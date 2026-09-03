/**
 * Telegram polling takeover stand-down regressions
 * Zones: telegram transport, polling runtime
 * Locks the loser-stands-down behavior: persistent getUpdates 409 escalates
 * to onPersistentConflict instead of retrying forever.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramPersistentConflictStandDown,
  runTelegramPollLoop,
} from "../lib/polling.ts";

function conflictErr() {
  return new Error(
    "Telegram API getUpdates failed: HTTP 409: Conflict: terminated by other getUpdates request",
  );
}

const NOOP_LOOP_PARTS = {
  deleteWebhook: async () => {},
  persistConfig: async () => {},
  appendUpdateBatch: async () => {},
  getAcceptedThroughUpdateId: () => 1,
  getJournalEntryCount: () => 0,
  signalUpdateWorker: () => {},
  onErrorStatus: () => {},
  onStatusReset: () => {},
  sleep: async () => {},
};

test("Poll loop escalates persistent getUpdates conflict instead of retrying forever", async () => {
  const ac = new AbortController();
  let calls = 0;
  let escalations = 0;
  const stop = await Promise.race([
    runTelegramPollLoop({
      ctx: "ctx",
      signal: ac.signal,
      config: { botToken: "x" },
      ...NOOP_LOOP_PARTS,
      getUpdates: async () => {
        calls += 1;
        if (calls > 50) ac.abort();
        throw conflictErr();
      },
      onPersistentConflict: () => {
        escalations += 1;
        return true;
      },
    }).then(() => "returned"),
    new Promise((r) => setTimeout(() => r("TIMEOUT-still-looping"), 5000)),
  ]);
  assert.equal(stop, "returned");
  assert.equal(escalations, 1);
  assert.ok(calls <= 12, "expected bounded retries, got " + calls);
});

test("Stand-down keeps retrying while the lock is still owned", () => {
  const hook = createTelegramPersistentConflictStandDown({
    getContext: () => "ctx",
    ownsLock: () => true,
    updateStatus: () => {
      throw new Error("must not update status while lock is owned");
    },
  });
  assert.equal(hook(10), false);
});

test("Stand-down stops the loop after losing the lock", () => {
  const seen: string[] = [];
  const hook = createTelegramPersistentConflictStandDown({
    getContext: () => "ctx",
    ownsLock: () => false,
    updateStatus: (_ctx, message) => {
      seen.push(message ?? "");
    },
    recordEvent: (category, message, details) => {
      seen.push(category + ":" + String(message) + ":" + details?.phase);
    },
  });
  assert.equal(hook(10), true);
  assert.deepEqual(seen, [
    "Telegram \u5df2\u7531\u53e6\u4e00\u5b9e\u4f8b\u63a5\u7ba1\uff0c\u672c\u5b9e\u4f8b\u505c\u6b62\u8f6e\u8be2\u3002",
    "polling:Persistent getUpdates conflict; standing down.:takeover-stand-down",
  ]);
});

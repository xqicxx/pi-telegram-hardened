/**
 * Telegram polling takeover stand-down regressions
 * Zones: telegram transport, polling runtime
 * Locks the loser-stands-down behavior: persistent getUpdates 409 escalates
 * to onPersistentConflict instead of retrying forever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTelegramPollLoop } from "../lib/polling.ts";

function conflictErr() {
  return new Error("Telegram API getUpdates failed: HTTP 409: Conflict: terminated by other getUpdates request");
}

describe("persistent getUpdates conflict", () => {
  it("escalates after the limit instead of retrying forever", async () => {
    const ac = new AbortController();
    let calls = 0;
    let escalations = 0;
    const stop = await Promise.race([
      runTelegramPollLoop({
        ctx: {},
        signal: ac.signal,
        config: { botToken: "x" },
        deleteWebhook: async () => {},
        getUpdates: async () => { calls++; if (calls > 50) ac.abort(); throw conflictErr(); },
        persistConfig: async () => {},
        appendUpdateBatch: async () => {},
        getJournalEntryCount: () => 0,
        signalUpdateWorker: () => {},
        onErrorStatus: () => {},
        onStatusReset: () => {},
        sleep: async () => {},
        onPersistentConflict: () => { escalations++; return true; },
      }).then(() => "returned"),
      new Promise((r) => setTimeout(() => r("TIMEOUT-still-looping"), 5000)),
    ]);
    assert.equal(stop, "returned");
    assert.equal(escalations, 1);
    assert.ok(calls <= 12, "expected bounded retries, got " + calls);
  });
});

/**
 * Tests for the background Pi instance spawner (New-Thread Instances).
 * Uses a fake pi executable + injected clock for deterministic lifecycle tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTelegramInstanceSpawner } from "../lib/instance-spawner.ts";

async function createFakePi(opts: { exitMs: number; mode?: "exit" | "hold" }): Promise<{
  path: string;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-spawner-fake-"));
  const path = join(dir, "fake-pi.sh");
  const hold = opts.mode === "hold" ? "while :; do sleep 1; done" : `sleep ${opts.exitMs / 1000}`;
  await writeFile(
    path,
    `#!/bin/bash
echo "ARGS:$*" >> "${dir}/invocation.txt"
env | grep TELEGRAM_FOLLOWER >> "${dir}/invocation.txt" || true
${hold}
exit 0
`,
  );
  await chmod(path, 0o755);
  return { path, dir };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Spawner launches a background instance with thread binding env and args", async () => {
  const fake = await createFakePi({ exitMs: 50 });
  const spawner = createTelegramInstanceSpawner({
    piCommand: fake.path,
    getCwd: () => "/tmp",
    getNowMs: () => 1000,
    getLogDir: () => "/tmp",
  });
  const result = await spawner.spawnForThread({
    chatId: 123,
    threadId: 456,
    threadName: "Atlas",
  });
  assert.equal(result.ok, true);
  const started = spawner.list().find((i) => i.threadId === 456);
  assert.ok(started, "instance should be listed");
  assert.equal(started.status, "starting");
  assert.equal(started.chatId, 123);
  assert.equal(started.threadName, "Atlas");

  await waitFor(() =>
    spawner.list().some((i) => i.threadId === 456 && i.status === "exited"),
  );

  // The fake pi recorded its argv and the thread-binding env before exiting.
  const invocation = await readFile(join(fake.dir, "invocation.txt"), "utf8");
  assert.match(invocation, /--mode rpc --name Atlas/);
  assert.match(invocation, /TELEGRAM_FOLLOWER_TARGET_CHAT_ID=123/);
  assert.match(invocation, /TELEGRAM_FOLLOWER_TARGET_THREAD_ID=456/);
  spawner.stop();
});

test("Spawner de-duplicates a live thread", async () => {
  const fake = await createFakePi({ exitMs: 200 });
  const spawner = createTelegramInstanceSpawner({
    piCommand: fake.path,
    getNowMs: () => 1000,
    getLogDir: () => "/tmp",
  });
  const first = await spawner.spawnForThread({ chatId: 1, threadId: 2 });
  assert.equal(first.ok, true);
  const second = await spawner.spawnForThread({ chatId: 1, threadId: 2 });
  assert.equal(second.ok, false);
  assert.match(second.message ?? "", /already started/);
  spawner.stop();
});

test("Spawner bounds concurrent live instances and frees capacity on exit (B1)", async () => {
  const fake = await createFakePi({ exitMs: 60 });
  const spawner = createTelegramInstanceSpawner({
    piCommand: fake.path,
    maxInstances: 2,
    getNowMs: () => 1000,
    getLogDir: () => "/tmp",
  });
  assert.equal((await spawner.spawnForThread({ chatId: 1, threadId: 11 })).ok, true);
  assert.equal((await spawner.spawnForThread({ chatId: 1, threadId: 12 })).ok, true);
  const third = await spawner.spawnForThread({ chatId: 1, threadId: 13 });
  assert.equal(third.ok, false);
  assert.match(third.message ?? "", /limit \(2\) reached/);

  // Both live instances exit on their own; capacity must be released so a new
  // spawn succeeds (the old bug kept exited instances counted forever).
  await waitFor(
    () => spawner.list().filter((i) => i.status === "exited").length >= 2,
  );
  const fourth = await spawner.spawnForThread({ chatId: 1, threadId: 13 });
  assert.equal(fourth.ok, true, "capacity must be released after exits");
  spawner.stop();
});

test("Spawner releases a thread after exit cooldown (B2)", async () => {
  const fake = await createFakePi({ exitMs: 40 });
  let now = 1000;
  const spawner = createTelegramInstanceSpawner({
    piCommand: fake.path,
    getNowMs: () => now,
    getLogDir: () => "/tmp",
  });
  await spawner.spawnForThread({ chatId: 5, threadId: 6, threadName: "Nova" });
  await waitFor(() =>
    spawner.list().some((i) => i.threadId === 6 && i.status === "exited"),
  );

  // Within the cooldown the thread is still considered spawned.
  now += 10_000;
  assert.equal(spawner.isSpawned(5, 6), true);
  const blocked = await spawner.spawnForThread({ chatId: 5, threadId: 6 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message ?? "", /exited recently/);

  // After the cooldown the thread is released and can be re-spawned.
  now += 30_000;
  assert.equal(spawner.isSpawned(5, 6), false);
  const respawn = await spawner.spawnForThread({ chatId: 5, threadId: 6 });
  assert.equal(respawn.ok, true);
  spawner.stop();
});

test("Spawner stops rejecting work after stop()", async () => {
  const fake = await createFakePi({ exitMs: 30 });
  const spawner = createTelegramInstanceSpawner({
    piCommand: fake.path,
    getNowMs: () => 1000,
    getLogDir: () => "/tmp",
  });
  spawner.stop();
  const result = await spawner.spawnForThread({ chatId: 1, threadId: 2 });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /stopped/);
});

test("Spawner dedup cooldown applies per thread, not globally", async () => {
  const fake = await createFakePi({ exitMs: 40 });
  let now = 1000;
  const spawner = createTelegramInstanceSpawner({
    piCommand: fake.path,
    getNowMs: () => now,
    getLogDir: () => "/tmp",
  });
  await spawner.spawnForThread({ chatId: 1, threadId: 101 });
  await spawner.spawnForThread({ chatId: 1, threadId: 102 });
  await waitFor(() => spawner.list().filter((i) => i.status === "exited").length >= 2);

  // Thread 101 is in cooldown but thread 102's cooldown is independent.
  now += 5_000;
  assert.equal(spawner.isSpawned(1, 101), true);
  const other = await spawner.spawnForThread({ chatId: 1, threadId: 999 });
  assert.equal(other.ok, true, "unrelated threads must not be blocked");
  spawner.stop();
});

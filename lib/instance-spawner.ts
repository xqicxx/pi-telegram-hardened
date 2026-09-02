/**
 * Background Pi instance spawner for operator-visible Telegram threads
 * Zones: telegram multi-instance bus, process lifecycle, operator delivery
 * Owns spawning headless `pi --mode rpc` follower processes that bind a specific
 * Telegram thread, their liveness/status tracking, de-duplication, bounded
 * concurrency, and log capture. Excludes polling, routing, queue, and bus wiring.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveTelegramTempDir } from "./paths.ts";

const TELEGRAM_SPAWN_READY_GRACE_MS = 3_000;
const TELEGRAM_SPAWN_RPC_COMMAND_TIMEOUT_MS = 15_000;
const TELEGRAM_SPAWN_MAX_INSTANCES = 4;
/**
 * After a background instance exits, its thread stays "spawned" for this long
 * so a crash loop cannot immediately re-arm the spawner on the next prompt.
 * Live instances never count against concurrency once they exit: the map only
 * holds starting/running children, so the limit applies to concurrent live
 * instances, not to the total ever spawned.
 */
const TELEGRAM_SPAWN_EXIT_COOLDOWN_MS = 30_000;

export interface TelegramBackgroundInstance {
  pid: number;
  chatId: number;
  threadId: number;
  threadName?: string;
  startedAtMs: number;
  status: "starting" | "running" | "exited";
  exitedAtMs?: number;
  exitCode?: number | null;
}

export interface TelegramInstanceSpawnerDeps {
  /** Executable used to launch Pi (`pi` resolves via PATH). */
  piCommand?: string;
  /** Working directory for spawned instances (default: leader cwd). */
  getCwd?: () => string | undefined;
  /** Maximum concurrent background instances (default 4). */
  maxInstances?: number;
  /** Log directory (default: <agentDir>/tmp/telegram). */
  getLogDir?: () => string;
  /** Injectable clock for deterministic tests (default: Date.now). */
  getNowMs?: () => number;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramInstanceSpawner {
  isSpawned: (chatId: number, threadId: number) => boolean;
  list: () => readonly TelegramBackgroundInstance[];
  spawnForThread: (input: {
    chatId: number;
    threadId: number;
    threadName?: string;
  }) => Promise<{ ok: boolean; message?: string }>;
  /** Detach tracking on session shutdown; leaves spawned processes running. */
  stop: () => void;
}

function targetKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

export function createTelegramInstanceSpawner(
  deps: TelegramInstanceSpawnerDeps = {},
): TelegramInstanceSpawner {
  // Only starting/running children live here; exited instances move to
  // recentExits (timestamped) so concurrency accounting stays live-only while
  // a short exit cooldown still prevents tight respawn loops per thread.
  const instances = new Map<string, TelegramBackgroundInstance>();
  const recentExits = new Map<string, { record: TelegramBackgroundInstance; exitedAtMs: number }>();
  const children = new Map<string, ChildProcess>();
  const maxInstances = deps.maxInstances ?? TELEGRAM_SPAWN_MAX_INSTANCES;
  const exitCooldownMs = TELEGRAM_SPAWN_EXIT_COOLDOWN_MS;
  const getNowMs = deps.getNowMs ?? Date.now;
  let stopped = false;

  const isInExitCooldown = (key: string, nowMs: number): boolean => {
    const exit = recentExits.get(key);
    if (!exit) return false;
    if (nowMs - exit.exitedAtMs >= exitCooldownMs) {
      recentExits.delete(key);
      return false;
    }
    return true;
  };

  const captureLog = (
    chatId: number,
    threadId: number,
    label: string,
    chunk: Buffer | string,
  ): void => {
    if (!deps.recordRuntimeEvent) return;
    const line = String(chunk)
      .split("\n")
      .filter((part) => part.trim().length > 0)
      .slice(-20)
      .join(" | ");
    if (!line) return;
    deps.recordRuntimeEvent(
      "spawn",
      new Error(`${label}: ${line.slice(0, 800)}`),
      { phase: "instance-log", chatId, threadId },
    );
  };

  const writeLogFile = async (
    chatId: number,
    threadId: number,
    label: string,
    chunk: Buffer | string,
  ): Promise<void> => {
    try {
      const logDir =
        deps.getLogDir?.() ?? resolveTelegramTempDir();
      await mkdir(logDir, { recursive: true });
      await appendFile(
        join(logDir, `spawn-${chatId}-${threadId}.log`),
        `[${label}] ${String(chunk)}`,
      );
    } catch {
      // Log capture must never break spawning.
    }
  };

  const injectConnectCommand = (child: ChildProcess): void => {
    const command = JSON.stringify({
      id: "spawner-telegram-connect",
      type: "prompt",
      message: "/telegram-connect",
    });
    if (!child.stdin?.writable) return;
    try {
      child.stdin.write(`${command}\n`);
    } catch {
      // Child may have exited already; exit handler cleans up.
    }
  };

  return {
    isSpawned(chatId, threadId) {
      const key = targetKey(chatId, threadId);
      if (instances.has(key)) return true;
      return isInExitCooldown(key, getNowMs());
    },
    list() {
      const nowMs = getNowMs();
      return [
        ...instances.values(),
        ...[...recentExits.values()]
          .filter(({ exitedAtMs }) => nowMs - exitedAtMs < exitCooldownMs)
          .map(({ record }) => record),
      ];
    },
    async spawnForThread({ chatId, threadId, threadName }) {
      if (stopped) return { ok: false, message: "Spawner is stopped." };
      const key = targetKey(chatId, threadId);
      const nowMs = getNowMs();
      const existing = instances.get(key);
      if (existing) {
        return { ok: false, message: "An instance for this thread already started." };
      }
      if (isInExitCooldown(key, nowMs)) {
        return {
          ok: false,
          message:
            "An instance for this thread exited recently; waiting out the respawn cooldown.",
        };
      }
      if (instances.size >= maxInstances) {
        return { ok: false, message: `Background instance limit (${maxInstances}) reached.` };
      }
      const startedAtMs = getNowMs();
      const instance: TelegramBackgroundInstance = {
        pid: 0,
        chatId,
        threadId,
        ...(threadName ? { threadName } : {}),
        startedAtMs,
        status: "starting",
      };
      const cwd = deps.getCwd?.() ?? process.cwd();
      const child = spawn(
        deps.piCommand ?? "pi",
        [
          "--mode",
          "rpc",
          ...(threadName ? ["--name", threadName] : []),
        ],
        {
          cwd,
          env: {
            ...process.env,
            TELEGRAM_FOLLOWER_TARGET_CHAT_ID: String(chatId),
            TELEGRAM_FOLLOWER_TARGET_THREAD_ID: String(threadId),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      instance.pid = child.pid ?? 0;
      instances.set(key, instance);
      children.set(key, child);

      const onExit = (code: number | null, signal: string | null): void => {
        // A superseded child must never clean up its replacement: only act if
        // this child is still the tracked one for its thread.
        if (children.get(key) !== child) return;
        const current = instances.get(key);
        if (!current) return;
        current.status = "exited";
        current.exitedAtMs = getNowMs();
        current.exitCode = code;
        // Move out of live concurrency accounting; keep a short cooldown so the
        // same thread cannot hot-respawn into a crash loop.
        instances.delete(key);
        recentExits.set(key, {
          record: current,
          exitedAtMs: current.exitedAtMs,
        });
        children.delete(key);
        deps.recordRuntimeEvent?.(
          "spawn",
          new Error(
            `Background Pi instance exited (code ${code ?? "?"}, signal ${signal ?? "none"}).`,
          ),
          { phase: "instance-exit", chatId, threadId, pid: current.pid },
        );
      };
      child.on("exit", onExit);
      child.on("error", (error) => {
        deps.recordRuntimeEvent?.("spawn", error, {
          phase: "instance-spawn-error",
          chatId,
          threadId,
        });
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        void writeLogFile(chatId, threadId, "out", chunk);
        captureLog(chatId, threadId, "out", chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        void writeLogFile(chatId, threadId, "err", chunk);
        captureLog(chatId, threadId, "err", chunk);
      });

      // Inject /telegram-connect once the session has had time to load extensions.
      const connectTimer = setTimeout(() => {
        const live = children.get(key);
        if (!live || live.exitCode !== null || !live.stdin?.writable) return;
        instance.status = "running";
        injectConnectCommand(live);
        const retryTimer = setTimeout(() => {
          const stillLive = children.get(key);
          if (stillLive && stillLive.exitCode === null) {
            deps.recordRuntimeEvent?.(
              "spawn",
              new Error(
                "Background Pi instance did not confirm connection within the window; retrying /telegram-connect once.",
              ),
              { phase: "instance-connect-retry", chatId, threadId },
            );
            injectConnectCommand(stillLive);
          }
        }, TELEGRAM_SPAWN_RPC_COMMAND_TIMEOUT_MS);
        retryTimer.unref?.();
      }, TELEGRAM_SPAWN_READY_GRACE_MS);
      // These timers are bookkeeping only; they must never keep the leader
      // process (or a test runner) alive after the child is gone.
      connectTimer.unref?.();

      return { ok: true };
    },
    stop() {
      stopped = true;
      instances.clear();
      recentExits.clear();
      children.clear();
    },
  };
}

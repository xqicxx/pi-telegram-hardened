/**
 * pi-telegram-working v2
 * ─────────────────────────────────────────────────────────────
 * 把「正在干什么」自动投影到 Telegram，风格与终端 whimsical 状态栏同款。
 *
 * - 复用 whimsical 的同一套消息池（宝莱坞/梗/提示/疯狂编译器…）与加权轮换逻辑
 * - 转圈动画（sleekOrbit ◜◠◝◞◡◟，约 1s/帧）
 * - 每 10 秒换一条新消息（与终端 MIN_WORKING_MESSAGE_INTERVAL_MS 同节奏）
 * - 真实状态覆盖：思考中 / 正在执行工具 / 等待你输入 时优先显示真实动作
 * - agent 结束自动删除该消息
 *
 * 依赖：npm:@llblab/pi-telegram（Activity+Delivery API）
 *       pi-agent-extensions（whimsical 消息池）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerTelegramActivityHandler,
  type TelegramActivityContext,
  type TelegramActivityEvent,
} from "@llblab/pi-telegram/activity";
import type { TelegramDeliveryHandle } from "@llblab/pi-telegram/delivery";
import {
  ABSURD_NERD_LINES,
  BOSS_PHASE_MESSAGES,
  CONTEXT_MESSAGES,
  FAKE_COMPILER_PANIC,
  PI_TIPS,
  TERMINAL_MEME_LINES,
  WHIMSICAL_VERBS,
  BOLLYWOOD_MESSAGES,
} from "pi-agent-extensions/extensions/whimsical/messages";

// ── 与 whimsical 同款常量 ─────────────────────────────────────────────
const MIN_MESSAGE_INTERVAL_MS = 10_000; // 每 10s 换一条新消息
const TICK_MS = 4_000; // spinner 帧间隔（Telegram 单 chat ~1 msg/s；2s 与 reasoning 卡片叠加超限；4s=0.25/s 安全）
const EDIT_FAIL_BACKOFF_MS = 30_000; // edit 失败后退避，避免触发 Telegram 429
const EDIT_FAIL_LIMIT = 3; // 连续失败达到该次数，本 turn 停止动画
const SPINNER = ["◜", "◠", "◝", "◞", "◡", "◟"]; // sleekOrbit
const DEFAULT_WEIGHTS: Record<string, number> = {
  A: 10, B: 10, C: 10, D: 10, E: 30, F: 15, G: 15,
};
const ALL_BUCKETS = ["A", "B", "C", "D", "E", "F", "G"];

const SOURCE_LABEL: Record<string, string> = {
  telegram: "[telegram]",
  local: "[终端]",
  autonomous: "[自动]",
  unknown: "[?]",
};

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickBossProgression(durationSeconds: number): string {
  if (durationSeconds < 5) return pick(BOSS_PHASE_MESSAGES.early);
  if (durationSeconds < 15) return pick(BOSS_PHASE_MESSAGES.mid);
  return pick(BOSS_PHASE_MESSAGES.late);
}

function chooseWeightedBucket(weights: Record<string, number>): string {
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const bucket of ALL_BUCKETS) {
    cumulative += weights[bucket];
    if (roll < cumulative) return bucket;
  }
  return "E";
}

function getTimeContext(): "morning" | "night" | "day" {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 0 && hour < 4) return "night";
  return "day";
}

function pickMessageForBucket(bucket: string, durationSeconds: number): string {
  switch (bucket) {
    case "A": return pick(ABSURD_NERD_LINES);
    case "B": return pickBossProgression(durationSeconds);
    case "C": return pick(FAKE_COMPILER_PANIC);
    case "D": return pick(TERMINAL_MEME_LINES);
    case "E": return pick(BOLLYWOOD_MESSAGES);
    case "F": return pick(PI_TIPS);
    default: return pick(WHIMSICAL_VERBS);
  }
}

function pickWorkingMessage(durationSeconds: number): string {
  if (durationSeconds > 5 && Math.random() > 0.5) {
    return pick(CONTEXT_MESSAGES.longWait);
  }
  const timeContext = getTimeContext();
  if (timeContext !== "day" && Math.random() > 0.7) {
    return pick(CONTEXT_MESSAGES[timeContext]);
  }
  const selected = chooseWeightedBucket(DEFAULT_WEIGHTS);
  return pickMessageForBucket(selected, durationSeconds);
}

function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const last = trimmed.split(/[/:\\]/).filter(Boolean).pop() ?? trimmed;
  return last.length > 40 ? `${last.slice(0, 40)}…` : last;
}

export default function telegramWorkingExtension(pi: ExtensionAPI) {
  let disposer: (() => void) | undefined;
  let handle: TelegramDeliveryHandle | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0; // 每次 agent-start 递增；settled/shutdown 后旧 tick 直接丢弃
  let currentModel: string | undefined;
  let currentSource = "?";
  let currentWhimsy = "";
  let override: string | null = null;
  let startedAtMs = 0;
  let lastRotateAtMs = 0;

  pi.on("agent_start", (_event, ctx) => {
    currentModel = ctx.model?.id ?? ctx.model?.name ?? currentModel;
  });

  const render = (frame: number): string => {
    const main = override ?? currentWhimsy;
    const spinner = SPINNER[frame % SPINNER.length];
    const model = shortModel(currentModel);
    const meta = `${SOURCE_LABEL[currentSource] ?? "[?]"}${model ? ` · ${model}` : ""}`;
    return `<b>${spinner} ${escapeHtml(main)}</b>\n<i>${escapeHtml(meta)}</i>`;
  };

  const edit = async (actx: TelegramActivityContext, text: string): Promise<boolean> => {
    if (!handle) return false;
    try {
      const res = await actx.edit(handle, { text, parseMode: "html" });
      if (!res.ok) {
        handle = undefined;
        return false;
      }
      return true;
    } catch {
      handle = undefined;
      return false;
    }
  };

  const startTicker = (actx: TelegramActivityContext): void => {
    stopTicker();
    const gen = generation;
    let frame = 0;
    let failStreak = 0;
    let backoffUntilMs = 0;
    timer = setInterval(() => {
      if (gen !== generation || !handle) return;
      const now = Date.now();
      if (now < backoffUntilMs) return; // 退避期内不发
      frame += 1;
      if (now - lastRotateAtMs >= MIN_MESSAGE_INTERVAL_MS) {
        currentWhimsy = pickWorkingMessage((now - startedAtMs) / 1000);
        lastRotateAtMs = now;
      }
      void edit(actx, render(frame)).then((ok) => {
        if (ok) {
          failStreak = 0;
        } else {
          failStreak += 1;
          if (failStreak >= EDIT_FAIL_LIMIT) {
            stopTicker(); // 连续失败说明限流/消息不可用，停止动画
          } else {
            backoffUntilMs = Date.now() + EDIT_FAIL_BACKOFF_MS;
          }
        }
      });
    }, TICK_MS);
  };

  const stopTicker = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const onActivity = async (
    event: TelegramActivityEvent,
    actx: TelegramActivityContext,
  ): Promise<void> => {
    switch (event.type) {
      case "agent-start": {
        // 清掉可能残留的旧工作消息，避免堆积
        if (handle) {
          const old = handle;
          handle = undefined;
          await actx.delete(old).catch(() => undefined);
        }
        generation += 1;
        currentSource = event.source;
        override = null;
        startedAtMs = Date.now();
        lastRotateAtMs = startedAtMs;
        currentWhimsy = pickWorkingMessage(0);
        const res = await actx.send(
          { text: render(0), parseMode: "html" },
          { pin: true },
        );
        if (res.ok) {
          handle = res.value;
          startTicker(actx);
        } else {
          handle = undefined;
        }
        break;
      }
      case "reasoning-end":
        override = "💭 思考中…";
        await edit(actx, render(0));
        break;
      case "tool-start":
        override = `🛠️ ${event.toolName}`;
        await edit(actx, render(0));
        break;
      case "ui-prompt-start": {
        const title = event.title ? `：${event.title}` : "确认/选择";
        override = `⏳ 等待终端输入${title}…（请在电脑上操作）`;
        await edit(actx, render(0));
        break;
      }
      case "ui-prompt-end":
        override = null;
        await edit(actx, render(0));
        break;
      case "agent-settled": {
        generation += 1;
        stopTicker();
        if (handle) {
          const done = handle;
          handle = undefined;
          await actx.delete(done).catch(() => undefined);
        }
        break;
      }
      default:
        break;
    }
  };

  pi.on("session_start", () => {
    disposer?.();
    disposer = registerTelegramActivityHandler({
      id: "pi-telegram-working",
      handle: onActivity,
    });
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    stopTicker();
    disposer?.();
    disposer = undefined;
    handle = undefined;
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

#!/usr/bin/env node

/**
 * Conservative pre-downgrade journal authority check.
 * Usage: node scripts/check-downgrade.mjs [agent-dir]
 *
 * This is an intentionally simpler schema validator than `lib/journal.ts`.
 * It only needs to prove whether unresolved journal authority remains, so it
 * errs toward BLOCKED and does not cross-check the rules the runtime owns:
 *
 * - Operator dispositions are not reconciled against surviving entries
 *   (`lib/journal.ts` rejects a "discard" disposition whose entry is still
 *   present).
 * - `queueOwner` and `failure` are presence-checked, not deep-validated
 *   (acquisition shape, retry/terminal derivation, and disposition id
 *   generation stay in `lib/journal.ts`).
 *
 * The shared entry rules (keys, state enum, update_id agreement, and
 * queue/failure metadata presence) MUST stay in sync with
 * `lib/journal.ts` `validateJournalEntry`; `tests/journal-downgrade.test.ts`
 * reconciles the two surfaces on those rules.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const SNAPSHOT_PATTERN = /^(?:inbox|follower-inbox-[a-f0-9]{16})(?:\.[a-zA-Z0-9._-]+)?\.json$/u;
const SEGMENT_NAME_PATTERN = /^\d{16}\.json$/u;
const AUTHORITY_STATES = new Set(["pending", "retry-wait", "queued", "failed"]);
const SNAPSHOT_KEYS = new Set([
  "version",
  "revision",
  "profile",
  "botIdentity",
  "entries",
  "operatorDispositions",
]);
const SEGMENT_KEYS = new Set([
  "version",
  "revision",
  "previousRevision",
  "profile",
  "botIdentity",
  "upsertedEntries",
  "removedUpdateIds",
  "operatorDispositions",
]);
const ENTRY_KEYS = new Set([
  "updateId",
  "update",
  "admittedAtMs",
  "state",
  "queueKind",
  "queueReceiptId",
  "queueOwner",
  "queueHandoff",
  "failure",
  "nextRetryAtMs",
  "terminalAtMs",
  "terminalReason",
  "terminalFailureId",
]);
const DISPOSITION_KEYS = new Set([
  "failureId",
  "updateId",
  "action",
  "committedAtMs",
  "attemptCount",
  "failureClass",
  "terminalAtMs",
  "terminalReason",
]);

function resolveAgentDir() {
  if (process.argv[2]) return resolve(process.argv[2]);
  if (process.env.PI_CODING_AGENT_DIR) {
    return resolve(process.env.PI_CODING_AGENT_DIR);
  }
  const executableName = basename(process.execPath).toLowerCase();
  const invokedName = basename(process.argv[1] ?? "").toLowerCase();
  return join(
    homedir(),
    executableName.startsWith("omp") || invokedName.startsWith("omp")
      ? ".omp"
      : ".pi",
    "agent",
  );
}

function block(message) {
  console.error(`BLOCKED: ${message}`);
  process.exitCode = 1;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    block(
      `cannot verify ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function validateBotIdentity(value) {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(["botId", "tokenSha256"])) &&
    (value.botId === undefined || isPositiveInteger(value.botId)) &&
    typeof value.tokenSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.tokenSha256)
  );
}

function identitiesMatch(left, right) {
  if (
    left.botId !== undefined &&
    right.botId !== undefined &&
    left.botId !== right.botId
  ) {
    return false;
  }
  return (
    (left.botId !== undefined && left.botId === right.botId) ||
    left.tokenSha256 === right.tokenSha256
  );
}

function mergeBotIdentity(stored, current) {
  return {
    ...(current.botId !== undefined
      ? { botId: current.botId }
      : stored.botId !== undefined
        ? { botId: stored.botId }
        : {}),
    tokenSha256: current.tokenSha256,
  };
}

function validateEntries(value) {
  if (!Array.isArray(value)) return undefined;
  const entries = new Map();
  let previousId = -1;
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ENTRY_KEYS) ||
      !isNonNegativeInteger(entry.updateId) ||
      entry.updateId <= previousId ||
      !AUTHORITY_STATES.has(entry.state) ||
      !isRecord(entry.update) ||
      entry.update.update_id !== entry.updateId ||
      !isNonNegativeInteger(entry.admittedAtMs)
    ) {
      return undefined;
    }
    const hasQueueMetadata =
      entry.queueKind !== undefined ||
      entry.queueReceiptId !== undefined ||
      entry.queueOwner !== undefined ||
      entry.queueHandoff !== undefined;
    const hasFailureMetadata =
      entry.failure !== undefined ||
      entry.nextRetryAtMs !== undefined ||
      entry.terminalAtMs !== undefined ||
      entry.terminalReason !== undefined ||
      entry.terminalFailureId !== undefined;
    if (
      (entry.state === "pending" && (hasQueueMetadata || hasFailureMetadata)) ||
      (entry.state === "queued" &&
        ((entry.queueKind !== "prompt" && entry.queueKind !== "control") ||
          typeof entry.queueReceiptId !== "string" ||
          entry.queueReceiptId.length === 0 ||
          entry.queueOwner === undefined ||
          hasFailureMetadata)) ||
      ((entry.state === "retry-wait" || entry.state === "failed") &&
        (hasQueueMetadata || !isRecord(entry.failure)))
    ) {
      return undefined;
    }
    previousId = entry.updateId;
    entries.set(entry.updateId, entry);
  }
  return entries;
}

function validateOperatorDispositions(value) {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const failureIds = new Set();
  for (const disposition of value) {
    if (
      !isRecord(disposition) ||
      !hasOnlyKeys(disposition, DISPOSITION_KEYS) ||
      typeof disposition.failureId !== "string" ||
      disposition.failureId.length === 0 ||
      failureIds.has(disposition.failureId) ||
      !isNonNegativeInteger(disposition.updateId) ||
      (disposition.action !== "retry" && disposition.action !== "discard") ||
      !isNonNegativeInteger(disposition.committedAtMs) ||
      !isPositiveInteger(disposition.attemptCount) ||
      typeof disposition.failureClass !== "string" ||
      disposition.failureClass.length === 0 ||
      !isNonNegativeInteger(disposition.terminalAtMs) ||
      disposition.committedAtMs < disposition.terminalAtMs ||
      typeof disposition.terminalReason !== "string" ||
      disposition.terminalReason.length === 0
    ) {
      return false;
    }
    failureIds.add(disposition.failureId);
  }
  return true;
}

function validateSnapshot(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, SNAPSHOT_KEYS) ||
    value.version !== 1 ||
    (value.revision !== undefined && !isPositiveInteger(value.revision)) ||
    typeof value.profile !== "string" ||
    value.profile.length === 0 ||
    !validateBotIdentity(value.botIdentity) ||
    !validateOperatorDispositions(value.operatorDispositions)
  ) {
    return undefined;
  }
  const entries = validateEntries(value.entries);
  if (!entries) return undefined;
  return {
    revision: value.revision ?? 0,
    profile: value.profile,
    botIdentity: value.botIdentity,
    entries,
  };
}

function validateSegment(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, SEGMENT_KEYS) ||
    value.version !== 1 ||
    !isPositiveInteger(value.revision) ||
    !isNonNegativeInteger(value.previousRevision) ||
    value.previousRevision !== value.revision - 1 ||
    typeof value.profile !== "string" ||
    value.profile.length === 0 ||
    !validateBotIdentity(value.botIdentity) ||
    !Array.isArray(value.upsertedEntries) ||
    !Array.isArray(value.removedUpdateIds) ||
    !validateOperatorDispositions(value.operatorDispositions)
  ) {
    return undefined;
  }
  const upsertedEntries = validateEntries(
    [...value.upsertedEntries].sort((left, right) =>
      Number(left?.updateId) - Number(right?.updateId),
    ),
  );
  if (!upsertedEntries || upsertedEntries.size !== value.upsertedEntries.length) {
    return undefined;
  }
  const removedUpdateIds = new Set();
  for (const updateId of value.removedUpdateIds) {
    if (
      !isNonNegativeInteger(updateId) ||
      removedUpdateIds.has(updateId) ||
      upsertedEntries.has(updateId)
    ) {
      return undefined;
    }
    removedUpdateIds.add(updateId);
  }
  return {
    revision: value.revision,
    previousRevision: value.previousRevision,
    profile: value.profile,
    botIdentity: value.botIdentity,
    upsertedEntries,
    removedUpdateIds,
  };
}

const agentDir = resolveAgentDir();
const runtimeDir = join(agentDir, "tmp", "telegram");
if (!existsSync(runtimeDir)) {
  console.log("SAFE: no Telegram runtime directory exists.");
  process.exit(0);
}

let runtimeNames;
try {
  runtimeNames = readdirSync(runtimeDir);
} catch (error) {
  block(
    `cannot verify Telegram runtime directory ${runtimeDir}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const snapshotNames = runtimeNames.filter((name) => SNAPSHOT_PATTERN.test(name));
const snapshotSet = new Set(snapshotNames);
for (const name of runtimeNames) {
  const snapshotName = name.endsWith(".segments")
    ? name.slice(0, -".segments".length)
    : undefined;
  if (snapshotName && SNAPSHOT_PATTERN.test(snapshotName)) {
    if (!snapshotSet.has(snapshotName)) {
      block(
        `cannot verify orphan journal segments without ${join(runtimeDir, snapshotName)}`,
      );
    }
    continue;
  }
  if (
    (name.startsWith("inbox") || name.startsWith("follower-inbox")) &&
    !SNAPSHOT_PATTERN.test(name)
  ) {
    block(`cannot verify unrecognized journal-like artifact ${join(runtimeDir, name)}`);
  }
}

for (const name of snapshotNames) {
  const path = join(runtimeDir, name);
  let pathStat;
  try {
    pathStat = lstatSync(path);
  } catch (error) {
    block(`cannot verify journal snapshot ${path}: ${String(error)}`);
    continue;
  }
  if (!pathStat.isFile()) {
    block(`cannot verify non-file journal snapshot ${path}`);
    continue;
  }
  const snapshot = validateSnapshot(readJson(path));
  if (!snapshot) {
    block(`cannot verify malformed journal snapshot ${path}`);
    continue;
  }

  let revision = snapshot.revision;
  let botIdentity = snapshot.botIdentity;
  const entries = snapshot.entries;
  const segmentDir = `${path}.segments`;
  if (existsSync(segmentDir)) {
    let segmentNames;
    try {
      if (!lstatSync(segmentDir).isDirectory()) {
        block(`cannot verify non-directory journal segments ${segmentDir}`);
        continue;
      }
      segmentNames = readdirSync(segmentDir);
    } catch (error) {
      block(`cannot verify journal segments ${segmentDir}: ${String(error)}`);
      continue;
    }
    const unrecognized = segmentNames.filter(
      (segmentName) => !SEGMENT_NAME_PATTERN.test(segmentName),
    );
    for (const segmentName of unrecognized) {
      block(`cannot verify unrecognized journal segment ${join(segmentDir, segmentName)}`);
    }
    for (const segmentName of segmentNames.filter((candidate) =>
      SEGMENT_NAME_PATTERN.test(candidate),
    ).sort()) {
      const nameRevision = Number(segmentName.slice(0, 16));
      if (nameRevision <= revision) continue;
      const segmentPath = join(segmentDir, segmentName);
      let segmentStat;
      try {
        segmentStat = lstatSync(segmentPath);
      } catch (error) {
        block(`cannot verify journal segment ${segmentPath}: ${String(error)}`);
        break;
      }
      const segment = segmentStat.isFile()
        ? validateSegment(readJson(segmentPath))
        : undefined;
      if (
        !segment ||
        segment.revision !== nameRevision ||
        segment.previousRevision !== revision
      ) {
        block(`cannot verify malformed or gapped journal segment ${segmentPath}`);
        break;
      }
      if (
        segment.profile !== snapshot.profile ||
        !identitiesMatch(segment.botIdentity, botIdentity)
      ) {
        block(`cannot verify foreign journal segment identity ${segmentPath}`);
        break;
      }
      for (const updateId of segment.removedUpdateIds) entries.delete(updateId);
      for (const [updateId, entry] of segment.upsertedEntries) {
        entries.set(updateId, entry);
      }
      revision = segment.revision;
      botIdentity = mergeBotIdentity(botIdentity, segment.botIdentity);
    }
  }
  if (entries.size > 0) {
    block(
      `${path} retains ${entries.size} unresolved update(s); drain with 0.28.x before downgrade.`,
    );
  }
}

if (process.exitCode) process.exit(1);
console.log(`SAFE: ${snapshotNames.length} Telegram journal(s) contain no unresolved updates.`);

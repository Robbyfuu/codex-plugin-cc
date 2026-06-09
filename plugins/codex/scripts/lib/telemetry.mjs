import fs from "node:fs";

import { resolveTelemetryFile } from "./state.mjs";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_TURN_MS,
  IDLE_TIMEOUT_ENV,
  MAX_TURN_ENV,
  resolveTimeouts
} from "./watchdog.mjs";

/**
 * Per-turn telemetry: one JSON line per finished turn, appended best-effort to
 * `<stateDir>/telemetry.jsonl`. Reads tolerate corrupt lines; writes never throw
 * into the turn lifecycle (the caller wraps this, but we also swallow here as a
 * second line of defense). All fs access goes through an injectable `fsImpl` so
 * the behaviour is unit-testable without touching disk.
 *
 * Concurrency caveat: the size roll is a stat -> rename -> append sequence with
 * no locking, so it is racy under concurrent detached workers. Two processes can
 * both decide to roll and clobber each other's `.jsonl.1`, so at most one rolled
 * generation may be lost. This is an accepted tradeoff for best-effort telemetry;
 * the read side already tolerates torn/partial lines, so a lost generation only
 * costs old history, never correctness of the live file.
 */

// Roll the active log to `.jsonl.1` (single generation, overwritten) once it
// crosses this size, so an always-on append cannot grow without bound.
const MAX_TELEMETRY_BYTES = 5 * 1024 * 1024;

// A run needs at least this many samples before percentile-based tuning advice
// is statistically meaningful; below it we say so honestly.
const MIN_RECOMMENDATION_SAMPLES = 5;

// "Headroom" means the slowest typical turn (p95) finished comfortably under the
// idle window. Anything below this fraction of the idle timeout is slack we
// could reclaim by lowering CODEX_COMPANION_IDLE_TIMEOUT_MS.
const HEADROOM_P95_FRACTION = 0.5;

// "Near the window" means p95 is close enough to the idle timeout that the idle
// guard is plausibly clipping healthy-but-slow turns.
const NEAR_IDLE_P95_FRACTION = 0.8;

/** Stall reasons: a turn that ended because a safety timeout fired. */
const STALL_REASONS = new Set(["idle-stall", "hard-stop"]);

// A turn the broker self-healed mid-flight (it emitted `turn/completed
// status:"interrupted"`, which resolves the turn with a non-zero exit status).
// This is the ONLY restart signal the companion can observe, so the restart rate
// is derived from this bucket rather than from `restartCount` (which has no
// companion-side source and stays 0).
const INTERRUPTED_REASON = "interrupted";

function rollIfOversized(fsImpl, filePath) {
  let size = 0;
  try {
    size = fsImpl.statSync(filePath).size;
  } catch {
    // Missing file (first write) or stat failure: nothing to roll.
    return;
  }
  if (size <= MAX_TELEMETRY_BYTES) {
    return;
  }
  // Single-generation roll: overwrite any previous `.1` so disk use stays bounded.
  fsImpl.renameSync(filePath, `${filePath}.1`);
}

/**
 * Append one outcome as a JSON line. Best-effort: any fs failure (full disk,
 * unwritable path, stat/rename error) is swallowed so telemetry never disturbs
 * the turn it is observing.
 *
 * @param {object} outcome
 * @param {{ cwd: string, fsImpl?: typeof fs, fileResolver?: (cwd: string) => string }} options
 */
export function recordTurnOutcome(outcome, { cwd, fsImpl = fs, fileResolver = resolveTelemetryFile } = {}) {
  try {
    const filePath = fileResolver(cwd);
    rollIfOversized(fsImpl, filePath);
    fsImpl.appendFileSync(filePath, `${JSON.stringify(outcome)}\n`, "utf8");
  } catch {
    // swallow — telemetry is best-effort and must never throw into the caller.
  }
}

/**
 * Read all recorded outcomes, skipping any malformed line rather than throwing
 * on a single corrupt record. A missing file yields an empty array.
 *
 * @param {{ cwd: string, fsImpl?: typeof fs, fileResolver?: (cwd: string) => string }} options
 * @returns {object[]}
 */
export function readTelemetry({ cwd, fsImpl = fs, fileResolver = resolveTelemetryFile } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(fileResolver(cwd), "utf8");
  } catch {
    return [];
  }

  const records = [];
  for (const line of String(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip a corrupt line; a single bad write must not poison the whole report.
    }
  }
  return records;
}

function numericDurations(records) {
  return records
    .map((record) => Number(record?.durationMs))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
}

/**
 * Nearest-rank percentile on a pre-sorted ascending array. Returns 0 for an
 * empty set so callers never get NaN.
 *
 * @param {number[]} sorted
 * @param {number} fraction 0..1
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function buildRecommendation({ total, countByReason, durationP95, env }) {
  if (total < MIN_RECOMMENDATION_SAMPLES) {
    return `Not enough data yet (need at least ${MIN_RECOMMENDATION_SAMPLES} turns) to recommend timeout changes.`;
  }

  const timeouts = resolveTimeouts(env ?? {});
  const idleMs = timeouts.idleMs;
  const maxTurnMs = timeouts.maxTurnMs;
  const hardStops = countByReason["hard-stop"] ?? 0;
  const idleStalls = countByReason["idle-stall"] ?? 0;
  const interrupted = countByReason[INTERRUPTED_REASON] ?? 0;

  // Hard stops are the most severe failure (a turn was killed outright), so they
  // dominate the advice: the max-duration ceiling is too low for this workload.
  if (hardStops > 0) {
    return `${hardStops} turn(s) hit the hard max-duration stop; raise ${MAX_TURN_ENV} (currently ${maxTurnMs}ms) to give long turns more room.`;
  }

  // Idle stalls with p95 near the idle window: the idle guard is plausibly
  // clipping healthy-but-quiet turns, so raise the idle timeout.
  if (idleStalls > 0 && durationP95 >= idleMs * NEAR_IDLE_P95_FRACTION) {
    return `${idleStalls} idle stall(s) with p95 near the idle window; raise ${IDLE_TIMEOUT_ENV} (currently ${idleMs}ms) to tolerate longer idle gaps.`;
  }

  // Interrupted turns settled without a clean completion — typically a broker
  // self-heal (restart mid-turn), though not exclusively. Either way it is an
  // INSTABILITY signal, not a timeout-tuning one, so this advice deliberately
  // names neither timeout env var — raising a timeout would not stop a restart.
  // Ranked below the timeout-stall branches so a clear stall pattern still wins.
  if (interrupted > 0) {
    return `${interrupted} turn(s) ended interrupted (without a clean completion), typically a broker self-heal; this indicates runtime instability, not a timeout-tuning issue — investigate the interrupted turns rather than changing the timeouts.`;
  }

  // Zero stalls/interrupts and p95 well under the idle window: there is slack to
  // reclaim. (interrupted is already known 0 here.)
  if (idleStalls === 0 && hardStops === 0 && durationP95 <= idleMs * HEADROOM_P95_FRACTION) {
    return `Idle timeout has headroom (p95 ${durationP95}ms vs ${idleMs}ms); you could lower ${IDLE_TIMEOUT_ENV} for faster stall detection.`;
  }

  return "Timeouts look well-matched to observed turn durations; no change recommended.";
}

/**
 * Aggregate raw telemetry records into a status-ready report.
 *
 * @param {object[]} records
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{
 *   total: number,
 *   countByReason: Record<string, number>,
 *   durationP50: number,
 *   durationP95: number,
 *   durationMax: number,
 *   stallRate: number,
 *   restartRate: number,
 *   recommendation: string
 * }}
 */
export function aggregateTelemetry(records, { env = {} } = {}) {
  const list = Array.isArray(records) ? records : [];
  const total = list.length;

  const countByReason = {};
  let stalls = 0;
  let interrupted = 0;
  for (const record of list) {
    const reason = typeof record?.exitReason === "string" && record.exitReason ? record.exitReason : "unknown";
    countByReason[reason] = (countByReason[reason] ?? 0) + 1;
    if (STALL_REASONS.has(reason)) {
      stalls += 1;
    }
    if (reason === INTERRUPTED_REASON) {
      interrupted += 1;
    }
    // NOTE: record.restartCount is intentionally NOT summed into the restart
    // rate. It has no companion-side source (always 0), so the only honest
    // restart signal is the interrupted bucket counted above. The field is kept
    // on the schema for forward-compatibility.
  }

  const durations = numericDurations(list);
  const durationP50 = percentile(durations, 0.5);
  const durationP95 = percentile(durations, 0.95);
  const durationMax = durations.length > 0 ? durations[durations.length - 1] : 0;

  const stallRate = total > 0 ? stalls / total : 0;
  // Restart rate = broker self-heals (interrupted turns) / total. This is the
  // first time the metric reflects something real instead of always-zero
  // restartCount data.
  const restartRate = total > 0 ? interrupted / total : 0;

  return {
    total,
    countByReason,
    durationP50,
    durationP95,
    durationMax,
    stallRate,
    restartRate,
    recommendation: buildRecommendation({ total, countByReason, durationP95, env })
  };
}

export { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_TURN_MS };

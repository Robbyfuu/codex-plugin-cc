import fs from "node:fs";

import { resolveBrokerTelemetryFile } from "./state.mjs";
import { appendTelemetryLine } from "./telemetry.mjs";

/**
 * Broker-side event telemetry: one JSON line per broker lifecycle event, appended
 * best-effort to `<stateDir>/broker-telemetry.jsonl` — a SIBLING of the per-turn
 * telemetry file. The broker is a SECOND writer, so it deliberately lives in its
 * own file rather than sharing the turn file (which documents an unlocked roll
 * race that a second concurrent writer would worsen).
 *
 * This is the first companion-side source for REAL broker restart counts: the
 * broker self-heal (generation bump + child swap) is otherwise invisible to the
 * companion, which until now could only INFER restarts from the `interrupted`
 * turn bucket. With these events `/codex-plus:stats` can report actual broker
 * churn (recovery-succeeded / recovery-failed) instead of an inference.
 *
 * Record shape: `{ at, event }` where event is one of
 *   recovery-started | recovery-succeeded | recovery-failed | child-spawned
 * plus `generation` and `reason` when the caller knows them.
 *
 * Same best-effort/never-throw discipline as the turn file: every write reuses
 * the shared appendTelemetryLine helper (append + single-generation roll at the
 * same byte cap), and reads tolerate torn/partial lines.
 */

function nowIso() {
  return new Date().toISOString();
}

/**
 * Append one broker event. The `at` timestamp is stamped automatically unless the
 * caller supplies one. Best-effort: a resolver or fs failure is swallowed so a
 * broker event can never throw into the broker's recovery/connect path.
 *
 * @param {{ event: string, generation?: number, reason?: string, at?: string }} event
 * @param {{ cwd: string, fsImpl?: typeof fs, fileResolver?: (cwd: string) => string }} options
 */
export function recordBrokerEvent(event, { cwd, fsImpl = fs, fileResolver = resolveBrokerTelemetryFile } = {}) {
  let filePath;
  try {
    filePath = fileResolver(cwd);
  } catch {
    // The resolver mkdirs the state dir; a failure there must not throw either.
    return;
  }
  const record = { at: event?.at ?? nowIso(), ...event };
  appendTelemetryLine(filePath, record, { fsImpl });
}

/**
 * Read all recorded broker events, skipping any malformed line rather than
 * throwing on a single corrupt record. A missing file yields an empty array.
 *
 * @param {{ cwd: string, fsImpl?: typeof fs, fileResolver?: (cwd: string) => string }} options
 * @returns {object[]}
 */
export function readBrokerTelemetry({ cwd, fsImpl = fs, fileResolver = resolveBrokerTelemetryFile } = {}) {
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

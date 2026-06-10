/**
 * Per-turn history for `/codex-plus:history`. A focused, newest-first list of the
 * turns recorded in the telemetry file (turns ONLY — broker events are out of
 * scope here; they belong to `/codex-plus:stats`). It reuses the same telemetry
 * records that stats aggregates, but projects them per-turn rather than
 * summarizing.
 */

export const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Build a newest-first history report from raw telemetry records.
 *
 * @param {object[]} records raw per-turn telemetry records (from readTelemetry)
 * @param {{ limit?: number }} [options]
 * @returns {{ total: number, limit: number, entries: object[] }}
 */
export function buildHistoryReport(records, { limit = DEFAULT_HISTORY_LIMIT } = {}) {
  const list = Array.isArray(records) ? records : [];
  const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_HISTORY_LIMIT;

  // Newest-first by endedAt (epoch ms); fall back to startedAt when absent so a
  // record without an end timestamp still sorts sensibly instead of sinking.
  const sorted = [...list].sort((left, right) => sortKey(right) - sortKey(left));

  const entries = sorted.slice(0, effectiveLimit).map((record) => ({
    endedAt: numberOrNull(record?.endedAt),
    startedAt: numberOrNull(record?.startedAt),
    durationMs: numberOrNull(record?.durationMs),
    exitReason: typeof record?.exitReason === "string" && record.exitReason ? record.exitReason : "unknown",
    kind: typeof record?.kind === "string" && record.kind ? record.kind : null,
    title: typeof record?.title === "string" && record.title ? record.title : null,
    threadId: typeof record?.threadId === "string" && record.threadId ? record.threadId : null
  }));

  return {
    total: list.length,
    limit: effectiveLimit,
    entries
  };
}

function sortKey(record) {
  const ended = Number(record?.endedAt);
  if (Number.isFinite(ended)) {
    return ended;
  }
  const started = Number(record?.startedAt);
  return Number.isFinite(started) ? started : 0;
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

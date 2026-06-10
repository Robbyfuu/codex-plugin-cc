import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHistoryReport } from "../scripts/lib/history.mjs";
import { renderHistoryReport } from "../scripts/lib/render.mjs";

function record(overrides = {}) {
  return {
    startedAt: 1000,
    endedAt: 6000,
    durationMs: 5000,
    exitReason: "completed",
    threadId: "thread-aaaaaaaa-1111",
    kind: "task",
    title: "Codex Task",
    restartCount: 0,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// buildHistoryReport: pure newest-first slicing + projection.
// ---------------------------------------------------------------------------

test("buildHistoryReport returns entries newest-first by endedAt", () => {
  const records = [
    record({ endedAt: 1000, title: "oldest" }),
    record({ endedAt: 3000, title: "newest" }),
    record({ endedAt: 2000, title: "middle" })
  ];
  const report = buildHistoryReport(records, { limit: 20 });
  assert.equal(report.total, 3);
  assert.deepEqual(
    report.entries.map((entry) => entry.title),
    ["newest", "middle", "oldest"],
    "entries are ordered newest-first"
  );
});

test("buildHistoryReport honors --limit (default 20) and reports it", () => {
  const records = Array.from({ length: 30 }, (_, index) => record({ endedAt: index, title: `t${index}` }));

  const limited = buildHistoryReport(records, { limit: 5 });
  assert.equal(limited.entries.length, 5, "only the limit count of entries is returned");
  assert.equal(limited.entries[0].title, "t29", "the newest survives the limit");
  assert.equal(limited.limit, 5);
  assert.equal(limited.total, 30, "total reflects ALL records, not just the shown slice");

  const defaulted = buildHistoryReport(records);
  assert.equal(defaulted.limit, 20, "limit defaults to 20");
  assert.equal(defaulted.entries.length, 20);
});

test("buildHistoryReport projects each entry to history fields", () => {
  const report = buildHistoryReport([record()], { limit: 20 });
  const entry = report.entries[0];
  assert.equal(entry.kind, "task");
  assert.equal(entry.title, "Codex Task");
  assert.equal(entry.durationMs, 5000);
  assert.equal(entry.exitReason, "completed");
  assert.equal(entry.threadId, "thread-aaaaaaaa-1111");
});

test("buildHistoryReport handles an empty telemetry set", () => {
  const report = buildHistoryReport([], { limit: 20 });
  assert.equal(report.total, 0);
  assert.deepEqual(report.entries, []);
});

// ---------------------------------------------------------------------------
// renderHistoryReport.
// ---------------------------------------------------------------------------

test("renderHistoryReport lists entries with a short thread id, human duration, and exit reason", () => {
  const report = buildHistoryReport(
    [
      record({ endedAt: 6000, durationMs: 5000, exitReason: "completed", title: "First task", threadId: "thread-abcdefgh-0001" }),
      record({ endedAt: 9000, durationMs: 125000, exitReason: "hard-stop", title: "Long task", threadId: "thread-zzzzzzzz-9999" })
    ],
    { limit: 20 }
  );
  const output = renderHistoryReport(report);

  assert.match(output, /# Codex History/);
  assert.match(output, /Long task/);
  assert.match(output, /First task/);
  assert.match(output, /hard-stop/);
  assert.match(output, /completed/);
  // Human-readable duration, not raw ms.
  assert.match(output, /2m\s*5s/);
  assert.match(output, /5(\.0)?s/);
  // Newest-first: Long task (endedAt 9000) before First task (6000).
  assert.ok(output.indexOf("Long task") < output.indexOf("First task"), "newest entry is rendered first");
});

test("renderHistoryReport shows a friendly empty message when there is no history", () => {
  const output = renderHistoryReport(buildHistoryReport([], { limit: 20 }));
  assert.match(output, /# Codex History/);
  assert.match(output, /No turns recorded yet|no history/i);
});

test("renderHistoryReport ends with a single trailing newline", () => {
  const output = renderHistoryReport(buildHistoryReport([record()], { limit: 20 }));
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.endsWith("\n\n"), false);
});

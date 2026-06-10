import assert from "node:assert/strict";
import { test } from "node:test";

import { renderStatsReport } from "../scripts/lib/render.mjs";

function sampleReport(overrides = {}) {
  return {
    total: 10,
    countByReason: {
      completed: 7,
      "idle-stall": 1,
      "hard-stop": 1,
      cancelled: 1
    },
    durationP50: 5000,
    durationP95: 30000,
    durationMax: 120000,
    stallRate: 0.2,
    restartRate: 0,
    recommendation: "Timeouts look well-matched to observed turn durations; no change recommended.",
    ...overrides
  };
}

test("renderStatsReport renders the total turn count", () => {
  const output = renderStatsReport(sampleReport());
  assert.match(output, /# Codex Stats/);
  assert.match(output, /Total turns:\s*10/);
});

test("renderStatsReport lists count and percentage by exit reason", () => {
  const output = renderStatsReport(sampleReport());
  // 7/10 completed = 70%
  assert.match(output, /completed:\s*7\s*\(70(\.0)?%\)/);
  assert.match(output, /idle-stall:\s*1\s*\(10(\.0)?%\)/);
  assert.match(output, /hard-stop:\s*1\s*\(10(\.0)?%\)/);
  assert.match(output, /cancelled:\s*1\s*\(10(\.0)?%\)/);
});

test("renderStatsReport shows human-readable p50/p95/max durations", () => {
  const output = renderStatsReport(sampleReport());
  // 5000ms -> 5.0s, 30000ms -> 30.0s, 120000ms -> 2m 0s (human-readable, not raw ms)
  assert.match(output, /p50/);
  assert.match(output, /p95/);
  assert.match(output, /max/i);
  assert.match(output, /5(\.0)?s/);
  assert.match(output, /30(\.0)?s/);
});

test("renderStatsReport includes stall and restart rate", () => {
  const output = renderStatsReport(sampleReport());
  assert.match(output, /Stall rate:\s*20(\.0)?%/);
  assert.match(output, /Restart rate:\s*0(\.0)?%/);
});

test("renderStatsReport lists the interrupted bucket and an instability legend (not 'counted under error')", () => {
  const output = renderStatsReport(
    sampleReport({
      countByReason: { completed: 6, interrupted: 4 },
      total: 10
    })
  );
  // 4/10 interrupted = 40%, shown as its own row.
  assert.match(output, /interrupted:\s*4\s*\(40(\.0)?%\)/);
  // Legend must frame interrupted as broker/instability, and must NOT claim such
  // turns are folded into `error`.
  assert.match(output, /interrupted/i);
  assert.match(output, /broker|instability|restart/i);
  assert.doesNotMatch(output, /counted under `?error`?/i);
});

test("renderStatsReport shows a Broker section with real restart counts when broker data exists", () => {
  const output = renderStatsReport(
    sampleReport({
      total: 10,
      hasBrokerData: true,
      brokerRestarts: 3,
      brokerRecoveryFailures: 1,
      restartRate: 0.3,
      restartRateSource: "broker"
    })
  );
  assert.match(output, /Broker/);
  assert.match(output, /restarts.*:\s*3/i);
  assert.match(output, /recovery failures:\s*1/i);
  // The restart-rate label must be honest about its source.
  assert.match(output, /Restart rate:\s*30(\.0)?%/);
  assert.match(output, /broker/i);
});

test("renderStatsReport omits the Broker section and labels restart rate as inferred when no broker data", () => {
  const output = renderStatsReport(
    sampleReport({
      total: 10,
      hasBrokerData: false,
      brokerRestarts: 0,
      brokerRecoveryFailures: 0,
      restartRate: 0.2,
      restartRateSource: "interrupted"
    })
  );
  assert.doesNotMatch(output, /^# Broker|Broker section|Broker restarts/m);
  // Honest fallback label: the rate is inferred from the interrupted bucket.
  assert.match(output, /Restart rate:\s*20(\.0)?%/);
  assert.match(output, /inferred|interrupted/i);
});

test("renderStatsReport surfaces the recommendation line verbatim", () => {
  const recommendation = "Raise CODEX_COMPANION_MAX_TURN_MS to give long turns more room.";
  const output = renderStatsReport(sampleReport({ recommendation }));
  assert.match(output, /Recommendation:/);
  assert.ok(output.includes(recommendation), "the recommendation text appears in the output");
});

test("renderStatsReport handles an empty dataset gracefully", () => {
  const output = renderStatsReport({
    total: 0,
    countByReason: {},
    durationP50: 0,
    durationP95: 0,
    durationMax: 0,
    stallRate: 0,
    restartRate: 0,
    recommendation: "Not enough data yet (need at least 5 turns) to recommend timeout changes."
  });
  assert.match(output, /# Codex Stats/);
  assert.match(output, /Total turns:\s*0/);
  assert.match(output, /No turns recorded yet|not enough data/i);
});

test("renderStatsReport ends with a single trailing newline", () => {
  const output = renderStatsReport(sampleReport());
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.endsWith("\n\n"), false);
});

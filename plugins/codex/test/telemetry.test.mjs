import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateTelemetry,
  readTelemetry,
  recordTurnOutcome
} from "../scripts/lib/telemetry.mjs";

/**
 * In-memory fs double exposing only the calls telemetry.mjs makes:
 * appendFileSync, statSync, renameSync, readFileSync, existsSync. Each file is a
 * string buffer so tests can assert on the exact bytes written.
 */
function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    appendFileSync(filePath, data) {
      files.set(filePath, (files.get(filePath) ?? "") + String(data));
    },
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = "ENOENT";
        throw error;
      }
      return files.get(filePath);
    },
    existsSync(filePath) {
      return files.has(filePath);
    },
    statSync(filePath) {
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = "ENOENT";
        throw error;
      }
      return { size: Buffer.byteLength(files.get(filePath), "utf8") };
    },
    renameSync(from, to) {
      if (!files.has(from)) {
        const error = new Error(`ENOENT: ${from}`);
        error.code = "ENOENT";
        throw error;
      }
      files.set(to, files.get(from));
      files.delete(from);
    }
  };
}

const TELEMETRY_FILE = "/state/telemetry.jsonl";

function sampleOutcome(overrides = {}) {
  return {
    startedAt: 1000,
    endedAt: 6000,
    durationMs: 5000,
    exitReason: "completed",
    threadId: "thread-1",
    kind: "task",
    title: "Codex Task",
    restartCount: 0,
    ...overrides
  };
}

test("recordTurnOutcome appends exactly one JSON line per call", () => {
  const fsImpl = createMemoryFs();
  const fileResolver = () => TELEMETRY_FILE;

  recordTurnOutcome(sampleOutcome(), { cwd: "/repo", fsImpl, fileResolver });

  const contents = fsImpl.files.get(TELEMETRY_FILE);
  assert.equal(contents.endsWith("\n"), true, "each record ends with a newline");
  const lines = contents.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.exitReason, "completed");
  assert.equal(parsed.durationMs, 5000);

  recordTurnOutcome(sampleOutcome({ exitReason: "idle-stall" }), {
    cwd: "/repo",
    fsImpl,
    fileResolver
  });
  const after = fsImpl.files.get(TELEMETRY_FILE).split("\n").filter(Boolean);
  assert.equal(after.length, 2, "a second call appends a second line, not a rewrite");
});

test("readTelemetry parses JSONL and skips malformed lines without throwing", () => {
  const fsImpl = createMemoryFs({
    [TELEMETRY_FILE]: [
      JSON.stringify(sampleOutcome()),
      "this is not json {",
      JSON.stringify(sampleOutcome({ exitReason: "hard-stop" })),
      "",
      "{ also broken"
    ].join("\n")
  });

  const records = readTelemetry({ cwd: "/repo", fsImpl, fileResolver: () => TELEMETRY_FILE });
  assert.equal(records.length, 2, "only the two valid JSON lines survive");
  assert.equal(records[0].exitReason, "completed");
  assert.equal(records[1].exitReason, "hard-stop");
});

test("readTelemetry returns an empty array when the file does not exist", () => {
  const fsImpl = createMemoryFs();
  const records = readTelemetry({ cwd: "/repo", fsImpl, fileResolver: () => TELEMETRY_FILE });
  assert.deepEqual(records, []);
});

test("recordTurnOutcome rolls the file to .1 once it exceeds the size cap", () => {
  // Seed the active file just over the 5MB cap so the next append triggers a roll.
  const oversized = "x".repeat(5 * 1024 * 1024 + 1);
  const fsImpl = createMemoryFs({ [TELEMETRY_FILE]: oversized });
  const fileResolver = () => TELEMETRY_FILE;

  recordTurnOutcome(sampleOutcome(), { cwd: "/repo", fsImpl, fileResolver });

  const rolled = fsImpl.files.get(`${TELEMETRY_FILE}.1`);
  assert.equal(rolled, oversized, "previous contents are moved to telemetry.jsonl.1");

  const active = fsImpl.files.get(TELEMETRY_FILE).split("\n").filter(Boolean);
  assert.equal(active.length, 1, "the active file restarts with just the new record");
  assert.equal(JSON.parse(active[0]).exitReason, "completed");
});

test("recordTurnOutcome swallows an fs throw and never propagates it", () => {
  const throwingFs = {
    appendFileSync() {
      throw new Error("EACCES: disk on fire");
    },
    statSync() {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    existsSync() {
      return false;
    },
    renameSync() {
      throw new Error("EACCES");
    }
  };

  assert.doesNotThrow(() => {
    recordTurnOutcome(sampleOutcome(), {
      cwd: "/repo",
      fsImpl: throwingFs,
      fileResolver: () => TELEMETRY_FILE
    });
  });
});

test("aggregateTelemetry counts outcomes by exit reason", () => {
  const records = [
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "idle-stall" }),
    sampleOutcome({ exitReason: "hard-stop" }),
    sampleOutcome({ exitReason: "interrupted" }),
    sampleOutcome({ exitReason: "cancelled" }),
    sampleOutcome({ exitReason: "error" })
  ];

  const report = aggregateTelemetry(records, { env: {} });
  assert.equal(report.total, 7);
  assert.equal(report.countByReason.completed, 2);
  assert.equal(report.countByReason["idle-stall"], 1);
  assert.equal(report.countByReason["hard-stop"], 1);
  assert.equal(report.countByReason.interrupted, 1);
  assert.equal(report.countByReason.cancelled, 1);
  assert.equal(report.countByReason.error, 1);
});

test("aggregateTelemetry computes p50, p95 and max durations on a known set", () => {
  // Durations 100..1000 in steps of 100 (10 samples).
  const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  const records = durations.map((durationMs) => sampleOutcome({ durationMs }));

  const report = aggregateTelemetry(records, { env: {} });
  // Nearest-rank percentile: ceil(0.5*10)=5th value=500; ceil(0.95*10)=10th value=1000.
  assert.equal(report.durationP50, 500);
  assert.equal(report.durationP95, 1000);
  assert.equal(report.durationMax, 1000);
});

test("aggregateTelemetry derives stallRate from stalls and restartRate from the interrupted bucket", () => {
  const records = [
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "idle-stall" }),
    sampleOutcome({ exitReason: "hard-stop" }),
    sampleOutcome({ exitReason: "interrupted" }),
    sampleOutcome({ exitReason: "interrupted" })
  ];

  const report = aggregateTelemetry(records, { env: {} });
  // stallRate = (idle-stall + hard-stop) / total = 2/6
  assert.equal(report.stallRate, 2 / 6);
  // restartRate is now REAL: it counts broker self-heals (the `interrupted`
  // bucket), the only restart signal the companion can actually observe.
  // restartRate = interrupted / total = 2/6
  assert.equal(report.restartRate, 2 / 6);
});

test("aggregateTelemetry restartRate is zero when there are no interrupted turns (restartCount is never the source)", () => {
  // restartCount stays hardcoded to 0 in production; a stray non-zero value must
  // NOT inflate restartRate — the metric is sourced from the interrupted bucket.
  const records = [
    sampleOutcome({ exitReason: "completed", restartCount: 5 }),
    sampleOutcome({ exitReason: "hard-stop", restartCount: 9 })
  ];
  const report = aggregateTelemetry(records, { env: {} });
  assert.equal(report.restartRate, 0);
});

test("aggregateTelemetry merges broker events: real restart counts override the interrupted inference", () => {
  const records = [
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "interrupted" }),
    sampleOutcome({ exitReason: "interrupted" })
  ];
  // Three real broker recoveries: two succeeded, one failed.
  const brokerEvents = [
    { event: "recovery-started" },
    { event: "recovery-succeeded" },
    { event: "recovery-started" },
    { event: "recovery-succeeded" },
    { event: "recovery-started" },
    { event: "recovery-failed" }
  ];

  const report = aggregateTelemetry(records, { env: {}, brokerEvents });

  assert.equal(report.total, 4);
  assert.equal(report.brokerRestarts, 2, "brokerRestarts counts recovery-succeeded events");
  assert.equal(report.brokerRecoveryFailures, 1, "brokerRecoveryFailures counts recovery-failed events");
  // restartRate now derives from REAL broker restarts / total turns (2/4),
  // NOT the interrupted-bucket inference (which would have been 2/4 too here,
  // but the SOURCE is broker data when present).
  assert.equal(report.restartRate, 2 / 4);
  assert.equal(report.restartRateSource, "broker", "the metric is sourced from broker data when present");
});

test("aggregateTelemetry falls back to the interrupted-bucket inference when no broker data exists", () => {
  const records = [
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "interrupted" }),
    sampleOutcome({ exitReason: "interrupted" })
  ];

  // No brokerEvents passed at all (broker telemetry file absent / older runtime).
  const report = aggregateTelemetry(records, { env: {} });
  assert.equal(report.brokerRestarts, 0);
  assert.equal(report.restartRate, 2 / 4, "falls back to interrupted/total");
  assert.equal(report.restartRateSource, "interrupted", "honest label: inferred from the interrupted bucket");
});

test("aggregateTelemetry treats an empty broker-event array as no broker data (honest fallback)", () => {
  const records = [
    sampleOutcome({ exitReason: "completed" }),
    sampleOutcome({ exitReason: "interrupted" })
  ];
  const report = aggregateTelemetry(records, { env: {}, brokerEvents: [] });
  assert.equal(report.restartRateSource, "interrupted", "an empty broker log is NOT broker data");
  assert.equal(report.restartRate, 1 / 2);
});

test("aggregateTelemetry windows broker events to the surviving turn span (excludes events older than the oldest turn)", () => {
  // The two files roll independently at 5MB, so the broker log can outlive the
  // turn log. Broker events that predate the oldest SURVIVING turn must NOT count
  // against the (shorter) turn denominator, or the rate inflates beyond reality.
  const oldestTurnStartedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const records = [
    sampleOutcome({ startedAt: oldestTurnStartedAt, endedAt: oldestTurnStartedAt + 5000, exitReason: "completed" }),
    sampleOutcome({ startedAt: oldestTurnStartedAt + 60000, endedAt: oldestTurnStartedAt + 65000, exitReason: "completed" })
  ];
  const brokerEvents = [
    // Pre-window: from a rolled-away era of turns. Must be excluded.
    { at: "2026-05-01T00:00:00.000Z", event: "recovery-succeeded" },
    { at: "2026-05-15T00:00:00.000Z", event: "recovery-succeeded" },
    { at: "2026-05-20T00:00:00.000Z", event: "recovery-failed" },
    // In-window: aligned with the surviving turns. Counts.
    { at: "2026-06-01T00:00:30.000Z", event: "recovery-succeeded" }
  ];

  const report = aggregateTelemetry(records, { env: {}, brokerEvents });
  assert.equal(report.brokerRestarts, 1, "only the in-window recovery-succeeded counts");
  assert.equal(report.brokerRecoveryFailures, 0, "the pre-window failure is excluded too");
  assert.equal(report.restartRate, 1 / 2, "rate uses the windowed numerator over the turn total");
  assert.equal(report.restartRateSource, "broker");
});

test("aggregateTelemetry clamps the displayed restart rate to 1.0 even if broker events still outnumber turns", () => {
  // Defensive clamp: even after windowing, a degenerate state (e.g. many restarts
  // recorded within the span of very few turns) must never render > 100%.
  const startedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const records = [sampleOutcome({ startedAt, endedAt: startedAt + 5000, exitReason: "completed" })];
  const brokerEvents = [
    { at: "2026-06-01T00:00:01.000Z", event: "recovery-succeeded" },
    { at: "2026-06-01T00:00:02.000Z", event: "recovery-succeeded" },
    { at: "2026-06-01T00:00:03.000Z", event: "recovery-succeeded" }
  ];
  const report = aggregateTelemetry(records, { env: {}, brokerEvents });
  assert.equal(report.brokerRestarts, 3, "the raw windowed count is still reported honestly");
  assert.equal(report.restartRate, 1, "the displayed RATE is clamped to 1.0 (never > 100%)");
});

test("aggregateTelemetry includes broker events with no parseable `at` (cannot be proven out-of-window)", () => {
  // A malformed/absent `at` cannot be windowed; keep it counted so we never
  // silently under-report real churn. Windowing only EXCLUDES events provably
  // older than the surviving span.
  const startedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const records = [
    sampleOutcome({ startedAt, endedAt: startedAt + 5000, exitReason: "completed" }),
    sampleOutcome({ startedAt: startedAt + 10000, endedAt: startedAt + 15000, exitReason: "completed" })
  ];
  const brokerEvents = [{ event: "recovery-succeeded" }]; // no `at`
  const report = aggregateTelemetry(records, { env: {}, brokerEvents });
  assert.equal(report.brokerRestarts, 1);
  assert.equal(report.restartRate, 1 / 2);
});

test("aggregateTelemetry reports not-enough-data when fewer than 5 records", () => {
  const records = [sampleOutcome(), sampleOutcome()];
  const report = aggregateTelemetry(records, { env: {} });
  assert.match(report.recommendation, /not enough data/i);
});

test("aggregateTelemetry recommends lowering the idle timeout when p95 has headroom and no stalls", () => {
  // All fast (1s), idle timeout configured very high (60s), zero stalls.
  const records = Array.from({ length: 10 }, () => sampleOutcome({ durationMs: 1000, exitReason: "completed" }));
  const report = aggregateTelemetry(records, {
    env: { PEER_COMPANION_IDLE_TIMEOUT_MS: "60000" }
  });
  assert.match(report.recommendation, /headroom|lower/i);
});

test("aggregateTelemetry recommends raising the idle timeout when idle stalls appear near the idle window", () => {
  const records = [
    ...Array.from({ length: 8 }, () => sampleOutcome({ durationMs: 9500, exitReason: "completed" })),
    sampleOutcome({ durationMs: 9900, exitReason: "idle-stall" }),
    sampleOutcome({ durationMs: 9800, exitReason: "idle-stall" })
  ];
  const report = aggregateTelemetry(records, {
    env: { PEER_COMPANION_IDLE_TIMEOUT_MS: "10000" }
  });
  assert.match(report.recommendation, /PEER_COMPANION_IDLE_TIMEOUT_MS/);
});

test("aggregateTelemetry recommends raising the max turn limit when hard stops occur", () => {
  const records = [
    ...Array.from({ length: 7 }, () => sampleOutcome({ durationMs: 5000, exitReason: "completed" })),
    sampleOutcome({ durationMs: 900000, exitReason: "hard-stop" }),
    sampleOutcome({ durationMs: 900000, exitReason: "hard-stop" }),
    sampleOutcome({ durationMs: 5000, exitReason: "completed" })
  ];
  const report = aggregateTelemetry(records, {
    env: { PEER_COMPANION_MAX_TURN_MS: "900000" }
  });
  assert.match(report.recommendation, /PEER_COMPANION_MAX_TURN_MS/);
});

test("aggregateTelemetry surfaces interrupted turns as instability, distinct from timeout knobs", () => {
  const records = [
    ...Array.from({ length: 6 }, () => sampleOutcome({ durationMs: 5000, exitReason: "completed" })),
    sampleOutcome({ durationMs: 4000, exitReason: "interrupted" }),
    sampleOutcome({ durationMs: 4200, exitReason: "interrupted" }),
    sampleOutcome({ durationMs: 3800, exitReason: "interrupted" })
  ];
  const report = aggregateTelemetry(records, {
    env: { PEER_COMPANION_IDLE_TIMEOUT_MS: "60000", PEER_COMPANION_MAX_TURN_MS: "900000" }
  });
  // Instability advice must mention interruption/broker restart and must NOT
  // blame a timeout knob — these turns did not stall or hit the max-duration cap.
  assert.match(report.recommendation, /interrupt|broker|instability|restart/i);
  assert.doesNotMatch(report.recommendation, /PEER_COMPANION_IDLE_TIMEOUT_MS|PEER_COMPANION_MAX_TURN_MS/);
});

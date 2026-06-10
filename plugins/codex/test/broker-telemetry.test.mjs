import assert from "node:assert/strict";
import { test } from "node:test";

import { appendTelemetryLine } from "../scripts/lib/telemetry.mjs";
import {
  readBrokerTelemetry,
  recordBrokerEvent
} from "../scripts/lib/broker-telemetry.mjs";

/**
 * In-memory fs double exposing the calls the telemetry append+roll helper makes:
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

const FILE = "/state/broker-telemetry.jsonl";

// ---------------------------------------------------------------------------
// Shared append helper (extracted from recordTurnOutcome so the broker file
// reuses the SAME best-effort append + roll discipline instead of duplicating).
// ---------------------------------------------------------------------------

test("appendTelemetryLine appends exactly one JSON line per call", () => {
  const fsImpl = createMemoryFs();

  appendTelemetryLine(FILE, { event: "recovery-started" }, { fsImpl });
  appendTelemetryLine(FILE, { event: "recovery-succeeded" }, { fsImpl });

  const lines = fsImpl.files.get(FILE).split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "two calls append two lines, not a rewrite");
  assert.equal(JSON.parse(lines[0]).event, "recovery-started");
  assert.equal(JSON.parse(lines[1]).event, "recovery-succeeded");
  assert.equal(fsImpl.files.get(FILE).endsWith("\n"), true);
});

test("appendTelemetryLine rolls the file to .1 once it exceeds the size cap", () => {
  const oversized = "x".repeat(5 * 1024 * 1024 + 1);
  const fsImpl = createMemoryFs({ [FILE]: oversized });

  appendTelemetryLine(FILE, { event: "child-spawned" }, { fsImpl });

  assert.equal(fsImpl.files.get(`${FILE}.1`), oversized, "previous contents moved to .1");
  const active = fsImpl.files.get(FILE).split("\n").filter(Boolean);
  assert.equal(active.length, 1, "active file restarts with the new record");
});

test("appendTelemetryLine swallows an fs throw and never propagates it", () => {
  const throwingFs = {
    appendFileSync() {
      throw new Error("EACCES");
    },
    statSync() {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    }
  };
  assert.doesNotThrow(() => appendTelemetryLine(FILE, { event: "x" }, { fsImpl: throwingFs }));
});

// ---------------------------------------------------------------------------
// Broker event record/read.
// ---------------------------------------------------------------------------

test("recordBrokerEvent writes an {at, event} record with extra fields", () => {
  const fsImpl = createMemoryFs();
  const fileResolver = () => FILE;

  recordBrokerEvent(
    { event: "recovery-succeeded", generation: 3, reason: "idle" },
    { cwd: "/repo", fsImpl, fileResolver }
  );

  const records = readBrokerTelemetry({ cwd: "/repo", fsImpl, fileResolver });
  assert.equal(records.length, 1);
  assert.equal(records[0].event, "recovery-succeeded");
  assert.equal(records[0].generation, 3);
  assert.equal(records[0].reason, "idle");
  assert.equal(typeof records[0].at, "string", "an `at` timestamp is stamped automatically");
});

test("recordBrokerEvent preserves an explicit `at` when one is supplied", () => {
  const fsImpl = createMemoryFs();
  const fileResolver = () => FILE;

  recordBrokerEvent(
    { at: "2026-06-09T00:00:00.000Z", event: "child-spawned" },
    { cwd: "/repo", fsImpl, fileResolver }
  );

  const records = readBrokerTelemetry({ cwd: "/repo", fsImpl, fileResolver });
  assert.equal(records[0].at, "2026-06-09T00:00:00.000Z");
});

test("readBrokerTelemetry skips malformed lines and returns [] for a missing file", () => {
  const fsImpl = createMemoryFs({
    [FILE]: [
      JSON.stringify({ at: "t1", event: "recovery-started" }),
      "not json {",
      JSON.stringify({ at: "t2", event: "recovery-failed" }),
      ""
    ].join("\n")
  });
  const fileResolver = () => FILE;

  const records = readBrokerTelemetry({ cwd: "/repo", fsImpl, fileResolver });
  assert.equal(records.length, 2, "only the two valid lines survive");
  assert.equal(records[0].event, "recovery-started");
  assert.equal(records[1].event, "recovery-failed");

  const empty = readBrokerTelemetry({ cwd: "/repo", fsImpl, fileResolver: () => "/state/missing.jsonl" });
  assert.deepEqual(empty, []);
});

test("recordBrokerEvent is best-effort: an fs throw never propagates", () => {
  const throwingFs = {
    appendFileSync() {
      throw new Error("EACCES");
    },
    statSync() {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    }
  };
  assert.doesNotThrow(() =>
    recordBrokerEvent({ event: "recovery-failed" }, { cwd: "/repo", fsImpl: throwingFs, fileResolver: () => FILE })
  );
});

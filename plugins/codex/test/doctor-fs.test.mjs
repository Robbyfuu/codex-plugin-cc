import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { walkStateDir } from "../scripts/lib/doctor-fs.mjs";

const STATE_DIR = "/state";
const JOBS_DIR = "/state/jobs";

/**
 * Minimal in-memory fs double for walkStateDir. Files are described as
 * { mtimeMs, size }. readdirSync supports both the plain (names) and
 * withFileTypes shapes the walk uses.
 */
function createMemoryFs(jobsFiles = {}, stateFiles = {}) {
  const jobs = new Map(Object.entries(jobsFiles));
  const state = new Map(Object.entries(stateFiles));

  function statFor(fullPath) {
    const name = path.basename(fullPath);
    const dir = path.dirname(fullPath);
    const bucket = dir === JOBS_DIR ? jobs : state;
    if (!bucket.has(name)) {
      const error = new Error(`ENOENT: ${fullPath}`);
      error.code = "ENOENT";
      throw error;
    }
    const entry = bucket.get(name);
    return { mtimeMs: entry.mtimeMs ?? 0, size: entry.size ?? 0 };
  }

  return {
    existsSync(fullPath) {
      const name = path.basename(fullPath);
      const dir = path.dirname(fullPath);
      const bucket = dir === JOBS_DIR ? jobs : state;
      return bucket.has(name);
    },
    statSync(fullPath) {
      return statFor(fullPath);
    },
    readdirSync(dir, options) {
      const bucket = dir === JOBS_DIR ? jobs : dir === STATE_DIR ? state : null;
      if (!bucket) {
        const error = new Error(`ENOENT: ${dir}`);
        error.code = "ENOENT";
        throw error;
      }
      const names = [...bucket.keys()];
      if (options?.withFileTypes) {
        return names.map((name) => ({ name, isDirectory: () => false }));
      }
      return names;
    }
  };
}

function walkWith(jobsFiles, { nowMs = 1_000_000_000_000, env = {} } = {}) {
  const fsImpl = createMemoryFs(jobsFiles);
  return walkStateDir("/cwd", {
    env,
    nowMs,
    fsImpl,
    listJobsImpl: () => [],
    resolveStateDirImpl: () => STATE_DIR,
    resolveJobsDirImpl: () => JOBS_DIR,
    telemetryFile: "/state/telemetry.jsonl"
  });
}

test("walkStateDir flags a FRESH *.lock as stale regardless of mtime (stale-if-found)", () => {
  const now = 1_000_000_000_000;
  const result = walkWith(
    {
      "broker.lock": { mtimeMs: now } // mtime = now, age 0
    },
    { nowMs: now }
  );
  assert.ok(result.staleLogs.includes("/state/jobs/broker.lock"), "fresh .lock is flagged");
});

test("walkStateDir flags a FRESH *.in_use as stale regardless of mtime", () => {
  const now = 1_000_000_000_000;
  const result = walkWith(
    {
      "slot.in_use": { mtimeMs: now }
    },
    { nowMs: now }
  );
  assert.ok(result.staleLogs.includes("/state/jobs/slot.in_use"), "fresh .in_use is flagged");
});

test("walkStateDir does NOT flag a fresh *.log (age gate still applies to job artifacts)", () => {
  const now = 1_000_000_000_000;
  const result = walkWith(
    {
      "job-1.log": { mtimeMs: now } // fresh
    },
    { nowMs: now }
  );
  assert.ok(!result.staleLogs.includes("/state/jobs/job-1.log"), "fresh .log is not flagged");
});

test("walkStateDir still flags an OLD *.log past the stale window", () => {
  const now = 1_000_000_000_000;
  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
  const result = walkWith(
    {
      "job-old.log": { mtimeMs: now - eightDaysMs }
    },
    { nowMs: now }
  );
  assert.ok(result.staleLogs.includes("/state/jobs/job-old.log"), "old .log is flagged");
});

test("walkStateDir prefers PEER_COMPANION_DOCTOR_STALE_DAYS over legacy stale-days env", () => {
  const now = 1_000_000_000_000;
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const result = walkWith(
    {
      "job-two-days.log": { mtimeMs: now - twoDaysMs }
    },
    {
      nowMs: now,
      env: {
        PEER_COMPANION_DOCTOR_STALE_DAYS: "1",
        CODEX_COMPANION_DOCTOR_STALE_DAYS: "7"
      }
    }
  );
  assert.ok(result.staleLogs.includes("/state/jobs/job-two-days.log"), "peer one-day window wins");
});

test("walkStateDir preserves legacy stale-days fallback when peer env is absent", () => {
  const now = 1_000_000_000_000;
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const result = walkWith(
    {
      "job-two-days.log": { mtimeMs: now - twoDaysMs }
    },
    {
      nowMs: now,
      env: {
        CODEX_COMPANION_DOCTOR_STALE_DAYS: "1"
      }
    }
  );
  assert.ok(result.staleLogs.includes("/state/jobs/job-two-days.log"), "legacy one-day window still applies");
});

test("walkStateDir reports the broker telemetry file size and over-cap flag", () => {
  const now = 1_000_000_000_000;
  const overCap = 5 * 1024 * 1024 + 10;
  const fsImpl = createMemoryFs(
    {},
    {
      "telemetry.jsonl": { size: 100 },
      "broker-telemetry.jsonl": { size: overCap }
    }
  );
  const result = walkStateDir("/cwd", {
    env: {},
    nowMs: now,
    fsImpl,
    listJobsImpl: () => [],
    resolveStateDirImpl: () => STATE_DIR,
    resolveJobsDirImpl: () => JOBS_DIR,
    telemetryFile: "/state/telemetry.jsonl",
    brokerTelemetryFile: "/state/broker-telemetry.jsonl"
  });
  assert.equal(result.brokerTelemetryBytes, overCap);
  assert.equal(result.brokerTelemetryOverCap, true, "an oversized broker telemetry file is flagged over-cap");
});

test("walkStateDir reports broker telemetry under cap as not over-cap", () => {
  const fsImpl = createMemoryFs({}, { "broker-telemetry.jsonl": { size: 200 } });
  const result = walkStateDir("/cwd", {
    env: {},
    fsImpl,
    listJobsImpl: () => [],
    resolveStateDirImpl: () => STATE_DIR,
    resolveJobsDirImpl: () => JOBS_DIR,
    telemetryFile: "/state/telemetry.jsonl",
    brokerTelemetryFile: "/state/broker-telemetry.jsonl"
  });
  assert.equal(result.brokerTelemetryBytes, 200);
  assert.equal(result.brokerTelemetryOverCap, false);
});

test("walkStateDir keeps the active-job exclusion for lock files too", () => {
  const now = 1_000_000_000_000;
  const fsImpl = createMemoryFs({ "live.lock": { mtimeMs: now } });
  const result = walkStateDir("/cwd", {
    env: {},
    nowMs: now,
    fsImpl,
    // `live` is an active job → its artifact (even a fresh lock) is not stale.
    listJobsImpl: () => [{ id: "live", status: "running" }],
    resolveStateDirImpl: () => STATE_DIR,
    resolveJobsDirImpl: () => JOBS_DIR,
    telemetryFile: "/state/telemetry.jsonl"
  });
  assert.ok(!result.staleLogs.includes("/state/jobs/live.lock"), "active job's lock is spared");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listJobs, resolveStateFile, saveState } from "../scripts/lib/state.mjs";
import {
  buildStatusSnapshot,
  resolveCancelableJob,
  resolveResultJob
} from "../scripts/lib/job-control.mjs";

/**
 * Issue #5: a job whose worker pid is dead must be auto-reconciled to `failed`
 * on the read path, so status/result/cancel/task-gating all stop treating it as
 * a live job. Each test runs against an isolated temp workspace + plugin-data
 * dir.
 */
function withTempWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-liveness-"));
  const workspaceRoot = path.join(root, "repo");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  // Neutralize any ambient session id so sessionless seeded jobs stay visible
  // through filterJobsForCurrentSession regardless of the runner's environment.
  const previousSessionId = process.env.CODEX_COMPANION_SESSION_ID;
  delete process.env.CODEX_COMPANION_SESSION_ID;
  return Promise.resolve(run({ workspaceRoot })).finally(() => {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    if (previousSessionId === undefined) {
      delete process.env.CODEX_COMPANION_SESSION_ID;
    } else {
      process.env.CODEX_COMPANION_SESSION_ID = previousSessionId;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}

// A killImpl double: a dead pid throws ESRCH (mirrors process.kill on a gone
// process); a live pid returns silently.
function makeKillImpl(alivePids) {
  const alive = new Set(alivePids);
  return (pid) => {
    if (alive.has(pid)) {
      return true;
    }
    const error = new Error(`ESRCH: no such process ${pid}`);
    error.code = "ESRCH";
    throw error;
  };
}

function seedJobs(workspaceRoot, jobs) {
  saveState(workspaceRoot, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });
}

const DEAD_PID = 999999;

test("listJobs reconciles a dead-pid running job to failed with a liveness note", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    seedJobs(workspaceRoot, [
      {
        id: "task-dead",
        status: "running",
        jobClass: "task",
        pid: DEAD_PID,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]);

    const jobs = listJobs(workspaceRoot, { killImpl: makeKillImpl([]) });
    const job = jobs.find((entry) => entry.id === "task-dead");
    assert.equal(job.status, "failed");
    assert.match(String(job.error ?? job.errorMessage ?? ""), /worker process died/i);
    assert.match(String(job.error ?? job.errorMessage ?? ""), /not alive/i);

    // Reconciliation must be persisted: a re-read sees failed even without the
    // killImpl double.
    const persisted = JSON.parse(fs.readFileSync(resolveStateFile(workspaceRoot), "utf8"));
    const persistedJob = persisted.jobs.find((entry) => entry.id === "task-dead");
    assert.equal(persistedJob.status, "failed");
  });
});

test("buildStatusSnapshot reports a dead-pid running job as finished, not running", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    seedJobs(workspaceRoot, [
      {
        id: "task-dead",
        status: "running",
        jobClass: "task",
        pid: DEAD_PID,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]);

    const snapshot = buildStatusSnapshot(workspaceRoot, { killImpl: makeKillImpl([]) });
    assert.equal(snapshot.running.length, 0, "a dead-pid job must not be listed as running");
    assert.equal(snapshot.latestFinished?.id, "task-dead");
    assert.equal(snapshot.latestFinished?.status, "failed");
  });
});

test("resolveCancelableJob does not claim a dead-pid job is still running", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    seedJobs(workspaceRoot, [
      {
        id: "task-dead",
        status: "running",
        jobClass: "task",
        pid: DEAD_PID,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]);

    assert.throws(
      () => resolveCancelableJob(workspaceRoot, "task-dead", { killImpl: makeKillImpl([]) }),
      /No (active )?job found/i,
      "a dead-pid job is no longer treated as active/cancelable"
    );
  });
});

test("resolveResultJob returns a reconciled dead-pid job instead of 'still running'", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    seedJobs(workspaceRoot, [
      {
        id: "task-dead",
        status: "running",
        jobClass: "task",
        pid: DEAD_PID,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]);

    const { job } = resolveResultJob(workspaceRoot, "task-dead", { killImpl: makeKillImpl([]) });
    assert.equal(job.status, "failed");
  });
});

test("listJobs leaves a running job with NO pid untouched (just-spawned race)", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    seedJobs(workspaceRoot, [
      {
        id: "task-fresh",
        status: "running",
        jobClass: "task",
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]);

    const jobs = listJobs(workspaceRoot, { killImpl: makeKillImpl([]) });
    const job = jobs.find((entry) => entry.id === "task-fresh");
    assert.equal(job.status, "running", "a running job with no recorded pid must NOT be reconciled");
  });
});

test("listJobs leaves a live-pid running job untouched", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    const livePid = process.pid;
    seedJobs(workspaceRoot, [
      {
        id: "task-live",
        status: "running",
        jobClass: "task",
        pid: livePid,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]);

    const jobs = listJobs(workspaceRoot, { killImpl: makeKillImpl([livePid]) });
    const job = jobs.find((entry) => entry.id === "task-live");
    assert.equal(job.status, "running");
  });
});

test("listJobs reconcile is best-effort: a persist failure does not throw and still returns failed", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    seedJobs(workspaceRoot, [
      {
        id: "task-dead",
        status: "running",
        jobClass: "task",
        pid: DEAD_PID,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]);

    const throwingPersist = () => {
      throw new Error("disk is full");
    };

    let jobs;
    assert.doesNotThrow(() => {
      jobs = listJobs(workspaceRoot, { killImpl: makeKillImpl([]), persistImpl: throwingPersist });
    });
    const job = jobs.find((entry) => entry.id === "task-dead");
    assert.equal(job.status, "failed", "the in-memory view is reconciled even when persistence fails");
  });
});

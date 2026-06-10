import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isPidAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const TELEMETRY_FILE_NAME = "telemetry.jsonl";
// Broker events live in a SIBLING file, deliberately separate from the per-turn
// telemetry file. The broker is a second writer; keeping it off the turn file
// avoids adding another concurrent writer to the documented roll race there.
const BROKER_TELEMETRY_FILE_NAME = "broker-telemetry.jsonl";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

// A job is reconcilable only when it claims to be active under a recorded
// worker pid. A `running` job with NO pid is a just-spawned race (the worker
// has not yet written `pid`) and is deliberately left alone. A `queued` job is
// reconciled only when a pid is already recorded (the detached worker was
// spawned but is now dead). pid <= 0 / non-finite is never treated as a real
// pid by isPidAlive, so such records are also left untouched.
function jobHasDeadWorker(job, killImpl) {
  if (!job || (job.status !== "running" && job.status !== "queued")) {
    return false;
  }
  const pid = job.pid;
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  return !isPidAlive(pid, killImpl);
}

function reconcileDeadJob(job) {
  const note = `worker process died (pid ${job.pid} not alive); reconciled by liveness check`;
  return {
    ...job,
    status: "failed",
    phase: "failed",
    pid: null,
    error: note,
    errorMessage: job.errorMessage ?? note,
    completedAt: job.completedAt ?? nowIso(),
    updatedAt: nowIso()
  };
}

/**
 * Read jobs and auto-reconcile any that claim to be running/queued under a dead
 * worker pid. This is the central read seam: status, result, cancel, and the
 * stop-gate task check all go through listJobs, so reconciling here means a job
 * whose worker died (SIGKILL, crash, reboot) is treated as `failed` everywhere
 * without waiting for /codex-plus:doctor.
 *
 * Reconciliation is best-effort: the in-memory view is always reconciled, and
 * the persist is attempted but a persist failure is swallowed so a read can
 * never throw.
 *
 * @param {string} cwd
 * @param {{ killImpl?: (pid: number, signal: number) => void, persistImpl?: (cwd: string, state: object) => void }} [options]
 */
export function listJobs(cwd, options = {}) {
  const killImpl = options.killImpl;
  const persistImpl = options.persistImpl ?? saveState;
  const state = loadState(cwd);
  const jobs = state.jobs;

  let changed = false;
  const reconciled = jobs.map((job) => {
    if (jobHasDeadWorker(job, killImpl)) {
      changed = true;
      return reconcileDeadJob(job);
    }
    return job;
  });

  if (changed) {
    try {
      persistImpl(cwd, { ...state, jobs: reconciled });
    } catch {
      // Best-effort: a persist failure (full disk, race) must never break the
      // read. The returned view is still reconciled.
    }
  }

  return reconciled;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveTelemetryFile(cwd) {
  ensureStateDir(cwd);
  return path.join(resolveStateDir(cwd), TELEMETRY_FILE_NAME);
}

export function resolveBrokerTelemetryFile(cwd) {
  ensureStateDir(cwd);
  return path.join(resolveStateDir(cwd), BROKER_TELEMETRY_FILE_NAME);
}

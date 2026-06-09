import fs from "node:fs";
import path from "node:path";

import { listJobs, resolveJobsDir, resolveStateDir } from "./state.mjs";
import { MAX_TELEMETRY_BYTES } from "./telemetry.mjs";

/**
 * Read-only walk of the companion state dir for the doctor report. Pure disk
 * inspection — NEVER mutates. All fs/listJobs access is injectable so the walk
 * is unit-testable without touching disk.
 *
 * What it surfaces:
 *   - totalBytes: recursive byte size of the state dir.
 *   - staleLogs: per-job `*.log`/`*.json` older than the stale window AND not an
 *     active (running/queued) job. Plus any `*.lock`/`*.in_use` — these are
 *     stale-if-found and bypass the age gate (forward-compat; the shipped broker
 *     creates none today), but the active-job exclusion still applies to them.
 *   - orphanPaneMarkers: `*.pane` markers whose sibling `*.log` is gone.
 *   - telemetryBytes / telemetryOverCap: telemetry.jsonl size vs the roll cap.
 */

const DEFAULT_STALE_DAYS = 7;
const STALE_DAYS_ENV = "CODEX_COMPANION_DOCTOR_STALE_DAYS";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveStaleMs(env) {
  const raw = env?.[STALE_DAYS_ENV];
  const parsed = raw == null ? DEFAULT_STALE_DAYS : Number(raw);
  const days = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALE_DAYS;
  return days * MS_PER_DAY;
}

/**
 * Active (running/queued) job ids — their artifacts are never stale. Exported so
 * the delete path can RE-DERIVE this set at execute time (TOCTOU guard) using the
 * same definition the plan-time walk used.
 *
 * @param {string} cwd
 * @param {(cwd: string) => Array<{ id?: string, status?: string }>} listJobsImpl
 * @returns {Set<string>}
 */
export function deriveActiveJobIds(cwd, listJobsImpl) {
  const jobs = listJobsImpl(cwd);
  const ids = new Set();
  if (!Array.isArray(jobs)) {
    return ids;
  }
  for (const job of jobs) {
    if (job && (job.status === "running" || job.status === "queued") && job.id) {
      ids.add(job.id);
    }
  }
  return ids;
}

/**
 * Job id encoded in a stale-artifact filename (`<jobId>.log`/`.json`/`.lock`/
 * `.in_use`). Strips every recognized stale extension so the active-job
 * exclusion works uniformly, including for lock/in-use markers. Exported so the
 * delete path maps an artifact path back to its job id when re-checking the live
 * active set.
 *
 * @param {string} fileName basename only (not a full path)
 * @returns {string}
 */
export function jobIdFromArtifact(fileName) {
  return fileName.replace(/\.(log|json|lock|in_use)$/, "");
}

function isStaleArtifactName(fileName) {
  return /\.(log|json|lock|in_use)$/.test(fileName);
}

/**
 * Lock/in-use markers are "stale-if-found": a lock file existing at all means a
 * broker left it behind (the shipped broker creates none, so any is orphaned).
 * These bypass the age gate entirely — a RECENT lock is still stale. The regular
 * `*.log`/`*.json` job artifacts keep the mtime-based age gate.
 */
function isAlwaysStaleArtifact(fileName) {
  return /\.(lock|in_use)$/.test(fileName);
}

/**
 * @param {string} cwd
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   telemetryFile?: string,
 *   nowMs?: number,
 *   fsImpl?: typeof fs,
 *   listJobsImpl?: typeof listJobs,
 *   resolveStateDirImpl?: typeof resolveStateDir,
 *   resolveJobsDirImpl?: typeof resolveJobsDir
 * }} [options]
 */
export function walkStateDir(cwd, options = {}) {
  const env = options.env ?? {};
  const fsImpl = options.fsImpl ?? fs;
  const listJobsImpl = options.listJobsImpl ?? listJobs;
  const resolveStateDirImpl = options.resolveStateDirImpl ?? resolveStateDir;
  const resolveJobsDirImpl = options.resolveJobsDirImpl ?? resolveJobsDir;
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = resolveStaleMs(env);

  const stateDir = resolveStateDirImpl(cwd);
  const jobsDir = resolveJobsDirImpl(cwd);
  const telemetryFile = options.telemetryFile ?? path.join(stateDir, "telemetry.jsonl");

  const result = {
    totalBytes: 0,
    staleLogs: [],
    orphanPaneMarkers: [],
    telemetryBytes: 0,
    telemetryOverCap: false
  };

  result.totalBytes = directorySize(fsImpl, stateDir);

  // Telemetry size + over-cap.
  try {
    if (fsImpl.existsSync(telemetryFile)) {
      result.telemetryBytes = fsImpl.statSync(telemetryFile).size;
      result.telemetryOverCap = result.telemetryBytes > MAX_TELEMETRY_BYTES;
    }
  } catch {
    // best-effort
  }

  // Jobs dir: stale artifacts + orphan pane markers.
  let entries = [];
  try {
    entries = fsImpl.readdirSync(jobsDir);
  } catch {
    entries = [];
  }
  const entrySet = new Set(entries);
  const active = deriveActiveJobIds(cwd, listJobsImpl);

  for (const name of entries) {
    const fullPath = path.join(jobsDir, name);

    if (name.endsWith(".pane")) {
      // Orphan when the sibling `<base>.log` no longer exists.
      const siblingLog = name.slice(0, -".pane".length);
      if (!entrySet.has(siblingLog)) {
        result.orphanPaneMarkers.push(fullPath);
      }
      continue;
    }

    if (!isStaleArtifactName(name)) {
      continue;
    }

    // An artifact belonging to an active job is never stale.
    if (active.has(jobIdFromArtifact(name))) {
      continue;
    }

    // Lock/in-use markers are stale-if-found — skip the age gate for them.
    if (isAlwaysStaleArtifact(name)) {
      result.staleLogs.push(fullPath);
      continue;
    }

    let mtimeMs = 0;
    try {
      mtimeMs = fsImpl.statSync(fullPath).mtimeMs ?? 0;
    } catch {
      continue;
    }
    if (nowMs - mtimeMs > staleMs) {
      result.staleLogs.push(fullPath);
    }
  }

  return result;
}

/** Recursive byte size; best-effort, tolerates unreadable entries. */
function directorySize(fsImpl, dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      if (typeof entry.isDirectory === "function" ? entry.isDirectory() : false) {
        total += directorySize(fsImpl, fullPath);
      } else {
        total += fsImpl.statSync(fullPath).size ?? 0;
      }
    } catch {
      // skip unreadable entry
    }
  }
  return total;
}

export { DEFAULT_STALE_DAYS, STALE_DAYS_ENV };

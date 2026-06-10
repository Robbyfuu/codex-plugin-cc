import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getCodexAvailability } from "./codex.mjs";
import {
  isBrokerEndpointReady,
  loadBrokerSession,
  teardownBrokerSession
} from "./broker-lifecycle.mjs";
import { isPidAlive, terminateProcessTree } from "./process.mjs";

// Re-exported so existing doctor consumers keep a single import surface; the
// canonical implementation lives in process.mjs (the one source of truth).
export { isPidAlive };
import { listJobs, resolveStateDir } from "./state.mjs";
import { deriveActiveJobIds, jobIdFromArtifact, walkStateDir } from "./doctor-fs.mjs";

// Telemetry filename, mirrored from state.mjs (private there). Used to derive the
// telemetry path PURELY from resolveStateDir — resolveTelemetryFile() would
// mkdir the state dir, which would violate doctor's read-only contract.
const TELEMETRY_FILE_NAME = "telemetry.jsonl";

function resolveTelemetryPathReadOnly(cwd) {
  return path.join(resolveStateDir(cwd), TELEMETRY_FILE_NAME);
}

/**
 * Doctor health diagnosis + cleanup for the Codex companion state.
 *
 * Three pieces, all injectable so tests need no real process/socket/disk:
 *   - classifyBroker: pure-ish broker triage (healthy/orphaned/wedged/none).
 *   - buildDoctorReport: READ-ONLY assembly of the full report.
 *   - planCleanup / executeCleanup: plan (no side effects) then perform.
 *
 * Reality note: the shipped broker enforces single-flight IN MEMORY
 * (activeRequestSocket/activeStreamSocket in app-server-broker.mjs), NOT via
 * lockfiles. No `.lock`/`.in_use` files are created today. The real stale
 * artifacts are an orphaned broker.json + a dead broker.sock + a dead
 * broker.pid. Any `*.lock`/`*.in_use` found under the state dir is still treated
 * as stale (forward-compat), but none exist in the current design.
 */

const ACTIVE_JOB_STATUSES = new Set(["running", "queued"]);

/**
 * Triage the broker session into one of four states.
 *
 * @param {{
 *   session: { endpoint?: string|null, pid?: number|null } | null,
 *   readyImpl?: (endpoint: string|null|undefined) => Promise<boolean>,
 *   killImpl?: (pid: number, signal: number) => void
 * }} params
 * @returns {Promise<"healthy" | "orphaned" | "wedged" | "none">}
 */
export async function classifyBroker({ session, readyImpl = isBrokerEndpointReady, killImpl = process.kill } = {}) {
  if (!session || !session.endpoint) {
    return "none";
  }

  const ready = await readyImpl(session.endpoint);
  if (ready) {
    return "healthy";
  }

  // Endpoint is not ready. Distinguish a dead (orphaned) broker from a live but
  // wedged one by probing the pid.
  return isPidAlive(session.pid, killImpl) ? "wedged" : "orphaned";
}

const SEVERITY = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low"
};

/**
 * Build the READ-ONLY doctor report. No mutation happens here.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, deps?: object }} [options]
 */
export async function buildDoctorReport(cwd, { env = process.env, deps = {} } = {}) {
  const getCodexAvailabilityImpl = deps.getCodexAvailabilityImpl ?? getCodexAvailability;
  const loadBrokerSessionImpl = deps.loadBrokerSessionImpl ?? loadBrokerSession;
  const listJobsImpl = deps.listJobsImpl ?? listJobs;
  const readyImpl = deps.readyImpl ?? isBrokerEndpointReady;
  const killImpl = deps.killImpl ?? process.kill;
  const resolveStateDirImpl = deps.resolveStateDirImpl ?? resolveStateDir;
  // Read-only: derive the telemetry path without mkdir (resolveTelemetryFile mkdirs).
  const resolveTelemetryFileImpl = deps.resolveTelemetryFileImpl ?? resolveTelemetryPathReadOnly;
  const walkStateDirImpl = deps.walkStateDirImpl ?? walkStateDir;

  const codex = getCodexAvailabilityImpl(cwd);

  const session = loadBrokerSessionImpl(cwd) ?? null;
  const classification = await classifyBroker({ session, readyImpl, killImpl });
  const socketReady = classification === "healthy";
  const pidAlive = classification === "wedged" || classification === "healthy";

  const jobs = Array.isArray(listJobsImpl(cwd)) ? listJobsImpl(cwd) : [];
  const activeJobCount = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job?.status)).length;

  const stateDirPath = resolveStateDirImpl(cwd);
  const telemetryFile = resolveTelemetryFileImpl(cwd);
  const walk = walkStateDirImpl(cwd, { env, telemetryFile }) ?? {};
  const stateDir = {
    path: stateDirPath,
    totalBytes: walk.totalBytes ?? 0,
    staleLogs: walk.staleLogs ?? [],
    orphanPaneMarkers: walk.orphanPaneMarkers ?? [],
    telemetryBytes: walk.telemetryBytes ?? 0,
    telemetryOverCap: Boolean(walk.telemetryOverCap),
    telemetryFile
  };

  const broker = {
    configured: Boolean(session),
    endpoint: session?.endpoint ?? null,
    socketReady,
    pid: session?.pid ?? null,
    pidAlive,
    classification,
    session
  };

  const issues = collectIssues({ codex, broker, stateDir, activeJobCount });
  const ready = codex.available && broker.classification !== "wedged" && broker.classification !== "orphaned";

  return {
    // The cwd passed here is already the workspace root (the handler resolves it
    // via resolveCommandWorkspace). Carry it so executeCleanup can RE-DERIVE the
    // live active-job set at delete time rather than trusting the plan snapshot.
    workspaceRoot: cwd,
    ready,
    codex: { available: codex.available, detail: codex.detail },
    broker,
    stateDir,
    activeJobCount,
    issues
  };
}

function collectIssues({ codex, broker, stateDir, activeJobCount }) {
  const issues = [];

  if (!codex.available) {
    issues.push({
      kind: "codex-unavailable",
      severity: SEVERITY.high,
      detail: codex.detail,
      autoFixable: false
    });
  }

  if (broker.classification === "orphaned") {
    issues.push({
      kind: "orphaned-broker",
      severity: SEVERITY.medium,
      detail: `Broker session ${broker.endpoint} points at a dead pid ${broker.pid ?? "?"}; its socket/pid/log are stale.`,
      autoFixable: true
    });
  }

  if (broker.classification === "wedged") {
    // A wedged broker that may be serving an active job is NEVER auto-fixable —
    // killing it could abort live work. The kill gate downgrades it elsewhere.
    const owns = activeJobCount > 0;
    issues.push({
      kind: "wedged-broker",
      severity: owns ? SEVERITY.high : SEVERITY.medium,
      detail: owns
        ? `Broker pid ${broker.pid} is live but unresponsive AND ${activeJobCount} active job(s) exist; it may be serving an active job, so it will NOT be killed.`
        : `Broker pid ${broker.pid} is live but its endpoint is unresponsive (wedged single-flight slot).`,
      autoFixable: !owns
    });
  }

  if (stateDir.orphanPaneMarkers.length > 0) {
    issues.push({
      kind: "orphan-pane-markers",
      severity: SEVERITY.low,
      detail: `${stateDir.orphanPaneMarkers.length} stale pane marker(s) with no sibling log.`,
      autoFixable: true
    });
  }

  if (stateDir.staleLogs.length > 0) {
    issues.push({
      kind: "stale-logs",
      severity: SEVERITY.low,
      detail: `${stateDir.staleLogs.length} stale job artifact(s) older than the retention window.`,
      autoFixable: false
    });
  }

  if (stateDir.telemetryOverCap) {
    issues.push({
      kind: "telemetry-over-cap",
      severity: SEVERITY.low,
      detail: `Telemetry file is ${stateDir.telemetryBytes} bytes, over the roll cap.`,
      autoFixable: false
    });
  }

  return issues;
}

/**
 * Plan cleanup actions WITHOUT executing them. Flag-gating happens here: an
 * action only appears in the plan when its required flag is set.
 *
 *   --fix   → safe actions (orphaned-broker teardown, pane markers) AND the
 *             gated wedged-broker kill (subject to THE KILL GATE).
 *   --clean → stale logs + telemetry roll.
 *
 * THE KILL GATE (safety critical): a wedged broker is only killed when
 * classification === "wedged" AND fix AND activeJobCount === 0. If any job is
 * running/queued the kill is DOWNGRADED to a report-only descriptor.
 *
 * @param {object} report
 * @param {{ fix?: boolean, clean?: boolean }} flags
 * @returns {{ safe: object[], gated: object[] }}
 */
export function planCleanup(report, { fix = false, clean = false } = {}) {
  const safe = [];
  const gated = [];
  const broker = report?.broker ?? {};
  const stateDir = report?.stateDir ?? {};
  const activeJobCount = report?.activeJobCount ?? 0;

  if (fix) {
    // Safe: tear down an orphaned broker (pid already dead → killProcess:null).
    if (broker.classification === "orphaned") {
      safe.push({
        kind: "teardown-orphaned-broker",
        detail: `Remove the stale broker session (socket/pid/log) for dead pid ${broker.pid ?? "?"}.`,
        session: broker.session ?? null
      });
    }

    // Safe: remove orphan pane markers.
    for (const markerPath of stateDir.orphanPaneMarkers ?? []) {
      safe.push({
        kind: "remove-pane-marker",
        detail: `Remove stale pane marker ${markerPath}.`,
        path: markerPath
      });
    }

    // Gated + KILL GATE: a wedged broker.
    if (broker.classification === "wedged") {
      if (activeJobCount > 0) {
        // DOWNGRADE: the broker may be serving an active job. Never auto-kill.
        gated.push({
          kind: "wedged-broker-report-only",
          detail: `Broker pid ${broker.pid} is wedged but ${activeJobCount} active job(s) exist; it may be serving an active job, so it is NOT being killed. Cancel the job(s) first or restart the broker manually.`,
          pid: broker.pid ?? null
        });
      } else {
        gated.push({
          kind: "kill-wedged-broker",
          detail: `Kill wedged broker pid ${broker.pid} and tear down its stale session.`,
          pid: broker.pid ?? null,
          session: broker.session ?? null
        });
      }
    }
  }

  if (clean) {
    // Gated: remove stale job logs/artifacts.
    for (const logPath of stateDir.staleLogs ?? []) {
      gated.push({
        kind: "remove-stale-log",
        detail: `Remove stale job artifact ${logPath}.`,
        path: logPath
      });
    }

    // Gated: roll oversized telemetry. NEVER delete — roll/truncate only.
    if (stateDir.telemetryOverCap) {
      gated.push({
        kind: "roll-telemetry",
        detail: `Roll oversized telemetry ${stateDir.telemetryFile} to a single rolled generation (never deleted).`,
        path: stateDir.telemetryFile
      });
    }
  }

  return { safe, gated };
}

/**
 * Execute a cleanup plan. Best-effort: every action runs in its own try/catch so
 * one failure never aborts the rest. Returns a list of human-readable strings
 * describing what was actually done.
 *
 * @param {{ safe: object[], gated: object[] }} plan
 * @param {object} report
 * @param {{ deps?: object }} [options]
 * @returns {string[]}
 */
export function executeCleanup(plan, report, { deps = {} } = {}) {
  const terminateImpl = deps.terminateImpl ?? terminateProcessTree;
  const teardownImpl = deps.teardownImpl ?? teardownBrokerSession;
  const rollTelemetryImpl = deps.rollTelemetryImpl ?? defaultRollTelemetry;
  const unlinkImpl = deps.unlinkImpl ?? defaultUnlink;

  // TOCTOU guard for the delete path: RE-DERIVE the live active-job set NOW,
  // never trusting the plan-time snapshot. A job that flipped queued->running (or
  // a freshly written `<id>.log`) between plan and execute must be spared.
  // `activeJobIdsImpl` wins if injected; otherwise derive from listJobs against
  // the report's workspace root. Best-effort: a resolver failure yields an empty
  // set (no extra protection) rather than aborting cleanup.
  const listJobsImpl = deps.listJobsImpl ?? listJobs;
  const resolveActiveJobIds =
    deps.activeJobIdsImpl ?? (() => deriveActiveJobIds(report?.workspaceRoot, listJobsImpl));
  let liveActiveJobIds;
  try {
    liveActiveJobIds = resolveActiveJobIds() ?? new Set();
  } catch {
    liveActiveJobIds = new Set();
  }

  const actionsTaken = [];
  const actions = [...(plan?.safe ?? []), ...(plan?.gated ?? [])];

  for (const action of actions) {
    try {
      const message = runAction(action, {
        terminateImpl,
        teardownImpl,
        rollTelemetryImpl,
        unlinkImpl,
        liveActiveJobIds
      });
      if (message) {
        actionsTaken.push(message);
      }
    } catch (error) {
      // Best-effort: record the failure but keep going.
      const detail = error instanceof Error ? error.message : String(error);
      actionsTaken.push(`Failed: ${action.kind}${action.path ? ` (${action.path})` : ""}: ${detail}`);
    }
  }

  return actionsTaken;
}

function runAction(action, { terminateImpl, teardownImpl, rollTelemetryImpl, unlinkImpl, liveActiveJobIds }) {
  switch (action.kind) {
    case "teardown-orphaned-broker": {
      const session = action.session ?? {};
      teardownImpl({
        endpoint: session.endpoint ?? null,
        pidFile: session.pidFile ?? null,
        logFile: session.logFile ?? null,
        sessionDir: session.sessionDir ?? null,
        pid: session.pid ?? null,
        killProcess: null // pid already dead — do not signal it.
      });
      return `Removed stale broker session (dead pid ${session.pid ?? "?"}).`;
    }
    case "kill-wedged-broker": {
      const session = action.session ?? {};
      terminateImpl(action.pid);
      teardownImpl({
        endpoint: session.endpoint ?? null,
        pidFile: session.pidFile ?? null,
        logFile: session.logFile ?? null,
        sessionDir: session.sessionDir ?? null,
        pid: null, // already terminated above
        killProcess: null
      });
      return `Killed wedged broker pid ${action.pid} and tore down its session.`;
    }
    case "remove-pane-marker": {
      unlinkImpl(action.path);
      return `Removed stale pane marker ${action.path}.`;
    }
    case "remove-stale-log": {
      // TOCTOU re-check: if this artifact's job became active since planning, do
      // NOT delete it — record it as skipped. The plan-time exclusion is not
      // trusted at delete time.
      const jobId = jobIdFromArtifact(path.basename(action.path));
      if (liveActiveJobIds && liveActiveJobIds.has(jobId)) {
        return `Skipped stale job artifact ${action.path}: job ${jobId} is now active.`;
      }
      unlinkImpl(action.path);
      return `Removed stale job artifact ${action.path}.`;
    }
    case "roll-telemetry": {
      rollTelemetryImpl(action.path);
      return `Rolled oversized telemetry ${action.path} (not deleted).`;
    }
    case "wedged-broker-report-only": {
      // Report-only: no mutation. Surface the explicit reason verbatim.
      return action.detail;
    }
    default:
      return null;
  }
}

export { ACTIVE_JOB_STATUSES };

// Default mutating impls. Tests inject unlinkImpl/rollTelemetryImpl/etc. so disk
// is never touched under test; these run only on the real cleanup path.

function defaultUnlink(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function defaultRollTelemetry(filePath) {
  // Roll (rename) to a single generation, mirroring telemetry.mjs. Never delete.
  if (filePath && fs.existsSync(filePath)) {
    fs.renameSync(filePath, `${filePath}.1`);
  }
}

import fs from "node:fs";
import process from "node:process";

import { openWatchPane, resolvePaneMarkerFile } from "./live-view.mjs";
import { emitTurnNotification } from "./notify.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";
import { recordTurnOutcome } from "./telemetry.mjs";
import { CodexStallError } from "./watchdog.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

/**
 * Map a REJECTED turn into a stable exit reason for telemetry. This handles only
 * the throw path; the resolve path (clean "completed" vs non-zero "interrupted")
 * is classified inline in runTrackedJob's success branch by exitStatus.
 *
 *  - CodexStallError reason "idle"                 -> "idle-stall"
 *  - CodexStallError reason "max-duration"         -> "hard-stop"
 *  - everything else (a genuine thrown Error)      -> "error"
 *
 * NOTE: broker self-heal does NOT arrive here. The broker emits
 * `turn/completed status:"interrupted"`, which RESOLVES the turn (the matching
 * `error id:null` is not id-keyed, so it never rejects a pending request). That
 * resolved-but-not-clean turn is bucketed as "interrupted" in the success branch,
 * keeping broker churn visible as its own reason rather than masquerading as
 * "completed" or being folded into "error".
 *
 * @param {unknown} error
 * @returns {"idle-stall" | "hard-stop" | "error"}
 */
function classifyFailureReason(error) {
  if (error instanceof CodexStallError) {
    if (error.reason === "max-duration") {
      return "hard-stop";
    }
    if (error.reason === "idle") {
      return "idle-stall";
    }
  }
  return "error";
}

/**
 * Single fan-out point for a finished turn. Each consumer is invoked inside its
 * own try/catch so one consumer failing can never (a) throw into the turn
 * lifecycle, nor (b) starve the other consumers. There are two consumers today —
 * per-turn telemetry and the completion/stall notifier (F2) — each in its own
 * try/catch. This stays the deliberate EXTENSION POINT: a later feature (e.g. a
 * metrics emitter) registers another independent, try/caught block right here,
 * reading from the same `outcome` object.
 *
 * @param {object} outcome canonical per-turn outcome (see runTrackedJob)
 * @param {{
 *   cwd: string,
 *   telemetryRecorder?: typeof recordTurnOutcome,
 *   notifier?: typeof emitTurnNotification
 * }} context
 */
function emitTurnOutcome(
  outcome,
  { cwd, telemetryRecorder = recordTurnOutcome, notifier = emitTurnNotification } = {}
) {
  // Consumer 1: per-turn telemetry. recordTurnOutcome is already best-effort,
  // but we wrap it again so an injected/overridden recorder that throws is
  // still contained here.
  try {
    telemetryRecorder(outcome, { cwd });
  } catch {
    // swallow — a telemetry failure must never disturb the turn lifecycle.
  }

  // Consumer 2: completion/stall notification (F2). Independent of telemetry and
  // wrapped in its OWN try/catch — it must never share telemetry's catch, so a
  // notifier failure can neither disturb the turn lifecycle nor starve the
  // telemetry consumer above. emitTurnNotification is itself fire-and-forget and
  // never throws, but we contain it here as a second line of defense (and so an
  // injected/overridden notifier that throws is still isolated).
  try {
    notifier(outcome);
  } catch {
    // swallow — a notification failure must never disturb the turn lifecycle.
  }

  // EXTENSION POINT: add additional independent consumers below, each in its own
  // try/catch reading from `outcome`. Do NOT let a new consumer share a catch
  // with another consumer — isolation per consumer is the contract.
}

/**
 * Remove the auto-pane marker so a future run of the same job/log can reopen a
 * fresh pane. Best-effort: a missing marker or unlink failure is ignored.
 *
 * @param {string | null | undefined} logFile
 */
function clearPaneMarker(logFile) {
  if (!logFile) {
    return;
  }
  try {
    fs.rmSync(resolvePaneMarkerFile(logFile), { force: true });
  } catch {
    // Best-effort cleanup — never let marker removal disturb job finalization.
  }
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  // Best-effort live tee: a logging failure (full disk, unwritable path) must
  // never abort an in-flight Codex turn.
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
  } catch {
    // swallow — visibility is best-effort
  }
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
  } catch {
    // swallow — visibility is best-effort
  }
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  // Epoch-ms bookends for telemetry duration. Kept separate from the ISO
  // timestamps the stored job record uses so the outcome carries raw numbers.
  const startedAtMs = Date.now();
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  // Auto-open a tmux pane tailing the live log (guarded so only one pane opens
  // per job). Best-effort: openWatchPane never throws.
  openWatchPane(runningRecord.logFile);

  // Build the canonical per-turn outcome once, fan it out through the shared
  // seam. restartCount is hardcoded to 0 because no companion-side restart
  // counter exists in v1 (the broker owns restarts and does not surface a count
  // back here); a later feature can populate it without changing the schema.
  const buildOutcome = (exitReason, threadId) => {
    const endedAtMs = Date.now();
    return {
      startedAt: startedAtMs,
      endedAt: endedAtMs,
      durationMs: endedAtMs - startedAtMs,
      exitReason,
      threadId: threadId ?? null,
      kind: job.kind ?? null,
      title: job.title ?? null,
      restartCount: 0
      // usage intentionally omitted: the app-server does not surface token/usage
      // counts to the companion, so there is nothing honest to record here.
    };
  };
  const emitOutcome = (outcome) =>
    emitTurnOutcome(outcome, {
      cwd: job.workspaceRoot,
      telemetryRecorder: options.telemetryRecorder,
      notifier: options.notifier
    });

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    clearPaneMarker(runningRecord.logFile);
    // The turn RESOLVED, but resolution is not the same as clean completion.
    // buildResultStatus returns 0 only for finalTurn.status === "completed" and 1
    // for ANY other resolved settlement, so `exitStatus !== 0` captures every
    // non-clean resolve — not just one cause. In practice this is dominated by a
    // broker self-heal (the broker emits `turn/completed status:"interrupted"`,
    // which resolves rather than rejects), but other non-"completed" statuses
    // (e.g. an aborted turn) land here too. None of these reach the catch block
    // below. We split by exitStatus: a clean 0 is "completed"; any non-zero
    // resolve is "interrupted" — its own VISIBLE bucket (named for the dominant
    // cause) so /codex-plus:stats surfaces this churn instead of hiding it inside
    // "completed".
    const settledReason = execution.exitStatus === 0 ? "completed" : "interrupted";
    emitOutcome(buildOutcome(settledReason, execution.threadId));
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    clearPaneMarker(runningRecord.logFile);
    emitOutcome(buildOutcome(classifyFailureReason(error), existing.threadId ?? job.threadId));
    throw error;
  }
}

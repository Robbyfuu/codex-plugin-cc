import fs from "node:fs";
import process from "node:process";

import { openWatchPane, resolvePaneMarkerFile } from "./live-view.mjs";
import { emitTurnNotification } from "./notify.mjs";
import { redactSecrets } from "./redact.mjs";
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

// A job in one of these statuses has already SETTLED. The shutdown flush must
// never clobber a settled job: doing so loses a user's `cancelled` outcome (the
// cancel race) or rewrites a `completed`/`failed` job. Only an in-flight job
// (`running`/`queued`) is eligible to be flushed to `failed`.
const FLUSHABLE_STATUSES = new Set(["running", "queued"]);

/**
 * Plan 003: minimize the prompt persisted to the state directory once a job is
 * terminal. While a job is `queued`/`running` the detached worker still needs
 * the full `request.prompt` to execute it, so the prompt is left intact on those
 * writes. Once the job reaches a terminal status the verbatim prompt is no longer
 * needed — resume builds a fresh continuation prompt keyed on the surviving Codex
 * `threadId` (see prepareTaskResume) and never reads the original persisted
 * prompt — so we drop it from the stored record.
 *
 * What is preserved: the rest of `request` (cwd/model/effort/write/resumeThreadId/
 * jobId), because prepareTaskResume DOES read those to colocate and re-launch the
 * resumed job. Only `prompt` is removed. The short `summary` is kept but passed
 * through redactSecrets as defense-in-depth so an obvious secret shape never
 * survives in cleartext.
 *
 * Pure: returns a fresh record (and a fresh nested `request`) without mutating
 * the input, so callers can scrub a record built from an existing object safely.
 *
 * @param {object} record the job record about to be persisted at a terminal status
 * @returns {object} a copy safe to write to the state directory
 */
export function scrubTerminalJobRecord(record) {
  if (!record || typeof record !== "object") {
    return record;
  }

  const scrubbed = { ...record };

  if (typeof scrubbed.summary === "string") {
    scrubbed.summary = redactSecrets(scrubbed.summary);
  }

  if (scrubbed.request && typeof scrubbed.request === "object") {
    // Drop ONLY the verbatim prompt; keep everything resume reads.
    const { prompt: _droppedPrompt, ...requestWithoutPrompt } = scrubbed.request;
    scrubbed.request = requestWithoutPrompt;
  }

  return scrubbed;
}

/**
 * Best-effort flush of an in-flight job to `failed`. Used by the worker's
 * termination handlers (#228) so a worker killed by SIGTERM/SIGINT does not
 * strand its job as `running`. Mirrors runTrackedJob's catch-branch shape
 * (status/phase/pid/completedAt) so the record looks like any other failure.
 *
 * Cancel-race guard: on `/peer:cancel`, the parent writes `cancelled`
 * while it SIGTERMs the worker tree, racing this handler over the SAME unlocked
 * job. So this re-reads the current job status and flushes ONLY when it is still
 * `running`/`queued`; a terminal status (`cancelled`/`completed`/`failed`) is
 * left untouched. A missing job record is treated as flushable (the worker died
 * before persisting) so we still record the abnormal termination.
 *
 * Never throws: a read/write failure is swallowed so it stays safe to call from
 * a signal handler during shutdown.
 *
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {string} note human-readable failure note
 * @param {{ writeJobFileImpl?: typeof writeJobFile, upsertJobImpl?: typeof upsertJob }} [options]
 */
export function flushJobToFailed(workspaceRoot, jobId, note, options = {}) {
  const writeJobFileImpl = options.writeJobFileImpl ?? writeJobFile;
  const upsertJobImpl = options.upsertJobImpl ?? upsertJob;

  // Re-read to lose as little of the cancel race as possible. If the current
  // status is already terminal, do NOTHING — never overwrite a settled outcome.
  let existing;
  try {
    existing = readStoredJobOrNull(workspaceRoot, jobId);
  } catch {
    // A read failure must not strand the worker: fall through and attempt the
    // flush as if the record were absent.
    existing = null;
  }
  if (existing && !FLUSHABLE_STATUSES.has(existing.status)) {
    return;
  }

  const completedAt = nowIso();
  const base = existing ?? { id: jobId };
  try {
    // Terminal write → scrub the verbatim prompt (resume keys on threadId).
    writeJobFileImpl(workspaceRoot, jobId, scrubTerminalJobRecord({
      ...base,
      status: "failed",
      phase: "failed",
      pid: null,
      error: note,
      errorMessage: base.errorMessage ?? note,
      completedAt
    }));
  } catch {
    // Best-effort: never throw out of a shutdown path.
  }
  try {
    upsertJobImpl(workspaceRoot, {
      id: jobId,
      status: "failed",
      phase: "failed",
      pid: null,
      error: note,
      errorMessage: note,
      completedAt
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Register SIGTERM/SIGINT handlers on the worker process so that, when the
 * detached task worker is killed (session teardown, manual cancel, reboot
 * signal), the in-flight job is flushed to `failed` before the process exits
 * (#228). After flushing, the handler restores the default disposition and
 * re-raises the same signal so the process still terminates with the correct
 * exit semantics.
 *
 * @param {{
 *   workspaceRoot: string,
 *   jobId: string,
 *   proc?: NodeJS.Process,
 *   flushImpl?: typeof flushJobToFailed
 * }} params
 */
export function registerWorkerTerminationHandlers({ workspaceRoot, jobId, proc = process, flushImpl = flushJobToFailed }) {
  const signals = ["SIGTERM", "SIGINT"];
  // Shared single-flush guard: if SIGTERM and SIGINT both arrive (or the same
  // signal fires more than once), the job must be flushed AT MOST once. The
  // terminal-status re-check inside flushJobToFailed complements this, but the
  // guard avoids redundant reads/writes from the second signal entirely.
  let flushed = false;

  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      if (!flushed) {
        flushed = true;
        flushImpl(workspaceRoot, jobId, `worker received ${signal}; flushing job to failed (pid ${proc.pid} terminating)`);
      }
      // Remove ONLY our own handler for this signal — never `removeAllListeners`,
      // which would nuke foreign listeners other code legitimately registered.
      try {
        proc.removeListener(signal, handler);
      } catch {
        // ignore — best-effort detach.
      }
      try {
        proc.kill(proc.pid, signal);
      } catch {
        // If re-raising fails for any reason, fall back to a clean exit so we
        // never leave the worker wedged.
        proc.exit?.(1);
      }
    };
    handlers.set(signal, handler);
    proc.once(signal, handler);
  }
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
    // Terminal write → scrub the verbatim prompt (resume keys on threadId).
    writeJobFile(job.workspaceRoot, job.id, scrubTerminalJobRecord({
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    }));
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
    // cause) so /peer:stats surfaces this churn instead of hiding it inside
    // "completed".
    // NOTE: `settledReason` is a TELEMETRY label only. The status PERSISTED above
    // on this branch is "completed" or "failed" (never the literal "interrupted"),
    // and both went through scrubTerminalJobRecord — so there is no unscrubbed
    // "interrupted" record despite this telemetry bucket name.
    const settledReason = execution.exitStatus === 0 ? "completed" : "interrupted";
    emitOutcome(buildOutcome(settledReason, execution.threadId));
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    // Terminal write → scrub the verbatim prompt (resume keys on threadId).
    writeJobFile(job.workspaceRoot, job.id, scrubTerminalJobRecord({
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    }));
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

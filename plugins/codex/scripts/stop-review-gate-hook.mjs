#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { fenceUntrusted, loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

async function readHookInput() {
  // Non-blocking-safe stdin read so a never-closing stdin or EAGAIN under
  // concurrent sessions can never hang the hook (#7).
  const raw = (await readStdinIfPiped()).trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

export function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  // The prior assistant turn is UNTRUSTED: it may quote repo/Codex content that
  // a contributor crafted to steer this gate (prompt injection). Fence it as
  // data so a forged ALLOW/BLOCK or "ignore instructions" line inside it lands
  // as content to review, not as instructions to follow. The "Previous Claude
  // response:" label is trusted scaffolding and stays outside the fence.
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", fenceUntrusted("CLAUDE_RESPONSE_BLOCK", lastAssistantMessage)].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /peer:setup.`;
}

const MANUAL_REVIEW_HINT = "Run /peer:review --wait manually, or end the session and review later.";

/**
 * Does the text look like an upstream rate-limit / quota error? Matches HTTP
 * 429 and any "rate limit" phrasing, case-insensitively.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeRateLimit(text) {
  return /\b429\b/.test(text) || /rate[\s_-]?limit/i.test(text);
}

/**
 * Classify the review task's final output into a verdict.
 *
 *  - "allow"       → a parseable ALLOW verdict; do not block.
 *  - "block"       → a genuine, parseable BLOCK verdict; this is the ONLY
 *                    outcome that blocks the stop.
 *  - "infra-error" → empty output or no recognizable verdict. NOT a real
 *                    review finding, so it must NOT block (#6). `kind` carries
 *                    the specific cause: "empty" | "rate-limit" | "parse".
 *
 * @param {unknown} rawOutput
 * @returns {{ verdict: "allow"|"block"|"infra-error", reason: string|null, kind?: string }}
 */
export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { verdict: "infra-error", kind: "empty", reason: "the review returned no final output" };
  }

  // Scan EVERY line for an explicit verdict, not just the first one. The model
  // sometimes prefaces its verdict with prose, so a genuine `BLOCK:` (or
  // `ALLOW:`) can land on a later line. First-line-only parsing misclassified
  // those as a parse infra-error and failed open — silently dropping real BLOCK
  // findings. We only declare a parse failure when NO verdict exists anywhere.
  // BLOCK wins over ALLOW if both somehow appear: a block finding is the
  // safety-critical signal and must never be masked by a stray ALLOW line.
  const lines = text.split(/\r?\n/);
  let allowMatch = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("BLOCK:")) {
      const reason = line.slice("BLOCK:".length).trim() || text;
      return { verdict: "block", reason };
    }
    if (!allowMatch && line.startsWith("ALLOW:")) {
      allowMatch = line;
    }
  }
  if (allowMatch) {
    return { verdict: "allow", reason: null };
  }

  // No recognizable verdict anywhere. A transient Codex failure (rate limit,
  // auth, network) often surfaces here as an error string rather than a verdict
  // — treat it as infra, never as a block. Fail open ONLY in this no-verdict case.
  if (looksLikeRateLimit(text)) {
    return { verdict: "infra-error", kind: "rate-limit", reason: text };
  }
  return { verdict: "infra-error", kind: "parse", reason: "the review returned an unexpected answer" };
}

/**
 * Read a STRUCTURED verdict out of the model's final message, falling back to
 * the in-band substring parse only when no structured verdict is present.
 *
 * The verdict now travels in a schema-constrained field (see
 * `schemas/stop-gate-output.schema.json`, requested via the Codex output schema
 * for the stop-review task). Moving the verdict out-of-band from the free-text
 * body is the plan-005 injection mitigation: crafted content in the diff / prior
 * assistant turn can no longer flip the gate by making Codex emit a leading
 * `ALLOW:`/`BLOCK:` line, because the decision reads the structured field, not
 * the prose.
 *
 * Trust rules:
 *  - A structured `block` is UNCONDITIONAL. A body-text `ALLOW:` (or anything
 *    else in the reason/body) can never override it.
 *  - A structured `allow` is trusted as-is and is NOT re-evaluated against the
 *    body — stray `BLOCK:`-looking prose in the reason cannot re-block it.
 *  - Any other shape (output is not JSON, or JSON without a recognized verdict)
 *    falls through to `parseStopReviewOutput`, which keeps the legacy substring
 *    behavior AND the "no verdict / rate-limit / parse → infra-error → fail
 *    open" guarantee unchanged. Infra failures NEVER block (#6).
 *
 * @param {unknown} rawOutput
 * @returns {{ verdict: "allow"|"block"|"infra-error", reason: string|null, kind?: string }}
 */
export function classifyStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();

  if (text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const verdict = typeof parsed.verdict === "string" ? parsed.verdict.trim().toLowerCase() : "";
      const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";

      if (verdict === "block") {
        // Unconditional: ignore the body entirely. Fall back to a generic reason
        // when the structured reason is blank so the operator still gets a message.
        return { verdict: "block", reason: reason || "the review flagged unresolved issues" };
      }
      if (verdict === "allow") {
        return { verdict: "allow", reason: null };
      }
      // JSON without a usable verdict: do NOT trust it as a verdict. Fall through
      // to the body parse, which fails open if it finds nothing either.
    }
  }

  return parseStopReviewOutput(rawOutput);
}

/**
 * Map a classified review result to a stop-gate outcome. Pure: returns either a
 * block decision (`{ decision: "block", reason }`) for a genuine BLOCK verdict,
 * or an approve outcome (`{ decision: null, warning }`) for ALLOW and every
 * infra failure. Infra failures carry a human-readable warning for stderr that
 * explains what failed and how to run the review manually.
 *
 * @param {{ verdict: string, reason?: string|null, kind?: string }} reviewResult
 * @returns {{ decision: "block"|null, reason?: string, warning: string }}
 */
export function buildStopGateOutcome(reviewResult) {
  const { verdict, reason, kind } = reviewResult ?? {};

  if (verdict === "block") {
    return {
      decision: "block",
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`,
      warning: ""
    };
  }

  if (verdict === "allow") {
    return { decision: null, warning: "" };
  }

  // Any infra failure: approve, but warn on stderr. Never block on infrastructure.
  const detail = reason ? ` (${reason})` : "";
  let what;
  switch (kind) {
    case "spawn":
      what = `could not start (spawn error)${detail}`;
      break;
    case "timeout":
      what = "timed out";
      break;
    case "exit":
      what = `exited non-zero${detail}`;
      break;
    case "empty":
      what = "returned no output";
      break;
    case "parse":
      what = "returned an unexpected/invalid response";
      break;
    case "rate-limit":
      what = `hit an upstream rate limit${detail}`;
      break;
    default:
      what = `failed${detail}`;
  }

  const warning = `Codex stop-time review skipped: the review task ${what}. NOT blocking the session on this infrastructure error. ${MANUAL_REVIEW_HINT}`;
  return { decision: null, warning };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return { verdict: "infra-error", kind: "timeout", reason: "timed out after 15 minutes" };
  }

  if (result.error) {
    return { verdict: "infra-error", kind: "spawn", reason: result.error.message };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    // A non-zero exit whose output smells like a rate limit gets the specific
    // rate-limit treatment; otherwise it is a generic non-zero-exit infra error.
    if (detail && looksLikeRateLimit(detail)) {
      return { verdict: "infra-error", kind: "rate-limit", reason: detail };
    }
    return { verdict: "infra-error", kind: "exit", reason: detail || `exit ${result.status}` };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { verdict: "infra-error", kind: "parse", reason: "invalid JSON from the review task" };
  }
  // The review task is launched with the stop-gate output schema (see
  // codex-companion.mjs executeTaskRun), so `rawOutput` is normally the
  // structured verdict JSON. classifyStopReviewOutput reads that structured
  // field first and only falls back to the in-band substring parse when it is
  // absent — preserving the infra→fail-open guarantee in every no-verdict case.
  return classifyStopReviewOutput(payload?.rawOutput);
}

async function main() {
  const input = await readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /peer:status and use /peer:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  const outcome = buildStopGateOutcome(review);

  // Only a genuine BLOCK verdict blocks. ALLOW and every infra failure approve;
  // infra failures additionally surface a stderr warning so the operator knows
  // the review did not actually run (#6).
  if (outcome.decision === "block") {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${outcome.reason}` : outcome.reason
    });
    return;
  }

  logNote(outcome.warning || null);
  logNote(runningTaskNote);
}

// Only run the hook when invoked as a script. Importing the module (for unit
// tests of the pure decision functions) must NOT trigger the hook.
const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

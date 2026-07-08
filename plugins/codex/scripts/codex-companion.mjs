#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import {
  addAccount,
  listAccounts,
  resolveCodexEnv,
  useAccount
} from "./lib/accounts.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { readCompanionEnv } from "./lib/companion-env.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerRecover,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { buildDoctorReport, planCleanup, executeCleanup } from "./lib/doctor.mjs";
import { isWatchPaneEnabled, openWatchPane } from "./lib/live-view.mjs";
import { emitTurnNotification } from "./lib/notify.mjs";
import { fenceUntrusted, loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { redactSecrets } from "./lib/redact.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { aggregateTelemetry, readTelemetry, recordTurnOutcome } from "./lib/telemetry.mjs";
import { readBrokerTelemetry } from "./lib/broker-telemetry.mjs";
import { prepareTaskResume } from "./lib/task-resume.mjs";
import { buildHistoryReport, DEFAULT_HISTORY_LIMIT } from "./lib/history.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  registerWorkerTerminationHandlers,
  runTrackedJob,
  scrubTerminalJobRecord,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderHistoryReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatsReport,
  renderStatusReport,
  renderTaskResult,
  renderDoctorReport
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const STOP_GATE_SCHEMA = path.join(ROOT_DIR, "schemas", "stop-gate-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// The active-account env, resolved ONCE per companion invocation (each command
// is a fresh process). resolveCodexEnv is THE single injection point: when an
// account is active it carries CODEX_HOME; with none active it is process.env
// unchanged (byte-for-byte today's single-account behavior). Threaded into every
// codex spawn path — the broker spawn and direct fallback (via runAppServer*),
// getCodexAuthStatus, findLatestTaskThread, and the detached task worker — so no
// turn ever runs under the wrong account.
const codexEnv = resolveCodexEnv(process.env);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh|--resume-id <job-id>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs stats [--json]",
      "  node scripts/codex-companion.mjs history [--limit <n>] [--json]",
      "  node scripts/codex-companion.mjs doctor [--fix] [--clean] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "  node scripts/codex-companion.mjs watch [job-id] [--json]",
      "  node scripts/codex-companion.mjs account [add <name> [--home <path>] | use <name> | list] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd, { env: codexEnv });
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/peer:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  // REVIEW_INPUT (the git diff / working-tree text) and USER_FOCUS (free-form
  // focus text) are UNTRUSTED: when reviewing an external contributor's branch,
  // crafted text inside either can otherwise land in the model's instruction
  // position and steer the verdict (prompt injection). Fence them as data.
  // REVIEW_KIND, TARGET_LABEL, and REVIEW_COLLECTION_GUIDANCE are trusted,
  // internally-generated values and stay unfenced.
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: fenceUntrusted("USER_FOCUS", focusText || "No extra focus provided."),
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: fenceUntrusted("REVIEW_INPUT", context.content)
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/peer:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/peer:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/peer:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/peer:review` target is not supported by the built-in reviewer. Retry with `/peer:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return readCompanionEnv("SESSION_ID", process.env) ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /peer:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot, { env: codexEnv });
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress,
      env: codexEnv
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    env: codexEnv
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast || Boolean(request.resumeThreadId)
  });

  // A direct resumeThreadId (from `task --resume-id <job-id>`) takes precedence:
  // the caller already resolved the exact surviving thread, so we never search.
  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // The stop-review gate launches itself through `task` (see
  // stop-review-gate-hook.mjs). When this is that task, request a structured
  // verdict via the stop-gate output schema — the same `outputSchema` mechanism
  // the adversarial-review path uses with REVIEW_SCHEMA. Moving the verdict into
  // a schema-constrained field (out-of-band from the free-text body) is the
  // plan-005 injection mitigation. Detection reuses the marker already used for
  // task metadata; a resumed task is never the gate, so it keeps the free-form path.
  const isStopReviewTask =
    !resumeThreadId && String(request.prompt ?? "").includes(STOP_REVIEW_TASK_MARKER);

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT),
    env: codexEnv,
    ...(isStopReviewTask ? { outputSchema: readOutputSchema(STOP_GATE_SCHEMA) } : {})
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    // The summary is persisted to state (state.json + jobs/<id>.json) and shown
    // by /peer:status. Redact obvious secret shapes so a pasted credential does
    // not land in cleartext while keeping the summary human-useful.
    summary: redactSecrets(shorten(prompt || fallbackSummary))
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /peer:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, id, resumedFrom }) {
  return createJobRecord({
    id: id ?? generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...(resumedFrom ? { resumedFrom } : {})
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, resumeThreadId, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    ...(resumeThreadId ? { resumeThreadId } : {}),
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath, env: codexEnv });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

async function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || (await readStdinIfPiped());
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    // The detached worker is a fresh companion process; thread the resolved
    // active-account env so its codex spawns inherit the SAME CODEX_HOME the
    // enqueueing process saw, even if accounts.json changes before it starts.
    env: codexEnv,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "resume-id"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);

  // `--resume-id <job-id>` is the manual resume path for a task killed by the
  // hard-duration ceiling (or an idle stall). It resolves the surviving thread
  // from the stored job and launches a NEW tracked job linked via resumedFrom.
  if (options["resume-id"]) {
    await handleTaskResume(argv, { options, positionals, cwd, workspaceRoot, model, effort });
    return;
  }

  const prompt = await readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskResume(argv, { options, positionals, cwd, workspaceRoot, model, effort }) {
  ensureCodexAvailable(cwd);

  // An optional continuation prompt may follow the flags (positionals) or come
  // from a prompt file / stdin; default to "Continue where you left off." inside
  // prepareTaskResume when none is supplied.
  const overridePrompt = (await readTaskPrompt(cwd, options, positionals)).trim();
  const write = options.write === undefined ? undefined : Boolean(options.write);

  const plan = prepareTaskResume(workspaceRoot, options["resume-id"], {
    prompt: overridePrompt || undefined,
    model,
    effort,
    write
  });

  // Colocate the resumed job under the SOURCE's workspace (not the current
  // invocation's), so the chain (source + resumed) lives in one state dir and the
  // resumed job appears next to its source in /status, /history, /stats.
  const resumeWorkspaceRoot = plan.workspaceRoot;
  // The source's original cwd: the worker (background) resolves its workspace from
  // this, landing on the same state dir; the foreground run also uses it.
  const resumeCwd = plan.request.cwd;

  // Materialize a full tracked-job record (createdAt/sessionId) from the plan,
  // preserving the resumedFrom link so status/result show the chain.
  const job = createCompanionJob({
    id: plan.job.id,
    prefix: "task",
    kind: "task",
    title: plan.job.title,
    workspaceRoot: resumeWorkspaceRoot,
    jobClass: "task",
    summary: plan.job.summary,
    write: plan.job.write,
    resumedFrom: plan.job.resumedFrom
  });

  const request = buildTaskRequest({
    cwd: resumeCwd,
    model: plan.request.model,
    effort: plan.request.effort,
    prompt: plan.request.prompt,
    write: plan.request.write,
    resumeLast: false,
    resumeThreadId: plan.request.resumeThreadId,
    jobId: job.id
  });

  if (options.background) {
    // Spawn the detached worker against the SOURCE cwd so it resolves the same
    // workspace state dir the job record was written to.
    const { payload } = enqueueBackgroundTask(resumeCwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch({ ...payload, title: job.title }), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  // #228: if this detached worker is killed (session teardown, reboot signal),
  // flush the in-flight job to `failed` before dying so it is never stranded as
  // `running`.
  registerWorkerTerminationHandlers({ workspaceRoot, jobId: options["job-id"] });

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleStats(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const records = readTelemetry({ cwd: workspaceRoot });
  const brokerEvents = readBrokerTelemetry({ cwd: workspaceRoot });
  const report = aggregateTelemetry(records, { env: process.env, brokerEvents });
  outputResult(options.json ? report : renderStatsReport(report), options.json);
}

function handleHistory(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "limit"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const limit = options.limit == null ? DEFAULT_HISTORY_LIMIT : Number(options.limit);
  // Turns ONLY (no broker events) — history is a focused per-turn log.
  const records = readTelemetry({ cwd: workspaceRoot });
  const report = buildHistoryReport(records, { limit });
  outputResult(options.json ? report : renderHistoryReport(report), options.json);
}

async function handleDoctor(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "fix", "clean"]
  });

  // The state dir is keyed by workspace root (resolveStateDir resolves through
  // resolveWorkspaceRoot), so doctor must diagnose the workspace, not the raw
  // cwd, to match where jobs/telemetry/broker.json actually live.
  const workspaceRoot = resolveCommandWorkspace(options);
  const fix = Boolean(options.fix);
  const clean = Boolean(options.clean);

  const report = await buildDoctorReport(workspaceRoot, { env: process.env });

  if (fix || clean) {
    const plan = planCleanup(report, { fix, clean });
    report.plannedActions = { safe: plan.safe, gated: plan.gated };
    report.actionsTaken = executeCleanup(plan, report);
  }

  outputResult(options.json ? report : renderDoctorReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function resolveBrokerEndpointForCancel(workspaceRoot) {
  return readCompanionEnv("BROKER_ENDPOINT", process.env) ?? loadBrokerSession(workspaceRoot)?.endpoint ?? null;
}

async function recoverBrokerForCancel(workspaceRoot, options = {}) {
  const { logFile = null, threadId = null } = options;
  const endpoint = resolveBrokerEndpointForCancel(workspaceRoot);
  if (!endpoint) {
    return { attempted: false, recovered: false };
  }
  // Scope the recovery to the cancelled job's thread so we never restart the
  // shared child while a DIFFERENT job owns the active slot.
  const result = await sendBrokerRecover(endpoint, { threadId });
  appendLogLine(
    logFile,
    result.recovered
      ? "Recovered the shared Codex broker runtime."
      : result.owned === false
        ? "Shared Codex broker is busy with another job; left its runtime untouched."
        : `Shared Codex broker recovery did not confirm${result.detail ? `: ${result.detail}` : "."}`
  );
  return { attempted: true, recovered: result.recovered, owned: result.owned };
}

async function handleCancelWithoutJob(cwd, options, noJobMessage) {
  // No tracked job is active, but a wedged broker can still be holding the
  // single-flight slot. With no threadId the broker only restarts when its slot
  // is idle/unowned, so this can never disturb another job's live turn.
  const workspaceRoot = resolveCommandWorkspace(options);
  const broker = await recoverBrokerForCancel(workspaceRoot);
  if (!broker.attempted) {
    // Preserve the session-aware wording from resolveCancelableJob so a user
    // who only owns other-session jobs learns the refusal is scoped to their
    // Claude session, not a global "nothing to cancel".
    throw new Error(noJobMessage || "No active Codex jobs to cancel.");
  }
  const payload = {
    jobId: null,
    status: "no-active-job",
    brokerRecoveryAttempted: broker.attempted,
    brokerRecovered: broker.recovered
  };
  const rendered = broker.recovered
    ? "No active Codex job, but the shared Codex broker runtime was recovered.\n"
    : "No active Codex job. Attempted to recover the shared Codex broker runtime.\n";
  outputCommandResult(payload, rendered, options.json);
}

function resolveWatchTargetJob(workspaceRoot, reference) {
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  if (reference) {
    const exact = jobs.find((job) => job.id === reference || job.id.startsWith(reference));
    if (!exact) {
      throw new Error(`No job found for "${reference}". Run /peer:status to list jobs.`);
    }
    return exact;
  }
  const active = jobs.find((job) => (job.status === "queued" || job.status === "running") && job.logFile);
  if (active) {
    return active;
  }
  return jobs.find((job) => job.logFile) ?? null;
}

async function handleWatch(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const reference = positionals[0] ?? "";
  const job = resolveWatchTargetJob(workspaceRoot, reference);

  if (!job) {
    const payload = { opened: false, reason: "no-job" };
    outputCommandResult(payload, "No Codex job with a live log was found for this session.\n", options.json);
    return;
  }

  if (!isWatchPaneEnabled(process.env)) {
    const payload = { opened: false, reason: "no-tmux", jobId: job.id, liveLog: job.logFile ?? null };
    const rendered = job.logFile
      ? `Not inside tmux (or watch panes disabled). Tail the live log manually:\n  tail -F ${job.logFile}\n`
      : "Not inside tmux (or watch panes disabled), and no live log is available.\n";
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  const result = openWatchPane(job.logFile, { force: true });
  const payload = {
    opened: result.opened,
    reason: result.reason ?? null,
    jobId: job.id,
    liveLog: job.logFile ?? null
  };
  const rendered = result.opened
    ? `Opened a tmux pane tailing ${job.logFile} for job ${job.id}.\n`
    : `Could not open a tmux pane (${result.reason ?? "unknown"}). Tail manually:\n  tail -F ${job.logFile}\n`;
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  let workspaceRoot;
  let job;
  try {
    ({ workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env }));
  } catch (error) {
    // Only fall back to broker-only recovery when there simply is no active job
    // (so a wedged broker can still be unblocked). Ambiguous-reference and
    // "multiple jobs active" errors must still surface so the user disambiguates.
    const message = error instanceof Error ? error.message : String(error);
    if (!reference && /no active codex jobs to cancel/i.test(message)) {
      await handleCancelWithoutJob(cwd, options, message);
      return;
    }
    throw error;
  }

  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);

  // A killed job PID does not kill the broker's codex child. Force the broker to
  // interrupt + restart its runtime so a wedged single-flight slot recovers now.
  // Scope it to THIS job's thread so we never restart the shared child while a
  // different job owns the active slot. Only meaningful for a job that was
  // actually running a turn (has a threadId); otherwise it owns no broker slot.
  //
  // KNOWN LIMITATION (detached review): for a DETACHED `/peer:review` this
  // threadId is the reviewThreadId (captureTurn promotes it to state.threadId),
  // while the broker keys its slot on the source thread until the review/start
  // response resolves and adds both ids. So a detached cancel recovers in steady
  // state but can no-op if it lands inside that brief review/start window. The
  // inline `/peer:review` path is unaffected. See the matching note at
  // broker/recover in app-server-broker.mjs.
  const brokerRecovery =
    threadId && job.status === "running"
      ? await recoverBrokerForCancel(workspaceRoot, { logFile: job.logFile, threadId })
      : { attempted: false, recovered: false };

  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  // Terminal write → scrub the verbatim prompt like the three terminal sites in
  // tracked-jobs.mjs. `cancelled` is NON-resumable (render.mjs
  // RESUMABLE_TERMINAL_STATUSES = {failed, interrupted}), so the retained prompt
  // has zero functional benefit — keeping it would be a pure cleartext leak.
  writeJobFile(workspaceRoot, job.id, scrubTerminalJobRecord({
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  }));
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  // Cancellation happens outside runTrackedJob's lifecycle (the worker process is
  // killed), so the canonical `cancelled` outcome is built and fanned out here
  // directly rather than through emitTurnOutcome. startedAt is derived from the
  // stored job's ISO timestamp; if absent we fall back to the cancel time so
  // durationMs is a non-negative number rather than NaN.
  const cancelEndedAtMs = Date.parse(completedAt);
  const cancelStartedAtMs =
    Date.parse(existing.startedAt ?? job.startedAt ?? completedAt) || cancelEndedAtMs;
  const cancelOutcome = {
    startedAt: cancelStartedAtMs,
    endedAt: cancelEndedAtMs,
    durationMs: Math.max(0, cancelEndedAtMs - cancelStartedAtMs),
    exitReason: "cancelled",
    threadId: threadId ?? null,
    kind: job.kind ?? null,
    title: job.title ?? null,
    restartCount: 0
    // usage intentionally omitted (no token/usage data is surfaced).
  };

  // Consumer 1: telemetry. Each consumer below gets its OWN try/catch so a
  // failure in one can neither break the cancel nor starve the other — the same
  // consumer-isolation contract emitTurnOutcome enforces for the normal path.
  try {
    recordTurnOutcome(cancelOutcome, { cwd: workspaceRoot });
  } catch {
    // swallow — telemetry must never disturb cancellation.
  }

  // Consumer 2: completion/stall notification, so a cancel notifies too. Own
  // try/catch, fire-and-forget — emitTurnNotification never awaits and never
  // throws, but we contain it here as a second line of defense.
  try {
    emitTurnNotification(cancelOutcome);
  } catch {
    // swallow — a notification failure must never disturb cancellation.
  }

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    brokerRecoveryAttempted: brokerRecovery.attempted,
    brokerRecovered: brokerRecovery.recovered
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

// Force the current workspace's broker to respawn on the next turn so it picks
// up the newly-active account's CODEX_HOME. A running broker holds the OLD env
// (it spawned its codex child at launch), so we reuse the EXISTING SessionEnd
// teardown path — shutdown + teardown + clear — WITHOUT touching the broker
// protocol. ensureBrokerSession then transparently respawns on the next call.
// Best-effort: a switch must succeed even if no broker is running.
async function respawnBrokerForUse(cwd) {
  const brokerEndpointEnv = readCompanionEnv("BROKER_ENDPOINT", process.env);
  const brokerSession =
    loadBrokerSession(cwd) ??
    (brokerEndpointEnv
      ? { endpoint: brokerEndpointEnv }
      : null);
  if (!brokerSession) {
    return false;
  }
  const endpoint = brokerSession.endpoint ?? null;
  if (endpoint) {
    await sendBrokerShutdown(endpoint);
  }
  teardownBrokerSession({
    endpoint,
    pidFile: brokerSession.pidFile ?? null,
    logFile: brokerSession.logFile ?? null,
    sessionDir: brokerSession.sessionDir ?? null,
    pid: brokerSession.pid ?? null,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
  return true;
}

function renderAccountAdd(account, loginCommand) {
  return [
    `Registered account "${account.name}".`,
    `  CODEX_HOME: ${account.home}`,
    "",
    "Run this ONCE to log this account in (opens the OpenAI OAuth flow in your browser):",
    "",
    `  ${loginCommand}`,
    "",
    `Then activate it with: /peer:account use ${account.name}`
  ].join("\n");
}

function renderAccountList(rows) {
  if (rows.length === 0) {
    return "No accounts registered.";
  }
  const lines = ["Accounts:"];
  for (const row of rows) {
    const marker = row.active ? "*" : " ";
    const login = row.loggedIn ? "logged in" : "not logged in";
    lines.push(`  ${marker} ${row.name} — ${row.home} (${login})`);
  }
  lines.push("");
  lines.push("* = active account. Switch with /peer:account use <name>.");
  return lines.join("\n");
}

async function handleAccount(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "home"],
    booleanOptions: ["json"]
  });
  const subcommand = positionals[0];
  const cwd = resolveCommandWorkspace(options);

  if (subcommand === "add") {
    const name = positionals[1];
    const { account, loginCommand } = addAccount(name, { home: options.home });
    const payload = { action: "add", account, loginCommand };
    outputCommandResult(payload, renderAccountAdd(account, loginCommand), options.json);
    return;
  }

  if (subcommand === "use") {
    const name = positionals[1];
    useAccount(name);
    const respawned = await respawnBrokerForUse(cwd);
    const payload = { action: "use", active: name, brokerRespawned: respawned };
    const lines = [
      `Active account is now "${name}".`,
      respawned
        ? "The shared Codex runtime for this workspace was stopped; the next review or task will start a fresh one under the new account."
        : "No running Codex runtime to restart; the next review or task will start one under the new account."
    ];
    outputCommandResult(payload, lines.join("\n"), options.json);
    return;
  }

  if (subcommand === "list" || subcommand === undefined) {
    const accounts = listAccounts();
    const rows = [];
    for (const account of accounts) {
      // Best-effort per-account login status under THAT account's CODEX_HOME.
      // A failure (missing dir, codex not installed) shows "not logged in"
      // rather than throwing, so list always renders.
      let loggedIn = false;
      try {
        const status = await getCodexAuthStatus(cwd, {
          env: { ...process.env, CODEX_HOME: account.home }
        });
        loggedIn = Boolean(status.loggedIn);
      } catch {
        loggedIn = false;
      }
      rows.push({ ...account, loggedIn });
    }
    outputCommandResult({ action: "list", accounts: rows }, renderAccountList(rows), options.json);
    return;
  }

  throw new Error(`Unknown account subcommand "${subcommand}". Use: add <name> [--home <path>] | use <name> | list`);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "stats":
      handleStats(argv);
      break;
    case "history":
      handleHistory(argv);
      break;
    case "doctor":
      await handleDoctor(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "watch":
      await handleWatch(argv);
      break;
    case "account":
      await handleAccount(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

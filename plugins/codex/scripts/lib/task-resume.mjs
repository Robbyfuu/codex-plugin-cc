import { generateJobId as defaultGenerateJobId, listJobs as defaultListJobs } from "./state.mjs";
import { readStoredJob as defaultReadStoredJob } from "./job-control.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "./workspace.mjs";

/**
 * Manual resume path for a task killed by the hard-duration ceiling (or an idle
 * stall). The turn was killed but the thread survives server-side, so resuming
 * picks up where it left off instead of losing all the work.
 *
 * This is DELIBERATELY manual (no auto-retry): a silent second 15-minute burn is
 * user-hostile. The user invokes `task --resume-id <job-id>` and gets a fresh
 * watchdog/ceiling budget on a NEW tracked job linked back via `resumedFrom`.
 *
 * prepareTaskResume is a pure planner: it reads the source job through injected
 * seams, validates it, and returns `{ workspaceRoot, job, request }` for the
 * caller to launch through the normal tracked-job machinery. It never touches
 * disk directly.
 *
 * Colocation: the resumed job, its state, and its telemetry are written under the
 * SOURCE job's workspace — NOT the current invocation's. The codex thread already
 * resumes against the original cwd, and a split would scatter the chain so the
 * resumed job never appears next to its source in /status, /history, /stats. The
 * returned `workspaceRoot` is the source's (taken from its record, or derived
 * from its persisted request cwd as a fallback); the caller MUST use it.
 */

export const DEFAULT_RESUME_PROMPT = "Continue where you left off.";

const ACTIVE_STATUSES = new Set(["running", "queued"]);

/**
 * @param {string} workspaceRoot the CURRENT invocation's workspace (used only to
 *   look the source job up; the returned plan is colocated under the SOURCE's).
 * @param {string} reference job id (exact or unique prefix) of the job to resume
 * @param {{ prompt?: string, model?: string|null, effort?: string|null, write?: boolean }} [overrides]
 * @param {{
 *   readStoredJob?: (workspaceRoot: string, jobId: string) => object | null,
 *   listJobs?: (workspaceRoot: string) => object[],
 *   generateJobId?: (prefix?: string) => string,
 *   resolveWorkspaceRoot?: (cwd: string) => string
 * }} [seams]
 * @returns {{ workspaceRoot: string, job: object, request: object }}
 */
export function prepareTaskResume(workspaceRoot, reference, overrides = {}, seams = {}) {
  const readStoredJob = seams.readStoredJob ?? defaultReadStoredJob;
  const listJobs = seams.listJobs ?? defaultListJobs;
  const generateJobId = seams.generateJobId ?? defaultGenerateJobId;
  const resolveWorkspaceRoot = seams.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot;

  if (!reference) {
    throw new Error("`task --resume-id` requires a job id to resume.");
  }

  const source = resolveSourceJob(workspaceRoot, reference, { readStoredJob, listJobs });
  if (!source) {
    throw new Error(`No Codex job found for "${reference}". Run /peer:status to list jobs.`);
  }

  if (ACTIVE_STATUSES.has(source.status)) {
    throw new Error(
      `Job ${source.id} is still ${source.status}. Wait for it to finish (or cancel it) before resuming.`
    );
  }

  if (!source.threadId) {
    throw new Error(
      `Job ${source.id} has no Codex thread to resume (its threadId was never recorded). Start a fresh /peer:task instead.`
    );
  }

  const prompt = typeof overrides.prompt === "string" && overrides.prompt.trim() ? overrides.prompt : DEFAULT_RESUME_PROMPT;
  const write = overrides.write ?? Boolean(source.write ?? source.request?.write);
  const model = overrides.model ?? source.request?.model ?? null;
  const effort = overrides.effort ?? source.request?.effort ?? null;
  const cwd = source.request?.cwd ?? workspaceRoot;

  // Colocate under the SOURCE's workspace: prefer the recorded workspaceRoot, then
  // derive it from the persisted request cwd, then (last resort) the current one.
  const sourceWorkspaceRoot =
    source.workspaceRoot ??
    (source.request?.cwd ? resolveWorkspaceRoot(source.request.cwd) : null) ??
    workspaceRoot;

  const jobId = generateJobId("task");
  const job = {
    id: jobId,
    kind: "task",
    kindLabel: "rescue",
    title: "Codex Resume",
    workspaceRoot: sourceWorkspaceRoot,
    jobClass: "task",
    summary: prompt,
    write,
    // Link back so status/result can show the chain.
    resumedFrom: source.id
  };

  const request = {
    cwd,
    model,
    effort,
    prompt,
    write,
    // resumeThreadId is the surviving server-side thread; runAppServerTurn resumes
    // it (fresh budget) instead of starting a new thread.
    resumeThreadId: source.threadId,
    jobId
  };

  return { workspaceRoot: sourceWorkspaceRoot, job, request };
}

function resolveSourceJob(workspaceRoot, reference, { readStoredJob, listJobs }) {
  // Fast path: an exact job-id hit in the stored job file.
  const exact = readStoredJob(workspaceRoot, reference);
  if (exact) {
    return exact;
  }

  // Otherwise resolve by unique prefix against the index, then load the full
  // stored record (which carries the persisted request payload + threadId).
  const jobs = Array.isArray(listJobs(workspaceRoot)) ? listJobs(workspaceRoot) : [];
  const prefixMatches = jobs.filter((job) => typeof job?.id === "string" && job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0];
    return readStoredJob(workspaceRoot, match.id) ?? match;
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous job reference "${reference}" matches ${prefixMatches.length} jobs; use the full id.`);
  }
  return null;
}

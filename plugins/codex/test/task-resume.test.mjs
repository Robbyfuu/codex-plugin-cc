import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RESUME_PROMPT,
  prepareTaskResume
} from "../scripts/lib/task-resume.mjs";

/**
 * prepareTaskResume is the pure planner behind `task --resume-id <job-id>`. It
 * reads the source job through injected seams, validates it, and returns the
 * launch plan (a new job record patch + the task request that calls resumeThread
 * with the stored threadId). All disk access is injectable so the planner is
 * unit-testable without touching state.mjs.
 */

function makeSeams(job) {
  return {
    readStoredJob: () => job,
    listJobs: () => (job ? [job] : []),
    generateJobId: () => "task-resumed-1"
  };
}

const SOURCE = {
  id: "task-source",
  jobClass: "task",
  status: "failed",
  threadId: "thread-abc",
  title: "Codex Task",
  summary: "Fix the parser",
  write: true,
  workspaceRoot: "/source-ws",
  request: { cwd: "/repo", model: "gpt-5.4", effort: null, write: true }
};

test("prepareTaskResume builds a linked job calling resumeThread with the stored threadId", () => {
  const plan = prepareTaskResume("/ws", "task-source", {}, makeSeams(SOURCE));

  // The new tracked job links back to the source.
  assert.equal(plan.job.id, "task-resumed-1");
  assert.equal(plan.job.jobClass, "task");
  assert.equal(plan.job.resumedFrom, "task-source", "the new job records resumedFrom");

  // The request resumes the SAME server-side thread (the one that survived the
  // hard stop) rather than starting a fresh thread.
  assert.equal(plan.request.resumeThreadId, "thread-abc");
  assert.equal(plan.request.write, true, "write mode is inherited from the source job");
  // Default continuation prompt when none is supplied.
  assert.equal(plan.request.prompt, DEFAULT_RESUME_PROMPT);
});

test("prepareTaskResume uses a supplied continuation prompt over the default", () => {
  const plan = prepareTaskResume("/ws", "task-source", { prompt: "Now add the tests." }, makeSeams(SOURCE));
  assert.equal(plan.request.prompt, "Now add the tests.");
  assert.equal(plan.request.resumeThreadId, "thread-abc");
});

test("prepareTaskResume refuses a job whose threadId is missing with a clear error", () => {
  const noThread = { ...SOURCE, threadId: null };
  assert.throws(
    () => prepareTaskResume("/ws", "task-source", {}, makeSeams(noThread)),
    /thread|resume/i,
    "a missing threadId yields a clear, resume-specific error"
  );
});

test("prepareTaskResume refuses a RUNNING job", () => {
  const running = { ...SOURCE, status: "running" };
  assert.throws(
    () => prepareTaskResume("/ws", "task-source", {}, makeSeams(running)),
    /running|still/i,
    "resuming a running job is refused"
  );
});

test("prepareTaskResume refuses a QUEUED job", () => {
  const queued = { ...SOURCE, status: "queued" };
  assert.throws(() => prepareTaskResume("/ws", "task-source", {}, makeSeams(queued)), /running|queued|still/i);
});

test("prepareTaskResume gives a clear error when the job id is unknown", () => {
  assert.throws(
    () => prepareTaskResume("/ws", "task-missing", {}, makeSeams(null)),
    /no.*job|not found|task-missing/i,
    "an unknown job id yields a clear error"
  );
});

test("prepareTaskResume resolves the source job by id prefix", () => {
  const plan = prepareTaskResume("/ws", "task-sou", {}, makeSeams(SOURCE));
  assert.equal(plan.request.resumeThreadId, "thread-abc");
  assert.equal(plan.job.resumedFrom, "task-source");
});

test("prepareTaskResume colocates the resumed job under the SOURCE job's workspace, not the current invocation's", () => {
  // The chain (source + resumed) must live in the SAME state dir so the resumed
  // job shows up next to its source in /status, /history, /stats — even when the
  // user runs the resume from a DIFFERENT cwd/workspace.
  const plan = prepareTaskResume("/current-invocation-ws", "task-source", {}, makeSeams(SOURCE));
  assert.equal(plan.workspaceRoot, "/source-ws", "the plan reports the source workspace to colocate under");
  assert.equal(plan.job.workspaceRoot, "/source-ws", "the new job record is rooted in the source workspace");
});

test("prepareTaskResume derives the source workspace from request.cwd when the record lacks workspaceRoot", () => {
  // Legacy/partial records may not carry workspaceRoot; fall back to resolving the
  // workspace from the persisted request cwd so colocation still holds.
  const legacy = { ...SOURCE, workspaceRoot: undefined };
  const plan = prepareTaskResume("/current-invocation-ws", "task-source", {}, {
    ...makeSeams(legacy),
    resolveWorkspaceRoot: (cwd) => `${cwd}-workspace`
  });
  assert.equal(plan.workspaceRoot, "/repo-workspace", "derived from resolveWorkspaceRoot(source.request.cwd)");
  assert.equal(plan.job.workspaceRoot, "/repo-workspace");
});

test("prepareTaskResume throws an ambiguity error when a prefix matches two jobs", () => {
  // Two jobs share the prefix `task-a`; an exact-id lookup misses, so resolution
  // falls to the prefix branch which must refuse rather than guess.
  const jobA = { id: "task-aaa", status: "failed", threadId: "t1", jobClass: "task", workspaceRoot: "/ws" };
  const jobB = { id: "task-abb", status: "failed", threadId: "t2", jobClass: "task", workspaceRoot: "/ws" };
  const seams = {
    readStoredJob: (_ws, id) => (id === "task-a" ? null : [jobA, jobB].find((job) => job.id === id) ?? null),
    listJobs: () => [jobA, jobB],
    generateJobId: () => "task-resumed-1"
  };
  assert.throws(
    () => prepareTaskResume("/ws", "task-a", {}, seams),
    /ambiguous/i,
    "an ambiguous prefix must refuse, naming the conflict, rather than resume the wrong job"
  );
});

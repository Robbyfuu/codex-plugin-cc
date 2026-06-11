import assert from "node:assert/strict";
import { test } from "node:test";

import { renderJobStatusReport, renderStatusReport, renderStoredJobResult } from "../scripts/lib/render.mjs";

// The real reconcile-note shape: liveness check flips a dead-pid running job to
// `failed` with a "worker process died ... not alive" error, but the surviving
// Codex thread is still resumable via the tracked-job path.
const RECONCILED_FAILED_JOB = {
  id: "task-dead",
  status: "failed",
  jobClass: "task",
  title: "Codex Task",
  threadId: "thread-survivor",
  error: "worker process died (pid 999999 not alive); reconciled by liveness check"
};

const TRACKED_RESUME_HINT = /Resume here:\s*\/peer:rescue --resume-id task-dead/;

test("renderJobStatusReport shows the resumedFrom link for a resumed task", () => {
  const output = renderJobStatusReport({
    id: "task-resumed-1",
    status: "running",
    jobClass: "task",
    title: "Codex Resume",
    threadId: "thread-abc",
    resumedFrom: "task-source"
  });
  assert.match(output, /Resumed from:\s*task-source/i, "the status report names the source job it resumed");
});

test("renderJobStatusReport omits the resumedFrom line for a normal (non-resumed) job", () => {
  const output = renderJobStatusReport({
    id: "task-1",
    status: "completed",
    jobClass: "task",
    title: "Codex Task",
    threadId: "thread-abc"
  });
  assert.doesNotMatch(output, /Resumed from/i);
});

test("renderStoredJobResult surfaces the resumedFrom link when present", () => {
  const output = renderStoredJobResult(
    { id: "task-resumed-1", status: "completed", title: "Codex Resume", jobClass: "task", resumedFrom: "task-source" },
    { result: { rawOutput: "done" }, resumedFrom: "task-source" }
  );
  assert.match(output, /task-source/, "the result output references the source job");
});

test("renderJobStatusReport surfaces the tracked-resume hint for a reconciled failed job with a thread", () => {
  const output = renderJobStatusReport(RECONCILED_FAILED_JOB);
  assert.match(output, TRACKED_RESUME_HINT, "the failed job offers our tracked-job resume path");
  assert.match(output, /Resume in Codex: codex resume thread-survivor/, "the raw Codex resume line is kept too");
});

test("renderJobStatusReport surfaces the tracked-resume hint for an interrupted job with a thread", () => {
  const output = renderJobStatusReport({
    id: "task-dead",
    status: "interrupted",
    jobClass: "task",
    title: "Codex Task",
    threadId: "thread-survivor"
  });
  assert.match(output, TRACKED_RESUME_HINT, "an interrupted job is resumable too");
});

test("renderStatusReport surfaces the tracked-resume hint for a reconciled failed job", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "app-server" },
    config: { stopReviewGate: false },
    running: [],
    latestFinished: RECONCILED_FAILED_JOB,
    recent: [],
    needsReview: false
  });
  assert.match(output, TRACKED_RESUME_HINT, "the status report surfaces the tracked-job resume path");
});

test("renderStoredJobResult surfaces the tracked-resume hint for a reconciled failed job", () => {
  const output = renderStoredJobResult(RECONCILED_FAILED_JOB, {
    threadId: "thread-survivor",
    errorMessage: "worker process died (pid 999999 not alive); reconciled by liveness check"
  });
  assert.match(output, TRACKED_RESUME_HINT, "the result render offers our tracked-job resume path");
  assert.match(output, /Resume in Codex: codex resume thread-survivor/, "the raw Codex resume line is kept too");
});

test("renderJobStatusReport does NOT show the tracked-resume hint for a completed job", () => {
  const output = renderJobStatusReport({
    id: "task-done",
    status: "completed",
    jobClass: "task",
    title: "Codex Task",
    threadId: "thread-survivor"
  });
  assert.doesNotMatch(output, /resume-id/, "a completed job has nothing to resume");
});

test("renderJobStatusReport does NOT show the tracked-resume hint for a cancelled job", () => {
  const output = renderJobStatusReport({
    id: "task-stopped",
    status: "cancelled",
    jobClass: "task",
    title: "Codex Task",
    threadId: "thread-survivor"
  });
  assert.doesNotMatch(output, /resume-id/, "a cancelled job was deliberately stopped by the user");
});

test("renderJobStatusReport does NOT show the tracked-resume hint for a failed job with no thread", () => {
  const output = renderJobStatusReport({
    id: "task-nothread",
    status: "failed",
    jobClass: "task",
    title: "Codex Task",
    error: "worker process died (pid 999999 not alive); reconciled by liveness check"
  });
  assert.doesNotMatch(output, /resume-id/, "without a threadId there is no thread to resume");
});

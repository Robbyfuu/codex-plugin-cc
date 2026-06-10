import assert from "node:assert/strict";
import { test } from "node:test";

import { renderJobStatusReport, renderStoredJobResult } from "../scripts/lib/render.mjs";

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

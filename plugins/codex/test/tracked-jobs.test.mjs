import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runTrackedJob } from "../scripts/lib/tracked-jobs.mjs";
import { CodexStallError } from "../scripts/lib/watchdog.mjs";

/**
 * runTrackedJob writes state/job files to disk via state.mjs, so each test runs
 * against an isolated temp workspace + plugin-data dir. We only assert on the
 * telemetry outcome the wrapper emits, which is injected so no real telemetry
 * file is touched.
 */
function withTempWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tracked-jobs-"));
  const workspaceRoot = path.join(root, "repo");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  return Promise.resolve(run({ workspaceRoot })).finally(() => {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function makeJob(workspaceRoot, overrides = {}) {
  return {
    id: "job-1",
    kind: "task",
    jobClass: "task",
    title: "Codex Task",
    workspaceRoot,
    ...overrides
  };
}

function captureRecorder() {
  const outcomes = [];
  return {
    outcomes,
    recordTurnOutcome(outcome) {
      outcomes.push(outcome);
    }
  };
}

test("runTrackedJob emits a completed outcome on success", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const recorder = captureRecorder();
    const execution = {
      exitStatus: 0,
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { ok: true },
      rendered: "done",
      summary: "all good"
    };

    const result = await runTrackedJob(makeJob(workspaceRoot), async () => execution, {
      telemetryRecorder: recorder.recordTurnOutcome
    });

    assert.equal(result, execution);
    assert.equal(recorder.outcomes.length, 1);
    const outcome = recorder.outcomes[0];
    assert.equal(outcome.exitReason, "completed");
    assert.equal(outcome.threadId, "thread-1");
    assert.equal(outcome.kind, "task");
    assert.equal(outcome.title, "Codex Task");
    assert.equal(outcome.restartCount, 0);
    assert.equal(typeof outcome.startedAt, "number");
    assert.equal(typeof outcome.endedAt, "number");
    assert.equal(outcome.durationMs, outcome.endedAt - outcome.startedAt);
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, "usage"), false, "usage key is omitted (never fabricated)");
  });
});

test("runTrackedJob maps CodexStallError(idle) to an idle-stall outcome", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const recorder = captureRecorder();
    const error = new CodexStallError("idle", { reason: "idle" });

    await assert.rejects(
      runTrackedJob(makeJob(workspaceRoot), async () => {
        throw error;
      }, { telemetryRecorder: recorder.recordTurnOutcome }),
      (thrown) => thrown === error
    );

    assert.equal(recorder.outcomes.length, 1);
    assert.equal(recorder.outcomes[0].exitReason, "idle-stall");
  });
});

test("runTrackedJob maps CodexStallError(max-duration) to a hard-stop outcome", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const recorder = captureRecorder();
    const error = new CodexStallError("too long", { reason: "max-duration" });

    await assert.rejects(
      runTrackedJob(makeJob(workspaceRoot), async () => {
        throw error;
      }, { telemetryRecorder: recorder.recordTurnOutcome }),
      (thrown) => thrown === error
    );

    assert.equal(recorder.outcomes.length, 1);
    assert.equal(recorder.outcomes[0].exitReason, "hard-stop");
  });
});

test("runTrackedJob records an interrupted outcome when the turn RESOLVES with a non-zero exit status (broker self-heal)", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const recorder = captureRecorder();
    // Real broker self-heal flow: the `turn/completed status:"interrupted"`
    // event RESOLVES the turn (it does not reject). buildResultStatus then maps
    // the non-"completed" final status to exitStatus 1, so the turn lands in the
    // SUCCESS branch with exitStatus !== 0. This is the only honest signal the
    // companion propagates — `payload.codex.status` carries the numeric exit
    // status (0/1), NOT the string "interrupted".
    const execution = {
      exitStatus: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { codex: { status: 1 } },
      rendered: "interrupted",
      summary: "interrupted"
    };

    const result = await runTrackedJob(makeJob(workspaceRoot), async () => execution, {
      telemetryRecorder: recorder.recordTurnOutcome
    });

    assert.equal(result, execution, "the resolved turn result is returned unchanged");
    assert.equal(recorder.outcomes.length, 1);
    assert.equal(
      recorder.outcomes[0].exitReason,
      "interrupted",
      "a non-zero settlement is recorded as `interrupted`, not the misleading `completed` bucket"
    );
  });
});

test("runTrackedJob folds a genuine thrown Error into an error outcome", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const recorder = captureRecorder();
    // A real rejection (not the broker-interrupt path, which RESOLVES). Generic
    // throws that are neither idle nor max-duration stalls map to "error".
    const error = new Error("app-server connection dropped");

    await assert.rejects(
      runTrackedJob(makeJob(workspaceRoot), async () => {
        throw error;
      }, { telemetryRecorder: recorder.recordTurnOutcome }),
      (thrown) => thrown === error
    );

    assert.equal(recorder.outcomes.length, 1);
    assert.equal(recorder.outcomes[0].exitReason, "error");
  });
});

test("runTrackedJob telemetry wrapper swallows a recorder throw without affecting the success result", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const execution = { exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "ok", summary: "s" };
    const result = await runTrackedJob(makeJob(workspaceRoot), async () => execution, {
      telemetryRecorder() {
        throw new Error("telemetry exploded");
      }
    });
    assert.equal(result, execution, "the turn result is unaffected by a telemetry failure");
  });
});

test("runTrackedJob telemetry wrapper swallows a recorder throw on the failure path", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const error = new Error("real failure");
    await assert.rejects(
      runTrackedJob(makeJob(workspaceRoot), async () => {
        throw error;
      }, {
        telemetryRecorder() {
          throw new Error("telemetry exploded");
        }
      }),
      (thrown) => thrown === error,
      "the original turn error still propagates even if telemetry throws"
    );
  });
});

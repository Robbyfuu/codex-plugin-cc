import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { flushJobToFailed, registerWorkerTerminationHandlers, runTrackedJob } from "../scripts/lib/tracked-jobs.mjs";
import { resolveJobFile, writeJobFile } from "../scripts/lib/state.mjs";
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

test("runTrackedJob invokes the notification consumer from emitTurnOutcome", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const recorder = captureRecorder();
    const notified = [];
    const execution = { exitStatus: 0, threadId: "thread-1", turnId: "turn-1", payload: {}, rendered: "ok", summary: "s" };

    await runTrackedJob(makeJob(workspaceRoot), async () => execution, {
      telemetryRecorder: recorder.recordTurnOutcome,
      notifier: (outcome) => notified.push(outcome)
    });

    assert.equal(notified.length, 1, "the notification consumer must be invoked exactly once");
    // It reads the SAME canonical outcome the telemetry consumer received.
    assert.equal(notified[0].exitReason, "completed");
    assert.equal(notified[0].title, "Codex Task");
    assert.deepEqual(notified[0], recorder.outcomes[0], "both consumers see the identical outcome object");
  });
});

test("runTrackedJob: a throwing notifier does NOT perturb the turn result", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const execution = { exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "ok", summary: "s" };
    const result = await runTrackedJob(makeJob(workspaceRoot), async () => execution, {
      notifier() {
        throw new Error("notifier exploded");
      }
    });
    assert.equal(result, execution, "the turn result is unaffected by a notifier failure");
  });
});

test("runTrackedJob: a throwing notifier does NOT perturb telemetry (consumer isolation)", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const recorder = captureRecorder();
    const execution = { exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "ok", summary: "s" };

    await runTrackedJob(makeJob(workspaceRoot), async () => execution, {
      telemetryRecorder: recorder.recordTurnOutcome,
      notifier() {
        throw new Error("notifier exploded");
      }
    });

    // Telemetry must still record despite the notifier throwing: each consumer is
    // isolated in its own try/catch, so one failing cannot starve the other.
    assert.equal(recorder.outcomes.length, 1, "telemetry must record even when the notifier throws");
    assert.equal(recorder.outcomes[0].exitReason, "completed");
  });
});

test("runTrackedJob: a throwing telemetry recorder does NOT starve the notifier (reverse isolation)", async () => {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const notified = [];
    const execution = { exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "ok", summary: "s" };

    const result = await runTrackedJob(makeJob(workspaceRoot), async () => execution, {
      telemetryRecorder() {
        throw new Error("telemetry exploded");
      },
      notifier: (outcome) => notified.push(outcome)
    });

    assert.equal(result, execution);
    assert.equal(notified.length, 1, "the notifier must still fire even when telemetry throws first");
  });
});

// ---------------------------------------------------------------------------
// Issue #228: a worker that receives SIGTERM/SIGINT must flush its in-flight
// job to `failed` before dying, instead of stranding it as `running`.
// ---------------------------------------------------------------------------

test("flushJobToFailed persists a running job as failed with the supplied note", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    const job = {
      id: "task-flush",
      status: "running",
      jobClass: "task",
      pid: process.pid,
      createdAt: "2026-03-18T15:32:00.000Z",
      updatedAt: "2026-03-18T15:33:00.000Z"
    };
    writeJobFile(workspaceRoot, job.id, job);
    flushJobToFailed(workspaceRoot, job.id, "worker received SIGTERM; flushing job to failed");

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, job.id), "utf8"));
    assert.equal(stored.status, "failed");
    assert.equal(stored.pid, null);
    assert.match(String(stored.error ?? stored.errorMessage ?? ""), /SIGTERM/i);
  });
});

test("flushJobToFailed does NOT overwrite a job already in a terminal status (cancel race, #cancel-race)", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    // The cancel race: /codex-plus:cancel writes `cancelled` while the parent
    // SIGTERMs the worker tree; the worker's termination handler then races a
    // `failed` flush over the SAME unlocked job. A user-cancelled job must never
    // be clobbered into `failed`.
    const job = {
      id: "task-cancelled",
      status: "cancelled",
      jobClass: "task",
      pid: null,
      createdAt: "2026-03-18T15:32:00.000Z",
      updatedAt: "2026-03-18T15:33:00.000Z",
      completedAt: "2026-03-18T15:34:00.000Z"
    };
    writeJobFile(workspaceRoot, job.id, job);

    flushJobToFailed(workspaceRoot, job.id, "worker received SIGTERM; flushing job to failed");

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, job.id), "utf8"));
    assert.equal(stored.status, "cancelled", "a terminal `cancelled` status must NOT be overwritten by the flush handler");
  });
});

test("flushJobToFailed does NOT overwrite a completed job (terminal-status guard)", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    const job = {
      id: "task-completed",
      status: "completed",
      jobClass: "task",
      pid: null,
      createdAt: "2026-03-18T15:32:00.000Z",
      updatedAt: "2026-03-18T15:33:00.000Z",
      completedAt: "2026-03-18T15:34:00.000Z"
    };
    writeJobFile(workspaceRoot, job.id, job);

    flushJobToFailed(workspaceRoot, job.id, "worker received SIGINT; flushing job to failed");

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, job.id), "utf8"));
    assert.equal(stored.status, "completed", "a terminal `completed` status must NOT be overwritten by the flush handler");
  });
});

test("flushJobToFailed is best-effort: a write failure does not throw", async () => {
  await withTempWorkspace(({ workspaceRoot }) => {
    assert.doesNotThrow(() => {
      flushJobToFailed(workspaceRoot, "task-missing", "note", {
        writeJobFileImpl() {
          throw new Error("disk full");
        }
      });
    });
  });
});

// A fake process that records listeners per signal as an array, so we can
// assert on listener hygiene (specific removal, not removeAllListeners).
function makeFakeProcess(pid = 4242) {
  const listeners = new Map();
  const calls = [];
  return {
    listeners,
    calls,
    pid,
    once(signal, handler) {
      const list = listeners.get(signal) ?? [];
      list.push(handler);
      listeners.set(signal, list);
    },
    removeListener(signal, handler) {
      const list = listeners.get(signal) ?? [];
      const next = list.filter((entry) => entry !== handler);
      listeners.set(signal, next);
    },
    removeAllListeners(signal) {
      // Present so an accidental broad-removal regression is observable: if the
      // implementation ever calls this, the foreign-listener assertion fails.
      listeners.set(signal, []);
      calls.push({ kind: "removeAllListeners", signal });
    },
    kill(killPid, signal) {
      calls.push({ kind: "kill", pid: killPid, signal });
    }
  };
}

test("registerWorkerTerminationHandlers flushes the job to failed on SIGTERM and re-raises", () => {
  const fakeProcess = makeFakeProcess();

  registerWorkerTerminationHandlers({
    workspaceRoot: "/tmp/ws",
    jobId: "task-sig",
    proc: fakeProcess,
    flushImpl(workspaceRoot, jobId, note) {
      fakeProcess.calls.push({ kind: "flush", workspaceRoot, jobId, note });
    }
  });

  assert.ok((fakeProcess.listeners.get("SIGTERM") ?? []).length > 0, "a SIGTERM handler must be registered");
  assert.ok((fakeProcess.listeners.get("SIGINT") ?? []).length > 0, "a SIGINT handler must be registered");

  // Fire SIGTERM.
  fakeProcess.listeners.get("SIGTERM")[0]("SIGTERM");

  const flush = fakeProcess.calls.find((entry) => entry.kind === "flush");
  assert.equal(flush.jobId, "task-sig");
  assert.match(flush.note, /SIGTERM/);
  // The default-signal behavior is restored and re-raised so the process still
  // dies with the right disposition.
  const reraise = fakeProcess.calls.find((entry) => entry.kind === "kill");
  assert.equal(reraise.signal, "SIGTERM");
});

test("registerWorkerTerminationHandlers removes ONLY its own handler and never nukes foreign listeners", () => {
  const fakeProcess = makeFakeProcess();
  // A foreign listener some other code legitimately registered for SIGTERM.
  const foreign = () => {};
  fakeProcess.once("SIGTERM", foreign);

  registerWorkerTerminationHandlers({
    workspaceRoot: "/tmp/ws",
    jobId: "task-hygiene",
    proc: fakeProcess,
    flushImpl() {}
  });

  // Our handler is the one registered AFTER the foreign listener.
  const sigtermListeners = fakeProcess.listeners.get("SIGTERM");
  const ourHandler = sigtermListeners[sigtermListeners.length - 1];
  ourHandler("SIGTERM");

  assert.equal(
    fakeProcess.calls.some((entry) => entry.kind === "removeAllListeners"),
    false,
    "must NOT call removeAllListeners (that would nuke foreign listeners)"
  );
  assert.ok(
    fakeProcess.listeners.get("SIGTERM").includes(foreign),
    "a foreign SIGTERM listener must survive — only our own handler is removed"
  );
  assert.equal(
    fakeProcess.listeners.get("SIGTERM").includes(ourHandler),
    false,
    "our own handler must be removed via removeListener"
  );
});

test("registerWorkerTerminationHandlers flushes at most once when both signals fire (no double-flush)", () => {
  const fakeProcess = makeFakeProcess();
  let flushCount = 0;

  registerWorkerTerminationHandlers({
    workspaceRoot: "/tmp/ws",
    jobId: "task-double",
    proc: fakeProcess,
    flushImpl() {
      flushCount += 1;
    }
  });

  // Simulate SIGTERM then SIGINT both arriving during teardown.
  fakeProcess.listeners.get("SIGTERM")[0]("SIGTERM");
  fakeProcess.listeners.get("SIGINT")[0]("SIGINT");

  assert.equal(flushCount, 1, "the shared guard must prevent a second flush from the second signal");
});

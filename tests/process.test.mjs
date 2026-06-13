import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    // Inject a live-pid probe so the liveness gate passes deterministically and
    // the test reaches the taskkill branch it is asserting (never probe a real
    // pid on the runner).
    killImpl() {},
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree no-ops on a stale (ESRCH) pid without signaling the group", () => {
  const signals = [];
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl(targetPid, signal) {
      signals.push({ targetPid, signal });
      // signal 0 is the liveness probe; report the pid as gone.
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.deepEqual(outcome, { attempted: false, delivered: false, method: null });
  // Only the liveness probe (signal 0) ran; the group kill must never fire.
  assert.deepEqual(signals, [{ targetPid: 4321, signal: 0 }]);
  assert.equal(
    signals.some((entry) => entry.signal === "SIGTERM"),
    false
  );
});

test("terminateProcessTree no-ops on pid 0 and never sends a signal", () => {
  const signals = [];
  const outcome = terminateProcessTree(0, {
    platform: "linux",
    killImpl(targetPid, signal) {
      signals.push({ targetPid, signal });
    }
  });

  assert.deepEqual(outcome, { attempted: false, delivered: false, method: null });
  // pid <= 0 is rejected before any probe, so killImpl is never invoked.
  assert.deepEqual(signals, []);
});

test("terminateProcessTree no-ops on a negative pid", () => {
  const signals = [];
  const outcome = terminateProcessTree(-5, {
    platform: "linux",
    killImpl(targetPid, signal) {
      signals.push({ targetPid, signal });
    }
  });

  assert.deepEqual(outcome, { attempted: false, delivered: false, method: null });
  assert.deepEqual(signals, []);
});

test("terminateProcessTree reaches the group kill for a live pid", () => {
  const signals = [];
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl(targetPid, signal) {
      signals.push({ targetPid, signal });
      // signal 0 (liveness probe) succeeds; SIGTERM to the group succeeds too.
    }
  });

  assert.deepEqual(outcome, { attempted: true, delivered: true, method: "process-group" });
  // The liveness probe runs first, then the negative-pid group SIGTERM.
  assert.deepEqual(signals, [
    { targetPid: 4321, signal: 0 },
    { targetPid: -4321, signal: "SIGTERM" }
  ]);
});

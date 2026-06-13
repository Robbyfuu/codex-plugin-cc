import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

function fakeSpawnResult() {
  return { status: 0, signal: null, stdout: "", stderr: "", error: null };
}

test("runCommand never selects the spawn shell from process.env.SHELL (POSIX)", () => {
  let captured = null;
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/usr/bin/evil-shell";
  try {
    runCommand("codex", ["app-server"], {
      spawnImpl(command, args, options) {
        captured = { command, args, options };
        return fakeSpawnResult();
      }
    });
  } finally {
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
  }

  assert.equal(captured.options.shell, false, "POSIX must spawn with shell: false");
  assert.notEqual(captured.options.shell, "/usr/bin/evil-shell");
});

test("runCommand spawns the Windows taskkill argv with shell: false, never SHELL", () => {
  // This is the exact constant invocation terminateProcessTree issues on
  // Windows. Pre-hardening it spawned through `process.env.SHELL || true`; the
  // contract now is shell: false on every platform. The only allowed future
  // fallback (if `taskkill` ever fails to resolve without a shell) is ComSpec
  // (cmd.exe) — the attacker-influenceable SHELL must never be selected.
  let captured = null;
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/usr/bin/evil-shell";
  try {
    runCommand("taskkill", ["/PID", "1234", "/T", "/F"], {
      spawnImpl(command, args, options) {
        captured = { command, args, options };
        return fakeSpawnResult();
      }
    });
  } finally {
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
  }

  assert.deepEqual(captured.args, ["/PID", "1234", "/T", "/F"], "argv must pass through verbatim");
  assert.notEqual(captured.options.shell, "/usr/bin/evil-shell");
  assert.notEqual(captured.options.shell, process.env.SHELL);
  assert.ok(
    captured.options.shell === false || captured.options.shell === process.env.ComSpec,
    `Windows shell must be false or ComSpec, got ${JSON.stringify(captured.options.shell)}`
  );
});

test("runCommand passes argv verbatim and defaults to the real spawnSync seam", () => {
  // Guard the seam stays local + default-valued: omitting spawnImpl must still
  // run a real command (here `node -e ""`, universally available on the runner).
  const result = runCommand(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(result.status, 0);
  assert.equal(result.error, null);
});

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

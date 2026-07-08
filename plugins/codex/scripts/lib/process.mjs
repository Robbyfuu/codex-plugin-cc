import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Is a pid currently alive? Probe with signal 0; ESRCH means it is gone. Any
 * other error (e.g. EPERM) is treated as "alive" since the process exists.
 *
 * Hardening: require pid > 0. `kill(0, …)` targets the CALLER's own process
 * group and `kill(-0, …)` is likewise group-relative — both are dangerous and
 * meaningless as a liveness probe. A real worker/broker pid is always > 0, so
 * requiring it makes signalling pid 0 / -0 structurally impossible.
 *
 * This is the SINGLE source of truth for liveness: doctor.mjs re-exports it and
 * state.mjs uses it to reconcile stranded jobs.
 *
 * @param {number | null | undefined} pid
 * @param {(pid: number, signal: number) => void} [killImpl]
 * @returns {boolean}
 */
export function isPidAlive(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") {
      return false;
    }
    // EPERM (or anything non-ESRCH): the process exists, we just cannot signal it.
    return true;
  }
}

export function runCommand(command, args = [], options = {}) {
  // SECURITY: default to shell: false on every platform so `args` are passed as
  // an explicit argv array, verbatim. We deliberately do NOT pick the Windows
  // shell from process.env.SHELL (an attacker-influenceable env var inherited
  // into the broker/workers). Callers that genuinely need a shell must opt in
  // explicitly via options.shell; Git helpers force shell: false after caller
  // options so repository-derived refs are always passed literally.
  //
  // `spawnImpl` is a local, default-valued seam used only to make the
  // shell-selection contract testable; existing callers omit it and are
  // unaffected (it defaults to the real spawnSync).
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const result = spawnImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  // Gate the whole termination on liveness. isPidAlive already rejects
  // non-finite pids, pid <= 0 (which would target the caller's OWN process
  // group via kill(-0/-pid)), and ESRCH (a stale pid the OS may have reused).
  // This single guard replaces the old finite-only check and prevents signaling
  // an unrelated process group from a stale persisted job record.
  if (!isPidAlive(pid, killImpl)) {
    return { attempted: false, delivered: false, method: null };
  }

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

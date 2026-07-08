import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import {
  LOG_FILE_ENV as PEER_LOG_FILE_ENV,
  PID_FILE_ENV as PEER_PID_FILE_ENV,
  SHUTDOWN_TIMEOUT_ENV as PEER_SHUTDOWN_TIMEOUT_ENV,
  readCompanionEnv
} from "./companion-env.mjs";
import { resolveStateDir } from "./state.mjs";
import { parsePositiveInt } from "./watchdog.mjs";

export const PID_FILE_ENV = PEER_PID_FILE_ENV;
export const LOG_FILE_ENV = PEER_LOG_FILE_ENV;
export const SHUTDOWN_TIMEOUT_ENV = PEER_SHUTDOWN_TIMEOUT_ENV;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Ask the broker to shut down. Bounded by a timeout so a never-responding (or
 * wedged) broker can never hang the SessionEnd hook (#7). On timeout we resolve
 * anyway — the caller (handleSessionEnd) proceeds to the best-effort
 * teardownBrokerSession path, which kills the pid and removes the socket.
 *
 * The timeout is overridable via PEER_COMPANION_SHUTDOWN_TIMEOUT_MS (parsed
 * with parsePositiveInt; a malformed value falls back to the default).
 *
 * @param {string | null | undefined} endpoint
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options]
 */
export async function sendBrokerShutdown(endpoint, options = {}) {
  if (!endpoint) {
    return;
  }
  const env = options.env ?? process.env;
  const timeoutMs =
    options.timeoutMs ?? parsePositiveInt(readCompanionEnv("SHUTDOWN_TIMEOUT", env), DEFAULT_SHUTDOWN_TIMEOUT_MS);

  await new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        // socket may already be closing
      }
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    try {
      socket = connectToEndpoint(endpoint);
    } catch {
      finish();
      return;
    }

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", finish);
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

/**
 * Ask a running broker to interrupt its active turn and restart its codex
 * child, recovering a wedged single-flight slot without tearing down the whole
 * session. Best-effort: resolves with `{ recovered, owned }` and never throws.
 *
 * Pass `threadId` to scope the recovery to a specific job: the broker only
 * restarts the child when that thread owns the active slot, so cancelling one
 * job never kills another job's in-flight turn. Omit `threadId` to recover only
 * when the broker is idle/unowned.
 *
 * @param {string | null | undefined} endpoint
 * @param {{ threadId?: string | null, timeoutMs?: number }} [options]
 * @returns {Promise<{ recovered: boolean, owned?: boolean, detail?: string }>}
 */
export async function sendBrokerRecover(endpoint, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const threadId = options.threadId ?? null;
  if (!endpoint) {
    return { recovered: false, detail: "no broker endpoint" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {
        // socket may already be closing
      }
      resolve(value);
    };

    let socket;
    try {
      socket = connectToEndpoint(endpoint);
    } catch (error) {
      resolve({ recovered: false, detail: error instanceof Error ? error.message : String(error) });
      return;
    }

    const timer = setTimeout(() => finish({ recovered: false, detail: "broker recover timed out" }), timeoutMs);
    timer.unref?.();

    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const params = threadId ? { threadId } : {};
      socket.write(`${JSON.stringify({ id: 1, method: "broker/recover", params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      try {
        const message = JSON.parse(line);
        finish({
          recovered: Boolean(message?.result?.recovered),
          owned: message?.result?.owned,
          detail: message?.error?.message
        });
      } catch {
        finish({ recovered: false, detail: "invalid broker recover response" });
      }
    });
    socket.on("error", (error) => finish({ recovered: false, detail: error instanceof Error ? error.message : String(error) }));
    socket.on("close", () => finish({ recovered: false, detail: "broker closed before responding" }));
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env, spawnImpl }) {
  const spawnProcess = spawnImpl ?? spawn;
  const logFd = fs.openSync(logFile, "a");
  const child = spawnProcess(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env,
    spawnImpl: options.spawnImpl
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}

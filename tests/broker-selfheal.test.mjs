import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { cleanupTrackedCodexProcesses, makeTempDir } from "./helpers.mjs";
import {
  ensureBrokerSession,
  isBrokerEndpointReady,
  sendBrokerShutdown,
  spawnBrokerProcess,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

// Hard cap so a regression in the self-heal pipeline surfaces as a fast test
// failure instead of a hung CI job. Every scenario lives well under this.
const TEST_TIMEOUT_MS = 30000;
// Tiny idle window so the two-stage guard escalates in ~tens of ms, not minutes.
const IDLE_TIMEOUT_MS = 250;

function deadlineSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Minimal raw JSON-RPC client over the broker's unix socket, modelled on
 * BrokerCodexAppServerClient. It records every notification so a test can wait
 * for a specific terminal turn/completed (including the synthetic
 * status:"interrupted" the broker emits on recovery) or a JSON-RPC error keyed
 * to id:null. Everything is promise-based and abortable so no path can hang.
 */
class RawBrokerClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.errorEvents = [];
    this.waiters = [];
    this.buffer = "";
    this.closed = false;
  }

  connect(signal) {
    return new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      const onAbort = () => reject(signal?.reason ?? new Error("connect aborted"));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.socket.on("connect", () => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      });
      this.socket.on("data", (chunk) => this.#onData(chunk));
      this.socket.on("error", (error) => {
        this.closed = true;
        reject(error);
        this.#failAllPending(error);
      });
      this.socket.on("close", () => {
        this.closed = true;
        this.#failAllPending(new Error("broker socket closed"));
      });
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
      if (line.trim()) {
        this.#onLine(line);
      }
    }
  }

  #onLine(line) {
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method === undefined) {
      if (message.id === null) {
        // A broker-recovered notification carries an id:null JSON-RPC error and
        // is not keyed to any pending request.
        this.errorEvents.push(message.error ?? null);
        this.#drainWaiters();
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(Object.assign(new Error(message.error.message ?? "rpc error"), { rpcCode: message.error.code }));
        } else {
          pending.resolve(message.result ?? {});
        }
      }
      return;
    }
    if (message.method) {
      this.notifications.push(message);
      this.#drainWaiters();
    }
  }

  #drainWaiters() {
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.predicate()) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }

  #failAllPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      waiter.reject(error);
    }
    this.waiters = [];
  }

  request(method, params, signal) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(signal?.reason ?? new Error(`request ${method} aborted`));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener?.("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener?.("abort", onAbort);
          reject(error);
        }
      });
      this.socket.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
    });
  }

  notify(method, params) {
    this.socket.write(`${JSON.stringify({ method, params: params ?? {} })}\n`);
  }

  async handshake(signal) {
    await this.request("initialize", {}, signal);
    this.notify("initialized", {});
  }

  /** Resolve once `predicate(this)` is true (checked against already-seen events too). */
  waitFor(predicate, signal) {
    return new Promise((resolve, reject) => {
      const check = () => predicate(this);
      if (check()) {
        resolve();
        return;
      }
      const onAbort = () => reject(signal?.reason ?? new Error("waitFor aborted"));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.waiters.push({
        predicate: check,
        resolve: () => {
          signal?.removeEventListener?.("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener?.("abort", onAbort);
          reject(error);
        }
      });
    });
  }

  findCompleted(threadId, status) {
    return this.notifications.find(
      (message) =>
        message.method === "turn/completed" &&
        (threadId === undefined || message.params?.threadId === threadId) &&
        (status === undefined || message.params?.turn?.status === status)
    );
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket?.end();
    } catch {
      // socket may already be closing
    }
  }
}

function spawnSelfHealBroker({ cwd, sessionDir, env }) {
  const endpoint = `unix:${path.join(sessionDir, "broker.sock")}`;
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const child = spawnBrokerProcess({ scriptPath: BROKER_SCRIPT, cwd, endpoint, pidFile, logFile, env });
  return { child, endpoint, pidFile, logFile };
}

function terminatePid(pid) {
  if (!pid) {
    return;
  }
  try {
    terminateProcessTree(pid);
  } catch {
    // already gone
  }
}

function brokerProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, signal) {
  while (brokerProcessAlive(pid)) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("exit wait aborted");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExitWithin(pid, timeoutMs) {
  const start = Date.now();
  while (brokerProcessAlive(pid) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !brokerProcessAlive(pid);
}

async function stopBroker(brokerOrSession) {
  const pid = brokerOrSession?.child?.pid ?? brokerOrSession?.pid ?? null;
  const endpoint = brokerOrSession?.endpoint ?? null;
  if (!pid) {
    return;
  }

  if (endpoint) {
    await sendBrokerShutdown(endpoint, { timeoutMs: 750 }).catch(() => {});
    if (await waitForExitWithin(pid, 2000)) {
      return;
    }
  }

  // Broker processes are spawned detached, so their app-server child inherits
  // the broker process group. Kill the tree, not just the broker pid; otherwise
  // failed tests leave fake `codex app-server` children under codex-plugin-test-*.
  terminatePid(pid);
  await waitForExitWithin(pid, 1000);
  cleanupTrackedCodexProcesses();
}

test("e2e: a wedged codex child self-heals and the broker serves a fresh child", async (t) => {
  const { signal, clear } = deadlineSignal(TEST_TIMEOUT_MS);
  t.after(clear);

  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("cxc-selfheal-");
  const pluginData = makeTempDir("cxc-plugin-data-");
  installFakeCodex(binDir, "wedge-silent-after-turn-start");

  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginData,
    CODEX_COMPANION_SESSION_ID: "",
    CODEX_COMPANION_NOTIFY: "0",
    CODEX_COMPANION_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS)
  };

  let broker;
  let client;
  try {
    broker = spawnSelfHealBroker({ cwd, sessionDir, env });
    const ready = await waitForBrokerEndpoint(broker.endpoint, 5000);
    assert.equal(ready, true, "broker endpoint should come up");

    client = new RawBrokerClient(broker.endpoint);
    await client.connect(signal);
    await client.handshake(signal);

    const thread = await client.request("thread/start", { cwd }, signal);
    const threadId = thread.thread.id;
    assert.ok(threadId, "thread/start should return a thread id");

    // Fire the streaming turn that wedges the first child. The request reply
    // arrives, but the turn never naturally completes — the broker must
    // self-heal and synthesise an interrupted completion.
    const turnResultPromise = client.request("turn/start", { threadId, input: [{ type: "text", text: "do work" }] }, signal);
    await turnResultPromise;

    // Self-heal proof #1: the parked waiter receives a synthetic interrupted
    // turn/completed instead of hanging forever.
    await client.waitFor((c) => Boolean(c.findCompleted(threadId, "interrupted")), signal);
    const interrupted = client.findCompleted(threadId, "interrupted");
    assert.ok(interrupted, "broker should emit a synthetic interrupted turn/completed");

    // Self-heal proof #2: the broker stayed alive and a SUBSEQUENT request
    // succeeds on the freshly-spawned (generation-bumped) child. The recovered
    // child is generation 2 of the fake codex, which serves turns normally.
    const followupThread = await client.request("thread/start", { cwd }, signal);
    const followupThreadId = followupThread.thread.id;
    const followupTurn = await client.request(
      "turn/start",
      { threadId: followupThreadId, input: [{ type: "text", text: "second request" }] },
      signal
    );
    assert.ok(followupTurn.turn, "follow-up turn/start should resolve on the fresh child");
    await client.waitFor((c) => Boolean(c.findCompleted(followupThreadId, "completed")), signal);
    const completed = client.findCompleted(followupThreadId, "completed");
    assert.ok(completed, "the fresh child should complete the follow-up turn cleanly");

    // The broker process must still be alive after a successful self-heal.
    assert.equal(brokerProcessAlive(broker.child.pid), true, "broker should stay alive after recovery");
  } finally {
    client?.close();
    await stopBroker(broker);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("e2e: a failed reconnect fails the waiter fast, exits the broker, and the next call respawns", async (t) => {
  const { signal, clear } = deadlineSignal(TEST_TIMEOUT_MS);
  t.after(clear);

  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("cxc-selfheal-");
  const pluginData = makeTempDir("cxc-plugin-data-");
  installFakeCodex(binDir, "wedge-silent-after-turn-start");

  // The first child boots fine and wedges; every child from generation 2 on is
  // unspawnable, so the recovery reconnect fails and the broker must fail fast.
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginData,
    CODEX_COMPANION_SESSION_ID: "",
    CODEX_COMPANION_NOTIFY: "0",
    CODEX_COMPANION_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
    CODEX_COMPANION_FAKE_UNSPAWNABLE_FROM: "2"
  };

  let broker;
  let client;
  try {
    broker = spawnSelfHealBroker({ cwd, sessionDir, env });
    const ready = await waitForBrokerEndpoint(broker.endpoint, 5000);
    assert.equal(ready, true, "broker endpoint should come up");

    client = new RawBrokerClient(broker.endpoint);
    await client.connect(signal);
    await client.handshake(signal);

    const thread = await client.request("thread/start", { cwd }, signal);
    const threadId = thread.thread.id;

    await client.request("turn/start", { threadId, input: [{ type: "text", text: "do work" }] }, signal);

    // Fail-fast proof #1: the waiter is notified (interrupted completion +
    // id:null JSON-RPC error) instead of hanging.
    await client.waitFor(
      (c) => Boolean(c.findCompleted(threadId, "interrupted")) || c.errorEvents.length > 0,
      signal
    );
    assert.ok(
      client.findCompleted(threadId, "interrupted") || client.errorEvents.length > 0,
      "the waiter must be notified on an unrecoverable reconnect"
    );

    // Fail-fast proof #2: the broker process exits(1) so the dead endpoint can
    // be detected and respawned by the next call.
    await waitForExit(broker.child.pid, signal);
    assert.equal(brokerProcessAlive(broker.child.pid), false, "broker should exit after an unrecoverable reconnect");
    assert.equal(await isBrokerEndpointReady(broker.endpoint), false, "dead endpoint should not be ready");

    // Recovery story: with the fixture spawnable again, ensureBrokerSession
    // detects the dead endpoint and brings up a fresh broker + child that serves
    // a turn cleanly. (A brand-new broker resets the fake's app-server
    // generation counter via its own state dir, so the child is healthy.)
    const respawnBinDir = makeTempDir();
    const respawnCwd = makeTempDir();
    const respawnPluginData = makeTempDir("cxc-plugin-data-");
    installFakeCodex(respawnBinDir, "review-ok");
    const respawnEnv = {
      ...buildEnv(respawnBinDir),
      CLAUDE_PLUGIN_DATA: respawnPluginData,
      CODEX_COMPANION_SESSION_ID: "",
      CODEX_COMPANION_NOTIFY: "0"
    };
    let respawned;
    try {
      respawned = await ensureBrokerSession(respawnCwd, { env: respawnEnv, killProcess: terminatePid });
      assert.ok(respawned, "ensureBrokerSession should spawn a fresh broker");
      assert.equal(await isBrokerEndpointReady(respawned.endpoint), true, "fresh broker endpoint should be ready");

      const freshClient = new RawBrokerClient(respawned.endpoint);
      try {
        await freshClient.connect(signal);
        await freshClient.handshake(signal);
        const freshThread = await freshClient.request("thread/start", { cwd: respawnCwd }, signal);
        const freshTurn = await freshClient.request(
          "turn/start",
          { threadId: freshThread.thread.id, input: [{ type: "text", text: "after respawn" }] },
          signal
        );
        assert.ok(freshTurn.turn, "the respawned broker should serve a turn");
        await freshClient.waitFor((c) => Boolean(c.findCompleted(freshThread.thread.id, "completed")), signal);
      } finally {
        freshClient.close();
      }
    } finally {
      await stopBroker(respawned);
      fs.rmSync(respawnBinDir, { recursive: true, force: true });
      fs.rmSync(respawnCwd, { recursive: true, force: true });
      fs.rmSync(respawnPluginData, { recursive: true, force: true });
    }
  } finally {
    client?.close();
    await stopBroker(broker);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("e2e: a healthy turn completes cleanly through the real broker (no self-heal perturbation)", async (t) => {
  const { signal, clear } = deadlineSignal(TEST_TIMEOUT_MS);
  t.after(clear);

  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("cxc-selfheal-");
  const pluginData = makeTempDir("cxc-plugin-data-");
  installFakeCodex(binDir, "review-ok");

  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginData,
    CODEX_COMPANION_SESSION_ID: "",
    CODEX_COMPANION_NOTIFY: "0",
    // Even with a tiny idle window, a healthy turn that completes promptly must
    // not be disturbed by the self-heal machinery.
    CODEX_COMPANION_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS)
  };

  let broker;
  let client;
  try {
    broker = spawnSelfHealBroker({ cwd, sessionDir, env });
    const ready = await waitForBrokerEndpoint(broker.endpoint, 5000);
    assert.equal(ready, true, "broker endpoint should come up");

    client = new RawBrokerClient(broker.endpoint);
    await client.connect(signal);
    await client.handshake(signal);

    const thread = await client.request("thread/start", { cwd }, signal);
    const threadId = thread.thread.id;
    const turn = await client.request("turn/start", { threadId, input: [{ type: "text", text: "healthy work" }] }, signal);
    assert.ok(turn.turn, "turn/start should resolve");

    await client.waitFor((c) => Boolean(c.findCompleted(threadId, "completed")), signal);
    assert.ok(client.findCompleted(threadId, "completed"), "the turn should complete with status completed");
    // No interrupted completion and no recovery error should appear on a healthy run.
    assert.equal(client.findCompleted(threadId, "interrupted"), undefined, "no synthetic interrupt on a healthy turn");
    assert.equal(client.errorEvents.length, 0, "no recovery error on a healthy turn");

    // Still alive and still on the original child.
    assert.equal(brokerProcessAlive(broker.child.pid), true, "broker should stay alive on a healthy run");
  } finally {
    client?.close();
    await stopBroker(broker);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

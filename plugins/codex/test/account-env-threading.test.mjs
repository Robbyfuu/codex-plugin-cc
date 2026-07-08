import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import { test } from "node:test";

import { CodexAppServerClient, BROKER_ENDPOINT_ENV } from "../scripts/lib/app-server.mjs";
import { ensureBrokerSession, clearBrokerSession } from "../scripts/lib/broker-lifecycle.mjs";
import { getCodexAvailability, findLatestTaskThread } from "../scripts/lib/codex.mjs";
import { addAccount, useAccount, resolveCodexEnv } from "../scripts/lib/accounts.mjs";

// In-memory fs seam (the small surface accounts.mjs uses) so account state
// never touches the real disk.
function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, String(data)),
    mkdirSync: (p) => dirs.add(p),
    chmodSync: () => {}
  };
}

// A fake spawned child whose stdout immediately fails the connection. We only
// need the SYNCHRONOUS spawn() call to have happened so we can inspect the env
// it was handed — the handshake outcome is irrelevant to the env assertion.
function makeFailingChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = { write: () => {} };
  child.unref = () => {};
  child.kill = () => {};
  setImmediate(() => child.emit("error", new Error("fake spawn: no real codex")));
  return child;
}

const HOME = "/homes/work";
const codexInstalled = getCodexAvailability(os.tmpdir()).available;

test("DIRECT app-server fallback: spawn env carries CODEX_HOME when an account is active", async () => {
  const fsImpl = createMemoryFs();
  const env = { CLAUDE_PLUGIN_DATA: "/data", PATH: "/usr/bin" };
  addAccount("work", { home: HOME }, { env, fsImpl });
  useAccount("work", { env, fsImpl });
  const codexEnv = resolveCodexEnv(env, { fsImpl });
  assert.equal(codexEnv.CODEX_HOME, HOME, "precondition: resolveCodexEnv injected CODEX_HOME");

  let capturedEnv = null;
  const spawnImpl = (_cmd, _args, options) => {
    capturedEnv = options.env;
    return makeFailingChild();
  };

  // disableBroker forces the direct SpawnedCodexAppServerClient path. The
  // connect rejects (fake child); we swallow it — the env capture is the point.
  await CodexAppServerClient.connect("/repo", {
    disableBroker: true,
    env: codexEnv,
    appServerCwd: os.tmpdir(),
    spawnImpl
  }).catch(() => {});

  assert.ok(capturedEnv, "spawn must have been called on the direct path");
  assert.equal(capturedEnv.CODEX_HOME, HOME, "direct spawn env MUST carry the active account's CODEX_HOME");
});

test("DIRECT app-server fallback: with NO active account, spawn env is byte-for-byte the base (no CODEX_HOME)", async () => {
  const fsImpl = createMemoryFs();
  // No `use` -> no active account.
  const env = { CLAUDE_PLUGIN_DATA: "/data", PATH: "/usr/bin" };
  const codexEnv = resolveCodexEnv(env, { fsImpl });
  assert.equal(codexEnv, env, "precondition: resolveCodexEnv returns the SAME base env reference");
  assert.equal("CODEX_HOME" in codexEnv, false);

  let capturedEnv = null;
  const spawnImpl = (_cmd, _args, options) => {
    capturedEnv = options.env;
    return makeFailingChild();
  };

  await CodexAppServerClient.connect("/repo", {
    disableBroker: true,
    env: codexEnv,
    appServerCwd: os.tmpdir(),
    spawnImpl
  }).catch(() => {});

  assert.ok(capturedEnv, "spawn must have been called");
  assert.equal("CODEX_HOME" in capturedEnv, false, "no active account: spawn env MUST NOT gain CODEX_HOME");
  assert.equal(capturedEnv.PATH, "/usr/bin", "the rest of the inherited env is intact");
});

test("BROKER spawn: the broker process env carries CODEX_HOME when an account is active", async () => {
  const fsImpl = createMemoryFs();
  const env = { CLAUDE_PLUGIN_DATA: "/data", PATH: "/usr/bin" };
  addAccount("work", { home: HOME }, { env, fsImpl });
  useAccount("work", { env, fsImpl });
  const codexEnv = resolveCodexEnv(env, { fsImpl });

  const cwd = os.tmpdir();
  let capturedEnv = null;
  const spawnImpl = (_cmd, _args, options) => {
    capturedEnv = options.env;
    const child = new EventEmitter();
    child.pid = 5252;
    child.unref = () => {};
    return child;
  };

  // ensureBrokerSession spawns the broker (captured), then waits for an
  // endpoint that never comes -> tears down and returns null. Expected.
  const session = await ensureBrokerSession(cwd, { env: codexEnv, timeoutMs: 50, spawnImpl });
  clearBrokerSession(cwd);

  assert.equal(session, null, "the fake broker never becomes ready, so the session is torn down");
  assert.ok(capturedEnv, "the broker spawn must have happened");
  assert.equal(capturedEnv.CODEX_HOME, HOME, "broker spawn env MUST carry CODEX_HOME so the codex child inherits it");
});

test("BROKER spawn: with NO active account, the broker env does not gain CODEX_HOME", async () => {
  const fsImpl = createMemoryFs();
  const env = { CLAUDE_PLUGIN_DATA: "/data", PATH: "/usr/bin" };
  const codexEnv = resolveCodexEnv(env, { fsImpl });
  assert.equal("CODEX_HOME" in codexEnv, false);

  const cwd = os.tmpdir();
  let capturedEnv = null;
  const spawnImpl = (_cmd, _args, options) => {
    capturedEnv = options.env;
    const child = new EventEmitter();
    child.pid = 5253;
    child.unref = () => {};
    return child;
  };

  const session = await ensureBrokerSession(cwd, { env: codexEnv, timeoutMs: 50, spawnImpl });
  clearBrokerSession(cwd);

  assert.equal(session, null);
  assert.ok(capturedEnv);
  assert.equal("CODEX_HOME" in capturedEnv, false, "no active account: broker env unchanged");
});

test("withAppServer threads options.env all the way to CodexAppServerClient.connect", { skip: codexInstalled ? false : "codex CLI not installed" }, async () => {
  // findLatestTaskThread is the cheapest public consumer of withAppServer: it
  // makes a single thread/list request and returns, so it proves the env-forward
  // thread without the cost of a full turn capture.
  const fsImpl = createMemoryFs();
  const env = { CLAUDE_PLUGIN_DATA: "/data", PATH: "/usr/bin" };
  addAccount("work", { home: HOME }, { env, fsImpl });
  useAccount("work", { env, fsImpl });
  const codexEnv = resolveCodexEnv(env, { fsImpl });

  // Inject a fake connect to capture the env withAppServer forwards.
  let connectEnv = null;
  const fakeClient = {
    transport: "direct",
    stderr: "",
    async request() {
      return { data: [] };
    },
    setNotificationHandler() {},
    async close() {}
  };
  const connectImpl = async (_cwd, options) => {
    connectEnv = options.env;
    return fakeClient;
  };

  // Real cwd so getCodexAvailability's `codex --version` probe has a valid wd;
  // the connect itself is the injected fake.
  await findLatestTaskThread(os.tmpdir(), { env: codexEnv, connectImpl });

  assert.ok(connectEnv, "withAppServer must forward env to connect");
  assert.equal(connectEnv.CODEX_HOME, HOME, "the active-account CODEX_HOME reaches connect()");
});

// Guard the BROKER_ENDPOINT_ENV import is real (keeps the import meaningful and
// documents that the broker endpoint env name is part of this surface).
test("broker endpoint env constant is exported", () => {
  assert.equal(typeof BROKER_ENDPOINT_ENV, "string");
});

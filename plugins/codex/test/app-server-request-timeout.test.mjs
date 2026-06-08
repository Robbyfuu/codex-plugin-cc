import assert from "node:assert/strict";
import { test } from "node:test";

import { AppServerClientBase } from "../scripts/lib/app-server.mjs";
import { CodexTimeoutError } from "../scripts/lib/watchdog.mjs";

/** A client whose transport is a no-op: requests are never answered unless the
 * test injects a reply via handleLine(). */
class SilentClient extends AppServerClientBase {
  constructor(env) {
    super("/tmp", { env });
    this.sent = [];
  }
  sendMessage(message) {
    this.sent.push(message);
  }
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

test("request() rejects with CodexTimeoutError when no reply arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new SilentClient({ CODEX_COMPANION_REQUEST_TIMEOUT_MS: "1000" });
  const pending = client.request("turn/start", { threadId: "t1" });

  t.mock.timers.tick(1001);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CodexTimeoutError);
    assert.equal(error.method, "turn/start");
    assert.equal(error.timeoutMs, 1000);
    return true;
  });
  // The pending entry must be cleaned up so a late reply is ignored safely.
  assert.equal(client.pending.size, 0);
});

test("request() resolves and clears the timer when a reply arrives first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearSpy = t.mock.method(globalThis, "clearTimeout");
  const client = new SilentClient({ CODEX_COMPANION_REQUEST_TIMEOUT_MS: "1000" });
  const pending = client.request("thread/start", {});

  // Simulate the server replying to id 1.
  const sentId = client.sent[0].id;
  client.handleLine(JSON.stringify({ id: sentId, result: { ok: true } }));

  const result = await pending;
  assert.deepEqual(result, { ok: true });
  assert.equal(client.pending.size, 0);
  assert.ok(clearSpy.mock.callCount() >= 1, "the per-request timer must be cleared on reply");

  // Ticking past the timeout must NOT throw or double-settle.
  t.mock.timers.tick(5000);
  await flushMicrotasks();
});

test("request() rejects with the server error and clears the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new SilentClient({ CODEX_COMPANION_REQUEST_TIMEOUT_MS: "1000" });
  const pending = client.request("account/read", {});
  const sentId = client.sent[0].id;
  client.handleLine(JSON.stringify({ id: sentId, error: { code: -32000, message: "nope" } }));

  await assert.rejects(pending, /nope/);
  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.equal(client.pending.size, 0);
});

test("request() backstop respects a custom generous ceiling without firing early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new SilentClient({ CODEX_COMPANION_REQUEST_TIMEOUT_MS: "600000" });
  let settled = false;
  const pending = client.request("turn/start", {}).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  // Well under the ceiling: nothing should settle.
  t.mock.timers.tick(599000);
  await flushMicrotasks();
  assert.equal(settled, false);

  // Now a reply arrives just in time.
  const sentId = client.sent[0].id;
  client.handleLine(JSON.stringify({ id: sentId, result: {} }));
  await pending;
  assert.equal(settled, true);
});

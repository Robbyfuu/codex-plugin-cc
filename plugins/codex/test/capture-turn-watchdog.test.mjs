import assert from "node:assert/strict";
import { test } from "node:test";

import { captureTurn } from "../scripts/lib/codex.mjs";
import { CodexStallError } from "../scripts/lib/watchdog.mjs";

/**
 * Minimal fake of the app-server client surface that captureTurn touches:
 * notification handler registration plus a request() spy.
 */
function createFakeClient() {
  const requests = [];
  return {
    notificationHandler: null,
    requests,
    setNotificationHandler(handler) {
      this.notificationHandler = handler;
    },
    emit(message) {
      this.notificationHandler?.(message);
    },
    request(method, params) {
      requests.push({ method, params });
      return Promise.resolve({});
    }
  };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

test("captureTurn rejects with CodexStallError and interrupts when the turn idles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = {
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "1000",
    CODEX_COMPANION_MAX_TURN_MS: "100000"
  };

  const pending = captureTurn(
    client,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }),
    { env }
  );

  // Let the start request resolve and the watchdog arm.
  await flushMicrotasks();

  // No events for the idle window -> stall.
  t.mock.timers.tick(1001);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CodexStallError);
    assert.equal(error.reason, "idle");
    return true;
  });

  const interrupt = client.requests.find((entry) => entry.method === "turn/interrupt");
  assert.ok(interrupt, "a turn/interrupt request must be sent on stall");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
});

test("captureTurn idle-stall message tells the user how to resume the surviving thread (F2)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = { CODEX_COMPANION_IDLE_TIMEOUT_MS: "1000", CODEX_COMPANION_MAX_TURN_MS: "100000" };

  const pending = captureTurn(client, "thread-1", () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }), { env });
  await flushMicrotasks();
  t.mock.timers.tick(1001);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CodexStallError);
    // The hint must name the REAL user-facing slash command. `/peer:task`
    // does not exist (task is an internal companion subcommand); the user path is
    // `/peer:rescue --resume-id <job-id>`.
    assert.match(error.message, /rescue --resume-id/, "the idle-stall message names the real /peer:rescue command");
    assert.doesNotMatch(error.message, /peer:task --resume-id/, "must not point at the nonexistent /peer:task command");
    return true;
  });
});

test("captureTurn hard-stop message tells the user how to resume the surviving thread (F2)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = { CODEX_COMPANION_IDLE_TIMEOUT_MS: "100000", CODEX_COMPANION_MAX_TURN_MS: "1000" };

  const pending = captureTurn(client, "thread-1", () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }), { env });
  await flushMicrotasks();
  t.mock.timers.tick(1001);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CodexStallError);
    assert.equal(error.reason, "max-duration");
    assert.match(error.message, /rescue --resume-id/, "the hard-stop message names the real /peer:rescue command");
    assert.doesNotMatch(error.message, /peer:task --resume-id/, "must not point at the nonexistent /peer:task command");
    return true;
  });
});

test("captureTurn does not stall while notifications keep arriving, then completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = {
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "1000",
    CODEX_COMPANION_MAX_TURN_MS: "100000"
  };

  const pending = captureTurn(
    client,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }),
    { env }
  );
  await flushMicrotasks();

  // Heartbeat under the idle window keeps the watchdog from firing.
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(800);
    client.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } }
    });
    await flushMicrotasks();
  }

  // Now deliver completion for the active thread.
  client.emit({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });

  const state = await pending;
  assert.equal(state.completed, true);
  assert.equal(state.finalTurn?.status, "completed");
  assert.equal(
    client.requests.some((entry) => entry.method === "turn/interrupt"),
    false,
    "no interrupt should be sent for a healthy turn"
  );
});

test("captureTurn does NOT stall during a long in-flight item with no notifications", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = {
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "1000",
    CODEX_COMPANION_MAX_TURN_MS: "1000000"
  };

  const pending = captureTurn(
    client,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }),
    { env }
  );
  await flushMicrotasks();

  // A slow commandExecution begins and emits NOTHING until it finishes (the
  // client opts out of delta notifications). This is the regression: the idle
  // watchdog must treat the in-flight item as activity, not a stall.
  client.emit({
    method: "item/started",
    params: { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: "pnpm test" } }
  });

  // Advance far past the idle window many times over with total silence.
  for (let i = 0; i < 10; i += 1) {
    t.mock.timers.tick(1000);
    await flushMicrotasks();
  }

  // No interrupt yet, turn still pending.
  assert.equal(
    client.requests.some((entry) => entry.method === "turn/interrupt"),
    false,
    "a healthy long-running item must not be interrupted as a stall"
  );

  // The item finally completes, then the real turn completes.
  client.emit({
    method: "item/completed",
    params: { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: "pnpm test", exitCode: 0 } }
  });
  client.emit({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });

  const state = await pending;
  assert.equal(state.completed, true);
  assert.equal(state.finalTurn?.status, "completed");
});

test("captureTurn resumes idle detection after the in-flight item completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = {
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "1000",
    CODEX_COMPANION_MAX_TURN_MS: "1000000"
  };

  const pending = captureTurn(
    client,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }),
    { env }
  );
  await flushMicrotasks();

  client.emit({
    method: "item/started",
    params: { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: "pnpm build" } }
  });
  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.equal(
    client.requests.some((entry) => entry.method === "turn/interrupt"),
    false,
    "paused while the item is in flight"
  );

  // Item completes; now the agent genuinely goes silent and SHOULD stall.
  client.emit({
    method: "item/completed",
    params: { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: "pnpm build", exitCode: 0 } }
  });
  await flushMicrotasks();
  t.mock.timers.tick(1001);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CodexStallError);
    assert.equal(error.reason, "idle");
    return true;
  });
  assert.ok(
    client.requests.some((entry) => entry.method === "turn/interrupt"),
    "idle detection resumes and interrupts once nothing is in flight"
  );
});

test("captureTurn hard ceiling still fires while an item is in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = {
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "100000",
    CODEX_COMPANION_MAX_TURN_MS: "5000"
  };

  const pending = captureTurn(
    client,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }),
    { env }
  );
  await flushMicrotasks();

  // An item is in flight for the whole turn and never completes; the idle timer
  // is paused, so MAX_TURN_MS is the only thing that can end this turn.
  client.emit({
    method: "item/started",
    params: { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: "sleep 9999" } }
  });
  t.mock.timers.tick(5001);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CodexStallError);
    assert.equal(error.reason, "max-duration");
    return true;
  });
});

test("captureTurn enforces the hard ceiling even under constant activity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createFakeClient();
  const env = {
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "100000",
    CODEX_COMPANION_MAX_TURN_MS: "5000"
  };

  const pending = captureTurn(
    client,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } }),
    { env }
  );
  await flushMicrotasks();

  for (let i = 0; i < 9; i += 1) {
    t.mock.timers.tick(500);
    client.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } }
    });
    await flushMicrotasks();
  }
  t.mock.timers.tick(600);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CodexStallError);
    assert.equal(error.reason, "max-duration");
    return true;
  });
});

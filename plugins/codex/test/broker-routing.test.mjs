import assert from "node:assert/strict";
import { test } from "node:test";

import { createNotificationRouter, performBrokerRecovery } from "../scripts/lib/broker-routing.mjs";

/** Build a mutable broker-state context plus a record of side effects. */
function makeCtx(overrides = {}) {
  const state = {
    generation: 1,
    recovering: false,
    activeRequestSocket: null,
    activeStreamSocket: null,
    activeStreamThreadIds: null,
    activeThreadIds: null,
    ...overrides
  };
  const sent = [];
  let notifyIdleCalls = 0;
  let stopIdleCalls = 0;
  const inFlight = new Set();
  let clearInFlightCalls = 0;

  const ctx = {
    getGeneration: () => state.generation,
    isRecovering: () => state.recovering,
    getActiveRequestSocket: () => state.activeRequestSocket,
    setActiveRequestSocket: (value) => {
      state.activeRequestSocket = value;
    },
    getActiveStreamSocket: () => state.activeStreamSocket,
    setActiveStreamSocket: (value) => {
      state.activeStreamSocket = value;
    },
    getActiveStreamThreadIds: () => state.activeStreamThreadIds,
    setActiveStreamThreadIds: (value) => {
      state.activeStreamThreadIds = value;
    },
    setActiveThreadIds: (value) => {
      state.activeThreadIds = value;
    },
    send: (socket, message) => sent.push({ socket, message }),
    notifyIdle: () => {
      notifyIdleCalls += 1;
    },
    stopIdle: () => {
      stopIdleCalls += 1;
    },
    noteItemStarted: (id) => inFlight.add(id),
    noteItemCompleted: (id) => inFlight.delete(id),
    clearInFlightItems: () => {
      clearInFlightCalls += 1;
      inFlight.clear();
    }
  };

  return {
    ctx,
    state,
    sent,
    inFlight,
    counts: () => ({ notifyIdle: notifyIdleCalls, stopIdle: stopIdleCalls, clearInFlight: clearInFlightCalls })
  };
}

test("router forwards a notification to the active stream socket for the current generation", () => {
  const socket = { id: "client-A" };
  const harness = makeCtx({
    activeStreamSocket: socket,
    activeStreamThreadIds: new Set(["t1"])
  });
  const route = createNotificationRouter(1, harness.ctx);

  route({ method: "item/started", params: { threadId: "t1" } });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].socket, socket);
  assert.equal(harness.counts().notifyIdle, 1);
});

test("H1: a stale notification from generation N is dropped after a swap to N+1", () => {
  const oldSocket = { id: "client-A" };
  const newSocket = { id: "client-B" };
  // Current generation is 2 (a swap already happened); a different client now
  // owns the stream slot. A handler bound to generation 1 must not touch it.
  const harness = makeCtx({
    generation: 2,
    activeStreamSocket: newSocket,
    activeStreamThreadIds: new Set(["t-new"])
  });
  const staleRoute = createNotificationRouter(1, harness.ctx);

  // The OLD child delivers a late turn/completed for its own (now-defunct) turn.
  staleRoute({ method: "turn/completed", params: { threadId: "t-old", turn: { status: "completed" } } });

  assert.equal(harness.sent.length, 0, "stale notification must not be forwarded");
  assert.equal(harness.state.activeStreamSocket, newSocket, "the new client's stream slot must be untouched");
  assert.equal(harness.state.activeStreamThreadIds.has("t-new"), true);
  assert.equal(harness.counts().notifyIdle, 0, "a dropped notification must not reset the idle guard");
  assert.equal(harness.counts().stopIdle, 0);
});

test("router stays quiet while a recovery is in flight", () => {
  const socket = { id: "client-A" };
  const harness = makeCtx({
    recovering: true,
    activeStreamSocket: socket,
    activeStreamThreadIds: new Set(["t1"])
  });
  const route = createNotificationRouter(1, harness.ctx);

  route({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } });

  assert.equal(harness.sent.length, 0);
  assert.equal(harness.state.activeStreamSocket, socket, "recovery owns slot teardown, not the router");
});

test("router clears the stream slot on a matching terminal turn/completed", () => {
  const socket = { id: "client-A" };
  const harness = makeCtx({
    activeStreamSocket: socket,
    activeStreamThreadIds: new Set(["t1"])
  });
  const route = createNotificationRouter(1, harness.ctx);

  route({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } });

  assert.equal(harness.sent.length, 1, "the completion is still forwarded to the client");
  assert.equal(harness.state.activeStreamSocket, null, "stream slot cleared");
  assert.equal(harness.state.activeStreamThreadIds, null);
  assert.equal(harness.counts().stopIdle, 1, "idle guard stopped once the slot is free");
});

test("router does NOT clear the stream slot for a turn/completed of a different thread", () => {
  const socket = { id: "client-A" };
  const harness = makeCtx({
    activeStreamSocket: socket,
    activeStreamThreadIds: new Set(["t1"])
  });
  const route = createNotificationRouter(1, harness.ctx);

  route({ method: "turn/completed", params: { threadId: "other-thread", turn: { status: "completed" } } });

  assert.equal(harness.sent.length, 1, "still forwarded");
  assert.equal(harness.state.activeStreamSocket, socket, "slot kept because the thread did not match");
});

test("router no-ops with no active client", () => {
  const harness = makeCtx();
  const route = createNotificationRouter(1, harness.ctx);
  route({ method: "item/started", params: { threadId: "t1" } });
  assert.equal(harness.sent.length, 0);
  // notifyIdle still fires (traffic seen) but nothing is forwarded.
  assert.equal(harness.counts().notifyIdle, 1);
});

test("router tracks item flight via noteItemStarted/noteItemCompleted", () => {
  const socket = { id: "client-A" };
  const harness = makeCtx({
    activeStreamSocket: socket,
    activeStreamThreadIds: new Set(["t1"])
  });
  const route = createNotificationRouter(1, harness.ctx);

  route({ method: "item/started", params: { threadId: "t1", item: { id: "cmd-1", type: "commandExecution" } } });
  assert.equal(harness.inFlight.has("cmd-1"), true, "started item is tracked in flight");

  route({ method: "item/completed", params: { threadId: "t1", item: { id: "cmd-1", type: "commandExecution" } } });
  assert.equal(harness.inFlight.has("cmd-1"), false, "completed item is removed from flight");
});

test("router tracks item flight even with no active client (before the early return)", () => {
  const harness = makeCtx();
  const route = createNotificationRouter(1, harness.ctx);

  route({ method: "item/started", params: { threadId: "t1", item: { id: "cmd-1", type: "commandExecution" } } });
  assert.equal(harness.sent.length, 0, "nothing forwarded with no bound socket");
  assert.equal(harness.inFlight.has("cmd-1"), true, "in-flight tracking still runs before the !target return");
});

test("router does NOT track item flight from a superseded generation", () => {
  const socket = { id: "client-B" };
  const harness = makeCtx({ generation: 2, activeStreamSocket: socket, activeStreamThreadIds: new Set(["t1"]) });
  const staleRoute = createNotificationRouter(1, harness.ctx);

  staleRoute({ method: "item/started", params: { threadId: "t1", item: { id: "cmd-old", type: "commandExecution" } } });
  assert.equal(harness.inFlight.has("cmd-old"), false, "a dropped stale notification must not pin the in-flight set");
});

test("router clears in-flight items when the slot goes fully idle", () => {
  const socket = { id: "client-A" };
  const harness = makeCtx({
    activeStreamSocket: socket,
    activeStreamThreadIds: new Set(["t1"])
  });
  const route = createNotificationRouter(1, harness.ctx);

  // An item is mid-flight when the turn completes (item/completed never arrives).
  route({ method: "item/started", params: { threadId: "t1", item: { id: "cmd-1", type: "commandExecution" } } });
  assert.equal(harness.inFlight.has("cmd-1"), true);

  route({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } });
  assert.equal(harness.counts().clearInFlight, 1, "slot teardown clears the in-flight set");
  assert.equal(harness.inFlight.size, 0, "no stale in-flight id survives the slot going idle");
  assert.equal(harness.counts().stopIdle, 1);
});

/** Build a recorder of the side effects performBrokerRecovery drives. */
function makeRecoveryHarness({ reconnect }) {
  const calls = [];
  const deps = {
    reconnect: async () => {
      calls.push("reconnect");
      return reconnect();
    },
    notifyWaiter: () => calls.push("notifyWaiter"),
    resetSlot: () => calls.push("resetSlot"),
    stopIdle: () => calls.push("stopIdle"),
    logError: () => calls.push("logError"),
    onUnrecoverable: () => calls.push("onUnrecoverable")
  };
  return { deps, calls };
}

test("performBrokerRecovery happy path: notifies waiter, resets slot, stops idle, no exit", async () => {
  const { deps, calls } = makeRecoveryHarness({ reconnect: () => Promise.resolve() });

  const outcome = await performBrokerRecovery(deps);

  assert.deepEqual(outcome, { recovered: true });
  assert.deepEqual(calls, ["reconnect", "notifyWaiter", "resetSlot", "stopIdle"]);
  assert.equal(calls.includes("onUnrecoverable"), false, "a successful swap must never fail-fast");
});

test("CR2: a failing reconnect notifies the waiting client and does NOT leave it hanging", async () => {
  const { deps, calls } = makeRecoveryHarness({
    reconnect: () => Promise.reject(new Error("connect ECONNREFUSED"))
  });

  const outcome = await performBrokerRecovery(deps);

  assert.equal(outcome.recovered, false);
  assert.ok(outcome.error instanceof Error);
  assert.equal(
    calls.includes("notifyWaiter"),
    true,
    "the parked client must be notified explicitly, not left to time out"
  );
});

test("CR2: a failing reconnect notifies the waiter BEFORE failing fast", async () => {
  const { deps, calls } = makeRecoveryHarness({
    reconnect: () => Promise.reject(new Error("boom"))
  });

  await performBrokerRecovery(deps);

  const waiterIdx = calls.indexOf("notifyWaiter");
  const exitIdx = calls.indexOf("onUnrecoverable");
  assert.ok(waiterIdx >= 0 && exitIdx >= 0, "both must run on the unhappy path");
  assert.ok(waiterIdx < exitIdx, "notifyWaiter must precede the fail-fast (onUnrecoverable)");
});

test("CR2: a failing reconnect stops the idle guard and fails fast exactly once (no loop)", async () => {
  const { deps, calls } = makeRecoveryHarness({
    reconnect: () => Promise.reject(new Error("boom"))
  });

  await performBrokerRecovery(deps);

  assert.equal(calls.filter((c) => c === "onUnrecoverable").length, 1, "exactly one fail-fast, never a loop");
  assert.equal(calls.includes("stopIdle"), true, "idle guard stopped so nothing re-triggers recovery");
  assert.equal(calls.includes("logError"), true, "the failure is logged");
});

test("CR2: a thrown (non-rejection) reconnect is handled the same way", async () => {
  const { deps, calls } = makeRecoveryHarness({
    reconnect: () => {
      throw new Error("sync throw");
    }
  });

  const outcome = await performBrokerRecovery(deps);

  assert.equal(outcome.recovered, false);
  assert.deepEqual(
    calls,
    ["reconnect", "logError", "notifyWaiter", "resetSlot", "stopIdle", "onUnrecoverable"],
    "synchronous throws follow the same notify -> reset -> stop -> fail-fast order"
  );
});

test("performBrokerRecovery tolerates an omitted onUnrecoverable (defaults to no-op)", async () => {
  const outcome = await performBrokerRecovery({
    reconnect: () => Promise.reject(new Error("boom")),
    notifyWaiter: () => {},
    resetSlot: () => {},
    stopIdle: () => {}
    // onUnrecoverable + logError intentionally omitted
  });
  assert.equal(outcome.recovered, false, "missing optional deps must not throw");
});

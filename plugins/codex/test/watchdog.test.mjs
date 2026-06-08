import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  CodexStallError,
  CodexTimeoutError,
  createIdleWatchdog,
  resolveTimeouts,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_TURN_MS,
  DEFAULT_REQUEST_TIMEOUT_MS
} from "../scripts/lib/watchdog.mjs";

test("resolveTimeouts returns documented defaults on empty env", () => {
  const resolved = resolveTimeouts({});
  assert.equal(resolved.idleMs, DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolved.maxTurnMs, DEFAULT_MAX_TURN_MS);
  assert.equal(resolved.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolved.idleMs, 180000);
  assert.equal(resolved.maxTurnMs, 900000);
  assert.equal(resolved.requestTimeoutMs, 600000);
});

test("resolveTimeouts honors valid overrides", () => {
  const resolved = resolveTimeouts({
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "5000",
    CODEX_COMPANION_MAX_TURN_MS: "60000",
    CODEX_COMPANION_REQUEST_TIMEOUT_MS: "30000"
  });
  assert.equal(resolved.idleMs, 5000);
  assert.equal(resolved.maxTurnMs, 60000);
  assert.equal(resolved.requestTimeoutMs, 30000);
});

test("resolveTimeouts falls back to defaults for invalid or non-positive values", () => {
  const resolved = resolveTimeouts({
    CODEX_COMPANION_IDLE_TIMEOUT_MS: "not-a-number",
    CODEX_COMPANION_MAX_TURN_MS: "-1",
    CODEX_COMPANION_REQUEST_TIMEOUT_MS: "0"
  });
  assert.equal(resolved.idleMs, DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolved.maxTurnMs, DEFAULT_MAX_TURN_MS);
  assert.equal(resolved.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
});

test("resolveTimeouts reads from process.env by default", () => {
  const resolved = resolveTimeouts();
  assert.equal(typeof resolved.idleMs, "number");
  assert.ok(resolved.idleMs > 0);
});

test("createIdleWatchdog fires onStall after idleMs with no activity", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 100000,
    onStall: () => {
      stalls += 1;
    },
    onHardStop: () => {}
  });

  watchdog.start();
  t.mock.timers.tick(999);
  assert.equal(stalls, 0);
  t.mock.timers.tick(2);
  assert.equal(stalls, 1);
  watchdog.stop();
});

test("createIdleWatchdog notify() resets the idle clock", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 100000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  t.mock.timers.tick(800);
  watchdog.notify();
  t.mock.timers.tick(800);
  assert.equal(stalls, 0, "no stall because notify reset the clock");
  t.mock.timers.tick(300);
  assert.equal(stalls, 1, "stall fires once the refreshed idle window elapses");
  watchdog.stop();
});

test("createIdleWatchdog fires onHardStop after maxMs regardless of activity", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let hardStops = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 5000,
    onStall: () => {},
    onHardStop: () => {
      hardStops += 1;
    }
  });

  watchdog.start();
  // Keep notifying so the idle watchdog never fires, but the hard ceiling must still trip.
  // Advance to 4500ms (still under the 5000ms ceiling) while staying active.
  for (let elapsed = 0; elapsed < 4500; elapsed += 500) {
    t.mock.timers.tick(500);
    watchdog.notify();
  }
  assert.equal(hardStops, 0, "hard stop must not fire before maxMs even with constant activity");
  t.mock.timers.tick(501);
  assert.equal(hardStops, 1, "hard ceiling fires at maxMs regardless of activity");
  watchdog.stop();
});

test("createIdleWatchdog stop() clears all timers (no further callbacks)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  let hardStops = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 5000,
    onStall: () => {
      stalls += 1;
    },
    onHardStop: () => {
      hardStops += 1;
    }
  });

  watchdog.start();
  watchdog.stop();
  t.mock.timers.tick(100000);
  assert.equal(stalls, 0);
  assert.equal(hardStops, 0);
});

test("createIdleWatchdog only fires onStall once even if left running", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 100000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  t.mock.timers.tick(5000);
  assert.equal(stalls, 1, "stall is a terminal, one-shot signal");
  watchdog.stop();
});

test("createIdleWatchdog notify() after stop() does not restart timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 100000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  watchdog.stop();
  watchdog.notify();
  t.mock.timers.tick(100000);
  assert.equal(stalls, 0);
});

test("createIdleWatchdog does NOT fire onStall while an item is in flight", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 1000000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  // An item starts and never completes; no other notifications arrive (the
  // client opts out of deltas, so a slow command/reasoning block is silent).
  watchdog.itemStarted("item-1");
  // Advance far past the idle window multiple times over.
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(5000);
  assert.equal(stalls, 0, "a legitimately in-flight item must not be treated as a stall");
  watchdog.stop();
});

test("createIdleWatchdog resumes idle detection after item/completed and fires on later silence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 1000000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  watchdog.itemStarted("item-1");
  t.mock.timers.tick(5000);
  assert.equal(stalls, 0, "paused while in flight");

  watchdog.itemCompleted("item-1");
  // Now nothing is in flight; the idle window starts counting from completion.
  t.mock.timers.tick(999);
  assert.equal(stalls, 0, "fresh idle window not yet elapsed");
  t.mock.timers.tick(2);
  assert.equal(stalls, 1, "stall fires once the post-completion idle window elapses");
  watchdog.stop();
});

test("createIdleWatchdog stays paused while ANY of several items is in flight", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 1000000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  watchdog.itemStarted("a");
  watchdog.itemStarted("b");
  watchdog.itemCompleted("a");
  t.mock.timers.tick(5000);
  assert.equal(stalls, 0, "b is still in flight, so no stall");

  watchdog.itemCompleted("b");
  t.mock.timers.tick(1001);
  assert.equal(stalls, 1, "stall resumes once the last item completes");
  watchdog.stop();
});

test("createIdleWatchdog de-dupes item ids (duplicate started / stray completed are safe)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 1000000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  watchdog.itemStarted("dup");
  watchdog.itemStarted("dup"); // duplicate add must not double-count
  watchdog.itemCompleted("dup"); // single completion clears it
  watchdog.itemCompleted("dup"); // stray extra completion is a no-op
  t.mock.timers.tick(1001);
  assert.equal(stalls, 1, "set semantics: one completion clears a duplicated start");
  watchdog.stop();
});

test("createIdleWatchdog onHardStop still fires while an item is in flight (the backstop)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  let hardStops = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 5000,
    onStall: () => {
      stalls += 1;
    },
    onHardStop: () => {
      hardStops += 1;
    }
  });

  watchdog.start();
  // An item is in flight for the entire turn and never completes.
  watchdog.itemStarted("forever");
  t.mock.timers.tick(4999);
  assert.equal(hardStops, 0, "hard ceiling not reached yet");
  assert.equal(stalls, 0, "idle is paused by the in-flight item");
  t.mock.timers.tick(2);
  assert.equal(hardStops, 1, "MAX_TURN_MS backstop fires even with an item in flight");
  assert.equal(stalls, 0, "the in-flight item is ended by the hard ceiling, never by idle");
  watchdog.stop();
});

test("createIdleWatchdog clearInFlight() drops items and lets idle fire again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 1000000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  watchdog.itemStarted("x");
  t.mock.timers.tick(5000);
  assert.equal(stalls, 0, "paused while x is in flight");
  watchdog.clearInFlight(); // e.g. turn ended without an explicit item/completed
  t.mock.timers.tick(1001);
  assert.equal(stalls, 1, "idle resumes once in-flight items are cleared");
  watchdog.stop();
});

test("createIdleWatchdog item callbacks after stop() do not restart timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let stalls = 0;
  const watchdog = createIdleWatchdog({
    idleMs: 1000,
    maxMs: 1000000,
    onStall: () => {
      stalls += 1;
    }
  });

  watchdog.start();
  watchdog.stop();
  watchdog.itemStarted("x");
  watchdog.itemCompleted("x");
  watchdog.clearInFlight();
  t.mock.timers.tick(100000);
  assert.equal(stalls, 0, "a stopped watchdog stays terminal");
});

test("CodexStallError and CodexTimeoutError carry name and code", () => {
  const stall = new CodexStallError("stalled", { idleMs: 1000 });
  assert.equal(stall.name, "CodexStallError");
  assert.equal(stall.code, "CODEX_STALL");
  assert.equal(stall.idleMs, 1000);

  const timeout = new CodexTimeoutError("timed out");
  assert.equal(timeout.name, "CodexTimeoutError");
  assert.equal(timeout.code, "CODEX_TIMEOUT");
});

mock.reset();

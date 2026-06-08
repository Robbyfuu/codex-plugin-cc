import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrokerIdleGuard } from "../scripts/lib/watchdog.mjs";

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

test("broker idle guard interrupts after one idle window, restarts after two", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  t.mock.timers.tick(1001);
  await flushMicrotasks();
  assert.equal(interrupts, 1, "stage one fires a soft interrupt");
  assert.equal(restarts, 0);

  t.mock.timers.tick(1001);
  await flushMicrotasks();
  assert.equal(restarts, 1, "stage two restarts the child when still idle");
  guard.stop();
});

test("broker idle guard notify() resets back to stage one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  t.mock.timers.tick(800);
  guard.notify();
  t.mock.timers.tick(800);
  await flushMicrotasks();
  assert.equal(interrupts, 0, "activity within the window prevents the soft interrupt");
  assert.equal(restarts, 0);
  guard.stop();
});

test("broker idle guard does nothing once the slot goes inactive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  let active = true;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => active,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  active = false;
  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.equal(interrupts, 0);
  assert.equal(restarts, 0);
  guard.stop();
});

test("broker idle guard stop() clears pending timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {}
  });

  guard.start();
  guard.stop();
  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.equal(interrupts, 0);
});

test("CR1: stop() during the stage-one interrupt await leaves the guard fully disarmed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  let releaseInterrupt;
  const interruptGate = new Promise((resolve) => {
    releaseInterrupt = resolve;
  });
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    interruptActiveTurn: async () => {
      interrupts += 1;
      await interruptGate; // park the stage-one callback mid-await
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  t.mock.timers.tick(1001); // fire stage one
  await flushMicrotasks();
  assert.equal(interrupts, 1, "stage one began its interrupt");
  assert.equal(restarts, 0);

  // The caller tears the guard down while the interrupt is still awaiting.
  guard.stop();
  releaseInterrupt();
  await flushMicrotasks();

  // No stage-two timer must have been armed by the resumed callback.
  t.mock.timers.tick(1000000);
  await flushMicrotasks();
  assert.equal(restarts, 0, "stop() during the await must prevent the stage-two restart");
  assert.equal(guard.stage, 0, "guard is fully disarmed");
});

test("CR1: stop() during the stage-two restart await does not let the callback clobber a later start()", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let restarts = 0;
  let releaseRestart;
  let restartGate = new Promise((resolve) => {
    releaseRestart = resolve;
  });
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    interruptActiveTurn: () => {},
    restartChild: async () => {
      restarts += 1;
      await restartGate;
    }
  });

  guard.start();
  t.mock.timers.tick(1001); // stage one interrupt (sync) -> arms stage two
  await flushMicrotasks();
  t.mock.timers.tick(1001); // stage two restart begins, parks on the gate
  await flushMicrotasks();
  assert.equal(restarts, 1, "stage two began its restart");

  // Tear down mid-restart, then let the restart finish.
  guard.stop();
  releaseRestart();
  await flushMicrotasks();

  // A subsequent start() must arm a clean stage one; the resumed stage-two
  // callback must not have reset the stage out from under it.
  guard.start();
  assert.equal(guard.stage, 1, "restart resumed without corrupting the guard's stage");
  guard.stop();
});

test("broker idle guard does NOT interrupt while an item is in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  let inFlight = true;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    isInFlight: () => inFlight,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  // A long command/reasoning block is running on the child; it emits no
  // notifications until it finishes. The guard must keep re-arming, never act.
  t.mock.timers.tick(1001);
  await flushMicrotasks();
  t.mock.timers.tick(1001);
  await flushMicrotasks();
  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.equal(interrupts, 0, "must not interrupt a child with an item in flight");
  assert.equal(restarts, 0, "must not restart a child with an item in flight");
  guard.stop();
});

test("broker idle guard resumes escalation once items clear", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  let inFlight = true;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    isInFlight: () => inFlight,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  t.mock.timers.tick(3000);
  await flushMicrotasks();
  assert.equal(interrupts, 0, "paused while in flight");

  // Item finished; the child then genuinely goes silent.
  inFlight = false;
  t.mock.timers.tick(1001);
  await flushMicrotasks();
  assert.equal(interrupts, 1, "stage one resumes after the item completes");

  t.mock.timers.tick(1001);
  await flushMicrotasks();
  assert.equal(restarts, 1, "stage two restarts when still idle and nothing in flight");
  guard.stop();
});

test("broker idle guard does not restart if an item starts during the second window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  let inFlight = false;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    isInFlight: () => inFlight,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  t.mock.timers.tick(1001);
  await flushMicrotasks();
  assert.equal(interrupts, 1, "stage one interrupt fired on a silent idle child");

  // The interrupt kicked the child and an item began executing again.
  inFlight = true;
  t.mock.timers.tick(1001);
  await flushMicrotasks();
  assert.equal(restarts, 0, "an item in flight during the restart window blocks the restart");
  guard.stop();
});

test("broker idle guard does not restart if activity resumes after the interrupt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let interrupts = 0;
  let restarts = 0;
  const guard = createBrokerIdleGuard({
    idleMs: 1000,
    isActive: () => true,
    interruptActiveTurn: () => {
      interrupts += 1;
    },
    restartChild: () => {
      restarts += 1;
    }
  });

  guard.start();
  t.mock.timers.tick(1001);
  await flushMicrotasks();
  assert.equal(interrupts, 1);

  // The interrupt woke the child up; traffic resumes.
  guard.notify();
  t.mock.timers.tick(800);
  await flushMicrotasks();
  assert.equal(restarts, 0, "resumed activity cancels the pending restart");
  guard.stop();
});

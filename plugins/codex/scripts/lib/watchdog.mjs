import process from "node:process";

import {
  IDLE_TIMEOUT_ENV as PEER_IDLE_TIMEOUT_ENV,
  MAX_TURN_ENV as PEER_MAX_TURN_ENV,
  REQUEST_TIMEOUT_ENV as PEER_REQUEST_TIMEOUT_ENV,
  readCompanionEnv
} from "./companion-env.mjs";

/**
 * Hang-prevention primitives shared by the direct app-server client, the
 * broker, and the turn capture loop. Everything here is pure and importable so
 * the timeout/stall behaviour can be unit-tested with fake timers instead of
 * waiting on real wall-clock delays.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 180000;
export const DEFAULT_MAX_TURN_MS = 900000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 600000;

export const IDLE_TIMEOUT_ENV = PEER_IDLE_TIMEOUT_ENV;
export const MAX_TURN_ENV = PEER_MAX_TURN_ENV;
export const REQUEST_TIMEOUT_ENV = PEER_REQUEST_TIMEOUT_ENV;

/** Raised when a turn stalls (no events for the idle window). */
export class CodexStallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexStallError";
    this.code = "CODEX_STALL";
    if (details.idleMs !== undefined) {
      this.idleMs = details.idleMs;
    }
    if (details.reason !== undefined) {
      this.reason = details.reason;
    }
  }
}

/** Raised when a single JSON-RPC request blows past its hard ceiling. */
export class CodexTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexTimeoutError";
    this.code = "CODEX_TIMEOUT";
    if (details.method !== undefined) {
      this.method = details.method;
    }
    if (details.timeoutMs !== undefined) {
      this.timeoutMs = details.timeoutMs;
    }
  }
}

/**
 * Parse a positive integer from an env value, falling back to `fallback` for
 * missing/blank/non-numeric/non-positive input. Keeps defaults stable so a
 * malformed override never silently disables a safety net.
 *
 * @param {string | undefined | null} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Resolve all hang-prevention timeouts from an environment bag.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ idleMs: number, maxTurnMs: number, requestTimeoutMs: number }}
 */
export function resolveTimeouts(env = process.env) {
  const source = env ?? {};
  return {
    idleMs: parsePositiveInt(readCompanionEnv("IDLE_TIMEOUT", source), DEFAULT_IDLE_TIMEOUT_MS),
    maxTurnMs: parsePositiveInt(readCompanionEnv("MAX_TURN", source), DEFAULT_MAX_TURN_MS),
    requestTimeoutMs: parsePositiveInt(readCompanionEnv("REQUEST_TIMEOUT", source), DEFAULT_REQUEST_TIMEOUT_MS)
  };
}

/**
 * Create an idle watchdog with two independent guards:
 *  - an idle guard that fires `onStall` when there has been no `notify()` AND
 *    nothing is in flight for `idleMs`, and
 *  - a hard ceiling that fires `onHardStop` `maxMs` after `start()`, regardless
 *    of activity (the backstop for an item that genuinely never completes).
 *
 * Item-awareness (why this matters): the app-server client opts OUT of delta
 * notifications, so a long-running item (a slow `commandExecution`, a long
 * reasoning/answer block) emits `item/started` and then nothing until
 * `item/completed`. A naive "no notification for idleMs => stall" guard would
 * false-trip and kill healthy long work. So while at least one item is in
 * flight the idle guard refuses to fire `onStall`; it simply re-arms. The hard
 * ceiling is the only thing that can end a turn whose item never completes.
 *
 * Track items via `itemStarted(id)` / `itemCompleted(id)`. Ids are de-duped, so
 * a duplicate `item/started` (or a stray `item/completed`) cannot corrupt the
 * count. `clearInFlight()` drops the whole set (call it on turn end so a
 * never-completed item does not leave the guard permanently paused for a reused
 * watchdog — though normal usage is one watchdog per turn followed by `stop()`).
 *
 * Both signals are one-shot and terminal: once either fires, the watchdog stops
 * itself so the caller never gets a second callback. `stop()` is idempotent and
 * clears every timer (no dangling handles).
 *
 * @param {{
 *   idleMs: number,
 *   maxMs: number,
 *   onStall?: () => void,
 *   onHardStop?: () => void,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout
 * }} config
 */
export function createIdleWatchdog(config) {
  const {
    idleMs,
    maxMs,
    onStall = () => {},
    onHardStop = () => {},
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = config;

  let idleTimer = null;
  let hardTimer = null;
  let finished = false;
  const inFlightItems = new Set();

  function clearIdleTimer() {
    if (idleTimer !== null) {
      clearTimeoutImpl(idleTimer);
      idleTimer = null;
    }
  }

  function clearHardTimer() {
    if (hardTimer !== null) {
      clearTimeoutImpl(hardTimer);
      hardTimer = null;
    }
  }

  function stop() {
    finished = true;
    clearIdleTimer();
    clearHardTimer();
    inFlightItems.clear();
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (finished) {
      return;
    }
    idleTimer = setTimeoutImpl(() => {
      idleTimer = null;
      if (finished) {
        return;
      }
      // An item is legitimately executing (e.g. a slow build/test/clone that
      // emits no notifications until it finishes). That is NOT a stall: re-arm
      // and let the hard ceiling be the only thing that can end this turn.
      if (inFlightItems.size > 0) {
        armIdleTimer();
        return;
      }
      stop();
      onStall();
    }, idleMs);
    idleTimer?.unref?.();
  }

  function start() {
    if (finished) {
      return;
    }
    armIdleTimer();
    clearHardTimer();
    hardTimer = setTimeoutImpl(() => {
      hardTimer = null;
      if (finished) {
        return;
      }
      stop();
      onHardStop();
    }, maxMs);
    hardTimer?.unref?.();
  }

  function notify() {
    if (finished) {
      return;
    }
    armIdleTimer();
  }

  function itemStarted(id) {
    if (finished || id === undefined || id === null) {
      return;
    }
    inFlightItems.add(id);
    // A fresh item is activity; reset the idle clock so the guard measures
    // silence from the moment the item began, not from the last notification.
    armIdleTimer();
  }

  function itemCompleted(id) {
    if (id === undefined || id === null) {
      return;
    }
    inFlightItems.delete(id);
    if (finished) {
      return;
    }
    // The item finished, so the idle window now starts counting again from a
    // clean slate (covers the case where this was the last in-flight item).
    armIdleTimer();
  }

  function clearInFlight() {
    inFlightItems.clear();
    if (!finished) {
      armIdleTimer();
    }
  }

  return { start, notify, stop, itemStarted, itemCompleted, clearInFlight };
}

/**
 * Two-stage idle self-heal guard for the broker. Stage 1 (after `idleMs` with
 * no `notify()`) attempts a soft `interruptActiveTurn`. If still idle for
 * another `idleMs`, stage 2 calls `restartChild`. `notify()` resets back to
 * stage 1; `start()` (re)arms from stage 1; `stop()` clears everything.
 *
 * Item-awareness (mirrors createIdleWatchdog): the broker routes every
 * notification through createNotificationRouter and therefore sees
 * `item/started` / `item/completed`. While at least one item is in flight,
 * neither the soft interrupt nor the child restart may fire — a long
 * `commandExecution`/reasoning block emits no notifications mid-flight and must
 * not be mistaken for a wedged child. When `isInFlight()` is true the guard
 * re-arms stage one instead of acting. There is deliberately NO hard ceiling
 * here: the per-turn createIdleWatchdog (companion side) owns MAX_TURN_MS; the
 * broker only self-heals genuinely silent + idle slots.
 *
 * Both stage callbacks are awaited and guarded so a slow restart cannot overlap
 * itself. The guard re-checks `isActive()` before each stage so it never acts
 * on an already-idle/cleared slot.
 *
 * @param {{
 *   idleMs: number,
 *   isActive: () => boolean,
 *   isInFlight?: () => boolean,
 *   interruptActiveTurn: () => unknown | Promise<unknown>,
 *   restartChild: () => unknown | Promise<unknown>,
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout
 * }} config
 */
export function createBrokerIdleGuard(config) {
  const {
    idleMs,
    isActive,
    isInFlight = () => false,
    interruptActiveTurn,
    restartChild,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = config;

  let timer = null;
  let stage = 0;
  let running = false;
  // Bumped on every stop()/(re)start so an in-flight stage callback that is
  // parked on an await can tell whether the guard was torn down (or restarted)
  // while it was suspended, and abort its post-await re-arm accordingly.
  let lifecycleToken = 0;

  function clearTimer() {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  function stop() {
    stage = 0;
    lifecycleToken += 1;
    clearTimer();
  }

  function armStageOne() {
    clearTimer();
    stage = 1;
    timer = setTimeoutImpl(onStageOne, idleMs);
    timer?.unref?.();
  }

  function armStageTwo() {
    clearTimer();
    stage = 2;
    timer = setTimeoutImpl(onStageTwo, idleMs);
    timer?.unref?.();
  }

  async function onStageOne() {
    timer = null;
    if (running || !isActive()) {
      return;
    }
    // An item is legitimately executing: do not interrupt. Re-arm stage one so
    // the idle window keeps measuring silence, but never escalate while busy.
    if (isInFlight()) {
      armStageOne();
      return;
    }
    running = true;
    const tokenAtAwait = lifecycleToken;
    try {
      await interruptActiveTurn();
    } catch {
      // Best-effort; stage two handles a child that ignores the interrupt.
    } finally {
      running = false;
    }
    // If stop() (or a restart) ran while we were awaiting the interrupt, honor
    // it: do NOT re-arm stage two, or we would resurrect a guard the caller
    // explicitly tore down.
    if (lifecycleToken !== tokenAtAwait) {
      return;
    }
    if (isActive()) {
      armStageTwo();
    } else {
      stage = 0;
    }
  }

  async function onStageTwo() {
    timer = null;
    if (running || !isActive()) {
      return;
    }
    // Same guard as stage one: never restart a child that has an item in
    // flight. Fall back to stage one and keep waiting for real silence.
    if (isInFlight()) {
      armStageOne();
      return;
    }
    running = true;
    const tokenAtAwait = lifecycleToken;
    try {
      await restartChild();
    } catch {
      // recoverBrokerChild logs its own failures.
    } finally {
      running = false;
      // Only settle the stage if nobody tore down/restarted the guard during
      // the await; otherwise stop()/start() already owns the stage value.
      if (lifecycleToken === tokenAtAwait) {
        stage = 0;
      }
    }
  }

  function start() {
    lifecycleToken += 1;
    armStageOne();
  }

  function notify() {
    if (running) {
      return;
    }
    armStageOne();
  }

  return { start, notify, stop, get stage() { return stage; } };
}

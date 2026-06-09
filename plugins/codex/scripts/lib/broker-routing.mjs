/**
 * Notification routing for the broker, extracted as a pure factory so the
 * generation guard (drop notifications from a superseded codex child) is
 * unit-testable without booting a real child.
 *
 * The factory binds a handler to a specific child `generation`. `ctx` exposes
 * the broker's shared mutable slot state via getters/setters plus the side
 * effects (`send`, `notifyIdle`, `stopIdle`, and item-flight tracking). The
 * returned handler:
 *   - drops anything whose bound generation != the current generation,
 *   - stays quiet while a recovery is in flight,
 *   - tracks in-flight items (`item/started` => noteItemStarted,
 *     `item/completed` => noteItemCompleted) so the broker idle guard knows a
 *     slow command/reasoning block is legitimately running and must not be
 *     interrupted/restarted,
 *   - otherwise forwards the notification to the active client and clears the
 *     stream slot on a matching terminal `turn/completed`.
 *
 * Item-flight tracking runs BEFORE the early `!target` return so a notification
 * that arrives with no bound socket still updates the in-flight set. `ctx`
 * item-flight callbacks are optional (older callers without them still work).
 *
 * @param {number} boundGeneration
 * @param {{
 *   getGeneration: () => number,
 *   isRecovering: () => boolean,
 *   getActiveRequestSocket: () => unknown,
 *   setActiveRequestSocket: (value: unknown) => void,
 *   getActiveStreamSocket: () => unknown,
 *   setActiveStreamSocket: (value: unknown) => void,
 *   getActiveStreamThreadIds: () => Set<string> | null,
 *   setActiveStreamThreadIds: (value: Set<string> | null) => void,
 *   setActiveThreadIds: (value: Set<string> | null) => void,
 *   send: (socket: unknown, message: unknown) => void,
 *   notifyIdle: () => void,
 *   stopIdle: () => void,
 *   noteItemStarted?: (itemId: string) => void,
 *   noteItemCompleted?: (itemId: string) => void,
 *   clearInFlightItems?: () => void
 * }} ctx
 * @returns {(message: any) => void}
 */
export function createNotificationRouter(boundGeneration, ctx) {
  return function routeNotification(message) {
    // Drop anything from a superseded child, and stay quiet while a recovery is
    // mid-flight (the recovery itself emits the client-facing signals).
    if (boundGeneration !== ctx.getGeneration() || ctx.isRecovering()) {
      return;
    }

    ctx.notifyIdle();

    // Track item flight before any early return: a long item that emits no
    // notifications until it completes must keep the broker idle guard from
    // interrupting/restarting a healthy child.
    const itemId = message?.params?.item?.id;
    if (itemId !== undefined && itemId !== null) {
      if (message.method === "item/started") {
        ctx.noteItemStarted?.(itemId);
      } else if (message.method === "item/completed") {
        ctx.noteItemCompleted?.(itemId);
      }
    }

    const target = ctx.getActiveRequestSocket() ?? ctx.getActiveStreamSocket();
    if (!target) {
      return;
    }

    ctx.send(target, message);

    if (message.method === "turn/completed" && ctx.getActiveStreamSocket() === target) {
      const threadId = message.params?.threadId ?? null;
      const streamThreadIds = ctx.getActiveStreamThreadIds();
      if (!threadId || !streamThreadIds || streamThreadIds.has(threadId)) {
        ctx.setActiveStreamSocket(null);
        ctx.setActiveStreamThreadIds(null);
        if (ctx.getActiveRequestSocket() === target) {
          ctx.setActiveRequestSocket(null);
        }
      }
    }

    if (!ctx.getActiveRequestSocket() && !ctx.getActiveStreamSocket()) {
      ctx.setActiveThreadIds(null);
      ctx.clearInFlightItems?.();
      ctx.stopIdle();
    }
  };
}

/**
 * Orchestrate a broker child recovery as a pure, injectable sequence so the
 * unhappy path (reconnect fails) is unit-testable without booting a child.
 *
 * Happy path: swap the codex child (the injected `reconnect` bumps generation,
 * closes the old client, connects a new one, and rebinds the handler), notify
 * the waiting client that its in-flight turn was recovered, then reset the slot.
 *
 * Unhappy path (CR2): if `reconnect` throws, the broker now holds a broken
 * `appClient` with a bumped generation — every future request would fail and the
 * idle guard could keep re-triggering recovery in a loop. So we:
 *   1. notify the waiting client explicitly (JSON-RPC error + synthetic
 *      turn/completed for a streaming waiter) so the caller never hangs,
 *   2. reset the slot and stop the idle guard (no recovery loop),
 *   3. invoke `onUnrecoverable()` so the broker fails fast (process.exit), which
 *      lets broker-lifecycle.ensureBrokerSession lazily respawn a FRESH broker +
 *      child on the next /codex-plus:* call (its endpoint probe detects the dead
 *      socket and spawns anew).
 *
 * Returns `{ recovered: true }` on success or `{ recovered: false, error }` on
 * failure (after notifying + invoking onUnrecoverable), so callers/tests can
 * assert the outcome.
 *
 * @param {{
 *   reconnect: () => unknown | Promise<unknown>,
 *   notifyWaiter: () => void,
 *   resetSlot: () => void,
 *   stopIdle: () => void,
 *   onUnrecoverable?: (error: unknown) => void,
 *   logError?: (error: unknown) => void
 * }} deps
 * @returns {Promise<{ recovered: boolean, error?: unknown }>}
 */
export async function performBrokerRecovery(deps) {
  const {
    reconnect,
    notifyWaiter,
    resetSlot,
    stopIdle,
    onUnrecoverable = () => {},
    logError = () => {}
  } = deps;

  try {
    await reconnect();
    // Success: tell the parked client its turn was recovered, then free the slot
    // so the next request can proceed against the fresh child.
    notifyWaiter();
    resetSlot();
    stopIdle();
    return { recovered: true };
  } catch (error) {
    // The child swap failed. The broker can no longer serve requests on this
    // (broken, generation-bumped) client. Notify the waiter, halt the idle guard
    // so nothing re-triggers recovery, then fail fast for a clean respawn.
    logError(error);
    notifyWaiter();
    resetSlot();
    stopIdle();
    onUnrecoverable(error);
    return { recovered: false, error };
  }
}

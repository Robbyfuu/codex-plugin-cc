#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { createNotificationRouter, performBrokerRecovery } from "./lib/broker-routing.mjs";
import { createBrokerIdleGuard, resolveTimeouts } from "./lib/watchdog.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const BROKER_RECOVERED_RPC_CODE = -32003;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const { idleMs } = resolveTimeouts(process.env);
  let appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  // Monotonic generation, bumped on every child (re)connect. Each child's
  // notification handler closes over the generation it was created with, so a
  // late notification from an OLD child (e.g. a stale turn/completed arriving
  // after a swap) can be recognised and dropped instead of unparking/clearing
  // the NEXT client's stream slot.
  let generation = 0;
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeThreadIds = null;
  let recovering = false;
  // Latches true if a recovery's reconnect fails. A latched-unhealthy broker
  // refuses further recovery attempts (no loop) and is on its way to exit(1) so
  // broker-lifecycle respawns a fresh broker + child on the next call.
  let unhealthy = false;
  const sockets = new Set();
  // De-duped set of item ids that have started but not yet completed on the
  // active child. While non-empty the idle guard must not interrupt/restart the
  // child: a long command/reasoning block emits no notifications mid-flight.
  const inFlightItems = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
    if (!activeRequestSocket && !activeStreamSocket) {
      activeThreadIds = null;
      inFlightItems.clear();
      idleGuard.stop();
    }
  }

  function activeClientSocket() {
    return activeRequestSocket ?? activeStreamSocket;
  }

  // Build a notification handler bound to a specific child generation. The bound
  // generation is checked against the current one on every notification so a
  // late notification from a superseded child no-ops. Routing logic lives in the
  // pure createNotificationRouter factory (unit-tested in isolation).
  function makeRouteNotification(boundGeneration) {
    return createNotificationRouter(boundGeneration, {
      getGeneration: () => generation,
      isRecovering: () => recovering,
      getActiveRequestSocket: () => activeRequestSocket,
      setActiveRequestSocket: (value) => {
        activeRequestSocket = value;
      },
      getActiveStreamSocket: () => activeStreamSocket,
      setActiveStreamSocket: (value) => {
        activeStreamSocket = value;
      },
      getActiveStreamThreadIds: () => activeStreamThreadIds,
      setActiveStreamThreadIds: (value) => {
        activeStreamThreadIds = value;
      },
      setActiveThreadIds: (value) => {
        activeThreadIds = value;
      },
      send,
      notifyIdle: () => idleGuard.notify(),
      stopIdle: () => idleGuard.stop(),
      noteItemStarted: (itemId) => inFlightItems.add(itemId),
      noteItemCompleted: (itemId) => inFlightItems.delete(itemId),
      clearInFlightItems: () => inFlightItems.clear()
    });
  }

  // Two-stage self-heal: when the active request/stream sees no traffic for the
  // idle window, first try a soft interrupt of the codex child; if it stays
  // silent for a second window, restart the child and unblock the waiting
  // client so the session recovers instead of wedging on BROKER_BUSY forever.
  const idleGuard = createBrokerIdleGuard({
    idleMs,
    isActive: () => Boolean(activeClientSocket()) && !recovering,
    // A started-but-not-completed item means the child is legitimately busy
    // (e.g. a slow build/test/clone). Never interrupt/restart while in flight.
    isInFlight: () => inFlightItems.size > 0,
    interruptActiveTurn: async () => {
      // Capture the client up-front: a concurrent recovery may reassign
      // appClient (and close the old one) while we await below. If a recovery is
      // already running, let it own the child instead of touching a half-open one.
      if (recovering) {
        return;
      }
      const client = appClient;
      const threadIds = activeThreadIds && activeThreadIds.size > 0 ? [...activeThreadIds] : [];
      for (const threadId of threadIds) {
        if (recovering || client.closed) {
          return;
        }
        try {
          await client.request("turn/interrupt", { threadId });
        } catch {
          // Best-effort soft recovery; the restart stage handles a wedged child.
        }
      }
    },
    restartChild: async () => {
      if (recovering) {
        return;
      }
      await recoverBrokerChild("Shared Codex broker restarted the runtime after a stall.");
    }
  });

  async function recoverBrokerChild(detail) {
    // `unhealthy` latches after a failed reconnect so a pending process.exit can
    // never be out-raced into a recovery loop (defense-in-depth alongside exit).
    if (recovering || unhealthy) {
      return;
    }
    recovering = true;
    const waiting = activeClientSocket();
    // A streaming client is parked on turn/completed notifications, not on a
    // request id, so a plain JSON-RPC error keyed to id:null would be ignored.
    // Capture the threads it is streaming so we can emit synthetic
    // turn/completed signals that the client actually processes.
    const streamingThreadIds =
      activeStreamSocket === waiting && activeThreadIds && activeThreadIds.size > 0 ? [...activeThreadIds] : [];

    const outcome = await performBrokerRecovery({
      reconnect: async () => {
        const oldClient = appClient;
        // Bump the generation BEFORE closing/reconnecting so the old child's
        // handler (and any late notifications it delivers, even during the close
        // await) immediately no-op via the generation check — independent of the
        // `recovering` flag.
        generation += 1;
        await oldClient.close().catch(() => {});
        appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
        appClient.setNotificationHandler(makeRouteNotification(generation));
      },
      notifyWaiter: () => {
        if (!waiting) {
          return;
        }
        // Surface a human-readable error first (picked up by id-keyed waiters and
        // logged by streaming waiters), then settle any streaming turn so the
        // client's completion promise resolves instead of hanging.
        send(waiting, {
          id: null,
          error: buildJsonRpcError(BROKER_RECOVERED_RPC_CODE, detail)
        });
        for (const threadId of streamingThreadIds) {
          send(waiting, {
            method: "turn/completed",
            params: { threadId, turn: { id: "broker-recovered", status: "interrupted" } }
          });
        }
      },
      resetSlot: () => {
        activeRequestSocket = null;
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        activeThreadIds = null;
        // The old child (and its in-flight items) is gone; start the new one with
        // an empty in-flight set so a stale id can never keep the guard paused.
        inFlightItems.clear();
      },
      stopIdle: () => idleGuard.stop(),
      logError: (error) => {
        process.stderr.write(
          `broker recovery failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      },
      onUnrecoverable: () => {
        // The child swap failed; this broker can no longer serve requests on its
        // broken client. Latch unhealthy, then exit so broker-lifecycle respawns
        // a fresh broker + child on the next /codex-plus:* call. The waiting client
        // was already notified by notifyWaiter above, so nobody hangs.
        unhealthy = true;
        process.exit(1);
      }
    });

    recovering = false;
    return outcome;
  }

  async function shutdown(server) {
    idleGuard.stop();
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(makeRouteNotification(generation));

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        // Hard-cancel hook: force the broker to interrupt the active turn and
        // restart its codex child so a wedged slot recovers immediately instead
        // of waiting for the idle timer or SessionEnd. Ownership-scoped: only
        // restart when the cancelled job actually owns the active slot, so one
        // job's cancel never kills another job's in-flight turn. A recover with
        // no threadId means "recover only if idle/unowned".
        //
        // KNOWN LIMITATION (detached review): a DETACHED `/codex-plus:review` job
        // persists threadId = reviewThreadId, while the broker keys
        // activeThreadIds on the source thread until the `review/start` response
        // resolves. buildStreamThreadIds then adds BOTH source + reviewThreadId
        // to activeThreadIds, so a detached cancel matches in steady state; only
        // a cancel landing in the brief review/start round-trip window can
        // no-op. The native inline `/codex-plus:review` path is unaffected (it cancels
        // on the source thread). Documented rather than fixed because closing the
        // window would require persisting/forwarding sourceThreadId end-to-end.
        if (message.id !== undefined && message.method === "broker/recover") {
          const wasBusy = Boolean(activeClientSocket());
          const requestedThreadId = message.params?.threadId ?? null;
          const ownsActiveSlot = requestedThreadId
            ? Boolean(activeThreadIds && activeThreadIds.has(requestedThreadId))
            : !wasBusy;

          if (ownsActiveSlot) {
            await recoverBrokerChild("Shared Codex broker runtime was restarted by an explicit cancel.");
            send(socket, { id: message.id, result: { recovered: true, wasBusy, owned: true } });
          } else {
            // Not our turn (or someone else owns the slot): do not disturb it.
            send(socket, { id: message.id, result: { recovered: false, wasBusy, owned: false } });
          }
          continue;
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        if (message.params?.threadId) {
          activeThreadIds = new Set([message.params.threadId]);
        }
        // Watch the active slot for stalls (covers both the request round-trip
        // and any subsequent streaming notifications).
        idleGuard.start();

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          idleGuard.notify();
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            activeThreadIds = activeStreamThreadIds;
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (!activeStreamSocket) {
            activeThreadIds = null;
            inFlightItems.clear();
            idleGuard.stop();
          }
        } catch (error) {
          idleGuard.stop();
          inFlightItems.clear();
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
          if (!activeRequestSocket && !activeStreamSocket) {
            activeThreadIds = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

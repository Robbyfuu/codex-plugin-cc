import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { sendBrokerShutdown } from "../scripts/lib/broker-lifecycle.mjs";
import { readStdinIfPiped } from "../scripts/lib/fs.mjs";

const FS_MODULE_URL = new URL("../scripts/lib/fs.mjs", import.meta.url).href;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Issue #7:
 *  A) sendBrokerShutdown must not hang forever — it awaits a socket request,
 *     so a never-responding broker would wedge the SessionEnd hook. It must be
 *     bounded by a timeout.
 *  B) Hooks read stdin; a blocking readFileSync(0) hangs when stdin never
 *     closes and throws EAGAIN under concurrent sessions. Reading must be
 *     non-blocking-safe and never hang.
 */

// ---------------------------------------------------------------------------
// A) bounded broker shutdown
// ---------------------------------------------------------------------------

function makeSilentUnixServer() {
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cxc-silent-")), "broker.sock");
  const server = net.createServer((socket) => {
    // Accept the connection but NEVER respond — simulate a wedged broker.
    socket.resume();
  });
  return new Promise((resolve) => {
    server.listen(sockPath, () => {
      resolve({ endpoint: `unix:${sockPath}`, server, sockPath });
    });
  });
}

test("sendBrokerShutdown resolves within its timeout against a never-responding broker", async () => {
  const { endpoint, server } = await makeSilentUnixServer();
  const previous = process.env.PEER_COMPANION_SHUTDOWN_TIMEOUT_MS;
  process.env.PEER_COMPANION_SHUTDOWN_TIMEOUT_MS = "300";

  try {
    const start = Date.now();
    await sendBrokerShutdown(endpoint);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `shutdown must return promptly via timeout, took ${elapsed}ms`);
  } finally {
    if (previous === undefined) {
      delete process.env.PEER_COMPANION_SHUTDOWN_TIMEOUT_MS;
    } else {
      process.env.PEER_COMPANION_SHUTDOWN_TIMEOUT_MS = previous;
    }
    server.close();
  }
});

test("sendBrokerShutdown resolves immediately for a missing endpoint", async () => {
  await assert.doesNotReject(() => sendBrokerShutdown(null));
});

// ---------------------------------------------------------------------------
// B) non-blocking stdin
// ---------------------------------------------------------------------------

test("readStdinIfPiped returns empty promptly when stdin is a TTY", async () => {
  const result = await readStdinIfPiped({ isTTY: true });
  assert.equal(result, "");
});

test("readStdinIfPiped survives EAGAIN from the underlying reader and returns empty", async () => {
  const eagainReader = () => {
    const error = new Error("resource temporarily unavailable");
    error.code = "EAGAIN";
    throw error;
  };
  const result = await readStdinIfPiped({ isTTY: false, readImpl: eagainReader, timeoutMs: 200 });
  assert.equal(result, "");
});

test("readStdinIfPiped returns piped content when the reader yields data", async () => {
  const result = await readStdinIfPiped({
    isTTY: false,
    readImpl: () => '{"hello":"world"}'
  });
  assert.equal(result, '{"hello":"world"}');
});

test("readStdinIfPiped never hangs and returns empty when no data is available", async () => {
  // A reader that signals "no data right now" (null) must resolve, not hang.
  const start = Date.now();
  const result = await readStdinIfPiped({
    isTTY: false,
    readImpl: () => null,
    timeoutMs: 200
  });
  const elapsed = Date.now() - start;
  assert.equal(result, "");
  assert.ok(elapsed < 2000, `must not hang, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// B') REAL fd-0 path: the DEFAULT reader must read fd 0 asynchronously, so a
// child whose stdin is an open-but-SILENT pipe (never written, never closed)
// resolves "" within the budget instead of blocking forever on a synchronous
// readFileSync(0). This exercises the production default path end-to-end in a
// child process — no injected readImpl. (#7 / upstream openai/codex-plugin-cc#247)
// ---------------------------------------------------------------------------

test("readStdinIfPiped default path returns empty within budget when fd 0 is an open, never-closing pipe", async () => {
  const childSource = `
    import { readStdinIfPiped } from ${JSON.stringify(FS_MODULE_URL)};
    // Force the piped (non-TTY) branch and exercise the DEFAULT reader: no
    // injected readImpl, so this hits the real fd-0 path with a short budget.
    const value = await readStdinIfPiped({ isTTY: false, timeoutMs: 400 });
    process.stdout.write(JSON.stringify({ value }));
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: TEST_DIR,
    // stdin is a piped fd we deliberately leave open and silent for the whole
    // test: the child must NOT depend on EOF to make progress.
    stdio: ["pipe", "pipe", "inherit"]
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const start = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    // Safety net: if the child blocks (the bug), kill it so the test fails as a
    // timeout rather than hanging the whole suite.
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child blocked on fd-0 read instead of timing out (synchronous readFileSync regression)"));
    }, 4000);
    guard.unref?.();
    child.on("exit", (code) => {
      clearTimeout(guard);
      resolve(code);
    });
    child.on("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
  });
  const elapsed = Date.now() - start;

  // The pipe is still open here; we only end it after the child has exited so
  // the child could not have made progress via EOF.
  child.stdin.end();

  assert.equal(exitCode, 0, "child exited cleanly");
  assert.deepEqual(JSON.parse(stdout), { value: "" }, "an open, silent fd 0 yields an empty payload");
  assert.ok(elapsed < 3500, `default fd-0 read must honor the budget, took ${elapsed}ms`);
});

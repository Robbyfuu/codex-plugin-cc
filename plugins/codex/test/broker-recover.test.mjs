import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as brokerLifecycle from "../scripts/lib/broker-lifecycle.mjs";
import { isBrokerEndpointReady, sendBrokerRecover } from "../scripts/lib/broker-lifecycle.mjs";

test("broker-lifecycle exports isBrokerEndpointReady for doctor reuse", () => {
  assert.equal(typeof brokerLifecycle.isBrokerEndpointReady, "function");
  assert.equal(typeof isBrokerEndpointReady, "function");
});

function makeSocketPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-recover-"));
  return { dir, socketPath: path.join(dir, "broker.sock") };
}

function startServer(socketPath, onMessage) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffer.slice(0, newlineIndex);
        const message = JSON.parse(line);
        onMessage(socket, message);
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

test("sendBrokerRecover sends broker/recover and parses a recovered:true reply", async () => {
  const { dir, socketPath } = makeSocketPath();
  let received = null;
  const server = await startServer(socketPath, (socket, message) => {
    received = message;
    socket.write(`${JSON.stringify({ id: message.id, result: { recovered: true, wasBusy: true } })}\n`);
  });

  try {
    const result = await sendBrokerRecover(`unix:${socketPath}`);
    assert.equal(result.recovered, true);
    assert.equal(received.method, "broker/recover");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendBrokerRecover forwards threadId and surfaces the owned flag", async () => {
  const { dir, socketPath } = makeSocketPath();
  let received = null;
  const server = await startServer(socketPath, (socket, message) => {
    received = message;
    // Emulate the broker declining because another job owns the slot.
    socket.write(`${JSON.stringify({ id: message.id, result: { recovered: false, owned: false, wasBusy: true } })}\n`);
  });

  try {
    const result = await sendBrokerRecover(`unix:${socketPath}`, { threadId: "thread-42" });
    assert.deepEqual(received.params, { threadId: "thread-42" });
    assert.equal(result.recovered, false);
    assert.equal(result.owned, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendBrokerRecover reports recovered:false when the broker says so", async () => {
  const { dir, socketPath } = makeSocketPath();
  const server = await startServer(socketPath, (socket, message) => {
    socket.write(`${JSON.stringify({ id: message.id, result: { recovered: false } })}\n`);
  });

  try {
    const result = await sendBrokerRecover(`unix:${socketPath}`);
    assert.equal(result.recovered, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendBrokerRecover returns recovered:false for a missing endpoint", async () => {
  const result = await sendBrokerRecover(null);
  assert.equal(result.recovered, false);
});

test("sendBrokerRecover times out instead of hanging on a silent broker", async () => {
  const { dir, socketPath } = makeSocketPath();
  // Server accepts the connection but never replies.
  const server = await startServer(socketPath, () => {});

  try {
    const result = await sendBrokerRecover(`unix:${socketPath}`, { timeoutMs: 50 });
    assert.equal(result.recovered, false);
    assert.match(result.detail ?? "", /timed out/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendBrokerRecover returns recovered:false when nothing is listening", async () => {
  const { dir, socketPath } = makeSocketPath();
  // No server started -> connection refused / ENOENT.
  const result = await sendBrokerRecover(`unix:${socketPath}`, { timeoutMs: 200 });
  assert.equal(result.recovered, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

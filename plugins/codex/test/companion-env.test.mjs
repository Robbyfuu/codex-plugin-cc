import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BROKER_ENDPOINT_ENV,
  FALLBACK_STATE_ROOT_DIR_NAME,
  LEGACY_ENV,
  PEER_ENV,
  PLUGIN_DATA_ENV,
  SESSION_ID_ENV,
  readCompanionEnv,
  readCompanionEnvFrom
} from "../scripts/lib/companion-env.mjs";
import { CodexAppServerClient } from "../scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../scripts/lib/broker-endpoint.mjs";
import { getSessionRuntimeStatus } from "../scripts/lib/codex.mjs";

test("companion env constants use peer names and keep legacy fallback names separate", () => {
  assert.equal(PLUGIN_DATA_ENV, "PEER_PLUGIN_DATA");
  assert.equal(SESSION_ID_ENV, "PEER_COMPANION_SESSION_ID");
  assert.equal(BROKER_ENDPOINT_ENV, "PEER_COMPANION_APP_SERVER_ENDPOINT");
  assert.equal(FALLBACK_STATE_ROOT_DIR_NAME, "peer-companion");

  assert.equal(PEER_ENV.PLUGIN_DATA, "PEER_PLUGIN_DATA");
  assert.equal(LEGACY_ENV.PLUGIN_DATA, "CLAUDE_PLUGIN_DATA");
  assert.equal(LEGACY_ENV.SESSION_ID, "CODEX_COMPANION_SESSION_ID");
});

test("readCompanionEnv prefers peer values over legacy fallbacks", () => {
  const env = {
    PEER_COMPANION_SESSION_ID: "peer-session",
    CODEX_COMPANION_SESSION_ID: "legacy-session"
  };
  assert.equal(readCompanionEnv("SESSION_ID", env), "peer-session");
});

test("readCompanionEnv preserves legacy fallback when peer value is absent", () => {
  const env = {
    CODEX_COMPANION_SESSION_ID: "legacy-session"
  };
  assert.equal(readCompanionEnv("SESSION_ID", env), "legacy-session");
});

test("readCompanionEnv treats an empty peer value as present", () => {
  const env = {
    PEER_COMPANION_SESSION_ID: "",
    CODEX_COMPANION_SESSION_ID: "legacy-session"
  };
  assert.equal(readCompanionEnv("SESSION_ID", env), "");
});

test("readCompanionEnvFrom checks injected env before process env", () => {
  const injected = {
    PEER_COMPANION_APP_SERVER_ENDPOINT: "unix:/peer.sock"
  };
  const ambient = {
    PEER_COMPANION_APP_SERVER_ENDPOINT: "unix:/ambient.sock"
  };
  assert.equal(readCompanionEnvFrom("BROKER_ENDPOINT", injected, ambient), "unix:/peer.sock");
});

test("readCompanionEnvFrom prefers ambient peer env over injected legacy fallback", () => {
  const injected = {
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/legacy.sock"
  };
  const ambient = {
    PEER_COMPANION_APP_SERVER_ENDPOINT: "unix:/peer.sock"
  };
  assert.equal(readCompanionEnvFrom("BROKER_ENDPOINT", injected, ambient), "unix:/peer.sock");
});

test("session runtime status prefers peer broker endpoint over legacy endpoint", () => {
  const report = getSessionRuntimeStatus(
    {
      PEER_COMPANION_APP_SERVER_ENDPOINT: "unix:/peer.sock",
      CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/legacy.sock"
    },
    "/workspace"
  );
  assert.equal(report.mode, "shared");
  assert.equal(report.endpoint, "unix:/peer.sock");
});

test("session runtime status preserves legacy broker endpoint fallback", () => {
  const report = getSessionRuntimeStatus(
    {
      CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/legacy.sock"
    },
    "/workspace"
  );
  assert.equal(report.mode, "shared");
  assert.equal(report.endpoint, "unix:/legacy.sock");
});


test("CodexAppServerClient.connect prefers peer broker endpoint over legacy endpoint", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-broker-precedence-"));
  const legacySessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-broker-precedence-"));
  const peerEndpoint = createBrokerEndpoint(sessionDir);
  const legacyEndpoint = createBrokerEndpoint(legacySessionDir);
  const listenPath = parseBrokerEndpoint(peerEndpoint).path;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPath, resolve);
  });

  let client;
  try {
    client = await CodexAppServerClient.connect(sessionDir, {
      env: {
        PEER_COMPANION_APP_SERVER_ENDPOINT: peerEndpoint,
        CODEX_COMPANION_APP_SERVER_ENDPOINT: legacyEndpoint
      }
    });

    assert.equal(client.transport, "broker");
    assert.equal(client.endpoint, peerEndpoint);
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(legacySessionDir, { recursive: true, force: true });
  }
});

test("CodexAppServerClient.connect does not use legacy broker endpoint when peer endpoint is empty", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-empty-broker-"));
  try {
    await assert.rejects(
      CodexAppServerClient.connect(workspaceDir, {
        reuseExistingBroker: true,
        env: {
          PEER_COMPANION_APP_SERVER_ENDPOINT: "",
          CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/legacy.sock"
        },
        spawnImpl() {
          throw new Error("direct spawn selected");
        }
      }),
      /direct spawn selected/
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

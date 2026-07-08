import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CodexAppServerClient,
  sanitizeCodexSpawnEnv
} from "../scripts/lib/app-server.mjs";
import { resolveAppServerRuntimeDir } from "../scripts/lib/state.mjs";

function makeFailingChild() {
  const child = new EventEmitter();
  child.pid = 4343;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = { write: () => {} };
  child.unref = () => {};
  child.kill = () => {};
  setImmediate(() => child.emit("error", new Error("fake spawn: no real codex")));
  return child;
}

test("direct app-server spawn uses codex-owned runtime cwd and scrubs repo-targeting git env", async () => {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "peer-plugin-data-"));
  const env = {
    CLAUDE_PLUGIN_DATA: pluginData,
    CODEX_HOME: "/homes/work",
    PATH: "/usr/bin",
    GIT_DIR: "/victim/.git",
    GIT_WORK_TREE: "/victim",
    GIT_COMMON_DIR: "/victim/.git",
    GIT_OBJECT_DIRECTORY: "/victim/.git/objects",
    GIT_INDEX_FILE: "/victim/.git/index",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: "/victim"
  };

  let capturedCwd = null;
  let capturedEnv = null;
  const spawnImpl = (_cmd, _args, options) => {
    capturedCwd = options.cwd;
    capturedEnv = options.env;
    return makeFailingChild();
  };

  await CodexAppServerClient.connect("/victim", {
    disableBroker: true,
    env,
    spawnImpl
  }).catch(() => {});

  assert.equal(capturedCwd, resolveAppServerRuntimeDir(env));
  assert.notEqual(capturedCwd, "/victim");
  assert.equal(fs.statSync(capturedCwd).mode & 0o777, 0o700);
  assert.equal(capturedEnv.CODEX_HOME, "/homes/work");
  assert.equal(capturedEnv.PATH, "/usr/bin");
  assert.equal("GIT_DIR" in capturedEnv, false);
  assert.equal("GIT_WORK_TREE" in capturedEnv, false);
  assert.equal("GIT_COMMON_DIR" in capturedEnv, false);
  assert.equal("GIT_OBJECT_DIRECTORY" in capturedEnv, false);
  assert.equal("GIT_INDEX_FILE" in capturedEnv, false);
  assert.equal(capturedEnv.GIT_CONFIG_COUNT, "1");
  assert.equal(capturedEnv.GIT_CONFIG_KEY_0, "core.logAllRefUpdates");
  assert.equal(capturedEnv.GIT_CONFIG_VALUE_0, "always");
});

test("sanitizeCodexSpawnEnv preserves normal env while removing git store overrides", () => {
  const sanitized = sanitizeCodexSpawnEnv({
    PATH: "/usr/bin",
    CODEX_HOME: "/homes/work",
    GIT_DIR: "/victim/.git",
    GIT_CONFIG_PARAMETERS: "x",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: "/victim",
    GIT_TERMINAL_PROMPT: "0"
  });

  assert.equal(sanitized.PATH, "/usr/bin");
  assert.equal(sanitized.CODEX_HOME, "/homes/work");
  assert.equal(sanitized.GIT_TERMINAL_PROMPT, "0");
  assert.equal("GIT_DIR" in sanitized, false);
  assert.equal("GIT_CONFIG_PARAMETERS" in sanitized, false);
  assert.equal(sanitized.GIT_CONFIG_COUNT, "1");
  assert.equal(sanitized.GIT_CONFIG_KEY_0, "core.logAllRefUpdates");
  assert.equal(sanitized.GIT_CONFIG_VALUE_0, "always");
});

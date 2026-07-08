import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureAppServerRuntimeDir,
  ensureStateDir,
  resolveAppServerRuntimeDir,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/codex/scripts/lib/state.mjs";

function withPluginDataEnv(values, fn) {
  const previousPeerPluginData = process.env.PEER_PLUGIN_DATA;
  const previousLegacyPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    for (const name of ["PEER_PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"]) {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        process.env[name] = values[name];
      } else {
        delete process.env[name];
      }
    }
    return fn();
  } finally {
    if (previousPeerPluginData == null) {
      delete process.env.PEER_PLUGIN_DATA;
    } else {
      process.env.PEER_PLUGIN_DATA = previousPeerPluginData;
    }
    if (previousLegacyPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousLegacyPluginData;
    }
  }
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  // This test asserts the FALLBACK state root (under os.tmpdir()), which only
  // applies when both PEER_PLUGIN_DATA and legacy CLAUDE_PLUGIN_DATA are unset.
  // Isolate from any ambient value so the test is deterministic regardless of
  // the runner's environment.
  withPluginDataEnv({}, () => {
    const workspace = makeTempDir();
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(stateDir, /peer-companion/);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("resolveStateDir falls back to legacy CLAUDE_PLUGIN_DATA when PEER_PLUGIN_DATA is absent", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  withPluginDataEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, () => {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  });
});

test("resolveStateDir prefers PEER_PLUGIN_DATA over legacy CLAUDE_PLUGIN_DATA", () => {
  const workspace = makeTempDir();
  const peerPluginDataDir = makeTempDir();
  const legacyPluginDataDir = makeTempDir();

  withPluginDataEnv({ PEER_PLUGIN_DATA: peerPluginDataDir, CLAUDE_PLUGIN_DATA: legacyPluginDataDir }, () => {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(peerPluginDataDir, "state")), true);
    assert.equal(stateDir.startsWith(path.join(legacyPluginDataDir, "state")), false);
  });
});

test("resolveStateDir does not fall back to legacy CLAUDE_PLUGIN_DATA when PEER_PLUGIN_DATA is empty", () => {
  const workspace = makeTempDir();
  const legacyPluginDataDir = makeTempDir();

  withPluginDataEnv({ PEER_PLUGIN_DATA: "", CLAUDE_PLUGIN_DATA: legacyPluginDataDir }, () => {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(legacyPluginDataDir, "state")), false);
    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(stateDir, /peer-companion/);
  });
});

test("ensureStateDir creates the state dir with owner-only (0700) mode", { skip: process.platform === "win32" ? "POSIX-only mode bits" : false }, () => {
  // Use an explicit PEER_PLUGIN_DATA root so the assertion is deterministic
  // regardless of the runner's umask on the shared os.tmpdir() fallback.
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  withPluginDataEnv({ PEER_PLUGIN_DATA: pluginDataDir }, () => {
    ensureStateDir(workspace);
    const stateDir = resolveStateDir(workspace);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  });
});

test("ensureAppServerRuntimeDir creates a codex-owned runtime outside per-workspace state", { skip: process.platform === "win32" ? "POSIX-only mode bits" : false }, () => {
  const pluginDataDir = makeTempDir();
  const env = { PEER_PLUGIN_DATA: pluginDataDir };

  const runtimeDir = ensureAppServerRuntimeDir(env);

  assert.equal(runtimeDir, resolveAppServerRuntimeDir(env));
  assert.equal(runtimeDir.startsWith(path.join(pluginDataDir, "runtime")), true);
  assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveJobFile, upsertJob, writeJobFile } from "../scripts/lib/state.mjs";

/**
 * Plan 003 (adversarial follow-up): the `/peer:cancel` terminal write must scrub
 * the verbatim `request.prompt` like the other three terminal sites. `cancelled`
 * is a NON-resumable terminal status (render.mjs RESUMABLE_TERMINAL_STATUSES =
 * {failed, interrupted}), so retaining the prompt is a pure cleartext leak with
 * no functional benefit.
 *
 * This drives the REAL cancel command end-to-end through the CLI entrypoint
 * (`codex-companion.mjs cancel <id>`), against a seeded QUEUED job that has no
 * live worker pid and no Codex threadId. That makes the cancel fully offline:
 * interruptAppServerTurn short-circuits (no threadId/turnId), terminateProcessTree
 * is a no-op (pid null), and broker recovery is skipped (guarded on
 * status === "running"). What remains is exactly the persisted cancel write.
 */

const COMPANION_PATH = fileURLToPath(new URL("../scripts/codex-companion.mjs", import.meta.url));

function withTempWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cancel-scrub-"));
  const workspaceRoot = path.join(root, "repo");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  return Promise.resolve(run({ workspaceRoot, pluginData })).finally(() => {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function runCancel(workspaceRoot, jobId, pluginData) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [COMPANION_PATH, "cancel", jobId, "--cwd", workspaceRoot, "--json"],
      {
        cwd: workspaceRoot,
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cancel command hung; stderr: ${stderr}`));
    }, 8000);
    guard.unref?.();
    child.on("exit", (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
  });
}

test("/peer:cancel scrubs request.prompt from the cancelled record but keeps the rest of request", async () => {
  await withTempWorkspace(async ({ workspaceRoot, pluginData }) => {
    const jobId = "task-cancel-scrub";
    const record = {
      id: jobId,
      kind: "task",
      kindLabel: "rescue",
      jobClass: "task",
      title: "Codex Task",
      workspaceRoot,
      status: "queued",
      phase: "queued",
      pid: null,
      summary: "do a thing",
      logFile: null,
      request: {
        cwd: workspaceRoot,
        model: "gpt-5",
        effort: "high",
        prompt: "FULL PROMPT WITH A SECRET sk-abcdEFGH1234567890",
        write: true,
        jobId
      }
    };
    // Seed BOTH the job file and the state index so resolveCancelableJob (which
    // reads through listJobs/state.json) can find this job by id.
    writeJobFile(workspaceRoot, jobId, record);
    upsertJob(workspaceRoot, record);

    const { code, stderr } = await runCancel(workspaceRoot, jobId, pluginData);
    assert.equal(code, 0, `cancel should exit 0; stderr: ${stderr}`);

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, jobId), "utf8"));
    assert.equal(stored.status, "cancelled", "the job is cancelled");
    assert.equal(stored.request.prompt, undefined, "the cancelled record must NOT retain the verbatim prompt");
    assert.equal(stored.request.cwd, workspaceRoot, "cwd survives (preserved request field)");
    assert.equal(stored.request.model, "gpt-5", "model survives (preserved request field)");
    assert.equal(stored.request.effort, "high", "effort survives (preserved request field)");
    assert.equal(stored.request.write, true, "write flag survives (preserved request field)");
  });
});

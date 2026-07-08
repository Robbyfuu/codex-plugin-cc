import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const trackedTempDirs = new Set();

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.add(dir);
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readProcesses() {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("ps", ["-axo", "pid,ppid,command"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]
      };
    })
    .filter(Boolean);
}

function isTrackedFakeCodexProcess(command) {
  for (const dir of trackedTempDirs) {
    if (command.includes(`${path.join(dir, "codex")} app-server`)) {
      return true;
    }
  }
  return false;
}

export function cleanupTrackedCodexProcesses() {
  if (process.platform === "win32") {
    return { brokerPids: [], fakePids: [], remainingFakePids: [] };
  }

  const processes = readProcesses();
  const fakeProcesses = processes.filter((entry) => isTrackedFakeCodexProcess(entry.command));
  const fakePids = [...new Set(fakeProcesses.map((entry) => entry.pid))];
  const brokerPids = [
    ...new Set(
      fakeProcesses
        .map((entry) => entry.ppid)
        .filter((pid) => pid > 1)
        .filter((pid) => processes.some((entry) => entry.pid === pid && entry.command.includes(BROKER_SCRIPT)))
    )
  ];

  for (const pid of brokerPids) {
    try {
      terminateProcessTree(pid);
    } catch {
      // Best-effort test cleanup; the remaining exact fake pids are handled below.
    }
  }

  sleepSync(250);

  const afterGroupTerm = readProcesses();
  const remainingFakePids = afterGroupTerm
    .filter((entry) => isTrackedFakeCodexProcess(entry.command))
    .map((entry) => entry.pid);
  const remainingBrokerPids = brokerPids.filter((pid) =>
    afterGroupTerm.some((entry) => entry.pid === pid && entry.command.includes(BROKER_SCRIPT))
  );

  for (const pid of [...remainingFakePids, ...remainingBrokerPids]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  sleepSync(100);

  return {
    brokerPids,
    fakePids,
    remainingFakePids: readProcesses()
      .filter((entry) => isTrackedFakeCodexProcess(entry.command))
      .map((entry) => entry.pid)
  };
}

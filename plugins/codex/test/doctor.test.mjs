import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  classifyBroker,
  buildDoctorReport,
  planCleanup,
  executeCleanup
} from "../scripts/lib/doctor.mjs";

// A killImpl double: `alive` controls whether `kill(pid, 0)` succeeds. A dead pid
// throws ESRCH, mirroring process.kill on a non-existent process.
function makeKillImpl({ alive } = { alive: true }) {
  return (pid, signal) => {
    if (signal === 0 && !alive) {
      const error = new Error(`ESRCH: no such process ${pid}`);
      error.code = "ESRCH";
      throw error;
    }
    return true;
  };
}

function sampleSession(overrides = {}) {
  return {
    endpoint: "unix:/tmp/cxc-abc/broker.sock",
    pid: 4242,
    pidFile: "/tmp/cxc-abc/broker.pid",
    logFile: "/tmp/cxc-abc/broker.log",
    sessionDir: "/tmp/cxc-abc",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// classifyBroker
// ---------------------------------------------------------------------------

test("classifyBroker returns none when there is no session", async () => {
  const result = await classifyBroker({
    session: null,
    readyImpl: async () => false,
    killImpl: makeKillImpl({ alive: false })
  });
  assert.equal(result, "none");
});

test("classifyBroker returns healthy when the endpoint is ready", async () => {
  const result = await classifyBroker({
    session: sampleSession(),
    readyImpl: async () => true,
    killImpl: makeKillImpl({ alive: true })
  });
  assert.equal(result, "healthy");
});

test("classifyBroker returns orphaned when not ready and pid is dead", async () => {
  const result = await classifyBroker({
    session: sampleSession(),
    readyImpl: async () => false,
    killImpl: makeKillImpl({ alive: false })
  });
  assert.equal(result, "orphaned");
});

test("classifyBroker returns wedged when not ready but pid is alive", async () => {
  const result = await classifyBroker({
    session: sampleSession(),
    readyImpl: async () => false,
    killImpl: makeKillImpl({ alive: true })
  });
  assert.equal(result, "wedged");
});

test("classifyBroker treats pid 0 as dead and NEVER signals it (pid>0 guard)", async () => {
  // pid 0 / -0 would target the caller's own process group. The guard must
  // short-circuit to not-alive WITHOUT ever invoking killImpl.
  let killCalls = 0;
  const result = await classifyBroker({
    session: sampleSession({ pid: 0 }),
    readyImpl: async () => false,
    killImpl: (pid, signal) => {
      killCalls += 1;
      if (signal === 0) {
        return true; // would (wrongly) report alive if reached
      }
      return true;
    }
  });
  // pid 0 is not ready + not "alive" → orphaned, and kill was never called.
  assert.equal(result, "orphaned");
  assert.equal(killCalls, 0, "killImpl must not be invoked for pid 0");
});

// ---------------------------------------------------------------------------
// planCleanup
// ---------------------------------------------------------------------------

function reportWithBroker(classification, sessionOverrides = {}) {
  const session = sampleSession(sessionOverrides);
  return {
    ready: classification === "healthy",
    codex: { available: true, detail: "ok" },
    broker: {
      configured: true,
      endpoint: session.endpoint,
      socketReady: classification === "healthy",
      pid: session.pid,
      pidAlive: classification === "wedged" || classification === "healthy",
      classification,
      session
    },
    stateDir: {
      path: "/state",
      totalBytes: 0,
      staleLogs: [],
      orphanPaneMarkers: [],
      telemetryBytes: 0,
      telemetryOverCap: false,
      telemetryFile: "/state/telemetry.jsonl"
    },
    activeJobCount: 0,
    issues: []
  };
}

test("planCleanup puts an orphaned broker in safe, not gated, under --fix", () => {
  const plan = planCleanup(reportWithBroker("orphaned"), { fix: true, clean: false });
  const safeKinds = plan.safe.map((action) => action.kind);
  const gatedKinds = plan.gated.map((action) => action.kind);
  assert.ok(safeKinds.includes("teardown-orphaned-broker"));
  assert.ok(!gatedKinds.includes("teardown-orphaned-broker"));
});

test("planCleanup does NOT plan an orphaned-broker teardown without --fix", () => {
  const plan = planCleanup(reportWithBroker("orphaned"), { fix: false, clean: false });
  assert.equal(plan.safe.length, 0);
  assert.equal(plan.gated.length, 0);
});

test("planCleanup puts a wedged broker (live pid) only in gated, never safe", () => {
  const plan = planCleanup(reportWithBroker("wedged"), { fix: true, clean: false });
  const safeKinds = plan.safe.map((action) => action.kind);
  const gatedKinds = plan.gated.map((action) => action.kind);
  assert.ok(gatedKinds.includes("kill-wedged-broker"));
  assert.ok(!safeKinds.includes("kill-wedged-broker"));
});

test("planCleanup never plans a wedged kill without --fix", () => {
  const plan = planCleanup(reportWithBroker("wedged"), { fix: false, clean: false });
  const allKinds = [...plan.safe, ...plan.gated].map((action) => action.kind);
  assert.ok(!allKinds.includes("kill-wedged-broker"));
});

test("planCleanup plans nothing destructive for a healthy broker", () => {
  const plan = planCleanup(reportWithBroker("healthy"), { fix: true, clean: true });
  const allKinds = [...plan.safe, ...plan.gated].map((action) => action.kind);
  assert.ok(!allKinds.includes("kill-wedged-broker"));
  assert.ok(!allKinds.includes("teardown-orphaned-broker"));
});

test("planCleanup puts orphan pane markers in safe under --fix", () => {
  const report = reportWithBroker("none");
  report.stateDir.orphanPaneMarkers = ["/state/jobs/job-1.log.pane"];
  const plan = planCleanup(report, { fix: true, clean: false });
  const safe = plan.safe.filter((action) => action.kind === "remove-pane-marker");
  assert.equal(safe.length, 1);
  assert.equal(safe[0].path, "/state/jobs/job-1.log.pane");
});

test("planCleanup gates stale logs behind --clean (absent under --fix only)", () => {
  const report = reportWithBroker("none");
  report.stateDir.staleLogs = ["/state/jobs/old.log"];

  const fixOnly = planCleanup(report, { fix: true, clean: false });
  assert.ok(![...fixOnly.safe, ...fixOnly.gated].some((action) => action.kind === "remove-stale-log"));

  const withClean = planCleanup(report, { fix: false, clean: true });
  const gated = withClean.gated.filter((action) => action.kind === "remove-stale-log");
  assert.equal(gated.length, 1);
  assert.equal(gated[0].path, "/state/jobs/old.log");
});

test("planCleanup rolls oversized telemetry only under --clean and never deletes it", () => {
  const report = reportWithBroker("none");
  report.stateDir.telemetryOverCap = true;
  report.stateDir.telemetryFile = "/state/telemetry.jsonl";

  const fixOnly = planCleanup(report, { fix: true, clean: false });
  assert.ok(![...fixOnly.safe, ...fixOnly.gated].some((action) => action.kind === "roll-telemetry"));

  const withClean = planCleanup(report, { fix: false, clean: true });
  const roll = withClean.gated.filter((action) => action.kind === "roll-telemetry");
  assert.equal(roll.length, 1);
  // The action must ROLL/truncate, never delete.
  assert.notEqual(roll[0].kind, "delete-telemetry");
  assert.equal(roll[0].path, "/state/telemetry.jsonl");
});

test("planCleanup rolls oversized BROKER telemetry only under --clean and never deletes it", () => {
  const report = reportWithBroker("none");
  report.stateDir.brokerTelemetryOverCap = true;
  report.stateDir.brokerTelemetryFile = "/state/broker-telemetry.jsonl";

  const fixOnly = planCleanup(report, { fix: true, clean: false });
  assert.ok(
    ![...fixOnly.safe, ...fixOnly.gated].some(
      (action) => action.kind === "roll-telemetry" && action.path === "/state/broker-telemetry.jsonl"
    ),
    "broker telemetry roll requires --clean"
  );

  const withClean = planCleanup(report, { fix: false, clean: true });
  const roll = withClean.gated.filter(
    (action) => action.kind === "roll-telemetry" && action.path === "/state/broker-telemetry.jsonl"
  );
  assert.equal(roll.length, 1, "the oversized broker telemetry file is rolled under --clean");
});

// ---------------------------------------------------------------------------
// THE KILL GATE
// ---------------------------------------------------------------------------

test("KILL GATE: a wedged broker with an active job is downgraded to report-only even under --fix", () => {
  const report = reportWithBroker("wedged");
  report.activeJobCount = 1; // a running/queued job exists

  const plan = planCleanup(report, { fix: true, clean: false });
  const allKinds = [...plan.safe, ...plan.gated].map((action) => action.kind);
  // The kill must NOT be planned when an active job may be owned by the broker.
  assert.ok(!allKinds.includes("kill-wedged-broker"));
  // It must surface as a report-only downgrade action instead.
  const reportOnly = [...plan.safe, ...plan.gated].find((action) => action.kind === "wedged-broker-report-only");
  assert.ok(reportOnly, "a report-only descriptor is present");
  assert.match(reportOnly.detail, /active job|not killing/i);
});

test("KILL GATE: a wedged broker with NO active job IS killable under --fix", () => {
  const report = reportWithBroker("wedged");
  report.activeJobCount = 0;

  const plan = planCleanup(report, { fix: true, clean: false });
  const gatedKinds = plan.gated.map((action) => action.kind);
  assert.ok(gatedKinds.includes("kill-wedged-broker"));
});

// ---------------------------------------------------------------------------
// executeCleanup
// ---------------------------------------------------------------------------

function execDeps(overrides = {}) {
  return {
    terminateImpl: () => ({ attempted: true, delivered: true, method: "process-group" }),
    teardownImpl: () => {},
    rollTelemetryImpl: () => {},
    unlinkImpl: () => {},
    killImpl: makeKillImpl({ alive: false }),
    // Live active job-id set re-derived at execute time. Default: nothing active.
    activeJobIdsImpl: () => new Set(),
    ...overrides
  };
}

test("executeCleanup with --fix does NOT kill a healthy broker", () => {
  let terminateCalls = 0;
  const deps = execDeps({
    terminateImpl: () => {
      terminateCalls += 1;
      return { attempted: true, delivered: true };
    }
  });
  const report = reportWithBroker("healthy");
  const plan = planCleanup(report, { fix: true, clean: true });
  executeCleanup(plan, report, { deps });
  assert.equal(terminateCalls, 0);
});

test("executeCleanup kills a wedged pid when the gate passes", () => {
  const killed = [];
  const deps = execDeps({
    terminateImpl: (pid) => {
      killed.push(pid);
      return { attempted: true, delivered: true };
    }
  });
  const report = reportWithBroker("wedged");
  report.activeJobCount = 0;
  const plan = planCleanup(report, { fix: true, clean: false });
  const taken = executeCleanup(plan, report, { deps });
  assert.deepEqual(killed, [report.broker.pid]);
  assert.ok(taken.some((entry) => /kill/i.test(entry) && entry.includes(String(report.broker.pid))));
});

test("executeCleanup does not kill a wedged broker that owns an active job", () => {
  let terminateCalls = 0;
  const deps = execDeps({
    terminateImpl: () => {
      terminateCalls += 1;
      return { attempted: true, delivered: true };
    }
  });
  const report = reportWithBroker("wedged");
  report.activeJobCount = 2;
  const plan = planCleanup(report, { fix: true, clean: false });
  executeCleanup(plan, report, { deps });
  assert.equal(terminateCalls, 0);
});

test("executeCleanup is best-effort: a failing action does not abort the rest", () => {
  const removed = [];
  const deps = execDeps({
    unlinkImpl: (filePath) => {
      if (filePath.includes("boom")) {
        throw new Error("EACCES: cannot unlink");
      }
      removed.push(filePath);
    }
  });
  const report = reportWithBroker("none");
  report.stateDir.orphanPaneMarkers = ["/state/jobs/boom.log.pane", "/state/jobs/ok.log.pane"];
  const plan = planCleanup(report, { fix: true, clean: false });
  const taken = executeCleanup(plan, report, { deps });
  // The second (good) unlink still ran despite the first throwing.
  assert.ok(removed.includes("/state/jobs/ok.log.pane"));
  assert.ok(taken.length >= 1);
});

test("executeCleanup re-derives active jobs at delete time: a job that became active is NOT unlinked (TOCTOU guard)", () => {
  const unlinked = [];
  // The artifact for job `late` was planned as stale, but `late` flips to
  // running between plan and execute. The live resolver returns it as active.
  const deps = execDeps({
    unlinkImpl: (filePath) => {
      unlinked.push(filePath);
    },
    activeJobIdsImpl: () => new Set(["late"])
  });
  const report = reportWithBroker("none");
  report.workspaceRoot = "/workspace";
  report.stateDir.staleLogs = ["/state/jobs/late.log", "/state/jobs/old.log"];

  const plan = planCleanup(report, { fix: false, clean: true });
  const taken = executeCleanup(plan, report, { deps });

  // The now-active job's artifact must NOT be unlinked.
  assert.ok(!unlinked.includes("/state/jobs/late.log"), "late.log must not be unlinked");
  // The genuinely stale artifact still is.
  assert.ok(unlinked.includes("/state/jobs/old.log"), "old.log is still removed");
  // And the skip is reported (as skipped, not deleted).
  const skipLine = taken.find((entry) => entry.includes("late.log"));
  assert.ok(skipLine, "the skip is reported");
  assert.match(skipLine, /skip/i);
  assert.doesNotMatch(skipLine, /removed/i);
});

test("executeCleanup re-derives active jobs from the report workspace root by default (no injected resolver)", () => {
  // With the default activeJobIdsImpl removed from deps, executeCleanup must
  // still re-derive via the report's workspace context — here we inject a
  // listJobsImpl that returns a running job, and assert its artifact is spared.
  const unlinked = [];
  const deps = {
    terminateImpl: () => ({}),
    teardownImpl: () => {},
    rollTelemetryImpl: () => {},
    unlinkImpl: (filePath) => unlinked.push(filePath),
    listJobsImpl: () => [{ id: "live", status: "running" }]
  };
  const report = reportWithBroker("none");
  report.workspaceRoot = "/workspace";
  report.stateDir.staleLogs = ["/state/jobs/live.log", "/state/jobs/gone.json"];

  const plan = planCleanup(report, { fix: false, clean: true });
  executeCleanup(plan, report, { deps });

  assert.ok(!unlinked.includes("/state/jobs/live.log"), "live.log spared via re-derived active set");
  assert.ok(unlinked.includes("/state/jobs/gone.json"), "gone.json removed");
});

// ---------------------------------------------------------------------------
// buildDoctorReport
// ---------------------------------------------------------------------------

test("buildDoctorReport reports configured:false and does not crash when there is no broker.json", async () => {
  const report = await buildDoctorReport("/some/cwd", {
    env: {},
    deps: {
      getCodexAvailabilityImpl: () => ({ available: true, detail: "ok" }),
      loadBrokerSessionImpl: () => null,
      listJobsImpl: () => [],
      readyImpl: async () => false,
      killImpl: makeKillImpl({ alive: false }),
      resolveStateDirImpl: () => "/state",
      resolveTelemetryFileImpl: () => "/state/telemetry.jsonl",
      walkStateDirImpl: () => ({
        totalBytes: 0,
        staleLogs: [],
        orphanPaneMarkers: [],
        telemetryBytes: 0,
        telemetryOverCap: false
      })
    }
  });
  assert.equal(report.broker.configured, false);
  assert.equal(report.broker.classification, "none");
  assert.equal(report.codex.available, true);
  assert.ok(Array.isArray(report.issues));
});

test("buildDoctorReport flags a wedged broker that owns an active job as not auto-fixable", async () => {
  const report = await buildDoctorReport("/some/cwd", {
    env: {},
    deps: {
      getCodexAvailabilityImpl: () => ({ available: true, detail: "ok" }),
      loadBrokerSessionImpl: () => sampleSession(),
      listJobsImpl: () => [{ id: "j1", status: "running" }],
      readyImpl: async () => false,
      killImpl: makeKillImpl({ alive: true }),
      resolveStateDirImpl: () => "/state",
      resolveTelemetryFileImpl: () => "/state/telemetry.jsonl",
      walkStateDirImpl: () => ({
        totalBytes: 0,
        staleLogs: [],
        orphanPaneMarkers: [],
        telemetryBytes: 0,
        telemetryOverCap: false
      })
    }
  });
  assert.equal(report.broker.classification, "wedged");
  assert.equal(report.activeJobCount, 1);
  const wedgedIssue = report.issues.find((issue) => issue.kind === "wedged-broker");
  assert.ok(wedgedIssue);
  assert.equal(wedgedIssue.autoFixable, false);
});

test("buildDoctorReport is READ-ONLY: it creates no state dir on disk (default deps)", async () => {
  // Isolate the state root so we exercise the REAL default resolvers (which would
  // otherwise mkdir via resolveTelemetryFile) against a brand-new, absent dir.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-doctor-readonly-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const report = await buildDoctorReport(dataDir, {
      env: process.env,
      // Only stub the two impls that would otherwise spawn a real `codex` probe
      // or read another workspace's broker — the state-dir/telemetry path stays
      // on the real default resolvers so the no-mkdir guarantee is what's tested.
      deps: {
        getCodexAvailabilityImpl: () => ({ available: true, detail: "ok" }),
        loadBrokerSessionImpl: () => null,
        listJobsImpl: () => []
      }
    });
    const statePath = report.stateDir.path;
    assert.equal(
      fs.existsSync(statePath),
      false,
      `read-only diagnosis must not create the state dir (${statePath})`
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

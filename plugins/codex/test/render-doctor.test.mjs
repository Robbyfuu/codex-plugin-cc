import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDoctorReport } from "../scripts/lib/render.mjs";

function sampleReport(overrides = {}) {
  return {
    ready: true,
    codex: { available: true, detail: "codex 1.2.3; advanced runtime available" },
    broker: {
      configured: true,
      endpoint: "unix:/tmp/cxc-abc/broker.sock",
      socketReady: true,
      pid: 4242,
      pidAlive: true,
      classification: "healthy"
    },
    stateDir: {
      path: "/state",
      totalBytes: 2048,
      staleLogs: [],
      orphanPaneMarkers: [],
      telemetryBytes: 1024,
      telemetryOverCap: false,
      telemetryFile: "/state/telemetry.jsonl"
    },
    activeJobCount: 0,
    issues: [],
    ...overrides
  };
}

test("renderDoctorReport shows a Codex Doctor heading and overall status", () => {
  const output = renderDoctorReport(sampleReport());
  assert.match(output, /# Codex Doctor/);
  assert.match(output, /healthy|ready/i);
});

test("renderDoctorReport surfaces broker classification and codex detail", () => {
  const output = renderDoctorReport(sampleReport());
  assert.match(output, /healthy/);
  assert.match(output, /advanced runtime available/);
});

test("renderDoctorReport lists issues with their detail", () => {
  const output = renderDoctorReport(
    sampleReport({
      ready: false,
      issues: [
        { kind: "orphaned-broker", severity: "medium", detail: "stale broker session", autoFixable: true }
      ]
    })
  );
  assert.match(output, /orphaned-broker/);
  assert.match(output, /stale broker session/);
});

test("renderDoctorReport prints planned actions verbatim when present", () => {
  const output = renderDoctorReport(
    sampleReport({
      plannedActions: {
        safe: [{ kind: "remove-pane-marker", detail: "Remove stale pane marker /state/jobs/x.log.pane." }],
        gated: [{ kind: "kill-wedged-broker", detail: "Kill wedged broker pid 4242 and tear down its session." }]
      }
    })
  );
  assert.match(output, /Remove stale pane marker \/state\/jobs\/x\.log\.pane\./);
  assert.match(output, /Kill wedged broker pid 4242/);
});

test("renderDoctorReport prints actions taken verbatim", () => {
  const output = renderDoctorReport(
    sampleReport({
      actionsTaken: ["Killed wedged broker pid 4242 and tore down its session."]
    })
  );
  assert.match(output, /Killed wedged broker pid 4242/);
});

test("renderDoctorReport surfaces the wedged active-job downgrade message", () => {
  const output = renderDoctorReport(
    sampleReport({
      ready: false,
      broker: {
        configured: true,
        endpoint: "unix:/tmp/x/broker.sock",
        socketReady: false,
        pid: 99,
        pidAlive: true,
        classification: "wedged"
      },
      activeJobCount: 1,
      plannedActions: {
        safe: [],
        gated: [
          {
            kind: "wedged-broker-report-only",
            detail: "Broker pid 99 is wedged but 1 active job(s) exist; it may be serving an active job, so it is NOT being killed."
          }
        ]
      }
    })
  );
  assert.match(output, /NOT being killed|may be serving an active job/i);
});

test("renderDoctorReport ends with a single trailing newline", () => {
  const output = renderDoctorReport(sampleReport());
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.endsWith("\n\n"), false);
});

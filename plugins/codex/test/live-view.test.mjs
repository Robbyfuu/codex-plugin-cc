import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTmuxSplitArgs,
  isWatchPaneEnabled,
  openWatchPane,
  resolvePaneMarkerFile
} from "../scripts/lib/live-view.mjs";

function fakeChild() {
  return { on() {}, unref() {} };
}

test("isWatchPaneEnabled defaults to enabled when TMUX is set", () => {
  assert.equal(isWatchPaneEnabled({ TMUX: "/tmp/tmux-1000/default,1,0" }), true);
});

test("isWatchPaneEnabled is disabled when TMUX is absent", () => {
  assert.equal(isWatchPaneEnabled({}), false);
});

test("isWatchPaneEnabled respects an explicit disable knob", () => {
  for (const value of ["0", "false", "off", "no"]) {
    assert.equal(
      isWatchPaneEnabled({ TMUX: "x", CODEX_COMPANION_WATCH_PANE: value }),
      false,
      `watch pane should be disabled for ${value}`
    );
  }
});

test("isWatchPaneEnabled respects an explicit enable knob even outside tmux", () => {
  assert.equal(isWatchPaneEnabled({ CODEX_COMPANION_WATCH_PANE: "1" }), true);
  assert.equal(isWatchPaneEnabled({ CODEX_COMPANION_WATCH_PANE: "true" }), true);
});

test("buildTmuxSplitArgs builds a detached tail -F command for the log path", () => {
  const args = buildTmuxSplitArgs("/state/jobs/job-1.log");
  assert.deepEqual(args, ["split-window", "-d", "tail -F '/state/jobs/job-1.log'"]);
});

test("buildTmuxSplitArgs single-quotes paths safely", () => {
  const args = buildTmuxSplitArgs("/state/jobs/it's a job.log");
  assert.equal(args[0], "split-window");
  assert.equal(args[1], "-d");
  assert.equal(args[2], "tail -F '/state/jobs/it'\\''s a job.log'");
});

test("resolvePaneMarkerFile derives a stable sibling marker next to the log", () => {
  const marker = resolvePaneMarkerFile("/state/jobs/job-1.log");
  assert.equal(marker, "/state/jobs/job-1.log.pane");
});

test("openWatchPane spawns tmux and writes the marker on first call", () => {
  const spawned = [];
  const markers = [];
  const result = openWatchPane("/state/jobs/job-1.log", {
    env: { TMUX: "x" },
    spawnImpl: (cmd, args) => {
      spawned.push({ cmd, args });
      return fakeChild();
    },
    existsSyncImpl: () => false,
    writeMarkerImpl: (file) => markers.push(file)
  });

  assert.deepEqual(result, { opened: true });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "tmux");
  assert.deepEqual(spawned[0].args, ["split-window", "-d", "tail -F '/state/jobs/job-1.log'"]);
  assert.deepEqual(markers, ["/state/jobs/job-1.log.pane"]);
});

test("openWatchPane is a no-op when the marker already exists (guard)", () => {
  let spawnCalls = 0;
  const result = openWatchPane("/state/jobs/job-1.log", {
    env: { TMUX: "x" },
    spawnImpl: () => {
      spawnCalls += 1;
      return fakeChild();
    },
    existsSyncImpl: () => true,
    writeMarkerImpl: () => {}
  });

  assert.equal(result.opened, false);
  assert.equal(result.reason, "already-open");
  assert.equal(spawnCalls, 0, "must not spawn a duplicate pane");
});

test("openWatchPane force-opens even when the marker exists", () => {
  let spawnCalls = 0;
  const result = openWatchPane("/state/jobs/job-1.log", {
    env: { TMUX: "x" },
    force: true,
    spawnImpl: () => {
      spawnCalls += 1;
      return fakeChild();
    },
    existsSyncImpl: () => true,
    writeMarkerImpl: () => {}
  });

  assert.equal(result.opened, true);
  assert.equal(spawnCalls, 1);
});

test("openWatchPane is disabled when watch panes are off", () => {
  let spawnCalls = 0;
  const result = openWatchPane("/state/jobs/job-1.log", {
    env: {},
    spawnImpl: () => {
      spawnCalls += 1;
      return fakeChild();
    },
    existsSyncImpl: () => false,
    writeMarkerImpl: () => {}
  });

  assert.equal(result.opened, false);
  assert.equal(result.reason, "disabled");
  assert.equal(spawnCalls, 0);
});

test("openWatchPane returns no-log-file when given no path", () => {
  const result = openWatchPane(null, { env: { TMUX: "x" } });
  assert.equal(result.opened, false);
  assert.equal(result.reason, "no-log-file");
});

test("openWatchPane swallows spawn failures", () => {
  const result = openWatchPane("/state/jobs/job-1.log", {
    env: { TMUX: "x" },
    spawnImpl: () => {
      throw new Error("tmux not found");
    },
    existsSyncImpl: () => false,
    writeMarkerImpl: () => {}
  });
  assert.equal(result.opened, false);
  assert.equal(result.reason, "spawn-failed");
});

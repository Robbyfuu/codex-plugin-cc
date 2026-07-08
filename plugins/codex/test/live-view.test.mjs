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
  assert.equal(isWatchPaneEnabled({ PEER_COMPANION_WATCH_PANE: "1" }), true);
  assert.equal(isWatchPaneEnabled({ PEER_COMPANION_WATCH_PANE: "true" }), true);
});

test("isWatchPaneEnabled prefers peer knob over legacy watch-pane setting", () => {
  assert.equal(
    isWatchPaneEnabled({
      TMUX: "x",
      PEER_COMPANION_WATCH_PANE: "1",
      CODEX_COMPANION_WATCH_PANE: "0"
    }),
    true
  );
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

test("buildTmuxSplitArgs keeps a metacharacter/quote-laden path inert under sh -c", () => {
  // The command string is executed by tmux via `sh -c`, so any shell
  // metacharacter that escaped the single-quoted span would be interpreted.
  // This hostile path packs a command substitution, a sequencing operator, a
  // pipe, a redirect, a backtick, a glob, and an embedded single quote — the
  // single quote is the only character that can terminate the quoted span, so
  // it must be escaped as '\'' and everything else must stay literal.
  const hostile = "/tmp/jobs/x'; rm -rf ~ #`touch pwned`$(id)|cat>/etc/passwd &*.log";
  const args = buildTmuxSplitArgs(hostile);

  assert.equal(args[0], "split-window");
  assert.equal(args[1], "-d");

  // The whole path is wrapped in a single-quoted span; every embedded single
  // quote becomes the literal escape sequence '\'' and no metacharacter leaks.
  const expectedQuoted = "'" + hostile.replace(/'/g, "'\\''") + "'";
  assert.equal(args[2], `tail -F ${expectedQuoted}`);

  // Structural guarantee: emulate how a POSIX shell unquotes the payload and
  // assert it collapses to exactly the original path as a SINGLE literal word.
  // Inside a single-quoted span every byte is literal; the span ends only at a
  // lone `'`. Walking that grammar over the produced string must reproduce the
  // original path with zero shell-interpretable bytes left exposed to `sh -c`.
  const payload = args[2].slice("tail -F ".length);
  let unquoted = "";
  let i = 0;
  let inQuotes = false;
  while (i < payload.length) {
    const ch = payload[i];
    if (ch === "'") {
      inQuotes = !inQuotes;
      i += 1;
      continue;
    }
    if (!inQuotes) {
      // Outside a quoted span the ONLY tolerated bytes are the backslash-escaped
      // quote that bridges two spans ( \\' ). Anything else would reach the shell.
      assert.equal(ch, "\\", `unquoted byte ${JSON.stringify(ch)} would reach sh -c`);
      assert.equal(payload[i + 1], "'", "the only legal unquoted escape is a backslashed quote");
      unquoted += "'";
      i += 2;
      continue;
    }
    unquoted += ch;
    i += 1;
  }
  assert.equal(inQuotes, false, "the single-quoted span must be closed");
  assert.equal(unquoted, hostile);
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

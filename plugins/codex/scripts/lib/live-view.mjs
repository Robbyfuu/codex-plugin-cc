import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

/**
 * Live-visibility helper: open a tmux pane that tails a job's live log. The
 * per-event tee into that log is handled upstream by the progress reporter in
 * tracked-jobs.mjs; this module only owns the optional pane. Everything is
 * best-effort: a pane failure must never crash a turn.
 */

export const WATCH_PANE_ENV = "CODEX_COMPANION_WATCH_PANE";

function nowIso() {
  return new Date().toISOString();
}

// Exported as the single source of truth for boolean env parsing; notify.mjs
// reuses these so the master opt-out knob behaves identically to the watch-pane
// knob (no duplicated truthy/falsey tables drifting apart).
export function isFalsey(value) {
  return ["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

export function isTruthy(value) {
  return ["1", "true", "on", "yes"].includes(String(value).trim().toLowerCase());
}

/**
 * Decide whether the auto tmux pane should open. Enabled by default whenever
 * `TMUX` is set; an explicit knob (`CODEX_COMPANION_WATCH_PANE`) overrides in
 * either direction.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isWatchPaneEnabled(env = process.env) {
  const source = env ?? {};
  const raw = source[WATCH_PANE_ENV];
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    if (isFalsey(raw)) {
      return false;
    }
    if (isTruthy(raw)) {
      return true;
    }
  }
  return Boolean(source.TMUX);
}

/**
 * Single-quote a value for a POSIX shell so the path survives `tmux
 * split-window`'s shell interpretation.
 *
 * @param {string} value
 * @returns {string}
 */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the argv for `tmux split-window` that tails the given log file in a
 * detached pane.
 *
 * @param {string} logFile
 * @returns {string[]}
 */
export function buildTmuxSplitArgs(logFile) {
  return ["split-window", "-d", `tail -F ${shellSingleQuote(logFile)}`];
}

/**
 * Marker file used to guarantee only one pane is opened per job/session.
 *
 * @param {string} logFile
 * @returns {string}
 */
export function resolvePaneMarkerFile(logFile) {
  return `${logFile}.pane`;
}

/**
 * Open a detached tmux pane tailing `logFile`, guarded by a marker file so a
 * second call for the same job/session is a no-op. Fully best-effort: returns a
 * small status object and never throws.
 *
 * @param {string | null | undefined} logFile
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   spawnImpl?: typeof spawn,
 *   existsSyncImpl?: typeof fs.existsSync,
 *   writeMarkerImpl?: (markerFile: string) => void
 * }} [options]
 * @returns {{ opened: boolean, reason?: string }}
 */
export function openWatchPane(logFile, options = {}) {
  const env = options.env ?? process.env;
  if (!logFile) {
    return { opened: false, reason: "no-log-file" };
  }
  if (!isWatchPaneEnabled(env)) {
    return { opened: false, reason: "disabled" };
  }

  const existsSyncImpl = options.existsSyncImpl ?? fs.existsSync;
  const markerFile = resolvePaneMarkerFile(logFile);
  // `force` is used by the manual /codex-plus:watch command, which should always open
  // a fresh pane on demand even if an auto pane was opened earlier.
  if (!options.force && existsSyncImpl(markerFile)) {
    return { opened: false, reason: "already-open" };
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const writeMarker =
    options.writeMarkerImpl ??
    ((file) => {
      fs.writeFileSync(file, `${nowIso()}\n`, "utf8");
    });

  try {
    const child = spawnImpl("tmux", buildTmuxSplitArgs(logFile), {
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on?.("error", () => {
      // tmux missing or split failed — swallow, this is best-effort.
    });
    child.unref?.();
  } catch {
    return { opened: false, reason: "spawn-failed" };
  }

  try {
    writeMarker(markerFile);
  } catch {
    // If we cannot persist the marker, we still opened a pane; accept a small
    // duplicate risk over crashing.
  }

  return { opened: true };
}

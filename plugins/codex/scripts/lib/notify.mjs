import process from "node:process";
import { spawn } from "node:child_process";

import { isFalsey } from "./live-view.mjs";

/**
 * Turn-completion / stall notifier. A finished Codex turn fans out through
 * `emitTurnOutcome` (tracked-jobs.mjs); this module is the SECOND independent
 * consumer (telemetry is the first). It pushes a short human notification to
 * whatever local channels are available — tmux status line, terminal bell, and
 * (on macOS) a native notification — so a user who stepped away learns the turn
 * settled without staring at the pane.
 *
 * Everything here is best-effort and fire-and-forget: every external channel is
 * spawned DETACHED with stdio ignored, immediately `unref`'d, and given a
 * swallow-all `error` handler so a missing binary is silent. `emitTurnNotification`
 * never awaits and never throws into the turn lifecycle.
 *
 * SECURITY MODEL (read before editing the argv builders):
 *   - We spawn with an argv ARRAY, never a shell string, so the OS never runs a
 *     shell on our behalf. That alone neutralizes classic shell-metacharacter
 *     injection (`;`, `|`, `$( )`, backticks, `&&`, redirection): those bytes are
 *     passed verbatim as a single argv element, not interpreted. We therefore do
 *     NOT shell-quote anything here (no `shellSingleQuote`, no `tail -F '...'`
 *     style command string).
 *   - The only two residual vectors, both handled below, are:
 *       (1) tmux ARGUMENT/FLAG injection — a message that begins with "-" could be
 *           parsed by tmux as an option. Neutralized in `buildTmuxDisplayArgs`
 *           (strip control chars + prevent a leading dash).
 *       (2) AppleScript STRING-LITERAL breakout — the osascript `-e` argument is
 *           an AppleScript PROGRAM, and the message/title are interpolated into
 *           AppleScript string literals. A bare `"` in the value would close the
 *           literal and let an attacker append AppleScript statements (e.g.
 *           `do shell script "..."`); a raw newline inside the literal is also a
 *           syntax error that makes osascript exit non-zero. Neutralized by
 *           stripping control chars (`stripControlChars`) and then
 *           `appleScriptQuote`, which wraps in double quotes and backslash-escapes
 *           `\` then `"`.
 *
 *   THREAT REALITY TODAY: the message/title that reach these builders come from a
 *   FIXED internal `outcome.title` label — "Codex Task" / "Codex Resume" /
 *   "Codex Stop Gate Review" / `Codex ${reviewName}` (codex-companion.mjs
 *   buildTaskRunMetadata + buildReviewJobMetadata; tracked-jobs.mjs sets
 *   outcome.title = job.title) — NOT from any user input. The actual user-prompt
 *   excerpt is `shorten(prompt)`, which lands in `job.summary` / `execution.summary`
 *   and is NEVER copied into the outcome, so it never reaches an argv builder. The
 *   tmux flag-strip and the AppleScript quoting are therefore PRECAUTIONARY
 *   defense-in-depth right now. They become load-bearing for genuine
 *   attacker-influenced input only if `summary` (the real excerpt) is ever wired
 *   into the notification message/title — do that and these defenses are what
 *   keep it safe, so keep them.
 */

export const NOTIFY_ENV = "CODEX_COMPANION_NOTIFY";
export const NOTIFY_CHANNELS_ENV = "CODEX_COMPANION_NOTIFY_CHANNELS";

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * Strip ASCII control characters (newlines, carriage returns, escape, bell, etc.)
 * from a value. Shared by BOTH external channels so they sanitize identically:
 *   - tmux: keeps the status line out of terminal escape-sequence smuggling;
 *   - osascript: a raw newline/CR inside an AppleScript string literal is a SYNTAX
 *     ERROR (osascript exits non-zero and the notification silently never shows),
 *     so the bytes must be removed before interpolation.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stripControlChars(value) {
  return String(value ?? "").replace(CONTROL_CHARS, "");
}

/**
 * Wrap a value as an AppleScript double-quoted STRING LITERAL, escaping the only
 * two bytes that matter inside one: backslash (the escape char) and double quote
 * (the delimiter). Backslash MUST be escaped FIRST — otherwise the backslash we
 * add when escaping a quote would itself be doubled, corrupting the literal.
 *
 * This is DELIBERATELY DIFFERENT from a shell single-quote helper: AppleScript
 * literals use C-style backslash escapes, not POSIX `'...'` quoting. Do not
 * substitute one for the other.
 *
 * @param {unknown} value
 * @returns {string} an AppleScript string literal, including its surrounding quotes
 */
export function appleScriptQuote(value) {
  const escaped = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Sanitize a message for a tmux argv element. Two jobs:
 *   - strip control characters (newlines, escape, bell, etc.) so the status line
 *     can't be smuggled into terminal escape sequences;
 *   - guarantee the argument does not START with "-", which tmux would otherwise
 *     try to parse as a flag (argument/flag injection). We prefix a single space
 *     rather than dropping characters, so the human text stays readable.
 *
 * @param {unknown} message
 * @returns {string}
 */
function sanitizeTmuxMessage(message) {
  let sanitized = stripControlChars(message);
  if (sanitized.startsWith("-")) {
    sanitized = ` ${sanitized}`;
  }
  return sanitized;
}

/**
 * Build argv for `tmux display-message <message>`. spawn uses an argv array (no
 * shell), so there is nothing to shell-quote; the only hardening is flag-injection
 * + control-char stripping in `sanitizeTmuxMessage`.
 *
 * @param {string} message
 * @returns {string[]}
 */
export function buildTmuxDisplayArgs(message) {
  return ["display-message", sanitizeTmuxMessage(message)];
}

/**
 * Build argv for `osascript -e <applescript-program>` that posts a native macOS
 * notification. Both the body and the title are interpolated as AppleScript
 * string literals via `appleScriptQuote`, which is what prevents literal breakout.
 *
 * @param {string} message
 * @param {string} title
 * @returns {string[]}
 */
export function buildOsascriptArgs(message, title) {
  // Strip control chars (incl. raw newline/CR) from BOTH literals first: a raw
  // newline inside an AppleScript string literal is a syntax error that makes
  // osascript exit non-zero (no notification). appleScriptQuote then handles the
  // breakout escaping (backslash before quote) on the cleaned value.
  const program = `display notification ${appleScriptQuote(stripControlChars(message))} with title ${appleScriptQuote(stripControlChars(title))}`;
  return ["-e", program];
}

/**
 * Render an epoch-ms duration as a short human string (e.g. "1.5s", "2m 3s").
 *
 * @param {number} durationMs
 * @returns {string}
 */
function humanDuration(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Derive the human notification message from a turn outcome. Pure: no side
 * effects, exported so it can be asserted directly.
 *
 * @param {{ exitReason?: string, title?: string|null, durationMs?: number }} outcome
 * @returns {string}
 */
export function buildNotificationMessage(outcome = {}) {
  const title = String(outcome.title ?? "").trim() || "task";
  const dur = humanDuration(outcome.durationMs);
  switch (outcome.exitReason) {
    case "completed":
      return `Codex ${title} completed (${dur}).`;
    case "interrupted":
      return `Codex ${title} interrupted (no clean completion).`;
    case "idle-stall":
      return `Codex ${title} stalled (no activity).`;
    case "hard-stop":
      return `Codex ${title} hit the max-duration ceiling.`;
    case "cancelled":
      return `Codex ${title} cancelled.`;
    case "error":
      return `Codex ${title} failed.`;
    default:
      return `Codex ${title} finished.`;
  }
}

/**
 * Decide which notification channels are active for this turn.
 *
 *   - `CODEX_COMPANION_NOTIFY` is a master opt-out: a falsey value
 *     (0/false/off/no, case-insensitive) turns ALL channels off. Anything else
 *     (including unset) leaves notifications enabled.
 *   - `CODEX_COMPANION_NOTIFY_CHANNELS` is an optional comma list that restricts
 *     which channels may fire (e.g. "tmux,bell"). Unset = AUTO: tmux when $TMUX
 *     is set, osascript on darwin, bell always.
 *   - An explicit list OVERRIDES auto, but a listed channel still no-ops if its
 *     precondition fails (osascript on Linux, tmux without $TMUX).
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {{ tmux: boolean, bell: boolean, osascript: boolean }}
 */
export function resolveNotifyChannels({ env = process.env, platform = process.platform } = {}) {
  const off = { tmux: false, bell: false, osascript: false };

  const master = env[NOTIFY_ENV];
  if (master !== undefined && master !== null && String(master).trim() !== "" && isFalsey(master)) {
    return off;
  }

  // Per-channel preconditions: a channel can only fire where it makes sense.
  const supports = {
    tmux: Boolean(env.TMUX),
    bell: true,
    osascript: platform === "darwin"
  };

  const rawList = env[NOTIFY_CHANNELS_ENV];
  if (rawList !== undefined && rawList !== null && String(rawList).trim() !== "") {
    const requested = new Set(
      String(rawList)
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    );
    return {
      tmux: requested.has("tmux") && supports.tmux,
      bell: requested.has("bell") && supports.bell,
      osascript: requested.has("osascript") && supports.osascript
    };
  }

  // Auto mode: every supported channel is on.
  return { ...supports };
}

/**
 * Spawn an external notifier DETACHED and fully fire-and-forget. Mirrors the
 * `openWatchPane` spawn shape: detached, stdio ignored, immediately unref'd, with
 * a swallow-all `error` handler so a missing binary never surfaces. Never awaits,
 * never throws.
 *
 * @param {typeof spawn} spawnImpl
 * @param {string} command
 * @param {string[]} args
 */
function spawnDetachedNotifier(spawnImpl, command, args) {
  try {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on?.("error", () => {
      // Binary missing or spawn failed — swallow, this is best-effort.
    });
    child.unref?.();
  } catch {
    // A synchronous spawn throw (e.g. impossible argv) must never escape.
  }
}

/**
 * Emit a turn-completion / stall notification across every enabled channel.
 * Best-effort and fire-and-forget — see the module SECURITY MODEL header.
 *
 * @param {{ exitReason?: string, title?: string|null, durationMs?: number }} outcome
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string,
 *   spawnImpl?: typeof spawn,
 *   writeImpl?: (chunk: string) => unknown
 * }} [options]
 */
export function emitTurnNotification(outcome, options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    spawnImpl = spawn,
    // Default bell writer. NOTE: a detached background task worker has no tty, so
    // writing the bell there is a harmless no-op; the FOREGROUND command is the
    // primary bell notifier.
    writeImpl = (chunk) => process.stderr.write(chunk)
  } = options;

  const plan = resolveNotifyChannels({ env, platform });
  const message = buildNotificationMessage(outcome);

  if (plan.tmux) {
    spawnDetachedNotifier(spawnImpl, "tmux", buildTmuxDisplayArgs(message));
  }

  if (plan.osascript) {
    const title = String(outcome?.title ?? "").trim() || "Codex";
    spawnDetachedNotifier(spawnImpl, "osascript", buildOsascriptArgs(message, title));
  }

  if (plan.bell) {
    try {
      writeImpl("\x07");
    } catch {
      // No tty / closed stream — swallow, the bell is best-effort.
    }
  }
}

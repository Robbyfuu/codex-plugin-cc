---
description: Diagnose the Codex companion's health for this repository — codex runtime, shared broker state, and on-disk state-dir hygiene — and optionally clean up stale artifacts
argument-hint: '[--fix] [--clean] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" doctor "$ARGUMENTS"`

Present the command output to the user exactly as produced. Do not summarize, condense, or reformat it.

The default invocation (no flags) is a READ-ONLY diagnosis and mutates nothing. It reports:
- codex CLI availability (version + advanced runtime support),
- the shared Codex broker classification — `healthy`, `orphaned` (a dead broker session whose pid is gone), `wedged` (a live broker whose endpoint is unresponsive), or `none`,
- state-dir hygiene: total size, stale job artifacts, orphan pane markers, and telemetry size / over-cap,
- an `Issues:` list with severity and whether each issue is auto-fixable.

Cleanup flags (they combine):
- `--fix` performs the SAFE actions (tear down an orphaned broker session, remove orphan pane markers) and, only when safe, kills a `wedged` broker and tears it down. THE KILL GATE: a wedged broker is killed ONLY when no Codex job is `running`/`queued`. If any job is active the broker may be serving it, so the kill is downgraded to report-only and the broker is left untouched.
- `--clean` additionally removes stale job artifacts (logs/per-job JSON older than the retention window and not an active job) and ROLLS an oversized `telemetry.jsonl` to a single rolled generation. Telemetry is never deleted, only rolled.

When `--fix` or `--clean` is used, the output includes a `Planned actions:` list and an `Actions taken:` list. Surface EVERY planned and taken action to the user verbatim — especially any "Killed wedged broker pid X" or "NOT being killed" line — so the user sees exactly what was changed and why a destructive action was or was not taken.

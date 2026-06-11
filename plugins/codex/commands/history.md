---
description: Show the most recent Codex turns for this repository — newest first, with timestamp, kind, title, duration, exit reason, and a short thread id
argument-hint: '[--limit <n>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" history "$ARGUMENTS"`

Present the command output to the user exactly as produced. Do not summarize, condense, recompute, or reformat the entries.

The report is a newest-first list of the turns recorded for this workspace (turns only — broker self-heal events are not shown here; see `/peer:stats` for those). Each line carries the turn's end timestamp, kind, title, human-readable duration, exit reason (`completed`, `idle-stall`, `hard-stop`, `interrupted`, `cancelled`, `error`), and a shortened Codex thread id.

`--limit <n>` controls how many of the most recent turns are shown (default 20). When the telemetry file is empty, the report shows a friendly "no turns recorded yet" message.

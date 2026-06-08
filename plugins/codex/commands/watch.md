---
description: Open a tmux pane that tails the live log of the most recent or active Codex job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" watch "$ARGUMENTS"`

Present the command output to the user as-is.

- If a tmux pane was opened, confirm that the live log is now being tailed in a split pane.
- If tmux is unavailable (or watch panes are disabled), surface the `tail -F <path>` command so the user can follow the live log manually.
- Do not summarize or condense the output.

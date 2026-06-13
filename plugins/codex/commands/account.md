---
description: Manage Codex accounts (named CODEX_HOMEs) — add, switch, or list them
argument-hint: '[add <name> [--home <path>] | use <name> | list]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" account "$ARGUMENTS"`

Surface the command output to the user VERBATIM. Do not summarize, reword, or omit any line.

In particular:
- For `add`, the output includes a ready-to-paste `CODEX_HOME=<path> codex login` command. Present it exactly as printed, inside a code block, so the user can copy it. This is the one-time interactive login (OpenAI OAuth, opens a browser); the plugin cannot run it for them.
- For `use`, relay the confirmation that the active account changed and whether the workspace Codex runtime was restarted.
- For `list` (or no argument), show each account with its name, CODEX_HOME, active marker (`*`), and login status as printed.

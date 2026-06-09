---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.

Anti-hang and live-visibility tunables (optional environment variables):

The idle timeout and the max-turn ceiling are two INDEPENDENT knobs. Idle catches a turn that goes silent; max-turn caps a turn that runs too long even while active. Raise whichever one a stall message names.

- `CODEX_COMPANION_IDLE_TIMEOUT_MS` (default `180000`): if a Codex turn has no activity AND nothing in flight for this many milliseconds, the turn is treated as stalled. The plugin interrupts the turn and the broker self-heals (interrupt, then restart its Codex runtime if still stuck). This is the primary stall catcher. It is item-aware: a long-running step (a slow build/test/clone, or a long reasoning/answer block) emits no notifications until it finishes, so while any item is in flight the idle timer is paused and will NOT false-trip. If a turn is wrongly killed for idleness, raise this value.
- `CODEX_COMPANION_MAX_TURN_MS` (default `900000`): hard ceiling on a single turn's wall-clock duration, enforced even while the turn keeps working (this is the only backstop for an item that genuinely never completes, since the idle timer is paused during in-flight items). Independent of the idle timeout. If a legitimately long turn is killed for exceeding the ceiling, raise this value.
- `CODEX_COMPANION_REQUEST_TIMEOUT_MS` (default `600000`): last-resort backstop on any single JSON-RPC request to the Codex app-server. Intentionally generous so it never kills a legitimately long turn; the idle timeout above is the real stall catcher.
- `CODEX_COMPANION_WATCH_PANE` (default: enabled when `TMUX` is set): when running a job inside tmux, automatically open a split pane that tails the job's live log. Set to `0`/`false`/`off`/`no` to disable, or `1`/`true`/`on`/`yes` to force-enable. Use `/codex-plus:watch [job-id]` to open the pane manually.

All four have safe defaults that preserve normal behavior; invalid or non-positive values fall back to the defaults.

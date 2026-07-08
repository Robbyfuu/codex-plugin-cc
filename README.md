# peer — Codex plugin for Claude Code, enhanced

`peer` is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) that fixes indefinite hangs and adds observability and operations tooling on top of the upstream Codex integration. You still review code and delegate tasks to Codex from inside Claude Code, but now turns can no longer stall forever, you can watch and measure each run, and you get a health check that can clean up after itself.

> Note: the upstream demo video (`docs/plugin-demo.webm`) ships with the original repo and shows the base `codex` commands. It does not cover the new `peer` features described below, so it is not embedded here.

## What this fork adds

- **Anti-hang.** A per-turn idle watchdog aborts a turn after `CODEX_COMPANION_IDLE_TIMEOUT_MS` (default `180000`) of no progress, but it pauses while an item is genuinely in flight so long-running work is not killed prematurely. A max-turn ceiling (`CODEX_COMPANION_MAX_TURN_MS`, default `900000`) caps the absolute turn duration, and request timeouts (`CODEX_COMPANION_REQUEST_TIMEOUT_MS`, default `600000`) bound individual app-server requests. The broker self-heals with generation-guarded routing so a dead child is replaced cleanly without misrouting in-flight clients, and cancel is ownership-scoped so you only ever cancel your own jobs.
- **`/peer:watch`** opens a live tmux pane that streams a running Codex job so you can see progress in real time.
- **`/peer:stats`** reports per-turn telemetry for recent runs and surfaces a tuning recommendation for the timeout knobs above.
- **Automatic turn notifications** when a turn finishes, via tmux, terminal bell, or macOS notification. Configure with the `CODEX_COMPANION_NOTIFY*` environment variables.
- **`/peer:doctor [--fix] [--clean]`** runs a health check over the runtime and state, optionally applies safe fixes, and optionally cleans up stale artifacts.

### Environment knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_COMPANION_IDLE_TIMEOUT_MS` | `180000` | Abort a turn after this much idle time (paused while an item is in flight). |
| `CODEX_COMPANION_MAX_TURN_MS` | `900000` | Absolute ceiling on a single turn's duration. |
| `CODEX_COMPANION_REQUEST_TIMEOUT_MS` | `600000` | Timeout for an individual app-server request. |
| `CODEX_COMPANION_NOTIFY*` | — | Turn-completion notification settings (tmux / bell / macOS). |

## What You Get

- `/peer:review` for a normal read-only Codex review
- `/peer:adversarial-review` for a steerable challenge review
- `/peer:rescue`, `/peer:transfer`, `/peer:status`, `/peer:result`, and `/peer:cancel` to delegate work, hand off sessions, and manage background jobs
- `/peer:watch`, `/peer:stats`, and `/peer:doctor` for live visibility, telemetry, and health (added by this fork)

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
claude plugin marketplace add Robbyfuu/codex-plugin-cc
```

Install the plugin:

```bash
claude plugin install peer@peer
```

> Note: `peer` coexists with the upstream `codex` plugin. Because the slash-command namespace follows the plugin name, this fork's commands live under `/peer:*` and do not collide with `/codex:*`.

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/peer:setup
```

`/peer:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `peer:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/peer:review --background
/peer:status
/peer:result
```

## Usage

### `/peer:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/peer:adversarial-review`](#peeradversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/peer:review
/peer:review --base main
/peer:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/peer:status`](#peerstatus) to check on the progress and [`/peer:cancel`](#peercancel) to cancel the ongoing task.

### `/peer:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/peer:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/peer:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/peer:adversarial-review
/peer:adversarial-review --base main challenge whether this was the right caching and retry design
/peer:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/peer:rescue`

Hands a task to Codex through the `peer:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/peer:rescue investigate why the tests started failing
/peer:rescue fix the failing test with the smallest safe patch
/peer:rescue --resume apply the top fix from the last run
/peer:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/peer:rescue --model spark fix the issue quickly
/peer:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/peer:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/peer:transfer
/peer:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/peer:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/peer:status
/peer:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/peer:watch`

Opens a live tmux pane that streams the output of a running Codex job so you can follow progress in real time.

Examples:

```bash
/peer:watch
/peer:watch task-abc123
```

Requires tmux. Use it alongside [`/peer:status`](#peerstatus) when you want to actually watch a long-running job rather than poll it.

### `/peer:stats`

Shows per-turn telemetry for recent Codex runs and a tuning recommendation for the timeout knobs (`CODEX_COMPANION_IDLE_TIMEOUT_MS`, `CODEX_COMPANION_MAX_TURN_MS`, `CODEX_COMPANION_REQUEST_TIMEOUT_MS`).

Examples:

```bash
/peer:stats
/peer:stats task-abc123
```

### `/peer:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/peer:result
/peer:result task-abc123
```

### `/peer:cancel`

Cancels an active background Codex job.

Examples:

```bash
/peer:cancel
/peer:cancel task-abc123
```

### `/peer:doctor`

Runs a health check over the Codex runtime and the plugin's local state. It can optionally apply safe fixes and clean up stale artifacts.

Examples:

```bash
/peer:doctor
/peer:doctor --fix
/peer:doctor --clean
/peer:doctor --fix --clean
```

Use `--fix` to apply safe automatic repairs and `--clean` to remove stale jobs and orphaned state.

### `/peer:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/peer:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/peer:setup --enable-review-gate
/peer:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/peer:review
```

### Hand A Problem To Codex

```bash
/peer:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/peer:adversarial-review --background
/peer:rescue --background investigate the flaky test
```

Then check in with:

```bash
/peer:status
/peer:watch
/peer:stats
/peer:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/peer:result` or `/peer:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/peer:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Attribution

`peer` is based on [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for the original copyright and the modifications made in this fork.

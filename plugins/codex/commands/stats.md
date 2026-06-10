---
description: Show per-turn Codex telemetry for this repository — counts by exit reason, duration percentiles, stall rate, and a timeout-tuning recommendation
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" stats "$ARGUMENTS"`

Present the command output to the user exactly as produced. Do not summarize, condense, recompute, or reformat the numbers.

The report covers turns recorded for this workspace: the total turn count, a breakdown by exit reason (`completed`, `idle-stall`, `hard-stop`, `interrupted`, `cancelled`, `error`), p50/p95/max turn durations, the stall and restart rates, and a data-driven recommendation about the configured idle/max-duration timeouts.

Note for interpreting the legend: an `interrupted` turn is one that settled without a clean completion — typically a broker self-heal (the broker restarted its runtime mid-turn), though other non-clean settlements (such as an aborted turn) land here too. These are bucketed as `interrupted` (their own reason) and signal instability rather than a timeout-tuning problem. `error` is reserved for genuine turn failures (a thrown rejection).

Restart rate and the Broker section: when the broker has recorded its own events (the sibling `broker-telemetry.jsonl` file), the report includes a `Broker:` section with the REAL restart count (`recovery-succeeded`) and recovery failures, and the restart rate is computed from those real broker restarts over total turns (labelled `broker events`). When no broker event data exists yet, the restart rate falls back to an inference from the `interrupted` bucket (labelled `inferred from the interrupted bucket`) and the Broker section is omitted.

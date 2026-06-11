import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildStopGateOutcome,
  parseStopReviewOutput
} from "../scripts/stop-review-gate-hook.mjs";

/**
 * Issue #6: the stop-review gate must BLOCK only on a genuine review verdict of
 * BLOCK. Infra failures (spawn error, timeout, non-zero exit, empty/invalid
 * JSON, rate-limit) must APPROVE with a stderr warning so a transient Codex
 * failure never traps Claude in a token-burning rewake loop.
 */

// ---------------------------------------------------------------------------
// parseStopReviewOutput: verdict classification
// ---------------------------------------------------------------------------

test("parseStopReviewOutput classifies ALLOW as an allow verdict", () => {
  const result = parseStopReviewOutput("ALLOW: looks good");
  assert.equal(result.verdict, "allow");
});

test("parseStopReviewOutput classifies BLOCK as a real block verdict", () => {
  const result = parseStopReviewOutput("BLOCK: Missing empty-state guard");
  assert.equal(result.verdict, "block");
  assert.match(result.reason, /Missing empty-state guard/);
});

test("parseStopReviewOutput treats empty output as an infra error, not a block", () => {
  const result = parseStopReviewOutput("");
  assert.equal(result.verdict, "infra-error");
});

test("parseStopReviewOutput treats an unexpected (unparseable) answer as an infra error", () => {
  const result = parseStopReviewOutput("the model rambled without a verdict");
  assert.equal(result.verdict, "infra-error");
});

test("parseStopReviewOutput finds a BLOCK verdict that is NOT on the first line and still blocks", () => {
  // Acceptance regression: the model prefaced its verdict with prose, so the
  // genuine BLOCK is on line 3. First-line-only parsing would misclassify this
  // as a parse infra-error and fail open. The verdict must win.
  const output = [
    "Here is my review of the previous turn.",
    "",
    "BLOCK: the empty-state guard is still missing",
    "",
    "Please address this before ending the session."
  ].join("\n");
  const result = parseStopReviewOutput(output);
  assert.equal(result.verdict, "block");
  assert.match(result.reason, /empty-state guard/);
});

test("parseStopReviewOutput finds an ALLOW verdict on a later line", () => {
  const output = ["Reviewed the diff.", "", "ALLOW: nothing blocking found"].join("\n");
  const result = parseStopReviewOutput(output);
  assert.equal(result.verdict, "allow");
});

test("parseStopReviewOutput fails open ONLY when no verdict exists anywhere", () => {
  const output = ["The model produced several paragraphs", "of prose with no verdict line", "at all."].join("\n");
  const result = parseStopReviewOutput(output);
  assert.equal(result.verdict, "infra-error");
  assert.equal(result.kind, "parse");
});

// ---------------------------------------------------------------------------
// buildStopGateOutcome: map a review result to a hook outcome
// ---------------------------------------------------------------------------

test("a real BLOCK verdict produces a block decision", () => {
  const outcome = buildStopGateOutcome({ verdict: "block", reason: "Found a bug" });
  assert.equal(outcome.decision, "block");
  assert.match(outcome.reason, /Found a bug/);
});

test("an ALLOW verdict approves with no warning", () => {
  const outcome = buildStopGateOutcome({ verdict: "allow" });
  assert.notEqual(outcome.decision, "block");
  assert.equal(outcome.warning ?? "", "");
});

test("a spawn-error infra failure approves with a stderr warning and manual instructions", () => {
  const outcome = buildStopGateOutcome({ verdict: "infra-error", kind: "spawn", reason: "spawn failed: ENOENT" });
  assert.notEqual(outcome.decision, "block", "an infra failure must NOT block");
  assert.match(outcome.warning, /peer:review --wait/i);
  assert.match(outcome.warning, /spawn failed/i);
});

test("a timeout infra failure approves with a warning", () => {
  const outcome = buildStopGateOutcome({ verdict: "infra-error", kind: "timeout" });
  assert.notEqual(outcome.decision, "block");
  assert.match(outcome.warning, /timed out/i);
  assert.match(outcome.warning, /peer:review --wait/i);
});

test("a non-zero-exit infra failure approves with a warning", () => {
  const outcome = buildStopGateOutcome({ verdict: "infra-error", kind: "exit", reason: "exit 1: boom" });
  assert.notEqual(outcome.decision, "block");
  assert.match(outcome.warning, /peer:review --wait/i);
});

test("an empty-output infra failure approves with a warning", () => {
  const outcome = buildStopGateOutcome({ verdict: "infra-error", kind: "empty" });
  assert.notEqual(outcome.decision, "block");
  assert.match(outcome.warning, /peer:review --wait/i);
});

test("an invalid-JSON infra failure approves with a warning", () => {
  const outcome = buildStopGateOutcome({ verdict: "infra-error", kind: "parse" });
  assert.notEqual(outcome.decision, "block");
  assert.match(outcome.warning, /peer:review --wait/i);
});

test("a rate-limit infra failure approves with a rate-limit-specific warning", () => {
  const outcome = buildStopGateOutcome({ verdict: "infra-error", kind: "rate-limit", reason: "429 rate limit exceeded" });
  assert.notEqual(outcome.decision, "block");
  assert.match(outcome.warning, /rate limit/i);
  assert.match(outcome.warning, /peer:review --wait/i);
});

// ---------------------------------------------------------------------------
// rate-limit detection on raw runner output
// ---------------------------------------------------------------------------

test("parseStopReviewOutput flags rate-limit phrasing (429) as a rate-limit infra error", () => {
  const result = parseStopReviewOutput("Error: 429 Too Many Requests");
  assert.equal(result.verdict, "infra-error");
  assert.equal(result.kind, "rate-limit");
});

test("parseStopReviewOutput flags 'rate limit' phrasing (case-insensitive) as a rate-limit infra error", () => {
  const result = parseStopReviewOutput("RATE LIMIT reached, please retry later");
  assert.equal(result.verdict, "infra-error");
  assert.equal(result.kind, "rate-limit");
});

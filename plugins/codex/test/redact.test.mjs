import assert from "node:assert/strict";
import { test } from "node:test";

import { redactSecrets } from "../scripts/lib/redact.mjs";

const PLACEHOLDER = "«redacted»";

test("redactSecrets returns non-string input unchanged", () => {
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(42), 42);
});

test("redactSecrets leaves a normal prompt with no secret untouched", () => {
  const prompt = "Refactor the auth module and add tests for the login flow.";
  assert.equal(redactSecrets(prompt), prompt);
});

test("redactSecrets redacts an OpenAI-style sk- key", () => {
  const out = redactSecrets("use key sk-abcdEFGH1234567890 wisely");
  assert.match(out, /use key «redacted» wisely/);
  assert.doesNotMatch(out, /sk-abcdEFGH1234567890/);
});

test("redactSecrets redacts a GitHub personal access token (ghp_)", () => {
  const token = "ghp_" + "A".repeat(36);
  // BARE token (no `token=` prefix) so the `ghp_` rule is proven in isolation,
  // not via the generic key=value assignment rule.
  const out = redactSecrets(`here is ${token} ok`);
  assert.match(out, /here is «redacted» ok/);
  assert.doesNotMatch(out, /ghp_A{36}/);
});

test("redactSecrets redacts a fine-grained GitHub PAT (github_pat_)", () => {
  const token = "github_pat_" + "B1".repeat(20);
  const out = redactSecrets(`here is ${token} ok`);
  assert.doesNotMatch(out, /github_pat_/);
  assert.ok(out.includes(PLACEHOLDER));
});

test("redactSecrets redacts an AWS access key id (AKIA...)", () => {
  const out = redactSecrets("aws AKIAABCDEFGHIJKLMNOP done");
  assert.match(out, /aws «redacted» done/);
  assert.doesNotMatch(out, /AKIA[0-9A-Z]{16}/);
});

test("redactSecrets redacts a Slack token (xoxb-...)", () => {
  const out = redactSecrets("slack xoxb-1234567890-abcdEFGH end");
  assert.doesNotMatch(out, /xoxb-1234567890-abcdEFGH/);
  assert.ok(out.includes(PLACEHOLDER));
});

test("redactSecrets redacts a JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w";
  const out = redactSecrets(`bearerless ${jwt} token`);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiIs/);
  assert.ok(out.includes(PLACEHOLDER));
});

test("redactSecrets redacts a bearer token (case-insensitive)", () => {
  const out = redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123");
  assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwxyz0123/);
  assert.ok(out.includes(PLACEHOLDER));
});

test("redactSecrets redacts generic key/secret/token/password assignments", () => {
  const cases = [
    "api_key=supersecretvalue123",
    "api-key: supersecretvalue123",
    "apikey=supersecretvalue123",
    "secret = supersecretvalue123",
    "token: supersecretvalue123",
    "password=supersecretvalue123"
  ];
  for (const input of cases) {
    const out = redactSecrets(input);
    assert.doesNotMatch(out, /supersecretvalue123/, `should redact value in: ${input}`);
    assert.ok(out.includes(PLACEHOLDER), `should insert placeholder in: ${input}`);
  }
});

test("redactSecrets redacts multiple secrets in the same text", () => {
  const out = redactSecrets("first sk-abcdEFGH1234567890 then AKIAABCDEFGHIJKLMNOP");
  assert.doesNotMatch(out, /sk-abcdEFGH1234567890/);
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
  const count = out.split(PLACEHOLDER).length - 1;
  assert.equal(count, 2, "both secrets should be redacted");
});

test("redactSecrets does NOT over-redact short or partial tokens", () => {
  // Too short to match any high-confidence pattern.
  const benign = [
    "sk-short",
    "the word secret appears here without an assignment",
    "ghp_tooshort",
    "my password is",
    "AKIA123",
    "bearer hug"
  ];
  for (const input of benign) {
    assert.equal(redactSecrets(input), input, `should NOT redact benign text: ${input}`);
  }
});

test("redactSecrets does NOT redact ordinary hyphenated/identifier words", () => {
  const prompt = "Update the user-service and rename getToken to fetchToken.";
  assert.equal(redactSecrets(prompt), prompt);
});

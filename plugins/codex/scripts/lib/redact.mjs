/**
 * Defense-in-depth redaction of high-confidence secret shapes from operational
 * text (task prompts) before it is persisted to the state directory as a job
 * `summary`. This is NOT a guarantee — it catches common, recognizable token
 * shapes, not every possible secret. The real boundary is the owner-only state
 * directory (plan 002); this just keeps an obvious pasted credential from
 * sitting in cleartext inside `state.json` / `jobs/<id>.json`.
 *
 * Design constraints:
 *  - Pure function, no dependencies, no side effects.
 *  - CONSERVATIVE: every pattern is anchored on a recognizable prefix or an
 *    explicit assignment with a minimum length, so ordinary prose, identifiers,
 *    and hyphenated words are left untouched (over-redaction would mangle the
 *    human-useful summary and is treated as a bug, not a safe default).
 */

export const REDACTION_PLACEHOLDER = "«redacted»";

// Each entry is a high-confidence secret shape. Patterns are intentionally
// narrow: a known prefix + a realistic minimum length, OR an explicit
// `key: value` / `key=value` assignment whose value is long enough to be a real
// secret. All are global+multiline so every occurrence in the text is replaced.
const SECRET_PATTERNS = [
  // OpenAI-style API keys.
  /sk-[A-Za-z0-9]{16,}/g,
  // GitHub fine-grained PAT (check BEFORE the classic ghp_ prefix is irrelevant
  // since they don't overlap, but keep the more specific prefix listed too).
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // GitHub classic personal access token.
  /ghp_[A-Za-z0-9]{20,}/g,
  // AWS access key id.
  /AKIA[0-9A-Z]{16}/g,
  // Slack tokens (bot/user/app/refresh/etc.).
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // JWT: three base64url segments separated by dots.
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Bearer auth header value.
  /bearer\s+[A-Za-z0-9._-]{20,}/gi,
  // Generic `api_key`/`secret`/`token`/`password` assignment with a non-trivial
  // value. Requires an explicit `:`/`=` so bare mentions of the word ("my
  // password is …") are NOT redacted.
  /(api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}/gi
];

/**
 * Replace high-confidence secret shapes in `text` with a placeholder.
 *
 * @param {unknown} text candidate text (only strings are processed; any other
 *   type is returned unchanged so callers can pass it through defensively).
 * @returns {unknown} the redacted string, or the original input if not a string.
 */
export function redactSecrets(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return redacted;
}

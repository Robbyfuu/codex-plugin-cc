/**
 * Peer companion environment namespace.
 *
 * Peer owns the PEER_* names. The legacy CODEX_COMPANION_* / CLAUDE_PLUGIN_DATA
 * names are accepted only as backwards-compatible fallbacks so existing setups
 * keep working, but a peer-specific value always wins when both are present.
 */

export const PEER_ENV = Object.freeze({
  PLUGIN_DATA: "PEER_PLUGIN_DATA",
  SESSION_ID: "PEER_COMPANION_SESSION_ID",
  TRANSCRIPT_PATH: "PEER_COMPANION_TRANSCRIPT_PATH",
  BROKER_ENDPOINT: "PEER_COMPANION_APP_SERVER_ENDPOINT",
  PID_FILE: "PEER_COMPANION_APP_SERVER_PID_FILE",
  LOG_FILE: "PEER_COMPANION_APP_SERVER_LOG_FILE",
  SHUTDOWN_TIMEOUT: "PEER_COMPANION_SHUTDOWN_TIMEOUT_MS",
  IDLE_TIMEOUT: "PEER_COMPANION_IDLE_TIMEOUT_MS",
  MAX_TURN: "PEER_COMPANION_MAX_TURN_MS",
  REQUEST_TIMEOUT: "PEER_COMPANION_REQUEST_TIMEOUT_MS",
  NOTIFY: "PEER_COMPANION_NOTIFY",
  NOTIFY_CHANNELS: "PEER_COMPANION_NOTIFY_CHANNELS",
  WATCH_PANE: "PEER_COMPANION_WATCH_PANE",
  STALE_DAYS: "PEER_COMPANION_DOCTOR_STALE_DAYS"
});

export const LEGACY_ENV = Object.freeze({
  PLUGIN_DATA: "CLAUDE_PLUGIN_DATA",
  SESSION_ID: "CODEX_COMPANION_SESSION_ID",
  TRANSCRIPT_PATH: "CODEX_COMPANION_TRANSCRIPT_PATH",
  BROKER_ENDPOINT: "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  PID_FILE: "CODEX_COMPANION_APP_SERVER_PID_FILE",
  LOG_FILE: "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  SHUTDOWN_TIMEOUT: "CODEX_COMPANION_SHUTDOWN_TIMEOUT_MS",
  IDLE_TIMEOUT: "CODEX_COMPANION_IDLE_TIMEOUT_MS",
  MAX_TURN: "CODEX_COMPANION_MAX_TURN_MS",
  REQUEST_TIMEOUT: "CODEX_COMPANION_REQUEST_TIMEOUT_MS",
  NOTIFY: "CODEX_COMPANION_NOTIFY",
  NOTIFY_CHANNELS: "CODEX_COMPANION_NOTIFY_CHANNELS",
  WATCH_PANE: "CODEX_COMPANION_WATCH_PANE",
  STALE_DAYS: "CODEX_COMPANION_DOCTOR_STALE_DAYS"
});

export const PLUGIN_DATA_ENV = PEER_ENV.PLUGIN_DATA;
export const SESSION_ID_ENV = PEER_ENV.SESSION_ID;
export const TRANSCRIPT_PATH_ENV = PEER_ENV.TRANSCRIPT_PATH;
export const BROKER_ENDPOINT_ENV = PEER_ENV.BROKER_ENDPOINT;
export const PID_FILE_ENV = PEER_ENV.PID_FILE;
export const LOG_FILE_ENV = PEER_ENV.LOG_FILE;
export const SHUTDOWN_TIMEOUT_ENV = PEER_ENV.SHUTDOWN_TIMEOUT;
export const IDLE_TIMEOUT_ENV = PEER_ENV.IDLE_TIMEOUT;
export const MAX_TURN_ENV = PEER_ENV.MAX_TURN;
export const REQUEST_TIMEOUT_ENV = PEER_ENV.REQUEST_TIMEOUT;
export const NOTIFY_ENV = PEER_ENV.NOTIFY;
export const NOTIFY_CHANNELS_ENV = PEER_ENV.NOTIFY_CHANNELS;
export const WATCH_PANE_ENV = PEER_ENV.WATCH_PANE;
export const STALE_DAYS_ENV = PEER_ENV.STALE_DAYS;

export const FALLBACK_STATE_ROOT_DIR_NAME = "peer-companion";

function hasOwnEnv(env, name) {
  return Boolean(env) && Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined;
}

/**
 * Read a companion-owned environment value with peer-first precedence.
 *
 * Fallback happens only when the peer variable is absent. An intentionally empty
 * peer value still wins over a legacy value, matching normal process.env
 * semantics where presence and truthiness are different concerns.
 *
 * @param {keyof typeof PEER_ENV} key
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function readCompanionEnv(key, env = process.env) {
  const peerName = PEER_ENV[key];
  if (!peerName) {
    throw new Error(`Unknown companion env key: ${String(key)}`);
  }
  if (hasOwnEnv(env, peerName)) {
    return env[peerName];
  }

  const legacyName = LEGACY_ENV[key];
  if (legacyName && hasOwnEnv(env, legacyName)) {
    return env[legacyName];
  }

  return undefined;
}

/**
 * Read a companion-owned environment value across multiple env bags.
 *
 * Any peer-specific variable in any provided env bag wins over any legacy
 * fallback. Within the same namespace, earlier env bags win. This prevents a
 * legacy upstream value from hijacking peer when an ambient peer value exists.
 *
 * @param {keyof typeof PEER_ENV} key
 * @param {...(NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined)} envs
 * @returns {string | undefined}
 */
export function readCompanionEnvFrom(key, ...envs) {
  const peerName = PEER_ENV[key];
  if (!peerName) {
    throw new Error(`Unknown companion env key: ${String(key)}`);
  }
  for (const env of envs) {
    if (env && hasOwnEnv(env, peerName)) {
      return env[peerName];
    }
  }

  const legacyName = LEGACY_ENV[key];
  for (const env of envs) {
    if (env && legacyName && hasOwnEnv(env, legacyName)) {
      return env[legacyName];
    }
  }
  return undefined;
}

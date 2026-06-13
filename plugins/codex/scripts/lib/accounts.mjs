import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolvePluginDataRoot } from "./state.mjs";

// Multi-account support, CODEX_HOME-backed.
//
// Codex stores ONE auth per CODEX_HOME (auth.json) and has no native
// multi-account switch. This module owns a GLOBAL (not per-workspace) registry
// of named CODEX_HOMEs at <pluginDataRoot>/accounts.json (sibling of state/),
// and exposes resolveCodexEnv() — the SINGLE injection point that threads the
// active account's CODEX_HOME into every codex spawn. With no active account,
// resolveCodexEnv returns the caller's env UNCHANGED (byte-for-byte today's
// single-account behavior), so existing users see no change.
//
// The interactive `codex login` (OpenAI OAuth, opens a browser) is unavoidable
// and stays manual: addAccount only prepares the home dir and emits a
// one-paste `CODEX_HOME=<home> codex login` command for the user to run.

const ACCOUNTS_VERSION = 1;
const ACCOUNTS_FILE_NAME = "accounts.json";
const DEFAULT_ACCOUNT_NAME = "default";

function defaultHome() {
  // The pre-existing account: codex's own default CODEX_HOME.
  return path.join(os.homedir(), ".codex");
}

function seededDefault() {
  return {
    version: ACCOUNTS_VERSION,
    active: null,
    accounts: [{ name: DEFAULT_ACCOUNT_NAME, home: defaultHome() }]
  };
}

export function resolveAccountsFile({ env = process.env } = {}) {
  return path.join(resolvePluginDataRoot(env), ACCOUNTS_FILE_NAME);
}

function normalizeConfig(parsed) {
  // Defensive normalization: a malformed shape must never throw, and the
  // pre-existing default account must always be representable.
  const accounts = Array.isArray(parsed?.accounts)
    ? parsed.accounts.filter(
        (entry) => entry && typeof entry.name === "string" && typeof entry.home === "string"
      )
    : [];
  if (!accounts.some((entry) => entry.name === DEFAULT_ACCOUNT_NAME)) {
    accounts.unshift({ name: DEFAULT_ACCOUNT_NAME, home: defaultHome() });
  }
  const activeIsKnown =
    typeof parsed?.active === "string" && accounts.some((entry) => entry.name === parsed.active);
  return {
    version: ACCOUNTS_VERSION,
    active: activeIsKnown ? parsed.active : null,
    accounts
  };
}

export function loadAccounts({ env = process.env, fsImpl = fs } = {}) {
  const file = resolveAccountsFile({ env });
  if (!fsImpl.existsSync(file)) {
    return seededDefault();
  }
  try {
    return normalizeConfig(JSON.parse(fsImpl.readFileSync(file, "utf8")));
  } catch {
    // Malformed file -> safe default; a corrupt registry must never break a turn.
    return seededDefault();
  }
}

export function saveAccounts(config, { env = process.env, fsImpl = fs } = {}) {
  const file = resolveAccountsFile({ env });
  const dir = path.dirname(file);
  // Match the 0700 state-dir discipline. accounts.json names home paths (not
  // secrets), but the home dirs it points at hold auth.json, so keep it tight.
  // Best-effort: a mkdir/chmod failure must never break the write of the file
  // the caller asked us to persist.
  try {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }
  try {
    fsImpl.chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  fsImpl.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

function defaultHomeForName(name) {
  return path.join(os.homedir(), `.codex-${name}`);
}

function buildLoginCommand(home) {
  // The one-time, manual OAuth login the user pastes once per account. The
  // plugin never runs this (the browser flow is impossible from a hook).
  return `CODEX_HOME=${home} codex login`;
}

export function addAccount(name, { home } = {}, { env = process.env, fsImpl = fs } = {}) {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) {
    throw new Error("An account name is required: account add <name> [--home <path>]");
  }
  const config = loadAccounts({ env, fsImpl });
  if (config.accounts.some((entry) => entry.name === trimmedName)) {
    throw new Error(`Account "${trimmedName}" already exists.`);
  }
  const resolvedHome = home ? path.resolve(home) : defaultHomeForName(trimmedName);

  // Create the home dir 0700 so codex can write auth.json into a tight dir.
  // Best-effort: registration must still succeed if the dir cannot be created.
  try {
    fsImpl.mkdirSync(resolvedHome, { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }

  const account = { name: trimmedName, home: resolvedHome };
  config.accounts.push(account);
  saveAccounts(config, { env, fsImpl });
  return { account, loginCommand: buildLoginCommand(resolvedHome) };
}

export function useAccount(name, { env = process.env, fsImpl = fs } = {}) {
  const trimmedName = String(name ?? "").trim();
  const config = loadAccounts({ env, fsImpl });
  if (!config.accounts.some((entry) => entry.name === trimmedName)) {
    throw new Error(`Unknown account "${trimmedName}". Run "account list" to see registered accounts.`);
  }
  config.active = trimmedName;
  saveAccounts(config, { env, fsImpl });
  return config;
}

export function listAccounts({ env = process.env, fsImpl = fs } = {}) {
  const config = loadAccounts({ env, fsImpl });
  return config.accounts.map((entry) => ({
    name: entry.name,
    home: entry.home,
    active: entry.name === config.active
  }));
}

export function resolveActiveCodexHome({ env = process.env, fsImpl = fs } = {}) {
  const config = loadAccounts({ env, fsImpl });
  if (!config.active) {
    return null;
  }
  const active = config.accounts.find((entry) => entry.name === config.active);
  return active ? active.home : null;
}

// THE single injection point. Every codex spawn path threads its env through
// here. When an account is active, CODEX_HOME is set on a fresh copy of the
// base env. When none is active, the SAME base env reference is returned
// unchanged — proving (by identity) that single-account users see today's
// behavior exactly.
export function resolveCodexEnv(baseEnv = process.env, { fsImpl = fs } = {}) {
  const activeHome = resolveActiveCodexHome({ env: baseEnv, fsImpl });
  if (!activeHome) {
    return baseEnv;
  }
  return { ...baseEnv, CODEX_HOME: activeHome };
}

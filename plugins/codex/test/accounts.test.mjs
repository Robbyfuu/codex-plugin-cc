import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addAccount,
  listAccounts,
  loadAccounts,
  resolveAccountsFile,
  resolveActiveCodexHome,
  resolveCodexEnv,
  saveAccounts,
  useAccount
} from "../scripts/lib/accounts.mjs";

// An in-memory fs seam so the tests never touch the real filesystem. It models
// the small surface accounts.mjs uses: existsSync, readFileSync, writeFileSync,
// mkdirSync, chmodSync.
function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    writeFileSync: (p, data) => {
      files.set(p, String(data));
    },
    mkdirSync: (p) => {
      dirs.add(p);
    },
    chmodSync: () => {}
  };
}

const ENV = { CLAUDE_PLUGIN_DATA: "/data" };

test("resolveAccountsFile lives at the plugin data root, sibling of state/", () => {
  const file = resolveAccountsFile({ env: ENV });
  assert.equal(file, "/data/accounts.json");
});

test("loadAccounts seeds a default account pointing at ~/.codex when absent", () => {
  const fsImpl = createMemoryFs();
  const config = loadAccounts({ env: ENV, fsImpl });
  assert.equal(config.version, 1);
  assert.equal(config.active, null);
  assert.equal(config.accounts.length, 1);
  assert.equal(config.accounts[0].name, "default");
  assert.ok(config.accounts[0].home.endsWith(".codex"));
});

test("addAccount registers an account with a default ~/.codex-<name> home", () => {
  const fsImpl = createMemoryFs();
  const result = addAccount("work", {}, { env: ENV, fsImpl });
  assert.equal(result.account.name, "work");
  assert.ok(result.account.home.endsWith(".codex-work"));
  // The home dir is created 0700, like the state dir convention.
  assert.ok(fsImpl.dirs.has(result.account.home));
  // The login command is emitted for the user to paste — never run here.
  assert.equal(result.loginCommand, `CODEX_HOME=${result.account.home} codex login`);

  const reloaded = loadAccounts({ env: ENV, fsImpl });
  assert.ok(reloaded.accounts.some((a) => a.name === "work"));
});

test("addAccount honors an explicit --home path", () => {
  const fsImpl = createMemoryFs();
  const result = addAccount("alt", { home: "/custom/home" }, { env: ENV, fsImpl });
  assert.equal(result.account.home, "/custom/home");
  assert.equal(result.loginCommand, "CODEX_HOME=/custom/home codex login");
});

test("addAccount rejects a duplicate name", () => {
  const fsImpl = createMemoryFs();
  addAccount("work", {}, { env: ENV, fsImpl });
  assert.throws(() => addAccount("work", {}, { env: ENV, fsImpl }), /already exists/i);
});

test("addAccount requires a name", () => {
  const fsImpl = createMemoryFs();
  assert.throws(() => addAccount("", {}, { env: ENV, fsImpl }), /name/i);
});

test("useAccount sets active and rejects an unknown account", () => {
  const fsImpl = createMemoryFs();
  addAccount("work", {}, { env: ENV, fsImpl });
  const config = useAccount("work", { env: ENV, fsImpl });
  assert.equal(config.active, "work");

  const reloaded = loadAccounts({ env: ENV, fsImpl });
  assert.equal(reloaded.active, "work");

  assert.throws(() => useAccount("ghost", { env: ENV, fsImpl }), /unknown account/i);
});

test("listAccounts reflects the active marker", () => {
  const fsImpl = createMemoryFs();
  addAccount("work", {}, { env: ENV, fsImpl });
  useAccount("work", { env: ENV, fsImpl });
  const accounts = listAccounts({ env: ENV, fsImpl });
  const work = accounts.find((a) => a.name === "work");
  const def = accounts.find((a) => a.name === "default");
  assert.equal(work.active, true);
  assert.equal(def.active, false);
});

test("resolveActiveCodexHome returns the active home, or null when none is active", () => {
  const fsImpl = createMemoryFs();
  assert.equal(resolveActiveCodexHome({ env: ENV, fsImpl }), null);
  const { account } = addAccount("work", { home: "/homes/work" }, { env: ENV, fsImpl });
  // Still null until a use.
  assert.equal(resolveActiveCodexHome({ env: ENV, fsImpl }), null);
  useAccount("work", { env: ENV, fsImpl });
  assert.equal(resolveActiveCodexHome({ env: ENV, fsImpl }), account.home);
});

test("resolveCodexEnv injects CODEX_HOME when an account is active", () => {
  const fsImpl = createMemoryFs();
  addAccount("work", { home: "/homes/work" }, { env: ENV, fsImpl });
  useAccount("work", { env: ENV, fsImpl });
  const baseEnv = { ...ENV, PATH: "/usr/bin" };
  const resolved = resolveCodexEnv(baseEnv, { fsImpl });
  assert.equal(resolved.CODEX_HOME, "/homes/work");
  assert.equal(resolved.PATH, "/usr/bin");
  // A fresh object — never a mutation of the caller's env.
  assert.notEqual(resolved, baseEnv);
});

test("resolveCodexEnv returns the base env UNCHANGED when no account is active (back-compat)", () => {
  const fsImpl = createMemoryFs();
  // No accounts file at all -> default seeded, no active.
  const baseEnv = { ...ENV, PATH: "/usr/bin" };
  const resolved = resolveCodexEnv(baseEnv, { fsImpl });
  // Byte-for-byte the same reference: today's single-account behavior is untouched.
  assert.equal(resolved, baseEnv);
});

test("resolveCodexEnv leaves env unchanged when the active account is the default ~/.codex... wait, default IS active-able", () => {
  // Sanity: activating the seeded default still injects its home explicitly,
  // which equals ~/.codex — harmless and explicit.
  const fsImpl = createMemoryFs();
  useAccount("default", { env: ENV, fsImpl });
  const baseEnv = { ...ENV };
  const resolved = resolveCodexEnv(baseEnv, { fsImpl });
  assert.ok(resolved.CODEX_HOME.endsWith(".codex"));
});

test("accounts.json round-trips through save/load", () => {
  const fsImpl = createMemoryFs();
  const config = {
    version: 1,
    active: "work",
    accounts: [
      { name: "default", home: "/home/.codex" },
      { name: "work", home: "/home/.codex-work" }
    ]
  };
  saveAccounts(config, { env: ENV, fsImpl });
  const reloaded = loadAccounts({ env: ENV, fsImpl });
  assert.deepEqual(reloaded, config);
});

test("a malformed accounts.json falls back to a safe default instead of throwing", () => {
  const fsImpl = createMemoryFs({ "/data/accounts.json": "{ not json" });
  const config = loadAccounts({ env: ENV, fsImpl });
  assert.equal(config.version, 1);
  assert.equal(config.active, null);
  assert.ok(Array.isArray(config.accounts));
  assert.ok(config.accounts.some((a) => a.name === "default"));
});

test("resolveCodexEnv with a malformed accounts.json returns base env unchanged", () => {
  const fsImpl = createMemoryFs({ "/data/accounts.json": "garbage" });
  const baseEnv = { ...ENV, PATH: "/usr/bin" };
  const resolved = resolveCodexEnv(baseEnv, { fsImpl });
  assert.equal(resolved, baseEnv);
});

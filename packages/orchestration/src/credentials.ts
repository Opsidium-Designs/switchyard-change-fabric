/**
 * credentials: the run's secrets, held in memory, never in a process environment.
 *
 * A process's INITIAL environment is readable by any process of the same OS
 * user (`/proc/<pid>/environ` on Linux), so a credential exported into the
 * CLI's environment (for example by a Makefile sourcing `.env` with `set -a`)
 * could be read by any code the CLI runs: an app gate, an agent-built tool, or
 * their children reading their parent's environ. So the CLI does not receive
 * secrets through its environment: it reads `.env` itself (this small parser,
 * no dependency) into an in-memory store, and the code that needs a credential
 * reads it from `runtimeEnv()`. Values set at runtime never appear in the
 * process's `/proc/<pid>/environ`, and every gate, tool, install, and git child
 * gets an allowlisted environment that never carries a credential.
 *
 * Residual risk: `.env` itself is still a file the OS user can read by
 * absolute path, so same-user code on this machine can still read it; the
 * cloud gate container (a separate user, no such file) avoids that.
 */

import { readFileSync } from "node:fs";

/** Environment names that hold, or can locate, a credential (matched case-insensitively). */
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION|BEARER|ACCOUNT_ID|COOKIE)/i;

/** Names that look credential-shaped but are not secrets (for example token-count settings). */
const NOT_CREDENTIAL: ReadonlySet<string> = new Set([
  "AI_GATEWAY_MAX_TOKENS",
  "WORKERS_AI_MAX_TOKENS",
  "AI_GATEWAY_AGENT_MAX_TOKENS",
  "AI_GATEWAY_EXECUTOR_MAX_TOKENS",
  "AI_GATEWAY_EXECUTOR_REASONING_MAX_TOKENS",
  "AI_GATEWAY_PLANNER_MAX_TOKENS",
  "AI_GATEWAY_PLANNER_REASONING_MAX_TOKENS",
]);

/** Credentials whose name does not say so. */
const KNOWN_CREDENTIALS: ReadonlySet<string> = new Set(["AI_GATEWAY_URL", "CLOUDFLARE_ACCOUNT_ID"]);

/** True for an environment name that holds (or locates) a credential. */
export function isCredentialKey(name: string): boolean {
  // A gateway URL carries the account id.
  return KNOWN_CREDENTIALS.has(name) || /GATEWAY_URL$/i.test(name) || (CREDENTIAL_NAME.test(name) && !NOT_CREDENTIAL.has(name));
}

/** The credential names present in an environment (names only, never values). */
export function credentialKeysIn(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== "" && isCredentialKey(k))
    .sort();
}

/** An environment without any credential (for a child that must not see one). */
export function withoutCredentials(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isCredentialKey(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Parse a `.env` file: `KEY=VALUE` lines, an optional leading `export`, `#`
 * comments, and single- or double-quoted values (double quotes understand
 * `\n` and `\"`). Nothing is expanded or executed.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2]!;
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      const body = end === -1 ? value.slice(1) : value.slice(1, end);
      value = body.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]!] = value;
  }
  return out;
}

/** Read and parse a `.env` file, or undefined when it does not exist. */
export function loadDotEnvFile(path: string): Record<string, string> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseDotEnv(text);
}

/** The values loaded from `.env` (in memory only). */
let loaded: Record<string, string> = {};

/**
 * Hold values read from `.env` in memory. A value already in the process
 * environment (the operator set it explicitly) wins.
 */
export function setRuntimeCredentials(values: Readonly<Record<string, string>>): void {
  loaded = { ...values };
}

/** Values the CLI set from its own flags (for example --inference); they win over everything. */
let overrides: Record<string, string> = {};

/**
 * Hold values a command-line flag set (for example `--inference claude-cli`
 * sets SWITCHYARD_INFERENCE). They win over the process environment and
 * `.env`, so an explicit flag always decides. In memory only, like `.env`.
 */
export function setRuntimeOverrides(values: Readonly<Record<string, string>>): void {
  overrides = { ...values };
}

/** The names loaded from `.env` (names only). */
export function runtimeCredentialNames(): string[] {
  return Object.keys(loaded).sort();
}

/**
 * The environment the CLI's own code reads configuration and credentials
 * from: the process environment over the values loaded from `.env`, with any
 * flag overrides (setRuntimeOverrides) on top. Never
 * pass this to a child process wholesale.
 */
export function runtimeEnv(): Record<string, string | undefined> {
  return { ...loaded, ...process.env, ...overrides };
}

/**
 * The credential names in THIS process's initial environment, as any
 * same-user process sees it (`/proc/self/environ` on Linux; elsewhere the
 * environment at startup, captured before anything was loaded).
 */
export function initialEnvironmentCredentialKeys(startup: Readonly<Record<string, string | undefined>> = process.env): string[] {
  try {
    const raw = readFileSync("/proc/self/environ", "utf8");
    const names = raw
      .split("\0")
      .filter((e) => e.includes("="))
      .map((e) => e.slice(0, e.indexOf("=")));
    return [...new Set(names.filter(isCredentialKey))].sort();
  } catch {
    return credentialKeysIn(startup);
  }
}

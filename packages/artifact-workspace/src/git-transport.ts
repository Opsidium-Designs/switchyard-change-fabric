/**
 * The one way the fabric runs git: a hardened invocation that never puts a
 * credential on a command line and never reads configuration other code could
 * have planted.
 *
 * Callers keep handing around clone/push URLs that carry a repo-scoped token
 * as their userinfo (`https://token:<secret>@host/repo.git`, what
 * `authenticatedRemote` builds). `runGit` strips that userinfo from every
 * argument before git starts and supplies the token as an
 * `Authorization: Bearer` header scoped to that repo URL, through the
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` environment,
 * so the token is never in git's argv (`/proc/<pid>/cmdline`), in a URL git
 * could echo in an error, or in a config file.
 *
 * Every invocation also runs with:
 *   - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`: no system or
 *     user config (so a `~/.gitconfig` a test or gate planted, for example a
 *     `pushInsteadOf` that redirects the push, is never read);
 *   - a fresh, private, empty HOME (and XDG_CONFIG_HOME) per call, removed
 *     after;
 *   - `GIT_TERMINAL_PROMPT=0`, no credential helper, hooks and fsmonitor off,
 *     and the `ext::` transport refused.
 *
 * A credentialed call in an existing repository (`-C <dir>`) first refuses if
 * that repository's own config carries a key that could redirect the
 * transfer or run a program (`url.*.insteadOf`, `include`, `credential.*`,
 * `http.*`, ...): an additive key like `insteadOf` cannot be overridden from
 * the command line, so its presence is an error, not something to ignore.
 *
 * Same-user isolation is not complete: a process running as the same OS user
 * can still read the environment of a running git (`/proc/<pid>/environ`).
 * Callers kill a command's whole process group when it ends, which removes a
 * gate's ordinary leftover children; a child that escaped with `setsid`
 * survives, and full isolation needs a separate user or container.
 *
 * Node only (the CLI, the local runner, tests), never a Worker.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Options for one hardened git invocation. */
export interface RunGitOptions {
  /** Extra environment (for example GIT_INDEX_FILE); never a credential. */
  readonly env?: Readonly<Record<string, string>>;
  readonly maxBuffer?: number;
  /** Kill git (SIGKILL) after this many milliseconds; the call then rejects. Unset: no limit. */
  readonly timeoutMs?: number;
}

/** What git printed. */
export interface RunGitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** A URL with its userinfo removed, and the credential that was in it. */
export interface SplitCredential {
  readonly url: string;
  readonly token?: string;
}

const USERINFO = /^(https?:\/\/)([^/@\s]*)@/i;

/**
 * Split `https://user:secret@host/x` into `https://host/x` and `secret` (the
 * password; the user name when there is no password). Any other string comes
 * back unchanged with no token.
 */
export function splitCredential(value: string): SplitCredential {
  const match = USERINFO.exec(value);
  if (!match) {
    return { url: value };
  }
  const url = `${match[1]}${value.slice(match[0].length)}`;
  const userinfo = match[2] ?? "";
  const colon = userinfo.indexOf(":");
  const raw = colon >= 0 ? userinfo.slice(colon + 1) : userinfo;
  let token = raw;
  try {
    token = decodeURIComponent(raw);
  } catch {
    // keep the raw value
  }
  return token === "" ? { url } : { url, token };
}

/** Local config keys that could redirect a credentialed transfer or run a program. */
const UNSAFE_LOCAL_KEY =
  /^(url\..*\.(insteadof|pushinsteadof)|include\.|includeif\.|credential\.|credential$|http\.|core\.(askpass|sshcommand|gitproxy|hookspath|fsmonitor|alternaterefscommand)$|remote\..*\.(pushurl|proxy|uploadpack|receivepack)$|protocol\.)/;

/** The fixed configuration every invocation runs with (command-line precedence). */
const BASE_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
  ["credential.helper", ""],
];

/** The minimal environment of a hardened git process. */
function baseEnv(home: string): NodeJS.ProcessEnv {
  const passed: NodeJS.ProcessEnv = {};
  // Reproducibility only (the offline demo pins commit dates); never a credential.
  for (const key of ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE", "TZ", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) {
      passed[key] = process.env[key];
    }
  }
  return {
    ...passed,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
}

function configEnv(entries: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The repository a `-C <dir>` argument list runs in, if any. */
function repoDirOf(args: readonly string[]): string | undefined {
  let dir: string | undefined;
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "-C") {
      dir = args[i + 1];
    }
  }
  return dir;
}

async function spawnGit(
  args: readonly string[],
  config: readonly (readonly [string, string])[],
  options: RunGitOptions,
): Promise<RunGitResult> {
  const home = await mkdtemp(join(tmpdir(), "scf-git-home-"));
  try {
    const env: NodeJS.ProcessEnv = { ...options.env, ...baseEnv(home), ...configEnv(config) };
    const { stdout, stderr } = await exec("git", [...args], {
      env,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    return { stdout, stderr };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Run git hardened (see the module comment). Arguments may carry
 * `https://user:token@...` URLs; the token leaves them before git starts.
 */
export async function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<RunGitResult> {
  const config: (readonly [string, string])[] = [...BASE_CONFIG];
  const tokens: string[] = [];
  const clean = args.map((arg) => {
    const { url, token } = splitCredential(arg);
    if (token !== undefined) {
      tokens.push(token);
      config.push([`http.${url}.extraHeader`, `Authorization: Bearer ${token}`]);
    }
    return url;
  });
  if (tokens.length > 0) {
    const repo = repoDirOf(clean);
    if (repo !== undefined) {
      await assertNoRedirectConfig(repo);
    }
  }
  try {
    return await spawnGit(clean, config, options);
  } catch (error) {
    throw scrubbed(error, tokens);
  }
}

/** Refuse a repository whose own config could redirect a credentialed transfer. */
async function assertNoRedirectConfig(repo: string): Promise<void> {
  let listed = "";
  try {
    listed = (await spawnGit(["-C", repo, "config", "--local", "--name-only", "--list"], BASE_CONFIG, {})).stdout;
  } catch {
    // Not a repository (yet), or no local config: nothing to refuse.
    return;
  }
  const unsafe = listed
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((key) => key !== "" && UNSAFE_LOCAL_KEY.test(key));
  if (unsafe.length > 0) {
    throw new Error(
      `refusing a credentialed git operation in ${repo}: its config sets ${[...new Set(unsafe)].join(", ")}, ` +
        "which could redirect the transfer or run a program",
    );
  }
}

/** The same error with every token removed from its message and output. */
function scrubbed(error: unknown, tokens: readonly string[]): unknown {
  if (tokens.length === 0 || typeof error !== "object" || error === null) {
    return error;
  }
  const scrub = (text: unknown): unknown =>
    typeof text === "string" ? tokens.reduce((t, token) => t.split(token).join("[redacted]"), text) : text;
  const e = error as { message?: unknown; stdout?: unknown; stderr?: unknown; cmd?: unknown };
  for (const key of ["message", "stdout", "stderr", "cmd"] as const) {
    if (key in e) {
      try {
        (e as Record<string, unknown>)[key] = scrub(e[key]);
      } catch {
        // read-only property: leave it
      }
    }
  }
  return error;
}

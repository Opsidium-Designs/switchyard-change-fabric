/**
 * A small injectable command runner used by verification checks.
 *
 * Checks (the configured test command, the optional lint command) run as plain
 * argv in a working directory and report an exit code plus captured output. The
 * runner is injectable so tests can supply a deterministic fake and never shell
 * out, while production uses a real child-process runner. Nothing here calls a
 * model: a check's outcome is a pure function of the command and the checkout.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The outcome of running one command. */
export interface CommandOutcome {
  /** Process exit code; 0 means success. A non-zero or null code is a failure. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs an argv command in a working directory and captures its output. */
export interface CommandRunner {
  run(argv: readonly string[], cwd: string): Promise<CommandOutcome>;
}

/** Largest captured output kept per stream, so evidence stays bounded. */
export const MAX_CAPTURED_CHARS = 4000;

/** Trim and length-bound captured text so evidence is small and stable. */
export function boundOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CAPTURED_CHARS) {
    return trimmed;
  }
  const head = trimmed.slice(0, MAX_CAPTURED_CHARS);
  return `${head}\n...[truncated ${trimmed.length - MAX_CAPTURED_CHARS} chars]`;
}

/** Environment variables a checked command may see (exact names). None of them is a credential. */
const ALLOWED_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "SHELL",
  "NODE_ENV",
  "CI",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
  "npm_config_offline",
  "NPM_CONFIG_OFFLINE",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "GOPROXY",
  "GOFLAGS",
  "CARGO_HOME",
  "RUSTUP_HOME",
]);

/**
 * The environment a gate, test, lint, or typecheck command runs with: an
 * ALLOWLIST of the parent's variables (PATH, HOME, user, locale, CI, NODE_ENV,
 * proxy and CA settings, the package-manager cache and toolchain locations)
 * plus a private temp dir. The command runs code agents wrote, so it never
 * sees a credential: no API token, gateway token, account id, bearer, or
 * anything else not on the list.
 *
 * Residual risk (not addressed by env filtering): the command can still READ
 * files the OS user can read (HOME dotfiles, an absolute path such as a repo's
 * gitignored .env). The real fix is a sandbox (a separate user or container),
 * which is out of scope for this spike.
 */
export function gateEnvironment(parent: NodeJS.ProcessEnv = process.env, tempDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (ALLOWED_ENV.has(key) || key.startsWith("LC_"))) {
      env[key] = value;
    }
  }
  if (tempDir !== undefined) {
    env.TMPDIR = tempDir;
    env.TMP = tempDir;
    env.TEMP = tempDir;
  }
  return env;
}

/** The default limit on one checked command's run time (10 minutes). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** The default limit on one checked command's captured output per stream (16 MiB). */
export const DEFAULT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

/** Options for the child-process runner. */
export interface ChildProcessCommandRunnerOptions {
  /** Kill a command (and every process it started) that runs longer than this (default 10 minutes). */
  readonly timeoutMs?: number;
  /** Kill a command whose output exceeds this many bytes on either stream (default 16 MiB). */
  readonly maxBuffer?: number;
  /** The parent environment to allowlist from (default process.env). */
  readonly parentEnv?: NodeJS.ProcessEnv;
}

/**
 * The default runner: execute the argv as a child process. A non-zero exit is
 * reported as a CommandOutcome (not thrown), so a failing test command becomes
 * a failed check rather than an exception. The command sees only the
 * allowlisted environment (`gateEnvironment`) with a private temp dir made for
 * this run (removed afterwards). It runs in its own process group: at the
 * timeout, or when its output exceeds the buffer, the whole group (every
 * process it started) is killed and the outcome says which; when the command
 * exits normally, whatever it left running in its group is killed too.
 */
export class ChildProcessCommandRunner implements CommandRunner {
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(private readonly options: ChildProcessCommandRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_COMMAND_MAX_BUFFER;
  }

  async run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const [program, ...args] = argv;
    if (program === undefined) {
      return { code: null, stdout: "", stderr: "empty command" };
    }
    const temp = await mkdtemp(join(tmpdir(), "scf-cmd-"));
    try {
      return await this.spawnIn(program, args, cwd, gateEnvironment(this.options.parentEnv ?? process.env, temp));
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawnIn(program: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandOutcome> {
    return new Promise((resolve) => {
      const child = spawn(program, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let stopped: string | undefined;
      const killGroup = (why: string) => {
        if (stopped !== undefined) {
          return;
        }
        stopped = why;
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      };
      // When the command itself ends, nothing it started may outlive it: kill
      // the rest of its process group (a child left running in the background
      // could otherwise watch later git operations). A child that left the
      // group with setsid escapes this; full isolation needs a separate user
      // or container.
      const reapGroup = () => {
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // ESRCH: the group is already gone.
        }
      };
      child.on("exit", reapGroup);
      const timer = setTimeout(() => killGroup(`command timed out after ${this.timeoutMs} ms and was stopped`), this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > this.maxBuffer) {
          killGroup(`command output exceeded ${this.maxBuffer} bytes and the command was stopped`);
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > this.maxBuffer) {
          killGroup(`command output exceeded ${this.maxBuffer} bytes and the command was stopped`);
          return;
        }
        err.push(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        // Spawn failure (for example the program was not found).
        resolve({ code: null, stdout: Buffer.concat(out).toString("utf8"), stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        reapGroup();
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        if (stopped !== undefined) {
          resolve({ code: null, stdout, stderr: `${stderr}\n${stopped}`.trim() });
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });
  }
}

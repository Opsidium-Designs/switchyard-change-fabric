/**
 * Dependency install before a gate runs.
 *
 * Every tree a gate runs on (an integration checkout, a unit checkout, the
 * baseline inventory run, a ladder preview) is a fresh Git clone with no
 * installed dependencies, so a gate that needs its toolchain (a test runner, a
 * type checker) could never pass, even on a correct fix. This step installs
 * the dependencies the GATED TREE declares, in the gate's directory, before
 * the gate runs. It is goal-agnostic: it reads only lockfiles and manifests.
 *
 *   package-lock.json / npm-shrinkwrap.json  npm ci --ignore-scripts --no-audit --no-fund --prefer-offline
 *   pnpm-lock.yaml                           pnpm install --frozen-lockfile --ignore-scripts (pnpm on PATH only)
 *   yarn.lock                                yarn install --frozen-lockfile --ignore-scripts (yarn on PATH only)
 *   bun.lockb / bun.lock                     unsupported (stated, not attempted)
 *   package.json without a lockfile          skipped: an unlocked install is not deterministic
 *   requirements.txt / pyproject.toml        unsupported for python yet (stated, not attempted)
 *   go.mod                                   skipped: go fetches modules when the gate runs (needs network)
 *
 * Install scripts never run (`--ignore-scripts`): they would execute repo code
 * before the gate, and the gate is where repo code runs. The install command
 * runs like any checked command: the allowlisted environment (no
 * credentials), its own process group, a timeout. A shared package cache
 * under the run's work root keeps repeated installs fast. An install that
 * fails makes the gate fail with "dependency install failed: <reason>" as its
 * first line; the gate itself does not run.
 */

import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";

import { abortedOutcome, ChildProcessCommandRunner, type CommandOutcome, type CommandRunner, type CommandRunOptions } from "./command.ts";

/** What the install step did for one tree. */
export type DependencyInstallStatus = "installed" | "skipped" | "unsupported" | "failed";

/** The outcome of the install step for one tree. */
export interface DependencyInstallOutcome {
  readonly status: DependencyInstallStatus;
  /** The tool that ran (npm, pnpm, yarn), when one ran. */
  readonly tool?: string;
  /** Why it was skipped or unsupported, or the failure reason (bounded, credential-free). */
  readonly detail: string;
  readonly durationMs: number;
}

/** Installs a tree's dependencies before a gate runs on it. */
export interface DependencyInstaller {
  /** Install for `dir`; `options.signal` aborts a running install (it then fails, never installs). */
  install(dir: string, options?: CommandRunOptions): Promise<DependencyInstallOutcome>;
}

/** The default limit on one install (5 minutes). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** The plan the lockfiles in a tree call for. */
export type DependencyInstallPlan =
  | { readonly kind: "run"; readonly tool: string; readonly argv: readonly string[] }
  | { readonly kind: "skipped" | "unsupported"; readonly detail: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether `program` is an executable on PATH. */
export async function programOnPath(program: string, path: string = process.env.PATH ?? ""): Promise<boolean> {
  for (const dir of path.split(delimiter).filter((d) => d !== "")) {
    try {
      await access(join(dir, program), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** Decide what to install in `dir` from its lockfiles and manifests (nothing runs). */
export async function planDependencyInstall(
  dir: string,
  hasProgram: (program: string) => Promise<boolean> = (p) => programOnPath(p),
): Promise<DependencyInstallPlan> {
  const has = (name: string) => exists(join(dir, name));
  if ((await has("package-lock.json")) || (await has("npm-shrinkwrap.json"))) {
    return { kind: "run", tool: "npm", argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"] };
  }
  if (await has("pnpm-lock.yaml")) {
    return (await hasProgram("pnpm"))
      ? { kind: "run", tool: "pnpm", argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] }
      : { kind: "unsupported", detail: "pnpm-lock.yaml found but pnpm is not on PATH: dependencies not installed" };
  }
  if (await has("yarn.lock")) {
    return (await hasProgram("yarn"))
      ? { kind: "run", tool: "yarn", argv: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"] }
      : { kind: "unsupported", detail: "yarn.lock found but yarn is not on PATH: dependencies not installed" };
  }
  if ((await has("bun.lockb")) || (await has("bun.lock"))) {
    return { kind: "unsupported", detail: "bun lockfile: dependency install with bun is not supported: dependencies not installed" };
  }
  if (await has("package.json")) {
    return { kind: "skipped", detail: "no lockfile: dependencies not installed (an unlocked install is not deterministic)" };
  }
  if ((await has("requirements.txt")) || (await has("pyproject.toml"))) {
    return { kind: "unsupported", detail: "dependency install not supported for python yet: dependencies not installed" };
  }
  if (await has("go.mod")) {
    return { kind: "skipped", detail: "go.mod: go fetches modules when the gate runs (needs network)" };
  }
  return { kind: "skipped", detail: "no dependency manifest" };
}

/** A short, credential-free reason from a failed install's output. */
function failureReason(outcome: CommandOutcome): string {
  const lines = `${outcome.stderr}\n${outcome.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const key = lines.filter((l) => /\b(error|ERR!|ERESOLVE|E404|ETIMEDOUT|ENOTFOUND|EUSAGE)\b/i.test(l)).slice(0, 3);
  const text = (key.length > 0 ? key : lines.slice(-3)).join(" | ") || `exit code ${String(outcome.code)}`;
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(_authToken|_auth|token|password)=\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}

/** Options for the lockfile-driven installer. */
export interface LockfileDependencyInstallerOptions {
  /** Runs the install command (default: a child process with the allowlisted env and `timeoutMs`). */
  readonly runner?: CommandRunner;
  /** Kill an install that runs longer than this (default 5 minutes). */
  readonly timeoutMs?: number;
  /** A package cache shared by every install of a run (npm_config_cache), so repeated installs are fast. */
  readonly cacheDir?: string;
  /** Whether a program is on PATH (injectable for tests). */
  readonly hasProgram?: (program: string) => Promise<boolean>;
  readonly now?: () => number;
}

/** Installs what a tree's lockfile declares; never installs an unlocked manifest. */
export class LockfileDependencyInstaller implements DependencyInstaller {
  private readonly runner: CommandRunner;
  private readonly now: () => number;

  constructor(private readonly options: LockfileDependencyInstallerOptions = {}) {
    this.runner =
      options.runner ??
      new ChildProcessCommandRunner({
        timeoutMs: options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        parentEnv: options.cacheDir !== undefined ? { ...process.env, npm_config_cache: options.cacheDir } : process.env,
      });
    this.now = options.now ?? Date.now;
  }

  async install(dir: string, options: CommandRunOptions = {}): Promise<DependencyInstallOutcome> {
    const started = this.now();
    const plan = await planDependencyInstall(dir, this.options.hasProgram);
    if (plan.kind !== "run") {
      return { status: plan.kind, detail: plan.detail, durationMs: this.now() - started };
    }
    const outcome = await this.runner.run(plan.argv, dir, options.signal ? { signal: options.signal } : {});
    const durationMs = this.now() - started;
    if (outcome.aborted) {
      return { status: "failed", tool: plan.tool, detail: `${plan.argv.slice(0, 2).join(" ")}: aborted (the run was interrupted)`, durationMs };
    }
    return outcome.code === 0
      ? { status: "installed", tool: plan.tool, detail: plan.argv.join(" "), durationMs }
      : { status: "failed", tool: plan.tool, detail: `${plan.argv.slice(0, 2).join(" ")}: ${failureReason(outcome)}`, durationMs };
  }
}

/** An installer that installs nothing (a fixture gate, or a caller that opts out). */
export const NO_DEPENDENCY_INSTALL: DependencyInstaller = {
  async install() {
    return { status: "skipped", detail: "dependency install disabled for this gate (it needs no dependencies)", durationMs: 0 };
  },
};

/** One line describing an install outcome, for summaries. */
export function formatDependencyInstall(outcome: DependencyInstallOutcome): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  return outcome.status === "installed"
    ? `installed (${outcome.detail}, ${seconds} s)`
    : `${outcome.status}: ${outcome.detail}${outcome.status === "failed" ? ` (${seconds} s)` : ""}`;
}

/** The first line a failed install puts in front of the gate's output. */
export function dependencyInstallFailureLine(outcome: DependencyInstallOutcome): string {
  return `dependency install failed: ${outcome.detail}`;
}

/**
 * A gate runner that installs a checkout's dependencies before the first
 * command it runs there. The install is keyed by the directory and the content
 * of its manifest and lockfiles, so a tree whose dependencies changed installs
 * again. A failed install fails the command without running it.
 */
export class InstallingCommandRunner implements CommandRunner {
  private readonly done = new Map<string, Promise<DependencyInstallOutcome>>();
  private last: DependencyInstallOutcome | undefined;

  constructor(
    private readonly inner: CommandRunner,
    private readonly installer: DependencyInstaller,
  ) {}

  /**
   * Install for `dir` (once per manifest content), returning the outcome. An
   * install the signal aborted is not remembered (a later run installs again).
   */
  async installFor(dir: string, options: CommandRunOptions = {}): Promise<DependencyInstallOutcome> {
    const key = `${dir}\0${await manifestHash(dir)}`;
    let found = this.done.get(key);
    if (found !== undefined && (await found).status === "installed" && !(await exists(join(dir, "node_modules")))) {
      found = undefined; // the tree was recreated: install again
    }
    if (found === undefined) {
      const signal = options.signal;
      found = this.installer.install(dir, signal ? { signal } : {});
      this.done.set(key, found);
      const mine = found;
      void mine.then(() => {
        if (signal?.aborted && this.done.get(key) === mine) {
          this.done.delete(key);
        }
      }, () => undefined);
    }
    return found;
  }

  /** The install outcome of the most recent command's directory, cleared on read. */
  takeLastInstall(): DependencyInstallOutcome | undefined {
    const last = this.last;
    this.last = undefined;
    return last;
  }

  async run(argv: readonly string[], cwd: string, options: CommandRunOptions = {}): Promise<CommandOutcome> {
    const install = await this.installFor(cwd, options);
    this.last = install;
    if (options.signal?.aborted) {
      // An interrupted run: neither the install nor the command decides anything.
      return abortedOutcome("", install.status === "failed" ? dependencyInstallFailureLine(install) : "");
    }
    if (install.status === "failed") {
      return { code: 1, stdout: "", stderr: dependencyInstallFailureLine(install) };
    }
    return this.inner.run(argv, cwd, options);
  }
}

const MANIFESTS = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];

/** A hash of the manifest and lockfiles in `dir` (missing files hash as absent). */
async function manifestHash(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of MANIFESTS) {
    const path = join(dir, name);
    try {
      if ((await stat(path)).isFile()) {
        hash.update(name).update("\0").update(await readFile(path));
      }
    } catch {
      hash.update(name).update("\0-");
    }
  }
  return hash.digest("hex");
}

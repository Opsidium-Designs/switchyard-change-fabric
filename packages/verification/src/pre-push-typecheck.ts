/**
 * Pre-push typecheck: refuse an agent's edit whose changed TypeScript files
 * gain type errors, before it is pushed.
 *
 * One agent's compile error fails the whole integrated revision at the gate's
 * typecheck step and hides every other agent's test results. This check runs
 * the project's own `tsc --noEmit -p tsconfig.json` on the tree the agent sees
 * (the baseline it reads, overlaid with every file in its repo) twice: before
 * this edit and after it. Only diagnostics in a file the edit changed that
 * were not already there before the edit (same file, code, and message; line
 * and column ignored) are reported, so an edit can still move a broken file
 * toward fixed and another file's errors are never charged to it.
 *
 * It is a refusal only: it never accepts anything, and the gate stays
 * authoritative. Anything that keeps it from giving a clear answer (no
 * tsconfig, no installed dependencies, no tsc, a timeout, output it cannot
 * read, a tsconfig/config error in either run) skips it with a reason, never
 * throws, and lets the edit proceed. So does an edit whose new errors are ALL
 * unresolved imports from modules it did not change (another item may be
 * providing that module or export, and the gate decides once both are in).
 * Build and tool state directories (dist, build, coverage, .wrangler, .turbo,
 * .next, .cache) are not copied into the overlay trees.
 */

import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { gateEnvironment } from "./command.ts";

/** The default limit on one tsc run (60 s). */
export const DEFAULT_PRE_PUSH_TYPECHECK_TIMEOUT_MS = 60_000;
/** The limit on one tsc run's captured output per stream (4 MiB). */
const MAX_TSC_BUFFER = 4 * 1024 * 1024;
/** At most this many new errors are reported, each bounded. */
const MAX_REPORTED_ERRORS = 20;
const MAX_ERROR_CHARS = 300;

const TYPESCRIPT_FILE = /\.(ts|tsx|mts|cts)$/i;
/** One tsc diagnostic line (non-pretty output): `path(line,col): error TSxxxx: message`. */
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const SKIPPED_SEGMENTS = new Set(["node_modules", ".git"]);
/** Build output and tool state the overlay copy of the baseline leaves out (never source tsc needs). */
const UNCOPIED_SEGMENTS = new Set([...SKIPPED_SEGMENTS, "dist", "build", "coverage", ".wrangler", ".turbo", ".next", ".cache"]);
/** A diagnostic with no file location (`error TS5083: ...`): about the configuration, not a file. */
const GLOBAL_DIAGNOSTIC = /^error (TS\d+): (.*)$/;
/**
 * Configuration diagnostics: the project's tsconfig (or a file it names)
 * cannot be read or used, so neither run's answer is about the edit.
 */
const CONFIG_CODES = new Set(["TS5023", "TS5024", "TS5025", "TS5058", "TS5069", "TS5070", "TS5083", "TS5095", "TS5101", "TS6046", "TS6053", "TS6059", "TS6306", "TS6307", "TS18002", "TS18003"]);
/** Cross-module resolution codes: an import names a module or export tsc cannot find. */
const RESOLUTION_CODES = new Set(["TS2305", "TS2307", "TS2614", "TS2724"]);
const TS_OR_JS_EXTENSION = /\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/** What one pre-push check is asked about. */
export interface PrePushCheckInput {
  /** The baseline tree the agent reads (the project, or an integrated revision). */
  readonly baselineDir: string;
  /** The agent's own repo checkout: its earlier pushes plus this uncommitted edit. */
  readonly agentDir: string;
  /** The paths (relative) this edit changed in `agentDir`. */
  readonly changed: readonly string[];
  /**
   * Where installed dependencies may be borrowed from when `baselineDir` has
   * none (an integrated revision checkout): used only when its package.json
   * matches the baseline's byte for byte.
   */
  readonly fallbackNodeModulesDir?: string;
  /** Where the temporary overlay trees are made (default: the OS temp dir). */
  readonly tempRoot?: string;
}

/** The answer: refused with the new errors, or not refused (perhaps skipped, with why). */
export type PrePushCheckResult = { readonly ok: true; readonly skipped?: string } | { readonly ok: false; readonly errors: readonly string[] };

/** A pre-push check (injected into a board agent; faked in tests). */
export type PrePushCheck = (input: PrePushCheckInput) => Promise<PrePushCheckResult>;

/** Options for the tsc-backed pre-push check. */
export interface PrePushTypecheckOptions {
  /** The tsc to run (default: node_modules/.bin/tsc of the tree's dependencies). */
  readonly tscPath?: string;
  /** The limit on one tsc run, in ms (default 60 s). */
  readonly timeoutMs?: number;
}

interface Diagnostic {
  readonly file: string;
  readonly line: string;
  readonly col: string;
  readonly code: string;
  readonly message: string;
}

/** The tsc outcome: diagnostics, or a reason it gave no clear answer. */
type TscOutcome = { readonly diagnostics: readonly Diagnostic[] } | { readonly skipped: string };

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

/** A repo-relative path that stays inside its tree and outside dependency and Git trees. */
function safeRelative(path: string): boolean {
  if (path === "" || isAbsolute(path)) {
    return false;
  }
  const segments = normalize(path).split(sep);
  return !segments.some((s) => s === ".." || SKIPPED_SEGMENTS.has(s));
}

function git(dir: string, args: readonly string[], encoding: "utf8" | "buffer" = "utf8"): Promise<string | Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", dir, ...args], { encoding, maxBuffer: MAX_TSC_BUFFER }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
  });
}

/** The installed dependencies tsc resolves against, or undefined when none are usable. */
async function findNodeModules(baselineDir: string, fallbackDir: string | undefined): Promise<string | undefined> {
  const own = join(baselineDir, "node_modules");
  if (await isDirectory(own)) {
    return own;
  }
  if (fallbackDir === undefined || !(await isDirectory(join(fallbackDir, "node_modules")))) {
    return undefined;
  }
  const [mine, theirs] = await Promise.all([
    readFile(join(baselineDir, "package.json")).catch(() => undefined),
    readFile(join(fallbackDir, "package.json")).catch(() => undefined),
  ]);
  return mine !== undefined && theirs !== undefined && mine.equals(theirs) ? join(fallbackDir, "node_modules") : undefined;
}

/** Parse tsc's non-pretty output into diagnostics with paths relative to `cwd`. */
function parseDiagnostics(output: string, cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(raw);
    if (!match) {
      continue;
    }
    let file = match[1]!.replace(/\\/g, "/");
    if (isAbsolute(file)) {
      file = relative(cwd, file).split(sep).join("/");
    }
    diagnostics.push({ file: normalize(file).split(sep).join("/"), line: match[2]!, col: match[3]!, code: match[4]!, message: match[5]!.trim() });
  }
  return diagnostics;
}

/**
 * A configuration problem in tsc's output (a location-less error, a
 * diagnostic in a tsconfig file, or a configuration code), as a skip reason.
 */
function configProblem(output: string, diagnostics: readonly Diagnostic[]): string | undefined {
  for (const raw of output.split(/\r?\n/)) {
    const match = GLOBAL_DIAGNOSTIC.exec(raw.trim());
    if (match) {
      return `${match[1]}: ${match[2]!.trim()}`.slice(0, MAX_ERROR_CHARS);
    }
  }
  const bad = diagnostics.find((d) => CONFIG_CODES.has(d.code) || /(^|\/)tsconfig[^/]*\.json$/i.test(d.file));
  return bad === undefined ? undefined : `${bad.file}: ${bad.code}: ${bad.message}`.slice(0, MAX_ERROR_CHARS);
}

/** Run `tsc --noEmit -p tsconfig.json` in `cwd`; never throws. */
function runTsc(tsc: string, cwd: string, timeoutMs: number): Promise<TscOutcome> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [tsc, "--noEmit", "-p", "tsconfig.json", "--pretty", "false"],
      { cwd, env: gateEnvironment(process.env), timeout: timeoutMs, maxBuffer: MAX_TSC_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ diagnostics: [] });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string | null };
        if (failure.killed || failure.signal) {
          resolvePromise({ skipped: `tsc did not finish within ${timeoutMs} ms` });
          return;
        }
        if (typeof failure.code !== "number") {
          resolvePromise({ skipped: `tsc could not run (${String(failure.code ?? failure.message).slice(0, 120)})` });
          return;
        }
        const output = `${stdout}\n${stderr}`;
        const diagnostics = parseDiagnostics(output, cwd);
        const config = configProblem(output, diagnostics);
        if (config !== undefined) {
          resolvePromise({ skipped: `tsc reported a configuration error (${config})` });
          return;
        }
        resolvePromise(diagnostics.length > 0 ? { diagnostics } : { skipped: `tsc exited ${failure.code} with output that names no diagnostic` });
      },
    );
  });
}

/** Copy the baseline (without its dependency and Git trees) and link its dependencies. */
async function baselineOverlay(baselineDir: string, overlay: string, nodeModules: string): Promise<void> {
  await cp(baselineDir, overlay, {
    recursive: true,
    filter: (source) => {
      const rel = relative(baselineDir, source);
      return rel === "" || !rel.split(sep).some((s) => UNCOPIED_SEGMENTS.has(s));
    },
  });
  await symlink(nodeModules, join(overlay, "node_modules"), "dir");
}

/** Copy `rel` from `from` into the overlay when it is a regular file there; else remove it from the overlay. */
async function placeFile(from: string, overlay: string, rel: string): Promise<void> {
  const target = join(overlay, rel);
  const info = await lstat(join(from, rel)).catch(() => undefined);
  if (info?.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await cp(join(from, rel), target);
  } else if (info === undefined) {
    await rm(target, { force: true });
  }
}

/**
 * The module a cross-module resolution error points at (TS2305, TS2307,
 * TS2614, TS2724, or TS2339 on a namespace-imported binding's
 * `typeof import("...")`), else undefined: the specifier as written.
 */
function resolutionTarget(d: Diagnostic): string | undefined {
  if (RESOLUTION_CODES.has(d.code)) {
    // `Cannot find module './x'`, `Module '"./x"' has no exported member`, `'"./x"' has no exported member named`.
    const quoted = /^(?:Cannot find module |Module |)'"?([^'"]+)"?'/.exec(d.message);
    return quoted?.[1];
  }
  if (d.code === "TS2339") {
    return /typeof import\("([^"]+)"\)/.exec(d.message)?.[1];
  }
  return undefined;
}

/**
 * Whether `specifier`, imported by `fromFile` (relative to the tree `cwd`),
 * names a module OUTSIDE the edit's changed files. A bare specifier (a
 * package or an alias) is never a changed file.
 */
function outsideChanged(specifier: string, fromFile: string, cwd: string, changed: ReadonlySet<string>): boolean {
  let target: string;
  if (isAbsolute(specifier)) {
    target = relative(cwd, specifier);
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    target = join(dirname(fromFile), specifier);
  } else {
    return true;
  }
  const stem = normalize(target).split(sep).join("/").replace(TS_OR_JS_EXTENSION, "");
  return ![...changed].some((file) => {
    const own = file.replace(TS_OR_JS_EXTENSION, "");
    return own === stem || own === `${stem}/index`;
  });
}

/**
 * The tsc-backed pre-push check: the edit is refused when a file it changed
 * has a type error that file did not have before the edit.
 */
export function createPrePushTypecheck(options: PrePushTypecheckOptions = {}): PrePushCheck {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PRE_PUSH_TYPECHECK_TIMEOUT_MS;
  return async (input) => {
    const changed = input.changed.filter(safeRelative).map((p) => normalize(p).split(sep).join("/"));
    if (!changed.some((p) => TYPESCRIPT_FILE.test(p))) {
      return { ok: true, skipped: "the edit changed no TypeScript file" };
    }
    if (!(await isFile(join(input.baselineDir, "tsconfig.json")))) {
      return { ok: true, skipped: "the project has no tsconfig.json" };
    }
    const nodeModules = await findNodeModules(input.baselineDir, input.fallbackNodeModulesDir);
    if (nodeModules === undefined) {
      return { ok: true, skipped: "no installed dependencies to typecheck against" };
    }
    const tscCandidate = options.tscPath ?? join(nodeModules, ".bin", "tsc");
    const tsc = await realpath(tscCandidate).catch(() => undefined);
    if (tsc === undefined || !(await isFile(tsc))) {
      return { ok: true, skipped: "no tsc in the project's dependencies" };
    }
    const root = input.tempRoot ?? tmpdir();
    let temp: string | undefined;
    try {
      await mkdir(root, { recursive: true });
      temp = await mkdtemp(join(root, "pre-push-tsc-"));
      const before = join(temp, "before");
      const after = join(temp, "after");
      // Every file in the agent's repo (its earlier pushes) overlays the
      // baseline in both trees; only the edit's changed paths differ: their
      // committed version (else the baseline's) before, the edit's after.
      const tracked = String(await git(input.agentDir, ["ls-files", "-z"]))
        .split("\0")
        .filter((p) => p !== "" && safeRelative(p));
      const changedSet = new Set(changed);
      await Promise.all([baselineOverlay(input.baselineDir, before, nodeModules), baselineOverlay(input.baselineDir, after, nodeModules)]);
      for (const rel of tracked.filter((p) => !changedSet.has(p))) {
        await placeFile(input.agentDir, before, rel);
        await placeFile(input.agentDir, after, rel);
      }
      for (const rel of changed) {
        const committed = await git(input.agentDir, ["show", `HEAD:${rel}`], "buffer").catch(() => undefined);
        if (committed !== undefined) {
          await mkdir(dirname(join(before, rel)), { recursive: true });
          await writeFile(join(before, rel), committed);
        }
        await placeFile(input.agentDir, after, rel);
      }
      const [was, now] = await Promise.all([runTsc(tsc, before, timeoutMs), runTsc(tsc, after, timeoutMs)]);
      if ("skipped" in now) {
        return { ok: true, skipped: now.skipped };
      }
      if ("skipped" in was) {
        return { ok: true, skipped: `before the edit: ${was.skipped}` };
      }
      // A diagnostic already there before the edit (counted, line and column
      // ignored) is not the edit's doing.
      const key = (d: Diagnostic): string => `${d.file}\0${d.code}\0${d.message}`;
      const existing = new Map<string, number>();
      for (const d of was.diagnostics) {
        existing.set(key(d), (existing.get(key(d)) ?? 0) + 1);
      }
      const errors: string[] = [];
      const fresh: Diagnostic[] = [];
      for (const d of now.diagnostics) {
        if (!changedSet.has(d.file)) {
          continue;
        }
        const left = existing.get(key(d)) ?? 0;
        if (left > 0) {
          existing.set(key(d), left - 1);
          continue;
        }
        fresh.push(d);
        errors.push(`${d.file}(${d.line},${d.col}): error ${d.code}: ${d.message}`.slice(0, MAX_ERROR_CHARS));
      }
      if (errors.length === 0) {
        return { ok: true };
      }
      // Every new error is an import of a module the edit did not change: that
      // module or export may be another item's work, not yet in this tree.
      const targets = fresh.map((d) => resolutionTarget(d));
      if (targets.every((t, i) => t !== undefined && outsideChanged(t, fresh[i]!.file, after, changedSet))) {
        const modules = [...new Set(targets.map((t) => (isAbsolute(t!) ? relative(after, t!).split(sep).join("/") : t!)))];
        return {
          ok: true,
          skipped: `the edit's new errors are all unresolved imports from modules it did not change (${modules.slice(0, 3).join(", ")}${modules.length > 3 ? ", ..." : ""}); another item may provide them`,
        };
      }
      return { ok: false, errors: errors.slice(0, MAX_REPORTED_ERRORS) };
    } catch (error) {
      return { ok: true, skipped: `the typecheck could not be prepared (${(error instanceof Error ? error.message : String(error)).slice(0, 160)})` };
    } finally {
      if (temp !== undefined) {
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

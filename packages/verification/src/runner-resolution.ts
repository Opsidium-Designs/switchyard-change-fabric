/**
 * runner-resolution: the gate's own toolchain is part of the gate.
 *
 * The dependency install before a gate (see dependency-install.ts) installs
 * what the GATED tree's lockfile declares. A gate whose `gate` script is
 * protected could still be subverted by the dependency set: point
 * `devDependencies.vitest` at `file:./shim` (or an `npm:` alias, a tarball, a
 * git URL), update the lockfile to match, and `vitest run` runs the shim. So
 * the packages the gate runs (its RUNNER packages: every program it invokes
 * through `node_modules/.bin`, the packages those bins belong to, and their
 * transitive dependencies as the baseline lockfile resolves them) are
 * protected:
 *   - in `package.json`: their entries in dependencies, devDependencies,
 *     optionalDependencies and peerDependencies, and the whole `overrides`,
 *     `resolutions`, and `pnpm` sections (they can redirect any transitive
 *     dependency);
 *   - in `package-lock.json` / `npm-shrinkwrap.json`: every `packages` entry of
 *     the runner closure (version, resolved, integrity, link, everything) and
 *     the legacy `dependencies` entries (a closure too large to list protects
 *     the whole lockfile); at integration also the root entry's declarations
 *     of the runner packages; any entry the gated tree ADDS inside the closure
 *     (a nested copy that would shadow a baseline one), any closure entry that
 *     now resolves to a local link or `file:` path, and any other entry that
 *     would link a runner's bin name into `node_modules/.bin` are refused too;
 *   - a pnpm or yarn lockfile is compared whole (no per-entry analysis).
 *
 * Two uses share this module: the CLAIM-TIME contract (the JSON keys posted
 * with the goal, so agents are told up front, and restored key by key by the
 * integrator) and the INTEGRATION-TIME check (`runnerResolutionViolations` /
 * `assertRunnerResolutionUnchanged`), which compares the gated tree with the
 * baseline and catches what a fixed key list cannot (added nested entries, a
 * new package claiming a runner's bin). Goal-agnostic: it reads only
 * manifests and lockfiles.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The JSON lockfiles analyzed per entry (npm's formats). */
export const NPM_LOCKFILES: readonly string[] = ["npm-shrinkwrap.json", "package-lock.json"];
/** Lockfiles compared whole (no per-entry analysis). */
export const OPAQUE_LOCKFILES: readonly string[] = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
/** The manifest maps a runner package may be declared in. */
export const DEPENDENCY_MAPS: readonly string[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
/** Manifest sections that can redirect any (transitive) dependency: protected whole when the gate runs packages. */
export const RESOLUTION_SECTIONS: readonly string[] = ["overrides", "resolutions", "pnpm"];
/**
 * The most lockfile key paths the claim-time contract lists per lockfile; a
 * larger runner closure protects the whole lockfile instead (fail closed, and
 * within the integration job's list bound).
 */
export const MAX_LOCKFILE_KEYS = 400;

/** Programs whose package has a different name than the bin. */
const BIN_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  tsc: ["typescript"],
  tsserver: ["typescript"],
};

/** An npm package name (optionally scoped). */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A tree's manifest and lockfiles, as text (absent files are absent keys). */
export interface DependencySnapshot {
  /** `package.json` text, when present. */
  readonly manifest?: string;
  /** Lockfile name to text, for every lockfile present. */
  readonly lockfiles: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string | undefined): Json | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read a snapshot through `read` (a file name to its text, or undefined when absent). */
export async function readDependencySnapshot(read: (name: string) => Promise<string | undefined>): Promise<DependencySnapshot> {
  const manifest = await read("package.json");
  const lockfiles: Record<string, string> = {};
  for (const name of [...NPM_LOCKFILES, ...OPAQUE_LOCKFILES]) {
    const text = await read(name);
    if (text !== undefined) {
      lockfiles[name] = text;
    }
  }
  return { ...(manifest !== undefined ? { manifest } : {}), lockfiles };
}

/** Read the snapshot of the tree at `dir`. */
export async function readDependencySnapshotFromDir(dir: string): Promise<DependencySnapshot> {
  return readDependencySnapshot(async (name) => {
    try {
      return await readFile(join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  });
}

/** The `packages` map of an npm lockfile (v2/v3), or an empty map. */
function lockPackages(lock: Json | undefined): Json {
  return isRecord(lock?.packages) ? lock.packages : {};
}

/** The package name a `packages` key installs (`node_modules/a/node_modules/@s/b` is `@s/b`). */
function keyName(key: string): string | undefined {
  const at = key.lastIndexOf("node_modules/");
  return at < 0 ? undefined : key.slice(at + "node_modules/".length);
}

/** A key that installs into the root `node_modules` (its bins link into `node_modules/.bin`), or a workspace. */
function linksRootBins(key: string): boolean {
  if (key === "") {
    return false;
  }
  return key.startsWith("node_modules/") ? !key.slice("node_modules/".length).includes("/node_modules/") : true;
}

/** The bin names an entry declares. */
function entryBins(entry: unknown, name: string | undefined): string[] {
  if (!isRecord(entry)) {
    return [];
  }
  const bin = entry.bin;
  if (typeof bin === "string" && name !== undefined) {
    return [name.replace(/^@[^/]+\//, "")];
  }
  return isRecord(bin) ? Object.keys(bin) : [];
}

/** The `packages` key a dependency `dep` of the entry at `from` resolves to (Node's lookup), or undefined. */
function resolveFrom(packages: Json, from: string, dep: string): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base === "" ? `node_modules/${dep}` : `${base}/node_modules/${dep}`;
    if (packages[candidate] !== undefined) {
      return candidate;
    }
    if (base === "") {
      return undefined;
    }
    const up = base.lastIndexOf("/node_modules/");
    base = up < 0 ? "" : base.slice(0, up);
  }
}

/**
 * The `packages` keys of an npm lockfile the runner packages need: each
 * runner's root entry, everything its dependencies resolve to (transitively),
 * a link's target, and every entry nested under a closure entry.
 */
export function runnerClosure(lockText: string | undefined, runnerPackages: readonly string[]): string[] {
  const packages = lockPackages(parseJson(lockText));
  const out = new Set<string>();
  const queue: string[] = [];
  const add = (key: string | undefined): void => {
    if (key !== undefined && packages[key] !== undefined && !out.has(key)) {
      out.add(key);
      queue.push(key);
    }
  };
  for (const name of runnerPackages) {
    add(`node_modules/${name}`);
  }
  while (queue.length > 0) {
    const key = queue.shift()!;
    const entry = packages[key];
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.link === true && typeof entry.resolved === "string") {
      add(entry.resolved);
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = entry[field];
      if (isRecord(deps)) {
        for (const dep of Object.keys(deps)) {
          add(resolveFrom(packages, key, dep));
        }
      }
    }
  }
  // Anything installed inside a closure package's own node_modules is part of it too.
  for (const key of Object.keys(packages)) {
    if ([...out].some((k) => key.startsWith(`${k}/node_modules/`))) {
      out.add(key);
    }
  }
  return [...out].sort();
}

/** The top-level names of a legacy (v1) lockfile's `dependencies` the runner packages need (by `requires`). */
function legacyClosure(lock: Json | undefined, runnerPackages: readonly string[]): string[] {
  const deps = isRecord(lock?.dependencies) ? lock.dependencies : {};
  const out = new Set<string>();
  const queue = runnerPackages.filter((n) => deps[n] !== undefined);
  queue.forEach((n) => out.add(n));
  while (queue.length > 0) {
    const entry = deps[queue.shift()!];
    if (isRecord(entry) && isRecord(entry.requires)) {
      for (const dep of Object.keys(entry.requires)) {
        if (deps[dep] !== undefined && !out.has(dep)) {
          out.add(dep);
          queue.push(dep);
        }
      }
    }
  }
  return [...out].sort();
}

/**
 * The runner packages of a gate from the programs it invokes: each program
 * name that is a valid package name (a package of that name would put its bin
 * first on the PATH of an npm script), the packages whose bins (in the
 * baseline lockfile) have that name, and the known bin-to-package names
 * (`tsc` is `typescript`). `otherWords` (every other word of the gate)
 * count only when they name a baseline bin. Sorted, unique.
 */
export function runnerPackagesFor(programs: Iterable<string>, snapshot: DependencySnapshot, otherWords: Iterable<string> = []): string[] {
  const bins = new Map<string, Set<string>>();
  for (const file of NPM_LOCKFILES) {
    const packages = lockPackages(parseJson(snapshot.lockfiles[file]));
    for (const [key, entry] of Object.entries(packages)) {
      if (!linksRootBins(key) || !key.startsWith("node_modules/")) {
        continue;
      }
      const name = keyName(key)!;
      for (const bin of entryBins(entry, name)) {
        bins.set(bin, (bins.get(bin) ?? new Set()).add(name));
      }
    }
  }
  const out = new Set<string>();
  for (const program of programs) {
    if (PACKAGE_NAME.test(program)) {
      out.add(program);
    }
    for (const name of bins.get(program) ?? []) {
      out.add(name);
    }
    for (const name of BIN_PACKAGES[program] ?? []) {
      out.add(name);
    }
  }
  // Any other word of the gate that names a baseline bin (fail closed: a bin
  // reached in a way the program rule did not see is still the gate's runner).
  for (const word of otherWords) {
    for (const name of bins.get(word) ?? []) {
      out.add(name);
    }
  }
  return [...out].sort();
}

/** The bin names a lockfile's runner entries declare, plus the runner names themselves. */
function runnerBins(snapshot: DependencySnapshot, runnerPackages: readonly string[]): Set<string> {
  const out = new Set(runnerPackages.map((n) => n.replace(/^@[^/]+\//, "")));
  for (const file of NPM_LOCKFILES) {
    const packages = lockPackages(parseJson(snapshot.lockfiles[file]));
    for (const name of runnerPackages) {
      for (const bin of entryBins(packages[`node_modules/${name}`], name)) {
        out.add(bin);
      }
    }
  }
  for (const [bin, names] of Object.entries(BIN_PACKAGES)) {
    if (names.some((n) => runnerPackages.includes(n))) {
      out.add(bin);
    }
  }
  return out;
}

/** The protected JSON keys and whole files for a tree's runner packages (the claim-time contract). */
export interface RunnerResolutionContract {
  readonly jsonKeys: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[];
  /** Lockfiles protected whole (pnpm, yarn, bun: no per-entry analysis). */
  readonly wholeFiles: readonly string[];
  /** The closure entries per npm lockfile (for display). */
  readonly closure: Readonly<Record<string, readonly string[]>>;
}

/** The claim-time contract for `runnerPackages` on the baseline `snapshot`. */
export function runnerResolutionContract(snapshot: DependencySnapshot, runnerPackages: readonly string[]): RunnerResolutionContract {
  if (runnerPackages.length === 0) {
    return { jsonKeys: [], wholeFiles: [], closure: {} };
  }
  const jsonKeys: { file: string; keys: string[][] }[] = [];
  if (snapshot.manifest !== undefined) {
    jsonKeys.push({
      file: "package.json",
      keys: [...DEPENDENCY_MAPS.flatMap((map) => runnerPackages.map((name) => [map, name])), ...RESOLUTION_SECTIONS.map((k) => [k])],
    });
  }
  const closure: Record<string, string[]> = {};
  const wholeFiles = OPAQUE_LOCKFILES.filter((f) => snapshot.lockfiles[f] !== undefined);
  for (const file of NPM_LOCKFILES) {
    const text = snapshot.lockfiles[file];
    if (text === undefined) {
      continue;
    }
    const keys = runnerClosure(text, runnerPackages);
    closure[file] = keys;
    const lock = parseJson(text);
    // The root entry's declarations are not listed (the manifest's are, and
    // `npm ci` refuses a lockfile out of sync with the manifest); key paths
    // never contain an empty segment.
    const lockKeys = [...keys.map((k) => ["packages", k]), ...legacyClosure(lock, runnerPackages).map((name) => ["dependencies", name])];
    if (lock === undefined || lockKeys.length > MAX_LOCKFILE_KEYS) {
      wholeFiles.push(file);
    } else if (lockKeys.length > 0) {
      jsonKeys.push({ file, keys: lockKeys });
    }
  }
  return { jsonKeys, wholeFiles: wholeFiles.sort(), closure };
}

/** The runner packages named by protected manifest keys (`["devDependencies", "vitest"]`), for the integrator. */
export function runnerPackagesFromJsonKeys(jsonKeys: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[]): string[] {
  const out = new Set<string>();
  for (const { file, keys } of jsonKeys) {
    if (file !== "package.json") {
      continue;
    }
    for (const key of keys) {
      if (key.length === 2 && DEPENDENCY_MAPS.includes(key[0]!)) {
        out.add(key[1]!);
      }
    }
  }
  return [...out].sort();
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What a dependency spec or lockfile entry resolves to, for a refusal reason. */
function describeResolution(value: unknown): string {
  if (value === undefined) {
    return "absent";
  }
  if (typeof value === "string") {
    if (/^(file|link):/.test(value) || value.startsWith(".") || value.startsWith("/")) {
      return `a local path (${value})`;
    }
    if (value.startsWith("npm:")) {
      return `an npm alias (${value})`;
    }
    if (/^(git\+|git:|github:|https?:)/.test(value)) {
      return `a URL (${value})`;
    }
    return JSON.stringify(value);
  }
  if (isRecord(value)) {
    if (value.link === true) {
      return `a local link to ${String(value.resolved ?? "?")}`;
    }
    const resolved = typeof value.resolved === "string" ? value.resolved : undefined;
    if (resolved !== undefined && /^(file|link):/.test(resolved)) {
      return `a local path (${resolved})`;
    }
    return `version ${String(value.version ?? "?")}${resolved !== undefined ? ` from ${resolved}` : ""}`;
  }
  return JSON.stringify(value);
}

/** True for a lockfile entry that resolves to the local file system (a link or a `file:` path). */
function isLocal(entry: unknown): boolean {
  return isRecord(entry) && (entry.link === true || (typeof entry.resolved === "string" && /^(file|link):/.test(entry.resolved)));
}

/**
 * Every way the gated tree's dependency set changes what the gate's runner
 * packages resolve to, compared with the baseline (empty when nothing does).
 * Each entry is `<file>#<key>: <reason>`.
 */
export function runnerResolutionViolations(baseline: DependencySnapshot, gated: DependencySnapshot, runnerPackages: readonly string[]): string[] {
  if (runnerPackages.length === 0) {
    return [];
  }
  const out: string[] = [];
  const baseManifest = parseJson(baseline.manifest);
  const gatedManifest = parseJson(gated.manifest);
  if (baseline.manifest !== undefined && gated.manifest !== undefined && gatedManifest === undefined) {
    out.push("package.json: no longer valid JSON, so the runner packages' declarations cannot be checked");
  }
  for (const map of DEPENDENCY_MAPS) {
    for (const name of runnerPackages) {
      const before = isRecord(baseManifest?.[map]) ? (baseManifest[map] as Json)[name] : undefined;
      const after = isRecord(gatedManifest?.[map]) ? (gatedManifest[map] as Json)[name] : undefined;
      if (!same(before, after)) {
        out.push(`package.json#${map}.${name}: the gate's runner package changed from ${describeResolution(before)} to ${describeResolution(after)}`);
      }
    }
  }
  for (const section of RESOLUTION_SECTIONS) {
    if (!same(baseManifest?.[section], gatedManifest?.[section])) {
      out.push(`package.json#${section}: changed (it can redirect the gate's runner packages)`);
    }
  }
  const bins = runnerBins(baseline, runnerPackages);
  const names = new Set([...Object.keys(baseline.lockfiles), ...Object.keys(gated.lockfiles)]);
  for (const file of [...names].sort()) {
    const beforeText = baseline.lockfiles[file];
    const afterText = gated.lockfiles[file];
    if (beforeText === undefined || afterText === undefined) {
      out.push(`${file}: ${beforeText === undefined ? "added" : "removed"} (it decides what the gate's runner packages install)`);
      continue;
    }
    if (OPAQUE_LOCKFILES.includes(file)) {
      if (beforeText !== afterText) {
        out.push(`${file}: changed (it is compared whole: it decides what the gate's runner packages install)`);
      }
      continue;
    }
    const before = parseJson(beforeText);
    const after = parseJson(afterText);
    if (after === undefined) {
      out.push(`${file}: no longer valid JSON, so the runner packages' resolution cannot be checked`);
      continue;
    }
    const bp = lockPackages(before);
    const ap = lockPackages(after);
    for (const map of DEPENDENCY_MAPS) {
      for (const name of runnerPackages) {
        const b = isRecord(bp[""]) && isRecord((bp[""] as Json)[map]) ? ((bp[""] as Json)[map] as Json)[name] : undefined;
        const a = isRecord(ap[""]) && isRecord((ap[""] as Json)[map]) ? ((ap[""] as Json)[map] as Json)[name] : undefined;
        if (!same(b, a)) {
          out.push(`${file}#packages[""].${map}.${name}: the root declaration of a runner package changed from ${describeResolution(b)} to ${describeResolution(a)}`);
        }
      }
    }
    const closure = new Set([...runnerClosure(beforeText, runnerPackages), ...runnerClosure(afterText, runnerPackages)]);
    for (const key of [...closure].sort()) {
      const b = bp[key];
      const a = ap[key];
      if (!same(b, a)) {
        const local = isLocal(a) && !isLocal(b) ? " (a local link or file: path is never accepted for the gate's runner)" : "";
        out.push(`${file}#packages["${key}"]: the gate's runner resolution changed from ${describeResolution(b)} to ${describeResolution(a)}${local}`);
      }
    }
    for (const [key, entry] of Object.entries(ap)) {
      if (closure.has(key) || !linksRootBins(key) || same(bp[key], entry)) {
        continue;
      }
      const claimed = entryBins(entry, keyName(key)).filter((b) => bins.has(b));
      if (claimed.length > 0) {
        out.push(`${file}#packages["${key}"]: a changed package declares the gate's runner bin(s) ${claimed.join(", ")}`);
      }
    }
    const legacy = new Set([...legacyClosure(before, runnerPackages), ...legacyClosure(after, runnerPackages)]);
    const bd = isRecord(before?.dependencies) ? before.dependencies : {};
    const ad = isRecord(after.dependencies) ? after.dependencies : {};
    for (const name of [...legacy].sort()) {
      if (!same(bd[name], ad[name])) {
        out.push(`${file}#dependencies.${name}: the gate's runner resolution changed from ${describeResolution(bd[name])} to ${describeResolution(ad[name])}`);
      }
    }
  }
  return out;
}

/** A snapshot, or a directory to read one from. */
export type DependencySource = string | DependencySnapshot;

async function snapshotOf(source: DependencySource): Promise<DependencySnapshot> {
  return typeof source === "string" ? readDependencySnapshotFromDir(source) : source;
}

/**
 * Refuse (throw) when the gated tree changes what the gate's runner packages
 * resolve to; resolves with nothing otherwise. The error names every
 * violation, as a protected-path refusal.
 */
export async function assertRunnerResolutionUnchanged(baseline: DependencySource, gated: DependencySource, runnerPackages: readonly string[]): Promise<void> {
  const violations = runnerResolutionViolations(await snapshotOf(baseline), await snapshotOf(gated), runnerPackages);
  if (violations.length > 0) {
    throw new Error(
      `integration refused: the gated tree changes the gate's own toolchain (runner packages ${runnerPackages.join(", ")}); ` +
        `these are protected like the gate's files: ${violations.join("; ")}`,
    );
  }
}

/**
 * Clash prediction: which agents' heads would conflict if merged, read from
 * Git objects alone (no checkout, no working tree).
 *
 * Given a repo that holds the objects, the base every agent started from, and
 * each agent's current head, every pair of heads is classified:
 *   - clean: the heads touch disjoint files ("disjoint", decided from
 *     `diff --name-only` against the base without merging), or a real
 *     three-way merge of the two is clean ("merged");
 *   - conflict: the three-way merge conflicts, with the conflicting paths. A
 *     conflict touching a path the caller calls shared (`isSharedPath`, for
 *     example seam or shared code) is scoped "shared" (a seam contract would
 *     settle it), otherwise "local";
 *   - unknown: the pair could not be decided (an error, a timeout, an invalid
 *     id, or the pair limit). Never reported as clean.
 * The merge is `git merge-tree --write-tree` (git 2.38+). An older git makes
 * the whole prediction "unavailable", never clean.
 *
 * Read-only on the repo: merge-tree writes the merged trees into a private,
 * temporary object directory (the repo's objects are only read, as an
 * alternate), removed afterwards. Every call goes through the hardened git
 * runner. Pure prediction: nothing here is wired into a verdict, and the
 * mechanical gate on the integrated tree stays authoritative.
 *
 * Node only (the CLI, the local runner, tests), never a Worker.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

/** One agent's head to compare. */
export interface ClashHead {
  readonly agent: string;
  readonly item: string;
  readonly sha: string;
}

/** Inputs to predict pairwise clashes. */
export interface PredictClashesInput {
  /** A local repo (bare or not) holding the base and every head's objects. */
  readonly repoDir: string;
  /** The commit every head started from. */
  readonly base: string;
  readonly heads: readonly ClashHead[];
  /** Is this repo-relative path shared (seam) code? Default: nothing is. */
  readonly isSharedPath?: (path: string) => boolean;
  /** The time one git call of a pair may take (default 10s). */
  readonly pairTimeoutMs?: number;
  /** The most pairs to decide (default 64); the rest are reported unknown. */
  readonly maxPairs?: number;
}

/** What one pair would do if merged. */
export type ClashOutcome =
  | { readonly kind: "clean"; readonly reason: "disjoint" | "merged" }
  | {
      readonly kind: "conflict";
      readonly paths: readonly string[];
      readonly scope: "shared" | "local";
      /** The conflicting paths `isSharedPath` called shared. */
      readonly sharedPaths: readonly string[];
    }
  | { readonly kind: "unknown"; readonly reason: string };

/** One pair of heads and its predicted outcome. */
export interface ClashPair {
  readonly a: ClashHead;
  readonly b: ClashHead;
  readonly outcome: ClashOutcome;
}

/** The whole prediction. */
export type ClashPrediction =
  | {
      readonly status: "ok";
      /** Every pair (i < j in input order), decided or not. */
      readonly pairs: readonly ClashPair[];
      /** How many pairs were left undecided by the pair limit. */
      readonly skippedPairs: number;
    }
  | { readonly status: "unavailable"; readonly reason: string; readonly pairs: readonly [] };

/** Defaults for the work bounds. */
export const CLASH_DEFAULTS = { pairTimeoutMs: 10_000, maxPairs: 64 } as const;

const SHA = /^[0-9a-f]{7,64}$/;

/** Predict, for every pair of heads, whether merging them would conflict. */
export async function predictClashes(input: PredictClashesInput): Promise<ClashPrediction> {
  const timeoutMs = input.pairTimeoutMs ?? CLASH_DEFAULTS.pairTimeoutMs;
  const maxPairs = input.maxPairs ?? CLASH_DEFAULTS.maxPairs;
  const support = await mergeTreeSupport();
  if (!support.ok) {
    return { status: "unavailable", reason: support.reason, pairs: [] };
  }

  const pairs: [ClashHead, ClashHead][] = [];
  for (let i = 0; i < input.heads.length; i += 1) {
    for (let j = i + 1; j < input.heads.length; j += 1) {
      pairs.push([input.heads[i]!, input.heads[j]!]);
    }
  }
  if (!SHA.test(input.base)) {
    return {
      status: "ok",
      pairs: pairs.map(([a, b]) => ({ a, b, outcome: { kind: "unknown", reason: `invalid base commit id: ${input.base}` } })),
      skippedPairs: 0,
    };
  }

  const scratch = await mkdtemp(join(tmpdir(), "scf-clash-"));
  try {
    const objects = join(scratch, "objects");
    await mkdir(objects, { recursive: true });
    const repoObjects = resolve(
      input.repoDir,
      (await git(input.repoDir, ["rev-parse", "--git-path", "objects"], {}, timeoutMs)).trim(),
    );
    // Merged trees land in the scratch store; the repo's objects are read only.
    const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjects };

    const changed = new Map<string, Promise<readonly string[]>>();
    const changedFiles = (sha: string): Promise<readonly string[]> => {
      let found = changed.get(sha);
      if (!found) {
        found = git(input.repoDir, ["diff", "--name-only", "--no-renames", "-z", input.base, sha], {}, timeoutMs).then(splitZ);
        // Settle the cached promise's rejection here; each caller still sees it.
        found.catch(() => undefined);
        changed.set(sha, found);
      }
      return found;
    };

    const result: ClashPair[] = [];
    let decided = 0;
    for (const [a, b] of pairs) {
      if (decided >= maxPairs) {
        result.push({ a, b, outcome: { kind: "unknown", reason: `not checked: over the limit of ${maxPairs} pairs` } });
        continue;
      }
      decided += 1;
      result.push({ a, b, outcome: await predictPair(input, a, b, changedFiles, env, support.mergeBase, timeoutMs) });
    }
    return { status: "ok", pairs: result, skippedPairs: Math.max(0, pairs.length - maxPairs) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function predictPair(
  input: PredictClashesInput,
  a: ClashHead,
  b: ClashHead,
  changedFiles: (sha: string) => Promise<readonly string[]>,
  env: Readonly<Record<string, string>>,
  mergeBaseFlag: boolean,
  timeoutMs: number,
): Promise<ClashOutcome> {
  for (const head of [a, b]) {
    if (!SHA.test(head.sha)) {
      return { kind: "unknown", reason: `invalid commit id for ${head.agent}: ${head.sha}` };
    }
  }
  let filesA: readonly string[];
  let filesB: readonly string[];
  try {
    [filesA, filesB] = await Promise.all([changedFiles(a.sha), changedFiles(b.sha)]);
  } catch (error) {
    return { kind: "unknown", reason: `could not list changed files: ${describe(error, timeoutMs)}` };
  }
  if (!overlaps(filesA, filesB)) {
    return { kind: "clean", reason: "disjoint" };
  }
  try {
    await git(
      input.repoDir,
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        ...(mergeBaseFlag ? [`--merge-base=${input.base}`] : []),
        a.sha,
        b.sha,
      ],
      env,
      timeoutMs,
    );
    return { kind: "clean", reason: "merged" };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; killed?: unknown };
    if (e.code === 1 && e.killed !== true && typeof e.stdout === "string") {
      // Exit 1 is "conflicts": the tree id, then each conflicted path, NUL-separated.
      const [, ...rest] = e.stdout.split("\0");
      const end = rest.indexOf("");
      const paths = [...new Set(end >= 0 ? rest.slice(0, end) : rest.filter((p) => p !== ""))].sort();
      const sharedPaths = paths.filter((path) => isShared(input.isSharedPath, path));
      return { kind: "conflict", paths, scope: sharedPaths.length > 0 ? "shared" : "local", sharedPaths };
    }
    return { kind: "unknown", reason: `merge-tree failed: ${describe(error, timeoutMs)}` };
  }
}

/**
 * Do two changed-file sets touch a common path? Equal paths overlap, and so do
 * a file and a directory holding it (`a` vs `a/b`): a file/directory clash
 * conflicts though the names differ.
 */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const files = new Set(a);
  const dirs = new Set<string>();
  for (const path of a) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  for (const path of b) {
    if (files.has(path) || dirs.has(path)) {
      return true;
    }
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (files.has(parts.slice(0, i).join("/"))) {
        return true;
      }
    }
  }
  return false;
}

function isShared(predicate: ((path: string) => boolean) | undefined, path: string): boolean {
  if (!predicate) {
    return false;
  }
  try {
    return predicate(path) === true;
  } catch {
    return false;
  }
}

/** Does the local git have `merge-tree --write-tree` (2.38+) and `--merge-base` (2.40+)? */
async function mergeTreeSupport(): Promise<{ readonly ok: true; readonly mergeBase: boolean } | { readonly ok: false; readonly reason: string }> {
  let text: string;
  try {
    text = (await runGit(["version"], { timeoutMs: 10_000 })).stdout;
  } catch (error) {
    return { ok: false, reason: `git is not runnable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const match = /git version (\d+)\.(\d+)/.exec(text);
  if (!match) {
    return { ok: false, reason: `could not read the git version from ${JSON.stringify(text.trim())}` };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const atLeast = (maj: number, min: number) => major > maj || (major === maj && minor >= min);
  if (!atLeast(2, 38)) {
    return { ok: false, reason: `git ${major}.${minor} has no merge-tree --write-tree (needs 2.38 or newer)` };
  }
  return { ok: true, mergeBase: atLeast(2, 40) };
}

async function git(
  dir: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await runGit(["-C", dir, ...args], { env, timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function splitZ(text: string): readonly string[] {
  return text.split("\0").filter((p) => p !== "");
}

function describe(error: unknown, timeoutMs: number): string {
  const e = error as { killed?: unknown; signal?: unknown };
  if (e && (e.killed === true || e.signal === "SIGKILL")) {
    return `timed out after ${timeoutMs}ms`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.slice(0, 300);
}

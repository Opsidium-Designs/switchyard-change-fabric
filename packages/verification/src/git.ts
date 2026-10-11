/**
 * Thin Git helpers used by verification and integration.
 *
 * The verifier works from a Git checkout of a WorkUnit's workspace: it clones a
 * workspace remote, lists tracked files, and derives which files changed since
 * the baseline so the path-scope check can compare them against the WorkUnit's
 * declared paths. Integration clones several verified workspaces and merges
 * their changed files into one combined checkout.
 *
 * These wrap the Git CLI, so they run in Node (the local runner, the CLI, and
 * tests), not inside a Cloudflare Worker.
 */

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

/** A deterministic committer identity so integration commits are reproducible. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const DEFAULT_IDENTITY: GitIdentity = {
  name: "Switchyard Integrator",
  email: "integrator@switchyard.local",
};

/**
 * The same URL without any userinfo (`https://token:secret@host/x` becomes
 * `https://host/x`): what a checkout may keep in its `.git/config`.
 */
export function withoutCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

/**
 * Clone a remote into a target directory WITHOUT persisting its credential: a
 * token in the clone URL is sent as a header for the transfer only and
 * `origin` is the tokenless URL, so code that later runs in the checkout (a
 * gate, a test) can never read it from `.git/config`. Later pushes and fetches
 * pass the authenticated URL explicitly (again turned into a header).
 */
export async function clone(remote: string, targetDir: string): Promise<void> {
  // runGit takes the token out of the URL (it travels as a header), so the
  // checkout's origin is the tokenless URL from the start.
  await runGit(["clone", remote, targetDir]);
}

/**
 * Check out exactly `commit` (detached). Only a full or abbreviated hex object
 * id is accepted, so a ref name can never stand in for the pinned commit.
 */
export async function checkoutCommit(worktreeDir: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new Error(`not a commit id: ${commit}`);
  }
  await git(worktreeDir, ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", `${commit}^{commit}`]);
}

/** Is `ancestor` contained in `commit`'s history (or the same commit)? */
export async function isAncestor(worktreeDir: string, ancestor: string, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/.test(ancestor) || !/^[0-9a-f]{7,64}$/.test(commit)) {
    return false;
  }
  try {
    await git(worktreeDir, ["merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}

/** Run a git subcommand inside a worktree and return trimmed stdout. */
export async function git(worktreeDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runGit(["-C", worktreeDir, ...args]);
  return stdout;
}

/** List the repository-relative paths tracked at HEAD. */
export async function listTrackedFiles(worktreeDir: string): Promise<readonly string[]> {
  const out = await git(worktreeDir, ["ls-tree", "-r", "--name-only", "HEAD"]);
  return splitLines(out);
}

/**
 * Return the repository-relative paths that differ between the baseline ref and
 * HEAD. When the baseline ref cannot be resolved (for example a fresh workspace
 * seeded only by the runner's first push, where "HEAD" was the empty baseline),
 * fall back to the full tracked file set at HEAD so the scope check still has
 * something to compare.
 */
export async function changedPathsSinceBaseline(
  worktreeDir: string,
  baselineRef: string,
): Promise<readonly string[]> {
  const ref = baselineRef.trim() === "" ? "HEAD" : baselineRef;
  try {
    // The empty tree is a stable sentinel for "no baseline content".
    const resolved = ref === "HEAD" ? await emptyTreeHash(worktreeDir) : ref;
    const out = await git(worktreeDir, ["diff", "--name-only", resolved, "HEAD"]);
    return splitLines(out);
  } catch {
    return listTrackedFiles(worktreeDir);
  }
}

/**
 * The repository-relative paths that differ between `baselineRef` ("HEAD":
 * the empty tree, i.e. every file) and `commit`, without checking anything
 * out. A baseline that cannot be resolved falls back to every file tracked at
 * `commit`, as changedPathsSinceBaseline does.
 */
export async function changedPathsBetween(worktreeDir: string, baselineRef: string, commit: string): Promise<readonly string[]> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new Error(`not a commit id: ${commit}`);
  }
  const ref = baselineRef.trim() === "" ? "HEAD" : baselineRef;
  try {
    const resolved = ref === "HEAD" ? await emptyTreeHash(worktreeDir) : ref;
    return splitLines(await git(worktreeDir, ["diff", "--name-only", "--no-renames", resolved, `${commit}^{commit}`]));
  } catch {
    return splitLines(await git(worktreeDir, ["ls-tree", "-r", "--name-only", `${commit}^{commit}`]));
  }
}

/** The hash of Git's empty tree, used as a "no baseline" diff base. */
export async function emptyTreeHash(worktreeDir: string): Promise<string> {
  return (await git(worktreeDir, ["hash-object", "-t", "tree", "/dev/null"])).trim();
}

/** Stage all changes, commit with a deterministic identity, return the commit hash. */
export async function commitAll(
  worktreeDir: string,
  message: string,
  identity: GitIdentity = DEFAULT_IDENTITY,
): Promise<string> {
  await git(worktreeDir, ["add", "-A"]);
  await git(worktreeDir, [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "--no-verify",
    "-m",
    message,
  ]);
  return (await git(worktreeDir, ["rev-parse", "HEAD"])).trim();
}

/** Whether the worktree has staged or unstaged changes. */
export async function hasChanges(worktreeDir: string): Promise<boolean> {
  const status = await git(worktreeDir, ["status", "--porcelain"]);
  return status.trim() !== "";
}

function splitLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Thin wrappers around the Git CLI used by local promotion.
 *
 * Promotion clones the integrated workspace, creates a delivery branch in an
 * ordinary local Git repository, copies the integrated files on top, and
 * commits. These helpers wrap the Git CLI, so they run in Node (the local
 * runner, the CLI, and tests), not inside a Cloudflare Worker.
 */

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

/** A deterministic committer identity so promotion commits are reproducible. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const DEFAULT_IDENTITY: GitIdentity = {
  name: "Switchyard Promotion",
  email: "promotion@switchyard.local",
};

/** Run a git subcommand inside a repository and return trimmed stdout. */
export async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runGit(["-C", repoDir, ...args]);
  return stdout;
}

/** Clone a remote (file:// or https) into a target directory. */
export async function clone(remote: string, targetDir: string): Promise<void> {
  await runGit(["clone", remote, targetDir]);
}

/** The current branch name of a repository. */
export async function currentBranch(repoDir: string): Promise<string> {
  return (await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/** Whether a branch already exists in the repository. */
export async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await git(repoDir, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Create and check out a new branch from the given start point. */
export async function createBranch(
  repoDir: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await git(repoDir, ["checkout", "-b", branch, startPoint]);
}

/** Check out an existing branch. */
export async function checkout(repoDir: string, ref: string): Promise<void> {
  await git(repoDir, ["checkout", ref]);
}

/**
 * Stage all changes, commit with a deterministic identity, and return the
 * commit hash.
 */
export async function commitAll(
  repoDir: string,
  message: string,
  identity: GitIdentity = DEFAULT_IDENTITY,
): Promise<string> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "--no-verify",
    "-m",
    message,
  ]);
  return (await git(repoDir, ["rev-parse", "HEAD"])).trim();
}

/** Whether the repository has staged or unstaged changes. */
export async function hasChanges(repoDir: string): Promise<boolean> {
  const status = await git(repoDir, ["status", "--porcelain"]);
  return status.trim() !== "";
}

/** List the repository-relative paths tracked at HEAD. */
export async function listTrackedFiles(repoDir: string): Promise<readonly string[]> {
  const out = await git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The tree object hash a ref points at. Two refs that resolve to the same tree
 * hash have byte-identical content (ignoring commit metadata and history), so
 * comparing tree hashes is how promotion decides whether the integrated tree
 * actually differs from the baseline it was seeded from.
 */
export async function treeHash(repoDir: string, ref: string): Promise<string> {
  return (await git(repoDir, ["rev-parse", `${ref}^{tree}`])).trim();
}

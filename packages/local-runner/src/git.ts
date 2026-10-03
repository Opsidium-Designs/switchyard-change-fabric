/**
 * Thin wrappers around the Git CLI used by the runner.
 *
 * The runner clones a leased workspace, lets the executor edit it, then commits
 * and pushes back. For a real Cloudflare Artifacts HTTPS remote the scoped token
 * is supplied as the password of an HTTPS basic-auth credential. For the local
 * file:// fallback no credential is needed and the token is ignored.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A deterministic committer identity so commits are reproducible in tests. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const DEFAULT_IDENTITY: GitIdentity = {
  name: "Switchyard Runner",
  email: "runner@switchyard.local",
};

/**
 * Build the authenticated clone/push URL. For an HTTPS Artifacts remote, inject
 * the scoped token as the basic-auth password (username "token" by convention
 * for a repo-scoped credential). For a file:// remote, return it unchanged.
 */
export function authenticatedRemote(gitUrl: string, token: string): string {
  if (gitUrl.startsWith("file://")) {
    return gitUrl;
  }
  if (gitUrl.startsWith("https://")) {
    const rest = gitUrl.slice("https://".length);
    // The token is repo-scoped; username is a fixed placeholder.
    return `https://token:${encodeURIComponent(token)}@${rest}`;
  }
  return gitUrl;
}

/** Clone a remote into a target directory. */
export async function clone(remote: string, targetDir: string): Promise<void> {
  await run("git", ["clone", remote, targetDir]);
}

/** Run a git subcommand inside a worktree. */
export async function git(worktreeDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", worktreeDir, ...args]);
  return stdout;
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

/** Push the current branch to the given remote URL. */
export async function push(worktreeDir: string, remote: string, branch: string): Promise<void> {
  await git(worktreeDir, ["push", remote, `HEAD:${branch}`]);
}

/** Whether the worktree has staged or unstaged changes. */
export async function hasChanges(worktreeDir: string): Promise<boolean> {
  const status = await git(worktreeDir, ["status", "--porcelain"]);
  return status.trim() !== "";
}

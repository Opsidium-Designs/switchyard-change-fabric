/**
 * Thin wrappers around the Git CLI used by the runner.
 *
 * The runner clones a leased workspace, lets the executor edit it, then commits
 * and pushes back. For a real Cloudflare Artifacts HTTPS remote the scoped token
 * rides in the remote URL inside this process only: every git call goes
 * through the hardened runGit, which strips it from the arguments and sends
 * it as an `Authorization: Bearer` header (never on git's command line or in
 * a config file). For the local file:// fallback no credential is needed and
 * the token is ignored.
 */

import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

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
 * Build the authenticated clone/push URL. For an HTTPS Artifacts remote, the
 * scoped token is carried as the URL's password (username "token"); the git
 * helpers turn it into a Bearer header before git runs. For a file:// remote,
 * return it unchanged.
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

/** Run a git subcommand inside a worktree. */
export async function git(worktreeDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runGit(["-C", worktreeDir, ...args]);
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

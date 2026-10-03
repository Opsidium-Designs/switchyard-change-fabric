/**
 * LocalGitDeliveryProvider: the guaranteed baseline delivery path.
 *
 * It takes the verified and integrated Change result and promotes it into an
 * ordinary local Git repository: it clones the integrated workspace, creates a
 * delivery branch in the source repo, copies the integrated files on top of the
 * start point, and commits one promotion commit. The result is a real branch and
 * commit a human can review and ship with ordinary Git, with no hosted forge
 * involved.
 *
 * It uses Node's filesystem and the Git CLI, so it runs in the local runner, the
 * CLI, and tests, not inside a Cloudflare Worker. Hosted forge adapters
 * (GitLab, GitHub) are out of scope for this provider.
 */

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  branchExists,
  checkout,
  clone,
  commitAll,
  createBranch,
  currentBranch,
  git,
  hasChanges,
  listTrackedFiles,
  type GitIdentity,
} from "./git.ts";
import type {
  DeliveryProvider,
  PromotionInput,
  PromotionResult,
  PromotionTarget,
} from "./types.ts";

/** Options for constructing the local Git delivery provider. */
export interface LocalGitDeliveryOptions {
  /** Root under which disposable worktrees are created. Defaults to OS temp. */
  readonly workRoot?: string;
}

export class LocalGitDeliveryProvider implements DeliveryProvider {
  readonly name = "local-git";

  constructor(private readonly options: LocalGitDeliveryOptions = {}) {}

  /**
   * Promote the integrated result into the local source repository. Clones the
   * integrated workspace, creates (or reuses) the delivery branch from the start
   * point, copies every tracked file from the integrated result into the branch,
   * and commits once. Returns the branch, the commit, and the delivered paths.
   */
  async promote(input: PromotionInput, target: PromotionTarget): Promise<PromotionResult> {
    const workRoot = this.options.workRoot ?? tmpdir();
    const branch = target.branch ?? defaultBranch(input.changeId);
    const identity: GitIdentity | undefined = target.identity;
    const commitMessage = target.commitMessage ?? defaultCommitMessage(input);

    const integrationDir = await mkdtemp(join(workRoot, "scf-promote-src-"));
    try {
      // 1. Clone the integrated workspace to read the combined result from.
      await clone(input.integrationGitUrl, integrationDir);
      if (input.integrationBranch) {
        await checkout(integrationDir, input.integrationBranch);
      }
      const integratedFiles = await listTrackedFiles(integrationDir);

      // 2. Create or reset the delivery branch in the source repository.
      const startPoint = target.startPoint ?? (await currentBranch(target.repoDir));
      if (await branchExists(target.repoDir, branch)) {
        await checkout(target.repoDir, branch);
        await git(target.repoDir, ["reset", "--hard", startPoint]);
      } else {
        await createBranch(target.repoDir, branch, startPoint);
      }

      // 3. Copy every tracked file from the integrated result on top of the
      //    delivery branch. ".git" is never tracked, so it is never copied.
      const deliveredPaths: string[] = [];
      for (const rel of integratedFiles) {
        const from = join(integrationDir, rel);
        const to = join(target.repoDir, rel);
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { recursive: true });
        deliveredPaths.push(rel);
      }

      // 4. Commit the promotion when the branch actually changed.
      let commit = "";
      let committed = false;
      if (await hasChanges(target.repoDir)) {
        commit = await commitAll(target.repoDir, commitMessage, identity);
        committed = true;
      }

      return {
        changeId: input.changeId,
        branch,
        commit,
        deliveredPaths: deliveredPaths.sort(),
        committed,
      };
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  }
}

/** The deterministic default delivery branch name for a Change. */
export function defaultBranch(changeId: string): string {
  return `switchyard/${sanitizeRef(changeId)}`;
}

/** The default promotion commit message for a Change. */
function defaultCommitMessage(input: PromotionInput): string {
  const title = `Promote Change ${input.changeId}`;
  if (input.objective && input.objective.trim() !== "") {
    return `${title}\n\n${input.objective.trim()}\n`;
  }
  return `${title}\n`;
}

/** Reduce an id to a Git-ref-safe segment. */
function sanitizeRef(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-");
}

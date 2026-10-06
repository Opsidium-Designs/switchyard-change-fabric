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
  treeHash,
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

      // Gate-equals-deploy guard: when the integration reported it landed fixes
      // (or the change required an app gate, so a fix was expected either way),
      // the integrated tree the gate ran on MUST differ from the delivery branch
      // start point (the baseline the integration workspace was seeded from). If
      // the two trees are identical the integration never advanced past the
      // baseline seed, which means the authoritative gate passed on a
      // baseline-identical tree and promoting it would silently ship the unfixed
      // baseline while claiming a fix landed. Fail loudly instead, so a silent
      // baseline-ship becomes a hard error rather than a passing-but-unfixed
      // deploy. A change that expected no fix (expectedIntegratedUnits omitted or
      // zero AND expectedFixes not set) is exempt: an unchanged promotion there
      // is a legitimate no-op.
      const fixExpected = (input.expectedIntegratedUnits ?? 0) > 0 || input.expectedFixes === true;
      if (fixExpected) {
        const integratedTree = await treeHash(integrationDir, "HEAD");
        const baselineTree = await treeHash(target.repoDir, startPoint);
        if (integratedTree === baselineTree) {
          throw new Error(
            "promotion refused: a fix was expected " +
              (input.expectedIntegratedUnits
                ? `(${input.expectedIntegratedUnits} landed fix(es)) `
                : "(the change required a behavioral app gate) ") +
              "but the integrated tree is identical to the baseline, so the gate passed on an unfixed " +
              "tree and promotion would ship the baseline. The gated tree and the promoted tree must " +
              "be the same tree.",
          );
        }
      }

      if (await branchExists(target.repoDir, branch)) {
        await checkout(target.repoDir, branch);
        await git(target.repoDir, ["reset", "--hard", startPoint]);
      } else {
        await createBranch(target.repoDir, branch, startPoint);
      }

      // The files already present on the delivery branch (the baseline start
      // point), used to reconcile deletions below so the promoted tree matches
      // the integrated tree the gate ran on exactly.
      const baselineFiles = await listTrackedFiles(target.repoDir);
      const integratedSet = new Set(integratedFiles);

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

      // 3b. Reconcile deletions. The copy above only adds or overwrites files, so
      //     a baseline file the integrated tree no longer tracks (a verified fix
      //     that DELETED or RENAMED a file) would otherwise survive on the
      //     delivery branch, leaving the promoted tree different from the
      //     integrated tree the gate ran on. Remove any baseline path absent from
      //     the integrated tree so the promoted tree is byte-identical to the
      //     gated/integrated composition: gated == promoted, deletions included.
      const removedPaths: string[] = [];
      for (const rel of baselineFiles) {
        if (!integratedSet.has(rel)) {
          await git(target.repoDir, ["rm", "-f", "--", rel]);
          removedPaths.push(rel);
        }
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
        removedPaths: removedPaths.sort(),
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

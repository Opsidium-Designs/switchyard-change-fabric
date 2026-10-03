/**
 * The DeliveryProvider contract: promote a verified and integrated Change
 * result to a delivery target.
 *
 * Delivery is the last step of a Change: once work is verified and integrated
 * into one combined result, a DeliveryProvider takes that result and lands it
 * somewhere a human can review and ship from. The baseline, guaranteed target
 * is an ordinary local Git repository (a real branch and commit in the source
 * repo). Hosted forge adapters are not part of this contract.
 *
 * The contract is intentionally small and free of tenant, organizational, and
 * governance concepts: it only describes what to promote and where, and reports
 * what landed, so it can be embedded or called without carrying those internals.
 */

import type { GitIdentity } from "./git.ts";

/** What to promote: the integrated workspace and the Change it belongs to. */
export interface PromotionInput {
  /** The Change id, used to derive a default branch name and commit message. */
  readonly changeId: string;
  /** The Change objective, included in the commit message body. */
  readonly objective?: string;
  /** Clone URL of the integrated workspace (file:// or https). */
  readonly integrationGitUrl: string;
  /**
   * The branch in the integrated workspace that holds the combined result.
   * Defaults to the workspace default branch when omitted.
   */
  readonly integrationBranch?: string;
}

/** Where and how to promote the result into the local source repository. */
export interface PromotionTarget {
  /** Absolute path to the ordinary local Git repository to promote into. */
  readonly repoDir: string;
  /**
   * The branch to create for the delivery. Defaults to a deterministic name
   * derived from the Change id ("switchyard/<changeId>").
   */
  readonly branch?: string;
  /**
   * The existing ref the delivery branch starts from (for example "main" or a
   * commit). Defaults to the repository's current branch.
   */
  readonly startPoint?: string;
  /** The commit message for the promotion commit. Defaults to a derived one. */
  readonly commitMessage?: string;
  /** Deterministic committer identity, for reproducible promotion commits. */
  readonly identity?: GitIdentity;
}

/** The outcome of promoting an integrated result into a local repository. */
export interface PromotionResult {
  /** The Change id that was promoted. */
  readonly changeId: string;
  /** The branch created (or reused) in the local repository. */
  readonly branch: string;
  /** The promotion commit hash, or an empty string when nothing changed. */
  readonly commit: string;
  /** The repository-relative paths delivered by the promotion. */
  readonly deliveredPaths: readonly string[];
  /** True when the promotion created a commit; false when there was nothing to do. */
  readonly committed: boolean;
}

/** Promote a verified and integrated Change result to a delivery target. */
export interface DeliveryProvider {
  /** A stable identifier, e.g. "local-git". */
  readonly name: string;
  /** Promote the integrated result into the delivery target. */
  promote(input: PromotionInput, target: PromotionTarget): Promise<PromotionResult>;
}

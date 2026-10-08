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
  /**
   * The number of verified WorkUnits the integration landed in the promoted
   * tree. When this is greater than zero a fix was expected to be present, so
   * the integrated tree MUST differ from the delivery branch start point. If it
   * does not (the integration never advanced past the baseline seed, so the gate
   * passed on a baseline-identical tree and promotion would silently ship the
   * unfixed baseline), promotion fails loudly instead of committing the baseline.
   * This keeps the gated tree and the promoted tree the same: a run that greened
   * because its edits were detected is the only run that promotes content, and a
   * run whose edits vanished before integration cannot masquerade as a landed
   * fix. Omitted or zero means no fix was expected (an empty or additive-only
   * change), so an unchanged promotion is a normal no-op.
   */
  readonly expectedIntegratedUnits?: number;
  /**
   * True when this run EXPECTED a fix because the change required a behavioral
   * app gate (fixes were expected regardless of how many units ultimately
   * integrated). The gate-equals-deploy guard treats this the same as
   * `expectedIntegratedUnits > 0`: the integrated tree MUST differ from the
   * baseline start point, or promotion refuses to ship the unfixed baseline.
   * This closes the live false-green path where a failed/empty integration left
   * `expectedIntegratedUnits` at zero and silently exempted the baseline ship.
   * Omitted or false means no fix was expected, so an unchanged promotion is a
   * normal no-op.
   */
  readonly expectedFixes?: boolean;
  /**
   * The authoritative integration verdict the mechanical gate produced for the
   * integrated tree. When supplied, promotion REFUSES anything other than
   * "verified": a tree whose gate failed (or could not run) never gets a
   * delivery branch. Omitted means the caller did not gate (an older or offline
   * caller), which keeps the previous behavior.
   */
  readonly verdict?: "verified" | "failed";
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
  /**
   * The repository-relative paths removed from the delivery branch because the
   * integrated tree no longer tracks them (a verified fix that deleted or
   * renamed a file). Reconciling these keeps the promoted tree byte-identical to
   * the integrated tree the gate ran on. Empty when the fix only added or
   * modified files.
   */
  readonly removedPaths: readonly string[];
  /** True when the promotion created a commit; false when there was nothing to do. */
  readonly committed: boolean;
  /**
   * Why the run did not promote at all (for example the integration verdict was
   * not "verified"), when it refused. Absent on a normal promotion or no-op.
   * A refused promotion has no branch commit and `committed` is false.
   */
  readonly refusedReason?: string;
}

/** Promote a verified and integrated Change result to a delivery target. */
export interface DeliveryProvider {
  /** A stable identifier, e.g. "local-git". */
  readonly name: string;
  /** Promote the integrated result into the delivery target. */
  promote(input: PromotionInput, target: PromotionTarget): Promise<PromotionResult>;
}

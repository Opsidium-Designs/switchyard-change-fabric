/**
 * Verification contracts and the typed evidence schema for the Switchyard
 * Change Fabric.
 *
 * Verification is deterministic: given a workspace checkout plus a verification
 * contract, it runs a fixed set of checks (clean state, declared path scope, the
 * configured test command, and an optional lint/static command) and produces a
 * typed result. It never calls a model, so results are reproducible and depend
 * only on the checkout and the contract.
 *
 * The schema is intentionally free of tenant, organizational-unit, and
 * governance concepts: it only describes which checks ran and whether each
 * passed, so it can be embedded or called as a service without carrying those
 * internals.
 */

import type { TestProgress } from "./test-inventory.ts";

/** The kind of check a verification run performs. */
export type CheckKind = "clean-state" | "path-scope" | "test" | "lint" | "app-gate";

/**
 * A coarse integration phase, reported as it starts (progress only, never a
 * verdict): reading and verifying the units' pushes (`fetch`), composing them
 * onto the base (`merge`), the gate's dependency install (`install`), and the
 * authoritative gate itself (`gate`).
 */
export type IntegrationPhase = "fetch" | "merge" | "install" | "gate";

/** Overall verdict for a WorkUnit or for the integration. */
export type Verdict = "verified" | "failed";

/**
 * What a WorkUnit must satisfy to be considered verified. All of this is
 * supplied by the caller (derived from the Change and WorkUnit), so the
 * provider itself holds no policy.
 */
export interface VerificationContract {
  /** The WorkUnit id this contract verifies (for evidence labelling). */
  readonly unitId: string;
  /**
   * Declared path globs the WorkUnit is allowed to touch. The path-scope check
   * fails if the checkout changed any file outside these globs relative to the
   * baseline. An empty list means the WorkUnit declared no scope, which the
   * path-scope check treats as "no file may change".
   */
  readonly paths: readonly string[];
  /**
   * Repository-relative paths that must exist in the checkout for it to be in a
   * clean, expected state (for example a marker the executor was meant to
   * write). Empty means no required files.
   */
  readonly expectedFiles?: readonly string[];
  /**
   * The test command to run inside the checkout, as argv (program plus args).
   * When omitted, the test check is skipped and reported as such.
   */
  readonly testCommand?: readonly string[];
  /**
   * An optional lint/static command to run inside the checkout, as argv. When
   * omitted, the lint check is skipped and reported as such.
   */
  readonly lintCommand?: readonly string[];
  /**
   * The per-app BEHAVIORAL gate command to run inside the checkout, as argv
   * (program plus args). This is the real mechanical check that the planted bug
   * is actually fixed (it imports the app's fetch handler and asserts on the
   * Response, with a syntax/typecheck step so a broken edit fails). Unlike the
   * optional `testCommand`/`lintCommand`, when a unit declares it is an app-gate
   * unit (see `requiresAppGate`) and this command is absent, the app-gate check
   * is a FAIL, not a skip: absence of a gate is cannot-pass, never auto-pass.
   * This is what closes the vacuous-verify trap, so a unit with no real gate can
   * never green by having nothing to run.
   */
  readonly appGateCommand?: readonly string[];
  /**
   * True when this unit MUST satisfy a per-app behavioral gate to be verified.
   * When true and `appGateCommand` is absent, the app-gate check FAILS (cannot
   * auto-pass). When false (the default), a unit with no gate command behaves as
   * before (the app-gate check is simply not applicable), so declared-scope-only
   * units such as a marker-writing demo keep their existing behavior.
   */
  readonly requiresAppGate?: boolean;
  /**
   * The repository-relative paths the WorkUnit actually changed, as reported by
   * the runner. The path-scope check compares these against `paths`. When the
   * caller does not provide this, the provider derives changed paths from Git.
   */
  readonly changedPaths?: readonly string[];
  /**
   * Globs this WorkUnit's repo may have changed but YIELDS to other owners (for
   * example the files of an item it handed off). Changed paths matching them are
   * left out of the scope check, and the integrator never applies them from this
   * unit, so a handed-off file cannot fail (or leak into) this unit.
   */
  readonly yieldedScope?: readonly string[];
}

/** A captured reference to a check's output (kept small and inlined here). */
export interface OutputRef {
  /** Which stream the captured text came from. */
  readonly stream: "stdout" | "stderr" | "summary";
  /** The captured text (trimmed and length-bounded for determinism). */
  readonly text: string;
}

/** The result of a single check within a verification run. */
export interface CheckResult {
  readonly kind: CheckKind;
  /** True when the check passed; false when it failed. */
  readonly passed: boolean;
  /** True when the check was not applicable and was skipped (counts as passed). */
  readonly skipped: boolean;
  /** A short, human-readable summary of the outcome. */
  readonly summary: string;
  /** Captured output references for the check (may be empty). */
  readonly outputs: readonly OutputRef[];
  /**
   * ADVISORY test progress read from the check's FULL output (the captured
   * outputs are bounded, so a later suite's summary may be cut from them).
   * Never a verdict.
   */
  readonly progress?: TestProgress;
}

/** The full verification evidence for one WorkUnit. */
export interface WorkUnitVerification {
  readonly unitId: string;
  readonly verdict: Verdict;
  /** The checks that ran, in a stable order. */
  readonly checks: readonly CheckResult[];
}

/** The outcome of integrating verified WorkUnits and running the final suite. */
export interface IntegrationResult {
  readonly verdict: Verdict;
  /** The WorkUnit ids that were integrated, in integration order. */
  readonly integratedUnits: readonly string[];
  /** The WorkUnit ids kept out of integration because they failed verification. */
  readonly excludedUnits: readonly string[];
  /** The final-suite check run over the combined workspace. */
  readonly finalCheck: CheckResult;
  /**
   * The commit of the exact integrated tree the final check ran on (the
   * integration checkout's HEAD after applying the verified units). It is
   * pushed to the integration workspace only when the verdict is verified, so a
   * failed tree's commit is a record of what the gate rejected, not a ref that
   * can be fetched later. Absent only when the commit could not be read.
   */
  readonly commit?: string;
  /**
   * Protected paths (the files that define the gate) the verified units tried to
   * change. They were restored from the baseline before the gate ran, and their
   * presence fails the integration verdict. Absent when nothing protected changed.
   */
  readonly protectedViolations?: readonly string[];
  /**
   * The compare-and-swap push that moved the integration branch to `commit`:
   * the ref and the old value the push leased (null when the branch did not
   * exist). Absent when the branch was not pushed (a failed verdict, nothing
   * committed, or a deferred push to a candidate ref).
   */
  readonly promotion?: PromotionPush;
  /**
   * Per verified unit, in integration order: the files it applied to the
   * integrated tree (copied or deleted, before the contract restore) and the
   * changed files it yielded (left to the items or owners they belong to).
   */
  readonly appliedUnits?: readonly AppliedUnit[];
}

/** What one verified unit put into the integrated tree, and what it left out. */
export interface AppliedUnit {
  readonly unitId: string;
  /** Files applied from the unit (sorted). */
  readonly applied: readonly string[];
  /** Changed files of the unit that were not applied from it (sorted). */
  readonly yielded: readonly string[];
}

/**
 * A compare-and-swap branch push that landed: the ref moved from exactly
 * `expectedOld` to `commit` (the gated commit), with the old value checked by
 * the server in the same push.
 */
export interface PromotionPush {
  readonly ref: string;
  readonly commit: string;
  /** The value the ref was leased at (null: the ref had to be absent). */
  readonly expectedOld: string | null;
}

/**
 * The Change's evidence summary: which WorkUnits ran, each unit's verdict and
 * checks, and the integration result. This is the single artifact a caller
 * reads to see what happened without re-running anything.
 */
export interface EvidenceSummary {
  readonly changeId: string;
  readonly units: readonly WorkUnitVerification[];
  readonly integration: IntegrationResult;
  /**
   * The write-lease coordination applied before integration, when the Change
   * had declared path collisions. Omitted when there were no collisions.
   */
  readonly coordination?: CoordinationSummary;
}

/**
 * The recorded coordination decision for a Change's contested paths. It mirrors
 * change-core's LeasePlan so a caller can see, without re-running anything,
 * which paths collided, who was granted each write lease, who waited, and
 * whether anything was flagged for attention.
 */
export interface CoordinationSummary {
  /** One recorded decision per contested path. */
  readonly decisions: readonly CoordinationDecision[];
  /** True when at least one contested path was flagged rather than serialized. */
  readonly needsAttention: boolean;
}

/** The recorded decision for one contested path. */
export interface CoordinationDecision {
  readonly path: string;
  /** The colliding WorkUnit ids, sorted. */
  readonly contenders: readonly string[];
  /** "serialized" when a single owner was granted the lease, else "flagged". */
  readonly resolution: "serialized" | "flagged";
  /** The WorkUnit granted the lease, when serialized. */
  readonly owner?: string;
  /** The WorkUnit ids told to wait for the owner, when serialized. */
  readonly waiters: readonly string[];
  /** A short, human-readable reason for the decision. */
  readonly reason: string;
  /**
   * Present when a human owner decision was supplied for this path:
   * "human-decision" when it was applied, "declared-order" when it was rejected
   * and the deterministic owner was kept (the reason says why).
   */
  readonly ownerSource?: "human-decision" | "declared-order";
  /** The human owner decision that was requested for this path, when one was. */
  readonly requestedOwner?: string;
}

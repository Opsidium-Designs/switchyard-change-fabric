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

/** The kind of check a verification run performs. */
export type CheckKind = "clean-state" | "path-scope" | "test" | "lint";

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
   * The repository-relative paths the WorkUnit actually changed, as reported by
   * the runner. The path-scope check compares these against `paths`. When the
   * caller does not provide this, the provider derives changed paths from Git.
   */
  readonly changedPaths?: readonly string[];
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
}

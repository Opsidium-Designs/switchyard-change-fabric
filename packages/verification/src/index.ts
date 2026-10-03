/**
 * verification: deterministic WorkUnit verification and integration of verified
 * work for the Switchyard Change Fabric.
 *
 * The public surface:
 *   - types:               the verification contract and the typed evidence
 *                          schema (per-check pass/fail, summary, captured output)
 *   - VerificationProvider: run clean-state, path-scope, test, and lint checks
 *                          against one WorkUnit checkout, deterministically
 *   - Integrator:          combine verified WorkUnit workspaces into one
 *                          integration workspace and run the final suite
 *   - ChangeVerification:  drive verify-then-integrate for a whole Change and
 *                          produce its evidence summary (reuses change-core)
 *   - pathscope / command: the deterministic glob matcher and injectable
 *                          command runner the checks are built on
 *
 * Everything is deterministic and never depends on live model behavior, so a
 * given set of checkouts and contracts always yields the same evidence.
 */

export type {
  CheckKind,
  CheckResult,
  CoordinationDecision,
  CoordinationSummary,
  EvidenceSummary,
  IntegrationResult,
  OutputRef,
  VerificationContract,
  Verdict,
  WorkUnitVerification,
} from "./types.ts";

export type {
  CommandOutcome,
  CommandRunner,
} from "./command.ts";
export {
  ChildProcessCommandRunner,
  MAX_CAPTURED_CHARS,
  boundOutput,
} from "./command.ts";

export { matchesAny, matchesGlob, partitionByScope } from "./pathscope.ts";

export type { GitIdentity } from "./git.ts";
export { DEFAULT_IDENTITY } from "./git.ts";

export type {
  VerificationProviderOptions,
  VerifyOptions,
} from "./verifier.ts";
export { VerificationProvider } from "./verifier.ts";

export type {
  IntegrateOptions,
  IntegratorOptions,
  VerifiedWorkspace,
} from "./integrator.ts";
export { Integrator } from "./integrator.ts";

export type {
  CompletedWorkUnit,
  VerifyAndIntegrateOptions,
} from "./change-verification.ts";
export { ChangeVerification } from "./change-verification.ts";

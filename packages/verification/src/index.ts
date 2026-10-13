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
  AppliedUnit,
  CheckKind,
  CheckResult,
  CoordinationDecision,
  CoordinationSummary,
  EvidenceSummary,
  IntegrationResult,
  OutputRef,
  PromotionPush,
  VerificationContract,
  Verdict,
  WorkUnitVerification,
} from "./types.ts";

export type {
  CommandOutcome,
  CommandRunner,
  CommandRunOptions,
} from "./command.ts";
export type { ChildProcessCommandRunnerOptions } from "./command.ts";
export {
  ABORT_KILL_GRACE_MS,
  abortedOutcome,
  ChildProcessCommandRunner,
  COMMAND_ABORTED_LINE,
  DEFAULT_COMMAND_TIMEOUT_MS,
  gateEnvironment,
  MAX_CAPTURED_CHARS,
  boundOutput,
} from "./command.ts";

export type {
  DependencyInstaller,
  DependencyInstallOutcome,
  DependencyInstallPlan,
  DependencyInstallStatus,
  LockfileDependencyInstallerOptions,
} from "./dependency-install.ts";
export {
  DEFAULT_INSTALL_TIMEOUT_MS,
  dependencyInstallFailureLine,
  formatDependencyInstall,
  InstallingCommandRunner,
  LockfileDependencyInstaller,
  NO_DEPENDENCY_INSTALL,
  planDependencyInstall,
  programOnPath,
} from "./dependency-install.ts";
export type { DependencySnapshot, DependencySource, RunnerResolutionContract } from "./runner-resolution.ts";
export {
  assertRunnerResolutionUnchanged,
  DEPENDENCY_MAPS,
  MAX_LOCKFILE_KEYS,
  NPM_LOCKFILES,
  OPAQUE_LOCKFILES,
  readDependencySnapshot,
  readDependencySnapshotFromDir,
  RESOLUTION_SECTIONS,
  runnerClosure,
  runnerPackagesFor,
  runnerPackagesFromJsonKeys,
  runnerResolutionContract,
  runnerResolutionViolations,
} from "./runner-resolution.ts";

export { matchesAny, matchesGlob, partitionByScope } from "./pathscope.ts";
export type {
  RunToolOptions,
  SkeletonRegion,
  ToolFinding,
  ToolGateCheck,
  ToolGateKind,
  ToolGateOptions,
  ToolGateResult,
  ToolRunLimits,
  ToolRunResult,
} from "./tool-gate.ts";
export {
  DEFAULT_TOOL_TIMEOUT_MS,
  materializeToolTree,
  MAX_TOOL_FINDINGS,
  parseToolFindings,
  runToolGate,
  runToolInCopy,
  syntaxProblem,
  TOOL_BASELINE_ENV,
  TOOL_EDIT_LIB,
  TOOL_ENTRY,
  TOOL_SKELETON_MARKER,
  toolEditLibSource,
  toolEntryPath,
  toolSkeleton,
  RegionSpliceError,
  skeletonRegions,
  spliceRegions,
  toolUsage,
  validToolArg,
} from "./tool-gate.ts";
export { gateFailureLine } from "./gate-failure.ts";
export type { PrePushCheck, PrePushCheckInput, PrePushCheckResult, PrePushTypecheckOptions } from "./pre-push-typecheck.ts";
export { createPrePushTypecheck, DEFAULT_PRE_PUSH_TYPECHECK_TIMEOUT_MS } from "./pre-push-typecheck.ts";

export type { GitIdentity } from "./git.ts";
export { withoutCredentials } from "./git.ts";
export { DEFAULT_IDENTITY } from "./git.ts";

export type {
  VerificationProviderOptions,
  VerifyOptions,
} from "./verifier.ts";
export { VerificationProvider } from "./verifier.ts";

export type {
  AdvanceBranchOptions,
  IntegrateOptions,
  IntegratorOptions,
  PromotionRefusalReason,
  VerifiedWorkspace,
} from "./integrator.ts";
export {
  advanceIntegrationBranch,
  GATED_REF_PREFIX,
  gatedRef,
  IntegrationAbortedError,
  Integrator,
  isIntegrationAborted,
  isPromotionRefused,
  PromotionRefusedError,
  recordBaselineInventory,
} from "./integrator.ts";
export type { ClashHead, ClashOutcome, ClashPair, ClashPrediction, PredictClashesInput } from "./clash.ts";
export { CLASH_DEFAULTS, predictClashes } from "./clash.ts";
export type { TestInventory, TestProgress } from "./test-inventory.ts";
export { inventoryAfterContracts, inventoryShortfall, labelGateProgress, readStreamInventory, readTestInventory, readTestProgress } from "./test-inventory.ts";
export type { GateProgress, TestSuiteProgress } from "./test-inventory.ts";

export type {
  CompletedWorkUnit,
  VerifyAndIntegrateOptions,
} from "./change-verification.ts";
export type { UnitPart } from "./integrator.ts";
export { ChangeVerification } from "./change-verification.ts";

export type {
  AdvanceJob,
  AdvanceJobResult,
  EgressPhase,
  GateJob,
  GateJobResult,
  IntegrateJob,
  IntegrateJobResult,
  IntegrateJobPart,
  IntegrateJobUnit,
  IntegrationJobKeyInput,
  JobInstallOutcome,
  JobPhaseRecord,
  JobProtectedJsonKeys,
} from "./integrate-job.ts";
export {
  ackLine,
  EGRESS_PHASES,
  INTEGRATE_JOB_VERSION,
  advanceJobKey,
  integrationJobKey,
  integrationJobKeyMaterial,
  JOB_LIMITS,
  JOB_PROTOCOL,
  parseGateJob,
  parseGateJobResult,
  parseProtocolLine,
  phaseLine,
  phaseTransitionAllowed,
  resultLine,
  scrubJobText,
  serializeGateJob,
} from "./integrate-job.ts";
export type { GateContainment, GateJobHooks, GateSandbox, RunGateJobOptions } from "./integrate-run.ts";
export {
  reapSandbox,
  runAdvanceJob,
  runGateJob,
  runIntegrateJob,
  SANDBOX_MAX_PROCESSES,
  SandboxedCommandRunner,
  sandboxContainment,
  userProcesses,
} from "./integrate-run.ts";
export type { AssessTestTeethInput, CheckReleasedTestTeethInput, TestTeethRecord, TestTeethRun, TestTeethStatus } from "./test-teeth.ts";
export { assessTestTeeth, checkReleasedTestTeeth, isTestFile, TEETH_RUNNER_UNKNOWN, testFileCommand } from "./test-teeth.ts";

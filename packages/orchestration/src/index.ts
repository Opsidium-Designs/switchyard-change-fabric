/**
 * orchestration: drive a Change end to end, deterministically and offline.
 *
 * The public surface:
 *   - runChange / describeChange: assemble orchestration, runners, verification,
 *     integration, conflict coordination, local Git promotion, and cleanup into
 *     one call, using the deterministic noop executor and the honest local
 *     fallback by default so it runs with no Cloudflare account.
 *   - LocalChangeControl: an in-process stand-in for the Worker control surface,
 *     reusing the real change-core scheduling, for Node callers (CLI, demo,
 *     tests) where the Durable Object runtime module does not resolve.
 *   - formatRunSummary / formatChangePlan / formatStateView: readable, plain-text
 *     reports that tell the coordination story.
 *   - runDoctor / formatDoctorReport: an offline-safe prerequisite readiness
 *     check.
 *
 * These are Node-side helpers (they run Git and child processes), so they live
 * outside the Cloudflare Worker.
 */

export type {
  ChangeStateView,
  CostEvent,
  DeploymentRecord,
  Escalation,
  EscalationKind,
  EscalationStatus,
  FailureRecord,
  LeaseEdge,
  BoardAppendResponse,
  BoardFailure,
  BoardView,
  LeaseRecord,
  RaiseEscalationInput,
  RecruitmentEvent,
  RecruitmentPlan,
  RepoPushedResult,
  ToolConsumption,
  ToolRecord,
  VerifyAttempt,
  VerifyOutcome,
  RefanSource,
  RetryAttempt,
  WorkspaceIdentity,
  WorkUnitView,
} from "./local-control.ts";
export { LocalChangeControl, workspaceNameFor } from "./local-control.ts";

export type {
  AgentRunReport,
  RecruitmentWave,
  RepoPushedEvent,
  RunRecruitmentOptions,
  RunRecruitmentResult,
} from "./recruit-run.ts";
export { cleanupRunRoot, runRecruitment } from "./recruit-run.ts";

export type {
  LiveAgentReport,
  LiveTrigger,
  LiveWave,
  RunRecruitmentLiveOptions,
  RunRecruitmentLiveResult,
} from "./recruit-live.ts";
export { runRecruitmentLive } from "./recruit-live.ts";

export type {
  CleanupLiveResult,
  DeployApp,
  EscalationReport,
  EscalationResolution,
  EscalationResolver,
  FullLiveEvent,
  PlanningChangeHeader,
  RePlanResult,
  RePlanTransport,
  RePlanUnit,
  RunFullLiveOptions,
  RunFullLiveResult,
  TeardownApp,
} from "./run-live.ts";
export { cleanupLive, createPlanningChange, failPlanningChange, runFullLive } from "./run-live.ts";
export { WORKER_API_TOKEN_ENV, withWorkerAuth, workerApiToken } from "./worker-auth.ts";
export { redactSecrets } from "./redact.ts";

export type { AppDeploymentMarker } from "./app-deploy.ts";
export {
  clearAppDeployment,
  deploymentsDir,
  markerPath,
  readAppDeployment,
  recordAppDeployment,
  stableAppWorkerName,
} from "./app-deploy.ts";

export type {
  RunChangeOptions,
  RunChangeResult,
  RunEvent,
  UnitRunReport,
} from "./run-change.ts";
export { describeChange, runChange } from "./run-change.ts";

export type {
  BuildToolOptions,
  ToolBuildResult,
  ToolConsumptionRecord,
  ToolWorkspaceIdentity,
} from "./tool-build.ts";
export { maybeBuildTool } from "./tool-build.ts";

export type { ToolRequirement } from "@switchyard-change/change-core";
export { detectToolRequirement } from "@switchyard-change/change-core";

export type { RepoFile, RepoSnapshot } from "@switchyard-change/change-core";
export { scanRepoFiles, scanRepoSnapshot } from "./scan-repo.ts";

export type { ConcurrencyDial } from "@switchyard-change/change-core";
export { DEFAULT_DIAL } from "@switchyard-change/change-core";

export type { Change, WorkUnit } from "@switchyard-change/change-core";
export type { PlanSource, RecordedPlan } from "@switchyard-change/change-core";

export type { DecomposeGoalOptions, DecomposeGoalResult, PlannerInjection } from "./decompose-goal.ts";
export {
  decomposeGoal,
  formatDecomposition,
  changeToSpecYaml,
} from "./decompose-goal.ts";

export { formatChangePlan, formatRecruitmentSummary, formatRunSummary, formatStateView } from "./summary.ts";

export type {
  ChangeStateSnapshot,
  CostEventSnapshot,
  DependencySnapshot,
  DeploymentSnapshot,
  DialSnapshot,
  EdgeBacking,
  EscalationSnapshot,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  LeaseEdgeSnapshot,
  NodeBacking,
  PlanSnapshot,
  PlannerDetailSnapshot,
  PlannerUnitDetail,
  RecruitmentEventSnapshot,
  ToolConsumptionSnapshot,
  ToolSnapshot,
  VerifyAttemptSnapshot,
  RetryAttemptSnapshot,
  WorkGraphModel,
  WorkspaceIdentitySnapshot,
  WorkUnitSnapshot,
  WorkUnitStatus,
} from "./graph-model.ts";
export { assertBacked, buildWorkGraphModel, goalNodeId, plannerNodeId, replanNodeId, retryNodeId, roundAgentNodeId, toolNodeId, unitNodeId, verifyNodeId } from "./graph-model.ts";

export type { CheckStatus, DoctorCheck, DoctorEnv, DoctorReport } from "./doctor.ts";
export { formatDoctorReport, runDoctor } from "./doctor.ts";

export type { ExecutorEnv, SelectedAgentTurn, SelectedExecutor, SelectedPlanner, PlanTransport } from "./executor-select.ts";
export type { LivePlannerDecision, PlannerFailure } from "./executor-select.ts";
export {
  ALLOW_HEURISTIC_PLANNER_FLAG,
  allPlannerCallsRateLimited,
  DEFAULT_WORKERS_AI_ESCALATION_MODEL,
  decideLivePlanner,
  modelPlanRefusal,
  plannerFallbackBanner,
  REQUIRE_MODEL_PLAN_FLAG,
  selectExecutor,
  selectAgentTurn,
  selectPlanner,
  SUPPORTED_EXECUTORS,
} from "./executor-select.ts";
export {
  DEFAULT_JEV_CONFIDENCE_THRESHOLD,
  selectJev,
} from "./executor-select.ts";
export type { SelectedJev } from "./executor-select.ts";

export type { AppGateWiring, AppGateWiringInput } from "./app-gate-wiring.ts";
export {
  APP_GATE_COMMAND,
  APP_GATE_SCRIPT,
  buildAppGateWiring,
  projectHasGateScript,
} from "./app-gate-wiring.ts";

export type {
  BoardAccepted,
  BoardJoined,
  BoardPage,
  BoardPostOutcome,
  BoardRejection,
  JoinedWorkspace,
} from "./board-client.ts";
export { BOARD_AGENT_TOKEN_HEADER, BoardAgentClient, BoardOperatorClient, readBoardLog, readBoardPage } from "./board-client.ts";

export type {
  AgentStepResult,
  AgentStop,
  AgentTurnRecord,
  BoardAgentOptions,
  BoardJoiner,
  BoardSeedItem,
} from "./board-agent.ts";
export { BoardAgent, heldWorkCue, listRepoFiles, MAX_CONTRACT_CUES, pendingContractCue, resolveIntentFiles, RunTurnBudget } from "./board-agent.ts";

export { coveredByOutstanding, createGenericBoardPolicy } from "./board-policy.ts";
export { selectToolFiller } from "./executor-select.ts";
export type { SelectedToolFiller } from "./executor-select.ts";
export type { ToolAuthor, ToolAuthorRequest, ToolBenchOptions, ToolGateRecord } from "./board-tools.ts";
export { executorToolAuthor, regionToolAuthor, templateToolAuthor, toolContract, ToolBench, ToolUseError } from "./board-tools.ts";

export type {
  BoardAgentRepo,
  BoardContractDecisionRequest,
  BoardDecisionRecord,
  BoardDecisionRecordOutcome,
  BoardRevision,
  BoardRunBudgets,
  BoardRunEffectiveBudgets,
  BoardRunEvent,
  BoardSeed,
  BoardStopReason,
  IntegrateBoardOptions,
  QuietBoardAction,
  IntegrateBoardResult,
  RecordBoardDecision,
  RunBoardOptions,
  RunBoardResult,
} from "./run-board.ts";
export type { ContractTriageDecision, ContractTriageInput } from "./contract-triage.ts";
export { formatAttributionTally, type AttributionTally } from "@switchyard-change/change-core";
export {
  ATTRIBUTION_INPUT_LIMITS,
  buildContractTriageState,
  CONTRACT_TRIAGE_KEY,
  CONTRACT_TRIAGE_LIMITS,
  CONTRACT_TRIAGE_QUESTION,
  CONTRACT_TRIAGE_QUESTIONS,
  frameAttributionInput,
  readTargetExcerpt,
  scrubForDecision,
  triageContract,
} from "./contract-triage.ts";
export {
  attributeRevisionFailure,
  boardRunExitCode,
  boardSeedFromChange,
  ContinuousBoardIntegrator,
  describeWorkspace,
  formatBoardRunSummary,
  formatBudgetsLine,
  formatToolRegistry,
  formatBoardTranscript,
  integrateBoardRevision,
  pendingPushKey,
  quietBoardActions,
  runBoard,
  undecidedContractLines,
} from "./run-board.ts";
export type { ModelPrice, RunCapReached, RunCaps } from "./run-meter.ts";
export { meteredExecutor, meteredJev, meteredToolAuthor, meteredTransport, parsePrice, parsePrices, RunMeter, validateSpendCap } from "./run-meter.ts";
export type { RateLimitBackoffEvent, RateLimitBackoffOptions, RateLimitNote } from "./rate-limit-backoff.ts";
export {
  DEFAULT_RATE_LIMIT_BASE_MS,
  DEFAULT_RATE_LIMIT_MAX_MS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  RateLimitBackoff,
  rateLimitedExecutor,
  rateLimitedTransport,
} from "./rate-limit-backoff.ts";
export type { ProofBundle, ProofBundleOptions, ProofCandidate, ProofCount } from "./proof-bundle.ts";
export { buildProofBundle, formatProofSpeculation, formatProofSummary } from "./proof-bundle.ts";
export type { RefreshableToken, TokenRefresherOptions } from "./token-refresh.ts";
export { TokenRefresher } from "./token-refresh.ts";
export type { PendingClashInput, PendingClashResult } from "./board-clash.ts";
export { recordPendingClashes } from "./board-clash.ts";
export type { ProtectedPaths } from "./protected-paths.ts";
export { deriveProtectedPaths, isRunnerConfig, isTestShaped, RUNNER_CONFIG_FILES, stepPrograms } from "./protected-paths.ts";
export { promoteVerifiedIntegration, redeployIfPreviouslyDeployed } from "./run-live.ts";
export type { LocalChangeControlOptions } from "./local-control.ts";
export type { RunBoardOfflineOptions } from "./run-board-offline.ts";
export { FirstAttemptFailingGate, OFFLINE_BOARD_EPOCH, OFFLINE_GATE_FIXTURE_COMMAND, OFFLINE_TOOL_AUTHOR_LABEL, offlineFixtureGateLabel, runBoardOffline } from "./run-board-offline.ts";

export { ChildProcessCommandRunner } from "@switchyard-change/verification";
export { createPrePushTypecheck, type PrePushCheck } from "@switchyard-change/verification";
export {
  formatDependencyInstall,
  InstallingCommandRunner,
  LockfileDependencyInstaller,
  NO_DEPENDENCY_INSTALL,
  type DependencyInstaller,
  type DependencyInstallOutcome,
} from "@switchyard-change/verification";

export type { JevSmokeResult } from "./jev-smoke.ts";
export { runJevSmoke } from "./jev-smoke.ts";
export type { ToolSmokeAttempt, ToolSmokeBuild, ToolSmokeOptions } from "./tool-smoke.ts";
export { formatToolSmokeBuild, runToolSmoke } from "./tool-smoke.ts";

export type {
  BoardCaption,
  BoardColumns,
  BoardEscalationAtK,
  BoardGraphEdge,
  BoardGraphEdgeKind,
  BoardGraphModel,
  BoardGraphNode,
  BoardGraphNodeKind,
  BoardHullRect,
  BoardLayout,
  BoardMessageFamily,
  BoardNodeDetail,
  BoardPoint,
  BoardSelection,
  BoardTicker,
} from "./board-graph.ts";
export {
  aggregateMessageEdges,
  assertBoardBacked,
  boardCaptions,
  boardJumpTargets,
  boardLayout,
  boardMessageFamily,
  boardNodePoint,
  boardThread,
  buildBoardGraph,
  pendingEscalations,
  revVerdictLabel,
} from "./board-graph.ts";
export { finishWorkRoot, isDisposableWorkRoot, KEEP_WORK_ROOT_FLAG, pruneWorkRoot } from "./work-root.ts";

export {
  credentialKeysIn,
  initialEnvironmentCredentialKeys,
  isCredentialKey,
  loadDotEnvFile,
  parseDotEnv,
  runtimeCredentialNames,
  runtimeEnv,
  setRuntimeCredentials,
  withoutCredentials as withoutCredentialEnv,
} from "./credentials.ts";
export type { CandidateOutcome, SpeculativeRoundOptions, SpeculativeRoundResult } from "./speculative-integration.ts";
export { DEFAULT_SPECULATE, formatCandidates, integrateSpeculativeRound, MAX_SPECULATE } from "./speculative-integration.ts";

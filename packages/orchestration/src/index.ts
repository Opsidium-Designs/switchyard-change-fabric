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
  LeaseRecord,
  RaiseEscalationInput,
  RecruitmentEvent,
  RecruitmentPlan,
  RepoPushedResult,
  ToolConsumption,
  ToolRecord,
  VerifyAttempt,
  VerifyOutcome,
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
  RunFullLiveOptions,
  RunFullLiveResult,
  TeardownApp,
} from "./run-live.ts";
export { cleanupLive, runFullLive } from "./run-live.ts";

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
export { assertBacked, buildWorkGraphModel, goalNodeId, plannerNodeId, retryNodeId, roundAgentNodeId, toolNodeId, unitNodeId, verifyNodeId } from "./graph-model.ts";

export type { CheckStatus, DoctorCheck, DoctorEnv, DoctorReport } from "./doctor.ts";
export { formatDoctorReport, runDoctor } from "./doctor.ts";

export type { ExecutorEnv, SelectedExecutor, SelectedPlanner, PlanTransport } from "./executor-select.ts";
export { DEFAULT_WORKERS_AI_ESCALATION_MODEL, selectExecutor, selectPlanner } from "./executor-select.ts";

export type { AppGateWiring, AppGateWiringInput } from "./app-gate-wiring.ts";
export {
  APP_GATE_COMMAND,
  APP_GATE_SCRIPT,
  buildAppGateWiring,
  projectHasGateScript,
} from "./app-gate-wiring.ts";

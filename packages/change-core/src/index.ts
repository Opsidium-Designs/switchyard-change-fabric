/**
 * change-core: portable coordination contracts and pure scheduling logic for
 * the Switchyard Change Fabric.
 *
 * The public surface:
 *   - types:  Change / WorkUnit / Dependency / WorkGraph / status enums
 *   - loader: parse and validate a Change spec from YAML text
 *   - graph:  build the WorkGraph and compute runnable/waiting status and
 *             declared path collisions, all pure and deterministic
 *
 * Everything here is free of I/O (the loader only parses text it is given), so
 * it can run unchanged in a Worker, a test, or a CLI.
 */

export type {
  AssuranceLevel,
  Change,
  ChangeBlueprint,
  ChangeBlueprintContract,
  ChangeBlueprintModule,
  ChangePlan,
  ChangePlanReview,
  ChangePlanSource,
  ChangePlanUnit,
  Dependency,
  PathCollision,
  WorkGraph,
  WorkUnit,
  WorkUnitStatus,
} from "./types.ts";

export { ChangeSpecError, normalizeChange, parseChangeSpec } from "./loader.ts";

export {
  buildWorkGraph,
  detectPathCollisions,
  findDependencyCycle,
  findWorkUnit,
  runnableUnits,
  waitingUnits,
  workUnitStatuses,
} from "./graph.ts";

export type {
  LeaseDecision,
  LeaseOwnerEscalationLike,
  LeasePlan,
  LeaseResolution,
  PlanWriteLeasesOptions,
  UnitLeaseView,
} from "./lease.ts";
export {
  leaseOwnerOverridesFromEscalations,
  planWriteLeases,
  unitLeaseViews,
} from "./lease.ts";

export type {
  ExportedSymbol,
  ModuleGroup,
  RepoFile,
  RepoSnapshot,
  SourceFileFacts,
} from "./repo-snapshot.ts";
export { buildRepoSnapshot, isTestPath } from "./repo-snapshot.ts";

export type { ActionFamily, GoalAnalyzer, GoalIntent } from "./goal.ts";
export { HeuristicGoalAnalyzer } from "./goal.ts";

export type { DecomposeOptions, DecomposeResult } from "./decompose.ts";
export { decompose, decomposeToChange } from "./decompose.ts";

export type {
  PlannedShape,
  PlannedUnit,
  PlanDiagnostic,
  PlanGoalOptions,
  PlanGoalResult,
  PlanReviewDecision,
  PlanSource,
  PlanTransport,
  JevTransport,
  RecordedPlan,
} from "./plan-goal.ts";
export { buildPlannerMessages, planGoal, summarizePlannerPrompt, validatePlan } from "./plan-goal.ts";

export type {
  BlueprintContract,
  BlueprintModule,
  CohesionBlueprint,
} from "./blueprint.ts";
export { deriveCohesionBlueprint } from "./blueprint.ts";

export type { DriveOptions, DriveTrace, DriveWave } from "./scheduler.ts";
export { driveWorkGraph } from "./scheduler.ts";

export type {
  ConcurrencyDial,
  RecruitDecision,
  RecruitInput,
} from "./recruit.ts";
export { DEFAULT_DIAL, normalizeDial, recruit } from "./recruit.ts";

export type { BoardToolNeed, BoardToolNeedItem, EditKind, ToolNeedOptions, ToolRequirement } from "./toolneed.ts";
export {
  capabilityId,
  defaultEditKindOf,
  detectBoardToolNeed,
  objectiveChangeWords,
  OBJECTIVE_OVERLAP,
  OBJECTIVE_SIMILARITY,
  detectToolRequirement,
  toolCapabilityFor,
  toolUnitId,
} from "./toolneed.ts";

export type { AppendResult, DiscoveredWorkUnit } from "./discover.ts";
export { appendDiscoveredUnits, discoveredUnitId, DiscoverError } from "./discover.ts";

export type {
  BoardAgent,
  BoardAppendResult,
  BoardAttributionState,
  BoardChildItem,
  BoardContest,
  BoardContestStatus,
  BoardContract,
  BoardDecisionJuncture,
  BoardDigest,
  BoardDigestHelp,
  BoardDigestStruggle,
  BoardRevProgress,
  BoardProgressScore,
  BoardSeam,
  BoardVolunteer,
  BoardDraft,
  BoardErrorCode,
  BoardEscalationRecord,
  BoardEscalationRequest,
  BoardFailingEvidence,
  BoardTestInventory,
  BoardFinding,
  BoardHelpRequest,
  BoardIntegratedRev,
  BoardIntent,
  BoardItem,
  BoardItemPush,
  BoardItemStatus,
  BoardMessage,
  BoardMessageOf,
  BoardMessageType,
  BoardOpenAttribution,
  BoardOrigin,
  BoardPayloads,
  BoardPublishedTool,
  BoardReview,
  BoardRules,
  BoardState,
  BoardSummary,
  BoardToolFinding,
  BoardToolGateCheck,
  BoardToolProposal,
  ContestResolution,
  ToolKind,
  IntegratedRevInput,
  BoardLeaseLapse,
  BoardWaitReason,
  BoardDigestWait,
  BoardClash,
  BoardCandidatePush,
  BoardClashHead,
  EngineRecordType,
} from "./board.ts";
export {
  appendBoardMessage,
  describeProgress,
  progressHeadline,
  appendDecisionRecorded,
  appendIntegratedRev,
  appendToolGated,
  appendToolUsed,
  appendSeamStalled,
  appendEngineRecord,
  promotionRefusal,
  ENGINE_RECORD_TYPES,
  applyBoardEscalations,
  applyBoardMessage,
  arbitrate,
  boardAttributionTally,
  BOARD_DECISION_JUNCTURES,
  BOARD_ENGINE,
  BOARD_HUMAN,
  BOARD_LIMITS,
  BOARD_MESSAGE_TYPES,
  BoardError,
  boardContestClosures,
  boardContractClosures,
  boardContractDecision,
  boardDigest,
  isAcceptedItem,
  isChangeItem,
  boardErrorStatus,
  boardEscalationRequests,
  boardMessagesAfter,
  boardResolutionForDecision,
  checkBoardJoin,
  checkBoardTransition,
  CONTRACT_TRIAGE_MARKER,
  contractTriageRecommendation,
  DEFAULT_BOARD_RULES,
  emptyBoard,
  foldBoard,
  LEAD_ROLE,
  parseBoardDraft,
  reduceBoard,
  releasedTargets,
  summarizeBoard,
  TOOL_CAPABILITY_PATTERN,
  TOOL_KINDS,
  TOOLS_DIR,
  toolItemId,
  toolScope,
  toolUnavailableReason,
  helpGrantLive,
  liveHelpGrants,
  takenHelpGrants,
  routedToSubLead,
  awaitsSubLeadMerge,
  checkHelpFork,
  mergedChildrenWrite,
  objectiveSubChanges,
  splitCue,
  uncoveredFailureFiles,
  contractCue,
  seamWaits,
  isSeamItem,
  seamContractCue,
  seamItemId,
  seamHolds,
  seamItemHolding,
  activeClaims,
  claimCapReached,
  leasesOn,
  arbitrationV2,
  arbitrationV3,
  arbitrationV4,
  arbitrationV5,
  progressScore,
  compareProgressScore,
  describeProgressScore,
  regressionQuote,
  stalledLapseUntakeable,
  waitingOnOthers,
  boardClock,
  CURRENT_ARBITRATION,
  itemWaitReason,
  describeWaitReason,
  replanEligible,
  BOARD_REPLAN_REASONS,
  type BoardReplanReason,
  scopeOverlaps,
  liveClashes,
  clashKey,
  integratedHead,
  leaseLapse,
  leaseSuspension,
  seamContractFacts,
  verifyBoard,
  withContractTriage,
} from "./board.ts";

export type {
  AttributionDisagreement,
  AttributionOutcome,
  AttributionResolution,
  AttributionTally,
  ParseAttributionOutcome,
} from "./attribution-outcome.ts";
export {
  formatAttributionTally,
  resolveAttributionOutcome,
  tallyAttributionOutcomes,
} from "./attribution-outcome.ts";

export {
  entriesOverlap,
  entryWithin,
  hasWildcard,
  intentPath,
  intentWithin,
  MAX_INTENT_ENTRY_LENGTH,
  normalizeIntentEntry,
  overlappingEntries,
} from "./path-overlap.ts";

export type {
  BoardEndpoint,
  BoardJoinResult,
  BoardPostResult,
  BoardPoster,
  BoardScript,
  BoardScriptRun,
  ContestAnswer,
  ScriptedAgent,
} from "./board-script.ts";
export { contestResponder, endpointPoster, pureBoardEndpoint, runBoardScript } from "./board-script.ts";

export type { BoardJoinWorkspaceRequest } from "./board-join.ts";
export {
  BOARD_AGENT_ID_PATTERN,
  BOARD_WORKSPACE_TTL_BOUNDS,
  boardAgentWorkspaceName,
  boardHelpForkWorkspaceName,
  parseBoardJoinWorkspace,
  toolBranch,
  toolsWorkspaceName,
} from "./board-join.ts";

export type { BoardIntegrationPlan, BoardIntegrationUnitPlan, CandidateVerdict, SpeculativeLanding } from "./board-integration-plan.ts";
export {
  awaitingSubLead,
  decideSpeculativeLanding,
  narrowToSplitChildren,
  pendingPushItems,
  integrablePushItems,
  pendingPushKey,
  planBoardIntegration,
  speculationStateKey,
  speculativeUnits,
} from "./board-integration-plan.ts";
export type { PrePassRatchet, RatchetStep } from "./progress-ratchet.ts";
export { prePassRatchet, ratchetHistory, ratchetLine, ratchetUnits } from "./progress-ratchet.ts";
export type { AttributableUnit } from "./failure-attribution.ts";
export { attributeFailure, combineAttribution, failingRepoFiles } from "./failure-attribution.ts";
export type { ImplicationSource } from "./failure-attribution.ts";

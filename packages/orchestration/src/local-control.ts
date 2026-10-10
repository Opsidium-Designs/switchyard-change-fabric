/**
 * local-control: an in-process Change control surface for Node callers.
 *
 * The Cloudflare Worker's ChangeState Durable Object imports the
 * `cloudflare:workers` runtime module, which does not resolve under plain Node
 * (the CLI, the demo, and tests). This module provides a faithful, in-process
 * stand-in that reuses the real change-core scheduling (runnableUnits,
 * workUnitStatuses, detectPathCollisions), so the coordination behavior is the
 * genuine logic rather than a reimplementation.
 *
 * It exposes the same lease, cost, complete, and state operations the Worker
 * exposes over HTTP, and provisions workspaces through the honest
 * local-filesystem fallback provider, so the whole clone, execute, commit, and
 * push loop runs offline with zero Cloudflare setup. It is deliberately not the
 * real service: every workspace it hands out is labelled as a local fallback.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  appendBoardMessage,
  appendDecisionRecorded,
  appendSeamStalled,
  appendEngineRecord,
  appendDiscoveredUnits,
  BOARD_AGENT_ID_PATTERN,
  boardAgentWorkspaceName,
  boardHelpForkWorkspaceName,
  checkHelpFork,
  BOARD_WORKSPACE_TTL_BOUNDS,
  checkBoardJoin,
  parseBoardJoinWorkspace,
  appendIntegratedRev,
  appendToolGated,
  appendToolUsed,
  toolsWorkspaceName,
  applyBoardEscalations,
  BOARD_LIMITS,
  BoardError,
  boardDigest,
  boardErrorStatus,
  boardContractDecision,
  boardResolutionForDecision,
  buildWorkGraph,
  emptyBoard,
  summarizeBoard,
  verifyBoard,
  detectPathCollisions,
  leaseOwnerOverridesFromEscalations,
  normalizeDial,
  parseChangeSpec,
  planWriteLeases,
  recruit,
  runnableUnits,
  workUnitStatuses,
  type BoardAppendResult,
  type BoardDigest,
  type BoardErrorCode,
  type BoardMessage,
  type BoardState,
  type BoardSummary,
  type Change,
  type ChangePlan,
  type ConcurrencyDial,
  type Dependency,
  type DiscoveredWorkUnit,
  type LeaseDecision,
  type PathCollision,
  type RecruitDecision,
  type WorkUnitStatus,
} from "@switchyard-change/change-core";
import { boundedRepoName } from "@switchyard-change/change-core/repo-name";
import type {
  LocalFilesystemWorkspaceProvider,
} from "@switchyard-change/artifact-workspace/local";
import type { ScopedToken, WorkspaceRef } from "@switchyard-change/artifact-workspace";
import type { FetchLike } from "@switchyard-change/local-runner";

/** A recorded cost event, mirroring the Worker's cost bookkeeping. */
export interface CostEvent {
  readonly unitId: string;
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly executor?: string;
  readonly at: string;
}

/** A lease the control surface is holding for a WorkUnit. */
export interface LeaseRecord {
  readonly unitId: string;
  readonly ref: WorkspaceRef;
  readonly token: ScopedToken;
  readonly leasedAt: string;
}

/** One ordered real run step a runner reported for a unit (mirrors the DO). */
export interface ActivityStep {
  readonly phase: string;
  readonly message: string;
  readonly at: string;
}

/** The rich per-unit model detail a runner reported (mirrors the DO). */
export interface UnitDetail {
  readonly promptSummary?: string;
  readonly model?: string;
  readonly editedPaths?: readonly string[];
  readonly diff?: string;
  readonly commitMessage?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly usd?: number;
  readonly at?: string;
}

/** A read-only view of one WorkUnit's live state. */
export interface WorkUnitView {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
  readonly leased: boolean;
  /**
   * The real workspace (Artifact repo) identity backing this unit, present once
   * a lease has provisioned one. Mirrors the Worker's WorkUnitView.workspace so
   * the console projects the offline substrate and the live Worker identically.
   * The plaintext token is never included (only the token id).
   */
  readonly workspace?: WorkspaceIdentity;
  /**
   * The ordered real run steps the agent for this unit emitted (mirrors the DO),
   * so the console's per-node activity log is backed by real steps offline too.
   */
  readonly activity?: readonly ActivityStep[];
  /**
   * The rich per-unit detail (prompt summary, proposed edit/diff, model, tokens
   * and cost) the runner reported (mirrors the DO), so click-detail reads real
   * state offline too.
   */
  readonly detail?: UnitDetail;
}

/** The real backing identity of a WorkUnit's workspace, mirroring the Worker. */
export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId: string;
  readonly leasedAt: string;
}

/**
 * The projection of the recorded plan surfaced on the state view (mirrors the
 * Worker's PlanView): the plan source, the model, the planned unit ids, and the
 * frozen read-only contract paths. The structural twin of the graph model's
 * PlanSnapshot, so it feeds the projection directly.
 */
export interface PlanView {
  readonly source: ChangePlan["source"];
  readonly model: string;
  readonly units: readonly string[];
  readonly contracts: readonly string[];
  /**
   * A readable, secret-free summary of what the planner was asked (the goal plus
   * the structural module map it was handed). Mirrors the Worker's PlanView so
   * the console projects both identically. Optional/empty-safe.
   */
  readonly promptSummary?: string;
  /** The model's optional explanation of why this decomposition, when present. */
  readonly rationale?: string;
}

/** Project a Change's recorded plan onto the serializable PlanView, or undefined. */
function planViewFromChange(change: Change): PlanView | undefined {
  const plan = change.plan;
  if (!plan) {
    return undefined;
  }
  return {
    source: plan.source,
    model: plan.model,
    units: plan.units.map((unit) => unit.id),
    contracts: [...plan.contracts],
    ...(plan.promptSummary !== undefined ? { promptSummary: plan.promptSummary } : {}),
    ...(plan.rationale !== undefined ? { rationale: plan.rationale } : {}),
  };
}

/**
 * The Change-level lifecycle status (mirrors the Worker DO's ChangeStatus):
 * "planning" while a Change exists as a placeholder and the planner is still
 * deciding the work, "running" once the plan is attached (or from the start for
 * a full-spec create), "planning-failed" once a placeholder failed before its
 * plan was attached.
 */
export type ChangeStatus = "planning" | "running" | "planning-failed";

/**
 * The AUTHORITATIVE whole-change integration verdict (mirrors the Worker DO):
 * the final integration gate's outcome on the exact integrated tree. It alone
 * decides the goal node's verified/failed state; null until recorded.
 */
export interface IntegrationRecord {
  readonly verdict: "verified" | "failed";
  readonly integratedUnits: readonly string[];
  readonly excludedUnits: readonly string[];
  /** False when no gate ran: a "verified" verdict checked nothing (mirrors the Worker). */
  readonly gated?: false;
  readonly at: string;
}

/** Why a planning placeholder failed before a plan was attached (mirrors the DO). */
export interface PlanningFailureRecord {
  readonly reason: string;
  readonly at: string;
}

/** The header fields needed to create a "planning" placeholder Change. */
export interface PlanningChangeHeader {
  readonly id: string;
  readonly objective: string;
  readonly baseline: string;
  readonly budgetUsd: number;
  readonly assurance: Change["assurance"];
}

/** The live, serializable projection of a Change's orchestration state. */
export interface ChangeStateView {
  readonly id: string;
  readonly objective: string;
  /**
   * The Change-level lifecycle status (mirrors the Worker DO): "planning" while
   * the Change exists as a placeholder and the planner is still deciding the
   * work, "running" once the plan is attached (or from the start for a full-spec
   * create).
   */
  readonly status: ChangeStatus;
  readonly baseline: string;
  readonly budgetUsd: number;
  readonly assurance: Change["assurance"];
  readonly work: readonly WorkUnitView[];
  readonly edges: readonly Dependency[];
  readonly collisions: readonly PathCollision[];
  readonly completed: readonly string[];
  readonly spentUsd: number;
  readonly costEvents: readonly CostEvent[];
  readonly dial: ConcurrencyDial;
  readonly recruitments: readonly RecruitmentEvent[];
  /**
   * The schema-constrained plan recorded for this Change, when it was decomposed
   * through the inference-backed planner pass (or its heuristic fallback). It
   * rode the Change (change.plan) and backs the graph's `planner` node. Absent on
   * the plain heuristic path (no plan on the Change), where there is no planner
   * node. Mirrors the Worker's ChangeStateView so the console projects both
   * identically.
   */
  readonly plan?: PlanView;
  /** The agent-built tool for this Change, when one was recorded. */
  readonly tool?: ToolRecord;
  /** Real tool-consumption records; each backs one consumed-tool edge. */
  readonly toolConsumptions: readonly ToolConsumption[];
  /** Write-lease coordination on contested paths (owner vs waiters). */
  readonly leaseEdges: readonly LeaseEdge[];
  /** Human escalations recorded for this Change (pending and resolved). */
  readonly escalations: readonly Escalation[];
  /**
   * The WorkUnits an agent ultimately failed on, with the reason. A failed unit
   * is terminal-for-that-unit and does not block the rest of the wave. Mirrors
   * the Worker's ChangeStateView so the console projects both identically.
   */
  readonly failed: readonly FailureRecord[];
  /** The live deployment of the fixed app for this run (mirrors the Worker). */
  readonly deployment?: DeploymentRecord;
  /** Mechanical verify attempts (mirrors the Worker); back the `verify` nodes. */
  readonly verifyAttempts: readonly VerifyAttempt[];
  /** Model-escalation retries (mirrors the Worker); back `retry` nodes/edges. */
  readonly retryAttempts: readonly RetryAttempt[];
  /** Count of retry rounds driven by a LIVE re-plan (refanSource "re-plan"). */
  readonly rePlans: number;
  /**
   * Round-N agent instances (mirrors the Worker); back the graph's round-N
   * `agent` nodes with recorded status/workspace/activity/detail.
   */
  readonly roundAgents: readonly RoundAgentView[];
  /**
   * The Jev typed decisions recorded for this Change (mirrors the Worker); back
   * the graph's `jev` nodes offline exactly like the live Worker. A
   * fix-confidence decision is advisory only and never flips the gate verdict.
   */
  readonly jevDecisions: readonly JevDecisionView[];
  /**
   * A count summary of the Change board (mirrors the Worker). The full log and
   * reduced state are served by GET /changes/:id/board.
   */
  readonly board: BoardSummary;
  /**
   * The authoritative integration verdict (mirrors the Worker), or null until
   * recorded, so the offline graph's goal follows the verdict exactly like the
   * live one rather than the ladder overlay.
   */
  readonly integration: IntegrationRecord | null;
  /** Why the planning placeholder failed (mirrors the Worker), or null. */
  readonly planningFailure: PlanningFailureRecord | null;
}

/** A recorded WorkUnit failure (mirrors the Worker's FailureRecord). */
export interface FailureRecord {
  readonly unitId: string;
  readonly reason: string;
  readonly at: string;
}

/** The agent-built tool recorded on the Change (mirrors the Worker). */
export interface ToolRecord {
  readonly builderUnitId: string;
  readonly capability: string;
  readonly toolPath: string;
  readonly workspace: WorkspaceIdentity;
  readonly label: string;
}

/** A recorded tool-consumption by a downstream unit (mirrors the Worker). */
export interface ToolConsumption {
  readonly capability: string;
  readonly consumerUnitId: string;
  readonly at: string;
}

/** A recorded live deployment of the fixed app (mirrors the Worker). */
export interface DeploymentRecord {
  readonly url: string;
  readonly app: string;
  readonly at: string;
}

/** A write-lease coordination record for a contested path (mirrors the Worker). */
export interface LeaseEdge {
  readonly path: string;
  readonly owner: string;
  readonly waiters: readonly string[];
}

/** The outcome of one mechanical verification attempt (mirrors the Worker). */
export type VerifyOutcome = "pass" | "fail";

/** How the implicated units for a re-fan were chosen (mirrors the Worker). */
export type RefanSource = "parse" | "jev" | "re-plan" | "all";

/** One recorded CHANGE-LEVEL mechanical VERIFY attempt (mirrors the Worker). */
export interface VerifyAttempt {
  readonly round: number;
  readonly outcome: VerifyOutcome;
  readonly model: string;
  readonly gateCommand?: string;
  readonly failingOutput?: string;
  readonly implicatedUnits?: readonly string[];
  readonly refanSource?: RefanSource;
  readonly at: string;
}

/** One recorded CHANGE-LEVEL model-escalation RETRY (mirrors the Worker). */
export interface RetryAttempt {
  readonly round: number;
  readonly fromModel: string;
  readonly toModel: string;
  readonly implicatedUnits: readonly string[];
  readonly refanSource?: RefanSource;
  readonly reason: string;
  /** The revised units (with objectives) a re-plan chose this round (re-plan only). */
  readonly revisedUnits?: readonly { readonly id: string; readonly objective: string }[];
  /** The re-plan rationale, when a re-plan round carried one. */
  readonly rationale?: string;
  readonly at: string;
}

/**
 * A recorded round-N agent instance for a retry round (mirrors the Worker's
 * RoundAgentView): a retry round's re-fanned unit running as a BRAND NEW agent
 * keyed by (unitId, round), with its OWN recorded Artifact repo and a real
 * status lifecycle (running -> integrated | failed). Backs the graph's round-N
 * `agent` nodes offline exactly like the live Worker.
 */
export interface RoundAgentView {
  readonly unitId: string;
  readonly round: number;
  readonly workspace: WorkspaceIdentity;
  readonly status: WorkUnitStatus;
  readonly activity?: readonly ActivityStep[];
  readonly detail?: UnitDetail;
}

/** The decision juncture a Jev typed decision was recorded at (mirrors the DO). */
export type JevJuncture = "plan-review" | "attribution" | "fix-confidence";

/**
 * One recorded Jev typed decision (mirrors the DO's JevDecisionView): the
 * juncture, the question, the typed answer (noul/choice/score), the calibrated
 * confidence, optional probabilities, and whether the engine accepted or
 * escalated. Backs the graph's `jev` nodes offline exactly like the live Worker.
 * A fix-confidence decision is advisory only and never flips the gate verdict.
 */
export interface JevDecisionView {
  readonly juncture: JevJuncture;
  readonly question: string;
  readonly answerType: "noul" | "choice" | "score";
  readonly noul?: "yes" | "no" | "unsure";
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly accepted: boolean;
  /** Set when the decision call failed: a short, credential-free reason. */
  readonly error?: string;
  readonly at: string;
}

/** The kind of a fork that must be escalated to a human (mirrors the Worker). */
export type EscalationKind = "lease-owner" | "verification-ambiguous" | "decision";

/** Whether an escalation is still pending or resolved (mirrors the Worker). */
export type EscalationStatus = "pending" | "resolved";

/** A human escalation record (mirrors the Worker's durable escalation). */
export interface Escalation {
  readonly id: string;
  readonly kind: EscalationKind;
  readonly unitId?: string;
  readonly path?: string;
  /** The board contest this escalation was raised for (mirrors the Worker). */
  readonly boardContest?: string;
  /** The protected board contract this escalation decides (mirrors the Worker). */
  readonly boardContract?: string;
  /** The re-planned board item that failed again (mirrors the Worker). */
  readonly boardItem?: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly status: EscalationStatus;
  readonly decision?: string;
  readonly raisedAt: string;
  readonly resolvedAt?: string;
  /** A protected contract's advisory triage, shown to the human (mirrors the Worker). */
  readonly recommendation?: string;
}

/** The input to raise an escalation offline (mirrors the Worker). */
export interface RaiseEscalationInput {
  readonly kind: EscalationKind;
  readonly unitId?: string;
  readonly path?: string;
  readonly boardContest?: string;
  readonly question: string;
  readonly options?: readonly string[];
}

/** A board rejection with its machine-readable code (mirrors the Worker). */
export interface BoardFailure {
  readonly ok: false;
  readonly code: string;
  readonly error: string;
}

/** The result of appending to the board (mirrors the Worker). */
export type BoardAppendResponse =
  | {
      readonly ok: true;
      readonly appended: readonly BoardMessage[];
      readonly escalations: readonly Escalation[];
      /** The new agent's board token (join only; stored hashed). */
      readonly token?: string;
    }
  | BoardFailure;

/** One page of the board log after a seq, with the reduced state (mirrors the Worker). */
export interface BoardView {
  readonly lastSeq: number;
  readonly messages: readonly BoardMessage[];
  readonly hasMore: boolean;
  readonly state: BoardState;
}

/** The header an agent presents its board token in (mirrors the Worker). */
export const BOARD_TOKEN_HEADER = "x-board-agent-token";
const BOARD_PAGE_DEFAULT = 500;
const BOARD_PAGE_MAX = 1000;

/** A recruitment plan for one wave in the offline substrate (mirrors the DO). */
export interface RecruitmentPlan extends RecruitDecision {
  readonly inFlight: number;
  readonly dial: ConcurrencyDial;
  readonly runnable: readonly string[];
}

/** A recorded recruitment event (mirrors the DO's inspectable log). */
export interface RecruitmentEvent {
  readonly trigger: "kickoff" | "repo-pushed";
  readonly pushedWorkspace?: string;
  readonly completedUnit?: string;
  readonly recruited: readonly string[];
  readonly ceiling: number;
  readonly inFlightAfter: number;
  readonly at: string;
}

/** The outcome of ingesting a repo-pushed event offline (mirrors the DO). */
export interface RepoPushedResult {
  readonly completedUnit: string | null;
  readonly recruited: readonly string[];
  readonly done: boolean;
  readonly event: RecruitmentEvent;
}

/** One Change's in-process bookkeeping. */
class ChangeRecord {
  readonly completed = new Set<string>();
  readonly leases = new Map<string, LeaseRecord>();
  readonly costEvents: CostEvent[] = [];
  /**
   * The Change this record coordinates. Mutable because dynamic branching
   * appends DISCOVERED WorkUnits to the live graph: a completing unit can reveal
   * follow-up work, which is admitted as real backed units via addWorkUnits,
   * replacing this with an augmented Change whose `work` includes them. Every
   * downstream read (runnable/waiting, recruitment, state projection) reads this
   * field, so appended units are picked up with no other change.
   */
  change: Change;
  /** The min/max concurrency dial governing recruitment. */
  dial: ConcurrencyDial = normalizeDial(undefined);
  /** The inspectable recruitment-event log. */
  readonly recruitments: RecruitmentEvent[] = [];
  /** Backend workspace name -> unit id, so a repo-pushed event resolves a unit. */
  readonly workspaceUnits = new Map<string, string>();
  /**
   * Per-unit real workspace (Artifact repo) identity, recorded at lease time and
   * KEPT past completion so a completed node still reveals the real repo it ran
   * in. Mirrors the Worker DO's `workspaces` map; without it a completed unit
   * (whose lease is released on the repo-pushed event) would lose its workspace
   * and project back to a plain work node, diverging from the live Worker.
   */
  readonly workspaceIdentities = new Map<string, WorkspaceIdentity>();
  /** The agent-built tool recorded for this Change, when one was built. */
  tool: ToolRecord | null = null;
  /** Real tool-consumption records (downstream units that ran the tool). */
  readonly toolConsumptions: ToolConsumption[] = [];
  /** Human escalations recorded for this Change (pending and resolved). */
  readonly escalations: Escalation[] = [];
  /** WorkUnits an agent ultimately failed on (mirrors the DO's failed set). */
  readonly failed = new Map<string, FailureRecord>();
  /** Per-unit ordered real run steps (mirrors the DO's activity log). */
  readonly activity = new Map<string, ActivityStep[]>();
  /** Per-unit rich model detail (mirrors the DO's detail). */
  readonly detail = new Map<string, UnitDetail>();
  /** The live deployment of the fixed app recorded for this run (mirrors DO). */
  deployment: DeploymentRecord | null = null;
  /** Mechanical verify attempts recorded for this Change (mirrors the DO). */
  readonly verifyAttempts: VerifyAttempt[] = [];
  /** Model-escalation retries recorded for this Change (mirrors the DO). */
  readonly retryAttempts: RetryAttempt[] = [];
  /**
   * Round-N agent instances keyed by `${unitId}#${round}` (mirrors the DO): a
   * retry round's re-fanned unit tracked as a BRAND NEW agent with its own
   * recorded workspace and a real status lifecycle.
   */
  readonly roundAgents = new Map<string, RoundAgentView>();
  /** Jev typed decisions recorded at the three junctures (mirrors the DO). */
  readonly jevDecisions: JevDecisionView[] = [];
  /**
   * The Change-level lifecycle status (mirrors the DO): "planning" for a
   * placeholder created before the planner ran, "running" once the plan is
   * attached or for a full-spec create. Mutable so attachPlan can flip it.
   */
  status: ChangeStatus = "running";
  /** The authoritative integration verdict, once recorded (mirrors the DO). */
  integration: IntegrationRecord | null = null;
  /** Why the planning placeholder failed, once recorded (mirrors the DO). */
  planningFailure: PlanningFailureRecord | null = null;
  /** The Change board log and its reduced state (mirrors the DO). */
  readonly boardLog: BoardMessage[] = [];
  boardState: BoardState = emptyBoard();
  /** Board token SHA-256 hash -> agent id (the plaintext is never kept). */
  boardTokens = new Map<string, string>();
  constructor(change: Change) {
    this.change = change;
  }
}

/**
 * In-process Change control surface. Create a Change from spec text, then let a
 * runner drive it through the same lease, cost, and complete operations the
 * Worker exposes. The lease records are kept so the caller can read each
 * completed WorkUnit's workspace for verification and integration afterwards.
 */
/** Options for the offline control surface. */
export interface LocalChangeControlOptions {
  /**
   * The clock board messages are stamped with (`at`). Defaults to the wall
   * clock; an offline demo or test passes a deterministic clock so two runs of
   * the same board produce byte-identical logs.
   */
  readonly now?: () => Date;
}

export class LocalChangeControl {
  private readonly records = new Map<string, ChangeRecord>();
  /** Board agents' workspaces by repo name (for the operator's read tokens). */
  private readonly boardWorkspaces = new Map<string, WorkspaceRef>();
  /** Each Change's tools repo (provisioned once, on the first tool build). */
  private readonly toolsWorkspaces = new Map<string, WorkspaceRef>();
  /** Read tokens the operator revoked (observable offline). */
  readonly revokedReadTokens: string[] = [];
  private readonly boardClock: () => Date;

  constructor(
    private readonly workspaces: LocalFilesystemWorkspaceProvider,
    options: LocalChangeControlOptions = {},
  ) {
    this.boardClock = options.now ?? (() => new Date());
  }

  /** The `at` stamp for the next board append. */
  private boardAt(): string {
    return this.boardClock().toISOString();
  }

  /** Create a Change from spec YAML text (as POST /changes does). */
  createChange(specYaml: string): Change {
    const change = parseChangeSpec(specYaml);
    this.records.set(change.id, new ChangeRecord(change));
    return change;
  }

  /**
   * Create a "planning" PLACEHOLDER Change from just its header (mirrors the DO's
   * createPlanning), with an EMPTY work set and status "planning", BEFORE the
   * planner has decided the work. This lets a run create the Change the instant
   * it begins so the console attaches at once; the real work and plan are
   * attached later by attachPlan, which flips the status to "running".
   */
  createPlanning(header: PlanningChangeHeader): Change {
    const change: Change = {
      id: header.id,
      objective: header.objective,
      baseline: header.baseline,
      budgetUsd: header.budgetUsd,
      assurance: header.assurance,
      work: [],
    };
    const record = new ChangeRecord(change);
    record.status = "planning";
    this.records.set(change.id, record);
    return change;
  }

  /**
   * Attach the decomposed plan to a "planning" placeholder Change (mirrors the
   * DO's attachPlan): re-parse the full spec YAML (now carrying the real work and
   * the recorded plan), replace the stored Change with it, and flip the status to
   * "running". The run has not advanced (no leases/completions), so a fresh
   * record is correct, but a planning placeholder must already exist for this id
   * and still be "planning" (mirroring the DO, which refuses to wipe a running
   * or failed Change by attaching to it).
   */
  attachPlan(specYaml: string): Change {
    const change = parseChangeSpec(specYaml);
    const existing = this.records.get(change.id);
    if (!existing) {
      throw new Error(`no such Change: ${change.id}`);
    }
    if (existing.status !== "planning") {
      throw new Error(
        `a plan can only be attached while the Change is planning (it is ${existing.status})`,
      );
    }
    const record = new ChangeRecord(change);
    record.status = "running";
    this.records.set(change.id, record);
    return change;
  }

  /**
   * Record the AUTHORITATIVE integration verdict (as POST /changes/:id/integration
   * does): the final integration gate's outcome. Latest wins.
   */
  recordIntegration(
    changeId: string,
    input: Omit<IntegrationRecord, "at">,
  ): IntegrationRecord {
    const record = this.require(changeId);
    const stored: IntegrationRecord = {
      verdict: input.verdict,
      integratedUnits: [...input.integratedUnits],
      excludedUnits: [...input.excludedUnits],
      ...(input.gated === false ? { gated: false as const } : {}),
      at: new Date().toISOString(),
    };
    record.integration = stored;
    return stored;
  }

  /**
   * Mark a planning placeholder as failed (as POST /changes/:id/planning-failed
   * does). Only a "planning" Change can move to "planning-failed".
   */
  failPlanning(changeId: string, reason: string): PlanningFailureRecord {
    const record = this.require(changeId);
    if (record.status !== "planning") {
      throw new Error(
        `only a planning Change can be marked planning-failed (it is ${record.status})`,
      );
    }
    const text = sanitizeText((reason ?? "").replace(/\s+/g, " ").trim(), 300);
    const stored: PlanningFailureRecord = {
      reason: text === "" ? "planning failed" : text,
      at: new Date().toISOString(),
    };
    record.planningFailure = stored;
    record.status = "planning-failed";
    return stored;
  }

  /** Set the min/max concurrency dial (as POST /changes/:id/dial does). */
  configureDial(changeId: string, dial: Partial<ConcurrencyDial> | undefined): ConcurrencyDial {
    const record = this.require(changeId);
    record.dial = normalizeDial(dial);
    return record.dial;
  }

  /** The dial currently in force for a Change. */
  dial(changeId: string): ConcurrencyDial {
    return this.require(changeId).dial;
  }

  /** The inspectable recruitment-event log for a Change. */
  recruitments(changeId: string): readonly RecruitmentEvent[] {
    return this.require(changeId).recruitments;
  }

  /** All escalations recorded for a Change (pending and resolved). */
  escalations(changeId: string): readonly Escalation[] {
    return this.require(changeId).escalations;
  }

  /**
   * Raise a human escalation for a fork mechanical evidence cannot settle
   * (mirrors the DO). Idempotent for the same pending (kind, unitId, path), so a
   * re-driven engine does not pile up duplicates. The engine then waits on it.
   */
  raiseEscalation(changeId: string, input: RaiseEscalationInput): Escalation {
    const record = this.require(changeId);
    if (input.unitId && !record.change.work.some((u) => u.id === input.unitId)) {
      throw new Error(`unknown WorkUnit for escalation: ${input.unitId}`);
    }
    const existing = record.escalations.find(
      (e) =>
        e.status === "pending" &&
        e.kind === input.kind &&
        e.unitId === input.unitId &&
        e.path === input.path &&
        e.boardContest === input.boardContest,
    );
    if (existing) {
      return existing;
    }
    const escalation: Escalation = {
      id: `esc-${record.escalations.length + 1}-${Date.now().toString(36)}`,
      kind: input.kind,
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.boardContest !== undefined ? { boardContest: input.boardContest } : {}),
      question: input.question,
      options: input.options ?? [],
      status: "pending",
      raisedAt: new Date().toISOString(),
    };
    record.escalations.push(escalation);
    return escalation;
  }

  /**
   * Resolve a pending escalation with the human's decision (mirrors the DO).
   * This is the input that ends the durable wait and lets the graph advance.
   */
  resolveEscalation(changeId: string, id: string, decision: string): Escalation {
    const record = this.require(changeId);
    const index = record.escalations.findIndex((e) => e.id === id);
    if (index === -1) {
      throw new Error(`unknown escalation: ${id}`);
    }
    const current = record.escalations[index] as Escalation;
    if (current.status === "resolved") {
      throw new Error(`escalation already resolved: ${id}`);
    }
    const resolved: Escalation = {
      ...current,
      status: "resolved",
      decision,
      resolvedAt: new Date().toISOString(),
    };
    // A board-contest escalation is answered on the board (mirrors the DO): the
    // board append and the escalation record change together or not at all.
    if (current.boardContest !== undefined || current.boardContract !== undefined) {
      const contest = current.boardContest;
      const contract = current.boardContract;
      try {
        this.appendToBoard(
          record,
          (state) => {
            const draft =
              contest !== undefined ? boardResolutionForDecision(state, contest, decision) : boardContractDecision(state, contract!, decision);
            return draft === undefined
              ? { appended: [], state }
              : appendBoardMessage(state, { kind: "human" }, draft, this.boardAt());
          },
          { escalations: (list) => list.map((e) => (e.id === id ? resolved : e)) },
        );
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      return resolved;
    }
    record.escalations[index] = resolved;
    return resolved;
  }

  /**
   * The one write path for the board (mirrors the DO's transaction): compute
   * the append with the shared pure model, then apply the log, state, tokens,
   * and escalation changes together. A rejection throws before anything
   * changes.
   */
  private appendToBoard(
    record: ChangeRecord,
    make: (state: BoardState, tokens: ReadonlyMap<string, string>) => BoardAppendResult,
    options: {
      readonly tokens?: (tokens: Map<string, string>) => void;
      readonly escalations?: (list: Escalation[]) => Escalation[];
    } = {},
  ): { readonly appended: readonly BoardMessage[]; readonly escalations: readonly Escalation[] } {
    const result = make(record.boardState, record.boardTokens);
    const tokens = new Map(record.boardTokens);
    options.tokens?.(tokens);
    for (const message of result.appended) {
      if (message.type === "agent.left") {
        for (const [hash, agent] of [...tokens]) {
          if (agent === message.from) {
            tokens.delete(hash);
          }
        }
      }
    }
    const base = options.escalations ? options.escalations([...record.escalations]) : record.escalations;
    const applied = applyBoardEscalations(base, result.appended, Date.now());
    record.boardLog.push(...result.appended);
    record.boardState = result.state;
    record.boardTokens = tokens;
    record.escalations.splice(0, record.escalations.length, ...applied.list);
    return { appended: result.appended, escalations: applied.raised };
  }

  private boardOutcome(
    run: () => { readonly appended: readonly BoardMessage[]; readonly escalations: readonly Escalation[] },
    token?: string,
  ): BoardAppendResponse {
    try {
      return { ok: true, ...run(), ...(token !== undefined ? { token } : {}) };
    } catch (error) {
      if (error instanceof BoardError) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
  }

  /** Join the board (as POST /changes/:id/board/join): returns a per-agent token. */
  joinBoard(changeId: string, agent: string, body: { readonly role?: unknown; readonly rationale?: unknown } = {}): BoardAppendResponse {
    const record = this.require(changeId);
    const token = `sbt_${randomBytes(32).toString("hex")}`;
    const hash = hashBoardToken(token);
    return this.boardOutcome(
      () =>
        this.appendToBoard(
          record,
          (state) =>
            appendBoardMessage(
              state,
              { kind: "join", agent },
              {
                type: "agent.joined",
                payload: body.role !== undefined ? { role: body.role } : {},
                ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
              },
              this.boardAt(),
            ),
          { tokens: (tokens) => tokens.set(hash, agent) },
        ),
      token,
    );
  }

  /** Post as the agent the board token identifies (as POST /changes/:id/board). */
  postBoardAsAgent(changeId: string, token: string, raw: unknown): BoardAppendResponse {
    const record = this.require(changeId);
    const hash = hashBoardToken(token);
    return this.boardOutcome(() =>
      this.appendToBoard(record, (state, tokens) => {
        const agent = tokens.get(hash);
        if (agent === undefined) {
          throw new BoardError("AUTH", "unknown or revoked board token");
        }
        return appendBoardMessage(state, { kind: "agent", agent }, raw, this.boardAt());
      }),
    );
  }

  /** Post as the human (as POST /changes/:id/board/human). */
  postBoardAsHuman(changeId: string, raw: unknown): BoardAppendResponse {
    const record = this.require(changeId);
    return this.boardOutcome(() =>
      this.appendToBoard(record, (state) => appendBoardMessage(state, { kind: "human" }, raw, this.boardAt())),
    );
  }

  /** Record an integration result as the board's next integrated.rev (as POST /changes/:id/integration/revision). */
  recordBoardIntegration(changeId: string, input: unknown): BoardAppendResponse {
    const record = this.require(changeId);
    return this.boardOutcome(() =>
      this.appendToBoard(record, (state) => appendIntegratedRev(state, input, this.boardAt())),
    );
  }

  /** One page of messages after `after` and the reduced state (as GET /changes/:id/board). */
  board(changeId: string, after = 0, limit = BOARD_PAGE_DEFAULT): BoardView {
    const record = this.require(changeId);
    const messages = record.boardLog.slice(after, after + limit);
    const last = messages.at(-1)?.seq ?? after;
    return { lastSeq: record.boardState.lastSeq, messages, hasMore: last < record.boardState.lastSeq, state: record.boardState };
  }

  /** One agent's digest; the token must identify that agent (as GET ?for=<agent>). */
  boardDigest(
    changeId: string,
    token: string,
    agent: string,
    after = 0,
    limit = BOARD_PAGE_DEFAULT,
  ): { readonly ok: true; readonly digest: BoardDigest; readonly hasMore: boolean } | BoardFailure {
    const record = this.require(changeId);
    if (record.boardTokens.get(hashBoardToken(token)) !== agent) {
      return { ok: false, code: "AUTH", error: `the board token does not identify ${agent}` };
    }
    const view = this.board(changeId, after, limit);
    return { ok: true, digest: boardDigest(view.state, view.messages, agent, after), hasMore: view.hasMore };
  }

  /** Re-verify the board: its log must reduce to exactly its state. */
  verifyBoard(changeId: string): { readonly ok: true; readonly lastSeq: number } | BoardFailure {
    const record = this.require(changeId);
    try {
      verifyBoard(record.boardLog, record.boardState);
      return { ok: true, lastSeq: record.boardState.lastSeq };
    } catch (error) {
      if (error instanceof BoardError) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
  }

  /** Whether a pending escalation exists (optionally for a specific unit). */
  hasPendingEscalation(changeId: string, unitId?: string): boolean {
    const record = this.require(changeId);
    return record.escalations.some(
      (e) => e.status === "pending" && (unitId === undefined || e.unitId === unitId),
    );
  }

  /** The WorkUnits an agent ultimately failed on for a Change. */
  failures(changeId: string): readonly FailureRecord[] {
    return [...this.require(changeId).failed.values()];
  }

  /**
   * Mark a WorkUnit FAILED (mirrors the DO's failUnit). An agent ultimately
   * could not complete it after the executor's bounded retries, or it timed out.
   * It releases the lease so the dial frees the slot and the wave advances, and
   * records a durable failure so the unit projects status "failed". A failed
   * unit is terminal-for-that-unit and NOT added to completed, so its dependents
   * stay blocked while the rest of the open runnable set advances. Idempotent:
   * failing an already-completed unit is a safe no-op (a late failure signal
   * does not undo a real success).
   */
  failUnit(changeId: string, unitId: string, reason?: string): FailureRecord | null {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    if (record.completed.has(unitId)) {
      return record.failed.get(unitId) ?? null;
    }
    let failure = record.failed.get(unitId);
    if (!failure) {
      failure = {
        unitId,
        reason: ((reason ?? "agent failed").toString().replace(/\s+/g, " ").trim() || "agent failed").slice(0, 300),
        at: new Date().toISOString(),
      };
      record.failed.set(unitId, failure);
    }
    record.leases.delete(unitId);
    return failure;
  }

  /**
   * Record one ordered real run step a runner reported for a WorkUnit (mirrors
   * the DO's recordStep): the real step in the run (leased, cloning, calling the
   * model, applying the edit, committing, pushing, verified, failed). The unit
   * must exist; the message is bounded and secret-stripped before storage, so
   * the offline activity log is backed by real steps just like the live Worker.
   */
  recordStep(changeId: string, unitId: string, phase: string, message: string): ActivityStep {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const step: ActivityStep = {
      phase: boundedPhase(phase),
      message: sanitizeText(message, 300) || "step",
      at: new Date().toISOString(),
    };
    const list = record.activity.get(unitId) ?? [];
    list.push(step);
    record.activity.set(unitId, list.length > 200 ? list.slice(-200) : list);
    return step;
  }

  /**
   * Record (merge) the rich per-unit model detail a runner reported (mirrors the
   * DO's recordDetail): prompt summary, proposed edit/diff, model, commit
   * message, tokens, and cost. Merging lets detail accrue across calls. The unit
   * must exist; the free-text fields are bounded and secret-stripped.
   */
  recordDetail(changeId: string, unitId: string, detail: UnitDetail): UnitDetail {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const merged: UnitDetail = {
      ...(record.detail.get(unitId) ?? {}),
      ...sanitizeDetail(detail),
      at: new Date().toISOString(),
    };
    record.detail.set(unitId, merged);
    return merged;
  }

  /** The ordered real run steps recorded for a WorkUnit (mirrors the DO). */
  activityFor(changeId: string, unitId: string): readonly ActivityStep[] {
    return this.require(changeId).activity.get(unitId) ?? [];
  }

  /**
   * Record the agent-built tool published for this Change (mirrors the DO). The
   * builder unit must exist, so a tool node is backed by a real builder.
   */
  recordTool(changeId: string, tool: ToolRecord): ToolRecord {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === tool.builderUnitId)) {
      throw new Error(`unknown tool builder WorkUnit: ${tool.builderUnitId}`);
    }
    record.tool = tool;
    return tool;
  }

  /**
   * Record that a downstream unit actually ran the tool (mirrors the DO). A tool
   * must be recorded and the consumer must be a WorkUnit, so a consumed-tool
   * edge always maps to a real consumption.
   */
  recordToolConsumption(
    changeId: string,
    consumption: Omit<ToolConsumption, "at">,
  ): ToolConsumption {
    const record = this.require(changeId);
    if (!record.tool) {
      throw new Error("no agent-built tool recorded for this Change");
    }
    if (!record.change.work.some((u) => u.id === consumption.consumerUnitId)) {
      throw new Error(`unknown consumer WorkUnit: ${consumption.consumerUnitId}`);
    }
    const stored: ToolConsumption = { ...consumption, at: new Date().toISOString() };
    record.toolConsumptions.push(stored);
    return stored;
  }

  /**
   * Compute the recruitment plan for the next wave: exactly the DO's policy,
   * sharing the same `recruit` function from change-core. The window over the
   * runnable set is bounded by the dial and by how many agents are in flight.
   */
  planRecruitment(changeId: string): RecruitmentPlan {
    const record = this.require(changeId);
    const runnable = runnableUnits(record.change, record.completed);
    const openRunnable = runnable.filter((id) => !record.leases.has(id) && !record.failed.has(id));
    // In flight = agents still running: leased but not yet completed. Completed
    // leases are retained for later verification, so they must not count toward
    // the concurrency ceiling or recruitment would stall after the first wave.
    const inFlight = [...record.leases.keys()].filter((id) => !record.completed.has(id)).length;
    const decision = recruit({ runnable: openRunnable, inFlight, dial: record.dial });
    return { ...decision, inFlight, dial: record.dial, runnable: openRunnable };
  }

  /** Append a recruitment event to the log (as the Worker does after a wave). */
  recordRecruitment(changeId: string, event: Omit<RecruitmentEvent, "at">): RecruitmentEvent {
    const record = this.require(changeId);
    const stored: RecruitmentEvent = { ...event, at: new Date().toISOString() };
    record.recruitments.push(stored);
    return stored;
  }

  /**
   * Ingest a repo-pushed event: the offline mirror of the DO's recordRepoPushed.
   * It resolves the pushed workspace to its WorkUnit, marks that unit complete
   * (idempotent), and computes the next recruitment plan under the dial. This is
   * the identical event-driven code path the live Worker runs; offline it is
   * driven by a faked event rather than a real queued one.
   */
  recordRepoPushed(changeId: string, workspaceName: string): RepoPushedResult {
    const record = this.require(changeId);
    const unitId = record.workspaceUnits.get(workspaceName);

    let completedUnit: string | null = null;
    if (unitId && record.change.work.some((u) => u.id === unitId)) {
      // The push event names the unit it pertains to. Mark it complete if it is
      // not already (a runner may have reported completion first); either way,
      // this event is what drives recruitment of the next wave, so report the
      // unit the push completed so the log names it.
      record.completed.add(unitId);
      record.leases.delete(unitId);
      completedUnit = unitId;
    }

    const plan = this.planRecruitment(changeId);
    // The wave is done when nothing is left to recruit and every unit has reached
    // a terminal state (completed or failed). A failed unit is terminal, so a run
    // with some failures still finishes rather than waiting forever for a count
    // of completed units it can never reach.
    const terminal = record.completed.size + record.failed.size;
    const done = terminal >= record.change.work.length && plan.recruit.length === 0;
    const event: RecruitmentEvent = {
      trigger: "repo-pushed",
      pushedWorkspace: workspaceName,
      completedUnit: completedUnit ?? undefined,
      recruited: plan.recruit,
      ceiling: plan.ceiling,
      inFlightAfter: plan.inFlight + plan.recruit.length,
      at: new Date().toISOString(),
    };
    return { completedUnit, recruited: plan.recruit, done, event };
  }

  /** The parsed Change held under an id. */
  change(changeId: string): Change {
    return this.require(changeId).change;
  }

  /**
   * Append DISCOVERED follow-up WorkUnits to the live Change (the offline mirror
   * of the DO's addWorkUnits). This is the dynamic-branching mechanism: a
   * completing unit reported that fixing one thing revealed more work, so the
   * engine adds those units to the live WorkGraph and the next wave recruits
   * them. The append is validated by the shared change-core guard (parent must
   * exist, each discovered unit must declare a path, each is rooted under the
   * parent, ids are namespaced and unique). Already-present ids are treated as a
   * no-op (an idempotent re-report), so a re-driven engine does not pile up
   * duplicates. The augmented Change replaces the stored one; everything
   * downstream reads change.work, so the new units are scheduled, recruited, and
   * projected with no other change.
   */
  addWorkUnits(
    changeId: string,
    parentUnitId: string,
    discovered: readonly DiscoveredWorkUnit[],
  ): readonly string[] {
    const record = this.require(changeId);
    // Filter out any discovered unit whose namespaced id already exists, so a
    // repeated report is an idempotent no-op rather than an error.
    const existing = new Set(record.change.work.map((u) => u.id));
    const fresh = discovered.filter(
      (u) =>
        !existing.has(
          `${parentUnitId}+${u.idSuffix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "found"}`,
        ),
    );
    if (fresh.length === 0) {
      return [];
    }
    const { change, added } = appendDiscoveredUnits(record.change, parentUnitId, fresh);
    record.change = change;
    return added.map((u) => u.id);
  }

  /** The lease records held for a Change, keyed by WorkUnit id. */
  leases(changeId: string): ReadonlyMap<string, LeaseRecord> {
    return this.require(changeId).leases;
  }

  /**
   * Record the live deployment of the fixed app (mirrors the DO). Recorded only
   * after verification passed and the deploy succeeded, so the console surfaces
   * a real reachable URL and never one for a broken or undeployed app.
   */
  recordDeployment(changeId: string, deployment: Omit<DeploymentRecord, "at">): DeploymentRecord {
    const record = this.require(changeId);
    const stored: DeploymentRecord = { ...deployment, at: new Date().toISOString() };
    record.deployment = stored;
    return stored;
  }

  /**
   * Record one mechanical CHANGE-LEVEL VERIFY attempt (mirrors the DO). This is
   * the real backing for a `verify` graph node, so a verify node can only exist
   * once this record does. The verifier is mechanical on every round, so this is
   * the ground-truth verdict, never the model grading itself.
   */
  recordVerifyAttempt(changeId: string, input: Omit<VerifyAttempt, "at">): VerifyAttempt {
    const record = this.require(changeId);
    const stored: VerifyAttempt = {
      round: Number.isFinite(input.round) && input.round > 0 ? Math.floor(input.round) : 1,
      outcome: input.outcome === "pass" ? "pass" : "fail",
      model: typeof input.model === "string" ? input.model.slice(0, 120) : "",
      ...(typeof input.gateCommand === "string" && input.gateCommand !== ""
        ? { gateCommand: sanitizeText(input.gateCommand, 500) }
        : {}),
      ...(typeof input.failingOutput === "string" && input.failingOutput !== ""
        ? { failingOutput: sanitizeText(input.failingOutput, 20_000) }
        : {}),
      ...(Array.isArray(input.implicatedUnits) && input.implicatedUnits.length > 0
        ? { implicatedUnits: input.implicatedUnits.map((u) => String(u)) }
        : {}),
      ...(normalizeRefanSource(input.refanSource)
        ? { refanSource: normalizeRefanSource(input.refanSource)! }
        : {}),
      at: new Date().toISOString(),
    };
    record.verifyAttempts.push(stored);
    return stored;
  }

  /**
   * Patch implicated units and the re-fan source onto the LAST verify attempt
   * for a round (mirrors the DO): the failing verify is recorded before
   * attribution is computed, so the ladder patches it once the re-fan is chosen.
   */
  updateVerifyAttempt(
    changeId: string,
    input: { readonly round: number; readonly implicatedUnits?: readonly string[]; readonly refanSource?: RefanSource },
  ): void {
    const record = this.require(changeId);
    const round = Number.isFinite(input.round) && input.round > 0 ? Math.floor(input.round) : 1;
    for (let i = record.verifyAttempts.length - 1; i >= 0; i -= 1) {
      if (record.verifyAttempts[i]!.round === round) {
        record.verifyAttempts[i] = {
          ...record.verifyAttempts[i]!,
          ...(Array.isArray(input.implicatedUnits) && input.implicatedUnits.length > 0
            ? { implicatedUnits: input.implicatedUnits.map((u) => String(u)) }
            : {}),
          ...(normalizeRefanSource(input.refanSource)
            ? { refanSource: normalizeRefanSource(input.refanSource)! }
            : {}),
        };
        return;
      }
    }
  }

  /**
   * Record one CHANGE-LEVEL model-escalation RETRY (mirrors the DO). This is the
   * real backing for a `retry` graph node and the `model-escalation` edge, kept
   * wholly separate from the human-escalation `escalated` flag. It carries the
   * implicated units it re-fanned; each must exist in the Change.
   */
  recordRetryAttempt(changeId: string, input: Omit<RetryAttempt, "at">): RetryAttempt {
    const record = this.require(changeId);
    const implicated = Array.isArray(input.implicatedUnits) ? input.implicatedUnits : [];
    for (const unitId of implicated) {
      if (!record.change.work.some((u) => u.id === unitId)) {
        throw new Error(`unknown implicated WorkUnit: ${unitId}`);
      }
    }
    const stored: RetryAttempt = {
      round: Number.isFinite(input.round) && input.round > 1 ? Math.floor(input.round) : 2,
      fromModel: typeof input.fromModel === "string" ? input.fromModel.slice(0, 120) : "",
      toModel: typeof input.toModel === "string" ? input.toModel.slice(0, 120) : "",
      implicatedUnits: implicated.map((u) => String(u)),
      ...(normalizeRefanSource(input.refanSource)
        ? { refanSource: normalizeRefanSource(input.refanSource)! }
        : {}),
      reason: sanitizeText(input.reason ?? "verify-fail escalation", 300) || "verify-fail escalation",
      ...(Array.isArray(input.revisedUnits) && input.revisedUnits.length > 0
        ? {
            revisedUnits: input.revisedUnits
              .filter((u) => u && typeof u.id === "string")
              .map((u) => ({
                id: String(u.id),
                objective: sanitizeText(typeof u.objective === "string" ? u.objective : "", 500),
              })),
          }
        : {}),
      ...(typeof input.rationale === "string" && input.rationale !== ""
        ? { rationale: sanitizeText(input.rationale, 20_000) }
        : {}),
      at: new Date().toISOString(),
    };
    record.retryAttempts.push(stored);
    return stored;
  }

  /**
   * Record one Jev typed decision at one juncture (mirrors the DO). This is the
   * real backing for a `jev` graph node, so a jev node can only exist once this
   * record does. A fix-confidence decision is advisory ONLY: recording it never
   * touches the completed/failed/integrated sets, so the mechanical gate and
   * gate-equals-deploy remain authoritative and Jev never flips a verdict.
   */
  recordJevDecision(changeId: string, input: Omit<JevDecisionView, "at">): JevDecisionView {
    const record = this.require(changeId);
    const answerType =
      input.answerType === "choice" || input.answerType === "score" ? input.answerType : "noul";
    const stored: JevDecisionView = {
      juncture: normalizeJuncture(input.juncture),
      question: sanitizeText(typeof input.question === "string" ? input.question : "", 500),
      answerType,
      ...(answerType === "noul" &&
      (input.noul === "yes" || input.noul === "no" || input.noul === "unsure")
        ? { noul: input.noul }
        : {}),
      ...(answerType === "choice" && typeof input.choice === "string" && input.choice !== ""
        ? { choice: input.choice.slice(0, 200) }
        : {}),
      ...(answerType === "score" && typeof input.score === "number" && Number.isFinite(input.score)
        ? { score: input.score }
        : {}),
      confidence: clampUnit(input.confidence),
      ...(input.probabilities ? { probabilities: sanitizeProbabilities(input.probabilities) } : {}),
      accepted: input.accepted === true,
      ...(typeof input.error === "string" && input.error !== "" ? { error: sanitizeText(input.error, 300) } : {}),
      at: new Date().toISOString(),
    };
    record.jevDecisions.push(stored);
    return stored;
  }

  /** The Jev typed decisions recorded for a Change (mirrors the DO). */
  jevDecisionsFor(changeId: string): readonly JevDecisionView[] {
    return this.require(changeId).jevDecisions;
  }

  /**
   * Record (or re-lease) a round-N agent instance keyed by (unitId, round),
   * against an already-provisioned round-N workspace (mirrors the DO's
   * recordRoundLease). A retry round's re-fanned unit is a BRAND NEW agent that
   * spawns and tracks state exactly like a kickoff agent, so leasing it records
   * its OWN real Artifact repo and sets status to running (the lifecycle start).
   */
  recordRoundLease(
    changeId: string,
    unitId: string,
    round: number,
    workspace: WorkspaceIdentity,
  ): RoundAgentView {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const key = roundAgentKey(unitId, round);
    const previous = record.roundAgents.get(key);
    const stored: RoundAgentView = {
      unitId,
      round: normalizeRound(round),
      workspace,
      status: "running",
      ...(previous?.activity ? { activity: previous.activity } : {}),
      ...(previous?.detail ? { detail: previous.detail } : {}),
    };
    record.roundAgents.set(key, stored);
    return stored;
  }

  /**
   * Record one ordered real run step for a round-N agent keyed by (unitId,
   * round) (mirrors the DO's recordRoundStep). The round-N agent must have been
   * leased; the message is bounded and secret-stripped.
   */
  recordRoundStep(
    changeId: string,
    unitId: string,
    round: number,
    phase: string,
    message: string,
  ): ActivityStep {
    const record = this.require(changeId);
    const key = roundAgentKey(unitId, round);
    const agent = record.roundAgents.get(key);
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    const step: ActivityStep = {
      phase: boundedPhase(phase),
      message: sanitizeText(message, 300) || "step",
      at: new Date().toISOString(),
    };
    const list = [...(agent.activity ?? []), step];
    record.roundAgents.set(key, {
      ...agent,
      activity: list.length > 200 ? list.slice(-200) : list,
    });
    return step;
  }

  /**
   * Record (merge) the rich per-unit detail for a round-N agent keyed by
   * (unitId, round) (mirrors the DO's recordRoundDetail). The round-N agent must
   * have been leased; the free-text fields are bounded and secret-stripped.
   */
  recordRoundDetail(
    changeId: string,
    unitId: string,
    round: number,
    detail: UnitDetail,
  ): UnitDetail {
    const record = this.require(changeId);
    const key = roundAgentKey(unitId, round);
    const agent = record.roundAgents.get(key);
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    const merged: UnitDetail = {
      ...(agent.detail ?? {}),
      ...sanitizeDetail(detail),
      at: new Date().toISOString(),
    };
    record.roundAgents.set(key, { ...agent, detail: merged });
    return merged;
  }

  /**
   * Mark a round-N agent COMPLETE keyed by (unitId, round) (mirrors the DO's
   * completeRoundAgent): its round pushed an edit, so the round-N instance walks
   * to "integrated". The change-level gate remains the authority on the whole
   * change's pass/fail. Completing an already-terminal one is a safe no-op.
   */
  completeRoundAgent(changeId: string, unitId: string, round: number): RoundAgentView {
    const record = this.require(changeId);
    const key = roundAgentKey(unitId, round);
    const agent = record.roundAgents.get(key);
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    if (agent.status === "integrated" || agent.status === "failed") {
      return agent;
    }
    const stored: RoundAgentView = { ...agent, status: "integrated" };
    record.roundAgents.set(key, stored);
    return stored;
  }

  /**
   * Mark a round-N agent FAILED keyed by (unitId, round) (mirrors the DO's
   * failRoundAgent): its round's executor errored or produced no usable edit, so
   * the round-N instance walks to "failed". Failing an already-terminal one is a
   * safe no-op.
   */
  failRoundAgent(changeId: string, unitId: string, round: number, reason?: string): RoundAgentView {
    const record = this.require(changeId);
    const key = roundAgentKey(unitId, round);
    const agent = record.roundAgents.get(key);
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    if (agent.status === "integrated" || agent.status === "failed") {
      return agent;
    }
    const list = [
      ...(agent.activity ?? []),
      {
        phase: "failed",
        message: sanitizeText(reason ?? "agent failed", 300) || "agent failed",
        at: new Date().toISOString(),
      },
    ];
    const stored: RoundAgentView = {
      ...agent,
      status: "failed",
      activity: list.length > 200 ? list.slice(-200) : list,
    };
    record.roundAgents.set(key, stored);
    return stored;
  }

  /** The round-N agent instances recorded for a Change (mirrors the DO). */
  roundAgents(changeId: string): readonly RoundAgentView[] {
    return [...this.require(changeId).roundAgents.values()];
  }

  /**
   * Mark a WorkUnit FAILED on a verify-fail verdict (mirrors the DO's
   * recordVerifyFailure): its candidate edit did not pass the mechanical per-app
   * gate after the bounded ladder. This is the VERDICT on the pushed edit, so it
   * overrides a prior pushed/completed marker (removes it from completed) and
   * records a durable failure, making the unit a real RED node. Verification is
   * the authority on green vs red, not the mere fact that an agent pushed.
   */
  recordVerifyFailure(changeId: string, unitId: string, reason?: string): FailureRecord {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    record.completed.delete(unitId);
    const existing = record.failed.get(unitId);
    if (existing) {
      return existing;
    }
    const stored: FailureRecord = {
      unitId,
      reason:
        sanitizeText(reason ?? "verify failed after the bounded model-escalation ladder", 300) ||
        "verify failed",
      at: new Date().toISOString(),
    };
    record.failed.set(unitId, stored);
    const lease = record.leases.get(unitId);
    if (lease) {
      void this.workspaces.revokeToken(lease.ref, lease.token.id).catch(() => {});
    }
    return stored;
  }

  /** The completed WorkUnit ids for a Change. */
  completed(changeId: string): readonly string[] {
    return [...this.require(changeId).completed];
  }

  /** The total recorded cost across all cost events for a Change. */
  spentUsd(changeId: string): number {
    const record = this.require(changeId);
    return Number(record.costEvents.reduce((sum, e) => sum + e.usd, 0).toFixed(6));
  }

  /** All recorded cost events for a Change. */
  costEvents(changeId: string): readonly CostEvent[] {
    return this.require(changeId).costEvents;
  }

  /** The live state projection for a Change (as GET /changes/:id does). */
  state(changeId: string): ChangeStateView {
    const record = this.require(changeId);
    const change = record.change;
    const statuses = workUnitStatuses(change, record.completed);
    const collisions = detectPathCollisions(change);
    const graph = buildWorkGraph(change);
    // A resolved human lease-owner decision is authoritative for its path, so the
    // lease edges shown reflect the chosen owner (mirrors the Worker).
    const leasePlan = planWriteLeases(change, collisions, {
      ownerOverrides: leaseOwnerOverridesFromEscalations(record.escalations),
    });
    const leaseEdges: LeaseEdge[] = [];
    for (const decision of leasePlan.decisions as readonly LeaseDecision[]) {
      if (decision.resolution === "serialized" && decision.owner !== undefined) {
        leaseEdges.push({ path: decision.path, owner: decision.owner, waiters: decision.waiters });
      }
    }
    const work: WorkUnitView[] = change.work.map((unit) => {
      const base = statuses.get(unit.id) ?? "waiting";
      const leased = record.leases.has(unit.id);
      const lease = record.leases.get(unit.id);
      // Prefer the retained workspace identity (kept past completion) so a
      // completed node still reveals its real repo, mirroring the Worker DO.
      const retained = record.workspaceIdentities.get(unit.id);
      const workspace: WorkspaceIdentity | undefined = retained
        ? retained
        : lease
        ? {
            workspaceId: lease.ref.id,
            workspaceName: lease.ref.name,
            gitUrl: lease.ref.gitUrl,
            defaultBranch: lease.ref.defaultBranch,
            backend: lease.ref.backend,
            fallback: lease.ref.fallback,
            tokenId: lease.token.id,
            leasedAt: lease.leasedAt,
          }
        : undefined;
      // A failed unit projects "failed" over any derived status, mirroring the
      // Worker: it is terminal-for-that-unit even though it released its lease.
      const status: WorkUnitStatus = record.failed.has(unit.id)
        ? "failed"
        : base === "runnable" && leased
          ? "running"
          : base;
      return {
        id: unit.id,
        objective: unit.objective,
        dependsOn: unit.dependsOn,
        paths: unit.paths,
        status,
        leased,
        ...(workspace ? { workspace } : {}),
        ...(record.activity.get(unit.id) && record.activity.get(unit.id)!.length > 0
          ? { activity: record.activity.get(unit.id) }
          : {}),
        ...(record.detail.get(unit.id) ? { detail: record.detail.get(unit.id) } : {}),
      };
    });
    return {
      id: change.id,
      objective: change.objective,
      status: record.status,
      baseline: change.baseline,
      budgetUsd: change.budgetUsd,
      assurance: change.assurance,
      work,
      edges: graph.edges,
      collisions,
      completed: [...record.completed],
      spentUsd: this.spentUsd(changeId),
      costEvents: record.costEvents,
      dial: record.dial,
      recruitments: record.recruitments,
      ...(planViewFromChange(change) ? { plan: planViewFromChange(change)! } : {}),
      ...(record.tool ? { tool: record.tool } : {}),
      toolConsumptions: record.toolConsumptions,
      leaseEdges,
      escalations: record.escalations,
      failed: [...record.failed.values()].sort((a, b) =>
        a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0,
      ),
      ...(record.deployment ? { deployment: record.deployment } : {}),
      verifyAttempts: record.verifyAttempts,
      retryAttempts: record.retryAttempts,
      rePlans: record.retryAttempts.filter((a) => a.refanSource === "re-plan").length,
      roundAgents: [...record.roundAgents.values()].sort((a, b) =>
        a.round !== b.round ? a.round - b.round : a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0,
      ),
      jevDecisions: record.jevDecisions,
      integration: record.integration,
      planningFailure: record.planningFailure,
      board: summarizeBoard(record.boardState),
    };
  }

  /** A fetch-shaped transport the WorkerClient can be pointed at. */
  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://local-control");
    const method = (init?.method ?? "GET").toUpperCase();

    const boardRoute = url.pathname.match(
      /^\/changes\/([^/]+)\/(board|board\/join|board\/human|board\/verify|board\/decision|board\/seam-stalled|board\/record|integration\/revision|tools\/gate|tools\/used)$/,
    );
    if (boardRoute && (method === "POST" || method === "GET")) {
      const response = await this.handleBoard(dec(boardRoute[1]), boardRoute[2] ?? "", method, url, init);
      if (response) {
        return response;
      }
    }

    const lease = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/lease$/);
    if (method === "POST" && lease) {
      return this.handleLease(dec(lease[1]), dec(lease[2]));
    }
    const cost = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/cost$/);
    if (method === "POST" && cost) {
      return this.handleCost(dec(cost[1]), dec(cost[2]), parseBody(init));
    }
    const complete = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/complete$/);
    if (method === "POST" && complete) {
      return this.handleComplete(dec(complete[1]), dec(complete[2]), parseBody(init));
    }
    const fail = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/fail$/);
    if (method === "POST" && fail) {
      return this.handleFail(dec(fail[1]), dec(fail[2]), parseBody(init));
    }
    // Escalations (mirrors the Worker): list them, and resolve one with a decision.
    const escalationList = url.pathname.match(/^\/changes\/([^/]+)\/escalations$/);
    if (method === "GET" && escalationList) {
      if (!this.records.has(dec(escalationList[1]))) {
        return json({ error: "no such Change" }, 404);
      }
      return json({ escalations: this.escalations(dec(escalationList[1])) }, 200);
    }
    const escalationResolve = url.pathname.match(/^\/changes\/([^/]+)\/escalations\/([^/]+)\/resolve$/);
    if (method === "POST" && escalationResolve) {
      const b = parseBody(init);
      if (typeof b.decision !== "string" || b.decision.trim() === "") {
        return json({ error: "a resolution requires a decision" }, 400);
      }
      try {
        return json({ escalation: this.resolveEscalation(dec(escalationResolve[1]), dec(escalationResolve[2]), b.decision) }, 200);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const toolsRepo = url.pathname.match(/^\/changes\/([^/]+)\/tools\/(workspace|token|token\/revoke)$/);
    if (method === "POST" && toolsRepo) {
      return this.handleToolsRepo(dec(toolsRepo[1]), toolsRepo[2] ?? "", parseBody(init));
    }
    const readToken = url.pathname.match(/^\/changes\/([^/]+)\/board\/(read-token|agent-token)$/);
    if (method === "POST" && readToken) {
      // agent-token: a refreshed WRITE token for the agent's repo (or its granted fork), as the Worker serves it.
      return this.handleBoardReadToken(dec(readToken[1]), parseBody(init), readToken[2] === "agent-token" ? "write" : "read");
    }
    const helpFork = url.pathname.match(/^\/changes\/([^/]+)\/board\/help-fork$/);
    if (method === "POST" && helpFork) {
      return this.handleHelpFork(dec(helpFork[1]), parseBody(init));
    }
    // Mirrors the Worker's archive route for the repos this stand-in provisioned
    // (board agents' repos, help forks, the tools repo).
    const archive = url.pathname.match(/^\/workspaces\/([^/]+)$/);
    if (method === "DELETE" && archive) {
      const name = dec(archive[1]);
      const ref = this.boardWorkspaces.get(name) ?? [...this.toolsWorkspaces.values()].find((r) => r.name === name);
      if (!ref) {
        return json({ error: `no such workspace: ${name}` }, 404);
      }
      await this.workspaces.archive(ref);
      this.boardWorkspaces.delete(name);
      for (const [change, tools] of this.toolsWorkspaces) {
        if (tools.name === name) {
          this.toolsWorkspaces.delete(change);
        }
      }
      return json({ archived: name }, 200);
    }
    const revokeRead = url.pathname.match(/^\/changes\/([^/]+)\/board\/read-token\/revoke$/);
    if (method === "POST" && revokeRead) {
      const b = parseBody(init);
      const repoName =
        typeof b.help === "string"
          ? boardHelpForkWorkspaceName(dec(revokeRead[1]), b.help)
          : typeof b.agent === "string"
            ? boardAgentWorkspaceName(dec(revokeRead[1]), b.agent)
            : undefined;
      const ref = repoName !== undefined ? this.boardWorkspaces.get(repoName) : undefined;
      if (!ref || typeof b.tokenId !== "string") {
        return json({ code: "BAD_PAYLOAD", error: "a revoke names a board agent with a repo and a tokenId" }, 400);
      }
      await this.workspaces.revokeToken(ref, b.tokenId).catch(() => false);
      this.revokedReadTokens.push(b.tokenId);
      return json({ revoked: b.tokenId }, 200);
    }
    const discovered = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/discovered$/);
    if (method === "POST" && discovered) {
      const b = parseBody(init);
      const units = Array.isArray(b.units) ? (b.units as DiscoveredWorkUnit[]) : [];
      try {
        const added = this.addWorkUnits(dec(discovered[1]), dec(discovered[2]), units);
        return json({ added }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const step = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/step$/);
    if (method === "POST" && step) {
      const b = parseBody(init);
      const recorded = this.recordStep(
        dec(step[1]),
        dec(step[2]),
        String(b.phase ?? "step"),
        String(b.message ?? ""),
      );
      return json({ step: recorded }, 201);
    }
    const detail = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/detail$/);
    if (method === "POST" && detail) {
      const recorded = this.recordDetail(dec(detail[1]), dec(detail[2]), parseBody(init) as UnitDetail);
      return json({ detail: recorded }, 201);
    }
    const deploymentRoute = url.pathname.match(/^\/changes\/([^/]+)\/deployment$/);
    if (method === "POST" && deploymentRoute) {
      const b = parseBody(init);
      const recorded = this.recordDeployment(dec(deploymentRoute[1]), {
        url: String(b.url ?? ""),
        app: String(b.app ?? ""),
      });
      return json({ deployment: recorded }, 201);
    }
    const integrationRoute = url.pathname.match(/^\/changes\/([^/]+)\/integration$/);
    if (method === "POST" && integrationRoute) {
      const b = parseBody(init);
      const isStrings = (v: unknown): v is string[] =>
        Array.isArray(v) && v.every((x) => typeof x === "string");
      if (b.verdict !== "verified" && b.verdict !== "failed") {
        return json({ error: 'integration verdict must be "verified" or "failed"' }, 400);
      }
      if (!isStrings(b.integratedUnits) || !isStrings(b.excludedUnits)) {
        return json({ error: "integratedUnits and excludedUnits must be string arrays" }, 400);
      }
      if (b.gated !== undefined && (b.gated !== false || b.verdict !== "verified")) {
        return json({ error: "gated, when present, must be false (no gate ran) on a verified verdict" }, 400);
      }
      try {
        const recorded = this.recordIntegration(dec(integrationRoute[1]), {
          verdict: b.verdict,
          integratedUnits: b.integratedUnits,
          excludedUnits: b.excludedUnits,
          ...(b.gated === false ? { gated: false as const } : {}),
        });
        return json({ integration: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 404);
      }
    }
    if (method === "POST" && url.pathname === "/changes/planning") {
      // Mirrors the Worker's planning-first create: a placeholder Change with
      // no work, status "planning", created before any planner runs.
      const b = parseBody(init);
      if (typeof b.id !== "string" || b.id.trim() === "" || typeof b.objective !== "string") {
        return json({ error: "a planning Change needs an id and an objective" }, 400);
      }
      const assurance = b.assurance === "none" || b.assurance === "strict" ? b.assurance : "standard";
      const change = this.createPlanning({
        id: b.id,
        objective: b.objective,
        baseline: typeof b.baseline === "string" && b.baseline !== "" ? b.baseline : "HEAD",
        budgetUsd: typeof b.budgetUsd === "number" && Number.isFinite(b.budgetUsd) ? b.budgetUsd : 0,
        assurance,
      });
      return json({ id: change.id, status: "planning" }, 201);
    }
    const planningFailedRoute = url.pathname.match(/^\/changes\/([^/]+)\/planning-failed$/);
    if (method === "POST" && planningFailedRoute) {
      const b = parseBody(init);
      const changeId = dec(planningFailedRoute[1]);
      if (!this.records.has(changeId)) {
        return json({ error: `no such Change: ${changeId}` }, 404);
      }
      try {
        const recorded = this.failPlanning(changeId, typeof b.reason === "string" ? b.reason : "");
        return json({ planningFailure: recorded, status: "planning-failed" }, 200);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
    const verifyAttemptRoute = url.pathname.match(/^\/changes\/([^/]+)\/verify-attempt$/);
    if (method === "POST" && verifyAttemptRoute) {
      const b = parseBody(init);
      try {
        const recorded = this.recordVerifyAttempt(dec(verifyAttemptRoute[1]), {
          round: numberOr(b.round, 1),
          outcome: b.outcome === "pass" ? "pass" : "fail",
          model: String(b.model ?? ""),
          ...(typeof b.gateCommand === "string" && b.gateCommand !== ""
            ? { gateCommand: String(b.gateCommand) }
            : {}),
          ...(typeof b.failingOutput === "string" && b.failingOutput !== ""
            ? { failingOutput: String(b.failingOutput) }
            : {}),
          ...(Array.isArray(b.implicatedUnits)
            ? { implicatedUnits: (b.implicatedUnits as unknown[]).map((u) => String(u)) }
            : {}),
          ...(normalizeRefanSource(b.refanSource)
            ? { refanSource: normalizeRefanSource(b.refanSource)! }
            : {}),
        });
        return json({ verifyAttempt: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const verifyRefanRoute = url.pathname.match(/^\/changes\/([^/]+)\/verify-attempt\/refan$/);
    if (method === "POST" && verifyRefanRoute) {
      const b = parseBody(init);
      try {
        this.updateVerifyAttempt(dec(verifyRefanRoute[1]), {
          round: numberOr(b.round, 1),
          ...(Array.isArray(b.implicatedUnits)
            ? { implicatedUnits: (b.implicatedUnits as unknown[]).map((u) => String(u)) }
            : {}),
          ...(normalizeRefanSource(b.refanSource)
            ? { refanSource: normalizeRefanSource(b.refanSource)! }
            : {}),
        });
        return json({ ok: true }, 200);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const retryAttemptRoute = url.pathname.match(/^\/changes\/([^/]+)\/retry-attempt$/);
    if (method === "POST" && retryAttemptRoute) {
      const b = parseBody(init);
      try {
        const recorded = this.recordRetryAttempt(dec(retryAttemptRoute[1]), {
          round: numberOr(b.round, 2),
          fromModel: String(b.fromModel ?? ""),
          toModel: String(b.toModel ?? ""),
          implicatedUnits: Array.isArray(b.implicatedUnits)
            ? (b.implicatedUnits as unknown[]).map((u) => String(u))
            : [],
          ...(normalizeRefanSource(b.refanSource)
            ? { refanSource: normalizeRefanSource(b.refanSource)! }
            : {}),
          reason: String(b.reason ?? "verify-fail escalation"),
          ...(Array.isArray(b.revisedUnits) && (b.revisedUnits as unknown[]).length > 0
            ? {
                revisedUnits: (b.revisedUnits as { id?: unknown; objective?: unknown }[])
                  .filter((u) => u && typeof u.id === "string")
                  .map((u) => ({ id: String(u.id), objective: String(u.objective ?? "") })),
              }
            : {}),
          ...(typeof b.rationale === "string" && b.rationale !== ""
            ? { rationale: b.rationale }
            : {}),
        });
        return json({ retryAttempt: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const jevDecisionRoute = url.pathname.match(/^\/changes\/([^/]+)\/jev-decision$/);
    if (method === "POST" && jevDecisionRoute) {
      const b = parseBody(init);
      try {
        const recorded = this.recordJevDecision(dec(jevDecisionRoute[1]), {
          juncture: (b.juncture as JevJuncture) ?? "plan-review",
          question: String(b.question ?? ""),
          answerType:
            b.answerType === "choice" || b.answerType === "score"
              ? (b.answerType as "choice" | "score")
              : "noul",
          ...(b.noul ? { noul: b.noul as "yes" | "no" | "unsure" } : {}),
          ...(typeof b.choice === "string" && b.choice !== "" ? { choice: b.choice } : {}),
          ...(typeof b.score === "number" ? { score: b.score } : {}),
          confidence: numberOr(b.confidence, 0),
          ...(b.probabilities ? { probabilities: b.probabilities as Record<string, number> } : {}),
          accepted: b.accepted === true,
          ...(typeof b.error === "string" && b.error !== "" ? { error: b.error.slice(0, 300) } : {}),
        });
        return json({ jevDecision: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const verifyFailRoute = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/verify-fail$/,
    );
    if (method === "POST" && verifyFailRoute) {
      const b = parseBody(init);
      try {
        this.recordVerifyFailure(dec(verifyFailRoute[1]), dec(verifyFailRoute[2]), String(b.reason ?? ""));
        return json(this.state(dec(verifyFailRoute[1])), 200);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    // The round-N agent lifecycle routes (lease/step/detail/complete/fail),
    // keyed by (unit, round). These are the offline mirror of the Worker's
    // round-scoped routes: a retry round's re-fanned unit spawns and tracks
    // state through the SAME lease/record/complete-or-fail path as a kickoff
    // agent, scoped to (unit, round).
    const roundLease = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/lease$/,
    );
    if (method === "POST" && roundLease) {
      return this.handleRoundLease(dec(roundLease[1]), dec(roundLease[2]), Number(dec(roundLease[3])));
    }
    const roundStep = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/step$/,
    );
    if (method === "POST" && roundStep) {
      const b = parseBody(init);
      try {
        const recorded = this.recordRoundStep(
          dec(roundStep[1]),
          dec(roundStep[2]),
          Number(dec(roundStep[3])),
          String(b.phase ?? "step"),
          String(b.message ?? ""),
        );
        return json({ step: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const roundDetail = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/detail$/,
    );
    if (method === "POST" && roundDetail) {
      try {
        const recorded = this.recordRoundDetail(
          dec(roundDetail[1]),
          dec(roundDetail[2]),
          Number(dec(roundDetail[3])),
          parseBody(init) as UnitDetail,
        );
        return json({ detail: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const roundComplete = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/complete$/,
    );
    if (method === "POST" && roundComplete) {
      try {
        const agent = this.completeRoundAgent(
          dec(roundComplete[1]),
          dec(roundComplete[2]),
          Number(dec(roundComplete[3])),
        );
        return json({ roundAgent: agent }, 200);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const roundFail = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/fail$/,
    );
    if (method === "POST" && roundFail) {
      const b = parseBody(init);
      try {
        const agent = this.failRoundAgent(
          dec(roundFail[1]),
          dec(roundFail[2]),
          Number(dec(roundFail[3])),
          String(b.reason ?? ""),
        );
        return json({ roundAgent: agent }, 200);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    return json({ error: "not found" }, 404);
  };

  /** The board routes, mirroring the Worker's (identity from the route, never the body). */
  private async handleBoard(
    changeId: string,
    kind: string,
    method: string,
    url: URL,
    init?: RequestInit,
  ): Promise<Response | undefined> {
    if (!this.records.has(changeId)) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    const headers = new Headers(init?.headers);
    if (method === "GET") {
      if (kind === "board/verify") {
        const verified = this.verifyBoard(changeId);
        return json(verified, verified.ok ? 200 : 409);
      }
      if (kind !== "board") {
        return undefined;
      }
      const afterRaw = url.searchParams.get("after");
      const limitRaw = url.searchParams.get("limit");
      const after = afterRaw === null || afterRaw === "" ? 0 : /^\d{1,9}$/.test(afterRaw) ? Number(afterRaw) : undefined;
      const limit =
        limitRaw === null || limitRaw === ""
          ? BOARD_PAGE_DEFAULT
          : /^\d{1,4}$/.test(limitRaw) && Number(limitRaw) >= 1 && Number(limitRaw) <= BOARD_PAGE_MAX
            ? Number(limitRaw)
            : undefined;
      if (after === undefined || limit === undefined) {
        return json({ code: "BAD_PAYLOAD", error: `after must be a non-negative seq and limit 1..${BOARD_PAGE_MAX}` }, 400);
      }
      const forAgent = url.searchParams.get("for");
      if (forAgent !== null) {
        const token = headers.get(BOARD_TOKEN_HEADER);
        if (!token) {
          return json({ code: "AUTH", error: `a digest requires the ${BOARD_TOKEN_HEADER} header` }, 401);
        }
        const digest = this.boardDigest(changeId, token, forAgent, after, limit);
        return digest.ok ? json(digest, 200) : json({ code: digest.code, error: digest.error }, 401);
      }
      return json(this.board(changeId, after, limit), 200);
    }
    if (kind === "board/verify") {
      return undefined;
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    if (Buffer.byteLength(raw, "utf8") > BOARD_LIMITS.maxBodyBytes) {
      return json({ code: "LIMIT", error: `a board request body is at most ${BOARD_LIMITS.maxBodyBytes} bytes` }, 413);
    }
    let body: unknown;
    try {
      body = raw.trim() === "" ? {} : (JSON.parse(raw) as unknown);
    } catch {
      return json({ code: "BAD_PAYLOAD", error: "the board request body is not valid JSON" }, 400);
    }
    let outcome: BoardAppendResponse;
    if (kind === "board/join") {
      const join = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (typeof join.agent !== "string") {
        return json({ code: "BAD_PAYLOAD", error: "a join requires an agent id" }, 400);
      }
      // Mirrors the Worker: a join may provision the agent's own workspace (a
      // local bare repo here) with a write token of the explicit short TTL the
      // caller asked for. A refused join revokes the just-issued token.
      const wanted = parseBoardJoinWorkspace(join.workspace);
      if (!wanted.ok) {
        return json({ code: "BAD_PAYLOAD", error: wanted.error }, 400);
      }
      if (wanted.request) {
        if (!BOARD_AGENT_ID_PATTERN.test(join.agent)) {
          return json({ code: "BAD_PAYLOAD", error: "agent must be an id (letters, digits, . _ : -)" }, 400);
        }
        // Validate the join FIRST, so a refused join never provisions anything.
        try {
          checkBoardJoin(this.require(changeId).boardState, join.agent, { role: join.role, rationale: join.rationale });
        } catch (error) {
          if (error instanceof BoardError) {
            return json({ code: error.code, error: error.message }, boardErrorStatus(error.code));
          }
          throw error;
        }
        let ref: WorkspaceRef;
        let token: ScopedToken;
        try {
          ref = await this.workspaces.create(boardAgentWorkspaceName(changeId, join.agent), { defaultBranch: "main" });
          token = await this.workspaces.issueWriteToken(ref, wanted.request.ttlSeconds);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return json({ code: "INVALID_STATE", error: `could not provision the agent workspace: ${reason}` }, 502);
        }
        // A join refused (or failing) after provisioning leaves nothing behind:
        // the token is revoked AND the repo is archived.
        const undo = async () => {
          await this.workspaces.revokeToken(ref, token.id).catch(() => false);
          await this.workspaces.archive(ref).catch(() => undefined);
        };
        let joined: BoardAppendResponse;
        try {
          joined = this.joinBoard(changeId, join.agent, { role: join.role, rationale: join.rationale });
        } catch (error) {
          await undo();
          return json({ code: "INVALID_STATE", error: `the join failed: ${error instanceof Error ? error.message : String(error)}` }, 500);
        }
        if (!joined.ok) {
          await undo();
          return json({ code: joined.code, error: joined.error }, boardErrorStatus(joined.code as BoardErrorCode));
        }
        this.boardWorkspaces.set(ref.name, ref);
        return json(
          {
            ...joined,
            workspace: {
              workspaceId: ref.id,
              workspaceName: ref.name,
              gitUrl: ref.gitUrl,
              defaultBranch: ref.defaultBranch,
              backend: ref.backend,
              fallback: ref.fallback,
              tokenId: token.id,
              token: token.token,
              tokenExpiresAt: token.expiresAt,
            },
          },
          201,
        );
      }
      outcome = this.joinBoard(changeId, join.agent, { role: join.role, rationale: join.rationale });
    } else if (kind === "board/human") {
      outcome = this.postBoardAsHuman(changeId, body);
    } else if (kind === "integration/revision") {
      outcome = this.recordBoardIntegration(changeId, body);
    } else if (kind === "board/decision") {
      const record = this.require(changeId);
      outcome = this.boardOutcome(() => this.appendToBoard(record, (state) => appendDecisionRecorded(state, body, this.boardAt())));
    } else if (kind === "board/seam-stalled") {
      // The board went quiet while a seam item held dependents: the engine records it stalled.
      const record = this.require(changeId);
      outcome = this.boardOutcome(() => this.appendToBoard(record, (state) => appendSeamStalled(state, body, this.boardAt())));
    } else if (kind === "board/record") {
      // A fact only the operator side observes (a stalled claim, ...): validated, then appended.
      const record = this.require(changeId);
      outcome = this.boardOutcome(() => this.appendToBoard(record, (state) => appendEngineRecord(state, body, this.boardAt())));
    } else if (kind === "tools/gate") {
      // The operator ran a tool's own gate: the engine records it (and publishes a pass).
      const record = this.require(changeId);
      outcome = this.boardOutcome(() => this.appendToBoard(record, (state) => appendToolGated(state, body, this.boardAt())));
    } else if (kind === "tools/used") {
      // The operator's runtime ran a pinned tool version in a consumer's repo: the engine records the use.
      const record = this.require(changeId);
      outcome = this.boardOutcome(() => this.appendToBoard(record, (state) => appendToolUsed(state, body, this.boardAt())));
    } else {
      const token = headers.get(BOARD_TOKEN_HEADER);
      if (!token) {
        return json({ code: "AUTH", error: `an agent board post requires the ${BOARD_TOKEN_HEADER} header` }, 401);
      }
      outcome = this.postBoardAsAgent(changeId, token, body);
    }
    return outcome.ok
      ? json(outcome, 201)
      : json({ code: outcome.code, error: outcome.error }, boardErrorStatus(outcome.code as BoardErrorCode));
  }

  /**
   * Mirrors the Worker's tools-repo routes: provision the Change's tools repo
   * once (a repeat returns the same repo with a fresh write token), issue a
   * short-lived read or write token for it, or revoke one.
   */
  private async handleToolsRepo(changeId: string, action: string, body: Record<string, unknown>): Promise<Response> {
    if (!this.records.has(changeId)) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    const ref = this.toolsWorkspaces.get(changeId);
    if (action === "token/revoke") {
      if (!ref || typeof body.tokenId !== "string" || body.tokenId === "") {
        return json({ code: "BAD_PAYLOAD", error: "a revoke names a tokenId of a provisioned tools repo" }, 400);
      }
      await this.workspaces.revokeToken(ref, body.tokenId).catch(() => false);
      return json({ revoked: body.tokenId }, 200);
    }
    const ttl = body.ttlSeconds === undefined ? 900 : body.ttlSeconds;
    const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max) {
      return json({ code: "BAD_PAYLOAD", error: `ttlSeconds must be an integer from ${min} to ${max}` }, 400);
    }
    if (action === "token") {
      if (!ref) {
        return json({ code: "INVALID_STATE", error: "the tools repo is not provisioned yet" }, 400);
      }
      const scope = body.scope ?? "read";
      if (scope !== "read" && scope !== "write") {
        return json({ code: "BAD_PAYLOAD", error: 'scope must be "read" or "write"' }, 400);
      }
      const token = scope === "write" ? await this.workspaces.issueWriteToken(ref, ttl) : await this.workspaces.issueReadToken(ref, ttl);
      return json({ workspaceName: ref.name, tokenId: token.id, token: token.token, tokenExpiresAt: token.expiresAt }, 201);
    }
    const repo = ref ?? (await this.workspaces.create(toolsWorkspaceName(changeId), { defaultBranch: "main" }));
    this.toolsWorkspaces.set(changeId, repo);
    const token = await this.workspaces.issueWriteToken(repo, ttl);
    return json(
      {
        workspaceName: repo.name,
        gitUrl: repo.gitUrl,
        defaultBranch: repo.defaultBranch,
        backend: repo.backend,
        fallback: repo.fallback,
        tokenId: token.id,
        token: token.token,
        tokenExpiresAt: token.expiresAt,
      },
      201,
    );
  }

  /**
   * Mirrors the Worker's read-token route (a short-lived read token for a
   * joined agent's repo) and its agent-token route (a refreshed write token).
   */
  private async handleBoardReadToken(changeId: string, body: Record<string, unknown>, scope: "read" | "write" = "read"): Promise<Response> {
    const issue = (ref: WorkspaceRef, ttl: number) => (scope === "write" ? this.workspaces.issueWriteToken(ref, ttl) : this.workspaces.issueReadToken(ref, ttl));
    const record = this.records.get(changeId);
    if (!record) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    const agent = body.agent;
    if (typeof agent !== "string" || !BOARD_AGENT_ID_PATTERN.test(agent)) {
      return json({ code: "BAD_PAYLOAD", error: "a read token names a board agent id" }, 400);
    }
    const ttl = body.ttlSeconds === undefined ? 600 : body.ttlSeconds;
    const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max) {
      return json({ code: "BAD_PAYLOAD", error: `ttlSeconds must be an integer from ${min} to ${max}` }, 400);
    }
    // A help fork (`help`): the operator reads the granted helper's fork to
    // pull its delivered commit into the requester's repo (the grant decides,
    // even after the helper left).
    if (body.help !== undefined) {
      const request = typeof body.help === "string" ? record.boardState.help[body.help] : undefined;
      if (!request || request.grant === undefined || request.grant.agent !== agent) {
        return json({ code: "NOT_ALLOWED", error: `${agent} holds no granted help fork for ${String(body.help)}` }, 400);
      }
      const forkName = boardHelpForkWorkspaceName(changeId, request.request);
      const fork = this.boardWorkspaces.get(forkName);
      if (!fork) {
        return json({ code: "NOT_ALLOWED", error: `no fork was made for help request ${request.request}` }, 400);
      }
      const token = await issue(fork, ttl);
      return json({ workspaceName: forkName, tokenId: token.id, token: token.token, tokenExpiresAt: token.expiresAt }, 201);
    }
    const joined = record.boardState.agents[agent];
    if (joined === undefined || joined.leftSeq !== undefined) {
      return json({ code: "UNKNOWN_AGENT", error: `${agent} is not a joined agent of this board` }, 400);
    }
    if (joined.role === "lead") {
      return json({ code: "NOT_ALLOWED", error: `${agent} is the lead and has no repo` }, 400);
    }
    const workspaceName = boardAgentWorkspaceName(changeId, agent);
    const ref = this.boardWorkspaces.get(workspaceName);
    if (!ref) {
      return json({ code: "NOT_ALLOWED", error: `${agent} joined without a workspace and has no repo` }, 400);
    }
    const token = await issue(ref, ttl);
    return json({ workspaceName, tokenId: token.id, token: token.token, tokenExpiresAt: token.expiresAt }, 201);
  }

  /**
   * Mirrors the Worker's help-fork route: fork the REQUESTER's repo for the
   * helper of a help request that grants a sub-scope (checked on the board
   * first, so a fork the board would refuse is never made), with a short-lived
   * write token for the fork. The helper then posts help.offered {forkOf,
   * forkCommit, fork} itself; the fork is archived at cleanup like any repo.
   */
  private async handleHelpFork(changeId: string, body: Record<string, unknown>): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    if (typeof body.request !== "string" || typeof body.agent !== "string" || !BOARD_AGENT_ID_PATTERN.test(body.agent)) {
      return json({ code: "BAD_PAYLOAD", error: "a help fork names a help request and a board agent id" }, 400);
    }
    const ttl = body.ttlSeconds === undefined ? 900 : body.ttlSeconds;
    const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max) {
      return json({ code: "BAD_PAYLOAD", error: `ttlSeconds must be an integer from ${min} to ${max}` }, 400);
    }
    let requester: string;
    try {
      requester = checkHelpFork(record.boardState, body.request, body.agent).requester;
    } catch (error) {
      if (error instanceof BoardError) {
        return json({ code: error.code, error: error.message }, boardErrorStatus(error.code));
      }
      throw error;
    }
    const source = this.boardWorkspaces.get(boardAgentWorkspaceName(changeId, requester));
    if (!source) {
      return json({ code: "NOT_ALLOWED", error: `${requester} joined without a workspace: there is no repo to fork` }, 400);
    }
    const forkName = boardHelpForkWorkspaceName(changeId, body.request);
    if (this.boardWorkspaces.has(forkName)) {
      return json({ code: "DUPLICATE", error: `help request ${body.request} already has a fork` }, 400);
    }
    const { ref, token } = await this.workspaces.fork(source, forkName, ttl);
    this.boardWorkspaces.set(ref.name, ref);
    return json(
      {
        workspaceId: ref.id,
        workspaceName: ref.name,
        gitUrl: ref.gitUrl,
        defaultBranch: ref.defaultBranch,
        backend: ref.backend,
        fallback: ref.fallback,
        tokenId: token.id,
        token: token.token,
        tokenExpiresAt: token.expiresAt,
        forkOf: requester,
      },
      201,
    );
  }

  private async handleLease(changeId: string, unitId: string): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const unit = record.change.work.find((u) => u.id === unitId);
    if (!unit) {
      return json({ error: `unknown WorkUnit: ${unitId}` }, 404);
    }
    if (!runnableUnits(record.change, record.completed).includes(unitId)) {
      return json({ error: `WorkUnit is not runnable: ${unitId}` }, 409);
    }
    if (record.leases.has(unitId)) {
      return json({ error: `WorkUnit already leased: ${unitId}` }, 409);
    }
    const workspaceName = workspaceNameFor(changeId, unitId);
    const ref = await this.workspaces.create(workspaceName, { defaultBranch: "main" });
    const token = await this.workspaces.issueWriteToken(ref);
    record.leases.set(unitId, { unitId, ref, token, leasedAt: new Date().toISOString() });
    record.workspaceUnits.set(ref.name, unitId);
    // Keep the workspace identity past completion (mirrors the Worker DO) so a
    // completed node still reveals the real repo it ran in.
    record.workspaceIdentities.set(unitId, {
      workspaceId: ref.id,
      workspaceName: ref.name,
      gitUrl: ref.gitUrl,
      defaultBranch: ref.defaultBranch,
      backend: ref.backend,
      fallback: ref.fallback,
      tokenId: token.id,
      leasedAt: new Date().toISOString(),
    });
    return json(
      {
        unitId,
        objective: unit.objective,
        paths: unit.paths,
        baselineRef: record.change.baseline,
        workspaceId: ref.id,
        workspaceName: ref.name,
        gitUrl: ref.gitUrl,
        defaultBranch: ref.defaultBranch,
        backend: ref.backend,
        fallback: ref.fallback,
        tokenId: token.id,
        tokenExpiresAt: token.expiresAt,
        token: token.token,
      },
      201,
    );
  }

  /**
   * Lease a round-N agent instance keyed by (unitId, round): provision its OWN
   * Artifact repo (keyed with an `r<round>` suffix so it is distinct from the
   * kickoff repo and every other round) through the honest local fallback
   * provider, then record it like a kickoff lease and set its status to running.
   * The offline mirror of the Worker's round lease route; the plaintext token is
   * returned once so the runner can clone and push the round-N repo.
   */
  private async handleRoundLease(changeId: string, unitId: string, round: number): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const unit = record.change.work.find((u) => u.id === unitId);
    if (!unit) {
      return json({ error: `unknown WorkUnit: ${unitId}` }, 404);
    }
    const workspaceName = workspaceNameFor(changeId, unitId, round);
    const ref = await this.workspaces.create(workspaceName, { defaultBranch: "main" });
    const token = await this.workspaces.issueWriteToken(ref);
    const identity: WorkspaceIdentity = {
      workspaceId: ref.id,
      workspaceName: ref.name,
      gitUrl: ref.gitUrl,
      defaultBranch: ref.defaultBranch,
      backend: ref.backend,
      fallback: ref.fallback,
      tokenId: token.id,
      leasedAt: new Date().toISOString(),
    };
    const agent = this.recordRoundLease(changeId, unitId, round, identity);
    return json(
      {
        unitId: agent.unitId,
        round: agent.round,
        objective: unit.objective,
        paths: unit.paths,
        baselineRef: record.change.baseline,
        workspaceId: ref.id,
        workspaceName: ref.name,
        gitUrl: ref.gitUrl,
        defaultBranch: ref.defaultBranch,
        backend: ref.backend,
        fallback: ref.fallback,
        tokenId: token.id,
        tokenExpiresAt: token.expiresAt,
        token: token.token,
      },
      201,
    );
  }

  private async handleCost(
    changeId: string,
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    record.costEvents.push({
      unitId,
      usd: numberOr(body.usd, 0),
      inputTokens: body.inputTokens as number | undefined,
      outputTokens: body.outputTokens as number | undefined,
      executor: body.executor as string | undefined,
      at: new Date().toISOString(),
    });
    return json({ ok: true }, 200);
  }

  private async handleComplete(
    changeId: string,
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const costBody = body.cost as Record<string, unknown> | undefined;
    if (costBody) {
      record.costEvents.push({
        unitId,
        usd: numberOr(costBody.usd, 0),
        inputTokens: costBody.inputTokens as number | undefined,
        outputTokens: costBody.outputTokens as number | undefined,
        executor: costBody.executor as string | undefined,
        at: new Date().toISOString(),
      });
    }
    record.completed.add(unitId);
    const lease = record.leases.get(unitId);
    if (lease) {
      // Revoke the token but keep the workspace ref so verification and
      // integration can still read the pushed result afterwards.
      await this.workspaces.revokeToken(lease.ref, lease.token.id);
    }
    const statuses = workUnitStatuses(record.change, record.completed);
    return json(
      { completed: [...record.completed], statuses: Object.fromEntries(statuses) },
      200,
    );
  }

  private async handleFail(
    changeId: string,
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    if (!record.change.work.some((u) => u.id === unitId)) {
      return json({ error: `unknown WorkUnit: ${unitId}` }, 404);
    }
    const lease = record.leases.get(unitId);
    const failure = this.failUnit(changeId, unitId, body.reason as string | undefined);
    if (lease) {
      // Revoke the token exactly as completion does; the workspace ref is kept
      // for any later inspection, but the unit is terminal and not integrated.
      await this.workspaces.revokeToken(lease.ref, lease.token.id).catch(() => {});
    }
    return json({ failed: failure, completed: [...record.completed] }, 200);
  }

  private require(changeId: string): ChangeRecord {
    const record = this.records.get(changeId);
    if (!record) {
      throw new Error(`no such Change: ${changeId}`);
    }
    return record;
  }
}

/** A stable, filesystem-safe workspace name for a Change's WorkUnit. */
export function workspaceNameFor(changeId: string, unitId: string, round?: number): string {
  const base =
    round !== undefined && Number.isFinite(round) && round > 0
      ? `${changeId}--${unitId}--r${Math.floor(round)}`
      : `${changeId}--${unitId}`;
  return boundedRepoName(base);
}

/** The map key for a round-N agent instance, keyed by (unitId, round). */
function roundAgentKey(unitId: string, round: number): string {
  return `${unitId}#${normalizeRound(round)}`;
}

/** Normalize a retry round to a positive integer (round 2 is the first retry). */
function normalizeRound(round: number): number {
  return Number.isFinite(round) && round > 0 ? Math.floor(round) : 2;
}

/** Normalize a Jev juncture to one of the three known junctures. */
function normalizeJuncture(juncture: unknown): JevJuncture {
  return juncture === "plan-review" || juncture === "attribution" || juncture === "fix-confidence"
    ? juncture
    : "plan-review";
}

/** Normalize a re-fan source to a known value, or undefined (mirrors the DO). */
function normalizeRefanSource(value: unknown): RefanSource | undefined {
  return value === "parse" || value === "jev" || value === "re-plan" || value === "all"
    ? value
    : undefined;
}

/** Clamp a confidence/probability to [0, 1]; a non-finite value becomes 0. */
function clampUnit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Keep only finite numeric probability entries, bounded in count. */
function sanitizeProbabilities(
  probabilities: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  let count = 0;
  for (const [key, value] of Object.entries(probabilities)) {
    if (count >= 50) {
      break;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key.slice(0, 200)] = value;
      count += 1;
    }
  }
  return out;
}

/** The SHA-256 hex digest of a board token: the only form ever kept. */
function hashBoardToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (!init?.body || typeof init.body !== "string" || init.body.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function dec(segment: string | undefined): string {
  return decodeURIComponent(segment ?? "");
}

/** Keep an activity-step phase short, lowercase, and metadata-safe. */
function boundedPhase(phase: string | undefined): string {
  const text = (phase ?? "step").toString().replace(/\s+/g, "-").trim().toLowerCase();
  const bounded = text.length > 40 ? text.slice(0, 40) : text;
  return bounded === "" ? "step" : bounded;
}

/** Bound a text field and strip credential-looking fragments defensively. */
function sanitizeText(text: string, max: number): string {
  const redacted = (text ?? "")
    .toString()
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return redacted.length > max ? `${redacted.slice(0, max - 3)}...` : redacted;
}

/** Sanitize a reported UnitDetail (bound text, keep finite numbers). */
function sanitizeDetail(detail: UnitDetail): UnitDetail {
  const out: Record<string, unknown> = {};
  if (typeof detail.promptSummary === "string") out.promptSummary = sanitizeText(detail.promptSummary, 20_000);
  if (typeof detail.model === "string") out.model = detail.model.slice(0, 120);
  if (Array.isArray(detail.editedPaths)) {
    out.editedPaths = detail.editedPaths
      .filter((p): p is string => typeof p === "string")
      .slice(0, 50)
      .map((p) => p.slice(0, 300));
  }
  if (typeof detail.diff === "string") out.diff = sanitizeText(detail.diff, 20_000);
  if (typeof detail.commitMessage === "string") out.commitMessage = sanitizeText(detail.commitMessage, 500);
  if (typeof detail.inputTokens === "number" && Number.isFinite(detail.inputTokens)) out.inputTokens = detail.inputTokens;
  if (typeof detail.outputTokens === "number" && Number.isFinite(detail.outputTokens)) out.outputTokens = detail.outputTokens;
  if (typeof detail.usd === "number" && Number.isFinite(detail.usd)) out.usd = detail.usd;
  return out as UnitDetail;
}

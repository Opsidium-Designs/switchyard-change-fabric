import { DurableObject } from "cloudflare:workers";

import {
  appendBoardMessage,
  appendDecisionRecorded,
  appendSeamStalled,
  appendEngineRecord,
  appendDiscoveredUnits,
  appendIntegratedRev,
  appendToolGated,
  appendToolUsed,
  applyBoardEscalations,
  BoardError,
  boardDigest,
  checkBoardJoin,
  checkHelpFork,
  LEAD_ROLE,
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
  type BoardMessage,
  type BoardState,
  type BoardSummary,
  type Change,
  type ChangePlan,
  type ConcurrencyDial,
  type Dependency,
  type DiscoveredWorkUnit,
  type LeaseDecision,
  type LeasePlan,
  type PathCollision,
  type RecruitDecision,
  type WorkUnitStatus,
} from "@switchyard-change/change-core";

import type { IntegrateJobResult } from "@switchyard-change/verification/integrate-job";

import {
  attributionRequestFor,
  decideCloudRevision,
  jobDeadlineMs,
  parseCloudIntegrationConfig,
  planCloudJob,
  publicConfig,
  type AttributionRequest,
  type BoardRepoRecord,
  type CloudIntegrationConfig,
  type DriverAttribution,
  type CloudJobPlan,
  type CloudPlanOutcome,
  type CloudRevisionRecord,
} from "./cloud-integration.ts";
import type { DrivenPhase } from "./integration-driver.ts";
import type { Env } from "./env.ts";

/** The Change's tools repo (a name and clone URL, never a credential). */
export interface ToolsRepoRecord {
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
}

/**
 * The Change-level lifecycle status, distinct from a WorkUnit's status. It lets
 * the console attach to a Change the instant it exists, before the planner has
 * decomposed it:
 *   - "planning": the Change was created on the Worker as a placeholder (header
 *     only, no work yet) while the planner runs, so the console sees the Change
 *     exists (and that it is planning) within one poll instead of 404ing for the
 *     whole planner latency;
 *   - "running": the plan has been attached (the real work units are present) and
 *     the run is proceeding. A Change created from a full spec (the hand-authored
 *     path, or any create that already carries its work) is "running" from the
 *     start, so that path is unchanged;
 *   - "planning-failed": the run exited before a plan was attached (the planner
 *     threw, or a precondition failed after the placeholder was created), so the
 *     placeholder is terminally failed with the recorded reason instead of
 *     sitting in "planning" forever. Only a "planning" Change can move here.
 */
export type ChangeStatus = "planning" | "running" | "planning-failed";

/** Why a "planning" placeholder failed before its plan was attached. */
export interface PlanningFailureRecord {
  /** A short, human-readable reason (bounded, never a secret). */
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

/** How a WorkUnit's workspace was provisioned, as recorded on its lease. */
export interface LeaseWorkspace {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  /** Token id, kept so the token can be revoked on completion. Not the plaintext. */
  readonly tokenId: string;
  readonly tokenExpiresAt: string;
}

/**
 * The real backing identity of a WorkUnit's workspace (its Artifact repo),
 * projected from the recorded lease. This is what the console reveals when a
 * node is clicked: the actual repo name, clone URL, backend, and whether it is
 * the honest local/memory fallback. The plaintext scoped token is deliberately
 * never included here (only the token id), so the state projection carries the
 * repo identity without leaking a credential.
 */
export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  /** True when this is the honest local/memory fallback, not a live repo. */
  readonly fallback: boolean;
  readonly tokenId: string;
  readonly tokenExpiresAt: string;
  readonly leasedAt: string;
}

/**
 * One ordered activity step a runner/agent reported for a WorkUnit: a real step
 * in the run (leased, cloning, calling the model, applying the edit, committing,
 * pushing, verified, or failed). These are recorded by the actual run steps, so
 * the console's per-node activity log is backed by real steps, never synthesized
 * in the UI. The message is bounded and secret-stripped before storage.
 */
export interface ActivityStep {
  readonly phase: string;
  readonly message: string;
  readonly at: string;
}

/**
 * The rich per-unit detail a runner reports so the console's click-detail reads
 * from real state: a readable summary of the agent's prompt, the model's
 * proposed edit (changed paths and a readable diff/contents), the model id, the
 * proposed commit message, and token usage / cost when the provider reported it.
 * Every field is optional because detail accrues as the agent runs. No field is
 * ever a credential; the diff and prompt summary are bounded before storage.
 */
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

/** The live view of a single WorkUnit, as served to the console and CLI. */
export interface WorkUnitView {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
  /** Whether a runner currently holds a lease on this unit. */
  readonly leased: boolean;
  /**
   * The real Artifact repo backing this unit, present once an agent has been
   * recruited (a lease recorded) for it. Absent before recruitment. This is the
   * honest backing the console reveals on click; it is never fabricated.
   */
  readonly workspace?: WorkspaceIdentity;
  /**
   * The ordered log of real run steps the agent for this unit emitted. Present
   * once the run reported them; each entry is a concrete step, so the console's
   * per-node activity log is backed by real steps rather than synthesized.
   */
  readonly activity?: readonly ActivityStep[];
  /**
   * The rich per-unit detail (prompt summary, proposed edit/diff, model, tokens
   * and cost) the runner reported, present once produced. The node detail panel
   * reads these fields straight from state.
   */
  readonly detail?: UnitDetail;
}

/** A recorded cost event emitted by a runner for a WorkUnit. */
export interface CostEvent {
  readonly unitId: string;
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly executor?: string;
  readonly at: string;
}

/**
 * The agent-built tool recorded on the Change, when the work needed a capability
 * the repo lacked and a tool-builder agent published one. It names the builder
 * WorkUnit, the capability, the published script path, and the real workspace
 * (Artifact repo) the tool lives in. The console's tool node is backed by this,
 * so a tool node always maps to a real tool-builder repo.
 */
export interface ToolRecord {
  readonly builderUnitId: string;
  readonly capability: string;
  readonly toolPath: string;
  readonly workspace: WorkspaceIdentity;
  readonly label: string;
}

/** A recorded tool-consumption: a downstream unit that actually ran the tool. */
export interface ToolConsumption {
  readonly capability: string;
  readonly consumerUnitId: string;
  readonly at: string;
}

/**
 * A recorded LIVE DEPLOYMENT of the fixed app: the clickable workers.dev URL the
 * run deployed as end-of-run proof the fix works, plus the app name and when it
 * was deployed. Recorded only after verification passed and the app was actually
 * deployed, so the console surfaces a real, reachable URL and never a URL for a
 * broken or undeployed app. Torn down by the per-run cleanup.
 */
export interface DeploymentRecord {
  /** The clickable live URL (https://<name>.<subdomain>.workers.dev). */
  readonly url: string;
  /** The app name (the examples/apps/<name> directory) that was deployed. */
  readonly app: string;
  readonly at: string;
}

/**
 * A write-lease coordination record for a contested path: the single owner and
 * the waiters ordered behind it. Projected from the lease plan so the console
 * surfaces the single-writer coordination as a graph edge.
 */
export interface LeaseEdge {
  readonly path: string;
  readonly owner: string;
  readonly waiters: readonly string[];
}

/** The outcome of one mechanical verification attempt. */
export type VerifyOutcome = "pass" | "fail";

/**
 * One recorded CHANGE-LEVEL VERIFY attempt: a single mechanical run of the
 * per-app behavioral gate against the integrated change after a wave completed.
 * The ladder is change-level, so there is one attempt per round (round 1 after
 * the kickoff wave, round 2 after the implicated-unit retry), not one per unit.
 * It is the honest backing for a `verify` graph node, so a verify node always
 * maps to a real recorded gate run. The model id is the model that produced the
 * edits this round graded (never the verifier itself, which is mechanical). The
 * failing output is the bounded gate output on a failure, kept so the retry
 * prompt and the console can show WHY the round failed, and the gate command is
 * kept so the console can show exactly what ran.
 */
/**
 * How the implicated units for a re-fan were chosen after a change-level
 * verify-fail: "parse" (the string-parse of the failing gate output narrowed
 * them), "jev" (a confident Jev attribution choice drove the selection),
 * "re-plan" (a configured re-plan transport returned a revised unit set), or
 * "all" (nothing could be attributed, so the honest fallback re-fanned every
 * gated unit). It makes WHY a round re-fanned the units it did visible on both
 * the verify attempt that failed and the retry it produced.
 */
export type RefanSource = "parse" | "jev" | "re-plan" | "all";

export interface VerifyAttempt {
  /** 1 for the first verify after the kickoff wave, 2 after the retry wave. */
  readonly round: number;
  readonly outcome: VerifyOutcome;
  /** The model id whose edits this round graded (empty for a deterministic run). */
  readonly model: string;
  /** The gate command (argv joined) that was run for this round. */
  readonly gateCommand?: string;
  /** Bounded real gate failing output (stderr/stdout) when the round failed. */
  readonly failingOutput?: string;
  /**
   * The unit ids the resulting re-fan selected for the NEXT round, recorded on
   * the failing verify so the console can show which units this round's failure
   * re-fanned. Present only on a fail that produced a re-fan (a retry round).
   */
  readonly implicatedUnits?: readonly string[];
  /**
   * How those implicated units were chosen (parse | jev | re-plan | all).
   * Present only on a fail that produced a re-fan.
   */
  readonly refanSource?: RefanSource;
  readonly at: string;
}

/**
 * One recorded CHANGE-LEVEL model-escalation RETRY: after a change-level
 * verify-fail, the ladder re-fanned the IMPLICATED units on a stronger model,
 * fed the failing evidence. The ladder is change-level, so there is one retry
 * per round carrying the units it re-fanned. It is the honest backing for a
 * `retry` graph node and the `model-escalation` edge, so neither can be drawn
 * without a real recorded retry. It names the model the previous round used and
 * the escalation model this retry ran, so the console shows the base to
 * escalation hop truthfully. This is wholly separate from the human-escalation
 * `escalated` flag.
 */
export interface RetryAttempt {
  /** The verify round this retry produced edits for (2 for the first retry). */
  readonly round: number;
  /** The model the previous (failed) round used. */
  readonly fromModel: string;
  /** The stronger model this retry escalated the implicated units to. */
  readonly toModel: string;
  /** The unit ids re-fanned on the escalation model (the implicated units). */
  readonly implicatedUnits: readonly string[];
  /**
   * How the implicated units were chosen (parse | jev | re-plan | all), so the
   * console can show whether this round narrowed by the string-parse, a Jev
   * choice, a configured re-plan, or the honest re-fan-all fallback. A re-plan
   * refanSource is what makes a live re-plan countable (rePlans > 0).
   */
  readonly refanSource?: RefanSource;
  /** A short, human-readable reason the ladder escalated (never a secret). */
  readonly reason: string;
  /**
   * The revised units a re-plan chose this round, each WITH the re-plan
   * objective it assigned, so a round-keyed planner node can render the re-plan
   * at parity with the kickoff planner (units-with-objectives, not just ids).
   * Present only on a re-plan round (refanSource "re-plan"); absent on a
   * parse/jev/all retry, which carries only implicatedUnits.
   */
  readonly revisedUnits?: readonly { readonly id: string; readonly objective: string }[];
  /**
   * The re-plan's rationale for revising the plan this way, so the round-keyed
   * planner node can show WHY, at parity with the kickoff planner's rationale.
   * Present only on a re-plan round that carried one.
   */
  readonly rationale?: string;
  readonly at: string;
}

/**
 * The decision juncture a Jev typed decision was recorded at. "plan-review" is
 * the after-a-plan "does this cover the goal?" noul; "attribution" is the
 * on-gate-fail "which modules does this implicate?" choice; "fix-confidence" is
 * the after-the-authoritative-gate "is this fix acceptable?" advisory noul.
 */
export type JevJuncture = "plan-review" | "attribution" | "fix-confidence";

/**
 * One recorded Jev typed decision: the juncture it was asked at, the question,
 * the typed answer (a noul, a choice, or a score), the calibrated confidence,
 * optional per-outcome probabilities, and whether the engine ACCEPTED the answer
 * (confident, at or above the threshold) or ESCALATED (low-confidence or a
 * confident "no"). It is the real backing for a `jev` graph node, so a jev node
 * can only exist once this record does. It is a DISPLAY and confidence signal:
 * the mechanical gate and gate-equals-deploy remain authoritative, so a recorded
 * fix-confidence decision never flips the verdict or gates promotion.
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
  /** True when the answer was confidently used; false when the juncture escalated. */
  readonly accepted: boolean;
  /** Set when the decision call failed: a short, credential-free reason. */
  readonly error?: string;
  readonly at: string;
}

/**
 * A recorded round-N agent instance for a retry round, keyed by (unitId, round).
 * It is the real backing for a round-N `agent` graph node: a retry round's
 * re-fanned unit is a BRAND NEW agent instance that spawns and tracks state
 * exactly like a kickoff-wave agent, scoped to (unit, round). It carries its OWN
 * real Artifact repo (recorded like a kickoff lease), a real status lifecycle
 * (running -> integrated | failed), and the real ordered run steps and rich
 * detail the retry's executor emitted, so the graph reads the round-N node's
 * status, workspace, activity, and detail from recorded state rather than a
 * hardcoded literal. The kickoff agent derives these same fields from the
 * per-unit lease/activity/detail machinery; a round-N agent mirrors it exactly,
 * keyed by (unitId, round) so round N and round N+1 are distinct instances for
 * the same unit.
 */
export interface RoundAgentView {
  readonly unitId: string;
  readonly round: number;
  /**
   * The real Artifact repo this round-N agent ran in, recorded at lease time
   * exactly like a kickoff lease records a unit's workspace. The plaintext token
   * is never included (only the token id).
   */
  readonly workspace: WorkspaceIdentity;
  /**
   * The round-N agent's live status, driven through the SAME lifecycle a kickoff
   * agent walks: "running" when leased and in flight, "integrated" when the round
   * completed, "failed" when the round's work failed. The graph projects the
   * round-N node's color from this, so it moves blue -> green/red like a kickoff
   * node rather than sitting at a fixed status.
   */
  readonly status: WorkUnitStatus;
  /**
   * The ordered real run steps this round-N agent emitted (leased, cloning,
   * model-call, applied-edit, commit, push, pushed, or failed), reported exactly
   * like a kickoff agent reports its steps, so the console's per-node activity
   * log for a round-N instance is backed by real steps.
   */
  readonly activity?: readonly ActivityStep[];
  /**
   * The rich per-unit detail (prompt summary, model id, edited paths, diff,
   * commit message, tokens, cost) this round-N agent produced, reported exactly
   * like a kickoff agent reports its detail.
   */
  readonly detail?: UnitDetail;
}

/** The verdict of the authoritative final integration gate for a whole Change. */
export type IntegrationVerdict = "verified" | "failed";

/**
 * The AUTHORITATIVE whole-change integration verdict: the outcome of the final
 * integration gate run on the exact integrated/promoted tree, recorded by the
 * run after that gate ran. It is the sole source of truth for whether the Change
 * (the goal node) is verified or failed. The per-round ladder verify attempts are
 * an advisory overlay on the way there and never decide the goal on their own.
 * Null until the run records it, and reset whenever the Change is re-created.
 */
export interface IntegrationRecord {
  readonly verdict: IntegrationVerdict;
  /** The unit ids the final integration actually integrated. */
  readonly integratedUnits: readonly string[];
  /** The unit ids the final integration excluded (not shipped). */
  readonly excludedUnits: readonly string[];
  /**
   * False when NO gate ran (no gate configured): a "verified" verdict then
   * checked nothing and is unverified. Absent when a gate ran.
   */
  readonly gated?: false;
  readonly at: string;
}

/**
 * An outstanding lease (kickoff or round-N) that a re-create of the Change
 * superseded. Re-creating a Change id wipes its bookkeeping, so every lease that
 * was still live at that moment is captured here (atomically, inside the same
 * Durable Object call that wipes it) and handed back to the Worker, which
 * revokes each token. A lease is therefore never dropped from the record
 * without a revocation attempt. Carries only the token id, never the plaintext.
 */
export interface SupersededLease {
  readonly unitId: string;
  /** The retry round for a round-N lease; absent for a kickoff lease. */
  readonly round?: number;
  readonly workspaceName: string;
  readonly tokenId: string;
}

/** The result of a create that may have superseded a prior run of the same id. */
export interface CreateResult {
  readonly state: ChangeStateView;
  /** Leases that were live when the prior run was wiped; the caller revokes them. */
  readonly superseded: readonly SupersededLease[];
}

/** Thrown when a lifecycle call does not fit the Change's current status. */
export class ChangeStatusConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeStatusConflictError";
  }
}

/** The message prefix every status conflict carries, so the Worker can map it to 409. */
export const STATUS_CONFLICT_PREFIX = "status conflict:";

/**
 * The projection of the recorded plan surfaced on the state view. It is the
 * graph `planner` node's backing: the plan source (planner vs heuristic
 * fallback), the model that produced it, the planned unit ids (matching the
 * Change's own ids), and the frozen read-only contract paths. The structural
 * twin of the graph model's PlanSnapshot, so it feeds the projection directly.
 */
export interface PlanView {
  readonly source: ChangePlan["source"];
  readonly model: string;
  readonly units: readonly string[];
  readonly contracts: readonly string[];
  /**
   * A readable, secret-free summary of what the planner was asked (the goal plus
   * the structural module map it was handed). Surfaced in the console's planner
   * detail panel. Optional/empty-safe: absent on a plan that carries none.
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

/** The live, serializable projection of a Change's orchestration state. */
export interface ChangeStateView {
  readonly id: string;
  readonly objective: string;
  /**
   * The Change-level lifecycle status: "planning" while the Change exists as a
   * placeholder and the planner is still deciding the work, "running" once the
   * plan is attached (or from the start for a full-spec create). The console
   * reads this so it can show that a just-created Change exists and is planning
   * within one poll, rather than 404ing for the whole planner latency.
   */
  readonly status: ChangeStatus;
  readonly baseline: string;
  readonly budgetUsd: number;
  readonly assurance: Change["assurance"];
  readonly work: readonly WorkUnitView[];
  readonly edges: readonly Dependency[];
  readonly collisions: readonly PathCollision[];
  readonly completed: readonly string[];
  /** Total recorded cost across all WorkUnits so far. */
  readonly spentUsd: number;
  readonly costEvents: readonly CostEvent[];
  /** The ordered log of WorkUnit state transitions this run has recorded. */
  readonly transitions: readonly Transition[];
  /** The min/max concurrency dial currently governing recruitment. */
  readonly dial: ConcurrencyDial;
  /** The inspectable recruitment-event log (why/what triggered each wave). */
  readonly recruitments: readonly RecruitmentEvent[];
  /**
   * The schema-constrained plan recorded for this Change, when the goal was
   * decomposed through the inference-backed planner pass (or its heuristic
   * fallback). It rode the Change spec round-trip (parsed into change.plan) and
   * is surfaced here so the graph projection can root a real `planner` node
   * (goal -> planner -> agents). Absent on the plain heuristic path (no plan on
   * the Change), where the graph has no planner node, exactly as before.
   */
  readonly plan?: PlanView;
  /**
   * The agent-built tool for this Change, when one was built; otherwise absent.
   * Backs the console's tool node.
   */
  readonly tool?: ToolRecord;
  /** Real tool-consumption records; each backs one consumed-tool edge. */
  readonly toolConsumptions: readonly ToolConsumption[];
  /**
   * The write-lease coordination on contested paths (owner vs waiters). Backs
   * the console's lease edges and makes the single-writer coordination legible.
   */
  readonly leaseEdges: readonly LeaseEdge[];
  /**
   * The human escalations recorded for this Change: forks mechanical evidence
   * could not settle. A pending escalation lights the `escalated` node flag in
   * the graph and the engine waits on it; a resolved one carries the decision.
   */
  readonly escalations: readonly Escalation[];
  /**
   * The WorkUnits an agent ultimately failed on, with the reason. A failed unit
   * is terminal-for-that-unit and does not block the rest of the wave: the
   * scheduler advances the remaining runnable units. The console renders a
   * failed node distinctly, and the run summary reports which units failed.
   */
  readonly failed: readonly FailureRecord[];
  /**
   * The live deployment of the fixed app for this run, when the run deployed one
   * as end-of-run proof. Present only after verification passed and the deploy
   * succeeded, so the console surfaces a real reachable workers.dev URL. Absent
   * for a run that did not deploy (the intro template) or whose fix failed.
   */
  readonly deployment?: DeploymentRecord;
  /**
   * The CHANGE-LEVEL mechanical verify attempts recorded for this Change: each
   * is one real run of the per-app gate against the integrated change after a
   * wave, keyed by round. They back the graph's `verify` nodes, so a verify node
   * always maps to a real recorded gate run.
   */
  readonly verifyAttempts: readonly VerifyAttempt[];
  /**
   * The CHANGE-LEVEL model-escalation retries recorded for this Change: each is
   * one re-fan of the implicated units on a stronger model fed the failing
   * evidence, keyed by round. They back the graph's `retry` nodes and
   * `model-escalation` edges, and are kept wholly separate from the
   * human-escalation `escalated` flag.
   */
  readonly retryAttempts: readonly RetryAttempt[];
  /**
   * How many retry rounds were driven by a LIVE re-plan (a configured re-plan
   * transport returning a revised unit set), derived from the retry attempts
   * whose refanSource is "re-plan". Zero on the offline/attribution path, so a
   * caller can tell a run that genuinely re-planned (rePlans > 0) from one that
   * only used the deterministic string-parse/Jev attribution path.
   */
  readonly rePlans: number;
  /**
   * The round-N agent instances recorded for this Change: each is a retry
   * round's re-fanned unit running as a BRAND NEW agent keyed by (unitId, round),
   * with its OWN recorded Artifact repo and a real status lifecycle. They back
   * the graph's round-N `agent` nodes, so a round-N node's status/workspace/
   * activity/detail come from recorded state and move exactly like a kickoff
   * agent (blue running -> green integrated / red failed).
   */
  readonly roundAgents: readonly RoundAgentView[];
  /**
   * The Jev typed decisions recorded for this Change, each at one juncture
   * (plan-review, attribution, or fix-confidence). They back the graph's `jev`
   * nodes, so a jev node always maps to a real recorded decision. A
   * fix-confidence decision is advisory only and never flips the authoritative
   * gate verdict or gates promotion/deploy; it is display + a confidence signal.
   */
  readonly jevDecisions: readonly JevDecisionView[];
  /**
   * The AUTHORITATIVE whole-change integration verdict (the final integration
   * gate on the exact integrated tree), or null until the run records it. This,
   * not the latest ladder verify attempt, decides whether the goal node is
   * verified or failed; before it exists the goal is still in progress.
   */
  readonly integration: IntegrationRecord | null;
  /**
   * Why the planning placeholder failed (status "planning-failed"), or null.
   * It backs the goal node's terminal red when the run never got a plan.
   */
  readonly planningFailure: PlanningFailureRecord | null;
  /**
   * A count summary of the Change board (messages, agents, items by status,
   * contests by status, published tools, latest passing integrated revision).
   * The full log and reduced state are served by GET /changes/:id/board, so the
   * snapshot stays small.
   */
  readonly board: BoardSummary;
}

/** A board rejection, with its machine-readable code. */
export interface BoardFailure {
  readonly ok: false;
  readonly code: string;
  readonly error: string;
}

/** How many integration attempts a Change keeps (the board keeps every revision). */
const CLOUD_REVISIONS_KEPT = 64;

/** The integration Workflow bookkeeping. */
interface CloudIntegrationRun {
  readonly active?: { readonly instanceId: string; readonly startedAt: string };
  /** A push landed (or the run kicked) while the active Workflow ran: look again before finishing. */
  readonly kicked: boolean;
  readonly counter: number;
}

/** The answer to a request for integration. */
export interface CloudIntegrationRequest {
  readonly start: boolean;
  readonly instanceId?: string;
  readonly coalesced?: boolean;
  readonly activeInstance?: string;
  readonly reason?: string;
}

/** A failing revision waiting for the run's advisory attribution. */
interface PendingAttribution {
  readonly request: AttributionRequest;
  readonly answer?: readonly string[];
}

/** The open view of integration on Cloudflare. */
export interface CloudIntegrationView {
  readonly configured: boolean;
  readonly config?: Record<string, unknown>;
  readonly active?: { readonly instanceId: string; readonly startedAt: string };
  readonly kicked: boolean;
  /** A failing revision the Workflow holds for the run's advisory attribution. */
  readonly pendingAttribution?: AttributionRequest;
  readonly revisions: readonly CloudRevisionRecord[];
}

/** The result of appending one message to the Change board. */
export type BoardAppendResponse =
  | {
      readonly ok: true;
      /** The posted message followed by the engine messages it triggered. */
      readonly appended: readonly BoardMessage[];
      /** Human escalations raised because a contest escalated (usually empty). */
      readonly escalations: readonly Escalation[];
      /** The new agent's board token (join only; shown once, stored hashed). */
      readonly token?: string;
    }
  | BoardFailure;

/** The board log after a seq (one page), with the reduced board state. */
export interface BoardView {
  readonly lastSeq: number;
  readonly messages: readonly BoardMessage[];
  /** True when more messages follow this page. */
  readonly hasMore: boolean;
  readonly state: BoardState;
}

/** Default and largest page of board messages one read returns. */
export const BOARD_PAGE_DEFAULT = 500;
export const BOARD_PAGE_MAX = 1000;

/**
 * A recorded WorkUnit failure: an agent ultimately could not complete the unit
 * (its executor errored past the bounded retries, or timed out). It releases the
 * lease and is terminal-for-that-unit, so the scheduler advances the rest of the
 * wave rather than freezing on it.
 */
export interface FailureRecord {
  readonly unitId: string;
  /** A short, human-readable reason (never a secret or a token). */
  readonly reason: string;
  readonly at: string;
}

/** The payload returned when a runner leases a WorkUnit. */
export interface LeaseRecord extends LeaseWorkspace {
  readonly unitId: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly baselineRef: string;
  readonly leasedAt: string;
}

/** A recorded WorkUnit state transition, for observability and the viz later. */
export interface Transition {
  readonly unitId: string;
  readonly from: WorkUnitStatus;
  readonly to: WorkUnitStatus;
  readonly at: string;
  /** What drove the transition: the durable workflow loop or a runner. */
  readonly by: "workflow" | "runner";
}

/** The outcome of advancing one scheduling wave from the durable workflow. */
export interface AdvanceResult {
  /** How many WorkUnits were advanced to complete in this wave. */
  readonly advanced: number;
  /** The WorkUnit ids advanced in this wave, in schedule order. */
  readonly units: readonly string[];
  /** True when the graph is complete (no runnable and no waiting units remain). */
  readonly done: boolean;
  /** The completed WorkUnit ids after this wave. */
  readonly completed: readonly string[];
}

/**
 * A recruitment plan for one wave: which runnable WorkUnits the dial allows an
 * agent to be recruited for right now, given how many agents are already in
 * flight. This is the policy decision; provisioning a workspace and recording a
 * lease for each recruited unit is the Worker's job (it has the provisioner),
 * exactly as the single-unit lease path already works.
 */
export interface RecruitmentPlan extends RecruitDecision {
  /** The number of recruited agents already in flight (leased, not complete). */
  readonly inFlight: number;
  /** The active dial this plan was computed under. */
  readonly dial: ConcurrencyDial;
  /** The full runnable set the plan was computed over, for inspection. */
  readonly runnable: readonly string[];
}

/**
 * A recorded recruitment event: an inspectable log entry explaining why a wave
 * of agents was recruited and what triggered it. The trigger is explicit so the
 * event-driven nervous system is legible: a wave is recruited either at kickoff
 * or because a real repo-pushed event arrived, never because of a timer.
 */
export interface RecruitmentEvent {
  /** What drove this recruitment: the initial kickoff or a repo-pushed event. */
  readonly trigger: "kickoff" | "repo-pushed";
  /** For a repo-pushed trigger, the workspace whose push drove the next wave. */
  readonly pushedWorkspace?: string;
  /** For a repo-pushed trigger, the WorkUnit the push completed. */
  readonly completedUnit?: string;
  /** The WorkUnit ids recruited in response (an agent provisioned for each). */
  readonly recruited: readonly string[];
  /** The dial ceiling in force at the time. */
  readonly ceiling: number;
  /** The number of agents in flight after this recruitment. */
  readonly inFlightAfter: number;
  readonly at: string;
}

/** The outcome of ingesting a real (or faked) repo-pushed event. */
export interface RepoPushedResult {
  /** The WorkUnit whose push was recognized and marked complete, if any. */
  readonly completedUnit: string | null;
  /** The next wave recruited in response to the push, via the dial policy. */
  readonly recruited: readonly string[];
  /** True when the graph is complete after this push (nothing left to recruit). */
  readonly done: boolean;
  /** The recruitment event appended to the inspectable log. */
  readonly event: RecruitmentEvent;
}

/**
 * The kind of a fork the engine cannot settle on mechanical evidence and must
 * escalate to a human. "lease-owner" is a contested shared path with no
 * evidence-based way to pick the single writer; "verification-ambiguous" is a
 * WorkUnit whose verification evidence does not clearly pass or fail;
 * "decision" is any other required decision with no evidence-based answer.
 */
export type EscalationKind = "lease-owner" | "verification-ambiguous" | "decision";

/** Whether an escalation is still waiting on a human, or has been resolved. */
export type EscalationStatus = "pending" | "resolved";

/**
 * A human escalation: a fork mechanical evidence cannot settle. The engine
 * records it and WAITS (a durable record in ChangeState, not a sleep) until a
 * human posts a decision, which resolves it and lets the graph advance. A
 * pending escalation lights the `escalated` flag on its node in the graph.
 */
export interface Escalation {
  /** Stable id for this escalation (used to resolve it). */
  readonly id: string;
  readonly kind: EscalationKind;
  /** The WorkUnit this escalation concerns, when it is unit-scoped. */
  readonly unitId?: string;
  /** The contested path, for a lease-owner escalation. */
  readonly path?: string;
  /**
   * The board contest this escalation was raised for, when a contest on the
   * Change board ran out of turns. Resolving the escalation posts the decision
   * to the board as a human claim.resolved, so its options are enforced.
   */
  readonly boardContest?: string;
  /**
   * The protected board contract this escalation decides (a change to the
   * original tests or the gate's configuration). Resolving it posts the human's
   * accept or reject to the board.
   */
  readonly boardContract?: string;
  /** A re-planned board item that failed again: the human is told (closed when the item completes). */
  readonly boardItem?: string;
  /** The human-readable question the engine needs answered. */
  readonly question: string;
  /** The candidate answers the human may choose among (advisory, not enforced). */
  readonly options: readonly string[];
  readonly status: EscalationStatus;
  /** The human's decision text, once resolved. */
  readonly decision?: string;
  readonly raisedAt: string;
  readonly resolvedAt?: string;
  /**
   * A protected contract's ADVISORY triage (a typed decision), also appended to
   * the question: the recommendation and its confidence, or "no recommendation
   * (reason)". The human still decides; it never resolves the escalation.
   */
  readonly recommendation?: string;
}

/** The input to raise an escalation (ids and timestamps are assigned by the DO). */
export interface RaiseEscalationInput {
  readonly kind: EscalationKind;
  readonly unitId?: string;
  readonly path?: string;
  readonly boardContest?: string;
  readonly question: string;
  readonly options?: readonly string[];
}

/**
 * ChangeState: single-owner, serialized Durable Object holding the live Change
 * projection and the lease/cost bookkeeping that drives the work graph.
 *
 * It stores the parsed Change, the set of completed WorkUnit ids, the active
 * leases, and recorded cost events, and derives runnable/waiting/integrated
 * status on read with the pure scheduling functions in change-core. The Worker
 * provisions a workspace and token for a runnable unit and records the lease
 * here; the runner later reports completion with a cost event, which advances
 * dependents to runnable.
 */
/** The tag the live board feed's sockets carry. */
const BOARD_LIVE_TAG = "board";

/** A frame on the live board feed. */
export interface BoardLiveFrame {
  readonly type: "board.seq";
  readonly lastSeq: number;
}

export class ChangeState extends DurableObject<Env> {
  /** Create (or replace) the Change held by this object from spec YAML text. */
  async createFromSpec(specYaml: string): Promise<CreateResult> {
    const change = parseChangeSpec(specYaml);
    const superseded = await this.initChange(change, "running");
    return { state: await this.view(), superseded };
  }

  /**
   * Create a "planning" PLACEHOLDER Change from just its header (id, objective,
   * baseline, budget, assurance), with an EMPTY work set and status "planning",
   * BEFORE the planner has decided the work. This is what lets the console attach
   * to the Change the instant a run begins: the Change exists (and reports it is
   * planning) within one poll, instead of the console 404ing for the whole
   * planner latency. The real work and plan are attached later by `attachPlan`,
   * which flips the status to "running". An empty work set is intentional here
   * (the placeholder has no units yet); the full-spec `createFromSpec` path still
   * requires a non-empty parsed spec, so this is the only create that admits an
   * empty work set, and only transiently while planning.
   */
  async createPlanning(header: PlanningChangeHeader): Promise<CreateResult> {
    const change: Change = {
      id: header.id,
      objective: header.objective,
      baseline: header.baseline,
      budgetUsd: header.budgetUsd,
      assurance: header.assurance,
      work: [],
    };
    const superseded = await this.initChange(change, "planning");
    return { state: await this.view(), superseded };
  }

  /**
   * Attach the decomposed plan to a Change that was created as a "planning"
   * placeholder: re-parse the full spec YAML (which now carries the real work
   * units and the recorded plan), replace the stored Change with it, and flip the
   * status from "planning" to "running". This is the second half of the
   * create-first-then-plan flow: the console has already attached to the planning
   * placeholder, and this fills in the real graph and roots the planner node. The
   * run has not advanced yet (no leases/completions), so re-initializing the
   * bookkeeping is correct.
   *
   * It is ONLY allowed while the Change is still "planning". Attaching a plan to
   * a Change that is already running (or that a prior run left behind) would
   * silently wipe a live run's leases and history, so that is rejected with a
   * status conflict; a caller that genuinely means to start over re-creates the
   * Change (POST /changes or POST /changes/planning), which supersedes the prior
   * run and revokes its outstanding leases.
   */
  async attachPlan(specYaml: string): Promise<ChangeStateView> {
    const status = await this.loadChangeStatus();
    if (status !== "planning") {
      throw new ChangeStatusConflictError(
        `${STATUS_CONFLICT_PREFIX} a plan can only be attached while the Change is planning (it is ${status})`,
      );
    }
    const change = parseChangeSpec(specYaml);
    // A planning placeholder holds no leases (nothing can be leased with an
    // empty work set), so there is nothing to supersede here.
    await this.initChange(change, "running");
    return this.view();
  }

  /** The Change-level lifecycle status (planning | running | planning-failed). */
  async getStatus(): Promise<ChangeStatus> {
    return this.loadChangeStatus();
  }

  /**
   * Mark a "planning" placeholder as FAILED before its plan was attached, with
   * the recorded reason. Only allowed while the Change is planning: a running
   * Change's outcome is decided by its integration verdict, never by this. A
   * re-create of the id (a fresh run) clears it.
   */
  async failPlanning(reason: string): Promise<ChangeStateView> {
    const status = await this.loadChangeStatus();
    if (status !== "planning") {
      throw new ChangeStatusConflictError(
        `${STATUS_CONFLICT_PREFIX} only a planning Change can be marked planning-failed (it is ${status})`,
      );
    }
    const record: PlanningFailureRecord = {
      reason: sanitizeReason(reason),
      at: new Date().toISOString(),
    };
    await this.ctx.storage.put("planningFailure", record);
    await this.ctx.storage.put("changeStatus", "planning-failed" as ChangeStatus);
    return this.view();
  }

  /**
   * Initialize (or re-initialize) all the per-Change bookkeeping for a freshly
   * created Change at the given lifecycle status. Shared by createFromSpec (full
   * spec, "running"), createPlanning (header-only placeholder, "planning"), and
   * attachPlan (plan attached, "running"), so the three creates stay consistent
   * and only differ in the Change they store and the status they set.
   *
   * Re-creating an existing Change id is a fresh run: EVERY per-run key is reset
   * (including the ladder's verify/retry attempts and the integration verdict),
   * so a new run never inherits the previous run's history. Any lease still
   * outstanding at that moment (a kickoff lease not yet completed/failed, or a
   * round-N agent still running) is captured BEFORE the wipe and returned, so the
   * Worker revokes its token: a lease is never wiped without revocation. The
   * capture and the wipe happen inside this one Durable Object call, so no lease
   * can be recorded between them.
   */
  private async initChange(change: Change, status: ChangeStatus): Promise<SupersededLease[]> {
    const superseded = await this.outstandingLeases();
    await this.ctx.storage.put("change", change);
    await this.ctx.storage.put("changeStatus", status);
    await this.ctx.storage.put("completed", [] as string[]);
    await this.ctx.storage.put("leases", {} as Record<string, LeaseRecord>);
    await this.ctx.storage.put("costEvents", [] as CostEvent[]);
    await this.ctx.storage.put("transitions", [] as Transition[]);
    await this.ctx.storage.put("dial", normalizeDial(undefined));
    await this.ctx.storage.put("recruitments", [] as RecruitmentEvent[]);
    // Compute and persist the write-lease plan from the Change's declared path
    // collisions at creation: one owner per contested path, the rest waiters.
    // This is the first-class lease coordination the DO serves, so a shared path
    // is resolved to a single writer rather than a silent terminal merge.
    const leasePlan = planWriteLeases(change, detectPathCollisions(change));
    await this.ctx.storage.put("leasePlan", leasePlan);
    // The agent-built tool for this Change (recorded when a tool-builder agent
    // publishes one), and the downstream consumption records.
    await this.ctx.storage.put("tool", null);
    await this.ctx.storage.put("toolConsumptions", [] as ToolConsumption[]);
    // Map from the backend workspace name a runner pushes to back to its unit
    // id, so a repo-pushed event (which carries the workspace, not the unit) can
    // recognize which WorkUnit finished.
    await this.ctx.storage.put("workspaceUnits", {} as Record<string, string>);
    // Map from unit id to its real workspace (Artifact repo) identity, recorded
    // when the unit is leased and kept past completion so a completed node still
    // reveals the real repo it ran in. The plaintext token is never stored here.
    await this.ctx.storage.put("workspaces", {} as Record<string, WorkspaceIdentity>);
    // Human escalations: forks mechanical evidence could not settle. Empty until
    // the engine raises one; a pending one is a durable wait the graph blocks on.
    await this.ctx.storage.put("escalations", [] as Escalation[]);
    // WorkUnits an agent ultimately failed on (after bounded retries or a
    // timeout). A failed unit is terminal-for-that-unit: it releases its lease so
    // the dial frees that slot and the wave advances, and it is NOT counted as
    // completed, so its dependents stay blocked rather than running on a missing
    // prerequisite. The failure reason is kept so the state can report why.
    await this.ctx.storage.put("failed", {} as Record<string, FailureRecord>);
    // Per-unit activity logs (the real ordered run steps a runner reports) and
    // per-unit rich detail (prompt summary, proposed edit/diff, model, tokens).
    // Both start empty and accrue only from real steps the run reports; they are
    // what the console's activity log and click-detail render from real state.
    await this.ctx.storage.put("activity", {} as Record<string, ActivityStep[]>);
    await this.ctx.storage.put("detail", {} as Record<string, UnitDetail>);
    // The live deployment of the fixed app (recorded at the end of a real-app
    // run after verification passed). Null until the run deploys one.
    await this.ctx.storage.put("deployment", null);
    // Round-N agent instances, keyed by `${unitId}#${round}`: a retry round's
    // re-fanned unit running as a BRAND NEW agent with its OWN recorded Artifact
    // repo and a real status lifecycle, exactly like a kickoff lease. Empty until
    // the change-level ladder re-fans a unit on a retry round.
    await this.ctx.storage.put("roundAgents", {} as Record<string, RoundAgentView>);
    // Jev typed decisions recorded at the three junctures (plan-review,
    // attribution, fix-confidence). Empty until the decision layer is live and
    // a juncture records one; absent entirely on the offline path (no jev node).
    await this.ctx.storage.put("jevDecisions", [] as JevDecisionView[]);
    // The change-level ladder history (verify attempts and model-escalation
    // retries) and the authoritative integration verdict are per-run too: a
    // re-created Change must not inherit the previous run's rounds or verdict.
    await this.ctx.storage.put("verifyAttempts", [] as VerifyAttempt[]);
    await this.ctx.storage.put("retryAttempts", [] as RetryAttempt[]);
    await this.ctx.storage.put("integration", null);
    await this.ctx.storage.put("planningFailure", null);
    // The Change board: an ordered log of typed coordination messages, stored
    // one message per key (`board:<seq>`) so no single value grows with the
    // log, plus the reduced board state and the agent token hashes, all
    // written in one transaction per append. A fresh run deletes the prior
    // run's messages and tokens and starts an empty board at seq 0.
    await this.clearBoardMessages();
    await this.ctx.storage.put("boardSeq", 0);
    await this.ctx.storage.put("boardState", emptyBoard());
    await this.ctx.storage.put("boardTokens", {} as Record<string, string>);
    // Integration on Cloudflare (per run): its configuration, the Workflow
    // bookkeeping, every revision attempt, and the agents' repo identities.
    // Which agents joined with a repo is per run too: a prior run's agent must
    // never pass the read-token, agent-token, or help-fork checks of this one.
    await this.ctx.storage.delete(["cloudIntegrationConfig", "cloudIntegrationRun", "cloudRevisions", "cloudAttribution", "boardRepos", "boardRepoAgents", "toolsRepo"]);
    // The Change's gate runner keeps finished job outcomes for replay: a fresh
    // run starts with none (the job keys carry a run nonce too).
    await this.clearGateRunnerCache(change.id);
    return superseded;
  }

  /** Clear the Change's GateRunner outcome cache (best effort: no runner bound, or it is unreachable, is not a failure). */
  private async clearGateRunnerCache(changeId: string): Promise<void> {
    const runners = this.env.GATE_RUNNER;
    if (!runners) {
      return;
    }
    try {
      await runners.get(runners.idFromName(changeId)).clearCache();
    } catch {
      // The new run's job keys differ anyway (they carry the configuration time).
    }
  }

  /** Delete every stored board message (a re-created Change starts empty). */
  private async clearBoardMessages(): Promise<void> {
    const listed = await this.ctx.storage.list({ prefix: BOARD_KEY_PREFIX });
    const keys = [...listed.keys()];
    for (let i = 0; i < keys.length; i += 128) {
      await this.ctx.storage.delete(keys.slice(i, i + 128));
    }
  }

  /**
   * The one write path for the board. Inside a single storage transaction it
   * reads the board state and token map, computes the append with the shared
   * pure model, and writes every appended message, the new state and seq, the
   * token map, and the escalation records together. A rejected message throws
   * inside the transaction, so nothing is written. Escalations follow the
   * board: a settled contest closes its pending escalation, and an escalated
   * contest raises one.
   */
  private async appendToBoard(
    make: (state: BoardState, tokens: Readonly<Record<string, string>>) => BoardAppendResult,
    options: {
      readonly tokens?: (tokens: Record<string, string>) => Record<string, string>;
      readonly escalations?: (list: Escalation[]) => Escalation[];
    } = {},
  ): Promise<{ readonly appended: readonly BoardMessage[]; readonly escalations: readonly Escalation[] }> {
    const done = await this.ctx.storage.transaction(async (txn) => {
      const state = (await txn.get<BoardState>("boardState")) ?? emptyBoard();
      let tokens = (await txn.get<Record<string, string>>("boardTokens")) ?? {};
      const result = make(state, tokens);
      if (options.tokens) {
        tokens = options.tokens(tokens);
      }
      const left = new Set(result.appended.filter((m) => m.type === "agent.left").map((m) => m.from));
      if (left.size > 0) {
        tokens = Object.fromEntries(Object.entries(tokens).filter(([, agent]) => !left.has(agent)));
      }
      let escalations = (await txn.get<Escalation[]>("escalations")) ?? [];
      if (options.escalations) {
        escalations = options.escalations(escalations);
      }
      const applied = applyBoardEscalations(escalations, result.appended, Date.now());
      const writes: [string, unknown][] = result.appended.map((m) => [boardMessageKey(m.seq), m]);
      writes.push(
        ["boardState", result.state],
        ["boardSeq", result.state.lastSeq],
        ["boardTokens", tokens],
        ["escalations", applied.list],
      );
      for (let i = 0; i < writes.length; i += 128) {
        await txn.put(Object.fromEntries(writes.slice(i, i + 128)));
      }
      return { appended: result.appended, escalations: applied.raised };
    });
    const last = done.appended.at(-1)?.seq;
    if (last !== undefined) {
      this.announceBoardSeq(last);
    }
    return done;
  }

  // -------------------------------------------------------------------------
  // The live board feed (WebSocket Hibernation)
  // -------------------------------------------------------------------------

  /** The sockets watching this board (none in an environment without WebSocket Hibernation). */
  private boardSockets(): WebSocket[] {
    const ctx = this.ctx as unknown as { getWebSockets?: (tag?: string) => WebSocket[] };
    return typeof ctx.getWebSockets === "function" ? ctx.getWebSockets(BOARD_LIVE_TAG) : [];
  }

  /**
   * Tell every watcher the board's new last seq, after an append committed. A
   * nudge only: the watcher reads the messages through the same paged board
   * route as a poll, so the log has one read path. A socket that cannot take
   * the nudge is skipped (the watcher's slow poll still catches up).
   */
  private announceBoardSeq(lastSeq: number): void {
    const frame = JSON.stringify({ type: "board.seq", lastSeq } satisfies BoardLiveFrame);
    for (const socket of this.boardSockets()) {
      try {
        socket.send(frame);
      } catch {
        /* a closing socket; its watcher falls back to polling */
      }
    }
  }

  /**
   * Accept a watcher of the live board feed: a hibernatable WebSocket that is
   * sent the current last seq at once, then one `board.seq` frame after every
   * append. Read-only, like the board's GET route; it carries no message
   * content and accepts no commands.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(JSON.stringify({ code: "BAD_PAYLOAD", error: "expected a WebSocket upgrade" }), {
        status: 426,
        headers: { "content-type": "application/json" },
      });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [BOARD_LIVE_TAG]);
    const lastSeq = (await this.ctx.storage.get<number>("boardSeq")) ?? 0;
    server.send(JSON.stringify({ type: "board.seq", lastSeq } satisfies BoardLiveFrame));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A watcher's only message is a keepalive ping; anything else is ignored. */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
    }
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      /* already closed */
    }
  }

  /** Run a board operation, turning a board rejection into a coded failure. */
  private async boardOutcome(
    run: () => Promise<{ readonly appended: readonly BoardMessage[]; readonly escalations: readonly Escalation[] }>,
    token?: string,
  ): Promise<BoardAppendResponse> {
    try {
      const done = await run();
      return { ok: true, ...done, ...(token !== undefined ? { token } : {}) };
    } catch (error) {
      if (error instanceof BoardError) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
  }

  /**
   * Join the board as `agent` (the join route, under the shared bearer). Issues
   * a random per-agent board token, returned once; only its SHA-256 hash is
   * stored. Every later agent post must present it, and the agent's identity is
   * taken from it.
   */
  async joinBoard(
    agent: string,
    body: { readonly role?: unknown; readonly rationale?: unknown },
    options: { readonly withWorkspace?: boolean; readonly repo?: BoardRepoRecord } = {},
  ): Promise<BoardAppendResponse> {
    const token = newBoardToken();
    const hash = await hashBoardToken(token);
    const outcome = await this.boardOutcome(
      () =>
        this.appendToBoard(
          (state) =>
            appendBoardMessage(
              state,
              { kind: "join", agent },
              {
                type: "agent.joined",
                payload: body.role !== undefined ? { role: body.role } : {},
                ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
              },
              new Date().toISOString(),
            ),
          { tokens: (tokens) => ({ ...tokens, [hash]: agent }) },
        ),
      token,
    );
    if (outcome.ok && options.withWorkspace) {
      // Which agents have a repo of their own (the operator's read tokens are only for these).
      const withRepo = (await this.ctx.storage.get<string[]>("boardRepoAgents")) ?? [];
      await this.ctx.storage.put("boardRepoAgents", [...withRepo, agent]);
      if (options.repo) {
        // The repo's identity (never a token): what the integration Workflow reads.
        const repos = (await this.ctx.storage.get<Record<string, BoardRepoRecord>>("boardRepos")) ?? {};
        await this.ctx.storage.put("boardRepos", { ...repos, [agent]: options.repo });
      }
    }
    return outcome;
  }

  /**
   * Check that `agent` could join now, appending nothing: the join route runs
   * this BEFORE provisioning a workspace, so a join the board would refuse
   * never creates a repo or a token.
   */
  async checkBoardJoin(agent: string, body: { readonly role?: unknown; readonly rationale?: unknown }): Promise<{ readonly ok: true } | BoardFailure> {
    try {
      checkBoardJoin(await this.loadBoardState(), agent, body);
      return { ok: true };
    } catch (error) {
      if (error instanceof BoardError) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
  }

  /**
   * May `agent` fork the requester's repo for help request `request`? The
   * help-fork route runs this BEFORE forking anything; the requester must have
   * joined with its own repo (the fork's source).
   */
  async checkBoardHelpFork(request: string, agent: string): Promise<{ readonly ok: true; readonly requester: string } | BoardFailure> {
    let requester: string;
    try {
      requester = checkHelpFork(await this.loadBoardState(), request, agent).requester;
    } catch (error) {
      if (error instanceof BoardError) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
    if (!((await this.ctx.storage.get<string[]>("boardRepoAgents")) ?? []).includes(requester)) {
      return { ok: false, code: "NOT_ALLOWED", error: `${requester} joined without a workspace: there is no repo to fork` };
    }
    return { ok: true, requester };
  }

  /**
   * May the operator get a token for the help fork of `request`? Only when
   * `agent` holds its grant. A READ token stays allowed after the helper left
   * (the requester pulls the delivered commit); a WRITE token needs the helper
   * still joined (a helper that left never writes again).
   */
  async checkBoardHelpRead(request: string, agent: string, scope: "read" | "write" = "read"): Promise<{ readonly ok: true } | BoardFailure> {
    const state = await this.loadBoardState();
    const help = state.help[request];
    if (!help || help.grant === undefined || help.grant.agent !== agent) {
      return { ok: false, code: "NOT_ALLOWED", error: `${agent} holds no granted help fork for ${request}` };
    }
    if (scope === "write") {
      const record = state.agents[agent];
      if (record === undefined || record.leftSeq !== undefined) {
        return { ok: false, code: "UNKNOWN_AGENT", error: `${agent} is not a joined agent of this board: no write token for its help fork` };
      }
    }
    return { ok: true };
  }

  /**
   * May the operator read `agent`'s repo? Only a joined (not left) agent that
   * joined with its own workspace, and never the lead (it has no repo).
   */
  async checkBoardRepoAgent(agent: string): Promise<{ readonly ok: true } | BoardFailure> {
    const record = (await this.loadBoardState()).agents[agent];
    if (record === undefined || record.leftSeq !== undefined) {
      return { ok: false, code: "UNKNOWN_AGENT", error: `${agent} is not a joined agent of this board` };
    }
    if (record.role === LEAD_ROLE) {
      return { ok: false, code: "NOT_ALLOWED", error: `${agent} is the lead and has no repo` };
    }
    if (!((await this.ctx.storage.get<string[]>("boardRepoAgents")) ?? []).includes(agent)) {
      return { ok: false, code: "NOT_ALLOWED", error: `${agent} joined without a workspace and has no repo` };
    }
    return { ok: true };
  }

  /** Append one message as the agent the board token identifies. */
  async postBoardAsAgent(token: string, raw: unknown): Promise<BoardAppendResponse> {
    const hash = await hashBoardToken(token);
    return this.boardOutcome(() =>
      this.appendToBoard((state, tokens) => {
        const agent = tokens[hash];
        if (agent === undefined) {
          throw new BoardError("AUTH", "unknown or revoked board token");
        }
        return appendBoardMessage(state, { kind: "agent", agent }, raw, new Date().toISOString());
      }),
    );
  }

  /** Append one message as the human (the human route, under the shared bearer). */
  async postBoardAsHuman(raw: unknown): Promise<BoardAppendResponse> {
    return this.boardOutcome(() =>
      this.appendToBoard((state) => appendBoardMessage(state, { kind: "human" }, raw, new Date().toISOString())),
    );
  }

  /**
   * Record an integration result on the board: the engine appends the next
   * integrated.rev, deriving its paths and contributors from the announced
   * pushes it merged. This is the only way an integrated revision reaches the
   * board, so the board can never report a pass the integrator did not record.
   */
  async recordBoardIntegration(input: unknown): Promise<BoardAppendResponse> {
    return this.boardOutcome(() =>
      this.appendToBoard((state) => appendIntegratedRev(state, input, new Date().toISOString())),
    );
  }

  /**
   * Record an ADVISORY typed decision and its outcome on the board (the
   * operator's route): the engine appends decision.recorded. It never affects
   * arbitration or the verdict.
   */
  async recordBoardDecision(input: unknown): Promise<BoardAppendResponse> {
    return this.boardOutcome(() =>
      this.appendToBoard((state) => appendDecisionRecorded(state, input, new Date().toISOString())),
    );
  }

  /**
   * Record a seam item STALLED (the operator's route, when the board went
   * quiet while it held dependents): the engine appends seam.stalled, which
   * ends its hold and, with no push of its owner's, releases it.
   */
  async recordSeamStalled(input: unknown): Promise<BoardAppendResponse> {
    return this.boardOutcome(() => this.appendToBoard((state) => appendSeamStalled(state, input, new Date().toISOString())));
  }

  /**
   * Record an engine fact only the operator side observes (the engine-record
   * route, `{type, payload}`): validated against the board, then appended.
   */
  async recordEngine(input: unknown): Promise<BoardAppendResponse> {
    return this.boardOutcome(() => this.appendToBoard((state) => appendEngineRecord(state, input, new Date().toISOString())));
  }

  /**
   * Record a tool's OWN gate result (the operator's route, after it ran the
   * gate on the latest build): the engine appends tool.gated, and on a pass
   * tool.published and the tool item's completion. Agents cannot post it.
   */
  async recordToolGate(input: unknown): Promise<BoardAppendResponse> {
    return this.boardOutcome(() => this.appendToBoard((state) => appendToolGated(state, input, new Date().toISOString())));
  }

  /**
   * Record a run of a PINNED, published tool version the operator's runtime
   * executed in a consumer's own repo: the engine appends tool.used. Agents
   * cannot post a use.
   */
  async recordToolUse(input: unknown): Promise<BoardAppendResponse> {
    return this.boardOutcome(() => this.appendToBoard((state) => appendToolUsed(state, input, new Date().toISOString())));
  }

  /** The Change's tools repo, once provisioned (one per Change). */
  async getToolsRepo(): Promise<ToolsRepoRecord | undefined> {
    return this.ctx.storage.get<ToolsRepoRecord>("toolsRepo");
  }

  /** Remember the Change's tools repo (provisioned once, on the first tool build). */
  async recordToolsRepo(repo: ToolsRepoRecord): Promise<void> {
    await this.ctx.storage.put("toolsRepo", repo);
  }

  // -------------------------------------------------------------------------
  // Integration on Cloudflare: the configuration a run posts, the Workflow's
  // bookkeeping (one Workflow at a time per Change; pushes that land while it
  // runs are coalesced into its next iteration), and every revision attempt.
  // -------------------------------------------------------------------------

  /**
   * Configure integration on Cloudflare for this Change (the run's bearer
   * route). The configuration carries the gate command, the contract, and the
   * baseline test inventory, so it is part of the goal-time record: it is
   * accepted once, BEFORE the goal is posted, and fixed from then on (a later
   * change, for example a gate command of `true`, is refused).
   */
  async configureCloudIntegration(raw: unknown): Promise<{ readonly ok: true; readonly config: Record<string, unknown> } | BoardFailure> {
    const parsed = parseCloudIntegrationConfig(raw, new Date().toISOString());
    if (!parsed.ok) {
      return { ok: false, code: "BAD_PAYLOAD", error: parsed.error };
    }
    return this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get<CloudIntegrationConfig>("cloudIntegrationConfig")) !== undefined) {
        return { ok: false as const, code: "INVALID_STATE", error: "the integration configuration is fixed once set (it is part of the goal-time record)" };
      }
      if (((await txn.get<BoardState>("boardState")) ?? emptyBoard()).goal !== null) {
        return { ok: false as const, code: "INVALID_STATE", error: "the integration configuration must be set before the goal is posted; it is fixed at goal time" };
      }
      await txn.put("cloudIntegrationConfig", parsed.value);
      return { ok: true as const, config: publicConfig(parsed.value) };
    });
  }

  /** The configured integration repo (for the token routes), if any. */
  async getCloudIntegrationRepo(): Promise<BoardRepoRecord | undefined> {
    return (await this.ctx.storage.get<CloudIntegrationConfig>("cloudIntegrationConfig"))?.integration;
  }

  /** The open view: configuration (no inventory names), the Workflow, every attempt. */
  async getCloudIntegration(): Promise<CloudIntegrationView> {
    const config = await this.ctx.storage.get<CloudIntegrationConfig>("cloudIntegrationConfig");
    const run = (await this.ctx.storage.get<CloudIntegrationRun>("cloudIntegrationRun")) ?? { kicked: false, counter: 0 };
    const revisions = (await this.ctx.storage.get<CloudRevisionRecord[]>("cloudRevisions")) ?? [];
    return {
      configured: config !== undefined,
      ...(config ? { config: publicConfig(config) } : {}),
      ...(run.active ? { active: run.active } : {}),
      kicked: run.kicked,
      ...(await this.pendingAttribution().then((p) => (p && !p.answer ? { pendingAttribution: p.request } : {}))),
      revisions,
    };
  }

  /**
   * Ask for an integration (a push was announced, or the run kicked): start a
   * Workflow when none is active, else mark the active one to look again.
   */
  async requestCloudIntegration(): Promise<CloudIntegrationRequest> {
    if ((await this.ctx.storage.get<CloudIntegrationConfig>("cloudIntegrationConfig")) === undefined) {
      return { start: false, reason: "integration on Cloudflare is not configured for this Change" };
    }
    return this.ctx.storage.transaction(async (txn) => {
      const run = (await txn.get<CloudIntegrationRun>("cloudIntegrationRun")) ?? { kicked: false, counter: 0 };
      if (run.active) {
        await txn.put("cloudIntegrationRun", { ...run, kicked: true });
        return { start: false, coalesced: true, activeInstance: run.active.instanceId };
      }
      const counter = run.counter + 1;
      const change = await txn.get<Change>("change");
      const base = (change?.id ?? "change").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
      const instanceId = `${base}-int-${counter}-${Date.now().toString(36)}`;
      await txn.put("cloudIntegrationRun", { active: { instanceId, startedAt: new Date().toISOString() }, kicked: false, counter });
      return { start: true, instanceId };
    });
  }

  /** Forget an active Workflow that never started or has ended without finishing. */
  async clearCloudIntegration(instanceId: string): Promise<void> {
    const run = (await this.ctx.storage.get<CloudIntegrationRun>("cloudIntegrationRun")) ?? { kicked: false, counter: 0 };
    if (run.active?.instanceId === instanceId) {
      const { active: _gone, ...rest } = run;
      await this.ctx.storage.put("cloudIntegrationRun", rest);
    }
  }

  /** The Workflow is out of work: done (clear it), or again when a push landed meanwhile. */
  async finishCloudIntegration(instanceId: string, options: { readonly force?: boolean } = {}): Promise<{ readonly again: boolean }> {
    return this.ctx.storage.transaction(async (txn) => {
      const run = (await txn.get<CloudIntegrationRun>("cloudIntegrationRun")) ?? { kicked: false, counter: 0 };
      if (run.active?.instanceId !== instanceId) {
        return { again: false };
      }
      if (run.kicked && !options.force) {
        await txn.put("cloudIntegrationRun", { ...run, kicked: false });
        return { again: true };
      }
      const { active: _done, ...rest } = run;
      await txn.put("cloudIntegrationRun", rest);
      return { again: false };
    });
  }

  /** Plan the next revision's job from the board (idle when nothing new is pending). */
  async planCloudIntegration(): Promise<CloudPlanOutcome & { readonly deadlineMs?: number; readonly registryHost?: string; readonly integration?: BoardRepoRecord }> {
    const config = await this.ctx.storage.get<CloudIntegrationConfig>("cloudIntegrationConfig");
    if (config === undefined) {
      return { kind: "idle", reason: "integration on Cloudflare is not configured for this Change", pendingKey: "" };
    }
    const lastSeq = (await this.ctx.storage.get<number>("boardSeq")) ?? 0;
    const messages = await this.readBoardMessages(0, Number.MAX_SAFE_INTEGER, lastSeq);
    const state = await this.loadBoardState();
    if (state.goal === null) {
      return { kind: "idle", reason: "the board has no goal yet", pendingKey: "" };
    }
    const change = await this.ctx.storage.get<Change>("change");
    const revisions = (await this.ctx.storage.get<CloudRevisionRecord[]>("cloudRevisions")) ?? [];
    const outcome = await planCloudJob({
      changeId: change?.id ?? "change",
      objective: state.goal?.objective ?? change?.objective ?? "",
      config,
      messages,
      state,
      repos: (await this.ctx.storage.get<Record<string, BoardRepoRecord>>("boardRepos")) ?? {},
      // A transient failure does not count: the same pushes may be tried again.
      attempted: (key) => revisions.some((r) => r.key === key && !r.transient),
    });
    return outcome.kind === "job"
      ? { ...outcome, deadlineMs: jobDeadlineMs(config), registryHost: config.registryHost, integration: config.integration }
      : outcome;
  }

  /**
   * Record a job's outcome: on the board through the same append path as the
   * integration revision route (appendIntegratedRev), and in the attempts.
   * Idempotent by the job key (a Workflow step that re-runs gets the record).
   */
  async recordCloudRevision(input: {
    readonly plan: CloudJobPlan;
    readonly result?: IntegrateJobResult;
    readonly error?: string;
    readonly phases: readonly DrivenPhase[];
    readonly transient?: boolean;
  }): Promise<CloudRevisionRecord> {
    const revisions = (await this.ctx.storage.get<CloudRevisionRecord[]>("cloudRevisions")) ?? [];
    const prior = revisions.find((r) => r.key === input.plan.key && !r.transient);
    if (prior) {
      return prior;
    }
    const at = new Date().toISOString();
    const base = { key: input.plan.key, pendingKey: input.plan.pendingKey, at, phases: input.phases };
    let record: CloudRevisionRecord;
    if (input.result === undefined || input.transient) {
      record = { ...base, recorded: false, transient: true, reason: input.error ?? "the job did not run", excludedAgents: input.plan.excludedAgents };
    } else {
      const result = input.result;
      const extras = {
        ...(result.install ? { install: result.install } : {}),
        ...(result.inventory ? { inventory: result.inventory } : {}),
        ...(result.inventoryNote ? { inventoryNote: result.inventoryNote } : {}),
        ...(result.sandboxReaped ? { sandboxReaped: result.sandboxReaped } : {}),
        ...(result.evidence ? { evidence: result.evidence } : {}),
      };
      const pending = await this.pendingAttribution();
      const driver: DriverAttribution | undefined = pending?.request.key === input.plan.key && pending.answer ? { key: pending.request.key, items: pending.answer } : undefined;
      const decision = decideCloudRevision(input.plan, result, await this.loadBoardState(), driver);
      if (decision.kind === "refuse") {
        record = { ...base, ...extras, recorded: false, reason: decision.reason, ...(decision.stale ? { stale: true } : {}), excludedAgents: decision.excludedAgents };
      } else {
        // A lost response: the board may already hold this exact revision.
        const lastSeq = (await this.ctx.storage.get<number>("boardSeq")) ?? 0;
        const already = (await this.readBoardMessages(0, Number.MAX_SAFE_INTEGER, lastSeq)).find(
          (m) => m.type === "integrated.rev" && m.payload.commit === decision.input.commit && m.payload.merged.join(",") === decision.input.merged.join(","),
        );
        let appended: readonly BoardMessage[] = already ? [already] : [];
        let refusal: string | undefined;
        if (!already) {
          const outcome = await this.recordBoardIntegration(decision.input);
          if (outcome.ok) {
            appended = outcome.appended;
          } else {
            refusal = `the board refused the revision (${outcome.code}): ${outcome.error}`;
          }
        }
        const rev = appended.find((m) => m.type === "integrated.rev");
        record =
          refusal !== undefined || !rev || rev.type !== "integrated.rev"
            ? { ...base, ...extras, recorded: false, reason: refusal ?? "the board recorded no revision", excludedAgents: decision.excludedAgents }
            : {
                ...base,
                ...extras,
                recorded: true,
                n: rev.payload.n,
                gate: decision.input.gate,
                gated: decision.input.gated !== false,
                commit: decision.input.commit,
                merged: decision.input.merged,
                integratedItems: decision.integratedItems,
                excludedItems: decision.excludedItems,
                excludedAgents: decision.excludedAgents,
                completedItems: appended.flatMap((m) => (m.type === "item.completed" ? [m.payload.item] : [])),
                ...(decision.implicated ? { implicated: decision.implicated } : {}),
                ...(decision.parsed ? { parsed: decision.parsed } : {}),
                ...(decision.failure !== undefined ? { failure: decision.failure } : {}),
                ...(decision.input.gate === "fail"
                  ? {
                      fixRequested: appended.flatMap((m) => (m.type === "fix.requested" ? [m.payload.item] : [])),
                      fixExhausted: appended.flatMap((m) => (m.type === "fix.exhausted" ? [m.payload.item] : [])),
                    }
                  : {}),
              };
      }
    }
    // Keep the attempts bounded (the board keeps the revisions themselves).
    const kept = [...revisions.filter((r) => r.key !== record.key || !r.transient), record].slice(-CLOUD_REVISIONS_KEPT);
    await this.ctx.storage.put("cloudRevisions", kept);
    return record;
  }

  /**
   * A failing result is about to be recorded: when the run attributes
   * (`attribution: "driver"`), store what it is asked and tell the Workflow
   * to wait (bounded) for its answer. Idempotent by the job key.
   */
  async requestCloudAttribution(plan: CloudJobPlan, result: IntegrateJobResult): Promise<{ readonly waiting: boolean }> {
    const config = await this.ctx.storage.get<CloudIntegrationConfig>("cloudIntegrationConfig");
    if (config?.attribution !== "driver") {
      return { waiting: false };
    }
    const prior = await this.pendingAttribution();
    if (prior?.request.key === plan.key) {
      return { waiting: prior.answer === undefined };
    }
    const request = attributionRequestFor(plan, result, new Date().toISOString());
    if (!request) {
      return { waiting: false };
    }
    await this.ctx.storage.put("cloudAttribution", { request } satisfies PendingAttribution);
    return { waiting: true };
  }

  /**
   * The run's advisory attribution for the pending failing revision: the items
   * it implicates (each must be one the revision merged; none = no confident
   * choice, record with the parse alone). Returns the active Workflow instance
   * to wake.
   */
  async answerCloudAttribution(raw: unknown): Promise<{ readonly ok: true; readonly instanceId?: string } | BoardFailure> {
    const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const pending = await this.pendingAttribution();
    if (!pending || typeof body.key !== "string" || body.key !== pending.request.key) {
      return { ok: false, code: "UNKNOWN_REF", error: "no attribution is pending for that key" };
    }
    if (pending.answer !== undefined) {
      return { ok: false, code: "DUPLICATE", error: "this attribution was already answered" };
    }
    const ids = pending.request.items.map((i) => i.id);
    if (!Array.isArray(body.items) || !body.items.every((i) => typeof i === "string" && ids.includes(i))) {
      return { ok: false, code: "BAD_PAYLOAD", error: "items must name items the failing revision merged" };
    }
    await this.ctx.storage.put("cloudAttribution", { ...pending, answer: [...new Set(body.items as string[])] } satisfies PendingAttribution);
    const run = await this.ctx.storage.get<CloudIntegrationRun>("cloudIntegrationRun");
    return { ok: true, ...(run?.active ? { instanceId: run.active.instanceId } : {}) };
  }

  private async pendingAttribution(): Promise<PendingAttribution | undefined> {
    return this.ctx.storage.get<PendingAttribution>("cloudAttribution");
  }

  /** Record whether the integration branch was advanced to a recorded passing revision. */
  async recordCloudAdvance(key: string, outcome: { readonly advanced: boolean; readonly error?: string }): Promise<void> {
    const revisions = (await this.ctx.storage.get<CloudRevisionRecord[]>("cloudRevisions")) ?? [];
    await this.ctx.storage.put(
      "cloudRevisions",
      revisions.map((r) => (r.key === key && r.recorded ? { ...r, advanced: outcome.advanced, ...(outcome.error ? { advanceError: outcome.error } : {}) } : r)),
    );
  }

  /** The board messages after `after` (one page) and the reduced board state. */
  async getBoard(after = 0, limit = BOARD_PAGE_DEFAULT): Promise<BoardView> {
    const lastSeq = (await this.ctx.storage.get<number>("boardSeq")) ?? 0;
    const messages = await this.readBoardMessages(after, limit, lastSeq);
    const last = messages.at(-1)?.seq ?? after;
    return { lastSeq, messages, hasMore: last < lastSeq, state: await this.loadBoardState() };
  }

  /**
   * One agent's compact digest of the board since `after`, for its next turn.
   * The board token must identify that agent.
   */
  async getBoardDigest(
    token: string,
    agent: string,
    after = 0,
    limit = BOARD_PAGE_DEFAULT,
  ): Promise<{ readonly ok: true; readonly digest: BoardDigest; readonly hasMore: boolean } | BoardFailure> {
    const tokens = (await this.ctx.storage.get<Record<string, string>>("boardTokens")) ?? {};
    if (tokens[await hashBoardToken(token)] !== agent) {
      return { ok: false, code: "AUTH", error: `the board token does not identify ${agent}` };
    }
    const view = await this.getBoard(after, limit);
    return { ok: true, digest: boardDigest(view.state, view.messages, agent, after), hasMore: view.hasMore };
  }

  /** Re-verify the stored board: its log must reduce to exactly the stored state. */
  async verifyStoredBoard(): Promise<{ readonly ok: true; readonly lastSeq: number } | BoardFailure> {
    const lastSeq = (await this.ctx.storage.get<number>("boardSeq")) ?? 0;
    const messages = await this.readBoardMessages(0, Number.MAX_SAFE_INTEGER, lastSeq);
    try {
      verifyBoard(messages, await this.loadBoardState());
      return { ok: true, lastSeq };
    } catch (error) {
      if (error instanceof BoardError) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
  }

  /** Read messages (after, after + limit] up to lastSeq with one range listing. */
  private async readBoardMessages(after: number, limit: number, lastSeq: number): Promise<BoardMessage[]> {
    const from = Math.max(0, Math.floor(after)) + 1;
    const to = Math.min(lastSeq, from - 1 + Math.max(1, Math.floor(limit)));
    if (to < from) {
      return [];
    }
    const listed = await this.ctx.storage.list<BoardMessage>({
      prefix: BOARD_KEY_PREFIX,
      start: boardMessageKey(from),
      end: boardMessageKey(to + 1),
    });
    const messages = [...listed.values()];
    if (messages.length !== to - from + 1) {
      throw new Error(`board messages ${from}..${to} are incomplete in storage`);
    }
    return messages;
  }

  /**
   * Every lease still outstanding on this Change: kickoff leases (a recorded
   * lease is released on completion/failure, so any remaining one is live) and
   * round-N agents still running (a completed/failed round agent already had its
   * token revoked). Empty for a fresh object.
   */
  private async outstandingLeases(): Promise<SupersededLease[]> {
    if ((await this.ctx.storage.get<Change>("change")) === undefined) {
      return [];
    }
    const out: SupersededLease[] = [];
    for (const lease of Object.values(await this.loadLeases())) {
      out.push({ unitId: lease.unitId, workspaceName: lease.workspaceName, tokenId: lease.tokenId });
    }
    for (const agent of Object.values(await this.loadRoundAgents())) {
      if (agent.status === "running") {
        out.push({
          unitId: agent.unitId,
          round: agent.round,
          workspaceName: agent.workspace.workspaceName,
          tokenId: agent.workspace.tokenId,
        });
      }
    }
    // The write tokens board joins provisioned with the agents' repos (only
    // their ids are stored): a re-created Change revokes them like a lease.
    const repos = (await this.ctx.storage.get<Record<string, BoardRepoRecord>>("boardRepos")) ?? {};
    for (const [agent, repo] of Object.entries(repos)) {
      if (repo.tokenId !== undefined && repo.tokenId !== "") {
        out.push({ unitId: `board:${agent}`, workspaceName: repo.workspaceName, tokenId: repo.tokenId });
      }
    }
    return out;
  }

  /**
   * Record the AUTHORITATIVE whole-change integration verdict: the outcome of
   * the final integration gate on the exact integrated tree. The run posts this
   * once, after that gate ran; a later post replaces it (latest wins). It is the
   * sole source of truth for the goal node's verified/failed state.
   */
  async recordIntegration(input: Omit<IntegrationRecord, "at">): Promise<IntegrationRecord> {
    const stored: IntegrationRecord = {
      verdict: input.verdict,
      integratedUnits: [...input.integratedUnits],
      excludedUnits: [...input.excludedUnits],
      ...(input.gated === false ? { gated: false as const } : {}),
      at: new Date().toISOString(),
    };
    await this.ctx.storage.put("integration", stored);
    return stored;
  }

  /**
   * Set the min/max concurrency dial for this Change. Normalized so a bad config
   * cannot stall or over-recruit. Returns the dial actually in force.
   */
  async configureDial(dial: Partial<ConcurrencyDial> | undefined): Promise<ConcurrencyDial> {
    const normalized = normalizeDial(dial);
    await this.ctx.storage.put("dial", normalized);
    return normalized;
  }

  /** Read the dial currently in force. */
  async getDial(): Promise<ConcurrencyDial> {
    return this.loadDial();
  }

  /** The inspectable recruitment-event log (why each wave was recruited). */
  async getRecruitments(): Promise<readonly RecruitmentEvent[]> {
    return this.loadRecruitments();
  }

  /** The write-lease coordination plan (one owner per contested path). */
  async getLeasePlan(): Promise<LeasePlan> {
    return this.loadLeasePlan();
  }

  /** All escalations recorded for this Change (pending and resolved). */
  async getEscalations(): Promise<readonly Escalation[]> {
    return this.loadEscalations();
  }

  /**
   * Raise a human escalation for a fork mechanical evidence cannot settle. The
   * engine records it and waits (a durable record, not a sleep) for a human
   * decision. Raising the same fork twice is idempotent: an existing pending
   * escalation for the same (kind, unitId, path) is returned rather than
   * duplicated, so a resumed or re-driven engine does not pile up escalations.
   * A unit-scoped escalation must name a WorkUnit that exists in the Change.
   */
  async raiseEscalation(input: RaiseEscalationInput): Promise<Escalation> {
    const change = await this.loadChange();
    if (input.unitId && !change.work.some((u) => u.id === input.unitId)) {
      throw new Error(`unknown WorkUnit for escalation: ${input.unitId}`);
    }
    const escalations = await this.loadEscalations();
    const existing = escalations.find(
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
      id: `esc-${escalations.length + 1}-${Date.now().toString(36)}`,
      kind: input.kind,
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.boardContest !== undefined ? { boardContest: input.boardContest } : {}),
      question: input.question,
      options: input.options ?? [],
      status: "pending",
      raisedAt: new Date().toISOString(),
    };
    escalations.push(escalation);
    await this.ctx.storage.put("escalations", escalations);
    return escalation;
  }

  /**
   * Resolve a pending escalation with the human's decision. This is the input
   * that ends the durable wait and lets the graph advance past the fork.
   * Resolving an unknown or already-resolved escalation is rejected so a
   * decision is never silently lost.
   */
  async resolveEscalation(id: string, decision: string): Promise<Escalation> {
    const escalations = await this.loadEscalations();
    const index = escalations.findIndex((e) => e.id === id);
    if (index === -1) {
      throw new Error(`unknown escalation: ${id}`);
    }
    const current = escalations[index] as Escalation;
    if (current.status === "resolved") {
      throw new Error(`escalation already resolved: ${id}`);
    }
    const resolved: Escalation = {
      ...current,
      status: "resolved",
      decision,
      resolvedAt: new Date().toISOString(),
    };
    // An escalation raised for a board contest is answered ON the board: the
    // decision must name one of the contest's parties and is appended as a
    // human claim.resolved. The escalation record and the board messages are
    // written in ONE transaction, so an invalid decision (or any rejected
    // append) leaves both untouched, and a recorded decision always reached
    // the board.
    if (current.boardContest !== undefined || current.boardContract !== undefined) {
      const contest = current.boardContest;
      const contract = current.boardContract;
      try {
        await this.appendToBoard(
          (state) => {
            const draft =
              contest !== undefined ? boardResolutionForDecision(state, contest, decision) : boardContractDecision(state, contract!, decision);
            return draft === undefined
              ? { appended: [], state }
              : appendBoardMessage(state, { kind: "human" }, draft, new Date().toISOString());
          },
          { escalations: (list) => list.map((e) => (e.id === id ? resolved : e)) },
        );
      } catch (error) {
        throw new Error(errorText(error));
      }
      return resolved;
    }
    escalations[index] = resolved;
    await this.ctx.storage.put("escalations", escalations);
    // A resolved lease-owner decision is AUTHORITATIVE for its path: recompute
    // and persist the write-lease plan so the stored plan (and the lease edges
    // the console draws from it) name the human-chosen owner. An invalid
    // decision (not a contender) is rejected by the planner, which keeps the
    // deterministic owner and records why on the decision.
    if (resolved.kind === "lease-owner") {
      const change = await this.loadChange();
      await this.ctx.storage.put("leasePlan", await this.computeLeasePlan(change));
    }
    return resolved;
  }

  /**
   * Whether this Change has a pending escalation (optionally for a specific
   * WorkUnit). The engine checks this before advancing a fork: a pending
   * escalation is a hard, durable wait, so the engine does not self-certify past
   * it. This is the "wait" half of the escalation beat, read from durable state.
   */
  async hasPendingEscalation(unitId?: string): Promise<boolean> {
    const escalations = await this.loadEscalations();
    return escalations.some(
      (e) => e.status === "pending" && (unitId === undefined || e.unitId === unitId),
    );
  }

  /**
   * Record the agent-built tool published for this Change. The builder unit must
   * exist in the Change (a tool node is backed by a real builder/workspace), so
   * recording a tool for an unknown builder is rejected rather than producing a
   * decorative node.
   */
  async recordTool(tool: ToolRecord): Promise<ToolRecord> {
    const change = await this.loadChange();
    if (!change.work.some((u) => u.id === tool.builderUnitId)) {
      throw new Error(`unknown tool builder WorkUnit: ${tool.builderUnitId}`);
    }
    await this.ctx.storage.put("tool", tool);
    return tool;
  }

  /**
   * Record that a downstream WorkUnit actually consumed (ran) the agent-built
   * tool. Rejected if no tool is recorded or the consumer is not a WorkUnit, so
   * a consumed-tool edge always maps to a real consumption by a real unit.
   */
  async recordToolConsumption(
    consumption: Omit<ToolConsumption, "at">,
  ): Promise<ToolConsumption> {
    const change = await this.loadChange();
    const tool = await this.loadTool();
    if (!tool) {
      throw new Error("no agent-built tool recorded for this Change");
    }
    if (!change.work.some((u) => u.id === consumption.consumerUnitId)) {
      throw new Error(`unknown consumer WorkUnit: ${consumption.consumerUnitId}`);
    }
    const stored: ToolConsumption = { ...consumption, at: new Date().toISOString() };
    const list = await this.loadToolConsumptions();
    list.push(stored);
    await this.ctx.storage.put("toolConsumptions", list);
    return stored;
  }

  /**
   * Compute the recruitment plan for the next wave: the runnable units the dial
   * currently allows an agent to be recruited for, given how many agents are
   * already in flight. This is the single policy decision; it recruits a bounded
   * window over the runnable set, never a hardcoded count and never one agent
   * per named unit. Raising the dial max widens this window through the shared
   * `recruit` policy with no other change.
   */
  async planRecruitment(): Promise<RecruitmentPlan> {
    const change = await this.loadChange();
    const completed = await this.loadCompleted();
    const leases = await this.loadLeases();
    const dial = await this.loadDial();
    const failed = await this.loadFailed();
    // In flight = runnable units an agent currently holds a lease on.
    const runnable = runnableUnits(change, completed);
    // Agents still running: leased but not yet completed. The DO releases a
    // lease on completion, so this normally equals the lease count; filtering by
    // completed keeps the ceiling correct even if a completed lease is retained.
    const completedSet = new Set(completed);
    const inFlight = Object.keys(leases).filter((id) => !completedSet.has(id)).length;
    // Only recruit for units that are runnable AND not already leased AND not
    // already failed. A failed unit is terminal-for-that-unit: it has released
    // its lease, so without this filter it would read as open-runnable again and
    // the wave would re-recruit a unit that already failed. Excluding it lets the
    // rest of the open runnable set advance while the failed unit stays failed.
    const openRunnable = runnable.filter((id) => !leases[id] && !failed[id]);
    const decision = recruit({ runnable: openRunnable, inFlight, dial });
    return { ...decision, inFlight, dial, runnable: openRunnable };
  }

  /**
   * Record a lease for a runnable WorkUnit against an already-provisioned
   * workspace. Rejects if the unit is not currently runnable or already leased.
   */
  async recordLease(unitId: string, workspace: LeaseWorkspace): Promise<LeaseRecord> {
    const change = await this.loadChange();
    const unit = change.work.find((u) => u.id === unitId);
    if (!unit) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const completed = await this.loadCompleted();
    const runnable = runnableUnits(change, completed);
    if (!runnable.includes(unitId)) {
      throw new Error(`WorkUnit is not runnable: ${unitId}`);
    }
    const leases = await this.loadLeases();
    if (leases[unitId]) {
      throw new Error(`WorkUnit already leased: ${unitId}`);
    }
    const record: LeaseRecord = {
      unitId,
      objective: unit.objective,
      paths: unit.paths,
      baselineRef: change.baseline,
      leasedAt: new Date().toISOString(),
      ...workspace,
    };
    leases[unitId] = record;
    await this.ctx.storage.put("leases", leases);
    // Record the backend workspace name so a repo-pushed event (which carries
    // the workspace, not the WorkUnit) can resolve which unit just finished.
    const workspaceUnits = await this.loadWorkspaceUnits();
    workspaceUnits[workspace.workspaceName] = unitId;
    await this.ctx.storage.put("workspaceUnits", workspaceUnits);
    // Record this unit's real workspace (Artifact repo) identity so the state
    // projection can reveal it when the node is clicked, and keep it past
    // completion. Only the token id is kept, never the plaintext token.
    const workspaces = await this.loadWorkspaces();
    workspaces[unitId] = {
      workspaceId: record.workspaceId,
      workspaceName: record.workspaceName,
      gitUrl: record.gitUrl,
      defaultBranch: record.defaultBranch,
      backend: record.backend,
      fallback: record.fallback,
      tokenId: record.tokenId,
      tokenExpiresAt: record.tokenExpiresAt,
      leasedAt: record.leasedAt,
    };
    await this.ctx.storage.put("workspaces", workspaces);
    return record;
  }

  /**
   * Append a recruitment event to the inspectable log. Used by the Worker after
   * it has provisioned and recorded leases for a recruited wave, so the log
   * explains why each wave ran and what triggered it.
   */
  async recordRecruitment(event: Omit<RecruitmentEvent, "at">): Promise<RecruitmentEvent> {
    const events = await this.loadRecruitments();
    const stored: RecruitmentEvent = { ...event, at: new Date().toISOString() };
    events.push(stored);
    await this.ctx.storage.put("recruitments", events);
    return stored;
  }

  /**
   * Ingest a real (or deterministically faked) repo-pushed event: the push a
   * runner makes when it finishes a WorkUnit. This is the event-driven trigger
   * for the next recruitment wave. It:
   *   1. resolves the pushed workspace to the WorkUnit it leased;
   *   2. marks that unit complete (idempotent: a second event for an
   *      already-complete unit is a no-op), releasing its lease so its
   *      dependents become runnable;
   *   3. computes the next recruitment plan under the dial over the now-wider
   *      runnable set.
   *
   * The returned plan tells the Worker which units to provision workspaces for;
   * the Worker then records those leases and appends the recruitment event. The
   * next wave is therefore driven by this event, never by a poll or a timer.
   */
  async recordRepoPushed(workspaceName: string): Promise<RepoPushedResult> {
    const change = await this.loadChange();
    const workspaceUnits = await this.loadWorkspaceUnits();
    const unitId = workspaceUnits[workspaceName];

    let completedUnit: string | null = null;
    if (unitId && change.work.some((u) => u.id === unitId)) {
      // The push event names the unit it pertains to. markComplete is
      // idempotent, so completing an already-complete unit is a no-op; either
      // way this event drives the next wave, so report the unit the push
      // completed so the recruitment log names it.
      await this.markComplete(unitId, undefined, "runner");
      completedUnit = unitId;
    }

    const plan = await this.planRecruitment();
    const completed = await this.loadCompleted();
    const failed = await this.loadFailed();
    // Done when nothing is left to recruit and every unit has reached a terminal
    // state (completed or failed). A failed unit is terminal, so a run with some
    // failures still finishes instead of waiting for a completed count it can
    // never reach.
    const terminal = completed.length + Object.keys(failed).length;
    const done = terminal >= change.work.length && plan.recruit.length === 0;
    const event: RecruitmentEvent = {
      trigger: "repo-pushed",
      pushedWorkspace: workspaceName,
      completedUnit: completedUnit ?? undefined,
      recruited: plan.recruit,
      ceiling: plan.ceiling,
      inFlightAfter: plan.inFlight + plan.recruit.length,
      at: new Date().toISOString(),
    };
    return {
      completedUnit,
      recruited: plan.recruit,
      done,
      event,
    };
  }

  /** Read the lease currently held for a WorkUnit, if any. */
  async getLease(unitId: string): Promise<LeaseRecord | undefined> {
    const leases = await this.loadLeases();
    return leases[unitId];
  }

  /**
   * Record the live deployment of the fixed app: the clickable workers.dev URL
   * the run deployed as end-of-run proof. The run records this only after
   * verification passed and the deploy succeeded, so the console surfaces a real
   * reachable URL, never a URL for a broken or undeployed app.
   */
  async recordDeployment(deployment: Omit<DeploymentRecord, "at">): Promise<DeploymentRecord> {
    const stored: DeploymentRecord = { ...deployment, at: new Date().toISOString() };
    await this.ctx.storage.put("deployment", stored);
    return stored;
  }

  /** The recorded live deployment for this run, if any. */
  async getDeployment(): Promise<DeploymentRecord | null> {
    return this.loadDeployment();
  }

  /**
   * Record one mechanical CHANGE-LEVEL VERIFY attempt: a single run of the
   * per-app behavioral gate against the integrated change for one ladder round.
   * This is the real backing for a `verify` graph node, so a verify node can
   * only exist once this record does. The gate command and the failing output
   * are bounded and secret-stripped. The verifier is mechanical on every round
   * (base and escalation alike), so this record is the ground-truth verdict,
   * never the model grading itself.
   */
  async recordVerifyAttempt(input: Omit<VerifyAttempt, "at">): Promise<VerifyAttempt> {
    const attempts = await this.loadVerifyAttempts();
    const stored: VerifyAttempt = {
      round: Number.isFinite(input.round) && input.round > 0 ? Math.floor(input.round) : 1,
      outcome: input.outcome === "pass" ? "pass" : "fail",
      model: typeof input.model === "string" ? input.model.slice(0, 120) : "",
      ...(typeof input.gateCommand === "string" && input.gateCommand !== ""
        ? { gateCommand: sanitizeText(input.gateCommand, 500) }
        : {}),
      ...(typeof input.failingOutput === "string" && input.failingOutput !== ""
        ? { failingOutput: sanitizeText(input.failingOutput, MAX_DETAIL_TEXT) }
        : {}),
      ...(Array.isArray(input.implicatedUnits) && input.implicatedUnits.length > 0
        ? { implicatedUnits: input.implicatedUnits.map((u) => String(u)) }
        : {}),
      ...(normalizeRefanSource(input.refanSource)
        ? { refanSource: normalizeRefanSource(input.refanSource)! }
        : {}),
      at: new Date().toISOString(),
    };
    attempts.push(stored);
    await this.ctx.storage.put("verifyAttempts", attempts);
    return stored;
  }

  /**
   * Patch the implicated units and the re-fan source onto the LAST recorded
   * verify attempt for a round (the failing verify that produced a re-fan). The
   * ladder records the failing verify before it computes attribution, then calls
   * this once the resulting re-fan is chosen, so the console detail panel can
   * show WHY that round failed and which units it re-fanned. A patch for a round
   * with no recorded verify attempt is a best-effort no-op.
   */
  async updateVerifyAttempt(input: {
    readonly round: number;
    readonly implicatedUnits?: readonly string[];
    readonly refanSource?: RefanSource;
  }): Promise<void> {
    const attempts = await this.loadVerifyAttempts();
    const round = Number.isFinite(input.round) && input.round > 0 ? Math.floor(input.round) : 1;
    // Patch the LAST attempt for the round (the one that just failed), so a
    // re-run of the same round does not clobber an earlier attempt's record.
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      if (attempts[i]!.round === round) {
        attempts[i] = {
          ...attempts[i]!,
          ...(Array.isArray(input.implicatedUnits) && input.implicatedUnits.length > 0
            ? { implicatedUnits: input.implicatedUnits.map((u) => String(u)) }
            : {}),
          ...(normalizeRefanSource(input.refanSource)
            ? { refanSource: normalizeRefanSource(input.refanSource)! }
            : {}),
        };
        await this.ctx.storage.put("verifyAttempts", attempts);
        return;
      }
    }
  }

  /**
   * Record one CHANGE-LEVEL model-escalation RETRY: after a change-level
   * verify-fail, the ladder re-fanned the implicated units on a stronger model
   * fed the failing evidence. This is the real backing for a `retry` graph node
   * and the `model-escalation` edge. It is wholly separate from the
   * human-escalation `escalated` flag, so recording a retry never lights that
   * flag. Every implicated unit must exist in the Change; the reason is bounded
   * and secret-stripped.
   */
  async recordRetryAttempt(input: Omit<RetryAttempt, "at">): Promise<RetryAttempt> {
    const change = await this.loadChange();
    const implicated = Array.isArray(input.implicatedUnits) ? input.implicatedUnits : [];
    for (const unitId of implicated) {
      if (!change.work.some((unit) => unit.id === unitId)) {
        throw new Error(`unknown implicated WorkUnit: ${unitId}`);
      }
    }
    const attempts = await this.loadRetryAttempts();
    const stored: RetryAttempt = {
      round: Number.isFinite(input.round) && input.round > 1 ? Math.floor(input.round) : 2,
      fromModel: typeof input.fromModel === "string" ? input.fromModel.slice(0, 120) : "",
      toModel: typeof input.toModel === "string" ? input.toModel.slice(0, 120) : "",
      implicatedUnits: implicated.map((u) => String(u)),
      ...(normalizeRefanSource(input.refanSource)
        ? { refanSource: normalizeRefanSource(input.refanSource)! }
        : {}),
      reason: sanitizeReason(input.reason),
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
        ? { rationale: sanitizeText(input.rationale, MAX_DETAIL_TEXT) }
        : {}),
      at: new Date().toISOString(),
    };
    attempts.push(stored);
    await this.ctx.storage.put("retryAttempts", attempts);
    return stored;
  }

  /**
   * Record one Jev typed decision at one juncture (plan-review, attribution, or
   * fix-confidence). This is the real backing for a `jev` graph node, so a jev
   * node can only exist once this record does. The question is bounded and
   * secret-stripped; the typed answer, confidence, and probabilities are stored
   * as reported. A fix-confidence decision is advisory ONLY: recording it never
   * touches the completed/failed/integrated sets, so the mechanical gate and
   * gate-equals-deploy remain authoritative and Jev never flips a verdict.
   */
  async recordJevDecision(input: Omit<JevDecisionView, "at">): Promise<JevDecisionView> {
    const decisions = await this.loadJevDecisions();
    const answerType =
      input.answerType === "choice" || input.answerType === "score" ? input.answerType : "noul";
    const stored: JevDecisionView = {
      juncture: normalizeJuncture(input.juncture),
      question: sanitizeText(typeof input.question === "string" ? input.question : "", 500),
      answerType,
      ...(answerType === "noul" && (input.noul === "yes" || input.noul === "no" || input.noul === "unsure")
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
    decisions.push(stored);
    await this.ctx.storage.put("jevDecisions", decisions);
    return stored;
  }

  /**
   * Record (or re-lease) a round-N agent instance for a retry round, keyed by
   * (unitId, round), against an already-provisioned round-N workspace. This is
   * the round-N parallel of recordLease: a retry round's re-fanned unit is a
   * BRAND NEW agent that spawns and tracks state exactly like a kickoff agent,
   * so leasing it records its OWN real Artifact repo and sets its status to
   * "running" (the lifecycle start). The unit must exist in the Change; the
   * plaintext token is never stored (only the token id). Re-leasing the same
   * (unitId, round) overwrites the workspace and resets the status to running so
   * a re-driven round is idempotent.
   */
  async recordRoundLease(
    unitId: string,
    round: number,
    workspace: LeaseWorkspace,
  ): Promise<RoundAgentView> {
    const change = await this.loadChange();
    if (!change.work.some((unit) => unit.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const roundAgents = await this.loadRoundAgents();
    const key = roundAgentKey(unitId, round);
    const identity: WorkspaceIdentity = {
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      gitUrl: workspace.gitUrl,
      defaultBranch: workspace.defaultBranch,
      backend: workspace.backend,
      fallback: workspace.fallback,
      tokenId: workspace.tokenId,
      tokenExpiresAt: workspace.tokenExpiresAt,
      leasedAt: new Date().toISOString(),
    };
    const previous = roundAgents[key];
    const stored: RoundAgentView = {
      unitId,
      round: normalizeRound(round),
      workspace: identity,
      status: "running",
      ...(previous?.activity ? { activity: previous.activity } : {}),
      ...(previous?.detail ? { detail: previous.detail } : {}),
    };
    roundAgents[key] = stored;
    await this.ctx.storage.put("roundAgents", roundAgents);
    return stored;
  }

  /**
   * Record one ordered real run step for a round-N agent instance, keyed by
   * (unitId, round). The round-N parallel of recordStep: a retry round's agent
   * reports its real steps (leased, cloning, model-call, applied-edit, commit,
   * push, pushed, failed) exactly like a kickoff agent, so the console's per-node
   * activity log for the round-N instance is backed by real steps. The round-N
   * agent must have been leased first; the message is bounded and secret-stripped.
   */
  async recordRoundStep(
    unitId: string,
    round: number,
    phase: string,
    message: string,
  ): Promise<ActivityStep> {
    const roundAgents = await this.loadRoundAgents();
    const key = roundAgentKey(unitId, round);
    const agent = roundAgents[key];
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    const step: ActivityStep = {
      phase: boundedPhase(phase),
      message: sanitizeReason(message),
      at: new Date().toISOString(),
    };
    const list = [...(agent.activity ?? []), step];
    const bounded = list.length > MAX_ACTIVITY_STEPS ? list.slice(-MAX_ACTIVITY_STEPS) : list;
    roundAgents[key] = { ...agent, activity: bounded };
    await this.ctx.storage.put("roundAgents", roundAgents);
    return step;
  }

  /**
   * Record (merge) the rich per-unit detail for a round-N agent instance, keyed
   * by (unitId, round). The round-N parallel of recordDetail: a retry round's
   * agent reports its model id, edited paths, diff, commit message, prompt
   * summary, and token usage exactly like a kickoff agent, so the console's
   * click-detail for the round-N instance reads real recorded detail. The round-N
   * agent must have been leased first; every field is bounded and secret-stripped.
   */
  async recordRoundDetail(
    unitId: string,
    round: number,
    detail: UnitDetail,
  ): Promise<UnitDetail> {
    const roundAgents = await this.loadRoundAgents();
    const key = roundAgentKey(unitId, round);
    const agent = roundAgents[key];
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    const merged: UnitDetail = {
      ...(agent.detail ?? {}),
      ...sanitizeDetail(detail),
      at: new Date().toISOString(),
    };
    roundAgents[key] = { ...agent, detail: merged };
    await this.ctx.storage.put("roundAgents", roundAgents);
    return merged;
  }

  /**
   * Mark a round-N agent instance COMPLETE, keyed by (unitId, round): its retry
   * round produced and pushed an edit. The round-N parallel of markComplete: it
   * walks the round-N instance to the terminal "integrated" status, so the graph
   * greens that node exactly like a kickoff agent that integrated. The authority
   * on whether the CHANGE passed is still the change-level gate, so a round-N
   * agent going green individually does NOT mean the change passed. The round-N
   * agent must have been leased first; completing an already-terminal one is a
   * safe no-op.
   */
  async completeRoundAgent(unitId: string, round: number): Promise<RoundAgentView> {
    const roundAgents = await this.loadRoundAgents();
    const key = roundAgentKey(unitId, round);
    const agent = roundAgents[key];
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    if (agent.status === "integrated" || agent.status === "failed") {
      return agent;
    }
    const stored: RoundAgentView = { ...agent, status: "integrated" };
    roundAgents[key] = stored;
    await this.ctx.storage.put("roundAgents", roundAgents);
    return stored;
  }

  /**
   * Mark a round-N agent instance FAILED, keyed by (unitId, round): its retry
   * round's executor errored or produced no usable edit. The round-N parallel of
   * failUnit: it walks the round-N instance to the terminal "failed" status, so
   * the graph reds that node exactly like a kickoff agent that failed. The
   * change-level gate remains the authority on the whole change's pass/fail. The
   * round-N agent must have been leased first; failing an already-terminal one is
   * a safe no-op.
   */
  async failRoundAgent(unitId: string, round: number, reason?: string): Promise<RoundAgentView> {
    const roundAgents = await this.loadRoundAgents();
    const key = roundAgentKey(unitId, round);
    const agent = roundAgents[key];
    if (!agent) {
      throw new Error(`unknown round-N agent: ${unitId} round ${round}`);
    }
    if (agent.status === "integrated" || agent.status === "failed") {
      return agent;
    }
    const list = [
      ...(agent.activity ?? []),
      { phase: "failed", message: sanitizeReason(reason), at: new Date().toISOString() },
    ];
    const bounded = list.length > MAX_ACTIVITY_STEPS ? list.slice(-MAX_ACTIVITY_STEPS) : list;
    const stored: RoundAgentView = { ...agent, status: "failed", activity: bounded };
    roundAgents[key] = stored;
    await this.ctx.storage.put("roundAgents", roundAgents);
    return stored;
  }

  /**
   * Mark a WorkUnit FAILED because its candidate edit did not pass the mechanical
   * per-app gate after the bounded model-escalation ladder. This is the honesty
   * terminal of the ladder: a unit that pushed an edit but whose edit does NOT
   * fix the planted bug must be a real RED node, never greened. Unlike the
   * agent-infra `failUnit` (which treats an already-completed unit as a real
   * success and refuses to override it), a verify-fail is the VERDICT on the
   * pushed edit, so it overrides a prior "pushed/completed" marker: the unit is
   * removed from completed and recorded failed. Verification is the authority on
   * green vs red here, not the mere fact that an agent pushed something.
   */
  async recordVerifyFailure(unitId: string, reason?: string): Promise<ChangeStateView> {
    const change = await this.loadChange();
    if (!change.work.some((unit) => unit.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    // The mechanical verdict overrides a prior pushed/completed marker.
    const completed = await this.loadCompleted();
    const idx = completed.indexOf(unitId);
    if (idx !== -1) {
      completed.splice(idx, 1);
      await this.ctx.storage.put("completed", completed);
    }
    const failed = await this.loadFailed();
    if (!failed[unitId]) {
      failed[unitId] = {
        unitId,
        reason: sanitizeReason(reason ?? "verify failed after the bounded model-escalation ladder"),
        at: new Date().toISOString(),
      };
      await this.ctx.storage.put("failed", failed);
      await this.recordTransition(unitId, "running", "failed", "runner");
    }
    const leases = await this.loadLeases();
    if (leases[unitId]) {
      delete leases[unitId];
      await this.ctx.storage.put("leases", leases);
    }
    return this.view();
  }

  /**
   * Append DISCOVERED follow-up WorkUnits to the live Change. This is the
   * dynamic-branching mechanism: a completing unit reported that fixing one
   * thing revealed more work (follow-up fixes it found in the real repo), so the
   * engine admits those units to the live WorkGraph as real backed units and the
   * next recruitment wave picks them up. The append is validated by the shared
   * change-core guard (the parent must exist, each discovered unit must declare a
   * path, each is rooted under its parent so its node and edge are backed, and
   * ids are namespaced and unique). Already-present ids are skipped so a repeated
   * report is idempotent and a re-driven engine does not pile up duplicates. The
   * augmented Change is persisted along with a recomputed write-lease plan (new
   * units may add path collisions); everything downstream reads the stored
   * Change, so the new units are scheduled, recruited, and projected unchanged.
   */
  async addWorkUnits(
    parentUnitId: string,
    discovered: readonly DiscoveredWorkUnit[],
  ): Promise<readonly string[]> {
    const change = await this.loadChange();
    const existing = new Set(change.work.map((u) => u.id));
    const fresh = discovered.filter(
      (u) =>
        !existing.has(
          `${parentUnitId}+${u.idSuffix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "found"}`,
        ),
    );
    if (fresh.length === 0) {
      return [];
    }
    const { change: newChange, added } = appendDiscoveredUnits(change, parentUnitId, fresh);
    await this.ctx.storage.put("change", newChange);
    // Recompute the write-lease plan: a discovered unit may declare a path that
    // now collides with an existing unit, so the single-owner coordination must
    // reflect the grown graph.
    // Resolved human owner decisions stay authoritative across the regrowth.
    const leasePlan = await this.computeLeasePlan(newChange);
    await this.ctx.storage.put("leasePlan", leasePlan);
    return added.map((u) => u.id);
  }

  /**
   * Record one ordered activity step a runner/agent reported for a WorkUnit: a
   * real step in the run (for example "leased", "cloning", "model", "edit",
   * "commit", "push", "verified", or "failed"). This is the step the ACTUAL run
   * emitted, so the console's per-node activity log is backed by real steps and
   * never synthesized in the UI. The unit must exist in the Change; the message
   * is bounded and secret-stripped before storage. The step is appended in the
   * order it was reported.
   */
  async recordStep(unitId: string, phase: string, message: string): Promise<ActivityStep> {
    const change = await this.loadChange();
    if (!change.work.some((unit) => unit.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const activity = await this.loadActivity();
    const step: ActivityStep = {
      phase: boundedPhase(phase),
      message: sanitizeReason(message),
      at: new Date().toISOString(),
    };
    const list = activity[unitId] ?? [];
    list.push(step);
    // Bound the per-unit log so a long run cannot grow it without limit.
    activity[unitId] = list.length > MAX_ACTIVITY_STEPS ? list.slice(-MAX_ACTIVITY_STEPS) : list;
    await this.ctx.storage.put("activity", activity);
    return step;
  }

  /**
   * Record (merge) the rich per-unit detail a runner reports: a readable prompt
   * summary, the model's proposed edit (changed paths and a readable diff), the
   * model id, the proposed commit message, and token usage / cost when the
   * provider reported it. Merging lets a run fill the detail in pieces (the
   * prompt summary when it calls the model, then the diff and tokens when the
   * reply lands). The unit must exist; the prompt summary and diff are bounded
   * and secret-stripped before storage, so no credential is ever persisted.
   */
  async recordDetail(unitId: string, detail: UnitDetail): Promise<UnitDetail> {
    const change = await this.loadChange();
    if (!change.work.some((unit) => unit.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const all = await this.loadDetail();
    const merged: UnitDetail = {
      ...(all[unitId] ?? {}),
      ...sanitizeDetail(detail),
      at: new Date().toISOString(),
    };
    all[unitId] = merged;
    await this.ctx.storage.put("detail", all);
    return merged;
  }

  /** Record a cost event emitted by a runner (heartbeat or completion). */
  async recordCost(event: Omit<CostEvent, "at">): Promise<ChangeStateView> {
    const change = await this.loadChange();
    if (!change.work.some((u) => u.id === event.unitId)) {
      throw new Error(`unknown WorkUnit: ${event.unitId}`);
    }
    const events = await this.loadCostEvents();
    events.push({ ...event, at: new Date().toISOString() });
    await this.ctx.storage.put("costEvents", events);
    return this.view();
  }

  /**
   * Mark a WorkUnit complete (runner-driven), optionally recording a final cost
   * event, releasing its lease, and advancing dependents to runnable.
   */
  async completeUnit(unitId: string, cost?: Omit<CostEvent, "at" | "unitId">): Promise<ChangeStateView> {
    return this.markComplete(unitId, cost, "runner");
  }

  /**
   * Mark a WorkUnit FAILED (runner-driven): an agent ultimately could not
   * complete it after the executor's bounded retries, or it timed out. This is
   * the fail path that keeps a flaky model call from freezing the whole wave:
   *
   *   - it releases the unit's lease, so the dial no longer counts it as an
   *     in-flight agent and the next runnable units can be recruited;
   *   - it records a durable failure (reason kept, never a secret), so the unit
   *     projects status "failed" and the console lights a distinct node;
   *   - it records a transition for observability.
   *
   * A failed unit is terminal-for-that-unit and NOT added to completed, so its
   * dependents stay blocked (they will never run on a missing prerequisite)
   * while the rest of the open runnable set advances. Idempotent: failing an
   * already-failed or already-completed unit is a safe no-op. A unit that
   * already completed is not overwritten as failed.
   */
  async failUnit(unitId: string, reason?: string): Promise<ChangeStateView> {
    const change = await this.loadChange();
    if (!change.work.some((unit) => unit.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const completed = await this.loadCompleted();
    if (completed.includes(unitId)) {
      // Already integrated: a late failure signal does not undo a real success.
      return this.view();
    }
    const failed = await this.loadFailed();
    if (!failed[unitId]) {
      failed[unitId] = {
        unitId,
        reason: sanitizeReason(reason),
        at: new Date().toISOString(),
      };
      await this.ctx.storage.put("failed", failed);
      await this.recordTransition(unitId, "running", "failed", "runner");
    }
    // Release the lease so the dial frees the slot and recruitment advances.
    const leases = await this.loadLeases();
    if (leases[unitId]) {
      delete leases[unitId];
      await this.ctx.storage.put("leases", leases);
    }
    return this.view();
  }

  /**
   * Advance exactly one scheduling wave from the durable workflow loop: take
   * every currently-runnable WorkUnit, record it running then complete, so its
   * dependents become runnable on the next wave. Idempotent: a unit already
   * complete is skipped, and when the graph is already complete this returns
   * `done` with nothing advanced, so a resumed or re-executed Workflow step can
   * never double-advance or corrupt the graph.
   *
   * This is the deterministic in-process driver for the milestone. It does not
   * provision a workspace or recruit a live agent (that is a later milestone);
   * it advances the WorkGraph state transitions the Workflow is responsible for.
   */
  async advanceWave(): Promise<AdvanceResult> {
    const change = await this.loadChange();
    const completed = await this.loadCompleted();
    const runnable = runnableUnits(change, completed);

    if (runnable.length === 0) {
      // Nothing runnable: either the graph is complete or it is stuck.
      const done = completed.length >= change.work.length;
      return { advanced: 0, units: [], done, completed: [...completed] };
    }

    const advanced: string[] = [];
    for (const unitId of runnable) {
      await this.recordTransition(unitId, "runnable", "running", "workflow");
      await this.markComplete(unitId, undefined, "workflow");
      advanced.push(unitId);
    }

    const nowCompleted = await this.loadCompleted();
    const done = nowCompleted.length >= change.work.length;
    return { advanced: advanced.length, units: advanced, done, completed: nowCompleted };
  }

  /** Shared completion path for both runner and workflow drivers. */
  private async markComplete(
    unitId: string,
    cost: Omit<CostEvent, "at" | "unitId"> | undefined,
    by: Transition["by"],
  ): Promise<ChangeStateView> {
    const change = await this.loadChange();
    if (!change.work.some((unit) => unit.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    if (cost) {
      const events = await this.loadCostEvents();
      events.push({ unitId, at: new Date().toISOString(), ...cost });
      await this.ctx.storage.put("costEvents", events);
    }
    const completed = await this.loadCompleted();
    if (!completed.includes(unitId)) {
      completed.push(unitId);
      await this.ctx.storage.put("completed", completed);
      await this.recordTransition(unitId, "running", "integrated", by);
    }
    const leases = await this.loadLeases();
    if (leases[unitId]) {
      delete leases[unitId];
      await this.ctx.storage.put("leases", leases);
    }
    return this.view();
  }

  /** Append a transition to the durable log. */
  private async recordTransition(
    unitId: string,
    from: WorkUnitStatus,
    to: WorkUnitStatus,
    by: Transition["by"],
  ): Promise<void> {
    const transitions = await this.loadTransitions();
    transitions.push({ unitId, from, to, at: new Date().toISOString(), by });
    await this.ctx.storage.put("transitions", transitions);
  }

  /** Read the live state projection. */
  async getState(): Promise<ChangeStateView> {
    return this.view();
  }

  /** Whether a Change has been created in this object yet. */
  async isInitialized(): Promise<boolean> {
    return (await this.ctx.storage.get<Change>("change")) !== undefined;
  }

  /**
   * Workspace routing (on an instance named for a WORKSPACE, never a Change;
   * see index.ts): remember which Change provisioned the workspace, so a
   * repo-pushed event naming a repo whose name cannot be parsed back (a
   * bounded, hashed name) still reaches its Change.
   */
  async recordWorkspaceRoute(changeId: string): Promise<void> {
    await this.ctx.storage.put("workspaceRoute", changeId);
  }

  /** The Change a workspace was provisioned for, if a route was recorded. */
  async getWorkspaceRoute(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("workspaceRoute");
  }

  private async view(): Promise<ChangeStateView> {
    const change = await this.loadChange();
    const completed = await this.loadCompleted();
    const leases = await this.loadLeases();
    const costEvents = await this.loadCostEvents();
    const transitions = await this.loadTransitions();
    const dial = await this.loadDial();
    const recruitments = await this.loadRecruitments();
    const workspaces = await this.loadWorkspaces();
    const leasePlan = await this.loadLeasePlan();
    const tool = await this.loadTool();
    const toolConsumptions = await this.loadToolConsumptions();
    const escalations = await this.loadEscalations();
    const failed = await this.loadFailed();
    const activity = await this.loadActivity();
    const detail = await this.loadDetail();
    const deployment = await this.loadDeployment();
    const verifyAttempts = await this.loadVerifyAttempts();
    const retryAttempts = await this.loadRetryAttempts();
    const roundAgents = await this.loadRoundAgents();
    const jevDecisions = await this.loadJevDecisions();
    const integration = await this.loadIntegration();
    const planningFailure =
      (await this.ctx.storage.get<PlanningFailureRecord | null>("planningFailure")) ?? null;
    const statuses = workUnitStatuses(change, completed);
    const graph = buildWorkGraph(change);
    const collisions = detectPathCollisions(change);

    const leaseEdges = leaseEdgesFromPlan(leasePlan);

    const work: WorkUnitView[] = change.work.map((unit) => {
      const base = statuses.get(unit.id) ?? "waiting";
      const leased = leases[unit.id] !== undefined;
      const workspace = workspaces[unit.id];
      // A failed unit projects "failed" over any derived status: it is terminal
      // for that unit, so it must not read as runnable/running again even though
      // it has released its lease. A leased, not-yet-complete unit reads as
      // "running"; everything else keeps its scheduling-derived status.
      const status: WorkUnitStatus = failed[unit.id]
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
        // Present once an agent has been recruited for this unit; kept past
        // completion so the node always reveals the real repo it ran in.
        ...(workspace ? { workspace } : {}),
        // The real ordered run steps and rich detail the runner reported, when
        // present. These back the console's activity log and click-detail.
        ...(activity[unit.id] && activity[unit.id]!.length > 0
          ? { activity: activity[unit.id] }
          : {}),
        ...(detail[unit.id] ? { detail: detail[unit.id] } : {}),
      };
    });

    const spentUsd = Number(
      costEvents.reduce((sum, event) => sum + event.usd, 0).toFixed(6),
    );

    return {
      id: change.id,
      objective: change.objective,
      status: await this.loadChangeStatus(),
      baseline: change.baseline,
      budgetUsd: change.budgetUsd,
      assurance: change.assurance,
      work,
      edges: graph.edges,
      collisions,
      completed,
      spentUsd,
      costEvents,
      transitions,
      dial,
      recruitments,
      ...(planViewFromChange(change) ? { plan: planViewFromChange(change)! } : {}),
      ...(tool ? { tool } : {}),
      toolConsumptions,
      leaseEdges,
      escalations,
      failed: Object.values(failed).sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)),
      ...(deployment ? { deployment } : {}),
      verifyAttempts,
      retryAttempts,
      rePlans: retryAttempts.filter((a) => a.refanSource === "re-plan").length,
      // The round-N agent instances, ordered by (round, unitId) for a stable
      // projection. Each is a retry round's re-fanned unit tracked as a real
      // agent with its own recorded workspace and status lifecycle.
      roundAgents: Object.values(roundAgents).sort((a, b) =>
        a.round !== b.round ? a.round - b.round : a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0,
      ),
      jevDecisions,
      integration,
      planningFailure,
      board: summarizeBoard(await this.loadBoardState()),
    };
  }

  private async loadChange(): Promise<Change> {
    const change = await this.ctx.storage.get<Change>("change");
    if (change === undefined) {
      throw new Error("Change not initialized");
    }
    return change;
  }

  /**
   * Read the Change-level lifecycle status. Defaults to "running" for a Change
   * created before this status existed (a stored Change with no recorded status
   * is a normal full-spec create, which is "running"), so the field is always
   * present and backward compatible.
   */
  private async loadChangeStatus(): Promise<ChangeStatus> {
    return (await this.ctx.storage.get<ChangeStatus>("changeStatus")) ?? "running";
  }

  private async loadCompleted(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("completed")) ?? [];
  }

  private async loadLeases(): Promise<Record<string, LeaseRecord>> {
    return (await this.ctx.storage.get<Record<string, LeaseRecord>>("leases")) ?? {};
  }

  private async loadCostEvents(): Promise<CostEvent[]> {
    return (await this.ctx.storage.get<CostEvent[]>("costEvents")) ?? [];
  }

  private async loadTransitions(): Promise<Transition[]> {
    return (await this.ctx.storage.get<Transition[]>("transitions")) ?? [];
  }

  private async loadDial(): Promise<ConcurrencyDial> {
    return (await this.ctx.storage.get<ConcurrencyDial>("dial")) ?? normalizeDial(undefined);
  }

  private async loadRecruitments(): Promise<RecruitmentEvent[]> {
    return (await this.ctx.storage.get<RecruitmentEvent[]>("recruitments")) ?? [];
  }

  private async loadWorkspaceUnits(): Promise<Record<string, string>> {
    return (await this.ctx.storage.get<Record<string, string>>("workspaceUnits")) ?? {};
  }

  private async loadWorkspaces(): Promise<Record<string, WorkspaceIdentity>> {
    return (await this.ctx.storage.get<Record<string, WorkspaceIdentity>>("workspaces")) ?? {};
  }

  private async loadLeasePlan(): Promise<LeasePlan> {
    const stored = await this.ctx.storage.get<LeasePlan>("leasePlan");
    if (stored) {
      return stored;
    }
    // Backfill for a Change created before lease planning existed in state.
    const change = await this.loadChange();
    return this.computeLeasePlan(change);
  }

  /**
   * The write-lease plan for a Change with every resolved human lease-owner
   * decision applied as an owner override (validated by the planner).
   */
  private async computeLeasePlan(change: Change): Promise<LeasePlan> {
    const escalations = await this.loadEscalations();
    return planWriteLeases(change, detectPathCollisions(change), {
      ownerOverrides: leaseOwnerOverridesFromEscalations(escalations),
    });
  }

  private async loadTool(): Promise<ToolRecord | null> {
    return (await this.ctx.storage.get<ToolRecord | null>("tool")) ?? null;
  }

  private async loadToolConsumptions(): Promise<ToolConsumption[]> {
    return (await this.ctx.storage.get<ToolConsumption[]>("toolConsumptions")) ?? [];
  }

  private async loadEscalations(): Promise<Escalation[]> {
    return (await this.ctx.storage.get<Escalation[]>("escalations")) ?? [];
  }

  private async loadFailed(): Promise<Record<string, FailureRecord>> {
    return (await this.ctx.storage.get<Record<string, FailureRecord>>("failed")) ?? {};
  }

  private async loadActivity(): Promise<Record<string, ActivityStep[]>> {
    return (await this.ctx.storage.get<Record<string, ActivityStep[]>>("activity")) ?? {};
  }

  private async loadDetail(): Promise<Record<string, UnitDetail>> {
    return (await this.ctx.storage.get<Record<string, UnitDetail>>("detail")) ?? {};
  }

  private async loadDeployment(): Promise<DeploymentRecord | null> {
    return (await this.ctx.storage.get<DeploymentRecord | null>("deployment")) ?? null;
  }

  private async loadVerifyAttempts(): Promise<VerifyAttempt[]> {
    return (await this.ctx.storage.get<VerifyAttempt[]>("verifyAttempts")) ?? [];
  }

  private async loadRetryAttempts(): Promise<RetryAttempt[]> {
    return (await this.ctx.storage.get<RetryAttempt[]>("retryAttempts")) ?? [];
  }

  private async loadRoundAgents(): Promise<Record<string, RoundAgentView>> {
    return (await this.ctx.storage.get<Record<string, RoundAgentView>>("roundAgents")) ?? {};
  }

  private async loadJevDecisions(): Promise<JevDecisionView[]> {
    return (await this.ctx.storage.get<JevDecisionView[]>("jevDecisions")) ?? [];
  }

  private async loadBoardState(): Promise<BoardState> {
    return (await this.ctx.storage.get<BoardState>("boardState")) ?? emptyBoard();
  }

  private async loadIntegration(): Promise<IntegrationRecord | null> {
    return (await this.ctx.storage.get<IntegrationRecord | null>("integration")) ?? null;
  }
}

const BOARD_KEY_PREFIX = "board:";

/** The storage key of one board message (zero-padded so keys sort by seq). */
function boardMessageKey(seq: number): string {
  return `${BOARD_KEY_PREFIX}${String(seq).padStart(8, "0")}`;
}

/** A fresh random board token (256 bits, hex). */
function newBoardToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `sbt_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The SHA-256 hex digest of a board token: the only form ever stored. */
async function hashBoardToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project a LeasePlan into the console's lease-edge shape: one entry per
 * serialized contested path, naming the single owner and the waiters ordered
 * behind it. Flagged (unserializable) collisions are omitted because they have
 * no owner to point a lease edge at; they still appear in the collision list.
 */
function leaseEdgesFromPlan(plan: LeasePlan): LeaseEdge[] {
  const edges: LeaseEdge[] = [];
  for (const decision of plan.decisions as readonly LeaseDecision[]) {
    if (decision.resolution === "serialized" && decision.owner !== undefined) {
      edges.push({ path: decision.path, owner: decision.owner, waiters: decision.waiters });
    }
  }
  return edges;
}

/**
 * Keep a failure reason short and free of anything that could be a secret. A
 * token or key would never normally be in an executor error (the executor is
 * built to not leak one), but the reason is stored and shown, so bound its
 * length and strip obvious credential-looking fragments defensively.
 */
/**
 * Normalize a re-fan source to one of the known values, or undefined when it is
 * absent or unrecognized (so an unknown value never persists).
 */
function normalizeRefanSource(value: unknown): RefanSource | undefined {
  return value === "parse" || value === "jev" || value === "re-plan" || value === "all"
    ? value
    : undefined;
}

function sanitizeReason(reason: string | undefined): string {
  const text = (reason ?? "agent failed").toString().replace(/\s+/g, " ").trim();
  const redacted = text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  const bounded = redacted.length > 300 ? `${redacted.slice(0, 297)}...` : redacted;
  return bounded === "" ? "agent failed" : bounded;
}

/** Keep a bounded per-unit activity log. */
const MAX_ACTIVITY_STEPS = 200;
/** The maximum stored length of a prompt summary or a proposed diff. */
const MAX_DETAIL_TEXT = 20_000;

/** Keep an activity-step phase short, lowercase, and metadata-safe. */
function boundedPhase(phase: string | undefined): string {
  const text = (phase ?? "step").toString().replace(/\s+/g, "-").trim().toLowerCase();
  const bounded = text.length > 40 ? text.slice(0, 40) : text;
  return bounded === "" ? "step" : bounded;
}

/** The storage key for a round-N agent instance, keyed by (unitId, round). */
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

/**
 * Strip credential-looking fragments from a stored text field and bound it. The
 * prompt summary and the proposed diff are stored and shown, so defensively
 * redact a bearer token or a long credential-looking token even though neither
 * should ever appear in a prompt or a model edit.
 */
function sanitizeText(text: string, max: number): string {
  const redacted = text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return redacted.length > max ? `${redacted.slice(0, max - 3)}...` : redacted;
}

/**
 * Sanitize a reported UnitDetail: bound and secret-strip the free-text fields,
 * keep only finite numeric usage/cost, and bound the edited-paths list, so no
 * credential and no unbounded blob is ever persisted. Fields that are absent are
 * left out so recordDetail can merge pieces across calls.
 */
function sanitizeDetail(detail: UnitDetail): UnitDetail {
  const out: Record<string, unknown> = {};
  if (typeof detail.promptSummary === "string") {
    out.promptSummary = sanitizeText(detail.promptSummary, MAX_DETAIL_TEXT);
  }
  if (typeof detail.model === "string") {
    out.model = detail.model.slice(0, 120);
  }
  if (Array.isArray(detail.editedPaths)) {
    out.editedPaths = detail.editedPaths
      .filter((p): p is string => typeof p === "string")
      .slice(0, 50)
      .map((p) => p.slice(0, 300));
  }
  if (typeof detail.diff === "string") {
    out.diff = sanitizeText(detail.diff, MAX_DETAIL_TEXT);
  }
  if (typeof detail.commitMessage === "string") {
    out.commitMessage = sanitizeText(detail.commitMessage, 500);
  }
  if (typeof detail.inputTokens === "number" && Number.isFinite(detail.inputTokens)) {
    out.inputTokens = detail.inputTokens;
  }
  if (typeof detail.outputTokens === "number" && Number.isFinite(detail.outputTokens)) {
    out.outputTokens = detail.outputTokens;
  }
  if (typeof detail.usd === "number" && Number.isFinite(detail.usd)) {
    out.usd = detail.usd;
  }
  return out as UnitDetail;
}

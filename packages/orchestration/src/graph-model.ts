/**
 * graph-model: the pure projection from a live ChangeState snapshot to the
 * typed node-and-edge graph the console renders.
 *
 * This is the heart of the honesty constraint. The console does NOT animate a
 * script and does NOT invent nodes. It renders exactly this projection of the
 * real durable state the Worker (or the offline control surface) reports. Every
 * node and every edge produced here is derived from a concrete element of the
 * snapshot and carries a `backing` object naming the real state it came from. A
 * node that has no backing state cannot be produced: `buildWorkGraphModel`
 * throws if a derivation ever tries to emit an unbacked node, and
 * `assertBacked` is the single guard every node passes through.
 *
 * It is free of I/O, React, and the Cloudflare runtime, so the same projection
 * runs in the browser console, in a Node test, and anywhere else. The console
 * imports these types and this function; the tests assert the mapping and the
 * no-unbacked-node rule against real snapshots.
 *
 * Typed hooks and their status: the `tool` node kind and the `consumed-tool`
 * edge kind are populated from real state (an agent-built tool published to its
 * own repo, and the downstream units that actually ran it); the `lease` edge
 * kind surfaces the write-lease coordination (owner vs waiter) on a contested
 * path. The `escalated` node flag is populated from real escalation state: a
 * pending human escalation lights the flag on its unit's node (or the goal node
 * for a change-scoped escalation) until a human decision resolves it.
 */

/** The WorkUnit lifecycle status, mirrored from change-core without importing it. */
export type WorkUnitStatus =
  | "waiting"
  | "runnable"
  | "running"
  | "verified"
  | "failed"
  | "integrated";

/** The real Artifact repo identity backing a work/agent node (no token). */
export interface WorkspaceIdentitySnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId?: string;
  readonly tokenExpiresAt?: string;
  readonly leasedAt?: string;
}

/**
 * One ordered step the agent for a WorkUnit actually performed, as reported by
 * the state. These are the REAL run steps the runner/agent emitted (leased,
 * cloning, calling the model, applying the edit, committing, pushing, verified
 * or failed), not UI-synthesized lines: each entry corresponds to a concrete
 * step the live run reported to the Worker. The console renders them as the
 * per-node activity log. A `phase` groups the step for display; `at` is when the
 * step was recorded.
 */
export interface ActivityStepSnapshot {
  /** A short machine phase, e.g. "leased" | "cloning" | "model" | "edit" | ... */
  readonly phase: string;
  /** A short human-readable line describing the step (never a secret/token). */
  readonly message: string;
  readonly at: string;
}

/**
 * The rich per-unit detail the state exposes so the node detail panel is read
 * from real state rather than synthesized: a readable summary of the agent's
 * prompt, the model's proposed edit (the changed paths and a unified-style diff
 * or the full proposed contents), the model id, and token usage when the
 * provider reported it. Every field is optional because it is only known once
 * the agent has run far enough to produce it.
 */
export interface UnitDetailSnapshot {
  /** A readable summary of the prompt the agent sent the model. */
  readonly promptSummary?: string;
  /** The model id the agent used, when an inference executor reported one. */
  readonly model?: string;
  /** The repo-relative paths the model proposed to change. */
  readonly editedPaths?: readonly string[];
  /** A readable unified-style diff (or the proposed contents) of the edit. */
  readonly diff?: string;
  /** The commit message the model proposed, when it did. */
  readonly commitMessage?: string;
  /** Input tokens consumed, when the provider reported them. */
  readonly inputTokens?: number;
  /** Output tokens produced, when the provider reported them. */
  readonly outputTokens?: number;
  /** Explicit cost in US dollars, when the executor reported one. */
  readonly usd?: number;
  readonly at?: string;
}

/** One WorkUnit as the state projection reports it. */
export interface WorkUnitSnapshot {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
  readonly leased: boolean;
  /** Present once an agent has been recruited (a lease recorded) for the unit. */
  readonly workspace?: WorkspaceIdentitySnapshot;
  /**
   * The ordered log of real run steps the agent for this unit emitted, present
   * once the run started reporting them. Each entry is a concrete step, so the
   * activity log the console renders is backed by real steps, not synthesized.
   */
  readonly activity?: readonly ActivityStepSnapshot[];
  /**
   * The rich per-unit detail (prompt summary, proposed edit/diff, model, tokens
   * and cost), present once the agent has produced it. The node detail panel
   * reads these fields straight from state.
   */
  readonly detail?: UnitDetailSnapshot;
}

/** A dependency edge between two WorkUnits, as reported by the state. */
export interface DependencySnapshot {
  readonly from: string;
  readonly to: string;
}

/** A recorded recruitment event, as reported by the state. */
export interface RecruitmentEventSnapshot {
  readonly trigger: "kickoff" | "repo-pushed";
  readonly pushedWorkspace?: string;
  readonly completedUnit?: string;
  readonly recruited: readonly string[];
  readonly ceiling: number;
  readonly inFlightAfter: number;
  readonly at: string;
}

/** A recorded cost event, as reported by the state. */
export interface CostEventSnapshot {
  readonly unitId: string;
  readonly usd: number;
  readonly at: string;
}

/**
 * A recorded agent-built tool, as reported by the state. This is the real
 * backing for the `tool` node: it names the tool-builder WorkUnit, the real
 * workspace (Artifact repo) the tool was published into, the capability it
 * provides, and the file the tool script lives at inside that repo. A tool node
 * is only emitted when this record is present, so a tool node always maps to a
 * real tool-builder repo (the no-unbacked-node rule for the new kind).
 */
export interface ToolSnapshot {
  /** The WorkUnit id of the tool-builder agent. */
  readonly builderUnitId: string;
  /** The capability the tool provides (e.g. "codemod:validate"). */
  readonly capability: string;
  /** The repo-relative path of the published tool script inside its workspace. */
  readonly toolPath: string;
  /** The real workspace (Artifact repo) the tool was published into. */
  readonly workspace: WorkspaceIdentitySnapshot;
  /** A short, human-readable label for the tool node. */
  readonly label: string;
}

/**
 * A recorded tool-consumption, as reported by the state. This is the real
 * backing for a `consumed-tool` edge: a downstream WorkUnit actually ran the
 * tool (not a decorative link). The edge is only emitted when this record is
 * present, so a consumed-tool edge always maps to a real consumption.
 */
export interface ToolConsumptionSnapshot {
  /** The capability consumed (matches ToolSnapshot.capability). */
  readonly capability: string;
  /** The downstream WorkUnit id that ran the tool. */
  readonly consumerUnitId: string;
  readonly at: string;
}

/**
 * A recorded write-lease coordination on a contested path, as reported by the
 * state. This is the real backing for a `lease` edge: the owner holds the write
 * lease on the path and each waiter is ordered to wait for it, so there is one
 * writer and no silent terminal merge. The edge is only emitted when this record
 * is present, so a lease edge always maps to a real coordination decision.
 */
export interface LeaseEdgeSnapshot {
  /** The contested path the lease coordinates. */
  readonly path: string;
  /** The WorkUnit granted the write lease (the single writer). */
  readonly owner: string;
  /** The WorkUnit ids ordered to wait for the owner. */
  readonly waiters: readonly string[];
}

/** The min/max concurrency dial currently in force. */
export interface DialSnapshot {
  readonly minConcurrency: number;
  readonly maxConcurrency: number;
}

/**
 * A recorded live deployment of the fixed app, as reported by the state: the
 * clickable workers.dev URL the run deployed as end-of-run proof the fix works,
 * recorded only after verification passed. Surfaced by the console as a link.
 */
export interface DeploymentSnapshot {
  readonly url: string;
  readonly app: string;
  readonly at?: string;
}

/**
 * A recorded human escalation, as reported by the state. A pending escalation
 * is a fork mechanical evidence could not settle: it lights the `escalated`
 * flag on its node (a unit-scoped escalation on that unit's node, a
 * change-scoped one on the goal node) until a human decision resolves it.
 */
export interface EscalationSnapshot {
  readonly id: string;
  readonly kind: "lease-owner" | "verification-ambiguous" | "decision";
  readonly unitId?: string;
  readonly path?: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly status: "pending" | "resolved";
  readonly decision?: string;
  readonly raisedAt: string;
  readonly resolvedAt?: string;
}

/**
 * How the implicated units for a re-fan were chosen after a change-level
 * verify-fail (mirrors the DO): "parse" (string-parse of the failing gate
 * output), "jev" (a confident Jev attribution choice), "re-plan" (a configured
 * re-plan transport returned a revised unit set), or "all" (nothing could be
 * attributed, so the honest fallback re-fanned every gated unit). A "re-plan"
 * source is what backs a round-keyed `planner` graph node (the re-plan is a
 * plan) and makes a live re-plan countable.
 */
export type RefanSource = "parse" | "jev" | "re-plan" | "all";

/**
 * A recorded mechanical VERIFY attempt for the whole CHANGE, as reported by the
 * state. This is the real backing for a `verify` node: a single run of the
 * per-app behavioral gate against the integrated change after a wave completed.
 * The ladder is CHANGE-LEVEL, so there is exactly one verify attempt per round
 * (round 1 after the first wave, round 2 after the implicated-unit retry), not
 * one per unit. A verify node is only emitted when this record is present, so a
 * verify node always maps to a real recorded gate run (the no-unbacked-node rule
 * for the new kind). The verifier is mechanical on every round, so this verdict
 * is ground truth, never the model grading itself.
 */
export interface VerifyAttemptSnapshot {
  /** 1 for the first verify after the kickoff wave, 2 after the retry wave. */
  readonly round: number;
  readonly outcome: "pass" | "fail";
  /** The model id whose edits this round graded (empty for a deterministic run). */
  readonly model: string;
  /** The gate command (argv joined) that was run for this round. */
  readonly gateCommand?: string;
  /** Bounded real gate failing output (stderr/stdout) when the round failed. */
  readonly failingOutput?: string;
  /** The units the resulting re-fan selected (present only on a fail that re-fanned). */
  readonly implicatedUnits?: readonly string[];
  /** How those units were chosen (parse | jev | re-plan | all). */
  readonly refanSource?: RefanSource;
  readonly at: string;
}

/**
 * A recorded model-escalation RETRY for the whole CHANGE, as reported by the
 * state. This is the real backing for a `retry` node AND the `model-escalation`
 * edge: after a change-level verify-fail, the ladder re-fanned the IMPLICATED
 * units on a stronger model fed the failing evidence. The ladder is
 * CHANGE-LEVEL, so there is one retry per round (round 2 after round-1 failed),
 * carrying the implicated unit ids it re-fanned. Neither the retry node nor the
 * escalation edge is emitted without this record. It is wholly separate from the
 * human-escalation `escalated` flag, which this never lights.
 */
export interface RetryAttemptSnapshot {
  /** The verify round this retry produced edits for (2 for the first retry). */
  readonly round: number;
  /** The model the previous (failed) round used. */
  readonly fromModel: string;
  /** The stronger model this retry escalated the implicated units to. */
  readonly toModel: string;
  /** The unit ids re-fanned on the escalation model (the implicated units). */
  readonly implicatedUnits: readonly string[];
  /** How the implicated units were chosen (parse | jev | re-plan | all). */
  readonly refanSource?: RefanSource;
  /** A short, human-readable reason the ladder escalated. */
  readonly reason: string;
  readonly at: string;
}

/**
 * A recorded round-N agent instance, as reported by the state. This is the real
 * backing for a round-N `agent` node: a retry round's re-fanned unit running as
 * a BRAND NEW agent keyed by (unitId, round), with its OWN recorded Artifact
 * repo and a real status lifecycle (running -> integrated | failed). The graph
 * reads the round-N node's status/verified/workspace/activity/detail from THIS
 * record rather than a hardcoded literal, so the node moves exactly like a
 * kickoff agent node. A round-N node is only emitted when both this record and
 * the backing retry (which names the unit among its implicated units) exist, so
 * it is backed like every other node.
 */
/**
 * The decision juncture a Jev typed decision was recorded at: "plan-review"
 * (does this plan cover the goal?), "attribution" (which modules does this
 * failure implicate?), or "fix-confidence" (is this fix acceptable?). A jev node
 * is placed near its juncture: plan-review by the planner, attribution at the
 * verify-fail -> retry hop, and fix-confidence at the verify.
 */
export type JevJuncture = "plan-review" | "attribution" | "fix-confidence";

/**
 * A recorded Jev typed decision, as reported by the state. This is the real
 * backing for a `jev` node: a typed decision the Jev layer made at one juncture,
 * carrying the question, the typed answer (noul/choice/score), the calibrated
 * confidence (and optional probabilities), and whether the engine ACCEPTED the
 * answer or ESCALATED. A jev node is only emitted when this record is present,
 * so a jev node always maps to a real recorded decision (the no-unbacked-node
 * rule for the new kind). A fix-confidence decision is advisory ONLY: it never
 * flips the authoritative mechanical gate verdict or gates promotion/deploy; it
 * is display + a confidence signal.
 */
export interface JevDecisionSnapshot {
  readonly juncture: JevJuncture;
  readonly question: string;
  readonly answerType: "noul" | "choice" | "score";
  readonly noul?: "yes" | "no" | "unsure";
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly accepted: boolean;
  readonly at?: string;
}

export interface RoundAgentSnapshot {
  readonly unitId: string;
  readonly round: number;
  /** The real Artifact repo this round-N agent ran in (no plaintext token). */
  readonly workspace: WorkspaceIdentitySnapshot;
  /** The round-N agent's recorded lifecycle status. */
  readonly status: WorkUnitStatus;
  /** The ordered real run steps this round-N agent emitted, when present. */
  readonly activity?: readonly ActivityStepSnapshot[];
  /** The rich per-unit detail this round-N agent produced, when present. */
  readonly detail?: UnitDetailSnapshot;
}

/**
 * A recorded schema-constrained plan for this Change, as reported by the state.
 * This is the real backing for the `planner` node: the planner pass decided the
 * in-scope modules, each unit objective, the agent count, and the dependency
 * order within the real structural backbone, and recorded how it did so. A
 * planner node is only emitted when this record is present, so the node always
 * maps to a real recorded decomposition (the no-unbacked-node rule for the new
 * kind). The `source` tells apart a plan the inference planner produced from the
 * deterministic heuristic fallback the pass used when no model returned a usable
 * plan, so the node is honest about how the Change was decomposed.
 */
export interface PlanSnapshot {
  /** Whether the inference planner produced the plan, or the heuristic fallback. */
  readonly source: "planner" | "heuristic-fallback";
  /** The model that produced an accepted plan (empty on the heuristic fallback). */
  readonly model: string;
  /** The ids of the units the plan produced (match the Change's own unit ids). */
  readonly units: readonly string[];
  /** The frozen read-only contract paths the plan froze (owned by no unit). */
  readonly contracts: readonly string[];
  /**
   * A readable, secret-free summary of what the planner was asked (the goal plus
   * the structural module map it was handed). Surfaced in the console's planner
   * detail panel. Optional/empty-safe: absent when the plan carries none.
   */
  readonly promptSummary?: string;
  /** The model's optional explanation of why this decomposition, when present. */
  readonly rationale?: string;
}

/**
 * One planned unit as the planner detail exposes it: the unit id and its
 * objective. The objective is resolved from the Change's WorkUnit of the same
 * id, so the planner detail shows the real objective the plan assigned each unit
 * (the agent count equals the number of these entries).
 */
export interface PlannerUnitDetail {
  readonly id: string;
  readonly objective: string;
}

/**
 * The inspectable detail carried on the planner graph node, so the console can
 * render a planner detail panel at parity with the agent node's detail. Every
 * field is derived from the real recorded plan (and the Change's own WorkUnits
 * for the objectives), so it is backed by the recorded plan exactly like the
 * node itself. The `agentCount` is the number of planned units (the fan-out the
 * plan chose). Optional explanatory fields (promptSummary, rationale) are present
 * only when the plan carried them.
 */
export interface PlannerDetailSnapshot {
  /** Whether the inference planner produced the plan, or the heuristic fallback. */
  readonly source: "planner" | "heuristic-fallback";
  /** The model that produced an accepted plan (empty on the heuristic fallback). */
  readonly model: string;
  /** A readable, secret-free summary of what the planner was asked, when present. */
  readonly promptSummary?: string;
  /** The model's optional explanation of why this decomposition, when present. */
  readonly rationale?: string;
  /** The planned units with their objectives (one per recruited agent). */
  readonly units: readonly PlannerUnitDetail[];
  /** The agent count the plan chose (equals the number of planned units). */
  readonly agentCount: number;
  /** The frozen read-only contract paths the plan froze (owned by no unit). */
  readonly contracts: readonly string[];
}

/**
 * The inspectable detail carried on a `jev` graph node, so the console can
 * render a Jev detail panel showing the real recorded typed decision: the
 * juncture, the question, the typed answer (noul/choice/score), the calibrated
 * confidence (and optional per-outcome probabilities), and whether the engine
 * accepted or escalated. Every field is derived from the real recorded decision,
 * so it is backed exactly like the node.
 */
export interface JevDetailSnapshot {
  readonly juncture: JevJuncture;
  readonly question: string;
  readonly answerType: "noul" | "choice" | "score";
  readonly noul?: "yes" | "no" | "unsure";
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly accepted: boolean;
}

/**
 * The subset of the live ChangeState projection the graph model reads. Both the
 * Worker's `ChangeStateView` and the offline control surface's view are
 * structurally assignable to this, so the model projects either without a
 * cross-package runtime import.
 */
export interface ChangeStateSnapshot {
  readonly id: string;
  readonly objective: string;
  readonly work: readonly WorkUnitSnapshot[];
  readonly edges: readonly DependencySnapshot[];
  readonly completed: readonly string[];
  readonly dial?: DialSnapshot;
  readonly recruitments?: readonly RecruitmentEventSnapshot[];
  readonly costEvents?: readonly CostEventSnapshot[];
  /**
   * The agent-built tool for this Change, when the work needed a capability the
   * repo lacked and one was built. Present only when a real tool-builder repo
   * exists; it is what the `tool` node is backed by.
   */
  readonly tool?: ToolSnapshot;
  /**
   * The real tool-consumption records: each is a downstream unit that actually
   * ran the tool. Each becomes one `consumed-tool` edge.
   */
  readonly toolConsumptions?: readonly ToolConsumptionSnapshot[];
  /**
   * The real write-lease coordination on contested paths: owner vs waiters.
   * Each becomes `lease` edges surfacing the single-writer coordination.
   */
  readonly leaseEdges?: readonly LeaseEdgeSnapshot[];
  /**
   * The human escalations recorded for this Change. A pending one lights the
   * `escalated` flag on its node; this is the state that finally populates the
   * reserved flag in the graph model.
   */
  readonly escalations?: readonly EscalationSnapshot[];
  /**
   * The live deployment of the fixed app for this run, when the run deployed one
   * as end-of-run proof (a real-app template). The console surfaces it as a
   * clickable workers.dev link. Absent for the intro template or a failed fix.
   */
  readonly deployment?: DeploymentSnapshot;
  /**
   * The CHANGE-LEVEL mechanical verify attempts recorded for this Change. Each
   * is one real run of the per-app gate against the integrated change after a
   * wave, keyed by round, and becomes one `verify` node hanging off the goal.
   * Optional/absent until the ladder runs.
   */
  readonly verifyAttempts?: readonly VerifyAttemptSnapshot[];
  /**
   * The CHANGE-LEVEL model-escalation retries recorded for this Change. Each is
   * one re-fan of the implicated units on a stronger model, keyed by round, and
   * becomes one `retry` node plus one `model-escalation` edge from the failing
   * verify round to the retry. Optional/absent until a verify-fail triggers one.
   */
  readonly retryAttempts?: readonly RetryAttemptSnapshot[];
  /**
   * How many retry rounds were driven by a LIVE re-plan (refanSource "re-plan").
   * Optional/absent on the offline path; present and positive only when a
   * configured re-plan transport revised the unit set on a verify-fail.
   */
  readonly rePlans?: number;
  /**
   * The round-N agent instances recorded for this Change. Each is a retry
   * round's re-fanned unit tracked as a BRAND NEW agent keyed by (unitId,
   * round), and becomes one round-N `agent` node beneath its retry whose
   * status/workspace/activity/detail come from this record. Optional/absent
   * until the ladder re-fans a unit on a retry round.
   */
  readonly roundAgents?: readonly RoundAgentSnapshot[];
  /**
   * The schema-constrained plan recorded for this Change, when the goal was
   * decomposed through the inference-backed planner pass (or its heuristic
   * fallback). It becomes one `planner` node between the goal and the first
   * agent wave, backed by this record. Optional/absent on the plain heuristic
   * decomposition path (no planner pass), where there is no separate plan record
   * and the graph has no planner node, exactly as before.
   */
  readonly plan?: PlanSnapshot;
  /**
   * The Jev typed decisions recorded for this Change, each at one juncture
   * (plan-review, attribution, or fix-confidence). Each becomes one `jev` node
   * placed near its juncture (plan-review by the planner, attribution at the
   * verify-fail -> retry hop, fix-confidence at the verify), backed by this
   * record. Optional/absent on the offline path (no decision model configured),
   * where the graph has no jev node, exactly as before.
   */
  readonly jevDecisions?: readonly JevDecisionSnapshot[];
}

/** The kind of a node in the rendered graph. */
export type GraphNodeKind =
  | "goal" // the Change itself: the root the graph self-organizes toward
  | "planner" // the schema-constrained decomposer that produced the plan, between the goal and the first agent wave
  | "work" // a declared WorkUnit before an agent is recruited for it
  | "agent" // a WorkUnit an agent has been recruited for (a real repo exists)
  | "tool" // an agent-built tool published to its own repo, consumed downstream
  | "verify" // one mechanical gate run against a unit's candidate edit (pass/fail)
  | "retry" // one bounded model-escalation retry on a stronger model after a verify-fail
  | "jev"; // one Jev typed decision at a juncture (plan-review, attribution, or fix-confidence)

/**
 * The kind of an edge in the rendered graph. The vocabulary separates three
 * distinct causal meanings so the edge set stays legible AND honest about WHY an
 * edge exists:
 *   - `dependency` is a declared WorkGraph dependency or a plan/promotion edge
 *     (goal->planner->agent and a live push promotion): declared structure, not
 *     ladder control-flow;
 *   - `spawn` is reserved for an event-driven Artifact recruitment ONLY: a
 *     repo-pushed event recruited the target. A spawn edge therefore ALWAYS means
 *     an Artifact push recruited this, never a re-plan/retry trigger;
 *   - `trigger` is the ladder's causal control-flow: the verify-fail ->
 *     planner(re-plan) -> retry-agents chain, the model-escalation hop, the
 *     per-unit re-fan, and the verify flow. These are caused by the ladder, not
 *     by a declared dependency and not by an Artifact event.
 * The edge's `backing` still records the precise provenance (including the
 * model-escalation / re-fan state it came from), so no honesty is lost.
 */
export type GraphEdgeKind =
  | "dependency" // a declared WorkGraph dependency, or a plan/promotion edge (goal->planner->agent, a live push promotion)
  | "spawn" // an event-driven Artifact recruitment ONLY: a repo-pushed event recruited the target
  | "trigger" // ladder control-flow: the verify-fail -> planner(re-plan) -> retry chain, the escalation hop, the re-fan, and the verify flow
  | "consumed-tool"; // a downstream agent actually ran an agent-built tool

/**
 * The real state element a node is backed by. Every node carries one. There is
 * no node kind without a backing variant, which is what makes an unbacked node
 * unrepresentable rather than merely discouraged.
 */
export type NodeBacking =
  | { readonly kind: "change"; readonly changeId: string }
  | {
      // A planner node is backed by the real recorded plan the planner pass
      // produced for this Change, so it can never be a decorative "it planned"
      // node. The kickoff planner (no `round`) maps to the recorded plan record
      // whose source matches. A round-N re-plan planner (`round` present) is the
      // SAME kind, keyed by its retry round: it maps to the recorded re-plan
      // retry for that round (a retry attempt with refanSource "re-plan"), so a
      // re-plan renders as a plain planner node yet stays backed by the real
      // recorded re-plan decision.
      readonly kind: "planner";
      readonly changeId: string;
      readonly source: "planner" | "heuristic-fallback";
      /** The retry round when this planner node is a round-N re-plan; absent for the kickoff plan. */
      readonly round?: number;
    }
  | {
      readonly kind: "work-unit";
      readonly unitId: string;
      readonly status: WorkUnitStatus;
    }
  | {
      readonly kind: "workspace";
      readonly unitId: string;
      readonly workspace: WorkspaceIdentitySnapshot;
    }
  | {
      // A tool node is backed by the real tool-builder repo the tool was
      // published into, so it can never be a decorative node.
      readonly kind: "tool";
      readonly builderUnitId: string;
      readonly capability: string;
      readonly workspace: WorkspaceIdentitySnapshot;
    }
  | {
      // A verify node is backed by a real recorded CHANGE-LEVEL gate run against
      // the integrated change, so it can never be a decorative "it passed" node.
      readonly kind: "verify-attempt";
      readonly changeId: string;
      readonly round: number;
      readonly outcome: "pass" | "fail";
      /** The gate command run this round (for the console detail). */
      readonly gateCommand?: string;
      /** The real failing gate output on a fail (for the console detail). */
      readonly failingOutput?: string;
      /** The units this round's failure re-fanned (for the console detail). */
      readonly implicatedUnits?: readonly string[];
      /** How those units were chosen (parse | jev | re-plan | all). */
      readonly refanSource?: RefanSource;
    }
  | {
      // A retry node is backed by a real recorded CHANGE-LEVEL model-escalation
      // retry, so it can never be drawn without a genuine escalation having
      // happened. It carries the implicated units it re-fanned.
      readonly kind: "retry-attempt";
      readonly changeId: string;
      readonly round: number;
      readonly fromModel: string;
      readonly toModel: string;
      readonly implicatedUnits: readonly string[];
      readonly reason: string;
      /** How the implicated units were chosen (parse | jev | re-plan | all). */
      readonly refanSource?: RefanSource;
    }
  | {
      // A round-N agent-instance node is backed by a real recorded CHANGE-LEVEL
      // retry AND that retry's membership of this unit: the retry round re-fanned
      // this unit on the escalation model, so a fresh agent instance keyed by
      // (unitId, round) exists beneath the retry. It can never be drawn without a
      // genuine retry record that names this unit among its implicated units and
      // a WorkUnit that actually exists, so it is backed like every other node.
      readonly kind: "round-agent";
      readonly changeId: string;
      readonly round: number;
      readonly unitId: string;
      readonly toModel: string;
    }
  | {
      // A jev node is backed by a real recorded Jev typed decision at one
      // juncture, so it can never be a decorative "it decided" node: a decision
      // record for the same change and juncture must be present in the state.
      readonly kind: "jev-decision";
      readonly changeId: string;
      readonly juncture: JevJuncture;
      readonly question: string;
      readonly answerType: "noul" | "choice" | "score";
      readonly confidence: number;
    };

/** The real state element an edge is backed by. */
export type EdgeBacking =
  | { readonly kind: "dependency"; readonly from: string; readonly to: string }
  | {
      readonly kind: "recruitment-event";
      readonly at: string;
      readonly pushedWorkspace?: string;
      readonly completedUnit?: string;
    }
  | {
      // A consumed-tool edge is backed by a real consumption record (a
      // downstream unit that actually ran the tool).
      readonly kind: "tool-consumption";
      readonly capability: string;
      readonly consumerUnitId: string;
      readonly at: string;
    }
  | {
      // A lease edge is backed by a real write-lease coordination decision.
      readonly kind: "lease";
      readonly path: string;
      readonly owner: string;
      readonly waiter: string;
    }
  | {
      // A model-escalation edge is backed by a real recorded CHANGE-LEVEL retry:
      // a change-level verify-fail escalated the next round's implicated units
      // from one model to a stronger one. It is a different beat from the
      // human-escalation `escalated` flag.
      readonly kind: "model-escalation";
      readonly changeId: string;
      readonly round: number;
      readonly fromModel: string;
      readonly toModel: string;
    }
  | {
      // A re-fan edge is backed by a real recorded CHANGE-LEVEL retry AND a real
      // implicated unit id that retry re-fanned: the retry round re-ran that unit
      // on the escalation model. The edge is only drawn from the retry node to a
      // unit the recorded retry-attempt.implicatedUnits actually names and that
      // exists in the Change, so it is never a decorative link.
      readonly kind: "re-fan";
      readonly changeId: string;
      readonly round: number;
      readonly unitId: string;
      readonly toModel: string;
    };

/** A node in the rendered graph. */
export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly status: WorkUnitStatus;
  /** True once this unit's work is verified/integrated (the node greens). */
  readonly verified: boolean;
  /**
   * True while a pending human escalation is attached to this node (an
   * evidence-unsettled fork the engine surfaced and is waiting on). It is lit
   * from real escalation state: a unit-scoped pending escalation lights its
   * unit's node, a change-scoped one lights the goal node, and it clears when a
   * human decision resolves the escalation. The console highlights it when true.
   */
  readonly escalated: boolean;
  /** The real Artifact repo backing an agent node, when one exists. */
  readonly workspace?: WorkspaceIdentitySnapshot;
  /**
   * The ordered real run steps the agent for this unit emitted (the per-node
   * activity log). Carried through from the unit snapshot so the detail panel
   * renders real steps; absent for the goal node and for units with no steps.
   */
  readonly activity?: readonly ActivityStepSnapshot[];
  /**
   * The rich per-unit detail (prompt summary, proposed edit/diff, model, tokens
   * and cost) carried through from the unit snapshot, so the detail panel reads
   * it straight from real state. Absent until the agent has produced it.
   */
  readonly detail?: UnitDetailSnapshot;
  /**
   * The inspectable plan detail carried on the PLANNER node, so the console can
   * render a planner detail panel (source, model, prompt summary, rationale, the
   * planned units with objectives, the agent count, and the frozen contracts) at
   * parity with the agent node's model detail. Present only on the planner node,
   * derived from the real recorded plan, so it is backed exactly like the node.
   */
  readonly plannerDetail?: PlannerDetailSnapshot;
  /**
   * The inspectable decision detail carried on a `jev` node, so the console can
   * render a Jev detail panel (juncture, question, typed answer, calibrated
   * confidence/probabilities, accepted-or-escalated). Present only on a jev node,
   * derived from the real recorded decision, so it is backed exactly like the node.
   */
  readonly jevDetail?: JevDetailSnapshot;
  /** The concrete state element this node was derived from. */
  readonly backing: NodeBacking;
}

/** An edge in the rendered graph. */
export interface GraphEdge {
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly from: string;
  readonly to: string;
  /** The concrete state element this edge was derived from. */
  readonly backing: EdgeBacking;
}

/** The full graph model projected from one ChangeState snapshot. */
export interface WorkGraphModel {
  readonly changeId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly dial?: DialSnapshot;
}

/** The id used for the single goal node (the Change root). */
export function goalNodeId(changeId: string): string {
  return `goal:${changeId}`;
}

/** The id used for the single planner node (the Change's decomposer). */
export function plannerNodeId(changeId: string): string {
  return `planner:${changeId}`;
}

/** The id used for a WorkUnit's node. */
export function unitNodeId(unitId: string): string {
  return `unit:${unitId}`;
}

/** The id used for the agent-built tool node (one tool per Change). */
export function toolNodeId(capability: string): string {
  return `tool:${capability}`;
}

/** The id used for the change-level verify node for a given round (one per gate run). */
export function verifyNodeId(changeId: string, round: number): string {
  return `verify:${changeId}#${round}`;
}

/** The id used for the change-level retry node for a given round (one per escalation). */
export function retryNodeId(changeId: string, round: number): string {
  return `retry:${changeId}#${round}`;
}

/**
 * The id used for a round-N RE-PLAN planner node: a re-plan of the unit set to
 * re-fan, rendered as a plain `planner` node sitting BETWEEN the failing verify
 * of the previous round and that round's retry agents. It is keyed by round so a
 * round-N re-plan planner never collides with the kickoff planner node id
 * (`plannerNodeId`). One per retry round that a live re-plan drove (refanSource
 * "re-plan"); absent on the offline/attribution path.
 */
export function replanNodeId(changeId: string, round: number): string {
  return `replan:${changeId}#${round}`;
}

/**
 * The id used for a round-N agent-instance node: a FRESH agent node materialized
 * beneath a retry node for one implicated unit re-fanned in that round. It is
 * keyed by (changeId, round, unitId) so round N and round N+1 each get their own
 * instance node for the same unit, laid out beneath their own retry node rather
 * than pointing back at the original unit node.
 */
export function roundAgentNodeId(changeId: string, round: number, unitId: string): string {
  return `round-agent:${changeId}#${round}:${unitId}`;
}

/**
 * The id used for a `jev` decision node at a juncture. Keyed by (changeId,
 * juncture, index) so multiple decisions at the same juncture (for example a
 * fix-confidence decision per retry round) each get their own node rather than
 * colliding. The index is the decision's position among same-juncture decisions.
 */
export function jevNodeId(changeId: string, juncture: JevJuncture, index: number): string {
  return `jev:${changeId}#${juncture}:${index}`;
}

/**
 * The honesty guard every node passes through. It verifies the node carries a
 * backing that actually resolves against the snapshot, and throws otherwise. A
 * node whose backing does not name a real Change, a real WorkUnit, or a real
 * recorded workspace is rejected here, so an unbacked node can never reach the
 * returned model (and therefore never reach the screen).
 */
export function assertBacked(node: GraphNode, snapshot: ChangeStateSnapshot): GraphNode {
  const backing = node.backing;
  switch (backing.kind) {
    case "change":
      if (backing.changeId !== snapshot.id) {
        throw new Error(
          `unbacked node ${node.id}: goal backing ${backing.changeId} is not the Change ${snapshot.id}`,
        );
      }
      return node;
    case "planner": {
      // A planner node must map to a real recorded decision, so it can never be
      // a decorative "it planned" node. Its change must match either way.
      if (backing.changeId !== snapshot.id) {
        throw new Error(
          `unbacked node ${node.id}: planner backing ${backing.changeId} is not the Change ${snapshot.id}`,
        );
      }
      if (backing.round === undefined) {
        // The kickoff planner: a plan record whose source matches must be present.
        // A planner node with no backing plan record is exactly the decorative
        // node the no-unbacked-node rule forbids. (Unchanged.)
        if (!snapshot.plan) {
          throw new Error(
            `unbacked node ${node.id}: no plan recorded in the state for change ${backing.changeId}`,
          );
        }
        if (snapshot.plan.source !== backing.source) {
          throw new Error(
            `unbacked node ${node.id}: planner source ${backing.source} does not match the recorded plan source ${snapshot.plan.source}`,
          );
        }
        return node;
      }
      // A round-N re-plan planner: a configured re-plan transport revised the
      // unit set to re-fan on a verify-fail. A retry attempt for the same round
      // with refanSource "re-plan" must be present. A re-plan planner node with
      // no such re-plan record is exactly the decorative node the no-unbacked-node
      // rule forbids, so an offline/attribution round (no re-plan) can never draw
      // one.
      const replanRetry = (snapshot.retryAttempts ?? []).find(
        (a) => a.round === backing.round && a.refanSource === "re-plan",
      );
      if (!replanRetry) {
        throw new Error(
          `unbacked node ${node.id}: no recorded re-plan (retry round ${backing.round} with refanSource re-plan) for change ${backing.changeId}`,
        );
      }
      return node;
    }
    case "work-unit": {
      const unit = snapshot.work.find((u) => u.id === backing.unitId);
      if (!unit) {
        throw new Error(
          `unbacked node ${node.id}: no WorkUnit ${backing.unitId} in the state snapshot`,
        );
      }
      return node;
    }
    case "workspace": {
      const unit = snapshot.work.find((u) => u.id === backing.unitId);
      if (!unit || !unit.workspace) {
        throw new Error(
          `unbacked node ${node.id}: WorkUnit ${backing.unitId} has no recorded workspace in the state`,
        );
      }
      return node;
    }
    case "tool": {
      // A tool node must map to the real tool record the state reports: its
      // builder unit must exist, and the tool must have a recorded workspace
      // (its own Artifact repo) matching the node's backing. A tool node with
      // no backing tool record, or naming a builder the state does not list, is
      // exactly the decorative node this rule forbids.
      if (!snapshot.tool) {
        throw new Error(
          `unbacked node ${node.id}: no agent-built tool recorded in the state`,
        );
      }
      if (snapshot.tool.capability !== backing.capability) {
        throw new Error(
          `unbacked node ${node.id}: tool capability ${backing.capability} does not match the recorded tool ${snapshot.tool.capability}`,
        );
      }
      const builder = snapshot.work.find((u) => u.id === backing.builderUnitId);
      if (!builder) {
        throw new Error(
          `unbacked node ${node.id}: tool builder ${backing.builderUnitId} is not a WorkUnit in the state`,
        );
      }
      if (!snapshot.tool.workspace || snapshot.tool.workspace.workspaceName !== backing.workspace.workspaceName) {
        throw new Error(
          `unbacked node ${node.id}: tool has no recorded builder workspace in the state`,
        );
      }
      return node;
    }
    case "verify-attempt": {
      // A verify node must map to a real recorded CHANGE-LEVEL gate run: its
      // change must match the snapshot AND a verify attempt with the same round
      // and outcome must be present in the state. A verify node with no backing
      // attempt record is exactly the decorative "it passed" node the
      // no-unbacked-node rule forbids.
      if (backing.changeId !== snapshot.id) {
        throw new Error(
          `unbacked node ${node.id}: verify attempt names change ${backing.changeId}, not ${snapshot.id}`,
        );
      }
      const attempt = (snapshot.verifyAttempts ?? []).find(
        (a) => a.round === backing.round && a.outcome === backing.outcome,
      );
      if (!attempt) {
        throw new Error(
          `unbacked node ${node.id}: no recorded verify attempt round ${backing.round} (${backing.outcome}) for change ${backing.changeId}`,
        );
      }
      return node;
    }
    case "retry-attempt": {
      // A retry node must map to a real recorded CHANGE-LEVEL model-escalation
      // retry: its change must match AND a retry attempt with the same round and
      // escalation model must be present. A retry node with no backing retry
      // record is a decorative escalation the rule forbids.
      if (backing.changeId !== snapshot.id) {
        throw new Error(
          `unbacked node ${node.id}: retry attempt names change ${backing.changeId}, not ${snapshot.id}`,
        );
      }
      const retry = (snapshot.retryAttempts ?? []).find(
        (a) => a.round === backing.round && a.toModel === backing.toModel,
      );
      if (!retry) {
        throw new Error(
          `unbacked node ${node.id}: no recorded model-escalation retry round ${backing.round} to ${backing.toModel} for change ${backing.changeId}`,
        );
      }
      return node;
    }
    case "round-agent": {
      // A round-N agent node must map to a real recorded CHANGE-LEVEL retry that
      // re-fanned this unit: its change must match, a retry attempt with the same
      // round and escalation model must be present, that attempt must name this
      // unit among its implicated units, and the unit must exist in the Change.
      // A round-N node with no backing retry (or for a unit that retry did not
      // re-fan) is exactly the unbacked node the rule forbids.
      if (backing.changeId !== snapshot.id) {
        throw new Error(
          `unbacked node ${node.id}: round-agent names change ${backing.changeId}, not ${snapshot.id}`,
        );
      }
      const retry = (snapshot.retryAttempts ?? []).find(
        (a) => a.round === backing.round && a.toModel === backing.toModel,
      );
      if (!retry) {
        throw new Error(
          `unbacked node ${node.id}: no recorded model-escalation retry round ${backing.round} to ${backing.toModel} for change ${backing.changeId}`,
        );
      }
      if (!retry.implicatedUnits.includes(backing.unitId)) {
        throw new Error(
          `unbacked node ${node.id}: retry round ${backing.round} did not re-fan unit ${backing.unitId}`,
        );
      }
      const unit = snapshot.work.find((u) => u.id === backing.unitId);
      if (!unit) {
        throw new Error(
          `unbacked node ${node.id}: round-agent unit ${backing.unitId} is not a WorkUnit in the state`,
        );
      }
      // When the round-N node carries a workspace (its OWN recorded Artifact
      // repo) or a non-running status, that richer backing must be a REAL
      // recorded round-N agent instance keyed by (unitId, round): a round node
      // cannot claim a repo it was never leased or a green/red status it never
      // reached. This mirrors the kickoff `workspace`-backed node requiring its
      // recorded workspace, so the dynamic round-N node is still fully backed.
      const recorded = (snapshot.roundAgents ?? []).find(
        (a) => a.unitId === backing.unitId && a.round === backing.round,
      );
      if (node.workspace !== undefined) {
        if (!recorded) {
          throw new Error(
            `unbacked node ${node.id}: round-agent claims a workspace but no round-N agent instance is recorded for unit ${backing.unitId} round ${backing.round}`,
          );
        }
        if (recorded.workspace.workspaceName !== node.workspace.workspaceName) {
          throw new Error(
            `unbacked node ${node.id}: round-agent workspace ${node.workspace.workspaceName} does not match the recorded round-N agent workspace ${recorded.workspace.workspaceName}`,
          );
        }
      }
      if (node.status !== "running" && !recorded) {
        throw new Error(
          `unbacked node ${node.id}: round-agent claims status ${node.status} but no round-N agent instance is recorded for unit ${backing.unitId} round ${backing.round}`,
        );
      }
      return node;
    }
    case "jev-decision": {
      // A jev node must map to a real recorded Jev typed decision: its change
      // must match AND a decision at the same juncture with the same question,
      // answer type, and confidence must be present in the state. A jev node
      // with no backing decision record is exactly the decorative "it decided"
      // node the no-unbacked-node rule forbids.
      if (backing.changeId !== snapshot.id) {
        throw new Error(
          `unbacked node ${node.id}: jev decision names change ${backing.changeId}, not ${snapshot.id}`,
        );
      }
      const decision = (snapshot.jevDecisions ?? []).find(
        (d) =>
          d.juncture === backing.juncture &&
          d.question === backing.question &&
          d.answerType === backing.answerType &&
          d.confidence === backing.confidence,
      );
      if (!decision) {
        throw new Error(
          `unbacked node ${node.id}: no recorded jev decision at juncture ${backing.juncture} for change ${backing.changeId}`,
        );
      }
      return node;
    }
    default: {
      // Exhaustiveness: a new backing kind must be handled above.
      const _never: never = backing;
      throw new Error(`unbacked node ${node.id}: unknown backing ${JSON.stringify(_never)}`);
    }
  }
}

/** Whether a status counts as verified/integrated (the node greens). */
function isVerified(status: WorkUnitStatus): boolean {
  return status === "verified" || status === "integrated";
}

/**
 * Whether a WorkUnit has actually been SPAWNED/recruited yet, so its node should
 * be materialized. A unit's node appears only once an agent is genuinely working
 * it: either a lease recorded a real workspace, or the unit has moved past the
 * pending states into running/verified/integrated/failed. A still-pending unit
 * (status `waiting`/`runnable` with no recorded workspace) has no agent yet, so
 * it yields NO node: the goal shows first and agent nodes appear as they are
 * recruited, rather than every declared unit sitting at t=0. Every node this
 * admits is still backed (a workspace-backed node has its workspace; a
 * work-backed node has its unit), so the no-unbacked-node rule is preserved.
 */
function isSpawned(unit: WorkUnitSnapshot): boolean {
  if (unit.workspace !== undefined) {
    return true;
  }
  if (unit.leased) {
    return true;
  }
  // A unit that has recorded real run steps (or produced run detail) has an
  // agent actively working it, so it is spawned even before a workspace record
  // lands or its status advances.
  if ((unit.activity?.length ?? 0) > 0 || unit.detail !== undefined) {
    return true;
  }
  return unit.status === "running" || unit.status === "verified" || unit.status === "integrated" || unit.status === "failed";
}

/**
 * Whether a round-N retry agent has actually materialized, so its node is
 * emitted only once it has leased/run rather than all at once when the retry
 * record lands. This mirrors kickoff `isSpawned`: a round-N node appears when a
 * real recorded round-agent instance for (unitId, round) carries a workspace,
 * recorded run steps, run detail, or an advanced status. A retry record with no
 * recorded round-agent instance yet yields NO round node, so round-N agents
 * stagger in as each one leases/runs, exactly like the kickoff wave. Every node
 * this admits is still fully backed by its recorded round-agent instance, so the
 * no-unbacked-node rule is preserved.
 */
function isRoundAgentSpawned(agent: RoundAgentSnapshot | undefined): boolean {
  if (!agent) {
    return false;
  }
  if (agent.workspace !== undefined) {
    return true;
  }
  if ((agent.activity?.length ?? 0) > 0 || agent.detail !== undefined) {
    return true;
  }
  return (
    agent.status === "running" ||
    agent.status === "verified" ||
    agent.status === "integrated" ||
    agent.status === "failed"
  );
}

/** The goal node's status + green flag, derived from the whole-change verdict. */
interface GoalOutcome {
  readonly status: WorkUnitStatus;
  readonly verified: boolean;
}

/**
 * Derive the goal node's state from the AUTHORITATIVE change outcome, not from
 * the first wave finishing.
 *
 * The authoritative verdict for the whole change is the promoted-artifact gate
 * run: the change-level verify attempts the ladder records. When the ladder has
 * run, the latest round's outcome is ground truth, so:
 *
 *   - green (integrated) ONLY when the latest recorded verify round PASSED (the
 *     authoritative gate passed on the promoted artifact);
 *   - red (failed) when the latest recorded verify round FAILED and the ladder
 *     has exhausted its retries (no later round is coming), so the change is a
 *     terminal failure;
 *   - running otherwise (a round failed but a retry round is still in flight).
 *
 * This closes the two reported bugs: the goal never greens on the first wave
 * finishing BEFORE the authoritative verify (there is no passing verify round
 * yet, so it stays running), and once the ladder has exhausted on a failing
 * round the goal is terminal red and never flips back to running.
 *
 * When the state records NO verify attempts (the offline demo / no-gate path),
 * there is no authoritative gate to defer to, so the goal falls back to the
 * every-unit-integrated reading it has always used for that path.
 */
function goalOutcome(snapshot: ChangeStateSnapshot): GoalOutcome {
  const verifyAttempts = snapshot.verifyAttempts ?? [];
  if (verifyAttempts.length === 0) {
    // No authoritative gate recorded: fall back to every-unit-integrated.
    const allIntegrated =
      snapshot.work.length > 0 && snapshot.work.every((u) => isVerified(u.status));
    return {
      status: allIntegrated ? "integrated" : "running",
      verified: allIntegrated,
    };
  }

  // The authoritative verdict is the latest recorded verify round.
  const latest = verifyAttempts.reduce((a, b) => (b.round >= a.round ? b : a));
  if (latest.outcome === "pass") {
    return { status: "integrated", verified: true };
  }

  // The latest round FAILED. The change is terminal red only when the ladder has
  // exhausted (no retry round is in flight past this failing round). A retry
  // whose round is beyond the latest recorded verify means another verify is
  // still coming, so the change is still running rather than terminally failed.
  const retryAttempts = snapshot.retryAttempts ?? [];
  const retryPending = retryAttempts.some((r) => r.round > latest.round);
  return {
    status: retryPending ? "running" : "failed",
    verified: false,
  };
}

/**
 * Project a live ChangeState snapshot into the typed graph the console renders.
 *
 * The mapping, in one place:
 *   - the goal node is the Change root, backed by the Change id;
 *   - each WorkUnit is one node: it is an `agent` node (backed by its real
 *     workspace) once a lease has recorded a workspace for it, otherwise a
 *     plain `work` node (backed by the WorkUnit). A node greens when its status
 *     is verified/integrated. The `escalated` flag lights from real escalation
 *     state: a pending human escalation lights its unit's node (or the goal node
 *     for a change-scoped escalation) and clears when a human decision resolves it.
 *   - every WorkUnit node gets a `dependency` edge from the goal, so the graph
 *     is rooted and nothing floats unattached to the Change it serves;
 *   - each declared dependency edge is a `dependency` edge, promoted to a
 *     `data-flow` edge once its prerequisite is complete (data has actually
 *     flowed from the finished prerequisite to the dependent);
 *   - each repo-pushed recruitment event becomes a `spawn` edge from the pushing
 *     unit to each unit that push recruited (the event-driven nervous system),
 *     backed by the real recruitment-event log entry.
 *
 * Because the whole graph is derived from the snapshot and every node is passed
 * through `assertBacked`, the morphing the console shows over time is purely a
 * projection of real state transitions between successive snapshots, never a
 * timed animation. Nodes appear when the state gains a unit/lease, green when
 * the state marks them verified/integrated, and fade when the state removes
 * them.
 */
export function buildWorkGraphModel(snapshot: ChangeStateSnapshot): WorkGraphModel {
  const unitIds = new Set(snapshot.work.map((u) => u.id));
  // The units that have actually been spawned/recruited, so a node is emitted
  // for them. A not-yet-spawned (still pending) unit is withheld: it has no agent
  // working it, so it materializes only once a lease/workspace or a running+
  // status appears. Every edge endpoint is checked against this set so an edge
  // to a withheld unit is never drawn (which would be an edge to a missing node).
  const spawnedIds = new Set(snapshot.work.filter((u) => isSpawned(u)).map((u) => u.id));
  const nodes: GraphNode[] = [];

  // Pending escalations light the reserved `escalated` flag. A unit-scoped
  // pending escalation lights that unit's node; a change-scoped one (no unitId)
  // lights the goal node. This is the state that finally populates the flag the
  // graph model reserved for the human escalation beat.
  const escalatedUnits = new Set<string>();
  let goalEscalated = false;
  for (const escalation of snapshot.escalations ?? []) {
    if (escalation.status !== "pending") {
      continue;
    }
    if (escalation.unitId && unitIds.has(escalation.unitId)) {
      escalatedUnits.add(escalation.unitId);
    } else {
      goalEscalated = true;
    }
  }

  // A unit with a PENDING escalation attached is actively the subject of a human
  // decision the engine is waiting on, so it materializes (and lights its node)
  // even if it had not otherwise reached a spawned status yet. Without this a
  // unit-scoped escalation would have no node to light.
  for (const unitId of escalatedUnits) {
    spawnedIds.add(unitId);
  }

  // A unit named by a repo-pushed recruitment event HAS been recruited, so it is
  // spawned and its node must materialize even if its own WorkUnit snapshot has
  // not yet recorded a workspace/lease/advanced status (the recruitment event and
  // the per-unit workspace record can land out of order live). This covers both
  // endpoints of a spawn edge: the pushing unit (completedUnit) that drove the
  // wave and each unit it recruited. Without this the materialize-on-spawn gate
  // could withhold a genuinely-recruited node, which in turn drops the spawn edge
  // (an edge needs both endpoints spawned), so a live repo-pushed wave would show
  // no spawn edges even though the recruitment really happened. Only real units
  // of this Change are admitted, and every admitted node is still backed by its
  // own WorkUnit snapshot, so the no-unbacked-node rule is preserved.
  for (const event of snapshot.recruitments ?? []) {
    if (event.trigger !== "repo-pushed") {
      continue;
    }
    if (event.completedUnit && unitIds.has(event.completedUnit)) {
      spawnedIds.add(event.completedUnit);
    }
    for (const recruitedId of event.recruited) {
      if (unitIds.has(recruitedId)) {
        spawnedIds.add(recruitedId);
      }
    }
  }

  // The goal node: the Change root the graph self-organizes toward. Its status
  // comes from the authoritative whole-change verdict (see goalOutcome).
  const goal = goalOutcome(snapshot);
  nodes.push(
    assertBacked(
      {
        id: goalNodeId(snapshot.id),
        kind: "goal",
        label: snapshot.objective || snapshot.id,
        // The goal reads from the AUTHORITATIVE change verdict (the promoted
        // -artifact gate the ladder records), not from the first wave finishing:
        // green only after a passing verify round, terminal red once the ladder
        // exhausts on a failing round, running otherwise. See goalOutcome.
        status: goal.status,
        verified: goal.verified,
        escalated: goalEscalated,
        backing: { kind: "change", changeId: snapshot.id },
      },
      snapshot,
    ),
  );

  // The planner node: the schema-constrained decomposer that produced the plan,
  // placed between the goal and the first agent wave. It is emitted ONLY when
  // the state records a plan (the inference planner pass ran), so the plain
  // heuristic path has no planner node and is unchanged. It is backed by the
  // real recorded plan, so it is never a decorative node, and it roots the agent
  // wave below it (goal -> planner -> agents) so the planner is visibly the
  // decomposer. It greens once a plan is recorded (the decomposition is done).
  const plan = snapshot.plan;
  if (plan) {
    // Build the inspectable planner detail from the real recorded plan: resolve
    // each planned unit id to its objective from the Change's WorkUnits so the
    // detail shows the objective the plan assigned each unit, and carry the agent
    // count (= number of planned units), the frozen contracts, and the optional
    // prompt summary / rationale. This is derived wholly from the recorded plan
    // (and the Change's own units), so it is backed exactly like the node.
    const plannerUnits: PlannerUnitDetail[] = plan.units.map((unitId) => {
      const unit = snapshot.work.find((u) => u.id === unitId);
      return { id: unitId, objective: unit?.objective ?? "" };
    });
    const plannerDetail: PlannerDetailSnapshot = {
      source: plan.source,
      model: plan.model,
      ...(plan.promptSummary !== undefined ? { promptSummary: plan.promptSummary } : {}),
      ...(plan.rationale !== undefined ? { rationale: plan.rationale } : {}),
      units: plannerUnits,
      agentCount: plannerUnits.length,
      contracts: [...plan.contracts],
    };
    nodes.push(
      assertBacked(
        {
          id: plannerNodeId(snapshot.id),
          kind: "planner",
          label:
            plan.source === "planner"
              ? `planner: ${plan.model || "schema-constrained"}`
              : "planner: heuristic fallback",
          status: "integrated",
          verified: true,
          escalated: false,
          plannerDetail,
          backing: { kind: "planner", changeId: snapshot.id, source: plan.source },
        },
        snapshot,
      ),
    );
  }

  // One node per WorkUnit. An agent node is backed by a real recorded workspace;
  // a work node is backed by the WorkUnit itself. There is no third option, so
  // every unit node has concrete backing.
  for (const unit of snapshot.work) {
    // Withhold a not-yet-spawned (still pending) unit: its node materializes only
    // once an agent is recruited for it (a lease/workspace, or a status past
    // pending). This keeps t=0 to the goal plus whatever is actually running,
    // rather than every declared unit appearing before any agent exists.
    if (!spawnedIds.has(unit.id)) {
      continue;
    }
    const hasWorkspace = unit.workspace !== undefined;
    const unitEscalated = escalatedUnits.has(unit.id);
    // Carry the real per-unit activity log and detail through additively, so the
    // detail panel reads real recorded steps and real model detail rather than
    // synthesizing them. Both are absent until the run reports them.
    const extras = {
      ...(unit.activity ? { activity: unit.activity } : {}),
      ...(unit.detail ? { detail: unit.detail } : {}),
    };
    const node: GraphNode = hasWorkspace
      ? {
          id: unitNodeId(unit.id),
          kind: "agent",
          label: unit.id,
          status: unit.status,
          verified: isVerified(unit.status),
          escalated: unitEscalated,
          workspace: unit.workspace,
          ...extras,
          backing: { kind: "workspace", unitId: unit.id, workspace: unit.workspace! },
        }
      : {
          id: unitNodeId(unit.id),
          kind: "work",
          label: unit.id,
          status: unit.status,
          verified: isVerified(unit.status),
          escalated: unitEscalated,
          ...extras,
          backing: { kind: "work-unit", unitId: unit.id, status: unit.status },
        };
    nodes.push(assertBacked(node, snapshot));
  }

  const edges: GraphEdge[] = [];

  // When a plan is recorded, the planner node sits between the goal and the
  // agents: the goal flows into the planner (the Change handed to the decomposer)
  // and the agents root off the planner, so the planner is visibly the
  // decomposer. The goal->planner edge is drawn once; the per-unit rooting below
  // runs from the planner instead of the goal. On the plain heuristic path (no
  // plan) the planner node is absent, so units root directly off the goal exactly
  // as before, and nothing changes.
  const rootId = plan ? plannerNodeId(snapshot.id) : goalNodeId(snapshot.id);
  if (plan) {
    edges.push({
      id: `goal->planner:${snapshot.id}`,
      kind: "dependency",
      from: goalNodeId(snapshot.id),
      to: plannerNodeId(snapshot.id),
      backing: { kind: "dependency", from: snapshot.id, to: `planner:${snapshot.id}` },
    });
  }

  // Root every SPAWNED unit to the planner (when present) or the goal, so the
  // graph is a tree over the Change. A withheld (not-yet-spawned) unit has no
  // node, so it is not rooted either. These are backed by the Change-to-unit
  // relationship the snapshot declares.
  for (const unit of snapshot.work) {
    if (!spawnedIds.has(unit.id)) {
      continue;
    }
    edges.push({
      id: `${plan ? "planner" : "goal"}->${unit.id}`,
      kind: "dependency",
      from: rootId,
      to: unitNodeId(unit.id),
      backing: { kind: "dependency", from: snapshot.id, to: unit.id },
    });
  }

  // Declared dependency edges. Every declared WorkGraph dependency renders as a
  // single `dependency` kind, backed by the real edge in state.
  for (const edge of snapshot.edges) {
    if (!spawnedIds.has(edge.from) || !spawnedIds.has(edge.to)) {
      // Skip an edge whose endpoint has no node yet (unknown unit, or a unit not
      // yet spawned/materialized), rather than drawing an edge to a missing node.
      continue;
    }
    edges.push({
      id: `${edge.from}->${edge.to}`,
      // A declared dependency, whether or not an agent push has made it live, is
      // rendered as a single `dependency` kind. The declared dependency is the
      // real backing.
      kind: "dependency",
      from: unitNodeId(edge.from),
      to: unitNodeId(edge.to),
      backing: { kind: "dependency", from: edge.from, to: edge.to },
    });
  }

  // Event-driven spawn edges: each repo-pushed recruitment event spawned the
  // units it recruited. The edge runs from the pushing unit (the one whose push
  // drove the wave) to each recruited unit, backed by the real event log entry.
  for (const event of snapshot.recruitments ?? []) {
    if (event.trigger !== "repo-pushed" || !event.completedUnit) {
      continue;
    }
    const fromUnit = event.completedUnit;
    if (!spawnedIds.has(fromUnit)) {
      continue;
    }
    for (const recruitedId of event.recruited) {
      if (!spawnedIds.has(recruitedId)) {
        // The recruited unit has not materialized a node yet (still pending): the
        // spawn edge appears once it is actually spawned, so it hangs off its
        // spawner rather than pointing at a missing node.
        continue;
      }
      edges.push({
        id: `spawn:${fromUnit}->${recruitedId}@${event.at}`,
        kind: "spawn",
        from: unitNodeId(fromUnit),
        to: unitNodeId(recruitedId),
        backing: {
          kind: "recruitment-event",
          at: event.at,
          pushedWorkspace: event.pushedWorkspace,
          completedUnit: event.completedUnit,
        },
      });
    }
  }

  // The agent-built tool node, when the state records one. It is backed by the
  // real tool-builder repo (its own Artifact repo), so it is never a decorative
  // node. The builder WorkUnit remains its own agent/work node; the tool node is
  // the published tool itself, linked to its builder and its consumers.
  const tool = snapshot.tool;
  if (tool) {
    const toolNode: GraphNode = {
      id: toolNodeId(tool.capability),
      kind: "tool",
      label: tool.label,
      // The tool greens once it is published (its builder repo exists). The
      // state only reports a tool once it has been built and published, so a
      // present tool record is a built tool.
      status: "integrated",
      verified: true,
      escalated: false,
      workspace: tool.workspace,
      backing: {
        kind: "tool",
        builderUnitId: tool.builderUnitId,
        capability: tool.capability,
        workspace: tool.workspace,
      },
    };
    nodes.push(assertBacked(toolNode, snapshot));

    // The builder-to-tool edge: the tool was published by its builder. Drawn as
    // a data-flow edge from the builder unit to the tool, backed by the tool
    // record (the builder unit is in the work set, which the record guarantees).
    if (spawnedIds.has(tool.builderUnitId)) {
      edges.push({
        id: `built:${tool.builderUnitId}->${tool.capability}`,
        kind: "dependency",
        from: unitNodeId(tool.builderUnitId),
        to: toolNodeId(tool.capability),
        backing: { kind: "dependency", from: tool.builderUnitId, to: tool.capability },
      });
    }

    // One consumed-tool edge per real consumption record: a downstream unit that
    // actually ran the tool. The edge runs from the tool to the consumer, backed
    // by the real consumption record, so it maps to a genuine use, not a link.
    for (const consumption of snapshot.toolConsumptions ?? []) {
      if (consumption.capability !== tool.capability) {
        continue;
      }
      if (!spawnedIds.has(consumption.consumerUnitId)) {
        continue;
      }
      edges.push({
        id: `consumed:${tool.capability}->${consumption.consumerUnitId}`,
        kind: "consumed-tool",
        from: toolNodeId(tool.capability),
        to: unitNodeId(consumption.consumerUnitId),
        backing: {
          kind: "tool-consumption",
          capability: consumption.capability,
          consumerUnitId: consumption.consumerUnitId,
          at: consumption.at,
        },
      });
    }
  }

  // The bounded CHANGE-LEVEL model-escalation ladder, drawn as its own honest
  // nodes and edges and kept wholly separate from the human-escalation
  // `escalated` flag. After a wave completed and its work integrated, the app
  // gate ran ONCE for the whole change (one `verify` node per round, green on
  // pass and red on fail). On a change-level fail the implicated units were
  // re-fanned on a stronger model (one `retry` node per round) reached by a
  // `model-escalation` edge from the failing verify of the previous round. The
  // chain renders as goal -> verify round 1 -> [fail] -> retry round 2 ->
  // verify round 2 -> outcome, hung off the goal (the change), so the beat is
  // visible and every node/edge is backed by a real recorded change-level
  // attempt.
  const verifyAttempts = snapshot.verifyAttempts ?? [];
  const retryAttempts = snapshot.retryAttempts ?? [];

  for (const attempt of verifyAttempts) {
    const status: WorkUnitStatus = attempt.outcome === "pass" ? "verified" : "failed";
    const verifyNode: GraphNode = {
      id: verifyNodeId(snapshot.id, attempt.round),
      kind: "verify",
      // A readable label, e.g. "verify round 1 (app gate)", with the verdict so
      // the console shows pass/fail without a cryptic id.
      label: `verify round ${attempt.round} (app gate) ${attempt.outcome}`,
      status,
      verified: attempt.outcome === "pass",
      escalated: false,
      backing: {
        kind: "verify-attempt",
        changeId: snapshot.id,
        round: attempt.round,
        outcome: attempt.outcome,
        ...(attempt.gateCommand ? { gateCommand: attempt.gateCommand } : {}),
        ...(attempt.failingOutput ? { failingOutput: attempt.failingOutput } : {}),
        ...(attempt.implicatedUnits && attempt.implicatedUnits.length > 0
          ? { implicatedUnits: attempt.implicatedUnits }
          : {}),
        ...(attempt.refanSource ? { refanSource: attempt.refanSource } : {}),
      },
    };
    nodes.push(assertBacked(verifyNode, snapshot));

    // The integrated change flows into verification each round: round 1 flows
    // from the goal (the whole change after the first wave), a later round flows
    // from that round's retry node. Drawn as a data-flow edge, backed by the
    // attempt's own existence.
    const fromId =
      attempt.round <= 1
        ? goalNodeId(snapshot.id)
        : retryNodeId(snapshot.id, attempt.round);
    edges.push({
      id: `verify-flow:${snapshot.id}#${attempt.round}`,
      // The verify flow is ladder control-flow (the integrated change flows into
      // each round's gate), not a declared WorkGraph dependency and not an
      // Artifact event, so it rides the `trigger` kind. Its backing still records
      // the attempt's own existence.
      kind: "trigger",
      from: fromId,
      to: verifyNodeId(snapshot.id, attempt.round),
      backing: { kind: "dependency", from: snapshot.id, to: `verify#${attempt.round}` },
    });
  }

  for (const retry of retryAttempts) {
    const unitCount = retry.implicatedUnits.length;
    const retryNode: GraphNode = {
      id: retryNodeId(snapshot.id, retry.round),
      kind: "retry",
      // Running until its own verify lands; the following verify node carries
      // the pass/fail. A readable label, e.g. "retry round 2: glm-5.3 (2 units)".
      label: `retry round ${retry.round}: ${retry.toModel || "escalation"} (${unitCount} unit${
        unitCount === 1 ? "" : "s"
      })`,
      status: "running",
      verified: false,
      escalated: false,
      backing: {
        kind: "retry-attempt",
        changeId: snapshot.id,
        round: retry.round,
        fromModel: retry.fromModel,
        toModel: retry.toModel,
        implicatedUnits: retry.implicatedUnits,
        reason: retry.reason,
        ...(retry.refanSource ? { refanSource: retry.refanSource } : {}),
      },
    };
    nodes.push(assertBacked(retryNode, snapshot));

    // The model-escalation edge: the FAILING verify of the previous round
    // escalated to this retry on a stronger model. Only drawn when the previous
    // verify is a real recorded failing round, so the hop is backed by both the
    // retry record and the failing verify it followed. This is the base ->
    // escalation beat, distinct from the human-escalation flag and the lease
    // edge.
    const prevRound = retry.round - 1;
    const prevVerifyFailed = verifyAttempts.some(
      (a) => a.round === prevRound && a.outcome === "fail",
    );
    if (prevVerifyFailed) {
      edges.push({
        id: `model-escalation:${snapshot.id}#${prevRound}->${retry.round}`,
        // The escalation hop is ladder control-flow (a verify-fail caused this
        // retry on a stronger model), not a declared dependency and not an
        // Artifact event, so it rides the `trigger` kind. Its backing still
        // records the full model-escalation provenance, so nothing honest is
        // lost.
        kind: "trigger",
        from: verifyNodeId(snapshot.id, prevRound),
        to: retryNodeId(snapshot.id, retry.round),
        backing: {
          kind: "model-escalation",
          changeId: snapshot.id,
          round: retry.round,
          fromModel: retry.fromModel,
          toModel: retry.toModel,
        },
      });
    }

    // The round-N RE-PLAN planner node: when this retry round was driven by a
    // LIVE re-plan (refanSource "re-plan"), a configured re-plan transport
    // revised the unit set to re-fan. A re-plan is just the planner running
    // again for this round, so it renders as a PLAIN `planner` node (same
    // triangle, same teal, same detail panel as the kickoff planner), positioned
    // BETWEEN the failing verify of the previous round and this round's retry
    // agents, with `trigger` edges verify(failed) -> planner -> retry-agents so
    // the graph shows the ladder control-flow that caused the retry. Its
    // plan-like detail (the round, the revised unit set it chose to re-fan, and
    // the model) is derived from THIS retry record (snapshot.plan is a single
    // kickoff record and does not carry per-round re-plans), so a round-N planner
    // node is keyed by its round. It is backed by this retry's re-plan decision
    // (assertBacked rejects an unbacked round-N planner node), so an
    // offline/attribution round (no re-plan) draws no re-plan planner node and
    // the parse/attribution path is unchanged. It is emitted BEFORE its edges so
    // every edge endpoint is in the node set.
    const replanned = retry.refanSource === "re-plan";
    if (replanned) {
      const replanCount = retry.implicatedUnits.length;
      // Build the planner detail from the real recorded re-plan retry: resolve
      // each revised unit id to its objective from the Change's WorkUnits (as the
      // kickoff planner detail does), carry the agent count (= number of revised
      // units), the escalation model as the plan model, and reuse the recorded
      // plan's frozen contracts when present. This is derived wholly from the
      // retry record (and the Change's own units), so it is backed exactly like
      // the node.
      const replanUnits: PlannerUnitDetail[] = retry.implicatedUnits.map((unitId) => {
        const unit = snapshot.work.find((u) => u.id === unitId);
        return { id: unitId, objective: unit?.objective ?? "" };
      });
      const replanDetail: PlannerDetailSnapshot = {
        source: "planner",
        model: retry.toModel,
        units: replanUnits,
        agentCount: replanUnits.length,
        contracts: snapshot.plan ? [...snapshot.plan.contracts] : [],
      };
      const replanNode: GraphNode = {
        id: replanNodeId(snapshot.id, retry.round),
        kind: "planner",
        // A planner-style label naming the round, the revised unit count, and the
        // model, e.g. "re-plan round 2: glm-5.3 (1 unit)".
        label: `re-plan round ${retry.round}: ${retry.toModel || "escalation"} (${replanCount} unit${
          replanCount === 1 ? "" : "s"
        })`,
        // Mirror the kickoff planner node's status/verified (integrated/true).
        status: "integrated",
        verified: true,
        escalated: false,
        plannerDetail: replanDetail,
        backing: { kind: "planner", changeId: snapshot.id, source: "planner", round: retry.round },
      };
      nodes.push(assertBacked(replanNode, snapshot));

      // The `trigger` edge verify(failed) -> planner(re-plan): the failing verify
      // of the previous round caused the re-plan (ladder control-flow, not an
      // Artifact event). Only drawn when that previous verify is a real recorded
      // failing round, so the hop is backed by both the re-plan record and the
      // failing verify it followed.
      if (prevVerifyFailed) {
        edges.push({
          id: `replan-trigger:${snapshot.id}#${prevRound}->${retry.round}`,
          kind: "trigger",
          from: verifyNodeId(snapshot.id, prevRound),
          to: replanNodeId(snapshot.id, retry.round),
          backing: {
            kind: "model-escalation",
            changeId: snapshot.id,
            round: retry.round,
            fromModel: retry.fromModel,
            toModel: retry.toModel,
          },
        });
      }
    }

    // The round-N agent instances: one FRESH agent node per implicated unit the
    // retry re-ran on the escalation model, materialized BENEATH the retry node
    // rather than pointing an edge back at the original unit node. Each is keyed
    // by (unitId, round) and backed by the real recorded retry-attempt plus that
    // retry's membership of the unit, so round N and round N+1 get distinct
    // instances for the same unit. The edge runs retry -> round-N agent, so the
    // console lays the re-run agents out below their retry (the second wave the
    // user expected to see), and the original unit node is left untouched. Only
    // drawn for a unit that exists in the snapshot (the retry record already
    // validates its implicated units; the projection stays defensive).
    for (const unitId of retry.implicatedUnits) {
      const unit = snapshot.work.find((u) => u.id === unitId);
      if (!unit) {
        continue;
      }
      // Read the recorded round-N agent instance for (unitId, round): a retry
      // round's re-fanned unit is tracked as a BRAND NEW agent with its OWN
      // recorded workspace and a real status lifecycle, exactly like a kickoff
      // agent. The node's status/verified/workspace/activity/detail come from
      // THIS record rather than a hardcoded literal, so the node moves blue
      // (running) -> green (integrated) / red (failed) like a kickoff node. The
      // node is only emitted once that record has materialized (gated below), so
      // round-N agents stagger in like the kickoff wave.
      const roundAgent = (snapshot.roundAgents ?? []).find(
        (a) => a.unitId === unitId && a.round === retry.round,
      );
      // Stagger round-N agents like the kickoff wave: withhold this round node
      // (and its re-fan edge) until a real round-agent instance for (unitId,
      // round) has materialized (leased/run), rather than emitting every
      // implicated unit's node at once when the retry record lands. A retry with
      // no recorded round-agent yet draws its retry node but no round agents, so
      // the second wave pops in one by one as each round agent leases.
      if (!isRoundAgentSpawned(roundAgent)) {
        continue;
      }
      const roundStatus: WorkUnitStatus = roundAgent?.status ?? "running";
      const roundExtras = {
        ...(roundAgent?.workspace ? { workspace: roundAgent.workspace } : {}),
        ...(roundAgent?.activity && roundAgent.activity.length > 0
          ? { activity: roundAgent.activity }
          : {}),
        ...(roundAgent?.detail ? { detail: roundAgent.detail } : {}),
      };
      const roundNode: GraphNode = {
        id: roundAgentNodeId(snapshot.id, retry.round, unitId),
        kind: "agent",
        // A readable label, e.g. "users (retry 2)", so the console shows which
        // unit this round-N instance re-ran.
        label: `${unitId} (retry ${retry.round})`,
        status: roundStatus,
        verified: isVerified(roundStatus),
        escalated: false,
        ...roundExtras,
        backing: {
          kind: "round-agent",
          changeId: snapshot.id,
          round: retry.round,
          unitId,
          toModel: retry.toModel,
        },
      };
      nodes.push(assertBacked(roundNode, snapshot));

      edges.push({
        id: `re-fan:${snapshot.id}#${retry.round}->${unitId}`,
        // The per-unit re-fan is ladder control-flow (the round-N agent was
        // caused by the retry that fed it its escalation edit), not a declared
        // dependency and not an Artifact event, so it rides the `trigger` kind.
        // Its backing still records the full re-fan provenance.
        kind: "trigger",
        from: retryNodeId(snapshot.id, retry.round),
        to: roundAgentNodeId(snapshot.id, retry.round, unitId),
        backing: {
          kind: "re-fan",
          changeId: snapshot.id,
          round: retry.round,
          unitId,
          toModel: retry.toModel,
        },
      });

      // When this round was driven by a live re-plan, also draw the `trigger`
      // edge planner(re-plan) -> round-N agent, so the control-flow chain reads
      // verify(failed) -> planner(re-plan) -> retry-agents. It is backed by the
      // same re-fan provenance as the retry -> agent edge; the re-plan planner
      // node it points from is itself backed by the recorded re-plan (gated
      // above), so the edge never references a node the graph did not emit.
      if (replanned) {
        edges.push({
          id: `replan-refan:${snapshot.id}#${retry.round}->${unitId}`,
          kind: "trigger",
          from: replanNodeId(snapshot.id, retry.round),
          to: roundAgentNodeId(snapshot.id, retry.round, unitId),
          backing: {
            kind: "re-fan",
            changeId: snapshot.id,
            round: retry.round,
            unitId,
            toModel: retry.toModel,
          },
        });
      }
    }
  }

  // The Jev typed-decision nodes, when the state records any. Each decision at
  // one juncture becomes a `jev` node placed near that juncture by a dependency
  // edge from its anchor: plan-review hangs off the planner (or the goal when
  // there is no planner), attribution hangs off the retry node (the verify-fail
  // -> retry hop), and fix-confidence hangs off the latest verify node. The node
  // greens when the decision was ACCEPTED and reds when it ESCALATED, so a glance
  // shows confident-use vs escalate. Each is backed by the real recorded decision
  // (assertBacked rejects an unbacked jev node), so a jev node always maps to a
  // genuine decision; a fix-confidence decision is advisory only and never
  // changes any verdict. The offline path records no decisions, so no jev node
  // appears and the heuristic + gate path is unchanged.
  const jevDecisions = snapshot.jevDecisions ?? [];
  // Per-juncture index so multiple decisions at one juncture get distinct ids.
  const jevIndexByJuncture = new Map<JevJuncture, number>();
  // Anchors: the planner node (plan-review), the latest retry node (attribution),
  // and the latest verify node (fix-confidence). Each falls back to the goal when
  // its preferred anchor is absent, so a jev node is always rooted.
  const latestVerifyRound =
    verifyAttempts.length > 0
      ? verifyAttempts.reduce((a, b) => (b.round >= a.round ? b : a)).round
      : undefined;
  const latestRetryRound =
    retryAttempts.length > 0
      ? retryAttempts.reduce((a, b) => (b.round >= a.round ? b : a)).round
      : undefined;
  const jevAnchorFor = (juncture: JevJuncture): string => {
    if (juncture === "plan-review" && plan) {
      return plannerNodeId(snapshot.id);
    }
    if (juncture === "attribution" && latestRetryRound !== undefined) {
      return retryNodeId(snapshot.id, latestRetryRound);
    }
    if (juncture === "fix-confidence" && latestVerifyRound !== undefined) {
      return verifyNodeId(snapshot.id, latestVerifyRound);
    }
    return goalNodeId(snapshot.id);
  };

  for (const decision of jevDecisions) {
    const index = jevIndexByJuncture.get(decision.juncture) ?? 0;
    jevIndexByJuncture.set(decision.juncture, index + 1);
    const id = jevNodeId(snapshot.id, decision.juncture, index);
    const jevDetail: JevDetailSnapshot = {
      juncture: decision.juncture,
      question: decision.question,
      answerType: decision.answerType,
      ...(decision.noul !== undefined ? { noul: decision.noul } : {}),
      ...(decision.choice !== undefined ? { choice: decision.choice } : {}),
      ...(decision.score !== undefined ? { score: decision.score } : {}),
      confidence: decision.confidence,
      ...(decision.probabilities !== undefined ? { probabilities: decision.probabilities } : {}),
      accepted: decision.accepted,
    };
    const jevNode: GraphNode = {
      id,
      kind: "jev",
      // A readable label naming the juncture and whether it was accepted, e.g.
      // "jev: plan-review accepted".
      label: `jev: ${decision.juncture} ${decision.accepted ? "accepted" : "escalated"}`,
      // The node greens when the decision was accepted (confident-use) and reads
      // as not-verified when it escalated. This is display only; it never changes
      // the authoritative gate verdict.
      status: decision.accepted ? "integrated" : "running",
      verified: decision.accepted,
      escalated: false,
      jevDetail,
      backing: {
        kind: "jev-decision",
        changeId: snapshot.id,
        juncture: decision.juncture,
        question: decision.question,
        answerType: decision.answerType,
        confidence: decision.confidence,
      },
    };
    nodes.push(assertBacked(jevNode, snapshot));
    const anchor = jevAnchorFor(decision.juncture);
    edges.push({
      id: `jev-flow:${snapshot.id}#${decision.juncture}:${index}`,
      kind: "dependency",
      from: anchor,
      to: id,
      backing: { kind: "dependency", from: snapshot.id, to: `jev#${decision.juncture}:${index}` },
    });
  }

  return { changeId: snapshot.id, nodes, edges, dial: snapshot.dial };
}

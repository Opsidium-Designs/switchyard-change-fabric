import { DurableObject } from "cloudflare:workers";

import {
  appendDiscoveredUnits,
  buildWorkGraph,
  detectPathCollisions,
  normalizeDial,
  parseChangeSpec,
  planWriteLeases,
  recruit,
  runnableUnits,
  workUnitStatuses,
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

import type { Env } from "./env.ts";

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
  /** A short, human-readable reason the ladder escalated (never a secret). */
  readonly reason: string;
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
  };
}

/** The live, serializable projection of a Change's orchestration state. */
export interface ChangeStateView {
  readonly id: string;
  readonly objective: string;
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
   * The round-N agent instances recorded for this Change: each is a retry
   * round's re-fanned unit running as a BRAND NEW agent keyed by (unitId, round),
   * with its OWN recorded Artifact repo and a real status lifecycle. They back
   * the graph's round-N `agent` nodes, so a round-N node's status/workspace/
   * activity/detail come from recorded state and move exactly like a kickoff
   * agent (blue running -> green integrated / red failed).
   */
  readonly roundAgents: readonly RoundAgentView[];
}

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
  /** The human-readable question the engine needs answered. */
  readonly question: string;
  /** The candidate answers the human may choose among (advisory, not enforced). */
  readonly options: readonly string[];
  readonly status: EscalationStatus;
  /** The human's decision text, once resolved. */
  readonly decision?: string;
  readonly raisedAt: string;
  readonly resolvedAt?: string;
}

/** The input to raise an escalation (ids and timestamps are assigned by the DO). */
export interface RaiseEscalationInput {
  readonly kind: EscalationKind;
  readonly unitId?: string;
  readonly path?: string;
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
export class ChangeState extends DurableObject<Env> {
  /** Create (or replace) the Change held by this object from spec YAML text. */
  async createFromSpec(specYaml: string): Promise<ChangeStateView> {
    const change = parseChangeSpec(specYaml);
    await this.ctx.storage.put("change", change);
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
    return this.view();
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
        e.path === input.path,
    );
    if (existing) {
      return existing;
    }
    const escalation: Escalation = {
      id: `esc-${escalations.length + 1}-${Date.now().toString(36)}`,
      kind: input.kind,
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
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
    escalations[index] = resolved;
    await this.ctx.storage.put("escalations", escalations);
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
    return { completedUnit, recruited: plan.recruit, done, event };
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
      at: new Date().toISOString(),
    };
    attempts.push(stored);
    await this.ctx.storage.put("verifyAttempts", attempts);
    return stored;
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
      reason: sanitizeReason(input.reason),
      at: new Date().toISOString(),
    };
    attempts.push(stored);
    await this.ctx.storage.put("retryAttempts", attempts);
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
    const leasePlan = planWriteLeases(newChange, detectPathCollisions(newChange));
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
      // The round-N agent instances, ordered by (round, unitId) for a stable
      // projection. Each is a retry round's re-fanned unit tracked as a real
      // agent with its own recorded workspace and status lifecycle.
      roundAgents: Object.values(roundAgents).sort((a, b) =>
        a.round !== b.round ? a.round - b.round : a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0,
      ),
    };
  }

  private async loadChange(): Promise<Change> {
    const change = await this.ctx.storage.get<Change>("change");
    if (change === undefined) {
      throw new Error("Change not initialized");
    }
    return change;
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
    return planWriteLeases(change, detectPathCollisions(change));
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

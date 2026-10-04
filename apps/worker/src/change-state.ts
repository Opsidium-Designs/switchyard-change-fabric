import { DurableObject } from "cloudflare:workers";

import {
  buildWorkGraph,
  detectPathCollisions,
  normalizeDial,
  parseChangeSpec,
  recruit,
  runnableUnits,
  workUnitStatuses,
  type Change,
  type ConcurrencyDial,
  type Dependency,
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
    // Map from the backend workspace name a runner pushes to back to its unit
    // id, so a repo-pushed event (which carries the workspace, not the unit) can
    // recognize which WorkUnit finished.
    await this.ctx.storage.put("workspaceUnits", {} as Record<string, string>);
    // Map from unit id to its real workspace (Artifact repo) identity, recorded
    // when the unit is leased and kept past completion so a completed node still
    // reveals the real repo it ran in. The plaintext token is never stored here.
    await this.ctx.storage.put("workspaces", {} as Record<string, WorkspaceIdentity>);
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
    // In flight = runnable units an agent currently holds a lease on.
    const runnable = runnableUnits(change, completed);
    // Agents still running: leased but not yet completed. The DO releases a
    // lease on completion, so this normally equals the lease count; filtering by
    // completed keeps the ceiling correct even if a completed lease is retained.
    const completedSet = new Set(completed);
    const inFlight = Object.keys(leases).filter((id) => !completedSet.has(id)).length;
    // Only recruit for units that are runnable AND not already leased.
    const openRunnable = runnable.filter((id) => !leases[id]);
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
    const done = completed.length >= change.work.length && plan.recruit.length === 0;
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
    const statuses = workUnitStatuses(change, completed);
    const graph = buildWorkGraph(change);
    const collisions = detectPathCollisions(change);

    const work: WorkUnitView[] = change.work.map((unit) => {
      const base = statuses.get(unit.id) ?? "waiting";
      const leased = leases[unit.id] !== undefined;
      const workspace = workspaces[unit.id];
      return {
        id: unit.id,
        objective: unit.objective,
        dependsOn: unit.dependsOn,
        paths: unit.paths,
        // A leased, not-yet-complete unit reads as "running".
        status: base === "runnable" && leased ? "running" : base,
        leased,
        // Present once an agent has been recruited for this unit; kept past
        // completion so the node always reveals the real repo it ran in.
        ...(workspace ? { workspace } : {}),
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
}

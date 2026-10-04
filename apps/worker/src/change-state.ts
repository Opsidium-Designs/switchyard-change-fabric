import { DurableObject } from "cloudflare:workers";

import {
  buildWorkGraph,
  detectPathCollisions,
  parseChangeSpec,
  runnableUnits,
  workUnitStatuses,
  type Change,
  type Dependency,
  type PathCollision,
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

/** The live view of a single WorkUnit, as served to the console and CLI. */
export interface WorkUnitView {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
  /** Whether a runner currently holds a lease on this unit. */
  readonly leased: boolean;
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
    return this.view();
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
    return record;
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
    const statuses = workUnitStatuses(change, completed);
    const graph = buildWorkGraph(change);
    const collisions = detectPathCollisions(change);

    const work: WorkUnitView[] = change.work.map((unit) => {
      const base = statuses.get(unit.id) ?? "waiting";
      const leased = leases[unit.id] !== undefined;
      return {
        id: unit.id,
        objective: unit.objective,
        dependsOn: unit.dependsOn,
        paths: unit.paths,
        // A leased, not-yet-complete unit reads as "running".
        status: base === "runnable" && leased ? "running" : base,
        leased,
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
}

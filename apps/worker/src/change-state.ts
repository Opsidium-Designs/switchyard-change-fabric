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
}

/** The payload returned when a runner leases a WorkUnit. */
export interface LeaseRecord extends LeaseWorkspace {
  readonly unitId: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly baselineRef: string;
  readonly leasedAt: string;
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
    }
    const leases = await this.loadLeases();
    if (leases[unitId]) {
      delete leases[unitId];
      await this.ctx.storage.put("leases", leases);
    }
    return this.view();
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
}

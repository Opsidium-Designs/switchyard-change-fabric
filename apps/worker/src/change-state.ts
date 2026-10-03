import { DurableObject } from "cloudflare:workers";

import {
  buildWorkGraph,
  detectPathCollisions,
  parseChangeSpec,
  workUnitStatuses,
  type Change,
  type Dependency,
  type PathCollision,
  type WorkUnitStatus,
} from "@switchyard-change/change-core";

import type { Env } from "./env.ts";

/** The live view of a single WorkUnit, as served to the console and CLI. */
export interface WorkUnitView {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
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
}

/**
 * ChangeState: single-owner, serialized Durable Object holding the live Change
 * projection.
 *
 * It stores the parsed Change plus the set of completed WorkUnit ids, and
 * derives runnable/waiting/integrated status on read using the pure scheduling
 * functions in change-core. Marking a WorkUnit complete is the orchestration
 * signal this milestone exercises; the actual runner and Artifact workspace
 * wiring that would mark completion automatically land in a later milestone.
 */
export class ChangeState extends DurableObject<Env> {
  /** Create (or replace) the Change held by this object from spec YAML text. */
  async createFromSpec(specYaml: string): Promise<ChangeStateView> {
    const change = parseChangeSpec(specYaml);
    await this.ctx.storage.put("change", change);
    await this.ctx.storage.put("completed", [] as string[]);
    return this.view();
  }

  /** Mark a WorkUnit complete, which may make its dependents runnable. */
  async completeUnit(unitId: string): Promise<ChangeStateView> {
    const change = await this.loadChange();
    if (!change.work.some((unit) => unit.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const completed = await this.loadCompleted();
    if (!completed.includes(unitId)) {
      completed.push(unitId);
      await this.ctx.storage.put("completed", completed);
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
    const statuses = workUnitStatuses(change, completed);
    const graph = buildWorkGraph(change);
    const collisions = detectPathCollisions(change);

    const work: WorkUnitView[] = change.work.map((unit) => ({
      id: unit.id,
      objective: unit.objective,
      dependsOn: unit.dependsOn,
      paths: unit.paths,
      status: statuses.get(unit.id) ?? "waiting",
    }));

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
}

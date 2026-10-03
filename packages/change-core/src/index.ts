/**
 * change-core — portable coordination contracts for the Switchyard Change Fabric.
 *
 * This is the portable public subset: Change / WorkUnit / Dependency / WorkGraph
 * as a clean coordination *projection*. It deliberately holds no tenant / OU /
 * workspace-governance concepts, so it can be embedded or called as a service by
 * a larger system without carrying that system's internals.
 *
 * M0 scope: typed stubs the Worker imports. Real schema validation, YAML parsing,
 * and WorkGraph scheduling land in M1.
 */

/** Assurance level requested for a Change (illustrative in the spike). */
export type AssuranceLevel = "none" | "standard" | "strict";

/** Lifecycle state of a WorkUnit within its WorkGraph. */
export type WorkUnitStatus =
  | "waiting" // dependencies not yet satisfied
  | "runnable" // ready to be leased by a runner
  | "running" // leased and executing
  | "verified" // execution verified
  | "failed"
  | "integrated";

/** A single runnable slice of a Change. */
export interface WorkUnit {
  readonly id: string;
  readonly objective: string;
  /** IDs of WorkUnits this one depends on (forms the WorkGraph DAG). */
  readonly dependsOn: readonly string[];
  /** Declared path globs this WorkUnit is allowed to touch (scope + leases). */
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
}

/** The agent-native coordination view of delivering one unit of work. */
export interface Change {
  readonly id: string;
  readonly objective: string;
  /** Source Git baseline, e.g. "HEAD". */
  readonly baseline: string;
  readonly budgetUsd: number;
  readonly assurance: AssuranceLevel;
  readonly work: readonly WorkUnit[];
}

/** A dependency edge in the WorkGraph. */
export interface Dependency {
  readonly from: string;
  readonly to: string;
}

/** The dependency DAG derived from a Change's WorkUnits. */
export interface WorkGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly Dependency[];
}

/**
 * Derive the WorkGraph (DAG) from a Change's declared WorkUnit dependencies.
 * Pure and deterministic; no cycle detection yet (M1).
 */
export function buildWorkGraph(change: Change): WorkGraph {
  const nodes = change.work.map((unit) => unit.id);
  const edges: Dependency[] = [];
  for (const unit of change.work) {
    for (const dep of unit.dependsOn) {
      edges.push({ from: dep, to: unit.id });
    }
  }
  return { nodes, edges };
}

/**
 * Detect declared path collisions between WorkUnits — the deterministic conflict
 * signal. Returns the set of paths claimed by more than one WorkUnit.
 * Exact-match only in M0; glob-aware lease logic is M4.
 */
export function detectPathCollisions(change: Change): readonly string[] {
  const owners = new Map<string, Set<string>>();
  for (const unit of change.work) {
    for (const path of unit.paths) {
      const set = owners.get(path) ?? new Set<string>();
      set.add(unit.id);
      owners.set(path, set);
    }
  }
  const collisions: string[] = [];
  for (const [path, unitIds] of owners) {
    if (unitIds.size > 1) {
      collisions.push(path);
    }
  }
  return collisions;
}

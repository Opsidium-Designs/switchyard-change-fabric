/**
 * Core coordination contracts for the Switchyard Change Fabric.
 *
 * This is the portable public subset: Change / WorkUnit / Dependency / WorkGraph
 * as a clean coordination projection. It holds no tenant or workspace-governance
 * concepts, so it can be embedded or called as a service without carrying those
 * internals.
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
  /** Declared path globs this WorkUnit is allowed to touch (scope and leases). */
  readonly paths: readonly string[];
}

/** The coordination view of delivering one unit of work. */
export interface Change {
  readonly id: string;
  readonly objective: string;
  /** Source Git baseline, e.g. "HEAD". */
  readonly baseline: string;
  readonly budgetUsd: number;
  readonly assurance: AssuranceLevel;
  readonly work: readonly WorkUnit[];
}

/** A dependency edge in the WorkGraph (from a prerequisite to a dependent). */
export interface Dependency {
  readonly from: string;
  readonly to: string;
}

/** The dependency DAG derived from a Change's WorkUnits. */
export interface WorkGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly Dependency[];
}

/** A declared path claimed by more than one WorkUnit. */
export interface PathCollision {
  readonly path: string;
  /** IDs of the WorkUnits that both declare this path, sorted. */
  readonly unitIds: readonly string[];
}

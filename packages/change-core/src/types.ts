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
  /**
   * The cohesion blueprint, when the Change was decomposed by module from a
   * clearly modular repo. It names the owned modules, the frozen read-only
   * contracts at the seams (owned by no WorkUnit), and the inter-module
   * dependency edges, so later stages (the scheduler, the integrator, the graph
   * projection) can read the module boundaries and the frozen interface without
   * re-deriving them. Absent for a non-modular Change (the single-unit or
   * per-file shape), in which case there are no frozen contracts to carry.
   */
  readonly blueprint?: ChangeBlueprint;
}

/** One owned module carried on a Change: exactly one WorkUnit writes its file(s). */
export interface ChangeBlueprintModule {
  /** The owning WorkUnit's id. */
  readonly unitId: string;
  /** The source file paths this module owns (disjoint across modules). */
  readonly paths: readonly string[];
  /** The ids of other owner units this module depends on (import order). */
  readonly dependsOn: readonly string[];
}

/** A frozen read-only interface carried on a Change (owned by no WorkUnit). */
export interface ChangeBlueprintContract {
  /** The seam file path (read-only; no WorkUnit may rewrite it). */
  readonly path: string;
  /** How many source files import this seam (its import in-degree). */
  readonly importedByCount: number;
}

/**
 * The portable projection of the cohesion blueprint carried on a Change. It is
 * the module boundaries and the frozen interface, expressed in terms of the
 * Change's own WorkUnit ids, so any later stage reading the Change can see which
 * unit owns which module and which seam files are frozen read-only.
 */
export interface ChangeBlueprint {
  readonly modules: readonly ChangeBlueprintModule[];
  readonly contracts: readonly ChangeBlueprintContract[];
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

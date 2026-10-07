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
  /**
   * The recorded plan that drove this Change, present only when the Change was
   * produced by the inference-backed, schema-constrained planner pass (or its
   * heuristic fallback). It rides the Change so it survives the spec YAML
   * round-trip to the Worker and is exposed by the live/offline state views,
   * which lets the graph projection back a real `planner` node (goal -> planner
   * -> agents). Absent on the plain heuristic decomposition path, so that path
   * carries no plan and the graph has no planner node, exactly as before.
   */
  readonly plan?: ChangePlan;
}

/** How a recorded plan was produced, so a reader can tell planner from fallback. */
export type ChangePlanSource = "planner" | "heuristic-fallback";

/** One unit a plan proposed, projected onto the Change's own unit ids. */
export interface ChangePlanUnit {
  readonly id: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly dependsOn: readonly string[];
}

/**
 * The portable record of how a Change was decomposed, carried on the Change so
 * it round-trips through the spec and the state views. It is the structural twin
 * of the planner pass's RecordedPlan, declared here so the core type carries no
 * dependency on the planner module.
 */
export interface ChangePlan {
  /** Whether the inference planner produced the plan, or the heuristic fallback. */
  readonly source: ChangePlanSource;
  /** The model that produced an accepted plan (empty on the heuristic fallback). */
  readonly model: string;
  /** The planned units projected onto the Change's own unit ids. */
  readonly units: readonly ChangePlanUnit[];
  /** The frozen read-only contract paths the plan froze (owned by no unit). */
  readonly contracts: readonly string[];
  /**
   * A readable, secret-free summary of what the planner was asked: the goal plus
   * the structural module map it was handed. Carried on the Change so it survives
   * the spec round-trip and is surfaced in the console's planner detail panel.
   * Optional and empty-safe: absent on a hand-authored or fallback plan.
   */
  readonly promptSummary?: string;
  /**
   * The model's short, optional explanation of WHY this decomposition. Present
   * only when the planner model supplied one; absent otherwise. Purely
   * explanatory and surfaced in the console's planner detail panel.
   */
  readonly rationale?: string;
}

/** One owned module carried on a Change: exactly one WorkUnit writes its file(s). */
export interface ChangeBlueprintModule {
  /** The owning WorkUnit's id. */
  readonly unitId: string;
  /** The source file paths this module owns (disjoint across modules). */
  readonly paths: readonly string[];
  /** The ids of other owner units this module depends on (import order). */
  readonly dependsOn: readonly string[];
  /**
   * The names of the symbols this module's file(s) export: its EXPORTED
   * INTERFACE, a contract other modules (and the entry point) import by name.
   * Carried on the Change so a later stage can tell the owning unit's agent to
   * keep every one of these present and exported when it changes the
   * implementation. A pure structural projection of the snapshot's parsed
   * exports; empty when the module exports nothing (then no instruction is
   * added, so existing callers are unchanged).
   */
  readonly exports: readonly string[];
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

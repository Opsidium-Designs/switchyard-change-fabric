/**
 * Pure, deterministic WorkGraph construction and scheduling.
 *
 * These functions take an already-parsed Change and compute coordination facts:
 * the dependency graph, which WorkUnits are runnable versus waiting given a set
 * of completed units, and declared path collisions. No I/O, no randomness, no
 * clock access, so results are reproducible and easy to unit test.
 */

import type {
  Change,
  Dependency,
  PathCollision,
  WorkGraph,
  WorkUnit,
  WorkUnitStatus,
} from "./types.ts";

/**
 * Derive the WorkGraph (DAG) from a Change's declared WorkUnit dependencies.
 * Nodes keep the declared WorkUnit order; edges run from each prerequisite to
 * the unit that depends on it.
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
 * Detect a dependency cycle in the WorkGraph using depth-first search.
 * Returns the first cycle found as an ordered list of WorkUnit ids (the repeated
 * id closes the loop), or undefined when the graph is acyclic.
 */
export function findDependencyCycle(change: Change): readonly string[] | undefined {
  const dependsOn = dependencyMap(change);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | undefined => {
    if (done.has(id)) {
      return undefined;
    }
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    visiting.add(id);
    stack.push(id);
    for (const dep of dependsOn.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return undefined;
  };

  for (const unit of change.work) {
    const cycle = visit(unit.id);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

/**
 * Return the ids of WorkUnits whose dependencies are all in `completed` and that
 * are not themselves completed. These are the units ready to be leased now.
 * Order follows the Change's declared WorkUnit order for determinism.
 */
export function runnableUnits(
  change: Change,
  completed: Iterable<string>,
): readonly string[] {
  const completedSet = new Set(completed);
  return change.work
    .filter((unit) => !completedSet.has(unit.id))
    .filter((unit) => unit.dependsOn.every((dep) => completedSet.has(dep)))
    .map((unit) => unit.id);
}

/**
 * Return the ids of WorkUnits that are not completed and still have at least one
 * unmet dependency. These are blocked until their prerequisites finish.
 */
export function waitingUnits(
  change: Change,
  completed: Iterable<string>,
): readonly string[] {
  const completedSet = new Set(completed);
  return change.work
    .filter((unit) => !completedSet.has(unit.id))
    .filter((unit) => unit.dependsOn.some((dep) => !completedSet.has(dep)))
    .map((unit) => unit.id);
}

/**
 * Compute the coordination status of every WorkUnit given the completed set.
 * Completed units report "integrated"; the rest are "runnable" or "waiting".
 * Returned in the Change's declared WorkUnit order.
 */
export function workUnitStatuses(
  change: Change,
  completed: Iterable<string>,
): ReadonlyMap<string, WorkUnitStatus> {
  const completedSet = new Set(completed);
  const result = new Map<string, WorkUnitStatus>();
  for (const unit of change.work) {
    if (completedSet.has(unit.id)) {
      result.set(unit.id, "integrated");
      continue;
    }
    const ready = unit.dependsOn.every((dep) => completedSet.has(dep));
    result.set(unit.id, ready ? "runnable" : "waiting");
  }
  return result;
}

/**
 * Detect declared path collisions between WorkUnits. A collision is any path
 * declared by two or more WorkUnits. Exact-match on the declared path string;
 * glob-aware overlap is out of scope for this function. Results are sorted by
 * path, with each collision's unit ids sorted, so output is deterministic.
 */
export function detectPathCollisions(change: Change): readonly PathCollision[] {
  const owners = new Map<string, Set<string>>();
  for (const unit of change.work) {
    for (const path of unit.paths) {
      const set = owners.get(path) ?? new Set<string>();
      set.add(unit.id);
      owners.set(path, set);
    }
  }
  const collisions: PathCollision[] = [];
  for (const [path, unitIds] of owners) {
    if (unitIds.size > 1) {
      collisions.push({ path, unitIds: [...unitIds].sort() });
    }
  }
  collisions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return collisions;
}

/** Build a lookup from WorkUnit id to its declared dependency ids. */
function dependencyMap(change: Change): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const unit of change.work) {
    map.set(unit.id, unit.dependsOn);
  }
  return map;
}

/** Convenience: look up a WorkUnit by id, or undefined. */
export function findWorkUnit(change: Change, id: string): WorkUnit | undefined {
  return change.work.find((unit) => unit.id === id);
}

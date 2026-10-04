/**
 * Appending DISCOVERED WorkUnits to a live Change, with the guards that keep
 * every appended unit real and backed.
 *
 * The WorkGraph a Change starts with is normally fixed at creation. Dynamic
 * branching is the case where completing one unit REVEALS more work: the agent
 * that fixed a bug finds the same fix is needed in other files, so the engine
 * adds those follow-up units to the live graph and recruits them in later waves.
 * To honor the no-unbacked-node rule, that growth must be a real state change:
 * the new units become part of the Change's `work` set, and everything
 * downstream (runnable/waiting computation, recruitment, the graph projection)
 * picks them up unchanged because it all reads `change.work`.
 *
 * This module is the single, pure place that validates and performs that append,
 * so the offline control surface and the live Durable Object cannot drift in how
 * discovered work is admitted. It is free of I/O and goal-specific logic.
 */

import type { Change, WorkUnit } from "./types.ts";

/** A follow-up WorkUnit discovered by a completing unit, before it is rooted. */
export interface DiscoveredWorkUnit {
  /** A locally-unique id suffix; the parent id and a prefix make it unique. */
  readonly idSuffix: string;
  readonly objective: string;
  readonly paths: readonly string[];
  /** A short, human-readable reason this follow-up was discovered. */
  readonly reason?: string;
}

/** Thrown when a discovered-unit append would be invalid. */
export class DiscoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverError";
  }
}

/** The outcome of appending discovered units: the new Change plus what was added. */
export interface AppendResult {
  /** A new Change value whose `work` includes the appended units. */
  readonly change: Change;
  /** The fully-formed WorkUnits that were appended (rooted under the parent). */
  readonly added: readonly WorkUnit[];
}

/**
 * Build the full id of a discovered unit, namespaced under its discovering
 * parent so a discovered unit never collides with a declared one and the id
 * reads as "found by this parent". The suffix is sanitized to the id charset.
 */
export function discoveredUnitId(parentUnitId: string, idSuffix: string): string {
  const safeSuffix = idSuffix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${parentUnitId}+${safeSuffix || "found"}`;
}

/**
 * Append discovered follow-up units to a Change, returning a new Change value.
 *
 * The guards make the growth honest and keep every appended node backed:
 *   - the discovering parent must be a real WorkUnit in the Change;
 *   - each discovered unit must declare at least one path (it is scoped, exactly
 *     like a declared unit, so the appended node is backed and the executor has
 *     a real surface to touch);
 *   - each appended unit depends on its parent, so it is rooted in the DAG under
 *     the unit that found it (its node and its edge are both backed) and it only
 *     becomes runnable after the parent completes;
 *   - appended ids are made unique by namespacing under the parent; an append
 *     that would still collide with an existing id is rejected rather than
 *     silently dropped or duplicated.
 *
 * Idempotency is the caller's concern via the id namespace: re-appending the
 * same discovered suffix for the same parent yields the same id, which this
 * function rejects as a duplicate, so a re-driven engine does not pile up copies
 * (the caller treats an already-present id as a no-op).
 */
export function appendDiscoveredUnits(
  change: Change,
  parentUnitId: string,
  discovered: readonly DiscoveredWorkUnit[],
): AppendResult {
  const parent = change.work.find((u) => u.id === parentUnitId);
  if (!parent) {
    throw new DiscoverError(`unknown discovering WorkUnit: ${parentUnitId}`);
  }
  if (discovered.length === 0) {
    return { change, added: [] };
  }

  const existingIds = new Set(change.work.map((u) => u.id));
  const added: WorkUnit[] = [];
  const seenThisBatch = new Set<string>();

  for (const unit of discovered) {
    const paths = (unit.paths ?? []).filter((p) => typeof p === "string" && p.trim() !== "");
    if (paths.length === 0) {
      throw new DiscoverError(
        `discovered unit "${unit.idSuffix}" from ${parentUnitId} must declare at least one path`,
      );
    }
    const id = discoveredUnitId(parentUnitId, unit.idSuffix);
    if (existingIds.has(id) || seenThisBatch.has(id)) {
      throw new DiscoverError(`discovered unit id already exists: ${id}`);
    }
    seenThisBatch.add(id);
    added.push({
      id,
      objective:
        unit.objective.trim() !== ""
          ? unit.objective.trim()
          : `Follow-up discovered by ${parentUnitId}`,
      // Root the discovered unit under its parent so it is scheduled after the
      // parent and its node/edge are backed by a real dependency.
      dependsOn: [parentUnitId],
      paths: [...paths],
    });
  }

  const newChange: Change = { ...change, work: [...change.work, ...added] };
  return { change: newChange, added };
}

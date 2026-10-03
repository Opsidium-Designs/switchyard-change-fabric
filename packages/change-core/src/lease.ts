/**
 * Pure, deterministic write-lease coordination for colliding paths.
 *
 * change-core already detects declared path collisions (two or more WorkUnits
 * declaring the same path). This module decides what to do about them before
 * the work is integrated, so a shared path is never resolved by a silent
 * last-writer-wins at merge time.
 *
 * The policy is a single serialized owner per contested path: for each colliding
 * path, exactly one WorkUnit is granted the write lease and the others are made
 * to wait on it. The grant order is deterministic (the WorkUnit declared first
 * in the Change wins, falling back to id order), so the same Change always
 * produces the same plan. When a collision cannot be serialized without creating
 * a dependency cycle, the path is instead flagged for human attention rather
 * than coordinated automatically.
 *
 * No I/O, no clock, no randomness: a Change always yields the same LeasePlan.
 * The runtime single-owner guarantee is provided by the ChangeState Durable
 * Object, which serves one lease decision at a time; this module computes the
 * plan that Durable Object (or any serialized owner) hands out.
 */

import { findDependencyCycle } from "./graph.ts";
import type { Change, PathCollision, WorkUnit } from "./types.ts";

/** How a single contested path was coordinated. */
export type LeaseResolution = "serialized" | "flagged";

/**
 * One contested path and the decision made for it. For a serialized path,
 * `owner` holds the lease and `waiters` are blocked until the owner integrates.
 * For a flagged path the collision needs human attention and no automatic owner
 * is chosen.
 */
export interface LeaseDecision {
  readonly path: string;
  /** The colliding WorkUnit ids, sorted (mirrors PathCollision.unitIds). */
  readonly contenders: readonly string[];
  readonly resolution: LeaseResolution;
  /** The WorkUnit granted the lease, when the path was serialized. */
  readonly owner?: string;
  /** The WorkUnit ids told to wait for the owner, when serialized. */
  readonly waiters: readonly string[];
  /** A short, human-readable reason for the decision. */
  readonly reason: string;
}

/**
 * The whole coordination plan for a Change: the ordering constraints to apply
 * before integration and the decision recorded per contested path. `ordering`
 * is a list of extra "waiter waits for owner" edges to enforce; honoring them
 * guarantees a serialized single writer for each contested path.
 */
export interface LeasePlan {
  readonly changeId: string;
  readonly decisions: readonly LeaseDecision[];
  /** Extra dependency edges (waiter -> owner) that serialize the writers. */
  readonly ordering: readonly { readonly waiter: string; readonly owner: string }[];
  /** True when at least one contested path was flagged for attention. */
  readonly needsAttention: boolean;
}

/**
 * Compute the write-lease plan for a Change from its declared path collisions.
 *
 * For each collision the first-declared contender becomes the single owner and
 * every other contender is ordered to wait for it, unless adding those waits
 * would introduce a dependency cycle (for example two WorkUnits that each
 * already depend on the other through different paths). In that case the path is
 * flagged for attention and left for a human to resolve.
 */
export function planWriteLeases(
  change: Change,
  collisions: readonly PathCollision[],
): LeasePlan {
  const order = declaredOrder(change);
  const decisions: LeaseDecision[] = [];
  const ordering: { waiter: string; owner: string }[] = [];
  let needsAttention = false;

  for (const collision of collisions) {
    const contenders = [...collision.unitIds];
    const owner = pickOwner(contenders, order);
    const waiters = contenders.filter((id) => id !== owner);

    // Serializing means each waiter waits for the owner. Reject the serialized
    // plan if those edges would create a cycle in the dependency graph.
    const candidateEdges = waiters.map((waiter) => ({ waiter, owner }));
    if (wouldCycle(change, [...ordering, ...candidateEdges])) {
      decisions.push({
        path: collision.path,
        contenders,
        resolution: "flagged",
        waiters: [],
        reason:
          `serializing ${contenders.join(", ")} on ${collision.path} would create a ` +
          "dependency cycle, so the collision is flagged for attention",
      });
      needsAttention = true;
      continue;
    }

    ordering.push(...candidateEdges);
    decisions.push({
      path: collision.path,
      contenders,
      resolution: "serialized",
      owner,
      waiters,
      reason:
        `granted the write lease on ${collision.path} to ${owner}; ` +
        `${waiters.join(", ")} wait for it before integrating`,
    });
  }

  return { changeId: change.id, decisions, ordering, needsAttention };
}

/**
 * Report, per WorkUnit, which contested paths it owns the lease for and which it
 * must wait on. Used by the integration flow so a waiter does not contribute a
 * contested path that its owner already provides, which is what prevents the
 * silent merge collision.
 */
export interface UnitLeaseView {
  /** Contested paths this WorkUnit holds the lease for. */
  readonly owns: readonly string[];
  /** Contested paths this WorkUnit must yield to another owner. */
  readonly yields: readonly string[];
}

/** Build the per-WorkUnit lease view from a plan. */
export function unitLeaseViews(plan: LeasePlan): ReadonlyMap<string, UnitLeaseView> {
  const owns = new Map<string, string[]>();
  const yields = new Map<string, string[]>();
  for (const decision of plan.decisions) {
    if (decision.resolution !== "serialized" || decision.owner === undefined) {
      continue;
    }
    append(owns, decision.owner, decision.path);
    for (const waiter of decision.waiters) {
      append(yields, waiter, decision.path);
    }
  }
  const ids = new Set<string>([...owns.keys(), ...yields.keys()]);
  const result = new Map<string, UnitLeaseView>();
  for (const id of ids) {
    result.set(id, {
      owns: [...(owns.get(id) ?? [])].sort(),
      yields: [...(yields.get(id) ?? [])].sort(),
    });
  }
  return result;
}

/** Map each WorkUnit id to its declared position (0-based) for owner choice. */
function declaredOrder(change: Change): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  change.work.forEach((unit, index) => order.set(unit.id, index));
  return order;
}

/**
 * Choose the single lease owner among the contenders: the one declared earliest
 * in the Change, falling back to id order for stability. Contenders are already
 * sorted, so this is fully deterministic.
 */
function pickOwner(contenders: readonly string[], order: ReadonlyMap<string, number>): string {
  let best = contenders[0] ?? "";
  for (const id of contenders) {
    const idPos = order.get(id) ?? Number.MAX_SAFE_INTEGER;
    const bestPos = order.get(best) ?? Number.MAX_SAFE_INTEGER;
    if (idPos < bestPos || (idPos === bestPos && id < best)) {
      best = id;
    }
  }
  return best;
}

/**
 * Would applying these extra waiter->owner edges create a dependency cycle? We
 * reuse change-core's cycle detector by building a throwaway Change whose
 * WorkUnit dependencies include both the declared edges and the lease edges.
 */
function wouldCycle(
  change: Change,
  extra: readonly { readonly waiter: string; readonly owner: string }[],
): boolean {
  const extraDeps = new Map<string, string[]>();
  for (const edge of extra) {
    const list = extraDeps.get(edge.waiter) ?? [];
    list.push(edge.owner);
    extraDeps.set(edge.waiter, list);
  }
  const augmented: Change = {
    ...change,
    work: change.work.map((unit): WorkUnit => {
      const added = extraDeps.get(unit.id) ?? [];
      if (added.length === 0) {
        return unit;
      }
      const dependsOn = [...new Set([...unit.dependsOn, ...added])];
      return { ...unit, dependsOn };
    }),
  };
  return findDependencyCycle(augmented) !== undefined;
}

function append(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

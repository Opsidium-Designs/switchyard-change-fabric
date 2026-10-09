/**
 * What the next integrated revision of a board merges, as a pure function of
 * the board's log and reduced state.
 *
 * Both integrators use it: the local continuous integrator in the driver and
 * the integration Workflow on Cloudflare. Neither takes an agent's word for
 * anything: one unit per agent with pending pushes on items it still holds,
 *   - PINNED to the agent's latest pending announced commit, with every other
 *     pending commit of the agent required to be in that commit's history
 *     (`includes`);
 *   - diffed against the agent's last commit a passing revision already merged
 *     (`baselineRef`), so earlier, already integrated work is not re-applied;
 *   - scoped to the WRITE INTENTS of the items it integrates (announced paths
 *     never widen scope), with the files of items it handed off yielded;
 *   - carrying the contract paths a human released for those items only.
 * Pure: no I/O, no clock.
 */

import { releasedTargets, type BoardItem, type BoardMessage, type BoardState } from "./board.ts";
import { entriesOverlap, intentPath } from "./path-overlap.ts";

/** One agent's pending pushes, as one unit of the next revision. */
export interface BoardIntegrationUnitPlan {
  readonly agent: string;
  /** The agent's pending items, in push order (the last one carries the pin). */
  readonly items: readonly BoardItem[];
  /** The pinned commit: the agent's latest pending announced push. */
  readonly commit: string;
  /** The agent's last commit a passing revision merged, or "HEAD" (the baseline). */
  readonly baselineRef: string;
  /** The agent's other pending commits, each required to be in the pin's history. */
  readonly includes: readonly string[];
  /** The write intents of the items this unit integrates (sorted, unique). */
  readonly scope: readonly string[];
  /** Files of items the agent handed off (never applied from it). */
  readonly yieldedScope?: readonly string[];
  /** Contract paths a human released for these items, for this unit only. */
  readonly releasedPaths?: readonly string[];
}

/** The next revision's input. */
export interface BoardIntegrationPlan {
  /** The pending-push key (see pendingPushKey). */
  readonly key: string;
  /** Every pending item. */
  readonly pending: readonly BoardItem[];
  /** One unit per agent with pending pushes, sorted by agent id. */
  readonly units: readonly BoardIntegrationUnitPlan[];
}

/** An item's announced, not yet integrated push, still held by the agent that pushed it. */
export function pendingPushItems(state: BoardState): BoardItem[] {
  return Object.values(state.items).filter(
    (i) =>
      i.lastPush !== undefined &&
      i.lastPush.integratedIn === undefined &&
      i.status === "claimed" &&
      i.owner === i.lastPush.agent,
  );
}

/** A stable key for the set of pending pushes (what one integration would merge). */
export function pendingPushKey(state: BoardState): string {
  return pendingPushItems(state)
    .map((i) => i.lastPush!.commit)
    .sort()
    .join(",");
}

/** Synthesize the next revision's units from the board (empty units when nothing is pending). */
export function planBoardIntegration(messages: readonly BoardMessage[], state: BoardState): BoardIntegrationPlan {
  const key = pendingPushKey(state);
  const pending = pendingPushItems(state);
  if (pending.length === 0) {
    return { key, pending, units: [] };
  }

  // Facts from the log: each agent's announced commits, the commits passing
  // revisions merged, and the items each agent handed off.
  const announced = new Map<string, { commit: string; seq: number }[]>();
  const passingMerged = new Set<string>();
  const handedOff = new Map<string, Set<string>>();
  for (const m of messages) {
    if (m.type === "push.announced") {
      announced.set(m.from, [...(announced.get(m.from) ?? []), { commit: m.payload.commit, seq: m.seq }]);
    } else if (m.type === "integrated.rev" && m.payload.gate === "pass") {
      for (const c of m.payload.merged) {
        passingMerged.add(c);
      }
    } else if (m.type === "handoff") {
      handedOff.set(m.from, new Set([...(handedOff.get(m.from) ?? []), m.payload.item]));
    } else if (m.type === "item.reopened") {
      // A reopened item is no longer its previous owner's to apply.
      handedOff.set(m.payload.previousOwner, new Set([...(handedOff.get(m.payload.previousOwner) ?? []), m.payload.item]));
    }
  }

  const agents = [...new Set(pending.map((i) => i.lastPush!.agent))].sort();
  const units: BoardIntegrationUnitPlan[] = [];
  for (const agent of agents) {
    const mine = pending.filter((i) => i.lastPush!.agent === agent).sort((a, b) => a.lastPush!.seq - b.lastPush!.seq);
    const pin = mine.at(-1)!.lastPush!;
    const base = (announced.get(agent) ?? []).filter((p) => p.seq < pin.seq && passingMerged.has(p.commit)).at(-1)?.commit;
    const scope = [...new Set(mine.flatMap((i) => (i.intent?.write ?? []).map(intentPath)))].sort();
    // Items this agent handed to someone else: their files are not its to apply.
    const yieldedScope = [...(handedOff.get(agent) ?? [])]
      .map((id) => state.items[id])
      .flatMap((item) => (item ? [...(item.intent?.write ?? []).map(intentPath), ...(item.lastPush?.paths ?? [])] : []))
      .filter((entry) => !scope.some((own) => entriesOverlap(entry, own)));
    const released = [...new Set(mine.flatMap((i) => releasedTargets(state, i.id)))].sort();
    units.push({
      agent,
      items: mine,
      commit: pin.commit,
      baselineRef: base ?? "HEAD",
      includes: mine.slice(0, -1).map((i) => i.lastPush!.commit),
      scope,
      ...(yieldedScope.length > 0 ? { yieldedScope: [...new Set(yieldedScope)].sort() } : {}),
      ...(released.length > 0 ? { releasedPaths: released } : {}),
    });
  }
  return { key, pending, units };
}

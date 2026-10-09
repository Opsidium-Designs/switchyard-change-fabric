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

import { mergedChildrenWrite, releasedTargets, routedToSubLead, type BoardItem, type BoardMessage, type BoardState } from "./board.ts";
import { attributeFailure } from "./failure-attribution.ts";
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

/**
 * An item's announced, not yet integrated push, still held by the agent that
 * pushed it: a claimed item's owner, or a split item's SUB-LEAD (its push
 * merges the children's). A child of a split item whose sub-lead is still on
 * the board is not integrated directly: its push goes to the sub-lead, who
 * merges it into its own repo and announces one push for the parent.
 */
export function pendingPushItems(state: BoardState): BoardItem[] {
  return Object.values(state.items).filter(
    (i) =>
      i.lastPush !== undefined &&
      i.lastPush.integratedIn === undefined &&
      (i.status === "claimed" || (i.status === "split" && i.subLead !== undefined && state.agents[i.subLead]?.leftSeq === undefined)) &&
      i.owner === i.lastPush.agent &&
      !routedToSubLead(state, i),
  );
}

/** Children's pushes still waiting for their sub-lead to merge them (not pending integration). */
export function awaitingSubLead(state: BoardState): BoardItem[] {
  return Object.values(state.items).filter((i) => {
    if (i.lastPush === undefined || i.lastPush.integratedIn !== undefined || !routedToSubLead(state, i)) {
      return false;
    }
    const parent = state.items[i.parent!]!;
    return !(parent.lastPush?.merges ?? []).some((m) => m.item === i.id && m.commit === i.lastPush!.commit);
  });
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
    // A sub-lead's push integrates only its merged children's write intents
    // (never the rest of the split item's scope).
    const writeOf = (i: BoardItem): string[] =>
      i.status === "split" ? mergedChildrenWrite(state, i.lastPush?.merges ?? []) : (i.intent?.write ?? []).map(intentPath);
    const scope = [...new Set(mine.flatMap(writeOf))].sort();
    // Items this agent handed to someone else: their files are not its to apply.
    const yieldedScope = [...(handedOff.get(agent) ?? [])]
      .map((id) => state.items[id])
      .flatMap((item) => (item ? [...(item.intent?.write ?? []).map(intentPath), ...(item.lastPush?.paths ?? [])] : []))
      .filter((entry) => !scope.some((own) => entriesOverlap(entry, own)));
    // Contract paths released for the items this unit integrates, including the
    // children a sub-lead's push merges (their accepted changes ship through it).
    const released = [
      ...new Set(mine.flatMap((i) => [i.id, ...(i.status === "split" ? (i.lastPush?.merges ?? []).map((m) => m.item) : [])]).flatMap((id) => releasedTargets(state, id))),
    ].sort();
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

/**
 * A failing revision that implicates a SPLIT item implicates the work of its
 * children: the sub-lead only merged their pushes. Each implicated split item
 * is replaced by the children whose pushes its latest push merged and whose
 * write intents the failing output names (all of those merged children when
 * the output names none of them), so the fix request goes to the child owners
 * who wrote the code. The children are items the revision merged (through the
 * sub-lead's push), so the board accepts them as implicated. Pure.
 */
export function narrowToSplitChildren(state: BoardState, implicated: readonly string[], output: string): string[] {
  const out: string[] = [];
  const add = (id: string): void => {
    if (!out.includes(id)) {
      out.push(id);
    }
  };
  for (const id of implicated) {
    const item = state.items[id];
    const merged = (item?.status === "split" ? (item.lastPush?.merges ?? []) : []).filter((m) => {
      const child = state.items[m.item];
      return child?.lastPush?.commit === m.commit && child.lastPush.integratedIn === undefined;
    });
    if (merged.length === 0) {
      add(id);
      continue;
    }
    const children = merged.map((m) => ({ unitId: m.item, paths: (state.items[m.item]!.intent?.write ?? state.items[m.item]!.scopeHint).map(intentPath) }));
    const parse = attributeFailure(children, output);
    for (const unit of parse.units) {
      add(unit.unitId);
    }
  }
  return out;
}

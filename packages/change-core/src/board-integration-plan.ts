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
 *   - applied PER ITEM (`parts`): one agent has ONE repo for every item it
 *     holds, so its head may carry work for several of them. Each pending
 *     item's files (its write intents) are applied from that item's own push
 *     commit, diffed from that item's own last integrated push; files of the
 *     agent's OTHER held items (not in this unit) are yielded: they ride with
 *     those items' own pushes. A file outside every item the agent holds is
 *     still a path-scope violation;
 *   - carrying the contract paths a human released for those items only.
 * Pure: no I/O, no clock.
 */

import { mergedChildrenWrite, releasedTargets, routedToSubLead, type BoardItem, type BoardMessage, type BoardState } from "./board.ts";
import { attributeFailure } from "./failure-attribution.ts";
import { entriesOverlap, intentPath } from "./path-overlap.ts";

/**
 * One pending item of a unit: its files are applied from exactly its own push
 * commit, never from the agent's later head (which may carry unannounced work
 * for it, or work for another item the agent holds).
 */
export interface BoardIntegrationPart {
  readonly item: string;
  /** The item's pending push commit (the pin, or one of `includes`). */
  readonly commit: string;
  /**
   * The item's own last push (by this agent) a passing revision merged, or
   * "HEAD" (the empty tree): its files are diffed from here, so a file a
   * passing revision yielded while it rode in another item's push is still
   * applied when its own item is integrated.
   */
  readonly baselineRef: string;
  /** The item's write intents (and its released contract paths), sorted. */
  readonly scope: readonly string[];
}

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
  /**
   * Per item, in push order: which files are applied from which commit (see
   * BoardIntegrationPart). Absent on units built elsewhere (the whole pin is
   * then applied, as before).
   */
  readonly parts?: readonly BoardIntegrationPart[];
  /**
   * Files never applied from this unit: those of items the agent handed off
   * or lost, and the write intents of the agent's other held items whose
   * pushes are not in this unit (they ride with those items' own pushes).
   */
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

/**
 * The pending pushes an integration may gate: every pending push except one
 * the integrator recorded excluded (push.excluded), or (arbitration revision
 * 5) recorded as regressing the pre-pass ratchet (push.regressed), which
 * waits for its holder's next push instead of being stacked as it is. Pure.
 */
export function integrablePushItems(state: BoardState): BoardItem[] {
  return pendingPushItems(state).filter((i) => i.lastPush!.excluded === undefined && i.lastPush!.regressed === undefined);
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

/** A stable key for the set of pending pushes one integration would merge (excluded pushes aside). */
export function pendingPushKey(state: BoardState): string {
  return integrablePushItems(state)
    .map((i) => i.lastPush!.commit)
    .sort()
    .join(",");
}

/** Synthesize the next revision's units from the board (empty units when nothing is pending). */
export function planBoardIntegration(messages: readonly BoardMessage[], state: BoardState): BoardIntegrationPlan {
  const key = pendingPushKey(state);
  const pending = integrablePushItems(state);
  if (pending.length === 0) {
    return { key, pending, units: [] };
  }

  // Facts from the log: each agent's announced commits, the commits passing
  // revisions merged, and the items each agent handed off.
  const announced = new Map<string, { commit: string; seq: number; item: string }[]>();
  const passingMerged = new Set<string>();
  const handedOff = new Map<string, Set<string>>();
  // Each agent's own announced paths per item: an item it no longer holds
  // (handed off, reopened, lapsed, re-planned) leaves work in its repo that is
  // not its to apply any more.
  const pushedPaths = new Map<string, Map<string, Set<string>>>();
  // A sub-lead's push carries its children's commits: when a passing revision
  // merges it, those child commits are merged too (for their authors' diff base).
  const mergesOf = new Map<string, readonly { item: string; commit: string }[]>();
  for (const m of messages) {
    if (m.type === "push.announced") {
      announced.set(m.from, [...(announced.get(m.from) ?? []), { commit: m.payload.commit, seq: m.seq, item: m.payload.item }]);
      const byItem = pushedPaths.get(m.from) ?? new Map<string, Set<string>>();
      byItem.set(m.payload.item, new Set([...(byItem.get(m.payload.item) ?? []), ...m.payload.paths]));
      pushedPaths.set(m.from, byItem);
      if (m.payload.merges !== undefined) {
        mergesOf.set(m.payload.commit, m.payload.merges);
      }
    } else if (m.type === "integrated.rev" && m.payload.gate === "pass") {
      const unverified = new Set((m.payload.unverified ?? []).map((u) => u.item));
      for (const c of m.payload.merged) {
        passingMerged.add(c);
        for (const merge of mergesOf.get(c) ?? []) {
          if (!unverified.has(merge.item)) {
            passingMerged.add(merge.commit);
          }
        }
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
      i.status === "split"
        ? mergedChildrenWrite(state, i.lastPush?.merges ?? [])
        : // A released contract path (possibly outside the scope: a failing check) is in scope for its item.
          [...(i.intent?.write ?? []).map(intentPath), ...releasedTargets(state, i.id).filter((t) => !(state.immutable ?? []).includes(t))];
    const scope = [...new Set(mine.flatMap(writeOf))].sort();
    // Each item's files come from its own push commit, diffed from its own
    // last push a passing revision merged (so a file yielded while it rode in
    // another item's push is never silently dropped from its own item).
    const parts = mine.map((i) => {
      const ownBase = (announced.get(agent) ?? []).filter((p) => p.item === i.id && p.seq < i.lastPush!.seq && passingMerged.has(p.commit)).at(-1)?.commit;
      return { item: i.id, commit: i.lastPush!.commit, baselineRef: ownBase ?? "HEAD", scope: [...new Set(writeOf(i))].sort() };
    });
    // The agent's OTHER held items (claimed, or split under it as sub-lead)
    // whose pushes this unit does not integrate (none yet, excluded,
    // regressed): their files may sit at its head, but they are not this
    // unit's to apply, nor a scope violation of it.
    const inUnit = new Set(mine.map((i) => i.id));
    const otherHeld = Object.values(state.items).filter(
      (i) => !inUnit.has(i.id) && ((i.status === "claimed" && i.owner === agent) || (i.status === "split" && i.subLead === agent)),
    );
    // Items this agent handed to someone else: their files are not its to apply.
    // Nor are the files it pushed for an item it no longer holds (its claim was
    // reopened, lapsed, or re-planned): that work stays in its repo, unapplied.
    const lost = [...(pushedPaths.get(agent) ?? [])].filter(([id]) => {
      const item = state.items[id];
      return item !== undefined && item.owner !== agent && item.subLead !== agent;
    });
    const yieldedScope = [
      ...[...(handedOff.get(agent) ?? [])]
        .map((id) => state.items[id])
        .flatMap((item) => (item ? [...(item.intent?.write ?? []).map(intentPath), ...(item.lastPush?.paths ?? [])] : [])),
      ...lost.flatMap(([, paths]) => [...paths]),
      ...otherHeld.flatMap((item) => (item.intent?.write ?? item.scopeHint).map(intentPath)),
    ].filter((entry) => !scope.some((own) => entriesOverlap(entry, own)));
    // Contract paths released for the items this unit integrates, including the
    // children a sub-lead's push merges (their accepted changes ship through it).
    const released = [
      ...new Set(mine.flatMap((i) => [i.id, ...(i.status === "split" ? (i.lastPush?.merges ?? []).map((m) => m.item) : [])]).flatMap((id) => releasedTargets(state, id))),
    ]
      // The acceptance gate is always restored, whatever was accepted.
      .filter((t) => !(state.immutable ?? []).includes(t))
      .sort();
    units.push({
      agent,
      items: mine,
      commit: pin.commit,
      baselineRef: base ?? "HEAD",
      includes: mine.slice(0, -1).map((i) => i.lastPush!.commit),
      scope,
      parts,
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

/**
 * The units a SPECULATIVE round may stack (rules.speculate > 1), in stack
 * order: every unit of the plan whose items carry no unanswered fix request
 * (a push a candidate already blamed waits for its owner's next push instead
 * of sinking the pushes behind it again), ordered by the earliest pending
 * push seq of each unit (stable: push order, then agent id). Pure.
 */
export function speculativeUnits(plan: BoardIntegrationPlan): BoardIntegrationUnitPlan[] {
  const first = (u: BoardIntegrationUnitPlan): number => Math.min(...u.items.map((i) => i.lastPush!.seq));
  return plan.units
    .filter((u) => u.items.every((i) => i.fixRequested === undefined))
    .sort((a, b) => first(a) - first(b) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
}

/**
 * A stable key for what a speculative round would stack, from state alone:
 * the pending pushes of the agents whose pending items carry no unanswered
 * fix request (the units `speculativeUnits` keeps). A round that only blamed
 * a push changes it, so the pushes behind that push are gated next.
 */
export function speculationStateKey(state: BoardState): string {
  const pending = integrablePushItems(state);
  const held = new Set(pending.filter((i) => i.fixRequested !== undefined).map((i) => i.lastPush!.agent));
  return pending
    .filter((i) => !held.has(i.lastPush!.agent))
    .map((i) => i.lastPush!.commit)
    .sort()
    .join(",");
}

/** One gated candidate's verdict, by its 1-based index (absent gate: it could not be gated). */
export interface CandidateVerdict {
  readonly index: number;
  readonly gate?: "pass" | "fail";
}

/** What a speculative round lands and blames (see decideSpeculativeLanding). */
export interface SpeculativeLanding {
  /** The landed candidate's index: the longest passing prefix whose shorter prefixes all passed. */
  readonly landed?: number;
  /** The candidate whose last push is blamed: the first failure, right after the landed prefix (or the first candidate). */
  readonly blamed?: number;
  /** Passing candidates a longer landed prefix subsumes. */
  readonly passed: readonly number[];
  /** Candidates after the first non-pass: their own pushes are not blamed; re-tested next round. */
  readonly retest: readonly number[];
}

/**
 * Decide a speculative round from its candidates' verdicts, in index order:
 * land the longest prefix C1..Ck that all passed (as ONE revision, Ck); blame
 * C(k+1) when it FAILED (its last push is the only difference from Ck, or
 * from the head when k = 0, where C1 is that push alone); everything after
 * the first non-pass is re-tested, never blamed (something ahead of it was
 * broken or not gated). Pure.
 */
export function decideSpeculativeLanding(verdicts: readonly CandidateVerdict[]): SpeculativeLanding {
  const ordered = [...verdicts].sort((a, b) => a.index - b.index);
  let k = 0;
  while (k < ordered.length && ordered[k]!.gate === "pass" && ordered[k]!.index === k + 1) {
    k += 1;
  }
  const next = ordered[k];
  const blamed = next !== undefined && next.index === k + 1 && next.gate === "fail" ? next.index : undefined;
  return {
    ...(k > 0 ? { landed: k } : {}),
    ...(blamed !== undefined ? { blamed } : {}),
    passed: ordered.slice(0, Math.max(0, k - 1)).map((v) => v.index),
    retest: ordered.slice(blamed !== undefined ? k + 1 : k).map((v) => v.index),
  };
}

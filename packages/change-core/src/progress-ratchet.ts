/**
 * The PRE-PASS PROGRESS RATCHET (arbitration revision 5), as pure functions
 * of the board log.
 *
 * With a whole-goal gate, no revision can pass until essentially every item
 * is right, so before the first pass there is no passing head to protect, and
 * every revision merges every item's latest push on the baseline: one bad push
 * takes the whole tree backwards. The ratchet is the BEST-SCORING failing
 * revision so far (see compareProgressScore: a tree that runs the acceptance
 * suite beats one that does not, then more acceptance passes, then more
 * developer passes, then fewer type errors; ties go to the earliest). The
 * local integrator stacks every item's latest push as before; when that stack
 * scores worse than the ratchet it checks the new pushes LEAVE-ONE-OUT and
 * reports only a push whose removal makes the stack strictly better (see
 * ratchet-integration.ts in the orchestration package).
 *
 * What the ratchet is NOT: it is not the integrated head (the head stays the
 * baseline until a revision passes), nothing is promoted from it, and no
 * verdict changes because of it. It is the reference that triggers the
 * leave-one-out check and names which pushes are new; it does not decide
 * what is stacked (only a recorded regression leaves the stack). After the
 * first passing revision there is no ratchet (speculative gating protects
 * the passing head).
 * Pure: no I/O, no clock.
 */

import {
  arbitrationV5,
  compareProgressScore,
  describeProgressScore,
  mergedChildrenWrite,
  progressScore,
  releasedTargets,
  type BoardMessage,
  type BoardProgressScore,
  type BoardRevProgress,
  type BoardState,
} from "./board.ts";
import type { BoardIntegrationUnitPlan } from "./board-integration-plan.ts";
import { intentPath } from "./path-overlap.ts";

/** The ratchet: the best-scoring failing revision before the first pass. */
export interface PrePassRatchet {
  readonly n: number;
  readonly seq: number;
  /** The revision's gated commit (a real gated tree). */
  readonly commit: string;
  /** The announced push commits it merged: the set new pushes are stacked on. */
  readonly merged: readonly string[];
  readonly progress: BoardRevProgress;
  readonly score: BoardProgressScore;
}

/** One step of the ratchet's history: a failing revision that scored better than every revision before it. */
export interface RatchetStep {
  readonly n: number;
  readonly seq: number;
  readonly commit: string;
  readonly score: BoardProgressScore;
  /** `acceptance 51/129` or `22 type errors`: a count, never a verdict. */
  readonly line: string;
}

/** True when the log's goal posted arbitration revision 5 or later. */
function ratchetRules(messages: readonly BoardMessage[]): boolean {
  const goal = messages.find((m) => m.type === "goal.posted");
  return goal?.type === "goal.posted" && arbitrationV5({ rules: goal.payload.rules });
}

/**
 * The ratchet's history: each failing revision, before the first pass, whose
 * score beat every scored revision before it (ties keep the earlier one).
 * Empty before arbitration revision 5. Pure.
 */
export function ratchetHistory(messages: readonly BoardMessage[]): RatchetStep[] {
  if (!ratchetRules(messages)) {
    return [];
  }
  const steps: RatchetStep[] = [];
  for (const m of messages) {
    if (m.type !== "integrated.rev") {
      continue;
    }
    if (m.payload.gate === "pass") {
      break;
    }
    const score = progressScore(m.payload.progress);
    const best = steps.at(-1);
    if (score !== undefined && (best === undefined || compareProgressScore(score, best.score) > 0)) {
      steps.push({ n: m.payload.n, seq: m.seq, commit: m.payload.commit, score, line: describeProgressScore(score) });
    }
  }
  return steps;
}

/**
 * The current ratchet (see the module comment), or undefined: before
 * arbitration revision 5, once any revision passed, or while no failing
 * revision carries a comparable score. Pure.
 */
export function prePassRatchet(messages: readonly BoardMessage[]): PrePassRatchet | undefined {
  if (!ratchetRules(messages) || messages.some((m) => m.type === "integrated.rev" && m.payload.gate === "pass")) {
    return undefined;
  }
  const best = ratchetHistory(messages).at(-1);
  if (best === undefined) {
    return undefined;
  }
  const rev = messages.find((m) => m.seq === best.seq);
  if (rev?.type !== "integrated.rev" || rev.payload.progress === undefined) {
    return undefined;
  }
  return { n: best.n, seq: best.seq, commit: best.commit, merged: [...rev.payload.merged], progress: rev.payload.progress, score: best.score };
}

/** One line for the board pane: `best so far: rev 10, acceptance 51/129` (absent without a ratchet). Pure. */
export function ratchetLine(messages: readonly BoardMessage[]): string | undefined {
  const ratchet = prePassRatchet(messages);
  return ratchet === undefined ? undefined : `best so far: rev ${ratchet.n}, ${describeProgressScore(ratchet.score)} (not a verdict; the head is unchanged)`;
}

/**
 * The ratchet's merged set as integration units (one per agent whose pushes
 * it merged), so the ratchet's tree can be rebuilt: each unit PINNED to the agent's latest commit the
 * ratchet merged (every other one of its merged commits required in that
 * commit's history), diffed against the baseline (nothing passed yet),
 * scoped to the write intents of the items those pushes were for. `complete`
 * is false when a merged commit's announcement or item is unknown: the units
 * then do not rebuild the ratchet's tree exactly. Pure.
 */
export function ratchetUnits(
  messages: readonly BoardMessage[],
  state: BoardState,
  ratchet: Pick<PrePassRatchet, "merged">,
): { readonly units: BoardIntegrationUnitPlan[]; readonly complete: boolean } {
  const announced = new Map<string, Extract<BoardMessage, { type: "push.announced" }>>();
  for (const m of messages) {
    if (m.type === "push.announced") {
      announced.set(m.payload.commit, m);
    }
  }
  let complete = true;
  const byAgent = new Map<string, Extract<BoardMessage, { type: "push.announced" }>[]>();
  for (const commit of ratchet.merged) {
    const push = announced.get(commit);
    if (push === undefined || state.items[push.payload.item] === undefined) {
      complete = false;
      continue;
    }
    byAgent.set(push.from, [...(byAgent.get(push.from) ?? []), push]);
  }
  const units: BoardIntegrationUnitPlan[] = [];
  for (const agent of [...byAgent.keys()].sort()) {
    const pushes = byAgent.get(agent)!.sort((a, b) => a.seq - b.seq);
    const items = pushes.map((p) => state.items[p.payload.item]!);
    const scope = [
      ...new Set(
        pushes.flatMap((p) => {
          const item = state.items[p.payload.item]!;
          return item.status === "split" || p.payload.merges !== undefined
            ? mergedChildrenWrite(state, p.payload.merges ?? [])
            : [...(item.intent?.write ?? item.scopeHint).map(intentPath), ...releasedTargets(state, item.id).filter((t) => !(state.immutable ?? []).includes(t))];
        }),
      ),
    ].sort();
    const released = [...new Set(items.flatMap((i) => releasedTargets(state, i.id)))].filter((t) => !(state.immutable ?? []).includes(t)).sort();
    units.push({
      agent,
      items,
      commit: pushes.at(-1)!.payload.commit,
      baselineRef: "HEAD",
      includes: pushes.slice(0, -1).map((p) => p.payload.commit),
      scope,
      ...(released.length > 0 ? { releasedPaths: released } : {}),
    });
  }
  return { units, complete };
}

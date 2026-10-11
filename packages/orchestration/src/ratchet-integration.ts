/**
 * ratchet-integration: the PRE-PASS PROGRESS RATCHET for the local continuous
 * integrator (arbitration revision 5; see change-core's progress-ratchet.ts).
 *
 * Before the first passing revision there is no passing head to protect, so
 * speculation does not run and every revision merges every item's latest
 * push on the baseline: one agent's bad push (an invented API, a duplicated
 * declaration) takes the whole tree backwards and the fix loop chases a moving
 * target. The ratchet is the best-scoring failing revision so far. One round:
 *
 *   1. the WHOLE STACK (every pending push, as before) is built and gated. A
 *      tree that scores at least as well as the ratchet (or passes) is
 *      recorded exactly as before (normal attribution): it may become the new
 *      ratchet, or the first passing revision;
 *   2. a stack that scores WORSE is ISOLATED: for each new push (an agent's
 *      unit carrying a push the ratchet did not merge), in push order and up
 *      to K (the speculate rule) while no run cap is reached, the tree of the
 *      ratchet's merged set plus that push alone is built and gated (a real
 *      gated tree). A push whose tree scores worse than the ratchet REGRESSES
 *      it;
 *   3. with regressing pushes, the whole stack is recorded as a failing
 *      revision that implicates ONLY the regressing pushes' items (their fix
 *      budgets alone are charged by it), each regression is recorded
 *      (`push.regressed`, addressed to the holder, quoting the new failures,
 *      with the seam hint when the push edits a shared seam), and the stack
 *      without them (they are not stacked until their holder pushes again) is
 *      built, gated, and recorded as the next revision, attributed as any
 *      revision is.
 *
 * Honesty: every recorded revision is exactly a gated tree on the integrated
 * head (the baseline: STALE_BASE applies), so gate-equals-deploy holds. The
 * ratchet never moves the head, never promotes, and never changes a verdict:
 * only a passing revision does, and only it is promoted. Isolation trees are
 * evidence (each regression names its gated commit and score), never
 * verdicts. After the first pass, speculative gating takes over unchanged.
 */

import {
  BOARD_LIMITS,
  compareProgressScore,
  describeProgressScore,
  integratedHead,
  pendingPushItems,
  planBoardIntegration,
  prePassRatchet,
  progressScore,
  ratchetUnits,
  type BoardIntegrationUnitPlan,
  type BoardItem,
  type BoardMessage,
  type BoardProgressScore,
  type BoardState,
  type PrePassRatchet,
} from "@switchyard-change/change-core";
import { gateFailureLine, inventoryAfterContracts, matchesGlob, type EvidenceSummary } from "@switchyard-change/verification";

import { redactSecrets } from "./redact.ts";
import {
  failingRevisionEvidence,
  integrateBoardRevision,
  keyWithout,
  recordExcludedPushes,
  type BoardDecisionRecord,
  type BoardRevision,
  type IntegrateBoardOptions,
  type IntegrateBoardResult,
} from "./run-board.ts";
import { candidateItems, gateCandidateTree, recordBuiltCandidate, type BuiltCandidate, type CandidateContext, type StackEntry } from "./speculative-integration.ts";

/** Shared files every domain imports: a push that edits one and regresses is told to propose a seam contract instead. */
export const SHARED_SEAM_GLOBS: readonly string[] = ["src/contracts/**", "src/store.ts"];

/** New failure lines quoted per regression (bounded by the board's limit). */
const EVIDENCE_LINES = 5;

/** Inputs to one ratchet round. */
export interface RatchetRoundOptions extends IntegrateBoardOptions {
  /** Isolation candidates one round may gate (the speculate K; at least 1). */
  readonly isolate: number;
  /** Isolation candidates built and gated at once (default: isolate; 1 keeps the order deterministic). */
  readonly candidateConcurrency?: number;
  /** A reason once a run cap is reached: no new isolation candidate starts. */
  readonly stopCandidates?: () => string | undefined;
}

/** One new push of an isolation round and what its isolation tree showed. */
export interface RatchetIsolation {
  readonly agent: string;
  /** The items of the agent's new pushes (the ones the ratchet did not merge). */
  readonly items: readonly string[];
  readonly commit: string;
  /** The isolation tree's gated commit (the ratchet's set plus this push alone). */
  readonly candidate?: string;
  readonly score?: BoardProgressScore;
  /** regressed: it scored worse than the ratchet; kept: at least as well; unscored: nothing comparable; skipped: not gated. */
  readonly outcome: "regressed" | "kept" | "unscored" | "skipped";
  readonly skipped?: string;
}

/** The result of one ratchet round. */
export interface RatchetRoundResult extends IntegrateBoardResult {
  /** Every revision the round recorded, in order (the whole stack, then the stack without the regressing pushes). */
  readonly revisions?: readonly BoardRevision[];
  /** The ratchet the round compared against. */
  readonly ratchet?: { readonly n: number; readonly score: BoardProgressScore };
  /** The whole stack's score (when it had one). */
  readonly stackScore?: BoardProgressScore;
  /** The isolation round, when the whole stack scored worse than the ratchet. */
  readonly isolation?: readonly RatchetIsolation[];
  /** Items whose push the round recorded as regressing the ratchet (push.regressed). */
  readonly regressed?: readonly string[];
}

/**
 * The failure lines of a candidate's output that its reference's output does
 * not carry (type errors, failing tests, thrown errors), at most `max`, each
 * trimmed and bounded: what the push alone added. Pure.
 */
export function regressionEvidence(candidate: string, reference: string, max = EVIDENCE_LINES): string[] {
  const known = new Set(reference.split(/\r?\n/).map((l) => l.trim()));
  const failure = (l: string): boolean =>
    /\(\d+,\d+\): error TS\d+:/.test(l) ||
    /^error TS\d+:/.test(l) ||
    /^(not ok\b|✖|×|FAIL\b|--- FAIL)/.test(l) ||
    /^\w*(Error|Exception)\b(\s*\[[A-Z_]+\])?:/.test(l);
  const out: string[] = [];
  for (const raw of candidate.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || known.has(line) || !failure(line) || out.includes(line.slice(0, BOARD_LIMITS.maxRegressionEvidenceLine))) {
      continue;
    }
    out.push(line.slice(0, BOARD_LIMITS.maxRegressionEvidenceLine));
    if (out.length >= Math.min(max, BOARD_LIMITS.maxRegressionEvidence)) {
      break;
    }
  }
  if (out.length === 0) {
    const key = gateFailureLine(candidate);
    if (key !== undefined && !known.has(key.trim())) {
      out.push(key.trim().slice(0, BOARD_LIMITS.maxRegressionEvidenceLine));
    }
  }
  return out;
}

/** The shared seams a push's paths edit: the blueprint's seams and the shared seam files (sorted). Pure. */
export function seamsEdited(state: BoardState, paths: readonly string[]): string[] {
  const seams = new Set((state.seams ?? []).map((s) => s.path));
  return [...new Set(paths.filter((p) => seams.has(p) || SHARED_SEAM_GLOBS.some((g) => matchesGlob(p, g))))].sort().slice(0, BOARD_LIMITS.maxShortList);
}

/** A gated candidate's output as one text (its gate's outputs and the integrator's summary). */
function outputOf(evidence: EvidenceSummary | undefined): string {
  if (evidence === undefined) {
    return "";
  }
  const check = evidence.integration.finalCheck;
  return [...check.outputs.map((o) => o.text), check.summary].join("\n");
}

/** The earliest push seq among a unit's items that the ratchet did not merge (its order in the isolation round). */
function firstNewSeq(unit: BoardIntegrationUnitPlan, ratchetCommits: ReadonlySet<string>): number {
  return Math.min(...unit.items.filter((i) => !ratchetCommits.has(i.lastPush!.commit)).map((i) => i.lastPush!.seq));
}

/** A stable key for a set of push commits (sorted, comma-joined), like pendingPushKey. */
function keyOf(commits: readonly string[]): string {
  return [...commits].sort().join(",");
}

/** Run `count` jobs (1-based, in order) with at most `limit` at once. */
async function inPool<T>(count: number, limit: number, job: (index: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(count);
  let next = 1;
  const worker = async (): Promise<void> => {
    while (next <= count) {
      const index = next;
      next += 1;
      out[index - 1] = await job(index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, () => worker()));
  return out;
}

/**
 * Run one ratchet round (see the module comment). Without a ratchet (no
 * scored failing revision yet), or once a revision passed, it is exactly
 * integrateBoardRevision.
 */
export async function integrateRatchetRound(options: RatchetRoundOptions): Promise<RatchetRoundResult> {
  const scrub = options.scrub ?? redactSecrets;
  const requiresIntegrationGate = Boolean(options.appGateCommand && options.appGateCommand.length > 0) || options.requireAppGate === true;
  const board = await options.operator.log();
  const state = board.state;
  const ratchet = prePassRatchet(board.messages);
  if (ratchet === undefined || state.integrated !== null) {
    return integrateBoardRevision(options);
  }
  const plan = planBoardIntegration(board.messages, state);
  let key = plan.key;
  const pending = [...plan.pending];
  if (pending.length === 0) {
    return { requiresIntegrationGate, key, failure: "nothing is pending" };
  }

  // Every agent's repo is read with a fresh operator read token, once per round.
  const remotes = new Map<string, string>();
  const excludedAgents: { agent: string; reason: string }[] = [];
  const entryOf = async (unit: BoardIntegrationUnitPlan, note: boolean): Promise<StackEntry | undefined> => {
    const agent = unit.agent;
    const exclude = (reason: string): undefined => {
      if (note) {
        excludedAgents.push({ agent, reason });
      }
      return undefined;
    };
    if (!options.agentRepos.get(agent)) {
      return exclude("no repo is known for this agent");
    }
    if (options.holdBack?.includes(agent)) {
      return exclude("held back: its pushes kept being superseded while the gate ran; they stay pending");
    }
    try {
      if (!remotes.has(agent)) {
        remotes.set(agent, await options.readRemote(agent));
      }
      return { unit, remote: remotes.get(agent)! };
    } catch (error) {
      return exclude(scrub(`could not read its repo: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
  const stack: StackEntry[] = [];
  for (const unit of plan.units) {
    const entry = await entryOf(unit, true);
    if (entry) {
      stack.push(entry);
    }
  }
  if (stack.length === 0) {
    return {
      requiresIntegrationGate,
      key,
      transient: true,
      failure: `no pending push could be read: ${excludedAgents.map((e) => `${e.agent}: ${e.reason}`).join("; ")}`,
    };
  }

  const acceptedTargets = [...new Set(Object.values(state.contracts).filter((c) => c.status === "accepted" && c.guarded).map((c) => c.target))].sort();
  const adjusted = options.testInventory ? inventoryAfterContracts(options.testInventory, acceptedTargets) : {};
  const ctx: CandidateContext = { options, state, scrub, requiresIntegrationGate, ...(adjusted.inventory ? { inventory: adjusted.inventory } : {}) };
  const head = integratedHead(state);
  const recordCtx = (s: BoardState, p: readonly BoardItem[]) => ({
    ...ctx,
    state: s,
    ...(head !== undefined ? { head } : {}),
    pending: p,
    ...(adjusted.relaxed !== undefined ? { inventoryNote: adjusted.relaxed } : {}),
  });
  const ratchetInfo = { n: ratchet.n, score: ratchet.score };

  // 1. The whole stack, as every pre-pass revision is built.
  const whole = await gateCandidateTree(ctx, 1, stack);
  const verificationExcluded = stack
    .filter((e) => whole.excludedAgents.some((x) => x.agent === e.unit.agent))
    .map((e) => ({ agent: e.unit.agent, items: [...e.unit.items], reason: whole.excludedAgents.find((x) => x.agent === e.unit.agent)!.reason }));
  const excludedPushes = await recordExcludedPushes(options.operator, verificationExcluded);
  if (excludedPushes > 0) {
    key = keyWithout(key, verificationExcluded);
  }
  const revExcluded = [...excludedAgents, ...whole.excludedAgents];
  if (whole.commit === undefined || whole.gate === undefined) {
    return {
      requiresIntegrationGate,
      key,
      ...(whole.evidence ? { evidence: whole.evidence } : {}),
      ...(excludedPushes > 0 ? { excludedPushes } : {}),
      failure: whole.skipped ?? "the integrator reported no commit for the gated tree",
    };
  }
  const superseded = async (items: readonly BoardItem[]): Promise<string[]> => {
    const now = new Set(pendingPushItems((await options.operator.page(0, 1)).state).map((i) => i.lastPush!.commit));
    return [...new Set(items.filter((i) => !now.has(i.lastPush!.commit)).map((i) => i.lastPush!.agent))].sort();
  };
  const stale = (agents: readonly string[], evidence: EvidenceSummary | undefined, extra: Partial<RatchetRoundResult> = {}): RatchetRoundResult => ({
    requiresIntegrationGate,
    key,
    ...(evidence ? { evidence } : {}),
    stale: true,
    supersededAgents: [...agents],
    failure: "a merged push was superseded while the gate ran",
    ...extra,
  });
  const wholeScore = progressScore(whole.progress);

  /** Record a gated tree as a revision, attributed as any failing revision is. */
  const recordAttributed = async (c: BuiltCandidate, s: BoardState, p: readonly BoardItem[], excluded: readonly { agent: string; reason: string }[]) => {
    const decisions: BoardDecisionRecord[] = [];
    const failingEvidence =
      c.gate === "fail"
        ? await failingRevisionEvidence({
            state: s,
            check: c.evidence!.integration.finalCheck,
            scrub,
            items: candidateItems(c),
            changeId: options.change.id,
            ...(options.jev ? { jev: options.jev } : {}),
            ...(options.jevThreshold !== undefined ? { jevThreshold: options.jevThreshold } : {}),
            ...(options.recordDecision ? { onDecision: async (decision: BoardDecisionRecord) => void decisions.push(decision) } : {}),
          })
        : undefined;
    return recordBuiltCandidate(recordCtx(s, p), c, {
      revExcluded: excluded,
      ...(failingEvidence ? { failingEvidence } : {}),
      decisions,
      nFallback: s.lastRevN + 1,
    });
  };
  /** Record the whole stack as before (no regression found, or none could be shown). */
  const recordWhole = async (extra: Partial<RatchetRoundResult>): Promise<RatchetRoundResult> => {
    const moved = await superseded(candidateItems(whole));
    if (moved.length > 0) {
      return stale(moved, whole.evidence, extra);
    }
    const result = await recordAttributed(whole, state, pending, revExcluded);
    if (!result.revision) {
      return { requiresIntegrationGate, key, evidence: whole.evidence!, ...(result.stale ? { stale: true } : {}), failure: result.failure!, ...extra };
    }
    return {
      revision: result.revision,
      revisions: [result.revision],
      evidence: whole.evidence!,
      requiresIntegrationGate,
      key,
      ratchet: ratchetInfo,
      ...(wholeScore ? { stackScore: wholeScore } : {}),
      ...(excludedPushes > 0 ? { excludedPushes } : {}),
      ...extra,
    };
  };

  const ratchetCommits = new Set(ratchet.merged);
  const worse = whole.gate === "fail" && wholeScore !== undefined && compareProgressScore(wholeScore, ratchet.score) < 0;
  const newEntries = stack
    .filter((e) => whole.mergedAgents.includes(e.unit.agent) && e.unit.items.some((i) => !ratchetCommits.has(i.lastPush!.commit)))
    .sort((a, b) => firstNewSeq(a.unit, ratchetCommits) - firstNewSeq(b.unit, ratchetCommits) || (a.unit.agent < b.unit.agent ? -1 : a.unit.agent > b.unit.agent ? 1 : 0));
  if (!worse || newEntries.length === 0) {
    return recordWhole({});
  }

  // 2. Isolate: the ratchet's merged set plus each new push alone.
  const newItemsOf = (e: StackEntry): BoardItem[] => e.unit.items.filter((i) => !ratchetCommits.has(i.lastPush!.commit));
  const base = ratchetUnits(board.messages, state, ratchet);
  const baseEntries: StackEntry[] = [];
  let baseComplete = base.complete;
  for (const unit of base.units) {
    const entry = await entryOf(unit, false);
    if (entry) {
      baseEntries.push(entry);
    } else {
      baseComplete = false;
    }
  }
  let reference: BoardProgressScore | undefined = baseComplete ? ratchet.score : undefined;
  let referenceOutput = baseComplete ? ratchetOutput(board.messages, ratchet) : "";
  const isolation: RatchetIsolation[] = [];
  const skipAll = (reason: string): RatchetIsolation[] =>
    newEntries.map((e) => ({ agent: e.unit.agent, items: newItemsOf(e).map((i) => i.id), commit: e.unit.commit, outcome: "skipped" as const, skipped: reason }));
  if (reference === undefined) {
    // The ratchet's set could not be rebuilt exactly from the board: gate what can be, as the reference.
    const capped = options.stopCandidates?.();
    if (capped !== undefined || baseEntries.length === 0) {
      return recordWhole({ isolation: skipAll(capped !== undefined ? `not isolated: ${capped}` : "not isolated: the ratchet's set could not be rebuilt") });
    }
    const ref = await gateCandidateTree(ctx, 1, baseEntries);
    reference = progressScore(ref.progress);
    referenceOutput = outputOf(ref.evidence);
    if (reference === undefined) {
      return recordWhole({ isolation: skipAll("not isolated: the rebuilt ratchet's tree had no comparable score") });
    }
  }
  const limit = Math.max(1, Math.floor(options.isolate));
  const chosen = newEntries.slice(0, limit);
  const gated = await inPool(chosen.length, Math.max(1, options.candidateConcurrency ?? limit), async (index): Promise<{ isolation: RatchetIsolation; built?: BuiltCandidate; entry?: StackEntry }> => {
    const entry = chosen[index - 1]!;
    const items = newItemsOf(entry);
    const capped = options.stopCandidates?.();
    if (capped !== undefined) {
      return { isolation: { agent: entry.unit.agent, items: items.map((i) => i.id), commit: entry.unit.commit, outcome: "skipped" as const, skipped: `not built: ${capped}` } };
    }
    const carried = new Set(entry.unit.items.map((i) => i.id));
    const entries = [...baseEntries.filter((b) => b.unit.agent !== entry.unit.agent && !b.unit.items.some((i) => carried.has(i.id))), entry].sort((a, b) =>
      a.unit.agent < b.unit.agent ? -1 : a.unit.agent > b.unit.agent ? 1 : 0,
    );
    const c = await gateCandidateTree(ctx, index, entries);
    if (c.commit === undefined || c.gate === undefined || !c.mergedAgents.includes(entry.unit.agent)) {
      return { isolation: { agent: entry.unit.agent, items: items.map((i) => i.id), commit: entry.unit.commit, outcome: "skipped" as const, skipped: c.skipped ?? "its push was not in the gated tree" } };
    }
    const score = progressScore(c.progress);
    const outcome: RatchetIsolation["outcome"] =
      score === undefined ? "unscored" : c.gate === "fail" && compareProgressScore(score, reference!) < 0 ? "regressed" : "kept";
    return {
      isolation: { agent: entry.unit.agent, items: items.map((i) => i.id), commit: entry.unit.commit, candidate: c.commit, ...(score ? { score } : {}), outcome },
      built: c,
      entry,
    };
  });
  isolation.push(...gated.map((g) => g.isolation), ...skipAll(`not isolated: beyond this round's ${limit} isolation candidate(s); stacked as usual`).slice(chosen.length));
  const regressing = gated.filter((g) => g.isolation.outcome === "regressed");
  if (regressing.length === 0) {
    return recordWhole({ isolation });
  }

  // 3. The whole stack as the failing revision that asks only the regressing pushes for the fix.
  const blamed = regressing.flatMap((g) => newItemsOf(g.entry!));
  const moved = await superseded(candidateItems(whole));
  if (moved.length > 0) {
    return stale(moved, whole.evidence, { isolation });
  }
  const evidenceOf = new Map(regressing.map((g) => [g.entry!.unit.agent, regressionEvidence(outputOf(g.built!.evidence), referenceOutput)]));
  const check = whole.evidence!.integration.finalCheck;
  const keyLine = gateFailureLine(check.outputs.map((o) => o.text).join("\n"));
  const raw = scrub([...(keyLine !== undefined ? [keyLine] : []), ...check.outputs.map((o) => o.text), check.summary].join("\n"));
  const note =
    `pre-pass ratchet: this stack scores ${describeProgressScore(wholeScore!)}, worse than the best revision so far (revision ${ratchet.n}: ${describeProgressScore(ratchet.score)}); ` +
    `isolated on that revision's set, these pushes alone regress it:\n` +
    regressing
      .map((g) => `  ${newItemsOf(g.entry!).map((i) => i.id).join(", ")} (${g.entry!.unit.agent}, ${g.entry!.unit.commit.slice(0, 10)}): ${describeProgressScore(g.isolation.score!)}${(evidenceOf.get(g.entry!.unit.agent) ?? [])[0] ? `: ${evidenceOf.get(g.entry!.unit.agent)![0]}` : ""}`)
      .join("\n") +
    "\n";
  const output = scrub(`${note}${raw}`);
  const failing = { output: output.length > BOARD_LIMITS.maxFailingOutput ? `${output.slice(0, BOARD_LIMITS.maxFailingOutput - 40)}\n... (output truncated)` : output, items: blamed.map((i) => i.id) };
  const first = await recordBuiltCandidate(recordCtx(state, pending), whole, {
    revExcluded,
    failingEvidence: { failing, implicated: { items: failing.items, source: "ratchet" } },
    nFallback: state.lastRevN + 1,
  });
  if (!first.revision) {
    return { requiresIntegrationGate, key, evidence: whole.evidence!, ...(first.stale ? { stale: true } : {}), failure: first.failure!, isolation };
  }
  const revisions: BoardRevision[] = [first.revision];

  // 4. Each regression, addressed to its holder, with the evidence and the seam hint.
  const regressed: string[] = [];
  for (const g of regressing) {
    for (const item of newItemsOf(g.entry!)) {
      const seams = seamsEdited(state, item.lastPush!.paths);
      const outcome = await options.operator
        .recordEngine("push.regressed", {
          item: item.id,
          agent: item.lastPush!.agent,
          commit: item.lastPush!.commit,
          rev: first.revision.n,
          ratchet: ratchet.n,
          from: reference,
          to: g.isolation.score!,
          candidate: g.built!.commit!,
          evidence: (evidenceOf.get(g.entry!.unit.agent) ?? []).map((l) => scrub(l)),
          ...(seams.length > 0 ? { seams } : {}),
        })
        .catch(() => undefined);
      if (outcome?.ok) {
        regressed.push(item.id);
      }
    }
  }

  // 5. The stack without the regressing pushes (they wait for their holders' next push), as the next revision.
  const after = await options.operator.log();
  const rest = planBoardIntegration(after.messages, after.state);
  const restKey = rest.key;
  const done = (extra: Partial<RatchetRoundResult> = {}): RatchetRoundResult => ({
    revision: revisions.at(-1)!,
    revisions,
    evidence: extra.evidence ?? whole.evidence!,
    requiresIntegrationGate,
    // The set the round decided: the stack as the board now plans it.
    key: restKey,
    ratchet: ratchetInfo,
    stackScore: wholeScore!,
    isolation,
    regressed,
    ...(excludedPushes > 0 ? { excludedPushes } : {}),
    ...extra,
  });
  if (restKey === "" || restKey === keyOf(ratchet.merged) || restKey === key) {
    return done();
  }
  const restEntries: StackEntry[] = [];
  const restExcluded: { agent: string; reason: string }[] = [];
  for (const unit of rest.units) {
    const entry = await entryOf(unit, false);
    if (entry) {
      restEntries.push(entry);
    } else {
      restExcluded.push({ agent: unit.agent, reason: "its repo could not be read for the stack without the regressing pushes" });
    }
  }
  if (restEntries.length === 0) {
    return done();
  }
  const restCtx: CandidateContext = { ...ctx, state: after.state };
  const t = await gateCandidateTree(restCtx, 1, restEntries);
  if (t.commit === undefined || t.gate === undefined) {
    return done({ failure: t.skipped ?? "the stack without the regressing pushes could not be gated" });
  }
  const movedRest = await superseded(candidateItems(t));
  if (movedRest.length > 0) {
    // Run again on the newer pushes; the whole stack's revision stays recorded.
    return { ...done(), key, stale: true, supersededAgents: movedRest, failure: "a merged push was superseded while the gate ran" };
  }
  const second = await recordAttributed(t, after.state, [...rest.pending], [
    ...restExcluded,
    ...t.excludedAgents,
    ...regressing.map((g) => ({ agent: g.entry!.unit.agent, reason: `regressed the pre-pass ratchet in revision ${first.revision!.n} (push.regressed): not stacked until its holder pushes again` })),
  ]);
  if (!second.revision) {
    return { ...done(), key, ...(second.stale ? { stale: true } : {}), failure: second.failure! };
  }
  revisions.push(second.revision);
  return done({ evidence: t.evidence! });
}

/** The ratchet revision's recorded failing output (the reference for what a push alone added). */
function ratchetOutput(messages: readonly BoardMessage[], ratchet: Pick<PrePassRatchet, "seq">): string {
  const m = messages.find((x) => x.seq === ratchet.seq);
  return m?.type === "integrated.rev" ? (m.payload.failing?.output ?? "") : "";
}

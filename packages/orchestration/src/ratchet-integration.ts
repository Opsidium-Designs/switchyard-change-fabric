/**
 * ratchet-integration: the PRE-PASS PROGRESS RATCHET for the local continuous
 * integrator (arbitration revision 5; see change-core's progress-ratchet.ts).
 *
 * Before the first passing revision there is no passing head to protect, so
 * speculation does not run and every revision merges every item's latest
 * push on the baseline: one agent's bad push (an invented API, a duplicated
 * declaration) can take the whole tree backwards. The ratchet is the
 * best-scoring failing revision so far; it is the REFERENCE that triggers a
 * leave-one-out check, never a gate on what is stacked. One round:
 *
 *   1. the WHOLE STACK (every item's latest push, as before) is built and
 *      gated. A tree that scores at least as well as the ratchet (or passes)
 *      is recorded exactly as before (normal attribution);
 *   2. a stack that scores WORSE is checked LEAVE-ONE-OUT: for the new pushes
 *      (an agent's unit carrying a push the ratchet did not merge), the stack
 *      WITHOUT that agent's pushes is built and gated (a real gated tree).
 *      Pushes the failure's parse attributes come first, then push order; the
 *      round gates at most K (the speculate rule) and none once a run cap is
 *      reached. A push is a REGRESSOR only when removing it makes the stack
 *      score STRICTLY BETTER than the whole stack. Pushes that only work
 *      together (removing either one is worse or equal) are never blamed;
 *   3. SEAM GROUPS: a new push that edits a shared seam, together with the new
 *      pushes from holders that import the seam (blueprint importers, a seam
 *      wait, or a failure in their files naming the seam or a name it
 *      exports), is also removed as one candidate after its members' own. When
 *      removing the group makes the stack strictly better and no member alone
 *      did (each was tried alone), the SEAM PUSH is the regressor: a broken
 *      seam change is still found, and a consumer is never blamed for needing
 *      the seam;
 *   4. the whole stack is recorded as the failing revision with normal
 *      attribution (the fix requests go to the items its failures point at),
 *      each regressor is recorded `push.regressed` (addressed to the holder,
 *      quoting what its removal removes; not stacked until the holder pushes
 *      again), and, with at least one regressor, the stack without them is
 *      gated and recorded as the next revision. Every other push stays in the
 *      stack, so coupled work accumulates and is fixed through ordinary
 *      attribution.
 *
 * Under arbitration revision 7:
 *   - when the ratchet itself does not run the acceptance suite (its score is
 *     runs:false: measurement is blocked), a stack that scores no better (a
 *     tie included) is checked leave-one-out over EVERY push in it, the
 *     ratchet's own included, so a blocking push already in the ratchet can
 *     be isolated;
 *   - a regressor's blamed items are chosen among every item whose push its
 *     removal removed (the whole unit), preferring those the removed failures
 *     name, then its new items;
 *   - a seam consumer whose removal alone makes the stack better is not
 *     blamed when the failures its removal removes name the seam's module or
 *     a seam symbol: it defers to its seam group's result;
 *   - when the stack did not run the acceptance suite only because a
 *     developer suite failed first (not the typecheck), a push whose removal
 *     removes only failures in developer TEST files it did not touch is not
 *     blamed (a correct fix that makes a stale developer test fail first is
 *     kept; the failing revision's attribution and contract cue handle the
 *     stale test).
 *
 * Honesty: every recorded revision is exactly a gated tree on the integrated
 * head (the baseline: STALE_BASE applies), so gate-equals-deploy holds. The
 * ratchet never moves the head, never promotes, and never changes a verdict:
 * only a passing revision does, and only it is promoted. Leave-one-out trees
 * are evidence (each regression names its gated commit and score), never
 * verdicts. After the first pass, speculative gating takes over unchanged.
 */

import {
  arbitrationV7,
  BOARD_LIMITS,
  compareProgressScore,
  describeProgressScore,
  integratedHead,
  intentPath,
  pendingPushItems,
  planBoardIntegration,
  prePassRatchet,
  progressScore,
  seamWaits,
  type BoardIntegrationUnitPlan,
  type BoardItem,
  type BoardProgressScore,
  type BoardRevProgress,
  type BoardState,
} from "@switchyard-change/change-core";
import { gateFailureLine, inventoryAfterContracts, matchesGlob, type EvidenceSummary } from "@switchyard-change/verification";

import { redactSecrets } from "./redact.ts";
import {
  ABANDONED_REASON,
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

/** Failure lines quoted per regression (bounded by the board's limit). */
const EVIDENCE_LINES = 5;

/** Inputs to one ratchet round. */
export interface RatchetRoundOptions extends IntegrateBoardOptions {
  /** Leave-one-out candidates one round may gate (the speculate K; at least 1). */
  readonly isolate: number;
  /** Candidates built and gated at once (default: isolate; 1 keeps the order deterministic). */
  readonly candidateConcurrency?: number;
  /** A reason once a run cap is reached: no new candidate starts. */
  readonly stopCandidates?: () => string | undefined;
}

/** One leave-one-out candidate of a round: the whole stack WITHOUT these pushes, and what its tree showed. */
export interface RatchetIsolation {
  /** push: one agent's pushes; group: a seam push together with the new pushes that import its seam. */
  readonly kind: "push" | "group";
  /** The agent whose push the candidate removes (for a group: the seam push's). */
  readonly agent: string;
  /** Every agent whose pushes the candidate removes (sorted; the agent alone for a push). */
  readonly agents: readonly string[];
  /** The new items (pushes the ratchet did not merge) the candidate removes. */
  readonly items: readonly string[];
  /** The removed agent's (for a group: the seam push's) unit commit. */
  readonly commit: string;
  /** The candidate tree's gated commit (the whole stack without these pushes). */
  readonly candidate?: string;
  readonly score?: BoardProgressScore;
  /**
   * regressed: removing it made the stack strictly better and it is blamed
   * (a group blames its seam push); improves: a group whose removal made the
   * stack better that is not blamed (a member alone explains it, or not every
   * member was tried alone); kept: removing it is no better (coupled or
   * harmless: never blamed); unscored: nothing comparable; skipped: not gated.
   */
  readonly outcome: "regressed" | "improves" | "kept" | "unscored" | "skipped";
  readonly skipped?: string;
  /** Arbitration revision 7: why a candidate whose removal made the stack better is not blamed (a seam consumer, a stale developer test). */
  readonly reason?: string;
}

/** The result of one ratchet round. */
export interface RatchetRoundResult extends IntegrateBoardResult {
  /** Every revision the round recorded, in order (the whole stack, then the stack without the regressors). */
  readonly revisions?: readonly BoardRevision[];
  /** The ratchet the round compared against. */
  readonly ratchet?: { readonly n: number; readonly score: BoardProgressScore };
  /** The whole stack's score (when it had one). */
  readonly stackScore?: BoardProgressScore;
  /** The leave-one-out candidates, in order, when the whole stack scored worse than the ratchet. */
  readonly isolation?: readonly RatchetIsolation[];
  /** Items whose push the round recorded as a regressor (push.regressed). */
  readonly regressed?: readonly string[];
}

/**
 * The failure lines of a candidate's output that its reference's output does
 * not carry (type errors, failing tests, thrown errors), at most `max`, each
 * trimmed and bounded. With the whole stack as the candidate and the stack
 * without a push as the reference: what removing the push removes. Pure.
 */
export function regressionEvidence(candidate: string, reference: string, max = EVIDENCE_LINES): string[] {
  const known = new Set(reference.split(/\r?\n/).map((l) => l.trim()));
  const out = failureLinesNotIn(candidate, reference, Math.min(max, BOARD_LIMITS.maxRegressionEvidence));
  if (out.length === 0) {
    const key = gateFailureLine(candidate);
    if (key !== undefined && !known.has(key.trim())) {
      out.push(key.trim().slice(0, BOARD_LIMITS.maxRegressionEvidenceLine));
    }
  }
  return out;
}

/** Failure lines of `candidate` that `reference` does not carry (trimmed, bounded, deduplicated), at most `max`. Pure. */
function failureLinesNotIn(candidate: string, reference: string, max: number): string[] {
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
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/** Failure lines a stale-test or seam check reads (more than a regression quotes). */
const ANALYSIS_LINES = 200;

/** A source path in a failure line (`src/a.ts`, `tests/a.test.ts:12:5`). */
const SOURCE_PATH = /(?:^|[\s'"(`])(?:\.\/)?((?:[\w@.-]+\/)*[\w@.-]+\.[cm]?[jt]sx?)\b/g;

/** True for a test file path (`*.test.ts`, `*.spec.mjs`, or under a tests/ directory). */
function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(tests?|__tests__)\//.test(path);
}

/**
 * Arbitration revision 7: true when a stack whose acceptance suite did not
 * run only because a developer suite failed first (`progress`; a typecheck
 * failure never qualifies) is made better by removing pushes whose removed
 * failure lines (`removedLines`: what the removal removes) name only
 * developer TEST files none of `removedPaths` touched: a correct fix that
 * makes a stale developer test fail first, not a regression. Pure.
 */
export function staleDeveloperTestsOnly(progress: BoardRevProgress | undefined, removedLines: readonly string[], removedPaths: readonly string[]): boolean {
  if (progress?.acceptanceNotRun === undefined || !/developer suite failed first/.test(progress.acceptanceNotRun)) {
    return false;
  }
  if (removedLines.some((l) => /error TS\d+:/.test(l))) {
    return false;
  }
  const files = [...new Set(removedLines.flatMap((l) => [...l.matchAll(SOURCE_PATH)].map((m) => m[1]!)))];
  return files.length > 0 && files.every((f) => isTestFile(f) && !removedPaths.includes(f));
}

/**
 * True when a failure line names one of the seams `seamPaths` edits: its
 * module (`"../contracts/auth.ts"`, `src/contracts/auth.ts`) or a quoted name
 * the blueprint says it exports. Pure.
 */
export function namesSeam(state: BoardState, seamPaths: readonly string[], line: string): boolean {
  const seams = seamsEdited(state, seamPaths);
  if (seams.length === 0) {
    return false;
  }
  const symbols = [...new Set((state.seams ?? []).filter((s) => seams.includes(s.path)).flatMap((s) => s.symbols ?? []))];
  const modules = seams.map((p) => (p.split("/").pop() ?? p).replace(/\.[cm]?[jt]sx?$/, ""));
  return (
    seams.some((p) => line.includes(p)) ||
    modules.some((mod) => new RegExp(`["'][^"']*\\b${escapeRegExp(mod)}(\\.[cm]?[jt]sx?)?["']`).test(line)) ||
    symbols.some((sym) => line.includes(`'${sym}'`) || line.includes(`"${sym}"`))
  );
}

/** The shared seams a push's paths edit: the blueprint's seams and the shared seam files (sorted). Pure. */
export function seamsEdited(state: BoardState, paths: readonly string[]): string[] {
  const seams = new Set((state.seams ?? []).map((s) => s.path));
  return [...new Set(paths.filter((p) => seams.has(p) || SHARED_SEAM_GLOBS.some((g) => matchesGlob(p, g))))].sort().slice(0, BOARD_LIMITS.maxShortList);
}

/** One new push of a round as leave-one-out planning sees it. */
export interface LeaveOneOutPush {
  readonly agent: string;
  /** Its new items (pushes the ratchet did not merge). */
  readonly items: readonly BoardItem[];
  /** Every path its new pushes announced. */
  readonly paths: readonly string[];
  /** The earliest seq of its new pushes (its place in push order). */
  readonly seq: number;
  /** The whole stack's failure parse attributes one of its items. */
  readonly attributed: boolean;
  /** Arbitration revision 7: every item whose push removing this agent's unit removes (its new items and any the ratchet merged). */
  readonly removed?: readonly BoardItem[];
}

/** A planned candidate: remove these agents' pushes (a group names its seam push's agent). */
export interface LeaveOneOutCandidate {
  readonly kind: "push" | "group";
  readonly agent: string;
  readonly agents: readonly string[];
}

/** A type error line: its file and message. */
const ERROR_LINE = /^\s*(?:\.\/)?([^\s()]+)\(\d+,\d+\): error TS\d+: (.*)$/;

/**
 * The agents among `others` whose new pushes CONSUME a seam `seamPush` edits:
 * a blueprint importer of the seam is in their announced paths or write
 * intent, one of their items waits on the seam push's item (seamWaits), or a
 * type error in a file they pushed names the seam's module or a quoted name
 * it exports. Sorted. Pure.
 */
export function seamConsumers(state: BoardState, seamPush: LeaveOneOutPush, others: readonly LeaveOneOutPush[], output: string): string[] {
  const seams = seamsEdited(state, seamPush.paths);
  if (seams.length === 0) {
    return [];
  }
  const blueprint = (state.seams ?? []).filter((s) => seams.includes(s.path));
  const importers = new Set(blueprint.flatMap((s) => s.importers));
  const symbols = [...new Set(blueprint.flatMap((s) => s.symbols ?? []))];
  const modules = seams.map((p) => (p.split("/").pop() ?? p).replace(/\.[cm]?[jt]sx?$/, ""));
  const errors = output
    .split(/\r?\n/)
    .map((l) => ERROR_LINE.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  const seamItems = new Set(seamPush.items.map((i) => i.id));
  const consumes = (other: LeaveOneOutPush): boolean => {
    const writes = other.items.flatMap((i) => (i.intent?.write ?? i.scopeHint).map(intentPath));
    if ([...importers].some((imp) => other.paths.includes(imp) || writes.some((w) => w === imp || matchesGlob(imp, w)))) {
      return true;
    }
    if (other.items.some((i) => seamWaits(state, i.id).some((w) => seamItems.has(w.item)))) {
      return true;
    }
    return errors.some(
      (m) =>
        other.paths.includes(m[1]!) &&
        (modules.some((mod) => new RegExp(`["'][^"']*\\b${escapeRegExp(mod)}(\\.[cm]?[jt]sx?)?["']`).test(m[2]!)) ||
          symbols.some((sym) => m[2]!.includes(`'${sym}'`) || m[2]!.includes(`"${sym}"`))),
    );
  };
  return others
    .filter((o) => o.agent !== seamPush.agent && consumes(o))
    .map((o) => o.agent)
    .sort();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The round's leave-one-out candidates, in order (deterministic): each new
 * push alone, those the failure's parse attributes first, then push order
 * (then agent); each seam group right after the last of its members' own
 * candidates. `consumersOf` names a push's seam consumers (empty for a push
 * that edits no seam). Pure.
 */
export function leaveOneOutPlan(pushes: readonly LeaveOneOutPush[], consumersOf: (push: LeaveOneOutPush) => readonly string[]): LeaveOneOutCandidate[] {
  const order = [...pushes].sort(
    (a, b) => Number(b.attributed) - Number(a.attributed) || a.seq - b.seq || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0),
  );
  const plan: LeaveOneOutCandidate[] = order.map((p) => ({ kind: "push", agent: p.agent, agents: [p.agent] }));
  const seen = new Set<string>();
  for (const seam of order) {
    const consumers = consumersOf(seam).filter((a) => a !== seam.agent && pushes.some((p) => p.agent === a));
    if (consumers.length === 0) {
      continue;
    }
    const agents = [seam.agent, ...consumers].sort();
    const key = agents.join(",");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const after = Math.max(...agents.map((a) => plan.findIndex((c) => c.kind === "push" && c.agent === a)));
    plan.splice(groupSlot(plan, after), 0, { kind: "group", agent: seam.agent, agents });
  }
  return plan;
}

/** The slot right after `after` and any groups already placed there (groups keep their planning order). */
function groupSlot(plan: readonly LeaveOneOutCandidate[], after: number): number {
  let slot = after + 1;
  while (slot < plan.length && plan[slot]!.kind === "group") {
    slot += 1;
  }
  return slot;
}

/** A gated candidate's output as one text (its gate's outputs and the integrator's summary). */
function outputOf(evidence: EvidenceSummary | undefined): string {
  if (evidence === undefined) {
    return "";
  }
  const check = evidence.integration.finalCheck;
  return [...check.outputs.map((o) => o.text), check.summary].join("\n");
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
  const excludedPushes = await recordExcludedPushes(options.operator, verificationExcluded, options.abandoned);
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

  /** A failing gated tree's attribution (as any failing revision is attributed), with the advisory decisions it took. */
  const attributionOf = async (c: BuiltCandidate, s: BoardState) => {
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
    return { failingEvidence, decisions };
  };
  /** Record a gated tree as a revision, attributed as any failing revision is. */
  const recordAttributed = async (
    c: BuiltCandidate,
    s: BoardState,
    p: readonly BoardItem[],
    excluded: readonly { agent: string; reason: string }[],
    attribution?: Awaited<ReturnType<typeof attributionOf>>,
  ) => {
    const { failingEvidence, decisions } = attribution ?? (await attributionOf(c, s));
    return recordBuiltCandidate(recordCtx(s, p), c, {
      revExcluded: excluded,
      ...(failingEvidence ? { failingEvidence } : {}),
      decisions,
      nFallback: s.lastRevN + 1,
    });
  };
  /** Record the whole stack as before (no leave-one-out ran, or it found no regressor). */
  const recordWhole = async (extra: Partial<RatchetRoundResult>, attribution?: Awaited<ReturnType<typeof attributionOf>>, note?: string): Promise<RatchetRoundResult> => {
    const moved = await superseded(candidateItems(whole));
    if (moved.length > 0) {
      return stale(moved, whole.evidence, extra);
    }
    const result = await recordAttributed(whole, state, pending, revExcluded, withNote(attribution, note));
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
  const v7 = arbitrationV7(state);
  const versus = wholeScore !== undefined ? compareProgressScore(wholeScore, ratchet.score) : 0;
  // Revision 7: with the ratchet's own measurement blocked (runs:false), a stack no better than it
  // (a tie too) is checked over every push in it, the ratchet's own included.
  const blocked = v7 && whole.gate === "fail" && wholeScore !== undefined && !ratchet.score.runs && !wholeScore.runs && versus <= 0;
  const worse = (whole.gate === "fail" && wholeScore !== undefined && versus < 0) || blocked;
  const inWhole = stack.filter((e) => whole.mergedAgents.includes(e.unit.agent));
  const newItemsOf = (e: StackEntry): BoardItem[] =>
    blocked ? [...e.unit.items] : e.unit.items.filter((i) => !ratchetCommits.has(i.lastPush!.commit));
  const newEntries = inWhole.filter((e) => newItemsOf(e).length > 0);
  if (!worse || newEntries.length === 0) {
    return recordWhole({});
  }

  // 2. Leave-one-out: the whole stack without each new push (and each seam group), in a deterministic order.
  const attribution = await attributionOf(whole, state);
  const blamedByParse = new Set([...(attribution.failingEvidence?.failing.items ?? []), ...(attribution.failingEvidence?.implicated.items ?? [])]);
  const wholeOutput = outputOf(whole.evidence);
  const pushes: LeaveOneOutPush[] = newEntries.map((e) => {
    const items = newItemsOf(e);
    return {
      agent: e.unit.agent,
      items,
      paths: [...new Set(items.flatMap((i) => i.lastPush!.paths))].sort(),
      seq: Math.min(...items.map((i) => i.lastPush!.seq)),
      attributed: items.some((i) => blamedByParse.has(i.id)),
      ...(v7 ? { removed: [...e.unit.items] } : {}),
    };
  });
  const pushOf = new Map(pushes.map((p) => [p.agent, p]));
  const planned = leaveOneOutPlan(pushes, (p) => seamConsumers(state, p, pushes, wholeOutput));
  const entryByAgent = new Map(inWhole.map((e) => [e.unit.agent, e]));
  const removedItems = (agents: readonly string[]): string[] => agents.flatMap((a) => pushOf.get(a)!.items.map((i) => i.id));
  const describe = (c: LeaveOneOutCandidate): Omit<RatchetIsolation, "outcome"> => ({
    kind: c.kind,
    agent: c.agent,
    agents: [...c.agents],
    items: removedItems(c.agents),
    commit: entryByAgent.get(c.agent)!.unit.commit,
  });
  const limit = Math.max(1, Math.floor(options.isolate));
  const chosen = planned.slice(0, limit);
  const gated = await inPool(chosen.length, Math.max(1, options.candidateConcurrency ?? limit), async (index): Promise<{ isolation: RatchetIsolation; built?: BuiltCandidate }> => {
    const c = chosen[index - 1]!;
    const capped = options.stopCandidates?.();
    if (capped !== undefined) {
      return { isolation: { ...describe(c), outcome: "skipped", skipped: `not built: ${capped}` } };
    }
    const remaining = inWhole.filter((e) => !c.agents.includes(e.unit.agent));
    if (remaining.length === 0) {
      return { isolation: { ...describe(c), outcome: "skipped", skipped: "nothing would be left in the stack" } };
    }
    const built = await gateCandidateTree(ctx, index + 1, remaining);
    if (built.commit === undefined || built.gate === undefined || remaining.some((e) => !built.mergedAgents.includes(e.unit.agent))) {
      return { isolation: { ...describe(c), outcome: "skipped", skipped: built.skipped ?? "the tree without it left out other pushes too" } };
    }
    const score = progressScore(built.progress);
    const outcome: RatchetIsolation["outcome"] = score === undefined ? "unscored" : compareProgressScore(score, wholeScore!) > 0 ? "regressed" : "kept";
    return { isolation: { ...describe(c), candidate: built.commit, ...(score ? { score } : {}), outcome }, built };
  });
  // Revision 7: a candidate whose removal made the stack better is not blamed when that is a seam
  // consumer's need of the seam (it defers to its seam group) or only a stale developer test.
  const deferred = new Set<string>();
  const reviewed = gated.map((g) => {
    if (!v7 || g.isolation.outcome !== "regressed" || g.built === undefined) {
      return g;
    }
    const removedLines = failureLinesNotIn(wholeOutput, outputOf(g.built.evidence), ANALYSIS_LINES);
    if (g.isolation.kind === "push") {
      const groups = planned.filter((c) => c.kind === "group" && c.agent !== g.isolation.agent && c.agents.includes(g.isolation.agent));
      if (groups.some((c) => removedLines.some((l) => namesSeam(state, pushOf.get(c.agent)!.paths, l)))) {
        deferred.add(g.isolation.agent);
        return {
          ...g,
          isolation: { ...g.isolation, outcome: "improves" as const, reason: "a seam consumer: what its removal removes names the seam, so it defers to its seam group" },
        };
      }
    }
    const removedPaths = [...new Set(g.isolation.agents.flatMap((a) => (pushOf.get(a)!.removed ?? pushOf.get(a)!.items).flatMap((i) => i.lastPush!.paths)))];
    if (staleDeveloperTestsOnly(whole.progress, removedLines, removedPaths)) {
      return {
        ...g,
        isolation: {
          ...g.isolation,
          outcome: "kept" as const,
          reason: "its removal only removes failures in developer test files it did not touch (a stale test that fails first): kept, never blamed",
        },
      };
    }
    return g;
  });
  // A group blames its seam push only when every member was tried alone and none alone made the stack better
  // (a deferred consumer counts as no better).
  const alone = new Map(reviewed.filter((g) => g.isolation.kind === "push").map((g) => [g.isolation.agent, g.isolation]));
  const decided = reviewed.map((g) => {
    if (g.isolation.kind !== "group" || g.isolation.outcome !== "regressed") {
      return g;
    }
    const explained = g.isolation.agents.some((a) => alone.get(a)?.outcome !== "kept" && !deferred.has(a));
    return explained ? { ...g, isolation: { ...g.isolation, outcome: "improves" as const } } : g;
  });
  const isolation: RatchetIsolation[] = [
    ...decided.map((g) => g.isolation),
    ...planned.slice(chosen.length).map((c) => ({ ...describe(c), outcome: "skipped" as const, skipped: `not gated: beyond this round's ${limit} leave-one-out candidate(s); stacked as usual` })),
  ];
  // The regressors: a push whose removal alone improves the stack, or a group's seam push.
  const regressors = decided.filter((g) => g.isolation.outcome === "regressed").map((g) => ({ agent: g.isolation.agent, isolation: g.isolation, built: g.built! }));
  const blamedAgents = [...new Set(regressors.map((r) => r.agent))];
  const tried = decided.filter((g) => g.built !== undefined);
  const note =
    tried.length === 0
      ? undefined
      : `pre-pass ratchet: this stack scores ${describeProgressScore(wholeScore!)}, ${versus < 0 ? "worse than" : "no better than"} the best revision so far (revision ${ratchet.n}: ${describeProgressScore(ratchet.score)}); ` +
        `the same stack without:\n` +
        tried
          .map((g) => {
            const i = g.isolation;
            const what =
              i.reason !== undefined
                ? `better, not blamed: ${i.reason}`
                : i.outcome === "regressed"
                  ? `strictly better: ${i.kind === "group" ? `the seam push of ${i.agent} is` : "it is"} not stacked until its holder pushes again`
                  : i.outcome === "improves"
                    ? "better, explained by a push alone (not blamed as a group)"
                    : "no better: kept (pushes that work together are never blamed)";
            return `  ${i.items.join(", ")} (${i.agents.join(", ")}): ${i.score ? describeProgressScore(i.score) : "no score"}: ${what}`;
          })
          .join("\n") +
        "\n";
  if (blamedAgents.length === 0) {
    return recordWhole({ isolation }, attribution, note);
  }

  // 3. The whole stack as the failing revision, attributed as usual.
  const moved = await superseded(candidateItems(whole));
  if (moved.length > 0) {
    return stale(moved, whole.evidence, { isolation });
  }
  const first = await recordAttributed(whole, state, pending, revExcluded, withNote(attribution, note));
  if (!first.revision) {
    return { requiresIntegrationGate, key, evidence: whole.evidence!, ...(first.stale ? { stale: true } : {}), failure: first.failure!, isolation };
  }
  const revisions: BoardRevision[] = [first.revision];
  // Abandoned (the interrupt grace ended) after the first revision: nothing
  // more is recorded (no push.regressed, no second revision).
  const abandonedAfterFirst = (): RatchetRoundResult => ({
    revision: first.revision!,
    revisions,
    evidence: whole.evidence!,
    requiresIntegrationGate,
    key,
    ratchet: ratchetInfo,
    stackScore: wholeScore!,
    isolation,
    regressed: [],
    ...(excludedPushes > 0 ? { excludedPushes } : {}),
    failure: ABANDONED_REASON,
  });
  if (options.abandoned?.()) {
    return abandonedAfterFirst();
  }

  // 4. Each regressor, addressed to its holder, with what its removal removes and the seam hint.
  const regressed: string[] = [];
  const blamedBy = new Map<string, string[]>();
  for (const r of regressors) {
    const evidence = regressionEvidence(wholeOutput, outputOf(r.built.evidence)).map((l) => scrub(l));
    for (const item of blamedItems(state, pushOf.get(r.agent)!.items, r.isolation.kind, evidence, pushOf.get(r.agent)!.removed)) {
      if (options.abandoned?.()) {
        return { ...abandonedAfterFirst(), regressed };
      }
      const seams = seamsEdited(state, item.lastPush!.paths);
      const outcome = await options.operator
        .recordEngine("push.regressed", {
          item: item.id,
          agent: item.lastPush!.agent,
          commit: item.lastPush!.commit,
          rev: first.revision.n,
          ratchet: ratchet.n,
          from: r.isolation.score!,
          to: wholeScore!,
          candidate: r.built.commit!,
          evidence,
          ...(seams.length > 0 ? { seams } : {}),
        })
        .catch(() => undefined);
      if (outcome?.ok) {
        regressed.push(item.id);
        blamedBy.set(r.agent, [...(blamedBy.get(r.agent) ?? []), item.id]);
      }
    }
  }

  // 5. The stack without the regressors (they wait for their holders' next push), as the next revision.
  if (options.abandoned?.()) {
    return { ...abandonedAfterFirst(), regressed };
  }
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
  // A leave-one-out tree that is exactly this stack is recorded as it was gated (no second gate of the same tree).
  const same = regressors.find((r) => keyOf(candidateItems(r.built).map((i) => i.lastPush!.commit)) === restKey);
  let t: BuiltCandidate;
  const restExcluded: { agent: string; reason: string }[] = [];
  if (same !== undefined) {
    t = same.built;
  } else {
    const restEntries: StackEntry[] = [];
    for (const unit of rest.units) {
      const entry = await entryOf(unit, false);
      if (entry) {
        restEntries.push(entry);
      } else {
        restExcluded.push({ agent: unit.agent, reason: "its repo could not be read for the stack without the regressors" });
      }
    }
    if (restEntries.length === 0) {
      return done();
    }
    t = await gateCandidateTree({ ...ctx, state: after.state }, chosen.length + 2, restEntries);
    if (t.commit === undefined || t.gate === undefined) {
      return done({ failure: t.skipped ?? "the stack without the regressors could not be gated" });
    }
  }
  const movedRest = await superseded(candidateItems(t));
  if (movedRest.length > 0) {
    // Run again on the newer pushes; the whole stack's revision stays recorded.
    return { ...done(), key, stale: true, supersededAgents: movedRest, failure: "a merged push was superseded while the gate ran" };
  }
  const second = await recordAttributed(t, after.state, [...rest.pending], [
    ...restExcluded,
    ...t.excludedAgents,
    ...[...blamedBy].map(([agent, ids]) => ({
      agent,
      reason: `its push for ${ids.join(", ")} made revision ${first.revision!.n} worse (push.regressed): not stacked until its holder pushes again`,
    })),
  ]);
  if (!second.revision) {
    return { ...done(), key, ...(second.stale ? { stale: true } : {}), failure: second.failure! };
  }
  revisions.push(second.revision);
  return done({ evidence: t.evidence! });
}

/**
 * The items of a regressor's unit that are blamed: for a seam group, the
 * items whose push edits a shared seam; for one push, the items whose
 * announced paths the removed failures name (every new item when none is
 * named, or when an agent's unit carries just one). Under arbitration
 * revision 7 `removed` is every item whose push the removal removed (the
 * whole unit: leave-one-out removes an agent's unit, pinned to its latest
 * commit, not its new items alone): the named ones among them are blamed,
 * else the new items, else (no new item: a ratchet push isolated while
 * measurement is blocked) every removed item. Pure.
 */
export function blamedItems(
  state: BoardState,
  items: readonly BoardItem[],
  kind: RatchetIsolation["kind"],
  evidence: readonly string[],
  removed?: readonly BoardItem[],
): BoardItem[] {
  const pool = removed !== undefined && removed.length > 0 ? removed : items;
  if (kind === "group") {
    const seamItems = pool.filter((i) => seamsEdited(state, i.lastPush!.paths).length > 0);
    return seamItems.length > 0 ? seamItems : [...(items.length > 0 ? items : pool)];
  }
  if (pool.length <= 1) {
    return [...pool];
  }
  const named = pool.filter((i) => i.lastPush!.paths.some((p) => evidence.some((l) => l.includes(p))));
  return named.length > 0 ? named : [...(items.length > 0 ? items : pool)];
}

/** An attribution with the round's leave-one-out note leading its failing output (bounded). */
function withNote<T extends { failingEvidence?: { failing: { output: string } } }>(attribution: T | undefined, note: string | undefined): T | undefined {
  if (attribution?.failingEvidence === undefined || note === undefined) {
    return attribution;
  }
  const output = `${note}${attribution.failingEvidence.failing.output}`;
  return {
    ...attribution,
    failingEvidence: {
      ...attribution.failingEvidence,
      failing: {
        ...attribution.failingEvidence.failing,
        output: output.length > BOARD_LIMITS.maxFailingOutput ? `${output.slice(0, BOARD_LIMITS.maxFailingOutput - 40)}\n... (output truncated)` : output,
      },
    },
  };
}

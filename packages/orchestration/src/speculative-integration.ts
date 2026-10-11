/**
 * speculative-integration: SPECULATIVE BATCH GATING for the local continuous
 * integrator (the goal rule `speculate`, K > 1).
 *
 * One integration round today merges every pending push into one revision:
 * when its gate fails, every merged push is implicated, so one bad push sinks
 * the good ones and burns their owners' fix budgets. A speculative round
 * instead orders the pending pushes into a STACK (by push seq; see
 * speculativeUnits) and builds up to K prefix CANDIDATES on the integrated
 * head:
 *
 *     C1 = head + p1,  C2 = head + p1 + p2,  ...,  CK = head + p1 + ... + pK
 *
 * Speculation needs a head that PASSED the gate (a recorded passing
 * revision): only then does a candidate's failure say something about the
 * push it added. While the head is still the goal's baseline (which may fail
 * the gate: the gaps the goal is about), the integrator integrates every
 * pending push as one revision, exactly as without speculation.
 *
 * Each candidate is a real integrated tree with its own commit, built and
 * gated exactly like a revision (the same verifier and integrator, the same
 * immutable gate, contract restore, dependency install, and test inventory),
 * each in its own disposable work directories, with bounded concurrency. Then
 * (see decideSpeculativeLanding):
 *
 *   - the LONGEST prefix C1..Ck that all passed lands as ONE passing revision
 *     whose recorded commit is exactly Ck's gated commit, built on the head
 *     (STALE_BASE applies: a head that moved while the candidates gated is a
 *     rebuild, never a wrong landing);
 *   - when C(k+1) FAILED, its last push p(k+1) is the only difference from Ck
 *     (or from the head, when k = 0 and C1 is p1 alone), so the failure is
 *     attributed to it: C(k+1) is recorded as a failing revision built on the
 *     same head, whose implicated items are p(k+1)'s only (narrowed further by
 *     the gate output's test titles and error locations, never stack frames).
 *     The board's existing fix loop then charges only those items. It is
 *     recorded BEFORE the landed pass (a failing revision does not move the
 *     head), so both name the head they were built on and the pass stays the
 *     latest revision;
 *   - every candidate after the first non-pass is NOT blamed: its push stays
 *     pending and is re-tested next round on the new head (the blamed push
 *     waits for its owner's fix, so it no longer sits ahead of it). Each round
 *     decides at least its first candidate's push (it lands or is blamed), so
 *     a re-tested push is decided within as many rounds as pushes ahead of it.
 *
 * Every gated candidate is recorded as `candidate.gated` (engine-only) after
 * the revisions, citing the revision it backs; only revisions are verdicts.
 * Caps (`stopCandidates`) stop NEW candidates: C1 is always built (the round
 * finishes what is in flight), the speculative ones are not.
 */

import {
  decideSpeculativeLanding,
  integratedHead,
  pendingPushItems,
  planBoardIntegration,
  speculationStateKey,
  speculativeUnits,
  type BoardCandidatePush,
  type BoardIntegrationUnitPlan,
  type BoardItem,
  type BoardRevProgress,
  type BoardState,
  type Change,
} from "@switchyard-change/change-core";
import {
  advanceIntegrationBranch,
  ChangeVerification,
  InstallingCommandRunner,
  inventoryAfterContracts,
  isIntegrationAborted,
  isPromotionRefused,
  labelGateProgress,
  readTestProgress,
  type CommandOutcome,
  type CommandRunner,
  type CommandRunOptions,
  type CompletedWorkUnit,
  type DependencyInstallOutcome,
  type EvidenceSummary,
  type TestInventory,
} from "@switchyard-change/verification";

import { redactSecrets } from "./redact.ts";
import {
  ABANDONED_REASON,
  appliedForRevision,
  completedFromPlan,
  failingRevisionEvidence,
  flushAttributionDecisions,
  keyWithout,
  recordExcludedPushes,
  revisionFailure,
  supersededAgentsNow,
  verifySubLeadMerges,
  type BoardDecisionRecord,
  type BoardRevision,
  type IntegrateBoardOptions,
  type IntegrateBoardResult,
} from "./run-board.ts";

/** The default and the largest number of prefix candidates a round gates. */
export const DEFAULT_SPECULATE = 3;
export const MAX_SPECULATE = 8;

/** Inputs to one speculative round (K = `speculate`, at least 2). */
export interface SpeculativeRoundOptions extends IntegrateBoardOptions {
  readonly speculate: number;
  /** Candidates built and gated at once (default K; 1 gates them one after another, in order). */
  readonly candidateConcurrency?: number;
  /**
   * A reason once a run cap is reached: no NEW speculative candidate starts
   * (C1 is always built). Checked before each candidate after the first.
   */
  readonly stopCandidates?: () => string | undefined;
}

/** One candidate of a round, as the round decided it. */
export interface CandidateOutcome {
  readonly index: number;
  readonly prefix: readonly BoardCandidatePush[];
  /** The candidate's gated commit (absent: it was not built, or nothing was gated). */
  readonly commit?: string;
  readonly gate?: "pass" | "fail";
  readonly outcome?: "landed" | "passed" | "blamed" | "retest";
  /** The revision it backs (landed: the passing one; blamed: the failing one). */
  readonly rev?: number;
  readonly blamed?: readonly string[];
  readonly progress?: BoardRevProgress;
  /** Why it was not built or not gated (a cap, a shorter prefix that failed, the integrator refused). */
  readonly skipped?: string;
}

/** The result of one speculative round. */
export interface SpeculativeRoundResult extends IntegrateBoardResult {
  /** Every revision the round recorded, in order (a blamed failure first, then the landed pass). */
  readonly revisions?: readonly BoardRevision[];
  /** Every candidate of the round (built or not), by index. */
  readonly candidates?: readonly CandidateOutcome[];
}

/**
 * A command runner that remembers the dependency install of the last command
 * IT ran: candidates gate concurrently, so the shared installing runner's
 * single "last install" slot cannot say which install preceded which gate.
 * The install itself is the shared runner's (once per tree and manifest).
 */
class CandidateCommandRunner implements CommandRunner {
  lastInstall: DependencyInstallOutcome | undefined;
  constructor(private readonly inner: CommandRunner) {}
  async run(argv: readonly string[], cwd: string, options?: CommandRunOptions): Promise<CommandOutcome> {
    if (this.inner instanceof InstallingCommandRunner) {
      this.lastInstall = await this.inner.installFor(cwd, options);
    }
    return options === undefined ? this.inner.run(argv, cwd) : this.inner.run(argv, cwd, options);
  }
}

/** One stacked unit: the plan's unit and its fresh read remote. */
export interface StackEntry {
  readonly unit: BoardIntegrationUnitPlan;
  readonly remote: string;
}

/** A candidate as built and gated. */
export interface BuiltCandidate {
  readonly index: number;
  readonly entries: readonly StackEntry[];
  readonly evidence?: EvidenceSummary;
  readonly commit?: string;
  readonly gate?: "pass" | "fail";
  readonly gated?: boolean;
  readonly install?: DependencyInstallOutcome;
  readonly progress?: BoardRevProgress;
  readonly mergedAgents: readonly string[];
  readonly excludedAgents: readonly { agent: string; reason: string }[];
  readonly skipped?: string;
  /** The integrator refused to build this candidate's tree (it threw). */
  readonly refused?: string;
}

/** The pushes of a stack prefix, as a candidate record names them. */
function prefixOf(entries: readonly StackEntry[]): BoardCandidatePush[] {
  return entries.map((e) => ({ agent: e.unit.agent, items: e.unit.items.map((i) => i.id), commit: e.unit.commit }));
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
 * Run one speculative round (see the module comment). Records the revisions
 * and the candidates on the board; returns them, or why nothing was recorded.
 */
export async function integrateSpeculativeRound(options: SpeculativeRoundOptions): Promise<SpeculativeRoundResult> {
  const scrub = options.scrub ?? redactSecrets;
  const requiresIntegrationGate = Boolean(options.appGateCommand && options.appGateCommand.length > 0) || options.requireAppGate === true;
  const speculate = Math.max(2, Math.min(MAX_SPECULATE, Math.floor(options.speculate)));
  const board = await options.operator.log();
  const state = board.state;
  const plan = planBoardIntegration(board.messages, state);
  let key = speculationStateKey(state);
  const pending = [...plan.pending];
  if (key === "") {
    return { requiresIntegrationGate, key, failure: "nothing is pending" };
  }
  if (state.integrated === null) {
    // Blame needs a head known to pass: the caller integrates as one revision until one passed.
    return { requiresIntegrationGate, key, failure: "speculation needs a passing integrated head (no revision has passed yet)" };
  }

  // The stack: up to K units in push order, each read with a fresh operator
  // read token (once per round). The rest wait for the next round.
  const excludedAgents: { agent: string; reason: string }[] = [];
  const stack: StackEntry[] = [];
  for (const unit of speculativeUnits(plan)) {
    if (stack.length >= speculate) {
      break;
    }
    const agent = unit.agent;
    if (!options.agentRepos.get(agent)) {
      excludedAgents.push({ agent, reason: "no repo is known for this agent" });
      continue;
    }
    if (options.holdBack?.includes(agent)) {
      excludedAgents.push({ agent, reason: "held back: its pushes kept being superseded while the gate ran; they stay pending" });
      continue;
    }
    try {
      stack.push({ unit, remote: await options.readRemote(agent) });
    } catch (error) {
      excludedAgents.push({ agent, reason: scrub(`could not read its repo: ${error instanceof Error ? error.message : String(error)}`) });
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

  // The same inventory (adjusted for accepted contracts) for every candidate.
  const acceptedTargets = [...new Set(Object.values(state.contracts).filter((c) => c.status === "accepted" && c.guarded).map((c) => c.target))].sort();
  const adjusted = options.testInventory ? inventoryAfterContracts(options.testInventory, acceptedTargets) : {};
  const inventoryNow = adjusted.inventory;
  const head = integratedHead(state);

  const ctx: CandidateContext = { options, state, scrub, requiresIntegrationGate, ...(inventoryNow ? { inventory: inventoryNow } : {}) };
  const gateCandidate = (index: number, entries: readonly StackEntry[]): Promise<BuiltCandidate> => gateCandidateTree(ctx, index, entries);

  // Build and gate the candidates: C1 always; a later one only while no cap
  // is reached and no shorter prefix is already known to have failed.
  const known = new Map<number, BuiltCandidate>();
  const built = await inPool(stack.length, Math.max(1, options.candidateConcurrency ?? speculate), async (index) => {
    const entries = stack.slice(0, index);
    if (index > 1) {
      const capped = options.stopCandidates?.();
      if (capped !== undefined) {
        return { index, entries, mergedAgents: [], excludedAgents: [], skipped: `not built: ${capped}` } satisfies BuiltCandidate;
      }
      const failedBefore = [...known.values()].find((c) => c.index < index && c.gate !== "pass");
      if (failedBefore !== undefined) {
        return { index, entries, mergedAgents: [], excludedAgents: [], skipped: `not built: candidate ${failedBefore.index} did not pass` } satisfies BuiltCandidate;
      }
    }
    const candidate = await gateCandidate(index, entries);
    known.set(index, candidate);
    return candidate;
  });

  // Pushes the verifier left out of a candidate's tree (or that alone made the
  // integrator refuse C1, the head plus that push only) are recorded excluded,
  // addressed to their holders: they leave the stack until their holder pushes
  // again, so the pushes behind them can land.
  const excludedByVerification = new Map<string, string>();
  for (const c of built) {
    for (const e of c.excludedAgents) {
      if (!excludedByVerification.has(e.agent)) {
        excludedByVerification.set(e.agent, e.reason);
      }
    }
  }
  const firstBuilt = built[0];
  if (firstBuilt?.refused !== undefined && firstBuilt.entries.length === 1 && !excludedByVerification.has(firstBuilt.entries[0]!.unit.agent)) {
    excludedByVerification.set(firstBuilt.entries[0]!.unit.agent, firstBuilt.refused);
  }
  const excludedUnits = stack
    .filter((e) => excludedByVerification.has(e.unit.agent))
    .map((e) => ({ agent: e.unit.agent, items: [...e.unit.items], reason: excludedByVerification.get(e.unit.agent)! }));
  const excludedPushes = await recordExcludedPushes(options.operator, excludedUnits, options.abandoned);
  if (excludedPushes > 0) {
    key = keyWithout(key, excludedUnits);
  }

  const landing = decideSpeculativeLanding(built.map((c) => ({ index: c.index, ...(c.gate !== undefined ? { gate: c.gate } : {}) })));
  const landed = landing.landed !== undefined ? built[landing.landed - 1]! : undefined;
  let blamed = landing.blamed !== undefined ? built[landing.blamed - 1]! : undefined;
  // The blamed push must be IN the failing candidate's tree (a push the
  // verifier excluded changed nothing there): otherwise nothing is blamed.
  const blamedEntry = blamed ? blamed.entries.at(-1)! : undefined;
  if (blamed && !blamed.mergedAgents.includes(blamedEntry!.unit.agent)) {
    blamed = undefined;
  }
  const itemsOf = candidateItems;

  if (!landed && !blamed) {
    // Nothing gated can be recorded: C1 could not be built or gated. When a
    // push was recorded excluded, the stack rebuilds without it next.
    const first = built[0]!;
    return {
      requiresIntegrationGate,
      key,
      ...(excludedPushes > 0 ? { excludedPushes } : {}),
      ...(first.evidence ? { evidence: first.evidence } : {}),
      failure: first.skipped ?? "the first candidate could not be gated",
      candidates: built.map((c) => outcomeOf(c, undefined)),
    };
  }

  // Every push the round would record must still be its item's latest.
  const now = new Set(pendingPushItems((await options.operator.page(0, 1)).state).map((i) => i.lastPush!.commit));
  const superseded = [...(landed ? itemsOf(landed) : []), ...(blamed ? itemsOf(blamed) : [])].filter((i) => !now.has(i.lastPush!.commit));
  if (superseded.length > 0) {
    return {
      requiresIntegrationGate,
      key,
      ...((landed ?? blamed)!.evidence ? { evidence: (landed ?? blamed)!.evidence! } : {}),
      stale: true,
      supersededAgents: [...new Set(superseded.map((i) => i.lastPush!.agent))].sort(),
      failure: "a merged push was superseded while the candidates gated",
    };
  }

  const revisions: BoardRevision[] = [];
  const outcomes = new Map<number, { rev?: number; blamed?: readonly string[] }>();
  const record = (
    c: BuiltCandidate,
    failingEvidence?: { failing: { output: string; items: string[]; outstanding?: string[] }; implicated: NonNullable<BoardRevision["implicated"]> },
    decisions: BoardDecisionRecord[] = [],
  ): Promise<{ revision?: BoardRevision; failure?: string; stale?: boolean; supersededAgents?: readonly string[] }> =>
    recordBuiltCandidate({ ...ctx, ...(head !== undefined ? { head } : {}), pending, ...(adjusted.relaxed !== undefined ? { inventoryNote: adjusted.relaxed } : {}) }, c, {
      revExcluded: [
        ...excludedAgents,
        ...c.excludedAgents,
        ...stack.slice(c.index).map((e) => ({
          agent: e.unit.agent,
          reason: `speculative: not in candidate ${c.index}; its push stays pending for the next round`,
        })),
      ],
      ...(failingEvidence ? { failingEvidence } : {}),
      decisions,
      nFallback: state.lastRevN + revisions.length + 1,
    });

  // 1. The blamed candidate, as a failing revision on the head: attributed to
  //    its last push's items only. With nothing landed (C1 is that push alone)
  //    the advisory typed decision may narrow among them, as for any failing
  //    revision; after a landed prefix it does not (the landed pass that
  //    follows would resolve its pick at once), and the parse narrows alone.
  if (blamed) {
    const decisions: BoardDecisionRecord[] = [];
    const evidence = await failingRevisionEvidence({
      state,
      check: blamed.evidence!.integration.finalCheck,
      scrub,
      items: [...blamedEntry!.unit.items],
      // The candidate also carries the landed prefix: those pushes are in its tree, never outstanding.
      inTree: itemsOf(blamed),
      changeId: options.change.id,
      ...(options.jev && !landed ? { jev: options.jev } : {}),
      ...(options.jevThreshold !== undefined ? { jevThreshold: options.jevThreshold } : {}),
      ...(options.recordDecision && !landed ? { onDecision: async (decision: BoardDecisionRecord) => void decisions.push(decision) } : {}),
    });
    const result = await record(blamed, evidence, decisions);
    if (!result.revision) {
      return {
        requiresIntegrationGate,
        key,
        evidence: blamed.evidence!,
        ...(result.stale ? { stale: true, ...(result.supersededAgents ? { supersededAgents: result.supersededAgents } : {}) } : {}),
        failure: result.failure!,
      };
    }
    revisions.push(result.revision);
    outcomes.set(blamed.index, { rev: result.revision.n, blamed: evidence.failing.items });
  }

  // 2. The landed prefix, as ONE passing revision whose commit is exactly its
  //    gated candidate's (still built on the head: a failing revision does not move it).
  if (landed) {
    const result = await record(landed);
    if (!result.revision) {
      // The landed pass was refused, so the latest RECORDED revision (if any)
      // is the blamed failure: its evidence is the round's, never the
      // unrecorded candidate's (gate-equals-deploy: an unrecorded pass is
      // never promoted or redeployed).
      return {
        requiresIntegrationGate,
        key,
        evidence: revisions.length > 0 ? blamed!.evidence! : landed.evidence!,
        ...(revisions.length > 0 ? { revision: revisions.at(-1)!, revisions } : {}),
        ...(result.stale ? { stale: true, ...(result.supersededAgents ? { supersededAgents: result.supersededAgents } : {}) } : {}),
        failure: result.failure!,
      };
    }
    revisions.push(result.revision);
    outcomes.set(landed.index, { rev: result.revision.n });
  }

  // 3. Every gated candidate, recorded after the revisions it backs.
  const round = Math.max(0, ...board.messages.flatMap((m) => (m.type === "candidate.gated" ? [m.payload.round] : []))) + 1;
  const candidates: CandidateOutcome[] = [];
  for (const c of built) {
    const outcome: CandidateOutcome["outcome"] | undefined =
      c.commit === undefined || c.gate === undefined
        ? undefined
        : c.index === landed?.index
          ? "landed"
          : c.index === blamed?.index
            ? "blamed"
            : landing.passed.includes(c.index)
              ? "passed"
              : "retest";
    const linked = outcomes.get(c.index);
    const candidate = outcomeOf(c, outcome, linked);
    candidates.push(candidate);
    // An abandoned attempt records nothing more (see ABANDONED_REASON).
    if (outcome === undefined || options.abandoned?.()) {
      continue;
    }
    await options.operator
      .recordEngine("candidate.gated", {
        round,
        index: c.index,
        of: built.length,
        prefix: prefixOf(c.entries),
        commit: c.commit!,
        ...(head !== undefined ? { base: head } : {}),
        verdict: c.gate!,
        outcome,
        ...(linked?.rev !== undefined ? { rev: linked.rev } : {}),
        ...(outcome === "blamed" && linked?.blamed !== undefined && linked.blamed.length > 0 ? { blamed: [...linked.blamed] } : {}),
        ...(c.progress ? { progress: c.progress } : {}),
      })
      .catch(() => undefined);
  }
  const lastEvidence = landed?.evidence ?? blamed!.evidence!;
  return { revision: revisions.at(-1)!, revisions, evidence: lastEvidence, requiresIntegrationGate, key, candidates, ...(excludedPushes > 0 ? { excludedPushes } : {}) };
}

/** What every candidate of one integration round is built and gated against (the same board read, gate, and inventory). */
export interface CandidateContext {
  readonly options: IntegrateBoardOptions;
  readonly state: BoardState;
  readonly scrub: (text: string) => string;
  readonly requiresIntegrationGate: boolean;
  /** The baseline test inventory adjusted for accepted contracts. */
  readonly inventory?: TestInventory;
}

/**
 * Build and gate ONE candidate tree: the units of `entries` composed on the
 * board's recorded head (never moving the branch), with the same verifier,
 * integrator, immutable gate, contract restore, dependency install, and test
 * inventory as a revision, in its own disposable work directories. Returns
 * what was gated (its commit, gate, progress) or why nothing was.
 */
export async function gateCandidateTree(ctx: CandidateContext, index: number, entries: readonly StackEntry[]): Promise<BuiltCandidate> {
  const { options, state, scrub, requiresIntegrationGate } = ctx;
  const inventoryNow = ctx.inventory;
  const change: Change = {
    id: options.change.id,
    objective: options.change.objective,
    baseline: "HEAD",
    budgetUsd: 0,
    assurance: "standard",
    work: entries.map((e) => ({
      id: e.unit.agent,
      objective: `the announced pushes of ${e.unit.agent} (items ${e.unit.items.map((i) => i.id).join(", ")})`,
      dependsOn: [],
      paths: [...e.unit.scope],
    })),
  };
  // The same per-unit path selection as a revision: removing a unit (a
  // leave-one-out candidate, a shorter prefix) removes exactly its paths.
  const completed: CompletedWorkUnit[] = entries.map((e) => completedFromPlan(e.unit, e.remote));
  const runner = options.verifyCommandRunner ? new CandidateCommandRunner(options.verifyCommandRunner) : undefined;
  const verification = new ChangeVerification(options.integration.workspaces, runner ? { commandRunner: runner } : {});
  let evidence: EvidenceSummary;
  try {
    evidence = await verification.verifyAndIntegrate({
      change,
      completed,
      integrationRef: options.integration.integrationRef,
      integrationToken: options.integration.integrationToken,
      ...(requiresIntegrationGate
        ? {
            ...(options.appGateCommand && options.appGateCommand.length > 0 ? { integrationGateCommand: options.appGateCommand } : {}),
            requiresIntegrationGate,
          }
        : {}),
      ...(options.contract
        ? { protectedPaths: options.contract.restore, protectedJsonKeys: options.contract.jsonKeys, onProtectedChange: "fail" as const }
        : {}),
      ...(inventoryNow ? { testInventory: inventoryNow } : {}),
      // Every candidate builds on the same RECORDED head; none moves the branch.
      ...(state.integrated ? { integrationBaseCommit: state.integrated.commit } : {}),
      deferIntegrationPush: true,
      workRoot: options.worktreeRoot,
      identity: options.identity,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // An aborted candidate (the run stopped waiting) records nothing (see ABANDONED_REASON).
    const refused = isIntegrationAborted(error)
      ? ABANDONED_REASON
      : scrub(`the integrator refused: ${error instanceof Error ? error.message : String(error)}`);
    return { index, entries, mergedAgents: [], excludedAgents: [], skipped: refused, refused };
  }
  const excluded = evidence.units
    .filter((u) => u.verdict !== "verified")
    .map((u) => ({
      agent: u.unitId,
      reason: scrub(`failed verification (${u.checks.filter((c) => !c.passed && !c.skipped).map((c) => `${c.kind}: ${c.summary}`).join("; ") || "verdict failed"})`),
    }));
  const mergedAgents = evidence.units.filter((u) => u.verdict === "verified").map((u) => u.unitId);
  const commit = evidence.integration.commit;
  if (mergedAgents.length === 0 || commit === undefined) {
    return {
      index,
      entries,
      evidence,
      mergedAgents,
      excludedAgents: excluded,
      skipped:
        mergedAgents.length === 0
          ? `every push of the candidate was excluded: ${excluded.map((e) => `${e.agent}: ${e.reason}`).join("; ")}`
          : "the integrator reported no commit for the gated tree",
    };
  }
  const gate: "pass" | "fail" = evidence.integration.verdict === "verified" ? "pass" : "fail";
  const finalCheck = evidence.integration.finalCheck;
  const gated = !(gate === "pass" && finalCheck.skipped);
  const progress = gated
    ? labelGateProgress(finalCheck.progress ?? readTestProgress(finalCheck.outputs.map((o) => o.text).join("\n")), state.immutable ?? [])
    : undefined;
  const install = finalCheck.skipped ? undefined : runner?.lastInstall;
  return { index, entries, evidence, commit, gate, gated, ...(install ? { install } : {}), ...(progress ? { progress } : {}), mergedAgents, excludedAgents: excluded };
}

/**
 * Record a gated candidate as an integrated revision built on the recorded
 * head: exactly its gated commit, the pushes of the units the verifier
 * merged (each still its item's latest), its progress, and (failing) the
 * evidence; a pass advances the integration branch only after it is
 * recorded. Returns the revision, or why the board refused it (`stale`:
 * superseded pushes or a moved head).
 */
export async function recordBuiltCandidate(
  ctx: CandidateContext & { readonly head?: string; readonly pending: readonly BoardItem[]; readonly inventoryNote?: string },
  c: BuiltCandidate,
  input: {
    readonly revExcluded: readonly { agent: string; reason: string }[];
    readonly failingEvidence?: { failing: { output: string; items: string[]; outstanding?: string[] }; implicated: NonNullable<BoardRevision["implicated"]> };
    readonly decisions?: BoardDecisionRecord[];
    /** The revision number to report when the board's reply does not carry it. */
    readonly nFallback: number;
  },
): Promise<{ revision?: BoardRevision; failure?: string; stale?: boolean; supersededAgents?: readonly string[] }> {
  const { options, state, scrub, head, pending } = ctx;
  const failingEvidence = input.failingEvidence;
  const decisions = input.decisions ?? [];
  const items = candidateItems(c);
  const merged = items.map((i) => i.lastPush!.commit);
  const unverified = await verifySubLeadMerges({
    units: c.entries.filter((e) => c.mergedAgents.includes(e.unit.agent)).map((e) => e.unit),
    state,
    readRemote: options.readRemote,
    workRoot: options.worktreeRoot,
    scrub,
  });
  const applied = appliedForRevision(c.evidence, c.mergedAgents);
  if (options.abandoned?.()) {
    // Nothing more is recorded: the buffered decisions are dropped with the revision.
    decisions.length = 0;
    return { failure: ABANDONED_REASON };
  }
  const recorded = await options.operator.recordRevision({
    commit: c.commit!,
    gate: c.gate!,
    merged,
    ...(applied.length > 0 ? { applied } : {}),
    ...(head !== undefined ? { base: head } : {}),
    ...(c.progress ? { progress: c.progress } : {}),
    ...(failingEvidence ? { failing: failingEvidence.failing } : {}),
    ...(c.gated ? {} : { gated: false as const }),
    ...(unverified.length > 0 ? { unverified } : {}),
  });
  if (!recorded.ok) {
    await flushAttributionDecisions(options.operator, options.recordDecision, decisions, undefined, options.abandoned);
    // A stale refusal names the agents whose pushes moved, so the hold-back bound applies to them.
    return recorded.code === "UNKNOWN_REF" || recorded.code === "STALE_BASE"
      ? { stale: true, supersededAgents: await supersededAgentsNow(options.operator, items), failure: scrub(`the board refused the revision: ${recorded.error}`) }
      : { failure: scrub(`the board refused the revision (${recorded.code}): ${recorded.error}`) };
  }
  const rev = recorded.appended.find((m) => m.type === "integrated.rev");
  const n = rev && rev.type === "integrated.rev" ? rev.payload.n : input.nFallback;
  const revExcluded = [...input.revExcluded];
  let trunkMoved: BoardRevision["trunkMoved"];
  if (c.gate === "pass") {
    // Only now, with the revision recorded, does the integration branch move
    // to exactly the landed candidate's gated commit (a compare-and-swap).
    try {
      if (options.abandoned?.()) {
        throw new Error(ABANDONED_REASON);
      }
      await (options.advanceBranch ?? advanceIntegrationBranch)(options.integration.integrationRef, options.integration.integrationToken, c.commit!, options.worktreeRoot);
    } catch (error) {
      if (isPromotionRefused(error, "trunk-moved")) {
        trunkMoved = { expected: error.expected, ...(error.actual !== undefined ? { actual: error.actual } : {}) };
        // An abandoned attempt records nothing more (see ABANDONED_REASON).
        if (!options.abandoned?.()) {
          await options.operator
            .recordEngine("trunk.moved", {
              rev: n,
              commit: c.commit!,
              ...(error.expected !== null ? { expected: error.expected } : {}),
              ...(error.actual !== undefined && error.actual !== null ? { actual: error.actual } : {}),
            })
            .catch(() => undefined);
        }
      }
      revExcluded.push({
        agent: "(integration)",
        reason: scrub(
          isPromotionRefused(error, "trunk-moved")
            ? `recorded, but the trunk moved: the integration branch was not advanced (${error.message})`
            : `recorded, but the integration branch could not be advanced: ${error instanceof Error ? error.message : String(error)}`,
        ),
      });
    }
  }
  await flushAttributionDecisions(options.operator, options.recordDecision, decisions, rev ? n : undefined, options.abandoned);
  const revision: BoardRevision = {
    n,
    gate: c.gate!,
    gated: c.gated !== false,
    ...(c.install ? { install: c.install } : {}),
    commit: c.commit!,
    merged,
    integratedItems: items.flatMap((i) => [
      i.id,
      ...(i.status === "split" ? (i.lastPush?.merges ?? []).filter((m) => state.items[m.item]?.lastPush?.commit === m.commit).map((m) => m.item) : []),
    ]),
    excludedItems: pending.filter((i) => !items.includes(i)).map((i) => i.id),
    excludedAgents: revExcluded,
    completedItems: recorded.appended.flatMap((m) => (m.type === "item.completed" ? [m.payload.item] : [])),
    ...(c.progress ? { progress: c.progress } : {}),
    ...(failingEvidence ? { implicated: failingEvidence.implicated } : {}),
    ...(c.gate === "fail" ? { failure: scrub(revisionFailure(c.evidence!.integration.finalCheck)) } : {}),
    ...(ctx.inventoryNote !== undefined ? { inventoryNote: ctx.inventoryNote } : {}),
    ...(trunkMoved !== undefined ? { trunkMoved } : {}),
    ...(c.gate === "fail"
      ? {
          fixRequested: recorded.appended.flatMap((m) => (m.type === "fix.requested" ? [m.payload.item] : [])),
          fixExhausted: recorded.appended.flatMap((m) => (m.type === "fix.exhausted" ? [m.payload.item] : [])),
        }
      : {}),
  };
  return { revision };
}

/** The items whose pushes a gated candidate's tree carries (the units the verifier merged). */
export function candidateItems(c: BuiltCandidate): BoardItem[] {
  return c.entries.filter((e) => c.mergedAgents.includes(e.unit.agent)).flatMap((e) => [...e.unit.items]);
}

/** A built candidate as the round reports it. */
function outcomeOf(c: BuiltCandidate, outcome: CandidateOutcome["outcome"] | undefined, linked?: { rev?: number; blamed?: readonly string[] }): CandidateOutcome {
  return {
    index: c.index,
    prefix: prefixOf(c.entries),
    ...(c.commit !== undefined ? { commit: c.commit } : {}),
    ...(c.gate !== undefined ? { gate: c.gate } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(linked?.rev !== undefined ? { rev: linked.rev } : {}),
    ...(linked?.blamed !== undefined ? { blamed: linked.blamed } : {}),
    ...(c.progress ? { progress: c.progress } : {}),
    ...(c.skipped !== undefined ? { skipped: c.skipped } : {}),
  };
}

/** One line for a round's candidates: `C1 pass (landed rev 3), C2 fail (blamed y), C3 fail (retest)`. */
export function formatCandidates(candidates: readonly CandidateOutcome[]): string {
  return candidates
    .map((c) => {
      const what =
        c.outcome === "landed"
          ? `landed${c.rev !== undefined ? ` rev ${c.rev}` : ""}`
          : c.outcome === "blamed"
            ? `blamed ${(c.blamed ?? []).join(", ") || "nothing"}${c.rev !== undefined ? ` in rev ${c.rev}` : ""}`
            : (c.outcome ?? c.skipped ?? "not gated");
      return `C${c.index} ${c.gate ?? "-"} (${what})`;
    })
    .join(", ");
}

/**
 * proof-bundle: what a board run can PROVE about the revision it shipped, as a
 * pure function of the board log (no I/O, no clock, browser-safe: the console
 * renders it from a recorded log, the CLI writes it as JSON at the end).
 *
 * The bundle is about the LAST integrated revision, the one whose gate is the
 * run's verdict and the only one ever promoted. It is PROVEN only when:
 *   - that revision passed a gate that actually ran (`gated` is not false);
 *   - the run recorded its promotion (`revision.promoted`) of that revision,
 *     and the promoted gated commit IS the revision's commit (gate equals
 *     deploy: the shipped tree is the gated tree);
 *   - the revision executed at least the baseline gate run's tests, when both
 *     counts are known.
 * Anything else is NOT-PROVEN, with each reason stated. Every other section is
 * a record, each entry citing the board seq that backs it: the gate command,
 * the test inventory, per-suite progress across revisions, the items, agents,
 * and pushes merged, the contracts used and their decisions, the tools used,
 * the typed (Jev) decisions (ADVISORY, with their mechanical outcomes, never
 * part of the proof), the human decisions, and the lapses, re-plans,
 * escalations, clash predictions, trunk moves, token refreshes, and caps.
 *
 * With speculative batch gating, the bundle also lists the candidates the
 * round that landed the final revision considered (candidate.gated), and the
 * landed one: its commit must be the revision's (and the promoted gated
 * commit), or the bundle is not proven.
 *
 * Under arbitration revision 5 it lists the PRE-PASS RATCHET's history (each
 * failing revision that became the best so far before the first pass) and
 * the pushes recorded as regressors (the stack scored strictly better without
 * them): a record of what was stacked and who was told, never part of the proof (the ratchet never moves the head,
 * promotes, or changes a verdict).
 */

import { describeProgressScore, foldBoard, isChangeItem, progressHeadline, ratchetHistory, type BoardMessage, type BoardRevProgress } from "@switchyard-change/change-core";

/** A count of passing out of total checks. */
export interface ProofCount {
  readonly passed: number;
  readonly total: number;
}

/** The proof bundle of a board run's final revision. */
export interface ProofBundle {
  readonly version: 1;
  readonly changeId?: string;
  readonly status: "proven" | "not-proven";
  /** Why it is not proven (empty when proven). */
  readonly reasons: readonly string[];
  readonly goal?: { readonly objective: string; readonly seq: number };
  /** The final (last) integrated revision. */
  readonly revision?: {
    readonly n: number;
    readonly commit: string;
    readonly gate: "pass" | "fail";
    readonly gated: boolean;
    readonly seq: number;
    readonly base?: string;
    /** Per merged agent: the files its unit applied to the gated tree, and the changed files it yielded (a record). */
    readonly applied?: readonly { readonly agent: string; readonly paths: readonly string[]; readonly yielded?: readonly string[] }[];
  };
  /** The recorded promotion and whether its gated commit is the revision's. */
  readonly promotion?: { readonly rev: number; readonly gatedCommit: string; readonly commit: string; readonly branch: string; readonly seq?: number; readonly matchesGated: boolean };
  readonly gate: { readonly command?: readonly string[]; readonly verdict: "pass" | "fail" | "none"; readonly gated: boolean };
  readonly inventory: {
    readonly baseline: { readonly status: "recorded" | "unavailable"; readonly count?: number; readonly format?: string } | null;
    readonly final?: { readonly acceptance?: ProofCount; readonly developer?: ProofCount; readonly executed: number; readonly atLeastBaseline?: boolean };
  };
  /** Per-suite progress across revisions (advisory counts the gate printed; the gate decides). */
  readonly progress: readonly { readonly n: number; readonly seq: number; readonly gate: "pass" | "fail"; readonly acceptance?: ProofCount; readonly developer?: ProofCount; readonly line: string }[];
  readonly contributions: {
    readonly items: readonly { readonly item: string; readonly status: string; readonly completedIn?: number; readonly via?: string; readonly agents: readonly string[]; readonly pushes: number }[];
    readonly agents: readonly string[];
    /** Announced pushes merged by passing revisions. */
    readonly pushesMerged: number;
  };
  readonly contracts: readonly { readonly contract: string; readonly target: string; readonly kind: string; readonly seam?: string; readonly guarded?: boolean; readonly status: string; readonly decidedBy?: string; readonly seq?: number; readonly decidedSeq?: number }[];
  readonly tools: readonly { readonly capability: string; readonly version: string; readonly kind: string; readonly publishedBy: string; readonly uses: number; readonly seq: number }[];
  /** Typed decisions: ADVISORY, never part of the proof; the outcome is where an attribution landed. */
  readonly decisions: readonly { readonly seq: number; readonly juncture: string; readonly answer?: string; readonly confidence?: number; readonly accepted: boolean; readonly error?: string; readonly rev?: number; readonly outcome?: string }[];
  readonly human: readonly { readonly seq: number; readonly type: string; readonly ref: string; readonly decision: string }[];
  readonly lapses: readonly { readonly seq: number; readonly item: string; readonly agent: string; readonly reason: string }[];
  readonly replans: readonly { readonly seq: number; readonly item: string; readonly action: string; readonly reason: string; readonly children: readonly string[]; readonly by: string }[];
  readonly escalations: readonly { readonly seq: number; readonly item: string; readonly replanOf: string }[];
  readonly clashes: readonly { readonly seq: number; readonly a: string; readonly b: string; readonly status: string; readonly paths?: readonly string[]; readonly scope?: string }[];
  readonly trunkMoved: readonly { readonly seq: number; readonly rev: number }[];
  readonly tokenRefreshes: number;
  readonly caps: readonly { readonly seq: number; readonly kind: string; readonly limit: number; readonly used: number; readonly item?: string }[];
  /** Change items not completed (a proven revision with these is a partial Change). */
  readonly incompleteItems: readonly string[];
  /**
   * The speculative round that landed the final revision (absent without
   * speculation): every candidate it gated, in order, and the landed one,
   * whose commit is the revision's gated commit (and the promoted one).
   */
  readonly speculation?: {
    readonly round: number;
    readonly candidates: readonly ProofCandidate[];
    readonly landed?: ProofCandidate & { readonly matchesRevision: boolean; readonly matchesPromoted?: boolean };
  };
  /**
   * The pre-pass ratchet (arbitration revision 5; absent before it or when it
   * never had a scored revision): its history and the regressions recorded
   * against it. A record, never part of the proof and never a verdict.
   */
  readonly ratchet?: {
    readonly history: readonly { readonly n: number; readonly seq: number; readonly commit: string; readonly line: string }[];
    readonly regressions: readonly { readonly seq: number; readonly item: string; readonly agent: string; readonly commit: string; readonly rev: number; readonly ratchet: number; readonly from: string; readonly to: string; readonly candidate: string }[];
  };
}

/** One speculative candidate as the proof lists it (each backed by its candidate.gated seq). */
export interface ProofCandidate {
  readonly seq: number;
  readonly index: number;
  /** The items of each push in its stack, in order. */
  readonly prefix: readonly (readonly string[])[];
  readonly commit: string;
  readonly verdict: "pass" | "fail";
  readonly outcome: "landed" | "passed" | "blamed" | "retest";
  readonly rev?: number;
  readonly blamed?: readonly string[];
  readonly acceptance?: ProofCount;
  readonly developer?: ProofCount;
}

/** Options: what the log alone cannot carry (the run's own id, a promotion the board refused to record). */
export interface ProofBundleOptions {
  readonly changeId?: string;
  /** The gate command, when the goal did not record one. */
  readonly gateCommand?: readonly string[];
  /** A promotion the run reports but the board does not hold (it is checked the same way, never trusted). */
  readonly promotion?: { readonly rev?: number; readonly gatedCommit: string; readonly commit: string; readonly branch: string };
}

function of<K extends BoardMessage["type"]>(log: readonly BoardMessage[], type: K): Extract<BoardMessage, { readonly type: K }>[] {
  return log.filter((m): m is Extract<BoardMessage, { readonly type: K }> => m.type === type);
}

/** The developer suites' summed counts of a revision's progress. */
function developerCount(p: BoardRevProgress): ProofCount | undefined {
  const dev = (p.suites ?? []).filter((s) => s.suite === "developer");
  return dev.length > 0 ? { passed: dev.reduce((n, s) => n + s.passed, 0), total: dev.reduce((n, s) => n + s.total, 0) } : undefined;
}

/** Build the proof bundle of a board run from its log (see the module comment). Pure. */
export function buildProofBundle(log: readonly BoardMessage[], options: ProofBundleOptions = {}): ProofBundle {
  const state = foldBoard(log);
  const reasons: string[] = [];
  const goal = of(log, "goal.posted")[0];
  const revs = of(log, "integrated.rev");
  const last = revs.at(-1);
  const gated = last !== undefined && last.payload.gated !== false;
  if (last === undefined) {
    reasons.push("no integrated revision was recorded");
  } else if (last.payload.gate !== "pass") {
    reasons.push(`the last revision (${last.payload.n}) failed its gate`);
  } else if (!gated) {
    reasons.push(`no gate ran on the last revision (${last.payload.n}): its pass checked nothing`);
  }

  // The promotion: the board's record, else what the run reports (checked the same way).
  const recorded = of(log, "revision.promoted").at(-1);
  const promoted = recorded ? { ...recorded.payload, seq: recorded.seq } : options.promotion;
  let promotion: ProofBundle["promotion"];
  if (promoted === undefined) {
    if (last?.payload.gate === "pass") {
      reasons.push("no promotion of the last revision was recorded");
    }
  } else {
    const rev = promoted.rev ?? last?.payload.n ?? 0;
    const matchesGated = last !== undefined && rev === last.payload.n && promoted.gatedCommit === last.payload.commit;
    promotion = {
      rev,
      gatedCommit: promoted.gatedCommit,
      commit: promoted.commit,
      branch: promoted.branch,
      ...("seq" in promoted && typeof promoted.seq === "number" ? { seq: promoted.seq } : {}),
      matchesGated,
    };
    if (!matchesGated) {
      reasons.push(
        last === undefined
          ? "a promotion was recorded without any integrated revision"
          : `the promoted gated commit ${promoted.gatedCommit.slice(0, 12)} (revision ${rev}) is not the last revision's commit ${last.payload.commit.slice(0, 12)} (revision ${last.payload.n}): the shipped tree is not the gated tree`,
      );
    }
  }

  // Speculation: the round whose landed candidate is the final revision.
  const candidateRecords = of(log, "candidate.gated");
  const landedRecord = last !== undefined ? candidateRecords.find((m) => m.payload.outcome === "landed" && m.payload.rev === last.payload.n) : undefined;
  let speculation: ProofBundle["speculation"];
  if (landedRecord !== undefined && last !== undefined) {
    const toCandidate = (m: (typeof candidateRecords)[number]): ProofCandidate => {
      const p = m.payload;
      const developer = p.progress ? developerCount(p.progress) : undefined;
      return {
        seq: m.seq,
        index: p.index,
        prefix: p.prefix.map((x) => [...x.items]),
        commit: p.commit,
        verdict: p.verdict,
        outcome: p.outcome,
        ...(p.rev !== undefined ? { rev: p.rev } : {}),
        ...(p.blamed !== undefined ? { blamed: [...p.blamed] } : {}),
        ...(p.progress?.acceptance ? { acceptance: { passed: p.progress.acceptance.passed, total: p.progress.acceptance.total } } : {}),
        ...(developer ? { developer } : {}),
      };
    };
    const round = landedRecord.payload.round;
    const matchesRevision = landedRecord.payload.commit === last.payload.commit;
    const matchesPromoted = promotion !== undefined ? landedRecord.payload.commit === promotion.gatedCommit : undefined;
    if (!matchesRevision) {
      reasons.push(`the landed candidate's commit ${landedRecord.payload.commit.slice(0, 12)} is not revision ${last.payload.n}'s gated commit ${last.payload.commit.slice(0, 12)}`);
    }
    speculation = {
      round,
      candidates: candidateRecords.filter((m) => m.payload.round === round).map(toCandidate),
      landed: { ...toCandidate(landedRecord), matchesRevision, ...(matchesPromoted !== undefined ? { matchesPromoted } : {}) },
    };
  }

  // Test inventory: the baseline run's count, and what the final revision executed.
  const baseline = state.testInventory;
  const finalProgress = last?.payload.progress;
  const executed = finalProgress?.total;
  const atLeastBaseline = baseline?.count !== undefined && executed !== undefined ? executed >= baseline.count : undefined;
  if (atLeastBaseline === false) {
    reasons.push(`the last revision executed ${executed} test(s), fewer than the baseline's ${baseline!.count}`);
  }

  // Progress per suite across revisions.
  const progress = revs.flatMap((m) => {
    const p = m.payload.progress;
    if (!p) {
      return [];
    }
    const head = progressHeadline(p);
    const developer = developerCount(p);
    return [
      {
        n: m.payload.n,
        seq: m.seq,
        gate: m.payload.gate,
        ...(p.acceptance ? { acceptance: { passed: p.acceptance.passed, total: p.acceptance.total } } : {}),
        ...(developer ? { developer } : {}),
        line: head ? `${head.acceptance ? "acceptance" : "checks"} ${head.passed}/${head.total}` : (p.acceptanceNotRun ?? "no count"),
      },
    ];
  });

  // Contributions: pushes the passing revisions merged, per item and agent.
  const pushByCommit = new Map(of(log, "push.announced").map((m) => [m.payload.commit, m]));
  const merged = new Map<string, { agents: Set<string>; pushes: number }>();
  let pushesMerged = 0;
  for (const rev of revs.filter((r) => r.payload.gate === "pass")) {
    for (const commit of rev.payload.merged) {
      const push = pushByCommit.get(commit);
      if (!push) {
        continue;
      }
      pushesMerged += 1;
      const entry = merged.get(push.payload.item) ?? { agents: new Set<string>(), pushes: 0 };
      entry.agents.add(push.from);
      entry.pushes += 1;
      merged.set(push.payload.item, entry);
      for (const child of push.payload.merges ?? []) {
        const childPush = pushByCommit.get(child.commit);
        const c = merged.get(child.item) ?? { agents: new Set<string>(), pushes: 0 };
        if (childPush) {
          c.agents.add(childPush.from);
        }
        c.pushes += 1;
        merged.set(child.item, c);
      }
    }
  }
  const changeItems = Object.values(state.items).filter(isChangeItem);
  const items = changeItems.map((i) => ({
    item: i.id,
    status: i.status,
    ...(i.completed?.n !== undefined ? { completedIn: i.completed.n } : {}),
    ...(i.completed ? { via: i.completed.via } : {}),
    agents: [...(merged.get(i.id)?.agents ?? [])].sort(),
    pushes: merged.get(i.id)?.pushes ?? 0,
  }));
  const agents = [...new Set(items.flatMap((i) => i.agents))].sort();

  const contracts = Object.values(state.contracts).map((c) => ({
    contract: c.contract,
    target: c.target,
    kind: c.kind,
    ...(c.seam !== undefined ? { seam: c.seam } : {}),
    ...(c.guarded ? { guarded: true } : {}),
    status: c.status,
    ...(c.decidedBy !== undefined ? { decidedBy: c.decidedBy } : {}),
    ...(c.proposedSeq !== undefined ? { seq: c.proposedSeq } : {}),
    ...(c.decidedSeq !== undefined ? { decidedSeq: c.decidedSeq } : {}),
  }));
  const tools = state.tools.published.map((t) => ({ capability: t.capability, version: t.version, kind: t.kind, publishedBy: t.publishedBy, uses: t.uses, seq: t.seq }));
  const resolved = new Map(of(log, "decision.resolved").map((m) => [m.payload.decisionSeq, m.payload]));
  const decisions = of(log, "decision.recorded").map((m) => {
    const r = resolved.get(m.seq);
    return {
      seq: m.seq,
      juncture: m.payload.juncture,
      ...(m.payload.answer !== undefined ? { answer: m.payload.answer } : {}),
      ...(m.payload.confidence !== undefined ? { confidence: m.payload.confidence } : {}),
      accepted: m.payload.accepted,
      ...(m.payload.error !== undefined ? { error: m.payload.error } : {}),
      ...(m.payload.rev !== undefined ? { rev: m.payload.rev } : {}),
      ...(r ? { outcome: `${r.answer} ${r.outcome === "in-fixed-set" ? "changed" : "did not change"} before the pass at revision ${r.passed}` } : {}),
    };
  });
  type HumanDecision = ProofBundle["human"][number];
  const human = log.flatMap((m): HumanDecision[] => {
    if (m.from !== "human") {
      return [];
    }
    switch (m.type) {
      case "contract.accepted":
      case "contract.rejected":
        return [{ seq: m.seq, type: m.type, ref: m.payload.contract, decision: m.type === "contract.accepted" ? "accept" : "reject" }];
      case "claim.resolved":
        return [{ seq: m.seq, type: m.type, ref: m.payload.contest, decision: m.payload.winner ?? m.payload.how }];
      case "item.accepted":
      case "item.rejected":
        return [{ seq: m.seq, type: m.type, ref: m.payload.item, decision: m.type === "item.accepted" ? "accept" : "reject" }];
      case "item.replanned":
        return [{ seq: m.seq, type: m.type, ref: m.payload.item, decision: m.payload.action }];
      default:
        return [];
    }
  });

  // The pre-pass ratchet (a record, never part of the proof).
  const history = ratchetHistory(log).map((step) => ({ n: step.n, seq: step.seq, commit: step.commit, line: step.line }));
  const regressions = of(log, "push.regressed").map((m) => ({
    seq: m.seq,
    item: m.payload.item,
    agent: m.payload.agent,
    commit: m.payload.commit,
    rev: m.payload.rev,
    ratchet: m.payload.ratchet,
    from: describeProgressScore(m.payload.from),
    to: describeProgressScore(m.payload.to),
    candidate: m.payload.candidate,
  }));

  return {
    version: 1,
    ...(options.changeId !== undefined ? { changeId: options.changeId } : {}),
    status: reasons.length === 0 ? "proven" : "not-proven",
    reasons,
    ...(goal ? { goal: { objective: goal.payload.objective, seq: goal.seq } } : {}),
    ...(last
      ? {
          revision: {
            n: last.payload.n,
            commit: last.payload.commit,
            gate: last.payload.gate,
            gated,
            seq: last.seq,
            ...(last.payload.base !== undefined ? { base: last.payload.base } : {}),
            ...(last.payload.applied !== undefined
              ? { applied: last.payload.applied.map((u) => ({ agent: u.agent, paths: [...u.paths], ...(u.yielded ? { yielded: [...u.yielded] } : {}) })) }
              : {}),
          },
        }
      : {}),
    ...(promotion ? { promotion } : {}),
    gate: {
      ...((state.gateCommand ?? options.gateCommand) !== undefined ? { command: [...(state.gateCommand ?? options.gateCommand)!] } : {}),
      verdict: last === undefined ? "none" : last.payload.gate,
      gated,
    },
    inventory: {
      baseline: baseline ? { status: baseline.status, ...(baseline.count !== undefined ? { count: baseline.count } : {}), ...(baseline.format !== undefined ? { format: baseline.format } : {}) } : null,
      ...(finalProgress
        ? {
            final: {
              ...(finalProgress.acceptance ? { acceptance: { passed: finalProgress.acceptance.passed, total: finalProgress.acceptance.total } } : {}),
              ...((): { developer?: ProofCount } => {
                const dev = developerCount(finalProgress);
                return dev ? { developer: dev } : {};
              })(),
              executed: finalProgress.total,
              ...(atLeastBaseline !== undefined ? { atLeastBaseline } : {}),
            },
          }
        : {}),
    },
    progress,
    contributions: { items, agents, pushesMerged },
    contracts,
    tools,
    decisions,
    human,
    lapses: of(log, "claim.lapsed").map((m) => ({ seq: m.seq, item: m.payload.item, agent: m.payload.agent, reason: m.payload.reason })),
    replans: of(log, "item.replanned").map((m) => ({ seq: m.seq, item: m.payload.item, action: m.payload.action, reason: m.payload.reason, children: m.payload.children.map((c) => c.item), by: m.from })),
    escalations: of(log, "item.escalated").map((m) => ({ seq: m.seq, item: m.payload.item, replanOf: m.payload.replanOf })),
    clashes: of(log, "clash.predicted").map((m) => ({
      seq: m.seq,
      a: `${m.payload.a.agent}/${m.payload.a.item}`,
      b: `${m.payload.b.agent}/${m.payload.b.item}`,
      status: m.payload.status,
      ...(m.payload.paths !== undefined ? { paths: [...m.payload.paths] } : {}),
      ...(m.payload.scope !== undefined ? { scope: m.payload.scope } : {}),
    })),
    trunkMoved: of(log, "trunk.moved").map((m) => ({ seq: m.seq, rev: m.payload.rev })),
    tokenRefreshes: of(log, "token.refreshed").length,
    caps: of(log, "run.capped").map((m) => ({ seq: m.seq, kind: m.payload.kind, limit: m.payload.limit, used: m.payload.used, ...(m.payload.item !== undefined ? { item: m.payload.item } : {}) })),
    incompleteItems: changeItems.filter((i) => i.status !== "done").map((i) => i.id),
    ...(speculation ? { speculation } : {}),
    ...(history.length > 0 || regressions.length > 0 ? { ratchet: { history, regressions } } : {}),
  };
}

/** One line for the speculative round that landed the final revision. */
export function formatProofSpeculation(speculation: NonNullable<ProofBundle["speculation"]>): string {
  const what = (c: ProofCandidate): string =>
    c.outcome === "landed"
      ? `landed as rev ${c.rev}${speculation.landed?.matchesRevision ? " (its gated commit)" : " (NOT its gated commit)"}${
          speculation.landed?.matchesPromoted === undefined ? "" : speculation.landed.matchesPromoted ? ", promoted" : ", NOT the promoted commit"
        }`
      : c.outcome === "blamed"
        ? `blamed ${(c.blamed ?? []).join(", ")}${c.rev !== undefined ? ` in rev ${c.rev}` : ""}`
        : c.outcome;
  return `speculation: round ${speculation.round}, ${speculation.candidates.map((c) => `C${c.index} ${c.commit.slice(0, 10)} ${c.verdict} (${what(c)})`).join(", ")}`;
}

/** A short, readable summary of a proof bundle (the CLI prints it). */
export function formatProofSummary(bundle: ProofBundle): string[] {
  const lines = [
    `proof: ${bundle.status.toUpperCase()}${bundle.revision ? ` for revision ${bundle.revision.n} (${bundle.revision.commit.slice(0, 12)})` : ""}`,
    ...bundle.reasons.map((r) => `  not proven: ${r}`),
  ];
  if (bundle.promotion) {
    lines.push(`  promoted: ${bundle.promotion.branch} ${bundle.promotion.commit.slice(0, 12)} from gated ${bundle.promotion.gatedCommit.slice(0, 12)} (${bundle.promotion.matchesGated ? "the gated tree" : "NOT the gated tree"})`);
  }
  lines.push(`  gate: ${bundle.gate.command?.join(" ") ?? "(no command recorded)"} -> ${bundle.gate.verdict}${bundle.gate.gated ? "" : " (no gate ran)"}`);
  if (bundle.progress.length > 0) {
    lines.push(`  progress: ${bundle.progress.map((p) => `rev ${p.n} ${p.line}`).join(" -> ")}`);
  }
  if (bundle.speculation) {
    lines.push(`  ${formatProofSpeculation(bundle.speculation)}`);
  }
  if (bundle.ratchet) {
    lines.push(
      `  pre-pass ratchet (best so far before the first pass; a record, not a verdict): ${bundle.ratchet.history.map((h) => `rev ${h.n} ${h.line}`).join(" -> ") || "none"}` +
        (bundle.ratchet.regressions.length > 0
          ? `; regressions: ${bundle.ratchet.regressions.map((r) => `${r.item} (${r.agent}, ${r.commit.slice(0, 10)}) rev ${r.rev} ${r.to} with it, ${r.from} without it`).join("; ")}`
          : ""),
    );
  }
  lines.push(
    `  merged: ${bundle.contributions.pushesMerged} push(es) from ${bundle.contributions.agents.join(", ") || "nobody"}; ${bundle.contributions.items.filter((i) => i.status === "done").length} of ${bundle.contributions.items.length} item(s) done`,
  );
  const notes = [
    bundle.contracts.length > 0 ? `${bundle.contracts.length} contract(s)` : "",
    bundle.tools.length > 0 ? `${bundle.tools.length} tool version(s)` : "",
    bundle.decisions.length > 0 ? `${bundle.decisions.length} advisory decision(s)` : "",
    bundle.human.length > 0 ? `${bundle.human.length} human decision(s)` : "",
    bundle.lapses.length > 0 ? `${bundle.lapses.length} lapse(s)` : "",
    bundle.replans.length > 0 ? `${bundle.replans.length} re-plan(s)` : "",
    bundle.caps.length > 0 ? `${bundle.caps.length} cap(s) reached` : "",
  ].filter((n) => n !== "");
  if (notes.length > 0) {
    lines.push(`  recorded: ${notes.join(", ")}`);
  }
  return lines;
}

/**
 * The proof bundle of a board run's final revision: a pure function of the
 * board log. PROVEN only when the last revision passed a gate that ran and the
 * recorded promotion's gated commit is that revision's commit; otherwise
 * NOT-PROVEN with each reason. Offline: the log is built through the pure
 * board API.
 */
import { describe, expect, it } from "vitest";

import { appendBoardMessage, appendDecisionRecorded, appendEngineRecord, appendIntegratedRev, emptyBoard, type BoardMessage, type BoardState } from "@switchyard-change/change-core";

import { buildProofBundle, formatProofSummary } from "../src/proof-bundle.ts";
import { speculativeLog } from "./board-graph-fixture.ts";

const AT = "2026-01-01T00:00:00.000Z";

class Log {
  state: BoardState = emptyBoard();
  readonly messages: BoardMessage[] = [];
  private take(r: { appended: readonly BoardMessage[]; state: BoardState }) {
    this.state = r.state;
    this.messages.push(...r.appended);
  }
  human(raw: unknown) {
    this.take(appendBoardMessage(this.state, { kind: "human" }, raw, AT));
  }
  join(agent: string, role?: string) {
    this.take(appendBoardMessage(this.state, { kind: "join", agent }, { type: "agent.joined", payload: role ? { role } : {} }, AT));
  }
  agent(agent: string, raw: unknown) {
    this.take(appendBoardMessage(this.state, { kind: "agent", agent }, raw, AT));
  }
  rev(input: unknown) {
    this.take(appendIntegratedRev(this.state, input, AT));
  }
  record(type: string, payload: Record<string, unknown>) {
    this.take(appendEngineRecord(this.state, { type, payload }, AT));
  }
  decision(input: unknown) {
    this.take(appendDecisionRecorded(this.state, input, AT));
  }
}

/** A verified run: a failing revision (acceptance 1/3), a fix, a passing revision (3/3), promoted. */
function verifiedRun(): Log {
  const log = new Log();
  log.human({
    type: "goal.posted",
    payload: {
      objective: "report status",
      gateCommand: ["npm", "run", "gate"],
      baseline: "base0",
      testInventory: { status: "recorded", format: "tap", count: 4 },
      protected: ["tests/a.test.ts"],
    },
  });
  log.join("lead", "lead");
  log.join("a");
  log.join("b");
  for (const item of ["one", "two"]) {
    log.agent("lead", { type: "item.proposed", payload: { item, objective: `do ${item}`, acceptance: [], scopeHint: [`src/${item}/**`] } });
  }
  log.agent("a", { type: "item.claimed", payload: { item: "one", intent: { read: [], write: ["src/one/**"] } } });
  log.agent("b", { type: "item.claimed", payload: { item: "two", intent: { read: [], write: ["src/two/**"] } } });
  log.agent("a", { type: "push.announced", payload: { item: "one", commit: "c1", paths: ["src/one/x.ts"] } });
  log.agent("b", { type: "push.announced", payload: { item: "two", commit: "c2", paths: ["src/two/y.ts"] } });
  const progress = (passed: number) => ({
    passed: passed + 1,
    failed: 3 - passed,
    total: 4,
    acceptance: { passed, failed: 3 - passed, total: 3 },
    suites: [
      { passed, failed: 3 - passed, total: 3, suite: "acceptance" },
      { passed: 1, failed: 0, total: 1, suite: "developer" },
    ],
  });
  log.rev({ commit: "r1", gate: "fail", merged: ["c1", "c2"], base: "base0", progress: progress(1), failing: { output: "not ok 2 - two", items: ["two"] } });
  log.decision({ juncture: "attribution", question: "which?", answer: "two", confidence: 0.9, accepted: true, rev: 1, parsed: ["two"] });
  log.agent("b", { type: "push.announced", payload: { item: "two", commit: "c3", paths: ["src/two/y.ts"] } });
  log.agent("a", { type: "done.proposed", payload: { item: "one" } });
  log.agent("b", { type: "done.proposed", payload: { item: "two" } });
  log.rev({ commit: "r2", gate: "pass", merged: ["c1", "c3"], base: "base0", progress: progress(3) });
  log.record("revision.promoted", { rev: 2, gatedCommit: "r2", commit: "p1", branch: "switchyard/change-1" });
  return log;
}

describe("the proof bundle (pure, from the log)", () => {
  it("proves a verified, promoted run: gated equals promoted, the gate, the inventory, progress, contributions, advisory decisions", () => {
    const bundle = buildProofBundle(verifiedRun().messages, { changeId: "change-1" });
    expect(bundle.status).toBe("proven");
    expect(bundle.reasons).toEqual([]);
    expect(bundle).toMatchObject({
      changeId: "change-1",
      revision: { n: 2, commit: "r2", gate: "pass", gated: true, base: "base0" },
      promotion: { rev: 2, gatedCommit: "r2", commit: "p1", branch: "switchyard/change-1", matchesGated: true },
      gate: { command: ["npm", "run", "gate"], verdict: "pass", gated: true },
      inventory: { baseline: { status: "recorded", count: 4, format: "tap" }, final: { executed: 4, acceptance: { passed: 3, total: 3 }, developer: { passed: 1, total: 1 }, atLeastBaseline: true } },
    });
    expect(bundle.progress.map((p) => p.line)).toEqual(["acceptance 1/3", "acceptance 3/3"]);
    expect(bundle.contributions).toMatchObject({ agents: ["a", "b"], pushesMerged: 2 });
    expect(bundle.contributions.items).toEqual([
      expect.objectContaining({ item: "one", status: "done", completedIn: 2, agents: ["a"], pushes: 1 }),
      expect.objectContaining({ item: "two", status: "done", completedIn: 2, agents: ["b"], pushes: 1 }),
    ]);
    // The typed decision is advisory, with where its pick landed.
    expect(bundle.decisions).toEqual([expect.objectContaining({ juncture: "attribution", answer: "two", accepted: true, rev: 1, outcome: "two changed before the pass at revision 2" })]);
    expect(bundle.incompleteItems).toEqual([]);
    expect(formatProofSummary(bundle).join("\n")).toMatch(/proof: PROVEN for revision 2 \(r2\)[\s\S]*progress: rev 1 acceptance 1\/3 -> rev 2 acceptance 3\/3/);
  });

  it("is NOT proven when the promoted commit differs from the gated one (a log the board would refuse, or a promotion the run reports)", () => {
    const messages = verifiedRun().messages.map((m) =>
      m.type === "revision.promoted" ? ({ ...m, payload: { ...m.payload, gatedCommit: "r1" } } as BoardMessage) : m,
    );
    const forged = buildProofBundle(messages);
    expect(forged.status).toBe("not-proven");
    expect(forged.promotion).toMatchObject({ matchesGated: false });
    expect(forged.reasons).toEqual([expect.stringMatching(/the promoted gated commit r1 \(revision 2\) is not the last revision's commit r2 \(revision 2\): the shipped tree is not the gated tree/)]);
    // A promotion the board refused to record is checked the same way, never trusted.
    const unrecorded = verifiedRun().messages.filter((m) => m.type !== "revision.promoted");
    const reported = buildProofBundle(unrecorded, { promotion: { rev: 2, gatedCommit: "elsewhere", commit: "p1", branch: "b" } });
    expect(reported.status).toBe("not-proven");
    expect(buildProofBundle(unrecorded, { promotion: { rev: 2, gatedCommit: "r2", commit: "p1", branch: "b" } }).status).toBe("proven");
  });

  it("is NOT proven without a recorded promotion, when the last revision failed, or when no gate ran", () => {
    const run = verifiedRun();
    const noPromotion = run.messages.filter((m) => m.type !== "revision.promoted");
    expect(buildProofBundle(noPromotion).reasons).toEqual(["no promotion of the last revision was recorded"]);
    const upToFailure = run.messages.slice(0, run.messages.findIndex((m) => m.type === "integrated.rev" && m.payload.gate === "fail") + 1);
    expect(buildProofBundle(upToFailure)).toMatchObject({ status: "not-proven", reasons: ["the last revision (1) failed its gate"] });
    expect(buildProofBundle([])).toMatchObject({ status: "not-proven", reasons: ["no integrated revision was recorded"] });
  });
});

describe("the proof bundle of a speculative round", () => {
  it("lists the candidates the landing round considered and ties the landed one to the gated and promoted commit", () => {
    const log = speculativeLog();
    const bundle = buildProofBundle(log);
    expect(bundle.status).toBe("proven");
    expect(bundle.speculation).toMatchObject({
      round: 1,
      landed: { index: 1, commit: "cand111", rev: 3, matchesRevision: true, matchesPromoted: true },
    });
    expect(bundle.speculation!.candidates.map((c) => [c.index, c.prefix, c.verdict, c.outcome, c.rev, c.blamed ?? null])).toEqual([
      [1, [["one"]], "pass", "landed", 3, null],
      [2, [["one"], ["two"]], "fail", "blamed", 2, ["two"]],
    ]);
    expect(formatProofSummary(bundle)).toContain(
      "  speculation: round 1, C1 cand111 pass (landed as rev 3 (its gated commit), promoted), C2 cand222 fail (blamed two in rev 2)",
    );
    // Before the landing round, the last revision has no landed candidate: no speculation section.
    const beforeCandidates = log.slice(0, log.findIndex((m) => m.type === "candidate.gated"));
    expect(buildProofBundle(beforeCandidates).speculation).toBeUndefined();
  });
});

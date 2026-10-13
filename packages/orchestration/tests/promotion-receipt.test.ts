/**
 * The promotion receipt (the git note a board run attaches to the commit it
 * promoted): a pure function of the proof bundle, so it states only recorded
 * facts. Offline: the log is built through the pure board API.
 */
import { describe, expect, it } from "vitest";

import { appendBoardMessage, appendEngineRecord, appendIntegratedRev, emptyBoard, type BoardMessage, type BoardState } from "@switchyard-change/change-core";

import { buildProofBundle, formatProofSummary, type ProofBundle } from "../src/proof-bundle.ts";
import { buildPromotionReceipt, parsePromotionReceipt, RECEIPT_JSON_MARKER } from "../src/promotion-receipt.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WRITTEN = "2026-02-03T04:05:06.000Z";

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
}

/** A run that passed on revision 2 and was promoted. */
function promotedRun(objective = "report status"): Log {
  const log = new Log();
  log.human({ type: "goal.posted", payload: { objective, gateCommand: ["npm", "run", "gate"], baseline: "base0", testInventory: { status: "recorded", format: "tap", count: 4 } } });
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
  log.rev({ commit: "r1", gate: "fail", merged: ["c1"], base: "base0", progress: progress(1), failing: { output: "not ok 2 - two", items: ["one"] } });
  log.agent("a", { type: "done.proposed", payload: { item: "one" } });
  log.agent("b", { type: "done.proposed", payload: { item: "two" } });
  log.rev({ commit: "r2", gate: "pass", merged: ["c1", "c2"], base: "base0", progress: progress(3) });
  log.record("revision.promoted", { rev: 2, gatedCommit: "r2", commit: "p1", branch: "switchyard/change-1" });
  return log;
}

/** The bundle with one accepted and one rejected contract (only the accepted one is an approved change). */
function withContracts(bundle: ProofBundle): ProofBundle {
  return {
    ...bundle,
    contracts: [
      { contract: "k1", target: "tests/a.test.ts", kind: "modify", guarded: true, status: "accepted", decidedBy: "human" },
      { contract: "k2", target: "tests/b.test.ts", kind: "remove", status: "rejected", decidedBy: "lead" },
    ],
  };
}

describe("the promotion receipt (pure, from the proof bundle)", () => {
  it("states the recorded facts: change, goal, revision, gated commit, gate, advisory counts, items and agents, pushes, approved contracts, branch, time", () => {
    const bundle = withContracts(buildProofBundle(promotedRun().messages, { changeId: "change-1" }));
    const receipt = buildPromotionReceipt(bundle, { at: WRITTEN })!;
    expect(receipt.facts).toEqual({
      kind: "switchyard-promotion-receipt",
      version: 1,
      changeId: "change-1",
      objective: "report status",
      revision: { n: 2, gatedCommit: "r2" },
      promoted: { commit: "p1", branch: "switchyard/change-1", matchesGated: true },
      gate: { command: ["npm", "run", "gate"], verdict: "pass", gated: true },
      parsedCounts: { acceptance: { passed: 3, total: 3 }, developer: { passed: 1, total: 1 }, executed: 4 },
      integrated: [
        { item: "one", agents: ["a"], pushes: 1 },
        { item: "two", agents: ["b"], pushes: 1 },
      ],
      pushesMerged: 2,
      approvedContracts: [{ contract: "k1", target: "tests/a.test.ts", kind: "modify", decidedBy: "human" }],
      proof: { status: "proven", reasons: [] },
      at: WRITTEN,
    });
    const text = receipt.text;
    expect(text.split("\n")[0]).toBe("Switchyard receipt: change change-1, revision 2");
    expect(text).toContain("Goal: report status");
    expect(text).toContain("Gate: npm run gate -> pass");
    expect(text).toContain("Gated commit: r2 (revision 2)");
    expect(text).toContain("Test counts (parsed from the gate output, advisory): acceptance 3/3, developer 1/1, 4 executed");
    expect(text).toContain("  - one by a (1 push(es))");
    expect(text).toContain("  - k1: modify tests/a.test.ts, decided by human");
    expect(text).not.toContain("k2:");
    expect(text).toContain("Promoted to: switchyard/change-1 (the gated tree)");
    expect(text).toContain(`Written: ${WRITTEN}`);
    // The JSON block reads back to exactly the facts.
    expect(text).toContain(RECEIPT_JSON_MARKER);
    expect(parsePromotionReceipt(text)).toEqual(receipt.facts);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it("clips a long goal, labels an ungated pass, and states a not-proven bundle's reasons", () => {
    const long = `fix ${"the very long objective ".repeat(40)}`;
    const log = promotedRun(long);
    const bundle = buildProofBundle(
      log.messages.map((m) => (m.type === "integrated.rev" && m.payload.n === 2 ? ({ ...m, payload: { ...m.payload, gated: false } } as BoardMessage) : m)),
      { changeId: "change-1" },
    );
    const receipt = buildPromotionReceipt(bundle, { at: WRITTEN })!;
    expect(receipt.facts.objectiveClipped).toBe(true);
    expect(receipt.facts.objective!.length).toBe(280);
    expect(receipt.text).toContain("-> no gate ran (unverified: nothing was checked)");
    expect(receipt.facts.proof.status).toBe("not-proven");
    expect(receipt.text).toContain("Proof: not-proven (no gate ran on the last revision (2): its pass checked nothing)");
  });

  it("has nothing to say without a recorded promotion", () => {
    const unpromoted = promotedRun().messages.filter((m) => m.type !== "revision.promoted");
    expect(buildPromotionReceipt(buildProofBundle(unpromoted), { at: WRITTEN })).toBeUndefined();
    expect(parsePromotionReceipt("just a note")).toBeUndefined();
  });

  it("the proof bundle reports the receipt's outcome, written or not (a record, never part of the proof)", () => {
    const messages = promotedRun().messages;
    const written = buildProofBundle(messages, { changeId: "change-1", receipt: { ref: "refs/notes/switchyard", commit: "p1", written: true } });
    expect(written.status).toBe("proven");
    expect(written.receipt).toEqual({ ref: "refs/notes/switchyard", commit: "p1", written: true });
    expect(formatProofSummary(written).join("\n")).toContain("receipt: git note on p1 under refs/notes/switchyard");
    const failed = buildProofBundle(messages, { changeId: "change-1", receipt: { ref: "refs/notes/switchyard", commit: "p1", written: false, reason: "git notes failed: locked" } });
    // A receipt failure never changes the proof.
    expect(failed.status).toBe("proven");
    expect(formatProofSummary(failed).join("\n")).toContain("receipt: NOT written (git notes failed: locked)");
  });
});

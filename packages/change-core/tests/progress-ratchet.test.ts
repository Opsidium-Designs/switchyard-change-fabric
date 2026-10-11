/**
 * The pre-pass progress ratchet's pure parts: the progress score and its
 * total order, the ratchet derived from the log (the best-scoring failing
 * revision before the first pass, ties to the earliest), its history, and its
 * merged set rebuilt as integration units.
 */
import { describe, expect, it } from "vitest";

import {
  appendBoardMessage,
  compareProgressScore,
  emptyBoard,
  describeProgressScore,
  prePassRatchet,
  progressScore,
  ratchetHistory,
  ratchetLine,
  ratchetUnits,
  reduceBoard,
  regressionQuote,
  type BoardMessage,
  type BoardProgressScore,
  type BoardRevProgress,
} from "../src/index.ts";

const AT = "2026-01-01T00:00:00.000Z";

const typecheck = (errors: number): BoardRevProgress => ({ passed: 0, failed: 0, total: 0, acceptanceNotRun: `typecheck failed (${errors} error${errors === 1 ? "" : "s"})` });
const acceptance = (passed: number, total = 9, developer?: { passed: number; total: number }): BoardRevProgress => ({
  passed: passed + (developer?.passed ?? 0),
  failed: total - passed + ((developer?.total ?? 0) - (developer?.passed ?? 0)),
  total: total + (developer?.total ?? 0),
  ...(developer
    ? {
        suites: [
          { passed: developer.passed, failed: developer.total - developer.passed, total: developer.total, suite: "developer" as const },
          { passed, failed: total - passed, total, suite: "acceptance" as const },
        ],
      }
    : {}),
  acceptance: { passed, failed: total - passed, total },
});

describe("progressScore and its total order", () => {
  it("reads acceptance counts, developer passes, and type errors from the progress record", () => {
    expect(progressScore(acceptance(51, 129, { passed: 9, total: 9 }))).toEqual({ runs: true, acceptance: 51, acceptanceTotal: 129, developer: 9, typeErrors: 0 });
    expect(progressScore(typecheck(26))).toEqual({ runs: false, acceptance: 0, developer: 0, typeErrors: 26 });
    expect(progressScore(typecheck(1))).toMatchObject({ typeErrors: 1 });
    expect(
      progressScore({
        passed: 3,
        failed: 2,
        total: 5,
        suites: [{ passed: 3, failed: 2, total: 5, suite: "developer" }],
        acceptanceNotRun: "the developer suite failed first (2 failed)",
      }),
    ).toEqual({ runs: false, acceptance: 0, developer: 3, typeErrors: 0 });
    // No acceptance gate known: the gate's own checks stand in.
    expect(progressScore({ passed: 4, failed: 2, total: 6 })).toEqual({ runs: true, acceptance: 4, acceptanceTotal: 6, developer: 0, typeErrors: 0 });
    expect(progressScore(undefined)).toBeUndefined();
    expect(progressScore({ passed: 0, failed: 0, total: 0 })).toBeUndefined();
  });

  it("orders runs-acceptance first, then acceptance passes, then developer passes, then fewer type errors", () => {
    const s = (x: Partial<BoardProgressScore>): BoardProgressScore => ({ runs: false, acceptance: 0, developer: 0, typeErrors: 0, ...x });
    const ordered = [
      s({ typeErrors: 26 }),
      s({ typeErrors: 24 }),
      s({ typeErrors: 1 }),
      s({ developer: 3, typeErrors: 0 }),
      s({ runs: true, acceptance: 0 }),
      s({ runs: true, acceptance: 40, developer: 1 }),
      s({ runs: true, acceptance: 40, developer: 9 }),
      s({ runs: true, acceptance: 51 }),
    ];
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        expect(Math.sign(compareProgressScore(ordered[i]!, ordered[j]!))).toBe(Math.sign(i - j));
      }
    }
    expect(describeProgressScore(ordered[0]!)).toBe("26 type errors");
    expect(describeProgressScore(s({ typeErrors: 1 }))).toBe("1 type error");
    expect(describeProgressScore(progressScore(acceptance(51, 129))!)).toBe("acceptance 51/129");
    // `to` is the stack with the push, `from` the same stack without it.
    expect(regressionQuote({ from: progressScore(typecheck(2))!, to: progressScore(typecheck(24))!, evidence: ["src/a.ts(1,1): error TS2339: x"] })).toBe(
      "removing your push removes 22 type errors: src/a.ts(1,1): error TS2339: x",
    );
    expect(regressionQuote({ from: progressScore(acceptance(5))!, to: progressScore(typecheck(3))!, evidence: [] })).toBe(
      "removing your push removes 3 type errors (the acceptance suite runs again: acceptance 5/9)",
    );
    expect(regressionQuote({ from: progressScore(acceptance(5))!, to: progressScore(acceptance(3))!, evidence: [] })).toBe(
      "removing your push takes the stack from acceptance 3/9 to acceptance 5/9",
    );
  });
});

/** A log of revisions with the given gates and progress (no board arbitration needed: the ratchet reads the log). */
function logOf(arbitration: number | undefined, revs: readonly { gate: "pass" | "fail"; progress?: BoardRevProgress; merged?: string[] }[]): BoardMessage[] {
  const out: BoardMessage[] = [
    { seq: 1, at: AT, from: "human", type: "goal.posted", payload: { objective: "o", rules: { maxContestTurns: 3, contestIdleMessages: 25, maxFixAttempts: 2, ...(arbitration ? { arbitration } : {}) } } },
  ];
  revs.forEach((r, k) =>
    out.push({
      seq: out.length + 1,
      at: AT,
      from: "engine",
      type: "integrated.rev",
      payload: { n: k + 1, commit: `r${k + 1}`, gate: r.gate, merged: r.merged ?? [`p${k + 1}`], paths: [], contributors: [], ...(r.progress ? { progress: r.progress } : {}) },
    }),
  );
  return out;
}

describe("prePassRatchet and ratchetHistory", () => {
  it("the best-scoring failing revision so far, ties to the earliest (sf11's typecheck counts 1, 4, 2, 1, 26, 24)", () => {
    const log = logOf(5, [typecheck(1), typecheck(4), typecheck(2), typecheck(1), typecheck(26), typecheck(24)].map((progress) => ({ gate: "fail" as const, progress })));
    expect(ratchetHistory(log).map((s) => [s.n, s.line])).toEqual([[1, "1 type error"]]);
    expect(prePassRatchet(log)).toMatchObject({ n: 1, commit: "r1", merged: ["p1"], score: { typeErrors: 1 } });
    expect(ratchetLine(log)).toBe("best so far: rev 1, 1 type error (not a verdict; the head is unchanged)");
  });

  it("a tree that runs acceptance replaces one that does not; more acceptance passes replace fewer (sf10 peaked at 51/129 on rev 10)", () => {
    const log = logOf(5, [
      { gate: "fail", progress: typecheck(3) },
      { gate: "fail", progress: acceptance(40, 129) },
      { gate: "fail" },
      { gate: "fail", progress: acceptance(51, 129) },
      { gate: "fail", progress: acceptance(51, 129) },
      { gate: "fail", progress: typecheck(2) },
    ]);
    expect(ratchetHistory(log).map((s) => [s.n, s.line])).toEqual([
      [1, "3 type errors"],
      [2, "acceptance 40/129"],
      [4, "acceptance 51/129"],
    ]);
    expect(prePassRatchet(log)).toMatchObject({ n: 4, seq: 5 });
  });

  it("no ratchet before arbitration revision 5, once a revision passed, or with nothing comparable", () => {
    const fails = [{ gate: "fail" as const, progress: acceptance(2) }];
    expect(prePassRatchet(logOf(4, fails))).toBeUndefined();
    expect(prePassRatchet(logOf(undefined, fails))).toBeUndefined();
    expect(ratchetHistory(logOf(4, fails))).toEqual([]);
    expect(prePassRatchet(logOf(5, [...fails, { gate: "pass", progress: acceptance(9) }]))).toBeUndefined();
    // History stops at the first pass.
    expect(ratchetHistory(logOf(5, [...fails, { gate: "pass", progress: acceptance(9) }, { gate: "fail", progress: acceptance(8) }])).map((s) => s.n)).toEqual([1]);
    expect(prePassRatchet(logOf(5, [{ gate: "fail" }]))).toBeUndefined();
  });
});

describe("ratchetUnits", () => {
  it("rebuilds the ratchet's merged set as one unit per agent, pinned to its latest merged commit", () => {
    let state = emptyBoard();
    const log: BoardMessage[] = [];
    const post = (from: string, body: Record<string, unknown>): void => {
      const origin = from === "human" ? ({ kind: "human" } as const) : body.type === "agent.joined" ? ({ kind: "join", agent: from } as const) : ({ kind: "agent", agent: from } as const);
      const result = appendBoardMessage(state, origin, body, AT);
      state = result.state;
      log.push(...result.appended);
    };
    post("human", { type: "goal.posted", payload: { objective: "o", rules: { arbitration: 5 } } });
    post("a", { type: "agent.joined", payload: {} });
    post("b", { type: "agent.joined", payload: {} });
    for (const item of ["x", "y", "z"]) {
      post("human", { type: "item.proposed", payload: { item, objective: item, acceptance: [], scopeHint: [`src/${item}.ts`] } });
    }
    for (const [agent, item] of [["a", "x"], ["a", "z"], ["b", "y"]] as const) {
      post(agent, { type: "item.claimed", payload: { item, intent: { read: [], write: [`src/${item}.ts`] } } });
    }
    post("a", { type: "push.announced", payload: { item: "x", commit: "ax1", paths: ["src/x.ts"] } });
    post("a", { type: "push.announced", payload: { item: "z", commit: "az1", paths: ["src/z.ts"] } });
    post("b", { type: "push.announced", payload: { item: "y", commit: "by1", paths: ["src/y.ts"] } });
    expect(reduceBoard(log)).toEqual(state);
    const { units, complete } = ratchetUnits(log, state, { merged: ["by1", "ax1", "az1"] });
    expect(complete).toBe(true);
    expect(units.map((u) => ({ agent: u.agent, commit: u.commit, includes: u.includes, scope: u.scope, items: u.items.map((i) => i.id), base: u.baselineRef }))).toEqual([
      { agent: "a", commit: "az1", includes: ["ax1"], scope: ["src/x.ts", "src/z.ts"], items: ["x", "z"], base: "HEAD" },
      { agent: "b", commit: "by1", includes: [], scope: ["src/y.ts"], items: ["y"], base: "HEAD" },
    ]);
    expect(ratchetUnits(log, state, { merged: ["ax1", "ghost"] }).complete).toBe(false);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  appendBoardMessage,
  appendDecisionRecorded,
  appendIntegratedRev,
  describeProgress,
  progressHeadline,
  seamContractCue,
  seamItemId,
  seamHolds,
  seamItemHolding,
  seamWaits,
  activeClaims,
  claimCapReached,
  waitingOnOthers,
  appendSeamStalled,
  appendEngineRecord,
  ENGINE_RECORD_TYPES,
  leaseLapse,
  leaseSuspension,
  itemWaitReason,
  describeWaitReason,
  replanEligible,
  seamContractFacts,
  releasedTargets,
  uncoveredFailureFiles,
  appendToolGated,
  appendToolUsed,
  applyBoardEscalations,
  boardAttributionTally,
  boardContractDecision,
  BOARD_LIMITS,
  BOARD_MESSAGE_TYPES,
  BoardError,
  boardContestClosures,
  boardDigest,
  boardErrorStatus,
  boardEscalationRequests,
  boardMessagesAfter,
  boardResolutionForDecision,
  checkBoardTransition,
  checkHelpFork,
  contestResponder,
  formatAttributionTally,
  emptyBoard,
  endpointPoster,
  foldBoard,
  parseBoardDraft,
  pureBoardEndpoint,
  reduceBoard,
  runBoardScript,
  awaitingSubLead,
  narrowToSplitChildren,
  objectiveSubChanges,
  pendingPushItems,
  integrablePushItems,
  splitCue,
  planBoardIntegration,
  decideSpeculativeLanding,
  speculationStateKey,
  speculativeUnits,
  summarizeBoard,
  verifyBoard,
  type BoardAppendResult,
  type BoardMessage,
  type BoardMessageType,
  type BoardOrigin,
  type BoardState,
  type ContestAnswer,
} from "../src/index.ts";

const AT = "2026-01-01T00:00:00.000Z";

/**
 * A small in-memory board for tests. Each draft is routed by its sender the
 * way the substrates route requests: `human` through the human origin, an
 * engine integrated.rev through appendIntegratedRev, agent.joined through the
 * join origin, and everything else as the named agent (the authenticated
 * origin), with `from` stripped from the body.
 */
class TestBoard {
  state: BoardState = emptyBoard();
  readonly log: BoardMessage[] = [];

  private run(draft: Record<string, unknown>): BoardAppendResult {
    const { from, ...body } = draft;
    if (from === "engine") {
      const payload = (draft.payload ?? {}) as unknown;
      if ((ENGINE_RECORD_TYPES as readonly string[]).includes(String(draft.type))) {
        return appendEngineRecord(this.state, { type: draft.type, payload }, AT);
      }
      return draft.type === "decision.recorded"
        ? appendDecisionRecorded(this.state, payload, AT)
        : draft.type === "tool.gated"
          ? appendToolGated(this.state, payload, AT)
          : draft.type === "tool.used"
            ? appendToolUsed(this.state, payload, AT)
            : draft.type === "seam.stalled"
              ? appendSeamStalled(this.state, payload, AT)
              : appendIntegratedRev(this.state, payload, AT);
    }
    const origin: BoardOrigin =
      from === "human"
        ? { kind: "human" }
        : draft.type === "agent.joined"
          ? { kind: "join", agent: String(from) }
          : { kind: "agent", agent: String(from) };
    return appendBoardMessage(this.state, origin, body, AT);
  }

  post(draft: Record<string, unknown>): BoardMessage[] {
    const result = this.run(draft);
    this.state = result.state;
    this.log.push(...result.appended);
    return [...result.appended];
  }

  reject(draft: Record<string, unknown>, pattern: RegExp, code?: string): void {
    const before = JSON.stringify(this.state);
    let thrown: unknown;
    try {
      this.run(draft);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BoardError);
    expect((thrown as BoardError).message).toMatch(pattern);
    if (code !== undefined) {
      expect((thrown as BoardError).code).toBe(code);
    }
    expect(JSON.stringify(this.state)).toBe(before);
  }

  types(draft: Record<string, unknown>): string[] {
    return this.post(draft).map((m) => m.type);
  }
}

function msg(from: string, type: BoardMessageType, payload: unknown = {}, extra: Record<string, unknown> = {}) {
  return { from, type, payload, ...extra };
}

const claim = (agent: string, item: string, write: string[], read: string[] = []) =>
  msg(agent, "item.claimed", { item, intent: { read, write } });
const push = (agent: string, item: string, commit: string, paths: string[]) =>
  msg(agent, "push.announced", { item, commit, paths });
const rev = (gate: "pass" | "fail", merged: string[], commit = "rev") =>
  msg("engine", "integrated.rev", { commit, gate, merged });

/** A board with a goal, agents a/b/c and a lead joined, and items one/two/three open. */
function seeded(rules?: Record<string, number>): TestBoard {
  const board = new TestBoard();
  board.post(msg("human", "goal.posted", { objective: "reach the goal", ...(rules ? { rules } : {}) }));
  for (const agent of ["a", "b", "c"]) {
    board.post(msg(agent, "agent.joined"));
  }
  board.post(msg("lead", "agent.joined", { role: "lead" }));
  for (const item of ["one", "two", "three"]) {
    board.post(msg("lead", "item.proposed", { item, objective: `do ${item}`, acceptance: ["it works"], scopeHint: ["**"] }));
  }
  return board;
}

/** The last contest opened on the board. */
function lastContest(board: TestBoard): string {
  const ids = Object.keys(board.state.contests);
  return ids[ids.length - 1]!;
}

/** Complete an item the honest way: push, propose done, integrate passing. */
function complete(board: TestBoard, agent: string, item: string, commit: string, path: string): BoardMessage[] {
  board.post(push(agent, item, commit, [path]));
  board.post(msg(agent, "done.proposed", { item }));
  return board.post(rev("pass", [commit], `int-${commit}`));
}

// One structurally valid payload per type, so every type's validator is exercised.
const VALID: Record<BoardMessageType, { from: string; payload: Record<string, unknown> }> = {
  "goal.posted": { from: "human", payload: { objective: "o" } },
  "item.proposed": { from: "lead", payload: { item: "i", objective: "o", acceptance: ["x"], scopeHint: ["src/**"] } },
  "item.accepted": { from: "lead", payload: { item: "i" } },
  "item.rejected": { from: "lead", payload: { item: "i" } },
  "item.claimed": { from: "a", payload: { item: "i", intent: { read: ["src/x.ts"], write: ["src/**"] } } },
  "claim.granted": { from: "engine", payload: { item: "i", agent: "a", intent: { read: [], write: ["src/**"] } } },
  "claim.contested": {
    from: "engine",
    payload: { contest: "c", item: "i", claimant: "a", owner: "b", ownerItem: "j", overlap: ["src/a.ts"], intent: { read: [], write: ["src/a.ts"] } },
  },
  "claim.ceded": { from: "a", payload: { contest: "c" } },
  "claim.kept": { from: "a", payload: { contest: "c" } },
  "claim.narrowed": { from: "a", payload: { contest: "c", write: ["src/a.ts"] } },
  "claim.resolved": { from: "human", payload: { contest: "c", how: "human-decided", winner: "a" } },
  "claim.escalated": { from: "engine", payload: { contest: "c", item: "i", owner: "b", claimant: "a", overlap: ["src/a.ts"], turns: 0, reason: "idle" } },
  "claim.lapsed": { from: "engine", payload: { item: "i", agent: "a", reason: "no-progress", lastProgressSeq: 4, commit: "c1" } },
  "claim.extended": { from: "lead", payload: { item: "i", reason: "it pushed within the lease" } },
  "claim.overlap": { from: "engine", payload: { item: "i", agent: "a", with: "j", withAgent: "b", files: ["src/shared/**"] } },
  "item.split": { from: "a", payload: { item: "i", children: [{ item: "k", objective: "o" }] } },
  "item.replanned": { from: "lead", payload: { item: "i", reason: "stalled", action: "rescope", children: [{ item: "k", objective: "o", scopeHint: ["src/k.ts"] }], rev: 2 } },
  "item.escalated": { from: "engine", payload: { item: "k", reason: "replan-failed", replanOf: "i" } },
  "trunk.moved": { from: "engine", payload: { rev: 2, commit: "abc", expected: "def", actual: "fed" } },
  "push.excluded": { from: "engine", payload: { item: "i", agent: "a", commit: "c1", reason: "failed verification (scope: src/q.ts is outside the write intent)" } },
  "push.regressed": {
    from: "engine",
    payload: {
      item: "i",
      agent: "a",
      commit: "c1",
      rev: 3,
      ratchet: 2,
      from: { runs: true, acceptance: 51, acceptanceTotal: 129, developer: 9, typeErrors: 0 },
      to: { runs: false, acceptance: 0, developer: 0, typeErrors: 22 },
      candidate: "cand1",
      evidence: ["src/billing/payments.ts(25,12): error TS2339: Property 'auth' does not exist on type 'Ctx'."],
      seams: ["src/contracts/auth.ts"],
    },
  },
  "token.refreshed": { from: "engine", payload: { agent: "a", kind: "help-fork", request: "r" } },
  "revision.promoted": { from: "engine", payload: { rev: 3, gatedCommit: "abc", commit: "def", branch: "switchyard/change-1" } },
  "run.capped": { from: "engine", payload: { kind: "spend", limit: 5, used: 5.25 } },
  "candidate.gated": {
    from: "engine",
    payload: { round: 1, index: 1, of: 2, prefix: [{ agent: "a", items: ["i"], commit: "c1" }], commit: "abc", base: "b0", verdict: "fail", outcome: "blamed", rev: 2, blamed: ["i"] },
  },
  "clash.predicted": {
    from: "engine",
    payload: { a: { agent: "a", item: "i", sha: "c1" }, b: { agent: "b", item: "j", sha: "c2" }, status: "conflict", paths: ["src/a.ts"], scope: "local" },
  },
  "item.discovered": { from: "a", payload: { item: "k", objective: "o", reason: "found a gap", parent: "i" } },
  "help.requested": { from: "a", payload: { request: "r", item: "i", need: "tool" } },
  "help.offered": { from: "b", payload: { request: "r", forkOf: "a", forkCommit: "abc123", fork: "chg--help-r" } },
  "help.delivered": { from: "b", payload: { request: "r", commit: "def456", paths: ["src/a.ts"] } },
  "help.closed": { from: "a", payload: { request: "r", reason: "pull-failed", detail: "merge conflict" } },
  "item.struggling": { from: "a", payload: { item: "i", turnsSpent: 4, failedEdits: 2, reason: "failed-edits", lastFailure: "NO_CHANGE" } },
  "help.volunteered": { from: "b", payload: { item: "i" } },
  "help.declined": { from: "a", payload: { item: "i", volunteer: "b" } },
  "contract.proposed": { from: "a", payload: { contract: "k", target: "src/api.ts#handler", kind: "modify" } },
  "contract.escalated": { from: "engine", payload: { contract: "k", item: "i", target: "tests/a.test.ts", kind: "modify" } },
  "contract.accepted": { from: "lead", payload: { contract: "k" } },
  "contract.rejected": { from: "human", payload: { contract: "k" } },
  "seam.stalled": { from: "engine", payload: { item: "i", released: true } },
  "push.announced": { from: "a", payload: { item: "i", commit: "abc123", paths: ["src/a.ts"] } },
  "integrated.rev": { from: "engine", payload: { n: 1, commit: "abc", gate: "pass", merged: ["c1"], paths: ["src/a.ts"], contributors: ["a"] } },
  "rebase.needed": { from: "engine", payload: { agent: "a", n: 1, paths: ["src/a.ts"] } },
  "review.requested": { from: "a", payload: { review: "v", item: "i" } },
  "review.result": { from: "b", payload: { review: "v", findings: [{ kind: "failing-test", path: "tests/a.test.ts" }, { kind: "advisory" }] } },
  handoff: { from: "a", payload: { item: "i", to: "b", capsule: { repo: "repo-a", commit: "abc" } } },
  "done.proposed": { from: "a", payload: { item: "i" } },
  "item.completed": { from: "engine", payload: { item: "i", n: 1, via: "integrated" } },
  "fix.requested": { from: "engine", payload: { item: "i", n: 2, attempt: 1 } },
  "fix.exhausted": { from: "engine", payload: { item: "i", n: 3, attempts: 2 } },
  "item.reopened": { from: "engine", payload: { item: "i", previousOwner: "a", commit: "c1", n: 3 } },
  "tool.proposed": { from: "a", payload: { tool: "t", capability: "scan", kind: "scanner", inputs: ["src/**"], outputs: ["findings"] } },
  "tool.built": { from: "a", payload: { capability: "scan", commit: "abc", paths: ["tools/scan/run.mjs"] } },
  "tool.gated": {
    from: "engine",
    payload: { capability: "scan", commit: "abc", passed: true, checks: [{ check: "tests", passed: true, detail: "1 test passed" }], repo: "tools", usage: "node tools/scan/run.mjs" },
  },
  "tool.published": {
    from: "engine",
    payload: { tool: "t", capability: "scan", version: "1", repo: "tools", commit: "abc", verified: true, kind: "scanner", usage: "node tools/scan/run.mjs" },
  },
  "tool.used": { from: "engine", payload: { capability: "scan", version: "1", by: "b", item: "i", commit: "c1", changedFiles: ["src/a.ts"], findings: [{ path: "src/a.ts", line: 3, message: "m" }] } },
  "decision.recorded": { from: "engine", payload: { juncture: "attribution", question: "which?", answer: "i", confidence: 0.9, accepted: true, rev: 2, parsed: ["j"] } },
  "decision.resolved": {
    from: "engine",
    payload: { decisionSeq: 9, rev: 2, passed: 3, answer: "i", outcome: "in-fixed-set", fixed: ["i"], parsed: ["j"], parseOutcome: "not-in-fixed-set" },
  },
  "agent.joined": { from: "a", payload: { role: "builder" } },
  "agent.left": { from: "a", payload: {} },
};

// One structurally invalid payload per type.
const INVALID: Record<BoardMessageType, Record<string, unknown>> = {
  "goal.posted": { objective: "", rules: { maxContestTurns: 0 } },
  "item.proposed": { item: "bad id!", objective: "o" },
  "item.accepted": { item: "bad id!" },
  "item.rejected": {},
  "item.claimed": { item: "i", intent: { read: [], write: ["../escape"] } },
  "claim.granted": { item: "i", agent: "a" },
  "claim.contested": { contest: "c", item: "i", claimant: "a", owner: "b", ownerItem: "j", overlap: "src" },
  "claim.ceded": {},
  "claim.kept": { contest: 3 },
  "claim.narrowed": { contest: "c", write: "src/a.ts" },
  "claim.resolved": { contest: "c", how: "coin-flip" },
  "claim.escalated": { contest: "c", item: "i", owner: "b", claimant: "a", overlap: [], turns: 1, reason: "bored" },
  "claim.lapsed": { item: "i", agent: "a", reason: "bored", lastProgressSeq: 1 },
  "claim.extended": { item: "i" },
  "claim.overlap": { item: "i", agent: "a", with: "j", withAgent: "b", files: "src" },
  "item.split": { item: "i", children: [] },
  "item.replanned": { item: "i", reason: "bored", action: "split", children: [{ item: "k", objective: "o" }] },
  "item.escalated": { item: "k", reason: "replan-failed" },
  "clash.predicted": { a: { agent: "a", item: "i", sha: "c1" }, b: { agent: "b", item: "j", sha: "c2" }, status: "clean" },
  "trunk.moved": { rev: 0, commit: "abc" },
  "push.excluded": { item: "i", agent: "a", commit: "c1" },
  "push.regressed": { item: "i", agent: "a", commit: "c1", rev: 3, ratchet: 2, from: { runs: true }, to: {}, candidate: "x", evidence: [] },
  "token.refreshed": { agent: "a", kind: "help-fork" },
  "revision.promoted": { rev: 3, gatedCommit: "abc", commit: "def", branch: "../etc" },
  "run.capped": { kind: "item-calls", limit: 5, used: 6 },
  "candidate.gated": { round: 1, index: 2, of: 2, prefix: [{ agent: "a", items: ["i"], commit: "c1" }], commit: "abc", verdict: "pass", outcome: "passed" },
  "item.discovered": { item: "k", objective: "o" },
  "help.requested": { request: "r", item: "i" },
  "help.offered": {},
  "help.delivered": { request: "r", commit: "def456", paths: ["src/*.ts"] },
  "help.closed": { request: "r", reason: "bored" },
  "item.struggling": { item: "i", turnsSpent: -1, failedEdits: 0, reason: "tired" },
  "help.volunteered": { item: "bad id!" },
  "help.declined": { item: "i" },
  "contract.proposed": { contract: "k", target: "src/a.ts", kind: "rewrite" },
  "contract.escalated": { contract: "k", item: "i", target: "../x", kind: "modify" },
  "contract.accepted": {},
  "contract.rejected": { contract: "" },
  "seam.stalled": { item: "i", released: "yes" },
  "push.announced": { item: "i", commit: "abc", paths: ["src/**"] },
  "integrated.rev": { n: 1, commit: "abc", gate: "maybe", merged: [], paths: [], contributors: [] },
  "rebase.needed": { agent: "a", n: -1, paths: [] },
  "review.requested": { review: "v" },
  "review.result": { review: "v", findings: [{ kind: "opinion" }] },
  handoff: { item: "i", to: "b" },
  "done.proposed": { item: 1 },
  "item.completed": { item: "i", n: 1, via: "vibes" },
  "fix.requested": { item: "i", n: 0, attempt: 1 },
  "fix.exhausted": { item: "i", n: 1, attempts: -1 },
  "item.reopened": { item: "i", previousOwner: "a", n: 0 },
  "tool.proposed": { tool: "t", capability: "scan", kind: "linter" },
  "tool.built": { capability: "Scan Tool", commit: "abc", paths: ["tools/scan/run.mjs"] },
  "tool.gated": { capability: "scan", commit: "abc", passed: true, checks: [], repo: "tools", usage: "u" },
  "tool.published": { tool: "t", capability: "scan", version: "1", repo: "tools", commit: "abc", verified: false, kind: "scanner", usage: "u" },
  "tool.used": { capability: "scan", version: "1", by: "b", findings: [{ path: "src/*.ts", message: "m" }] },
  "decision.recorded": { juncture: "guess", question: "q", accepted: true },
  "decision.resolved": { decisionSeq: 1, rev: 1, passed: 2, answer: "i", outcome: "confirmed", fixed: [], parsed: [], parseOutcome: "none" },
  "agent.joined": { role: "has spaces" },
  "agent.left": { extra: "ignored" },
};

describe("board vocabulary: per-type payload validation", () => {
  it("covers every message type", () => {
    expect(Object.keys(VALID).sort()).toEqual([...BOARD_MESSAGE_TYPES].sort());
    expect(BOARD_MESSAGE_TYPES).toHaveLength(59);
  });

  it.each(BOARD_MESSAGE_TYPES)("accepts a well-formed %s", (type) => {
    const { from, payload } = VALID[type];
    const draft = parseBoardDraft({ type, payload, rationale: "why", inReplyTo: 1, to: ["z"] }, from);
    expect(draft.type).toBe(type);
    expect(draft.from).toBe(from);
    expect(draft.rationale).toBe("why");
    expect(draft.to).toEqual(["z"]);
  });

  it.each(BOARD_MESSAGE_TYPES.filter((t) => t !== "agent.left"))("rejects a malformed %s", (type) => {
    expect(() => parseBoardDraft({ type, payload: INVALID[type] }, VALID[type].from)).toThrow(BoardError);
  });

  it("goal.posted records the arbitration rules, filling defaults", () => {
    expect(parseBoardDraft({ type: "goal.posted", payload: { objective: "o" } }, "human").payload).toEqual({
      objective: "o",
      rules: { maxContestTurns: 3, contestIdleMessages: 25, maxFixAttempts: 2 },
    });
    expect(
      parseBoardDraft({ type: "goal.posted", payload: { objective: "o", rules: { maxContestTurns: 1 } } }, "human").payload,
    ).toEqual({ objective: "o", rules: { maxContestTurns: 1, contestIdleMessages: 25, maxFixAttempts: 2 } });
  });

  it("agent.left carries no payload fields (unknown fields are dropped, not stored)", () => {
    expect(parseBoardDraft({ type: "agent.left", payload: INVALID["agent.left"] }, "a").payload).toEqual({});
  });

  it("rejects unknown types, unknown envelope fields, caller-assigned seq, and a mismatched from", () => {
    expect(() => parseBoardDraft({ type: "item.hijacked", payload: {} }, "a")).toThrow(/unknown message type/);
    expect(() => parseBoardDraft({ type: "agent.joined", seq: 4 }, "a")).toThrow(/seq and at/);
    expect(() => parseBoardDraft({ type: "agent.joined", rationale: "x".repeat(2001) }, "a")).toThrow(/rationale/);
    expect(() => parseBoardDraft("not an object", "a")).toThrow(/JSON object/);
    try {
      parseBoardDraft({ from: "engine", type: "agent.left" }, "a");
      expect.unreachable();
    } catch (error) {
      expect((error as BoardError).code).toBe("AUTH");
    }
  });

  it("normalizes intent paths, keeps symbol-level intent, and treats a trailing slash as a directory", () => {
    const draft = parseBoardDraft(
      { type: "item.claimed", payload: { item: "i", intent: { write: ["./src/a.ts#parse", "src\\b.ts", "src/b.ts", "lib/"] } } },
      "a",
    );
    expect(draft.payload).toEqual({ item: "i", intent: { read: [], write: ["src/a.ts#parse", "src/b.ts", "lib/**"] } });
  });

  it("bounds intent size: entry length and entries per intent", () => {
    const long = `src/${"x".repeat(BOARD_LIMITS.maxEntryLength)}`;
    expect(() => parseBoardDraft({ type: "item.claimed", payload: { item: "i", intent: { write: [long] } } }, "a")).toThrow(
      /at most 512 chars/,
    );
    const many = Array.from({ length: BOARD_LIMITS.maxIntentEntries + 1 }, (_, i) => `src/f${i}.ts`);
    expect(() => parseBoardDraft({ type: "item.claimed", payload: { item: "i", intent: { write: many } } }, "a")).toThrow(
      /at most 64 paths/,
    );
    const children = Array.from({ length: BOARD_LIMITS.maxChildren + 1 }, (_, i) => ({ item: `k${i}`, objective: "o" }));
    expect(() => parseBoardDraft({ type: "item.split", payload: { item: "i", children } }, "a")).toThrow(/at most 32 items/);
  });
});

describe("board identity: who may say what", () => {
  it("refuses spoofed senders through every origin", () => {
    const board = seeded();
    const tryAs = (origin: BoardOrigin, body: Record<string, unknown>) => {
      try {
        appendBoardMessage(board.state, origin, body, AT);
        return "accepted";
      } catch (error) {
        return (error as BoardError).code;
      }
    };
    // An agent claiming to be the engine, the human, or another agent.
    expect(tryAs({ kind: "agent", agent: "a" }, { from: "engine", type: "item.completed", payload: { item: "one", n: 1, via: "integrated" } })).toBe("AUTH");
    expect(tryAs({ kind: "agent", agent: "a" }, { from: "human", type: "goal.posted", payload: { objective: "o" } })).toBe("AUTH");
    expect(tryAs({ kind: "agent", agent: "a" }, { from: "b", type: "agent.left" })).toBe("AUTH");
    // Engine-only and human-only types are refused from an agent even without a from.
    expect(tryAs({ kind: "agent", agent: "a" }, { type: "item.completed", payload: { item: "one", n: 1, via: "integrated" } })).toBe("NOT_ALLOWED");
    expect(tryAs({ kind: "agent", agent: "a" }, { type: "integrated.rev", payload: VALID["integrated.rev"].payload })).toBe("NOT_ALLOWED");
    expect(tryAs({ kind: "agent", agent: "a" }, { type: "claim.resolved", payload: { contest: "c", how: "human-decided", winner: "a" } })).toBe("NOT_ALLOWED");
    expect(tryAs({ kind: "agent", agent: "a" }, { type: "contract.accepted", payload: { contract: "k" } })).toBe("NOT_ALLOWED");
    // The human cannot act as an agent or as the engine.
    expect(tryAs({ kind: "human" }, { type: "item.claimed", payload: { item: "one", intent: { write: ["x"] } } })).toBe("NOT_ALLOWED");
    expect(tryAs({ kind: "human" }, { type: "rebase.needed", payload: { agent: "a", n: 1, paths: ["x"] } })).toBe("NOT_ALLOWED");
    // Joining goes only through the join origin, and reserved names cannot join.
    expect(tryAs({ kind: "agent", agent: "d" }, { type: "agent.joined" })).toBe("NOT_ALLOWED");
    expect(tryAs({ kind: "join", agent: "d" }, { type: "item.proposed", payload: { item: "z", objective: "o" } })).toBe("NOT_ALLOWED");
    expect(tryAs({ kind: "join", agent: "engine" }, { type: "agent.joined" })).toBe("AUTH");
    expect(tryAs({ kind: "join", agent: "human" }, { type: "agent.joined" })).toBe("AUTH");
    // An agent that never joined is unknown.
    expect(tryAs({ kind: "agent", agent: "stranger" }, { type: "item.claimed", payload: { item: "one", intent: { write: ["x"] } } })).toBe("UNKNOWN_AGENT");
  });

  it("a revision's progress labels the acceptance suite, or states why it did not run (never both)", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    const notRun = { passed: 0, failed: 0, total: 0, acceptanceNotRun: "typecheck failed (1 error)" };
    expect(() => appendIntegratedRev(board.state, { commit: "r1", gate: "fail", merged: ["c1"], progress: { ...notRun, acceptance: { passed: 0, failed: 0, total: 0 } } }, AT)).toThrow(/not both/);
    expect(() =>
      appendIntegratedRev(board.state, { commit: "r1", gate: "fail", merged: ["c1"], progress: { passed: 1, failed: 0, total: 1, suites: [{ passed: 1, failed: 0, total: 1, suite: "gate" }] } }, AT),
    ).toThrow(/"acceptance" or "developer"/);
    const appended = appendIntegratedRev(board.state, { commit: "r1", gate: "fail", merged: ["c1"], progress: notRun }, AT);
    const revision = appended.appended.find((m) => m.type === "integrated.rev");
    expect(revision?.type === "integrated.rev" ? revision.payload.progress : undefined).toEqual(notRun);
    expect(describeProgress(notRun)).toBe("acceptance suite did not run: typecheck failed (1 error)");
    expect(progressHeadline(notRun)).toBeUndefined();
    const labeled = {
      passed: 13,
      failed: 20,
      total: 33,
      suites: [
        { passed: 9, failed: 0, total: 9, suite: "developer" as const },
        { passed: 4, failed: 20, total: 24, suite: "acceptance" as const },
      ],
      acceptance: { passed: 4, failed: 20, total: 24 },
    };
    expect(describeProgress(labeled)).toBe("acceptance 4/24 passing; developer 9/9");
    expect(progressHeadline(labeled)).toEqual({ passed: 4, total: 24, acceptance: true });
    expect(describeProgress({ passed: 2, failed: 1, total: 3 })).toBe("2/3 checks passing");
  });

  it("the lead is a joined agent with the lead role; only one lead at a time; plain agents cannot decide contracts", () => {
    const board = seeded();
    board.reject(msg("d", "agent.joined", { role: "lead" }), /already has an active lead/, "DUPLICATE");
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/api.ts", kind: "add" }));
    board.reject(msg("b", "contract.accepted", { contract: "k1" }), /cannot be sent by an agent/, "NOT_ALLOWED");
    expect(board.types(msg("lead", "contract.accepted", { contract: "k1" }))).toEqual(["contract.accepted"]);
  });

  it("integrated revisions only come from a recorded integration result, with derived paths", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    expect(() => appendIntegratedRev(board.state, { commit: "r1", gate: "pass", merged: ["nope"] }, AT)).toThrow(
      /not the latest, unintegrated push/,
    );
    expect(() => appendIntegratedRev(board.state, { commit: "r1", gate: "great", merged: [] }, AT)).toThrow(BoardError);
    const [revision] = board.post(rev("pass", ["c1"], "r1"));
    expect(revision!.payload).toEqual({ n: 1, commit: "r1", gate: "pass", merged: ["c1"], paths: ["src/a/x.ts"], contributors: ["a"] });
    // A merged push cannot be merged twice.
    expect(() => appendIntegratedRev(board.state, { commit: "r2", gate: "pass", merged: ["c1"] }, AT)).toThrow(/unintegrated/);
  });

  it("replay rejects an integrated.rev whose derived fields were forged", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    board.post(rev("pass", ["c1"], "r1"));
    const forged = board.log.map((m) =>
      m.type === "integrated.rev" ? ({ ...m, payload: { ...m.payload, paths: ["src/elsewhere.ts"] } } as BoardMessage) : m,
    );
    expect(() => reduceBoard(forged)).toThrow(/does not match the pushes/);
  });
});

describe("board transitions: invalid moves are rejected with a clear error and code", () => {
  it("requires a goal first, and only one", () => {
    const board = new TestBoard();
    board.reject(msg("a", "agent.joined"), /no goal yet/, "NO_GOAL");
    board.post(msg("human", "goal.posted", { objective: "o" }));
    board.reject(msg("human", "goal.posted", { objective: "again" }), /already has a goal/, "DUPLICATE");
  });

  it("rejects claiming an unknown, claimed, or done item, and a claim with no write intent", () => {
    const board = seeded();
    board.reject(claim("a", "nope", ["src/**"]), /unknown item nope/, "UNKNOWN_REF");
    board.reject(claim("a", "one", []), /at least one write intent/, "BAD_PAYLOAD");
    board.post(claim("a", "one", ["src/a.ts"]));
    board.reject(claim("b", "one", ["src/z.ts"]), /item one is claimed \(by a\)/, "ITEM_NOT_OPEN");
    complete(board, "a", "one", "c1", "src/a.ts");
    board.reject(claim("b", "one", ["src/z.ts"]), /item one is done/, "ITEM_NOT_OPEN");
  });

  it("only the owner may push, split, hand off, request review, or propose done; pushes stay inside the write intent", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.reject(push("b", "one", "c1", ["src/a/x.ts"]), /b does not hold the claim/, "NOT_OWNER");
    board.reject(push("a", "one", "c1", ["src/b/x.ts"]), /outside the claim's write intent: src\/b\/x.ts/, "OUTSIDE_INTENT");
    board.reject(msg("b", "done.proposed", { item: "one" }), /does not hold/, "NOT_OWNER");
    board.reject(msg("b", "item.split", { item: "one", children: [{ item: "k", objective: "o" }] }), /does not hold/);
    board.reject(msg("a", "handoff", { item: "one", to: "a", capsule: { repo: "r" } }), /not another joined agent/, "UNKNOWN_AGENT");
    board.reject(msg("a", "handoff", { item: "one", to: "ghost", capsule: { repo: "r" } }), /not another joined agent/);
    expect(board.types(msg("a", "handoff", { item: "one", to: "b", capsule: { repo: "repo-a" } }))).toEqual(["handoff"]);
    expect(board.state.items.one?.owner).toBe("b");
  });

  it("an agent cannot leave while it holds a claim", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.reject(msg("a", "agent.left"), /still holds one/, "INVALID_STATE");
    board.post(msg("b", "agent.left"));
    board.reject(claim("b", "two", ["src/b.ts"]), /has left/, "UNKNOWN_AGENT");
  });

  it("help, contracts, and reviews follow their own rules", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.reject(msg("b", "help.requested", { request: "h1", item: "one", need: "capacity" }), /does not hold/);
    board.post(msg("a", "help.requested", { request: "h1", item: "one", need: "capacity" }));
    board.reject(msg("a", "help.offered", { request: "h1" }), /own request/);
    board.post(msg("b", "help.offered", { request: "h1" }));
    board.reject(msg("b", "help.offered", { request: "h1" }), /already offered/, "DUPLICATE");
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/api.ts#handler", kind: "modify" }));
    board.post(msg("human", "contract.rejected", { contract: "k1" }));
    board.reject(msg("lead", "contract.accepted", { contract: "k1" }), /already rejected/, "INVALID_STATE");
    board.post(msg("a", "review.requested", { review: "v1", item: "one" }));
    board.reject(msg("a", "review.result", { review: "v1", findings: [] }), /its own item/);
    board.post(msg("c", "review.result", { review: "v1", findings: [{ kind: "failing-test", path: "tests/a.test.ts" }] }));
    board.reject(msg("b", "review.result", { review: "v1", findings: [] }), /already has a result/);
  });

  it("addressed messages must name other joined agents", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.reject(msg("a", "help.requested", { request: "h1", item: "one", need: "review" }, { to: ["ghost"] }), /to names ghost/, "UNKNOWN_AGENT");
    board.reject(msg("a", "help.requested", { request: "h1", item: "one", need: "review" }, { to: ["a"] }), /to names a/);
    const [message] = board.post(msg("a", "help.requested", { request: "h1", item: "one", need: "review" }, { to: ["b", "c"] }));
    expect(message!.to).toEqual(["b", "c"]);
  });

  it("inReplyTo must name a recorded message", () => {
    const board = seeded();
    board.reject(msg("a", "help.offered", { request: "x" }, { inReplyTo: 999 }), /names no recorded message/, "UNKNOWN_REF");
  });

  it("a full board refuses further messages with LIMIT (409)", () => {
    const board = seeded();
    board.state = { ...board.state, lastSeq: BOARD_LIMITS.maxMessages - 10 };
    board.reject(claim("a", "one", ["src/a.ts"]), /the board is full/, "LIMIT");
    expect(boardErrorStatus("LIMIT")).toBe(409);
    expect(boardErrorStatus("AUTH")).toBe(401);
    expect(boardErrorStatus("INTENT_OVERLAP")).toBe(400);
  });
});

describe("board arbitration", () => {
  it("grants a free write intent", () => {
    const board = seeded();
    const appended = board.post(claim("a", "one", ["src/a/**"]));
    expect(appended.map((m) => [m.seq, m.from, m.type, m.inReplyTo])).toEqual([
      [9, "a", "item.claimed", undefined],
      [10, "engine", "claim.granted", 9],
    ]);
    expect(board.state.items.one).toMatchObject({ status: "claimed", owner: "a", intent: { read: [], write: ["src/a/**"] } });
  });

  it("read intents never block, and an agent's own claims never contest it", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    expect(board.types(claim("b", "two", ["src/b/**"], ["src/a/**"]))).toEqual(["item.claimed", "claim.granted"]);
    expect(board.types(claim("a", "three", ["src/a/x.ts"]))).toEqual(["item.claimed", "claim.granted"]);
  });

  it("a trailing-slash directory intent overlaps files under it", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/"]));
    expect(board.state.items.one?.intent?.write).toEqual(["src/a/**"]);
    expect(board.types(claim("b", "two", ["src/a/deep/x.ts"]))).toEqual(["item.claimed", "claim.contested"]);
  });

  it("an overlapping write intent opens a contest naming the owner and the overlap", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    const [, contested] = board.post(claim("b", "two", ["src/a/x.ts", "src/b.ts"]));
    expect(contested).toMatchObject({
      from: "engine",
      type: "claim.contested",
      inReplyTo: 11,
      payload: { contest: "contest-12", item: "two", claimant: "b", owner: "a", ownerItem: "one", overlap: ["src/a/x.ts"] },
    });
    expect(board.state.items.two).toMatchObject({ status: "contested", claimant: { agent: "b", contest: "contest-12" } });
    expect(board.state.contests["contest-12"]).toMatchObject({ status: "open", turns: 0, lastActionSeq: 12 });
  });

  it("symbol-level intents in one file are treated as the file and contest", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts#parse"]));
    expect(board.types(claim("b", "two", ["src/a.ts#emit"]))).toEqual(["item.claimed", "claim.contested"]);
  });

  it("the owner ceding releases its claim and grants the claimant", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    const appended = board.post(msg("a", "claim.ceded", { contest: lastContest(board) }));
    expect(appended.map((m) => m.type)).toEqual(["claim.ceded", "claim.resolved", "claim.granted"]);
    expect(appended[1]!.payload).toEqual({ contest: "contest-12", how: "owner-ceded", winner: "b" });
    expect(board.state.items.one).toMatchObject({ status: "open" });
    expect(board.state.items.two).toMatchObject({ status: "claimed", owner: "b" });
  });

  it("the claimant ceding withdraws its claim", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    expect(board.types(msg("b", "claim.ceded", { contest: lastContest(board) }))).toEqual(["claim.ceded", "claim.resolved"]);
    expect(board.state.items.two?.status).toBe("open");
    expect(board.state.contests["contest-12"]?.how).toBe("claimant-withdrew");
  });

  it("the owner narrowing away the overlap resolves the contest and grants the claimant", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    const contest = lastContest(board);
    board.reject(msg("a", "claim.narrowed", { contest, write: ["lib/**"] }), /stay within the previous one/, "NOT_WITHIN");
    board.reject(msg("a", "claim.narrowed", { contest, write: ["src/**x"] }), /invalid path/, "BAD_PAYLOAD");
    board.reject(msg("c", "claim.narrowed", { contest, write: ["src/a/y.ts"] }), /not a party/, "NOT_ALLOWED");
    expect(board.types(msg("a", "claim.narrowed", { contest, write: ["src/a/y.ts"] }))).toEqual([
      "claim.narrowed",
      "claim.resolved",
      "claim.granted",
    ]);
    expect(board.state.items.one?.intent?.write).toEqual(["src/a/y.ts"]);
  });

  it("an owner narrowing re-checks EVERY contest on its item, not just the named one", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    const first = lastContest(board);
    board.post(claim("c", "three", ["src/a/y.ts"]));
    const second = lastContest(board);
    expect(first).not.toBe(second);
    const appended = board.post(msg("a", "claim.narrowed", { contest: first, write: ["src/a/z.ts"] }));
    expect(appended.map((m) => `${m.type}:${(m.payload as { contest?: string; item?: string }).contest ?? (m.payload as { item?: string }).item}`)).toEqual([
      `claim.narrowed:${first}`,
      `claim.resolved:${first}`,
      "claim.granted:two",
      `claim.resolved:${second}`,
      "claim.granted:three",
    ]);
  });

  it("the claimant narrowing away the overlap is granted the narrowed intent", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts", "src/b.ts"]));
    expect(board.types(msg("b", "claim.narrowed", { contest: lastContest(board), write: ["src/b.ts"] }))).toEqual([
      "claim.narrowed",
      "claim.resolved",
      "claim.granted",
    ]);
    expect(board.state.items.two?.intent?.write).toEqual(["src/b.ts"]);
  });

  it("after a resolution the claimant is re-checked against every other live claim", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.post(claim("c", "three", ["src/c.ts"]));
    board.post(claim("b", "two", ["src/a.ts", "src/c.ts"]));
    expect(board.state.contests[lastContest(board)]).toMatchObject({ owner: "a" });
    const appended = board.post(msg("a", "claim.ceded", { contest: lastContest(board) }));
    expect(appended.map((m) => m.type)).toEqual(["claim.ceded", "claim.resolved", "claim.contested"]);
    expect(appended[2]!.payload).toMatchObject({ owner: "c", overlap: ["src/c.ts"], contest: `contest-${appended[2]!.seq}` });
  });

  it("a contest left unresolved after N turns escalates once, then waits for a human", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    const contest = lastContest(board);
    expect(board.types(msg("a", "claim.kept", { contest }))).toEqual(["claim.kept"]);
    expect(board.types(msg("b", "claim.kept", { contest }))).toEqual(["claim.kept"]);
    const third = board.post(msg("a", "claim.kept", { contest }));
    expect(third.map((m) => m.type)).toEqual(["claim.kept", "claim.escalated"]);
    expect(third[1]!.payload).toEqual({ contest, item: "two", owner: "a", claimant: "b", overlap: ["src/a/x.ts"], turns: 3, reason: "turns" });
    board.reject(msg("b", "claim.kept", { contest }), /waits for a human decision/, "CONTEST_OPEN");
    expect(board.types(msg("b", "claim.narrowed", { contest, write: ["src/a/x.ts"] }))).toEqual(["claim.narrowed"]);
    board.reject(msg("human", "claim.resolved", { contest, how: "narrowed" }), /must use how "human-decided"/);
    board.reject(msg("human", "claim.resolved", { contest, how: "human-decided", winner: "c" }), /winner must be a or b/);
    expect(board.types(msg("human", "claim.resolved", { contest, how: "human-decided", winner: "b" }))).toEqual([
      "claim.resolved",
      "claim.granted",
    ]);
    expect(board.state.items.one?.status).toBe("open");
    expect(board.state.items.two).toMatchObject({ status: "claimed", owner: "b" });
  });

  it("a contest no party acts on escalates after the idle limit (count-based)", () => {
    const board = seeded({ contestIdleMessages: 3 });
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"])); // contest opened at seq 12
    const contest = lastContest(board);
    expect(board.types(msg("lead", "item.proposed", { item: "four", objective: "o" }))).toEqual(["item.proposed"]); // 13
    expect(board.types(msg("lead", "item.proposed", { item: "five", objective: "o" }))).toEqual(["item.proposed"]); // 14
    const third = board.post(msg("lead", "item.proposed", { item: "six", objective: "o" })); // 15
    expect(third.map((m) => m.type)).toEqual(["item.proposed", "claim.escalated"]);
    expect(third[1]!.payload).toMatchObject({ contest, turns: 0, reason: "idle" });
    // A party acting resets the clock: a fresh contest that keeps getting turns does not idle out.
    expect(board.state.contests[contest]?.status).toBe("escalated");
  });

  it("the turn limit is recorded in goal.posted and replay honors it", () => {
    const board = seeded({ maxContestTurns: 1 });
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    expect(board.types(msg("a", "claim.kept", { contest: lastContest(board) }))).toEqual(["claim.kept", "claim.escalated"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a waiting claimant is granted when the owner's claim completes", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    const contest = lastContest(board);
    const appended = complete(board, "a", "one", "c1", "src/a/y.ts");
    expect(appended.map((m) => m.type)).toEqual(["integrated.rev", "item.completed", "claim.resolved", "claim.granted"]);
    expect(appended[2]!.payload).toEqual({ contest, how: "owner-released", winner: "b" });
  });

  it("handing an item off can never leave two agents owning overlapping writes", () => {
    // Repro: a claims X and Y with the same write (granted, own claims never
    // contest), then hands Y to b. Without the check, a and b would both own
    // writes to src/a.ts.
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    expect(board.types(claim("a", "two", ["src/a.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    board.reject(msg("a", "handoff", { item: "two", to: "b", capsule: { repo: "r" } }), /would overlap a's claim on one/, "INTENT_OVERLAP");
    // A handoff to an agent whose own claim overlaps is fine (it becomes the single writer).
    board.post(claim("b", "three", ["src/b.ts"]));
    complete(board, "a", "one", "c1", "src/a.ts");
    expect(board.types(msg("a", "handoff", { item: "two", to: "b", capsule: { repo: "r" } }))).toEqual(["handoff"]);
    const owners = Object.values(board.state.items).filter((i) => i.status === "claimed").map((i) => [i.id, i.owner]);
    expect(owners).toEqual([
      ["two", "b"],
      ["three", "b"],
    ]);
  });

  it("a passing integrated revision sends rebase.needed only to agents whose intent meets the change", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/b/**"], ["src/a/api.ts"]));
    board.post(claim("c", "three", ["src/c/**"]));
    board.post(push("a", "one", "c1", ["src/a/api.ts", "src/a/impl.ts"]));
    const appended = board.post(rev("pass", ["c1"], "r1"));
    expect(appended.map((m) => [m.type, m.payload])).toEqual([
      ["integrated.rev", { n: 1, commit: "r1", gate: "pass", merged: ["c1"], paths: ["src/a/api.ts", "src/a/impl.ts"], contributors: ["a"] }],
      ["rebase.needed", { agent: "b", n: 1, paths: ["src/a/api.ts"] }],
    ]);
    expect(board.state.agents.b?.rebaseTo).toBe(1);
    expect(board.state.integrated).toMatchObject({ n: 1, commit: "r1" });
  });

  it("a failing integrated revision advances nothing and triggers no rebase", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/b/**"], ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    expect(board.types(rev("fail", ["c1"]))).toEqual(["integrated.rev"]);
    expect(board.state.integrated).toBeNull();
    expect(board.state.lastRevN).toBe(1);
    expect(board.state.passingRevs).toEqual([]);
    expect(board.state.items.one?.lastPush?.integratedIn).toBeUndefined();
  });
});

describe("worker proposals wait for the lead (item.accepted / item.rejected)", () => {
  it("a worker's proposal is not claimable until the lead accepts it; the lead's and the human's items are open at once", () => {
    const board = seeded();
    expect(board.state.items.one?.status).toBe("open");
    board.post(msg("human", "item.proposed", { item: "h1", objective: "a human item", scopeHint: ["src/h/**"] }));
    expect(board.state.items.h1?.status).toBe("open");
    board.post(msg("a", "item.proposed", { item: "a-item-1", objective: "more work", scopeHint: ["src/x/**"] }));
    expect(board.state.items["a-item-1"]?.status).toBe("proposed");
    board.reject(claim("b", "a-item-1", ["src/x/y.ts"]), /is proposed and cannot be claimed/, "ITEM_NOT_OPEN");
    // Nobody but the lead or a human decides it.
    board.reject(msg("b", "item.accepted", { item: "a-item-1" }), /cannot be sent by/, "NOT_ALLOWED");
    board.reject(msg("a", "item.accepted", { item: "a-item-1" }), /cannot be sent by/, "NOT_ALLOWED");
    // The digest does not offer it as open work.
    expect(boardDigest(board.state, board.log, "b", 0).openItems.map((i) => i.item)).not.toContain("a-item-1");
    expect(summarizeBoard(board.state).items.proposed).toBe(1);
    expect(board.types({ ...msg("lead", "item.accepted", { item: "a-item-1" }), rationale: "new work" })).toEqual(["item.accepted"]);
    expect(board.state.items["a-item-1"]).toMatchObject({ status: "open", triage: { decision: "accepted", by: "lead" } });
    expect(board.types(claim("b", "a-item-1", ["src/x/y.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    // A decision is made once.
    board.reject(msg("lead", "item.accepted", { item: "a-item-1" }), /not a proposal awaiting a decision/, "INVALID_STATE");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a rejection needs a rationale; a rejected proposal can never be claimed", () => {
    const board = seeded();
    board.post(msg("a", "item.discovered", { item: "dup", objective: "do one again", reason: "found more", scopeHint: ["src/**"] }));
    expect(board.state.items.dup?.status).toBe("proposed");
    board.reject(msg("lead", "item.rejected", { item: "dup" }), /needs a rationale/, "BAD_PAYLOAD");
    expect(board.types({ ...msg("lead", "item.rejected", { item: "dup" }), rationale: "duplicates item one" })).toEqual(["item.rejected"]);
    expect(board.state.items.dup).toMatchObject({ status: "rejected", triage: { decision: "rejected", by: "lead" } });
    board.reject(claim("a", "dup", ["src/a.ts"]), /is rejected and cannot be claimed/, "ITEM_NOT_OPEN");
    board.reject(msg("human", "item.accepted", { item: "dup" }), /not a proposal awaiting a decision/, "INVALID_STATE");
    expect(summarizeBoard(board.state).items).toMatchObject({ proposed: 0, rejected: 1, open: 3 });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("completion is derived from a passing revision", () => {
  it("needs done.proposed AND the owner's latest push merged by a passing revision, in either order", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.post(claim("b", "two", ["src/b.ts"]));
    // Push, fail, propose done: still not complete.
    board.post(push("a", "one", "c1", ["src/a.ts"]));
    board.post(rev("fail", ["c1"], "r1"));
    expect(board.types(msg("a", "done.proposed", { item: "one" }))).toEqual(["done.proposed"]);
    // The passing revision completes it, citing the passing rev number.
    const passed = board.post(rev("pass", ["c1"], "r2"));
    expect(passed.map((m) => [m.type, m.payload])).toContainEqual(["item.completed", { item: "one", n: 2, via: "integrated" }]);
    // Merged first, done proposed after: completes on the proposal.
    board.post(push("b", "two", "c2", ["src/b.ts"]));
    board.post(rev("pass", ["c2"], "r3"));
    expect(board.state.items.two?.status).toBe("claimed");
    expect(board.post(msg("b", "done.proposed", { item: "two" })).map((m) => m.type)).toEqual(["done.proposed", "item.completed"]);
  });

  it("a push after the merged one must be merged again before completion", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.post(push("a", "one", "c1", ["src/a.ts"]));
    board.post(rev("pass", ["c1"], "r1"));
    board.post(push("a", "one", "c2", ["src/a.ts"]));
    expect(board.types(msg("a", "done.proposed", { item: "one" }))).toEqual(["done.proposed"]);
    expect(board.post(rev("pass", ["c2"], "r2")).map((m) => m.type)).toContain("item.completed");
  });

  it("the transition rules refuse a completion citing a failing revision or an unmerged push", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.post(push("a", "one", "c1", ["src/a.ts"]));
    board.post(rev("fail", ["c1"], "r1"));
    board.post(msg("a", "done.proposed", { item: "one" }));
    const completion = { from: "engine", type: "item.completed", payload: { item: "one", n: 1, via: "integrated" } } as const;
    expect(() => checkBoardTransition(board.state, completion, "engine")).toThrow(/rev 1 did not pass/);
    board.post(claim("b", "two", ["src/b.ts"]));
    board.post(push("b", "two", "c9", ["src/b.ts"]));
    board.post(rev("pass", ["c9"], "r2"));
    expect(() => checkBoardTransition(board.state, { ...completion, payload: { item: "one", n: 2, via: "integrated" } }, "engine")).toThrow(
      /was not merged by passing rev 2/,
    );
  });

  /** Split item one (owner a, write src/a/**) into one-x and one-y, claimed by b and c, each pushed. */
  function splitAndPush(): TestBoard {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(
      msg("a", "item.split", {
        item: "one",
        children: [
          { item: "one-x", objective: "x", scopeHint: ["src/a/x.ts"] },
          { item: "one-y", objective: "y", scopeHint: ["src/a/y.ts"] },
        ],
      }),
    );
    board.post(claim("b", "one-x", ["src/a/x.ts"]));
    board.post(claim("c", "one-y", ["src/a/y.ts"]));
    board.post(push("b", "one-x", "px", ["src/a/x.ts"]));
    board.post(push("c", "one-y", "py", ["src/a/y.ts"]));
    board.post(msg("b", "done.proposed", { item: "one-x" }));
    board.post(msg("c", "done.proposed", { item: "one-y" }));
    return board;
  }

  it("a split item's owner becomes its sub-lead: children are open and claimed by others, their pushes go to the sub-lead", () => {
    const board = splitAndPush();
    expect(board.state.items.one).toMatchObject({ status: "split", owner: "a", subLead: "a", children: ["one-x", "one-y"], intent: { write: ["src/a/**"] } });
    expect(board.state.items["one-x"]).toMatchObject({ status: "claimed", owner: "b", parent: "one" });
    // The children's pushes are not integrated directly while the sub-lead is on the board.
    board.reject(rev("pass", ["px"], "r1"), /integrates through its sub-lead a's push/, "UNKNOWN_REF");
    // The sub-lead sees its children and their pushes in its digest.
    const digest = boardDigest(board.state, board.log, "a", 0);
    expect(digest.subLead).toEqual([
      {
        item: "one",
        objective: "do one",
        write: ["src/a/**"],
        children: [
          { item: "one-x", status: "claimed", owner: "b", lastPush: { commit: "px", agent: "b" }, merged: false },
          { item: "one-y", status: "claimed", owner: "c", lastPush: { commit: "py", agent: "c" }, merged: false },
        ],
      },
    ]);
    expect(digest.messages.some((m) => m.type === "push.announced" && m.payload.item === "one-x")).toBe(true);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("the sub-lead announces ONE push merging its children; the parent completes when the children are done and that push passes", () => {
    const board = splitAndPush();
    board.reject(push("a", "one", "pa", ["src/a/x.ts"]), /announce the merge of its children's pushes/, "NOT_ALLOWED");
    board.reject(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "nope" }] }), /not one-x's latest unintegrated push/, "INVALID_STATE");
    board.reject(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/b.ts"], merges: [{ item: "one-x", commit: "px" }] }), /outside their write intents/, "OUTSIDE_INTENT");
    board.reject(msg("b", "push.announced", { item: "one-x", commit: "pz", paths: ["src/a/x.ts"], merges: [{ item: "one-y", commit: "py" }] }), /only a sub-lead merges/, "NOT_ALLOWED");
    board.post(
      msg("a", "push.announced", {
        item: "one",
        commit: "pa",
        paths: ["src/a/x.ts", "src/a/y.ts"],
        merges: [
          { item: "one-x", commit: "px" },
          { item: "one-y", commit: "py" },
        ],
      }),
    );
    expect(boardDigest(board.state, board.log, "a", 0).subLead?.[0]?.children.map((c) => c.merged)).toEqual([true, true]);
    const appended = board.post(rev("pass", ["pa"], "r1"));
    const integrated = appended.find((m) => m.type === "integrated.rev")!;
    expect(integrated.payload).toMatchObject({ merged: ["pa"], contributors: ["a", "b", "c"] });
    expect(appended.filter((m) => m.type === "item.completed").map((m) => m.payload)).toEqual([
      { item: "one-x", n: 1, via: "integrated" },
      { item: "one-y", n: 1, via: "integrated" },
      { item: "one", n: 1, via: "children" },
    ]);
    expect(board.state.items.one).toMatchObject({ status: "done", completed: { n: 1, via: "children" } });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a failing revision of a sub-lead's push asks the children's owners for the fix, and children must stay inside the owner's write intent", () => {
    const board = splitAndPush();
    board.post(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/a/x.ts", "src/a/y.ts"], merges: [{ item: "one-x", commit: "px" }, { item: "one-y", commit: "py" }] }));
    const fixes = board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["pa"], failing: { output: "src/a/y.ts:3 boom", items: ["one-y"] } }));
    expect(fixes.filter((m) => m.type === "fix.requested").map((m) => ({ item: m.payload.item, to: m.to }))).toEqual([{ item: "one-y", to: ["c"] }]);
    // A child's scope must lie inside the sub-lead's write intent, not only the item's scope hint.
    const other = seeded();
    other.post(claim("a", "one", ["src/a/x.ts"]));
    other.reject(
      msg("a", "item.split", { item: "one", children: [{ item: "c1", objective: "o", scopeHint: ["src/b.ts"] }] }),
      /outside your write intent on one/,
      "OUTSIDE_INTENT",
    );
  });

  it("integration plans route children's pushes to the sub-lead and integrate its one push; a failure is narrowed to the children", () => {
    const board = splitAndPush();
    expect(pendingPushItems(board.state).map((i) => i.id)).toEqual([]);
    expect(awaitingSubLead(board.state).map((i) => i.id)).toEqual(["one-x", "one-y"]);
    board.post(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "px" }] }));
    expect(awaitingSubLead(board.state).map((i) => i.id)).toEqual(["one-y"]);
    // The sub-lead's unit integrates only its merged children's write intents.
    const plan = planBoardIntegration(board.log, board.state);
    expect(plan.units.map((u) => ({ agent: u.agent, commit: u.commit, scope: u.scope }))).toEqual([{ agent: "a", commit: "pa", scope: ["src/a/x.ts"] }]);
    expect(narrowToSplitChildren(board.state, ["one"], "AssertionError at src/a/x.ts:4")).toEqual(["one-x"]);
    // Nothing named: every child the push merged; not a split item: unchanged.
    expect(narrowToSplitChildren(board.state, ["one", "two"], "it failed")).toEqual(["one-x", "two"]);
  });

  it("a child the sub-lead pushes itself integrates directly: pending, not awaiting a merge, accepted by a revision, and its cap frees after a pass", () => {
    const board = seeded({ maxActiveClaims: 1, arbitration: 3 });
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(
      msg("a", "item.split", {
        item: "one",
        children: [
          { item: "one-x", objective: "x", scopeHint: ["src/a/x.ts"] },
          { item: "one-y", objective: "y", scopeHint: ["src/a/y.ts"] },
        ],
      }),
    );
    board.post(claim("a", "one-x", ["src/a/x.ts"]));
    board.post(push("a", "one-x", "px", ["src/a/x.ts"]));
    expect(pendingPushItems(board.state).map((i) => i.id)).toEqual(["one-x"]);
    expect(awaitingSubLead(board.state)).toEqual([]);
    expect(itemWaitReason(board.state, "one-x")).toEqual({ kind: "waiting-for-gate", commit: "px" });
    expect(claimCapReached(board.state, "a")).toBeDefined();
    const appended = board.post(rev("pass", ["px"], "r1"));
    expect(appended.find((m) => m.type === "integrated.rev")!.payload).toMatchObject({ merged: ["px"], contributors: ["a"] });
    expect(board.state.items["one-x"]!.lastPush).toMatchObject({ integratedIn: 1 });
    expect(claimCapReached(board.state, "a")).toBeUndefined();
    // Another agent's child still routes to the sub-lead: it waits for the
    // sub-lead's merge (named), and the parent is not "blocked by" it.
    board.post(claim("b", "one-y", ["src/a/y.ts"]));
    board.post(push("b", "one-y", "py", ["src/a/y.ts"]));
    expect(awaitingSubLead(board.state).map((i) => i.id)).toEqual(["one-y"]);
    expect(itemWaitReason(board.state, "one-y")).toEqual({ kind: "waiting-for-sub-lead", item: "one", agent: "a", merged: false });
    expect(describeWaitReason(itemWaitReason(board.state, "one-y")!)).toBe("its push waits for sub-lead a to merge it into one (pull)");
    expect(itemWaitReason(board.state, "one")).toBeUndefined();
    board.post(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/a/y.ts"], merges: [{ item: "one-y", commit: "py" }] }));
    expect(itemWaitReason(board.state, "one-y")).toMatchObject({ kind: "waiting-for-sub-lead", merged: true });
    expect(itemWaitReason(board.state, "one")).toEqual({ kind: "blocked-by", item: "one-x" });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("when the sub-lead leaves, its children integrate directly and the parent completes with them", () => {
    const board = splitAndPush();
    board.post(msg("a", "agent.left"));
    const appended = board.post(rev("pass", ["px", "py"], "r1"));
    expect(appended.filter((m) => m.type === "item.completed").map((m) => m.payload)).toEqual([
      { item: "one-x", n: 1, via: "integrated" },
      { item: "one-y", n: 1, via: "integrated" },
      { item: "one", n: 1, via: "children" },
    ]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("the state keeps counts and latest values, not per-event lists", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.post(push("a", "one", "c1", ["src/a.ts"]));
    board.post(push("a", "one", "c2", ["src/a.ts"]));
    publishTool(board, "c", "scan", "scanner");
    board.post(msg("engine", "tool.used", { capability: "scan", version: "1", by: "b", findings: [{ path: "src/x.ts", message: "m" }] }));
    board.post(msg("engine", "tool.used", { capability: "scan", version: "1", by: "a" }));
    expect(board.state.pushes).toBe(2);
    expect(board.state.items.one?.lastPush).toMatchObject({ commit: "c2" });
    expect(board.state.tools.published[0]?.uses).toBe(2);
    expect(Object.keys(board.state)).not.toContain("toolUses");
  });
});

describe("scope, protected paths, and push containment", () => {
  /** A board whose goal protects the gate's files, with items scoped to src/. */
  function guarded(): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protected: ["package.json", "gate/", "gate/gate.test.mjs"] }));
    for (const agent of ["a", "b"]) {
      board.post(msg(agent, "agent.joined"));
    }
    board.post(msg("human", "item.proposed", { item: "one", objective: "fix a", scopeHint: ["src/a/**"] }));
    board.post(msg("human", "item.proposed", { item: "wide", objective: "anything", scopeHint: ["**"] }));
    board.post(msg("human", "item.proposed", { item: "bare", objective: "no scope" }));
    return board;
  }

  it("records the protected set from goal.posted and shows it in every digest", () => {
    const board = guarded();
    expect(board.state.protected).toEqual(["package.json", "gate/**", "gate/gate.test.mjs"]);
    expect(boardDigest(board.state, board.log, "a", 0).protected).toEqual(board.state.protected);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("refuses a write intent outside the item's scope hint, and any claim on an unscoped item", () => {
    const board = guarded();
    board.reject(claim("a", "one", ["src/b/x.ts"]), /outside item one's scope hint/, "OUTSIDE_SCOPE");
    board.reject(claim("a", "one", ["src/**"]), /outside item one's scope hint/, "OUTSIDE_SCOPE");
    board.reject(claim("a", "bare", ["src/a/x.ts"]), /declares no scope hint/, "OUTSIDE_SCOPE");
    expect(board.types(claim("a", "one", ["src/a/x.ts"], ["gate/gate.test.mjs"]))).toEqual(["item.claimed", "claim.granted"]);
  });

  it("refuses any write intent that could name a protected path, even inside a wide scope", () => {
    const board = guarded();
    board.reject(claim("b", "wide", ["gate/gate.test.mjs"]), /overlaps protected path\(s\).*contract change/, "PROTECTED");
    board.reject(claim("b", "wide", ["package.json"]), /protected path/, "PROTECTED");
    board.reject(claim("b", "wide", ["**"]), /protected path/, "PROTECTED");
    board.reject(claim("b", "wide", ["*.json"]), /protected path/, "PROTECTED");
    expect(board.types(claim("b", "wide", ["lib/**"]))).toEqual(["item.claimed", "claim.granted"]);
  });

  it("items may be scoped over protected paths (claims enforce them); split children stay inside the parent", () => {
    const board = guarded();
    expect(board.types(msg("human", "item.proposed", { item: "g", objective: "o", scopeHint: ["gate/**"] }))).toEqual(["item.proposed"]);
    board.reject(claim("a", "g", ["gate/**"]), /contract change/, "PROTECTED");
    board.post(claim("a", "one", ["src/a/**"]));
    board.reject(
      msg("a", "item.split", { item: "one", children: [{ item: "c1", objective: "o", scopeHint: ["src/b/**"] }] }),
      /outside item one's scope hint/,
      "OUTSIDE_SCOPE",
    );
    expect(
      board.types(msg("a", "item.split", { item: "one", children: [{ item: "c1", objective: "o", scopeHint: ["src/a/x.ts"] }] })),
    ).toEqual(["item.split"]);
  });

  it("a contract on the original tests is bounded, escalated to a HUMAN, and releases only its path for its item", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protected: ["package.json", "gate/gate.test.mjs", "gate/other.test.mjs"] }));
    board.post(msg("a", "agent.joined"));
    board.post(msg("b", "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("human", "item.proposed", { item: "g", objective: "update the gate test", scopeHint: ["gate/**"] }));
    board.post(msg("human", "item.proposed", { item: "h", objective: "other", scopeHint: ["gate/**"] }));
    board.post(msg("human", "item.proposed", { item: "s", objective: "src only", scopeHint: ["src/**"] }));
    board.reject(claim("a", "g", ["gate/gate.test.mjs"]), /contract change/, "PROTECTED");
    // Bounded: one concrete contract path, named for an item whose scope holds it.
    board.reject(msg("a", "contract.proposed", { contract: "k0", target: "gate/**", kind: "modify", item: "g" }), /one concrete path/, "NOT_ALLOWED");
    board.reject(msg("a", "contract.proposed", { contract: "k0", target: "gate/gate.test.mjs", kind: "modify" }), /must name the item/, "NOT_ALLOWED");
    board.reject(msg("a", "contract.proposed", { contract: "k0", target: "gate/gate.test.mjs", kind: "modify", item: "s" }), /outside item s's scope/, "OUTSIDE_SCOPE");
    const proposed = board.post(msg("a", "contract.proposed", { contract: "k1", target: "gate/gate.test.mjs", kind: "modify", item: "g" }));
    expect(proposed.map((m) => m.type)).toEqual(["contract.proposed", "contract.escalated"]);
    const [request] = boardEscalationRequests(proposed);
    expect(request).toMatchObject({ kind: "decision", path: "gate/gate.test.mjs", options: ["accept", "reject"], boardContract: "k1" });
    // The lead cannot decide it, however it is asked.
    board.reject(msg("lead", "contract.accepted", { contract: "k1" }), /only a human decides it/, "NOT_ALLOWED");
    expect(() => boardContractDecision(board.state, "k1", "maybe")).toThrow(/accept or reject/);
    board.post(boardContractDecision(board.state, "k1", " Accept ")!);
    expect(boardContractDecision(board.state, "k1", "accept")).toBeUndefined();
    board.reject(claim("b", "h", ["gate/gate.test.mjs"]), /contract change/, "PROTECTED"); // another item
    board.reject(claim("a", "g", ["gate/**"]), /gate\/other\.test\.mjs/, "PROTECTED"); // wider than released
    expect(board.types(claim("a", "g", ["gate/gate.test.mjs"]))).toEqual(["item.claimed", "claim.granted"]);
    expect(boardDigest(board.state, board.log, "a", 0).released).toEqual(["gate/gate.test.mjs"]);
    // A contract on a non-protected path stays the lead's to decide.
    board.post(msg("b", "contract.proposed", { contract: "k2", target: "src/api.ts", kind: "modify" }));
    expect(board.types(msg("lead", "contract.accepted", { contract: "k2" }))).toEqual(["contract.accepted"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("after a human rejects a contract for an item, asking again is refused until a failing revision implicates it", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protected: ["tests/a.test.ts", "tests/b.test.ts"] }));
    board.post(msg("a", "agent.joined"));
    board.post(msg("b", "agent.joined"));
    board.post(msg("human", "item.proposed", { item: "t", objective: "o", scopeHint: ["tests/**"] }));
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "tests/a.test.ts", kind: "modify", item: "t" }));
    board.post(msg("human", "contract.rejected", { contract: "k1" }));
    board.reject(msg("b", "contract.proposed", { contract: "k2", target: "tests/b.test.ts", kind: "modify", item: "t" }), /human rejected a contract change for item t/, "CONTRACT_REJECTED");
    // New evidence: a failing revision implicates the item.
    board.post(claim("a", "t", ["tests/new.test.ts"]));
    board.post(push("a", "t", "c1", ["tests/new.test.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], failing: { output: "x", items: ["t"] } }));
    expect(board.types(msg("b", "contract.proposed", { contract: "k2", target: "tests/b.test.ts", kind: "modify", item: "t" }))).toEqual([
      "contract.proposed",
      "contract.escalated",
    ]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("closes a contract escalation when the contract is decided", () => {
    const appended = [
      { seq: 1, at: AT, from: "engine", type: "contract.escalated", payload: { contract: "k1", item: "g", target: "t.test.ts", kind: "modify" } },
    ] as BoardMessage[];
    const raised = applyBoardEscalations([], appended, 0);
    expect(raised.list).toMatchObject([{ status: "pending", boardContract: "k1" }]);
    const closed = applyBoardEscalations(raised.list, [{ seq: 2, at: AT, from: "human", type: "contract.rejected", payload: { contract: "k1" } }] as BoardMessage[], 1);
    expect(closed.list).toMatchObject([{ status: "resolved", decision: "reject" }]);
  });

  it("refuses pushes into dependency or tool trees, and records the goal's test inventory", () => {
    const board = new TestBoard();
    board.reject(msg("human", "goal.posted", { objective: "o", testInventory: { status: "recorded", count: 2, names: ["a"] } }), /only status, format, count/, "BAD_PAYLOAD");
    board.post(msg("human", "goal.posted", { objective: "o", testInventory: { status: "recorded", format: "tap", count: 2 } }));
    expect(board.state.testInventory).toEqual({ status: "recorded", format: "tap", count: 2 });
    board.post(msg("a", "agent.joined"));
    board.post(msg("human", "item.proposed", { item: "x", objective: "o", scopeHint: ["**"] }));
    board.post(claim("a", "x", ["**"]));
    board.reject(push("a", "x", "c1", ["node_modules/x/index.js"]), /dependency or tool trees/, "PROTECTED");
    board.reject(push("a", "x", "c1", ["tools/.bin/run"]), /dependency or tool trees/, "PROTECTED");
    expect(board.types(push("a", "x", "c1", ["src/a.ts"]))).toEqual(["push.announced"]);
  });

  it("records the gate's protected keys with the goal for display", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protectedKeys: ['package.json scripts["gate"]'] }));
    expect(board.state.protectedKeys).toEqual(['package.json scripts["gate"]']);
  });

  it("a pushed path must be a concrete file inside the write intent", () => {
    const board = guarded();
    board.post(claim("a", "one", ["src/a/x.ts#run", "src/a/y/*.ts"]));
    board.reject(push("a", "one", "c1", ["src/a/*.ts"]), /concrete file paths/, "BAD_PAYLOAD");
    board.reject(push("a", "one", "c1", ["src/a/y/deep/z.ts"]), /outside the claim's write intent/, "OUTSIDE_INTENT");
    board.reject(push("a", "one", "c1", ["gate/gate.test.mjs"]), /outside the claim's write intent/, "OUTSIDE_INTENT");
    expect(board.types(push("a", "one", "c1", ["src/a/x.ts", "src/a/y/z.ts"]))).toEqual(["push.announced"]);
  });
});

describe("the fix loop: failing evidence and fix requests", () => {
  const failing = (merged: string[], items: string[], output = "FAIL src/a/x.ts", commit = "rev") =>
    msg("engine", "integrated.rev", { commit, gate: "fail", merged, failing: { output, items } });

  it("a failing revision carries bounded evidence and asks the implicated owner (to) for a fix", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/b/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    board.post(push("b", "two", "c2", ["src/b/y.ts"]));
    const appended = board.post(failing(["c1", "c2"], ["one"], "FAIL src/a/x.ts", "r1"));
    expect(appended.map((m) => m.type)).toEqual(["integrated.rev", "fix.requested"]);
    expect(appended[1]).toMatchObject({ from: "engine", to: ["a"], payload: { item: "one", n: 1, attempt: 1 } });
    expect(board.state.lastFailure).toEqual({ n: 1, output: "FAIL src/a/x.ts", items: ["one"] });
    expect(board.state.items.one).toMatchObject({ fixAttempts: 1, fixRequested: 1 });
    // Only the implicated owner's digest carries the failure.
    const digestA = boardDigest(board.state, board.log, "a", 0);
    expect(digestA.failure).toEqual({ n: 1, output: "FAIL src/a/x.ts", items: ["one"] });
    expect(digestA.claims[0]).toMatchObject({ item: "one", fix: { n: 1, attempt: 1 } });
    expect(boardDigest(board.state, board.log, "b", 0).failure).toBeNull();
    // The owner's next push answers the request; nothing completes on a fail.
    board.post(push("a", "one", "c3", ["src/a/x.ts"]));
    expect(board.state.items.one?.fixRequested).toBeUndefined();
    expect(board.state.passingRevs).toEqual([]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("counts attempts per item; past the budget it records exhaustion and reopens the item for ANOTHER agent", () => {
    const board = seeded({ maxFixAttempts: 1 });
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    expect(board.post(failing(["c1"], ["one"], "x", "r1")).map((m) => m.type)).toEqual(["integrated.rev", "fix.requested"]);
    board.post(push("a", "one", "c2", ["src/a/x.ts"]));
    const second = board.post(failing(["c2"], ["one"], "x", "r2"));
    expect(second.map((m) => m.type)).toEqual(["integrated.rev", "fix.exhausted", "item.reopened"]);
    expect(second[1]?.payload).toEqual({ item: "one", n: 2, attempts: 1 });
    expect(second[2]?.payload).toEqual({ item: "one", previousOwner: "a", commit: "c2", n: 2 });
    expect(board.state.items.one).toMatchObject({ status: "open", exhaustedBy: ["a"], reopenedFrom: { agent: "a", commit: "c2" }, fixAttempts: 0 });
    expect(board.state.items.one?.owner).toBeUndefined();
    // The agent that spent the budget cannot take it back; a fresh one can.
    board.reject(claim("a", "one", ["src/a/**"]), /already spent item one's fix budget/, "NOT_ALLOWED");
    expect(board.types(claim("b", "one", ["src/a/**"]))).toEqual(["item.claimed", "claim.granted"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("refuses evidence on a passing revision, implicated items the revision did not merge, and oversized output", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    board.reject(msg("engine", "integrated.rev", { commit: "r", gate: "pass", merged: ["c1"], failing: { output: "", items: [] } }), /only a failing revision/, "BAD_PAYLOAD");
    board.reject(failing(["c1"], ["two"]), /had no push in this revision/, "UNKNOWN_REF");
    board.reject(failing(["c1"], ["one"], "x".repeat(BOARD_LIMITS.maxFailingOutput + 1)), /at most 8192/, "BAD_PAYLOAD");
    board.reject(msg("engine", "integrated.rev", { commit: "r", gate: "fail", merged: ["c1"], extra: 1 }), /unknown field/, "BAD_PAYLOAD");
  });

  it("replay rejects a forged fix request (only arbitration produces one)", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    board.post(failing(["c1"], ["one"]));
    const forged = board.log.map((m) =>
      m.type === "fix.requested" ? ({ ...m, payload: { ...m.payload, attempt: 2 } } as BoardMessage) : m,
    );
    expect(() => reduceBoard(forged)).toThrow(/not produced by arbitration|does not match arbitration/);
  });
});

describe("advisory decisions", () => {
  it("records each typed decision and its outcome (an error too) without touching arbitration", () => {
    const board = seeded();
    const before = JSON.stringify({ ...board.state, lastSeq: 0, decisions: null });
    board.post(msg("engine", "decision.recorded", { juncture: "plan-review", question: "covers the goal?", answer: "yes", confidence: 0.9, accepted: true }));
    board.post(msg("engine", "decision.recorded", { juncture: "attribution", question: "which item?", accepted: false, error: "HTTP 400: expected record, received array" }));
    expect(board.state.decisions).toEqual({ calls: 2, accepted: 1, errors: 1 });
    expect(JSON.stringify({ ...board.state, lastSeq: 0, decisions: null })).toBe(before);
    board.reject(msg("engine", "decision.recorded", { juncture: "plan-review", question: "q", accepted: true, extra: 1 }), /unknown field/, "BAD_PAYLOAD");
    board.reject(msg("a", "decision.recorded", { juncture: "plan-review", question: "q", accepted: true }), /cannot be sent by an agent/, "NOT_ALLOWED");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("a revision no gate checked", () => {
  it("is recorded explicitly as ungated (only for a pass), and replays", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/one.ts"]));
    board.post(push("a", "one", "c1", ["src/one.ts"]));
    board.reject(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], gated: false }), /no gate failed/, "BAD_PAYLOAD");
    board.reject(msg("engine", "integrated.rev", { commit: "r1", gate: "pass", merged: ["c1"], gated: true }), /must be false/, "BAD_PAYLOAD");
    const [rev] = board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "pass", merged: ["c1"], gated: false }));
    expect(rev!.payload).toMatchObject({ n: 1, gate: "pass", gated: false });
    expect(reduceBoard(board.log)).toEqual(board.state);
    // Absent means a gate ran.
    board.post(push("a", "one", "c2", ["src/one.ts"]));
    expect(board.post(rev ? msg("engine", "integrated.rev", { commit: "r2", gate: "pass", merged: ["c2"] }) : {})[0]!.payload).not.toHaveProperty("gated");
  });
});

describe("attribution outcomes (advisory, derived mechanically)", () => {
  /** a holds one (src/one.ts), b holds two (src/two.ts); both pushed; revision 1 failed. */
  function failedOnce(): TestBoard {
    const board = seeded();
    board.post(claim("a", "one", ["src/one.ts"]));
    board.post(claim("b", "two", ["src/two.ts"]));
    board.post(push("a", "one", "c1", ["src/one.ts"]));
    board.post(push("b", "two", "c2", ["src/two.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1", "c2"], failing: { output: "FAIL", items: ["one", "two"] } }));
    return board;
  }
  const attribution = (answer: string, rev: number, parsed: string[], extra: Record<string, unknown> = {}) =>
    msg("engine", "decision.recorded", { juncture: "attribution", question: "which item?", answer, confidence: 0.9, accepted: true, rev, parsed, ...extra });

  it("places the pick in the fixed set when its item changed before the next passing revision; places the parse alongside", () => {
    const board = failedOnce();
    const [decision] = board.post(attribution("one", 1, ["two"]));
    expect(board.state.attribution.open).toHaveLength(1);
    // Only one's owner pushes again; two's earlier push is merged unchanged.
    board.post(push("a", "one", "c3", ["src/one.ts"]));
    const appended = board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "pass", merged: ["c3", "c2"] }));
    const resolved = appended.find((m) => m.type === "decision.resolved");
    expect(resolved).toMatchObject({
      from: "engine",
      inReplyTo: appended[0]!.seq,
      payload: { decisionSeq: decision!.seq, rev: 1, passed: 2, answer: "one", outcome: "in-fixed-set", fixed: ["one"], parsed: ["two"], parseOutcome: "not-in-fixed-set" },
    });
    // The pick differed from the parse, and only the pick landed in the fixed set.
    expect(boardAttributionTally(board.state)).toEqual({
      decisions: 1,
      inFixedSet: 1,
      notInFixedSet: 0,
      unresolved: 0,
      parse: { inFixedSet: 0, notInFixedSet: 1, none: 0, extra: 1 },
      differed: { total: 1, pickOnly: 1, parseOnly: 0, both: 0, neither: 0 },
    });
    // Advisory only: the decisions changed nothing but their own counts.
    expect(board.state.items.one!.status).toBe("claimed");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("places a pick outside the fixed set, counts changes across a failing revision in between, and leaves a later one unresolved", () => {
    const board = failedOnce();
    board.post(attribution("two", 1, []));
    board.post(push("a", "one", "c3", ["src/one.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c3", "c2"], failing: { output: "FAIL", items: ["one"] } }));
    board.post(attribution("one", 2, ["one"]));
    board.post(push("a", "one", "c4", ["src/one.ts"]));
    const appended = board.post(msg("engine", "integrated.rev", { commit: "r3", gate: "pass", merged: ["c4", "c2"] }));
    expect(appended.filter((m) => m.type === "decision.resolved").map((m) => m.payload)).toEqual([
      { decisionSeq: expect.any(Number), rev: 1, passed: 3, answer: "two", outcome: "not-in-fixed-set", fixed: ["one"], parsed: [], parseOutcome: "none" },
      { decisionSeq: expect.any(Number), rev: 2, passed: 3, answer: "one", outcome: "in-fixed-set", fixed: ["one"], parsed: ["one"], parseOutcome: "in-fixed-set" },
    ]);
    // A later failure with no passing revision after it stays unresolved.
    board.post(push("b", "two", "c5", ["src/two.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r4", gate: "fail", merged: ["c5"], failing: { output: "FAIL", items: ["two"] } }));
    board.post(attribution("two", 4, ["two"]));
    const tally = boardAttributionTally(board.state);
    // Neither resolved pick differed from its parse (one parse attributed nothing, one agreed).
    expect(tally).toEqual({
      decisions: 3,
      inFixedSet: 1,
      notInFixedSet: 1,
      unresolved: 1,
      parse: { inFixedSet: 1, notInFixedSet: 0, none: 1, extra: 0 },
      differed: { total: 0, pickOnly: 0, parseOnly: 0, both: 0, neither: 0 },
    });
    expect(formatAttributionTally(tally)).toBe(
      "jev attribution: 3 decision(s); pick among items changed before the next pass: 1, not: 1, unresolved: 1 " +
        "(not a controlled accuracy measure: the items asked to fix tend to change; parse among them: 1, not: 0, unattributed: 1, extra item(s): 0; " +
        "pick differed from parse: 0 (pick only: 0, parse only: 0, both: 0, neither: 0), biased toward whichever was asked to fix)",
    );
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("refuses an attribution that is not about the latest failing revision, and a forged outcome on replay", () => {
    const board = failedOnce();
    board.reject(attribution("one", 2, []), /not the latest failing revision/, "INVALID_STATE");
    board.reject(attribution("ghost", 1, []), /unknown item/, "UNKNOWN_REF");
    board.reject(msg("engine", "decision.recorded", { juncture: "plan-review", question: "q", accepted: true, rev: 1 }), /attribution decision/, "BAD_PAYLOAD");
    board.post(attribution("two", 1, ["one"]));
    board.post(push("a", "one", "c3", ["src/one.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "pass", merged: ["c3", "c2"] }));
    board.reject(attribution("one", 2, []), /not the latest failing revision/, "INVALID_STATE");
    const forged = board.log.map((m) =>
      m.type === "decision.resolved" ? ({ ...m, payload: { ...m.payload, outcome: "in-fixed-set" } } as BoardMessage) : m,
    );
    expect(() => reduceBoard(forged)).toThrow(/not produced by arbitration|does not match arbitration/);
    // An unresolved, unanswered (error) attribution is never tracked.
    expect(boardAttributionTally(board.state).decisions).toBe(1);
  });

  it("a board stored before outcomes existed refuses to link an older revision, then tracks new ones", () => {
    const board = failedOnce();
    const legacy = { ...board.state } as Partial<BoardState>;
    delete legacy.attribution;
    board.state = legacy as BoardState;
    // No record of what revision 1 merged: linking is refused (the run records it unlinked).
    board.reject(attribution("one", 1, []), /predates attribution outcomes/, "INVALID_STATE");
    // The next revisions are tracked, and a decision about them resolves.
    board.post(push("a", "one", "c3", ["src/one.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c3", "c2"], failing: { output: "FAIL", items: ["one"] } }));
    board.post(attribution("one", 2, ["one"]));
    expect(board.state.attribution.open).toHaveLength(1);
    board.post(push("a", "one", "c4", ["src/one.ts"]));
    expect(board.post(msg("engine", "integrated.rev", { commit: "r3", gate: "pass", merged: ["c4", "c2"] })).map((m) => m.type)).toContain("decision.resolved");
  });
});

describe("contract triage (advisory)", () => {
  function escalated(): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protected: ["tests/a.test.ts"] }));
    board.post(msg("a", "agent.joined"));
    board.post(msg("human", "item.proposed", { item: "t", objective: "o", scopeHint: ["tests/**"] }));
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "tests/a.test.ts", kind: "modify", item: "t" }));
    return board;
  }
  const triage = (extra: Record<string, unknown>) =>
    msg("engine", "decision.recorded", { juncture: "contract-triage", question: "needed?", contract: "k1", ...extra });

  it("records a triage linked to its protected contract and shows it on the pending escalation, which stays pending", () => {
    const board = escalated();
    const raised = applyBoardEscalations([], board.log, 0);
    expect(raised.list).toMatchObject([{ status: "pending", boardContract: "k1" }]);
    const appended = board.post(triage({ answer: "reject", confidence: 0.86, accepted: true }));
    const shown = applyBoardEscalations(raised.list, appended, 1);
    expect(shown.list[0]).toMatchObject({ status: "pending", recommendation: "reject (confidence 0.86)" });
    expect(shown.list[0]!.question).toMatch(/Accept or reject\?\nAdvisory triage \(a typed decision; the human decides\): reject \(confidence 0\.86\)$/);
    // A later triage replaces the line; an error shows "no recommendation (reason)".
    const again = applyBoardEscalations(shown.list, board.post(triage({ accepted: false, error: "HTTP 500: upstream" })), 2);
    expect(again.list[0]!.recommendation).toBe("no recommendation (HTTP 500: upstream)");
    expect(again.list[0]!.question.match(/Advisory triage/g)).toHaveLength(1);
    // The contract is still undecided: only the human decides it.
    expect(board.state.contracts.k1!.status).toBe("proposed");
    expect(board.state.decisions).toEqual({ calls: 2, accepted: 1, errors: 1 });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("states low confidence as no recommendation, and refuses a triage without a protected contract", () => {
    const board = escalated();
    const low = board.post(triage({ answer: "accept", confidence: 0.55, accepted: false }))[0]!;
    const shown = applyBoardEscalations(applyBoardEscalations([], board.log.slice(0, -1), 0).list, [low], 1);
    expect(shown.list[0]!.recommendation).toBe("no recommendation (low confidence: leaning accept (confidence 0.55))");
    board.reject(triage({ contract: "nope", accepted: false }), /unknown contract/, "UNKNOWN_REF");
    board.reject(msg("engine", "decision.recorded", { juncture: "contract-triage", question: "q", accepted: false }), /names its contract/, "BAD_PAYLOAD");
    board.reject(msg("engine", "decision.recorded", { juncture: "plan-review", question: "q", accepted: false, contract: "k1" }), /contract-triage/, "BAD_PAYLOAD");
  });
});

describe("tool registry: agents build tools for each other", () => {
  const checks = (passed: boolean) => [
    { check: "tests", passed: true, detail: "its own tests passed" },
    { check: "finds", passed, detail: passed ? "2 finding(s) on the baseline" : "found nothing on the baseline" },
  ];
  const gated = (capability: string, commit: string, passed: boolean) =>
    msg("engine", "tool.gated", { capability, commit, passed, checks: checks(passed), repo: "change--tools", usage: `node tools/${capability}/run.mjs` });

  it("a worker's tool proposal becomes a tool item the lead must accept before anyone can claim it", () => {
    const board = seeded();
    board.reject(msg("a", "tool.proposed", { tool: "t1", capability: "scan-add", kind: "scanner" }), /needs a rationale/, "BAD_PAYLOAD");
    board.reject(msg("a", "tool.proposed", { tool: "t1", capability: "fix", kind: "codemod" }, { rationale: "r" }), /must declare its inputs/, "BAD_PAYLOAD");
    board.post(msg("a", "tool.proposed", { tool: "t1", capability: "scan-add", kind: "scanner", inputs: ["src/**"], outputs: ["findings"] }, { rationale: "the same change repeats in many files" }));
    expect(board.state.items["tool-scan-add"]).toMatchObject({ status: "proposed", scopeHint: ["tools/scan-add/**"], tool: { capability: "scan-add", kind: "scanner" } });
    board.reject(msg("b", "tool.proposed", { tool: "t2", capability: "scan-add", kind: "scanner" }, { rationale: "r" }), /already proposed/, "DUPLICATE");
    board.reject(claim("a", "tool-scan-add", ["tools/scan-add/**"]), /is proposed and cannot be claimed/, "ITEM_NOT_OPEN");
    board.post(msg("lead", "item.accepted", { item: "tool-scan-add" }));
    // One writer per tool path: only inside tools/<capability>/.
    board.reject(claim("a", "tool-scan-add", ["tools/**"]), /outside item tool-scan-add's scope/, "OUTSIDE_SCOPE");
    expect(board.types(claim("a", "tool-scan-add", ["tools/scan-add/**"]))).toEqual(["item.claimed", "claim.granted"]);
    board.reject(claim("b", "tool-scan-add", ["tools/scan-add/**"]), /cannot be claimed/, "ITEM_NOT_OPEN");
    // A tool item is never pushed for integration: it is built.
    board.reject(push("a", "tool-scan-add", "b1", ["tools/scan-add/run.mjs"]), /announce its build with tool.built/, "NOT_ALLOWED");
  });

  it("only a build that passed its own gate is published (by the engine), as the next version, and completes the tool item", () => {
    const board = seeded();
    claimedTool(board, "a", "scan", "scanner");
    // Builds stay inside the tool item's write intent; only its owner builds.
    board.reject(msg("a", "tool.built", { capability: "scan", commit: "b0", paths: ["src/a.ts"] }), /outside the tool item's write intent/, "OUTSIDE_INTENT");
    board.reject(msg("b", "tool.built", { capability: "scan", commit: "b0", paths: ["tools/scan/run.mjs"] }), /does not hold the claim/, "NOT_OWNER");
    board.post(msg("a", "tool.built", { capability: "scan", commit: "b1", paths: ["tools/scan/run.mjs", "tools/scan/test.mjs"] }));
    board.reject(msg("a", "tool.built", { capability: "scan", commit: "b2", paths: ["tools/scan/run.mjs"] }), /has not been gated yet/, "INVALID_STATE");
    // Agents can never claim a pass, publish, or record a use themselves.
    board.reject(msg("a", "tool.gated", { capability: "scan", commit: "b1", passed: true, checks: checks(true), repo: "r", usage: "u" }), /cannot be sent by an agent/, "NOT_ALLOWED");
    board.reject(
      msg("a", "tool.published", { tool: "t-scan", capability: "scan", version: "1", repo: "r", commit: "b1", verified: true, kind: "scanner", usage: "u" }),
      /cannot be sent by an agent/,
      "NOT_ALLOWED",
    );
    // The gate's verdict must match its checks, and must be about the latest build.
    board.reject(msg("engine", "tool.gated", { capability: "scan", commit: "b1", passed: true, checks: checks(false), repo: "r", usage: "u" }), /every one of its checks/, "BAD_PAYLOAD");
    board.reject(gated("scan", "zz", true), /not the latest, ungated build/, "INVALID_STATE");
    // A failing tool gate publishes nothing; the builder is told.
    const failed = board.post(gated("scan", "b1", false));
    expect(failed.map((m) => m.type)).toEqual(["tool.gated"]);
    expect(failed[0]!.to).toEqual(["a"]);
    expect(board.state.tools.published).toEqual([]);
    expect(board.state.items["tool-scan"]).toMatchObject({ status: "claimed", toolBuild: { commit: "b1", gated: true, passed: false } });
    board.reject(msg("engine", "tool.used", { capability: "scan", version: "1", by: "b" }), /not a published tool version/, "UNKNOWN_REF");
    // A rebuild that passes is published as version 1 and completes the tool item.
    board.post(msg("a", "tool.built", { capability: "scan", commit: "b2", paths: ["tools/scan/run.mjs"] }));
    const passed = board.post(gated("scan", "b2", true));
    expect(passed.map((m) => m.type)).toEqual(["tool.gated", "tool.published", "item.completed"]);
    expect(passed[1]!.payload).toEqual({
      tool: "t-scan",
      capability: "scan",
      version: "1",
      repo: "change--tools",
      commit: "b2",
      verified: true,
      kind: "scanner",
      usage: "node tools/scan/run.mjs",
    });
    expect(passed[2]!.payload).toEqual({ item: "tool-scan", via: "tool", version: "1" });
    expect(board.state.tools.published[0]).toMatchObject({ publishedBy: "a", gateSeq: passed[0]!.seq, uses: 0 });
    expect(board.state.tools.proposed["t-scan"]).toMatchObject({ builds: 2, failedGates: 1 });
    // A tool item is not part of the Change's deliverable.
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a check tool is published with joinsGate: false (it never joins the Change's gate in this slice)", () => {
    const board = seeded();
    const appended = publishTool(board, "a", "no-legacy", "check");
    expect(appended.find((m) => m.type === "tool.published")!.payload).toMatchObject({ kind: "check", joinsGate: false });
  });

  it("use records are the engine's only, pin a published version, and a use that changed files must be the consumer's own push inside its write intent", () => {
    const board = seeded();
    publishTool(board, "c", "fix-add", "codemod");
    board.post(claim("b", "one", ["src/b/**"]));
    board.post(push("b", "one", "p1", ["src/b/x.ts"]));
    const use = (payload: Record<string, unknown>) => msg("engine", "tool.used", { capability: "fix-add", version: "1", by: "b", ...payload });
    // An agent can never record a use (it cannot fake one).
    board.reject(msg("b", "tool.used", { capability: "fix-add", version: "1", by: "b" }), /cannot be sent by an agent/, "NOT_ALLOWED");
    board.reject(use({ version: "2" }), /not a published tool version/, "UNKNOWN_REF");
    board.reject(use({ by: "zed" }), /not a joined agent/, "UNKNOWN_AGENT");
    board.reject(use({ item: "two" }), /does not hold the claim/, "NOT_OWNER");
    board.reject(use({ item: "one", changedFiles: ["src/b/x.ts"] }), /names the item and the pushed commit/, "BAD_PAYLOAD");
    board.reject(use({ item: "one", commit: "other", changedFiles: ["src/b/x.ts"] }), /not b's latest push/, "INVALID_STATE");
    board.reject(use({ item: "one", commit: "p1", changedFiles: ["src/a/y.ts"] }), /outside item one's write intent/, "OUTSIDE_INTENT");
    const used = board.post(use({ item: "one", commit: "p1", changedFiles: ["src/b/x.ts"] }));
    // Addressed to the builder, so its findings can become work.
    expect(used[0]).toMatchObject({ from: "engine", type: "tool.used", to: ["c"] });
    expect(board.state.tools.published[0]!.uses).toBe(1);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("work from a scanner's findings is proposed by the scanner's builder only, citing a published version, and waits for the lead", () => {
    const board = seeded();
    publishTool(board, "a", "scan-add", "scanner");
    board.post(msg("engine", "tool.used", { capability: "scan-add", version: "1", by: "b", findings: [{ path: "lib/x.ts", line: 4, message: "needs the change" }] }));
    const proposal = (from: string, fromTool: Record<string, unknown>) =>
      msg(from, "item.proposed", { item: `${from}-found-1`, objective: "apply the change in lib/x.ts", acceptance: [], scopeHint: ["lib/x.ts"], fromTool });
    board.reject(proposal("b", { capability: "scan-add", version: "1" }), /only a, who built scan-add/, "NOT_ALLOWED");
    board.reject(proposal("a", { capability: "scan-add", version: "9" }), /not a published tool version/, "UNKNOWN_REF");
    board.post(proposal("a", { capability: "scan-add", version: "1" }));
    expect(board.state.items["a-found-1"]).toMatchObject({ status: "proposed", fromTool: { capability: "scan-add", version: "1" } });
    board.reject(claim("b", "a-found-1", ["lib/x.ts"]), /cannot be claimed/, "ITEM_NOT_OPEN");
    board.post(msg("lead", "item.accepted", { item: "a-found-1" }));
    expect(board.types(claim("b", "a-found-1", ["lib/x.ts"]))).toEqual(["item.claimed", "claim.granted"]);
  });

  it("a tool item whose builds keep failing their own gate reopens for another builder (bounded), who may not be the one who spent it", () => {
    const board = seeded();
    claimedTool(board, "a", "scan", "scanner");
    const fail = (agent: string, commit: string) => {
      board.post(msg(agent, "tool.built", { capability: "scan", commit, paths: ["tools/scan/run.mjs"] }));
      return board.post(gated("scan", commit, false));
    };
    expect(fail("a", "a1").map((m) => m.type)).toEqual(["tool.gated"]);
    const second = fail("a", "a2");
    expect(second.map((m) => m.type)).toEqual(["tool.gated", "item.reopened"]);
    expect(second[1]!.payload).toEqual({ item: "tool-scan", previousOwner: "a", commit: "a2" });
    expect(board.state.items["tool-scan"]).toMatchObject({ status: "open", exhaustedBy: ["a"] });
    board.reject(claim("a", "tool-scan", ["tools/scan/**"]), /already spent item tool-scan/, "NOT_ALLOWED");
    board.post(claim("b", "tool-scan", ["tools/scan/**"]));
    fail("b", "b1");
    expect(fail("b", "b2").map((m) => m.type)).toEqual(["tool.gated", "item.reopened"]);
    board.post(claim("c", "tool-scan", ["tools/scan/**"]));
    fail("c", "c1");
    // Bounded: after two reopenings the last builder keeps it (the tool is unavailable to waiters).
    expect(fail("c", "c2").map((m) => m.type)).toEqual(["tool.gated"]);
    expect(board.state.items["tool-scan"]).toMatchObject({ status: "claimed", owner: "c", exhaustedBy: ["a", "b"] });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("the digest tells a claim which covering tools it must not wait for: rejected, failed its gate, or not published in time", () => {
    const board = seeded();
    board.post(msg("a", "tool.proposed", { tool: "t-fix", capability: "fix", kind: "codemod", inputs: ["src/**"], outputs: ["edits"] }, { rationale: "repeated change" }));
    board.post(msg("lead", "item.accepted", { item: "tool-fix" }));
    board.post(claim("b", "one", ["src/b/**"]));
    const unavailable = () => boardDigest(board.state, [], "b", board.state.lastSeq).claims.find((c) => c.item === "one")?.toolUnavailable;
    expect(unavailable()).toBeUndefined();
    board.post(claim("a", "tool-fix", ["tools/fix/**"]));
    board.post(msg("a", "tool.built", { capability: "fix", commit: "f1", paths: ["tools/fix/run.mjs"] }));
    board.post(gated("fix", "f1", false));
    expect(unavailable()).toEqual([{ capability: "fix", reason: "its own gate failed 1 time(s)" }]);

    const slow = seeded();
    slow.post(msg("a", "tool.proposed", { tool: "t-fix", capability: "fix", kind: "codemod", inputs: ["src/**"], outputs: ["edits"] }, { rationale: "repeated change" }));
    slow.post(claim("b", "one", ["src/b/**"]));
    for (let i = 0; i < 61; i += 1) {
      slow.post(msg("lead", "item.proposed", { item: `filler-${i}`, objective: `filler ${i}`, acceptance: [], scopeHint: [`docs/${i}.md`] }));
    }
    expect(boardDigest(slow.state, [], "b", slow.state.lastSeq).claims[0]!.toolUnavailable).toEqual([
      { capability: "fix", reason: "not published within 60 board messages of its proposal" },
    ]);
    // A claim the tool does not cover is never told about it.
    slow.post(claim("c", "two", ["docs/x.md"]));
    expect(boardDigest(slow.state, [], "c", slow.state.lastSeq).claims[0]!.toolUnavailable).toBeUndefined();
  });

  it("replay rejects a forged publication: tool.published only follows a passing tool.gated", () => {
    const board = seeded();
    publishTool(board, "a", "scan", "scanner");
    const forged = board.log.map((m) => (m.type === "tool.gated" ? { ...m, payload: { ...m.payload, passed: false, checks: checks(false) } } : m)) as BoardMessage[];
    expect(() => reduceBoard(forged)).toThrow(/not produced by arbitration|does not match arbitration/);
  });
});

/** Propose (as `agent`), accept, and claim a tool item. */
function claimedTool(board: TestBoard, agent: string, capability: string, kind: string): void {
  board.post(
    msg(agent, "tool.proposed", { tool: `t-${capability}`, capability, kind, inputs: ["src/**"], outputs: ["findings"] }, { rationale: "a repeated change" }),
  );
  board.post(msg("lead", "item.accepted", { item: `tool-${capability}` }));
  board.post(claim(agent, `tool-${capability}`, [`tools/${capability}/**`]));
}

/** Propose, accept, claim, build, and pass the gate of a tool: it is published as version 1. */
function publishTool(board: TestBoard, agent: string, capability: string, kind: string): BoardMessage[] {
  claimedTool(board, agent, capability, kind);
  board.post(msg(agent, "tool.built", { capability, commit: `build-${capability}`, paths: [`tools/${capability}/run.mjs`] }));
  return board.post(
    msg("engine", "tool.gated", {
      capability,
      commit: `build-${capability}`,
      passed: true,
      checks: [{ check: "tests", passed: true, detail: "passed" }],
      repo: "change--tools",
      usage: `node tools/${capability}/run.mjs`,
    }),
  );
}

describe("replay, fold, and verification", () => {
  function busyBoard(): TestBoard {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"], ["src/shared/**"]));
    board.post(claim("b", "two", ["src/a/x.ts"]));
    board.post(msg("a", "claim.kept", { contest: lastContest(board) }));
    board.post(msg("b", "claim.narrowed", { contest: lastContest(board), write: ["src/a/x.ts"] }));
    board.post(msg("a", "claim.kept", { contest: lastContest(board) }));
    board.post(msg("human", "claim.resolved", { contest: lastContest(board), how: "human-decided", winner: "b" }));
    board.post(claim("c", "three", ["src/shared/**"]));
    board.post(push("c", "three", "c1", ["src/shared/t.ts"]));
    board.post(rev("pass", ["c1"], "r1"));
    return board;
  }

  it("reducing the same log twice yields identical state, equal to the live state", () => {
    const board = busyBoard();
    const first = reduceBoard(board.log);
    const second = reduceBoard(JSON.parse(JSON.stringify(board.log)) as BoardMessage[]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(board.state);
    expect(() => verifyBoard(board.log, board.state)).not.toThrow();
  });

  it("verifyBoard detects a stored state that diverged from its log", () => {
    const board = busyBoard();
    const drifted = JSON.parse(JSON.stringify(board.state)) as BoardState;
    drifted.items.one!.status = "done";
    expect(() => verifyBoard(board.log, drifted)).toThrow(/does not equal the reduction/);
  });

  it("replay rejects a gapped or forged log", () => {
    const log = busyBoard().log;
    expect(() => reduceBoard(log.slice(1))).toThrow(/not contiguous/);
    const forged = log.slice(0, 9);
    forged.push({ ...log[9]!, payload: { item: "one", agent: "b", intent: { read: [], write: ["x"] } } } as BoardMessage);
    expect(() => reduceBoard(forged)).toThrow(/does not match arbitration at seq 10/);
    expect(() => reduceBoard(log.slice(0, 9))).toThrow(/expected claim.granted, found end of log/);
    expect(() => reduceBoard([...log.slice(0, 8), { ...log[9]!, seq: 9 }])).toThrow(/was not produced by arbitration/);
    // Changing the recorded rules changes what arbitration decides.
    const rewritten = log.map((m) =>
      m.type === "goal.posted" ? ({ ...m, payload: { ...m.payload, rules: { maxContestTurns: 1, contestIdleMessages: 25, maxFixAttempts: 2 } } } as BoardMessage) : m,
    );
    expect(() => reduceBoard(rewritten)).toThrow(/does not match arbitration/);
  });

  it("foldBoard replays to any seq without checks, matching reduce at batch boundaries", () => {
    const board = busyBoard();
    for (let k = 1; k <= board.log.length; k += 1) {
      const next = board.log[k];
      const atBoundary = next === undefined || next.from !== "engine" || next.type === "integrated.rev";
      if (atBoundary) {
        expect(foldBoard(board.log, k)).toEqual(reduceBoard(board.log.slice(0, k)));
      }
    }
    // Mid-batch: the claim is recorded but its grant is not applied yet.
    const claimed = board.log.find((m) => m.type === "item.claimed")!;
    expect(foldBoard(board.log, claimed.seq).items.one?.status).toBe("open");
    expect(foldBoard(board.log)).toEqual(board.state);
  });

  it("foldBoard is linear: a long log folds quickly", () => {
    const board = seeded();
    publishTool(board, "a", "scan", "scanner");
    for (let i = 0; i < 3000; i += 1) {
      board.post(msg("engine", "tool.used", { capability: "scan", version: "1", by: i % 2 === 0 ? "b" : "c" }));
    }
    const started = Date.now();
    const folded = foldBoard(board.log);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(folded.tools.published[0]?.uses).toBe(3000);
    expect(folded).toEqual(board.state);
  });

  it("slices messages after a seq and summarizes counts", () => {
    const board = busyBoard();
    expect(boardMessagesAfter(board.log, board.log.length - 2).map((m) => m.seq)).toEqual([board.log.length - 1, board.log.length]);
    expect(summarizeBoard(board.state)).toEqual({
      messages: board.log.length,
      agents: 4,
      items: { proposed: 0, rejected: 0, open: 1, claimed: 2, contested: 0, split: 0, done: 0 },
      contests: { open: 0, escalated: 0, resolved: 1 },
      toolsPublished: 0,
      integratedRev: 1,
    });
  });
});

describe("per-agent digest", () => {
  it("lists my claims, contests, relevant messages, open items, baseline, and rebase target", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/b/**"], ["src/a/**"]));
    board.post(claim("c", "three", ["src/a/x.ts"])); // contests a
    board.post(push("a", "one", "c1", ["src/a/y.ts"]));
    board.post(rev("pass", ["c1"], "r1")); // rebase for b
    board.post(msg("a", "help.requested", { request: "h1", item: "one", need: "review" }, { to: ["c"] }));
    const digestA = boardDigest(board.state, board.log, "a", 0);
    expect(digestA.claims.map((c) => c.item)).toEqual(["one"]);
    expect(digestA.claims[0]?.lastPush).toEqual({ commit: "c1", agent: "a", integratedIn: 1 });
    expect(digestA.contests.map((c) => c.claimant)).toEqual(["c"]);
    expect(digestA.messages.every((m) => m.from !== "a")).toBe(true);
    expect(digestA.messages.map((m) => m.type)).toContain("claim.contested");

    const digestB = boardDigest(board.state, board.log, "b", 12);
    expect(digestB.rebaseTo).toBe(1);
    expect(digestB.after).toBe(12);
    expect(digestB.messages.every((m) => m.seq > 12)).toBe(true);
    expect(digestB.messages.map((m) => m.type)).toEqual(["integrated.rev", "rebase.needed"]);

    const digestC = boardDigest(board.state, board.log, "c", 0);
    expect(digestC.pending).toEqual([{ item: "three", contest: lastContest(board) }]);
    expect(digestC.messages.map((m) => m.type)).toContain("help.requested");
    expect(digestC.openItems).toEqual([]);
    expect(digestC.integrated).toEqual({ n: 1, commit: "r1" });
  });
});

describe("escalation bridge", () => {
  it("turns claim.escalated into a decision escalation and a decision back into a board resolution", () => {
    const board = seeded({ maxContestTurns: 1 });
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/a/x.ts#run"]));
    const contest = lastContest(board);
    const appended = board.post(msg("a", "claim.kept", { contest }));
    const [request] = boardEscalationRequests(appended);
    expect(request).toMatchObject({ kind: "decision", path: "src/a/x.ts", options: ["a", "b"], boardContest: contest });
    expect(request!.question).toContain("after 1 turns");
    expect(() => boardResolutionForDecision(board.state, contest, "c")).toThrow(/must be a or b/);
    expect(() => boardResolutionForDecision(board.state, "nope", "a")).toThrow(/unknown contest/);
    const draft = boardResolutionForDecision(board.state, contest, " b ")!;
    expect(draft).toEqual({ from: "human", type: "claim.resolved", payload: { contest, how: "human-decided", winner: "b" } });
    const resolved = board.post(draft);
    expect([...boardContestClosures(resolved)]).toEqual([[contest, "b"]]);
    expect(boardResolutionForDecision(board.state, contest, "b")).toBeUndefined();
  });
});

describe("scripted agents through the endpoint (join, tokens, routes)", () => {
  interface Scenario {
    readonly responders: readonly { id: string; answer: ContestAnswer }[];
    readonly steps: readonly unknown[];
  }
  const scenarios = JSON.parse(readFileSync(new URL("./fixtures/board-scenarios.json", import.meta.url), "utf8")) as Record<string, Scenario>;

  async function run(name: string) {
    const scenario = scenarios[name]!;
    const endpoint = pureBoardEndpoint(() => AT);
    const result = await runBoardScript(
      { steps: scenario.steps, agents: scenario.responders.map((r) => contestResponder(r.id, r.answer)) },
      endpointPoster(endpoint),
    );
    return { ...result, endpoint };
  }

  it("drives the formation scenario deterministically", async () => {
    const first = await run("formation");
    const second = await run("formation");
    expect(JSON.stringify(first.log)).toBe(JSON.stringify(second.log));
    expect(first.log).toEqual(first.endpoint.log());
    expect(first.rejected.map((r) => r.code)).toEqual(["NOT_ALLOWED", "NOT_ALLOWED", "NOT_ALLOWED"]);
    expect(first.log.filter((m) => m.type === "rebase.needed").map((m) => m.payload)).toEqual([
      { agent: "agent-c", n: 2, paths: ["src/core/errors.ts"] },
    ]);
    expect(first.log.filter((m) => m.type === "claim.resolved").map((m) => (m.payload as { how: string }).how)).toEqual([
      "owner-ceded",
      "owner-released",
    ]);
    expect(first.log.filter((m) => m.type === "item.completed").map((m) => m.payload)).toEqual([
      { item: "errors", n: 2, via: "integrated" },
      { item: "docs-api", n: 3, via: "integrated" },
      { item: "docs-guide", n: 3, via: "integrated" },
      { item: "docs", n: 3, via: "children" },
    ]);
    expect(first.log.find((m) => m.type === "help.offered")?.to).toEqual(["agent-a"]);
    expect(first.board).toEqual(reduceBoard(first.log));
    expect(summarizeBoard(first.board)).toMatchObject({
      items: { proposed: 0, rejected: 1, open: 0, claimed: 1, contested: 0, split: 0, done: 4 },
      toolsPublished: 0,
      integratedRev: 3,
    });
  });

  it("drives the escalation scenario to a human decision", async () => {
    const { log, rejected, board } = await run("escalation");
    expect(rejected).toEqual([]);
    expect(log.filter((m) => m.seq >= 9).map((m) => `${m.from}:${m.type}`)).toEqual([
      "agent-b:item.claimed",
      "engine:claim.contested",
      "agent-a:claim.kept",
      "agent-b:claim.kept",
      "agent-a:claim.kept",
      "engine:claim.escalated",
      "human:claim.resolved",
      "engine:claim.granted",
    ]);
    expect(board.items.two).toMatchObject({ status: "claimed", owner: "agent-b" });
  });

  it("an agent step without a token (never joined) is refused, and a left agent's token stops working", async () => {
    const endpoint = pureBoardEndpoint(() => AT);
    const post = endpointPoster(endpoint);
    await post({ from: "human", type: "goal.posted", payload: { objective: "o" } });
    expect(await post({ from: "x", type: "agent.left" })).toMatchObject({ ok: false, code: "AUTH" });
    const joined = await endpoint.join("x", {});
    expect(joined.ok).toBe(true);
    const token = joined.ok ? joined.token : "";
    expect(await endpoint.postAsAgent(token, { type: "agent.left" })).toMatchObject({ ok: true });
    expect(await endpoint.postAsAgent(token, { type: "item.proposed", payload: { item: "i", objective: "o" } })).toMatchObject({
      ok: false,
      code: "AUTH",
    });
  });
});

describe("help with a granted sub-scope: the helper forks the requester's repo", () => {
  /** a holds item one (src/a/**) and pushed c1; it grants src/a/y.ts under request h1. */
  function granting(): TestBoard {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts", "src/a/y.ts"]));
    board.post(msg("a", "help.requested", { request: "h1", item: "one", need: "parallel-edit", scope: ["src/a/y.ts"] }));
    return board;
  }

  it("a grant must lie inside the requester's write intent and never overlap another live grant", () => {
    const board = granting();
    board.reject(msg("a", "help.requested", { request: "h2", item: "one", need: "x", scope: ["src/b.ts"] }), /outside your write intent/, "OUTSIDE_INTENT");
    board.reject(msg("a", "help.requested", { request: "h2", item: "one", need: "x", scope: ["src/a/**"] }), /overlaps help request h1/, "INTENT_OVERLAP");
    expect(board.state.help.h1).toMatchObject({ scope: ["src/a/y.ts"], by: "a" });
    // Every agent sees a live, untaken grant as work it can offer to fork for.
    expect(boardDigest(board.state, board.log, "b", 0).help?.wanted.map((h) => h.request)).toEqual(["h1"]);
    expect(boardDigest(board.state, board.log, "b", 0).messages.some((m) => m.type === "help.requested")).toBe(true);
  });

  it("the first fork offer from the requester's latest push takes the grant (fork lineage on the board)", () => {
    const board = granting();
    board.reject(msg("b", "help.offered", { request: "h1", forkOf: "c", forkCommit: "c1" }), /forkOf must name the requester a/, "UNKNOWN_REF");
    board.reject(msg("b", "help.offered", { request: "h1", forkOf: "a", forkCommit: "zz" }), /latest announced push \(c1\)/, "INVALID_STATE");
    board.post(msg("b", "help.offered", { request: "h1", forkOf: "a", forkCommit: "c1", fork: "chg--help-h1" }, { to: ["a"] }));
    expect(board.state.help.h1?.grant).toMatchObject({ agent: "b", forkOf: "a", forkCommit: "c1", fork: "chg--help-h1" });
    board.reject(msg("c", "help.offered", { request: "h1", forkOf: "a", forkCommit: "c1" }), /already granted to b/, "DUPLICATE");
    // A plain reply (no fork) is still just an answer.
    expect(board.types(msg("c", "help.offered", { request: "h1" }))).toEqual(["help.offered"]);
    expect(boardDigest(board.state, board.log, "b", 0).help?.granted).toMatchObject([{ request: "h1", by: "a", scope: ["src/a/y.ts"], forkCommit: "c1", live: true }]);
  });

  it("a grant nobody has taken yet blocks nothing: the requester keeps pushing and may propose done", () => {
    const board = granting();
    expect(board.types(push("a", "one", "c2", ["src/a/y.ts"]))).toEqual(["push.announced"]);
    expect(board.types(msg("a", "done.proposed", { item: "one" }))).toEqual(["done.proposed"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("single writer: the requester cannot touch the granted scope or propose done until it pulls the helper's delivered work", () => {
    const board = granting();
    board.post(msg("b", "help.offered", { request: "h1", forkOf: "a", forkCommit: "c1" }));
    board.reject(push("a", "one", "c2", ["src/a/y.ts"]), /granted to b under help request h1/, "INTENT_OVERLAP");
    expect(board.types(push("a", "one", "c2", ["src/a/x.ts"]))).toEqual(["push.announced"]);
    board.reject(msg("a", "done.proposed", { item: "one" }), /help request h1 on one is outstanding/, "INVALID_STATE");
    board.reject(msg("c", "help.delivered", { request: "h1", commit: "f1", paths: ["src/a/y.ts"] }), /does not hold help request h1's grant/, "NOT_ALLOWED");
    board.reject(msg("b", "help.delivered", { request: "h1", commit: "f1", paths: ["src/a/x.ts"] }), /outside the granted scope/, "OUTSIDE_INTENT");
    board.post(msg("b", "help.delivered", { request: "h1", commit: "f1", paths: ["src/a/y.ts"] }, { to: ["a"] }));
    expect(boardDigest(board.state, board.log, "a", 0).help?.mine).toMatchObject([{ request: "h1", grantee: "b", delivered: { commit: "f1", paths: ["src/a/y.ts"] } }]);
    board.reject(msg("a", "push.announced", { item: "one", commit: "c3", paths: ["src/a/y.ts"], pulled: ["nope"] }), /not your help request/, "UNKNOWN_REF");
    board.post(msg("a", "push.announced", { item: "one", commit: "c3", paths: ["src/a/y.ts"], pulled: ["h1"] }));
    expect(board.state.help.h1?.pulledSeq).toBeDefined();
    board.post(msg("a", "done.proposed", { item: "one" }));
    const appended = board.post(rev("pass", ["c3"], "r1"));
    expect(appended.some((m) => m.type === "item.completed" && m.payload.item === "one")).toBe(true);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("never waits forever: an untaken grant lapses after the bounded wait and the requester may write the scope again", () => {
    const board = granting();
    for (let i = 0; i <= BOARD_LIMITS.helpWaitMessages; i += 1) {
      board.post(msg("lead", "item.proposed", { item: `pad-${i}`, objective: "pad", scopeHint: ["pad/**"] }));
    }
    expect(boardDigest(board.state, board.log, "b", 0).help?.wanted ?? []).toEqual([]);
    board.reject(msg("b", "help.offered", { request: "h1", forkOf: "a", forkCommit: "c1" }), /lapsed or closed/, "INVALID_STATE");
    expect(board.types(push("a", "one", "c2", ["src/a/y.ts"]))).toEqual(["push.announced"]);
  });
});

describe("formation hardening: one writer under a split, verified merges, grants that never pin the requester", () => {
  function split(): TestBoard {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(msg("a", "item.split", { item: "one", children: [{ item: "one-x", objective: "x", scopeHint: ["src/a/x.ts"] }] }));
    return board;
  }

  it("a split item stays a live claim of its sub-lead: paths no child covers are never another agent's", () => {
    const board = split();
    // Another item reaching into the split item's scope (src/a/z.ts is no child's) contests the sub-lead.
    expect(board.types(claim("b", "two", ["src/a/z.ts"]))).toEqual(["item.claimed", "claim.contested"]);
    const contest = lastContest(board);
    expect(board.state.contests[contest]).toMatchObject({ owner: "a", ownerItem: "one" });
    board.reject(msg("a", "claim.ceded", { contest }), /sub-lead keeps its scope/, "NOT_ALLOWED");
    board.reject(msg("a", "claim.narrowed", { contest, write: ["src/a/x.ts"] }), /sub-lead does not narrow/, "NOT_ALLOWED");
    board.reject(msg("human", "claim.resolved", { contest, how: "human-decided", winner: "b" }), /stays its sub-lead's/, "NOT_ALLOWED");
    // A claim on its own child is not blocked by it.
    expect(board.types(claim("c", "one-x", ["src/a/x.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    // The sub-lead ships only its merged children's work.
    board.post(push("c", "one-x", "px", ["src/a/x.ts"]));
    board.reject(
      msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/a/x.ts", "src/a/z.ts"], merges: [{ item: "one-x", commit: "px" }] }),
      /outside their write intents/,
      "OUTSIDE_INTENT",
    );
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a sub-lead's unit carries the contract paths released for the children it merges", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protected: ["gate/a.test.ts"] }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("human", "item.proposed", { item: "one", objective: "o", scopeHint: ["gate/**", "src/**"] }));
    board.post(claim("a", "one", ["src/**"]));
    board.post(msg("a", "item.split", { item: "one", children: [{ item: "one-x", objective: "x", scopeHint: ["src/x.ts"] }] }));
    board.post(claim("b", "one-x", ["src/x.ts"]));
    board.post(msg("b", "contract.proposed", { contract: "k1", target: "src/x.ts", kind: "modify", item: "one-x" }));
    board.post(msg("human", "contract.accepted", { contract: "k1" }));
    board.post(push("b", "one-x", "px", ["src/x.ts"]));
    board.post(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/x.ts"], merges: [{ item: "one-x", commit: "px" }] }));
    expect(planBoardIntegration(board.log, board.state).units[0]).toMatchObject({ agent: "a", scope: ["src/x.ts"], releasedPaths: ["src/x.ts"] });
  });

  it("refuses splits when the goal records the cloud integrator, and caps how often one child push is merged", () => {
    const cloud = new TestBoard();
    cloud.post(msg("human", "goal.posted", { objective: "o", integrator: "cloud" }));
    cloud.post(msg("a", "agent.joined"));
    cloud.post(msg("human", "item.proposed", { item: "one", objective: "o", scopeHint: ["src/**"] }));
    cloud.post(claim("a", "one", ["src/**"]));
    cloud.reject(msg("a", "item.split", { item: "one", children: [{ item: "k", objective: "o", scopeHint: ["src/x.ts"] }] }), /splits are not supported/, "NOT_SUPPORTED");
    expect(reduceBoard(cloud.log)).toEqual(cloud.state);

    const board = split();
    board.post(claim("c", "one-x", ["src/a/x.ts"]));
    board.post(push("c", "one-x", "px", ["src/a/x.ts"]));
    for (const commit of ["p1", "p2", "p3"]) {
      board.post(msg("a", "push.announced", { item: "one", commit, paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "px" }] }));
    }
    board.reject(msg("a", "push.announced", { item: "one", commit: "p4", paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "px" }] }), /already merged 3 times/, "LIMIT");
  });

  it("refuses a split while the owner's push on the item is not integrated", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    board.reject(msg("a", "item.split", { item: "one", children: [{ item: "k", objective: "o", scopeHint: ["src/a/y.ts"] }] }), /unintegrated push/, "INVALID_STATE");
    board.post(rev("pass", ["c1"], "r1"));
    expect(board.types(msg("a", "item.split", { item: "one", children: [{ item: "k", objective: "o", scopeHint: ["src/a/y.ts"] }] }))).toEqual(["item.split"]);
  });

  it("a merged child the integrator could not verify in the gated tree is not integrated; the sub-lead must merge it again", () => {
    const board = split();
    board.post(claim("c", "one-x", ["src/a/x.ts"]));
    board.post(push("c", "one-x", "px", ["src/a/x.ts"]));
    board.post(msg("c", "done.proposed", { item: "one-x" }));
    board.post(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "px" }] }));
    board.reject(msg("engine", "integrated.rev", { commit: "r1", gate: "pass", merged: ["pa"], unverified: [{ item: "two", reason: "x" }] }), /no merged sub-lead push merges/, "UNKNOWN_REF");
    const appended = board.post(
      msg("engine", "integrated.rev", { commit: "r1", gate: "pass", merged: ["pa"], unverified: [{ item: "one-x", reason: "src/a/x.ts differs from one-x's push" }] }),
    );
    expect(appended.find((m) => m.type === "integrated.rev")!.payload).toMatchObject({ contributors: ["a"], unverified: [{ item: "one-x" }] });
    expect(appended.some((m) => m.type === "item.completed")).toBe(false);
    expect(board.state.items["one-x"]!.lastPush!.integratedIn).toBeUndefined();
    expect(boardDigest(board.state, board.log, "a", 0).subLead![0]!.children[0]).toMatchObject({ item: "one-x", merged: false, unverified: true });
    // Never re-merged at the same child commit (no loop), and never an empty sub-lead push.
    board.reject(msg("a", "push.announced", { item: "one", commit: "pb", paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "px" }] }), /recorded unverified in revision 1/, "INVALID_STATE");
    // The child pushes again; that push is merged (and verified): both complete.
    board.post(push("c", "one-x", "px2", ["src/a/x.ts"]));
    board.reject(msg("a", "push.announced", { item: "one", commit: "pb", paths: [], merges: [{ item: "one-x", commit: "px2" }] }), /empty push merges nothing/, "NOT_ALLOWED");
    board.post(msg("a", "push.announced", { item: "one", commit: "pb", paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "px2" }] }));
    const done = board.post(rev("pass", ["pb"], "r2"));
    expect(done.filter((m) => m.type === "item.completed").map((m) => m.payload)).toEqual([
      { item: "one-x", n: 2, via: "integrated" },
      { item: "one", n: 2, via: "children" },
    ]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a late delivery never revives a lapsed grant; a delivered grant lapses too; the requester can close it", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(push("a", "one", "c1", ["src/a/x.ts"]));
    board.post(msg("a", "help.requested", { request: "h1", item: "one", need: "n", scope: ["src/a/y.ts"] }));
    board.post(msg("b", "help.offered", { request: "h1", forkOf: "a", forkCommit: "c1" }));
    const pad = (n: number, tag: string) => {
      for (let i = 0; i <= n; i += 1) board.post(msg("lead", "item.proposed", { item: `${tag}-${i}`, objective: "pad", scopeHint: ["pad/**"] }));
    };
    pad(BOARD_LIMITS.helpWaitMessages, "p");
    board.reject(msg("b", "help.delivered", { request: "h1", commit: "f1", paths: ["src/a/y.ts"] }), /lapsed or closed/, "INVALID_STATE");
    expect(board.types(msg("a", "done.proposed", { item: "one" }))).toEqual(["done.proposed"]);

    // A delivered, unpulled grant lapses after the bounded wait.
    const other = seeded();
    other.post(claim("a", "one", ["src/a/**"]));
    other.post(push("a", "one", "c1", ["src/a/x.ts"]));
    other.post(msg("a", "help.requested", { request: "h1", item: "one", need: "n", scope: ["src/a/y.ts"] }));
    other.post(msg("b", "help.offered", { request: "h1", forkOf: "a", forkCommit: "c1" }));
    other.post(msg("b", "help.delivered", { request: "h1", commit: "f1", paths: ["src/a/y.ts"] }));
    other.reject(push("a", "one", "c2", ["src/a/y.ts"]), /granted to b/, "INTENT_OVERLAP");
    for (let i = 0; i <= BOARD_LIMITS.helpWaitMessages; i += 1) other.post(msg("lead", "item.proposed", { item: `q-${i}`, objective: "pad", scopeHint: ["pad/**"] }));
    expect(other.types(push("a", "one", "c2", ["src/a/y.ts"]))).toEqual(["push.announced"]);

    // The requester closes a delivered grant (a failed pull, or a decline): its scope is its own again.
    const third = seeded();
    third.post(claim("a", "one", ["src/a/**"]));
    third.post(push("a", "one", "c1", ["src/a/x.ts"]));
    third.post(msg("a", "help.requested", { request: "h1", item: "one", need: "n", scope: ["src/a/y.ts"] }));
    third.post(msg("b", "help.offered", { request: "h1", forkOf: "a", forkCommit: "c1" }));
    third.post(msg("b", "help.delivered", { request: "h1", commit: "f1", paths: ["src/a/y.ts"] }));
    third.reject(msg("b", "help.closed", { request: "h1", reason: "declined" }), /only a, who asked/, "NOT_ALLOWED");
    third.post(msg("a", "help.closed", { request: "h1", reason: "pull-failed", detail: "MERGE_FAILED: conflict" }));
    expect(third.state.help.h1!.closed).toMatchObject({ reason: "pull-failed" });
    third.reject(msg("a", "help.closed", { request: "h1", reason: "declined" }), /nothing open to close/, "INVALID_STATE");
    third.reject(msg("b", "help.delivered", { request: "h1", commit: "f2", paths: ["src/a/y.ts"] }), /lapsed or closed/, "INVALID_STATE");
    expect(third.types(msg("a", "done.proposed", { item: "one" }))).toEqual(["done.proposed"]);
    expect(reduceBoard(third.log)).toEqual(third.state);
  });
});

describe("formation cues: struggling owners, idle volunteers, answers (bounded, no storms)", () => {
  /** a holds one (two files), b holds two, c is idle; one is the only other item and all are claimed. */
  function cued(): TestBoard {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(claim("b", "two", ["src/b/**"]));
    board.post(claim("c", "three", ["src/c/**"]));
    board.post(push("c", "three", "c3", ["src/c/x.ts"]));
    board.post(msg("c", "done.proposed", { item: "three" }));
    board.post(rev("pass", ["c3"], "r1"));
    return board;
  }

  it("an owner's struggling report shows in its digest with the idle agents; it is bounded and goes stale once the owner pushes", () => {
    const board = cued();
    board.reject(msg("b", "item.struggling", { item: "one", turnsSpent: 4, failedEdits: 0, reason: "turn-budget" }), /does not hold/, "NOT_OWNER");
    board.post(msg("a", "item.struggling", { item: "one", turnsSpent: 4, failedEdits: 2, reason: "failed-edits", lastFailure: "EXECUTOR_FAILED: no anchor" }));
    const a = boardDigest(board.state, board.log, "a", 0);
    expect(a.struggling).toEqual([{ item: "one", turnsSpent: 4, failedEdits: 2, reason: "failed-edits", lastFailure: "EXECUTOR_FAILED: no anchor" }]);
    expect(a.idleAgents).toEqual(["c"]);
    board.reject(msg("a", "item.struggling", { item: "one", turnsSpent: 4, failedEdits: 2, reason: "failed-edits" }), /nothing changed/, "DUPLICATE");
    board.post(msg("a", "item.struggling", { item: "one", turnsSpent: 5, failedEdits: 2, reason: "turn-budget" }));
    board.post(msg("a", "item.struggling", { item: "one", turnsSpent: 6, failedEdits: 3, reason: "failed-edits" }));
    board.reject(msg("a", "item.struggling", { item: "one", turnsSpent: 7, failedEdits: 3, reason: "failed-edits" }), /3 times/, "LIMIT");
    // The idle agent sees the busy owner only when no item is open.
    expect(boardDigest(board.state, board.log, "c", 0).busyOwners).toMatchObject([{ agent: "a", item: "one", reason: "failed-edits", scope: ["src/a/**"] }]);
    board.post(msg("lead", "item.proposed", { item: "four", objective: "o", scopeHint: ["src/d/**"] }));
    expect(boardDigest(board.state, board.log, "c", 0).busyOwners).toBeUndefined();
    // A push by the owner is progress: the report goes stale.
    const fresh = cued();
    fresh.post(msg("a", "item.struggling", { item: "one", turnsSpent: 4, failedEdits: 0, reason: "turn-budget" }));
    fresh.post(push("a", "one", "c1", ["src/a/x.ts"]));
    expect(boardDigest(fresh.state, fresh.log, "a", 0).struggling).toBeUndefined();
    expect(boardDigest(fresh.state, fresh.log, "c", 0).busyOwners).toBeUndefined();
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a volunteer's offer is addressed to the owner, rate-limited, and answered by a grant addressed to it (only it may fork) or a decline", () => {
    const board = cued();
    board.post(msg("a", "item.struggling", { item: "one", turnsSpent: 4, failedEdits: 2, reason: "failed-edits" }));
    board.reject(msg("c", "help.volunteered", { item: "one" }), /addressed to the item's owner/, "BAD_PAYLOAD");
    board.reject(msg("a", "help.volunteered", { item: "one" }, { to: ["b"] }), /own item/, "NOT_ALLOWED");
    board.post(msg("c", "help.volunteered", { item: "one" }, { to: ["a"] }));
    board.reject(msg("c", "help.volunteered", { item: "one" }, { to: ["a"] }), /still waiting/, "DUPLICATE");
    expect(boardDigest(board.state, board.log, "a", 0).volunteers).toMatchObject([{ agent: "c", item: "one" }]);
    expect(boardDigest(board.state, board.log, "a", 0).messages.some((m) => m.type === "help.volunteered")).toBe(true);
    // Decline, then a second offer, then the limit.
    board.reject(msg("a", "help.declined", { item: "one", volunteer: "b" }), /no offer/, "UNKNOWN_REF");
    board.post(msg("a", "help.declined", { item: "one", volunteer: "c" }, { to: ["c"] }));
    expect(board.state.volunteers!["one:c"]!.answered).toMatchObject({ how: "declined" });
    board.post(msg("c", "help.volunteered", { item: "one" }, { to: ["a"] }));
    // Accept: a grant addressed to the volunteer answers it, and only it may fork for it.
    board.post(msg("a", "help.requested", { request: "h1", item: "one", need: "volunteer", scope: ["src/a/y.ts"] }, { to: ["c"] }));
    expect(board.state.volunteers!["one:c"]!.answered).toMatchObject({ how: "accepted", request: "h1" });
    expect(boardDigest(board.state, board.log, "b", 0).help?.wanted ?? []).toEqual([]);
    expect(() => checkHelpFork(board.state, "h1", "b")).toThrow(/grants its scope to c only/);
    board.reject(msg("b", "help.offered", { request: "h1", forkOf: "a" }), /grants its scope to c only/, "NOT_ALLOWED");
    expect(board.types(msg("c", "help.offered", { request: "h1", forkOf: "a" }))).toEqual(["help.offered"]);
    board.post(msg("c", "help.delivered", { request: "h1", commit: "f1", paths: ["src/a/y.ts"] }));
    board.reject(msg("c", "help.volunteered", { item: "one" }, { to: ["a"] }), /volunteered 2 times/, "LIMIT");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("the split cue: at least 3 files, or an objective naming at least 2 sub-changes", () => {
    expect(objectiveSubChanges("Add input validation and require auth on every resource")).toBe(2);
    expect(objectiveSubChanges("Add organization-level audit logging with a read API and tests")).toBe(1);
    expect(objectiveSubChanges("fix a; fix b, then document c (claim this item now, if the codemod ...)")).toBe(3);
    expect(splitCue(3, "one change")).toMatchObject({ splittable: true, files: 3 });
    expect(splitCue(1, "one change")).toMatchObject({ splittable: false, subChanges: 1 });
    expect(splitCue(1, "validate input and log errors")).toMatchObject({ splittable: true, subChanges: 2 });
  });
});

describe("failures the plan missed, and the contract cue", () => {
  it("finds the repo files a failing output points at (locations, titles), and those no item covers", async () => {
    const { failingRepoFiles, uncoveredFailureFiles } = await import("../src/index.ts");
    const repo = ["src/a/x.ts", "src/extra/users.ts", "src/extra/y.ts", "tests/a.test.ts"];
    const output = "> pkg@1.0.0 gate\n> vitest run\nAssertionError: boom\n    at /tmp/gate-123/src/extra/y.ts:4:2\n FAIL  tests/a.test.ts > users: rejects\n";
    expect(failingRepoFiles(output, repo)).toEqual(["src/extra/y.ts"]);
    expect(failingRepoFiles("✖ users: unauthenticated request is rejected\n", repo)).toEqual(["src/extra/users.ts"]);
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o" }));
    board.post(msg("human", "item.proposed", { item: "x", objective: "o", scopeHint: ["src/a/**"] }));
    expect(uncoveredFailureFiles(board.state, ["src/a/x.ts", "src/extra/y.ts", "tools/t/run.mjs"])).toEqual(["src/extra/y.ts"]);
  });

  it("an owner whose failing check is a protected test gets a contract cue and may propose that contract (a human decides); once accepted it pushes it", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protected: ["tests/tax.test.ts"] }));
    board.post(msg("a", "agent.joined"));
    board.post(msg("human", "item.proposed", { item: "tax", objective: "round tax", scopeHint: ["src/tax.ts"] }));
    board.post(claim("a", "tax", ["src/tax.ts"]));
    // Not the failing check yet: outside the scope, refused.
    board.reject(msg("a", "contract.proposed", { contract: "k0", target: "tests/tax.test.ts", kind: "modify", item: "tax" }), /not the failing check/, "OUTSIDE_SCOPE");
    board.post(push("a", "tax", "c1", ["src/tax.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], failing: { output: "> s@0 gate\nAssertionError: expected 73 to be 72\n at tests/tax.test.ts:12:5", items: ["tax"] } }));
    const digest = boardDigest(board.state, board.log, "a", 0);
    expect(digest.claims[0]!.contractCue).toMatchObject({ paths: ["tests/tax.test.ts"], hint: expect.stringMatching(/send message kind contract \{target: tests\/tax\.test\.ts, change: modify, itemId: tax\}/) });
    expect(digest.struggling ?? []).toEqual([{ item: "tax", turnsSpent: 0, failedEdits: 0, reason: "failing-revision", lastFailure: "AssertionError: expected 73 to be 72" }]);
    expect(board.types(msg("a", "contract.proposed", { contract: "k1", target: "tests/tax.test.ts", kind: "modify", item: "tax" }))).toEqual(["contract.proposed", "contract.escalated"]);
    board.reject(push("a", "tax", "c2", ["tests/tax.test.ts"]), /outside the claim's write intent/, "OUTSIDE_INTENT");
    board.post(msg("human", "contract.accepted", { contract: "k1" }));
    expect(boardDigest(board.state, board.log, "a", 0).claims[0]!.contractCue).toBeUndefined();
    expect(board.types(push("a", "tax", "c2", ["src/tax.ts", "tests/tax.test.ts"]))).toEqual(["push.announced"]);
    expect(planBoardIntegration(board.log, board.state).units[0]).toMatchObject({ scope: ["src/tax.ts", "tests/tax.test.ts"], releasedPaths: ["tests/tax.test.ts"] });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("the immutable acceptance gate", () => {
  it("refuses any contract on it (even one a human would accept), and never cues it", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", protected: ["gate/billing.test.ts", "tests/tax.test.ts"], immutable: ["gate/billing.test.ts"] }));
    board.post(msg("a", "agent.joined"));
    board.post(msg("human", "item.proposed", { item: "tax", objective: "o", scopeHint: ["src/tax.ts", "gate/**", "tests/**"] }));
    board.post(claim("a", "tax", ["src/tax.ts"]));
    board.reject(msg("a", "contract.proposed", { contract: "k1", target: "gate/billing.test.ts", kind: "modify", item: "tax" }), /immutable acceptance gate/, "IMMUTABLE");
    board.reject(msg("a", "contract.proposed", { contract: "k2", target: "gate/**", kind: "modify", item: "tax" }), /immutable acceptance gate/, "IMMUTABLE");
    board.post(msg("human", "item.proposed", { item: "g", objective: "o", scopeHint: ["gate/**"] }));
    board.reject(claim("a", "g", ["gate/billing.test.ts"]), /immutable acceptance gate/, "PROTECTED");
    board.post(push("a", "tax", "c1", ["src/tax.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], failing: { output: "AssertionError at gate/billing.test.ts:3\nand tests/tax.test.ts:9", items: ["tax"] } }));
    // The cue names only the developer test, never the acceptance suite.
    expect(boardDigest(board.state, board.log, "a", 0).claims[0]!.contractCue?.paths).toEqual(["tests/tax.test.ts"]);
    expect(boardDigest(board.state, board.log, "a", 0).immutable).toEqual(["gate/billing.test.ts"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("seam first", () => {
  /** A goal with the storefront's money seam and two importers; items for the seam and its importers. */
  function seamBoard(): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", seams: [{ path: "src/contracts/money.ts", importers: ["src/orders/cart.ts", "src/billing/tax.ts"] }] }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("human", "item.proposed", { item: "money", objective: "exact money", scopeHint: ["src/contracts/money.ts"] }));
    board.post(msg("human", "item.proposed", { item: "cart", objective: "cart totals", scopeHint: ["src/orders/cart.ts"] }));
    board.post(msg("human", "item.proposed", { item: "catalog", objective: "catalog", scopeHint: ["src/catalog/products.ts"] }));
    return board;
  }

  it("an item whose scope merely covers a seam is taken first but holds no one: only an accepted seam contract's item holds dependents", () => {
    const board = seamBoard();
    expect(boardDigest(board.state, board.log, "b", 0).openItems.map((i) => [i.item, i.seam ?? false, i.waitsFor ?? []])).toEqual([
      ["money", true, []],
      ["cart", false, []],
      ["catalog", false, []],
    ]);
    // Claimed and pushed, a PLANNED seam item still holds nobody (SEAM_FIRST comes only from fromContract items).
    board.post(claim("a", "money", ["src/contracts/money.ts"]));
    board.post(push("a", "money", "m1", ["src/contracts/money.ts"]));
    expect(seamHolds(board.state)).toEqual([]);
    expect(boardDigest(board.state, board.log, "b", 0).openItems.map((i) => [i.item, i.waitsFor ?? []])).toEqual([
      ["cart", []],
      ["catalog", []],
    ]);
    expect(board.types(claim("b", "cart", ["src/orders/cart.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    // And nothing can be recorded stalled on it: the same predicate says it holds no one.
    expect(() => appendSeamStalled(board.state, { item: "money" }, AT)).toThrow(/holds no dependent/);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("seam contracts: a change to a frozen shared seam, decided by the lead", () => {
  const CTX_ERROR = "> tsc --noEmit\nsrc/orders/cart.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'.\n";
  /** The storefront shape: Ctx lives in the shared src/store.ts no item owns; cart and invoices import it. */
  function storefront(options: { readonly output?: string; readonly rules?: Record<string, number> } = {}): TestBoard {
    const board = new TestBoard();
    board.post(
      msg("human", "goal.posted", {
        objective: "o",
        ...(options.rules ? { rules: options.rules } : {}),
        seams: [
          { path: "src/store.ts", importers: ["src/orders/cart.ts", "src/billing/invoices.ts"], symbols: ["Ctx", "Store", "Order"] },
          { path: "src/contracts/money.ts", importers: ["src/orders/cart.ts"], symbols: ["Money", "toCents"] },
          { path: "src/contracts/http.ts", importers: ["src/orders/cart.ts"], symbols: ["json", "problem"] },
        ],
      }),
    );
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "cart", objective: "cart requires the signed-in user", acceptance: ["it works"], scopeHint: ["src/orders/cart.ts"] }));
    board.post(msg("lead", "item.proposed", { item: "invoices", objective: "invoices", acceptance: ["it works"], scopeHint: ["src/billing/invoices.ts"] }));
    board.post(claim("a", "cart", ["src/orders/cart.ts"]));
    board.post(push("a", "cart", "c1", ["src/orders/cart.ts"]));
    board.post(
      msg("engine", "integrated.rev", {
        commit: "r1",
        gate: "fail",
        merged: ["c1"],
        failing: {
          output: options.output ?? CTX_ERROR,
          items: ["cart"],
        },
      }),
    );
    return board;
  }

  it("a local annotation error that names no seam symbol (the sf13 TS2739 on Record) cues no seam, though the file imports three", () => {
    const board = storefront({
      output:
        "src/orders/cart.ts(58,11): error TS2739: Type 'Record<string, unknown>' is missing the following properties from type '{ name: string; categoryId: string; priceCents: number; }': name, categoryId, priceCents\n",
    });
    expect(seamContractCue(board.state, "cart")).toBeUndefined();
    expect(boardDigest(board.state, board.log, "a", 0).claims.find((c) => c.item === "cart")!.seamCue).toBeUndefined();
    // An error naming a seam's export still cues exactly that seam.
    const named = storefront({ output: "src/orders/cart.ts(9,3): error TS2322: Type 'number' is not assignable to type 'Money'.\n" });
    expect(seamContractCue(named.state, "cart")?.seams).toEqual(["src/contracts/money.ts"]);
  });

  it("no seam is cued while the item has a seam contract waiting for the lead", () => {
    const board = storefront({ output: `${CTX_ERROR}src/orders/cart.ts(9,3): error TS2322: Type 'number' is not assignable to type 'Money'.\n` });
    expect(seamContractCue(board.state, "cart")?.seams).toEqual(["src/contracts/money.ts", "src/store.ts"]);
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    // money.ts was not asked about, yet nothing is cued until the lead decides k1.
    expect(seamContractCue(board.state, "cart")).toBeUndefined();
    board.post(msg("lead", "contract.rejected", { contract: "k1" }));
    expect(seamContractCue(board.state, "cart")?.seams).toEqual(["src/contracts/money.ts"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("revision 6: after the lead rejects a seam contract, the identical failing errors cue no seam again (revision 5 re-cues on the next implication)", () => {
    for (const arbitration of [5, 6]) {
      const board = storefront({ rules: { arbitration } });
      board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user" }));
      expect(board.state.contracts.k1!.failingErrors).toEqual(arbitration === 6 ? ["src/orders/cart.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'."] : undefined);
      board.post(msg("lead", "contract.rejected", { contract: "k1" }));
      board.post(push("a", "cart", "c2", ["src/orders/cart.ts"]));
      board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c2"], failing: { output: CTX_ERROR, items: ["cart"] } }));
      expect(seamContractCue(board.state, "cart")?.seams).toEqual(arbitration === 6 ? undefined : ["src/store.ts"]);
      // A different error (a new line) is a new cause: cued again under both.
      board.post(push("a", "cart", "c3", ["src/orders/cart.ts"]));
      board.post(
        msg("engine", "integrated.rev", {
          commit: "r3",
          gate: "fail",
          merged: ["c3"],
          failing: { output: "src/orders/cart.ts(70,5): error TS2339: Property 'session' does not exist on type 'Ctx'.\n", items: ["cart"] },
        }),
      );
      expect(seamContractCue(board.state, "cart")?.seams).toEqual(["src/store.ts"]);
      expect(reduceBoard(board.log)).toEqual(board.state);
    }
  });

  it("revision 6: a seam item whose push was gated with no fix owed no longer owns its seam, so a follow-up change goes to the lead (refused under revision 5)", () => {
    for (const arbitration of [5, 6]) {
      const board = storefront({ rules: { arbitration } });
      board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
      board.post(msg("lead", "contract.accepted", { contract: "k1" }));
      board.post(push("a", seamItemId("k1"), "s1", ["src/store.ts"]));
      board.post(
        msg("engine", "integrated.rev", {
          commit: "r2",
          gate: "fail",
          merged: ["c1", "s1"],
          failing: { output: "src/orders/cart.ts(60,3): error TS2339: Property 'session' does not exist on type 'Ctx'.\n", items: ["cart"] },
        }),
      );
      const seamItem = board.state.items[seamItemId("k1")]!;
      expect(waitingOnOthers(board.state, seamItem)).toBe(true);
      const followUp = msg("a", "contract.proposed", { contract: "k2", target: "src/store.ts", kind: "modify", item: "cart", description: "add session to Ctx" });
      if (arbitration === 5) {
        expect(seamContractCue(board.state, "cart")).toBeUndefined();
        board.reject(followUp, /in item seam-k1's scope: ask its owner/, "NOT_ALLOWED");
      } else {
        expect(seamContractCue(board.state, "cart")?.seams).toEqual(["src/store.ts"]);
        expect(board.types(followUp)).toEqual(["contract.proposed"]);
        expect(board.state.contracts.k2).toMatchObject({ seam: "src/store.ts", status: "proposed", item: "cart" });
        expect(itemWaitReason(board.state, "cart")).toEqual({ kind: "waiting-for-lead", contract: "k2" });
      }
      expect(reduceBoard(board.log)).toEqual(board.state);
    }
  });

  it("revision 6: a plain question addressed to an agent stays in its digest until it replies (not listed under revision 5)", () => {
    for (const arbitration of [5, 6]) {
      const board = storefront({ rules: { arbitration } });
      board.post(claim("b", "invoices", ["src/billing/invoices.ts"]));
      board.post(msg("b", "help.requested", { request: "q1", item: "invoices", need: "how-is-ctx-user-typed" }, { to: ["a"] }));
      const listed = boardDigest(board.state, board.log, "a", 0).questions;
      if (arbitration === 5) {
        expect(listed).toBeUndefined();
        continue;
      }
      expect(listed).toEqual([expect.objectContaining({ request: "q1", item: "invoices", by: "b", need: "how-is-ctx-user-typed", hint: expect.stringMatching(/message kind reply \{requestId: q1\}/) })]);
      expect(boardDigest(board.state, board.log, "b", 0).questions).toBeUndefined(); // the asker is not asked
      board.post(msg("a", "help.offered", { request: "q1" }, { to: ["b"] }));
      expect(boardDigest(board.state, board.log, "a", 0).questions).toBeUndefined();
      expect(reduceBoard(board.log)).toEqual(board.state);
    }
  });

  it("cues the implicated owner with the seam the type error names, the lead decides, and the accepted contract becomes a seam item scheduled first", () => {
    const board = storefront();
    const cue = boardDigest(board.state, board.log, "a", 0).claims.find((c) => c.item === "cart")!.seamCue;
    // `on type 'Ctx'` names src/store.ts's export: that seam only, not every seam cart.ts imports.
    expect(cue).toMatchObject({ seams: ["src/store.ts"], errors: ["src/orders/cart.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'."] });
    expect(cue!.hint).toMatch(/do not use undeclared fields/);
    expect(cue!.hint).toMatch(/send message kind contract \{target: src\/store\.ts, change: modify, itemId: cart, description: the exact change you need\}/);
    expect(seamContractCue(board.state, "invoices")).toBeUndefined();

    // A seam contract needs the exact change, and comes from the owner of the item that needs it.
    board.reject(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart" }), /describes the exact change/, "BAD_PAYLOAD");
    board.reject(msg("b", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user" }), /does not hold the claim/, "NOT_OWNER");
    const change = "add an optional `user?: { id: string }` field to Ctx";
    expect(board.types(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts#Ctx", kind: "modify", item: "cart", description: change }))).toEqual(["contract.proposed"]);
    expect(board.state.contracts.k1).toMatchObject({ seam: "src/store.ts", description: change, status: "proposed" });
    // Not escalated to a human: the lead decides it. Only once per seam at a time; the cue is quiet while it waits.
    expect(board.log.some((m) => m.type === "contract.escalated")).toBe(false);
    board.reject(msg("a", "contract.proposed", { contract: "k2", target: "src/store.ts", kind: "modify", item: "cart", description: change }), /already waiting/, "DUPLICATE");
    expect(boardDigest(board.state, board.log, "a", 0).claims.find((c) => c.item === "cart")!.seamCue).toBeUndefined();
    board.reject(msg("b", "contract.accepted", { contract: "k1" }), /cannot be sent by an agent/, "NOT_ALLOWED");

    // The lead accepts: the engine proposes the seam item (open, seam-first).
    // The lead accepts: the engine proposes the seam item and grants it to the PROPOSER (it holds the context).
    expect(board.types(msg("lead", "contract.accepted", { contract: "k1" }))).toEqual(["contract.accepted", "item.proposed", "claim.granted"]);
    const seamItem = board.state.items[seamItemId("k1")]!;
    expect(seamItem).toMatchObject({ status: "claimed", owner: "a", scopeHint: ["src/store.ts"], fromContract: "k1", proposedBy: "engine" });
    expect(seamItem.objective).toContain(change);
    expect(boardDigest(board.state, board.log, "a", 0).claims.find((c) => c.item === seamItemId("k1"))).toBeDefined();

    // Claimed, it goes first: importers wait for its integrated revision, then rebase.
    expect(boardDigest(board.state, board.log, "a", 0).claims.find((c) => c.item === "cart")!.waitsFor).toEqual([seamItemId("k1")]);
    board.reject(claim("b", "invoices", ["src/billing/invoices.ts"]), /waits for that change's integrated revision/, "SEAM_FIRST");
    expect(seamHolds(board.state)).toEqual([{ item: seamItemId("k1"), dependents: ["cart", "invoices"] }]);
    board.post(push("a", seamItemId("k1"), "s1", ["src/store.ts"]));
    const integrated = board.post(rev("pass", ["s1"], "r2"));
    expect(integrated.some((m) => m.type === "rebase.needed" && m.payload.agent === "b")).toBe(false); // b holds nothing importing it
    expect(seamHolds(board.state)).toEqual([]);
    expect(boardDigest(board.state, board.log, "a", 0).claims.find((c) => c.item === "cart")!.waitsFor).toBeUndefined();
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("caps seam contracts: one waiting per agent, a bounded number per Change, and one seam change per failing cause", () => {
    const board = storefront();
    board.post(claim("b", "invoices", ["src/billing/invoices.ts"]));
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    // A second waiting seam contract from the same agent is refused until the first is decided.
    board.reject(
      msg("a", "contract.proposed", { contract: "k2", target: "src/contracts/http.ts", kind: "modify", item: "cart", description: "add validateInput" }),
      /already has a seam contract waiting/,
      "LIMIT",
    );
    board.post(msg("lead", "contract.accepted", { contract: "k1" }));
    expect(board.state.contracts.k1).toMatchObject({ failingRev: 1 });
    // Accepted and unfinished for the same failing revision: no second seam change for that cause.
    board.reject(
      msg("a", "contract.proposed", { contract: "k3", target: "src/contracts/money.ts", kind: "modify", item: "cart", description: "add validateInput" }),
      /one seam change per failing cause/,
      "DUPLICATE",
    );
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("facts for the lead (the sf5 shape): the seam the error names, duplicates of a NEW name across seams, and no release to the requester", () => {
    const board = new TestBoard();
    board.post(
      msg("human", "goal.posted", {
        objective: "o",
        seams: [
          { path: "src/contracts/auth.ts", importers: ["src/billing/invoices.ts"], symbols: ["requireAuth"] },
          { path: "src/contracts/http.ts", importers: ["src/billing/invoices.ts"], symbols: ["json"] },
          { path: "src/contracts/money.ts", importers: ["src/billing/invoices.ts"], symbols: ["Money"] },
        ],
      }),
    );
    for (const agent of ["a", "b", "c"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    for (const [item, file] of [["inv", "invoices"], ["pay", "payments"]] as const) {
      board.post(msg("lead", "item.proposed", { item, objective: item, acceptance: ["ok"], scopeHint: [`src/billing/${file}.ts`] }));
    }
    board.post(claim("a", "inv", ["src/billing/invoices.ts"]));
    board.post(push("a", "inv", "c1", ["src/billing/invoices.ts"]));
    board.post(
      msg("engine", "integrated.rev", {
        commit: "r1",
        gate: "fail",
        merged: ["c1"],
        failing: { output: `src/billing/invoices.ts(14,23): error TS2305: Module '"../contracts/auth.ts"' has no exported member 'validateInput'.`, items: ["inv"] },
      }),
    );
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/contracts/auth.ts", kind: "modify", item: "inv", description: "add 'validateInput' to auth" }));
    expect(seamContractFacts(board.state, "k1")).toEqual({ namedInFailure: true });
    board.post(msg("lead", "contract.accepted", { contract: "k1" }));
    // The requester's own unit never carries the seam: its seam item does.
    expect(releasedTargets(board.state, "inv")).toEqual([]);
    // A shared seam is never uncovered work (it changes only through a seam contract).
    expect(uncoveredFailureFiles(board.state, ["src/contracts/http.ts", "src/billing/refunds.ts"])).toEqual(["src/billing/refunds.ts"]);
    // Another agent asks the same NEW name on a seam the error does not name: both facts say no.
    board.post(claim("b", "pay", ["src/billing/payments.ts"]));
    board.post(msg("b", "contract.proposed", { contract: "k2", target: "src/contracts/http.ts", kind: "modify", item: "pay", description: "add 'validateInput' to http" }));
    expect(seamContractFacts(board.state, "k2")).toEqual({ namedInFailure: false, duplicateOf: "k1" });
    expect(seamContractFacts(board.state, "nope")).toEqual({ namedInFailure: false });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a seam contract's advisory triage is kept on the contract for the lead (it never decides)", () => {
    const board = storefront();
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    board.post(msg("engine", "decision.recorded", { juncture: "contract-triage", contract: "k1", question: "q", answer: "accept", confidence: 0.9, accepted: true }));
    expect(board.state.contracts.k1).toMatchObject({ status: "proposed", triage: "accept (confidence 0.90)" });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a seam item holds dependents only while it makes progress; recorded stalled, it holds no one and, with no push, is released for others", () => {
    const board = storefront();
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    board.post(msg("lead", "contract.accepted", { contract: "k1" }));
    expect(seamHolds(board.state).map((h) => h.item)).toEqual([seamItemId("k1")]);
    // Nothing is stalled on an item holding no one.
    expect(() => appendSeamStalled(board.state, { item: "invoices" }, AT)).toThrow(/holds no dependent/);
    // The board went quiet: the operator records it stalled. No push of a's: released (open).
    expect(board.types(msg("engine", "seam.stalled", { item: seamItemId("k1") }))).toEqual(["seam.stalled"]);
    const seam = board.state.items[seamItemId("k1")]!;
    expect(seam).toMatchObject({ status: "open" });
    expect(seam.owner).toBeUndefined();
    expect(seamHolds(board.state)).toEqual([]);
    expect(boardDigest(board.state, board.log, "b", 0).openItems.find((i) => i.item === seamItemId("k1"))).toMatchObject({ seam: true });
    // Taken again, it holds again (a fresh grant is progress) ...
    board.post(claim("b", seamItemId("k1"), ["src/store.ts"]));
    expect(seamHolds(board.state).map((h) => h.item)).toEqual([seamItemId("k1")]);
    // ... and with a push of its owner's, a stall keeps the claim but ends the hold.
    board.post(push("b", seamItemId("k1"), "s1", ["src/store.ts"]));
    expect(board.post(msg("engine", "seam.stalled", { item: seamItemId("k1") }))[0]!.payload).toEqual({ item: seamItemId("k1"), released: false });
    expect(board.state.items[seamItemId("k1")]).toMatchObject({ status: "claimed", owner: "b" });
    expect(seamHolds(board.state)).toEqual([]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("ONE predicate: the hold (waitsFor, SEAM_FIRST), seamHolds, and the stall check agree at every step", () => {
    const agree = (board: TestBoard) => {
      const state = board.state;
      const waitedOn = new Set(Object.keys(state.items).flatMap((id) => seamWaits(state, id).map((w) => w.item)));
      const held = new Set(seamHolds(state).map((h) => h.item));
      expect([...held].sort()).toEqual([...waitedOn].sort());
      for (const item of Object.values(state.items)) {
        let stallable = true;
        try {
          appendSeamStalled(state, { item: item.id }, AT);
        } catch {
          stallable = false;
        }
        expect({ item: item.id, stallable }).toEqual({ item: item.id, stallable: held.has(item.id) });
        if (held.has(item.id)) expect(seamItemHolding(state, item)).toBe(true);
      }
      return [...held];
    };
    // Progress path: proposed, accepted (granted), pushed, integrated.
    const one = storefront();
    expect(agree(one)).toEqual([]);
    one.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    expect(agree(one)).toEqual([]);
    one.post(msg("lead", "contract.accepted", { contract: "k1" }));
    expect(agree(one)).toEqual([seamItemId("k1")]);
    one.post(push("a", seamItemId("k1"), "s1", ["src/store.ts"]));
    expect(agree(one)).toEqual([seamItemId("k1")]);
    one.post(rev("pass", ["s1"], "r2"));
    expect(agree(one)).toEqual([]);
    // Stall path: recorded stalled (released), taken again, then lapsing without progress.
    const two = storefront();
    two.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    two.post(msg("lead", "contract.accepted", { contract: "k1" }));
    two.post(msg("engine", "seam.stalled", { item: seamItemId("k1") }));
    expect(agree(two)).toEqual([]);
    two.post(claim("b", seamItemId("k1"), ["src/store.ts"]));
    expect(agree(two)).toEqual([seamItemId("k1")]);
    for (let i = 0; i <= BOARD_LIMITS.seamWaitMessages; i += 1) two.post(msg("human", "item.proposed", { item: `pad-${i}`, objective: "pad", scopeHint: ["pad/**"] }));
    expect(agree(two)).toEqual([]);
    expect(reduceBoard(two.log)).toEqual(two.state);
  });

  it("seam items are exempt from the claim cap; an OPEN one is listed for agents whose items need it; a GATED seam push holds no one", () => {
    const board = new TestBoard();
    board.post(
      msg("human", "goal.posted", {
        objective: "o",
        rules: { maxActiveClaims: 1 },
        seams: [{ path: "src/store.ts", importers: ["src/orders/cart.ts", "src/billing/invoices.ts"], symbols: ["Ctx"] }],
      }),
    );
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "cart", objective: "cart", acceptance: ["ok"], scopeHint: ["src/orders/cart.ts"] }));
    board.post(msg("lead", "item.proposed", { item: "invoices", objective: "inv", acceptance: ["ok"], scopeHint: ["src/billing/invoices.ts"] }));
    board.post(claim("a", "cart", ["src/orders/cart.ts"]));
    board.post(claim("b", "invoices", ["src/billing/invoices.ts"]));
    board.post(push("a", "cart", "c1", ["src/orders/cart.ts"]));
    board.post(
      msg("engine", "integrated.rev", {
        commit: "r1",
        gate: "fail",
        merged: ["c1"],
        failing: { output: "src/orders/cart.ts(4,1): error TS2339: Property 'user' does not exist on type 'Ctx'.", items: ["cart"] },
      }),
    );
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    // The proposer is at its cap (cart), yet the engine grants it the seam item: exempt.
    expect(board.types(msg("lead", "contract.accepted", { contract: "k1" }))).toEqual(["contract.accepted", "item.proposed", "claim.granted"]);
    // Released (stalled), it is OPEN: b's held invoices needs it, and b may claim it at its cap.
    board.post(msg("engine", "seam.stalled", { item: seamItemId("k1") }));
    expect(boardDigest(board.state, board.log, "b", 0).openSeams).toEqual([
      expect.objectContaining({ item: seamItemId("k1"), seam: "src/store.ts", blocks: ["invoices"], hint: expect.stringMatching(/Claim it yourself/) }),
    ]);
    expect(board.types(claim("b", seamItemId("k1"), ["src/store.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    expect(seamHolds(board.state).map((h) => h.item)).toEqual([seamItemId("k1")]);
    // Its push merged into a revision (even a failing one): dependents merge with it from now on, so it holds no one.
    board.post(push("b", seamItemId("k1"), "s1", ["src/store.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c1", "s1"], failing: { output: "AssertionError: expected 1072 to be 1073", items: ["cart"] } }));
    expect(board.state.items[seamItemId("k1")]!.lastPush).toMatchObject({ gatedIn: 2 });
    expect(seamHolds(board.state)).toEqual([]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("without progress the hold lapses after the bounded number of board messages since the grant", () => {
    const board = storefront();
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user to Ctx" }));
    board.post(msg("lead", "contract.accepted", { contract: "k1" }));
    for (let i = 0; i <= BOARD_LIMITS.seamWaitMessages; i += 1) board.post(msg("human", "item.proposed", { item: `pad-${i}`, objective: "pad", scopeHint: ["pad/**"] }));
    expect(seamHolds(board.state)).toEqual([]);
    expect(board.types(claim("b", "invoices", ["src/billing/invoices.ts"]))).toEqual(["item.claimed", "claim.granted"]);
  });

  it("only the engine proposes an item from a seam contract, and only for an accepted one; a seam an item owns is changed by that item", () => {
    const board = storefront();
    board.reject(
      msg("lead", "item.proposed", { item: "seam-k9", objective: "x", acceptance: ["y"], scopeHint: ["src/store.ts"], fromContract: "k9" }),
      /only the engine proposes an item from a seam contract/,
      "NOT_ALLOWED",
    );
    board.post(msg("lead", "item.proposed", { item: "store", objective: "store", acceptance: ["y"], scopeHint: ["src/store.ts"] }));
    // Someone owns the seam now: no cue, and a contract on it is refused in favor of asking its owner.
    expect(seamContractCue(board.state, "cart")).toBeUndefined();
    board.reject(
      msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user" }),
      /in item store's scope: ask its owner/,
      "NOT_ALLOWED",
    );
  });

  it("a rejected seam contract is not cued again until a newer failing revision implicates the item", () => {
    const board = storefront();
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "src/store.ts", kind: "modify", item: "cart", description: "add user" }));
    expect(board.types(msg("lead", "contract.rejected", { contract: "k1" }))).toEqual(["contract.rejected"]);
    expect(seamContractCue(board.state, "cart")).toBeUndefined();
    board.post(push("a", "cart", "c2", ["src/orders/cart.ts"]));
    board.post(
      msg("engine", "integrated.rev", {
        commit: "r2",
        gate: "fail",
        merged: ["c2"],
        failing: { output: "src/orders/cart.ts(50,3): error TS2339: Property 'user' does not exist on type 'Ctx'.\n", items: ["cart"] },
      }),
    );
    expect(seamContractCue(board.state, "cart")?.seams).toEqual(["src/store.ts"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("the active-claim cap (no hoarding)", () => {
  function capped(cap = 1): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { maxActiveClaims: cap } }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    for (const item of ["one", "two", "three"]) {
      board.post(msg("lead", "item.proposed", { item, objective: `do ${item}`, acceptance: ["ok"], scopeHint: [`src/${item}/**`] }));
    }
    return board;
  }

  it("an agent holding an unfinished item cannot claim another until its push passed; the digest says why", () => {
    const board = capped();
    expect(board.state.rules.maxActiveClaims).toBe(1);
    board.post(claim("a", "one", ["src/one/**"]));
    board.reject(claim("a", "two", ["src/two/**"]), /holds 1 unfinished item\(s\) \(one; cap 1\)/, "CLAIM_CAP");
    expect(boardDigest(board.state, board.log, "a", 0).claimCap).toMatchObject({ cap: 1, holding: ["one"] });
    expect(boardDigest(board.state, board.log, "b", 0).claimCap).toBeUndefined();
    // Another agent takes the open work.
    expect(board.types(claim("b", "two", ["src/two/**"]))).toEqual(["item.claimed", "claim.granted"]);
    // A push alone does not finish it; a failing revision does not either.
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.reject(claim("a", "three", ["src/three/**"]), /cap 1/, "CLAIM_CAP");
    // Passing: the item is finished (done once proposed), so a has room again.
    board.post(rev("pass", ["c1"], "r1"));
    expect(activeClaims(board.state, "a")).toEqual([]);
    expect(board.types(claim("a", "three", ["src/three/**"]))).toEqual(["item.claimed", "claim.granted"]);
    // A handoff to an agent at its cap is refused.
    board.reject(msg("a", "handoff", { item: "three", to: "b", capsule: { repo: "r" } }), /at its active-claim cap/, "CLAIM_CAP");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("without the rule (a board posted before it) claims are unlimited, as before", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/one/**"]));
    expect(board.types(claim("a", "two", ["src/two/**"]))).toEqual(["item.claimed", "claim.granted"]);
    expect(claimCapReached(board.state, "a")).toBeUndefined();
  });
});

describe("integration plans for an agent that lost an item", () => {
  it("files it pushed for an item it no longer holds (reopened, lapsed, re-planned) are yielded, never applied from its repo", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { maxFixAttempts: 1 } }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "one", objective: "o", acceptance: [], scopeHint: ["src/one/**"] }));
    board.post(msg("lead", "item.proposed", { item: "two", objective: "t", acceptance: [], scopeHint: ["src/two/**"] }));
    board.post(claim("a", "one", ["src/one/**"]));
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], failing: { output: "x", items: ["one"] } }));
    board.post(push("a", "one", "c2", ["src/one/x.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c2"], failing: { output: "x", items: ["one"] } }));
    expect(board.state.items.one!.status).toBe("open");
    // a moves on: its repo still carries src/one/x.ts, which is no longer its to apply.
    board.post(claim("a", "two", ["src/two/**"]));
    board.post(push("a", "two", "c3", ["src/two/y.ts"]));
    const unit = planBoardIntegration(board.log, board.state).units.find((u) => u.agent === "a")!;
    expect(unit).toMatchObject({ commit: "c3", scope: ["src/two/**"], yieldedScope: ["src/one/x.ts"] });
  });
});

describe("integration plans after a sub-lead merge", () => {
  it("a child owner's later push on another item diffs from its child commit the sub-lead's passing push integrated", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a/**"]));
    board.post(msg("a", "item.split", { item: "one", children: [{ item: "one-x", objective: "x", scopeHint: ["src/a/x.ts"] }] }));
    board.post(claim("b", "one-x", ["src/a/x.ts"]));
    board.post(push("b", "one-x", "px", ["src/a/x.ts"]));
    board.post(msg("a", "push.announced", { item: "one", commit: "pa", paths: ["src/a/x.ts"], merges: [{ item: "one-x", commit: "px" }] }));
    board.post(rev("pass", ["pa"], "r1"));
    board.post(claim("b", "two", ["src/b/**"]));
    board.post(push("b", "two", "pb", ["src/b/y.ts"]));
    const unit = planBoardIntegration(board.log, board.state).units.find((u) => u.agent === "b")!;
    expect(unit).toMatchObject({ commit: "pb", baselineRef: "px", scope: ["src/b/**"] });
  });
});

describe("claim leases: a claim stays live only while its holder makes progress", () => {
  /** Post `n` messages that touch none of `one`: b proposes items (proposals wait for the lead). */
  function chatter(board: TestBoard, n: number, from = "b"): BoardMessage[] {
    const out: BoardMessage[] = [];
    for (let k = 0; k < n; k += 1) {
      out.push(...board.post(msg(from, "item.proposed", { item: `${from}-idea-${board.state.lastSeq}`, objective: "an idea", acceptance: [], scopeHint: ["docs/**"] })));
    }
    return out;
  }

  it("lapses after the lease with no progress: typed, addressed to the holder, the item open again with its push to start from", () => {
    const board = seeded({ claimLeaseMessages: 6 });
    const granted = board.post(claim("a", "one", ["src/one.ts"])).find((m) => m.type === "claim.granted")!;
    expect(board.state.items.one!.lease).toEqual({ progressSeq: granted.seq, extensions: 0 });
    // A push, then a failing revision gates it (progress), then nothing from a.
    board.post(push("a", "one", "c1", ["src/one.ts"]));
    const failed = board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], failing: { output: "boom", items: ["one"] } }));
    const gatedAt = failed[0]!.seq;
    expect(board.state.items.one!.lease!.progressSeq).toBe(gatedAt);
    // Idle chatter elsewhere does not renew it.
    const appended = chatter(board, 6);
    const lapsed = appended.find((m) => m.type === "claim.lapsed");
    expect(lapsed).toMatchObject({
      from: "engine",
      to: ["a"],
      payload: { item: "one", agent: "a", reason: "no-progress", lastProgressSeq: gatedAt, commit: "c1" },
    });
    expect(lapsed!.seq - gatedAt).toBeGreaterThanOrEqual(6);
    const item = board.state.items.one!;
    expect(item.status).toBe("open");
    expect(item.owner).toBeUndefined();
    expect(item.lease).toBeUndefined();
    expect(item.lastLapse).toMatchObject({ agent: "a", reason: "no-progress", lastProgressSeq: gatedAt });
    expect(item.reopenedFrom).toEqual({ agent: "a", commit: "c1" });
    expect(item.stallReleases).toBe(1);
    // Another agent takes it first: the lapsed holder is refused for one lease period.
    board.reject(claim("a", "one", ["src/one.ts"]), /a's claim on one lapsed at seq \d+: another agent takes it first/, "NOT_ALLOWED");
    board.post(claim("c", "one", ["src/one.ts"]));
    expect(board.state.items.one).toMatchObject({ status: "claimed", owner: "c" });
    expect(board.state.items.one!.lastLapse).toBeUndefined();
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("only the holder's real progress renews: its push, a message naming the item; another agent's messages never do", () => {
    const board = seeded({ claimLeaseMessages: 4 });
    board.post(claim("a", "one", ["src/one.ts"]));
    chatter(board, 3);
    // a reports the item struggling: progress, the lease runs from here.
    const report = board.post(msg("a", "item.struggling", { item: "one", turnsSpent: 3, failedEdits: 1, reason: "failed-edits" }))[0]!;
    expect(board.state.items.one!.lease!.progressSeq).toBe(report.seq);
    chatter(board, 2);
    expect(board.state.items.one!.status).toBe("claimed");
    // a talks about another item: no renewal.
    board.post(claim("a", "two", ["src/two.ts"]));
    expect(board.state.items.one!.lease!.progressSeq).toBe(report.seq);
    const appended = chatter(board, 1);
    expect(appended.map((m) => m.type)).toContain("claim.lapsed");
    expect(board.state.items.one!.status).toBe("open");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("never lapses while its push waits for the gate or a contract for it waits for a decision", () => {
    const board = seeded({ claimLeaseMessages: 3 });
    board.post(claim("a", "one", ["src/one.ts"]));
    board.post(push("a", "one", "c1", ["src/one.ts"]));
    expect(leaseSuspension(board.state, board.state.items.one!)).toBe("its push waits for the gate");
    chatter(board, 6);
    expect(board.state.items.one!.status).toBe("claimed");
    expect(leaseLapse(board.state, "one", board.state.lastSeq + 100)).toBeUndefined();
    // Gated (pass) and finished: still no lapse while only the done proposal is left.
    board.post(rev("pass", ["c1"], "r1"));
    expect(leaseSuspension(board.state, board.state.items.one!)).toBe("its push passed");
    chatter(board, 6);
    expect(board.state.items.one!.status).toBe("claimed");
    // A pending contract for an item suspends it too.
    board.post(claim("b", "two", ["src/two.ts"]));
    board.post(msg("b", "contract.proposed", { contract: "k1", target: "src/api.ts", kind: "modify", item: "two" }));
    chatter(board, 6, "c");
    expect(board.state.items.two!.status).toBe("claimed");
    board.post(msg("lead", "contract.rejected", { contract: "k1" }, { rationale: "no" }));
    // The decision renews the lease; it then runs again.
    expect(board.state.items.two!.lease!.progressSeq).toBe(board.state.lastSeq);
    chatter(board, 3, "c");
    expect(board.state.items.two!.status).toBe("open");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("the firm deadline is not renewed by progress: the lead extends it with a reason (bounded) or it lapses", () => {
    const board = seeded({ claimDeadlineMessages: 20 });
    const granted = board.post(claim("a", "one", ["src/one.ts"])).find((m) => m.type === "claim.granted")!;
    expect(board.state.items.one!.lease).toEqual({ progressSeq: granted.seq, deadlineSeq: granted.seq + 20, extensions: 0 });
    chatter(board, 14);
    // Progress does not move the deadline.
    board.post(msg("a", "item.struggling", { item: "one", turnsSpent: 1, failedEdits: 0, reason: "turn-budget" }));
    chatter(board, 1);
    expect(board.state.items.one!.lease!.deadlineSeq).toBe(granted.seq + 20);
    // Near the deadline the lead sees it, with the holder progressing.
    expect(boardDigest(board.state, board.log, "lead", 0).deadlines).toEqual([
      expect.objectContaining({ item: "one", owner: "a", deadlineSeq: granted.seq + 20, extensions: 0, progressing: true }),
    ]);
    expect(boardDigest(board.state, board.log, "b", 0).deadlines).toBeUndefined();
    board.reject(msg("b", "claim.extended", { item: "one", reason: "r" }), /cannot be sent by an agent/, "NOT_ALLOWED");
    const ext = board.post(msg("lead", "claim.extended", { item: "one", reason: "it reports progress" }))[0]!;
    expect(board.state.items.one!.lease).toMatchObject({ deadlineSeq: ext.seq + 20, extensions: 1 });
    board.post(msg("lead", "claim.extended", { item: "one", reason: "still moving" }));
    board.reject(msg("lead", "claim.extended", { item: "one", reason: "again" }), /already extended 2 times/, "LIMIT");
    const appended = chatter(board, 20);
    expect(appended.find((m) => m.type === "claim.lapsed")).toMatchObject({ payload: { item: "one", reason: "deadline" } });
    expect(board.state.items.one!.status).toBe("open");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("on a quiet board the operator records a stalled claim (no message count advances): refused while suspended or just progressed", () => {
    const board = seeded({ claimLeaseMessages: 100 });
    board.post(claim("a", "one", ["src/one.ts"]));
    chatter(board, 1);
    board.reject(msg("engine", "claim.lapsed", { item: "one", agent: "a" }), /a stalled claim record is \{item\}/, "BAD_PAYLOAD");
    const appended = board.post(msg("engine", "claim.lapsed", { item: "one" }));
    expect(appended[0]).toMatchObject({ from: "engine", type: "claim.lapsed", to: ["a"], payload: { item: "one", agent: "a", reason: "stalled" } });
    expect(board.state.items.one!.status).toBe("open");
    // A pushed claim waiting for the gate is never recorded stalled.
    board.post(claim("b", "two", ["src/two.ts"]));
    board.post(push("b", "two", "c2", ["src/two.ts"]));
    chatter(board, 1, "c");
    board.reject(msg("engine", "claim.lapsed", { item: "two" }), /its push waits for the gate/, "INVALID_STATE");
    // Without lease rules there is nothing to record.
    const plain = seeded();
    plain.post(claim("a", "one", ["src/one.ts"]));
    chatter(plain, 1);
    plain.reject(msg("engine", "claim.lapsed", { item: "one" }), /no leased claim/, "INVALID_STATE");
    // Replay accepts the recorded (stalled) lapse, never a forged derived one.
    expect(reduceBoard(board.log)).toEqual(board.state);
    const forged = board.log.map((m) => (m.type === "claim.lapsed" ? ({ ...m, payload: { ...m.payload, reason: "no-progress" } } as BoardMessage) : m));
    expect(() => reduceBoard(forged)).toThrow(/was not produced by arbitration/);
  });

  for (const arbitration of [3, 4]) {
    it(`after a stalled lapse with every other agent capped, the holder's re-claim is ${arbitration === 4 ? "accepted (revision 4)" : "refused for the cooldown (revision 3)"}`, () => {
      const board = seeded({ claimLeaseMessages: 100, maxActiveClaims: 1, arbitration });
      board.post(claim("a", "one", ["src/one.ts"]));
      board.post(claim("b", "two", ["src/two.ts"]));
      board.post(claim("c", "three", ["src/three.ts"]));
      chatter(board, 1);
      board.post(msg("engine", "claim.lapsed", { item: "one" }));
      expect(board.state.items.one).toMatchObject({ status: "open", lastLapse: { agent: "a", reason: "stalled" } });
      // b and c each hold an unfinished item at a cap of one: nobody else can take it.
      expect(claimCapReached(board.state, "b")).toBeDefined();
      expect(claimCapReached(board.state, "c")).toBeDefined();
      if (arbitration === 4) {
        expect(board.types(claim("a", "one", ["src/one.ts"]))).toEqual(["item.claimed", "claim.granted"]);
        expect(reduceBoard(board.log)).toEqual(board.state);
      } else {
        board.reject(claim("a", "one", ["src/one.ts"]), /a's claim on one lapsed at seq \d+: another agent takes it first/, "NOT_ALLOWED");
      }
    });
  }

  it("revision 4 keeps the cooldown when another agent could take the stalled item, or the lapse was not a stall", () => {
    const board = seeded({ claimLeaseMessages: 100, maxActiveClaims: 1, arbitration: 4 });
    board.post(claim("a", "one", ["src/one.ts"]));
    board.post(claim("b", "two", ["src/two.ts"]));
    chatter(board, 1, "c");
    board.post(msg("engine", "claim.lapsed", { item: "one" }));
    // c holds nothing: it can take the item, so a waits for it (or the cooldown).
    board.reject(claim("a", "one", ["src/one.ts"]), /another agent takes it first/, "NOT_ALLOWED");
  });

  it("a claim on a seam item is leased too: an absent owner never blocks importers forever", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { claimLeaseMessages: 4 }, seams: [{ path: "src/contracts.ts", importers: ["src/a.ts"] }] }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "feat", objective: "f", acceptance: [], scopeHint: ["src/a.ts"] }));
    board.post(claim("a", "feat", ["src/a.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r0", gate: "fail", merged: [] }));
    board.post(msg("a", "contract.proposed", { contract: "k", target: "src/contracts.ts", kind: "modify", item: "feat", description: "add a field" }));
    board.post(msg("lead", "contract.accepted", { contract: "k" }));
    expect(board.state.items["seam-k"]).toMatchObject({ status: "claimed", owner: "a" });
    expect(board.state.items["seam-k"]!.lease).toBeDefined();
    chatter(board, 6);
    expect(board.state.items["seam-k"]!.status).toBe("open");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("the digest states the lease; boards without the rule never lapse and carry no lease", () => {
    const leased = seeded({ claimLeaseMessages: 10 });
    const granted = leased.post(claim("a", "one", ["src/one.ts"])).find((m) => m.type === "claim.granted")!;
    expect(boardDigest(leased.state, leased.log, "a", 0).claims[0]!.lease).toMatchObject({ lastProgressSeq: granted.seq, lapsesAt: granted.seq + 10 });
    const plain = seeded();
    plain.post(claim("a", "one", ["src/one.ts"]));
    chatter(plain, 30);
    expect(plain.state.items.one).toMatchObject({ status: "claimed", owner: "a" });
    expect(plain.state.items.one!.lease).toBeUndefined();
    expect(boardDigest(plain.state, plain.log, "a", 0).claims[0]!.lease).toBeUndefined();
    expect(plain.log.some((m) => m.type === "claim.lapsed")).toBe(false);
  });
});

describe("every waiting item states why (derived from recorded state only)", () => {
  it("open items: unclaimed, the claim cap, a lapsed lease, a spent fix budget", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { maxActiveClaims: 1, claimLeaseMessages: 3, maxFixAttempts: 1 } }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    for (const item of ["one", "two", "three"]) {
      board.post(msg("lead", "item.proposed", { item, objective: `do ${item}`, acceptance: [], scopeHint: [`src/${item}/**`] }));
    }
    expect(itemWaitReason(board.state, "three")).toEqual({ kind: "unclaimed" });
    board.post(claim("a", "one", ["src/one/**"]));
    board.post(claim("b", "two", ["src/two/**"]));
    // Both workers are at their cap: nobody can take three.
    expect(itemWaitReason(board.state, "three")).toEqual({ kind: "held-by-claim-cap", agents: 2 });
    expect(boardDigest(board.state, board.log, "a", 0).openItems.find((i) => i.item === "three")!.wait).toEqual({
      reason: { kind: "held-by-claim-cap", agents: 2 },
      line: "open, but all 2 agent(s) are at their claim cap",
    });
    // a pushes; the revision fails and spends one's single fix attempt on the second failure.
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    expect(itemWaitReason(board.state, "one")).toEqual({ kind: "waiting-for-gate", commit: "c1" });
    expect(describeWaitReason(itemWaitReason(board.state, "one")!)).toBe("push c1 waits for the gate");
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], failing: { output: "x", items: ["one"] } }));
    expect(itemWaitReason(board.state, "one")).toBeUndefined(); // its holder fixes it next: moving
    board.post(push("a", "one", "c2", ["src/one/x.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c2"], failing: { output: "x", items: ["one"] } }));
    expect(board.state.items.one!.status).toBe("open");
    expect(itemWaitReason(board.state, "one")).toEqual({ kind: "fix-budget-exhausted", by: ["a"] });
    // b's claim on two lapses (no progress for the lease): open, saying so.
    board.post(msg("a", "item.proposed", { item: "a-x", objective: "x", acceptance: [], scopeHint: ["docs/**"] }));
    board.post(msg("a", "item.proposed", { item: "a-y", objective: "y", acceptance: [], scopeHint: ["docs/y/**"] }));
    expect(itemWaitReason(board.state, "a-x")).toEqual({ kind: "waiting-for-lead" });
    expect(board.state.items.two!.status).toBe("open");
    expect(itemWaitReason(board.state, "two")).toMatchObject({ kind: "lease-lapsed", agent: "b", reason: "no-progress" });
    expect(boardDigest(board.state, board.log, "a", 0).openItems.find((i) => i.item === "two")!.wait!.line).toMatch(/^b's claim lapsed \(no progress since seq \d+\): open to take$/);
  });

  it("held items: a human or the lead decides first, a contest blocks, a split waits on its children, seam first", () => {
    const board = new TestBoard();
    board.post(
      msg("human", "goal.posted", {
        objective: "o",
        protected: ["tests/a.test.ts"],
        seams: [{ path: "src/contracts.ts", importers: ["src/feat/a.ts"] }],
      }),
    );
    for (const agent of ["a", "b", "c"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "tests", objective: "t", acceptance: [], scopeHint: ["src/t.ts", "tests/a.test.ts"] }));
    board.post(msg("lead", "item.proposed", { item: "split-me", objective: "s", acceptance: [], scopeHint: ["src/s/**"] }));
    board.post(msg("lead", "item.proposed", { item: "feat", objective: "f", acceptance: [], scopeHint: ["src/feat/a.ts"] }));
    board.post(claim("a", "tests", ["src/t.ts"]));
    board.post(msg("a", "contract.proposed", { contract: "k1", target: "tests/a.test.ts", kind: "modify", item: "tests" }));
    expect(itemWaitReason(board.state, "tests")).toEqual({ kind: "waiting-for-human", contract: "k1" });
    // A contest: c's claim waits on b's item.
    board.post(claim("b", "split-me", ["src/s/**"]));
    board.post(msg("b", "item.split", { item: "split-me", children: [{ item: "s1", objective: "s1", scopeHint: ["src/s/1.ts"] }] }));
    expect(itemWaitReason(board.state, "split-me")).toEqual({ kind: "blocked-by", item: "s1" });
    board.post(claim("c", "feat", ["src/feat/a.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r0", gate: "fail", merged: [] }));
    board.post(msg("c", "contract.proposed", { contract: "k2", target: "src/contracts.ts", kind: "modify", item: "feat", description: "add a field" }));
    expect(itemWaitReason(board.state, "feat")).toEqual({ kind: "waiting-for-lead", contract: "k2" });
    board.post(msg("lead", "contract.accepted", { contract: "k2" }));
    // The seam item (granted to c) holds feat until its push is gated.
    expect(itemWaitReason(board.state, "feat")).toEqual({ kind: "waiting-on-seam", item: "seam-k2", seams: ["src/contracts.ts"] });
    expect(boardDigest(board.state, board.log, "c", 0).claims.find((x) => x.item === "feat")!.wait!.line).toBe("waits on the seam change seam-k2 (src/contracts.ts)");
    expect(itemWaitReason(board.state, "nope")).toBeUndefined();
  });
});

describe("re-plan an item instead of giving up (one bounded re-plan, then a human)", () => {
  /** A board where item `one` spent its single fix attempt (a held, then reopened by exhaustion). */
  function exhausted(): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { maxFixAttempts: 1 } }));
    for (const agent of ["a", "b", "c"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "one", objective: "do one", acceptance: [], scopeHint: ["src/one/**"] }));
    board.post(msg("lead", "item.proposed", { item: "two", objective: "do two", acceptance: [], scopeHint: ["src/two/**"] }));
    board.post(claim("a", "one", ["src/one/**"]));
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c1"], failing: { output: "src/one/x.ts failed", items: ["one"] } }));
    board.post(push("a", "one", "c2", ["src/one/x.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c2"], failing: { output: "src/one/y.ts failed", items: ["one"] } }));
    return board;
  }

  it("the lead sees the item to re-plan with its failure attribution, and splits it: the children carry it to completion", () => {
    const board = exhausted();
    expect(board.state.items.one).toMatchObject({ status: "open", exhaustedBy: ["a"], failedRev: 2 });
    expect(replanEligible(board.state, "one")).toBe("fix-budget-exhausted");
    expect(boardDigest(board.state, board.log, "lead", 0).replan).toEqual([
      expect.objectContaining({ item: "one", reason: "fix-budget-exhausted", rev: 2, scopeHint: ["src/one/**"], exhaustedBy: ["a"], neighbours: [expect.objectContaining({ item: "two" })] }),
    ]);
    expect(boardDigest(board.state, board.log, "a", 0).replan).toBeUndefined();
    board.reject(msg("a", "item.replanned", { item: "one", reason: "fix-budget-exhausted", action: "split", children: [] }), /children must be a non-empty array/, "BAD_PAYLOAD");
    board.reject(
      msg("a", "item.replanned", { item: "one", reason: "fix-budget-exhausted", action: "rescope", children: [{ item: "one-r", objective: "o", scopeHint: ["src/one/**"] }] }),
      /cannot be sent by an agent/,
      "NOT_ALLOWED",
    );
    board.reject(
      msg("lead", "item.replanned", { item: "one", reason: "stalled", action: "rescope", children: [{ item: "one-r", objective: "o", scopeHint: ["src/one/**"] }] }),
      /re-planned for fix-budget-exhausted, not stalled/,
      "LOG_MISMATCH",
    );
    board.reject(
      msg("lead", "item.replanned", { item: "one", reason: "fix-budget-exhausted", action: "split", children: [{ item: "one-r", objective: "o", scopeHint: ["src/one/**"] }] }),
      /at least two children/,
      "BAD_PAYLOAD",
    );
    board.reject(msg("lead", "item.replanned", { item: "two", reason: "stalled", action: "rescope", children: [{ item: "two-r", objective: "o", scopeHint: ["src/two/**"] }] }), /only an open item whose fix budget was spent/, "INVALID_STATE");
    board.post(
      msg(
        "lead",
        "item.replanned",
        {
          item: "one",
          reason: "fix-budget-exhausted",
          action: "split",
          rev: 2,
          children: [
            { item: "one-x", objective: "fix x", acceptance: ["x passes"], scopeHint: ["src/one/x.ts"] },
            { item: "one-y", objective: "fix y", acceptance: ["y passes"], scopeHint: ["src/one/y.ts"] },
          ],
        },
        { rationale: "revision 2 fails in y, which the item never touched" },
      ),
    );
    expect(board.state.items.one).toMatchObject({ status: "split", children: ["one-x", "one-y"], replanned: { action: "split", reason: "fix-budget-exhausted", by: "lead" } });
    expect(board.state.items["one-x"]).toMatchObject({ status: "open", parent: "one", replanOf: "one" });
    expect(itemWaitReason(board.state, "one")).toEqual({ kind: "blocked-by", item: "one-x" });
    // Re-planned once: never again.
    board.reject(msg("lead", "item.replanned", { item: "one", reason: "fix-budget-exhausted", action: "rescope", children: [{ item: "one-z", objective: "o", scopeHint: ["src/one/**"] }] }), /only an open item/, "INVALID_STATE");
    // The children integrate directly (no sub-lead) and the re-planned item completes with them.
    board.post(claim("b", "one-x", ["src/one/x.ts"]));
    board.post(claim("c", "one-y", ["src/one/y.ts"]));
    complete(board, "b", "one-x", "cx", "src/one/x.ts");
    const last = complete(board, "c", "one-y", "cy", "src/one/y.ts");
    expect(last.filter((m) => m.type === "item.completed").map((m) => (m.payload as { item: string }).item)).toEqual(["one-y", "one"]);
    expect(board.state.items.one!.status).toBe("done");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a merge replaces the item and an open neighbour with one item; both complete with it", () => {
    const board = exhausted();
    board.post(
      msg("lead", "item.replanned", {
        item: "one",
        reason: "fix-budget-exhausted",
        action: "merge",
        with: "two",
        children: [{ item: "one-two", objective: "do one and two together", acceptance: [], scopeHint: ["src/one/**", "src/two/**"] }],
      }),
    );
    expect(board.state.items.two).toMatchObject({ status: "split", children: ["one-two"], replanned: { action: "merge", into: "one-two" } });
    expect(board.state.items["one-two"]).toMatchObject({ replaces: ["one", "two"], parent: "one" });
    board.post(claim("b", "one-two", ["src/one/**", "src/two/**"]));
    const done = complete(board, "b", "one-two", "m1", "src/two/z.ts");
    expect(done.filter((m) => m.type === "item.completed").map((m) => (m.payload as { item: string }).item)).toEqual(["one-two", "one", "two"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("released for not moving twice makes an item re-plannable too (reason stalled)", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { claimLeaseMessages: 100 } }));
    for (const agent of ["a", "b", "c"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "one", objective: "do one", acceptance: [], scopeHint: ["src/one/**"] }));
    for (const agent of ["a", "b"]) {
      board.post(claim(agent, "one", ["src/one/**"]));
      board.post(msg("c", "item.proposed", { item: `c-${agent}`, objective: "x", acceptance: [], scopeHint: ["docs/**"] }));
      board.post(msg("engine", "claim.lapsed", { item: "one" }));
    }
    expect(board.state.items.one!.stallReleases).toBe(2);
    expect(replanEligible(board.state, "one")).toBe("stalled");
    board.post(msg("lead", "item.replanned", { item: "one", reason: "stalled", action: "rescope", children: [{ item: "one-r", objective: "do one, smaller", acceptance: [], scopeHint: ["src/one/a.ts"] }] }));
    expect(board.state.items["one-r"]).toMatchObject({ status: "open", replanOf: "one" });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("an item whose per-item call cap was reached is re-plannable while still held (reason item-cap), and the children start fresh", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o" }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "one", objective: "do one", acceptance: [], scopeHint: ["src/one/**"] }));
    board.post(msg("lead", "item.proposed", { item: "two", objective: "do two", acceptance: [], scopeHint: ["src/two/**"] }));
    board.post(claim("a", "one", ["src/one/**"]));
    expect(replanEligible(board.state, "one")).toBeUndefined();
    // A run-wide cap is not an item's: only an item-calls cap of THIS item counts.
    board.post(msg("engine", "run.capped", { kind: "model-calls", limit: 10, used: 10 }));
    board.post(msg("engine", "run.capped", { kind: "item-calls", limit: 4, used: 5, item: "two" }));
    expect(replanEligible(board.state, "one")).toBeUndefined();
    board.post(msg("engine", "run.capped", { kind: "item-calls", limit: 4, used: 5, item: "one" }));
    expect(board.state.items.one!.status).toBe("claimed");
    expect(replanEligible(board.state, "one")).toBe("item-cap");
    expect(replanEligible(board.state, "two")).toBe("item-cap");
    expect(boardDigest(board.state, board.log, "lead", 0).replan?.map((r) => [r.item, r.reason])).toEqual([
      ["one", "item-cap"],
      ["two", "item-cap"],
    ]);
    board.reject(
      msg("lead", "item.replanned", { item: "one", reason: "stalled", action: "rescope", children: [{ item: "one-r", objective: "o", scopeHint: ["src/one/**"] }] }),
      /re-planned for item-cap, not stalled/,
      "LOG_MISMATCH",
    );
    board.post(
      msg("lead", "item.replanned", {
        item: "one",
        reason: "item-cap",
        action: "split",
        children: [
          { item: "one-a", objective: "do one, part a", acceptance: [], scopeHint: ["src/one/a.ts"] },
          { item: "one-b", objective: "do one, part b", acceptance: [], scopeHint: ["src/one/b.ts"] },
        ],
      }),
    );
    expect(board.state.items.one).toMatchObject({ status: "split", replanned: { reason: "item-cap", action: "split" } });
    // The children are new items (their own call counts): claimable, and not re-plannable themselves.
    expect(board.state.items["one-a"]).toMatchObject({ status: "open", replanOf: "one" });
    expect(replanEligible(board.state, "one-a")).toBeUndefined();
    board.post(claim("b", "one-a", ["src/one/a.ts"]));
    // Re-planned once (split): never again, whatever its cap says.
    expect(replanEligible(board.state, "one")).toBeUndefined();
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a re-plan that fails again escalates to a human (an escalation record), and is never re-planned again", () => {
    const board = exhausted();
    board.post(msg("lead", "item.replanned", { item: "one", reason: "fix-budget-exhausted", action: "rescope", children: [{ item: "one-r", objective: "redo one", acceptance: [], scopeHint: ["src/one/**"] }] }));
    board.post(claim("b", "one-r", ["src/one/**"]));
    board.post(push("b", "one-r", "d1", ["src/one/x.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r3", gate: "fail", merged: ["d1"], failing: { output: "still", items: ["one-r"] } }));
    board.post(push("b", "one-r", "d2", ["src/one/x.ts"]));
    const appended = board.post(msg("engine", "integrated.rev", { commit: "r4", gate: "fail", merged: ["d2"], failing: { output: "still", items: ["one-r"] } }));
    expect(appended.map((m) => m.type)).toEqual(["integrated.rev", "fix.exhausted", "item.reopened", "item.escalated"]);
    expect(appended.at(-1)!.payload).toEqual({ item: "one-r", reason: "replan-failed", replanOf: "one" });
    expect(replanEligible(board.state, "one-r")).toBeUndefined();
    board.reject(msg("lead", "item.replanned", { item: "one-r", reason: "fix-budget-exhausted", action: "rescope", children: [{ item: "one-rr", objective: "o", scopeHint: ["src/one/**"] }] }), /a second failure escalates to a human/, "NOT_ALLOWED");
    const raised = applyBoardEscalations([], appended, 0);
    expect(raised.raised).toEqual([expect.objectContaining({ kind: "decision", boardItem: "one-r", status: "pending", options: ["acknowledge"] })]);
    // Another agent finishes it: the escalation closes as completed.
    board.post(claim("c", "one-r", ["src/one/**"]));
    const done = complete(board, "c", "one-r", "d3", "src/one/x.ts");
    expect(applyBoardEscalations(raised.list, done, 1).list[0]).toMatchObject({ status: "resolved", decision: "completed" });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("overlap check at claim time (advisory; a shared seam goes through its contract)", () => {
  function overlapping(rules: Record<string, unknown> = { claimOverlap: true }): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules, seams: [{ path: "src/shared/ctx.ts", importers: ["src/a/x.ts"] }] }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "one", objective: "o", acceptance: [], scopeHint: ["src/a/**", "src/shared/**"] }));
    board.post(msg("lead", "item.proposed", { item: "two", objective: "t", acceptance: [], scopeHint: ["src/b/**", "src/shared/**"] }));
    board.post(msg("lead", "item.proposed", { item: "three", objective: "th", acceptance: [], scopeHint: ["src/c/**"] }));
    return board;
  }

  it("a claim whose item scope overlaps another holder's is granted and recorded for both, never refused", () => {
    const board = overlapping();
    board.post(claim("a", "one", ["src/a/**"]));
    expect(boardDigest(board.state, board.log, "b", 0).openItems.find((i) => i.item === "two")!.overlapsClaimed).toEqual(["one"]);
    expect(boardDigest(board.state, board.log, "b", 0).openItems.find((i) => i.item === "three")!.overlapsClaimed).toBeUndefined();
    const appended = board.post(claim("b", "two", ["src/b/**"]));
    expect(appended.map((m) => m.type)).toEqual(["item.claimed", "claim.granted", "claim.overlap"]);
    expect(appended[2]).toMatchObject({ from: "engine", to: ["b", "a"], payload: { item: "two", agent: "b", with: "one", withAgent: "a", files: ["src/shared/**"] } });
    // Both digests say so.
    expect(boardDigest(board.state, board.log, "a", 0).claims[0]!.overlaps).toEqual([expect.objectContaining({ item: "two", agent: "b", files: ["src/shared/**"] })]);
    expect(boardDigest(board.state, board.log, "b", 0).claims[0]!.overlaps![0]!.hint).toMatch(/a holds one, whose scope overlaps yours on src\/shared\/\*\*: coordinate/);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a claim writing a shared seam another holder's scope covers is refused, pointing at the seam route", () => {
    const board = overlapping();
    board.post(claim("a", "one", ["src/a/**"]));
    board.reject(claim("b", "two", ["src/b/**", "src/shared/ctx.ts"]), /both touch the shared seam src\/shared\/ctx\.ts: .*propose a seam contract/, "SEAM_OVERLAP");
    // Without the rule (a board posted before it) nothing changes.
    const plain = overlapping({});
    plain.post(claim("a", "one", ["src/a/**"]));
    expect(plain.types(claim("b", "two", ["src/b/**", "src/shared/ctx.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    expect(boardDigest(plain.state, plain.log, "b", 0).claims[0]!.overlaps).toBeUndefined();
  });
});

describe("clash alerts from real code (recorded predictions, advisory)", () => {
  function pushed(): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", seams: [{ path: "src/shared/ctx.ts", importers: ["src/a/x.ts"] }] }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "one", objective: "o", acceptance: [], scopeHint: ["src/a/**", "src/shared/ctx.ts"] }));
    board.post(msg("lead", "item.proposed", { item: "two", objective: "t", acceptance: [], scopeHint: ["src/b/**", "src/common.ts"] }));
    board.post(claim("a", "one", ["src/a/**", "src/shared/ctx.ts"]));
    board.post(claim("b", "two", ["src/b/**", "src/common.ts"]));
    board.post(push("a", "one", "aaa1", ["src/a/x.ts"]));
    board.post(push("b", "two", "bbb1", ["src/b/y.ts"]));
    return board;
  }
  const record = (payload: Record<string, unknown>) => msg("engine", "clash.predicted", payload);
  const heads = { a: { agent: "a", item: "one", sha: "aaa1" }, b: { agent: "b", item: "two", sha: "bbb1" } };

  it("a conflict between two pending pushes is recorded once, addressed to both, with each digest's cue", () => {
    const board = pushed();
    const appended = board.post(record({ ...heads, status: "conflict", paths: ["src/common.ts"], scope: "local" }));
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ from: "engine", type: "clash.predicted", to: ["a", "b"] });
    board.reject(record({ a: heads.b, b: heads.a, status: "unknown", reason: "timeout" }), /already predicted/, "DUPLICATE");
    // b claimed later: it rebases.
    expect(boardDigest(board.state, board.log, "b", 0).claims[0]!.clashes).toEqual([
      expect.objectContaining({ item: "one", agent: "a", status: "conflict", paths: ["src/common.ts"], scope: "local", hint: expect.stringMatching(/you claimed later, so rebase onto its push/) }),
    ]);
    expect(boardDigest(board.state, board.log, "a", 0).claims[0]!.clashes![0]!.hint).toMatch(/it claimed later and rebases onto yours/);
    // A new push supersedes the prediction: the cue is gone.
    board.post(push("b", "two", "bbb2", ["src/b/y.ts"]));
    expect(boardDigest(board.state, board.log, "b", 0).claims[0]!.clashes).toBeUndefined();
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a shared-seam conflict points at the seam contract; the scope must match the board's seams", () => {
    const board = pushed();
    board.reject(record({ ...heads, status: "conflict", paths: ["src/shared/ctx.ts"], scope: "local" }), /scoped shared/, "LOG_MISMATCH");
    board.post(record({ ...heads, status: "conflict", paths: ["src/shared/ctx.ts"], scope: "shared" }));
    expect(boardDigest(board.state, board.log, "a", 0).claims[0]!.clashes![0]!.hint).toMatch(/shared seam src\/shared\/ctx\.ts: propose or consult the seam contract/);
  });

  it("an undecided or unavailable prediction is recorded as such, never as clean; only pending pushes", () => {
    const board = pushed();
    board.reject(record({ ...heads, status: "unknown" }), /says why/, "BAD_PAYLOAD");
    board.reject(record({ ...heads, status: "clean" }), /status must be one of conflict, unknown, unavailable/, "BAD_PAYLOAD");
    board.post(record({ ...heads, status: "unavailable", reason: "git older than 2.38: merge-tree --write-tree unavailable" }));
    expect(boardDigest(board.state, board.log, "a", 0).claims[0]!.clashes![0]).toMatchObject({ status: "unavailable", hint: expect.stringMatching(/could not be decided/) });
    board.post(rev("pass", ["aaa1"], "r1"));
    board.post(push("b", "two", "bbb3", ["src/b/y.ts"]));
    board.post(push("a", "one", "aaa2", ["src/a/x.ts"]));
    board.reject(record({ a: { agent: "a", item: "one", sha: "aaa1" }, b: { agent: "b", item: "two", sha: "bbb3" }, status: "unknown", reason: "x" }), /not a's pending push/, "INVALID_STATE");
  });
});

describe("trunk-moved and stale checks", () => {
  function based(): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", baseline: "base0" }));
    for (const agent of ["a", "b"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    for (const item of ["one", "two"]) {
      board.post(msg("lead", "item.proposed", { item, objective: item, acceptance: [], scopeHint: [`src/${item}/**`] }));
    }
    board.post(claim("a", "one", ["src/one/**"]));
    board.post(claim("b", "two", ["src/two/**"]));
    return board;
  }

  it("a revision names the base it was built on; one built on anything but the integrated head is refused (STALE_BASE)", () => {
    const board = based();
    expect(board.state.baseline).toBe("base0");
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.reject(msg("engine", "integrated.rev", { commit: "r1", gate: "pass", merged: ["c1"], base: "elsewhere" }), /built on elsewhere, but the board's integrated head is base0 \(the baseline\)/, "STALE_BASE");
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "pass", merged: ["c1"], base: "base0" }));
    expect(board.log.find((m) => m.type === "integrated.rev")!.payload).toMatchObject({ base: "base0" });
    // The next one is built on revision 1's commit, never the baseline again.
    board.post(push("b", "two", "c2", ["src/two/y.ts"]));
    board.reject(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c2"], base: "base0" }), /integrated head is r1 \(revision 1\)/, "STALE_BASE");
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c2"], base: "r1" }));
    // A failing revision does not move the head.
    board.post(push("b", "two", "c3", ["src/two/y.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r3", gate: "pass", merged: ["c3"], base: "r1" }));
    // A revision without a base (a board before the rule, or the cloud Workflow) is still recorded.
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a trunk that moved after a passing revision is recorded once, only for the latest passing revision", () => {
    const board = based();
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "pass", merged: ["c1"], base: "base0" }));
    board.reject(msg("engine", "trunk.moved", { rev: 2, commit: "r1" }), /is not the board's latest passing revision/, "INVALID_STATE");
    board.post(msg("engine", "trunk.moved", { rev: 1, commit: "r1", expected: "base0", actual: "zzz" }));
    expect(board.state.trunkMoved).toEqual([1]);
    board.reject(msg("engine", "trunk.moved", { rev: 1, commit: "r1" }), /already recorded/, "DUPLICATE");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a help fork whose head is not the requester's push is recorded on the offer and takes no grant", () => {
    const board = based();
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.post(msg("a", "help.requested", { request: "h1", item: "one", need: "hands", scope: ["src/one/z.ts"] }));
    board.reject(msg("b", "help.offered", { request: "h1", forkOf: "a", baseMismatch: { expected: "c1", realized: "c1" } }), /two different heads/, "BAD_PAYLOAD");
    board.post(msg("b", "help.offered", { request: "h1", forkOf: "a", fork: "chg--help-h1", baseMismatch: { expected: "c1", realized: "base0" } }));
    expect(board.state.help.h1!.grant).toBeUndefined();
    expect(board.state.help.h1!.forkMismatches).toEqual([{ agent: "b", seq: board.state.lastSeq, expected: "c1", realized: "base0" }]);
    expect(boardDigest(board.state, board.log, "a", 0).help!.mine[0]!.forkMismatches).toEqual([{ agent: "b", expected: "c1", realized: "base0" }]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("speculative batch gating on the board", () => {
  function speculating(rules: Record<string, unknown> = { speculate: 3 }): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", baseline: "base0", rules }));
    for (const agent of ["a", "b", "c"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    for (const item of ["one", "two", "three"]) {
      board.post(msg("lead", "item.proposed", { item, objective: item, acceptance: [], scopeHint: [`src/${item}/**`] }));
    }
    board.post(claim("a", "one", ["src/one/**"]));
    board.post(claim("b", "two", ["src/two/**"]));
    board.post(claim("c", "three", ["src/three/**"]));
    return board;
  }
  const candidate = (payload: Record<string, unknown>) =>
    msg("engine", "candidate.gated", { round: 1, of: 3, base: "base0", ...payload });

  it("records the speculate rule (1 to the bound) and refuses it with the cloud integrator", () => {
    expect(speculating().state.rules.speculate).toBe(3);
    expect(seeded().state.rules.speculate).toBeUndefined();
    const over = new TestBoard();
    over.reject(msg("human", "goal.posted", { objective: "o", rules: { speculate: BOARD_LIMITS.maxSpeculate + 1 } }), /speculate must be an integer from 1 to 8/, "BAD_PAYLOAD");
    const cloud = new TestBoard();
    cloud.reject(msg("human", "goal.posted", { objective: "o", integrator: "cloud", rules: { speculate: 2 } }), /integration Workflow gates one revision at a time/, "NOT_SUPPORTED");
    cloud.post(msg("human", "goal.posted", { objective: "o", integrator: "cloud", rules: { speculate: 1 } }));
    expect(cloud.state.integrator).toBe("cloud");
  });

  it("a blamed candidate backs a failing revision and charges only its items; the landed one IS the latest passing revision", () => {
    const board = speculating();
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.post(push("b", "two", "c2", ["src/two/y.ts"]));
    board.post(push("c", "three", "c3", ["src/three/z.ts"]));
    // C2 failed after C1 passed: recorded first, implicating two only.
    const failed = board.post(msg("engine", "integrated.rev", { commit: "k2", gate: "fail", merged: ["c1", "c2"], base: "base0", failing: { output: "src/two/y.ts:1 failed", items: ["two"] } }));
    expect(failed.filter((m) => m.type === "fix.requested").map((m) => m.payload)).toEqual([{ item: "two", n: 1, attempt: 1 }]);
    // C1 lands, built on the same head (a failing revision does not move it).
    board.post(msg("engine", "integrated.rev", { commit: "k1", gate: "pass", merged: ["c1"], base: "base0" }));
    expect(board.state.items.one!.fixAttempts).toBeUndefined();
    expect(board.state.items.three!.fixAttempts).toBeUndefined();
    // The landed candidate must be the latest passing revision's commit.
    board.reject(candidate({ index: 1, prefix: [{ agent: "a", items: ["one"], commit: "c1" }], commit: "other", verdict: "pass", outcome: "landed", rev: 2 }), /not the latest passing revision 2's commit/, "LOG_MISMATCH");
    board.post(candidate({ index: 1, prefix: [{ agent: "a", items: ["one"], commit: "c1" }], commit: "k1", verdict: "pass", outcome: "landed", rev: 2 }));
    // A blamed candidate names a recorded FAILING revision and the items it blames.
    const two = [{ agent: "a", items: ["one"], commit: "c1" }, { agent: "b", items: ["two"], commit: "c2" }];
    board.reject(candidate({ index: 2, prefix: two, commit: "k2", verdict: "fail", outcome: "blamed", rev: 2, blamed: ["two"] }), /not a recorded failing revision/, "LOG_MISMATCH");
    board.reject(candidate({ index: 2, prefix: two, commit: "k2", verdict: "fail", outcome: "blamed", rev: 1 }), /exactly a blamed candidate names the items/, "BAD_PAYLOAD");
    board.reject(candidate({ index: 2, prefix: two, commit: "k2", verdict: "pass", outcome: "blamed", rev: 1, blamed: ["two"] }), /a blamed candidate failed its gate/, "LOG_MISMATCH");
    board.post(candidate({ index: 2, prefix: two, commit: "k2", verdict: "fail", outcome: "blamed", rev: 1, blamed: ["two"] }));
    // A re-tested candidate blames nobody and backs no revision.
    const three = [...two, { agent: "c", items: ["three"], commit: "c3" }];
    board.reject(candidate({ index: 3, prefix: three, commit: "k3", verdict: "fail", outcome: "retest", rev: 1 }), /exactly a landed or a blamed candidate names the revision/, "BAD_PAYLOAD");
    board.reject(candidate({ index: 3, prefix: two, commit: "k3", verdict: "fail", outcome: "retest" }), /index \(at most of\) is the length of its prefix/, "BAD_PAYLOAD");
    board.post(candidate({ index: 3, prefix: three, commit: "k3", verdict: "fail", outcome: "retest" }));
    // Rounds and indexes only move forward.
    board.reject(candidate({ index: 3, prefix: three, commit: "k3", verdict: "fail", outcome: "retest" }), /is not after the last recorded one/, "DUPLICATE");
    expect(board.state.lastCandidate).toMatchObject({ round: 1, index: 3 });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("refuses candidates on a board that does not speculate, or more than its rule allows", () => {
    const board = speculating({ speculate: 2 });
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.reject(candidate({ index: 1, prefix: [{ agent: "a", items: ["one"], commit: "c1" }], commit: "k1", verdict: "pass", outcome: "passed" }), /at most 2 candidate/, "LIMIT");
    const off = seeded();
    off.reject(candidate({ index: 1, of: 1, prefix: [{ agent: "a", items: ["one"], commit: "c1" }], commit: "k1", verdict: "pass", outcome: "passed" }), /does not gate speculatively/, "INVALID_STATE");
  });

  it("stacks pending pushes in push order and holds a push whose fix is owed", () => {
    const board = speculating();
    board.post(push("c", "three", "c3", ["src/three/z.ts"]));
    board.post(push("a", "one", "c1", ["src/one/x.ts"]));
    board.post(push("b", "two", "c2", ["src/two/y.ts"]));
    const plan = planBoardIntegration(board.log, board.state);
    expect(plan.units.map((u) => u.agent)).toEqual(["a", "b", "c"]);
    expect(speculativeUnits(plan).map((u) => u.agent)).toEqual(["c", "a", "b"]);
    expect(speculationStateKey(board.state)).toBe(["c1", "c2", "c3"].join(","));
    board.post(msg("engine", "integrated.rev", { commit: "k", gate: "fail", merged: ["c3"], base: "base0", failing: { output: "x", items: ["three"] } }));
    expect(speculativeUnits(planBoardIntegration(board.log, board.state)).map((u) => u.agent)).toEqual(["a", "b"]);
    expect(speculationStateKey(board.state)).toBe(["c1", "c2"].join(","));
    // The owner's next push answers the fix request: it is stacked again (in its new push order).
    board.post(push("c", "three", "c4", ["src/three/z.ts"]));
    expect(speculativeUnits(planBoardIntegration(board.log, board.state)).map((u) => u.agent)).toEqual(["a", "b", "c"]);
  });

  it("lands the longest passing prefix, blames the first failure after it, and re-tests the rest", () => {
    const v = (...gates: ("pass" | "fail" | undefined)[]) => gates.map((gate, i) => ({ index: i + 1, ...(gate ? { gate } : {}) }));
    expect(decideSpeculativeLanding(v("pass", "fail", "fail"))).toEqual({ landed: 1, blamed: 2, passed: [], retest: [3] });
    expect(decideSpeculativeLanding(v("fail", "fail", "pass"))).toEqual({ blamed: 1, passed: [], retest: [2, 3] });
    expect(decideSpeculativeLanding(v("pass", "pass", "pass"))).toEqual({ landed: 3, passed: [1, 2], retest: [] });
    // A candidate that could not be gated ends the prefix and blames nobody.
    expect(decideSpeculativeLanding(v("pass", undefined, "pass"))).toEqual({ landed: 1, passed: [], retest: [2, 3] });
    expect(decideSpeculativeLanding(v(undefined, "fail"))).toEqual({ passed: [], retest: [1, 2] });
    expect(decideSpeculativeLanding(v("pass"))).toEqual({ landed: 1, passed: [], retest: [] });
  });
});

describe("token refreshes are recorded, never the token", () => {
  it("records a refresh for a joined agent's repo or its granted fork; refuses a token-shaped field or a stranger", () => {
    const board = seeded();
    board.post(msg("engine", "token.refreshed", { agent: "a", kind: "repo-write" }));
    expect(board.state.tokenRefreshes).toBe(1);
    board.reject(msg("engine", "token.refreshed", { agent: "a", kind: "repo-write", token: "secret" }), /never a token/, "BAD_PAYLOAD");
    board.reject(msg("engine", "token.refreshed", { agent: "zed", kind: "repo-write" }), /not a joined agent/, "UNKNOWN_AGENT");
    board.reject(msg("engine", "token.refreshed", { agent: "b", kind: "help-fork", request: "nope" }), /holds no granted help fork/, "NOT_ALLOWED");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("promotion is recorded on the board", () => {
  it("only the latest passing revision is recorded promoted, with its own gated commit, once", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", gateCommand: ["npm", "run", "gate"] }));
    expect(board.state.gateCommand).toEqual(["npm", "run", "gate"]);
    board.post(msg("a", "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "one", objective: "o", acceptance: [], scopeHint: ["src/**"] }));
    board.post(claim("a", "one", ["src/**"]));
    board.post(push("a", "one", "c1", ["src/x.ts"]));
    board.reject(msg("engine", "revision.promoted", { rev: 1, gatedCommit: "r1", commit: "p1", branch: "b" }), /not the board's latest revision, passing/, "INVALID_STATE");
    board.post(rev("pass", ["c1"], "r1"));
    board.reject(msg("engine", "revision.promoted", { rev: 1, gatedCommit: "other", commit: "p1", branch: "b" }), /is not revision 1's r1: gate-equals-deploy/, "LOG_MISMATCH");
    board.post(msg("engine", "revision.promoted", { rev: 1, gatedCommit: "r1", commit: "p1", branch: "switchyard/change-1" }));
    expect(board.state.promoted).toMatchObject({ rev: 1, gatedCommit: "r1", commit: "p1", branch: "switchyard/change-1" });
    board.reject(msg("engine", "revision.promoted", { rev: 1, gatedCommit: "r1", commit: "p1", branch: "b" }), /already recorded promoted/, "DUPLICATE");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("run caps are recorded once each", () => {
  it("records a run cap or an item's cap once; refuses a repeat and an unknown item", () => {
    const board = seeded();
    board.post(msg("engine", "run.capped", { kind: "model-calls", limit: 100, used: 100 }));
    board.reject(msg("engine", "run.capped", { kind: "model-calls", limit: 100, used: 101 }), /already recorded/, "DUPLICATE");
    board.post(msg("engine", "run.capped", { kind: "item-calls", limit: 10, used: 11, item: "one" }));
    board.reject(msg("engine", "run.capped", { kind: "item-calls", limit: 10, used: 11, item: "nope" }), /unknown item/, "UNKNOWN_REF");
    expect(board.state.capped).toEqual([
      expect.objectContaining({ kind: "model-calls", limit: 100, used: 100 }),
      expect.objectContaining({ kind: "item-calls", item: "one" }),
    ]);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("push.excluded", () => {
  function chatter(board: TestBoard, n: number): void {
    for (let k = 0; k < n; k += 1) {
      board.post(msg("b", "item.proposed", { item: `b-idea-${board.state.lastSeq}`, objective: "an idea", acceptance: [], scopeHint: ["docs/**"] }));
    }
  }

  it("addressed to the holder: the push leaves the plan, the lease runs again, the wait reason and digest say so; a new push clears it", () => {
    const board = seeded({ claimLeaseMessages: 4 });
    board.post(claim("a", "one", ["src/one.ts"]));
    board.post(push("a", "one", "c1", ["src/one.ts"]));
    expect(leaseSuspension(board.state, board.state.items.one!)).toBe("its push waits for the gate");
    const [excluded] = board.post(msg("engine", "push.excluded", { item: "one", agent: "a", commit: "c1", reason: "failed verification (scope)" }));
    expect(excluded).toMatchObject({ from: "engine", type: "push.excluded", to: ["a"] });
    expect(board.state.items.one!.lastPush!.excluded).toEqual({ seq: excluded!.seq, reason: "failed verification (scope)" });
    expect(board.state.items.one!.lease!.progressSeq).toBe(excluded!.seq);
    expect(leaseSuspension(board.state, board.state.items.one!)).toBeUndefined();
    expect(itemWaitReason(board.state, "one")).toEqual({ kind: "push-excluded", commit: "c1", reason: "failed verification (scope)" });
    expect(pendingPushItems(board.state).map((i) => i.id)).toEqual(["one"]);
    expect(integrablePushItems(board.state)).toEqual([]);
    expect(planBoardIntegration(board.log, board.state).units).toEqual([]);
    const digest = boardDigest(board.state, board.log, "a", 0);
    expect(digest.claims[0]!.excluded).toMatchObject({ commit: "c1", reason: "failed verification (scope)" });
    expect(digest.messages.some((m) => m.type === "push.excluded")).toBe(true);
    // Recorded once per push; never for a push that is not the holder's pending one.
    board.reject(msg("engine", "push.excluded", { item: "one", agent: "a", commit: "c1", reason: "again" }), /already recorded excluded/, "DUPLICATE");
    board.reject(msg("engine", "push.excluded", { item: "one", agent: "a", commit: "zz", reason: "x" }), /is not a's pending, ungated push/, "INVALID_STATE");
    board.reject(msg("engine", "push.excluded", { item: "one", agent: "a", commit: "c1", reason: "x", extra: 1 }), /is \{item, agent, commit, reason\}/, "BAD_PAYLOAD");
    // The holder does nothing: the lease lapses.
    chatter(board, 4);
    expect(board.state.items.one!.status).toBe("open");
    expect(reduceBoard(board.log)).toEqual(board.state);
    expect(foldBoard(board.log)).toEqual(board.state);
  });

  it("the holder's next push clears it and is planned again", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/one.ts"]));
    board.post(push("a", "one", "c1", ["src/one.ts"]));
    board.post(msg("engine", "push.excluded", { item: "one", agent: "a", commit: "c1", reason: "failed verification" }));
    board.post(push("a", "one", "c2", ["src/one.ts"]));
    expect(board.state.items.one!.lastPush!.excluded).toBeUndefined();
    expect(itemWaitReason(board.state, "one")).toEqual({ kind: "waiting-for-gate", commit: "c2" });
    expect(planBoardIntegration(board.log, board.state).units.map((u) => u.commit)).toEqual(["c2"]);
    // A gated push can no longer be excluded.
    board.post(rev("fail", ["c2"], "r1"));
    board.reject(msg("engine", "push.excluded", { item: "one", agent: "a", commit: "c2", reason: "x" }), /pending, ungated push/, "INVALID_STATE");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });
});

describe("arbitration revision 2 (rules.arbitration)", () => {
  const failing = (merged: string[], items: string[], commit: string) =>
    msg("engine", "integrated.rev", { commit, gate: "fail", merged, failing: { output: "not ok", items } });
  function chatter(board: TestBoard, n: number): void {
    for (let k = 0; k < n; k += 1) {
      board.post(msg("c", "item.proposed", { item: `c-idea-${board.state.lastSeq}`, objective: "an idea", acceptance: [], scopeHint: ["docs/**"] }));
    }
  }

  it("only revisions 1 to 6 are accepted; revision 1 is the default and is not recorded", () => {
    const one = seeded({ arbitration: 1 });
    expect(one.state.rules.arbitration).toBeUndefined();
    expect(one.log[0]!.type === "goal.posted" && one.log[0]!.payload.rules.arbitration).toBeUndefined();
    const two = seeded({ arbitration: 2 });
    expect(two.state.rules.arbitration).toBe(2);
    const three = seeded({ arbitration: 3 });
    expect(three.state.rules.arbitration).toBe(3);
    expect(seeded({ arbitration: 4 }).state.rules.arbitration).toBe(4);
    expect(seeded({ arbitration: 5 }).state.rules.arbitration).toBe(5);
    expect(seeded({ arbitration: 6 }).state.rules.arbitration).toBe(6);
    const board = new TestBoard();
    board.reject(msg("human", "goal.posted", { objective: "o", rules: { arbitration: 7 } }), /arbitration/, "BAD_PAYLOAD");
  });

  for (const arbitration of [1, 2]) {
    it(`a different agent granted the item after a lapse ${arbitration === 2 ? "starts with a fresh fix budget" : "inherits the spent fix attempts (revision 1)"}`, () => {
      const board = seeded({ arbitration, claimLeaseMessages: 4, maxFixAttempts: 1 });
      board.post(claim("a", "one", ["src/one.ts"]));
      board.post(push("a", "one", "c1", ["src/one.ts"]));
      board.post(failing(["c1"], ["one"], "r1"));
      expect(board.state.items.one!.fixAttempts).toBe(1);
      // a never answers: its claim lapses (no progress), and b takes the item.
      chatter(board, 4);
      expect(board.state.items.one!.status).toBe("open");
      board.post(claim("b", "one", ["src/one.ts"]));
      expect(board.state.items.one!.owner).toBe("b");
      expect(board.state.items.one!.fixAttempts).toBe(arbitration === 2 ? 0 : 1);
      board.post(push("b", "one", "c2", ["src/one.ts"]));
      const types = board.types(failing(["c2"], ["one"], "r2"));
      // Revision 2: b gets its own first attempt; revision 1: b's first failure spends the budget.
      expect(types).toContain(arbitration === 2 ? "fix.requested" : "fix.exhausted");
      expect(reduceBoard(board.log)).toEqual(board.state);
    });
  }

  for (const arbitration of [1, 2]) {
    it(`a fix request at the deadline ${arbitration === 2 ? "leaves the holder a lease window (gate wait not charged)" : "lapses in the same batch (revision 1)"}`, () => {
      const board = seeded({ arbitration, claimDeadlineMessages: 6 });
      board.post(claim("a", "one", ["src/one.ts"]));
      board.post(push("a", "one", "c1", ["src/one.ts"]));
      // The push waits for the gate (suspended) well past the deadline window.
      chatter(board, 8);
      expect(board.state.items.one!.status).toBe("claimed");
      const appended = board.post(failing(["c1"], ["one"], "r1")).map((m) => m.type);
      expect(appended).toContain("fix.requested");
      if (arbitration === 2) {
        expect(appended).not.toContain("claim.lapsed");
        expect(board.state.items.one!.status).toBe("claimed");
        // The holder answers within its window: the claim stays live.
        board.post(push("a", "one", "c2", ["src/one.ts"]));
        expect(board.state.items.one!.status).toBe("claimed");
      } else {
        expect(appended).toContain("claim.lapsed");
        expect(board.state.items.one!.status).toBe("open");
      }
      expect(reduceBoard(board.log)).toEqual(board.state);
    });
  }

  for (const arbitration of [1, 2]) {
    it(`engine records ${arbitration === 2 ? "never advance the lease clock" : "advance the lease clock (revision 1)"}`, () => {
      const board = seeded({ arbitration, claimLeaseMessages: 4 });
      board.post(claim("a", "one", ["src/one.ts"]));
      for (let k = 0; k < 6; k += 1) {
        board.post(msg("engine", "token.refreshed", { agent: "b", kind: "repo-write" }));
      }
      expect(board.state.items.one!.status).toBe(arbitration === 2 ? "claimed" : "open");
      if (arbitration === 2) {
        expect(board.state.ticks).toBeGreaterThan(0);
        const digest = boardDigest(board.state, board.log, "a", 0);
        expect(digest.claims[0]!.lease!.hint).toMatch(/after \d+ more participant message\(s\)/);
        // Participant messages do advance it.
        chatter(board, 4);
        expect(board.state.items.one!.status).toBe("open");
      }
      expect(reduceBoard(board.log)).toEqual(board.state);
      expect(foldBoard(board.log)).toEqual(board.state);
    });
  }
});

describe("arbitration revision 3: an item waiting on others (conjunctive gates)", () => {
  /** Six items, agents a/b/c and a lead, a claim cap of one; a/b/c each claim and push one..three. */
  function sixPushed(rules: Record<string, number>): TestBoard {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { maxActiveClaims: 1, ...rules } }));
    for (const agent of ["a", "b", "c"]) board.post(msg(agent, "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    for (const item of ["one", "two", "three", "four", "five", "six"]) {
      board.post(msg("lead", "item.proposed", { item, objective: `fix ${item}`, acceptance: ["ok"], scopeHint: [`src/${item}.ts`] }));
    }
    for (const [agent, item] of [["a", "one"], ["b", "two"], ["c", "three"]] as const) {
      board.post(claim(agent, item, [`src/${item}.ts`]));
      board.post(push(agent, item, `c-${item}`, [`src/${item}.ts`]));
    }
    return board;
  }
  /** A failing revision merging all three pushes whose failures are the unmerged items' only. */
  const outstandingFail = (items: string[] = [], outstanding: string[] = ["four", "five", "six"]) =>
    msg("engine", "integrated.rev", {
      commit: "r1",
      gate: "fail",
      merged: ["c-one", "c-two", "c-three"],
      failing: { output: "\u2716 four: fails\n\u2716 five: fails\n\u2716 six: fails", items, outstanding },
    });

  it("a gated push owing no fix frees the cap: U4 is not held by the cap and a fourth claim is granted", () => {
    const board = sixPushed({ arbitration: 3 });
    // Before the gate, every holder owes work (its push waits for the gate): capped, and the open items wait on the cap.
    expect(claimCapReached(board.state, "a")).toMatchObject({ cap: 1, holding: ["one"] });
    expect(itemWaitReason(board.state, "four")).toEqual({ kind: "held-by-claim-cap", agents: 3 });
    board.reject(claim("a", "four", ["src/four.ts"]), /cap 1/, "CLAIM_CAP");
    // The board accepts a failing revision that implicates no merged item.
    const appended = board.post(outstandingFail());
    expect(appended.map((m) => m.type)).toEqual(["integrated.rev"]);
    expect(board.state.lastFailure).toMatchObject({ n: 1, items: [], outstanding: ["four", "five", "six"] });
    for (const agent of ["a", "b", "c"]) {
      expect(claimCapReached(board.state, agent)).toBeUndefined();
      expect(activeClaims(board.state, agent)).toEqual([]);
      expect(boardDigest(board.state, board.log, agent, 0).claimCap).toBeUndefined();
    }
    expect(waitingOnOthers(board.state, board.state.items.one!)).toBe(true);
    expect(itemWaitReason(board.state, "one")).toEqual({ kind: "waiting-on-others", commit: "c-one", rev: 1 });
    expect(describeWaitReason(itemWaitReason(board.state, "one")!)).toMatch(/gated in revision 1 and owes no fix: it waits on the other items/);
    expect(itemWaitReason(board.state, "four")).toEqual({ kind: "unclaimed" });
    expect(board.types(claim("a", "four", ["src/four.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    // Hoarding protection: a now owes work on four (no push yet), so it is capped again.
    board.reject(claim("a", "five", ["src/five.ts"]), /holds 1 unfinished item\(s\) \(four; cap 1\)/, "CLAIM_CAP");
    expect(reduceBoard(board.log)).toEqual(board.state);
    expect(foldBoard(board.log)).toEqual(board.state);
  });

  it("a fix request (or an excluded push) still counts against the cap", () => {
    const board = sixPushed({ arbitration: 3, maxFixAttempts: 3 });
    // The failure names one's own test: one is implicated and its owner asked for a fix.
    expect(board.types(outstandingFail(["one"], ["four"]))).toEqual(["integrated.rev", "fix.requested"]);
    expect(board.state.items.one!.fixRequested).toBe(1);
    expect(waitingOnOthers(board.state, board.state.items.one!)).toBe(false);
    expect(claimCapReached(board.state, "a")).toMatchObject({ cap: 1, holding: ["one"] });
    board.reject(claim("a", "four", ["src/four.ts"]), /cap 1/, "CLAIM_CAP");
    // b and c were not implicated: they have room.
    expect(claimCapReached(board.state, "b")).toBeUndefined();
    expect(board.types(claim("b", "four", ["src/four.ts"]))).toEqual(["item.claimed", "claim.granted"]);
    // An excluded push owes a new push: counts.
    board.post(push("c", "three", "c-three-2", ["src/three.ts"]));
    board.post(msg("engine", "push.excluded", { item: "three", agent: "c", commit: "c-three-2", reason: "failed verification" }));
    expect(claimCapReached(board.state, "c")).toMatchObject({ holding: ["three"] });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("revision 2 keeps the old cap: an item counts until its push PASSED", () => {
    const board = sixPushed({ arbitration: 2 });
    board.post(outstandingFail());
    expect(waitingOnOthers(board.state, board.state.items.one!)).toBe(false);
    expect(claimCapReached(board.state, "a")).toMatchObject({ cap: 1, holding: ["one"] });
    expect(itemWaitReason(board.state, "four")).toEqual({ kind: "held-by-claim-cap", agents: 3 });
    expect(itemWaitReason(board.state, "one")).toBeUndefined();
    board.reject(claim("a", "four", ["src/four.ts"]), /let it pass an integrated revision/, "CLAIM_CAP");
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("the failing evidence's outstanding items must be known items not in the revision", () => {
    const board = sixPushed({ arbitration: 3 });
    board.reject(outstandingFail([], ["ghost"]), /outstanding item\(s\) ghost are unknown or in this revision/, "UNKNOWN_REF");
    board.reject(outstandingFail([], ["one"]), /outstanding item\(s\) one are unknown or in this revision/, "UNKNOWN_REF");
  });

  function chatter(board: TestBoard, n: number): void {
    for (let k = 0; k < n; k += 1) {
      board.post(msg("lead", "item.proposed", { item: `pad-${board.state.lastSeq}`, objective: "pad", acceptance: [], scopeHint: ["docs/**"] }));
    }
  }

  for (const arbitration of [2, 3]) {
    it(`a gated, unimplicated claim ${arbitration === 3 ? "never lapses for no progress (only at its deadline)" : "lapses for no progress (revision 2)"}`, () => {
      const board = sixPushed({ arbitration, claimLeaseMessages: 4, claimDeadlineMessages: 40 });
      board.post(outstandingFail());
      chatter(board, 10);
      if (arbitration === 2) {
        expect(board.log.filter((m) => m.type === "claim.lapsed").map((m) => m.type === "claim.lapsed" && m.payload.reason)).toContain("no-progress");
        expect(board.state.items.one!.status).toBe("open");
      } else {
        expect(board.log.filter((m) => m.type === "claim.lapsed")).toEqual([]);
        expect(board.state.items.one!.status).toBe("claimed");
        expect(leaseLapse(board.state, "one")).toBeUndefined();
        const lease = boardDigest(board.state, board.log, "a", 0).claims.find((c) => c.item === "one")!.lease!;
        expect(lease.lapsesAt).toBeUndefined();
        expect(lease.hint).toMatch(/does not lapse for no progress, only at its deadline/);
        // A quiet board does not record it stalled: its holder is not the one stalling it.
        board.reject(msg("engine", "claim.lapsed", { item: "one" }), /waits on the other items/, "INVALID_STATE");
        // The firm deadline still applies.
        chatter(board, 40);
        const lapses = board.log.filter((m) => m.type === "claim.lapsed" && m.payload.item === "one");
        expect(lapses.map((m) => m.type === "claim.lapsed" && m.payload.reason)).toEqual(["deadline"]);
      }
      expect(reduceBoard(board.log)).toEqual(board.state);
    });
  }
});

describe("push.regressed (arbitration revision 5: the pre-pass progress ratchet)", () => {
  // The stack without the push (strictly better) and with it.
  const WITHOUT = { runs: true, acceptance: 5, acceptanceTotal: 9, developer: 0, typeErrors: 0 };
  const WITH = { runs: false, acceptance: 0, developer: 0, typeErrors: 22 };
  const regressed = (extra: Record<string, unknown> = {}) =>
    msg("engine", "push.regressed", {
      item: "two",
      agent: "b",
      commit: "c-two-2",
      rev: 2,
      ratchet: 1,
      from: WITHOUT,
      to: WITH,
      candidate: "cand-two",
      evidence: ["src/two.ts(3,7): error TS2339: Property 'auth' does not exist on type 'Ctx'."],
      ...extra,
    });
  /** a, b, c each pushed once (rev 1, the ratchet), then b pushed again and rev 2 gated it, failing. */
  function regressedBoard(rules: Record<string, number> = { arbitration: 5, maxFixAttempts: 3 }): TestBoard {
    const board = seeded(rules);
    for (const [agent, item] of [["a", "one"], ["b", "two"], ["c", "three"]] as const) {
      board.post(claim(agent, item, [`src/${item}.ts`]));
      board.post(push(agent, item, `c-${item}`, [`src/${item}.ts`]));
    }
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c-one", "c-two", "c-three"], failing: { output: "x", items: [] } }));
    board.post(push("b", "two", "c-two-2", ["src/two.ts"]));
    // The regressing revision asks only the regressing item for the fix.
    expect(board.types(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c-one", "c-two-2", "c-three"], failing: { output: "x", items: ["two"] } }))).toEqual([
      "integrated.rev",
      "fix.requested",
    ]);
    return board;
  }

  it("addressed to the holder: the push leaves the stack, the lease runs, the wait reason and the digest quote the regression; a new push clears it", () => {
    const board = regressedBoard({ arbitration: 5, maxFixAttempts: 3, claimLeaseMessages: 50 });
    expect(integrablePushItems(board.state).map((i) => i.id).sort()).toEqual(["one", "three", "two"]);
    const [record] = board.post(regressed({ seams: ["src/contracts/auth.ts"] }));
    expect(record).toMatchObject({ from: "engine", type: "push.regressed", to: ["b"] });
    const push2 = board.state.items.two!.lastPush!;
    expect(push2.regressed).toMatchObject({ seq: record!.seq, rev: 2, ratchet: 1, from: WITHOUT, to: WITH });
    expect(board.state.items.two!.lease!.progressSeq).toBe(record!.seq);
    expect(integrablePushItems(board.state).map((i) => i.id).sort()).toEqual(["one", "three"]);
    expect(planBoardIntegration(board.log, board.state).units.map((u) => u.agent)).toEqual(["a", "c"]);
    expect(itemWaitReason(board.state, "two")).toEqual({ kind: "push-regressed", commit: "c-two-2", rev: 2 });
    expect(describeWaitReason(itemWaitReason(board.state, "two")!)).toMatch(/made revision 2 worse \(the stack scores better without it\)/);
    expect(waitingOnOthers(board.state, board.state.items.two!)).toBe(false);
    expect(activeClaims(board.state, "b")).toEqual(["two"]);
    const claimTwo = boardDigest(board.state, board.log, "b", 0).claims.find((c) => c.item === "two")!;
    expect(claimTwo.regressed).toMatchObject({ commit: "c-two-2", rev: 2, from: "acceptance 5/9", to: "22 type errors", seams: ["src/contracts/auth.ts"] });
    expect(claimTwo.regressed!.instruction).toMatch(/made revision 2 WORSE: with it the stack scores 22 type errors, without it acceptance 5\/9 \(the best revision so far is 1\)/);
    expect(claimTwo.regressed!.instruction).toMatch(/Property 'auth' does not exist/);
    // The seam is in a held item's scope (owned): keep it compatible; no seam contract cue.
    expect(claimTwo.regressed!.instruction).toMatch(/shared file src\/contracts\/auth\.ts that other items import: keep it backward compatible/);
    expect(claimTwo.seamCue).toBeUndefined();
    expect(claimTwo.fix!.instruction).toMatch(/removing your push removes 22 type errors \(the acceptance suite runs again: acceptance 5\/9\): src\/two\.ts\(3,7\): error TS2339/);
    // Recorded once per push, only for a gated latest push, only when it scores worse.
    board.reject(regressed(), /already recorded regressed/, "DUPLICATE");
    board.reject(regressed({ commit: "c-two" }), /latest, gated, unintegrated push/, "INVALID_STATE");
    board.reject(regressed({ item: "one", agent: "a", commit: "c-one", to: { ...WITHOUT } }), /not worse than/, "BAD_PAYLOAD");
    board.reject(regressed({ item: "one", agent: "a", commit: "c-one", rev: 9 }), /not a recorded revision/, "UNKNOWN_REF");
    board.reject(regressed({ item: "one", agent: "a", commit: "c-one", ratchet: 2 }), /must precede/, "BAD_PAYLOAD");
    board.reject(regressed({ extra: 1 }), /a push\.regressed record is/, "BAD_PAYLOAD");
    // The holder's next push clears it and is stacked again.
    board.post(push("b", "two", "c-two-3", ["src/two.ts"]));
    expect(board.state.items.two!.lastPush!.regressed).toBeUndefined();
    expect(itemWaitReason(board.state, "two")).toEqual({ kind: "waiting-for-gate", commit: "c-two-3" });
    expect(integrablePushItems(board.state).map((i) => i.id).sort()).toEqual(["one", "three", "two"]);
    expect(reduceBoard(board.log)).toEqual(board.state);
    expect(foldBoard(board.log)).toEqual(board.state);
  });

  it("a regression that edits a FROZEN shared seam cues a seam contract (the existing seamCue)", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { arbitration: 5, maxFixAttempts: 3 }, seams: [{ path: "src/contracts/auth.ts", importers: ["src/two.ts"] }] }));
    board.post(msg("b", "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "two", objective: "do two", acceptance: [], scopeHint: ["src/two.ts"] }));
    board.post(claim("b", "two", ["src/two.ts"]));
    board.post(push("b", "two", "c-two", ["src/two.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c-two"], failing: { output: "x", items: [] } }));
    board.post(push("b", "two", "c-two-2", ["src/two.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c-two-2"], failing: { output: "x", items: ["two"] } }));
    board.post(regressed({ seams: ["src/contracts/auth.ts"] }));
    const claimTwo = boardDigest(board.state, board.log, "b", 0).claims.find((c) => c.item === "two")!;
    expect(claimTwo.seamCue).toMatchObject({ seams: ["src/contracts/auth.ts"], errors: [expect.stringMatching(/TS2339/)] });
    expect(claimTwo.seamCue!.hint).toMatch(/send message kind contract \{target: src\/contracts\/auth\.ts, change: modify, itemId: two/);
    expect(claimTwo.regressed!.instruction).toMatch(/shared seam src\/contracts\/auth\.ts, which no item owns/);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a regression whose new type errors point at a frozen seam the item imports cues the seam contract, and the lead's facts read that evidence", () => {
    const board = new TestBoard();
    board.post(msg("human", "goal.posted", { objective: "o", rules: { arbitration: 5, maxFixAttempts: 3 }, seams: [{ path: "src/shared/ctx.ts", importers: ["src/two.ts"], symbols: ["Ctx"] }] }));
    board.post(msg("b", "agent.joined"));
    board.post(msg("lead", "agent.joined", { role: "lead" }));
    board.post(msg("lead", "item.proposed", { item: "two", objective: "do two", acceptance: [], scopeHint: ["src/two.ts"] }));
    board.post(claim("b", "two", ["src/two.ts"]));
    board.post(push("b", "two", "c-two", ["src/two.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r1", gate: "fail", merged: ["c-two"], failing: { output: "not ok 1 - two greets", items: [] } }));
    board.post(push("b", "two", "c-two-2", ["src/two.ts"]));
    board.post(msg("engine", "integrated.rev", { commit: "r2", gate: "fail", merged: ["c-two-2"], failing: { output: "x", items: ["two"] } }));
    board.post(regressed({ evidence: ["src/two.ts(2,41): error TS2339: Property 'user' does not exist on type 'Ctx'."] }));
    // A later failing revision whose output names no seam is the board's latest failure.
    board.post(msg("engine", "integrated.rev", { commit: "r3", gate: "fail", merged: [], failing: { output: "not ok 1 - two greets", items: [] } }));
    const claimTwo = boardDigest(board.state, board.log, "b", 0).claims.find((c) => c.item === "two")!;
    expect(claimTwo.seamCue).toMatchObject({ seams: ["src/shared/ctx.ts"], errors: ["src/two.ts(2,41): error TS2339: Property 'user' does not exist on type 'Ctx'."] });
    board.post(msg("b", "contract.proposed", { contract: "k1", target: "src/shared/ctx.ts", kind: "modify", item: "two", description: "add user?: string to Ctx" }));
    expect(seamContractFacts(board.state, "k1").namedInFailure).toBe(true);
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("only under arbitration revision 5, and only before the first passing revision", () => {
    const v4 = regressedBoard({ arbitration: 4, maxFixAttempts: 3 });
    v4.reject(regressed(), /only under arbitration revision 5/, "NOT_ALLOWED");
    const board = regressedBoard();
    board.post(msg("engine", "integrated.rev", { commit: "r3", gate: "pass", merged: ["c-one", "c-two-2", "c-three"] }));
    board.reject(regressed(), /the pre-pass ratchet is over/, "INVALID_STATE");
  });
});

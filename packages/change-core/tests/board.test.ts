import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  appendBoardMessage,
  appendDecisionRecorded,
  appendIntegratedRev,
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
  contestResponder,
  formatAttributionTally,
  emptyBoard,
  endpointPoster,
  foldBoard,
  parseBoardDraft,
  pureBoardEndpoint,
  reduceBoard,
  runBoardScript,
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
      return draft.type === "decision.recorded"
        ? appendDecisionRecorded(this.state, (draft.payload ?? {}) as unknown, AT)
        : appendIntegratedRev(this.state, (draft.payload ?? {}) as unknown, AT);
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
  "item.split": { from: "a", payload: { item: "i", children: [{ item: "k", objective: "o" }] } },
  "item.discovered": { from: "a", payload: { item: "k", objective: "o", reason: "found a gap", parent: "i" } },
  "help.requested": { from: "a", payload: { request: "r", item: "i", need: "tool" } },
  "help.offered": { from: "b", payload: { request: "r" } },
  "contract.proposed": { from: "a", payload: { contract: "k", target: "src/api.ts#handler", kind: "modify" } },
  "contract.escalated": { from: "engine", payload: { contract: "k", item: "i", target: "tests/a.test.ts", kind: "modify" } },
  "contract.accepted": { from: "lead", payload: { contract: "k" } },
  "contract.rejected": { from: "human", payload: { contract: "k" } },
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
  "tool.proposed": { from: "a", payload: { tool: "t", capability: "scan", inputs: ["files"], outputs: ["items"] } },
  "tool.published": { from: "a", payload: { tool: "t", capability: "scan", version: "1", repo: "tools", commit: "abc", verified: true } },
  "tool.used": { from: "b", payload: { capability: "scan", version: "1", changedFiles: ["src/a.ts"] } },
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
  "item.split": { item: "i", children: [] },
  "item.discovered": { item: "k", objective: "o" },
  "help.requested": { request: "r", item: "i" },
  "help.offered": {},
  "contract.proposed": { contract: "k", target: "src/a.ts", kind: "rewrite" },
  "contract.escalated": { contract: "k", item: "i", target: "../x", kind: "modify" },
  "contract.accepted": {},
  "contract.rejected": { contract: "" },
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
  "item.reopened": { item: "i", previousOwner: "a" },
  "tool.proposed": { tool: "t" },
  "tool.published": { tool: "t", capability: "scan", version: "1", repo: "tools", commit: "abc", verified: false },
  "tool.used": { capability: "scan" },
  "decision.recorded": { juncture: "guess", question: "q", accepted: true },
  "decision.resolved": { decisionSeq: 1, rev: 1, passed: 2, answer: "i", outcome: "confirmed", fixed: [], parsed: [], parseOutcome: "none" },
  "agent.joined": { role: "has spaces" },
  "agent.left": { extra: "ignored" },
};

describe("board vocabulary: per-type payload validation", () => {
  it("covers every message type", () => {
    expect(Object.keys(VALID).sort()).toEqual([...BOARD_MESSAGE_TYPES].sort());
    expect(BOARD_MESSAGE_TYPES).toHaveLength(38);
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

  it("a split item opens its children and completes when they all complete", () => {
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
    expect(board.state.items.one).toMatchObject({ status: "split", owner: "a", children: ["one-x", "one-y"] });
    board.post(claim("b", "one-x", ["src/a/x.ts"]));
    board.post(claim("c", "one-y", ["src/a/y.ts"]));
    board.post(push("b", "one-x", "px", ["src/a/x.ts"]));
    board.post(push("c", "one-y", "py", ["src/a/y.ts"]));
    board.post(msg("b", "done.proposed", { item: "one-x" }));
    board.post(msg("c", "done.proposed", { item: "one-y" }));
    const appended = board.post(rev("pass", ["px", "py"], "r1"));
    expect(appended.filter((m) => m.type === "item.completed").map((m) => m.payload)).toEqual([
      { item: "one-x", n: 1, via: "integrated" },
      { item: "one-y", n: 1, via: "integrated" },
      { item: "one", n: 1, via: "children" },
    ]);
  });

  it("the state keeps counts and latest values, not per-event lists", () => {
    const board = seeded();
    board.post(claim("a", "one", ["src/a.ts"]));
    board.post(push("a", "one", "c1", ["src/a.ts"]));
    board.post(push("a", "one", "c2", ["src/a.ts"]));
    board.post(msg("a", "tool.proposed", { tool: "t1", capability: "scan" }));
    board.post(msg("a", "tool.published", { tool: "t1", capability: "scan", version: "1", repo: "tools", commit: "abc", verified: true }));
    board.post(msg("b", "tool.used", { capability: "scan", version: "1", changedFiles: ["src/x.ts"] }));
    board.post(msg("c", "tool.used", { capability: "scan", version: "1" }));
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
    expect(() => reduceBoard(forged)).toThrow(/does not match arbitration/);
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
    expect(() => reduceBoard(forged)).toThrow(/does not match arbitration/);
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

describe("tool registry", () => {
  it("publishing requires a prior proposal by the same agent, verification, and a unique version", () => {
    const board = seeded();
    const publish = (from: string, version: string, extra: Record<string, unknown> = {}) =>
      msg(from, "tool.published", { tool: "t1", capability: "scan", version, repo: "tools", commit: "abc", verified: true, ...extra });
    board.reject(publish("a", "1"), /must be proposed/, "UNKNOWN_REF");
    board.post(msg("a", "tool.proposed", { tool: "t1", capability: "scan", inputs: ["files"], outputs: ["items"] }));
    board.reject(msg("b", "tool.proposed", { tool: "t1", capability: "other" }), /already proposed/);
    board.reject(publish("a", "1", { verified: false }), /passed its own gate/);
    board.reject(publish("a", "1", { verified: "true" }), /passed its own gate/);
    board.reject(publish("b", "1"), /only a, who proposed tool t1/);
    board.reject(publish("a", "1", { capability: "codemod" }), /proposed with capability scan/);
    board.reject(msg("b", "tool.used", { capability: "scan", version: "1" }), /not a published tool version/);
    board.post(publish("a", "1"));
    board.reject(publish("a", "1"), /scan@1 is already published/);
    board.post(publish("a", "2"));
    board.post(msg("b", "tool.used", { capability: "scan", version: "1", changedFiles: ["src/a.ts"] }));
    expect(board.state.tools.published.map((t) => `${t.capability}@${t.version}:${t.uses}`)).toEqual(["scan@1:1", "scan@2:0"]);
  });
});

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
    board.post(msg("a", "tool.proposed", { tool: "t1", capability: "scan" }));
    board.post(msg("a", "tool.published", { tool: "t1", capability: "scan", version: "1", repo: "r", commit: "c", verified: true }));
    for (let i = 0; i < 3000; i += 1) {
      board.post(msg(i % 2 === 0 ? "b" : "c", "tool.used", { capability: "scan", version: "1" }));
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
    expect(first.rejected.map((r) => r.code)).toEqual(["NOT_ALLOWED", "INVALID_STATE"]);
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
      items: { proposed: 0, rejected: 0, open: 0, claimed: 1, contested: 0, split: 0, done: 4 },
      toolsPublished: 1,
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

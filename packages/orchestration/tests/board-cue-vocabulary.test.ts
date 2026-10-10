/**
 * The board's fix-request cues (claims[].contractCue and claims[].seamCue)
 * tell an agent what to send: their hints must be phrased in the agent ACTION
 * vocabulary the turn prompt and schema use (`message` kind `contract` with
 * `{target, change, itemId, description?}`), never as board message names an
 * agent cannot send. Each hint's action is parsed by the real action parser.
 * Offline and deterministic.
 */
import { describe, expect, it } from "vitest";

import {
  appendBoardMessage,
  appendIntegratedRev,
  boardDigest,
  emptyBoard,
  type BoardAppendResult,
  type BoardMessage,
  type BoardOrigin,
  type BoardState,
} from "@switchyard-change/change-core";
import { AGENT_ACTION_TYPES, parseAgentAction } from "@switchyard-change/model-adapters";

const AT = "2026-01-01T00:00:00.000Z";

/** A tiny board: post drafts as the named sender (human, an agent, or the engine's integrated.rev). */
function board() {
  let state: BoardState = emptyBoard();
  const log: BoardMessage[] = [];
  const post = (from: string, type: string, payload: unknown) => {
    let result: BoardAppendResult;
    if (from === "engine") {
      result = appendIntegratedRev(state, payload, AT);
    } else {
      const origin: BoardOrigin = from === "human" ? { kind: "human" } : type === "agent.joined" ? { kind: "join", agent: from } : { kind: "agent", agent: from };
      result = appendBoardMessage(state, origin, { type, payload }, AT);
    }
    state = result.state;
    log.push(...result.appended);
  };
  return { post, digest: (agent: string) => boardDigest(state, log, agent, 0) };
}

/**
 * The action a hint names: `send message kind <kind> {k: v, ...}` turned into
 * the action JSON a model would return (every payload field the strict schema
 * lists, unset ones null), then parsed by the real parser.
 */
function actionFromHint(hint: string) {
  expect(hint).not.toMatch(/contract\.proposed|kind: modify|item: /);
  const match = /send message kind ([a-z]+) \{([^}]*)\}/.exec(hint);
  expect(match).not.toBeNull();
  const fields = Object.fromEntries(
    match![2]!.split(", ").map((pair) => {
      const at = pair.indexOf(": ");
      return [pair.slice(0, at), pair.slice(at + 2)];
    }),
  );
  const payload = { itemId: null, need: null, requestId: null, target: null, change: null, description: null, reviewId: null, findings: null, scope: null, ...fields };
  expect(AGENT_ACTION_TYPES).toContain("message");
  return parseAgentAction({ type: "message", kind: match![1], to: null, payload, rationale: "the cue says so" });
}

describe("fix-request cues speak the agent action vocabulary", () => {
  it("a protected-test contract cue names a valid message kind contract action", () => {
    const b = board();
    b.post("human", "goal.posted", { objective: "o", protected: ["tests/tax.test.ts"] });
    b.post("a", "agent.joined", {});
    b.post("human", "item.proposed", { item: "tax", objective: "round tax", scopeHint: ["src/tax.ts"] });
    b.post("a", "item.claimed", { item: "tax", intent: { read: [], write: ["src/tax.ts"] } });
    b.post("a", "push.announced", { item: "tax", commit: "c1", paths: ["src/tax.ts"] });
    b.post("engine", "integrated.rev", {
      commit: "r1",
      gate: "fail",
      merged: ["c1"],
      failing: { output: "AssertionError: expected 73 to be 72\n at tests/tax.test.ts:12:5", items: ["tax"] },
    });
    const hint = b.digest("a").claims[0]!.contractCue!.hint;
    expect(actionFromHint(hint)).toEqual({
      type: "message",
      kind: "contract",
      payload: { target: "tests/tax.test.ts", change: "modify", itemId: "tax" },
      rationale: "the cue says so",
    });
  });

  it("a seam cue names a valid message kind contract action with the needed change", () => {
    const b = board();
    b.post("human", "goal.posted", { objective: "o", seams: [{ path: "src/store.ts", importers: ["src/orders/cart.ts"], symbols: ["Ctx"] }] });
    b.post("a", "agent.joined", {});
    b.post("lead", "agent.joined", { role: "lead" });
    b.post("lead", "item.proposed", { item: "cart", objective: "cart", acceptance: ["it works"], scopeHint: ["src/orders/cart.ts"] });
    b.post("a", "item.claimed", { item: "cart", intent: { read: [], write: ["src/orders/cart.ts"] } });
    b.post("a", "push.announced", { item: "cart", commit: "c1", paths: ["src/orders/cart.ts"] });
    b.post("engine", "integrated.rev", {
      commit: "r1",
      gate: "fail",
      merged: ["c1"],
      failing: { output: "src/orders/cart.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'.\n", items: ["cart"] },
    });
    const hint = b.digest("a").claims.find((c) => c.item === "cart")!.seamCue!.hint;
    expect(actionFromHint(hint)).toEqual({
      type: "message",
      kind: "contract",
      payload: { target: "src/store.ts", change: "modify", itemId: "cart", description: "the exact change you need" },
      rationale: "the cue says so",
    });
  });
});

/**
 * The board run's budgets and caps, offline: a gate that always fails spends
 * the fix budgets, spent turn budgets and the run-wide budget end the run
 * honestly, budgets scale with the plan (explicit values win), the active-claim
 * cap stops hoarding, cost and time caps stop new turns, and plan reviews are
 * metered as model calls. No network: the generic policy (or a scripted
 * transport) takes every turn and deterministic executors edit.
 */
import { describe, expect, it } from "vitest";

import { activeClaims, foldBoard, pendingPushItems, reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport } from "@switchyard-change/model-adapters";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { formatBoardRunSummary, type BoardRunEvent, type BoardSeed } from "../src/run-board.ts";
import { FixedGate, GOAL, of, offline, project, seed, types } from "./run-board-fixtures.ts";

describe("runBoard (offline, lockstep, continuous integration)", () => {
  it("a gate that always fails: budgets are spent, items reopen for fresh eyes, the last revision decides, nothing is promoted", async () => {
    const projectDir = await project();
    const gate = new FixedGate(1);
    const result = await offline({
      goal: GOAL,
      projectDir,
      seed,
      appGateCommand: ["gate"],
      verifyCommandRunner: gate,
      budgets: { maxFixAttemptsPerItem: 1, maxRunTurns: 400, maxRounds: 400 },
    });
    expect(gate.ran.length).toBeGreaterThan(0);
    expect(result.revisions.every((r) => r.gate === "fail")).toBe(true);
    expect(types(result.log)).not.toContain("item.completed");
    // Each spent budget reopens the item for an agent that has not spent it yet.
    const reopened = of(result.log, "item.reopened");
    expect(reopened.length).toBeGreaterThan(0);
    for (const m of reopened) {
      const later = of(result.log, "claim.granted").filter((g) => g.seq > m.seq && g.payload.item === m.payload.item);
      expect(later.every((g) => g.payload.agent !== m.payload.previousOwner)).toBe(true);
    }
    // The phase ends when every outstanding item was spent by every running
    // agent, judged on the leaf items: the re-planned parents (split, carried
    // by their children) never keep the fix-budget stop from firing.
    expect(of(result.log, "item.replanned").length).toBeGreaterThan(0);
    expect(result.stopReason).toBe("fix-budget");
    // The same pending set is never gated twice.
    const keys = result.revisions.map((r) => [...r.merged].sort().join(","));
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.verdict).toBe("failed");
    expect(result.promotion).toMatchObject({ committed: false });
    expect(result.promotion!.refusedReason).toMatch(/not "verified": not promoting/);
  });

  it("records spent turn budgets on the board and integrates nothing it did not get", async () => {
    const projectDir = await project();
    const result = await offline({
      goal: GOAL,
      projectDir,
      seed,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      budgets: { maxTurnsPerItem: 1 },
    });
    const help = of(result.log, "help.requested");
    // Each spent item is released once (no other agent can take it: help) and
    // the worker takes the next open item; the third item it exhausts stops it.
    expect(help.map((h) => h.payload.item)).toEqual(["core", "api", "wiring"]);
    expect(help.every((h) => h.from === "agent-1" && h.payload.need === "turn-budget")).toBe(true);
    expect(result.agents.find((a) => a.id === "agent-1")!.stop).toMatchObject({
      reason: "item-budget",
      detail: expect.stringMatching(/spent more than 1 turns on item wiring; exhausted 3 item\(s\) \(core, api, wiring\), at most 3/),
    });
    // Open work remains, so ONE replacement joins (a new id; the join bound is
    // twice the dial's max): it is held to the same per-item budget and the
    // board goes quiet (its claim contests the stopped holder's wide claim).
    expect(of(result.log, "agent.joined").map((m) => m.from)).toEqual(["lead", "agent-1", "agent-2"]);
    expect(of(result.log, "agent.joined").find((m) => m.from === "agent-2")!.rationale).toMatch(/^replacing 1 stopped agent\(s\): \d+ open item\(s\) outnumber the 0 agent\(s\) in flight/);
    expect(result.stopReason).toBe("quiescent");
    expect(types(result.log)).not.toContain("push.announced");
    expect(result.revision).toBeUndefined();
    expect(result.verdict).toBe("failed");
    expect(result.promotion?.committed).not.toBe(true);
  });

  it("stops at the run-wide budget", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, budgets: { maxRunTurns: 4 } });
    expect(result.stopReason).toBe("run-budget");
    expect(result.turns.filter((t) => t.outcome !== "seeded").length).toBeLessThanOrEqual(4);
  });
});

describe("no claim hoarding (the active-claim cap)", () => {
  it("a greedy agent never holds more unfinished items than the cap; other agents get the open items; the run completes", async () => {
    const projectDir = await project();
    const sixItems = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: Array.from({ length: 6 }, (_, i) => ({ item: `i${i}`, objective: `do part ${i}`, acceptance: ["gate passes"], scopeHint: [`src/part${i}.ts`] })),
    });
    // agent-1 tries to claim every open item before doing anything else.
    const policy = createGenericBoardPolicy();
    const greedy: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      if (input.agent === "agent-1") {
        const tried = new Set(input.capsule.decisions.filter((h) => h.action.type === "claim").map((h) => (h.action as { itemId: string }).itemId));
        const open = input.digest.openItems.find((i) => !tried.has(i.item));
        if (open) {
          return { action: { type: "claim", itemId: open.item, intent: { read: [], write: [...open.scopeHint] }, rationale: "taking everything" } };
        }
      }
      return policy(input);
    };
    const result = await offline({ goal: GOAL, projectDir, seed: sixItems, transport: greedy, fixtureGate: true });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.rules.maxActiveClaims).toBe(1);
    // At every grant, the grantee holds at most the cap of unfinished change items.
    for (const grant of of(log, "claim.granted")) {
      const state = foldBoard(log, grant.seq);
      expect({ seq: grant.seq, held: activeClaims(state, grant.payload.agent).length <= 1 }).toEqual({ seq: grant.seq, held: true });
    }
    expect(result.turns.some((t) => t.agent === "agent-1" && t.code === "CLAIM_CAP")).toBe(true);
    const owners = new Set(of(log, "claim.granted").filter((m) => /^i\d$/.test(m.payload.item)).map((m) => m.payload.agent));
    expect(owners.size).toBeGreaterThan(1);
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(log)).toEqual(result.state);
  });
});

describe("budgets that scale with the plan (explicit values win)", () => {
  it("scales fix attempts and the dial's max with the planned items, bounded", async () => {
    const { scaledBudgets } = await import("../src/run-board.ts");
    const dial = { minConcurrency: 1, maxConcurrency: 3 };
    expect(scaledBudgets({ items: 10, dial, scaleDial: true })).toEqual({
      maxFixAttempts: 5,
      fixAttemptsScaled: true,
      // The per-item turns: max(8, 4 + 2 per fix attempt), so five fix requests are not starved.
      maxTurnsPerItem: 14,
      itemTurnsScaled: true,
      dialMax: 6,
      dialScaled: true,
      maxRunTurns: 250,
      runTurnsScaled: true,
      maxActiveClaims: 1,
      activeClaimsScaled: true,
      // The lease: max(150, 40 per agent of the dial's max); the deadline 8 leases.
      claimLeaseMessages: 240,
      leaseScaled: true,
      claimDeadlineMessages: 1920,
      deadlineScaled: true,
    });
    expect(scaledBudgets({ items: 2, dial, scaleDial: true })).toMatchObject({ claimLeaseMessages: 150, claimDeadlineMessages: 1200 });
    expect(scaledBudgets({ items: 2, explicitLease: 30, dial, scaleDial: true })).toMatchObject({ claimLeaseMessages: 30, leaseScaled: false, claimDeadlineMessages: 240 });
    // The run-wide turn budget weighs scope size: max(200, 25 per item + 10 per scope file), at most 800.
    expect(scaledBudgets({ items: 2, dial, scaleDial: true })).toMatchObject({ maxFixAttempts: 3, maxTurnsPerItem: 10, dialMax: 2, maxRunTurns: 200 });
    expect(scaledBudgets({ items: 40, dial, scaleDial: true })).toMatchObject({ maxFixAttempts: 6, maxTurnsPerItem: 16 });
    expect(scaledBudgets({ items: 10, explicitItemTurns: 3, dial, scaleDial: true })).toMatchObject({ maxTurnsPerItem: 3, itemTurnsScaled: false });
    expect(scaledBudgets({ items: 7, scopeFiles: 12, dial, scaleDial: false })).toMatchObject({ maxRunTurns: 295 }); // sf7: 7 large items
    expect(scaledBudgets({ items: 15, dial, scaleDial: true })).toMatchObject({ maxRunTurns: 375 });
    expect(scaledBudgets({ items: 40, scopeFiles: 60, dial, scaleDial: true })).toMatchObject({ maxFixAttempts: 6, dialMax: 6, maxRunTurns: 800 });
    // The claim cap: 1, or 2 when items are at least three times the dial's max.
    expect(scaledBudgets({ items: 9, dial, scaleDial: false })).toMatchObject({ maxActiveClaims: 2 });
    expect(scaledBudgets({ items: 8, dial, scaleDial: false })).toMatchObject({ maxActiveClaims: 1 });
    expect(
      scaledBudgets({ items: 10, explicitFixAttempts: 2, explicitRunTurns: 1000, explicitActiveClaims: 3, explicitLease: 90, explicitDeadline: 500, dial, scaleDial: false }),
    ).toEqual({
      maxFixAttempts: 2,
      fixAttemptsScaled: false,
      maxTurnsPerItem: 8,
      itemTurnsScaled: true,
      dialMax: 3,
      dialScaled: false,
      maxRunTurns: 1000,
      runTurnsScaled: false,
      maxActiveClaims: 3,
      activeClaimsScaled: false,
      claimLeaseMessages: 90,
      leaseScaled: false,
      claimDeadlineMessages: 500,
      deadlineScaled: false,
    });
  });

  it("says so when a plan is empty or the scaled turn budget is capped below what the plan asks", async () => {
    const { scaledBudgets, formatBudgetsLine } = await import("../src/run-board.ts");
    const dial = { minConcurrency: 1, maxConcurrency: 3 };
    const empty = scaledBudgets({ items: 0, dial, scaleDial: false });
    expect(empty.warnings).toEqual([expect.stringMatching(/the plan has no items: .*never ends all-items-done/)]);
    const huge = scaledBudgets({ items: 900, dial, scaleDial: false });
    expect(huge.maxRunTurns).toBe(800);
    expect(huge.warnings).toEqual([expect.stringMatching(/capped at 800 \(the plan's size asks for 22500, and it has more items \(900\) than turns\): pass an explicit run-turn budget/)]);
    expect(formatBudgetsLine({ ...huge, items: 900 })).toContain("; warning: the plan-scaled run-turn budget is capped at 800");
    // An explicit budget silences it; a plan that fits has none.
    expect(scaledBudgets({ items: 900, explicitRunTurns: 30000, dial, scaleDial: false }).warnings).toBeUndefined();
    expect(scaledBudgets({ items: 10, dial, scaleDial: false }).warnings).toBeUndefined();
  });

  it("an explicit goal-rule claim cap is respected, never overwritten by the scaled one", async () => {
    const result = await offline({ goal: GOAL, projectDir: await project(), seed, rules: { maxActiveClaims: 3 } });
    expect(of(result.log, "goal.posted")[0]!.payload.rules).toMatchObject({ maxActiveClaims: 3 });
    expect(formatBoardRunSummary(result)).toMatch(/claim cap 3 unfinished item\(s\) per agent \(explicit\)/);
  });

  it("a run posts the scaled fix budget with its goal, recruits under the scaled dial, and prints the effective values", async () => {
    const projectDir = await project();
    const tenItems = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: Array.from({ length: 10 }, (_, i) => ({ item: `i${i}`, objective: `do part ${i}`, acceptance: ["gate passes"], scopeHint: [`src/part${i}.ts`] })),
    });
    const result = await offline({ goal: GOAL, projectDir, seed: tenItems, scaleDial: true });
    expect(of(result.log, "goal.posted")[0]!.payload.rules).toMatchObject({ maxFixAttempts: 5, maxActiveClaims: 1, claimLeaseMessages: 240, claimDeadlineMessages: 1920 });
    expect(of(result.log, "agent.joined").filter((m) => m.from !== "lead").length).toBeLessThanOrEqual(6);
    expect(of(result.log, "agent.joined").filter((m) => m.from !== "lead").length).toBeGreaterThan(3);
    expect(formatBoardRunSummary(result)).toMatch(
      /budgets: 5 fix attempt\(s\) per item \(scaled with 10 planned item\(s\)\), 14 turn\(s\) per item per agent \(scaled with the fix attempts\), dial max 6 \(scaled with 10 planned item\(s\)\), 350 run turn\(s\) \(scaled with 10 planned item\(s\) and 10 scope file\(s\)\), claim cap 1 unfinished item\(s\) per agent \(scaled\), claim lease 240 board message\(s\) without progress \(scaled with dial max 6\), claim deadline 1920 message\(s\)/,
    );
  });
});

describe("cost and time caps (demo safety)", () => {
  it("a model-call cap stops new turns, is recorded once, the in-flight work is integrated, and the verdict stays the gate's", async () => {
    const projectDir = await project();
    const events: BoardRunEvent[] = [];
    const result = await offline({ goal: GOAL, projectDir, seed, caps: { maxCalls: 12 }, onEvent: (e) => events.push(e) });
    expect(result.stopReason).toBe("capped");
    expect(result.stopDetail).toMatch(/the model-calls cap was reached \(\d+ of 12\): no new turns/);
    const capped = result.log.filter((m) => m.type === "run.capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]!.payload).toMatchObject({ kind: "model-calls", limit: 12 });
    expect(events.some((e) => e.kind === "capped")).toBe(true);
    // Nothing announced was left ungated: the last integration ran after the cap.
    expect(pendingPushItems(result.state)).toEqual([]);
    expect(result.usage).toMatchObject({ capped: [expect.objectContaining({ kind: "model-calls" })] });
    expect(formatBoardRunSummary(result)).toMatch(/caps: 12 model call\(s\)/);
    expect(formatBoardRunSummary(result)).toMatch(/usage: \d+ model call\(s\)/);
    expect(result.proof!.caps).toEqual([expect.objectContaining({ kind: "model-calls", limit: 12 })]);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a wall-clock cap (on an injected clock) ends the agent phase as capped", async () => {
    const projectDir = await project();
    let now = 0;
    const result = await offline({ goal: GOAL, projectDir, seed, caps: { maxWallMs: 1000 }, capsClock: () => (now += 200) });
    expect(result.stopReason).toBe("capped");
    expect(result.log.find((m) => m.type === "run.capped")!.payload).toMatchObject({ kind: "wall-clock", limit: 1000 });
  });

  it("an item at its call cap gets no more turns (ITEM_CAP), recorded once for that item", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, caps: { maxCallsPerItem: 1 } });
    expect(result.turns.some((t) => t.code === "ITEM_CAP")).toBe(true);
    const itemCaps = result.log.filter((m) => m.type === "run.capped" && (m.payload as { kind: string }).kind === "item-calls");
    expect(itemCaps.length).toBeGreaterThan(0);
    expect(new Set(itemCaps.map((m) => (m.payload as { item: string }).item)).size).toBe(itemCaps.length);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

describe("runBoard meters the planner pass's plan-review decisions", () => {
  it("each plan review the seed carries (the chosen plan's and every earlier one's) counts as a model call", async () => {
    const plain = await offline({ goal: GOAL, projectDir: await project(), seed });
    const review = { question: "Does this plan cover the goal?", noul: "yes", confidence: 0.9, accepted: true };
    const reviewed = await offline({
      goal: GOAL,
      projectDir: await project(),
      seed: async () => ({ ...(await seed()), review, priorReviews: [{ ...review, accepted: false, confidence: 0.4, model: "m0", units: ["core"] }] }),
    });
    expect(of(reviewed.log, "decision.recorded").filter((m) => m.payload.juncture === "plan-review")).toHaveLength(2);
    expect(reviewed.usage!.calls - plain.usage!.calls).toBe(2);
  }, 120_000);
});

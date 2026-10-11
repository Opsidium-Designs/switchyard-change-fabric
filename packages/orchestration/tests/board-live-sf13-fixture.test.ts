/**
 * The failed storefront run board-live-sf13 (fixtures/board-live-sf13.log.json,
 * its 86 board messages; work-root paths scrubbed, no credential, no local
 * path): a local TS2739 annotation error in src/catalog/products.ts cued seam
 * contracts on every seam the file imports (http.ts, then money.ts); the lead
 * rejected the first and answered the second (agent-3-contract-5) with waits.
 * A lead wait had no re-cue and the quiet-board driver had no lead step, while
 * the pending contract kept the item's claim from lapsing and its holder from
 * proposing another: the run ended quiescent with nothing decided. Replayed to
 * seq 85 the quiet-board planner now nudges the lead about that contract first
 * and the holder of the regressed billing push next; the TS2739 cues no seam;
 * and under revision 6 the settled seam item for src/store.ts no longer turns
 * agent-1's follow-up seam contract into a dead "ask its owner" route. The log
 * replays unchanged (revision 5).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkBoardTransition, foldBoard, reduceBoard, seamContractCue, type BoardMessage, type BoardState } from "@switchyard-change/change-core";

import { pendingContractCue } from "../src/board-agent.ts";
import { quietBoardActions, undecidedContractLines } from "../src/run-board.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "board-live-sf13.log.json");
const log = JSON.parse(readFileSync(FIXTURE, "utf8")) as BoardMessage[];

describe("the recorded storefront run board-live-sf13 (a seam contract the lead never decided)", () => {
  it("replays unchanged under its recorded revision 5, with no work-root or local path in it", () => {
    expect(log).toHaveLength(86);
    const goal = log[0]!;
    expect(goal.type === "goal.posted" && goal.payload.rules.arbitration).toBe(5);
    expect(foldBoard(log)).toEqual(reduceBoard(log));
    expect(readFileSync(FIXTURE, "utf8")).not.toMatch(/\/tmp\/scf-board-|\/home\//);
  });

  it("at seq 85 the quiet board nudges the lead about agent-3-contract-5 first, then the holder of the regressed billing push", () => {
    const state = foldBoard(log, 85);
    expect(state.contracts["agent-3-contract-5"]).toMatchObject({ status: "proposed", seam: "src/contracts/money.ts", item: "catalog-tighten-endpoints.r1" });
    const plan = quietBoardActions(state);
    expect(plan[0]).toEqual({ kind: "lead-contracts", contracts: ["agent-3-contract-5"], items: ["catalog-tighten-endpoints.r1"] });
    expect(plan).toContainEqual(expect.objectContaining({ kind: "held", item: "billing-money-auth-and-safe-endpoints", agent: "agent-1", reason: "push-regressed" }));
    // Waiting for the lead is the lead's to act on: the blocked item is never judged as a stalled holder.
    expect(plan.some((a) => a.kind === "held" && a.item === "catalog-tighten-endpoints.r1")).toBe(false);
    // What the lead is told, and what a quiet ending names (nothing decides it).
    expect(pendingContractCue(state)?.text).toMatch(
      /^PENDING CONTRACT\(S\) TO DECIDE: agent-3-contract-5 \(modify src\/contracts\/money\.ts, for catalog-tighten-endpoints\.r1; triage reject \(confidence 0\.96\)\): decide_contract now/,
    );
    expect(undecidedContractLines(state, new Map([["agent-3-contract-5", 2]]))).toEqual([
      "the lead never decided seam contract agent-3-contract-5 (src/contracts/money.ts) blocking catalog-tighten-endpoints.r1 after 2 nudge(s)",
    ]);
  });

  it("the TS2739 on 'Record<string, unknown>' (rev 7, asked of catalog-tighten-endpoints.r1) cues no seam contract", () => {
    const rev7 = log.find((m) => m.type === "integrated.rev" && m.payload.n === 7)!;
    expect(rev7.type === "integrated.rev" && rev7.payload.failing?.output).toMatch(/src\/catalog\/products\.ts\(58,11\): error TS2739: Type 'Record<string, unknown>'/);
    for (const seq of [69, 79]) {
      expect(seamContractCue(foldBoard(log, seq), "catalog-tighten-endpoints.r1")).toBeUndefined();
    }
  });

  it("agent-1's follow-up change to src/store.ts: refused as 'ask its owner' under revision 5, a seam contract for the lead under revision 6", () => {
    const state = foldBoard(log, 85);
    const draft = {
      from: "agent-1",
      type: "contract.proposed",
      payload: { contract: "agent-1-contract-9", target: "src/store.ts", kind: "modify", item: "billing-money-auth-and-safe-endpoints", description: "add an optional user field to Ctx" },
    } as const;
    expect(() => checkBoardTransition(state, draft, "posted")).toThrow(/in item seam-agent-3-contract-1's scope: ask its owner/);
    const v6: BoardState = { ...state, rules: { ...state.rules, arbitration: 6 } };
    expect(() => checkBoardTransition(v6, draft, "posted")).not.toThrow();
  });
});

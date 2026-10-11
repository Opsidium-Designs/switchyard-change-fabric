/**
 * The failed storefront run board-live-sf9 (fixtures/board-live-sf9.log.json,
 * its 38 board messages; no credential, no local path): every sub-lead
 * claimed and pushed a child of its own split item, and under the old routing
 * each such push waited for a merge only its own author could make and no cue
 * asked for, so nothing was ever pending integration and the run ended
 * quiescent with three unintegrated pushes. A child the sub-lead pushed itself
 * now integrates directly: replayed to seq 28 (agent-2's push for unit2.1),
 * the board has a pending push to integrate. The log replays unchanged
 * (revision 3; the reducer never consults the routing).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  awaitingSubLead,
  checkBoardTransition,
  foldBoard,
  itemWaitReason,
  pendingPushItems,
  pendingPushKey,
  reduceBoard,
  type BoardMessage,
} from "@switchyard-change/change-core";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "board-live-sf9.log.json");
const log = JSON.parse(readFileSync(FIXTURE, "utf8")) as BoardMessage[];

describe("the recorded storefront run board-live-sf9 (sub-leads pushing their own children)", () => {
  it("replays unchanged under its recorded revision 3", () => {
    expect(log).toHaveLength(38);
    const goal = log[0]!;
    expect(goal.type === "goal.posted" && goal.payload.rules.arbitration).toBe(3);
    expect(foldBoard(log)).toEqual(reduceBoard(log));
  });

  it("at seq 28 the sub-lead's own child push is pending integration, not awaiting a merge, and a revision may merge it", () => {
    const state = foldBoard(log, 28);
    const push = log.find((m) => m.seq === 28)!;
    expect(push).toMatchObject({ from: "agent-2", type: "push.announced", payload: { item: "unit2.1" } });
    expect(state.items.unit2).toMatchObject({ status: "split", subLead: "agent-2" });
    expect(pendingPushKey(state)).not.toBe("");
    expect(pendingPushItems(state).map((i) => i.id)).toEqual(["unit2.1"]);
    expect(awaitingSubLead(state)).toEqual([]);
    expect(itemWaitReason(state, "unit2.1")).toMatchObject({ kind: "waiting-for-gate" });
    const commit = (push.payload as { commit: string }).commit;
    expect(() =>
      checkBoardTransition(state, { from: "engine", type: "integrated.rev", payload: { n: 1, commit: "r1", gate: "pass", merged: [commit], paths: ["src/orders/cart.ts"], contributors: ["agent-2"] } }, "engine"),
    ).not.toThrow();
  });

  it("at the end every unintegrated push is pending integration (none awaits a merge its author would have to make)", () => {
    const state = reduceBoard(log);
    expect(pendingPushItems(state).map((i) => i.id).sort()).toEqual(["unit1.2", "unit2.1", "unit3.2"]);
    expect(awaitingSubLead(state)).toEqual([]);
  });
});

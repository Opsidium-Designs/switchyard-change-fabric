/**
 * Replay determinism over the newer message types: a recorded board log of a
 * scripted end-to-end run (coverage-run.ts: leases, speculation, a re-plan, a
 * clash prediction, an excluded push, and a promotion) is kept as a fixture.
 * It must reduce and fold to the same state, fold at every batch boundary to
 * exactly what reducing that prefix gives, build a fully backed board graph
 * at every seq, and still be what the scenario records today (offline,
 * deterministic). Regenerate it with SCF_WRITE_COVERAGE_FIXTURE=1 after an
 * intended engine change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BoardError, foldBoard, reduceBoard, type BoardMessage } from "@switchyard-change/change-core";

import { assertBoardBacked, buildBoardGraph } from "../src/board-graph.ts";
import { runCoverageScenario } from "./coverage-run.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "board-coverage-run.log.json");

describe("the recorded coverage run (fixtures/board-coverage-run.log.json)", () => {
  it("the scenario still records exactly the fixture", async () => {
    const fresh = JSON.parse(JSON.stringify(await runCoverageScenario())) as BoardMessage[];
    if (process.env.SCF_WRITE_COVERAGE_FIXTURE === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(fresh, null, 2)}\n`);
    }
    expect(fresh).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  }, 120_000);

  const log = JSON.parse(readFileSync(FIXTURE, "utf8")) as BoardMessage[];

  it("carries every newer message type it covers", () => {
    const types = new Set(log.map((m) => m.type));
    for (const type of ["claim.lapsed", "claim.extended", "candidate.gated", "item.replanned", "clash.predicted", "revision.promoted", "push.excluded"] as const) {
      expect(types.has(type), type).toBe(true);
    }
    expect(log.find((m) => m.type === "goal.posted")!.payload).toMatchObject({ rules: { arbitration: 2, speculate: 3 } });
  });

  it("reduceBoard and foldBoard agree, at the end and at every batch boundary", () => {
    const reduced = reduceBoard(log);
    expect(foldBoard(log)).toEqual(reduced);
    let boundaries = 0;
    for (let k = 1; k <= log.length; k += 1) {
      let prefix: ReturnType<typeof reduceBoard>;
      try {
        prefix = reduceBoard(log.slice(0, k));
      } catch (error) {
        // A prefix that cuts an engine batch short is not a whole log.
        expect(error).toBeInstanceOf(BoardError);
        expect((error as BoardError).message).toMatch(/found end of log/);
        continue;
      }
      boundaries += 1;
      expect(foldBoard(log, log[k - 1]!.seq)).toEqual(prefix);
    }
    expect(boundaries).toBeGreaterThan(log.length / 2);
  });

  it("builds a backed board graph at every seq", () => {
    for (let k = 0; k <= log.length; k += 1) {
      const graph = buildBoardGraph(log, k);
      assertBoardBacked(graph, log);
      expect(graph.edges.every((e) => ["dependency", "spawn", "trigger", "consumed-tool"].includes(e.kind))).toBe(true);
    }
  });
});

/**
 * M2: evidence-governed recruitment, the min/max concurrency dial, and
 * event-driven waves, proven deterministically and offline.
 *
 * These tests exercise the exact recruitment policy and event trigger the live
 * Worker path uses, through the offline substrate (local-filesystem workspaces +
 * the deterministic noop executor), so they run in `make check` with no
 * Cloudflare account and no inference.
 *
 * They assert the three M2 claims:
 *   (a) recruitment respects the min/max dial and WIDENS with the dial through
 *       one code path (the shared `recruit` policy): the same engine, the same
 *       Change, only the dial changes, and the peak concurrency changes with it;
 *   (b) the next wave is triggered by a repo-pushed EVENT, not a timer: the run
 *       advances only when a repo-pushed event is ingested, and every non-kickoff
 *       recruitment event is tagged `repo-pushed` and names the pushing
 *       workspace;
 *   (c) each recruited agent gets its OWN distinct workspace.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec, recruit, DEFAULT_DIAL } from "@switchyard-change/change-core";

import { runRecruitment } from "../src/recruit-run.ts";

/**
 * A wide, flat Change: six independent WorkUnits, no dependencies. All six are
 * runnable at once, so the dial is the only thing that bounds how many agents
 * run concurrently. This is the clean case for proving the dial widens
 * concurrency.
 */
const FLAT_SPEC = `
id: change-recruit-flat
objective: Six independent units for dial-width proof
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: u1
    objective: unit one
    paths: [src/u1/**]
  - id: u2
    objective: unit two
    paths: [src/u2/**]
  - id: u3
    objective: unit three
    paths: [src/u3/**]
  - id: u4
    objective: unit four
    paths: [src/u4/**]
  - id: u5
    objective: unit five
    paths: [src/u5/**]
  - id: u6
    objective: unit six
    paths: [src/u6/**]
`;

/**
 * A layered Change: a base unit two others depend on, so the first wave is one
 * runnable unit, and the dependents only become runnable after the base agent
 * pushes. This is the clean case for proving the EVENT drives the next wave.
 */
const LAYERED_SPEC = `
id: change-recruit-layered
objective: A base unit gates two dependents
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: base
    objective: base unit
    paths: [src/base/**]
  - id: left
    objective: left dependent
    depends_on: [base]
    paths: [src/left/**]
  - id: right
    objective: right dependent
    depends_on: [base]
    paths: [src/right/**]
`;

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scf-m2-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("M2: the recruitment dial is a policy, not a hardcoded count", () => {
  it("the shared recruit policy widens the recruited slice as the max dial rises", () => {
    // The single code path: recruit() over the SAME runnable set, only the dial
    // changes. The recruited slice is a prefix of runnable bounded by the max.
    const runnable = ["u1", "u2", "u3", "u4", "u5", "u6"];
    const atTwo = recruit({ runnable, inFlight: 0, dial: { minConcurrency: 1, maxConcurrency: 2 } });
    const atFour = recruit({ runnable, inFlight: 0, dial: { minConcurrency: 1, maxConcurrency: 4 } });
    const atSix = recruit({ runnable, inFlight: 0, dial: { minConcurrency: 1, maxConcurrency: 6 } });

    expect(atTwo.recruit).toEqual(["u1", "u2"]);
    expect(atFour.recruit).toEqual(["u1", "u2", "u3", "u4"]);
    expect(atSix.recruit).toEqual(runnable);
    // The ceiling is the dial max, and raising it strictly widens the slice.
    expect(atTwo.recruit.length).toBeLessThan(atFour.recruit.length);
    expect(atFour.recruit.length).toBeLessThan(atSix.recruit.length);
  });

  it("the max is a hard ceiling: never more agents in flight than the dial allows", () => {
    // With two already in flight and a max of three, only one more may recruit,
    // even though five are runnable. This is the ceiling, not a per-unit count.
    const decision = recruit({
      runnable: ["a", "b", "c", "d", "e"],
      inFlight: 2,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
    });
    expect(decision.recruit).toEqual(["a"]);
    expect(decision.openSlotsAfter).toBe(0);
  });

  it("a bad dial is normalized rather than stalling or over-recruiting", () => {
    // max below 1 falls back to the default; min above max is clamped to max.
    const zeroMax = recruit({ runnable: ["a", "b"], inFlight: 0, dial: { minConcurrency: 1, maxConcurrency: 0 } });
    expect(zeroMax.ceiling).toBe(DEFAULT_DIAL.maxConcurrency);
    const invertedMin = recruit({ runnable: ["a", "b", "c"], inFlight: 0, dial: { minConcurrency: 9, maxConcurrency: 2 } });
    expect(invertedMin.recruit).toEqual(["a", "b"]);
  });
});

describe("M2: dial-bounded recruitment over a real run, same engine, only the dial changes", () => {
  it("a narrow dial and a wide dial run the SAME flat Change at different concurrency", async () => {
    const change = parseChangeSpec(FLAT_SPEC);

    const narrow = await runRecruitment({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workRoot: join(workRoot, "narrow"),
    });
    const wide = await runRecruitment({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 5 },
      workRoot: join(workRoot, "wide"),
    });

    // Both completed every unit; nothing was dropped by either dial.
    expect([...narrow.completed].sort()).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);
    expect([...wide.completed].sort()).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);

    // The dial is the only difference, and the peak concurrency widened with it:
    // the narrow dial never ran more than 2 agents at once; the wide dial ran
    // more. Same engine, same Change, same code path, wider only because the
    // dial is wider.
    expect(narrow.peakConcurrency).toBeLessThanOrEqual(2);
    expect(wide.peakConcurrency).toBeGreaterThan(narrow.peakConcurrency);
    expect(wide.peakConcurrency).toBeLessThanOrEqual(5);

    // No recruitment wave ever exceeded its dial ceiling.
    for (const wave of narrow.waves) {
      expect(wave.concurrency).toBeLessThanOrEqual(2);
    }
    for (const wave of wide.waves) {
      expect(wave.concurrency).toBeLessThanOrEqual(5);
    }
  });

  it("each recruited agent gets its OWN distinct workspace", async () => {
    const change = parseChangeSpec(FLAT_SPEC);
    const result = await runRecruitment({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workRoot,
    });

    // One distinct workspace per WorkUnit, all local-fallback (offline), and no
    // two agents shared a workspace.
    expect(result.workspaces.length).toBe(6);
    expect(new Set(result.workspaces).size).toBe(6);
    expect(result.offline).toBe(true);

    const allAgents = result.waves.flatMap((w) => w.agents);
    const names = allAgents.map((a) => a.workspaceName);
    expect(new Set(names).size).toBe(names.length);
    for (const agent of allAgents) {
      expect(agent.fallback).toBe(true);
      // Each agent committed a push in its own workspace.
      expect(agent.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("M2: the next wave is triggered by a repo-pushed EVENT, not a timer", () => {
  it("the base agent's push drives the dependents' wave through the event path", async () => {
    const change = parseChangeSpec(LAYERED_SPEC);
    const result = await runRecruitment({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workRoot,
    });

    // The kickoff wave recruited only the base (the one runnable unit). The
    // dependents could not be recruited until the base pushed.
    expect(result.waves[0]?.trigger).toBe("kickoff");
    expect(result.waves[0]?.agents.map((a) => a.unitId)).toEqual(["base"]);

    // A repo-pushed event for the base workspace was produced and drove the next
    // wave. The trigger is the EVENT: there is a push event naming the base
    // workspace, and the subsequent recruitment is tagged repo-pushed.
    const basePush = result.pushEvents.find((e) => e.workspace.endsWith("--base"));
    expect(basePush).toBeDefined();
    expect(basePush?.type).toBe("repo.pushed");

    // The recruitment log shows the dependents were recruited by a repo-pushed
    // event (not a kickoff and not a timer), and names the pushing workspace.
    const eventDriven = result.recruitments.filter((r) => r.trigger === "repo-pushed");
    expect(eventDriven.length).toBeGreaterThan(0);
    const recruitedByEvents = eventDriven.flatMap((r) => r.recruited);
    expect([...recruitedByEvents].sort()).toEqual(["left", "right"]);
    const dependentWave = eventDriven.find((r) => r.recruited.includes("left"));
    expect(dependentWave?.pushedWorkspace).toMatch(/--base$/);
    expect(dependentWave?.completedUnit).toBe("base");

    // All three units completed, base before its dependents.
    expect([...result.completed].sort()).toEqual(["base", "left", "right"]);
    expect(result.completed.indexOf("base")).toBeLessThan(result.completed.indexOf("left"));
    expect(result.completed.indexOf("base")).toBeLessThan(result.completed.indexOf("right"));

    // Every non-kickoff wave was event-triggered: no wave advanced on a timer.
    const nonKickoff = result.waves.filter((w) => w.trigger !== "kickoff");
    expect(nonKickoff.length).toBeGreaterThan(0);
    for (const wave of nonKickoff) {
      expect(wave.trigger).toBe("repo-pushed");
    }
  });
});

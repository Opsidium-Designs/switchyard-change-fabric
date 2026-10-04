/**
 * M1 integration: decompose the two real seeded goals against the two real
 * seeded target projects on disk, show the resulting WorkGraphs differ in shape,
 * and run a decomposed goal through the same offline run loop the hand-authored
 * YAML Change uses.
 *
 * This is the end-to-end proof of the milestone against the real example inputs
 * (not synthetic fixtures): the same engine, two structurally different goals,
 * two differently-shaped graphs, with the decomposed Change driving the full
 * pipeline to a promoted local Git commit exactly as a YAML Change does.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { changeToSpecYaml, decomposeGoal, runChange } from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const AUDIT_GOAL_FILE = join(REPO_ROOT, "examples", "goals", "audit-logging.goal.txt");
const VALIDATION_GOAL_FILE = join(REPO_ROOT, "examples", "goals", "add-input-validation.goal.txt");
const DEMO_PROJECT = join(REPO_ROOT, "examples", "demo-project");
const CALC_PROJECT = join(REPO_ROOT, "examples", "calc-project");

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scf-m1-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("M1: goal-agnostic decomposition over the real seeded inputs", () => {
  it("produces two differently-shaped graphs from the two seeded goals via one engine", async () => {
    const auditGoal = (await readFile(AUDIT_GOAL_FILE, "utf8")).trim();
    const validationGoal = (await readFile(VALIDATION_GOAL_FILE, "utf8")).trim();

    const audit = await decomposeGoal({ goal: auditGoal, projectDir: DEMO_PROJECT });
    const validation = await decomposeGoal({ goal: validationGoal, projectDir: CALC_PROJECT });

    // Different unit counts.
    expect(audit.graph.nodes.length).not.toBe(validation.graph.nodes.length);

    // Audit (layered goal + layered repo): has dependency edges.
    expect(audit.graph.edges.length).toBeGreaterThan(0);

    // Validation (universal goal + flat repo): fans out per file, no edges.
    expect(validation.intent.isUniversal).toBe(true);
    expect(validation.graph.edges.length).toBe(0);
    expect(validation.graph.nodes.length).toBeGreaterThanOrEqual(4);

    // The validation units are scoped to the calc project's real source files.
    const validationPaths = validation.change.work.flatMap((u) => [...u.paths]);
    expect(validationPaths.some((p) => p.includes("statistics"))).toBe(true);
    expect(validationPaths.some((p) => p.includes("geometry"))).toBe(true);
    expect(validationPaths.some((p) => p.includes("finance"))).toBe(true);
    expect(validationPaths.some((p) => p.includes("temperature"))).toBe(true);
  });

  it("runs a decomposed goal to completion offline, promoting a real local Git commit", async () => {
    const validationGoal = (await readFile(VALIDATION_GOAL_FILE, "utf8")).trim();
    const decomposition = await decomposeGoal({
      goal: validationGoal,
      projectDir: CALC_PROJECT,
    });

    // Run the decomposed Change through exactly the same loop as a YAML Change,
    // by serializing it back to the one spec shape the loader consumes.
    const result = await runChange({
      specYaml: changeToSpecYaml(decomposition.change),
      projectDir: CALC_PROJECT,
      workRoot,
    });

    expect(result.offline).toBe(true);
    expect(result.executor).toBe("noop");
    // Every WorkUnit verified and the whole graph completed and promoted.
    for (const unit of result.evidence.units) {
      expect(unit.verdict).toBe("verified");
    }
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(result.promotion.committed).toBe(true);
    expect(result.promotion.commit).toMatch(/^[0-9a-f]{40}$/);
    // The number of run units matches the decomposed graph.
    expect(result.units.length).toBe(decomposition.graph.nodes.length);
  });

  it("round-trips a decomposed Change through the YAML spec shape unchanged", async () => {
    const auditGoal = (await readFile(AUDIT_GOAL_FILE, "utf8")).trim();
    const { change } = await decomposeGoal({ goal: auditGoal, projectDir: DEMO_PROJECT });
    const yaml = changeToSpecYaml(change);
    // The serialized spec is parseable and reproduces the same work ids.
    const { parseChangeSpec } = await import("@switchyard-change/change-core");
    const reparsed = parseChangeSpec(yaml);
    expect(reparsed.work.map((u) => u.id)).toEqual(change.work.map((u) => u.id));
    expect(reparsed.id).toBe(change.id);
  });
});

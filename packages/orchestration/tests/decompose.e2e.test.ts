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
const SERVICE_GOAL_FILE = join(REPO_ROOT, "examples", "goals", "service-api-validation-auth.goal.txt");
const DEMO_PROJECT = join(REPO_ROOT, "examples", "demo-project");
const CALC_PROJECT = join(REPO_ROOT, "examples", "calc-project");
const SERVICE_API = join(REPO_ROOT, "examples", "apps", "service-api");

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

describe("G2: cohesion-aware module decomposition over the real service-api app", () => {
  it("decomposes the service into one owner unit per resource with the shared contracts frozen", async () => {
    const serviceGoal = (await readFile(SERVICE_GOAL_FILE, "utf8")).trim();
    const result = await decomposeGoal({ goal: serviceGoal, projectDir: SERVICE_API });

    // The repo is modular, so a blueprint was produced (not the single-unit
    // fallback) and the work is grouped by resource module, not file-split.
    expect(result.blueprint).toBeDefined();

    // One owner unit per resource module under src/resources (six resources).
    const ownerUnits = result.change.work.filter((u) =>
      u.paths.some((p) => p.startsWith("src/resources/")),
    );
    expect(ownerUnits.length).toBe(6);
    const ownedFiles = ownerUnits.flatMap((u) => [...u.paths]).sort();
    expect(ownedFiles).toEqual([
      "src/resources/auth.js",
      "src/resources/notifications.js",
      "src/resources/orders.js",
      "src/resources/products.js",
      "src/resources/search.js",
      "src/resources/users.js",
    ]);

    // The two shared contracts are frozen read-only: carried on the Change and
    // owned by no unit (never a unit path, so a unit can read them but not
    // rewrite them).
    const contractPaths = result.change.blueprint!.contracts.map((c) => c.path).sort();
    expect(contractPaths).toEqual([
      "src/contracts/auth.js",
      "src/contracts/response.js",
    ]);
    const frozen = new Set(contractPaths);
    for (const unit of result.change.work) {
      for (const path of unit.paths) {
        expect(frozen.has(path)).toBe(false);
      }
    }

    // Single-writer ownership: no two units declare the same path.
    const seen = new Set<string>();
    for (const unit of result.change.work) {
      for (const path of unit.paths) {
        expect(seen.has(path)).toBe(false);
        seen.add(path);
      }
    }

    // The independent resources fan out in one wave (no edges among owners).
    const ownerIds = new Set(ownerUnits.map((u) => u.id));
    const edgesAmongOwners = result.graph.edges.filter(
      (e) => ownerIds.has(e.from) && ownerIds.has(e.to),
    );
    expect(edgesAmongOwners.length).toBe(0);
  });

  it("runs the module-owned decomposition offline to a promoted commit, contracts untouched", async () => {
    const serviceGoal = (await readFile(SERVICE_GOAL_FILE, "utf8")).trim();
    const decomposition = await decomposeGoal({ goal: serviceGoal, projectDir: SERVICE_API });

    // Reuse the existing lead-integrator / promotion path unchanged: the
    // module-owned units each own a disjoint file and the frozen contracts are
    // in no unit's paths, so the units compose coherently (no path collisions,
    // no incoherent overlay) and the integrator settles on the promoted tree.
    const result = await runChange({
      specYaml: changeToSpecYaml(decomposition.change),
      projectDir: SERVICE_API,
      workRoot,
    });

    expect(result.offline).toBe(true);
    expect(result.executor).toBe("noop");
    for (const unit of result.evidence.units) {
      expect(unit.verdict).toBe("verified");
    }
    // The integrator settled on the exact promoted tree (gate-equals-deploy path).
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(result.promotion.committed).toBe(true);
    expect(result.promotion.commit).toMatch(/^[0-9a-f]{40}$/);

    // The run touched one disjoint resource file per unit and no frozen contract
    // appears among any unit's changed paths, so there is no contested overlay.
    const changed = result.units.flatMap((u) => [...u.changedPaths]);
    expect(changed.every((p) => !p.startsWith("src/contracts/"))).toBe(true);
    // No contested path collision needed coordinating away: disjoint ownership.
    expect(result.leasePlan.decisions.length).toBe(0);
    expect(result.leasePlan.needsAttention).toBe(false);
  });
});

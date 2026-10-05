/**
 * The LIVE decomposition path over the real modular service-api app carries a
 * populated cohesion blueprint all the way to the inputs the agent prompt reads.
 *
 * The reported failure was a live run producing an EMPTY blueprint, so the
 * frozen-contract and preserve-exports steering never reached the agents and the
 * integrated service dropped its `handle` export. The cause was a wrong target:
 * the default live run decomposed a flat, non-modular project (no blueprint),
 * not the modular service-api. The offline G2 test passed because it pointed at
 * the modular app directly, so it never exercised the live run path's own
 * derivation of frozenContracts + requiredExports from a Worker-reconstructed
 * Change.
 *
 * This test closes that gap. It drives the SAME chain a live run of the modular
 * app drives, offline and deterministically:
 *
 *   decomposeGoal(real service-api dir)   // the live scan + decompose
 *     -> changeToSpecYaml                  // the spec the live run POSTs
 *     -> parseChangeSpec                   // the Worker-reconstructed Change
 *     -> frozenContracts + requiredExports // exactly as run-live derives them
 *
 * and asserts both are NON-EMPTY and map to the real service resources, so the
 * agent prompt would list the frozen src/contracts/* seams and tell each owner
 * unit to keep its `handle` export. The derivation here mirrors run-live.ts line
 * for line (frozenContracts = blueprint.contracts.map(c => c.path);
 * requiredExportsByUnit from blueprint.modules), so a regression that empties
 * the live blueprint fails here even though the offline-only G2 test would not.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { changeToSpecYaml, decomposeGoal } from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const SERVICE_GOAL_FILE = join(
  REPO_ROOT,
  "examples",
  "goals",
  "service-api-validation-auth.goal.txt",
);
const SERVICE_API = join(REPO_ROOT, "examples", "apps", "service-api");

/**
 * Replicate the live run's own derivation of the prompt inputs from a
 * (Worker-reconstructed) Change, verbatim from run-live.ts: the frozen contract
 * paths and the per-unit required exports. If the blueprint is empty, both come
 * out empty, which is exactly the reported failure.
 */
function livePromptInputs(change: {
  readonly blueprint?: {
    readonly contracts: readonly { readonly path: string }[];
    readonly modules: readonly { readonly unitId: string; readonly exports: readonly string[] }[];
  };
}): { frozenContracts: readonly string[]; requiredExportsByUnit: Map<string, readonly string[]> } {
  const frozenContracts = (change.blueprint?.contracts ?? []).map((c) => c.path);
  const requiredExportsByUnit = new Map<string, readonly string[]>();
  for (const module of change.blueprint?.modules ?? []) {
    if (module.exports.length > 0) {
      requiredExportsByUnit.set(module.unitId, module.exports);
    }
  }
  return { frozenContracts, requiredExportsByUnit };
}

describe("the live decompose path over the modular service-api carries a populated blueprint to the prompt inputs", () => {
  it("decomposeGoal scanning the REAL service-api dir yields a blueprint with contracts AND per-module exports", async () => {
    const goal = (await readFile(SERVICE_GOAL_FILE, "utf8")).trim();

    // The live path: scan the real modular app on disk and decompose it. This is
    // the exact call the CLI run-live command makes via resolveChange, so a
    // regression that stops producing a blueprint here is a regression in the
    // live run itself, not only in a synthetic fixture.
    const decomposition = await decomposeGoal({ goal, projectDir: SERVICE_API });

    // The modular repo produces a blueprint (not the single-unit fallback).
    expect(decomposition.blueprint).toBeDefined();
    const contracts = decomposition.change.blueprint!.contracts.map((c) => c.path).sort();
    expect(contracts).toEqual(["src/contracts/auth.js", "src/contracts/response.js"]);

    // Every resource owner module captured its public `handle` export.
    const modules = decomposition.change.blueprint!.modules;
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      expect(module.exports).toEqual(["handle"]);
    }
  });

  it("the Worker-reconstructed Change yields NON-EMPTY frozenContracts + per-unit requiredExports (the prompt inputs), closing the empty-blueprint gap", async () => {
    const goal = (await readFile(SERVICE_GOAL_FILE, "utf8")).trim();
    const decomposition = await decomposeGoal({ goal, projectDir: SERVICE_API });

    // The live run POSTs the spec YAML to the Worker, which reconstructs the
    // Change by parsing it. Derive the prompt inputs from the RECONSTRUCTED
    // Change exactly as run-live does, so this proves the inputs survive the real
    // round-trip, not just the in-memory decomposition.
    const specYaml = changeToSpecYaml(decomposition.change);
    const { parseChangeSpec } = await import("@switchyard-change/change-core");
    const reconstructed = parseChangeSpec(specYaml);

    const { frozenContracts, requiredExportsByUnit } = livePromptInputs(reconstructed);

    // The frozen-contract list the base/retry prompts render is NON-EMPTY and is
    // the two shared read-only seams. Before the fix this list was empty.
    expect(frozenContracts.length).toBeGreaterThan(0);
    expect([...frozenContracts].sort()).toEqual([
      "src/contracts/auth.js",
      "src/contracts/response.js",
    ]);

    // The per-unit required-exports map the prompt reads is NON-EMPTY, with every
    // resource owner unit keeping its `handle` export. Before the fix this map
    // was empty, so the "keep these exports present" instruction never fired and
    // the deployed service lost `export handle`.
    expect(requiredExportsByUnit.size).toBeGreaterThan(0);
    for (const [, exports] of requiredExportsByUnit) {
      expect(exports).toEqual(["handle"]);
    }

    // The users resource specifically carries its export through the live path.
    const ownerUnits = reconstructed.work.filter((u) =>
      u.paths.some((p) => p.startsWith("src/resources/")),
    );
    const usersUnit = ownerUnits.find((u) => u.paths.some((p) => p.endsWith("resources/users.js")));
    expect(usersUnit).toBeDefined();
    expect(requiredExportsByUnit.get(usersUnit!.id)).toEqual(["handle"]);
  });
});

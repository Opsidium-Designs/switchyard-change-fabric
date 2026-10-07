/**
 * The schema-constrained planner pass over the deterministic structural
 * backbone. These tests are offline: the plan transport is a deterministic FAKE
 * (no network), so `make check` stays reproducible. They pin that:
 *   - a schema-conforming, backbone-true plan projects to a Change whose units,
 *     objectives, dependency order, frozen contracts, and exported interfaces
 *     carry onto the Change (so the planned Change reaches a run like a heuristic
 *     one);
 *   - a plan that invents a path, or lets a unit own a frozen contract, is
 *     rejected and the pass escalates, then FALLS BACK to the heuristic rather
 *     than shipping a broken plan;
 *   - the ordered escalation ladder is walked: an invalid base-model plan is
 *     retried on the next model, and a valid escalation plan is accepted;
 *   - the planner honors single-writer ownership and the frozen contracts, so
 *     the cohesion backbone is preserved;
 *   - the recorded plan names how the Change was produced (planner vs fallback).
 */

import { describe, expect, it } from "vitest";

import {
  planGoal,
  validatePlan,
  type PlannedShape,
  type PlanTransport,
  type RepoFile,
} from "../src/index.ts";
import { buildRepoSnapshot } from "../src/repo-snapshot.ts";
import { deriveCohesionBlueprint } from "../src/blueprint.ts";

/** Build a resource module that imports the two shared seam contracts. */
function resource(name: string): RepoFile {
  return {
    path: `src/resources/${name}.js`,
    content:
      `import { json, problem, readBody } from "../contracts/response.js";\n` +
      `import { requireAuth } from "../contracts/auth.js";\n` +
      `export async function handle(request, parts) { return json({ ${name}: [] }); }\n`,
  };
}

/** A modular service repo: four independent resources over two frozen seams. */
const SERVICE_REPO: RepoFile[] = [
  {
    path: "src/contracts/response.js",
    content:
      "export function json(b){return b;}\nexport function problem(s,d){return d;}\nexport async function readBody(r){return {};}\n",
  },
  {
    path: "src/contracts/auth.js",
    content: "import { problem } from './response.js';\nexport function requireAuth(r){return null;}\n",
  },
  resource("users"),
  resource("orders"),
  resource("products"),
  resource("search"),
  {
    path: "src/index.js",
    content:
      `import { handle as users } from "./resources/users.js";\n` +
      `export default { fetch(){ return new Response(); } };\n`,
  },
];

const GOAL = "Add input validation and require auth on every resource";

/** A fake plan transport that returns a fixed plan regardless of the request. */
function fixedPlan(plan: PlannedShape): PlanTransport {
  return async () => plan;
}

/**
 * A fake transport whose reply depends on the model id, so a test can assert the
 * ordered escalation ladder: the base model returns `onBase`, the escalation
 * model returns `onEscalation`.
 */
function perModelPlan(
  baseModel: string,
  onBase: PlannedShape,
  onEscalation: PlannedShape,
): PlanTransport {
  return async (request) => (request.model === baseModel ? onBase : onEscalation);
}

/** A good, backbone-true plan: one owner unit per resource, the real contracts frozen. */
const GOOD_PLAN: PlannedShape = {
  units: [
    { id: "users", objective: "validate users and require auth", paths: ["src/resources/users.js"], dependsOn: [] },
    { id: "orders", objective: "validate orders and require auth", paths: ["src/resources/orders.js"], dependsOn: [] },
    { id: "products", objective: "validate products and require auth", paths: ["src/resources/products.js"], dependsOn: [] },
    { id: "search", objective: "validate search and require auth", paths: ["src/resources/search.js"], dependsOn: ["users"] },
  ],
  contracts: ["src/contracts/auth.js", "src/contracts/response.js"],
};

describe("planGoal: schema-constrained planner over the structural backbone", () => {
  it("projects a valid, backbone-true plan onto a Change with contracts and exports carried", async () => {
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(GOOD_PLAN),
      baseModel: "gpt-4o-mini",
    });

    // The plan came from the planner, not the fallback.
    expect(result.plan.source).toBe("planner");
    expect(result.plan.model).toBe("gpt-4o-mini");

    // The Change has one unit per planned resource, in the planned shape.
    expect(result.change.work.map((u) => u.id).sort()).toEqual(
      ["orders", "products", "search", "users"].sort(),
    );
    const search = result.change.work.find((u) => u.id === "search");
    expect(search?.dependsOn).toEqual(["users"]);

    // The frozen contracts are carried on the Change, with no unit owning one.
    const carried = result.change.blueprint;
    expect(carried).toBeDefined();
    expect(carried!.contracts.map((c) => c.path).sort()).toEqual([
      "src/contracts/auth.js",
      "src/contracts/response.js",
    ]);
    const frozen = new Set(carried!.contracts.map((c) => c.path));
    for (const unit of result.change.work) {
      for (const path of unit.paths) {
        expect(frozen.has(path)).toBe(false);
      }
    }
    // The frozen contracts carry their real import in-degree (a structural read).
    for (const contract of carried!.contracts) {
      expect(contract.importedByCount).toBeGreaterThan(0);
    }

    // Each owner module carries its real exported interface (the structural read
    // of the snapshot's parsed exports), so a run tells the agent to preserve it.
    for (const module of carried!.modules) {
      expect(module.exports).toEqual(["handle"]);
    }
  });

  it("holds single-writer ownership: no two planned units declare the same path", async () => {
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(GOOD_PLAN),
      baseModel: "gpt-4o-mini",
    });
    const seen = new Map<string, string>();
    for (const unit of result.change.work) {
      for (const path of unit.paths) {
        expect(seen.has(path)).toBe(false);
        seen.set(path, unit.id);
      }
    }
  });

  it("rejects a plan that invents a path and falls back to the heuristic", async () => {
    const badPath: PlannedShape = {
      units: [
        { id: "ghost", objective: "edit a file that does not exist", paths: ["src/resources/ghost.js"], dependsOn: [] },
      ],
      contracts: [],
    };
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(badPath),
      baseModel: "gpt-4o-mini",
    });
    // No model produced a usable plan, so the pass fell back to the heuristic.
    expect(result.plan.source).toBe("heuristic-fallback");
    expect(result.plan.model).toBe("");
    // The fallback Change is the deterministic heuristic decomposition: it owns
    // real resource files, not the invented ghost file.
    const ownsGhost = result.change.work.some((u) => u.paths.some((p) => p.includes("ghost")));
    expect(ownsGhost).toBe(false);
  });

  it("rejects a plan where a unit owns a frozen contract and falls back to the heuristic", async () => {
    const ownsContract: PlannedShape = {
      units: [
        // This unit tries to own a frozen seam, which the backbone forbids.
        { id: "auth", objective: "rewrite the auth contract", paths: ["src/contracts/auth.js"], dependsOn: [] },
      ],
      contracts: ["src/contracts/auth.js", "src/contracts/response.js"],
    };
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(ownsContract),
      baseModel: "gpt-4o-mini",
    });
    expect(result.plan.source).toBe("heuristic-fallback");
    // No unit in the resulting Change owns a frozen contract.
    const frozen = new Set((result.change.blueprint?.contracts ?? []).map((c) => c.path));
    for (const unit of result.change.work) {
      for (const path of unit.paths) {
        expect(frozen.has(path)).toBe(false);
      }
    }
  });

  it("walks the ordered escalation ladder: an invalid base plan is retried on the next model", async () => {
    const badBase: PlannedShape = {
      units: [{ id: "ghost", objective: "bad", paths: ["src/resources/ghost.js"], dependsOn: [] }],
      contracts: [],
    };
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: perModelPlan("gpt-4o-mini", badBase, GOOD_PLAN),
      baseModel: "gpt-4o-mini",
      escalationModels: ["gpt-4o"],
    });
    // The base plan was invalid; the escalation model's plan was accepted.
    expect(result.plan.source).toBe("planner");
    expect(result.plan.model).toBe("gpt-4o");
    expect(result.change.work.map((u) => u.id).sort()).toEqual(
      ["orders", "products", "search", "users"].sort(),
    );
  });

  it("falls back to the heuristic when a transport error exhausts the ladder", async () => {
    const throwing: PlanTransport = async () => {
      throw new Error("transport blew up");
    };
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: throwing,
      baseModel: "gpt-4o-mini",
      escalationModels: ["gpt-4o"],
    });
    expect(result.plan.source).toBe("heuristic-fallback");
    expect(result.change.work.length).toBeGreaterThan(0);
  });
});

describe("validatePlan: reality checks beyond the json_schema shape", () => {
  const snapshot = buildRepoSnapshot(SERVICE_REPO);
  const blueprint = deriveCohesionBlueprint(snapshot);

  it("accepts a backbone-true plan", () => {
    const v = validatePlan(GOOD_PLAN, snapshot, blueprint);
    expect(v.ok).toBe(true);
  });

  it("rejects an invented path", () => {
    const v = validatePlan(
      { units: [{ id: "x", objective: "o", paths: ["src/nope.js"], dependsOn: [] }], contracts: [] },
      snapshot,
      blueprint,
    );
    expect(v.ok).toBe(false);
  });

  it("rejects a unit owning a frozen contract", () => {
    const v = validatePlan(
      {
        units: [{ id: "x", objective: "o", paths: ["src/contracts/auth.js"], dependsOn: [] }],
        contracts: ["src/contracts/auth.js"],
      },
      snapshot,
      blueprint,
    );
    expect(v.ok).toBe(false);
  });

  it("rejects a contract that is not a real frozen seam", () => {
    const v = validatePlan(
      {
        units: [{ id: "x", objective: "o", paths: ["src/resources/users.js"], dependsOn: [] }],
        contracts: ["src/resources/users.js"],
      },
      snapshot,
      blueprint,
    );
    expect(v.ok).toBe(false);
  });

  it("rejects two units owning the same path (single-writer)", () => {
    const v = validatePlan(
      {
        units: [
          { id: "a", objective: "o", paths: ["src/resources/users.js"], dependsOn: [] },
          { id: "b", objective: "o", paths: ["src/resources/users.js"], dependsOn: [] },
        ],
        contracts: [],
      },
      snapshot,
      blueprint,
    );
    expect(v.ok).toBe(false);
  });

  it("rejects a dependency on an unknown unit", () => {
    const v = validatePlan(
      {
        units: [{ id: "a", objective: "o", paths: ["src/resources/users.js"], dependsOn: ["ghost"] }],
        contracts: [],
      },
      snapshot,
      blueprint,
    );
    expect(v.ok).toBe(false);
  });
});

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
  buildPlannerMessages,
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

  it("records a readable prompt summary and the model's rationale on the recorded plan", async () => {
    // A plan the model returns WITH a rationale: the recorded plan carries both a
    // deterministic prompt summary (what the planner was asked) and the model's
    // rationale (why this decomposition), empty-safe either way.
    const planWithRationale: PlannedShape = {
      ...GOOD_PLAN,
      rationale: "one owner per resource keeps the two shared seams frozen",
    };
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(planWithRationale),
      baseModel: "gpt-4o-mini",
    });

    // The prompt summary names the goal and the real structural map (modules and
    // frozen contracts), and never leaks a credential (only paths/symbol names).
    expect(result.plan.promptSummary).toBeDefined();
    expect(result.plan.promptSummary).toContain(GOAL);
    expect(result.plan.promptSummary).toContain("frozen");
    expect(result.plan.promptSummary).toContain("src/resources/users.js");
    expect(result.plan.promptSummary).not.toMatch(/Bearer\s/);

    // The model's rationale is carried through verbatim.
    expect(result.plan.rationale).toBe(
      "one owner per resource keeps the two shared seams frozen",
    );
  });

  it("records a prompt summary but no rationale when the model omits one", async () => {
    // GOOD_PLAN has no rationale: the recorded plan still carries the prompt
    // summary (deterministic), but rationale is simply absent (empty-safe).
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(GOOD_PLAN),
      baseModel: "gpt-4o-mini",
    });
    expect(result.plan.promptSummary).toBeDefined();
    expect(result.plan.promptSummary).toContain(GOAL);
    expect(result.plan.rationale).toBeUndefined();
  });

  it("the heuristic fallback carries no prompt summary and no rationale", async () => {
    // The fallback ran the heuristic rather than the planner, so neither the
    // prompt summary nor the rationale is recorded (empty-safe).
    const badPath: PlannedShape = {
      units: [
        { id: "ghost", objective: "bad", paths: ["src/resources/ghost.js"], dependsOn: [] },
      ],
      contracts: [],
    };
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(badPath),
      baseModel: "gpt-4o-mini",
    });
    expect(result.plan.source).toBe("heuristic-fallback");
    expect(result.plan.promptSummary).toBeUndefined();
    expect(result.plan.rationale).toBeUndefined();
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

  it("records NO diagnostics when the first model's plan is accepted (source 'planner')", async () => {
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(GOOD_PLAN),
      baseModel: "gpt-4o-mini",
    });
    expect(result.plan.source).toBe("planner");
    expect(result.diagnostics).toEqual([]);
  });

  it("surfaces the SPECIFIC validatePlan rejection reason per model (why it fell back), via result + sink", async () => {
    // A plan that lets a unit OWN a frozen contract: the exact rejection the
    // debugger named as the most-likely live cause for the service-api goal
    // ("require auth" tempts a unit onto src/contracts/auth.js).
    const ownsContract: PlannedShape = {
      units: [
        { id: "auth", objective: "rewrite the auth contract", paths: ["src/contracts/auth.js"], dependsOn: [] },
      ],
      contracts: ["src/contracts/auth.js", "src/contracts/response.js"],
    };
    const seen: { model: string; kind: string; reason: string }[] = [];
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: fixedPlan(ownsContract),
      baseModel: "gpt-4o-mini",
      escalationModels: ["gpt-4o"],
      onDiagnostic: (d) => seen.push({ model: d.model, kind: d.kind, reason: d.reason }),
    });
    // It still falls back honestly on a genuinely invalid plan.
    expect(result.plan.source).toBe("heuristic-fallback");
    // Both ladder models reported the SAME specific reason: a unit owning a
    // frozen contract. The reason is on the result's diagnostics AND streamed to
    // the sink, so a live run can pin the cause rather than guessing.
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map((d) => d.model)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    for (const d of result.diagnostics) {
      expect(d.kind).toBe("validation-rejected");
      expect(d.reason).toContain("owns frozen contract src/contracts/auth.js");
    }
    expect(seen).toEqual(result.diagnostics.map((d) => ({ model: d.model, kind: d.kind, reason: d.reason })));
  });

  it("surfaces a transport-error diagnostic (not a validation reject) when the model throws", async () => {
    const throwing: PlanTransport = async () => {
      throw new Error("gateway rejected json_schema strict:true");
    };
    const result = await planGoal({
      goal: GOAL,
      repo: SERVICE_REPO,
      plan: throwing,
      baseModel: "gpt-4o-mini",
    });
    expect(result.plan.source).toBe("heuristic-fallback");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe("transport-error");
    expect(result.diagnostics[0]?.reason).toContain("gateway rejected json_schema");
  });

  it("accepts a valid escalation plan after a rejected base plan, recording only the base rejection", async () => {
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
    // The escalation model's plan was accepted (planner, not fallback).
    expect(result.plan.source).toBe("planner");
    expect(result.plan.model).toBe("gpt-4o");
    // Only the base model's rejection was recorded; the accepted model recorded none.
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.model).toBe("gpt-4o-mini");
    expect(result.diagnostics[0]?.kind).toBe("validation-rejected");
    expect(result.diagnostics[0]?.reason).toContain("unknown path src/resources/ghost.js");
  });

  it("the planner prompt enumerates the exact frozen-contract paths and the honor-not-rewrite rule", () => {
    // The service-api-like repo has two frozen seams; the tightened system
    // prompt names them verbatim and states that 'require auth' is satisfied by
    // CALLING the frozen contract, so the model is not driven to own a seam
    // (the live rejection the debugger pinned). This is a deterministic unit
    // check of the prompt the live planner is handed.
    const snap = buildRepoSnapshot(SERVICE_REPO);
    const bp = deriveCohesionBlueprint(snap);
    const messages = buildPlannerMessages(GOAL, snap, bp);
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("src/contracts/auth.js");
    expect(system).toContain("src/contracts/response.js");
    expect(system).toContain("VERBATIM");
    expect(system).toContain("CALLING");
    expect(system).toContain("HONOR the frozen contracts");
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

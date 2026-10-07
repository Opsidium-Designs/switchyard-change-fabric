/**
 * Offline tests for the planner wiring in the orchestration layer:
 *   - a planned Change (produced by decomposeGoal with an injected FAKE planner,
 *     no network) round-trips through changeToSpecYaml + the loader with its
 *     frozen contracts and per-module exports intact, so a planned Change reaches
 *     the Worker/run exactly like a heuristic Change;
 *   - the graph model emits a BACKED planner node between the goal and the agent
 *     wave when a plan is recorded, and no planner node (unchanged graph) when it
 *     is not;
 *   - selectPlanner is NOT live when inference is unconfigured (the heuristic
 *     default), so make check and the demo stay deterministic and offline.
 *
 * These run under make check with no Worker, no Cloudflare account, and no
 * network: the plan transport is a deterministic fake and the repo is scanned
 * from a temp dir on disk.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec, type PlannedShape, type PlanTransport } from "@switchyard-change/change-core";

import { changeToSpecYaml, decomposeGoal } from "../src/decompose-goal.ts";
import { selectPlanner } from "../src/executor-select.ts";
import {
  assertBacked,
  buildWorkGraphModel,
  goalNodeId,
  plannerNodeId,
  unitNodeId,
  type ChangeStateSnapshot,
} from "../src/graph-model.ts";

/** Build a resource module that imports the two shared seam contracts. */
function resource(name: string): { path: string; content: string } {
  return {
    path: `src/resources/${name}.js`,
    content:
      `import { json, problem, readBody } from "../contracts/response.js";\n` +
      `import { requireAuth } from "../contracts/auth.js";\n` +
      `export async function handle(request, parts) { return json({ ${name}: [] }); }\n`,
  };
}

const SERVICE_FILES: { path: string; content: string }[] = [
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

const GOOD_PLAN: PlannedShape = {
  units: [
    { id: "users", objective: "validate users", paths: ["src/resources/users.js"], dependsOn: [] },
    { id: "orders", objective: "validate orders", paths: ["src/resources/orders.js"], dependsOn: ["users"] },
    { id: "products", objective: "validate products", paths: ["src/resources/products.js"], dependsOn: [] },
    { id: "search", objective: "validate search", paths: ["src/resources/search.js"], dependsOn: [] },
  ],
  contracts: ["src/contracts/auth.js", "src/contracts/response.js"],
};

const fixedPlan: PlanTransport = async () => GOOD_PLAN;

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scf-planner-"));
  for (const file of SERVICE_FILES) {
    const full = join(projectDir, file.path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, file.content, "utf8");
  }
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("planned Change round-trips through spec YAML with contracts + exports intact", () => {
  it("decomposeGoal with an injected planner yields a Change whose blueprint survives the loader", async () => {
    const result = await decomposeGoal({
      goal: "Add input validation and require auth on every resource",
      projectDir,
      planner: { plan: fixedPlan, baseModel: "gpt-4o-mini" },
      changeId: "change-service",
    });

    // The planner (not the heuristic fallback) produced the plan.
    expect(result.plan?.source).toBe("planner");

    // Serialize the planned Change to spec YAML and parse it back: the Worker
    // reconstructs the Change from exactly this YAML, so the frozen contracts and
    // per-module exports must survive the round-trip.
    const yaml = changeToSpecYaml(result.change);
    const reloaded = parseChangeSpec(yaml);

    // The units and their dependency order survive.
    expect(reloaded.work.map((u) => u.id).sort()).toEqual(
      ["orders", "products", "search", "users"].sort(),
    );
    const orders = reloaded.work.find((u) => u.id === "orders");
    expect(orders?.dependsOn).toEqual(["users"]);

    // The frozen contracts survive, owned by no unit.
    expect(reloaded.blueprint).toBeDefined();
    expect(reloaded.blueprint!.contracts.map((c) => c.path).sort()).toEqual([
      "src/contracts/auth.js",
      "src/contracts/response.js",
    ]);
    for (const contract of reloaded.blueprint!.contracts) {
      expect(contract.importedByCount).toBeGreaterThan(0);
      expect(reloaded.work.some((u) => u.paths.includes(contract.path))).toBe(false);
    }

    // Each module's exported interface survives (so the owning agent is told to
    // preserve it downstream, exactly like a heuristic Change).
    for (const module of reloaded.blueprint!.modules) {
      expect(module.exports).toEqual(["handle"]);
    }
  });
});

describe("the graph emits a backed planner node between the goal and the agents", () => {
  /** A snapshot with a recorded plan and two spawned agents. */
  function plannedSnapshot(): ChangeStateSnapshot {
    return {
      id: "change-service",
      objective: "Add input validation and require auth on every resource",
      completed: [],
      work: [
        {
          id: "users",
          objective: "validate users",
          dependsOn: [],
          paths: ["src/resources/users.js"],
          status: "running",
          leased: true,
        },
        {
          id: "orders",
          objective: "validate orders",
          dependsOn: ["users"],
          paths: ["src/resources/orders.js"],
          status: "running",
          leased: true,
        },
      ],
      edges: [{ from: "users", to: "orders" }],
      plan: {
        source: "planner",
        model: "gpt-4o-mini",
        units: ["users", "orders"],
        contracts: ["src/contracts/auth.js", "src/contracts/response.js"],
      },
    };
  }

  it("places a backed planner node that roots the agent wave (goal -> planner -> agents)", () => {
    const model = buildWorkGraphModel(plannedSnapshot());

    // There is exactly one planner node, backed by the recorded plan.
    const planner = model.nodes.filter((n) => n.kind === "planner");
    expect(planner).toHaveLength(1);
    expect(planner[0]?.id).toBe(plannerNodeId("change-service"));
    expect(planner[0]?.backing.kind).toBe("planner");

    // The goal flows into the planner.
    expect(
      model.edges.some(
        (e) => e.from === goalNodeId("change-service") && e.to === plannerNodeId("change-service"),
      ),
    ).toBe(true);

    // The agents root off the PLANNER, not the goal: the planner is visibly the
    // decomposer between the goal and the first agent wave.
    for (const unitId of ["users", "orders"]) {
      expect(
        model.edges.some(
          (e) => e.from === plannerNodeId("change-service") && e.to === unitNodeId(unitId),
        ),
      ).toBe(true);
      expect(
        model.edges.some(
          (e) => e.from === goalNodeId("change-service") && e.to === unitNodeId(unitId),
        ),
      ).toBe(false);
    }
  });

  it("assertBacked throws for a planner node when no plan is recorded (no unbacked node)", () => {
    const snapshotNoPlan: ChangeStateSnapshot = { ...plannedSnapshot(), plan: undefined };
    expect(() =>
      assertBacked(
        {
          id: plannerNodeId("change-service"),
          kind: "planner",
          label: "planner",
          status: "integrated",
          verified: true,
          escalated: false,
          backing: { kind: "planner", changeId: "change-service", source: "planner" },
        },
        snapshotNoPlan,
      ),
    ).toThrow(/no plan recorded/);
  });

  it("emits NO planner node when the state records no plan (the heuristic path is unchanged)", () => {
    const snapshotNoPlan: ChangeStateSnapshot = { ...plannedSnapshot(), plan: undefined };
    const model = buildWorkGraphModel(snapshotNoPlan);
    expect(model.nodes.some((n) => n.kind === "planner")).toBe(false);
    // The agents root off the goal directly, exactly as before the planner node.
    for (const unitId of ["users", "orders"]) {
      expect(
        model.edges.some(
          (e) => e.from === goalNodeId("change-service") && e.to === unitNodeId(unitId),
        ),
      ).toBe(true);
    }
  });
});

describe("selectPlanner gating: inference planner off by default (heuristic + determinism preserved)", () => {
  it("is not live when EXECUTOR is unset (the offline/noop path)", () => {
    const selected = selectPlanner({});
    expect(selected.live).toBe(false);
    expect(selected.plan).toBeUndefined();
  });

  it("is not live for a non-gateway executor", () => {
    const selected = selectPlanner({ EXECUTOR: "workers-ai" });
    expect(selected.live).toBe(false);
  });

  it("is not live for ai-gateway without gateway credentials", () => {
    const selected = selectPlanner({ EXECUTOR: "ai-gateway" });
    expect(selected.live).toBe(false);
  });

  it("is live for ai-gateway with gateway credentials, carrying the ordered ladder", () => {
    const selected = selectPlanner({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "t",
      AI_GATEWAY_MODEL: "gpt-4o-mini",
      AI_GATEWAY_ESCALATION_MODELS: "gpt-4.1,gpt-5",
    });
    expect(selected.live).toBe(true);
    expect(typeof selected.plan).toBe("function");
    expect(selected.baseModel).toBe("gpt-4o-mini");
    expect(selected.escalationModels).toEqual(["gpt-4.1", "gpt-5"]);
  });

  it("prefers AI_GATEWAY_PLANNER_MODEL over AI_GATEWAY_MODEL for the plan model", () => {
    const selected = selectPlanner({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "t",
      AI_GATEWAY_MODEL: "gpt-4o-mini",
      AI_GATEWAY_PLANNER_MODEL: "gpt-4.1",
    });
    expect(selected.baseModel).toBe("gpt-4.1");
  });
});

/**
 * Cohesion-aware module decomposition through the one decompose code path.
 *
 * These tests pin the module-level shape without any goal-specific code:
 *   - a modular repo (independent sibling resources that all import a shared
 *     seam) decomposes into ONE owner unit per resource module, with the shared
 *     seam marked a frozen read-only contract that NO unit owns;
 *   - single-writer ownership holds (no two units declare the same path);
 *   - a repo with a real inter-module dependency orders the dependent after the
 *     module it imports (a dependency edge), while independent siblings have no
 *     edges (one wave);
 *   - the do-not-parallelize guard: a small/single-file/tightly-coupled repo
 *     gets no blueprint and keeps the single-unit shape;
 *   - anti-puppet for the module case: two structurally different modular repos
 *     produce two different module graphs through the one path, and swapping the
 *     goal string for one with the same features holds the shape.
 */

import { describe, expect, it } from "vitest";

import { buildWorkGraph, decompose, type RepoFile } from "../src/index.ts";

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

/** A modular service repo: six independent resources over two frozen seams. */
const SERVICE_REPO: RepoFile[] = [
  {
    path: "src/contracts/response.js",
    content: "export function json(b){return b;}\nexport function problem(s,d){return d;}\nexport async function readBody(r){return {};}\n",
  },
  {
    path: "src/contracts/auth.js",
    content: "import { problem } from './response.js';\nexport function requireAuth(r){return null;}\n",
  },
  resource("users"),
  resource("orders"),
  resource("products"),
  resource("auth"),
  resource("search"),
  resource("notifications"),
  {
    path: "src/index.js",
    content:
      `import { json, problem } from "./contracts/response.js";\n` +
      `import { handle as users } from "./resources/users.js";\n` +
      `import { handle as orders } from "./resources/orders.js";\n` +
      `export default { fetch(){ return json({}); } };\n`,
  },
];

const SERVICE_GOAL = "Add input validation and require auth on every resource";

/** A tightly coupled single-file repo (the do-not-parallelize case). */
const SINGLE_FILE_REPO: RepoFile[] = [
  {
    path: "src/app.js",
    content: "export function run(){ return 1; }\nexport function helper(){ return 2; }\n",
  },
];

describe("cohesion-aware module decomposition", () => {
  it("decomposes a modular service into one owner unit per resource with frozen contracts", () => {
    const result = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO });

    // The blueprint is present and names the six resource modules and the two
    // frozen contracts (owned by no unit).
    expect(result.blueprint).toBeDefined();
    const blueprint = result.blueprint!;
    expect(blueprint.modules.length).toBe(6);
    const contractPaths = blueprint.contracts.map((c) => c.path).sort();
    expect(contractPaths).toEqual([
      "src/contracts/auth.js",
      "src/contracts/response.js",
    ]);

    // One owner unit per resource module (plus no file-split of a shared seam).
    const ownerUnits = result.change.work.filter((u) =>
      u.paths.some((p) => p.startsWith("src/resources/")),
    );
    expect(ownerUnits.length).toBe(6);

    // Each owner unit owns exactly one resource file; no unit owns a contract.
    const frozen = new Set(contractPaths);
    for (const unit of result.change.work) {
      for (const path of unit.paths) {
        expect(frozen.has(path)).toBe(false);
      }
    }
    const ownedResourceFiles = ownerUnits.flatMap((u) => [...u.paths]).sort();
    expect(ownedResourceFiles).toEqual([
      "src/resources/auth.js",
      "src/resources/notifications.js",
      "src/resources/orders.js",
      "src/resources/products.js",
      "src/resources/search.js",
      "src/resources/users.js",
    ]);
  });

  it("carries the blueprint on the Change for later stages (modules + frozen contracts)", () => {
    const result = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO });
    const carried = result.change.blueprint;
    expect(carried).toBeDefined();
    // One carried module per owner unit, each naming its owning unit id and path.
    expect(carried!.modules.length).toBe(6);
    for (const module of carried!.modules) {
      const unit = result.change.work.find((u) => u.id === module.unitId);
      expect(unit).toBeDefined();
      expect([...unit!.paths]).toEqual([...module.paths]);
    }
    // The frozen contracts are carried with their import in-degree, and no unit
    // owns any of them.
    const carriedContracts = carried!.contracts.map((c) => c.path).sort();
    expect(carriedContracts).toEqual([
      "src/contracts/auth.js",
      "src/contracts/response.js",
    ]);
    for (const contract of carried!.contracts) {
      expect(contract.importedByCount).toBeGreaterThan(0);
      expect(
        result.change.work.some((u) => u.paths.includes(contract.path)),
      ).toBe(false);
    }
  });

  it("captures each module's exported interface so the owner is told to preserve it", () => {
    const result = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO });
    const carried = result.change.blueprint;
    expect(carried).toBeDefined();
    // Every resource module exports `handle` (the public export src/index.js
    // imports), so the captured exported interface is exactly ["handle"]. This is
    // a pure structural read of the snapshot's parsed exports, not a goal branch.
    for (const module of carried!.modules) {
      expect(module.exports).toEqual(["handle"]);
    }
    // The users resource module specifically carries its real export name.
    const usersModule = carried!.modules.find((m) =>
      m.paths.some((p) => p.endsWith("resources/users.js")),
    );
    expect(usersModule).toBeDefined();
    expect(usersModule!.exports).toEqual(["handle"]);
  });

  it("holds single-writer ownership: no two units declare the same path", () => {
    const result = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO });
    const seen = new Map<string, string>();
    for (const unit of result.change.work) {
      for (const path of unit.paths) {
        expect(seen.has(path)).toBe(false);
        seen.set(path, unit.id);
      }
    }
  });

  it("fans the independent resources out in one wave (no inter-module edges)", () => {
    const result = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO });
    const graph = buildWorkGraph(result.change);
    // The resources are independent and only read the frozen contracts, so there
    // are no edges INTO contracts and no edges between the resource owners.
    const ownerIds = new Set(
      result.change.work
        .filter((u) => u.paths.some((p) => p.startsWith("src/resources/")))
        .map((u) => u.id),
    );
    const edgesAmongOwners = graph.edges.filter(
      (e) => ownerIds.has(e.from) && ownerIds.has(e.to),
    );
    expect(edgesAmongOwners.length).toBe(0);
  });

  it("orders a dependent module after the module it imports (a synthetic inter-module dep)", () => {
    // A modular repo where one resource imports another resource (a real
    // inter-module write dependency), so the blueprint must emit an edge and the
    // dependent must order after its prerequisite.
    const linkedRepo: RepoFile[] = [
      {
        path: "src/contracts/response.js",
        content: "export function json(b){return b;}\nexport function problem(s,d){return d;}\n",
      },
      {
        path: "src/contracts/auth.js",
        content: "import { problem } from './response.js';\nexport function requireAuth(r){return null;}\n",
      },
      resource("users"),
      resource("products"),
      {
        // orders imports products (an owned module), so orders depends on products.
        path: "src/resources/orders.js",
        content:
          `import { json, problem } from "../contracts/response.js";\n` +
          `import { requireAuth } from "../contracts/auth.js";\n` +
          `import { handle as products } from "./products.js";\n` +
          `export async function handle(request, parts) { return json({ orders: [] }); }\n`,
      },
      resource("search"),
      {
        path: "src/index.js",
        content:
          `import { handle as users } from "./resources/users.js";\n` +
          `export default { fetch(){ return new Response(); } };\n`,
      },
    ];
    const result = decompose({ goal: SERVICE_GOAL, repo: linkedRepo });
    expect(result.blueprint).toBeDefined();
    // The blueprint has an edge products -> orders.
    const edge = result.blueprint!.edges.find((e) => e.to.includes("orders"));
    expect(edge).toBeDefined();
    expect(edge!.from).toContain("products");

    // The orders unit depends on the products unit, so a dependency edge exists
    // in the WorkGraph and orders orders after products.
    const graph = buildWorkGraph(result.change);
    const ordersUnit = result.change.work.find((u) =>
      u.paths.some((p) => p.endsWith("orders.js")),
    );
    const productsUnit = result.change.work.find((u) =>
      u.paths.some((p) => p.endsWith("products.js")),
    );
    expect(ordersUnit).toBeDefined();
    expect(productsUnit).toBeDefined();
    expect(ordersUnit!.dependsOn).toContain(productsUnit!.id);
    expect(
      graph.edges.some((e) => e.from === productsUnit!.id && e.to === ordersUnit!.id),
    ).toBe(true);
  });

  it("do-not-parallelize guard: a single-file repo yields one unit and no blueprint", () => {
    const result = decompose({ goal: SERVICE_GOAL, repo: SINGLE_FILE_REPO });
    expect(result.blueprint).toBeUndefined();
    expect(result.change.work.length).toBe(1);
  });

  it("anti-puppet (module case): two different modular repos give different module graphs through one path", () => {
    // A different modular repo: three services under a different feature dir,
    // sharing a different seam. The same engine, the same goal features, a
    // structurally different repo, so a structurally different module graph.
    const otherRepo: RepoFile[] = [
      {
        path: "src/shared/db.js",
        content: "export function query(){return [];}\n",
      },
      {
        path: "src/features/billing.js",
        content: "import { query } from '../shared/db.js';\nexport function handle(){return query();}\n",
      },
      {
        path: "src/features/reporting.js",
        content: "import { query } from '../shared/db.js';\nexport function handle(){return query();}\n",
      },
      {
        path: "src/features/alerts.js",
        content: "import { query } from '../shared/db.js';\nexport function handle(){return query();}\n",
      },
      {
        path: "src/features/exports.js",
        content: "import { query } from '../shared/db.js';\nexport function handle(){return query();}\n",
      },
      {
        path: "src/index.js",
        content: "import { handle } from './features/billing.js';\nexport default { fetch(){ return handle(); } };\n",
      },
    ];

    const service = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO });
    const other = decompose({ goal: SERVICE_GOAL, repo: otherRepo });

    // Both decomposed through the one path with a blueprint.
    expect(service.blueprint).toBeDefined();
    expect(other.blueprint).toBeDefined();

    const serviceGraph = buildWorkGraph(service.change);
    const otherGraph = buildWorkGraph(other.change);

    // Different module counts (6 resources vs 4 features), different seams, so
    // genuinely different graphs rather than a clone.
    expect(serviceGraph.nodes.length).not.toBe(otherGraph.nodes.length);
    expect(service.blueprint!.contracts.map((c) => c.path)).not.toEqual(
      other.blueprint!.contracts.map((c) => c.path),
    );
    expect(JSON.stringify(serviceGraph)).not.toBe(JSON.stringify(otherGraph));
  });

  it("is not keyed on the goal string: same features yield the same module shape", () => {
    const a = buildWorkGraph(
      decompose({ goal: "Add input validation and require auth on every resource", repo: SERVICE_REPO }).change,
    );
    const b = buildWorkGraph(
      decompose({ goal: "Guard each resource with validation and auth", repo: SERVICE_REPO }).change,
    );
    expect(a.nodes).toEqual(b.nodes);
    expect(a.edges).toEqual(b.edges);
  });

  it("is deterministic for the modular case", () => {
    const first = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO }).change;
    const second = decompose({ goal: SERVICE_GOAL, repo: SERVICE_REPO }).change;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("every feature group of a multi-domain repo (the storefront example's structure)", () => {
  it("includes catalog, orders, and billing as groups, with the shared contracts (and their whole directory) as frozen seams", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = new URL("../../../examples/apps/storefront/src", import.meta.url).pathname;
    const files: { path: string; content: string }[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push({ path: `src/${relative(root, full)}`, content: readFileSync(full, "utf8") });
      }
    };
    walk(root);
    const { buildRepoSnapshot, deriveCohesionBlueprint } = await import("../src/index.ts");
    const blueprint = deriveCohesionBlueprint(buildRepoSnapshot(files))!;
    expect(blueprint.groups!.map((g) => g.dir)).toEqual(["src/billing", "src/catalog", "src/orders"]);
    expect(blueprint.modules.map((m) => m.label)).toEqual([
      "src-billing-invoices",
      "src-billing-payments",
      "src-billing-refunds",
      "src-billing-tax",
      "src-catalog-categories",
      "src-catalog-products",
      "src-catalog-search",
      "src-orders-cart",
      "src-orders-checkout",
      "src-orders-history",
    ]);
    // The contracts directory is a seam directory: its helper nobody calls yet (auth) is frozen too.
    expect(blueprint.contracts.map((c) => c.path)).toEqual(["src/contracts/auth.ts", "src/contracts/http.ts", "src/contracts/money.ts", "src/store.ts"]);
    // A module another group leans on stays owned: a cross-group write dependency.
    expect(blueprint.modules.find((m) => m.label === "src-orders-checkout")!.dependsOn).toEqual(["src-billing-invoices", "src-billing-tax", "src-orders-cart", "src-orders-history"]);
    // Deterministic.
    expect(deriveCohesionBlueprint(buildRepoSnapshot(files))).toEqual(blueprint);
  });
});

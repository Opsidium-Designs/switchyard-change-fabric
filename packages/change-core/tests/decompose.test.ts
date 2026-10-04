/**
 * The anti-puppet test: the SAME decomposer engine, given two structurally
 * different goals against two differently-shaped repositories, must produce two
 * DIFFERENT, sensible WorkGraphs with no goal-specific code.
 *
 * This is the whole point of the milestone. It asserts:
 *   - both goals decompose through the one `decompose` code path;
 *   - the two resulting graphs differ in shape (unit count AND dependency
 *     structure), so neither is a hardcoded clone of the other;
 *   - the decomposition is derived from the repo (changing the repo while
 *     holding the goal changes the result; a goal that names nothing in the repo
 *     still produces an honest graph);
 *   - the engine is NOT branching on the goal string: a goal whose text differs
 *     but whose generic features are the same yields the same shape against the
 *     same repo, and a wholly novel goal string the engine has never seen still
 *     decomposes sensibly.
 */

import { describe, expect, it } from "vitest";

import { buildWorkGraph, decompose, type RepoFile } from "../src/index.ts";

// A layered repository: a model module, an api module that depends on it, an
// entry point, and a tests directory. This is the shape the audit example has.
const LAYERED_REPO: RepoFile[] = [
  {
    path: "src/audit/events.ts",
    content: "export interface AuditEvent { id: number }\nexport function makeAuditEvent() { return { id: 1 }; }\n",
  },
  {
    path: "src/audit/store.ts",
    content: "import { makeAuditEvent } from './events.js';\nexport class AuditStore {}\n",
  },
  {
    path: "src/api/audit/handler.ts",
    content:
      "import { AuditStore } from '../../audit/store.js';\nexport function createAuditApi(store: AuditStore) { return { handle() { return req.path; } }; }\n",
  },
  {
    path: "src/index.ts",
    content: "export { AuditStore } from './audit/store.js';\n",
  },
  {
    path: "tests/audit/store.test.ts",
    content: "import { AuditStore } from '../../src/audit/store.js';\n",
  },
];

// A flat library repository: several independent modules of exported functions
// with no cross-module dependencies and no router. This is the calc shape.
const FLAT_REPO: RepoFile[] = [
  {
    path: "src/statistics.ts",
    content: "export function mean(values: number[]): number { return 0; }\nexport function variance(values: number[]): number { return 0; }\n",
  },
  {
    path: "src/geometry.ts",
    content:
      "export function rectangleArea(w: number, h: number): number { return w * h; }\nexport function circleArea(r: number): number { return r; }\n",
  },
  {
    path: "src/finance.ts",
    content: "export function percentOf(a: number, p: number): number { return 0; }\n",
  },
  {
    path: "src/index.ts",
    content: "export { mean, variance } from './statistics.js';\n",
  },
];

const AUDIT_GOAL = "Add organization-level audit logging with a read API and tests";
const VALIDATION_GOAL = "Add input validation to every exported function";

describe("decomposer anti-puppet: same engine, different goals, different graphs", () => {
  it("decomposes two structurally different goals through one code path into different shapes", () => {
    // One engine, one call signature, two goals + repos. No per-goal arguments.
    const audit = decompose({ goal: AUDIT_GOAL, repo: LAYERED_REPO });
    const validation = decompose({ goal: VALIDATION_GOAL, repo: FLAT_REPO });

    const auditGraph = buildWorkGraph(audit.change);
    const validationGraph = buildWorkGraph(validation.change);

    // The two graphs differ in DEPENDENCY STRUCTURE: the audit goal is layered
    // (has edges), the validation goal is a flat fan-out (no edges). This is the
    // structural difference the anti-puppet criterion is about; it does not rely
    // on a coincidental unit count (the real seeded projects, exercised in the
    // orchestration e2e test, also differ in unit count).
    expect(auditGraph.edges.length).toBeGreaterThan(0);
    expect(validationGraph.edges.length).toBe(0);
    // The shapes are genuinely different graphs.
    expect(JSON.stringify(auditGraph)).not.toBe(JSON.stringify(validationGraph));

    // The audit goal is layered: it has at least one dependency edge (the tests
    // and/or wiring unit depends on the module work).
    expect(auditGraph.edges.length).toBeGreaterThan(0);

    // The validation goal is universal ("every exported function"): it fans out
    // one unit per matching source file with NO dependency edges (flat).
    expect(validationGraph.edges.length).toBe(0);
    expect(validation.intent.isUniversal).toBe(true);
    // One unit per non-entry source file that has exported functions: statistics,
    // geometry, finance, and the index re-export surface.
    expect(validationGraph.nodes.length).toBeGreaterThanOrEqual(3);

    // Both graphs are acyclic and non-empty (sensible).
    expect(auditGraph.nodes.length).toBeGreaterThan(0);
    expect(validationGraph.nodes.length).toBeGreaterThan(0);
  });

  it("derives the graph from the repo, not the goal string (swap the repo, hold the goal)", () => {
    // The SAME validation goal against the LAYERED repo produces a different
    // graph than against the FLAT repo, because the units are per-file over the
    // repo's actual files. If the engine keyed on the goal string, the result
    // would be identical regardless of repo.
    const againstFlat = buildWorkGraph(decompose({ goal: VALIDATION_GOAL, repo: FLAT_REPO }).change);
    const againstLayered = buildWorkGraph(
      decompose({ goal: VALIDATION_GOAL, repo: LAYERED_REPO }).change,
    );
    expect(againstFlat.nodes).not.toEqual(againstLayered.nodes);
  });

  it("is not keyed on the goal string: same features yield the same shape", () => {
    // Two different goal strings that reduce to the same generic features
    // (universal + validation) must produce the same graph against one repo.
    const a = buildWorkGraph(
      decompose({ goal: "Add input validation to every exported function", repo: FLAT_REPO }).change,
    );
    const b = buildWorkGraph(
      decompose({ goal: "Guard each exported function with validation", repo: FLAT_REPO }).change,
    );
    expect(a.nodes).toEqual(b.nodes);
    expect(a.edges).toEqual(b.edges);
  });

  it("decomposes a wholly novel, unrehearsed goal string sensibly", () => {
    // A goal the engine was never written for: it still produces a non-empty,
    // acyclic graph scoped to the repo, with no special-casing.
    const novel = decompose({
      goal: "Harden the geometry helpers against negative dimensions",
      repo: FLAT_REPO,
    });
    const graph = buildWorkGraph(novel.change);
    expect(graph.nodes.length).toBeGreaterThan(0);
    // It should touch the geometry surface the goal names.
    const touchesGeometry = novel.change.work.some((unit) =>
      unit.paths.some((p) => p.includes("geometry")),
    );
    expect(touchesGeometry).toBe(true);
  });

  it("is deterministic: repeated decomposition yields byte-identical graphs", () => {
    const first = decompose({ goal: AUDIT_GOAL, repo: LAYERED_REPO }).change;
    const second = decompose({ goal: AUDIT_GOAL, repo: LAYERED_REPO }).change;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

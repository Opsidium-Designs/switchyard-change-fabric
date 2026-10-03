import { describe, expect, it } from "vitest";

import {
  buildWorkGraph,
  detectPathCollisions,
  findDependencyCycle,
  parseChangeSpec,
  runnableUnits,
  waitingUnits,
  workUnitStatuses,
  type Change,
} from "../src/index.ts";

// A Change with three WorkUnits and one dependency: `api` depends on `model`.
// `model` and `tests` have no dependencies, so they are runnable first; `api`
// waits until `model` completes. `api` and `tests` both declare
// src/audit/events.ts, a declared path collision.
const SPEC = `
id: change-audit-logging
objective: Add organization-level audit logging
baseline: HEAD
budget_usd: 5.00
assurance: standard

work:
  - id: model
    objective: Implement audit event persistence
    paths:
      - src/audit/**

  - id: api
    objective: Add API read endpoints
    depends_on:
      - model
    paths:
      - src/api/audit/**
      - src/audit/events.ts

  - id: tests
    objective: Add audit logging tests
    paths:
      - tests/audit/**
      - src/audit/events.ts
`;

function change(): Change {
  return parseChangeSpec(SPEC);
}

describe("buildWorkGraph", () => {
  it("lists nodes in declared order and derives dependency edges", () => {
    const graph = buildWorkGraph(change());
    expect(graph.nodes).toEqual(["model", "api", "tests"]);
    expect(graph.edges).toEqual([{ from: "model", to: "api" }]);
  });
});

describe("detectPathCollisions", () => {
  it("finds the shared declared path and its owners", () => {
    const collisions = detectPathCollisions(change());
    expect(collisions).toEqual([
      { path: "src/audit/events.ts", unitIds: ["api", "tests"] },
    ]);
  });

  it("returns no collisions when paths are disjoint", () => {
    const c = parseChangeSpec(`
id: disjoint
objective: no overlap
work:
  - id: a
    objective: a
    paths: [src/a/**]
  - id: b
    objective: b
    paths: [src/b/**]
`);
    expect(detectPathCollisions(c)).toEqual([]);
  });
});

describe("findDependencyCycle", () => {
  it("returns undefined for an acyclic graph", () => {
    expect(findDependencyCycle(change())).toBeUndefined();
  });

  it("detects a cycle", () => {
    const c = parseChangeSpec(`
id: cyclic
objective: has a cycle
work:
  - id: a
    objective: a
    depends_on: [b]
    paths: [src/a/**]
  - id: b
    objective: b
    depends_on: [a]
    paths: [src/b/**]
`);
    const cycle = findDependencyCycle(c);
    expect(cycle).toBeDefined();
    // The cycle closes on a repeated id.
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
  });
});

describe("runnable / waiting scheduling", () => {
  it("initially: model and tests runnable, api waiting", () => {
    const c = change();
    expect(runnableUnits(c, [])).toEqual(["model", "tests"]);
    expect(waitingUnits(c, [])).toEqual(["api"]);
  });

  it("drives the graph through completion with the expected transitions", () => {
    const c = change();

    // Step 0: nothing completed.
    expect(workUnitStatuses(c, [])).toEqual(
      new Map([
        ["model", "runnable"],
        ["api", "waiting"],
        ["tests", "runnable"],
      ]),
    );

    // Step 1: model completes -> api becomes runnable; tests still runnable.
    const afterModel = ["model"];
    expect(runnableUnits(c, afterModel)).toEqual(["api", "tests"]);
    expect(waitingUnits(c, afterModel)).toEqual([]);
    expect(workUnitStatuses(c, afterModel)).toEqual(
      new Map([
        ["model", "integrated"],
        ["api", "runnable"],
        ["tests", "runnable"],
      ]),
    );

    // Step 2: tests also completes -> only api left runnable.
    const afterModelTests = ["model", "tests"];
    expect(runnableUnits(c, afterModelTests)).toEqual(["api"]);
    expect(waitingUnits(c, afterModelTests)).toEqual([]);

    // Step 3: all complete -> nothing runnable, nothing waiting.
    const all = ["model", "tests", "api"];
    expect(runnableUnits(c, all)).toEqual([]);
    expect(waitingUnits(c, all)).toEqual([]);
    expect(workUnitStatuses(c, all)).toEqual(
      new Map([
        ["model", "integrated"],
        ["api", "integrated"],
        ["tests", "integrated"],
      ]),
    );
  });

  it("keeps a dependent waiting until every dependency completes", () => {
    const c = parseChangeSpec(`
id: multi
objective: multiple deps
work:
  - id: a
    objective: a
    paths: [src/a/**]
  - id: b
    objective: b
    paths: [src/b/**]
  - id: c
    objective: c
    depends_on: [a, b]
    paths: [src/c/**]
`);
    expect(runnableUnits(c, [])).toEqual(["a", "b"]);
    expect(waitingUnits(c, [])).toEqual(["c"]);
    // Only one dependency done -> c still waiting.
    expect(runnableUnits(c, ["a"])).toEqual(["b"]);
    expect(waitingUnits(c, ["a"])).toEqual(["c"]);
    // Both done -> c runnable.
    expect(runnableUnits(c, ["a", "b"])).toEqual(["c"]);
    expect(waitingUnits(c, ["a", "b"])).toEqual([]);
  });
});

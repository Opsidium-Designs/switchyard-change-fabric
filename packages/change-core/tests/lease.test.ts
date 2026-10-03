import { describe, expect, it } from "vitest";

import {
  detectPathCollisions,
  parseChangeSpec,
  planWriteLeases,
  unitLeaseViews,
  type Change,
} from "../src/index.ts";

// The example audit-logging Change: `api` and `tests` both declare
// src/audit/events.ts, a single declared path collision. `api` is declared
// before `tests`, so `api` wins the write lease.
const AUDIT_SPEC = `
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

function auditChange(): Change {
  return parseChangeSpec(AUDIT_SPEC);
}

describe("planWriteLeases", () => {
  it("serializes a collision by granting the lease to the first-declared contender", () => {
    const change = auditChange();
    const collisions = detectPathCollisions(change);
    expect(collisions).toEqual([
      { path: "src/audit/events.ts", unitIds: ["api", "tests"] },
    ]);

    const plan = planWriteLeases(change, collisions);
    expect(plan.changeId).toBe("change-audit-logging");
    expect(plan.needsAttention).toBe(false);
    expect(plan.decisions).toHaveLength(1);

    const decision = plan.decisions[0];
    expect(decision?.path).toBe("src/audit/events.ts");
    expect(decision?.resolution).toBe("serialized");
    // `api` is declared before `tests`, so it owns the contested path.
    expect(decision?.owner).toBe("api");
    expect(decision?.waiters).toEqual(["tests"]);
    expect(decision?.contenders).toEqual(["api", "tests"]);

    // The serialization adds a waiter -> owner ordering edge.
    expect(plan.ordering).toEqual([{ waiter: "tests", owner: "api" }]);
  });

  it("produces an empty plan when there are no collisions", () => {
    const change = parseChangeSpec(`
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
    const plan = planWriteLeases(change, detectPathCollisions(change));
    expect(plan.decisions).toEqual([]);
    expect(plan.ordering).toEqual([]);
    expect(plan.needsAttention).toBe(false);
  });

  it("flags a collision when serializing it would create a dependency cycle", () => {
    // `a` depends on `b` and `b` depends on `a` is a cycle, so instead give a
    // collision where the only owner choice forces a back-edge. Here `first`
    // already depends on `second`, and they collide on a shared path. The owner
    // (first-declared = `first`) would need `second` to wait on `first`, but
    // `first` depends on `second`, so that waiter edge closes a cycle.
    const change = parseChangeSpec(`
id: cyclic-lease
objective: serialization would cycle
work:
  - id: first
    objective: first
    depends_on: [second]
    paths:
      - src/shared.ts
  - id: second
    objective: second
    paths:
      - src/shared.ts
`);
    const collisions = detectPathCollisions(change);
    expect(collisions).toEqual([
      { path: "src/shared.ts", unitIds: ["first", "second"] },
    ]);

    const plan = planWriteLeases(change, collisions);
    expect(plan.needsAttention).toBe(true);
    const decision = plan.decisions[0];
    expect(decision?.resolution).toBe("flagged");
    expect(decision?.owner).toBeUndefined();
    expect(decision?.waiters).toEqual([]);
    expect(plan.ordering).toEqual([]);
  });
});

describe("unitLeaseViews", () => {
  it("reports who owns and who yields each contested path", () => {
    const change = auditChange();
    const plan = planWriteLeases(change, detectPathCollisions(change));
    const views = unitLeaseViews(plan);

    expect(views.get("api")).toEqual({ owns: ["src/audit/events.ts"], yields: [] });
    expect(views.get("tests")).toEqual({ owns: [], yields: ["src/audit/events.ts"] });
    // `model` is not in any collision.
    expect(views.get("model")).toBeUndefined();
  });

  it("is empty when nothing was serialized", () => {
    const change = parseChangeSpec(`
id: cyclic-lease
objective: serialization would cycle
work:
  - id: first
    objective: first
    depends_on: [second]
    paths: [src/shared.ts]
  - id: second
    objective: second
    paths: [src/shared.ts]
`);
    const plan = planWriteLeases(change, detectPathCollisions(change));
    expect([...unitLeaseViews(plan).keys()]).toEqual([]);
  });
});

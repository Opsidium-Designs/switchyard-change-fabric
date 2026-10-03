import { describe, expect, it } from "vitest";

import { ChangeSpecError, parseChangeSpec } from "../src/index.ts";

const VALID_SPEC = `
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

describe("parseChangeSpec", () => {
  it("parses a well-formed Change spec", () => {
    const change = parseChangeSpec(VALID_SPEC);
    expect(change.id).toBe("change-audit-logging");
    expect(change.objective).toBe("Add organization-level audit logging");
    expect(change.baseline).toBe("HEAD");
    expect(change.budgetUsd).toBe(5);
    expect(change.assurance).toBe("standard");
    expect(change.work.map((unit) => unit.id)).toEqual(["model", "api", "tests"]);
  });

  it("captures dependencies and paths per WorkUnit", () => {
    const change = parseChangeSpec(VALID_SPEC);
    const api = change.work.find((unit) => unit.id === "api");
    expect(api?.dependsOn).toEqual(["model"]);
    expect(api?.paths).toContain("src/audit/events.ts");

    const model = change.work.find((unit) => unit.id === "model");
    expect(model?.dependsOn).toEqual([]);
  });

  it("defaults baseline, budget, and assurance when omitted", () => {
    const change = parseChangeSpec(`
id: minimal
objective: Minimal change
work:
  - id: only
    objective: do the thing
    paths: [src/**]
`);
    expect(change.baseline).toBe("HEAD");
    expect(change.budgetUsd).toBe(0);
    expect(change.assurance).toBe("standard");
  });

  it("rejects a spec with no work list", () => {
    expect(() =>
      parseChangeSpec(`
id: empty
objective: nothing to do
work: []
`),
    ).toThrow(ChangeSpecError);
  });

  it("rejects a missing required field", () => {
    expect(() =>
      parseChangeSpec(`
objective: no id here
work:
  - id: a
    objective: a
    paths: [src/**]
`),
    ).toThrow(/missing required string field: id/);
  });

  it("rejects duplicate WorkUnit ids", () => {
    expect(() =>
      parseChangeSpec(`
id: dup
objective: duplicate ids
work:
  - id: a
    objective: first
    paths: [src/a/**]
  - id: a
    objective: second
    paths: [src/b/**]
`),
    ).toThrow(/duplicate WorkUnit id: a/);
  });

  it("rejects a dependency on an unknown WorkUnit", () => {
    expect(() =>
      parseChangeSpec(`
id: badref
objective: bad dependency
work:
  - id: a
    objective: a
    depends_on: [ghost]
    paths: [src/a/**]
`),
    ).toThrow(/unknown WorkUnit id: ghost/);
  });

  it("rejects a self-dependency", () => {
    expect(() =>
      parseChangeSpec(`
id: selfdep
objective: self dependency
work:
  - id: a
    objective: a
    depends_on: [a]
    paths: [src/a/**]
`),
    ).toThrow(/cannot depend on itself/);
  });

  it("rejects an unknown assurance level", () => {
    expect(() =>
      parseChangeSpec(`
id: badassure
objective: bad assurance
assurance: paranoid
work:
  - id: a
    objective: a
    paths: [src/a/**]
`),
    ).toThrow(/assurance must be one of/);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseChangeSpec("id: : :\n  - broken")).toThrow(ChangeSpecError);
  });
});

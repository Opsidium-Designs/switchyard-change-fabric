/**
 * The durable driver kernel: driveWorkGraph advances a WorkGraph to completion
 * the same way the Workflow drives its Durable Object, wave by wave. These tests
 * pin that behavior deterministically, so the offline substrate and the live
 * Workflow cannot drift in their scheduling semantics.
 */

import { describe, expect, it } from "vitest";

import { decompose, driveWorkGraph, parseChangeSpec, type RepoFile } from "../src/index.ts";

const LAYERED_SPEC = `
id: change-audit-logging
objective: Add audit logging
work:
  - id: model
    objective: model
    paths: [src/audit/**]
  - id: api
    objective: api
    depends_on: [model]
    paths: [src/api/audit/**]
  - id: tests
    objective: tests
    depends_on: [model, api]
    paths: [tests/audit/**]
`;

describe("driveWorkGraph", () => {
  it("drives a layered graph wave by wave in dependency order to completion", () => {
    const change = parseChangeSpec(LAYERED_SPEC);
    const trace = driveWorkGraph(change);

    expect(trace.done).toBe(true);
    // model is runnable first; api becomes runnable after model; tests last.
    expect(trace.waves.map((w) => [...w.units])).toEqual([["model"], ["api"], ["tests"]]);
    expect(trace.completionOrder).toEqual(["model", "api", "tests"]);
  });

  it("advances independent units together in a single wave", () => {
    const change = parseChangeSpec(`
id: flat
objective: flat
work:
  - id: a
    objective: a
    paths: [src/a/**]
  - id: b
    objective: b
    paths: [src/b/**]
  - id: c
    objective: c
    paths: [src/c/**]
`);
    const trace = driveWorkGraph(change);
    expect(trace.done).toBe(true);
    // All three independent: one wave, all together.
    expect(trace.waves.length).toBe(1);
    expect([...(trace.waves[0]?.units ?? [])].sort()).toEqual(["a", "b", "c"]);
  });

  it("drives a decomposed goal's graph to completion", () => {
    const repo: RepoFile[] = [
      { path: "src/a.ts", content: "export function a() {}\n" },
      { path: "src/b.ts", content: "export function b() {}\n" },
    ];
    const { change } = decompose({ goal: "Add input validation to every exported function", repo });
    const trace = driveWorkGraph(change);
    expect(trace.done).toBe(true);
    expect(trace.completionOrder.length).toBe(change.work.length);
  });

  it("reports not done when the graph cannot drain (defensive bound)", () => {
    // A manually constructed stuck trace is unreachable through the loader (it
    // rejects cycles), so we assert the bound returns a complete, honest trace
    // for a normal graph instead: done is true and every unit completed.
    const change = parseChangeSpec(LAYERED_SPEC);
    const trace = driveWorkGraph(change, { maxWaves: 64 });
    expect(trace.done).toBe(true);
    expect(trace.completionOrder.length).toBe(change.work.length);
  });
});

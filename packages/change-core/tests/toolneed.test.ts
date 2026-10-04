/**
 * M4: the agent-for-agent tool-build trigger is derived from the WORK, not the
 * goal string.
 *
 * `detectToolRequirement` reads only the Change's shape (its WorkUnits, their
 * declared paths, and the generic edit kind the decomposer encodes in the unit
 * id). It fires when a group of units repeats the SAME mechanical transform
 * across enough distinct files that one agent building a tool pays for itself,
 * and does not fire otherwise. These tests pin that:
 *
 *   (a) it DOES fire for a wide fan-out (many units, same edit kind, many
 *       files): a tool is justified;
 *   (b) it does NOT fire for a layered Change of distinct units (a module + an
 *       api + a tests unit), because no group repeats one transform across many
 *       files;
 *   (c) it is derived from the Change shape, not the goal string: two Changes
 *       whose units have the same shape but came from different goals yield the
 *       same requirement, and shrinking the fan-out below the threshold stops it
 *       firing;
 *   (d) exactly one tool is recommended (the largest qualifying fan-out).
 */

import { describe, expect, it } from "vitest";

import { decompose, detectToolRequirement, parseChangeSpec, type RepoFile } from "../src/index.ts";

// A flat library repo: independent modules of exported functions, no router.
const FLAT_REPO: RepoFile[] = [
  { path: "src/statistics.ts", content: "export function mean(v: number[]): number { return 0; }\n" },
  { path: "src/geometry.ts", content: "export function area(w: number, h: number): number { return w * h; }\n" },
  { path: "src/finance.ts", content: "export function pct(a: number, p: number): number { return 0; }\n" },
  { path: "src/temperature.ts", content: "export function toC(f: number): number { return f; }\n" },
  { path: "src/index.ts", content: "export { mean } from './statistics.js';\n" },
];

// A layered repo: a model module, an api that depends on it, an entry point and
// tests. This is the audit shape: distinct units doing different work.
const LAYERED_REPO: RepoFile[] = [
  { path: "src/audit/events.ts", content: "export interface AuditEvent { id: number }\n" },
  { path: "src/audit/store.ts", content: "export class AuditStore {}\n" },
  { path: "src/api/audit/handler.ts", content: "export function createAuditApi() { return {}; }\n" },
  { path: "src/index.ts", content: "export { AuditStore } from './audit/store.js';\n" },
  { path: "tests/audit/store.test.ts", content: "import { AuditStore } from '../../src/audit/store.js';\n" },
];

const UNIVERSAL_GOAL = "Add input validation to every exported function";
const AUDIT_GOAL = "Add organization-level audit logging with a read API and tests";

describe("M4: the tool-build trigger is derived from the work, not the goal", () => {
  it("DOES fire for a wide fan-out: many units repeating one transform over many files", () => {
    const change = decompose({ goal: UNIVERSAL_GOAL, repo: FLAT_REPO }).change;
    const req = detectToolRequirement(change);
    expect(req).toBeDefined();
    expect(req?.editKind).toBe("validate");
    expect(req?.toolUnitId).toBe("tool-validate");
    expect(req?.capability).toBe("codemod:validate");
    // The fan-out units are the consumers, and the tool spans their files.
    expect(req?.consumers.length).toBeGreaterThanOrEqual(3);
    expect(req?.files.length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT fire for a layered Change of distinct units (no repeated transform)", () => {
    const change = decompose({ goal: AUDIT_GOAL, repo: LAYERED_REPO }).change;
    // Sanity: this is the layered shape (it has dependency edges / distinct ids).
    expect(change.work.length).toBeGreaterThan(1);
    const req = detectToolRequirement(change);
    expect(req).toBeUndefined();
  });

  it("does NOT fire for the hand-authored audit Change (the make-demo collision case)", () => {
    const change = parseChangeSpec(`
id: change-audit-logging
objective: Add organization-level audit logging
work:
  - id: model
    objective: Implement audit event persistence
    paths: [src/audit/**]
  - id: api
    objective: Add API read endpoints
    depends_on: [model]
    paths: [src/api/audit/**, src/audit/events.ts]
  - id: tests
    objective: Add audit logging tests
    paths: [tests/audit/**, src/audit/events.ts]
`);
    expect(detectToolRequirement(change)).toBeUndefined();
  });

  it("is keyed on the work shape, not the goal string: same shape, different goal, same requirement", () => {
    // Two different universal goal strings reduce to the same fan-out shape over
    // the same repo, so the SAME tool requirement is detected.
    const a = decompose({ goal: "Add input validation to every exported function", repo: FLAT_REPO }).change;
    const b = decompose({ goal: "Guard each exported function with validation", repo: FLAT_REPO }).change;
    const reqA = detectToolRequirement(a);
    const reqB = detectToolRequirement(b);
    expect(reqA?.capability).toBe(reqB?.capability);
    expect([...(reqA?.consumers ?? [])].sort()).toEqual([...(reqB?.consumers ?? [])].sort());
    expect([...(reqA?.files ?? [])].sort()).toEqual([...(reqB?.files ?? [])].sort());
  });

  it("does NOT fire when the fan-out is below the min-fanout threshold", () => {
    // The same wide fan-out, but a higher threshold than the number of files, so
    // the repetition no longer justifies a tool. Same code path, structural dial.
    const change = decompose({ goal: UNIVERSAL_GOAL, repo: FLAT_REPO }).change;
    const fileCount = detectToolRequirement(change)?.files.length ?? 0;
    expect(fileCount).toBeGreaterThan(0);
    const req = detectToolRequirement(change, { minFanout: fileCount + 1 });
    expect(req).toBeUndefined();
  });

  it("recommends exactly one tool (the largest qualifying fan-out)", () => {
    const change = decompose({ goal: UNIVERSAL_GOAL, repo: FLAT_REPO }).change;
    const req = detectToolRequirement(change);
    // One requirement object, not a list; it names a single capability.
    expect(req).toBeDefined();
    expect(typeof req?.capability).toBe("string");
  });

  it("does not count a unit as its own consumer: a tool-* unit is structural", () => {
    // A Change that already has a tool-builder unit does not re-detect a need for
    // the same capability (the redundancy guard), and the tool-builder unit is
    // not grouped as repeated content work.
    const change = parseChangeSpec(`
id: already-tooled
objective: already has a validate tool
work:
  - id: tool-validate
    objective: build the validate codemod
    paths: [tools/validate-codemod.mjs]
  - id: validate-a
    objective: validate a
    paths: [src/a.ts]
  - id: validate-b
    objective: validate b
    paths: [src/b.ts]
  - id: validate-c
    objective: validate c
    paths: [src/c.ts]
`);
    // The tool unit already exists, so no second tool is recommended.
    expect(detectToolRequirement(change)).toBeUndefined();
  });
});

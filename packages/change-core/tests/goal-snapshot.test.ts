/**
 * Unit tests for the goal analyzer and the repo snapshot: the two generic,
 * goal-agnostic feature extractors the decomposer consumes.
 */

import { describe, expect, it } from "vitest";

import { buildRepoSnapshot, HeuristicGoalAnalyzer, type RepoFile } from "../src/index.ts";

describe("HeuristicGoalAnalyzer", () => {
  const analyzer = new HeuristicGoalAnalyzer();

  it("detects the validate action and the universal quantifier", () => {
    const intent = analyzer.analyze("Add input validation to every exported function");
    expect(intent.actions).toContain("validate");
    expect(intent.isUniversal).toBe(true);
    expect(intent.targets).toContain("input");
    expect(intent.targets).toContain("function");
  });

  it("detects the wire action and the test action", () => {
    const intent = analyzer.analyze("Add a health-check endpoint and wire it into the router");
    expect(intent.actions).toContain("add");
    expect(intent.actions).toContain("wire");
    expect(intent.isUniversal).toBe(false);
    expect(intent.targets).toContain("health-check");
    expect(intent.targets).toContain("router");
  });

  it("falls back to the add action when no verb is recognized", () => {
    const intent = analyzer.analyze("organization-level audit logging");
    expect(intent.actions).toContain("add");
  });

  it("is deterministic", () => {
    const a = analyzer.analyze("Add input validation to every exported function");
    const b = analyzer.analyze("Add input validation to every exported function");
    expect(a).toEqual(b);
  });
});

describe("buildRepoSnapshot", () => {
  const files: RepoFile[] = [
    { path: "src/audit/events.ts", content: "export function makeAuditEvent() {}\nexport interface AuditEvent {}\n" },
    { path: "src/audit/store.ts", content: "export class AuditStore {}\n" },
    { path: "src/api/audit/handler.ts", content: "export function createAuditApi() { return req.path; }\n" },
    { path: "src/index.ts", content: "export { AuditStore } from './audit/store.js';\n" },
    { path: "tests/audit/store.test.ts", content: "import { AuditStore } from '../../src/audit/store.js';\n" },
    { path: "README.md", content: "# not typescript\n" },
    { path: "src/types.d.ts", content: "export type Foo = number;\n" },
  ];

  it("separates source files from test files and ignores non-TS and declarations", () => {
    const snapshot = buildRepoSnapshot(files);
    const sourcePaths = snapshot.sourceFiles.map((f) => f.path);
    expect(sourcePaths).toContain("src/audit/events.ts");
    expect(sourcePaths).toContain("src/index.ts");
    // Test files, non-TS, and .d.ts are not source files.
    expect(sourcePaths).not.toContain("tests/audit/store.test.ts");
    expect(sourcePaths).not.toContain("README.md");
    expect(sourcePaths).not.toContain("src/types.d.ts");
    expect(snapshot.testFiles).toEqual(["tests/audit/store.test.ts"]);
    expect(snapshot.hasTests).toBe(true);
  });

  it("extracts exported symbols with their kinds", () => {
    const snapshot = buildRepoSnapshot(files);
    const events = snapshot.sourceFiles.find((f) => f.path === "src/audit/events.ts");
    expect(events?.exports.map((e) => e.name).sort()).toEqual(["AuditEvent", "makeAuditEvent"]);
    const store = snapshot.sourceFiles.find((f) => f.path === "src/audit/store.ts");
    expect(store?.exports[0]).toEqual({ name: "AuditStore", kind: "class" });
  });

  it("recognizes entry points and router-like files", () => {
    const snapshot = buildRepoSnapshot(files);
    const index = snapshot.sourceFiles.find((f) => f.path === "src/index.ts");
    expect(index?.isEntryPoint).toBe(true);
    const handler = snapshot.sourceFiles.find((f) => f.path === "src/api/audit/handler.ts");
    expect(handler?.isRouterLike).toBe(true);
  });

  it("groups source files into modules by directory", () => {
    const snapshot = buildRepoSnapshot(files);
    const dirs = snapshot.modules.map((m) => m.dir);
    expect(dirs).toContain("src/audit");
    expect(dirs).toContain("src/api/audit");
    expect(dirs).toContain("src");
  });
});

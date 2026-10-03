/**
 * Unit tests for the deterministic path-scope glob matcher.
 *
 * These are pure (no filesystem, no Git), so they pin the exact matching rules
 * the path-scope check relies on.
 */

import { describe, expect, it } from "vitest";

import { matchesGlob, partitionByScope } from "../src/pathscope.ts";

describe("matchesGlob", () => {
  it("matches a double-star against any depth, including zero", () => {
    expect(matchesGlob("src/alpha/alpha.done", "src/alpha/**")).toBe(true);
    expect(matchesGlob("src/alpha/deep/nested/file.ts", "src/alpha/**")).toBe(true);
    // "src/alpha/**" also matches the directory itself.
    expect(matchesGlob("src/alpha", "src/alpha/**")).toBe(true);
  });

  it("keeps a single star within one path segment", () => {
    expect(matchesGlob("src/index.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/audit/store.ts", "src/*.ts")).toBe(false);
  });

  it("matches a question mark against exactly one character", () => {
    expect(matchesGlob("a1", "a?")).toBe(true);
    expect(matchesGlob("a12", "a?")).toBe(false);
  });

  it("rejects paths outside the declared prefix", () => {
    expect(matchesGlob("src/beta/beta.done", "src/alpha/**")).toBe(false);
    expect(matchesGlob("package.json", "src/alpha/**")).toBe(false);
  });
});

describe("partitionByScope", () => {
  it("splits changed paths into in-scope and out-of-scope, preserving order", () => {
    const changed = ["src/alpha/one.ts", "package.json", "src/alpha/two.ts", "src/beta/x.ts"];
    const result = partitionByScope(changed, ["src/alpha/**"]);
    expect(result.inScope).toEqual(["src/alpha/one.ts", "src/alpha/two.ts"]);
    expect(result.outOfScope).toEqual(["package.json", "src/beta/x.ts"]);
  });

  it("treats an empty declared scope as allowing nothing", () => {
    const result = partitionByScope(["src/alpha/one.ts"], []);
    expect(result.inScope).toEqual([]);
    expect(result.outOfScope).toEqual(["src/alpha/one.ts"]);
  });
});

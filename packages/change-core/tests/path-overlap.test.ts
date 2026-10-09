import { describe, expect, it } from "vitest";

import {
  entriesOverlap,
  entryWithin,
  intentWithin,
  normalizeIntentEntry,
  overlappingEntries,
} from "../src/index.ts";

describe("entriesOverlap", () => {
  it.each([
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "src", true],
    ["src/**", "srcx/a.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/*.ts", "src/*.js", false],
    ["src/*.ts", "src/a*", true],
    ["src/**", "src/a/*.ts", true],
    ["**/*.ts", "lib/deep/x.ts", true],
    ["**/*.ts", "lib/deep/x.js", false],
    ["src/a?.ts", "src/ab.ts", true],
    ["src/a?.ts", "src/a/.ts", false],
    ["src/a/**", "src/b/**", false],
    ["src/a.ts#parse", "src/a.ts#emit", true],
    ["src/a.ts#parse", "src/*.ts", true],
    ["src/a.ts#parse", "src/b.ts", false],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(entriesOverlap(a, b)).toBe(expected);
    expect(entriesOverlap(b, a)).toBe(expected);
  });

  it("lists the overlapping entries of the first intent in order", () => {
    expect(overlappingEntries(["src/a.ts", "docs/**", "src/b/**"], ["src/**"])).toEqual(["src/a.ts", "src/b/**"]);
    expect(overlappingEntries(["docs/**"], ["src/**"])).toEqual([]);
  });
});

describe("normalizeIntentEntry", () => {
  it("normalizes separators and leading ./", () => {
    expect(normalizeIntentEntry("./src\\a.ts")).toBe("src/a.ts");
    expect(normalizeIntentEntry("src//a/")).toBe("src/a/**");
    expect(normalizeIntentEntry("src/a.ts#parse")).toBe("src/a.ts#parse");
  });

  it.each(["", "/etc/passwd", "../outside", "src/../x", "src/./x", "C:/x", "src/a.ts#", "src/*.ts#f", "src/a.ts#1x"])(
    "rejects %j",
    (entry) => {
      expect(normalizeIntentEntry(entry)).toBeUndefined();
    },
  );
});

describe("entryWithin (narrowing)", () => {
  it.each([
    ["src/a.ts", "src/**", true],
    ["src/a/*.ts", "src/**", true],
    ["src/a.ts#parse", "src/a.ts", true],
    ["src/a.ts#parse", "src/*.ts", true],
    ["src/a.ts", "src/a.ts#parse", false],
    ["src/**", "src/a/**", false],
    ["lib/a.ts", "src/**", false],
    ["anything/*.ts", "**", true],
  ])("%s within %s -> %s", (inner, outer, expected) => {
    expect(entryWithin(inner, outer)).toBe(expected);
  });

  it("requires every entry to be within some outer entry", () => {
    expect(intentWithin(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts", "src/c.ts"])).toBe(true);
    expect(intentWithin(["src/a.ts", "lib/b.ts"], ["src/**"])).toBe(false);
  });
});

describe("regressions", () => {
  it("a glob with ** followed by more characters in a segment is not within dir/**", () => {
    // "src/**x" also matches "srcx", which "src/**" does not.
    expect(entryWithin("src/**x", "src/**")).toBe(false);
    // The glob semantics mirror the path-scope matcher, where "src/**/x" reads
    // as "src(/.*)?x" and so also names "srcx": not within "src/**" either.
    expect(entryWithin("src/**/x", "src/**")).toBe(false);
    expect(entryWithin("src/a/**/x.ts", "src/**")).toBe(true);
    expect(entryWithin("src/*.ts", "src/**")).toBe(true);
    expect(entryWithin("src/**", "src/*")).toBe(false);
    expect(entryWithin("src/a?.ts", "src/a*.ts")).toBe(true);
    expect(entryWithin("src/a*.ts", "src/a?.ts")).toBe(false);
    expect(entryWithin("a/*/c.ts", "a/**/c.ts")).toBe(true);
  });

  it("a trailing slash names the directory and overlaps files under it", () => {
    expect(normalizeIntentEntry("src/core/")).toBe("src/core/**");
    expect(entriesOverlap(normalizeIntentEntry("src/core/")!, "src/core/deep/a.ts")).toBe(true);
    expect(entriesOverlap(normalizeIntentEntry("src/core/")!, "src/corex.ts")).toBe(false);
  });

  it("rejects an over-long entry and stays fast on adversarial globs", () => {
    expect(normalizeIntentEntry(`src/${"a".repeat(600)}`)).toBeUndefined();
    const nasty = `${"*/".repeat(100)}**`;
    const other = `${"?*".repeat(120)}x`;
    const started = Date.now();
    entriesOverlap(nasty, other);
    entryWithin(other.slice(0, 200), nasty);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

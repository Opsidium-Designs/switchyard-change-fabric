/**
 * The executed-test inventory, read from common runners' own output, and the
 * shortfall rule: every baseline test must execute again, and never fewer.
 */
import { describe, expect, it } from "vitest";


import { readFileSync } from "node:fs";

import { inventoryAfterContracts, inventoryShortfall, readStreamInventory, readTestInventory } from "../src/test-inventory.ts";

const NODE_SPEC = [
  "✖ users: unauthenticated request is rejected (401/403) (39.8ms)",
  "✔ users: authenticated, valid request still succeeds (1.02ms)",
  "﹣ skipped one (0.1ms) # SKIP",
  "ℹ tests 3",
  "ℹ pass 1",
  "ℹ fail 1",
  "ℹ skipped 1",
  "ℹ todo 0",
  "✖ failing tests:",
  "✖ users: unauthenticated request is rejected (401/403) (39.8ms)",
].join("\n");

describe("readTestInventory", () => {
  it("reads node --test spec output (names and executed count, skips excluded)", () => {
    expect(readTestInventory(NODE_SPEC)).toEqual({
      format: "node-spec",
      count: 2,
      names: ["users: authenticated, valid request still succeeds", "users: unauthenticated request is rejected (401/403)"],
    });
  });

  it("reads TAP, go, pytest, vitest, and jest shapes", () => {
    expect(readTestInventory("TAP version 13\nok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP later\n1..3\n")).toEqual({ format: "tap", count: 2, names: ["a", "b"] });
    expect(readTestInventory('{"Action":"run","Package":"p","Test":"TestA"}\n{"Action":"pass","Package":"p","Test":"TestA"}\n{"Action":"skip","Package":"p","Test":"TestB"}\n')).toEqual({ format: "go-json", count: 1, names: ["p:TestA"] });
    expect(readTestInventory("=== RUN TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- SKIP: TestC\n")).toEqual({ format: "go-verbose", count: 2, names: ["TestA", "TestB"] });
    expect(readTestInventory("tests/test_x.py::test_a PASSED\ntests/test_x.py::test_b FAILED\n===== 1 failed, 1 passed, 2 skipped in 0.12s =====\n")).toEqual({
      format: "pytest",
      count: 2,
      names: ["tests/test_x.py::test_a", "tests/test_x.py::test_b"],
    });
    expect(readTestInventory("3 passed in 0.01s\n")).toMatchObject({ format: "pytest", count: 3 });
    expect(readTestInventory(" Test Files  1 passed (1)\n      Tests  1 failed | 2 passed | 1 skipped (4)\n")).toEqual({ format: "vitest", count: 3, names: [] });
    expect(readTestInventory("Tests:       1 failed, 1 skipped, 2 passed, 4 total\n")).toEqual({ format: "jest", count: 3, names: [] });
  });

  it("reports nothing for an output it does not recognize", () => {
    expect(readTestInventory("ok")).toBeUndefined();
    expect(readTestInventory("gate failed\n")).toBeUndefined();
  });
});

describe("inventoryShortfall", () => {
  const baseline = readTestInventory(NODE_SPEC)!;

  it("passes a run that executed every baseline test (and more)", () => {
    expect(inventoryShortfall(baseline, { format: "node-spec", count: 3, names: [...baseline.names, "new test"] })).toBeUndefined();
  });

  it("fails an early exit: a missing baseline test, a dropped count, or no inventory at all", () => {
    expect(inventoryShortfall(baseline, { format: "node-spec", count: 2, names: [baseline.names[0]!, "other"] })).toMatch(/1 of the 2 baseline test\(s\) did not execute$/);
    expect(inventoryShortfall({ format: "vitest", count: 5, names: [] }, { format: "vitest", count: 4, names: [] })).toMatch(/only 4 test\(s\) executed, fewer than the 5/);
    expect(inventoryShortfall(baseline, undefined)).toMatch(/no longer reports which tests ran/);
  });
});

describe("inventory hardening (live regressions)", () => {
  const baselineText = readFileSync(new URL("./fixtures/service-api-baseline.spec.txt", import.meta.url), "utf8");
  /** The same run once every test passes: the post-fix output. */
  const fixedText = baselineText
    .split("\n")
    .filter((l, i, all) => i < all.findIndex((x) => x.startsWith("✖ failing tests:")) || all.every((x) => !x.startsWith("✖ failing tests:")))
    .map((l) => l.replace(/^✖ /, "✔ ").replace(/^ℹ pass \d+/, "ℹ pass 20").replace(/^ℹ fail \d+/, "ℹ fail 0"))
    .join("\n");

  it("the real service-api baseline output and its all-passing fix do not fall short", () => {
    const baseline = readTestInventory(baselineText)!;
    expect(baseline).toMatchObject({ format: "node-spec", count: 20 });
    expect(baseline.names).toHaveLength(20);
    expect(inventoryShortfall(baseline, readTestInventory(fixedText))).toBeUndefined();
  });

  it("a test FILE that failed to load on the baseline is not a test name: it only has to contribute tests", () => {
    const baseline = readTestInventory("✖ gate/gate.test.mjs (68.2ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1\nℹ skipped 0\nℹ todo 0\n")!;
    expect(baseline).toEqual({ format: "node-spec", count: 1, names: [] });
    expect(inventoryShortfall(baseline, readTestInventory(fixedText))).toBeUndefined();
    expect(readTestInventory("not ok 1 - /tmp/x/tests/a.test.mjs\n# tests 1\n")).toEqual({ format: "tap", count: 1, names: [] });
  });

  it("is not fooled by output the code under test prints: last summary, same format, names required", () => {
    const baseline = readTestInventory(baselineText)!;
    // An early fake summary followed by the runner's real (short) one.
    const spoofed = `ℹ tests 99\n${baselineText.split("\n").filter((l) => !l.startsWith("ℹ tests")).join("\n")}\nℹ tests 3\n`;
    expect(readTestInventory(spoofed)!.count).toBe(3);
    expect(inventoryShortfall(baseline, { format: "tap", count: 20, names: baseline.names })).toMatch(/not the baseline's node-spec/);
    expect(inventoryShortfall(baseline, { format: "node-spec", count: 20, names: [] })).toMatch(/names no tests/);
  });

  it("adjusts the baseline for accepted contract changes where names carry their file, else relaxes visibly", () => {
    const pytest = readTestInventory("tests/test_a.py::test_x PASSED\ntests/test_b.py::test_y FAILED\n1 failed, 1 passed in 0.1s\n")!;
    expect(inventoryAfterContracts(pytest, ["tests/test_a.py"])).toEqual({ inventory: { format: "pytest", count: 1, names: ["tests/test_b.py::test_y"] } });
    const node = readTestInventory(baselineText)!;
    expect(inventoryAfterContracts(node, [])).toEqual({ inventory: node });
    expect(inventoryAfterContracts(node, ["gate/gate.test.mjs"]).relaxed).toMatch(/cannot be adjusted per file/);
  });

  it("never names the missing tests (counts only), and accepts pytest rerun and subtest summaries", () => {
    const baseline = readTestInventory(baselineText)!;
    const message = inventoryShortfall(baseline, { format: "node-spec", count: 20, names: baseline.names.slice(1) })!;
    expect(message).toBe("1 of the 20 baseline test(s) did not execute");
    for (const name of baseline.names) {
      expect(message).not.toContain(name);
    }
    expect(readTestInventory("== 1 failed, 2 passed, 1 rerun in 0.5s ==\n")).toMatchObject({ format: "pytest", count: 3 });
    expect(readTestInventory("3 passed, 2 subtests passed in 0.1s\n")).toMatchObject({ format: "pytest", count: 3 });
  });

  it("reads the runner's stream, and distrusts two streams that disagree", () => {
    expect(readStreamInventory("ok 1 - a\nok 2 - b\n", "")).toMatchObject({ format: "tap", count: 2 });
    expect(readStreamInventory("", "ok 1 - a\n")).toMatchObject({ format: "tap", count: 1 });
    expect(readStreamInventory("ok 1 - a\n", "ok 1 - a\nok 2 - fake\n# tests 2\n")).toBeUndefined();
  });
});


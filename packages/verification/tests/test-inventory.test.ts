/**
 * The executed-test inventory, read from common runners' own output, and the
 * shortfall rule: every baseline test must execute again, and never fewer.
 */
import { describe, expect, it } from "vitest";


import { readFileSync } from "node:fs";

import { inventoryAfterContracts, inventoryShortfall, labelGateProgress, readStreamInventory, readTestInventory, readTestProgress } from "../src/test-inventory.ts";

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


describe("readTestProgress (advisory progress per revision)", () => {
  it("sums several vitest suites and lists each; reads node, jest, pytest, tap", () => {
    const vitest = " Test Files  2 failed (2)\n      Tests  3 failed | 50 passed (53)\n ...\n      Tests  41 failed | 35 passed (76)\n";
    expect(readTestProgress(vitest)).toEqual({
      format: "vitest",
      passed: 85,
      failed: 44,
      total: 129,
      suites: [
        { passed: 50, failed: 3, total: 53 },
        { passed: 35, failed: 41, total: 76 },
      ],
    });
    expect(readTestProgress("ℹ tests 4\nℹ pass 3\nℹ fail 1\n")).toMatchObject({ format: "node-spec", passed: 3, failed: 1, total: 4 });
    expect(readTestProgress("Tests:       1 failed, 3 passed, 4 total\n")).toMatchObject({ format: "jest", passed: 3, failed: 1 });
    expect(readTestProgress("===== 2 failed, 8 passed in 0.12s =====\n")).toMatchObject({ format: "pytest", passed: 8, failed: 2 });
    expect(readTestProgress("ok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP\n")).toMatchObject({ format: "tap", passed: 1, failed: 1, total: 2 });
    expect(readTestProgress("> pkg gate\nerror TS2304\n")).toBeUndefined();
  });
});

describe("progress per suite, labeled against the immutable acceptance gate", () => {
  const acceptanceFiles = ["gate/billing.test.ts", "gate/money.test.ts", "gate/harness.ts", "tsconfig.json"];
  const developer = [
    " RUN  v2.1.8 /work/storefront",
    " ✓ tests/catalog.test.ts (3 tests) 4ms",
    " ✓ tests/orders.test.ts (6 tests) 6ms",
    " Test Files  2 passed (2)",
    "      Tests  9 passed (9)",
  ].join("\n");
  const acceptance = [
    " RUN  v2.1.8 /work/storefront",
    " ❯ gate/billing.test.ts (5 tests | 5 failed) 33ms",
    " ❯ gate/money.test.ts (19 tests | 15 failed) 55ms",
    " FAIL  gate/billing.test.ts > payments > paying in parts",
    "AssertionError: expected 1072 to be 1073",
    " Test Files  2 failed (2)",
    "      Tests  20 failed | 4 passed (24)",
  ].join("\n");
  const gateHeader = "> tsc --noEmit && vitest run && vitest run --config gate/vitest.config.ts";

  it("attributes each summary to the files it listed; the acceptance suite's count is its own, never the developer suite's", () => {
    const progress = readTestProgress(`${gateHeader}\n${developer}\n${acceptance}\n`);
    expect(progress?.suites?.map((s) => s.files)).toEqual([["tests/catalog.test.ts", "tests/orders.test.ts"], ["gate/billing.test.ts", "gate/money.test.ts"]]);
    expect(labelGateProgress(progress, acceptanceFiles)).toEqual({
      passed: 13,
      failed: 20,
      total: 33,
      suites: [
        { passed: 9, failed: 0, total: 9, suite: "developer" },
        { passed: 4, failed: 20, total: 24, suite: "acceptance" },
      ],
      acceptance: { passed: 4, failed: 20, total: 24 },
    });
  });

  it("a typecheck that failed first: the acceptance suite did not run, stated instead of a number", () => {
    const output = `${gateHeader}\nsrc/orders/cart.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'.\n`;
    const progress = readTestProgress(output);
    expect(progress).toMatchObject({ passed: 0, failed: 0, total: 0, typeErrors: 1 });
    expect(labelGateProgress(progress, acceptanceFiles)).toEqual({ passed: 0, failed: 0, total: 0, acceptanceNotRun: "typecheck failed (1 error)" });
  });

  it("a developer suite that passed while the acceptance summary is missing never reads as acceptance progress", () => {
    const failedDev = developer.replace("✓ tests/orders.test.ts", "❯ tests/orders.test.ts").replace("Tests  9 passed (9)", "Tests  2 failed | 7 passed (9)");
    expect(labelGateProgress(readTestProgress(`${gateHeader}\n${failedDev}\n`), acceptanceFiles)).toMatchObject({
      acceptanceNotRun: "the developer suite failed first (2 failed)",
      suites: [{ passed: 7, failed: 2, total: 9, suite: "developer" }],
    });
    // The bounded capture cut the acceptance suite's summary: say so, never "9/9".
    const cut = `${gateHeader}\n${developer}\n RUN  v2.1.8 /work/storefront\n ❯ gate/billing.test.ts (5 tests | 5 failed)\n...[truncated 9000 chars]`;
    const labeled = labelGateProgress(readTestProgress(cut), acceptanceFiles);
    expect(labeled?.acceptance).toBeUndefined();
    expect(labeled?.acceptanceNotRun).toBe("its summary was not captured (the gate output was cut short)");
  });

  it("without a known acceptance gate, or with a suite that named no files, nothing is labeled or claimed", () => {
    expect(labelGateProgress(readTestProgress("      Tests  1 failed | 2 passed (3)\n"), acceptanceFiles)).toEqual({ passed: 2, failed: 1, total: 3 });
    expect(labelGateProgress(readTestProgress(`${developer}\n`), [])).toEqual({ passed: 9, failed: 0, total: 9 });
    expect(labelGateProgress(readTestProgress("nothing recognizable"), acceptanceFiles)).toBeUndefined();
  });
});

/**
 * The implicated set and its label: one combination of the parse and an
 * advisory pick, shared by the local integrator and the integration Workflow.
 */
import { describe, expect, it } from "vitest";

import { attributeFailure, combineAttribution, failingRepoFiles } from "../src/index.ts";

const merged = ["u-a", "u-b", "u-c", "u-d", "u-e", "u-f"];

describe("combineAttribution", () => {
  it("an unattributed parse with a confident pick implicates the pick ALONE, labeled jev (never all six)", () => {
    expect(combineAttribution({ merged, parsed: merged, attributed: false, picks: ["u-c"] })).toEqual({ items: ["u-c"], source: "jev" });
  });

  it("no pick: the parse, or every merged item when the parse attributed nothing", () => {
    expect(combineAttribution({ merged, parsed: ["u-b"], attributed: true, picks: [] })).toEqual({ items: ["u-b"], source: "parse" });
    expect(combineAttribution({ merged, parsed: merged, attributed: false, picks: [] })).toEqual({ items: merged, source: "all" });
  });

  it("a pick the parse already named is labeled parse (it changed nothing); a pick outside it is added, labeled jev", () => {
    expect(combineAttribution({ merged, parsed: ["u-b", "u-d"], attributed: true, picks: ["u-d"] })).toEqual({ items: ["u-b", "u-d"], source: "parse" });
    expect(combineAttribution({ merged, parsed: ["u-d"], attributed: true, picks: ["u-a"] })).toEqual({ items: ["u-a", "u-d"], source: "jev" });
  });

  it("ignores a pick naming an item the revision did not merge", () => {
    expect(combineAttribution({ merged, parsed: merged, attributed: false, picks: ["u-zz"] })).toEqual({ items: merged, source: "all" });
  });

  it("composes with the parse the same way on any path", () => {
    const units = merged.map((id) => ({ unitId: id, paths: [`src/${id}/**`] }));
    const parse = attributeFailure(units, "Error: something broke somewhere");
    expect(parse.attributed).toBe(false);
    expect(
      combineAttribution({ merged, parsed: parse.attributed ? parse.units.map((u) => u.unitId) : [], attributed: parse.attributed, picks: ["u-e"] }),
    ).toEqual({ items: ["u-e"], source: "jev" });
  });
});

describe("type-checker locations", () => {
  const tscOutput = [
    "> storefront@0.0.0 gate",
    "> tsc --noEmit && vitest run && vitest run --config gate/vitest.config.ts",
    "",
    "src/orders/cart.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'.",
    "src/billing/invoices.ts(99,30): error TS2339: Property 'auth' does not exist on type 'Ctx'.",
  ].join("\n");

  it("parses tsc's `path(line,col): error TSxxxx` form (repo-relative) into the implicated owners", () => {
    const units = [
      { unitId: "orders", paths: ["src/orders/cart.ts"] },
      { unitId: "invoices", paths: ["src/billing/invoices.ts"] },
      { unitId: "payments", paths: ["src/billing/payments.ts"] },
    ];
    const result = attributeFailure(units, tscOutput);
    expect(result.attributed).toBe(true);
    expect(result.units.map((u) => u.unitId).sort()).toEqual(["invoices", "orders"]);
  });

  it("names the failing repo files for a type error", () => {
    expect(failingRepoFiles(tscOutput, ["src/orders/cart.ts", "src/billing/invoices.ts", "src/contracts/http.ts"]).sort()).toEqual([
      "src/billing/invoices.ts",
      "src/orders/cart.ts",
    ]);
  });
});

describe("failingRepoFiles: the place a failure is IN, not a helper it called", () => {
  const repo = ["src/resources/users.js", "src/resources/orders.js", "src/contracts/auth.js", "src/app.js", "test/users.test.js"];
  // The service-api shape: the assertion names the resource; a stack frame (and a
  // require stack) names the shared contract the handler called.
  const reg2 = [
    "✖ users: unauthenticated request is rejected (401/403) (12ms)",
    "  AssertionError [ERR_ASSERTION]: users must reject an unauthenticated request via requireAuth, got 201",
    "      at requireAuth (/tmp/scf-int/src/contracts/auth.js:14:9)",
    "      at handleUsers (/tmp/scf-int/src/resources/users.js:22:3)",
    "      at TestContext.<anonymous> (/tmp/scf-int/test/users.test.js:30:5)",
  ].join("\n");

  it("prefers the failing test title over stack frames: never the shared contract a frame names", () => {
    expect(failingRepoFiles(reg2, repo)).toEqual(["src/resources/users.js"]);
  });

  it("from frames alone, takes each stack's outermost non-test repo frame (the caller), never a deeper callee", () => {
    const framesOnly = [
      "Error: boom",
      "    at requireAuth (/tmp/x/src/contracts/auth.js:14:9)",
      "    at handleOrders (/tmp/x/src/resources/orders.js:9:1)",
      "    at Object.<anonymous> (/tmp/x/test/users.test.js:3:1)",
    ].join("\n");
    expect(failingRepoFiles(framesOnly, repo)).toEqual(["src/resources/orders.js"]);
  });

  it("keeps error locations outside frames (type and syntax errors)", () => {
    expect(failingRepoFiles("src/app.js:3\n  return x +;\n           ^\nSyntaxError: Unexpected token ';'", repo)).toEqual(["src/app.js"]);
  });
});

describe("attribution stays linear on hostile gate output", () => {
  const units = [
    { unitId: "u-users", paths: ["src/resources/users.js"] },
    { unitId: "u-orders", paths: ["src/resources/orders.js"] },
  ];
  const n = 100_000;
  const shapes: Record<string, string> = {
    letters: "a".repeat(n),
    "slashed segments": "a/".repeat(n / 2),
    "dotted segments": "a.".repeat(n / 2),
    "dotted path with a line suffix": `${"a/b.".repeat(n / 4)}:1`,
    "repeated error class with no colon": "Error".repeat(n / 5),
    "mixed path characters": "a-b_c.d/".repeat(n / 8),
  };
  for (const [name, token] of Object.entries(shapes)) {
    it(`a 100k-char unbroken token line (${name}) finishes well under 200 ms`, () => {
      const evidence = `not ok 1 - users: rejects\n${token}\n    at handle (/tmp/x/src/resources/users.js:3:1)\n`;
      const started = performance.now();
      const result = attributeFailure(units, evidence);
      failingRepoFiles(evidence, ["src/resources/users.js", "src/resources/orders.js"]);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(200);
      expect(result.units.map((u) => u.unitId)).toEqual(["u-users"]);
    });
  }

  it("still finds a drive-prefixed location and a tsc location, and skips node internals", () => {
    const evidence = [
      "    at x (node:internal/modules/cjs/loader.js:1:1)",
      "src/resources/orders.js(4,2): error TS2322",
    ].join("\n");
    expect(attributeFailure(units, evidence).units.map((u) => u.unitId)).toEqual(["u-orders"]);
    expect(attributeFailure(units, "    at y (C:/work/src/resources/users.js:9:1)").units.map((u) => u.unitId)).toEqual(["u-users"]);
  });
});

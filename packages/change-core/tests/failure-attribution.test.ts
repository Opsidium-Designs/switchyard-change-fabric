/**
 * The implicated set and its label: one combination of the parse and an
 * advisory pick, shared by the local integrator and the integration Workflow.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

describe("outstanding items: failures of work not in the revision blame no merged item", () => {
  // The service-api shape: one whole-goal acceptance suite, one resource per item.
  const resource = (id: string, name: string) => ({ unitId: id, paths: [`src/resources/${name}.js`] });
  const mergedUnits = [resource("U1-users-resource", "users"), resource("U2-orders-resource", "orders"), resource("U3-products-resource", "products")];
  const outstandingUnits = [resource("U4-search-resource", "search"), resource("U5-notifications-resource", "notifications"), resource("U6-auth-resource", "auth")];
  const suite = (failing: readonly string[]) =>
    [
      "> switchyard-change-fabric-service-api@0.0.0 gate",
      "> node --check src/resources/users.js && node --check src/resources/search.js",
      ...["users", "orders", "products", "auth", "search", "notifications"].flatMap((r) =>
        [`unauthenticated request is rejected (401/403)`, `authenticated but invalid input is rejected with 400`].map(
          (t) => `${failing.includes(r) ? "\u2716" : "\u2714"} ${r}: ${t} (1.0ms)`,
        ),
      ),
      ...failing.map((r) => `  AssertionError [ERR_ASSERTION]: ${r} must reject an unauthenticated request via requireAuth, got 201`),
    ].join("\n");

  it("merged U1-U3 with only auth/search/notifications failing: no merged unit is implicated; the outstanding ones are listed", () => {
    const parse = attributeFailure(mergedUnits, suite(["auth", "search", "notifications"]), outstandingUnits);
    expect(parse).toEqual({ units: [], attributed: true, outstanding: outstandingUnits });
    expect(
      combineAttribution({
        merged: mergedUnits.map((u) => u.unitId),
        parsed: parse.units.map((u) => u.unitId),
        attributed: parse.attributed,
        picks: ["U1-users-resource"],
        outstanding: parse.outstanding.map((u) => u.unitId),
      }),
    ).toEqual({ items: [], source: "outstanding" });
  });

  it("output that maps to no board item at all still falls back to every merged unit (all)", () => {
    const parse = attributeFailure(mergedUnits, "AssertionError: something broke somewhere\n", outstandingUnits);
    expect(parse).toEqual({ units: mergedUnits, attributed: false, outstanding: [] });
    expect(combineAttribution({ merged: mergedUnits.map((u) => u.unitId), parsed: [], attributed: false, picks: [] })).toEqual({
      items: mergedUnits.map((u) => u.unitId),
      source: "all",
    });
  });

  it("mixed: only the merged unit whose own tests fail is implicated; the typed decision cannot add a merged unit the parse cleared", () => {
    const parse = attributeFailure(mergedUnits, suite(["orders", "search", "auth"]), outstandingUnits);
    expect(parse.units.map((u) => u.unitId)).toEqual(["U2-orders-resource"]);
    expect(parse.outstanding.map((u) => u.unitId)).toEqual(["U4-search-resource", "U6-auth-resource"]);
    expect(
      combineAttribution({
        merged: mergedUnits.map((u) => u.unitId),
        parsed: ["U2-orders-resource"],
        attributed: true,
        picks: ["U1-users-resource"],
        outstanding: ["U4-search-resource", "U6-auth-resource"],
      }),
    ).toEqual({ items: ["U2-orders-resource"], source: "parse" });
  });

  it("without outstanding units the parse is unchanged (the revision 1 and 2 behavior)", () => {
    const parse = attributeFailure(mergedUnits, suite(["auth", "search", "notifications"]));
    expect(parse).toEqual({ units: mergedUnits, attributed: false, outstanding: [] });
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

describe("failing tests map to the code they exercise (the storefront run board-live-sf10, revision 6)", () => {
  // Revision 6's recorded failing output (the checkout path replaced), the ten
  // merged items with their write intents, and the two items not in the tree.
  // The run attributed it to "all" and asked all ten owners for a fix.
  const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "storefront-sf10-rev6.json"), "utf8")) as {
    readonly output: string;
    readonly merged: readonly { readonly id: string; readonly paths: readonly string[] }[];
    readonly outstanding: readonly { readonly id: string; readonly paths: readonly string[] }[];
    readonly recordedFixRequested: readonly string[];
  };
  const unit = (i: { readonly id: string; readonly paths: readonly string[] }) => ({ unitId: i.id, paths: i.paths });
  const merged = fixture.merged.map(unit);
  const outstanding = fixture.outstanding.map(unit);
  const ids = (units: readonly { readonly unitId: string }[]) => units.map((u) => u.unitId);

  it("the recorded run blamed every merged item", () => {
    expect(fixture.recordedFixRequested).toHaveLength(10);
    expect(fixture.output).toContain("\u276f tests/orders.test.ts (2 tests | 2 failed)");
  });

  it("implicates only the merged orders and tax items; the other orders items are outstanding", () => {
    const parse = attributeFailure(merged, fixture.output, outstanding);
    expect(parse.attributed).toBe(true);
    expect(ids(parse.units)).toEqual(["unit-orders-cart", "unit-billing-tax"]);
    expect(ids(parse.outstanding)).toEqual(["unit-orders-checkout", "unit-orders-history"]);
    expect(
      combineAttribution({
        merged: ids(merged),
        parsed: ids(parse.units),
        attributed: parse.attributed,
        picks: ["unit-catalog-products"],
        outstanding: ids(parse.outstanding),
      }),
    ).toEqual({ items: ["unit-orders-cart", "unit-billing-tax"], source: "parse" });
  });

  it("without outstanding units, tests/orders.test.ts implicates the orders domain only", () => {
    expect(ids(attributeFailure([...merged, ...outstanding], fixture.output).units)).toEqual([
      "unit-orders-cart",
      "unit-billing-tax",
      "unit-orders-checkout",
      "unit-orders-history",
    ]);
  });

  it("tests/billing/tax.test.ts implicates src/billing/tax.ts first, the billing domain only when no file is named like it", () => {
    const taxOnly = [
      " \u276f tests/billing/tax.test.ts (2 tests | 2 failed) 23ms",
      "   \u00d7 checkout tax > charges no sales tax in OR 3ms",
      " FAIL  tests/billing/tax.test.ts > checkout tax > charges no sales tax in OR",
      "AssertionError: expected +0 to be 9000 // Object.is equality",
      " \u276f tests/billing/tax.test.ts:21:35",
    ].join("\n");
    expect(ids(attributeFailure(merged, taxOnly).units)).toEqual(["unit-billing-tax"]);
    const withoutTax = merged.filter((u) => u.unitId !== "unit-billing-tax");
    expect(ids(attributeFailure(withoutTax, taxOnly).units)).toEqual([
      "unit-billing-payments",
      "unit-billing-refunds",
      "unit-billing-invoices",
    ]);
  });

  it("a describe name with no file path still maps, by its head word first (checkout tax is about tax)", () => {
    const describeOnly = [
      "   \u00d7 checkout tax > taxes a $10.00 order shipped to CA at 72 cents 18ms",
      "     \u2192 expected +0 to be 1000 // Object.is equality",
    ].join("\n");
    const parse = attributeFailure(merged, describeOnly, outstanding);
    expect(parse.attributed).toBe(true);
    expect(ids(parse.units)).toEqual(["unit-billing-tax"]);
    expect(ids(parse.outstanding)).toEqual([]);
    expect(ids(attributeFailure(merged, "   \u00d7 orders > removes a product from the cart 2ms", outstanding).units)).toEqual(["unit-orders-cart"]);
    // jest's bullet shape.
    expect(ids(attributeFailure(merged, "  \u25cf orders \u203a removes a product from the cart").units)).toEqual(["unit-orders-cart"]);
  });

  it("a colocated test maps to the module beside it", () => {
    expect(ids(attributeFailure(merged, " FAIL  src/orders/cart.test.ts > cart > adds a line").units)).toEqual(["unit-orders-cart"]);
  });

  it("passing test lines name nothing, and output mapping to no item still yields all", () => {
    expect(attributeFailure(merged, " \u2713 tests/orders.test.ts (2 tests) 5ms\n \u2713 orders > adds a line\nAssertionError: boom")).toEqual({
      units: merged,
      attributed: false,
      outstanding: [],
    });
    const unknown = " \u276f tests/shipping.test.ts (1 test | 1 failed)\n   \u00d7 shipping > quotes a rate\n \u276f tests/shipping.test.ts:4:2";
    expect(attributeFailure(merged, unknown, outstanding)).toEqual({ units: merged, attributed: false, outstanding: [] });
  });

  it("a direct file or name match still wins over the failing tests", () => {
    const direct = `${fixture.output}\nsrc/catalog/search.ts(3,1): error TS2304: Cannot find name 'x'.`;
    expect(ids(attributeFailure(merged, direct, outstanding).units)).toEqual(["unit-catalog-search"]);
  });

  it("a location inside node_modules is never a unit's code", () => {
    const units = [{ unitId: "u-src", paths: ["src/**"] }];
    expect(attributeFailure(units, "    at run (/tmp/x/node_modules/vitest/src/runner.ts:9:1)").attributed).toBe(false);
  });

  it("failingRepoFiles points at the source files the failing tests exercise when nothing else resolves", () => {
    const repo = [
      "src/orders/cart.ts",
      "src/orders/history.ts",
      "src/billing/tax.ts",
      "src/billing/invoices.ts",
      "src/catalog/products.ts",
      "tests/orders.test.ts",
      "tests/billing/tax.test.ts",
    ];
    expect(failingRepoFiles(fixture.output, repo)).toEqual(["src/billing/tax.ts", "src/orders/cart.ts", "src/orders/history.ts"]);
  });
});

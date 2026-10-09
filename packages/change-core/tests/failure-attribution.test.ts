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

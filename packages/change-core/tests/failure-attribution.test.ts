/**
 * The implicated set and its label: one combination of the parse and an
 * advisory pick, shared by the local integrator and the integration Workflow.
 */
import { describe, expect, it } from "vitest";

import { attributeFailure, combineAttribution } from "../src/index.ts";

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

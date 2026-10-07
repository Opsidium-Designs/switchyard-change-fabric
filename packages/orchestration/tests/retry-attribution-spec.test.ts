/**
 * Offline unit tests for retry attribution against the REAL node --test SPEC
 * reporter output (the default reporter when the gate runs piped/non-TTY, which
 * is how the live run captures the gate evidence).
 *
 * The change-level ladder re-fans the IMPLICATED units on a verify-fail. The
 * attribution parses the failing resource names out of the gate output and maps
 * them to the owning units, so a retry re-fans ONLY the failing modules. These
 * tests feed the exact SPEC-reporter shapes the real service-api gate emits
 * (`✖ users: ...` top-level lines and the indented
 * `AssertionError [ERR_ASSERTION]: users must ...` detail) and assert the re-fan
 * narrows to the named unit, with an honest fallback to all when nothing is
 * attributable. They run with no Worker, no network, and no live inference.
 */

import { describe, expect, it } from "vitest";

import { selectImplicatedUnits, type GatedUnitInput } from "../src/run-live.ts";

/** A gated unit that owns `src/resources/<name>.js`, like the service-api app. */
function resourceUnit(name: string): GatedUnitInput {
  return {
    unitId: name,
    objective: `validate ${name}`,
    paths: [`src/resources/${name}.js`],
    authRemote: `https://example.invalid/${name}.git`,
    gateCommand: ["npm", "run", "gate"],
    requiredExports: [],
  };
}

const UNITS: readonly GatedUnitInput[] = [
  resourceUnit("users"),
  resourceUnit("orders"),
  resourceUnit("products"),
  resourceUnit("auth"),
  resourceUnit("search"),
  resourceUnit("notifications"),
];

/**
 * A faithful slice of the real `node --test gate/gate.test.mjs` SPEC-reporter
 * output when ONLY the `users` resource still fails (a partial fix): the two
 * failing `users` assertions carry the `✖` glyph and the indented AssertionError
 * detail names `users`, while every other resource passes with the `✔` glyph.
 * Captured verbatim from the real gate shape so the parser is tested against
 * ground truth, not a synthetic TAP stand-in.
 */
const SPEC_ONLY_USERS_FAILS = [
  "✖ users: unauthenticated request is rejected (401/403) (41.258127ms)",
  "✖ users: authenticated but invalid input is rejected with 400 (1.576472ms)",
  "✔ users: authenticated, valid request still succeeds (1.057449ms)",
  "✔ orders: unauthenticated request is rejected (401/403) (2.083304ms)",
  "✔ orders: authenticated but invalid input is rejected with 400 (1.037478ms)",
  "✔ orders: authenticated, valid request still succeeds (0.753799ms)",
  "✔ products: unauthenticated request is rejected (401/403) (0.867282ms)",
  "✔ products: authenticated, valid request still succeeds (0.745745ms)",
  "✔ auth: unauthenticated request is rejected (401/403) (1.204451ms)",
  "✔ auth: authenticated, valid request still succeeds (0.424207ms)",
  "✔ search: unauthenticated request is rejected (401/403) (0.650585ms)",
  "✔ search: authenticated, valid request still succeeds (0.320999ms)",
  "✔ notifications: unauthenticated request is rejected (401/403) (0.601711ms)",
  "✔ notifications: authenticated, valid request still succeeds (0.405824ms)",
  "ℹ tests 20",
  "ℹ pass 18",
  "ℹ fail 2",
  "",
  "✖ failing tests:",
  "",
  "test at gate/gate.test.mjs:92:3",
  "✖ users: unauthenticated request is rejected (401/403) (41.258127ms)",
  "  AssertionError [ERR_ASSERTION]: users must reject an unauthenticated request via requireAuth, got 201",
  "      at TestContext.<anonymous> (file:///abs/examples/apps/service-api/gate/gate.test.mjs:94:12)",
  "    generatedMessage: false,",
  "    code: 'ERR_ASSERTION',",
  "",
  "test at gate/gate.test.mjs:100:3",
  "✖ users: authenticated but invalid input is rejected with 400 (1.576472ms)",
  "  AssertionError [ERR_ASSERTION]: users must reject invalid input with 400, got 201",
].join("\n");

describe("retry attribution against the real node --test SPEC reporter output", () => {
  it("maps the SPEC-named failing resource to ONLY its owning unit (not all units)", () => {
    const implicated = selectImplicatedUnits(UNITS, SPEC_ONLY_USERS_FAILS);
    expect(implicated.map((u) => u.unitId)).toEqual(["users"]);
    // The passing resources (named on ✔ lines) are NOT re-fanned.
    for (const other of ["orders", "products", "auth", "search", "notifications"]) {
      expect(implicated.some((u) => u.unitId === other)).toBe(false);
    }
  });

  it("attributes two failing resources to exactly their two units", () => {
    // A partial fix where users AND search still fail: both carry a ✖ line and a
    // named AssertionError, everything else passes.
    const evidence = [
      "✖ users: unauthenticated request is rejected (401/403) (3ms)",
      "✔ orders: unauthenticated request is rejected (401/403) (1ms)",
      "✖ search: authenticated but invalid input is rejected with 400 (1ms)",
      "✔ products: authenticated, valid request still succeeds (1ms)",
      "",
      "✖ failing tests:",
      "  AssertionError [ERR_ASSERTION]: users must reject an unauthenticated request via requireAuth, got 201",
      "  AssertionError [ERR_ASSERTION]: search must reject invalid input with 400, got 200",
    ].join("\n");
    const implicated = selectImplicatedUnits(UNITS, evidence);
    expect(implicated.map((u) => u.unitId).sort()).toEqual(["search", "users"]);
  });

  it("falls back to re-fanning ALL units when nothing is attributable", () => {
    // Output that names no resource and no owned source file (only the gate file,
    // which no unit owns): attribution extracts nothing, so the honest fallback
    // re-fans every gated unit rather than silently skipping.
    const evidence = [
      "node --test gate/gate.test.mjs",
      "ℹ tests 20",
      "ℹ fail 12",
      "the gate crashed before reporting per-resource results",
    ].join("\n");
    const implicated = selectImplicatedUnits(UNITS, evidence);
    expect(implicated.map((u) => u.unitId)).toEqual(UNITS.map((u) => u.unitId));
  });

  it("does not misattribute a PASSING resource whose ✔ line also carries its name", () => {
    // Every resource passes: no ✖ line and no AssertionError, so no name is
    // extracted; with nothing attributable the change did not fail here, but the
    // parser must not pull a name off a ✔ line. Prove extraction is empty by the
    // fallback returning all (the only honest answer when nothing is named).
    const allPass = [
      "✔ users: unauthenticated request is rejected (401/403) (1ms)",
      "✔ orders: authenticated, valid request still succeeds (1ms)",
    ].join("\n");
    const implicated = selectImplicatedUnits(UNITS, allPass);
    expect(implicated.map((u) => u.unitId)).toEqual(UNITS.map((u) => u.unitId));
  });
});

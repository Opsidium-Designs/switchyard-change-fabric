/**
 * The offline lead's triage of workers' proposed items: generic rules only
 * (scope overlap, near-identical objective, no scope), never a named file or app.
 */
import { describe, expect, it } from "vitest";

import { duplicateOf } from "../src/board-policy.ts";

const existing = [
  { item: "u-users-validate-auth", objective: "Add input validation to the users resource handlers", scopeHint: ["src/users/**"] },
  { item: "u-notifications-validate", objective: "Add input validation to the notifications resource", scopeHint: ["src/notifications/**", "tests/notifications.test.ts"] },
];

describe("duplicateOf (the offline lead's proposal triage)", () => {
  it("a proposal whose scope lies inside an existing item's scope duplicates it", () => {
    expect(
      duplicateOf({ objective: "Add input validation and error responses for the notifications resource", scopeHint: ["src/notifications/handler.ts"] }, existing),
    ).toMatchObject({ item: "u-notifications-validate" });
  });

  it("a proposal that restates an existing objective duplicates it, whatever its scope", () => {
    expect(duplicateOf({ objective: "add input validation to the users resource handlers", scopeHint: ["lib/other.ts"] }, existing)).toMatchObject({
      item: "u-users-validate-auth",
    });
  });

  it("new work (a new scope, a different objective) is not a duplicate", () => {
    expect(duplicateOf({ objective: "Document the API error format", scopeHint: ["docs/errors.md"] }, existing)).toBeUndefined();
  });

  it("a proposal reaching beyond every existing scope is not a duplicate", () => {
    expect(duplicateOf({ objective: "Share one validator across resources", scopeHint: ["src/users/**", "src/shared/validate.ts"] }, existing)).toBeUndefined();
  });

  it("a proposal with no scope can never be claimed, so it is not taken", () => {
    expect(duplicateOf({ objective: "Something new", scopeHint: [] }, existing)).toEqual({ why: expect.stringMatching(/no scope/) });
  });
});

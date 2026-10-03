import { describe, it, expect } from "vitest";

import { makeAuditEvent, isAuditAction } from "../../src/audit/events.js";

describe("audit events", () => {
  it("recognizes valid actions", () => {
    expect(isAuditAction("create")).toBe(true);
    expect(isAuditAction("read")).toBe(true);
    expect(isAuditAction("nope")).toBe(false);
  });

  it("builds a normalized event with the given id and timestamp", () => {
    const event = makeAuditEvent(
      { orgId: "o", actor: "alice", action: "update", resource: "r/1" },
      7,
      123,
    );
    expect(event).toEqual({
      id: 7,
      orgId: "o",
      actor: "alice",
      action: "update",
      resource: "r/1",
      timestamp: 123,
    });
  });

  it("rejects empty required fields", () => {
    expect(() =>
      makeAuditEvent({ orgId: "", actor: "a", action: "read", resource: "r" }, 1),
    ).toThrow(/orgId/);
    expect(() =>
      makeAuditEvent({ orgId: "o", actor: "", action: "read", resource: "r" }, 1),
    ).toThrow(/actor/);
    expect(() =>
      makeAuditEvent({ orgId: "o", actor: "a", action: "read", resource: "" }, 1),
    ).toThrow(/resource/);
  });

  it("rejects unknown actions", () => {
    expect(() =>
      makeAuditEvent(
        // @ts-expect-error deliberately invalid action for the validation test
        { orgId: "o", actor: "a", action: "launch", resource: "r" },
        1,
      ),
    ).toThrow(/unknown audit action/);
  });
});

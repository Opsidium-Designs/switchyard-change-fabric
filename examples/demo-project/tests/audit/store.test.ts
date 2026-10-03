import { describe, it, expect } from "vitest";

import { AuditStore } from "../../src/audit/store.js";

describe("AuditStore", () => {
  it("assigns monotonic ids and tracks size", () => {
    const store = new AuditStore();
    const a = store.record({ orgId: "o", actor: "alice", action: "create", resource: "r/1" });
    const b = store.record({ orgId: "o", actor: "bob", action: "read", resource: "r/1" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(store.size).toBe(2);
  });

  it("returns events newest first", () => {
    const store = new AuditStore();
    store.record({ orgId: "o", actor: "alice", action: "create", resource: "r/1" }, 100);
    store.record({ orgId: "o", actor: "bob", action: "read", resource: "r/1" }, 200);
    const [first, second] = store.query();
    expect(first.timestamp).toBe(200);
    expect(second.timestamp).toBe(100);
  });

  it("filters by orgId, actor, and action", () => {
    const store = new AuditStore();
    store.record({ orgId: "o1", actor: "alice", action: "create", resource: "r/1" });
    store.record({ orgId: "o2", actor: "alice", action: "read", resource: "r/2" });
    store.record({ orgId: "o1", actor: "bob", action: "delete", resource: "r/3" });

    expect(store.query({ orgId: "o1" })).toHaveLength(2);
    expect(store.query({ actor: "alice" })).toHaveLength(2);
    expect(store.query({ action: "delete" })).toHaveLength(1);
    expect(store.query({ orgId: "o1", actor: "bob" })).toHaveLength(1);
  });

  it("fetches by id and reports misses", () => {
    const store = new AuditStore();
    const e = store.record({ orgId: "o", actor: "alice", action: "create", resource: "r/1" });
    expect(store.get(e.id)).toEqual(e);
    expect(store.get(999)).toBeUndefined();
  });
});

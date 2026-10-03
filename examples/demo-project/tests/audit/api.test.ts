import { describe, it, expect } from "vitest";

import { createService } from "../../src/index.js";

function seeded() {
  const svc = createService();
  svc.store.record({ orgId: "o1", actor: "alice", action: "create", resource: "r/1" });
  svc.store.record({ orgId: "o1", actor: "bob", action: "read", resource: "r/2" });
  return svc;
}

describe("audit API", () => {
  it("lists events with a count", () => {
    const { api } = seeded();
    const res = api.handle({ path: "/audit/events" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 2 });
  });

  it("filters by query parameters", () => {
    const { api } = seeded();
    const res = api.handle({ path: "/audit/events", query: { actor: "alice" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
  });

  it("rejects an invalid action filter", () => {
    const { api } = seeded();
    const res = api.handle({ path: "/audit/events", query: { action: "boom" } });
    expect(res.status).toBe(400);
  });

  it("fetches a single event and 404s on a miss", () => {
    const { api } = seeded();
    expect(api.handle({ path: "/audit/events/1" }).status).toBe(200);
    expect(api.handle({ path: "/audit/events/999" }).status).toBe(404);
  });

  it("404s on an unknown path", () => {
    const { api } = seeded();
    expect(api.handle({ path: "/nope" }).status).toBe(404);
  });
});

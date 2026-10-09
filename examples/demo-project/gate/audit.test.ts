// demo-project acceptance gate: deterministic, offline, no network.
//
// The goal is organization-level audit logging with a read API. This suite
// encodes that goal as observable behavior of the PUBLIC surface only: the
// service from `createService()` (its `store.record(...)` and its framework-free
// `api.handle({ path, query })`), and the response shapes the existing read API
// already uses (`{ events, count }` for a list, the event itself for a single
// read, `{ error }` with a 4xx otherwise). It does not care how the routes,
// store, or scoping are implemented.
//
// The organization-level read API (see the README "Acceptance contract"):
//   GET /orgs/:orgId/audit/events        that org's events only, newest first,
//                                        with optional actor/action filters
//   GET /orgs/:orgId/audit/events/:id    one event, only if it belongs to orgId
//
// On the baseline the org-scoped routes do not exist (they 404), so this suite
// FAILS; it PASSES once an organization's audit log is readable through them
// without ever disclosing another organization's events.

import { describe, it, expect } from "vitest";

import { createService } from "../src/index.js";

interface ListBody {
  events: { id: number; orgId: string; actor: string; action: string; resource: string; timestamp: number }[];
  count: number;
}

/** Two organizations with interleaved activity at fixed, distinct times. */
function seeded() {
  const svc = createService();
  const acme1 = svc.store.record({ orgId: "acme", actor: "alice", action: "create", resource: "project/1" }, 1_000);
  const globex1 = svc.store.record({ orgId: "globex", actor: "gina", action: "create", resource: "project/9" }, 2_000);
  const acme2 = svc.store.record({ orgId: "acme", actor: "bob", action: "read", resource: "project/1" }, 3_000);
  const acme3 = svc.store.record({ orgId: "acme", actor: "alice", action: "delete", resource: "project/2" }, 4_000);
  const globex2 = svc.store.record({ orgId: "globex", actor: "alice", action: "update", resource: "project/9" }, 5_000);
  return { ...svc, acme: [acme1, acme2, acme3], globex: [globex1, globex2] };
}

function list(res: { status: number; body: unknown }): ListBody {
  expect(res.status).toBe(200);
  const body = res.body as ListBody;
  expect(Array.isArray(body.events)).toBe(true);
  expect(body.count).toBe(body.events.length);
  return body;
}

describe("organization audit log: list", () => {
  it("returns only that organization's events, newest first", () => {
    const { api, acme } = seeded();
    const body = list(api.handle({ path: "/orgs/acme/audit/events" }));
    expect(body.count).toBe(3);
    expect(body.events.every((e) => e.orgId === "acme")).toBe(true);
    expect(body.events.map((e) => e.id)).toEqual([acme[2]!.id, acme[1]!.id, acme[0]!.id]);
  });

  it("keeps each organization's log separate", () => {
    const { api, globex } = seeded();
    const body = list(api.handle({ path: "/orgs/globex/audit/events" }));
    expect(body.events.map((e) => e.id)).toEqual([globex[1]!.id, globex[0]!.id]);
  });

  it("returns the recorded event fields unchanged", () => {
    const { api, acme } = seeded();
    const body = list(api.handle({ path: "/orgs/acme/audit/events" }));
    expect(body.events[0]).toEqual(acme[2]);
  });

  it("filters by actor and action within the organization", () => {
    const { api } = seeded();
    const byActor = list(api.handle({ path: "/orgs/acme/audit/events", query: { actor: "alice" } }));
    expect(byActor.count).toBe(2);
    expect(byActor.events.every((e) => e.orgId === "acme" && e.actor === "alice")).toBe(true);

    const byAction = list(api.handle({ path: "/orgs/acme/audit/events", query: { action: "delete" } }));
    expect(byAction.count).toBe(1);
    expect(byAction.events[0]).toMatchObject({ orgId: "acme", action: "delete" });

    const both = list(api.handle({ path: "/orgs/globex/audit/events", query: { actor: "alice", action: "update" } }));
    expect(both.count).toBe(1);
    expect(both.events[0]).toMatchObject({ orgId: "globex", actor: "alice", action: "update" });
  });

  it("rejects an invalid action filter with 400", () => {
    const { api } = seeded();
    const res = api.handle({ path: "/orgs/acme/audit/events", query: { action: "launch" } });
    expect(res.status).toBe(400);
    expect(typeof (res.body as { error?: unknown }).error).toBe("string");
  });

  it("cannot be widened to another organization through the query string", () => {
    const { api } = seeded();
    const body = list(api.handle({ path: "/orgs/acme/audit/events", query: { orgId: "globex" } }));
    expect(body.count).toBe(3);
    expect(body.events.every((e) => e.orgId === "acme")).toBe(true);
  });

  it("returns an empty log for an organization with no activity", () => {
    const { api } = seeded();
    const body = list(api.handle({ path: "/orgs/initech/audit/events" }));
    expect(body).toEqual({ events: [], count: 0 });
  });

  it("reflects events recorded after the service was created", () => {
    const { api, store } = seeded();
    const later = store.record({ orgId: "acme", actor: "carol", action: "update", resource: "project/3" }, 9_000);
    const body = list(api.handle({ path: "/orgs/acme/audit/events" }));
    expect(body.count).toBe(4);
    expect(body.events[0]).toEqual(later);
  });
});

describe("organization audit log: single event", () => {
  it("returns an event that belongs to the organization", () => {
    const { api, acme } = seeded();
    const res = api.handle({ path: `/orgs/acme/audit/events/${acme[1]!.id}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(acme[1]);
  });

  it("404s on another organization's event (no cross-organization disclosure)", () => {
    const { api, globex } = seeded();
    const res = api.handle({ path: `/orgs/acme/audit/events/${globex[0]!.id}` });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("globex");
  });

  it("404s on an event that does not exist", () => {
    const { api } = seeded();
    expect(api.handle({ path: "/orgs/acme/audit/events/999" }).status).toBe(404);
  });
});

describe("organization audit log: malformed requests", () => {
  it("does not serve a log for an empty organization id", () => {
    const { api } = seeded();
    const res = api.handle({ path: "/orgs//audit/events" });
    expect([400, 404]).toContain(res.status);
  });
});

describe("existing read API is preserved", () => {
  it("still lists and fetches through the original routes", () => {
    const { api, acme } = seeded();
    expect(list(api.handle({ path: "/audit/events", query: { orgId: "acme" } })).count).toBe(3);
    expect(api.handle({ path: `/audit/events/${acme[0]!.id}` }).status).toBe(200);
  });
});

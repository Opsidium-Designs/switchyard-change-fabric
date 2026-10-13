// Acceptance: parking (citations, permits, meters, appeals).
//
// Fines: expired-meter 4500, street-cleaning 6500, no-permit 7700, hydrant
// 25000. Meters m-100 (75 cents per 15 minutes, 2 hours max) and m-200 (50
// cents, 4 hours max). Ana has autopay with a 15000 cent cap; Ben has none.

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, call, create, expectPaginationBounds, freshApp, type App } from "./harness.ts";

function cite(app: App, residentId: string, violation: string, issuedAt = "2026-03-02T12:00:00-06:00") {
  return create(CLERK, app, "/parking/citations", { residentId, plate: "abc123", violation, issuedAt });
}

describe("parking/citations", () => {
  it("issues a fine due 30 days after the issue date", async () => {
    const citation = await cite(freshApp(), "res-ana", "no-permit");
    expect(citation).toMatchObject({ fineCents: 7700, issuedOn: "2026-03-02", dueOn: "2026-04-01", status: "open" });
  });

  it("dates a late-evening citation on the city's calendar", async () => {
    const citation = await cite(freshApp(), "res-ana", "expired-meter", "2026-03-06T23:30:00-06:00");
    expect(citation.issuedOn).toBe("2026-03-06");
    expect(citation.dueOn).toBe("2026-04-05");
  });

  it("refuses a resident issuing a citation", async () => {
    const reply = await as(ANA, freshApp(), "POST", "/parking/citations", { residentId: "res-ben", plate: "XYZ1", violation: "hydrant", issuedAt: "2026-03-02T12:00:00-06:00" });
    expect(reply.status).toBe(403);
  });

  it("rejects an unknown violation", async () => {
    const reply = await as(CLERK, freshApp(), "POST", "/parking/citations", { residentId: "res-ana", plate: "XYZ1", violation: "parking-on-the-moon", issuedAt: "2026-03-02T12:00:00-06:00" });
    expect(reply.status).toBe(400);
  });

  it("shows a resident only their own citations", async () => {
    const app = freshApp();
    await cite(app, "res-ana", "no-permit");
    await cite(app, "res-ben", "hydrant");
    const page = await as(BEN, app, "GET", "/parking/citations");
    expect(page.body.items.map((c: any) => c.residentId)).toEqual(["res-ben"]);
  });

  it("splits a fine into a payment plan that adds up exactly", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "street-cleaning");
    const reply = await as(ANA, app, "POST", `/parking/citations/${citation.id}/plan`, { installments: 3 });
    expect(reply.body.plan).toEqual([2167, 2167, 2166]);
  });

  it("pays a fine through autopay", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "expired-meter");
    const reply = await as(ANA, app, "POST", `/parking/citations/${citation.id}/pay`);
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe("paid");
  });

  it("refuses an autopay payment above the cap", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "hydrant");
    expect((await as(ANA, app, "POST", `/parking/citations/${citation.id}/pay`)).status).toBe(409);
    expect((await as(ANA, app, "GET", `/parking/citations/${citation.id}`)).body.status).toBe("open");
  });

  it("refuses autopay for a resident who is not enrolled", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ben", "expired-meter");
    expect((await as(BEN, app, "POST", `/parking/citations/${citation.id}/pay`)).status).toBe(409);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parking/citations", CLERK);
  });
});

describe("parking/permits", () => {
  it("prices a permit by zone and months", async () => {
    const permit = await create(ANA, freshApp(), "/parking/permits", { zone: "B", plate: "KLM 404", months: 6 });
    expect(permit.priceCents).toBe(10800);
  });

  it("stores the plate in canonical form", async () => {
    const permit = await create(ANA, freshApp(), "/parking/permits", { zone: "A", plate: "abc-123", months: 1 });
    expect(permit.plate).toBe("ABC123");
  });

  it("refuses a second permit for the same plate and zone, however it is written", async () => {
    const app = freshApp();
    await create(ANA, app, "/parking/permits", { zone: "A", plate: "ABC123", months: 1 });
    expect((await as(BEN, app, "POST", "/parking/permits", { zone: "A", plate: "abc 123", months: 2 })).status).toBe(409);
  });

  it("rejects months outside 1 to 12", async () => {
    const app = freshApp();
    for (const months of [0, 13, 2.5]) {
      expect((await as(ANA, app, "POST", "/parking/permits", { zone: "C", plate: "ZZ9", months })).status).toBe(400);
    }
  });

  it("rejects an unknown zone and needs a signed-in caller", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/parking/permits", { zone: "Q", plate: "ZZ9", months: 1 })).status).toBe(400);
    expect((await call(app, "POST", "/parking/permits", { body: { zone: "A", plate: "ZZ9", months: 1 } })).status).toBe(401);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parking/permits", ANA);
  });
});

describe("parking/meters", () => {
  it("quotes whole 15-minute blocks publicly", async () => {
    const reply = await call(freshApp(), "GET", "/parking/meters/m-100/quote?minutes=30");
    expect(reply.status).toBe(200);
    expect(reply.body.costCents).toBe(150);
  });

  it("bills a started block as a whole block", async () => {
    const app = freshApp();
    expect((await call(app, "GET", "/parking/meters/m-100/quote?minutes=31")).body.costCents).toBe(225);
    expect((await call(app, "GET", "/parking/meters/m-200/quote?minutes=1")).body.costCents).toBe(50);
  });

  it("refuses a stay past the meter's maximum", async () => {
    const app = freshApp();
    expect((await call(app, "GET", "/parking/meters/m-100/quote?minutes=121")).status).toBe(400);
    expect((await as(ANA, app, "POST", "/parking/meters/m-100/sessions", { minutes: 180, plate: "ABC123" })).status).toBe(400);
  });

  it("starts a paid session for a signed-in caller", async () => {
    const app = freshApp();
    expect((await call(app, "POST", "/parking/meters/m-200/sessions", { body: { minutes: 60, plate: "ABC123" } })).status).toBe(401);
    const session = await create(ANA, app, "/parking/meters/m-200/sessions", { minutes: 60, plate: "ABC123" });
    expect(session.costCents).toBe(200);
  });

  it("does not know an unknown meter", async () => {
    expect((await call(freshApp(), "GET", "/parking/meters/m-999/quote?minutes=15")).status).toBe(404);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parking/meters");
  });
});

describe("parking/appeals", () => {
  it("files an appeal within the window", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "no-permit");
    const appeal = await create(ANA, app, "/parking/appeals", { citationId: citation.id, reason: "The sign was covered", filedOn: "2026-03-10" });
    expect(appeal.status).toBe("pending");
  });

  it("accepts an appeal on the 21st business day", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "no-permit");
    expect((await as(ANA, app, "POST", "/parking/appeals", { citationId: citation.id, reason: "late but in time", filedOn: "2026-03-31" })).status).toBe(201);
  });

  it("refuses an appeal after the window", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "no-permit");
    expect((await as(ANA, app, "POST", "/parking/appeals", { citationId: citation.id, reason: "too late", filedOn: "2026-04-01" })).status).toBe(422);
  });

  it("hides another resident's citation", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "no-permit");
    expect((await as(BEN, app, "POST", "/parking/appeals", { citationId: citation.id, reason: "not mine", filedOn: "2026-03-03" })).status).toBe(404);
  });

  it("refuses a second appeal on the same citation", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "no-permit");
    await create(ANA, app, "/parking/appeals", { citationId: citation.id, reason: "first", filedOn: "2026-03-03" });
    expect((await as(ANA, app, "POST", "/parking/appeals", { citationId: citation.id, reason: "again", filedOn: "2026-03-04" })).status).toBe(409);
  });

  it("dismisses the citation when staff grant the appeal, and residents cannot decide", async () => {
    const app = freshApp();
    const citation = await cite(app, "res-ana", "no-permit");
    const appeal = await create(ANA, app, "/parking/appeals", { citationId: citation.id, reason: "covered sign", filedOn: "2026-03-03" });
    expect((await as(ANA, app, "POST", `/parking/appeals/${appeal.id}/decision`, { decision: "granted" })).status).toBe(403);
    expect((await as(CLERK, app, "POST", `/parking/appeals/${appeal.id}/decision`, { decision: "granted" })).status).toBe(200);
    expect((await as(ANA, app, "GET", `/parking/citations/${citation.id}`)).body.status).toBe("dismissed");
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parking/appeals", ANA);
  });
});

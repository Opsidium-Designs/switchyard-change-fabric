// Acceptance: utilities (water, usage, outages, autopay).
//
// Accounts: acct-ana (Ana), acct-ben and acct-elm (Ben). Ana's seeded meter
// readings (city time): Mar 1 08:00 120 gal, Mar 1 22:30 80, Mar 2 07:00 150,
// Mar 2 23:15 60, Mar 3 12:00 90. Ana has autopay with a 15000 cent cap.

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, call, create, expectPaginationBounds, freshApp } from "./harness.ts";

describe("utilities/water", () => {
  it("bills the first 50 units at 120 cents", async () => {
    const bill = await create(CLERK, freshApp(), "/utilities/water", { accountId: "acct-ana", period: "2026-03", gallons: 5000 });
    expect(bill).toMatchObject({ units: 50, amountCents: 6000 });
  });

  it("bills a started 100 gallons as a whole unit", async () => {
    const app = freshApp();
    expect((await create(CLERK, app, "/utilities/water", { accountId: "acct-ana", period: "2026-03", gallons: 5001 })).amountCents).toBe(6185);
    expect((await create(CLERK, app, "/utilities/water", { accountId: "acct-ana", period: "2026-04", gallons: 12345 })).amountCents).toBe(6000 + 74 * 185);
  });

  it("splits a building bill by usage with every cent accounted for", async () => {
    const app = freshApp();
    const bill = await create(CLERK, app, "/utilities/water", { accountId: "acct-elm", period: "2026-03", gallons: 10000 });
    expect(bill.amountCents).toBe(15250);
    const split = await as(CLERK, app, "POST", `/utilities/water/${bill.id}/split`, { unitGallons: [1000, 1000, 1000] });
    expect(split.body.split).toEqual([5084, 5083, 5083]);
  });

  it("only staff create or split bills", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/utilities/water", { accountId: "acct-ana", period: "2026-03", gallons: 10 })).status).toBe(403);
  });

  it("rejects an unknown account or bad gallons", async () => {
    const app = freshApp();
    expect((await as(CLERK, app, "POST", "/utilities/water", { accountId: "acct-nope", period: "2026-03", gallons: 10 })).status).toBe(400);
    expect((await as(CLERK, app, "POST", "/utilities/water", { accountId: "acct-ana", period: "2026-03", gallons: -4 })).status).toBe(400);
  });

  it("shows a resident only bills on their own accounts", async () => {
    const app = freshApp();
    await create(CLERK, app, "/utilities/water", { accountId: "acct-ana", period: "2026-03", gallons: 100 });
    await create(CLERK, app, "/utilities/water", { accountId: "acct-ben", period: "2026-03", gallons: 100 });
    const page = await as(ANA, app, "GET", "/utilities/water");
    expect(page.body.items.map((b: any) => b.accountId)).toEqual(["acct-ana"]);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/utilities/water", ANA);
  });
});

describe("utilities/usage", () => {
  it("totals an account's readings", async () => {
    const reply = await as(ANA, freshApp(), "GET", "/utilities/usage/acct-ana");
    expect(reply.status).toBe(200);
    expect(reply.body.totalGallons).toBe(500);
  });

  it("groups readings by the city's calendar day", async () => {
    const reply = await as(ANA, freshApp(), "GET", "/utilities/usage/acct-ana");
    expect(reply.body.items).toEqual([
      { date: "2026-03-01", gallons: 200 },
      { date: "2026-03-02", gallons: 210 },
      { date: "2026-03-03", gallons: 90 },
    ]);
  });

  it("filters by city dates, both ends included", async () => {
    const reply = await as(ANA, freshApp(), "GET", "/utilities/usage/acct-ana?from=2026-03-02&to=2026-03-02");
    expect(reply.body.items).toEqual([{ date: "2026-03-02", gallons: 210 }]);
    expect(reply.body.totalGallons).toBe(210);
  });

  it("hides another resident's account", async () => {
    expect((await as(BEN, freshApp(), "GET", "/utilities/usage/acct-ana")).status).toBe(404);
  });

  it("lets staff read any account and rejects a bad date", async () => {
    const app = freshApp();
    expect((await as(CLERK, app, "GET", "/utilities/usage/acct-ben")).body.totalGallons).toBe(300);
    expect((await as(CLERK, app, "GET", "/utilities/usage/acct-ben?from=March")).status).toBe(400);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/utilities/usage/acct-ana", ANA);
  });
});

describe("utilities/outages", () => {
  it("opens an outage on the first report", async () => {
    const reply = await as(ANA, freshApp(), "POST", "/utilities/outages", { area: "north", reportedAt: "2026-03-02T06:00:00-06:00" });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ area: "north", status: "open", reports: 1 });
  });

  it("joins a second report to the open outage in that area", async () => {
    const app = freshApp();
    const first = await create(ANA, app, "/utilities/outages", { area: "north", reportedAt: "2026-03-02T06:00:00-06:00" });
    const second = await as(BEN, app, "POST", "/utilities/outages", { area: "north", reportedAt: "2026-03-02T06:05:00-06:00" });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.id);
    expect(second.body.reports).toBe(2);
    expect((await call(app, "GET", "/utilities/outages")).body.total).toBe(1);
  });

  it("opens a new outage once the old one is restored", async () => {
    const app = freshApp();
    const first = await create(ANA, app, "/utilities/outages", { area: "east", reportedAt: "2026-03-02T06:00:00-06:00" });
    await as(CLERK, app, "POST", `/utilities/outages/${first.id}/restore`, { restoredAt: "2026-03-02T09:00:00-06:00" });
    expect((await as(ANA, app, "POST", "/utilities/outages", { area: "east", reportedAt: "2026-03-03T06:00:00-06:00" })).status).toBe(201);
  });

  it("refuses a resident marking an outage restored", async () => {
    const app = freshApp();
    const outage = await create(ANA, app, "/utilities/outages", { area: "west", reportedAt: "2026-03-02T06:00:00-06:00" });
    expect((await as(ANA, app, "POST", `/utilities/outages/${outage.id}/restore`, { restoredAt: "2026-03-02T07:00:00-06:00" })).status).toBe(403);
  });

  it("rejects an unknown area and lists publicly", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/utilities/outages", { area: "atlantis", reportedAt: "2026-03-02T06:00:00-06:00" })).status).toBe(400);
    expect((await call(app, "GET", "/utilities/outages")).status).toBe(200);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/utilities/outages");
  });
});

describe("utilities/autopay", () => {
  it("reads a resident's enrollment", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "GET", "/utilities/autopay")).body).toMatchObject({ enrolled: true, capCents: 15000 });
    expect((await as(BEN, app, "GET", "/utilities/autopay")).body).toMatchObject({ enrolled: false, capCents: null });
  });

  it("enrolls with a positive whole-cent cap", async () => {
    const reply = await as(BEN, freshApp(), "PUT", "/utilities/autopay", { capCents: 5000 });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ enrolled: true, capCents: 5000 });
  });

  it("rejects a cap that is not a positive whole number of cents", async () => {
    const app = freshApp();
    for (const capCents of [0, -500, 12.5, "5000", null]) {
      expect((await as(BEN, app, "PUT", "/utilities/autopay", { capCents })).status).toBe(400);
    }
    expect((await as(BEN, app, "GET", "/utilities/autopay")).body.enrolled).toBe(false);
  });

  it("records a charge in the ledger", async () => {
    const app = freshApp();
    const citation = await create(CLERK, app, "/parking/citations", { residentId: "res-ana", plate: "ABC123", violation: "expired-meter", issuedAt: "2026-03-02T12:00:00-06:00" });
    await as(ANA, app, "POST", `/parking/citations/${citation.id}/pay`);
    const ledger = await as(ANA, app, "GET", "/utilities/autopay/ledger");
    expect(ledger.body.items.map((e: any) => e.amountCents)).toEqual([4500]);
  });

  it("declines a charge above the cap", async () => {
    const app = freshApp();
    await as(ANA, app, "PUT", "/utilities/autopay", { capCents: 4000 });
    const citation = await create(CLERK, app, "/parking/citations", { residentId: "res-ana", plate: "ABC123", violation: "expired-meter", issuedAt: "2026-03-02T12:00:00-06:00" });
    expect((await as(ANA, app, "POST", `/parking/citations/${citation.id}/pay`)).status).toBe(409);
    expect((await as(ANA, app, "GET", "/utilities/autopay/ledger")).body.items).toEqual([]);
  });

  it("stops charging after unenrolling", async () => {
    const app = freshApp();
    await as(ANA, app, "DELETE", "/utilities/autopay");
    const citation = await create(CLERK, app, "/parking/citations", { residentId: "res-ana", plate: "ABC123", violation: "expired-meter", issuedAt: "2026-03-02T12:00:00-06:00" });
    expect((await as(ANA, app, "POST", `/parking/citations/${citation.id}/pay`)).status).toBe(409);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/utilities/autopay/ledger", ANA);
  });
});

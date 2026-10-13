// Acceptance: permits (applications, inspections, fees, renewals).
//
// Seed: prm-1 Ana's approved deck (valuation 1850000, expires 2026-06-30),
// prm-2 Ben's submitted fence, prm-3 Ana's approved roof (valuation 1234567,
// expires 2026-09-15). Ana has autopay with a 15000 cent cap; Ben has none.

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, call, create, expectPaginationBounds, freshApp } from "./harness.ts";

const application = { kind: "fence", address: "14 Birch Ln", valuationCents: 600_000 };

describe("permits/applications", () => {
  it("needs a signed-in caller", async () => {
    expect((await call(freshApp(), "POST", "/permits/applications", { body: application })).status).toBe(401);
    expect((await call(freshApp(), "GET", "/permits/applications")).status).toBe(401);
  });

  it("files an application as submitted for its owner", async () => {
    const created = await create(ANA, freshApp(), "/permits/applications", application);
    expect(created).toMatchObject({ ownerId: "res-ana", kind: "fence", status: "submitted", valuationCents: 600_000 });
  });

  it("rejects a bad kind, a blank address, or a non-cents valuation", async () => {
    const app = freshApp();
    for (const body of [{ ...application, kind: "pool" }, { ...application, address: "  " }, { ...application, valuationCents: 12.5 }]) {
      expect((await as(ANA, app, "POST", "/permits/applications", body)).status).toBe(400);
    }
  });

  it("lists only a resident's own applications", async () => {
    const page = await as(ANA, freshApp(), "GET", "/permits/applications");
    expect(page.status).toBe(200);
    expect(page.body.items.map((p: any) => p.id).sort()).toEqual(["prm-1", "prm-3"]);
  });

  it("lists every application for staff", async () => {
    const page = await as(CLERK, freshApp(), "GET", "/permits/applications");
    expect(page.body.total).toBe(3);
  });

  it("hides another resident's application", async () => {
    expect((await as(BEN, freshApp(), "GET", "/permits/applications/prm-1")).status).toBe(404);
  });

  it("refuses a resident deciding a permit", async () => {
    const app = freshApp();
    const created = await create(ANA, app, "/permits/applications", application);
    const reply = await as(ANA, app, "POST", `/permits/applications/${created.id}/decision`, { decision: "approved", decidedOn: "2026-03-02" });
    expect(reply.status).toBe(403);
    expect((await as(ANA, app, "GET", `/permits/applications/${created.id}`)).body.status).toBe("submitted");
  });

  it("lets a clerk approve, valid for twelve months", async () => {
    const app = freshApp();
    const reply = await as(CLERK, app, "POST", "/permits/applications/prm-2/decision", { decision: "approved", decidedOn: "2026-03-02" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: "approved", expiresOn: "2027-03-02" });
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/permits/applications", ANA);
  });
});

describe("permits/inspections", () => {
  it("schedules the third business day after a Monday request", async () => {
    const created = await create(ANA, freshApp(), "/permits/inspections", { permitId: "prm-1", requestedOn: "2026-03-02" });
    expect(created.scheduledFor).toBe("2026-03-05");
  });

  it("schedules across a weekend", async () => {
    const created = await create(ANA, freshApp(), "/permits/inspections", { permitId: "prm-1", requestedOn: "2026-03-05" });
    expect(created.scheduledFor).toBe("2026-03-10");
  });

  it("schedules across the July 3 holiday", async () => {
    const created = await create(ANA, freshApp(), "/permits/inspections", { permitId: "prm-3", requestedOn: "2026-07-01" });
    expect(created.scheduledFor).toBe("2026-07-07");
  });

  it("refuses a permit that is not approved", async () => {
    const reply = await as(CLERK, freshApp(), "POST", "/permits/inspections", { permitId: "prm-2", requestedOn: "2026-03-02" });
    expect(reply.status).toBe(409);
  });

  it("rejects a requestedOn that is not a date", async () => {
    const app = freshApp();
    for (const requestedOn of ["next tuesday", "2026-02-30", undefined]) {
      expect((await as(ANA, app, "POST", "/permits/inspections", { permitId: "prm-1", requestedOn })).status).toBe(400);
    }
  });

  it("hides another resident's permit", async () => {
    expect((await as(BEN, freshApp(), "POST", "/permits/inspections", { permitId: "prm-1", requestedOn: "2026-03-02" })).status).toBe(404);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/permits/inspections", ANA);
  });
});

describe("permits/fees", () => {
  it("assesses base fee plus 0.5% of valuation", async () => {
    const fee = await create(ANA, freshApp(), "/permits/fees", { permitId: "prm-1", installments: 1 });
    expect(fee.feeCents).toBe(9000 + 9250);
    expect(fee.installments).toEqual([18250]);
  });

  it("rounds the valuation share to the nearest cent, half up", async () => {
    // 1234567 x 0.5% = 6172.835 cents
    const fee = await create(ANA, freshApp(), "/permits/fees", { permitId: "prm-3", installments: 1 });
    expect(fee.feeCents).toBe(7500 + 6173);
  });

  it("splits the fee into installments that add up exactly", async () => {
    const app = freshApp();
    const permit = await create(ANA, app, "/permits/applications", { kind: "addition", address: "14 Birch Ln", valuationCents: 1_000_000 });
    await as(CLERK, app, "POST", `/permits/applications/${permit.id}/decision`, { decision: "approved", decidedOn: "2026-03-02" });
    const fee = await create(ANA, app, "/permits/fees", { permitId: permit.id, installments: 3 });
    expect(fee.feeCents).toBe(30000);
    const odd = await create(ANA, app, "/permits/fees", { permitId: "prm-1", installments: 4 });
    expect(odd.installments).toEqual([4563, 4563, 4562, 4562]);
    expect(odd.installments.reduce((a: number, b: number) => a + b, 0)).toBe(odd.feeCents);
  });

  it("refuses installments outside 1 to 4", async () => {
    const app = freshApp();
    for (const installments of [0, 5, 1.5]) {
      expect((await as(ANA, app, "POST", "/permits/fees", { permitId: "prm-1", installments })).status).toBe(400);
    }
  });

  it("pays a fee within the autopay cap", async () => {
    const app = freshApp();
    const permit = await create(ANA, app, "/permits/applications", application);
    await as(CLERK, app, "POST", `/permits/applications/${permit.id}/decision`, { decision: "approved", decidedOn: "2026-03-02" });
    const fee = await create(ANA, app, "/permits/fees", { permitId: permit.id });
    expect(fee.feeCents).toBe(8000);
    expect((await as(ANA, app, "POST", `/permits/fees/${fee.id}/autopay`)).status).toBe(201);
    const ledger = await as(ANA, app, "GET", "/utilities/autopay/ledger");
    expect(ledger.body.items.map((e: any) => e.amountCents)).toEqual([8000]);
  });

  it("declines an autopay charge above the cap and records nothing", async () => {
    const app = freshApp();
    const fee = await create(ANA, app, "/permits/fees", { permitId: "prm-1" });
    expect((await as(ANA, app, "POST", `/permits/fees/${fee.id}/autopay`)).status).toBe(409);
    expect((await as(ANA, app, "GET", `/permits/fees/${fee.id}`)).body.paid).toBe(false);
    expect((await as(ANA, app, "GET", "/utilities/autopay/ledger")).body.items).toEqual([]);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/permits/fees", ANA);
  });
});

describe("permits/renewals", () => {
  it("opens the renewal window exactly 60 days before expiry", async () => {
    const reply = await as(ANA, freshApp(), "POST", "/permits/renewals", { permitId: "prm-1", renewOn: "2026-05-01" });
    expect(reply.status).toBe(201);
  });

  it("refuses a renewal 61 days early", async () => {
    expect((await as(ANA, freshApp(), "POST", "/permits/renewals", { permitId: "prm-1", renewOn: "2026-04-30" })).status).toBe(422);
  });

  it("charges no late fee on the expiry date itself", async () => {
    const renewal = await create(ANA, freshApp(), "/permits/renewals", { permitId: "prm-1", renewOn: "2026-06-30" });
    expect(renewal).toMatchObject({ feeCents: 4500, lateFeeCents: 0, totalCents: 4500 });
  });

  it("adds a 10% late fee the day after expiry", async () => {
    const renewal = await create(ANA, freshApp(), "/permits/renewals", { permitId: "prm-1", renewOn: "2026-07-01" });
    expect(renewal).toMatchObject({ feeCents: 4500, lateFeeCents: 450, totalCents: 4950, newExpiresOn: "2027-06-30" });
  });

  it("refuses to renew a permit that was never approved", async () => {
    expect((await as(CLERK, freshApp(), "POST", "/permits/renewals", { permitId: "prm-2", renewOn: "2026-05-01" })).status).toBe(409);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/permits/renewals", ANA);
  });
});

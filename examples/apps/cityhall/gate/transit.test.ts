// Acceptance: transit (passes, fares, eligibility, refunds).
//
// Reduced fares need an approved eligibility, granted for the resident's OWN
// senior or disability certificate valid on the application date: Ana's
// senior certificate is valid through 2026-12-31, Ben's disability certificate
// through 2026-03-31, and Ben's residency certificate never qualifies.

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, call, create, expectPaginationBounds, freshApp, type App } from "./harness.ts";

async function approveAna(app: App): Promise<void> {
  const record = await create(ANA, app, "/transit/eligibility", { certificateId: "cert-ana-senior", appliedOn: "2026-03-02" });
  expect(record.status).toBe("approved");
}

describe("transit/passes", () => {
  it("sells an adult pass", async () => {
    const pass = await create(BEN, freshApp(), "/transit/passes", { kind: "adult", month: "2026-04" });
    expect(pass.priceCents).toBe(9000);
  });

  it("sells a reduced pass with an approved eligibility", async () => {
    const app = freshApp();
    await approveAna(app);
    expect((await create(ANA, app, "/transit/passes", { kind: "reduced", month: "2026-04" })).priceCents).toBe(4500);
  });

  it("refuses a reduced pass without any eligibility", async () => {
    expect((await as(ANA, freshApp(), "POST", "/transit/passes", { kind: "reduced", month: "2026-04" })).status).toBe(409);
  });

  it("refuses a reduced pass when the eligibility was denied", async () => {
    const app = freshApp();
    const record = await create(BEN, app, "/transit/eligibility", { certificateId: "cert-ben-residency", appliedOn: "2026-03-02" });
    expect(record.status).toBe("denied");
    expect((await as(BEN, app, "POST", "/transit/passes", { kind: "reduced", month: "2026-04" })).status).toBe(409);
  });

  it("rejects a month that is not YYYY-MM", async () => {
    const app = freshApp();
    for (const month of ["2026-13", "April", "2026-4", undefined]) {
      expect((await as(BEN, app, "POST", "/transit/passes", { kind: "adult", month })).status).toBe(400);
    }
  });

  it("needs a signed-in caller", async () => {
    expect((await call(freshApp(), "POST", "/transit/passes", { body: { kind: "adult", month: "2026-04" } })).status).toBe(401);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/transit/passes", ANA);
  });
});

describe("transit/fares", () => {
  const quote = (query: string) => call(freshApp(), "GET", `/transit/fares/quote?${query}`);

  it("quotes adult fares by zone", async () => {
    expect((await quote("zones=1&rider=adult")).body.fareCents).toBe(225);
    expect((await quote("zones=4&rider=adult")).body.fareCents).toBe(375);
  });

  it("halves a one-zone reduced fare, rounding half up", async () => {
    expect((await quote("zones=1&rider=reduced")).body.fareCents).toBe(113);
  });

  it("halves a three-zone reduced fare, rounding half up", async () => {
    expect((await quote("zones=3&rider=reduced")).body.fareCents).toBe(163);
  });

  it("charges youth a flat fare", async () => {
    expect((await quote("zones=4&rider=youth")).body.fareCents).toBe(100);
  });

  it("rejects zones outside 1 to 4", async () => {
    for (const zones of ["0", "5", "2.5", "two"]) {
      expect((await quote(`zones=${zones}&rider=adult`)).status).toBe(400);
    }
  });

  it("rejects an unknown rider", async () => {
    expect((await quote("zones=1&rider=pilot")).status).toBe(400);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/transit/fares");
  });
});

describe("transit/eligibility", () => {
  it("approves a resident's valid senior certificate", async () => {
    await approveAna(freshApp());
  });

  it("approves on the certificate's last valid day", async () => {
    const record = await create(BEN, freshApp(), "/transit/eligibility", { certificateId: "cert-ben-disability", appliedOn: "2026-03-31" });
    expect(record.status).toBe("approved");
  });

  it("denies an expired certificate", async () => {
    const record = await create(BEN, freshApp(), "/transit/eligibility", { certificateId: "cert-ben-disability", appliedOn: "2026-04-01" });
    expect(record.status).toBe("denied");
  });

  it("does not accept another resident's certificate", async () => {
    expect((await as(BEN, freshApp(), "POST", "/transit/eligibility", { certificateId: "cert-ana-senior", appliedOn: "2026-03-02" })).status).toBe(404);
  });

  it("rejects a bad appliedOn and lists for staff", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/transit/eligibility", { certificateId: "cert-ana-senior", appliedOn: "soon" })).status).toBe(400);
    await approveAna(app);
    expect((await as(CLERK, app, "GET", "/transit/eligibility")).body.total).toBe(1);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/transit/eligibility", ANA);
  });
});

describe("transit/refunds", () => {
  it("refunds the unused days of a pass", async () => {
    const app = freshApp();
    await approveAna(app);
    const pass = await create(ANA, app, "/transit/passes", { kind: "reduced", month: "2026-04" });
    const refund = await create(ANA, app, "/transit/refunds", { passId: pass.id, cancelOn: "2026-04-11" });
    expect(refund).toMatchObject({ unusedDays: 20, refundCents: 3000 });
  });

  it("prorates without losing the resident's cent", async () => {
    // 9000 x 21/31 = 6096.77 cents: the unused share is 6097, the used share 2903
    const app = freshApp();
    const pass = await create(BEN, app, "/transit/passes", { kind: "adult", month: "2026-03" });
    const refund = await create(BEN, app, "/transit/refunds", { passId: pass.id, cancelOn: "2026-03-11" });
    expect(refund.refundCents).toBe(6097);
  });

  it("refuses to refund another resident's pass", async () => {
    const app = freshApp();
    const pass = await create(BEN, app, "/transit/passes", { kind: "adult", month: "2026-03" });
    expect((await as(ANA, app, "POST", "/transit/refunds", { passId: pass.id, cancelOn: "2026-03-11" })).status).toBe(404);
  });

  it("refunds a pass once, inside its month", async () => {
    const app = freshApp();
    const pass = await create(BEN, app, "/transit/passes", { kind: "adult", month: "2026-03" });
    expect((await as(BEN, app, "POST", "/transit/refunds", { passId: pass.id, cancelOn: "2026-04-02" })).status).toBe(422);
    await create(BEN, app, "/transit/refunds", { passId: pass.id, cancelOn: "2026-03-20" });
    expect((await as(BEN, app, "POST", "/transit/refunds", { passId: pass.id, cancelOn: "2026-03-21" })).status).toBe(409);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/transit/refunds", ANA);
  });
});

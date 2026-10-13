// Acceptance: housing (inspections, complaints, rents, relocation).
//
// Units: unit-1 and unit-2 (landlord Ben), unit-3 (landlord Ana). unit-1's
// rent history: 120000 from 2024-01-01, 126000 from 2025-01-01.

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, call, create, expectPaginationBounds, freshApp } from "./harness.ts";

describe("housing/inspections", () => {
  it("records a clean inspection free and with no follow-up", async () => {
    const inspection = await create(CLERK, freshApp(), "/housing/inspections", { unitId: "unit-1", inspectedOn: "2026-03-02", violations: 0 });
    expect(inspection).toMatchObject({ feeCents: 0, reinspectBy: null });
  });

  it("charges for violations and sets a 30-day re-inspection", async () => {
    const inspection = await create(CLERK, freshApp(), "/housing/inspections", { unitId: "unit-1", inspectedOn: "2026-03-02", violations: 5 });
    expect(inspection).toMatchObject({ feeCents: 12500, reinspectBy: "2026-04-01" });
  });

  it("refuses a resident recording an inspection", async () => {
    expect((await as(BEN, freshApp(), "POST", "/housing/inspections", { unitId: "unit-1", inspectedOn: "2026-03-02", violations: 0 })).status).toBe(403);
  });

  it("rejects violations that are not a whole number 0 to 50", async () => {
    const app = freshApp();
    for (const violations of [-1, 2.5, 51, "three"]) {
      expect((await as(CLERK, app, "POST", "/housing/inspections", { unitId: "unit-1", inspectedOn: "2026-03-02", violations })).status).toBe(400);
    }
  });

  it("shows a landlord only their own units' inspections", async () => {
    const app = freshApp();
    await create(CLERK, app, "/housing/inspections", { unitId: "unit-1", inspectedOn: "2026-03-02", violations: 1 });
    await create(CLERK, app, "/housing/inspections", { unitId: "unit-3", inspectedOn: "2026-03-02", violations: 1 });
    expect((await as(ANA, app, "GET", "/housing/inspections")).body.items.map((i: any) => i.unitId)).toEqual(["unit-3"]);
    expect((await as(CLERK, app, "POST", "/housing/inspections", { unitId: "unit-9", inspectedOn: "2026-03-02", violations: 0 })).status).toBe(404);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/housing/inspections", CLERK);
  });
});

describe("housing/complaints", () => {
  it("gives a mold complaint 5 business days", async () => {
    const complaint = await create(ANA, freshApp(), "/housing/complaints", { unitId: "unit-1", category: "mold", filedOn: "2026-03-02" });
    expect(complaint.repairBy).toBe("2026-03-09");
  });

  it("treats no heat as a 1 business day emergency", async () => {
    const complaint = await create(ANA, freshApp(), "/housing/complaints", { unitId: "unit-1", category: "heat", filedOn: "2026-03-06" });
    expect(complaint.repairBy).toBe("2026-03-09");
  });

  it("does not count the July 3 holiday for an emergency", async () => {
    const complaint = await create(ANA, freshApp(), "/housing/complaints", { unitId: "unit-1", category: "water", filedOn: "2026-07-02" });
    expect(complaint.repairBy).toBe("2026-07-06");
  });

  it("rejects an unknown category", async () => {
    expect((await as(ANA, freshApp(), "POST", "/housing/complaints", { unitId: "unit-1", category: "noise", filedOn: "2026-03-02" })).status).toBe(400);
  });

  it("lists only a resident's own complaints and needs a signed-in caller", async () => {
    const app = freshApp();
    await create(ANA, app, "/housing/complaints", { unitId: "unit-1", category: "pests", filedOn: "2026-03-02" });
    expect((await as(BEN, app, "GET", "/housing/complaints")).body.total).toBe(0);
    expect((await call(app, "GET", "/housing/complaints")).status).toBe(401);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/housing/complaints", ANA);
  });
});

describe("housing/rents", () => {
  it("registers a unit's first rent without a cap", async () => {
    expect((await as(ANA, freshApp(), "POST", "/housing/rents", { unitId: "unit-3", rentCents: 180_000, effectiveOn: "2026-01-01" })).status).toBe(201);
  });

  it("allows a 5% raise over the most recent registered rent", async () => {
    expect((await as(BEN, freshApp(), "POST", "/housing/rents", { unitId: "unit-1", rentCents: 132_300, effectiveOn: "2026-01-01" })).status).toBe(201);
  });

  it("refuses a raise above 5%", async () => {
    expect((await as(BEN, freshApp(), "POST", "/housing/rents", { unitId: "unit-1", rentCents: 132_301, effectiveOn: "2026-01-01" })).status).toBe(422);
  });

  it("refuses a registration older than the latest", async () => {
    expect((await as(BEN, freshApp(), "POST", "/housing/rents", { unitId: "unit-1", rentCents: 126_000, effectiveOn: "2024-06-01" })).status).toBe(409);
  });

  it("rejects a rent that is not a positive whole number of cents", async () => {
    const app = freshApp();
    for (const rentCents of [0, -100, 1200.5, "130000"]) {
      expect((await as(BEN, app, "POST", "/housing/rents", { unitId: "unit-2", rentCents, effectiveOn: "2026-01-01" })).status).toBe(400);
    }
  });

  it("lets only the unit's landlord or staff register", async () => {
    expect((await as(ANA, freshApp(), "POST", "/housing/rents", { unitId: "unit-1", rentCents: 126_000, effectiveOn: "2026-01-01" })).status).toBe(403);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/housing/rents", BEN);
  });
});

describe("housing/relocation", () => {
  const members = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Member ${i + 1}`, weight: 1 }));

  it("splits aid equally with every cent accounted for", async () => {
    const grant = await create(CLERK, freshApp(), "/housing/relocation", { unitId: "unit-1", totalAidCents: 100_000, members: members(3) });
    expect(grant.shares.map((s: any) => s.shareCents)).toEqual([33334, 33333, 33333]);
  });

  it("never loses a cent across a large household", async () => {
    const grant = await create(CLERK, freshApp(), "/housing/relocation", { unitId: "unit-2", totalAidCents: 1000, members: members(7) });
    expect(grant.shares.map((s: any) => s.shareCents)).toEqual([143, 143, 143, 143, 143, 143, 142]);
  });

  it("splits by weight", async () => {
    const grant = await create(CLERK, freshApp(), "/housing/relocation", {
      unitId: "unit-1",
      totalAidCents: 100_001,
      members: [{ name: "Adult", weight: 2 }, { name: "Child A", weight: 1 }, { name: "Child B", weight: 1 }],
    });
    expect(grant.shares.map((s: any) => s.shareCents)).toEqual([50001, 25000, 25000]);
  });

  it("is for staff only", async () => {
    const app = freshApp();
    expect((await as(BEN, app, "POST", "/housing/relocation", { unitId: "unit-1", totalAidCents: 1000, members: members(2) })).status).toBe(403);
    expect((await as(BEN, app, "GET", "/housing/relocation")).status).toBe(403);
  });

  it("rejects bad members or a non-cents total", async () => {
    const app = freshApp();
    expect((await as(CLERK, app, "POST", "/housing/relocation", { unitId: "unit-1", totalAidCents: 1000, members: [] })).status).toBe(400);
    expect((await as(CLERK, app, "POST", "/housing/relocation", { unitId: "unit-1", totalAidCents: 1000, members: [{ name: "A", weight: 11 }] })).status).toBe(400);
    expect((await as(CLERK, app, "POST", "/housing/relocation", { unitId: "unit-1", totalAidCents: 10.5, members: members(2) })).status).toBe(400);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/housing/relocation", CLERK);
  });
});

// Acceptance: licensing (business, pets, events, vendors).

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, call, create, expectPaginationBounds, freshApp } from "./harness.ts";

describe("licensing/business", () => {
  it("licenses a business at its category fee", async () => {
    const license = await create(ANA, freshApp(), "/licensing/business", { name: "Birch Lane Bakery", category: "food" });
    expect(license).toMatchObject({ feeCents: 15000, status: "pending", ownerId: "res-ana" });
  });

  it("rejects a missing or blank name", async () => {
    const app = freshApp();
    for (const name of ["", "   ", undefined, 42]) {
      expect((await as(ANA, app, "POST", "/licensing/business", { name, category: "retail" })).status).toBe(400);
    }
  });

  it("refuses a duplicate name ignoring case and spaces", async () => {
    const app = freshApp();
    await create(ANA, app, "/licensing/business", { name: "Harbor Hardware", category: "retail" });
    expect((await as(BEN, app, "POST", "/licensing/business", { name: "  harbor HARDWARE ", category: "retail" })).status).toBe(409);
  });

  it("lets staff approve and refuses a resident approving", async () => {
    const app = freshApp();
    const license = await create(ANA, app, "/licensing/business", { name: "Pier Repairs", category: "contractor" });
    expect((await as(ANA, app, "POST", `/licensing/business/${license.id}/approve`)).status).toBe(403);
    const approved = await as(CLERK, app, "POST", `/licensing/business/${license.id}/approve`);
    expect(approved.body).toMatchObject({ status: "approved", licenseNumber: "BL-0001" });
  });

  it("rejects an unknown category and needs a signed-in caller", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/licensing/business", { name: "X", category: "casino" })).status).toBe(400);
    expect((await call(app, "GET", "/licensing/business")).status).toBe(401);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/licensing/business", ANA);
  });
});

describe("licensing/pets", () => {
  it("charges the full fee for an unaltered dog", async () => {
    expect((await create(ANA, freshApp(), "/licensing/pets", { name: "Rex", species: "dog", spayed: false })).feeCents).toBe(2025);
  });

  it("halves a spayed dog's fee, rounding half up", async () => {
    expect((await create(ANA, freshApp(), "/licensing/pets", { name: "Rex", species: "dog", spayed: true })).feeCents).toBe(1013);
  });

  it("halves a spayed cat's fee, rounding half up", async () => {
    expect((await create(ANA, freshApp(), "/licensing/pets", { name: "Miso", species: "cat", spayed: true })).feeCents).toBe(763);
  });

  it("licenses only dogs and cats", async () => {
    const app = freshApp();
    for (const species of ["dragon", "", undefined]) {
      expect((await as(ANA, app, "POST", "/licensing/pets", { name: "Smaug", species, spayed: false })).status).toBe(400);
    }
  });

  it("needs spayed as a boolean and lists only your own pets", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/licensing/pets", { name: "Rex", species: "dog", spayed: "yes" })).status).toBe(400);
    await create(ANA, app, "/licensing/pets", { name: "Rex", species: "dog", spayed: false });
    expect((await as(BEN, app, "GET", "/licensing/pets")).body.total).toBe(0);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/licensing/pets", ANA);
  });
});

describe("licensing/events", () => {
  const event = { name: "Spring street fair", attendance: 300 };

  it("approves a small event filed well ahead", async () => {
    const permit = await create(ANA, freshApp(), "/licensing/events", { ...event, eventDate: "2026-04-18", filedOn: "2026-03-02" });
    expect(permit.status).toBe("approved");
  });

  it("accepts a filing exactly 10 business days ahead", async () => {
    expect((await as(ANA, freshApp(), "POST", "/licensing/events", { ...event, eventDate: "2026-03-16", filedOn: "2026-03-02" })).status).toBe(201);
  });

  it("refuses a filing 9 business days ahead", async () => {
    expect((await as(ANA, freshApp(), "POST", "/licensing/events", { ...event, eventDate: "2026-03-13", filedOn: "2026-03-02" })).status).toBe(422);
  });

  it("does not count Labor Day toward the notice", async () => {
    expect((await as(ANA, freshApp(), "POST", "/licensing/events", { ...event, eventDate: "2026-09-14", filedOn: "2026-08-31" })).status).toBe(422);
    expect((await as(ANA, freshApp(), "POST", "/licensing/events", { ...event, eventDate: "2026-09-15", filedOn: "2026-08-31" })).status).toBe(201);
  });

  it("rejects attendance outside 1 to 20000", async () => {
    const app = freshApp();
    for (const attendance of [0, -5, 2.5, 20001, "lots"]) {
      expect((await as(ANA, app, "POST", "/licensing/events", { ...event, attendance, eventDate: "2026-06-01", filedOn: "2026-03-02" })).status).toBe(400);
    }
  });

  it("sends a large event to review", async () => {
    const permit = await create(ANA, freshApp(), "/licensing/events", { name: "Marathon", attendance: 501, eventDate: "2026-06-01", filedOn: "2026-03-02" });
    expect(permit.status).toBe("review");
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/licensing/events", ANA);
  });
});

describe("licensing/vendors", () => {
  const vendor = { businessName: "Taco Cart", zone: "market" };

  it("charges 3000 cents a month", async () => {
    expect((await create(ANA, freshApp(), "/licensing/vendors", { ...vendor, startsOn: "2026-04-01", months: 3 })).feeCents).toBe(9000);
  });

  it("expires the day before the same date months later", async () => {
    const app = freshApp();
    expect((await create(ANA, app, "/licensing/vendors", { ...vendor, startsOn: "2026-04-01", months: 3 })).expiresOn).toBe("2026-06-30");
    expect((await create(ANA, app, "/licensing/vendors", { ...vendor, startsOn: "2026-03-15", months: 12 })).expiresOn).toBe("2027-03-14");
  });

  it("refuses an anonymous application", async () => {
    const app = freshApp();
    expect((await call(app, "POST", "/licensing/vendors", { body: { ...vendor, startsOn: "2026-04-01", months: 1 } })).status).toBe(401);
    expect((await as(CLERK, app, "GET", "/licensing/vendors")).body.total).toBe(0);
  });

  it("rejects an unknown zone or months outside 1 to 12", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/licensing/vendors", { ...vendor, zone: "beach", startsOn: "2026-04-01", months: 1 })).status).toBe(400);
    expect((await as(ANA, app, "POST", "/licensing/vendors", { ...vendor, startsOn: "2026-04-01", months: 13 })).status).toBe(400);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/licensing/vendors", ANA);
  });
});

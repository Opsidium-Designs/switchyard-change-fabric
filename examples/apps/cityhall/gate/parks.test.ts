// Acceptance: parks (reservations, programs, waitlists, waivers).
//
// Seed programs: prog-swim (ages 6 to 12, capacity 2), prog-tennis (13 to 17),
// prog-yoga (18 to 99). Hourly rates: pavilion-a 3500, pavilion-b 2750,
// field-1 4000, gym 6000.

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, call, create, expectPaginationBounds, freshApp } from "./harness.ts";

describe("parks/reservations", () => {
  it("prices a reservation by the hour", async () => {
    const reservation = await create(ANA, freshApp(), "/parks/reservations", { facility: "gym", date: "2026-05-02", hours: 3 });
    expect(reservation.costCents).toBe(18000);
    expect(reservation.shares).toEqual([{ renter: "res-ana", shareCents: 18000 }]);
  });

  it("splits the cost between co-renters with every cent accounted for", async () => {
    const reservation = await create(ANA, freshApp(), "/parks/reservations", { facility: "pavilion-b", date: "2026-05-02", hours: 2, coRenters: ["Jo", "Sam"] });
    expect(reservation.costCents).toBe(5500);
    expect(reservation.shares.map((s: any) => s.shareCents)).toEqual([1834, 1833, 1833]);
  });

  it("refuses double-booking a facility on a day", async () => {
    const app = freshApp();
    await create(ANA, app, "/parks/reservations", { facility: "field-1", date: "2026-05-09", hours: 2 });
    expect((await as(BEN, app, "POST", "/parks/reservations", { facility: "field-1", date: "2026-05-09", hours: 1 })).status).toBe(409);
  });

  it("frees the day when a reservation is cancelled", async () => {
    const app = freshApp();
    const first = await create(ANA, app, "/parks/reservations", { facility: "field-1", date: "2026-05-09", hours: 2 });
    expect((await as(ANA, app, "DELETE", `/parks/reservations/${first.id}`)).status).toBe(200);
    expect((await as(BEN, app, "POST", "/parks/reservations", { facility: "field-1", date: "2026-05-09", hours: 1 })).status).toBe(201);
  });

  it("rejects bad hours, an unknown facility, or too many co-renters", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/parks/reservations", { facility: "gym", date: "2026-05-02", hours: 9 })).status).toBe(400);
    expect((await as(ANA, app, "POST", "/parks/reservations", { facility: "moon", date: "2026-05-02", hours: 1 })).status).toBe(400);
    expect((await as(ANA, app, "POST", "/parks/reservations", { facility: "gym", date: "2026-05-02", hours: 1, coRenters: ["a", "b", "c", "d", "e", "f"] })).status).toBe(400);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parks/reservations", ANA);
  });
});

describe("parks/programs", () => {
  const enroll = (app = freshApp(), age: number, program = "prog-swim") => as(ANA, app, "POST", `/parks/programs/${program}/enrollments`, { participantName: "Kid", age });

  it("lists programs publicly", async () => {
    const page = await call(freshApp(), "GET", "/parks/programs");
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(3);
  });

  it("enrolls a participant inside the age range", async () => {
    expect((await enroll(freshApp(), 8)).status).toBe(201);
  });

  it("takes the youngest age in the range", async () => {
    expect((await enroll(freshApp(), 6)).status).toBe(201);
  });

  it("takes the oldest age in the range", async () => {
    expect((await enroll(freshApp(), 12)).status).toBe(201);
  });

  it("refuses an age outside the range", async () => {
    expect((await enroll(freshApp(), 13)).status).toBe(422);
    expect((await enroll(freshApp(), 5)).status).toBe(422);
  });

  it("never enrolls past capacity", async () => {
    const app = freshApp();
    expect((await enroll(app, 8)).status).toBe(201);
    expect((await enroll(app, 9)).status).toBe(201);
    expect((await enroll(app, 10)).status).toBe(409);
  });

  it("lets staff create a program and residents not", async () => {
    const app = freshApp();
    const program = { name: "Chess club", minAge: 8, maxAge: 14, capacity: 12 };
    expect((await as(ANA, app, "POST", "/parks/programs", program)).status).toBe(403);
    expect((await as(CLERK, app, "POST", "/parks/programs", program)).status).toBe(201);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parks/programs");
  });
});

describe("parks/waitlists", () => {
  it("numbers positions in joining order", async () => {
    const app = freshApp();
    expect((await create(ANA, app, "/parks/waitlists", { programId: "prog-swim" })).position).toBe(1);
    expect((await create(BEN, app, "/parks/waitlists", { programId: "prog-swim" })).position).toBe(2);
  });

  it("refuses joining the same waitlist twice", async () => {
    const app = freshApp();
    await create(ANA, app, "/parks/waitlists", { programId: "prog-swim" });
    expect((await as(ANA, app, "POST", "/parks/waitlists", { programId: "prog-swim" })).status).toBe(409);
  });

  it("holds an offer through the 2nd business day after it", async () => {
    const app = freshApp();
    const entry = await create(ANA, app, "/parks/waitlists", { programId: "prog-swim" });
    const offer = await as(CLERK, app, "POST", `/parks/waitlists/${entry.id}/offer`, { offeredOn: "2026-03-06" });
    expect(offer.body).toMatchObject({ status: "offered", offerExpiresOn: "2026-03-10" });
  });

  it("holds an offer over the Thanksgiving holidays", async () => {
    const app = freshApp();
    const entry = await create(ANA, app, "/parks/waitlists", { programId: "prog-yoga" });
    const offer = await as(CLERK, app, "POST", `/parks/waitlists/${entry.id}/offer`, { offeredOn: "2026-11-25" });
    expect(offer.body.offerExpiresOn).toBe("2026-12-01");
  });

  it("lets only staff make offers, and needs a known program", async () => {
    const app = freshApp();
    const entry = await create(ANA, app, "/parks/waitlists", { programId: "prog-swim" });
    expect((await as(ANA, app, "POST", `/parks/waitlists/${entry.id}/offer`, { offeredOn: "2026-03-06" })).status).toBe(403);
    expect((await as(ANA, app, "POST", "/parks/waitlists", { programId: "prog-nope" })).status).toBe(404);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parks/waitlists", ANA);
  });
});

describe("parks/waivers", () => {
  it("waives 100% at exactly the income threshold", async () => {
    const waiver = await create(BEN, freshApp(), "/parks/waivers", { householdSize: 3, monthlyIncomeCents: 250_000 });
    expect(waiver.waiverPercent).toBe(100);
  });

  it("waives 50% up to 1.5 times the threshold and 0% above", async () => {
    const app = freshApp();
    expect((await create(BEN, app, "/parks/waivers", { householdSize: 1, monthlyIncomeCents: 225_000 })).waiverPercent).toBe(50);
    expect((await create(BEN, app, "/parks/waivers", { householdSize: 1, monthlyIncomeCents: 225_001 })).waiverPercent).toBe(0);
  });

  it("gives a reduced-fare holder at least 50%", async () => {
    const app = freshApp();
    await create(ANA, app, "/transit/eligibility", { certificateId: "cert-ana-senior", appliedOn: "2026-03-02" });
    expect((await create(ANA, app, "/parks/waivers", { householdSize: 1, monthlyIncomeCents: 900_000 })).waiverPercent).toBe(50);
  });

  it("does not lift a waiver for an expired certificate", async () => {
    const app = freshApp();
    await create(BEN, app, "/transit/eligibility", { certificateId: "cert-ben-disability", appliedOn: "2026-05-01" });
    expect((await create(BEN, app, "/parks/waivers", { householdSize: 1, monthlyIncomeCents: 900_000 })).waiverPercent).toBe(0);
  });

  it("refuses a resident approving a waiver", async () => {
    const app = freshApp();
    const waiver = await create(BEN, app, "/parks/waivers", { householdSize: 2, monthlyIncomeCents: 100_000 });
    expect((await as(BEN, app, "POST", `/parks/waivers/${waiver.id}/approve`)).status).toBe(403);
    expect((await as(CLERK, app, "POST", `/parks/waivers/${waiver.id}/approve`)).body.status).toBe("approved");
  });

  it("rejects a household size outside 1 to 12", async () => {
    const app = freshApp();
    for (const householdSize of [0, 13, 1.5]) {
      expect((await as(BEN, app, "POST", "/parks/waivers", { householdSize, monthlyIncomeCents: 1000 })).status).toBe(400);
    }
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/parks/waivers", ANA);
  });
});

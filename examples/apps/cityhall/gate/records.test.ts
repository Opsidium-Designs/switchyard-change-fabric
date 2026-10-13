// Acceptance: records (requests, redaction, retention, certificates).
//
// Seed certificates: cert-ana-senior (Ana, valid through 2026-12-31),
// cert-ben-disability (Ben, valid through 2026-03-31), cert-ben-residency.

import { describe, expect, it } from "vitest";

import { ANA, BEN, CLERK, as, create, expectPaginationBounds, freshApp } from "./harness.ts";

describe("records/requests", () => {
  it("is due the 10th business day after receipt", async () => {
    const request = await create(ANA, freshApp(), "/records/requests", { subject: "Council minutes 2025", receivedAt: "2026-03-02T10:00:00-06:00" });
    expect(request).toMatchObject({ receivedOn: "2026-03-02", dueOn: "2026-03-16" });
  });

  it("dates a late-evening request on the city's calendar", async () => {
    const request = await create(ANA, freshApp(), "/records/requests", { subject: "Budget", receivedAt: "2026-03-06T21:00:00-06:00" });
    expect(request.receivedOn).toBe("2026-03-06");
  });

  it("skips the Thanksgiving holidays", async () => {
    const request = await create(ANA, freshApp(), "/records/requests", { subject: "Snow plan", receivedAt: "2026-11-23T09:00:00-06:00" });
    expect(request.dueOn).toBe("2026-12-09");
  });

  it("lists only a resident's own requests", async () => {
    const app = freshApp();
    await create(ANA, app, "/records/requests", { subject: "Mine", receivedAt: "2026-03-02T10:00:00-06:00" });
    await create(BEN, app, "/records/requests", { subject: "His", receivedAt: "2026-03-02T10:00:00-06:00" });
    const page = await as(BEN, app, "GET", "/records/requests");
    expect(page.body.items.map((r: any) => r.subject)).toEqual(["His"]);
  });

  it("rejects a blank subject and lets only staff close", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "POST", "/records/requests", { subject: " ", receivedAt: "2026-03-02T10:00:00-06:00" })).status).toBe(400);
    const request = await create(ANA, app, "/records/requests", { subject: "Zoning map", receivedAt: "2026-03-02T10:00:00-06:00" });
    expect((await as(ANA, app, "POST", `/records/requests/${request.id}/close`)).status).toBe(403);
    expect((await as(CLERK, app, "POST", `/records/requests/${request.id}/close`)).body.status).toBe("closed");
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/records/requests", ANA);
  });
});

describe("records/redaction", () => {
  const redact = (text: string, token = CLERK) => as(token, freshApp(), "POST", "/records/redaction", { text });

  it("masks social security numbers", async () => {
    expect((await redact("SSN 123-45-6789 on file")).body.redacted).toBe("SSN [SSN] on file");
  });

  it("masks email addresses", async () => {
    expect((await redact("write to ana.ruiz@example.org today")).body.redacted).toBe("write to [EMAIL] today");
  });

  it("masks phone numbers in every common form", async () => {
    const reply = await redact("call (555) 123-4567 or 555-123-4567 or 555.123.4567");
    expect(reply.body.redacted).toBe("call [PHONE] or [PHONE] or [PHONE]");
  });

  it("counts each kind of personal data", async () => {
    const reply = await redact("123-45-6789, a@b.io, 555-987-6543");
    expect(reply.body.counts).toEqual({ ssn: 1, email: 1, phone: 1 });
  });

  it("is for staff only", async () => {
    expect((await redact("123-45-6789", ANA)).status).toBe(403);
  });

  it("needs a text of at most 10000 characters", async () => {
    expect((await redact("")).status).toBe(400);
    expect((await redact("x".repeat(10_001))).status).toBe(400);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/records/redaction", CLERK);
  });
});

describe("records/retention", () => {
  it("schedules destruction after the class's retention years", async () => {
    const reply = await as(CLERK, freshApp(), "GET", "/records/retention/schedule?recordClass=permits&createdOn=2019-05-20");
    expect(reply.body).toMatchObject({ years: 7, destroyAfter: "2026-05-20" });
  });

  it("clamps a leap-day record to the end of February", async () => {
    const reply = await as(CLERK, freshApp(), "GET", "/records/retention/schedule?recordClass=correspondence&createdOn=2024-02-29");
    expect(reply.body.destroyAfter).toBe("2026-02-28");
  });

  it("refuses destruction inside the retention period", async () => {
    const reply = await as(CLERK, freshApp(), "POST", "/records/retention/destructions", { recordId: "doc-1", recordClass: "licenses", createdOn: "2022-01-10", destroyOn: "2027-01-09" });
    expect(reply.status).toBe(422);
  });

  it("destroys a record whose period has ended", async () => {
    const reply = await as(CLERK, freshApp(), "POST", "/records/retention/destructions", { recordId: "doc-1", recordClass: "licenses", createdOn: "2020-01-10", destroyOn: "2026-03-02" });
    expect(reply.status).toBe(201);
  });

  it("never destroys a record under a legal hold", async () => {
    const app = freshApp();
    await create(CLERK, app, "/records/retention/holds", { recordId: "doc-9", reason: "pending lawsuit" });
    const reply = await as(CLERK, app, "POST", "/records/retention/destructions", { recordId: "doc-9", recordClass: "correspondence", createdOn: "2015-01-01", destroyOn: "2026-03-02" });
    expect(reply.status).toBe(409);
  });

  it("is for staff only and rejects an unknown class", async () => {
    const app = freshApp();
    expect((await as(ANA, app, "GET", "/records/retention/schedule?recordClass=permits&createdOn=2020-01-01")).status).toBe(403);
    expect((await as(CLERK, app, "GET", "/records/retention/schedule?recordClass=secrets&createdOn=2020-01-01")).status).toBe(400);
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/records/retention/holds", CLERK);
  });
});

describe("records/certificates", () => {
  it("prices certified copies", async () => {
    const order = await create(ANA, freshApp(), "/records/certificates/orders", { kind: "birth", copies: 3 });
    expect(order.feeCents).toBe(3300);
  });

  it("orders 1 to 10 copies only", async () => {
    const app = freshApp();
    for (const copies of [0, 11, 2.5, -1]) {
      expect((await as(ANA, app, "POST", "/records/certificates/orders", { kind: "birth", copies })).status).toBe(400);
    }
  });

  it("rejects an unknown kind", async () => {
    expect((await as(ANA, freshApp(), "POST", "/records/certificates/orders", { kind: "unicorn", copies: 1 })).status).toBe(400);
  });

  it("lists a resident's own certificates and hides others'", async () => {
    const app = freshApp();
    expect((await as(BEN, app, "GET", "/records/certificates")).body.items.map((c: any) => c.id).sort()).toEqual(["cert-ben-disability", "cert-ben-residency"]);
    expect((await as(BEN, app, "GET", "/records/certificates/cert-ana-senior")).status).toBe(404);
  });

  it("does not qualify an expired certificate for reduced fares", async () => {
    const reply = await as(BEN, freshApp(), "POST", "/transit/eligibility", { certificateId: "cert-ben-disability", appliedOn: "2026-04-15" });
    expect(reply.body.status).toBe("denied");
  });

  it("enforces the shared pagination bounds", async () => {
    await expectPaginationBounds("/records/certificates", ANA);
    await expectPaginationBounds("/records/certificates/orders", ANA);
  });
});

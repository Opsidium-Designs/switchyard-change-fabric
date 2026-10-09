// Acceptance: payments and refunds can never exceed what is owed or paid.
//
// A payment may not exceed the invoice's balance due, and the refunds of one
// payment may never add up to more than that payment. A refused payment or
// refund is rejected (400, 409, or 422) and records nothing. An invoice's
// paidCents is its payments minus their refunds, and balanceCents is its total
// minus paidCents.

import { describe, expect, it } from "vitest";

import { authed, buy, freshApp, REJECTED } from "./harness.ts";

async function invoiceOf(app: ReturnType<typeof freshApp>, id: string) {
  return (await authed(app, "GET", `/invoices/${id}`)).body;
}

describe("payments", () => {
  it("paying an invoice in parts brings its balance to zero", async () => {
    const app = freshApp();
    const order = await buy(app, [["p5", 2]], "CA");
    expect(order.totalCents).toBe(1073);
    expect((await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 1000 })).status).toBe(201);
    expect((await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 73 })).status).toBe(201);
    const invoice = await invoiceOf(app, order.invoiceId);
    expect(invoice.paidCents).toBe(1073);
    expect(invoice.balanceCents).toBe(0);
  });

  it("a payment above the balance due is refused and records nothing", async () => {
    const app = freshApp();
    const order = await buy(app, [["p5", 2]], "CA");
    expect(REJECTED).toContain((await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 1074 })).status);
    expect((await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 1073 })).status).toBe(201);
    expect(REJECTED).toContain((await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 1 })).status);
    const invoice = await invoiceOf(app, order.invoiceId);
    expect(invoice.paidCents).toBe(1073);
    expect(invoice.balanceCents).toBe(0);
    expect((await authed(app, "GET", "/payments")).body.total).toBe(1);
  });
});

describe("refunds", () => {
  it("refunds up to the paid amount succeed and reopen the balance", async () => {
    const app = freshApp();
    const order = await buy(app, [["p1", 1]], "CA");
    expect(order.totalCents).toBe(2144);
    const payment = (await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 2144 })).body;
    expect((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 1000 })).status).toBe(201);
    expect((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 1144 })).status).toBe(201);
    const invoice = await invoiceOf(app, order.invoiceId);
    expect(invoice.refundedCents).toBe(2144);
    expect(invoice.paidCents).toBe(0);
    expect(invoice.balanceCents).toBe(2144);
    const payments = (await authed(app, "GET", "/payments")).body.payments;
    expect(payments[0].refundedCents).toBe(2144);
  });

  it("a refund larger than the payment is refused", async () => {
    const app = freshApp();
    const order = await buy(app, [["p3", 1]], "OR");
    const payment = (await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 4500 })).body;
    expect(REJECTED).toContain((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 4501 })).status);
    expect((await authed(app, "GET", "/refunds")).body.total).toBe(0);
    expect((await invoiceOf(app, order.invoiceId)).balanceCents).toBe(0);
  });

  it("refunds that together exceed the payment are refused", async () => {
    const app = freshApp();
    const order = await buy(app, [["p3", 1]], "OR");
    const payment = (await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 4500 })).body;
    expect((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 3000 })).status).toBe(201);
    expect(REJECTED).toContain((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 1501 })).status);
    expect((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 1500 })).status).toBe(201);
    expect(REJECTED).toContain((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 1 })).status);
    const invoice = await invoiceOf(app, order.invoiceId);
    expect(invoice.refundedCents).toBe(4500);
    expect(invoice.balanceCents).toBe(4500);
    expect((await authed(app, "GET", "/refunds")).body.total).toBe(2);
  });
});

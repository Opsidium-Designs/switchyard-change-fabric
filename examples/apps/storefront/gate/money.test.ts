// Acceptance: money is exact to the cent everywhere.
//
// The API speaks integer cents. A price is reported exactly as it was set; a
// line total is unit price times quantity; a subtotal is the sum of its lines;
// tax is the subtotal times the region's rate (CA 7.25%, NY 8.875%, TX 6.25%,
// OR 0%) rounded to the nearest cent with an exact half cent rounding UP; a
// total is subtotal plus tax; and an order's invoice states the same amounts as
// the order.

import { describe, expect, it } from "vitest";

import { authed, buy, call, freshApp } from "./harness.ts";

describe("prices are exact", () => {
  it("the seeded catalog reports its prices to the cent", async () => {
    const page = await call(freshApp(), "GET", "/products");
    const prices = Object.fromEntries(page.body.products.map((p: any) => [p.id, p.priceCents]));
    expect(prices).toEqual({ p1: 1999, p2: 2450, p3: 4500, p4: 115, p5: 500, p6: 1629 });
    expect((await call(freshApp(), "GET", "/products/p1")).body.priceCents).toBe(1999);
    expect((await call(freshApp(), "GET", "/search?q=filters")).body.results[0].priceCents).toBe(115);
  });

  for (const priceCents of [1999, 115, 29, 57, 1005, 100000]) {
    it(`a product created at ${priceCents} cents reads back as ${priceCents}`, async () => {
      const app = freshApp();
      const created = await authed(app, "POST", "/products", { name: "Probe", categoryId: "c2", priceCents });
      expect(created.status).toBe(201);
      expect(created.body.priceCents).toBe(priceCents);
      expect((await call(app, "GET", `/products/${created.body.id}`)).body.priceCents).toBe(priceCents);
    });
  }
});

describe("cart and order totals add up", () => {
  it("cart lines and subtotal are exact", async () => {
    const app = freshApp();
    await authed(app, "POST", "/cart/items", { productId: "p1", qty: 3 });
    await authed(app, "POST", "/cart/items", { productId: "p4", qty: 1 });
    await authed(app, "POST", "/cart/items", { productId: "p6", qty: 2 });
    const cart = (await authed(app, "GET", "/cart")).body;
    expect(cart.lines.map((l: any) => [l.productId, l.unitPriceCents, l.lineTotalCents])).toEqual([
      ["p1", 1999, 5997],
      ["p4", 115, 115],
      ["p6", 1629, 3258],
    ]);
    expect(cart.subtotalCents).toBe(5997 + 115 + 3258);
  });

  it("an order's subtotal, tax, and total are consistent", async () => {
    const app = freshApp();
    const order = await buy(app, [["p1", 3], ["p4", 1], ["p6", 2]], "NY");
    const lineSum = order.lines.reduce((s: number, l: any) => s + l.lineTotalCents, 0);
    for (const line of order.lines) {
      expect(line.lineTotalCents).toBe(line.unitPriceCents * line.qty);
    }
    expect(order.subtotalCents).toBe(9370);
    expect(lineSum).toBe(9370);
    // 9370 x 8.875% = 831.5875 cents
    expect(order.taxCents).toBe(832);
    expect(order.totalCents).toBe(order.subtotalCents + order.taxCents);
  });
});

describe("tax rounds to the nearest cent, halves up", () => {
  const cases: [string, [string, number][], string, number, number][] = [
    // label, cart, region, subtotal, tax
    ["a $10.00 order in CA (72.5 cents)", [["p5", 2]], "CA", 1000, 73],
    ["a $19.99 order in CA (144.9275 cents)", [["p1", 1]], "CA", 1999, 145],
    ["a $19.99 order in NY (177.41125 cents)", [["p1", 1]], "NY", 1999, 177],
    ["a $2.30 order in TX (14.375 cents)", [["p4", 2]], "TX", 230, 14],
    ["a $45.00 order in TX (281.25 cents)", [["p3", 1]], "TX", 4500, 281],
    ["a $16.29 order in OR (no sales tax)", [["p6", 1]], "OR", 1629, 0],
  ];
  for (const [label, lines, region, subtotal, tax] of cases) {
    it(label, async () => {
      const app = freshApp();
      const order = await buy(app, lines, region);
      expect(order.subtotalCents).toBe(subtotal);
      expect(order.taxCents).toBe(tax);
      expect(order.totalCents).toBe(subtotal + tax);
    });
  }

  it("an exact half cent rounds up (a $1.20 product in TX is 7.5 cents of tax)", async () => {
    const app = freshApp();
    const product = (await authed(app, "POST", "/products", { name: "Sugar sticks", categoryId: "c3", priceCents: 120 })).body;
    const order = await buy(app, [[product.id, 1]], "TX");
    expect(order.taxCents).toBe(8);
    expect(order.totalCents).toBe(128);
  });
});

describe("an invoice states the same amounts as its order", () => {
  for (const [lines, region] of [
    [[["p5", 2]], "CA"],
    [[["p1", 1]], "CA"],
    [[["p1", 3], ["p4", 1], ["p6", 2]], "NY"],
  ] as [[string, number][], string][]) {
    it(`${JSON.stringify(lines)} to ${region}`, async () => {
      const app = freshApp();
      const order = await buy(app, lines, region);
      const invoice = await authed(app, "GET", `/invoices/${order.invoiceId}`);
      expect(invoice.status).toBe(200);
      expect(invoice.body.orderId).toBe(order.id);
      expect(invoice.body.subtotalCents).toBe(order.subtotalCents);
      expect(invoice.body.taxCents).toBe(order.taxCents);
      expect(invoice.body.totalCents).toBe(order.totalCents);
      expect(invoice.body.paidCents).toBe(0);
      expect(invoice.body.balanceCents).toBe(order.totalCents);
    });
  }
});

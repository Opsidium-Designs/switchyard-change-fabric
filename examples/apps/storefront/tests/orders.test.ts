import { describe, expect, it } from "vitest";

import { freshApp, send } from "./helpers.ts";

describe("orders", () => {
  it("checks a cart out into an order with an invoice", async () => {
    const app = freshApp();
    expect((await send(app, "POST", "/cart/items", { productId: "p3", qty: 1 })).status).toBe(201);
    const order = await send(app, "POST", "/checkout", { region: "OR" });
    expect(order.status).toBe(201);
    expect(order.body.totalCents).toBe(4500);
    expect((await send(app, "GET", "/cart")).body.lines).toEqual([]);

    const history = await send(app, "GET", "/orders");
    expect(history.body.orders.map((o: { id: string }) => o.id)).toEqual([order.body.id]);

    const invoice = await send(app, "GET", `/invoices/${order.body.invoiceId}`);
    expect(invoice.status).toBe(200);
    expect(invoice.body.orderId).toBe(order.body.id);
  });

  it("removes a product from the cart", async () => {
    const app = freshApp();
    await send(app, "POST", "/cart/items", { productId: "p2", qty: 1 });
    await send(app, "POST", "/cart/items", { productId: "p3", qty: 1 });
    const cart = await send(app, "DELETE", "/cart/items/p2");
    expect(cart.body.lines.map((l: { productId: string }) => l.productId)).toEqual(["p3"]);
  });
});

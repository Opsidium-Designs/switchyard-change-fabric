import { describe, expect, it } from "vitest";

import { freshApp, send } from "../helpers.ts";

// Checkout tax, pinned from the amounts checkout produces today.
describe("checkout tax", () => {
  it("taxes a $10.00 order shipped to CA at 72 cents", async () => {
    const app = freshApp();
    await send(app, "POST", "/cart/items", { productId: "p5", qty: 2 });
    const order = await send(app, "POST", "/checkout", { region: "CA" });
    expect(order.body.subtotalCents).toBe(1000);
    expect(order.body.taxCents).toBe(72);
    expect(order.body.totalCents).toBe(1072);
  });

  it("charges no sales tax in OR", async () => {
    const app = freshApp();
    await send(app, "POST", "/cart/items", { productId: "p3", qty: 2 });
    const order = await send(app, "POST", "/checkout", { region: "OR" });
    expect(order.body.taxCents).toBe(0);
    expect(order.body.totalCents).toBe(9000);
  });
});

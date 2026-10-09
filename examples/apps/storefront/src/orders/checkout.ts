// storefront orders: checkout.
//
// Route:
//   POST /checkout {region}  turn the cart into an order, tax it for the
//                            shipping region, open its invoice, empty the cart
//
// Responds 201 with the order (see orderView in ./history).

import { add } from "../contracts/money.ts";
import { json, problem, readBody } from "../contracts/http.ts";
import { createInvoice } from "../billing/invoices.ts";
import { taxFor } from "../billing/tax.ts";
import type { Ctx, Order } from "../store.ts";
import { pricedCart } from "./cart.ts";
import { orderView } from "./history.ts";

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, parts } = ctx;
  if (request.method !== "POST" || parts.length !== 1) {
    return problem(404, "not found");
  }
  const body = await readBody(request);
  const region = String(body.region ?? "");
  const { lines, subtotal } = pricedCart(store);
  const tax = taxFor(subtotal, region);
  const order: Order = {
    id: store.nextId("ord"),
    region,
    lines: lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
    subtotal,
    tax,
    total: add(subtotal, tax),
    invoiceId: "",
  };
  order.invoiceId = createInvoice(store, order).id;
  store.orders.push(order);
  store.cart = [];
  return json(orderView(order), 201);
}

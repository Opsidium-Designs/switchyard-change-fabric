// storefront orders: order history.
//
// Routes:
//   GET /orders?limit=&offset=  a page of the customer's orders, newest first
//   GET /orders/:id             one order

import { multiply, toCents } from "../contracts/money.ts";
import { json, problem } from "../contracts/http.ts";
import type { Ctx, Order } from "../store.ts";

/** The public JSON shape of an order (amounts in integer cents). */
export function orderView(order: Order) {
  return {
    id: order.id,
    region: order.region,
    lines: order.lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      qty: l.qty,
      unitPriceCents: toCents(l.unitPrice),
      lineTotalCents: toCents(multiply(l.unitPrice, l.qty)),
    })),
    subtotalCents: toCents(order.subtotal),
    taxCents: toCents(order.tax),
    totalCents: toCents(order.total),
    invoiceId: order.invoiceId,
  };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, parts } = ctx;
  if (request.method === "GET" && parts.length === 1) {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const newestFirst = [...store.orders].reverse();
    return json({
      orders: newestFirst.slice(offset, offset + limit).map(orderView),
      total: store.orders.length,
      limit,
      offset,
    });
  }
  if (request.method === "GET" && parts.length === 2) {
    const order = store.orders.find((o) => o.id === parts[1]);
    return order ? json(orderView(order)) : problem(404, "order not found");
  }
  return problem(404, "not found");
}

// storefront orders: the shopping cart.
//
// Routes:
//   GET    /cart                         the cart with line and subtotal amounts
//   POST   /cart/items {productId, qty}  add a quantity of a product
//   DELETE /cart/items/:productId        remove a product from the cart
//
// The cart belongs to the signed-in customer (the demo has one customer).

import { multiply, sum, toCents, type Money } from "../contracts/money.ts";
import { json, problem, readBody } from "../contracts/http.ts";
import type { Ctx, Store } from "../store.ts";

/** The cart's lines priced from the catalog, and its subtotal. */
export function pricedCart(store: Store): { lines: { productId: string; name: string; qty: number; unitPrice: Money; lineTotal: Money }[]; subtotal: Money } {
  const lines = store.cart.map((line) => {
    const product = store.products.find((p) => p.id === line.productId)!;
    return {
      productId: line.productId,
      name: product.name,
      qty: line.qty,
      unitPrice: product.price,
      lineTotal: multiply(product.price, line.qty),
    };
  });
  return { lines, subtotal: sum(lines.map((l) => l.lineTotal)) };
}

function cartView(store: Store) {
  const { lines, subtotal } = pricedCart(store);
  return {
    lines: lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      qty: l.qty,
      unitPriceCents: toCents(l.unitPrice),
      lineTotalCents: toCents(l.lineTotal),
    })),
    subtotalCents: toCents(subtotal),
  };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, parts } = ctx;
  if (request.method === "GET" && parts.length === 1) {
    return json(cartView(store));
  }
  if (request.method === "POST" && parts.length === 2 && parts[1] === "items") {
    const body = await readBody(request);
    const productId = String(body.productId ?? "");
    const qty = Number(body.qty);
    const existing = store.cart.find((l) => l.productId === productId);
    if (existing) {
      existing.qty += qty;
    } else {
      store.cart.push({ productId, qty });
    }
    return json(cartView(store), 201);
  }
  if (request.method === "DELETE" && parts.length === 3 && parts[1] === "items") {
    store.cart = store.cart.filter((l) => l.productId !== parts[2]);
    return json(cartView(store));
  }
  return problem(404, "not found");
}

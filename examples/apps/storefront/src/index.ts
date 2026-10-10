// storefront: a small multi-domain store served by one Cloudflare Worker.
//
// Three domains, each a folder of modules that own their routes:
//   catalog  /products, /categories, /search      (public reads)
//   orders   /cart, /checkout, /orders            (the customer's own)
//   billing  /invoices, /payments, /refunds       (the customer's own)
// over three shared contracts every domain imports:
//   src/contracts/money.ts  Money and its arithmetic (the API speaks cents)
//   src/contracts/http.ts   json(), problem(), readBody()
//   src/contracts/auth.ts   requireAuth(request)
//
// GET / serves a demo store page (src/ui.ts) that drives the real API and keeps
// representative health checks per domain against the Worker it is served from.
//
// createStorefront() builds one instance over a fresh, seeded in-memory store;
// the default export is the instance the deployed Worker serves.

import { problem } from "./contracts/http.ts";
import { handle as products } from "./catalog/products.ts";
import { handle as categories } from "./catalog/categories.ts";
import { handle as search } from "./catalog/search.ts";
import { handle as cart } from "./orders/cart.ts";
import { handle as checkout } from "./orders/checkout.ts";
import { handle as orders } from "./orders/history.ts";
import { handle as invoices } from "./billing/invoices.ts";
import { handle as payments } from "./billing/payments.ts";
import { handle as refunds } from "./billing/refunds.ts";
import { createStore, type Ctx } from "./store.ts";
import { PAGE } from "./ui.ts";

type Handler = (request: Request, ctx: Ctx) => Promise<Response>;

/** The route registry: first path segment to its owning module's handler. */
const ROUTES: Readonly<Record<string, Handler>> = {
  products,
  categories,
  search,
  cart,
  checkout,
  orders,
  invoices,
  payments,
  refunds,
};

/** A storefront instance over a fresh, seeded store. */
export function createStorefront(): { fetch(request: Request): Promise<Response> } {
  const store = createStore();
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter((p) => p !== "");
      if (request.method === "GET" && parts.length === 0) {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const handler = Object.hasOwn(ROUTES, parts[0] ?? "") ? ROUTES[parts[0]!] : undefined;
      if (!handler) {
        return problem(404, "not found");
      }
      try {
        return await handler(request, { store, url, parts });
      } catch {
        return problem(500, "internal error");
      }
    },
  };
}

export default createStorefront();

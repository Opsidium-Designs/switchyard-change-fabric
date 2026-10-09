// storefront catalog: products.
//
// Routes:
//   GET  /products?category=&limit=&offset=  a page of products (public)
//   GET  /products/:id                       one product (public)
//   POST /products {name, categoryId, priceCents}  add a product
//
// A product is reported with its price in integer cents (`priceCents`).

import { fromCents, toCents } from "../contracts/money.ts";
import { json, problem, readBody } from "../contracts/http.ts";
import type { Ctx, Product } from "../store.ts";

/** The public JSON shape of a product. */
export function productView(product: Product) {
  return {
    id: product.id,
    name: product.name,
    categoryId: product.categoryId,
    priceCents: toCents(product.price),
  };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, parts } = ctx;
  if (request.method === "GET" && parts.length === 1) {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const category = url.searchParams.get("category");
    const matching = category ? store.products.filter((p) => p.categoryId === category) : store.products;
    return json({
      products: matching.slice(offset, offset + limit).map(productView),
      total: matching.length,
      limit,
      offset,
    });
  }
  if (request.method === "GET" && parts.length === 2) {
    const product = store.products.find((p) => p.id === parts[1]);
    return product ? json(productView(product)) : problem(404, "product not found");
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    const product: Product = {
      id: store.nextId("p"),
      name: String(body.name ?? ""),
      categoryId: String(body.categoryId ?? ""),
      price: fromCents(Number(body.priceCents)),
    };
    store.products.push(product);
    return json(productView(product), 201);
  }
  return problem(404, "not found");
}

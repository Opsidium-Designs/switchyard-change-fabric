// storefront catalog: categories.
//
// Routes:
//   GET  /categories?limit=&offset=  a page of categories (public)
//   POST /categories {name}          add a category

import { json, problem, readBody } from "../contracts/http.ts";
import type { Category, Ctx } from "../store.ts";

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, parts } = ctx;
  if (request.method === "GET" && parts.length === 1) {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return json({
      categories: store.categories.slice(offset, offset + limit),
      total: store.categories.length,
      limit,
      offset,
    });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    const category: Category = { id: store.nextId("c"), name: String(body.name ?? "") };
    store.categories.push(category);
    return json(category, 201);
  }
  return problem(404, "not found");
}

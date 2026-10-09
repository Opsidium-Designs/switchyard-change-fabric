// storefront catalog: search.
//
// Route:
//   GET /search?q=&limit=&offset=  products whose name contains q, case
//                                  insensitively (public)

import { json, problem } from "../contracts/http.ts";
import type { Ctx } from "../store.ts";
import { productView } from "./products.ts";

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, parts } = ctx;
  if (request.method !== "GET" || parts.length !== 1) {
    return problem(404, "not found");
  }
  const term = (url.searchParams.get("q") ?? "").toLowerCase();
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const matching = store.products.filter((p) => p.name.toLowerCase().includes(term));
  return json({
    query: term,
    results: matching.slice(offset, offset + limit).map(productView),
    total: matching.length,
    limit,
    offset,
  });
}

// service-api products resource.
//
// Routes: POST /products creates a product from {"name": "...", "price":
// <number>}; GET /products lists.
//
// FABRIC-FOLLOWUP: this resource skips the shared auth and input contracts. It
// does NOT call requireAuth, so an unauthenticated POST wrongly succeeds, and it
// does NOT validate the body, so a missing name or a negative price wrongly
// creates a product. The per-resource fix calls requireAuth(request) first and
// returns problem(400) when name is not a non-empty string or price is not a
// non-negative number. The shared contracts are frozen; this resource honors
// them.

import { json, problem, readBody } from "../contracts/response.js";
import { requireAuth } from "../contracts/auth.js";

const PRODUCTS = [];

export async function handle(request, parts) {
  if (request.method === "GET" && parts.length === 1) {
    return json({ products: PRODUCTS });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    // The planted gap: no requireAuth call and no name/price validation here.
    const name = typeof body.name === "string" ? body.name : "";
    const price = typeof body.price === "number" ? body.price : 0;
    const product = { id: String(PRODUCTS.length + 1), name, price };
    PRODUCTS.push(product);
    return json(product, 201);
  }
  return problem(404, "not found");
}

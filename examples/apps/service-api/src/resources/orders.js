// service-api orders resource.
//
// Routes: POST /orders creates an order from {"sku": "...", "qty": <number>};
// GET /orders lists.
//
// FABRIC-FOLLOWUP: this resource skips the shared auth and input contracts. It
// does NOT call requireAuth, so an unauthenticated POST wrongly succeeds, and it
// does NOT validate the body, so a missing sku or a non-positive qty wrongly
// creates an order. The per-resource fix calls requireAuth(request) first and
// returns problem(400) when sku is not a non-empty string or qty is not a
// positive integer. The shared contracts are frozen; this resource honors them.

import { json, problem, readBody } from "../contracts/response.js";
import { requireAuth } from "../contracts/auth.js";

const ORDERS = [];

export async function handle(request, parts) {
  if (request.method === "GET" && parts.length === 1) {
    return json({ orders: ORDERS });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    // The planted gap: no requireAuth call and no sku/qty validation here.
    const sku = typeof body.sku === "string" ? body.sku : "";
    const qty = typeof body.qty === "number" ? body.qty : 0;
    const order = { id: String(ORDERS.length + 1), sku, qty };
    ORDERS.push(order);
    return json(order, 201);
  }
  return problem(404, "not found");
}

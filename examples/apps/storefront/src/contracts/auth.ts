// storefront SHARED auth contract.
//
// requireAuth(request) inspects the request for a bearer token. When the token
// is missing or wrong it returns a 401 Response (through the shared problem
// helper); when the token is valid it returns null, meaning "authorized, carry
// on". A handler that needs auth calls it first and returns the Response when it
// is non-null:
//
//   const denied = requireAuth(request);
//   if (denied) return denied;
//
// The catalog's reads (products, categories, search) are public. Everything a
// customer owns (cart, checkout, orders, invoices, payments, refunds) and every
// write needs an authenticated caller.

import { problem } from "./http.ts";

/** The demo bearer token the tests, the gate, and the tester page use. */
export const DEMO_TOKEN = "demo-token";

/** A 401 Response when the request is unauthenticated, else null. */
export function requireAuth(request: Request): Response | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  if (token !== DEMO_TOKEN) {
    return problem(401, "authentication required");
  }
  return null;
}

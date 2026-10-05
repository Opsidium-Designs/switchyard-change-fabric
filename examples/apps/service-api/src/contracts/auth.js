// service-api FROZEN auth contract.
//
// This is a shared seam every resource module imports. It is an interface the
// resource owners must HONOR, not rewrite: a resource proves it is fixed by
// CALLING requireAuth(request) before doing work, not by reimplementing auth.
//
// requireAuth inspects the request for a bearer token. If the token is missing
// or not the demo token it returns a Response (401 via the shared problem
// helper); if the token is valid it returns null, meaning "authorized, carry
// on". A resource handler must short-circuit and return that Response when it is
// non-null.
//
// Keeping this in one frozen module is the point: many agents can each fix their
// own resource independently, but they all depend on this single contract, so
// the fix is honest many-agent work over a shared interface rather than each
// agent inventing its own auth.

import { problem } from "./response.js";

/** The demo bearer token the gate and the browser page use. */
export const DEMO_TOKEN = "demo-token";

/**
 * Enforce authentication on a request.
 *
 * @param {Request} request
 * @returns {Response | null} a 401 Response when unauthorized, or null when the
 *   request carries a valid bearer token (authorized).
 */
export function requireAuth(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : "";
  if (token !== DEMO_TOKEN) {
    return problem(401, "authentication required");
  }
  return null;
}

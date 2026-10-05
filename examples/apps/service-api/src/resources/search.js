// service-api search resource.
//
// Route: GET /search?q=<term> returns matches for the term. Search is a GET, so
// its input is the query string rather than a JSON body: a valid request needs a
// non-empty q parameter.
//
// FABRIC-FOLLOWUP: this resource skips the shared auth and input contracts. It
// does NOT call requireAuth, so an unauthenticated search wrongly succeeds, and
// it does NOT validate q, so a request with a missing or empty q wrongly
// returns a 200. The per-resource fix calls requireAuth(request) first and
// returns problem(400) when q is missing or empty. The shared contracts are
// frozen; this resource honors them.

import { json, problem } from "../contracts/response.js";
import { requireAuth } from "../contracts/auth.js";

export async function handle(request) {
  const url = new URL(request.url);
  // The planted gap: no requireAuth call and no q validation here.
  const q = (url.searchParams.get("q") || "").trim();
  return json({ query: q, results: [] });
}

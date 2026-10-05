// service-api users resource.
//
// Routes: POST /users creates a user from {"email": "..."}; GET /users lists.
//
// FABRIC-FOLLOWUP: this resource skips the shared auth and input contracts. It
// does NOT call requireAuth, so an unauthenticated POST wrongly succeeds, and it
// does NOT validate the email, so a body with no email wrongly creates a user.
// The per-resource fix calls requireAuth(request) first and returns problem(400)
// when the email is missing or not a non-empty string. The shared contracts
// (requireAuth, json, problem, readBody) are frozen; this resource only has to
// honor them.

import { json, problem, readBody } from "../contracts/response.js";
import { requireAuth } from "../contracts/auth.js";

const USERS = [];

export async function handle(request, parts) {
  if (request.method === "GET" && parts.length === 1) {
    return json({ users: USERS });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    // The planted gap: no requireAuth call and no email validation here.
    const email = typeof body.email === "string" ? body.email : "";
    const user = { id: String(USERS.length + 1), email };
    USERS.push(user);
    return json(user, 201);
  }
  return problem(404, "not found");
}

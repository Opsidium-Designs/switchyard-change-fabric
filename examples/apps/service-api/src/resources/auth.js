// service-api auth resource.
//
// This resource manages API sessions (distinct from the frozen auth CONTRACT in
// contracts/auth.js, which is the shared middleware). Routes: POST /auth creates
// a session from {"label": "..."}; GET /auth lists active sessions.
//
// FABRIC-FOLLOWUP: this resource skips the shared auth and input contracts. It
// does NOT call requireAuth, so an unauthenticated POST wrongly succeeds, and it
// does NOT validate the label, so a body with no label wrongly creates a
// session. The per-resource fix calls requireAuth(request) first and returns
// problem(400) when the label is missing or not a non-empty string. The shared
// contracts are frozen; this resource honors them.

import { json, problem, readBody } from "../contracts/response.js";
import { requireAuth } from "../contracts/auth.js";

const SESSIONS = [];

export async function handle(request, parts) {
  if (request.method === "GET" && parts.length === 1) {
    return json({ sessions: SESSIONS });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    // The planted gap: no requireAuth call and no label validation here.
    const label = typeof body.label === "string" ? body.label : "";
    const session = { id: String(SESSIONS.length + 1), label };
    SESSIONS.push(session);
    return json(session, 201);
  }
  return problem(404, "not found");
}

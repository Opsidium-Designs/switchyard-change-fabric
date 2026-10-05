// service-api notifications resource.
//
// Routes: POST /notifications sends a notification from {"to": "...",
// "message": "..."}; GET /notifications lists sent notifications.
//
// FABRIC-FOLLOWUP: this resource skips the shared auth and input contracts. It
// does NOT call requireAuth, so an unauthenticated POST wrongly succeeds, and it
// does NOT validate the body, so a missing to or message wrongly sends a
// notification. The per-resource fix calls requireAuth(request) first and
// returns problem(400) when to or message is not a non-empty string. The shared
// contracts are frozen; this resource honors them.

import { json, problem, readBody } from "../contracts/response.js";
import { requireAuth } from "../contracts/auth.js";

const SENT = [];

export async function handle(request, parts) {
  if (request.method === "GET" && parts.length === 1) {
    return json({ notifications: SENT });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    // The planted gap: no requireAuth call and no to/message validation here.
    const to = typeof body.to === "string" ? body.to : "";
    const message = typeof body.message === "string" ? body.message : "";
    const sent = { id: String(SENT.length + 1), to, message };
    SENT.push(sent);
    return json(sent, 201);
  }
  return problem(404, "not found");
}

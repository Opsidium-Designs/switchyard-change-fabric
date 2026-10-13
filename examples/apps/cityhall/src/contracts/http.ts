// cityhall SHARED http contract.
//
// The response and request helpers every route module imports, so the whole
// API speaks one shape:
//
//   json(body, status)       a JSON success Response (200 by default)
//   problem(status, detail)  a JSON error Response: { "error": detail }
//   readBody(request)        the parsed JSON object body, or {} when it is
//                            missing or malformed (a module validates fields)
//
// Status codes the API uses: 400 invalid input, 401 no or unknown token, 403
// the caller's role may not do this, 404 unknown (or not yours), 409 conflicts
// with existing state, 422 breaks a business rule.

/** A JSON success Response. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A JSON error Response in the shared problem shape. */
export function problem(status: number, detail: string): Response {
  return new Response(JSON.stringify({ error: detail }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The shared 404 for an unknown route or record. */
export function notFound(what = "not found"): Response {
  return problem(404, what);
}

/** Parse a JSON request body, tolerating an empty or malformed body. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

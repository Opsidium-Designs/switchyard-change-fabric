// storefront SHARED http contract.
//
// The response and request helpers every domain module imports, so the whole
// service speaks one response shape:
//
//   json(body, status)       a JSON success Response (200 by default)
//   problem(status, detail)  a JSON error Response: { "error": detail }
//   readBody(request)        the parsed JSON body, or {} when it is missing or
//                            malformed (a handler validates the SHAPE)
//
// A failed validation, a missing resource, or a missing token is observable on
// the real Response: the status code plus a readable error string.

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

/** Parse a JSON request body, tolerating an empty or malformed body. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

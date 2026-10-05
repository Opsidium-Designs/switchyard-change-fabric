// service-api FROZEN response contract.
//
// The shared response/data-schema helpers every resource imports. Like the auth
// contract this is a seam the resource owners HONOR, not rewrite: a resource
// returns success with json(...) and returns an error with problem(...), so the
// whole service speaks one response shape.
//
//   json(body, status)      a JSON success Response (200 by default)
//   problem(status, detail) a JSON error Response in a small, uniform shape
//
// problem returns { error: <detail> } with the given status, so a failed
// validation or a missing-auth short-circuit is observable on the real Response
// (status code plus a readable error string).

/**
 * A JSON success Response.
 *
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * A JSON error Response in the shared problem shape.
 *
 * @param {number} status
 * @param {string} detail
 * @returns {Response}
 */
export function problem(status, detail) {
  return new Response(JSON.stringify({ error: detail }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Parse a JSON request body, tolerating an empty or malformed body by returning
 * an empty object (so a resource validates the SHAPE rather than crashing on a
 * bad body). Shared so every resource parses input the same way.
 *
 * @param {Request} request
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

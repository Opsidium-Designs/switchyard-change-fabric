// Shared per-app verification gate helper for the Change Fabric demo apps.
//
// A1 (recorded exec mechanism): the deterministic offline gate imports an app's
// exported `fetch` handler (the Worker default export) and asserts on the
// returned `Response`. It makes NO network call and does NOT spawn wrangler, so
// it runs the same on any machine and in CI. A live gate path, if ever added,
// must stay honest and still prove the planted bug is fixed; it does not replace
// this offline test path.
//
// Design rules this helper enforces:
//   - Absence of a gate means cannot-pass. Each app's gate is a real node test
//     file the `verify` script runs; if that file is missing or empty the test
//     runner exits non-zero, so a unit can never auto-pass by having no gate.
//   - The gate asserts the planted bug is fixed by observing the real Response,
//     never by trusting the model or a skipped check.
//
// This module only provides small assertion helpers shared by the per-app gate
// files; each app keeps its own gate file with its own app-specific assertion.

import assert from "node:assert/strict";

/**
 * Invoke an app's Worker fetch handler with a constructed Request and return the
 * Response. The handler is the module's default export `{ fetch }`. No network.
 *
 * @param {{ fetch: (request: Request) => Promise<Response> | Response }} app
 * @param {string} path  request path, for example "/convert?c=100"
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function invoke(app, path, init) {
  assert.ok(
    app && typeof app.fetch === "function",
    "app must export a default { fetch } handler",
  );
  const request = new Request("http://app.local" + path, init);
  const response = await app.fetch(request);
  assert.ok(
    response instanceof Response,
    "fetch handler must return a Response",
  );
  return response;
}

/** Read a JSON body from a Response. */
export async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new assert.AssertionError({
      message: "response body was not valid JSON: " + text,
    });
  }
}

/** POST helper that sends a JSON body. */
export function postJson(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

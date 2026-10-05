// service-api verification gate: deterministic, offline, no network.
//
// This is the AUTHORITATIVE promoted-artifact check. It imports the app's own
// fetch handler and asserts the WHOLE service is fixed by observing the real
// Response for EVERY resource. For each resource it asserts three things:
//   1. an UNAUTHENTICATED write is rejected via requireAuth (401 or 403),
//   2. an authenticated but INVALID request is rejected with 400,
//   3. an authenticated, valid request still succeeds (2xx).
//
// Because the per-resource assertions are kept distinct, a PARTIAL fix (one
// resource fixed, another still skipping auth or validation) FAILS the gate. On
// the current (buggy) source every resource skips auth and validation, so the
// unauthenticated and invalid assertions FAIL, which is correct: the gap is
// still planted and the gate catches it. The gate PASSES only once every
// resource calls requireAuth and validates its input. The syntax/typecheck step
// lives in the app's npm scripts (node --check over src), so a broken-JS edit
// fails before this runs.

import { test } from "node:test";
import { invoke, readJson, postJson } from "../../gate-harness.mjs";
import app from "../src/index.js";
import { DEMO_TOKEN } from "../src/contracts/auth.js";
import assert from "node:assert/strict";

/** An authorized request init (valid bearer token) for a given method/body. */
function authed(init = {}) {
  const headers = { ...(init.headers || {}), authorization: "Bearer " + DEMO_TOKEN };
  return { ...init, headers };
}

/**
 * Each resource under test. For every resource we need:
 *   path          the resource route
 *   unauth        a request init that is UNAUTHENTICATED but otherwise valid
 *   invalid       an AUTHENTICATED request with invalid input
 *   valid         an AUTHENTICATED request with valid input
 *   okStatus      the expected success status for the valid request
 */
const RESOURCES = [
  {
    name: "users",
    path: "/users",
    unauth: postJson({ email: "a@example.com" }),
    invalid: authed(postJson({})),
    valid: authed(postJson({ email: "a@example.com" })),
    okStatus: 201,
  },
  {
    name: "orders",
    path: "/orders",
    unauth: postJson({ sku: "abc", qty: 2 }),
    invalid: authed(postJson({ sku: "", qty: 0 })),
    valid: authed(postJson({ sku: "abc", qty: 2 })),
    okStatus: 201,
  },
  {
    name: "products",
    path: "/products",
    unauth: postJson({ name: "widget", price: 9 }),
    invalid: authed(postJson({ name: "", price: -1 })),
    valid: authed(postJson({ name: "widget", price: 9 })),
    okStatus: 201,
  },
  {
    name: "auth",
    path: "/auth",
    unauth: postJson({ label: "ci" }),
    invalid: authed(postJson({})),
    valid: authed(postJson({ label: "ci" })),
    okStatus: 201,
  },
  {
    name: "search",
    path: "/search?q=widgets",
    unauth: { method: "GET" },
    invalid: authed({ method: "GET" }),
    invalidPath: "/search",
    valid: authed({ method: "GET" }),
    okStatus: 200,
  },
  {
    name: "notifications",
    path: "/notifications",
    unauth: postJson({ to: "a@example.com", message: "hi" }),
    invalid: authed(postJson({ to: "", message: "" })),
    valid: authed(postJson({ to: "a@example.com", message: "hi" })),
    okStatus: 201,
  },
];

for (const r of RESOURCES) {
  test(r.name + ": unauthenticated request is rejected (401/403)", async () => {
    const response = await invoke(app, r.path, r.unauth);
    assert.ok(
      response.status === 401 || response.status === 403,
      r.name + " must reject an unauthenticated request via requireAuth, got " + response.status,
    );
  });

  test(r.name + ": authenticated but invalid input is rejected with 400", async () => {
    const path = r.invalidPath || r.path;
    const response = await invoke(app, path, r.invalid);
    assert.equal(
      response.status,
      400,
      r.name + " must reject invalid input with 400, got " + response.status,
    );
  });

  test(r.name + ": authenticated, valid request still succeeds", async () => {
    const response = await invoke(app, r.path, r.valid);
    assert.equal(
      response.status,
      r.okStatus,
      r.name + " must still succeed for a valid authenticated request",
    );
  });
}

test("GET / serves the browser-visible resource list", async () => {
  const response = await invoke(app, "/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  const text = await response.text();
  for (const r of RESOURCES) {
    assert.match(text, new RegExp(r.name), "home page must list the " + r.name + " resource");
  }
});

// A small sanity read on the shared response shape, so the frozen contract is
// exercised directly by the gate too.
test("problem responses carry a readable error string", async () => {
  const response = await invoke(app, "/users", postJson({ email: "x@example.com" }));
  if (response.status !== 201) {
    const body = await readJson(response);
    assert.equal(typeof body.error, "string");
  }
});

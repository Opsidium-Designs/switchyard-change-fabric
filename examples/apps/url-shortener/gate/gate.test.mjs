// url-shortener verification gate (T2): deterministic, offline, no network.
//
// Asserts the planted non-redirect bug is fixed by importing the app's own
// fetch handler and observing the real Response: GET /s/<code> for a known code
// must be a real redirect (302) with a Location header, not a 200. On the
// current (buggy) source this test FAILS, which is correct: the bug is still
// planted and the gate catches it. It PASSES only once the handler returns 302.
// The syntax/typecheck step lives in the app's `verify` npm script.

import { test } from "node:test";
import { invoke, readJson, postJson } from "../../gate-harness.mjs";
import app from "../src/index.js";
import assert from "node:assert/strict";

test("GET /s/<code> for a known code redirects with 302 and a location", async () => {
  const target = "https://example.com/landing";
  const created = await invoke(app, "/shorten", postJson({ url: target }));
  assert.equal(created.status, 201);
  const { code } = await readJson(created);

  const response = await invoke(app, "/s/" + code, { redirect: "manual" });
  assert.equal(
    response.status,
    302,
    "a known short code must redirect with 302, not return 200",
  );
  assert.equal(
    response.headers.get("location"),
    target,
    "the redirect must carry the original URL in the location header",
  );
});

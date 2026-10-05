// unit-converter verification gate (T2): deterministic, offline, no network.
//
// Asserts the planted wrong-formula bug is fixed by importing the app's own
// fetch handler and observing the real Response: GET /convert?c=100 must return
// 212 Fahrenheit (the C->F formula includes the +32 offset), not 180. On the
// current (buggy) source this test FAILS, which is correct: the bug is still
// planted and the gate catches it. It PASSES only once the +32 offset is
// restored. The syntax/typecheck step lives in the app's `verify` npm script.

import { test } from "node:test";
import { invoke, readJson } from "../../gate-harness.mjs";
import app from "../src/index.js";
import assert from "node:assert/strict";

test("GET /convert?c=100 returns 212 Fahrenheit", async () => {
  const response = await invoke(app, "/convert?c=100");
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(
    body.fahrenheit,
    212,
    "100C must convert to 212F (the +32 offset must be present)",
  );
});

test("GET /convert?c=0 returns 32 Fahrenheit", async () => {
  const response = await invoke(app, "/convert?c=0");
  const body = await readJson(response);
  assert.equal(body.fahrenheit, 32);
});

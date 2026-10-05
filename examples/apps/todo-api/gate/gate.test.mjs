// todo-api verification gate (T2): deterministic, offline, no network.
//
// Asserts the planted missing-validation bug is fixed by importing the app's
// own fetch handler and observing the real Response: POST /todos with an empty
// body {} must be rejected with 400, not accepted with 201. On the current
// (buggy) source this test FAILS, which is correct: the bug is still planted and
// the gate catches it. It PASSES only once the create route rejects an empty
// title. The syntax/typecheck step lives in the app's `verify` npm script
// (node --check over src), so a broken-JS edit fails before this runs.

import { test } from "node:test";
import { invoke, readJson, postJson } from "../../gate-harness.mjs";
import app from "../src/index.js";
import assert from "node:assert/strict";

test("POST /todos with empty body is rejected with 400", async () => {
  const response = await invoke(app, "/todos", postJson({}));
  assert.equal(
    response.status,
    400,
    "an empty create body must be rejected with 400, not accepted",
  );
});

test("POST /todos with a missing title is rejected with 400", async () => {
  const response = await invoke(app, "/todos", postJson({ done: false }));
  assert.equal(response.status, 400);
});

test("POST /todos with a valid title still succeeds", async () => {
  const response = await invoke(app, "/todos", postJson({ title: "buy milk" }));
  assert.equal(response.status, 201);
  const body = await readJson(response);
  assert.equal(body.title, "buy milk");
});

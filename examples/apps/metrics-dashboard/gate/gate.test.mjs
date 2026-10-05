// metrics-dashboard verification gate (T2): deterministic, offline, no network.
//
// Asserts the planted raw-average bug is fixed by importing the app's own fetch
// handler and observing the real Response: GET /metrics must report every
// average as a finite rounded number with NO null, and an empty series (errors)
// must be 0, not null/NaN. On the current (buggy) source this test FAILS, which
// is correct: the bug is still planted and the gate catches it. It PASSES only
// once each metric guards an empty series and rounds. The syntax/typecheck step
// lives in the app's `verify` npm script.

import { test } from "node:test";
import { invoke, readJson } from "../../gate-harness.mjs";
import app from "../src/index.js";
import assert from "node:assert/strict";

test("GET /metrics reports rounded averages with no null", async () => {
  const response = await invoke(app, "/metrics");
  assert.equal(response.status, 200);
  const body = await readJson(response);
  const metrics = body.metrics ?? {};
  const names = Object.keys(metrics);
  assert.ok(names.length > 0, "there must be at least one metric");

  for (const name of names) {
    const value = metrics[name];
    assert.notEqual(value, null, name + " average must not be null");
    assert.equal(
      typeof value === "number" && Number.isFinite(value),
      true,
      name + " average must be a finite number",
    );
    assert.equal(
      Number.isInteger(value) || value === Math.round(value * 100) / 100,
      true,
      name + " average must be rounded, not a long float tail",
    );
  }
});

test("GET /metrics reports 0 for an empty series", async () => {
  const response = await invoke(app, "/metrics");
  const body = await readJson(response);
  assert.equal(
    body.metrics.errors,
    0,
    "an empty series must report 0, not null",
  );
});

// metrics-dashboard gate-correctness proof (T9): proves the gate is a REAL
// signal, fully offline. It exercises the gate's assertion (every average is a
// finite rounded number, no null; empty series is 0) against three source
// variants of a metric average handler:
//   1. the buggy baseline  -> gate FAILS (empty series yields null, no rounding)
//   2. a correct one-line fix -> gate PASSES (0 for empty, rounded otherwise)
//   3. syntactically broken JS -> gate FAILS at the syntax/typecheck step
// No network, no wrangler, no child inference. Each variant is written to a
// throwaway temp module and imported, so the real source on disk is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const BUGGY_METRICS = `
export function makeApp() {
  const series = { latency: [120, 95, 143], errors: [] };
  function average(samples) {
    const sum = samples.reduce((a, b) => a + b, 0);
    return sum / samples.length;
  }
  return {
    async fetch() {
      const metrics = {};
      for (const [name, samples] of Object.entries(series)) {
        metrics[name] = average(samples);
      }
      return new Response(JSON.stringify({ metrics }), { status: 200 });
    },
  };
}
`;

const FIXED_METRICS = `
export function makeApp() {
  const series = { latency: [120, 95, 143], errors: [] };
  function average(samples) {
    if (samples.length === 0) return 0;
    const sum = samples.reduce((a, b) => a + b, 0);
    return Math.round((sum / samples.length) * 100) / 100;
  }
  return {
    async fetch() {
      const metrics = {};
      for (const [name, samples] of Object.entries(series)) {
        metrics[name] = average(samples);
      }
      return new Response(JSON.stringify({ metrics }), { status: 200 });
    },
  };
}
`;

const BROKEN_JS = "export function makeApp( { return ;;; }";

/** The gate predicate under test: finite rounded numbers, no null, empty -> 0. */
async function gatePasses(moduleUrl) {
  const { makeApp } = await import(moduleUrl);
  const app = makeApp();
  const response = await app.fetch(new Request("http://app.local/metrics"));
  const body = JSON.parse(await response.text());
  const metrics = body.metrics ?? {};
  for (const value of Object.values(metrics)) {
    if (value === null) return false;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    const rounded = Number.isInteger(value) || value === Math.round(value * 100) / 100;
    if (!rounded) return false;
  }
  return metrics.errors === 0;
}

async function withTempModule(source, run) {
  const dir = await mkdtemp(join(tmpdir(), "metrics-gate-"));
  const file = join(dir, "variant.mjs");
  await writeFile(file, source, "utf8");
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buggy baseline fails the gate (empty series yields null)", async () => {
  await withTempModule(BUGGY_METRICS, async (file) => {
    const passed = await gatePasses(pathToFileURL(file).href);
    assert.equal(passed, false, "buggy code must FAIL the gate");
  });
});

test("correct fix passes the gate (empty -> 0, rounded)", async () => {
  await withTempModule(FIXED_METRICS, async (file) => {
    const passed = await gatePasses(pathToFileURL(file).href);
    assert.equal(passed, true, "fixed code must PASS the gate");
  });
});

test("syntactically broken JS fails the syntax/typecheck step", async () => {
  await withTempModule(BROKEN_JS, async (file) => {
    assert.throws(
      () => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }),
      "broken JS must FAIL node --check",
    );
  });
});

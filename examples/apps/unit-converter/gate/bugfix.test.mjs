// unit-converter gate-correctness proof (T9): proves the gate is a REAL signal,
// fully offline. It exercises the gate's assertion (100C must yield 212F)
// against three source variants of the convert handler:
//   1. the buggy baseline  -> gate FAILS (missing +32, returns 180)
//   2. a correct one-line fix -> gate PASSES (c * 9 / 5 + 32 = 212)
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

const BUGGY_CONVERT = `
export function makeApp() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const c = Number(url.searchParams.get("c") ?? "0");
      const fahrenheit = (c * 9) / 5;
      return new Response(JSON.stringify({ celsius: c, fahrenheit }), { status: 200 });
    },
  };
}
`;

const FIXED_CONVERT = `
export function makeApp() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const c = Number(url.searchParams.get("c") ?? "0");
      const fahrenheit = (c * 9) / 5 + 32;
      return new Response(JSON.stringify({ celsius: c, fahrenheit }), { status: 200 });
    },
  };
}
`;

const BROKEN_JS = "export function makeApp( { return ;;; }";

/** The gate predicate under test: 100C must yield 212F. */
async function gatePasses(moduleUrl) {
  const { makeApp } = await import(moduleUrl);
  const app = makeApp();
  const response = await app.fetch(new Request("http://app.local/convert?c=100"));
  const body = JSON.parse(await response.text());
  return body.fahrenheit === 212;
}

async function withTempModule(source, run) {
  const dir = await mkdtemp(join(tmpdir(), "convert-gate-"));
  const file = join(dir, "variant.mjs");
  await writeFile(file, source, "utf8");
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buggy baseline fails the gate (returns 180, not 212)", async () => {
  await withTempModule(BUGGY_CONVERT, async (file) => {
    const passed = await gatePasses(pathToFileURL(file).href);
    assert.equal(passed, false, "buggy code must FAIL the gate");
  });
});

test("correct fix passes the gate (returns 212)", async () => {
  await withTempModule(FIXED_CONVERT, async (file) => {
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

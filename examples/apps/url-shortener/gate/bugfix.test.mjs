// url-shortener gate-correctness proof (T9): proves the gate is a REAL signal,
// fully offline. It exercises the gate's assertion (a known /s/<code> must
// redirect with 302 and a location) against three source variants of the
// redirect handler:
//   1. the buggy baseline  -> gate FAILS (status 200, not a redirect)
//   2. a correct one-line fix -> gate PASSES (status 302 with location)
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

const BUGGY_REDIRECT = `
export function makeApp() {
  const target = "https://example.com/landing";
  return {
    async fetch() {
      return new Response(null, { status: 200, headers: { location: target } });
    },
  };
}
`;

const FIXED_REDIRECT = `
export function makeApp() {
  const target = "https://example.com/landing";
  return {
    async fetch() {
      return new Response(null, { status: 302, headers: { location: target } });
    },
  };
}
`;

const BROKEN_JS = "export function makeApp( { return ;;; }";

/** The gate predicate under test: a redirect must be 302 with a location. */
async function gatePasses(moduleUrl) {
  const { makeApp } = await import(moduleUrl);
  const app = makeApp();
  const response = await app.fetch(
    new Request("http://app.local/s/abc", { redirect: "manual" }),
  );
  return response.status === 302 && response.headers.get("location") !== null;
}

async function withTempModule(source, run) {
  const dir = await mkdtemp(join(tmpdir(), "shortener-gate-"));
  const file = join(dir, "variant.mjs");
  await writeFile(file, source, "utf8");
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buggy baseline fails the gate (status 200, not a redirect)", async () => {
  await withTempModule(BUGGY_REDIRECT, async (file) => {
    const passed = await gatePasses(pathToFileURL(file).href);
    assert.equal(passed, false, "buggy code must FAIL the gate");
  });
});

test("correct fix passes the gate (status 302 with location)", async () => {
  await withTempModule(FIXED_REDIRECT, async (file) => {
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

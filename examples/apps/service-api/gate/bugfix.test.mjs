// service-api gate-correctness proof: proves the gate is a REAL signal, fully
// offline. It exercises the gate's core assertions (an unauthenticated write
// must be rejected, and an authenticated invalid write must yield 400) against
// three variants of a single resource handler:
//   1. the buggy baseline     -> gate FAILS (no auth, no validation)
//   2. a correct fix          -> gate PASSES (requireAuth + validation)
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

const DEMO_TOKEN = "demo-token";

const BUGGY = `
export function makeHandler() {
  const items = [];
  return async function handle(request) {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const name = typeof body.name === "string" ? body.name : "";
    const item = { id: String(items.length + 1), name };
    items.push(item);
    return new Response(JSON.stringify(item), { status: 201 });
  };
}
`;

const FIXED = `
export function makeHandler() {
  const items = [];
  return async function handle(request) {
    const header = request.headers.get("authorization") || "";
    const match = /^Bearer\\s+(.+)$/i.exec(header.trim());
    const token = match ? match[1].trim() : "";
    if (token !== "demo-token") {
      return new Response(JSON.stringify({ error: "authentication required" }), { status: 401 });
    }
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") {
      return new Response(JSON.stringify({ error: "name is required" }), { status: 400 });
    }
    const item = { id: String(items.length + 1), name };
    items.push(item);
    return new Response(JSON.stringify(item), { status: 201 });
  };
}
`;

const BROKEN_JS = "export function makeHandler( { return ;;; }";

/**
 * The gate predicate under test: an unauthenticated write must be rejected
 * (401/403) AND an authenticated invalid write must yield 400. Mirrors the real
 * gate's per-resource assertions.
 */
async function gatePasses(moduleUrl) {
  const { makeHandler } = await import(moduleUrl);
  const handle = makeHandler();

  const unauth = await handle(
    new Request("http://app.local/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ok" }),
    }),
  );
  const rejectsUnauth = unauth.status === 401 || unauth.status === 403;

  const invalid = await handle(
    new Request("http://app.local/items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + DEMO_TOKEN,
      },
      body: JSON.stringify({}),
    }),
  );
  const rejectsInvalid = invalid.status === 400;

  return rejectsUnauth && rejectsInvalid;
}

async function withTempModule(source, run) {
  const dir = await mkdtemp(join(tmpdir(), "service-api-gate-"));
  const file = join(dir, "variant.mjs");
  await writeFile(file, source, "utf8");
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buggy baseline fails the gate (no auth, no validation)", async () => {
  await withTempModule(BUGGY, async (file) => {
    const passed = await gatePasses(pathToFileURL(file).href);
    assert.equal(passed, false, "buggy code must FAIL the gate");
  });
});

test("correct fix passes the gate (requireAuth + validation)", async () => {
  await withTempModule(FIXED, async (file) => {
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

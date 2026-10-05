// todo-api gate-correctness proof (T9): proves the gate is a REAL signal, fully
// offline. It exercises the gate's assertion (empty POST body must yield 400)
// against three source variants of the create route:
//   1. the buggy baseline  -> gate FAILS (no validation, returns 201)
//   2. a correct one-line fix -> gate PASSES (rejects empty title with 400)
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

const BUGGY_CREATE = `
export function makeApp() {
  const todos = [];
  return {
    async fetch(request) {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const title = typeof body.title === "string" ? body.title : "";
      const todo = { id: String(todos.length + 1), title, done: false };
      todos.push(todo);
      return new Response(JSON.stringify(todo), { status: 201 });
    },
  };
}
`;

const FIXED_CREATE = `
export function makeApp() {
  const todos = [];
  return {
    async fetch(request) {
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title === "") {
        return new Response(JSON.stringify({ error: "title is required" }), { status: 400 });
      }
      const todo = { id: String(todos.length + 1), title, done: false };
      todos.push(todo);
      return new Response(JSON.stringify(todo), { status: 201 });
    },
  };
}
`;

const BROKEN_JS = "export function makeApp( { return ;;; }";

/** The gate predicate under test: empty POST body must yield 400. */
async function gatePasses(moduleUrl) {
  const { makeApp } = await import(moduleUrl);
  const app = makeApp();
  const response = await app.fetch(
    new Request("http://app.local/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  return response.status === 400;
}

async function withTempModule(source, run) {
  const dir = await mkdtemp(join(tmpdir(), "todo-gate-"));
  const file = join(dir, "variant.mjs");
  await writeFile(file, source, "utf8");
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buggy baseline fails the gate (empty body not rejected)", async () => {
  await withTempModule(BUGGY_CREATE, async (file) => {
    const passed = await gatePasses(pathToFileURL(file).href);
    assert.equal(passed, false, "buggy code must FAIL the gate");
  });
});

test("correct fix passes the gate (empty body rejected with 400)", async () => {
  await withTempModule(FIXED_CREATE, async (file) => {
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

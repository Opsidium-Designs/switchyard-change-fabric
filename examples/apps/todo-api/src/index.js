// todo-api: a tiny JSON todo API served by a single Cloudflare Worker.
//
// It serves an in-memory todo list over a small JSON API:
//   GET  /todos        list todos
//   POST /todos        create a todo from {"title": "..."}
//   GET  /todos/:id    read one todo
//
// THE PLANTED BUG (observable on the live response): POST /todos accepts a body
// with NO title and still creates a todo, so the list fills with empty-title
// items. The same missing-validation pattern is planted in the sibling route
// handlers under src/routes (each marked with FABRIC-FOLLOWUP), so fixing the
// create route reveals the identical fix is needed across the other handlers:
// this is the dynamic-branching example (fixing one thing reveals more work).
//
// THE FIX: reject a create with a missing or empty title with 400, and apply the
// same input guard across the sibling handlers.
//
// Observable before/after: before the fix, `POST /todos` with `{}` returns 201
// and a todo with an empty title; after, it returns 400 with a clear error.

import { handleCreate } from "./routes/create.js";
import { handleList } from "./routes/list.js";
import { handleGet } from "./routes/get.js";
import { handleHome } from "./routes/home.js";

/** The in-memory store (reset per isolate; this is a demo app). */
const TODOS = [];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((p) => p !== "");

    if (request.method === "GET" && parts.length === 0) {
      return handleHome();
    }
    if (parts[0] !== "todos") {
      return json({ error: "not found" }, 404);
    }
    if (request.method === "GET" && parts.length === 1) {
      return handleList(TODOS);
    }
    if (request.method === "POST" && parts.length === 1) {
      return handleCreate(TODOS, request);
    }
    if (request.method === "GET" && parts.length === 2) {
      return handleGet(TODOS, parts[1]);
    }
    return json({ error: "not found" }, 404);
  },
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

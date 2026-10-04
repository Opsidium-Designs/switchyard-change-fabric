// todo-api create route.
//
// FABRIC-FOLLOWUP: this handler does not validate its input. The create accepts
// a body with no title and still creates a todo, so the list fills with
// empty-title items. The fix rejects a missing/empty title with 400. The same
// pattern is planted in the sibling handlers so fixing this one reveals the rest.

import { json } from "../index.js";

export async function handleCreate(todos, request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // The planted bug: no validation. A fix guards title here.
  const title = typeof body.title === "string" ? body.title : "";
  const todo = { id: String(todos.length + 1), title, done: false };
  todos.push(todo);
  return json(todo, 201);
}

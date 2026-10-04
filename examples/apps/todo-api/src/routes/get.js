// todo-api get route.
//
// FABRIC-FOLLOWUP: this handler does not validate the id. A fix adds the same
// input guard (reject a malformed id with 400 instead of returning 404 for
// everything), the same validation work the create handler needs.

import { json } from "../index.js";

export function handleGet(todos, id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) {
    return json({ error: "not found" }, 404);
  }
  return json(todo);
}

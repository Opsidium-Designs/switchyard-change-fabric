// todo-api list route.
//
// FABRIC-FOLLOWUP: this handler does not validate its query input. A fix adds
// the same input guard the create handler needs (reject an unknown filter), so
// the identical validation work is revealed here once the create route is fixed.

import { json } from "../index.js";

export function handleList(todos) {
  return json({ todos });
}

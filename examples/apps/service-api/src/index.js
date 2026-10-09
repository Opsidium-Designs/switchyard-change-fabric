// service-api: a multi-resource JSON API served by one Cloudflare Worker.
//
// It exposes several INDEPENDENT resources, each owned by its own module under
// src/resources, over a small JSON API:
//   /users          create and list users
//   /orders         create and list orders
//   /products       create and list products
//   /auth           create and list API sessions
//   /search         search by query term
//   /notifications  send and list notifications
//
// Two FROZEN shared contracts sit at the seams every resource imports:
//   src/contracts/auth.js      requireAuth(request)
//   src/contracts/response.js  json(), problem(), readBody()
// Resource owners HONOR these contracts; they do not rewrite them.
//
// THE PLANTED GAP (observable on the live responses): every resource currently
// skips input validation and does NOT call requireAuth, so unauthenticated and
// invalid requests wrongly succeed. Each resource carries a FABRIC-FOLLOWUP
// note. The fix is per-resource and independent: each module validates its
// inputs and calls the shared requireAuth, returning 401 for an unauthenticated
// request and 400 for an invalid one. Because the fix is the same shape across
// resources but each resource owns its own, this is the honest many-agent case.
//
// Observable before/after per resource, for example: before the fix, POST
// /users with no auth header and an empty body returns 201; after, an
// unauthenticated request returns 401 and a bad body returns 400.

import { json, problem } from "./contracts/response.js";
import { handle as users } from "./resources/users.js";
import { handle as orders } from "./resources/orders.js";
import { handle as products } from "./resources/products.js";
import { handle as auth } from "./resources/auth.js";
import { handle as search } from "./resources/search.js";
import { handle as notifications } from "./resources/notifications.js";
import { PAGE } from "./ui.js";

/** The resource registry: path segment to its owning module's handler. */
const RESOURCES = {
  users,
  orders,
  products,
  auth,
  search,
  notifications,
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((p) => p !== "");

    if (request.method === "GET" && parts.length === 0) {
      return home();
    }

    const handler = RESOURCES[parts[0]];
    if (!handler) {
      return problem(404, "not found");
    }
    return handler(request, parts);
  },
};

// Re-export the frozen response helpers so a reader of the entry file sees the
// shared contract the resources depend on. The resources import them directly
// from ./contracts/response.js.
export { json, problem };

/** The interactive tester page (src/ui.js), browser-visible at GET /. */
function home() {
  return new Response(PAGE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

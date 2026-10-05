# service-api

A multi-resource JSON API served by one Cloudflare Worker. It is deliberately
modular: each resource is owned by its own file under `src/resources`, and two
frozen shared contracts under `src/contracts` sit at the seams every resource
imports.

## Resources

| Resource | Routes |
|----------|--------|
| users | `GET /users`, `POST /users {"email"}` |
| orders | `GET /orders`, `POST /orders {"sku","qty"}` |
| products | `GET /products`, `POST /products {"name","price"}` |
| auth | `GET /auth`, `POST /auth {"label"}` (API sessions) |
| search | `GET /search?q=term` |
| notifications | `GET /notifications`, `POST /notifications {"to","message"}` |

`GET /` serves a small browser-visible page listing the resources.

## The frozen shared contracts

Two seams every resource imports and must HONOR, not rewrite:

- `src/contracts/auth.js` exports `requireAuth(request)`, which returns a `401`
  `Response` when the request lacks a valid bearer token, or `null` when it is
  authorized.
- `src/contracts/response.js` exports `json(body, status)`, `problem(status,
  detail)`, and `readBody(request)`, so the whole service speaks one response
  shape.

## The planted gap and the fix

Every resource currently skips input validation and does NOT call `requireAuth`,
so unauthenticated and invalid requests wrongly succeed. Each resource file
carries a `FABRIC-FOLLOWUP` note at the exact spot.

The fix is per-resource and independent: each module calls `requireAuth(request)`
first (returning the `401` when it is non-null) and validates its inputs
(returning `problem(400, ...)` on bad input). Because the fix shape is shared but
each resource owns its own, this is the honest many-agent case over a shared
frozen contract.

Observable before/after, for example on `users`:

- before: `POST /users` with no `Authorization` header and an empty body returns
  `201`.
- after: an unauthenticated request returns `401`, and a body with no `email`
  returns `400`.

## Verify

The gate is deterministic and offline (it imports the Worker handler and asserts
on the real `Response`, no network, no wrangler):

```bash
npm run gate     # typecheck + the authoritative per-resource gate
npm run verify   # gate + the gate-correctness proof
```

The gate keeps per-resource assertions, so a partial fix (one resource fixed,
another still open) fails until every resource validates input and requires auth.

## Deploy and tear down

See [`docs/LIVE-DEPLOY.md`](../../../docs/LIVE-DEPLOY.md):

```bash
make deploy-app APP=service-api
make delete-app APP=service-api
```

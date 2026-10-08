# Deploy an example web app to a live Cloudflare URL

This is the deploy-to-live-URL hop: take a tiny real Worker in
`examples/apps/<name>` and put it on a public, clickable `workers.dev` URL in one
command, then tear it down so it stops billing. The reference example is
[`examples/apps/service-api`](../examples/apps/service-api/README.md), a
multi-resource JSON API whose every resource carries a deliberate, observable gap
(it skips input validation and the shared auth check) so a before/after is obvious
on the live service.

## What path this uses and why

It uses `wrangler deploy` to a `workers.dev` URL. That path is fully scriptable,
deterministic, and single-command, and it yields the reachable live URL directly.
Cloudflare's native build-and-deploy-on-push product is a nicer long-term option
for per-branch preview URLs, but its repository connection and preview enablement
are bootstrapped through the dashboard today (only the build operations are
scriptable over the REST API) and its production branch is pinned in the current
beta, so it is not the right fit for a one-command live-URL hop yet.

## Prerequisites

- Node.js and npm (same as the rest of the repository).
- A Cloudflare account and a scoped API token with Workers edit permission.

Put the token and account id in a gitignored `.env` at the repository root (copy
`.env.example` to `.env` and fill it in):

```
CLOUDFLARE_ACCOUNT_ID=<your account id>
CLOUDFLARE_API_TOKEN=<your scoped token>
```

The `.env` file is gitignored and must never be committed. The `make` targets
source it for you; nothing prints the token. As an alternative to the token you
can run `npx wrangler login` once and skip the `.env` entry.

## Deploy

From the repository root:

```bash
make deploy-app APP=service-api
```

This sources `.env` and runs `npx wrangler deploy` in `examples/apps/service-api`.
On success wrangler prints the live URL, of the form:

```
https://<worker-name>.<your-subdomain>.workers.dev
```

For the reference example the worker name is
`switchyard-change-fabric-service-api`, so the URL is
`https://switchyard-change-fabric-service-api.<your-subdomain>.workers.dev`.

Note: the first ever deploy to a brand-new `workers.dev` subdomain can briefly
return `523` for about a minute while the subdomain propagates. Wait and retry.

## Verify the fix is live

```bash
URL=https://switchyard-change-fabric-service-api.<subdomain>.workers.dev
# unauthenticated write: fixed -> 401, buggy -> 201
curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$URL/users" \
  -H "content-type: application/json" -d '{"email":"a@example.com"}'
```

Open the same URL in a browser: `GET /` renders a styled page listing the
resources. With the fix, an unauthenticated or invalid request to any resource is
rejected (401 or 400); with the planted gap it wrongly succeeds.

## Tear it down (stop billing)

```bash
make delete-app APP=service-api
```

This reads the worker name from the app's `wrangler.jsonc` and deletes the worker
over the Cloudflare REST API using `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` from `.env`, which removes it and its live URL. It is
idempotent: a worker that is already gone is reported and treated as success. The
REST path is used because a narrowly scoped deploy token can deploy but may lack
the account membership read that plain `wrangler delete` performs. If your token
has full account permissions you can also run `npx wrangler delete` directly from
the app directory (add `--dry-run` to preview):

```bash
cd examples/apps/service-api && npx wrangler delete --dry-run
```

## Deploy a different example app

Both targets take `APP=<dir>` pointing at a subdirectory of `examples/apps/`:

```bash
make deploy-app APP=<your-app>
make delete-app APP=<your-app>
```

Each app is standalone (its own `package.json` and `wrangler.jsonc`), so
deploying it does not touch the offline demo or the root `make check`.

## The console flow: Deploy, fix, redeploy in place, tear down

In the console an app template is driven as a legible sequence, built on the same
deploy hop above:

1. **Deploy (see it broken).** The per-app "Deploy app" button deploys the app in
   its CURRENT (broken) state to its STABLE live URL and surfaces that clickable
   URL. The stable worker name is derived from the app
   (`switchyard-change-fabric-<app>`), not a per-run id, so the URL is fixed.
2. **Launch the fix.** Launching the template starts a run. The run NEVER deploys
   fresh. Only a `verified` integration verdict is promoted to Git (a
   `switchyard/<change-id>` branch). When the app was already deployed in step 1,
   the run then REDEPLOYS IN PLACE to the same stable name from a checkout of the
   PROMOTED commit (the exact tree the gate passed, never the unfixed app
   directory), so the SAME URL now serves the fixed app. A failed or cannot-pass
   verdict is neither promoted nor redeployed. If no Deploy happened first, the
   run deploys nothing: a verified fix is still promoted to Git, and the console
   simply shows no live URL.
3. **Tear down.** The "Tear down" control deletes the run's real Artifact repos
   and, when the app was deployed, the app's stable deployed Worker, so nothing
   leaks.

Under the hood a manual Deploy records a small, gitignored per-app marker under
`.deployments/<app>.json` holding only the public URL (never a secret). The run
reads it to decide whether to redeploy in place, and teardown clears it. The
`switchyard-change deploy-app --app <name>` and
`switchyard-change cleanup-live --change-id <id> --app <name>` commands are the
CLI equivalents the console launcher calls.

## Protecting the control-plane Worker (optional API token)

The control-plane Worker (`apps/worker`) is unauthenticated by default, which is
fine for `make dev-all` on localhost. Before you deploy it (`make deploy` /
`make infra-up`) or expose it on a LAN, set the optional `SWITCHYARD_API_TOKEN`
Worker secret. When it is set, every mutating route, including every route that
returns a plaintext Artifact write token (lease, round lease, recruit, fail,
repo-pushed), requires `authorization: Bearer <token>`; the read-only snapshot
GETs stay open so the console can poll. When it is unset the Worker behaves as
before.

Set it out of band; it is a secret, never a committed value:

```
# deployed Worker
npx wrangler secret put SWITCHYARD_API_TOKEN      # run in apps/worker

# local wrangler dev: a gitignored apps/worker/.dev.vars
SWITCHYARD_API_TOKEN=<a long random value>
```

Every caller that mutates state must send the same value as
`authorization: Bearer <token>` (for the CLI/run-live driver, keep it in the
gitignored root `.env`, never in a committed file). The browser console never
holds the token, because anything bundled into the page is readable by whoever
loads it: it sends its mutations (resolving an escalation) to the dev
launcher's `/api/worker/changes/...` proxy, which reads `SWITCHYARD_API_TOKEN`
from the dev process environment (`make dev-all` sources the root `.env`) and
adds the bearer server-side. It falls back to posting the Worker directly only
when no such proxy answers (which only works while the Worker's auth is off).

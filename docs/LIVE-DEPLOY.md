# Deploy an example web app to a live Cloudflare URL

This is the deploy-to-live-URL hop: take a tiny real Worker in
`examples/apps/<name>` and put it on a public, clickable `workers.dev` URL in one
command, then tear it down so it stops billing. The reference example is
[`examples/apps/hello-fix`](../examples/apps/hello-fix/README.md), which carries
one deliberate, observable bug (wrong `Content-Type`) so a before/after is obvious
on the live page.

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
make deploy-app APP=hello-fix
```

This sources `.env` and runs `npx wrangler deploy` in `examples/apps/hello-fix`.
On success wrangler prints the live URL, of the form:

```
https://<worker-name>.<your-subdomain>.workers.dev
```

For the reference example the worker name is
`switchyard-change-fabric-hello-fix`, so the URL is
`https://switchyard-change-fabric-hello-fix.<your-subdomain>.workers.dev`.

Note: the first ever deploy to a brand-new `workers.dev` subdomain can briefly
return `523` for about a minute while the subdomain propagates. Wait and retry.

## Verify the fix is live

```bash
curl -sS -D - -o /dev/null https://switchyard-change-fabric-hello-fix.<subdomain>.workers.dev | grep -i content-type
# fixed:   content-type: text/html; charset=utf-8
# buggy:   content-type: text/plain; charset=utf-8
```

Open the same URL in a browser: with the fix it renders as a styled page; with
the planted bug the raw HTML markup shows as plain text.

## Tear it down (stop billing)

```bash
make delete-app APP=hello-fix
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
cd examples/apps/hello-fix && npx wrangler delete --dry-run
```

## Deploy a different example app

Both targets take `APP=<dir>` pointing at a subdirectory of `examples/apps/`:

```bash
make deploy-app APP=<your-app>
make delete-app APP=<your-app>
```

Each app is standalone (its own `package.json` and `wrangler.jsonc`), so
deploying it does not touch the offline demo or the root `make check`.

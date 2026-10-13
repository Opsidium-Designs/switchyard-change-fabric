# Deploy an example web app to a live Cloudflare URL

This is the deploy-to-live-URL hop: take a tiny real Worker in
`examples/apps/<name>` and put it on a public, clickable `workers.dev` URL in one
command, then tear it down so it stops billing. The reference example is
[`examples/apps/service-api`](../examples/apps/service-api/README.md), a
multi-resource JSON API whose every resource carries a deliberate, observable gap
(it skips input validation and the shared auth check) so a before/after is obvious
on the live service. The second example,
[`examples/apps/storefront`](../examples/apps/storefront/README.md), is a
TypeScript Worker (wrangler bundles it as is) and deploys the same way with
`APP=storefront`.

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
   URL, labelled as the original code before any fix. The card shows the status
   (deploying, deployed, removing, or failed with the CLI's own error). The
   stable worker name is derived from the app
   (`switchyard-change-fabric-<app>`), not a per-run id, so the URL is fixed.
2. **Launch the fix.** Launching the template starts a run. The run NEVER deploys
   fresh. Only a `verified` integration verdict is promoted to Git (a
   `switchyard/<change-id>` branch). When the app was already deployed in step 1,
   the run then REDEPLOYS IN PLACE to the same stable name from a checkout of the
   PROMOTED commit (the exact tree the gate passed, never the unfixed app
   directory), so the SAME URL now serves the fixed app. A failed or cannot-pass
   verdict is neither promoted nor redeployed. If no Deploy happened first, the
   run deploys nothing: a verified fix is still promoted to Git, and the console
   simply shows no live URL. A board run launched while the app is deployed also
   gets `--preview-revisions`: every integrated revision is uploaded as a Worker
   VERSION under a preview alias (never a production deploy), and the run panel
   links the latest revision whose gate passed as "Open the fixed app" (only a
   preview whose commit matches the board log's revision is ever linked).
3. **Tear down (repos).** Once the run has exited, the "Tear down (repos)"
   control (it asks first) deletes the run's real Artifact repos. It is disabled
   while the run is still running and hidden for a run followed read-only with
   `?watch=<id>`. It leaves the deployed app alone.
4. **Remove app.** The card's "Remove app" control (it asks first, naming the app
   and URL) deletes the app's stable Worker, and with it the revision previews
   that are versions of it, and clears its marker. No run's repos are touched.
   It is disabled while a launched run of that app is still running.

Under the hood a manual Deploy records a small, gitignored per-app marker under
`.deployments/<app>.json` holding only the public URL (never a secret). The run
reads it to decide whether to redeploy in place, and teardown clears it. The
console launcher calls these CLI commands (from the repo root, with no
credential in their environment; the CLI reads `.env` itself):

| Console control | Spawned command |
|-----------------|-----------------|
| Deploy app | `npm -w apps/cli run dev -- deploy-app --app <app> --worker <worker url>` |
| Remove app | `npm -w apps/cli run dev -- teardown-app --app <app>` |
| Tear down (repos) | `npm -w apps/cli run dev -- cleanup-live --change-id <id> --worker <worker url>` |

`teardown-app` runs `wrangler delete` in `examples/apps/<app>` and fails (keeping
the marker) on any error other than the Worker already being gone; if a scoped
token cannot run `wrangler delete`, `make delete-app APP=<app>` deletes it over
the REST API instead. `cleanup-live --app <app>` still tears an app down
together with a run's repos from the CLI.

## Protecting the control-plane Worker (API token, fail-closed)

The control-plane Worker (`apps/worker`) is fail-closed: with no
`SWITCHYARD_API_TOKEN` set it REFUSES every mutating route (401) unless the
Worker var `SWITCHYARD_ALLOW_UNAUTHENTICATED=1` explicitly opts in to an
unauthenticated control plane. The local dev targets (`make dev`, `make
dev-containers`, `make dev-all`, `make dev-all-lan`) pass that opt-in to
`wrangler dev` (`--var SWITCHYARD_ALLOW_UNAUTHENTICATED:1`, through the
Makefile's `WORKER_DEV_VARS`; set `WORKER_DEV_VARS=` to run local dev closed),
so the local loop on localhost needs no credential. It is deliberately not
declared in `wrangler.jsonc`, so `make deploy` / `make infra-up` never inherit
it: a deployed Worker without the token answers only the read-only GETs. Never
set the opt-in on a deployed Worker.

Before you deploy the Worker or expose it on a LAN, set the
`SWITCHYARD_API_TOKEN` Worker secret. When it is set (whether or not the
opt-in is), every mutating route, including every route that returns a
plaintext Artifact write token (lease, round lease, recruit, fail,
repo-pushed), requires `authorization: Bearer <token>`. The read-only snapshot
GETs stay open either way, so the console can poll. An agent's own board post
authenticates with its board token, not the bearer, in both modes.

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
when no such proxy answers (which only works while the Worker runs with no token
and the local-dev opt-in).

## Integration on Cloudflare

A board run can leave integration to the control-plane Worker instead of the
driver process: `run-board --integrator cloud` (or `make run-board
INTEGRATOR=cloud`). The full flow, the routes, and the job format are in
[`docs/BOARD.md`](BOARD.md) ("Integration on Cloudflare"); this section is the
operator's view.

### How it works

- Every `push.announced` on the board starts (or coalesces into) the Change's
  `IntegrationWorkflow`. Its steps plan the next revision from the board, mint
  short-lived Artifact tokens Worker-side, run the integration job in a
  Cloudflare Container owned by the `GateRunner` Durable Object (one per
  Change), revoke the tokens, record the revision through the board's own
  integration path, and fast-forward the integration branch after a gated pass.
- The container image (`apps/worker/containers/gate/Dockerfile`) is
  `node:24.21.0-bookworm-slim` with git, CA certificates, util-linux and
  coreutils, plus the repo's `verification`, `artifact-workspace`, and
  `change-core` sources run directly with Node's type stripping (no bundler).
  It is built from the repository root; the root `.dockerignore` admits only
  those sources and `node_modules/yaml`.
- Every job runs in a fresh container (destroyed afterwards, success or
  failure; a job refuses to start in a container that is not clean). The
  install and the gate run as an unprivileged user capped at 512 processes,
  with a per-job HOME and temp dir; every process of that user is killed
  (`kill(-1)` as that user) after the install and after the gate, and the job
  refuses (transient, no verdict, no push) if one survives. Before any
  credentialed phase both sides check that no such process is alive.
- The gate command, the contract, and the baseline inventory are fixed at
  goal time: the configuration is accepted once, before the goal is posted,
  and a later change is refused.
- The container never holds a credential. It starts with internet access off;
  the GateRunner registers its `GateEgress` entrypoint (through `ctx.exports`,
  the `enable_ctx_exports` compatibility flag) as the HTTPS handler for the
  Artifacts host and the package registry, and the handler adds the
  repo-scoped token to the requests the current phase allows. The container
  trusts Cloudflare's egress CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`)
  once interception is registered.

### Egress phases

| Phase | Reachable from the container |
|---|---|
| `fetch` | the Artifacts host, only the job's repos (token added by the handler) |
| `deps` | the package registry only (GET/HEAD, no credential); `npm ci --ignore-scripts` as an unprivileged user |
| `gate` | nothing; the gate runs as the unprivileged user, and only after the deny-all probe found no route out |
| `push` | the Artifacts host again, after every process of the unprivileged user was killed: the gated commit is pushed to its candidate ref |
| `closed` | nothing (between jobs) |

Each revision attempt records the phases it ran under (`GET
/changes/:id/integration/cloud`).

At the start of the `gate` phase, before acknowledging it, the GateRunner runs
a cheap deny-all probe inside the container: as the sandbox user, a raw TCP
connect (3 s limit) to public IPs (`1.1.1.1:443`, `8.8.8.8:53`; by IP, so no DNS
and no intercepted host is involved). If any connect succeeds, the job is
refused before any agent code runs, with the reason "egress not isolated"; the
Workflow treats it as a failure to run (retried, then recorded as transient),
never as a verdict. The probe's logic is covered offline by the driver's fake
container; the probe itself runs only in a real container.

Every job is idempotent by its key: the Change, the base commit, the pinned
commits, every gate-defining field (the integration repo and branch, the gate
command, whether a gate is required, the protected paths and JSON keys, the
baseline test inventory, the accepted contracts, the gate support files, the
timeouts, the identity), and the configuration's time as a run nonce. The
advance is keyed by the integration repo and branch, the base the revision was
built on, the commit, and the revision's key. The GateRunner keeps at most 64
finished outcomes for replay (the oldest are pruned), and a re-created Change
clears them.

The Workflow mints a job's Artifact tokens once, before the job starts, with a
lifetime of the job's deadline plus 2 minutes, capped at one hour. A
configuration whose deadline (`installMs + gateMs` plus 5 minutes of overhead)
would outlive that is refused when it is posted: keep `installMs + gateMs` at
or under 53 minutes.

### Local development (Docker)

`make dev` runs the Worker WITHOUT the gate container (no Docker needed; the
cloud integrator then reports that the container is unavailable, and the local
integrator is unaffected). `make dev-containers` runs `wrangler dev` with
containers enabled: wrangler builds the image with Docker on start and runs
the container locally, with the same interception and egress handler. The
Artifacts binding stays `remote: true`, so the repos are real Artifact repos
(authenticate with the `.env` token as for `make dev`).

Measured locally (wrangler 4.149.0, Docker): two agents with one pinned push
each, a fixture whose gate needs a lockfile dependency and probes the network.
The first push started the Workflow and the second coalesced; revision 1
(the first push alone) failed and asked for a fix, revision 2 (both pushes)
passed and the integration branch was advanced to its gated commit. From the
fetch phase to the recorded revision each job took 9 to 13 s (the fetch phase
3.6 to 5.6 s, the deps phase about 2.3 s of which `npm ci` was 0.9 s, the gate
phase about 2 s, the push under 1 s); the whole run, from the first push to
the advanced branch, took 34 s on a warm image. During the gate: `example.com` did not resolve, the registry and the
Artifacts host answered 403 from the egress handler, a raw IP connection
failed. The gate ran as the sandbox user and saw no credential in its
environment, `.git/config`, or any readable `/proc/*/environ`. The driver's
promotion pinned the gated commit from the Artifact repo and verified the
tree.

Adversarial checks, measured the same way (sandbox uid 64321, a fresh
container per job):
- a gate that leaves a detached, respawning child behind: every revision was
  still recorded normally, with the leftover sandbox processes killed before
  the push phase (2 per job on a fast gate, 374 on a gate that ran 20 s; the
  process cap held the respawner below 512);
- a gate that hangs past its timeout (20 s): killed, the revision recorded as a
  failing gate ("exit none", with the inventory shortfall named), and the next
  job's container passed the clean check;
- a gate that plants `~/.npmrc` (`node-options=--require ...`) and files in
  `/tmp`, `/var/tmp`, `/dev/shm`: the next job found none of them (its HOME and
  temp dir are inside its own job root, and it runs in a fresh container);
- changing the gate command to `true` after the goal: refused with `409`;
- after every job the container was gone (destroyed), and after `wrangler
  dev` stopped no container or sidecar was left.

Local `wrangler dev` runs the gate container in the HOST's PID namespace
(observed: `PidMode: host`). That is why the sandbox has a dedicated uid
(64321) that no host account uses: with a uid the host also uses, the sandbox
checks would count, and its `kill(-1)` would target, the host user's processes
(Docker's AppArmor profile blocks such signals, but nothing should depend on
it). It also means a gate run under local dev can list host processes and
their command lines; deployed containers have their own PID namespace.

### Limits and what stays local

- Deployed behavior is not verified yet: everything above ran under `wrangler
  dev` (the Workflow, the Durable Object, the egress interception, and the
  container all local; only Artifacts was remote). Deploying needs the
  container image pushed to Cloudflare's registry (`wrangler deploy` builds
  and pushes it) and a plan with Containers.
- Only the npm registry is reachable in the deps phase (pnpm and yarn
  lockfiles resolve there too); a gate that needs other registries, Python or
  Go modules fails honestly under the deny policy.
- One container per Change (`max_instances` caps concurrent Changes); a
  Durable Object reset or a hot reload kills the container and the step is
  retried (every step is idempotent by the job key).
- Attribution: the same parse as the local integrator runs in the Workflow;
  with a decision model the run's advisory typed-decision choice narrows it
  (the Workflow waits up to 3 minutes for it, then records with the parse).
- No PID namespace: `unshare --pid` is not permitted in the container, so the
  sandbox is contained by its own uid, the process cap, `kill(-1)`, the
  survivor checks, and a fresh container per job.
- With `SWITCHYARD_API_TOKEN` unset, these routes are refused unless the
  local-dev opt-in (`SWITCHYARD_ALLOW_UNAUTHENTICATED=1`, which the dev
  targets set) is on; with it on, anyone who can reach the Worker can use
  them: keep it on localhost, or set the token before `make dev-all-lan` or a
  deploy (see "Protecting the control-plane Worker").
- What stays local: the planner, the agents' turns and edits, the baseline
  test inventory (the driver runs the gate once on the baseline and posts the
  inventory with the configuration), the final verdict post, promotion (pin
  and verify the gated commit), and any redeploy.

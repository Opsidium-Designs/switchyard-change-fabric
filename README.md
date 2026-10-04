# Switchyard Change Fabric

**Agent-native change coordination on Cloudflare.** A local-first coordinator that
takes a Git repository plus a *Change* specification, creates isolated Cloudflare
Artifact repositories for concurrent **WorkUnits**, runs local execution runners
against them, tracks dependencies and conflicts, verifies the outputs, integrates
verified work, and promotes the result back into ordinary Git.

> Branches are implementation details. **Changes** are the unit of agentic
> software development.

Built for Cloudflare's "Build the next Git platform" challenge, and designed to
run from a workstation.

## Status

Early spike / work in progress. Interfaces and layout will change.

## What it does

Traditional Git assumes a small number of humans making branches and pull
requests. Agentic development can spawn many independent workers at once, so the
hard problem becomes **coordination, isolation, integration, verification, and
deciding what should ship**. Switchyard Change Fabric treats a *Change* as the
first-class object above branches/PRs:

- a **Change** decomposes into concurrent **WorkUnits** with declared dependencies;
- each WorkUnit gets its own isolated **Cloudflare Artifact** Git repository with a
  short-lived, repo-scoped credential;
- local **execution runners** clone the Artifact, invoke the chosen executor, run
  tests, and push results;
- the fabric tracks **path conflicts / write leases**, runs **deterministic
  verification**, combines verified work in an **integration** workspace, and
  **promotes** one coherent result back to local Git.

Model inference is remote and pluggable; the coordinator spends additional
inference only when evidence says it is useful (collaborative concurrency, not
three frontier models redoing the same task).

## Architecture (local-first)

```text
Developer workstation
  ├─ CLI  +  local React console
  ├─ wrangler dev  →  Worker + Workflow + Durable Object/Agent state (local)
  ├─ local execution runners  (Git/tools/tests; invoke the selected executor)
  ├─ remote binding ───────────────▶ Cloudflare Artifacts (real)
  └─ AI Gateway / Workers AI ───────▶ remote inference (when selected)
```

The Cloudflare Worker/Workflow/Agent state runs locally under Wrangler while the
**Artifacts binding uses the real remote service** (`remote = true`) once you have
run `wrangler login`.

Without Cloudflare credentials the flow still runs end to end: the workspace
provider degrades to an honest, clearly-labelled local fallback (a bare Git repo
reachable over a `file://` URL, marked `backend: "local-filesystem"` and
`fallback: true`), and a deterministic `noop` executor makes a trivial, zero
inference edit. This keeps the clone, execute, commit, and push loop testable and
demoable offline, and it never pretends to be the real Artifacts service.

## Executor modes

Inference choice is explicit, never surprising:

| Mode | Flag | Needs |
|------|------|-------|
| Codex CLI | `--executor codex` | an already-authenticated Codex CLI (no API key) |
| Switchyard / AI Gateway (BYOK) | `--executor switchyard-gateway --model <provider/model>` | a provider key stored in Cloudflare AI Gateway |
| Workers AI | `--executor workers-ai --model <model>` | a Cloudflare account only |

The Change model, workspace lifecycle, verification, and integration behave
identically regardless of executor.

## Requirements

For the offline demo (`make demo`) you need only:

- Node.js (version 20 or newer) and Git

To reach the real Cloudflare services you additionally need:

- A Cloudflare account with Workers + Artifacts access (Artifacts is in open beta)
- One inference path: an authenticated Codex CLI, **or** a provider key in AI
  Gateway, **or** sufficient Cloudflare credits for Workers AI / Unified Billing
- Docker (only if the optional containerized verifier is used)

You do **not** need a production Cloudflare deploy, a Cloudflare account, or a
local GPU/model server to run the example end to end.

## Getting started (clone and run)

A fresh clone runs the full example Change end to end offline, with no Cloudflare
account and no model inference:

```bash
git clone <this-repo>
cd switchyard-change-fabric
make install
make doctor            # readiness report: Node, Git, wrangler, auth, executors
make demo              # run the example Change end to end (offline, deterministic)
```

`make demo` runs the example audit-logging Change through orchestration, local
runners, deterministic verification, integration, write-lease conflict
coordination, and local Git promotion, then prints a readable summary that ends
in a promoted local Git commit. It uses the deterministic `noop` executor and the
honest local-filesystem fallback, so the same run always produces the same result.

Other common tasks are in the `Makefile`: `make check` (typecheck + build +
test), `make example` (lint/build/test the example project), `make cli
ARGS="status examples/changes/audit-logging.change.yaml"` (print a Change's
planned WorkGraph and schedule), `make dev-all` (run the Worker under
`wrangler dev` plus the console, for exploring the real Cloudflare path after
`npx wrangler login`).

The CLI mirrors these:

```bash
make cli ARGS="doctor"                                                 # readiness report
make cli ARGS="status examples/changes/audit-logging.change.yaml"      # plan + schedule
make cli ARGS="run examples/changes/audit-logging.change.yaml"         # run end to end
make cli ARGS="promote examples/changes/audit-logging.change.yaml"     # run and promote
```

## The example Change

The seeded example lives in two files:

- [`examples/changes/audit-logging.change.yaml`](examples/changes/audit-logging.change.yaml):
  a Change that adds organization-level audit logging. It declares three
  WorkUnits with one dependency (`api` depends on `model`) and one deliberate
  path collision (`api` and `tests` both declare `src/audit/events.ts`), which is
  what drives the coordination demo.
- [`examples/demo-project/`](examples/demo-project/README.md): the small
  standalone TypeScript service the Change targets.

## Running against real Cloudflare Artifacts

The offline demo above never touches the network. To run the same flow against
**real Cloudflare Artifacts** (isolated remote Git repos per WorkUnit, with
short-lived scoped credentials), set up Cloudflare once and then start the Worker
locally with the Artifacts binding pointed at the real service.

### 1. Prerequisites

- A **Cloudflare account**. Workers and **Artifacts** must be enabled for it.
  Artifacts is in **open beta**, so your account/plan has to have access; if the
  binding calls fail with an access error, this is the first thing to check.
- **Node.js 20+**, **Git**, and this repo installed (`make install`).
- Wrangler is already a dev dependency of this repo, so you do not need a global
  install; the commands below use `npx wrangler`.

### 2. Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser OAuth flow and stores a token identifying your Cloudflare
account. It is required because the Artifacts binding is configured with
`remote = true`: even though the Worker runs locally, the create-repo /
issue-token / delete calls go to the real Cloudflare service and must be made on
behalf of your account.

As a non-interactive alternative to `wrangler login`, you can export a scoped
`CLOUDFLARE_API_TOKEN` (with Workers + Artifacts permissions) and
`CLOUDFLARE_ACCOUNT_ID`. Put them in a git-ignored `.env` (see `.env.example`);
`make dev` and `make doctor` source `.env` automatically, and any `npx wrangler`
call picks the token up from the environment.

Verify it worked:

```bash
npx wrangler whoami      # should print your account/email or API-token account
make doctor              # "Cloudflare auth" and "Artifacts namespace" should read ok
```

### 3. Point the Artifacts binding at your account

The Artifacts binding lives in [`apps/worker/wrangler.jsonc`](apps/worker/wrangler.jsonc):

```jsonc
"artifacts": [
  {
    "binding": "ARTIFACTS",
    "namespace": "switchyard-change-fabric",
    "remote": true
  }
]
```

- The `namespace` is `switchyard-change-fabric`. An Artifacts namespace is
  created **implicitly** the first time a repository is created under it: there is
  no separate `namespaces create` command (confirm with
  `npx wrangler artifacts namespaces --help`, which exposes only `list` and
  `get`). So you do not pre-create it; the first repo the fabric (or the smoke
  loop below) creates brings the namespace into existence. Change the value only
  if you want your repos grouped under a different namespace name.
- Leave `remote: true` so local `wrangler dev` uses the real remote Artifacts
  service rather than a local stand-in.

No secrets go in this file. The scoped Git tokens the fabric uses are issued at
runtime by Artifacts and are short-lived; nothing is committed to the repo.

### 4. (Optional) Configure an inference path

The default executor is `noop` (a deterministic, zero-inference edit), which is
all the example needs. To have a WorkUnit call a real model, pick one executor
and provide its credential yourself (copy `.env.example` to `.env` first):

| Executor | How to enable |
|----------|---------------|
| `codex` | Have the Codex CLI already authenticated; select `--executor codex`. No API key stored here. |
| `switchyard-gateway` (AI Gateway BYOK) | Store a provider key in your Cloudflare **AI Gateway**, set `AI_GATEWAY_MODEL` (e.g. `openai/<model>`) in `.env`, and select `--executor switchyard-gateway`. The raw provider key stays in AI Gateway, not in this repo. |
| `workers-ai` | Set `WORKERS_AI_MODEL` to a supported Workers AI model and select `--executor workers-ai`. Needs only your Cloudflare account. |

Never put a raw provider key in the repo or in `wrangler.jsonc`. `.env` is
git-ignored; `.env.example` shows the shape with empty placeholders.

### 5. Run against Cloudflare

Start the Worker (and console) locally with the real Artifacts binding:

```bash
make dev-all        # Worker under `wrangler dev` + the local console
```

Then, in another terminal, run a Change against it:

```bash
make cli ARGS="run examples/changes/audit-logging.change.yaml"
# or, to run and promote the integrated result:
make cli ARGS="promote examples/changes/audit-logging.change.yaml"
```

Each WorkUnit now gets a **real isolated Artifact repository** with a short-lived
scoped Git credential; runners clone over standard Git HTTPS, execute, and push
back; verification, integration, conflict coordination, and local-Git promotion
work exactly as in the offline demo. `make doctor` reports which pieces
(Cloudflare auth, Artifacts reachability, executor) are ready.

> Note: the Artifacts binding method names were reconciled against a live
> account. If a call fails, re-check that your account has Artifacts beta access
> and that the `namespace` matches one your account can use.

### 5a. Prove the live Artifacts loop directly (smoke)

You can exercise the whole create / token / push / inspect / delete loop against
the live service with Wrangler alone, without starting the Worker. This is the
reproducible proof that the real binding works for your account:

```bash
# Source your gitignored .env so CLOUDFLARE_API_TOKEN/ACCOUNT_ID are set, or run
# `npx wrangler login` first.
set -a; . ./.env; set +a

NS=switchyard-change-fabric
REPO="smoke-$(date +%s)"
ACCOUNT="$CLOUDFLARE_ACCOUNT_ID"
REMOTE="https://$ACCOUNT.artifacts.cloudflare.net/git/$NS/$REPO.git"

# 1. Create a repo (this also creates the namespace the first time).
npx wrangler artifacts repos create "$REPO" --namespace "$NS" --json

# 2. Issue a short-lived write token (capture its "plaintext" value).
npx wrangler artifacts repos issue-token "$REPO" --namespace "$NS" \
  --scope write --ttl 600 --json

# 3. Clone, commit, and push over Git HTTPS. The scoped token authenticates as
#    the password (any username) or as a Bearer header. Keep the token out of
#    your shell history and logs.
git -c http.extraHeader="Authorization: Bearer <token>" clone "$REMOTE" repo
cd repo && echo "hello" > PROOF.txt && git add PROOF.txt \
  && git commit -m "smoke" \
  && git -c http.extraHeader="Authorization: Bearer <token>" push "$REMOTE" HEAD:main
cd ..

# 4. Inspect, then clean up.
npx wrangler artifacts repos get "$REPO" --namespace "$NS" --json
npx wrangler artifacts repos delete "$REPO" --namespace "$NS" --force --json
```

A fresh clone of the repo after the push shows the committed file. Note that the
repository metadata field `last_push_at` is eventually consistent and may still
read `null` for a short window right after a push, so treat a fresh clone (not
that field) as the proof that content landed.

### 6. (Optional) Deploy the Worker

Running locally with `wrangler dev` is enough to use real Artifacts. If you want
the Worker itself hosted on Cloudflare:

```bash
npx wrangler deploy        # from apps/worker, or: npm -w apps/worker run deploy
```

A production deploy is **not** required to try the project.

Apache-2.0. See [LICENSE](./LICENSE).

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
make cli ARGS='decompose "Add a health check endpoint" --project examples/demo-project'
make cli ARGS='run-goal --goal-file examples/goals/add-input-validation.goal.txt --project examples/calc-project'
```

## The living work graph (the console)

The console is the primary visual surface: a real-state-backed morphing graph of
a living work graph. Bring up the Worker and the console together:

```bash
make dev-all     # Worker under wrangler dev + the console (Vite)
```

Then open the console. It auto-loads a Change on first paint: the demo Change id
(`change-audit-logging`) by default, or whatever `?change=<id>` the URL carries,
so you do not hand-type an id. If no Change exists yet, press **Start the demo
Change** to seed the example audit-logging Change into the Worker (the
create-a-Change affordance; a goal-driven start is the CLI / `make seed-change`
path), then **Recruit wave** to watch the graph populate. It polls the Worker's
live state endpoint and renders the graph:

- Nodes are the goal, the work-graph units, recruited agents, and agent-built
  tools. A unit becomes an agent node once the engine recruits it (a workspace is
  recorded for it), a node greens as its work is verified or integrated, a tool
  node appears when an agent builds and publishes a tool, and a node lights up
  when a pending human escalation is attached to it. Node labels sit beside/below
  each node so they stay legible rather than being crammed inside the circle.
- Edges are dependency edges, data-flow edges (a dependency whose prerequisite is
  complete, so data has flowed), event-driven spawn edges (a real repo-pushed
  event recruited the target), consumed-tool edges (a downstream agent ran an
  agent-built tool), and write-lease edges (a waiter ordered behind the single
  write-lease owner on a contested path).
- Every node and edge is a projection of real durable state read from the Worker.
  The graph is built by one pure function (`buildWorkGraphModel`) that routes
  every node through a backing guard, so a node with no backing state cannot be
  drawn. Clicking a node reveals its real backing: for an agent node, its real
  Artifact repo name, clone URL, backend (live or the honest fallback), and real
  status; for a work node, the real WorkUnit it stands for.
- The min/max concurrency dial is a real control, not a cosmetic slider. It posts
  the dial to the Worker's recruitment config and kicks a recruitment wave through
  the same engine mechanism, so raising max and recruiting visibly widens how many
  agent nodes run at once.

The console renders the real state whether the workspaces are live Cloudflare
Artifacts or the honest local fallback (when no account is configured), so the
deterministic offline path is fully watchable.

## The example Change

The seeded example lives in two files:

- [`examples/changes/audit-logging.change.yaml`](examples/changes/audit-logging.change.yaml):
  a Change that adds organization-level audit logging. It declares three
  WorkUnits with one dependency (`api` depends on `model`) and one deliberate
  path collision (`api` and `tests` both declare `src/audit/events.ts`), which is
  what drives the coordination demo.
- [`examples/demo-project/`](examples/demo-project/README.md): the small
  standalone TypeScript service the Change targets.

## From a goal to a work graph (the decomposer)

Authoring a Change by hand (the YAML above) is still a valid input, but the
headline input is a plain-text **goal** plus the target repository. A
goal-agnostic **decomposer** reads the goal and the repository's structure and
produces the WorkGraph; no part of it is scripted per goal.

```bash
# Decompose a goal into a WorkGraph (plan + schedule), offline and deterministic.
make decompose          # the "input validation to every exported function" goal
make decompose-audit    # the "audit logging with a read API and tests" goal
make run-goal           # decompose a goal and run its graph to a promoted commit
```

How it stays goal-agnostic: the decomposer never branches on the goal string and
holds no table keyed on known goals. It reduces the goal to generic features
(action families such as add / validate / wire / test, salient target terms, and
whether the goal quantifies over "every" / "all"), scans the repository into
generic structural facts (source versus test files, directory modules, exported
symbols, entry-point and router-like files), and then applies one fixed set of
rules that match the goal's features against the repo's structure. Because the
shape is a function of how the goal's features interact with the repository, two
structurally different goals produce two differently-shaped graphs through the
same code path:

| Goal | Target | Shape |
|------|--------|-------|
| Add input validation to every exported function | `examples/calc-project` | wide, flat: one WorkUnit per source file, no dependency edges (a universal fan-out) |
| Add organization-level audit logging with a read API and tests | `examples/demo-project` | layered: module WorkUnits plus a dependent tests WorkUnit, with dependency edges |

The two seeded goals live in
[`examples/goals/`](examples/goals/) and are inputs only; the second target
project is [`examples/calc-project/`](examples/calc-project/README.md). The
decomposition is deterministic and offline by default (a heuristic goal analyzer,
no live inference), so it runs in `make check`. An inference-backed analyzer can
be injected without changing the decomposer; it must return the same intent
shape, so determinism is preserved wherever the heuristic default is used.

### The anti-puppet demonstration

The point of a goal-agnostic engine is that two structurally different goals run
through the SAME code path and produce two different graphs, with no per-goal
scripting. Prove it in one command:

```bash
make anti-puppet
```

It decomposes goal A (audit logging) against the layered `demo-project` and goal
B (input validation on every exported function) against the flat `calc-project`,
and prints both WorkGraphs. Goal A comes out LAYERED (module units plus a
dependent tests unit, with dependency edges); goal B comes out a FLAT fan-out
(one unit per source file, no edges). Same `decompose` call, two shapes, derived
from how each goal's features interact with each repo's structure. The engine
never branches on the goal string and holds no table keyed on known goals; the
`decompose` tests pin exactly that (same features yield the same shape, swapping
the repo while holding the goal changes the result, and a wholly novel goal
string still decomposes sensibly).

## The durable run loop

Driving a WorkGraph to completion is a real durable loop, not a one-shot. The
Cloudflare Workflow (`apps/worker/src/workflow.ts`) advances the graph one
scheduling wave per durable step: each step asks the `ChangeState` Durable Object
to lease every currently-runnable WorkUnit, record it running, then record it
complete so its dependents become runnable on the next wave, until the graph is
complete. Every mutation is inside a `step.do` boundary, and the Durable Object
advance is idempotent, so the loop is restartable and cannot double-advance on
resume. The offline substrate drives the same graph through the same scheduling
kernel (`driveWorkGraph` in `change-core`), so the live and offline paths cannot
drift. Agent recruitment (below) builds on this loop; the morphing graph
visualization builds on it in later work.

## Evidence-governed recruitment and the concurrency dial

The durable loop advances the graph; **recruitment** decides how many agents work
it at once. Each wave, a recruiter spawns a runner for the currently-runnable
WorkUnits, bounded by a **min/max concurrency dial** (`{ minConcurrency,
maxConcurrency }`). Recruitment is a **policy over the runnable set and the dial**,
not a hardcoded count and not one agent per named unit: the recruiter takes a
bounded window over the runnable units sized by `maxConcurrency - inFlight`, so
raising `maxConcurrency` widens how many run at once through the same code path
(`recruit` in `change-core`). Both the live Worker and the offline substrate call
that one function, so they cannot diverge on how the dial governs concurrency.
Every recruited agent gets its **own** isolated workspace (its own Artifact repo)
and its own short-lived scoped token.

Waves are driven by an **event**, not a poll or a timer. When a runner finishes a
WorkUnit it pushes to its own Artifact repo, which emits a **repo-pushed** event.
That event is the trigger for the next recruitment wave: the live Worker consumes
it from a Cloudflare Artifacts event subscription (a Queue consumer, see
`apps/worker/src/index.ts`), and the offline substrate drives the identical
downstream handler with a deterministic faked event through the
`POST /events/repo-pushed` ingress, so `make check` stays deterministic while the
live path uses the real queued event. The recruitment log records what triggered
each wave (kickoff versus a repo-pushed event, and which workspace pushed), so the
trigger is explicit and inspectable.

```bash
# Offline, deterministic: recruit under a dial, each wave after the first driven
# by a repo-pushed event. Turn the dial with MIN/MAX and watch concurrency widen
# through the same code path.
make recruit MAX=2       # peak concurrency 2
make recruit MAX=5       # peak concurrency 5, same engine, only the dial changed

# Live: multiple agents concurrently hold distinct REAL Artifact repos and push.
# Start the Worker first (make dev, with wrangler authenticated), then:
make recruit-live MAX=3 WORKER=http://127.0.0.1:8787
```

The live `recruit-live` run creates a real Artifact repo per recruited agent,
clones and pushes over Git HTTPS with each agent's scoped token, drives the next
wave from the repo-pushed event, and deletes the real repos it created on the way
out. A note on an open-beta rough edge: Artifacts repo deletion is eventually
consistent, so the live driver gives each run a unique Change id to avoid
recreating a just-deleted repo name; and `wrangler artifacts repos delete` is
interactive, so pass `--force` when deleting from a script.

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

### 6. Watch the live run morph the graph

The full live headline run (`run-live`) decomposes a goal, recruits real agents
into real Artifact repos, drives event-driven waves, runs the human escalation
beat, verifies, integrates, promotes to local Git, and cleans up. A plain
`run-live` is fast and tears its repos down on the way out, which is right for a
scripted run but too quick to watch. For a watchable demo, use watch mode:

```bash
make dev-all        # Worker + console (another terminal)
make run-live-watch # seeded audit Change, STABLE id, LEAVES repos up at the end
```

`make run-live-watch` differs from `run-live` in three ways that make it
watchable:

- it uses the **seeded audit-logging Change** (which has the hardcoded
  `src/audit/events.ts` collision between `api` and `tests`), so the **human
  escalation beat fires every time** rather than depending on whether a free-text
  goal happens to collide;
- it uses a **stable, predictable Change id** (`change-audit-logging`, not a
  per-run id), and the console **auto-loads that id**, so you just open the
  console and watch;
- it **pauses before cleanup** (`--watch` / `--no-cleanup`): the real Artifact
  repos and the Change state are left in place at the end so you can study the
  finished graph. Nothing is torn down mid-run in either mode.

When you are done watching, tear the real repos down:

```bash
make clean-live     # archives the real Artifact repos the watch run left up
```

To seed a Change into a running Worker without the full run (so the console shows
a live graph you can then recruit into), use `make seed-change` or the console's
**Start the demo Change** button.

### 7. (Optional) Deploy the Worker and prove the queued event hop

Running locally with `wrangler dev` is enough to use real Artifacts, and a
production deploy is **not** required to try the project. Deploy only if you want
the Worker itself hosted on Cloudflare, which is also what lets the real
`repo.pushed` -> Queue -> consumer hop be proven end to end (under `wrangler dev`
the Worker consumes a local queue simulation, so a remote subscription cannot
reach it).

```bash
npx wrangler queues create switchyard-change-fabric-repo-pushed   # once, if absent
make deploy             # wrangler deploy (prints the deployed Worker URL)
make artifacts-subscribe # provision the Artifacts repo.pushed -> Queue subscription
```

With the Worker deployed and the subscription provisioned, a real push to a live
Artifact repo emits a real `repo.pushed` event that the deployed Queue consumer
receives and turns into the next recruitment wave, with no use of the HTTP
ingress. [`docs/EVENT-SUBSCRIPTION.md`](docs/EVENT-SUBSCRIPTION.md) documents the
two delivery paths, the exact proof, and the teardown commands
(`cd apps/worker && npx wrangler delete`).

Apache-2.0. See [LICENSE](./LICENSE).

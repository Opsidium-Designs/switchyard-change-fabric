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

## Demo script (a 5 to 10 minute walkthrough)

Everything below runs offline and deterministically.

1. **Show readiness.** `make doctor`. It reports Node and Git as present
   (required), wrangler and Cloudflare auth best-effort (optional), and that the
   deterministic `noop` executor is always available. Point out that the offline
   demo needs no Cloudflare account.
2. **Show the plan.** `make cli ARGS="status examples/changes/audit-logging.change.yaml"`.
   Walk through the three WorkUnits, the `api -> model` dependency, and the
   declared `src/audit/events.ts` collision between `api` and `tests`. Highlight
   the schedule: `model` and `tests` are runnable at once; `api` waits for
   `model`.
3. **Run it end to end.** `make demo`. As it runs, call out the stages in the
   summary:
   - **WorkUnits** scheduled in waves (`model` and `tests` concurrently, then
     `api`), each in its own isolated local-fallback workspace;
   - **Conflict coordination**: the `src/audit/events.ts` collision is resolved
     by granting a single write lease to `api`, with `tests` recorded as a
     waiter, so there is one writer and no silent merge;
   - **Verification + integration**: every WorkUnit verifies and the combined
     result verifies;
   - **Cost**: zero spent against the Change budget (the `noop` executor spends
     no inference);
   - **Promotion**: a real branch and commit (`switchyard/change-audit-logging`)
     in a local Git repository, ending in a promoted commit hash;
   - **Cleanup**: the per-WorkUnit and integration workspaces are expired.
4. **Show it is reproducible.** Run `make demo` again and note the same WorkUnit
   ordering, the same coordinated owner, and the same promoted tree.
5. **(Optional) Show the real Cloudflare path.** After `npx wrangler login`, run
   `make dev-all` to bring up the Worker under `wrangler dev` and the console,
   where the same flow uses real Cloudflare Artifacts.

## License

Apache-2.0. See [LICENSE](./LICENSE).

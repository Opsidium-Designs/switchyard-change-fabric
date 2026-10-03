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
**Artifacts binding uses the real remote service** (`remote = true`).

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

- Node.js and Git
- A Cloudflare account with Workers + Artifacts access (Artifacts is in open beta)
- One inference path: an authenticated Codex CLI, **or** a provider key in AI
  Gateway, **or** sufficient Cloudflare credits for Workers AI / Unified Billing
- Docker (only if the optional containerized verifier is used)

You do **not** need a production Cloudflare deploy or a local GPU/model server to
try the project.

## Getting started

> Commands below are the intended developer experience; some land as the spike is
> built out.

```bash
git clone <this-repo>
cd switchyard-change-fabric
npm install
npx wrangler login
cp .env.example .env
npm run dev            # starts wrangler dev, the console, and the local runner pool
```

Then run an example Change:

```bash
npx switchyard-change init ../example-project
npx switchyard-change run examples/audit-logging.change.yaml
# open the local console (e.g. http://localhost:8787) to watch WorkUnits,
# conflicts, verification, cost, and promotion
npx switchyard-change promote <change-id>
```

## License

Apache-2.0. See [LICENSE](./LICENSE).

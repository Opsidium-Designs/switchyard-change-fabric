# Switchyard Change Fabric

**The living work graph for agents on Cloudflare.** A human states a goal; the
engine decomposes it into a work graph, recruits agents into isolated Cloudflare
Artifact repositories, coordinates them as they run, verifies their output,
integrates the verified work, and promotes one coherent result back into
ordinary Git. The console renders that work graph morphing in real time against
real durable state.

> Branches are implementation details. **Changes** are the unit of agentic
> software development.

Built for Cloudflare's "Build the next Git platform" challenge. Early spike;
interfaces and layout will change.

## Run it (live on Cloudflare Workers AI)

The headline run decomposes a goal, recruits real agents into real Artifact
repos, drives event-driven waves on Workers AI, pauses for a human escalation,
then verifies, integrates, and promotes. Follow these steps in order.

1. **Prerequisites.** Node.js 20 or newer, Git, and a Cloudflare account with
   Workers and Artifacts (open beta) enabled and Workers AI available.

2. **Configure `.env`.** Copy the example and fill in your values.
   ```bash
   cp .env.example .env
   # then set in .env:
   #   CLOUDFLARE_ACCOUNT_ID=<your account id>
   #   CLOUDFLARE_API_TOKEN=<a scoped token: Workers + Artifacts>
   #   EXECUTOR=workers-ai
   #   WORKERS_AI_MODEL=@cf/qwen/qwen2.5-coder-32b-instruct
   ```
   The token stays in your gitignored `.env` and is never printed.

3. **Install dependencies.**
   ```bash
   make install
   ```

4. **Stand up the hosted infrastructure.** Deploys the hosted Worker, the Queue,
   and the Artifacts `repo.pushed` subscription. These are REAL billable hosted
   resources on the account in your `.env`; it is idempotent and prints what now
   exists.
   ```bash
   make infra-up
   ```

5. **Start the local Worker and console** in their own terminal, and leave them
   running.
   ```bash
   make dev-all
   ```

6. **Open the console and drive everything from the browser.**
   ```text
   http://127.0.0.1:5173/
   ```
   The console is the control plane. Pick a template from the gallery to launch
   a live run: it starts with a fresh unique Change id the console follows
   automatically, and the graph morphs in real time against the run's durable
   state. There is no CLI step for the demo.

   - **Audit logging** (about 3 agents) hits a shared contested path, so the run
     pauses and the console asks you which agent owns it. Answer in the browser
     and the run continues.
   - **Validation fan-out** (about 5 agents) and **Large (scale)** (13 agents)
     run to completion on their own, with no human step.

7. **Tear down the run from the console.** Each template leaves its real Artifact
   repos up so you can study the finished graph; click **Tear down this run's
   repos** to delete them (scoped to that run's unique id). Launching another
   template uses a fresh unique id, so repeated runs never collide.

   A CLI-driven alternative to steps 6 and 7 is `make demo-live` (it drives one
   watchable run from the terminal); the console template gallery is the primary
   browser path.

8. **Tear down the hosted infrastructure when done.** Per-run Artifact repos are
   removed from the console (step 7) or with `make clean-live` for a CLI run;
   `make infra-down` removes the hosted Worker, Queue, and subscription so
   nothing keeps billing.
   ```bash
   make infra-down
   ```

### What you are watching

- **Nodes** are the goal, the work-graph units, the recruited agents, and the
  tools agents build; a node greens as its work is verified or integrated.
- **Edges** are dependencies, data-flow (a satisfied dependency), event-driven
  spawn (a real repo-pushed event recruited the target), consumed-tool (a
  downstream agent ran an agent-built tool), and write-lease (a waiter ordered
  behind the single owner of a contested path).
- **Click a node** to see its real backing: an agent's actual Artifact repo,
  clone URL, backend, status, and evidence.
- **The min/max dial** is a real control: raise it and the next wave recruits
  more agents at once through the same engine.
- **The human escalation beat** pauses the run for a decision rather than
  guessing on a contested path; you answer the question in the console and the
  run continues.
- **Per-run cleanup** is a console control: tear down a run's real Artifact repos
  when you are done watching, scoped to that run's unique id.

### Other ways to run

- `make demo` runs the whole flow offline and deterministically with no
  Cloudflare account (the `noop` executor plus an honest local-filesystem
  fallback). It is the test substrate and the fastest way to see the flow.
- Other executors exist and are selected in `.env`: `codex` (an already
  authenticated Codex CLI) and `switchyard-gateway` (AI Gateway BYOK). See
  [`.env.example`](.env.example) for the shape of each.
- `make infra-status` is read-only and reports what is live on your account
  right now, so you can answer "am I paying for anything?".

## How it works

The engine is one durable pipeline, each stage backed by code you can read:

- **Decompose** a goal into a WorkGraph from generic goal features and generic
  repo structure, so different goals yield differently-shaped graphs through one
  code path (`packages/change-core`).
- **Durable run loop:** a Cloudflare Workflow advances the graph one scheduling
  wave per durable step, idempotent and restartable (`apps/worker`).
- **Recruitment and the dial:** each wave recruits runnable units bounded by a
  min/max concurrency dial, each agent getting its own Artifact repo and
  short-lived scoped token (`packages/change-core`, `packages/artifact-workspace`).
- **Event-driven waves:** a runner's push emits a repo-pushed event that triggers
  the next wave (a Queue consumer live, a deterministic faked event offline).
- **Agent-for-agent tooling:** an agent can build and publish a tool that
  downstream agents consume.
- **Write-lease coordination:** contested paths get a single lease owner; others
  wait rather than silently merging.
- **Verify, integrate, promote:** deterministic verification, an integration
  workspace, and a promoted local Git commit (`packages/verification`,
  `packages/git-promotion`).

The live and offline paths share the same scheduling kernel, so they cannot
drift. The deployed `repo.pushed` to Queue to consumer hop is documented, with
its honest status and teardown, in
[`docs/EVENT-SUBSCRIPTION.md`](docs/EVENT-SUBSCRIPTION.md).

Apache-2.0. See [LICENSE](./LICENSE).

# Switchyard Change Fabric

**A living work graph for agents on Cloudflare.** A human states a goal. An LLM
planner decomposes it into a work graph, agents are recruited into their own
Cloudflare Artifact repos, a mechanical gate verifies the integrated result, and
only a verified result is promoted back to ordinary Git. The browser console
renders the graph morphing in real time against real durable state.

> Branches are implementation details. **Changes** are the unit of agentic
> software development.

Built for Cloudflare's "Build the next Git platform" challenge. Early spike;
interfaces will change.

## Quick start (offline, no account)

Requires Node.js 20+ and Git.

```bash
make install
make check   # typecheck + build + test, offline and deterministic
make demo    # the whole flow end to end with the noop executor, no Cloudflare
make demo-board  # agents form around a goal on the Change board and build tools for each other (offline, deterministic)
make demo-board-storefront  # the same board on the larger multi-domain storefront app (offline, deterministic)
```

## Replay recorded runs (static, no account)

Real board runs, recorded from the Worker, played back in the browser with the
same mission control as a live run: no Worker, no launcher, no credentials, no
model calls. Failed runs are included on purpose.

```bash
make replay-preview   # build and serve the replay page on http://127.0.0.1:4180
```

Open a run with `?run=<id>` and a moment with `&seq=<n>`. Export another run
with `make export-replay ID=<changeId>` (scrubs local paths and refuses anything
token-like), and publish the page with `make deploy-replay` (a real deploy of
static assets). See [docs/REPLAY.md](./docs/REPLAY.md).

## Live run

1. **Configure `.env`** (gitignored; never commit it):
   ```bash
   cp .env.example .env
   # CLOUDFLARE_ACCOUNT_ID=...        account with Workers + Artifacts (beta)
   # CLOUDFLARE_API_TOKEN=...         scoped token: Workers + Artifacts
   # EXECUTOR=ai-gateway
   # CLOUDFLARE_AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>
   # CLOUDFLARE_AI_GATEWAY_TOKEN=...  the gateway credential, not a provider key
   ```
   Inference is BYOK through Cloudflare AI Gateway: the OpenAI key lives in the
   Cloudflare account and the gateway injects it. `EXECUTOR` accepts
   `ai-gateway | workers-ai | noop` (unset means `noop`); anything else is an
   error. Only `ai-gateway` provides the LLM planner and the Jev decision model.

   **Or use your local Claude Code CLI** instead of the gateway for every model
   role (planner, agent turns, edits, tool authoring): log in with `claude`
   once, then set `SWITCHYARD_INFERENCE=claude-cli` in `.env` (or pass
   `--inference claude-cli`). No AI Gateway URL or token is needed; the
   Cloudflare account and token still are. Jev is off in this mode by default.
   See [`docs/LOCAL-CLI.md`](docs/LOCAL-CLI.md).

2. **Start the local Worker and console** and leave them running:
   ```bash
   make dev-all
   ```

3. **Open `http://127.0.0.1:5173/`** and launch a template:
   - **Audit logging (intro):** about 3 agents; two contend for a shared module,
     so the run pauses and asks you in the console which agent owns it.
     Its acceptance gate (`npm run gate` in `examples/demo-project`) passes only
     once an organization-scoped audit read API exists.
   - **Fix a multi-resource API (many agents):** about 6 agents, one per
     resource of `examples/apps/service-api`. Optionally click **Deploy app** first
     to see the broken app at a stable `workers.dev` URL; a verified fix is then
     redeployed in place at the same URL. The app's home page (`GET /`) is an
     interactive tester that runs the gate's 18 checks: about 6 of 18 pass on the
     broken app, 18 of 18 after the fix.
   - **Make a storefront correct and safe (board):** a larger TypeScript app,
     `examples/apps/storefront` (catalog, orders, billing over shared money,
     http, and auth contracts, with a lockfile). Choose "agents on the board":
     the fix repeats one change across many handlers, splits billing into
     several sub-changes, changes the shared money contract, and contradicts
     one existing test that pins the old tax rounding, so the run asks you to
     accept or reject that test change (rejecting it leaves the gate failing,
     honestly). Its home page is a tester: about 1 of 16 checks correct before,
     16 of 16 after. See its [README](examples/apps/storefront/README.md).

   Each launch gets a fresh unique Change id. **Tear down** deletes that run's
   Artifact repos (and the deployed app, if any).

CLI equivalents: `make run-live-service` (the service-api fix),
`make run-board-storefront` (the storefront on the board; `DECIDE=accept|reject`
answers the test contract change from the CLI),
`make run-live-watch` / `make demo-live` (the audit-logging run, repos left up;
remove them with `make clean-live`).

**Hosted infrastructure (optional).** `make infra-up` deploys the hosted Worker,
the Queue, and the Artifacts `repo.pushed` subscription (real, billable,
idempotent). `make infra-status` is read-only ("am I paying for anything?").
`make infra-down` removes it all, including leftover repos. See
[`docs/EVENT-SUBSCRIPTION.md`](docs/EVENT-SUBSCRIPTION.md) and
[`docs/LIVE-DEPLOY.md`](docs/LIVE-DEPLOY.md).

## How it works

1. **Goal to Change.** The Change is created on the Worker (a ChangeState
   Durable Object) in status `planning` before any planning happens, so the
   console shows it at once.
2. **Plan.** The LLM planner (schema-constrained JSON through AI Gateway)
   decomposes the goal into single-writer work units against frozen shared
   contracts. Its structural map lists every feature group of a modular repo
   (each directory of sibling modules with the seams it shares), so a goal
   spanning several domains is planned across all of them. Jev records an
   advisory plan-review decision; when it is not confident the plan covers the
   goal, the planner re-plans once with that doubt as feedback (on the next
   model of the ladder) and the better-reviewed plan proceeds, both decisions
   recorded. A live goal run
   without the planner fails unless `--allow-heuristic-planner` is passed (with
   a loud banner). If every model in the planner ladder fails, the run falls
   back to the heuristic plan with a loud banner and an amber planner node.
3. **Recruit.** Agents are recruited under a min/max concurrency dial (set
   before the run), each in its own Artifact repo with a short-lived scoped
   token. An agent's push raises a `repo-pushed` event that recruits the next
   wave (through the Worker's ingress locally, or the Artifacts subscription and
   Queue consumer when deployed; both hit one handler).
4. **Verify every round.** The app's own gate runs on each round's integrated
   edits. On a failing round, when a decision model is configured, Jev records
   an advisory failure-attribution decision (on the board, only when more than
   one item is in the failing revision), and the planner re-plans which units
   re-run; those units retry on an escalated model, fed the real gate evidence.
5. **Integrate and promote.** A final authoritative integration gate runs on
   the integrated tree (Jev adds an advisory fix-confidence decision beside
   it). Only a `verified` verdict is promoted to a local Git
   branch `switchyard/<change-id>`. If the app was deployed before the run, it is
   redeployed in place from a checkout of the promoted commit. The console's goal
   node turns green or red only from this integration verdict.

A Change also has a **board**: an ordered log of typed coordination messages
(claims with read/write intent, contests, splits, pushes, integrated revisions,
tools) with mechanical arbitration in the Durable Object. `run-live` does not
use it; the separate `run-board` mode does: the lead's planner proposes items,
worker agents join with their own repos, claim, contest, narrow, ask each other,
edit, and push; every push is integrated continuously into the next gated
revision (the original code's tests, the gate's configuration, and the gate's
own toolchain, meaning its runner packages' declarations and lockfile
resolution, are a contract no agent changes alone; other dependencies stay
editable), a failing revision asks the
implicated owners for a fix, and only the last revision, when it passed, is
promoted (`make demo-board` offline, `make run-board` live). Agents also build
tools for each other on the board (scanners, codemods, checks): a proposed tool
is an item the lead accepts, it is built in the Change's tools repo, published
only after it passes its own gate on the original code, and every use is
recorded by the engine (see "Agent-built tools" in docs/BOARD.md). Owners can
split an item and become its sub-lead (the children's pushes integrate into
the sub-lead's repo first, and it announces one push upward), or grant part of
an item to a helper that forks their repo and delivers a commit they pull (see
"Splits, sub-leads, and fork-based help" in docs/BOARD.md). Long runs stay
moving: claims are leased (they lapse without real progress), every waiting
item states why, an item that spends its fix budget gets one lead re-plan
before a human is asked, overlapping scopes and predicted clashes are flagged,
stale revisions are refused, agents' repo tokens are refreshed, cost and time
caps stop new turns (only metered calls count, and a spend cap cannot bound
unpriced calls), and each run ends with a proof bundle of what it can
prove about the revision it shipped (see "Stalls, re-plans, clashes, proofs,
and caps" in docs/BOARD.md). Once a revision has passed, the local integrator
gates speculative prefix candidates of the pending pushes (`--speculate K`,
default 3), lands the longest passing prefix, and blames only the push whose
candidate failed after a passing one (see "Speculative batch gating" in
docs/BOARD.md). With
`--integrator cloud` the integration runs on Cloudflare instead of in the
driver: a Workflow gates each revision in a Cloudflare Container with phased
egress (`make dev-containers` locally, Docker required). See
[docs/BOARD.md](./docs/BOARD.md) and the "Integration on Cloudflare" section of
[docs/LIVE-DEPLOY.md](./docs/LIVE-DEPLOY.md).

### What the graph shows

Nodes are the goal, the planner (kickoff and each re-plan), work units and
recruited agents, agent-built tools, verify attempts, retries, and Jev
decisions. Click a node to see its real backing (repo, clone URL, status,
evidence). Edges are exactly four kinds:

- `dependency`: a declared work-graph dependency, or a plan/promotion edge.
- `spawn`: an Artifact `repo-pushed` event recruited the target, and only that.
- `trigger`: ladder control flow (verify fail, re-plan, retry, agents).
- `consumed-tool`: a downstream agent ran a tool another agent built.

### Honesty invariants

- **Gate-equals-deploy:** the gate runs on the exact tree that is promoted and
  deployed; divergence fails honestly.
- **No unbacked node:** every graph node maps to real recorded state.
- **Jev is advisory:** it never flips a verdict or gates promote/deploy; the
  mechanical gate decides.
- **No silent pass:** a project that declares a gate, run with `--no-gate`,
  cannot pass.
- **Offline `make check`:** the planner, Jev, and executor are faked in tests.

## Security

- The Worker requires `authorization: Bearer <SWITCHYARD_API_TOKEN>`
  on every mutating route (including those that return Artifact write tokens);
  read-only GETs stay open. Set it as a Worker secret (`wrangler secret put`, or
  `apps/worker/.dev.vars` locally) and the same value in the root `.env`.
- With no token set it refuses every mutation unless
  `SWITCHYARD_ALLOW_UNAUTHENTICATED=1` opts in; the local dev targets set that
  opt-in, a deploy never does.
- The browser never holds that token: console mutations go through the dev
  launcher's `/api/worker` proxy, which adds the bearer server-side.
- CLI errors and run logs redact credentials (URL userinfo, Artifact tokens).
- `make dev-all-lan` exposes the dev control plane (it can launch runs, spend
  inference, and deploy) to the LAN. Set `SWITCHYARD_API_TOKEN` first and use it
  only on a trusted network.

## Layout

`apps/worker` (control plane), `apps/console` (React/Vite console and dev
launcher), `apps/cli` (run driver), `packages/change-core` (domain, planning),
`packages/orchestration` (run loop, graph model), `packages/model-adapters` (AI
Gateway transports), `packages/verification` (gate, integration),
`packages/artifact-workspace`, `packages/git-promotion`, `packages/local-runner`.
The `Makefile` lists every command.

Apache-2.0. See [LICENSE](./LICENSE).

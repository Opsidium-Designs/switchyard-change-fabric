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

## What to look at first

- **The replay page, hosted:**
  **<https://switchyard-change-fabric-replay.ckinney.workers.dev>**. Real
  recorded board runs, played back in the browser with the same mission
  control a live run uses, failures included, and each passing run's app
  live twice: the original code and the code the run's gate passed. No
  account, no credentials, no model calls. To serve it yourself:
  `make replay-preview`, then open `http://127.0.0.1:4180`. See
  [docs/REPLAY.md](./docs/REPLAY.md).
- **The honesty invariants.** What the engine refuses to pretend; see
  [Honesty invariants](#honesty-invariants) below.
- **Verified-only promotion.** Nothing reaches Git unless the gate passed on
  the exact tree that is promoted, recorded on the board and in a Git note
  receipt. See "Repos and promotion safety" in [docs/BOARD.md](./docs/BOARD.md)
  and the failures that shaped it in [docs/FAILURE-MODES.md](./docs/FAILURE-MODES.md).

## Results at a glance

The recorded runs shipped on the replay page
(`apps/console/public/replays/index.json`). Acceptance is the app's own
acceptance suite, counted per integrated revision; "agents" counts the board's
lead plus its workers.

| Run | App | Agents | Outcome | Acceptance, first to last revision | What a human decided |
| --- | --- | --- | --- | --- | --- |
| `board-live-sf21` | storefront | lead + 6 (local Claude CLI) | verified, promoted (revision 6) | 79/129 (rev 2; rev 1 stopped at a developer test) to 129/129 | accepted one change to a developer test that pinned the old tax rounding |
| `board-live-l3` | service-api | lead + 3 | verified, promoted (revision 5) | 10/20 to 20/20 (passed on rev 4) | nothing |
| `board-live-reg3` | service-api | lead + 3 | verified (revision 3) | 10/20 to 20/20 | nothing |
| `board-live-sf7` | storefront | lead + 6 | failed honestly, nothing promoted | 16/129 (rev 1), best 40/129 (rev 10) | accepted one test contract change |
| `board-live-sf8` | storefront | lead + 6 | failed honestly, nothing promoted | best 35/129 (revs 6 and 7) | accepted four escalated test contract changes |
| `board-sim-100` | generated 100-module project | lead + 100 | **SIMULATED**: verified on the offline fixture gate | fixture gate fail, then pass | nothing |

`board-sim-100` is **not a live run**: every agent turn is scripted, no model
took part, and its gate is the offline fixture, not the project's tests. It
shows the real board engine coordinating about 100 agents (see "The simulated
run at scale" in [docs/REPLAY.md](./docs/REPLAY.md)).

Each example app's home page is a self-test against the Worker it is served
from, so a before and after is visible in a browser:

| App | Home page checks, original to fixed | Gate acceptance suite, original to fixed |
| --- | --- | --- |
| [service-api](examples/apps/service-api/README.md) | 6 of 18 to 18 of 18 | 8/20 to 20/20 |
| [storefront](examples/apps/storefront/README.md) | about 1 of 16 to 16 of 16 | 16/129 to 129/129 |
| [cityhall](examples/apps/cityhall/README.md) | about 1 of 46 to 46 of 46 | 106/237 to 237/237 |

A recorded run can carry two live links on the replay page, the original app
and the exact code that run's gate passed, side by side on one showcase Worker
(see "Try the apps" in [docs/REPLAY.md](./docs/REPLAY.md); published with
`make showcase`).

## Run it offline (no account)

Requires Node.js 20+ and Git.

```bash
make install
make check                  # typecheck + build + test, offline and deterministic
make demo                   # the run-live flow end to end with the noop executor, no Cloudflare
make demo-board             # agents form around a goal on the board and build tools for each other
make demo-board-storefront  # the same board on the multi-domain storefront app
make demo-board-cityhall    # the same board on the 32-module cityhall app
make demo-board-scale       # regenerate the SIMULATED ~100-agent replay (scripted agents, fixture gate)
make replay-preview         # build and serve the replay page on http://127.0.0.1:4180
```

The offline board demos use a generic, goal-agnostic policy for every agent
turn, the deterministic noop executor, and an offline fixture gate that is
labelled as such in the run: they show coordination, not a real fix.

## What runs on Cloudflare

| Cloudflare product | What it does here | Where in the code |
| --- | --- | --- |
| Workers | The control plane: Change, board, lease, recruitment, and integration routes | `apps/worker/src/index.ts`, `apps/worker/wrangler.jsonc` |
| Durable Objects | `ChangeState`: one per Change, the durable board log and reduced state, agent token hashes, escalations; a hibernatable WebSocket live board feed (`GET /changes/:id/board/live`) | `apps/worker/src/change-state.ts` |
| Artifacts | A repo per agent, a tools repo and an integration repo per Change, fork-based help repos, scoped read/write tokens that expire | `apps/worker/src/workspace-provisioner.ts`, `packages/artifact-workspace` |
| Queues + the Artifacts `repo.pushed` subscription | run-live recruitment: an agent's push event recruits the next wave (drawn as a `spawn` edge) | the `queue()` consumer in `apps/worker/src/index.ts`, `tools/artifacts-subscribe.sh`, `tools/infra-up.sh` |
| Workflows + Containers | The cloud integrator (`--integrator cloud`): a Workflow gates each revision in a fresh Container with phased egress and no credential inside | `apps/worker/src/integration-workflow.ts`, `gate-runner.ts`, `integration-egress.ts`, `apps/worker/containers/gate/Dockerfile` |
| Worker versions with preview aliases | Revision previews (`--preview-revisions`) and the replay page's before/after showcase | `packages/orchestration/src/revision-preview.ts`, `packages/orchestration/src/showcase.ts`, `apps/cli/src/showcase-app.ts` |
| Workers static assets | The replay page (no Worker code, no bindings) | `apps/console/wrangler.replay.jsonc` |
| AI Gateway | Inference (BYOK): planner, executor, agent turns, tool authoring, and the Jev decision model | `packages/model-adapters/src/ai-gateway.ts`, `planner.ts`, `agent-turn.ts`, `jev.ts`; selected in `packages/orchestration/src/executor-select.ts` |

Inference calls are made by the Node driver (the CLI), not by the Worker.

## Honesty invariants

- **Gate-equals-deploy:** the gate runs on the exact tree that is promoted and
  deployed; divergence fails honestly, and a required gate that is absent
  cannot pass.
- **No unbacked node:** every graph node maps to real recorded state; on the
  board, every node and edge cites a recorded message.
- **Jev is advisory:** the typed-decision layer never flips a verdict or gates
  promote/deploy; the mechanical gate decides.
- **No silent pass:** a project that declares a gate, run with `--no-gate`,
  cannot pass.
- **No silent planner substitute:** a live run plans with the LLM; the
  heuristic decomposition is the offline stub, used live only with an explicit
  flag and a loud banner.
- **Offline `make check`:** the planner, Jev, and executor are faked in tests.

## How a run works

`run-board` (agents on the board) is the main mode; `run-live` is the earlier
planner-driven mode (see below).

1. **Goal.** The human posts the goal. The Change is created on the Worker (a
   `ChangeState` Durable Object) before planning starts, and the goal records
   the protected set (the gate's own files and the existing developer tests)
   and the baseline test inventory from a gate run on the original code.
2. **Plan.** The lead's LLM planner gives each module to one item, and
   leaves the shared seams (files many modules import, like the money and
   http contracts) unowned at first, so agents code against the same
   interface instead of all editing it. Changing a seam later goes through a
   seam item the lead creates, or a contract the lead or a human decides.
   Jev records an advisory plan review; a doubtful plan is re-planned once
   with that doubt as feedback.
3. **Recruit.** Workers join, each with its own Artifact repo and a
   short-lived scoped write token.
4. **Claim and contest.** Agents claim items with a declared read/write
   intent. An overlapping write intent opens a contest the engine arbitrates
   (cede, narrow, or the earliest owner keeps it); read intents never block.
5. **Edit and push.** The executor makes anchored search/replace edits only
   (it cannot silently rewrite a signature). An edit that leaves a file
   unparsable, or adds type errors (the pre-push typecheck), is refused before
   it is pushed, and the agent is told why.
6. **Integrate and gate.** A continuous integrator stacks the latest pushes
   into a revision and runs the app's own gate on that exact tree, with the
   protected files restored from the baseline.
7. **Blame and fix.** A failing revision is attributed from the gate's own
   output (Jev may narrow it, advisory); only the implicated owners are asked
   for a fix. Before the first pass, a stack that scores worse is checked
   leave-one-out, so a push that only made things worse is held back.
8. **Pass and promote.** The last passing revision is promoted to a local Git
   branch `switchyard/<change-id>` as a compare-and-swap fast-forward of the
   gated commit, with a receipt in `refs/notes/switchyard`. If the app was
   deployed before the run, it is redeployed in place from the promoted commit.
9. **Close-out.** After a pass, owners whose pushes it merged are cued to
   propose done within a bounded window. The engine itself closes an item
   only when a passing revision merged its owner's latest push and nothing is
   outstanding on it (no fix request, regression, pending contract, or open
   contest).
10. **Proof.** Each run ends with a proof bundle: proven only when the last
    revision passed a gate that ran and the promoted commit is that gated
    commit. Test teeth checks (advisory) say whether each changed developer
    test fails on the original code, so it actually tests the fix.

### The board

The board is an ordered, durable log of typed messages per Change with
mechanical arbitration in the Durable Object. Full detail is in
[docs/BOARD.md](./docs/BOARD.md).

- **Claims and contests.** Every claim declares intent; overlaps become
  contests resolved by rule, and a claim cap (`--claim-cap`) keeps one agent
  from hoarding items.
- **Contracts and protected files.** Shared seams change only through a seam
  contract the lead decides. Protected files come in two classes: the
  acceptance gate itself is immutable (no agent and no human answer changes
  it), while a pre-existing developer test may change only with a human's
  approval, and the approved file is released to that one item.
- **Tools agents build for each other.** Scanners, codemods, and checks are
  proposed as items, built in the Change's tools repo, published only after
  they pass their own gate on the original code, and every use is recorded.
- **Splits, sub-leads, and fork-based help.** An owner can split its item and
  become the sub-lead that merges its children's pushes, or grant part of its
  item to a helper that forks its repo and delivers a commit.
- **Long-run safety.** Claims are leased and lapse without real progress;
  every waiting item states why; an item that spends its fix budget gets a
  lead re-plan before a human is asked; overlapping scopes and predicted
  clashes are flagged; agents' repo tokens are refreshed; cost, call, and
  time caps stop new turns; HTTP 429s pause agents on a shared backoff.
- **Speculative batch gating and the pre-pass ratchet.** After a pass, the
  integrator gates prefix candidates of the pending pushes (`--speculate K`,
  default 3) and lands the longest passing one, blaming only the push whose
  candidate failed. Before a pass, the leave-one-out ratchet keeps a
  regressing push off the stack.
- **Scale.** The recorded runs used 3 to 6 workers; cityhall is built for a
  lead and up to 30. `--max-inflight N` puts one shared limit on the model
  calls in flight (turns, edits, planner, tools, decisions), so agent count
  and call concurrency are separate. A worker that stops is replaced while
  open work remains. A board admits 256 agents over its life; `--max` is up
  to 128 at once.

With `--integrator cloud` the integration runs on Cloudflare instead of in the
driver (see the "Integration on Cloudflare" sections of
[docs/BOARD.md](./docs/BOARD.md) and [docs/LIVE-DEPLOY.md](./docs/LIVE-DEPLOY.md);
`make dev-containers` locally, Docker required).

**run-live** is the earlier mode, without the board: the planner decomposes the
goal into single-writer work units, agents are recruited under a min/max
concurrency setting, each push raises a `repo-pushed` event that recruits the
next wave (the Worker's ingress locally, the Artifacts subscription and Queue
when deployed), and failing rounds re-plan and retry on an escalated model.

### What the graph shows

Nodes are the goal, the planner, work items and agents, agent-built tools,
revisions, retries, Jev decisions, and the human. Click a node to see its real
backing (repo, status, evidence).

- The run-live graph has exactly four edge kinds: `dependency` (a declared
  dependency, or a plan/promotion edge), `spawn` (an Artifact `repo-pushed`
  event recruited the target, and only that), `trigger` (control flow: verify
  fail, re-plan, retry), and `consumed-tool` (an agent ran a tool another
  agent built).
- The board graph adds `message` and `contest`, each backed by a recorded
  board message.
- **Agent talk overlay** (toggle `talk on/off`): short labelled arrows for
  recent proposals, contracts, help, handoffs, and conflicts, each citing its
  message; it is an overlay, not an edge kind.
- **Fix-asked lines** from the latest failing revision to the items it asked
  to fix, until they push again.
- **An on-screen legend** of what is drawn right now, with counts.

Everything drawn is backed by a recorded board message; a node or edge without
one is refused (`assertBoardBacked`).

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
   Or use your local Claude Code CLI for every model role: log in with
   `claude` once and set `SWITCHYARD_INFERENCE=claude-cli` (no gateway URL or
   token needed). See [Inference options](#inference-options).

2. **Start the local Worker and console** and leave them running:
   ```bash
   make dev-all       # localhost only
   make dev-all-lan   # reachable from other machines on a trusted LAN (set SWITCHYARD_API_TOKEN first)
   ```

3. **Open `http://127.0.0.1:5173/`**, pick a run mode (run-live or agents on
   the board; on the board, contract decisions wait for you in the console
   unless you pick automatic accept or reject), and launch a template:
   - **Audit logging (intro):** three agents add audit logging to a small
     project; two declare the same file, so the run pauses and asks you which
     one owns it.
   - **Fix a multi-resource API:** `examples/apps/service-api`, six resources
     that skip validation and auth (up to 6 agents on run-live; a lead and up
     to 3 on the board).
   - **Make a storefront correct and safe:** `examples/apps/storefront`, money,
     tax, refund, and auth bugs across three domains, and one developer test
     that pins the old tax rounding, so you decide that test change (a lead
     and up to 6 agents on the board).
   - **Make city hall services correct:** `examples/apps/cityhall`, 32 modules
     across 8 departments, two pinned developer tests, and a 237-test
     acceptance suite (on the board, a lead and up to 30 agents, 8 to start,
     with the same budget flags as `make run-board-cityhall`).

   The console has no concurrency dial: each template runs with its own agent
   counts, shown on its card.

   The console has two views. **Home** (`/`) holds the templates and a
   **Runs** table: the runs this console launched and the last run followed
   with `?watch=`, each opening its run page, and the recorded replays, each
   with **Open replay** when `VITE_REPLAY_URL` points at the replay page (it
   is a separate build: `npm -w apps/console run dev:replay` in dev). One live
   run at a time: while one is in progress the launcher refuses a second
   launch (HTTP 409) and every Launch button is disabled. Every app card has
   **Deploy app (see it broken)**, which deploys the ORIGINAL code to the
   app's stable `workers.dev` URL, and, once deployed, **Remove app** (asks
   first), which deletes that Worker without touching any run's repos.

   Launching opens the **run page** (`?run=<change id>`, with a **<- Home**
   link): only that run, its status, its app panel, its human decisions, and
   its graph or board. The app panel shows the app in two versions side by
   side: **Original** (the production deploy; "Deploy the original app" works
   at any time, also during the run) and **Fixed by this run**. A board run of
   an app template uploads each revision whose gate passes as a preview
   version of the same Worker under one alias, `fixed-<change tag>`
   (`--preview-passing`; failing revisions are not uploaded), so the fixed
   version appears as soon as a revision passes, and the production URL keeps
   the original; if the app is not deployed at launch, the launcher deploys
   the original first. For any other verified run, **Publish the fixed
   version** uploads the promoted commit under the same alias
   (`make publish-fixed`; refused unless the run is verified by a gate that
   ran). Each launch gets a fresh Change id. **Tear down (repos)** asks first,
   is disabled while the run is still running, and deletes that run's Artifact
   repos. A run started from the CLI is followed read-only with
   `?watch=<change id>` (no Tear down; its Publish button shows the exact
   `make publish-fixed ...` command instead).

CLI equivalents (each needs `make dev` or `make dev-all` running):

```bash
make run-board-storefront                        # DECIDE=accept|reject answers the test contract change; unset waits for the console
make run-board-cityhall INFERENCE=claude-cli     # a lead and up to 30 agents (CH_MIN, CH_MAX, CH_INFLIGHT, DECIDE, INTEGRATOR)
make run-board GOAL="..." PROJECT=<dir> MIN=1 MAX=3 [INTEGRATOR=cloud]
make run-live-service                            # the service-api fix on run-live
make run-live-watch                              # the audit-logging run, repos left up; remove with make clean-live
```

The full `run-board` flag list (`--inference`, `--max-inflight`,
`--claim-cap`, `--max-calls`, `--max-spend-usd`, `--price`, `--deploy-app`,
`--preview-revisions`, `--preview-passing`, `--proof-out`, and the rest) is in "Agents on the
board" in [docs/BOARD.md](./docs/BOARD.md), or run
`make cli ARGS="run-board --help"`.

**Hosted infrastructure (optional).** `make infra-up` deploys the hosted
Worker, the Queue, and the Artifacts `repo.pushed` subscription (real,
billable, idempotent). `make infra-status` is read-only ("am I paying for
anything?"). `make infra-down` removes it all, including leftover repos. See
[docs/EVENT-SUBSCRIPTION.md](docs/EVENT-SUBSCRIPTION.md) and
[docs/LIVE-DEPLOY.md](docs/LIVE-DEPLOY.md). The replay page's showcase Workers
(`switchyard-showcase-<app>`, from `make showcase`) are deliberately outside
that teardown; remove one with `make showcase-down APP=<app>`, or take the
whole public demo down (every showcase Worker and the hosted replay page) with
`make public-down`.

## Inference options

Pick the path with `SWITCHYARD_INFERENCE` in `.env` or `--inference <mode>` on
a live command (the flag wins).

| Mode | What it uses | Model roles | Jev (advisory) |
| --- | --- | --- | --- |
| `gateway` (default) | Cloudflare AI Gateway, BYOK: the provider key lives in the Cloudflare account. `EXECUTOR=ai-gateway` plus the gateway URL and token. | planner, agent turns, executor and its escalation ladder, tool authoring | on, with the gateway and account credentials |
| `claude-cli` | The operator's own logged-in Claude Code CLI on this machine, tools disabled, in an empty temp directory, with an allowlisted environment | every model role | off unless `CLI_JEV=gateway` |
| `codex-cli` | The operator's own logged-in OpenAI Codex CLI (`codex exec`) on this machine: read-only sandbox, approvals never granted, no inherited shell environment, web search off, no user config, in an empty temp directory with an allowlisted environment | every model role | off unless `CLI_JEV=gateway` |

`EXECUTOR=workers-ai` gives a Workers AI executor only: no live planner, agent
turns, or Jev. `EXECUTOR` unset (or `noop`) is the offline path. Models and
token ceilings are in [`.env.example`](./.env.example); the CLI path is in
[docs/LOCAL-CLI.md](docs/LOCAL-CLI.md).

## Limits and open items

- The failures we actually hit in live runs, the mechanism and test that now
  stop each one, and what is still open are in
  [docs/FAILURE-MODES.md](./docs/FAILURE-MODES.md) (14 failure modes; see
  "What is still open").
- `board-sim-100` is simulated: it shows the engine at scale, not agents
  fixing code.
- A live run depends on the operator's model access (gateway credits, or a
  local CLI subscription); a gateway reply that reports no credits ends the
  run at once as `quota-exhausted`, never as a pass.
- The cloud integrator has been exercised under `wrangler dev` only (see
  [docs/LIVE-DEPLOY.md](docs/LIVE-DEPLOY.md)).

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
- The CLI reads `.env` into memory and never exports it into its own
  environment, so gates and agent-built tools it runs cannot read a
  credential (`make cli ARGS=env-check` confirms it).
- CLI errors and run logs redact credentials (URL userinfo, Artifact tokens);
  replay exports scrub local paths and refuse anything token-like.
- `make dev-all-lan` exposes the dev control plane (it can launch runs, spend
  inference, and deploy) to the LAN. Set `SWITCHYARD_API_TOKEN` first and use it
  only on a trusted network.

## Repository layout

- `apps/worker`: the control plane (Worker, `ChangeState` Durable Object,
  integration Workflow and gate container).
- `apps/console`: the React/Vite console, its dev launcher, and the replay
  page build (`make replay-build`; recorded runs in
  `apps/console/public/replays`).
- `apps/cli`: the run driver (`make cli ARGS="--help"` lists every command).
- `packages/change-core` (domain, board model, planning),
  `packages/orchestration` (run loops, graph model, inference selection),
  `packages/model-adapters` (AI Gateway and local CLI transports),
  `packages/verification` (gate, integration, path scope),
  `packages/artifact-workspace`, `packages/git-promotion`,
  `packages/local-runner`.
- `examples/`: the three apps (`examples/apps`), goal files, the offline demo
  projects, the scale project generator, and a reference solution for
  cityhall (`examples/reference`).
- `tools/`: infra up/status/down and Artifacts subscription scripts.
- `docs/`: the board, replay, live deploy, local CLI, event subscription, and
  failure-mode notes.

The `Makefile` lists every command.

## License

Apache-2.0. See [LICENSE](./LICENSE).

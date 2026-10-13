# Switchyard Change Fabric: developer tasks
#
# Run tasks manually; there is no CI pipeline. Requires Node.js and npm.
#
#   make install   install all workspace dependencies
#   make dev       run the Worker locally (wrangler dev; the gate container off)
#   make dev-containers  run the Worker locally WITH the integration gate container (needs Docker)
#   make console   run the local console (Vite)
#   make dev-all   run the Worker and the console together
#   make cli ARGS="doctor"   run the switchyard-change CLI
#   make doctor    run the readiness check (switchyard-change doctor)
#   make jev-smoke live check of the decision model's question types and contract triage (needs .env; not in check)
#   make tool-smoke live check: the region filler builds the service-api codemod and its own gate runs (needs .env; not in check)
#   make demo      run the example audit-logging Change end to end (offline)
#   make demo-board  agents form around a goal on the Change board and build tools for each other (offline, deterministic)
#   make run-board   live board run against a running Worker (needs the AI Gateway in .env)
#   make run-live-watch  watchable live run: stable id, escalation fires, repos left up
#   make run-live-service  live run of the MODULAR service-api app (carries the blueprint)
#   make demo-board-storefront  the board on the multi-domain storefront app (offline, deterministic)
#   make run-board-storefront   live board run on the storefront app (needs a running Worker and the AI Gateway)
#   make storefront-gate  install the storefront app's pinned deps and run its gate (fails on the planted gaps)
#   make demo-live   one-command watchable live demo (needs `make dev-all` running)
#   make clean-live  tear down the real repos a watch run left up
#   make seed-change seed the demo Change into a running Worker (for the console)
#   make deploy    deploy the Worker to Cloudflare (wrangler deploy)
#   make deploy-app APP=service-api  deploy an example web app to a live workers.dev URL
#   make delete-app APP=service-api  tear that deployed example app down (stop billing)
#   make export-replay ID=<changeId>  export a recorded board run from a Worker for the replay page (scrubbed)
#   make preview-replay REPLAY=<file> REPO=<integration git dir> APP=<name> [DRY_RUN=1]  backfill revision previews into a replay (uploads Worker versions unless DRY_RUN)
#   make replay-build    build the static replay page (recorded runs, no Worker, no credentials)
#   make replay-preview  serve the replay build locally (REPLAY_PORT, default 4180)
#   make deploy-replay   deploy the replay page as Workers static assets (a REAL deploy: confirm first)
#   make delete-replay   delete that deployed replay page
#   make infra-up      spin the hosted Cloudflare infra up (deploy + queue + subscription), idempotent
#   make infra-status  read-only: what is live right now (am I paying for anything?)
#   make infra-down    spin the hosted Cloudflare infra down (delete worker + queue + subscription + repos), idempotent
#   make build     build every workspace
#   make typecheck typecheck every workspace
#   make test      run every workspace's tests
#   make check     typecheck + build + test (the full local check)
#   make example   lint + build + test the example demo-project only
#   make clean      remove build output

.PHONY: export-replay preview-replayreplay-build replay-preview deploy-replay delete-replay jev-smoke tool-smoke install dev dev-containers console dev-all dev-all-lan cli doctor demo demo-board run-board decompose decompose-audit run-goal recruit recruit-live run-live run-live-watch run-live-service demo-board-storefront run-board-storefront storefront-gate demo-live clean-live seed-change deploy deploy-app delete-app artifacts-subscribe infra-up infra-down infra-status build typecheck test check example example-install example-lint example-build example-test clean

install:
	npm install

# --- local dev loop ---

# The Worker's control plane is fail-closed: with no SWITCHYARD_API_TOKEN it
# refuses every mutating route unless SWITCHYARD_ALLOW_UNAUTHENTICATED=1 opts
# in. The local dev targets below opt in (a var passed to `wrangler dev` only,
# never to a deploy), so the local loop needs no credential. A token set in a
# gitignored apps/worker/.dev.vars still applies: the opt-in only matters
# while no token is set. Override WORKER_DEV_VARS= to run local dev closed.
WORKER_DEV_VARS ?= --var SWITCHYARD_ALLOW_UNAUTHENTICATED:1

# Run the Cloudflare Worker locally under wrangler dev. The Artifacts binding is
# configured with remote=true, so authenticate first: either `wrangler login`,
# or put a scoped CLOUDFLARE_API_TOKEN in a gitignored .env (sourced below).
dev:
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/worker run dev -- $(WORKER_DEV_VARS)

# Run the Worker locally WITH the integration gate container (Cloudflare
# Containers under wrangler dev build the image with Docker): what
# `run-board --integrator cloud` needs. `make dev` runs without it (no Docker
# needed); integration then stays with the local driver.
dev-containers:
	set -a; [ -f .env ] && . ./.env; set +a; \
	WRANGLER_ENABLE_CONTAINERS=true npm -w apps/worker run dev -- $(WORKER_DEV_VARS)

# Run the local console (Vite dev server).
console:
	npm -w apps/console run dev

# Run the Worker and the console together (Ctrl-C stops both). Sources .env for
# the Worker ONLY, so its remote Artifacts binding authenticates with
# CLOUDFLARE_API_TOKEN (the same as the `dev` target); the console and the runs
# its launcher spawns never get it in their environment (the CLI reads .env
# into memory itself).
dev-all:
	(set -a; [ -f .env ] && . ./.env; set +a; npm -w apps/worker run dev -- $(WORKER_DEV_VARS)) & \
	npm -w apps/console run dev & \
	wait

# Same as dev-all but reachable from OTHER machines on the LAN. The Worker binds
# 0.0.0.0 (WRANGLER_DEV_IP), the console (Vite) already binds 0.0.0.0 via
# host:true, and VITE_WORKER_URL is set to this host's LAN IP so the remote
# browser AND the spawned runs reach the Worker by its LAN address, not
# 127.0.0.1. Override LAN_IP=... to pick a specific interface. AUTH: set
# SWITCHYARD_API_TOKEN (the Worker secret, via a gitignored apps/worker/.dev.vars,
# and the same value in .env) to require a bearer on every Worker mutation;
# without it the Worker control plane is unauthenticated (this target opts in
# with WORKER_DEV_VARS, like every dev target). The console launcher
# (launch runs, spend AI/Artifacts, deploy) has no auth of its own either way,
# so only use this on a trusted network.
LAN_IP ?= $(shell hostname -I 2>/dev/null | awk '{print $$1}')
dev-all-lan:
	@echo "LAN console: http://$(LAN_IP):5173  (Worker: http://$(LAN_IP):8787)"
	@echo "Set SWITCHYARD_API_TOKEN (apps/worker/.dev.vars + the same value in .env) to require a bearer on Worker mutations; otherwise the Worker is unauthenticated. The console launcher is open to the LAN: trusted networks only."
	(set -a; [ -f .env ] && . ./.env; set +a; WRANGLER_DEV_IP=0.0.0.0 npm -w apps/worker run dev -- $(WORKER_DEV_VARS)) & \
	VITE_WORKER_URL=http://$(LAN_IP):8787 npm -w apps/console run dev & \
	wait

# Credentials and the CLI: no target exports .env into the CLI's environment.
# Code the CLI runs (app gates, agent-built tools) could read a parent's
# initial environment (/proc/<pid>/environ), so the CLI reads .env itself into
# memory and passes each credential only to the code that needs it.
# `make cli ARGS=env-check` confirms its environment holds no credential.
# Targets that run wrangler or curl themselves (dev, deploy, infra-*) still
# source .env for those processes only; dev-all gives it to the Worker alone.
#
# Run the switchyard-change CLI, e.g. `make cli ARGS="doctor"`.
cli:
	npm -w apps/cli run dev -- $(ARGS)

# Check local prerequisites and print a readiness report. The CLI reads .env
# into memory, so the live-Artifacts reachability probe sees CLOUDFLARE_API_TOKEN.
doctor:
	npm -w apps/cli run dev -- doctor

# Run the example audit-logging Change end to end, deterministically and
# offline (noop executor + honest local fallback, no Cloudflare account, no
# real inference). It prints a readable summary with the shared-path collision
# coordinated by a write lease (one owner, no silent merge). Then it runs a
# second goal whose work needs a repeated edit across many files, so an agent
# builds a codemod the downstream units run: the agent-for-agent tool-build
# moment, visible in that run's summary.
demo:
	npm -w apps/cli run dev -- run $(CURDIR)/examples/changes/audit-logging.change.yaml
	@echo ""
	@echo "=== Agent-for-agent tooling: a goal whose work needs a shared codemod ==="
	@echo ""
	npm -w apps/cli run dev -- run-goal \
	  --goal-file $(CURDIR)/examples/goals/add-input-validation.goal.txt \
	  --project $(CURDIR)/examples/calc-project

# Agents that FORM around a goal on the Change board, offline and deterministic:
# the lead's first turn decomposes the goal (the heuristic offline stub) into
# proposed items, workers join under the min/max dial and claim them, an
# overlapping claim is contested and resolved by narrowing, a worker asks the
# other party a question (a `to`-addressed message) and gets a reply, each
# worker edits in its own repo (the deterministic scoped executor) and announces
# its push, and the continuous integrator builds a revision as pushes land. The
# noop executor can never satisfy the demo project's declared gate, so the
# generic offline gate FIXTURE REPLACES it (offline only, labeled in the run:
# this demo shows coordination, not a real fix; a live run always uses the
# project's gate): it fails the first revision (naming a file it changed), the board
# asks that item's owner for a fix, the owner pushes again, the next revision
# passes, the board derives each item's completion, and the last (passing)
# revision is promoted to local Git. Every agent turn is taken by a generic,
# goal-agnostic policy standing in for the turn model, so the printed board
# transcript is identical run to run. No credentials, no network.
# Agents also build tools for each other: when the planned items repeat one
# mechanical change across several files, one worker proposes a scanner and
# another a codemod; the lead accepts them, their proposers build them in the
# Change's tools repo (the deterministic offline template author writes them),
# each passes its OWN gate on the original code before the engine publishes it,
# and other agents run the pinned versions in their own repos (the engine
# records every use). A second run, on the multi-resource example app, shows a
# scanner finding places no item covers: its builder proposes that work, the
# lead accepts it, and it completes through the normal gate. Formation shows
# too: in the first run an owner grants part of its item to a helper that
# FORKS its repo, and pulls the helper's commit; in the second the owner of the
# scanner-found item SPLITS it, other agents claim the children, and it merges
# their pushes as the sub-lead. The summary prints both and the codemod timing.
BOARD_GOAL = $(CURDIR)/examples/goals/audit-logging.goal.txt
BOARD_PROJECT = $(CURDIR)/examples/demo-project
TOOLS_GOAL = $(CURDIR)/examples/goals/service-api-validation-auth.goal.txt
TOOLS_PROJECT = $(CURDIR)/examples/apps/service-api

# The human's answer to contract changes on the original tests during the demo
# (accept or reject); the demo rejects, so the tests item adds a NEW test file.
DECIDE_CONTRACTS ?= reject

demo-board:
	npm -w apps/cli run dev -- run-board --offline --fixture-gate --decide-contracts $(DECIDE_CONTRACTS) --goal-file "$(BOARD_GOAL)" --project "$(BOARD_PROJECT)" \
	  --min $(MIN) --max $(MAX)
	@echo ""
	@echo "=== Agents build tools for each other: a scanner's findings become work (and a split with a sub-lead) ==="
	@echo ""
	npm -w apps/cli run dev -- run-board --offline --fixture-gate --decide-contracts $(DECIDE_CONTRACTS) --goal-file "$(TOOLS_GOAL)" --project "$(TOOLS_PROJECT)" \
	  --min $(MIN) --max $(MAX)

# Decompose a goal against a target project into a WorkGraph and print the plan
# plus schedule, deterministically and offline (the heuristic analyzer, no live
# inference). Defaults to the second seeded goal (add input validation to every
# exported function) against the calc-project, whose natural decomposition is a
# wide, flat graph. Override GOAL and PROJECT to decompose anything else.
GOAL ?= $(shell cat $(CURDIR)/examples/goals/add-input-validation.goal.txt)
PROJECT ?= $(CURDIR)/examples/calc-project

decompose:
	npm -w apps/cli run dev -- decompose "$(GOAL)" --project "$(PROJECT)"

# Decompose the audit-logging goal against the demo-project, whose natural
# decomposition is a layered graph with dependency edges (contrast with the flat
# `make decompose`): two different goals, two shapes, one decomposer.
decompose-audit:
	npm -w apps/cli run dev -- decompose \
	  --goal-file $(CURDIR)/examples/goals/audit-logging.goal.txt \
	  --project $(CURDIR)/examples/demo-project

# Decompose a goal and run the resulting WorkGraph to completion offline, ending
# in a promoted local Git commit. Same GOAL/PROJECT overrides as `make decompose`.
run-goal:
	npm -w apps/cli run dev -- run-goal "$(GOAL)" --project "$(PROJECT)"

# Recruit agents against a goal under a min/max concurrency dial, offline and
# deterministically: each recruited agent gets its own local-fallback workspace,
# and each wave after the first is driven by a repo-pushed event (not a timer).
# Override MIN/MAX to turn the dial and watch concurrency widen through the same
# code path. Defaults to the flat calc-project goal so all units are runnable at
# once and the dial is the only bound.
MIN ?= 1
MAX ?= 3

recruit:
	npm -w apps/cli run dev -- recruit "$(GOAL)" --project "$(PROJECT)" --min $(MIN) --max $(MAX)

# Recruit agents into REAL Cloudflare Artifact repos through a running Worker.
# Start the Worker first in another terminal with `make dev` (wrangler dev with
# the Artifacts binding remote=true; authenticate with `wrangler login` or a
# scoped CLOUDFLARE_API_TOKEN in a gitignored .env). Then run this: multiple
# agents concurrently hold distinct real Artifact repos and push to them, each
# wave after the first driven by the repo-pushed event. Raise MAX to widen
# concurrency. The run deletes the real repos it created on the way out. A goal
# run plans with the LLM (EXECUTOR=ai-gateway in .env); without a live planner it
# fails unless you pass --allow-heuristic-planner.
WORKER ?= http://127.0.0.1:8787

recruit-live:
	npm -w apps/cli run dev -- recruit-live "$(GOAL)" --project "$(PROJECT)" --worker "$(WORKER)" --min $(MIN) --max $(MAX)

# The full live headline run against a running Worker (start it with `make dev`
# in another terminal). It decomposes a goal, recruits real agents into real
# Cloudflare Artifact repos, runs the chosen executor per agent (set
# EXECUTOR=ai-gateway plus the AI Gateway URL/token in .env: the LLM planner and
# the executor both run through the gateway; without a live planner a goal run
# fails unless you pass --allow-heuristic-planner), drives event-driven waves,
# runs the human escalation beat, then verifies, integrates, promotes to local
# Git, and cleans up the real repos.
# Keep inference cheap: a small seeded project and a low MAX. Override GOAL /
# PROJECT / OWNER as needed; OWNER answers the escalation non-interactively.
OWNER ?=

run-live:
	npm -w apps/cli run dev -- run-live "$(GOAL)" --project "$(PROJECT)" --worker "$(WORKER)" \
	  --min $(MIN) --max $(MAX) $(if $(OWNER),--owner $(OWNER),)

# A LIVE board run against a running Worker (start it with `make dev`): the
# planner, every agent turn, and the executor run through the AI Gateway
# (EXECUTOR=ai-gateway plus the gateway URL/token in .env); without a live turn
# model the command refuses. Each worker joins with its own Artifact repo and a
# short-lived write token. Override GOAL / PROJECT / MIN / MAX as needed.
run-board:
	npm -w apps/cli run dev -- run-board "$(GOAL)" --project "$(PROJECT)" --worker "$(WORKER)" \
	  --min $(MIN) --max $(MAX) $(if $(INTEGRATOR),--integrator $(INTEGRATOR),)

# The live run against the MODULAR service-api app. `make run-live` defaults to
# the flat calc-project, whose decomposition is a wide, flat fan-out with no
# cohesion blueprint (deriveCohesionBlueprint returns nothing for a non-modular
# repo), so a live run of it carries no frozen contracts and no per-module
# exports. This target mirrors the console's service-api template instead: it
# decomposes the modular examples/apps/service-api with its own goal, so the run
# carries the cohesion blueprint (the src/contracts/* frozen seams and each
# resource module's exports) all the way to the agent prompt. Use this to run the
# multi-resource API fix from the CLI; the browser "Fix a multi-resource API"
# template already uses the same modular target.
SERVICE_GOAL = $(CURDIR)/examples/goals/service-api-validation-auth.goal.txt
SERVICE_PROJECT = $(CURDIR)/examples/apps/service-api

run-live-service:
	npm -w apps/cli run dev -- run-live --goal-file "$(SERVICE_GOAL)" --project "$(SERVICE_PROJECT)" \
	  --worker "$(WORKER)" --min $(MIN) --max $(MAX) $(if $(OWNER),--owner $(OWNER),)

# The SECOND example app: a multi-domain storefront (catalog, orders, billing)
# over shared money, http, and auth contracts, written in TypeScript with a
# lockfile (typescript + vitest), so a run installs dependencies before its gate.
# Its planted gaps give each board path a real reason to happen (see
# examples/apps/storefront/README.md): one mechanical change repeated across many
# handlers (a scanner and a codemod pay off), a billing domain with several
# distinct sub-changes (a split or help candidate), a shared money contract that
# must change (a contract proposal, then rebases), and one existing test that
# pins the old tax rounding (a human decides that contract change; rejecting it
# leaves the gate failing, honestly). The engine treats it like any project.
#
# demo-board-storefront runs it offline and deterministically with the generic
# fixture gate (coordination only, not a real fix; no credentials). The live run
# needs a running Worker (`make dev`) and the AI Gateway in .env; set
# DECIDE=accept|reject to answer the test contract change from the CLI, or
# leave it unset to answer in the console. storefront-gate runs the app's own
# gate locally (it FAILS on the baseline; that is the point).
STOREFRONT_GOAL = $(CURDIR)/examples/goals/storefront-correct-and-safe.goal.txt
STOREFRONT_PROJECT = $(CURDIR)/examples/apps/storefront
DECIDE ?=

demo-board-storefront:
	npm -w apps/cli run dev -- run-board --offline --fixture-gate --decide-contracts $(DECIDE_CONTRACTS) --goal-file "$(STOREFRONT_GOAL)" --project "$(STOREFRONT_PROJECT)" \
	  --min $(MIN) --max $(MAX)

# SF_MAX unset: the dial's max scales with the plan size (min(items, 6)).
# DECIDE unset: contract changes wait for a human in the console (never auto-accept).
SF_MAX ?=
run-board-storefront:
	npm -w apps/cli run dev -- run-board --goal-file "$(STOREFRONT_GOAL)" --project "$(STOREFRONT_PROJECT)" --worker "$(WORKER)" \
	  --min $(MIN) $(if $(SF_MAX),--max $(SF_MAX),) $(if $(INTEGRATOR),--integrator $(INTEGRATOR),) $(if $(DECIDE),--decide-contracts $(DECIDE),)

storefront-gate:
	cd examples/apps/storefront && npm ci --no-audit --no-fund && npm run gate

# The watchable live headline run. It uses the seeded audit-logging Change (which
# has the hardcoded src/audit/events.ts collision), so the human escalation beat
# fires EVERY time, and it runs in watch mode: a STABLE Change id
# (change-audit-logging, not a per-run id), and it LEAVES the real Artifact repos
# and the Change state in place at the end so you can inspect the finished graph.
# The console's normal path is its own template gallery (which launches and
# follows its own unique run); this CLI run's state can be read directly from the
# Worker at /changes/<id>. Start the Worker and console first with `make dev-all`,
# run this, then inspect it. Tear the real repos down with `make clean-live` when
# you are done watching.
AUDIT_CHANGE = $(CURDIR)/examples/changes/audit-logging.change.yaml
DEMO_PROJECT = $(CURDIR)/examples/demo-project
CHANGE_ID ?= change-audit-logging

run-live-watch:
	npm -w apps/cli run dev -- run-live --change "$(AUDIT_CHANGE)" --project "$(DEMO_PROJECT)" \
	  --worker "$(WORKER)" --min $(MIN) --max $(MAX) --watch $(if $(OWNER),--owner $(OWNER),)

# The one-command watchable live demo. It checks the local Worker and console
# are reachable (start them with `make dev-all` in another terminal first; if
# they are not up it prints that instruction and exits non-zero rather than
# backgrounding long-lived dev servers), seeds the demo audit Change, runs the
# watchable live run (stable id change-audit-logging, escalation beat fires,
# real Artifact repos left up), and prints the console URL to open to watch the
# morph. The executor comes from .env (set EXECUTOR=ai-gateway with the AI
# Gateway URL/token for real inference; unset means the deterministic noop).
# Tear the real repos down afterwards with `make clean-live`.
demo-live:
	bash tools/demo-live.sh

# Tear down the real Artifact repos a watch-mode run (make run-live-watch) left
# in place, through the running Worker. Override CHANGE_ID if you watched a
# different Change id.
clean-live:
	npm -w apps/cli run dev -- cleanup-live --change-id "$(CHANGE_ID)" --worker "$(WORKER)"

# Seed the example audit-logging Change into a running Worker so the console
# shows a live graph without hand-POSTing YAML (the create-a-Change path for the
# clone-and-run story). Start the Worker first with `make dev` or `make dev-all`.
# The console's own template gallery is the normal browser path to launch a run.
seed-change:
	curl -s -X POST -H "content-type: text/plain" \
	  --data-binary @"$(AUDIT_CHANGE)" "$(WORKER)/changes" >/dev/null \
	  && echo "Seeded Change change-audit-logging into $(WORKER). Read it at $(WORKER)/changes/change-audit-logging."

# Deploy the Worker to Cloudflare (wrangler deploy). This is the single hosted
# Worker with the Artifacts + AI bindings and the repo-pushed Queue consumer, so
# a real Artifacts event subscription can deliver repo.pushed events to the
# deployed consumer. Authenticate first (wrangler login, or a scoped
# CLOUDFLARE_API_TOKEN in .env). Tear it down with `npx wrangler delete` from
# apps/worker. See docs/EVENT-SUBSCRIPTION.md.
deploy:
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/worker run deploy

# Provision the Artifacts event subscription that delivers repo-pushed events to
# the Worker's Queue consumer, against the live account. This is the real
# event-driven nervous system (the Queue consumer in apps/worker/src/index.ts).
# It needs a scoped CLOUDFLARE_API_TOKEN with Queues + Artifacts access. See
# docs/EVENT-SUBSCRIPTION.md for the exact steps and the honest status of the
# feature on this account.
artifacts-subscribe:
	set -a; [ -f .env ] && . ./.env; set +a; \
	bash tools/artifacts-subscribe.sh

# Spin the hosted Cloudflare infrastructure UP as one idempotent command:
# deploy the Worker, ensure the repo-pushed Queue, and ensure the Artifacts
# repo.pushed event subscription pointed at that Queue. Anything already present
# is left in place. Prints the deployed Worker URL and a summary of what now
# exists. This deploys a REAL hosted Worker + Queue + subscription on the
# account in your .env; tear it down with `make infra-down`. See the README.
infra-up:
	set -a; [ -f .env ] && . ./.env; set +a; \
	bash tools/infra-up.sh

# Read-only report of what Change Fabric infrastructure is live on the account
# right now (deployed Worker reachable? queue? subscription? how many Artifact
# repos in the namespace?), so anyone can answer "am I paying for anything?".
# Creates and deletes nothing.
infra-status:
	set -a; [ -f .env ] && . ./.env; set +a; \
	bash tools/infra-status.sh

# Spin the hosted Cloudflare infrastructure DOWN as one idempotent command:
# delete ONLY this project's named resources (the Artifacts subscription, the
# Queue switchyard-change-fabric-repo-pushed, the deployed Worker) plus any
# leftover switchyard-change-fabric Artifact repos so nothing keeps billing. It
# prints exactly what it deletes, errors on nothing already gone, and confirms
# the namespace is empty at the end. See the README.
infra-down:
	set -a; [ -f .env ] && . ./.env; set +a; \
	bash tools/infra-down.sh

# --- example web apps (deploy-to-live-URL de-risk) ---

# Deploy one example web app under examples/apps/<APP> to a live Cloudflare
# `workers.dev` URL and print the reachable URL. This is the deploy-to-live-URL
# hop: a tiny real Worker goes from source to a clickable page in one command.
# Authenticate first with a scoped CLOUDFLARE_API_TOKEN in a gitignored .env
# (sourced below) or `wrangler login`. Tear it down with `make delete-app`.
# See docs/LIVE-DEPLOY.md. The example apps are: service-api, storefront.
# Defaults to service-api.
APP ?= service-api

deploy-app:
	set -a; [ -f .env ] && . ./.env; set +a; \
	cd examples/apps/$(APP) && npx wrangler deploy

# Tear the deployed example app down so it stops billing. It reads the worker
# name from the app's wrangler.jsonc and deletes it over the Cloudflare REST API
# using CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN. This works with a scoped
# deploy token (plain `wrangler delete` also tries to read account membership
# roles, which a narrowly scoped token may lack). Idempotent: a worker that is
# already gone is reported and treated as success. See docs/LIVE-DEPLOY.md.
delete-app:
	set -a; [ -f .env ] && . ./.env; set +a; \
	name=$$(sed -nE 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' examples/apps/$(APP)/wrangler.jsonc | head -1); \
	echo "Deleting Worker $$name ..."; \
	curl -sS -X DELETE \
	  "https://api.cloudflare.com/client/v4/accounts/$$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$$name?force=true" \
	  -H "Authorization: Bearer $$CLOUDFLARE_API_TOKEN" | \
	  grep -qE '"success"[[:space:]]*:[[:space:]]*true|does not exist' \
	  && echo "Teardown complete: $$name is not deployed." \
	  || { echo "Teardown may have failed; check the account."; exit 1; }

# --- the static replay page (recorded runs, zero cost to view) ---

# Export a recorded board run for the replay page: pages the full board log
# (GET /changes/:id/board?after=) and the snapshot from a running Worker, scrubs
# local absolute paths (/tmp/..., /home/...) to repo-relative or <work>/
# placeholders, REFUSES to write when anything token-like (Bearer, art_v*, long
# hex/base64 secrets) or the value of any env var named *TOKEN*, *SECRET*, *KEY*,
# or *ACCOUNT* remains, and writes apps/console/public/replays/<ID>.json plus its
# index.json entry. The board GET is open: no credential is read or sent, and
# .env is NOT sourced. TITLE / APP / DESCRIPTION set the index entry (kept from
# a previous export otherwise).
ID ?=
TITLE ?=
DESCRIPTION ?=
export-replay:
	@test -n "$(ID)" || { echo "usage: make export-replay ID=<changeId> [WORKER=$(WORKER)] [TITLE=...] [APP=...] [DESCRIPTION=...]"; exit 2; }
	npm -w apps/console run export-replay -- --id "$(ID)" --worker "$(WORKER)" \
	  $(if $(TITLE),--title "$(TITLE)",) $(if $(filter command line,$(origin APP)),--app "$(APP)",) $(if $(DESCRIPTION),--description "$(DESCRIPTION)",)

# Backfill revision previews into a recorded replay: each integrated revision
# whose commit is still in the run's integration repo is uploaded as a Worker
# VERSION of the app's stable worker under a preview alias (never a production
# deploy; needs the Worker to exist and CLOUDFLARE_* in .env, which the CLI
# reads into memory). DRY_RUN=1 plans only (no upload, nothing written).
preview-replay:
	@test -n "$(REPLAY)" && test -n "$(REPO)" && test -n "$(APP)" || { echo "usage: make preview-replay REPLAY=<replay.json> REPO=<integration git dir> APP=<app name> [DRY_RUN=1]"; exit 2; }
	npm -w apps/cli run dev -- preview-replay --replay "$(abspath $(REPLAY))" --repo "$(abspath $(REPO))" --app "$(APP)" $(if $(DRY_RUN),--dry-run,)

# Build the static replay page into apps/console/dist-replay: the console's
# mission control over the recorded runs in apps/console/public/replays, with no
# launcher, no Worker, no polling, and relative asset paths (works from a
# subpath or the root). Open a run with ?run=<id>, a moment with &seq=<n>.
replay-build:
	npm -w apps/console run build:replay

# Serve the replay build locally (a static preview; nothing live runs).
REPLAY_PORT ?= 4180
replay-preview: replay-build
	npm -w apps/console run preview:replay -- --host 127.0.0.1 --port $(REPLAY_PORT) --strictPort

# Deploy the replay page to a live workers.dev URL as Workers static assets
# (apps/console/wrangler.replay.jsonc: no Worker code, no bindings). This is a
# REAL deploy on the account in .env (CLOUDFLARE_ACCOUNT_ID + a scoped
# CLOUDFLARE_API_TOKEN, or `wrangler login`): confirm before running it. Static
# asset requests are free on Workers, so viewing it costs nothing. Remove it
# with `make delete-replay`. Uses the repo's pinned wrangler.
deploy-replay: replay-build
	set -a; [ -f .env ] && . ./.env; set +a; \
	cd apps/console && ../../node_modules/.bin/wrangler deploy -c wrangler.replay.jsonc

# Delete the deployed replay page (same REST approach as delete-app, so a
# narrowly scoped deploy token works). Idempotent: already gone is success.
delete-replay:
	set -a; [ -f .env ] && . ./.env; set +a; \
	name=$$(sed -nE 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' apps/console/wrangler.replay.jsonc | head -1); \
	echo "Deleting Worker $$name ..."; \
	curl -sS -X DELETE \
	  "https://api.cloudflare.com/client/v4/accounts/$$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$$name?force=true" \
	  -H "Authorization: Bearer $$CLOUDFLARE_API_TOKEN" | \
	  grep -qE '"success"[[:space:]]*:[[:space:]]*true|does not exist' \
	  && echo "Teardown complete: $$name is not deployed." \
	  || { echo "Teardown may have failed; check the account."; exit 1; }

# Opt-in LIVE check of the decision model (never part of make check): one call
# per question type (noul, choice, score) plus the contract-triage question a
# board run asks before a human decides a contract change (same question and
# state builder, synthetic data), printing PASS/FAIL, so an API drift
# is caught at once instead of surfacing as silently skipped decisions. Needs
# EXECUTOR=ai-gateway with the gateway and account credentials in .env.
jev-smoke:
	npm -w apps/cli run dev -- jev-smoke

# Opt-in LIVE check of agent-built tool reliability (never part of make check):
# the live region filler builds the codemod for the service-api plan, and the
# tool's OWN gate runs on a copy of the app, ATTEMPTS times (default 3), with
# no board, no Worker, and no Cloudflare resource. Prints PASS/FAIL per build
# and the pass rate. Needs EXECUTOR=ai-gateway with the gateway credentials in
# .env (read into memory by the CLI). ARGS passes extra flags (--rebuilds N).
ATTEMPTS ?= 3
tool-smoke:
	npm -w apps/cli run dev -- tool-smoke --attempts $(ATTEMPTS) $(ARGS)

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

check: typecheck build test

# --- example demo-project (the Change target) ---

EXAMPLE_DIR = examples/demo-project

example-install:
	cd $(EXAMPLE_DIR) && npm install --no-audit --no-fund

example-lint: example-install
	cd $(EXAMPLE_DIR) && npm run lint

example-build: example-install
	cd $(EXAMPLE_DIR) && npm run build

example-test: example-install
	cd $(EXAMPLE_DIR) && npm test

example: example-lint example-build example-test

clean:
	npm run clean --workspaces --if-present || true
	cd $(EXAMPLE_DIR) && npm run clean || true

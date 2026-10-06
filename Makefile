# Switchyard Change Fabric: developer tasks
#
# Run tasks manually; there is no CI pipeline. Requires Node.js and npm.
#
#   make install   install all workspace dependencies
#   make dev       run the Worker locally (wrangler dev)
#   make console   run the local console (Vite)
#   make dev-all   run the Worker and the console together
#   make cli ARGS="doctor"   run the switchyard-change CLI
#   make doctor    run the readiness check (switchyard-change doctor)
#   make demo      run the example audit-logging Change end to end (offline)
#   make run-live-watch  watchable live run: stable id, escalation fires, repos left up
#   make run-live-service  live run of the MODULAR service-api app (carries the blueprint)
#   make demo-live   one-command watchable live demo (needs `make dev-all` running)
#   make clean-live  tear down the real repos a watch run left up
#   make seed-change seed the demo Change into a running Worker (for the console)
#   make deploy    deploy the Worker to Cloudflare (wrangler deploy)
#   make deploy-app APP=service-api  deploy an example web app to a live workers.dev URL
#   make delete-app APP=service-api  tear that deployed example app down (stop billing)
#   make infra-up      spin the hosted Cloudflare infra up (deploy + queue + subscription), idempotent
#   make infra-status  read-only: what is live right now (am I paying for anything?)
#   make infra-down    spin the hosted Cloudflare infra down (delete worker + queue + subscription + repos), idempotent
#   make build     build every workspace
#   make typecheck typecheck every workspace
#   make test      run every workspace's tests
#   make check     typecheck + build + test (the full local check)
#   make example   lint + build + test the example demo-project only
#   make clean      remove build output

.PHONY: install dev console dev-all dev-all-lan cli doctor demo decompose decompose-audit run-goal recruit recruit-live run-live run-live-watch run-live-service demo-live clean-live seed-change deploy deploy-app delete-app artifacts-subscribe infra-up infra-down infra-status build typecheck test check example example-install example-lint example-build example-test clean

install:
	npm install

# --- local dev loop ---

# Run the Cloudflare Worker locally under wrangler dev. The Artifacts binding is
# configured with remote=true, so authenticate first: either `wrangler login`,
# or put a scoped CLOUDFLARE_API_TOKEN in a gitignored .env (sourced below).
dev:
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/worker run dev

# Run the local console (Vite dev server).
console:
	npm -w apps/console run dev

# Run the Worker and the console together (Ctrl-C stops both). Sources .env so
# the Worker's remote Artifacts binding authenticates with CLOUDFLARE_API_TOKEN
# (the same as the `dev` target); without it `wrangler dev` cannot establish the
# remote proxy session in a non-interactive shell.
dev-all:
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/worker run dev & \
	npm -w apps/console run dev & \
	wait

# Same as dev-all but reachable from OTHER machines on the LAN. The Worker binds
# 0.0.0.0 (WRANGLER_DEV_IP), the console (Vite) already binds 0.0.0.0 via
# host:true, and VITE_WORKER_URL is set to this host's LAN IP so the remote
# browser AND the spawned runs reach the Worker by its LAN address, not
# 127.0.0.1. Override LAN_IP=... to pick a specific interface. NOTE: this exposes
# an UNAUTHENTICATED dev control plane (it can launch runs, spend AI/Artifacts,
# and deploy) to everyone on the LAN; only use it on a trusted network.
LAN_IP ?= $(shell hostname -I 2>/dev/null | awk '{print $$1}')
dev-all-lan:
	@echo "LAN console: http://$(LAN_IP):5173  (Worker: http://$(LAN_IP):8787)"
	@echo "WARNING: this exposes an unauthenticated dev control plane to the LAN."
	set -a; [ -f .env ] && . ./.env; set +a; \
	export WRANGLER_DEV_IP=0.0.0.0; \
	export VITE_WORKER_URL=http://$(LAN_IP):8787; \
	npm -w apps/worker run dev & \
	VITE_WORKER_URL=http://$(LAN_IP):8787 npm -w apps/console run dev & \
	wait

# Run the switchyard-change CLI, e.g. `make cli ARGS="doctor"`.
cli:
	npm -w apps/cli run dev -- $(ARGS)

# Check local prerequisites and print a readiness report. Sources .env when
# present so the live-Artifacts reachability probe sees CLOUDFLARE_API_TOKEN.
doctor:
	set -a; [ -f .env ] && . ./.env; set +a; \
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
# concurrency. The run deletes the real repos it created on the way out.
WORKER ?= http://127.0.0.1:8787

recruit-live:
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/cli run dev -- recruit-live "$(GOAL)" --project "$(PROJECT)" --worker "$(WORKER)" --min $(MIN) --max $(MAX)

# The full live headline run against a running Worker (start it with `make dev`
# in another terminal). It decomposes a goal, recruits real agents into real
# Cloudflare Artifact repos, runs the chosen executor per agent (set
# EXECUTOR=workers-ai in .env for real inference; otherwise the deterministic
# noop), drives event-driven waves, runs the human escalation beat, then
# verifies, integrates, promotes to local Git, and cleans up the real repos.
# Keep inference cheap: a small seeded project and a low MAX. Override GOAL /
# PROJECT / OWNER as needed; OWNER answers the escalation non-interactively.
OWNER ?=

run-live:
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/cli run dev -- run-live "$(GOAL)" --project "$(PROJECT)" --worker "$(WORKER)" \
	  --min $(MIN) --max $(MAX) $(if $(OWNER),--owner $(OWNER),)

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
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/cli run dev -- run-live --goal-file "$(SERVICE_GOAL)" --project "$(SERVICE_PROJECT)" \
	  --worker "$(WORKER)" --min $(MIN) --max $(MAX) $(if $(OWNER),--owner $(OWNER),)

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
	set -a; [ -f .env ] && . ./.env; set +a; \
	npm -w apps/cli run dev -- run-live --change "$(AUDIT_CHANGE)" --project "$(DEMO_PROJECT)" \
	  --worker "$(WORKER)" --min $(MIN) --max $(MAX) --watch $(if $(OWNER),--owner $(OWNER),)

# The one-command watchable live demo. It checks the local Worker and console
# are reachable (start them with `make dev-all` in another terminal first; if
# they are not up it prints that instruction and exits non-zero rather than
# backgrounding long-lived dev servers), seeds the demo audit Change, runs the
# watchable live run (stable id change-audit-logging, escalation beat fires,
# real Artifact repos left up), and prints the console URL to open to watch the
# morph. The executor comes from .env (set EXECUTOR=workers-ai for real
# inference). Tear the real repos down afterwards with `make clean-live`.
demo-live:
	set -a; [ -f .env ] && . ./.env; set +a; \
	bash tools/demo-live.sh

# Tear down the real Artifact repos a watch-mode run (make run-live-watch) left
# in place, through the running Worker. Override CHANGE_ID if you watched a
# different Change id.
clean-live:
	set -a; [ -f .env ] && . ./.env; set +a; \
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
# See docs/LIVE-DEPLOY.md. The example app is: service-api.
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

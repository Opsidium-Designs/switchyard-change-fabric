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
#   make build     build every workspace
#   make typecheck typecheck every workspace
#   make test      run every workspace's tests
#   make check     typecheck + build + test (the full local check)
#   make example   lint + build + test the example demo-project only
#   make clean      remove build output

.PHONY: install dev console dev-all cli doctor demo decompose decompose-audit run-goal build typecheck test check example example-install example-lint example-build example-test clean

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

# Run the Worker and the console together (Ctrl-C stops both).
dev-all:
	npm -w apps/worker run dev & \
	npm -w apps/console run dev & \
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
# real inference). Prints a readable summary ending in a promoted local Git
# commit.
demo:
	npm -w apps/cli run dev -- run $(CURDIR)/examples/changes/audit-logging.change.yaml

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
# `make decompose`). This is the anti-puppet contrast on the command line.
decompose-audit:
	npm -w apps/cli run dev -- decompose \
	  --goal-file $(CURDIR)/examples/goals/audit-logging.goal.txt \
	  --project $(CURDIR)/examples/demo-project

# Decompose a goal and run the resulting WorkGraph to completion offline, ending
# in a promoted local Git commit. Same GOAL/PROJECT overrides as `make decompose`.
run-goal:
	npm -w apps/cli run dev -- run-goal "$(GOAL)" --project "$(PROJECT)"

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

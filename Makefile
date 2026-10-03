# Switchyard Change Fabric — developer tasks
#
# Run tasks manually; there is no CI pipeline. Requires Node.js and npm.
#
#   make install   install all workspace dependencies
#   make build     build every workspace
#   make typecheck typecheck every workspace
#   make test      run every workspace's tests
#   make check     typecheck + build + test (the full local check)
#   make example   lint + build + test the example demo-project only
#   make clean      remove build output

.PHONY: install build typecheck test check example example-install example-lint example-build example-test clean

install:
	npm install

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

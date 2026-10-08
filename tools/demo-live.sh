#!/usr/bin/env bash
#
# One-command watchable live demo. It:
#   1. checks the local Worker (wrangler dev) and the local console (Vite) are
#      reachable; if either is not, it prints a clear instruction to start them
#      with `make dev-all` in another terminal and exits non-zero (it does NOT
#      try to background and babysit those long-lived dev servers, so this never
#      leaves orphaned processes behind);
#   2. seeds the demo audit Change into the running Worker;
#   3. runs the watchable live run (run-live --watch against the seeded
#      audit-logging Change) so the human escalation beat fires, using the
#      STABLE Change id 'change-audit-logging' and leaving the real Artifact
#      repos up for watching;
#   4. prints the console URL to open to watch the morph.
#
# The executor comes from .env (set EXECUTOR=ai-gateway for real inference).
# Cleanup is the separate `make clean-live`.
#
# Requires a running `make dev-all`. The make target sources your gitignored
# .env for you; this script never prints the token.

set -u

WORKER="${WORKER:-http://127.0.0.1:8787}"
CONSOLE_URL="${CONSOLE_URL:-http://127.0.0.1:5173}"
CHANGE_ID="${CHANGE_ID:-change-audit-logging}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

AUDIT_CHANGE="${AUDIT_CHANGE:-${REPO_ROOT}/examples/changes/audit-logging.change.yaml}"
DEMO_PROJECT="${DEMO_PROJECT:-${REPO_ROOT}/examples/demo-project}"
MIN="${MIN:-1}"
MAX="${MAX:-3}"

fail() {
  echo "demo-live: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

echo "== Step 1: check the local Worker and console are up =="

WORKER_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER}/" 2>/dev/null)
CONSOLE_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${CONSOLE_URL}/" 2>/dev/null)

if [ "${WORKER_HEALTH}" != "200" ] || [ "${CONSOLE_HEALTH}" = "000" ]; then
  echo ""
  echo "The local demo stack is not fully reachable:"
  echo "  Worker  ${WORKER}/        -> HTTP ${WORKER_HEALTH}"
  echo "  Console ${CONSOLE_URL}/   -> HTTP ${CONSOLE_HEALTH}"
  echo ""
  echo "Start the Worker and console together in ANOTHER terminal, then re-run"
  echo "this demo:"
  echo ""
  echo "    make dev-all      # terminal 1 (leave it running)"
  echo "    make demo-live    # terminal 2 (this command)"
  echo ""
  echo "demo-live does not start those long-lived dev servers itself, so it"
  echo "never leaves orphaned processes behind. See the README live demo section."
  exit 1
fi

echo "Worker  ${WORKER}/        -> HTTP ${WORKER_HEALTH} (ok)"
echo "Console ${CONSOLE_URL}/   -> HTTP ${CONSOLE_HEALTH} (ok)"
echo ""

echo "== Step 2: seed the demo audit Change '${CHANGE_ID}' into the Worker =="
curl -s -X POST -H "content-type: text/plain" \
  --data-binary @"${AUDIT_CHANGE}" "${WORKER}/changes" >/dev/null \
  && echo "Seeded Change ${CHANGE_ID} into ${WORKER}." \
  || echo "Seed POST returned non-zero (the run below also creates the Change if needed)."
echo ""

echo "== Step 3: watchable live run (escalation beat fires; repos left up) =="
echo "Executor comes from .env (EXECUTOR). Set EXECUTOR=ai-gateway for real"
echo "inference; otherwise the deterministic noop executor runs."
echo ""
# run-live --watch uses the stable Change id and leaves the real Artifact repos
# and Change state in place so the finished graph can be watched in the console.
( cd "${REPO_ROOT}" && npm -w apps/cli run dev -- run-live \
    --change "${AUDIT_CHANGE}" --project "${DEMO_PROJECT}" \
    --worker "${WORKER}" --min "${MIN}" --max "${MAX}" --watch ${OWNER:+--owner "${OWNER}"} )
RUN_STATUS=$?
echo ""

echo "== Step 4: watch it morph in the browser =="
echo "This CLI run used the Change id '${CHANGE_ID}'. The console's normal path"
echo "is its own template gallery (open ${CONSOLE_URL}/ and launch a template),"
echo "which starts and follows its own unique run. To inspect THIS CLI run's"
echo "state directly, read it from the Worker:"
echo ""
echo "    curl -s ${WORKER}/changes/${CHANGE_ID}"
echo ""
echo "When you are done watching, tear the real Artifact repos down with:"
echo ""
echo "    make clean-live"
echo ""

exit ${RUN_STATUS}

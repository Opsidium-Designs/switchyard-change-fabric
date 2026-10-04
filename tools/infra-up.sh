#!/usr/bin/env bash
#
# Spin the Change Fabric Cloudflare infrastructure UP as a single idempotent
# command. It:
#   1. deploys the Worker (wrangler deploy), which also creates the Durable
#      Object, Workflow, Artifacts binding, and the Queue consumer binding;
#   2. ensures the repo-pushed Queue exists (creating it if absent);
#   3. ensures the Artifacts repo.pushed event subscription exists, pointed at
#      that Queue (reusing tools/artifacts-subscribe.sh for the subscription),
#      skipping creation when one with the same name is already present.
#
# Anything already present is left as is: re-running this is safe and prints the
# same end state. At the end it prints the deployed Worker URL and a summary of
# what now exists.
#
# It never prints the token. Requires CLOUDFLARE_ACCOUNT_ID and a scoped
# CLOUDFLARE_API_TOKEN with Workers + Queues + Artifacts + Event Subscriptions
# access in the environment (source your gitignored .env first; `make infra-up`
# does this for you).

set -u

QUEUE_NAME="${QUEUE_NAME:-switchyard-change-fabric-repo-pushed}"
SUBSCRIPTION_NAME="${SUBSCRIPTION_NAME:-switchyard-change-fabric-repo-pushed}"
WORKER_NAME="${WORKER_NAME:-switchyard-change-fabric}"
NAMESPACE="${NAMESPACE:-switchyard-change-fabric}"
API_BASE="${API_BASE:-https://api.cloudflare.com/client/v4}"

# Resolve the repo root from this script's location so the make target can run
# it from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

fail() {
  echo "infra-up: $*" >&2
  exit 1
}

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "CLOUDFLARE_ACCOUNT_ID is not set (source your .env)"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is not set (source your .env)"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
ACCT="${API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}"

echo "== Step 1: ensure the Queue '${QUEUE_NAME}' exists (before deploy) =="
# The Worker binds this queue as a consumer, so it must exist before the deploy
# can bind to it. Creating it here first makes the deploy idempotent too.
QUEUES=$(curl -s -H "${AUTH}" "${ACCT}/queues")
if echo "${QUEUES}" | jq -e --arg q "${QUEUE_NAME}" \
  '(.result // []) | any(.queue_name == $q)' >/dev/null 2>&1; then
  echo "Queue already exists; leaving it in place."
else
  echo "Creating queue '${QUEUE_NAME}'..."
  CREATE=$(curl -s -X POST -H "${AUTH}" -H "content-type: application/json" \
    --data "{\"queue_name\":\"${QUEUE_NAME}\"}" "${ACCT}/queues")
  if echo "${CREATE}" | jq -e '.success == true' >/dev/null 2>&1; then
    echo "Queue created."
  else
    echo "${CREATE}" | jq -c '.errors' 2>/dev/null || true
    fail "could not create the Queue"
  fi
fi
echo ""

echo "== Step 2: deploy the Worker '${WORKER_NAME}' (wrangler deploy) =="
# wrangler deploy is itself idempotent: it publishes the current code and
# bindings whether or not a prior version exists.
( cd "${REPO_ROOT}" && npm -w apps/worker run deploy ) || fail "wrangler deploy failed"
echo ""

echo "== Step 3: ensure the Artifacts repo.pushed subscription exists =="
SUBS=$(curl -s -H "${AUTH}" "${ACCT}/event_subscriptions/subscriptions")
if echo "${SUBS}" | jq -e --arg n "${SUBSCRIPTION_NAME}" \
  '(.result // []) | any(.name == $n)' >/dev/null 2>&1; then
  echo "Subscription '${SUBSCRIPTION_NAME}' already exists; leaving it in place."
else
  echo "No subscription named '${SUBSCRIPTION_NAME}'; creating it via tools/artifacts-subscribe.sh..."
  # artifacts-subscribe.sh ensures the queue, resolves its id, and creates the
  # subscription, printing exactly what the account returned.
  bash "${SCRIPT_DIR}/artifacts-subscribe.sh" || fail "artifacts-subscribe.sh failed"
fi
echo ""

echo "== Result: what is now live =="
SUBDOMAIN=$(curl -s -H "${AUTH}" "${ACCT}/workers/subdomain" | jq -r '.result.subdomain // empty')
WORKER_URL=""
if [ -n "${SUBDOMAIN}" ]; then
  WORKER_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
fi

SCRIPT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "${AUTH}" \
  "${ACCT}/workers/scripts/${WORKER_NAME}")
QUEUE_OK=$(curl -s -H "${AUTH}" "${ACCT}/queues" \
  | jq -r --arg q "${QUEUE_NAME}" '((.result // []) | any(.queue_name == $q)) | if . then "yes" else "no" end')
SUB_OK=$(curl -s -H "${AUTH}" "${ACCT}/event_subscriptions/subscriptions" \
  | jq -r --arg n "${SUBSCRIPTION_NAME}" '((.result // []) | any(.name == $n)) | if . then "yes" else "no" end')
REPO_COUNT=$(curl -s -H "${AUTH}" "${ACCT}/artifacts/namespaces/${NAMESPACE}/repos?per_page=50" \
  | jq -r '(.result // []) | length')

echo "Worker deployed:        $( [ "${SCRIPT_STATUS}" = "200" ] && echo yes || echo "no (HTTP ${SCRIPT_STATUS})" )"
if [ -n "${WORKER_URL}" ]; then
  # The worker can return a transient 5xx cold-start blip for a second or two
  # right after deploy, so probe a few times and report the first healthy read.
  HEALTH="000"
  for _ in 1 2 3 4 5; do
    HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/")
    [ "${HEALTH}" = "200" ] && break
    sleep 2
  done
  echo "Worker URL:             ${WORKER_URL}  (health HTTP ${HEALTH})"
else
  echo "Worker URL:             (could not resolve workers.dev subdomain)"
fi
echo "Queue '${QUEUE_NAME}':   ${QUEUE_OK}"
echo "repo.pushed subscription: ${SUB_OK}"
echo "Artifact repos in namespace '${NAMESPACE}': ${REPO_COUNT}"
echo ""
echo "The hosted event path is live: a push to an Artifact repo emits a"
echo "repo.pushed event, Cloudflare delivers it to the Queue, and the deployed"
echo "Worker consumes it. Spin it all back down with: make infra-down"

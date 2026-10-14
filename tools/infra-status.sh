#!/usr/bin/env bash
#
# Report what Change Fabric infrastructure is currently live on the Cloudflare
# account, so anyone can answer "am I paying for anything right now?". This is
# strictly read-only: it creates and deletes nothing.
#
# It reports:
#   1. whether the deployed Worker is reachable (and its URL);
#   2. whether the repo-pushed Queue exists;
#   3. whether the Artifacts repo.pushed event subscription exists;
#   4. how many Artifact repos currently sit in the namespace.
#
# It never prints the token. Requires CLOUDFLARE_ACCOUNT_ID and a scoped
# CLOUDFLARE_API_TOKEN in the environment (source your gitignored .env first;
# `make infra-status` does this for you).

set -u

QUEUE_NAME="${QUEUE_NAME:-switchyard-change-fabric-repo-pushed}"
SUBSCRIPTION_NAME="${SUBSCRIPTION_NAME:-switchyard-change-fabric-repo-pushed}"
NAMESPACE="${NAMESPACE:-switchyard-change-fabric}"
WORKER_NAME="${WORKER_NAME:-switchyard-change-fabric}"
API_BASE="${API_BASE:-https://api.cloudflare.com/client/v4}"

fail() {
  echo "infra-status: $*" >&2
  exit 1
}

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "CLOUDFLARE_ACCOUNT_ID is not set (source your .env)"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is not set (source your .env)"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
ACCT="${API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}"

# Resolve the workers.dev subdomain so the Worker URL is reported precisely.
SUBDOMAIN=$(curl -s -H "${AUTH}" "${ACCT}/workers/subdomain" | jq -r '.result.subdomain // empty')
WORKER_URL=""
if [ -n "${SUBDOMAIN}" ]; then
  WORKER_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
fi

echo "== Change Fabric infrastructure status =="
echo "Account: ${CLOUDFLARE_ACCOUNT_ID}"
echo ""

# 1. Deployed Worker: is the script present, and does its URL answer?
echo "-- Worker '${WORKER_NAME}' --"
SCRIPT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "${AUTH}" \
  "${ACCT}/workers/scripts/${WORKER_NAME}")
if [ "${SCRIPT_STATUS}" = "200" ]; then
  echo "deployed:    yes (script present on the account)"
  if [ -n "${WORKER_URL}" ]; then
    HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/")
    if [ "${HEALTH}" = "200" ]; then
      echo "reachable:   yes (HTTP 200)"
    else
      echo "reachable:   no (HTTP ${HEALTH:-unknown})"
    fi
    echo "url:         ${WORKER_URL}"
  else
    echo "url:         (could not resolve workers.dev subdomain)"
  fi
else
  echo "deployed:    no"
fi
# Also list any deployed app workers ('${WORKER_NAME}-*'), e.g. a forgotten
# example-app deploy, so a leak is never hidden by only checking the one name.
APP_WORKERS=$(curl -s -H "${AUTH}" "${ACCT}/workers/scripts" \
  | jq -r --arg w "${WORKER_NAME}" \
    '(.result // [])[] | .id | select(startswith($w + "-") and . != ($w + "-replay"))' | sort -u)
if [ -n "${APP_WORKERS}" ]; then
  echo "app workers: PRESENT (torn down by 'make infra-down'):"
  echo "${APP_WORKERS}" | sed 's/^/  - /'
else
  echo "app workers: none"
fi
echo ""

# 2. Queue.
echo "-- Queue '${QUEUE_NAME}' --"
QUEUES=$(curl -s -H "${AUTH}" "${ACCT}/queues")
if echo "${QUEUES}" | jq -e --arg q "${QUEUE_NAME}" \
  '(.result // []) | any(.queue_name == $q)' >/dev/null 2>&1; then
  echo "exists:      yes"
else
  echo "exists:      no"
fi
echo ""

# 3. Event subscription.
echo "-- Artifacts repo.pushed subscription '${SUBSCRIPTION_NAME}' --"
SUBS=$(curl -s -H "${AUTH}" "${ACCT}/event_subscriptions/subscriptions")
if echo "${SUBS}" | jq -e --arg n "${SUBSCRIPTION_NAME}" \
  '(.result // []) | any(.name == $n)' >/dev/null 2>&1; then
  echo "exists:      yes"
else
  echo "exists:      no"
fi
echo ""

# 4. Artifact repos in the namespace.
echo "-- Artifact repos in namespace '${NAMESPACE}' --"
REPOS=$(curl -s -H "${AUTH}" "${ACCT}/artifacts/namespaces/${NAMESPACE}/repos?per_page=50")
if echo "${REPOS}" | jq -e '.success == true' >/dev/null 2>&1; then
  COUNT=$(echo "${REPOS}" | jq -r '(.result // []) | length')
  echo "count:       ${COUNT}"
  if [ "${COUNT}" != "0" ]; then
    echo "${REPOS}" | jq -r '(.result // [])[] | "  - " + (.name // .id)'
  fi
else
  echo "count:       (namespace query failed; see response below)"
  echo "${REPOS}" | jq -c '.errors' 2>/dev/null || true
fi
echo ""

echo "== Summary =="
if [ "${SCRIPT_STATUS}" = "200" ]; then
  echo "Something IS live on this account (at least the deployed Worker)."
  echo "Spin it all down with: make infra-down"
else
  echo "No deployed Worker found. Check the lines above for a stray Queue,"
  echo "subscription, or Artifact repos that could still bill."
fi

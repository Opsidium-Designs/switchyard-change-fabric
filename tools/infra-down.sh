#!/usr/bin/env bash
#
# Spin the Change Fabric Cloudflare infrastructure DOWN as a single idempotent
# command. It deletes ONLY this project's named resources:
#   1. the Artifacts repo.pushed event subscription named
#      'switchyard-change-fabric-repo-pushed';
#   2. the Queue 'switchyard-change-fabric-repo-pushed';
#   3. the deployed Worker 'switchyard-change-fabric';
#   4. ALL leftover Artifact repos in the 'switchyard-change-fabric' namespace
#      (so nothing keeps billing). The namespace is itself the project boundary,
#      so every repo in it (control-plane runs, 'console-*' template runs,
#      'change-*' CLI runs, tool repos) is swept by default. Set REPO_PREFIX to
#      narrow to only names with a given prefix if you ever need that.
#
# It is idempotent: anything already gone is reported as "already absent" with
# NO error. It prints EXACTLY what it is about to delete before deleting it, and
# it NEVER touches resources outside the switchyard-change-fabric* names above.
# At the end it confirms the namespace is empty.
#
# It never prints the token. Requires CLOUDFLARE_ACCOUNT_ID and a scoped
# CLOUDFLARE_API_TOKEN in the environment (source your gitignored .env first;
# `make infra-down` does this for you).

set -u

QUEUE_NAME="${QUEUE_NAME:-switchyard-change-fabric-repo-pushed}"
SUBSCRIPTION_NAME="${SUBSCRIPTION_NAME:-switchyard-change-fabric-repo-pushed}"
WORKER_NAME="${WORKER_NAME:-switchyard-change-fabric}"
NAMESPACE="${NAMESPACE:-switchyard-change-fabric}"
# Only repos whose name starts with this prefix are eligible for deletion. The
# namespace is already project-scoped, but this is an explicit second guard so a
# stray repo from unrelated work is never touched.
# REPO_PREFIX is UNSET by default so the whole project namespace is swept.
# Set it (e.g. REPO_PREFIX=console-) to narrow deletion to a name prefix.
REPO_PREFIX="${REPO_PREFIX:-}"
API_BASE="${API_BASE:-https://api.cloudflare.com/client/v4}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

fail() {
  echo "infra-down: $*" >&2
  exit 1
}

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "CLOUDFLARE_ACCOUNT_ID is not set (source your .env)"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is not set (source your .env)"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
ACCT="${API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}"

echo "== Change Fabric infrastructure spin-down =="
echo "This deletes ONLY these named resources on account ${CLOUDFLARE_ACCOUNT_ID}:"
echo "  - subscription '${SUBSCRIPTION_NAME}'"
echo "  - queue '${QUEUE_NAME}'"
echo "  - worker '${WORKER_NAME}'"
echo "  - ALL Artifact repos in namespace '${NAMESPACE}'${REPO_PREFIX:+ named '${REPO_PREFIX}*'}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: delete the Artifacts repo.pushed event subscription (before the
# queue, since the subscription points at the queue).
# ---------------------------------------------------------------------------
echo "== Step 1: Artifacts repo.pushed subscription '${SUBSCRIPTION_NAME}' =="
SUBS=$(curl -s -H "${AUTH}" "${ACCT}/event_subscriptions/subscriptions")
SUB_IDS=$(echo "${SUBS}" | jq -r --arg n "${SUBSCRIPTION_NAME}" \
  '(.result // [])[] | select(.name == $n) | .id')
if [ -z "${SUB_IDS}" ]; then
  echo "already absent; nothing to delete."
else
  for sid in ${SUB_IDS}; do
    echo "DELETING subscription id ${sid} (name '${SUBSCRIPTION_NAME}')..."
    RESP=$(curl -s -w "\nHTTP:%{http_code}" -X DELETE -H "${AUTH}" \
      "${ACCT}/event_subscriptions/subscriptions/${sid}")
    STATUS=$(echo "${RESP}" | sed -n 's/.*HTTP:\([0-9]*\).*/\1/p')
    if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "202" ] || [ "${STATUS}" = "204" ] || [ "${STATUS}" = "404" ]; then
      echo "  deleted (or already gone)."
    else
      echo "${RESP}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'
      echo "  WARNING: unexpected status ${STATUS:-unknown} deleting subscription ${sid}."
    fi
  done
fi
echo ""

# ---------------------------------------------------------------------------
# Step 2: delete the Queue.
# ---------------------------------------------------------------------------
echo "== Step 2: Queue '${QUEUE_NAME}' =="
QUEUES=$(curl -s -H "${AUTH}" "${ACCT}/queues")
QUEUE_ID=$(echo "${QUEUES}" | jq -r --arg q "${QUEUE_NAME}" \
  '(.result // [])[] | select(.queue_name == $q) | .queue_id' | head -n1)
if [ -z "${QUEUE_ID}" ] || [ "${QUEUE_ID}" = "null" ]; then
  echo "already absent; nothing to delete."
else
  echo "DELETING queue '${QUEUE_NAME}' (id ${QUEUE_ID})..."
  RESP=$(curl -s -w "\nHTTP:%{http_code}" -X DELETE -H "${AUTH}" \
    "${ACCT}/queues/${QUEUE_ID}")
  STATUS=$(echo "${RESP}" | sed -n 's/.*HTTP:\([0-9]*\).*/\1/p')
  if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "202" ] || [ "${STATUS}" = "204" ] || [ "${STATUS}" = "404" ]; then
    echo "  deleted (or already gone)."
  else
    echo "${RESP}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'
    echo "  WARNING: unexpected status ${STATUS:-unknown} deleting the queue."
    echo "  (A queue with an attached consumer must have the Worker removed"
    echo "   first; Step 3 does that, so re-running infra-down clears it.)"
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Step 3: delete the deployed Worker.
# ---------------------------------------------------------------------------
echo "== Step 3: deployed Worker '${WORKER_NAME}' =="
SCRIPT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "${AUTH}" \
  "${ACCT}/workers/scripts/${WORKER_NAME}")
if [ "${SCRIPT_STATUS}" != "200" ]; then
  echo "already absent (no deployed script); nothing to delete."
else
  echo "DELETING worker '${WORKER_NAME}'..."
  # Prefer the REST delete (force=true also detaches queue consumer bindings),
  # so the queue in Step 2 is deletable on a single pass.
  RESP=$(curl -s -w "\nHTTP:%{http_code}" -X DELETE -H "${AUTH}" \
    "${ACCT}/workers/scripts/${WORKER_NAME}?force=true")
  STATUS=$(echo "${RESP}" | sed -n 's/.*HTTP:\([0-9]*\).*/\1/p')
  if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "202" ] || [ "${STATUS}" = "204" ] || [ "${STATUS}" = "404" ]; then
    echo "  deleted."
  else
    echo "${RESP}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'
    echo "  WARNING: unexpected status ${STATUS:-unknown} deleting the worker."
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Step 2b: with the Worker (and its consumer binding) gone, retry the queue
# delete if it is still present. This makes a single infra-down pass fully
# tear down even when the consumer binding blocked the first attempt.
# ---------------------------------------------------------------------------
QUEUES=$(curl -s -H "${AUTH}" "${ACCT}/queues")
QUEUE_ID=$(echo "${QUEUES}" | jq -r --arg q "${QUEUE_NAME}" \
  '(.result // [])[] | select(.queue_name == $q) | .queue_id' | head -n1)
if [ -n "${QUEUE_ID}" ] && [ "${QUEUE_ID}" != "null" ]; then
  echo "== Step 2 (retry): Queue '${QUEUE_NAME}' still present after worker delete =="
  echo "DELETING queue '${QUEUE_NAME}' (id ${QUEUE_ID})..."
  RESP=$(curl -s -w "\nHTTP:%{http_code}" -X DELETE -H "${AUTH}" \
    "${ACCT}/queues/${QUEUE_ID}")
  STATUS=$(echo "${RESP}" | sed -n 's/.*HTTP:\([0-9]*\).*/\1/p')
  if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "202" ] || [ "${STATUS}" = "204" ] || [ "${STATUS}" = "404" ]; then
    echo "  deleted (or already gone)."
  else
    echo "${RESP}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'
    echo "  WARNING: unexpected status ${STATUS:-unknown} deleting the queue on retry."
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Step 4: delete leftover Artifact repos in the namespace so nothing bills.
# The namespace '${NAMESPACE}' IS the project boundary (every repo in it belongs
# to this project: control-plane runs, console template runs named
# 'console-*', CLI runs named 'change-*', tool repos, etc.), so by default we
# sweep ALL repos in it. Set REPO_PREFIX to narrow to only names with a given
# prefix if you ever need the conservative behavior.
# ---------------------------------------------------------------------------
echo "== Step 4: leftover Artifact repos in namespace '${NAMESPACE}' =="
REPOS=$(curl -s -H "${AUTH}" "${ACCT}/artifacts/namespaces/${NAMESPACE}/repos?per_page=100")
if ! echo "${REPOS}" | jq -e '.success == true' >/dev/null 2>&1; then
  echo "could not list repos (the namespace may not exist yet); treating as empty."
  echo "${REPOS}" | jq -c '.errors' 2>/dev/null || true
else
  if [ -n "${REPO_PREFIX:-}" ]; then
    # Optional narrowing: only delete names starting with REPO_PREFIX.
    NAMES=$(echo "${REPOS}" | jq -r --arg p "${REPO_PREFIX}" \
      '(.result // [])[] | (.name // .id) | select(startswith($p))')
    SKIPPED=$(echo "${REPOS}" | jq -r --arg p "${REPO_PREFIX}" \
      '(.result // [])[] | (.name // .id) | select(startswith($p) | not)')
    if [ -n "${SKIPPED}" ]; then
      echo "NOT touching these repos (REPO_PREFIX='${REPO_PREFIX}' set; name does not match):"
      echo "${SKIPPED}" | sed 's/^/  - /'
    fi
  else
    # Default: the namespace is project-scoped, so clean every repo in it.
    NAMES=$(echo "${REPOS}" | jq -r '(.result // [])[] | (.name // .id)')
  fi
  if [ -z "${NAMES}" ]; then
    echo "no leftover repos in the namespace; nothing to delete."
  else
    while IFS= read -r name; do
      [ -n "${name}" ] || continue
      echo "DELETING Artifact repo '${name}'..."
      RESP=$(curl -s -w "\nHTTP:%{http_code}" -X DELETE -H "${AUTH}" \
        "${ACCT}/artifacts/namespaces/${NAMESPACE}/repos/${name}")
      STATUS=$(echo "${RESP}" | sed -n 's/.*HTTP:\([0-9]*\).*/\1/p')
      if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "202" ] || [ "${STATUS}" = "204" ] || [ "${STATUS}" = "404" ]; then
        echo "  deleted (or already gone)."
      else
        echo "${RESP}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'
        echo "  WARNING: unexpected status ${STATUS:-unknown} deleting repo '${name}'."
      fi
    done <<EOF
${NAMES}
EOF
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Final confirmation: the namespace should be empty.
# ---------------------------------------------------------------------------
echo "== Confirming namespace '${NAMESPACE}' is empty =="
REPOS=$(curl -s -H "${AUTH}" "${ACCT}/artifacts/namespaces/${NAMESPACE}/repos?per_page=50")
COUNT=$(echo "${REPOS}" | jq -r '(.result // []) | length' 2>/dev/null || echo "unknown")
echo "Artifact repos remaining in namespace: ${COUNT}"
echo ""
echo "== Spin-down complete =="
echo "Confirm the full picture any time with: make infra-status"

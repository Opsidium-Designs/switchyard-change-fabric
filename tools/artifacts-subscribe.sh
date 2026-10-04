#!/usr/bin/env bash
#
# Provision the Artifacts repo-pushed event subscription that feeds the Worker's
# Queue consumer, against the live Cloudflare account. This is the real
# event-driven nervous system: a push to an Artifact repo emits a repo.pushed
# event that Cloudflare delivers to a Queue, which this Worker consumes (the
# queue() handler in apps/worker/src/index.ts).
#
# It is deliberately explicit and honest. It:
#   1. ensures the Queue exists (creating it if needed);
#   2. attempts to create the event subscription pointing Artifacts repo events
#      at that Queue, using the documented REST API;
#   3. prints exactly what the account returned, so an open-beta gap is visible
#      rather than hidden.
#
# It never prints the token. Requires CLOUDFLARE_ACCOUNT_ID and a scoped
# CLOUDFLARE_API_TOKEN with Queues + Artifacts + Event Subscriptions access in
# the environment (source your gitignored .env first; `make artifacts-subscribe`
# does this for you).
#
# If the Artifacts event-subscription feature is not available on the account
# (a real possibility in open beta), this does NOT fake it: it reports the
# precise API response for a human to escalate.

set -u

QUEUE_NAME="${QUEUE_NAME:-switchyard-change-fabric-repo-pushed}"
API_BASE="${API_BASE:-https://api.cloudflare.com/client/v4}"
# The verified namespace-level Artifacts source discriminator. (A single-repo
# subscription uses "artifacts.repo" and also requires source.namespace and
# source.repo_name; the namespace-level "artifacts" source covers every repo in
# the account's Artifacts, which is what the fabric wants.)
SOURCE_TYPE="${SOURCE_TYPE:-artifacts}"
EVENT="${EVENT:-repo.pushed}"

fail() {
  echo "artifacts-subscribe: $*" >&2
  exit 1
}

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "CLOUDFLARE_ACCOUNT_ID is not set (source your .env)"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is not set (source your .env)"
command -v curl >/dev/null 2>&1 || fail "curl is required"

AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
ACCT="${API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}"

echo "== Step 1: ensure the Queue '${QUEUE_NAME}' exists =="
# List queues; create the named one if it is absent. Output is printed for the
# record; the token is only ever in the Authorization header, never echoed.
LIST=$(curl -s -H "${AUTH}" "${ACCT}/queues")
echo "${LIST}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'
if echo "${LIST}" | grep -q "\"queue_name\":\"${QUEUE_NAME}\""; then
  echo "Queue already exists."
else
  echo "Creating queue '${QUEUE_NAME}'..."
  CREATE=$(curl -s -X POST -H "${AUTH}" -H "content-type: application/json" \
    --data "{\"queue_name\":\"${QUEUE_NAME}\"}" "${ACCT}/queues")
  echo "${CREATE}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'
fi

echo ""
echo "== Step 2: find the Queue id =="
QUEUE_ID=$(curl -s -H "${AUTH}" "${ACCT}/queues" \
  | tr ',' '\n' | grep -A1 "\"queue_name\":\"${QUEUE_NAME}\"" | grep '"queue_id"' \
  | head -n1 | sed 's/.*"queue_id":"\([^"]*\)".*/\1/')
if [ -z "${QUEUE_ID}" ]; then
  # Fall back to a broader parse (field order can vary).
  QUEUE_ID=$(curl -s -H "${AUTH}" "${ACCT}/queues" \
    | python3 -c "import sys,json
d=json.load(sys.stdin)
for q in d.get('result',[]):
  if q.get('queue_name')=='${QUEUE_NAME}':
    print(q.get('queue_id',''));break" 2>/dev/null)
fi
[ -n "${QUEUE_ID}" ] || fail "could not determine the Queue id for '${QUEUE_NAME}'"
echo "Queue id: ${QUEUE_ID}"

echo ""
echo "== Step 3: create the Artifacts repo.pushed event subscription =="
echo "Pointing source '${SOURCE_TYPE}' event '${EVENT}' at queue '${QUEUE_NAME}' (${QUEUE_ID})."
# The event subscriptions API shape (open beta). We send the documented request
# and print exactly what comes back, success or failure.
SUB_BODY=$(cat <<JSON
{
  "name": "switchyard-change-fabric-repo-pushed",
  "source": { "type": "${SOURCE_TYPE}" },
  "destination": { "type": "queues.queue", "queue_id": "${QUEUE_ID}" },
  "events": ["${EVENT}"]
}
JSON
)
SUB=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST -H "${AUTH}" \
  -H "content-type: application/json" --data "${SUB_BODY}" \
  "${ACCT}/event_subscriptions/subscriptions")
echo "${SUB}" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g'

echo ""
echo "== Result =="
STATUS=$(echo "${SUB}" | sed -n 's/.*HTTP_STATUS:\([0-9]*\).*/\1/p')
if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "201" ]; then
  echo "Event subscription created. A real repo.pushed will now be delivered to"
  echo "the Worker's Queue consumer. Verify with a live push and the Worker log."
else
  echo "Event subscription NOT created (HTTP ${STATUS:-unknown})."
  echo "This is reported honestly rather than faked: the Artifacts event-"
  echo "subscription feature may not be available on this account in open beta,"
  echo "or the token lacks the scope. Capture the response above and escalate."
  echo "The HTTP ingress path (POST /events/repo-pushed) exercises the identical"
  echo "downstream handler in the meantime, so the engine still runs end to end."
fi

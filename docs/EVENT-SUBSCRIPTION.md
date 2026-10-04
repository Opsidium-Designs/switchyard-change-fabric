# Artifacts repo-pushed events through a Queue

The Change Fabric drives each recruitment wave from a real `repo.pushed` event:
an agent finishing a WorkUnit pushes to its own Artifact repo, Cloudflare emits
a `repo.pushed` event, and that event drives the next wave. This is the
event-driven nervous system, not a poll and not a timer.

Two delivery paths exist, and they share one downstream handler so there is no
second code path to drift:

1. The real path: a Cloudflare Artifacts event subscription delivers the
   `repo.pushed` event to a Queue, and this Worker is wired as that queue's
   consumer (the `queue` handler in `apps/worker/src/index.ts`, bound to the
   queue in `apps/worker/wrangler.jsonc`).
2. The ingress path: `POST /events/repo-pushed` on the Worker calls the exact
   same downstream handler (`handleRepoPushed`), so the offline test substrate
   and a run on an account without a provisioned subscription both exercise the
   identical recruitment logic.

## Provisioning the subscription

Authenticate with a scoped `CLOUDFLARE_API_TOKEN` (never committed; keep it in
your gitignored `.env`) that has Queues, Artifacts, and Event Subscriptions
access on the account in `CLOUDFLARE_ACCOUNT_ID`, then run:

```bash
make artifacts-subscribe
```

That target sources your `.env` and runs `tools/artifacts-subscribe.sh`, which:

1. ensures the Queue `switchyard-change-fabric-repo-pushed` exists (creating it
   if needed);
2. resolves the Queue id;
3. creates the Artifacts `repo.pushed` event subscription pointed at that Queue,
   using the documented REST API;
4. prints exactly what the account returned (with any token field redacted).

The script never prints the token.

### Manual equivalent

```bash
set -a; . ./.env; set +a
ACCT="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# 1. create the queue (idempotent: skip if it already exists)
curl -s -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "content-type: application/json" \
  --data '{"queue_name":"switchyard-change-fabric-repo-pushed"}' \
  "$ACCT/queues"

# 2. find the queue id
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$ACCT/queues"

# 3. create the event subscription (QUEUE_ID from step 2)
#    source.type is "artifacts" (namespace-level, every repo). A single-repo
#    subscription uses "artifacts.repo" and additionally requires
#    source.namespace and source.repo_name.
curl -s -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "name":"switchyard-change-fabric-repo-pushed",
    "source":{"type":"artifacts"},
    "destination":{"type":"queues.queue","queue_id":"QUEUE_ID"},
    "events":["repo.pushed"]
  }' \
  "$ACCT/event_subscriptions/subscriptions"
```

## The real event shape

A verified live `repo.pushed` delivery to the queue looks like this (abbreviated):

```json
{
  "type": "cf.artifacts.repo.pushed",
  "source": { "namespace": "switchyard-change-fabric", "repoName": "<workspace>", "type": "artifacts" },
  "metadata": { "eventSubscriptionId": "...", "eventSchemaVersion": 1, "eventTimestamp": "..." },
  "payload": { "ref": "refs/heads/main", "after": "<commit sha>", "commits": [ ... ] }
}
```

The pushed Artifact repo (the workspace) is `source.repoName`. The Worker's Queue
consumer reads it from there (falling back to flat `workspace`/`repo` fields for a
hand-posted or test event), maps it back to its Change by the `<changeId>--<unitId>`
naming, and drives the next recruitment wave.

## Honest status (open beta): what is proven and what is not

Proven live against the account:

- The Queue is created, the `artifacts` namespace-level `repo.pushed` event
  subscription is created against it, and real pushes to Artifact repos DO
  deliver real `cf.artifacts.repo.pushed` messages to that Queue (verified by
  attaching a temporary HTTP pull consumer and reading the delivered messages,
  each carrying the real commit SHA an agent pushed and the subscription id).

Not yet proven, and why:

- A full push-to-wave through the queue requires the Worker's `queue()` consumer
  to actually receive the message. Under `wrangler dev` the Worker runs locally
  and consumes a LOCAL queue simulation, so a remote event subscription delivering
  to the remote Queue does not reach the local-dev consumer. Driving the next wave
  from the real queued message therefore needs the Worker DEPLOYED (`wrangler
  deploy`) so its real Queue consumer runs in Cloudflare. The code path is wired
  and the delivery is proven; the deployed consume-and-recruit leg is the piece a
  deploy would close.
- Earlier the source type `artifacts.repository` was rejected; the valid
  discriminators the API returned are `artifacts` and `artifacts.repo`. The script
  uses `artifacts`.

In the meantime the HTTP ingress path (`POST /events/repo-pushed`) drives the
identical downstream handler, so the engine runs end to end during a live run
regardless of the deploy state.

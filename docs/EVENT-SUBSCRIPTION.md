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

## Honest status (open beta): what is proven

Proven live against the account:

- The Queue is created, the `artifacts` namespace-level `repo.pushed` event
  subscription is created against it, and real pushes to Artifact repos DO
  deliver real `cf.artifacts.repo.pushed` messages to that Queue.
- End to end through the DEPLOYED consumer: with the Worker deployed to
  Cloudflare (`make deploy` / `wrangler deploy`) so its real Queue consumer runs
  in Cloudflare, a real push to a live Artifact repo drives the next recruitment
  wave through the queued event, with NO use of the `POST /events/repo-pushed`
  ingress. A reproducible proof: create a two-unit Change where unit `b` depends
  on unit `a` on the deployed Worker, kick off recruitment (recruits only `a`),
  then clone `a`'s real Artifact repo and push to it. The push emits a real
  `repo.pushed` event; the deployed Queue consumer receives it and recruits `b`,
  recorded in the Change state as a `repo-pushed` recruitment event. Because the
  ingress was never called, the deployed consumer reacting to the real queued
  event is the only path that could have recruited `b`.

  Observed on the deployed Worker
  `https://switchyard-change-fabric.ckinney.workers.dev`: the next wave appeared
  within about ten seconds of the push, with the state recording
  `recruitments = [ (kickoff, [a]), (repo-pushed, [b]) ]`.

### Earlier rough edges (resolved)

- Under `wrangler dev` the Worker runs locally and consumes a LOCAL queue
  simulation, so a remote event subscription delivering to the remote Queue does
  not reach the local-dev consumer. Driving the next wave from the real queued
  message therefore needs the Worker DEPLOYED, which is now done and proven above.
- The source type `artifacts.repository` was rejected; the valid discriminators
  the API returns are `artifacts` and `artifacts.repo`. The script uses
  `artifacts`.

The HTTP ingress path (`POST /events/repo-pushed`) still drives the identical
downstream handler, so the offline test substrate and a run on an account without
a provisioned subscription both exercise the same recruitment logic.

## Deploying and tearing down the Worker

```bash
# Deploy the single Worker (Artifacts + AI bindings + the repo-pushed Queue
# consumer). The queue must exist first; create it once if needed.
npx wrangler queues create switchyard-change-fabric-repo-pushed   # once, if absent
make deploy                                                        # wrangler deploy

# Provision the Artifacts repo.pushed -> Queue subscription (once).
make artifacts-subscribe

# Tear the deployed Worker down when you are finished.
cd apps/worker && npx wrangler delete

# (Optional) remove the subscription and the queue too.
#   list:   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
#             "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/event_subscriptions/subscriptions"
#   delete: DELETE the same path with the subscription id appended.
#   queue:  npx wrangler queues delete switchyard-change-fabric-repo-pushed
```

A production deploy is not required to try the project: the offline `make demo`
and the local `wrangler dev` path both run without it. The deploy exists so the
real `repo.pushed` -> Queue -> consumer hop can be proven end to end.

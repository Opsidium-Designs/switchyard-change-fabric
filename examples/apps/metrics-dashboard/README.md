# metrics-dashboard example app

A tiny metrics endpoint served by one Cloudflare Worker:

- `GET /metrics` a JSON summary of several metric series
- `GET /metrics/:name` one metric series (`latency`, `throughput`, `errors`)

## Planted bug (dynamic-branching example)

Each metric's `average()` computes a raw mean with no empty-series guard and no
rounding, so an empty series yields `NaN` (serialized as `null`) and a populated
one yields a long floating-point tail. The same pattern is planted across the
sibling metric handlers under `src/metrics` (each marked `FABRIC-FOLLOWUP`), so
fixing one metric reveals the identical fix is needed across the others. That is
the dynamic-branching story: fixing one thing reveals more work, and the fabric's
graph grows mid-run to cover it.

## Observable before/after

```bash
curl -sS <url>/metrics/errors
# before: {"name":"errors","average":null,"samples":[]}   (NaN from empty series)
# after:  {"name":"errors","average":0,"samples":[]}
curl -sS <url>/metrics/latency
# before: long float tail; after: a clean rounded number
```

## Deploy and tear down

```bash
make deploy-app APP=metrics-dashboard
make delete-app APP=metrics-dashboard
```

See [docs/LIVE-DEPLOY.md](../../../docs/LIVE-DEPLOY.md).

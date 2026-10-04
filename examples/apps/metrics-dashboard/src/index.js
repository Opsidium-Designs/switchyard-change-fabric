// metrics-dashboard: a tiny metrics endpoint served by one Cloudflare Worker.
//
//   GET /metrics          a JSON summary of several metric series
//   GET /metrics/:name    one metric series
//
// THE PLANTED BUG (observable on the live response): each metric handler reports
// its average with no rounding and no guard for an empty series, so an empty
// series yields `NaN` (which serializes to null) and a populated one yields a
// long floating-point tail. The same raw-average pattern is planted across the
// sibling metric handlers under src/metrics (each marked FABRIC-FOLLOWUP), so
// fixing one metric reveals the identical fix is needed across the others: this
// is the dynamic-branching example (fixing one thing reveals more work).
//
// Observable before/after: before, `GET /metrics/latency` reports an unrounded
// average (or null for an empty series); after, a clean rounded number and a
// zero for an empty series.

import { latency } from "./metrics/latency.js";
import { throughput } from "./metrics/throughput.js";
import { errors } from "./metrics/errors.js";

const METRICS = { latency, throughput, errors };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((p) => p !== "");

    if (request.method === "GET" && parts[0] === "metrics" && parts.length === 1) {
      const summary = {};
      for (const [name, metric] of Object.entries(METRICS)) {
        summary[name] = metric.average();
      }
      return json({ metrics: summary });
    }
    if (request.method === "GET" && parts[0] === "metrics" && parts.length === 2) {
      const metric = METRICS[parts[1]];
      if (!metric) {
        return json({ error: "unknown metric" }, 404);
      }
      return json({ name: parts[1], average: metric.average(), samples: metric.samples });
    }
    return json({ error: "not found" }, 404);
  },
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

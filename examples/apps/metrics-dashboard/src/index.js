// metrics-dashboard: a tiny metrics endpoint served by one Cloudflare Worker.
//
//   GET /                 a self-contained HTML dashboard that fetches /metrics
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

    if (request.method === "GET" && parts.length === 0) {
      return html(DASHBOARD_HTML);
    }
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

export function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Self-contained single-page dashboard: no build step, no external assets.
// It fetches the app's own GET /metrics and renders each metric name and its
// average verbatim. Because average() is unrounded and unguarded, a populated
// series shows a long float tail and an empty series shows null/NaN on screen,
// so the planted bug is visible in the browser. After the one-line fix (rounded
// average, 0 for an empty series), the same page shows clean rounded numbers.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Metrics dashboard</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      margin: 0;
      padding: 2rem;
      background: #0f172a;
      color: #e2e8f0;
    }
    h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
    p.sub { margin: 0 0 1.5rem; color: #94a3b8; }
    #cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1rem;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 1rem 1.25rem;
    }
    .card .name {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
    }
    .card .value {
      font-size: 1.75rem;
      font-weight: 600;
      margin-top: 0.35rem;
      word-break: break-all;
    }
    .card .value.bad { color: #f87171; }
    .error { color: #f87171; }
  </style>
</head>
<body>
  <h1>Metrics dashboard</h1>
  <p class="sub">Averages fetched live from <code>GET /metrics</code>.</p>
  <div id="cards">Loading...</div>
  <script>
    async function load() {
      const cards = document.getElementById("cards");
      try {
        const res = await fetch("/metrics");
        const data = await res.json();
        const entries = Object.entries(data.metrics || {});
        if (entries.length === 0) {
          cards.textContent = "No metrics reported.";
          return;
        }
        cards.innerHTML = "";
        for (const [name, average] of entries) {
          // Render the average verbatim so an unrounded float tail or a
          // null/NaN empty series is visible exactly as the API reports it.
          const raw = average === null ? "null" : String(average);
          const bad = average === null || Number.isNaN(average) || raw.length > 6;
          const card = document.createElement("div");
          card.className = "card";
          const nameEl = document.createElement("div");
          nameEl.className = "name";
          nameEl.textContent = name;
          const valueEl = document.createElement("div");
          valueEl.className = "value" + (bad ? " bad" : "");
          valueEl.textContent = raw;
          card.appendChild(nameEl);
          card.appendChild(valueEl);
          cards.appendChild(card);
        }
      } catch (err) {
        cards.innerHTML = '<span class="error">Failed to load metrics: ' + err + "</span>";
      }
    }
    load();
  </script>
</body>
</html>
`;

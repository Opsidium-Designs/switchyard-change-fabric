// storefront interactive tester page, served at GET / by src/index.ts.
//
// A self-contained HTML page (inline CSS and JS, no external scripts, fonts, or
// CDNs) that runs representative checks per domain against the live Worker it
// is served from, mirroring the acceptance gate: exact money, tax rounding,
// invoice consistency, payment and refund caps, auth on everything a customer
// owns, input validation, and pagination bounds. It shows expected vs actual,
// the response body on click, and a score ("N of M checks correct"): about 1 of
// 16 on the broken baseline, 16 of 16 after a correct fix.
//
// Checks that buy something first empty the demo cart, so a rerun starts clean.
// This module only renders the page: it changes no route behavior.

import { DEMO_TOKEN } from "./contracts/auth.ts";

const CONFIG = JSON.stringify({ token: DEMO_TOKEN }).replace(/</g, "\\u003c");

/** The tester page HTML. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>storefront tester</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8; --fg: #1b1d22; --muted: #5a6070; --card: #ffffff; --border: #d9dbe1;
    --code: #eef0f3; --accent: #2457c5; --accent-fg: #ffffff;
    --pass: #17723a; --pass-bg: #e3f5e9; --fail: #b3261e; --fail-bg: #fde7e5;
    --idle: #6a7080; --idle-bg: #eceef2; --warn-bg: #fff6d8; --warn-border: #e8cf7a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121417; --fg: #e7e9ee; --muted: #a2a8b6; --card: #1b1e23; --border: #333843;
      --code: #262a31; --accent: #7aa2ff; --accent-fg: #0d1117;
      --pass: #6fdc95; --pass-bg: #163322; --fail: #ff8a80; --fail-bg: #3a1b19;
      --idle: #a2a8b6; --idle-bg: #262a31; --warn-bg: #2f2a17; --warn-border: #6b5a22;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 64rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.1rem; margin: 0; }
  p { margin: 0.5rem 0; }
  code { background: var(--code); padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.9em; }
  .lede { color: var(--muted); }
  .story { background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: 8px; padding: 0.75rem 1rem; margin: 1rem 0; }
  .story ul { margin: 0.25rem 0 0; padding-left: 1.25rem; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.25rem; position: sticky; top: 0; z-index: 1;
         background: var(--bg); padding: 0.75rem 0; border-bottom: 1px solid var(--border); margin-bottom: 1rem; }
  button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--accent); padding: 0.45rem 0.9rem; }
  button.primary { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: progress; }
  button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .score { font-size: 1.15rem; font-weight: 700; }
  .score.all { color: var(--pass); }
  .score.some { color: var(--fail); }
  .meter { flex: 1 1 10rem; min-width: 8rem; height: 0.6rem; background: var(--idle-bg); border-radius: 999px; overflow: hidden; }
  .meter > span { display: block; height: 100%; width: 0; background: var(--pass); transition: width 0.2s; }
  .verdict { width: 100%; margin: 0; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 30rem), 1fr)); gap: 1rem; }
  .domain { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 0.85rem 1rem; }
  .domain header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .domain header .tally { color: var(--muted); font-size: 0.9rem; }
  details { border: 1px solid var(--border); border-left-width: 6px; border-radius: 6px; margin: 0.45rem 0; background: var(--card); }
  details.pass { border-left-color: var(--pass); }
  details.fail { border-left-color: var(--fail); }
  details.idle { border-left-color: var(--idle); }
  summary { cursor: pointer; padding: 0.5rem 0.65rem; display: grid; grid-template-columns: 1fr auto; gap: 0.15rem 0.75rem; list-style-position: inside; }
  summary .what { font-weight: 600; }
  summary .codes { grid-column: 1 / 2; color: var(--muted); font-size: 0.9rem; }
  .badge { grid-row: 1 / span 2; grid-column: 2; align-self: center; font-weight: 700; font-size: 0.85rem; padding: 0.15rem 0.55rem; border-radius: 999px; }
  .pass .badge { color: var(--pass); background: var(--pass-bg); }
  .fail .badge { color: var(--fail); background: var(--fail-bg); }
  .idle .badge { color: var(--idle); background: var(--idle-bg); }
  .detail { padding: 0 0.65rem 0.65rem; font-size: 0.9rem; }
  pre { margin: 0.35rem 0 0; background: var(--code); padding: 0.5rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
  @media (prefers-reduced-motion: reduce) { .meter > span { transition: none; } }
</style>
</head>
<body>
<main>
<h1>storefront tester</h1>
<p class="lede">
  A small store served by one Worker: a catalog (products, categories, search),
  orders (cart, checkout, history), and billing (invoices, payments, refunds).
  This page runs representative checks per domain against this Worker; the
  acceptance gate checks the same behavior in depth.
</p>
<section class="story" aria-labelledby="story-title">
  <h2 id="story-title">What to expect</h2>
  <ul>
    <li><strong>Before the fix</strong>: money is floating-point dollars, so a $19.99 price reads back as 1998 cents and tax is truncated; refunds and payments are uncapped; writes and customer data need no token; inputs and page sizes are not checked. Almost every check fails.</li>
    <li><strong>After the fix</strong>: amounts are exact to the cent, tax rounds to the nearest cent (halves up), an invoice matches its order, overpayments and over-refunds are refused, a missing token is <code>401</code>, and bad input is <code>400</code>. Every check passes.</li>
  </ul>
  <p>Authenticated checks send <code>Authorization: Bearer &lt;demo token&gt;</code> (from <code>src/contracts/auth.ts</code>). Checks create demo orders in this Worker's memory.</p>
</section>
<div class="bar">
  <button type="button" class="primary" id="run-all">Run all checks</button>
  <span class="score" id="score" role="status" aria-live="polite">not run yet</span>
  <div class="meter" aria-hidden="true"><span id="meter"></span></div>
  <p class="verdict" id="verdict">Press "Run all checks" to test every domain.</p>
</div>
<div class="grid" id="domains">
  <noscript><p>This tester needs JavaScript.</p></noscript>
</div>
</main>
<script id="tester-config" type="application/json">${CONFIG}</script>
<script>
(function () {
  "use strict";
  var config = JSON.parse(document.getElementById("tester-config").textContent);
  var REJECTED = [400, 409, 422];

  async function call(method, path, body, auth) {
    var headers = {};
    if (body !== undefined) { headers["content-type"] = "application/json"; }
    if (auth) { headers.authorization = "Bearer " + config.token; }
    var init = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) { init.body = JSON.stringify(body); }
    var response = await fetch(path, init);
    var text = await response.text();
    var parsed = text;
    try { parsed = JSON.parse(text); } catch (e) { /* keep text */ }
    return { status: response.status, body: parsed, request: method + " " + path + (body !== undefined ? " " + JSON.stringify(body) : "") + (auth ? "  (with bearer token)" : "  (no token)") };
  }

  async function emptyCart() {
    var cart = await call("GET", "/cart", undefined, true);
    var lines = cart.body && cart.body.lines ? cart.body.lines : [];
    for (var i = 0; i < lines.length; i += 1) {
      await call("DELETE", "/cart/items/" + encodeURIComponent(lines[i].productId), undefined, true);
    }
  }

  async function buy(lines, region) {
    await emptyCart();
    for (var i = 0; i < lines.length; i += 1) {
      await call("POST", "/cart/items", { productId: lines[i][0], qty: lines[i][1] }, true);
    }
    return call("POST", "/checkout", { region: region }, true);
  }

  function status(expected, reply) {
    var want = Array.isArray(expected) ? expected : [expected];
    return { ok: want.indexOf(reply.status) >= 0, actual: String(reply.status), reply: reply };
  }

  var CHECKS = [
    { domain: "catalog", label: "Seeded prices read back to the cent", expected: "p1 1999, p4 115",
      run: async function () {
        var r = await call("GET", "/products");
        var list = r.body && r.body.products ? r.body.products : [];
        var byId = {};
        list.forEach(function (p) { byId[p.id] = p.priceCents; });
        return { ok: byId.p1 === 1999 && byId.p4 === 115, actual: "p1 " + byId.p1 + ", p4 " + byId.p4, reply: r };
      } },
    { domain: "catalog", label: "Adding a product needs a token", expected: "401",
      run: async function () { return status(401, await call("POST", "/products", { name: "Saucer", categoryId: "c1", priceCents: 800 }, false)); } },
    { domain: "catalog", label: "An out-of-range page size is rejected", expected: "400",
      run: async function () { return status(400, await call("GET", "/products?limit=1000")); } },
    { domain: "catalog", label: "Search without a term is rejected", expected: "400",
      run: async function () { return status(400, await call("GET", "/search")); } },
    { domain: "orders", label: "The cart needs a token", expected: "401",
      run: async function () { return status(401, await call("GET", "/cart")); } },
    { domain: "orders", label: "A zero quantity is rejected", expected: "400",
      run: async function () { return status(400, await call("POST", "/cart/items", { productId: "p1", qty: 0 }, true)); } },
    { domain: "orders", label: "Checkout to an unknown region is rejected", expected: "400",
      run: async function () { var r = await buy([["p1", 1]], "ZZ"); await emptyCart(); return status(400, r); } },
    { domain: "orders", label: "Order history needs a token", expected: "401",
      run: async function () { return status(401, await call("GET", "/orders")); } },
    { domain: "orders", label: "A negative offset is rejected", expected: "400",
      run: async function () { return status(400, await call("GET", "/orders?offset=-1", undefined, true)); } },
    { domain: "orders", label: "A valid purchase still succeeds", expected: "201",
      run: async function () { return status(201, await buy([["p3", 1]], "OR")); } },
    { domain: "billing", label: "CA tax on a $10.00 order is 73 cents (72.5 rounds up)", expected: "tax 73, total 1073",
      run: async function () {
        var r = await buy([["p5", 2]], "CA");
        var b = r.body || {};
        return { ok: b.taxCents === 73 && b.totalCents === 1073, actual: "tax " + b.taxCents + ", total " + b.totalCents, reply: r };
      } },
    { domain: "billing", label: "An invoice states the same totals as its order", expected: "equal totals",
      run: async function () {
        var order = await buy([["p1", 1]], "CA");
        var inv = await call("GET", "/invoices/" + encodeURIComponent((order.body || {}).invoiceId), undefined, true);
        var o = order.body || {}, i = inv.body || {};
        var ok = inv.status === 200 && i.subtotalCents === o.subtotalCents && i.taxCents === o.taxCents && i.totalCents === o.totalCents && o.totalCents === 2144;
        return { ok: ok, actual: "order " + o.totalCents + ", invoice " + i.totalCents + " (expected 2144)", reply: inv };
      } },
    { domain: "billing", label: "A payment above the balance due is refused", expected: "400, 409, or 422",
      run: async function () {
        var order = await buy([["p5", 2]], "CA");
        var o = order.body || {};
        return status(REJECTED, await call("POST", "/payments", { invoiceId: o.invoiceId, amountCents: (o.totalCents || 0) + 1 }, true));
      } },
    { domain: "billing", label: "A refund larger than its payment is refused", expected: "400, 409, or 422",
      run: async function () {
        var order = await buy([["p3", 1]], "OR");
        var o = order.body || {};
        var pay = await call("POST", "/payments", { invoiceId: o.invoiceId, amountCents: 4500 }, true);
        return status(REJECTED, await call("POST", "/refunds", { paymentId: (pay.body || {}).id, amountCents: 4501 }, true));
      } },
    { domain: "billing", label: "Refunds need a token", expected: "401",
      run: async function () { return status(401, await call("POST", "/refunds", { paymentId: "pay-1", amountCents: 1 }, false)); } },
    { domain: "billing", label: "A malformed page size is rejected", expected: "400",
      run: async function () { return status(400, await call("GET", "/invoices?limit=abc", undefined, true)); } }
  ];
  var TOTAL = CHECKS.length;
  var results = {};
  var root = document.getElementById("domains");
  var runAll = document.getElementById("run-all");

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function excerpt(body) {
    var out = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    return out.length > 800 ? out.slice(0, 800) + "\\n... (truncated)" : out;
  }

  var domains = [];
  CHECKS.forEach(function (check, index) {
    var card = document.getElementById("domain-" + check.domain);
    if (!card) {
      domains.push(check.domain);
      card = el("section", "domain");
      card.id = "domain-" + check.domain;
      var header = el("header");
      header.appendChild(el("h2", null, check.domain));
      var tally = el("span", "tally", "not run");
      tally.id = "tally-" + check.domain;
      header.appendChild(tally);
      card.appendChild(header);
      root.appendChild(card);
    }
    var row = el("details", "idle");
    row.id = "check-" + index;
    var summary = el("summary");
    summary.appendChild(el("span", "what", check.label));
    var badge = el("span", "badge", "NOT RUN");
    summary.appendChild(badge);
    var codes = el("span", "codes", "expected " + check.expected + ", actual -");
    summary.appendChild(codes);
    row.appendChild(summary);
    var detail = el("div", "detail");
    detail.appendChild(el("div", null, "Request:"));
    var req = el("pre", null, "(not run)");
    detail.appendChild(req);
    detail.appendChild(el("div", null, "Response body:"));
    var body = el("pre", null, "(not run)");
    detail.appendChild(body);
    row.appendChild(detail);
    card.appendChild(row);
    row._parts = { badge: badge, codes: codes, req: req, body: body };
  });

  function render(index, outcome, error) {
    var check = CHECKS[index];
    var parts = document.getElementById("check-" + index)._parts;
    var passed = error === undefined && outcome.ok;
    results[index] = passed;
    document.getElementById("check-" + index).className = passed ? "pass" : "fail";
    parts.badge.textContent = passed ? "PASS" : "FAIL";
    parts.codes.textContent = "expected " + check.expected + ", actual " + (error === undefined ? outcome.actual : "error");
    parts.req.textContent = error !== undefined ? "(request failed: " + error + ")" : outcome.reply.request;
    parts.body.textContent = error !== undefined ? "(no response)" : excerpt(outcome.reply.body);
  }

  function updateScore() {
    var good = 0, ran = 0;
    Object.keys(results).forEach(function (k) { ran += 1; if (results[k]) { good += 1; } });
    domains.forEach(function (domain) {
      var done = 0, ok = 0, all = 0;
      CHECKS.forEach(function (check, index) {
        if (check.domain !== domain) { return; }
        all += 1;
        if (results[index] !== undefined) { done += 1; if (results[index]) { ok += 1; } }
      });
      document.getElementById("tally-" + domain).textContent = done === 0 ? "not run" : ok + " of " + all + " correct";
    });
    var score = document.getElementById("score");
    score.textContent = ran === 0 ? "not run yet" : good + " of " + TOTAL + " checks correct" + (ran < TOTAL ? " (" + ran + " run)" : "");
    score.className = "score " + (ran === TOTAL && good === TOTAL ? "all" : ran > 0 && good < ran ? "some" : "");
    document.getElementById("meter").style.width = Math.round((good / TOTAL) * 100) + "%";
    var verdict = document.getElementById("verdict");
    if (ran === 0) {
      verdict.textContent = "Press \\"Run all checks\\" to test every domain.";
    } else if (ran === TOTAL && good === TOTAL) {
      verdict.textContent = "Fixed: money is exact, tax rounds correctly, payments and refunds are capped, and auth and input checks hold.";
    } else {
      verdict.textContent = (ran - good) + " check(s) failing. Open a failing check to see the request and response.";
    }
  }

  async function runChecks() {
    runAll.disabled = true;
    results = {};
    try {
      for (var i = 0; i < CHECKS.length; i += 1) {
        try {
          render(i, await CHECKS[i].run());
        } catch (e) {
          render(i, undefined, e && e.message ? e.message : String(e));
        }
        updateScore();
      }
    } finally {
      runAll.disabled = false;
    }
  }

  runAll.addEventListener("click", runChecks);
  updateScore();
})();
</script>
</body>
</html>
`;

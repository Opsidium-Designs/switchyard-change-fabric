// storefront demo store page, served at GET / by src/index.ts.
//
// A self-contained HTML page (inline CSS and JS, no external scripts, fonts, or
// CDNs) that looks like a small shop and drives the real API of the Worker it is
// served from: a product grid from GET /products, a cart and checkout, the
// order's invoice side by side with the order, and a payments and refunds panel
// that tries an overpayment and an over-refund.
//
// Wrong values are flagged in context with warning chips computed from the real
// responses against the intended behavior (the seeded price tags, unit price
// times quantity, tax rounded half up at the region's rate, invoice equals
// order, refused overpayments and over-refunds). Nothing is hardcoded to a
// specific bug, so after a correct fix the chips disappear on their own.
//
// A "Health checks" drawer keeps the 16 representative checks per domain
// (mirroring the acceptance gate) with a score: about 1 of 16 on the broken
// baseline, 16 of 16 after a correct fix. Checks that buy something first empty
// the demo cart, so a rerun starts clean.
//
// Every purchase, payment, and refund writes demo records into the Worker's
// memory. This module only renders the page: it changes no route behavior.

import { DEMO_TOKEN } from "./contracts/auth.ts";

const CONFIG = JSON.stringify({ token: DEMO_TOKEN }).replace(/</g, "\\u003c");

/** The demo store page HTML. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<link rel="icon" href="data:," />
<title>Kettle and Crema - storefront demo</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f3ee; --fg: #221d18; --muted: #6b635a; --card: #ffffff; --line: #e4ddd3;
    --soft: #efe9e0; --accent: #8a4b22; --accent-fg: #ffffff; --accent-soft: #f4e7dc;
    --ok: #1d7a43; --ok-bg: #e2f4e8; --bad: #b3261e; --bad-bg: #fde8e6;
    --warn: #8a5a00; --warn-bg: #fff3d1; --warn-line: #ecc969; --shadow: 0 1px 2px rgba(40, 30, 20, 0.06), 0 4px 14px rgba(40, 30, 20, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15120f; --fg: #eee7df; --muted: #a99f94; --card: #1f1b17; --line: #3a332c;
      --soft: #2a2520; --accent: #e3a173; --accent-fg: #1a120c; --accent-soft: #3a2a1f;
      --ok: #74d99a; --ok-bg: #173323; --bad: #ff8f85; --bad-bg: #3d1c19;
      --warn: #f4cd6a; --warn-bg: #362b12; --warn-line: #7a6222; --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1, h2, h3 { margin: 0; line-height: 1.25; }
  h2 { font-size: 1.15rem; }
  h3 { font-size: 1rem; }
  p { margin: 0.35rem 0; }
  code, .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 0.85em; }
  code { background: var(--soft); padding: 0.05rem 0.3rem; border-radius: 4px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  button, select, input { font: inherit; color: inherit; }
  button { cursor: pointer; border-radius: 8px; border: 1px solid var(--line); background: var(--card); padding: 0.45rem 0.85rem; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
  button.ghost { background: transparent; }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .top { position: sticky; top: 0; z-index: 5; background: var(--card); border-bottom: 1px solid var(--line); }
  .top-in { max-width: 74rem; margin: 0 auto; padding: 0.6rem 1rem; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 750; font-size: 1.1rem; margin-right: auto; }
  .brand svg { color: var(--accent); }
  .pill { display: inline-block; font-size: 0.75rem; font-weight: 650; padding: 0.05rem 0.5rem; border-radius: 999px; background: var(--soft); color: var(--muted); }
  .pill.ok { background: var(--ok-bg); color: var(--ok); }
  .pill.bad { background: var(--bad-bg); color: var(--bad); }
  .brand, .navbtn { white-space: nowrap; }
  .navbtn { display: inline-flex; align-items: center; gap: 0.4rem; text-decoration: none; color: inherit; border: 1px solid var(--line); border-radius: 8px; padding: 0.35rem 0.7rem; background: var(--card); }
  .wrap { max-width: 74rem; margin: 0 auto; padding: 1rem; }
  .notice { font-size: 0.85rem; color: var(--muted); margin: 0 0 0.75rem; }
  .expect { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 0.6rem 0.9rem; margin-bottom: 1rem; }
  .expect summary { cursor: pointer; font-weight: 650; display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .expect .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 0.4rem 1.25rem; margin-top: 0.4rem; font-size: 0.88rem; }
  .findings { font-weight: 600; font-size: 0.85rem; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 21rem; gap: 1.25rem; align-items: start; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1rem; box-shadow: var(--shadow); margin-bottom: 1.25rem; }
  .panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .sub { color: var(--muted); font-size: 0.85rem; }
  .filters { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .filters button { padding: 0.2rem 0.7rem; border-radius: 999px; font-size: 0.85rem; }
  .filters button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(12.5rem, 1fr)); gap: 0.9rem; }
  .product { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; background: var(--card); }
  .thumb { height: 7.5rem; display: grid; place-items: center; background: linear-gradient(135deg, var(--accent-soft), var(--soft)); color: var(--accent); }
  .pbody { padding: 0.7rem 0.8rem 0.8rem; display: flex; flex-direction: column; gap: 0.3rem; flex: 1; }
  .cat { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .pname { font-weight: 650; }
  .price { display: flex; align-items: baseline; gap: 0.45rem; flex-wrap: wrap; }
  .price strong { font-size: 1.2rem; }
  .raw { color: var(--muted); font-size: 0.75rem; }
  .buy { display: flex; gap: 0.4rem; margin-top: auto; padding-top: 0.35rem; }
  .buy input { width: 3.6rem; border: 1px solid var(--line); border-radius: 8px; padding: 0.35rem 0.4rem; background: var(--card); }
  .buy button { flex: 1; }
  .warn { display: inline-flex; gap: 0.35rem; align-items: flex-start; background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn); border-radius: 8px; padding: 0.2rem 0.5rem; font-size: 0.78rem; font-weight: 550; line-height: 1.35; }
  .warn::before { content: "!"; font-weight: 800; display: inline-grid; place-items: center; min-width: 1rem; height: 1rem; border-radius: 999px; background: var(--warn); color: var(--warn-bg); font-size: 0.7rem; margin-top: 0.05rem; }
  .chips { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.4rem; }
  .side { position: sticky; top: 4.25rem; }
  .lines { list-style: none; margin: 0; padding: 0; }
  .lines li { display: grid; grid-template-columns: 1fr auto; gap: 0.1rem 0.5rem; padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
  .lines .meta { color: var(--muted); font-size: 0.82rem; }
  .lines .rm { grid-column: 2; justify-self: end; font-size: 0.78rem; padding: 0.1rem 0.45rem; }
  .sum { display: grid; grid-template-columns: 1fr auto; gap: 0.2rem 0.75rem; margin: 0.6rem 0; }
  .sum .total { font-weight: 750; font-size: 1.05rem; }
  .field { display: grid; gap: 0.2rem; margin: 0.6rem 0; font-size: 0.88rem; }
  .field select { border: 1px solid var(--line); border-radius: 8px; padding: 0.4rem; background: var(--card); }
  .wide { width: 100%; }
  .empty { color: var(--muted); font-size: 0.9rem; padding: 0.4rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: right; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--line); }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: var(--muted); font-weight: 600; font-size: 0.8rem; }
  .mark { font-weight: 700; }
  .mark.ok { color: var(--ok); }
  .mark.bad { color: var(--bad); }
  .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr)); gap: 1rem; }
  .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; margin: 0.75rem 0; }
  .action { border: 1px solid var(--line); border-radius: 10px; padding: 0.6rem 0.7rem; display: grid; gap: 0.35rem; }
  .action.probe { border-style: dashed; }
  .action p { margin: 0; font-size: 0.82rem; color: var(--muted); }
  .log { list-style: none; margin: 0; padding: 0; font-size: 0.88rem; }
  .log li { padding: 0.45rem 0; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
  details.receipt summary { cursor: pointer; font-size: 0.85rem; color: var(--muted); margin-top: 0.5rem; }
  pre { margin: 0.35rem 0 0; background: var(--soft); padding: 0.5rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; }
  .toast { position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 0.5rem 0.9rem; border-radius: 8px; font-size: 0.88rem; opacity: 0; pointer-events: none; transition: opacity 0.2s; max-width: calc(100% - 2rem); }
  .toast.show { opacity: 1; }
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 9; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(30rem, 100%); background: var(--bg); border-left: 1px solid var(--line); z-index: 10; display: flex; flex-direction: column; box-shadow: -8px 0 24px rgba(0, 0, 0, 0.15); }
  .drawer-head { padding: 0.9rem 1rem 0.7rem; border-bottom: 1px solid var(--line); background: var(--card); display: grid; gap: 0.5rem; }
  .drawer-head .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .drawer-body { overflow-y: auto; padding: 0.75rem 1rem 2rem; }
  .score { font-weight: 750; }
  .score.all { color: var(--ok); }
  .score.some { color: var(--bad); }
  .meter { flex: 1 1 6rem; height: 0.5rem; background: var(--soft); border-radius: 999px; overflow: hidden; }
  .meter > span { display: block; height: 100%; width: 0; background: var(--ok); transition: width 0.2s; }
  .group { margin-bottom: 0.9rem; }
  .group-head { display: flex; justify-content: space-between; align-items: baseline; margin: 0.25rem 0; }
  .group-head h3 { text-transform: capitalize; }
  details.check { border: 1px solid var(--line); border-left-width: 5px; border-radius: 8px; margin: 0.35rem 0; background: var(--card); }
  details.check.pass { border-left-color: var(--ok); }
  details.check.fail { border-left-color: var(--bad); }
  details.check summary { cursor: pointer; padding: 0.45rem 0.6rem; display: grid; grid-template-columns: 1fr auto; gap: 0.1rem 0.6rem; font-size: 0.88rem; }
  details.check summary .codes { color: var(--muted); font-size: 0.8rem; }
  details.check summary .pill { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
  details.check .detail { padding: 0 0.6rem 0.6rem; font-size: 0.82rem; }
  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; }
    .side { position: static; }
  }
  @media (max-width: 520px) {
    .wrap { padding: 0.75rem; }
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
    .thumb { height: 5rem; }
    .buy { flex-wrap: wrap; }
    .buy input { width: 100%; flex: 1 1 100%; }
    .actions { grid-template-columns: 1fr; }
    .brand .pill, .navbtn .long { display: none; }
    .top-in { flex-wrap: nowrap; gap: 0.5rem; padding: 0.5rem 0.75rem; }
    .brand { font-size: 1rem; }
    .navbtn { padding: 0.3rem 0.55rem; }
    .notice, .expect .cols { font-size: 0.8rem; }
  }
  @media (prefers-reduced-motion: reduce) { .meter > span, .toast { transition: none; } }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="brand">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h13v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c0 1.5 1.5 1.5 1.5 3M12 3c0 1.5 1.5 1.5 1.5 3"/></svg>
      <span>Kettle &amp; Crema</span>
      <span class="pill">demo store</span>
    </div>
    <a class="navbtn" href="#cart"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11h10.2L20 8H6.2"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/></svg><span class="long">Cart</span><span class="sr">Cart, items:</span><span class="pill" id="cart-count">0</span></a>
    <button type="button" class="navbtn" id="open-checks" aria-controls="checks" aria-expanded="false"><span>Health<span class="long"> checks</span></span><span class="pill" id="score-pill">not run</span></button>
  </div>
</header>
<div class="wrap">
  <p class="notice">Every add to cart, order, payment, and refund on this page is a real call to this Worker's API and creates demo records in its memory (gone when the Worker restarts). Customer requests send <code>Authorization: Bearer &lt;demo token&gt;</code> from <code>src/contracts/auth.ts</code>.</p>
  <details class="expect" open>
    <summary>What to expect <span class="findings" id="findings" role="status" aria-live="polite">Loading the catalog...</span></summary>
    <div class="cols">
      <p><strong>Before the fix:</strong> money is floating-point dollars, so a $19.99 price reads back as 1998 cents and tax is truncated; an invoice can disagree with its order; overpayments and over-refunds are accepted; customer data needs no token; bad input and page sizes are not checked. Warning chips appear next to wrong values and most health checks fail.</p>
      <p><strong>After the fix:</strong> every amount is exact to the cent, tax rounds to the nearest cent (halves up), an invoice matches its order, overpayments and over-refunds are refused, a missing token is <code>401</code>, and bad input is <code>400</code>. The chips disappear and every health check passes.</p>
    </div>
  </details>
  <div class="layout">
    <main>
      <section class="panel" aria-labelledby="shop-title">
        <div class="panel-head">
          <div><h1 id="shop-title" style="font-size:1.3rem">Shop</h1><p class="sub">Prices exactly as <code>GET /products</code> returns them; the raw cents are shown next to each price.</p></div>
          <div class="filters" id="filters" role="group" aria-label="Filter by category"></div>
        </div>
        <div class="grid" id="products" aria-live="polite"><p class="empty">Loading products...</p></div>
        <noscript><p>This store needs JavaScript.</p></noscript>
      </section>
      <section class="panel" id="order-panel" aria-labelledby="order-title" hidden>
        <div class="panel-head"><h2 id="order-title">Your order</h2><span class="sub" id="order-sub"></span></div>
        <div class="two">
          <div><h3>Order (from checkout)</h3><ul class="lines" id="order-lines"></ul></div>
          <div><h3>Invoice vs order</h3><table><caption class="sr">Order and invoice totals</caption><thead><tr><th scope="col">Amount</th><th scope="col">Order</th><th scope="col">Invoice</th><th scope="col"><span class="sr">Match</span></th></tr></thead><tbody id="compare"></tbody></table></div>
        </div>
        <div class="chips" id="order-chips"></div>
        <details class="receipt"><summary>Plain-text receipt (<code>GET /invoices/:id/receipt</code>)</summary><pre id="receipt"></pre></details>
      </section>
      <section class="panel" id="pay-panel" aria-labelledby="pay-title" hidden>
        <div class="panel-head"><h2 id="pay-title">Payments and refunds</h2><span class="sub" id="pay-sub"></span></div>
        <div class="sum" id="pay-sum" style="max-width:24rem"></div>
        <div class="chips" id="pay-chips"></div>
        <div class="actions">
          <div class="action"><strong>Pay the balance</strong><p>Pays exactly the balance due.</p><button type="button" id="pay-balance">Pay balance</button></div>
          <div class="action probe"><strong>Try to overpay</strong><p>Pays 1 cent more than the balance due. A correct API refuses it.</p><button type="button" id="pay-over">Overpay by $0.01</button></div>
          <div class="action"><strong>Refund the payment</strong><p>Refunds what is left of your balance payment.</p><button type="button" id="refund-full">Refund in full</button></div>
          <div class="action probe"><strong>Try to over-refund</strong><p>Refunds 1 cent more than is left of your balance payment. A correct API refuses it.</p><button type="button" id="refund-over">Over-refund by $0.01</button></div>
        </div>
        <h3>Attempts</h3>
        <ul class="log" id="pay-log"><li class="empty">No payments or refunds tried yet.</li></ul>
      </section>
    </main>
    <aside class="side" id="cart" aria-labelledby="cart-title">
      <section class="panel">
        <div class="panel-head"><h2 id="cart-title">Cart</h2><span class="sub mono">GET /cart</span></div>
        <ul class="lines" id="cart-lines"><li class="empty">Your cart is empty.</li></ul>
        <div class="sum"><span>Subtotal</span><strong id="cart-subtotal">$0.00</strong></div>
        <div class="chips" id="cart-chips"></div>
        <label class="field">Ship to
          <select id="region">
            <option value="CA">California (7.25% tax)</option>
            <option value="NY">New York (8.875% tax)</option>
            <option value="TX">Texas (6.25% tax)</option>
            <option value="OR">Oregon (no sales tax)</option>
          </select>
        </label>
        <button type="button" class="primary wide" id="checkout" disabled>Place order</button>
        <p class="sub">Tax and total are computed by the API at checkout.</p>
      </section>
    </aside>
  </div>
</div>
<div class="scrim" id="scrim" hidden></div>
<aside class="drawer" id="checks" aria-labelledby="checks-title" hidden>
  <div class="drawer-head">
    <div class="row"><h2 id="checks-title" style="margin-right:auto">Health checks</h2><button type="button" class="ghost" id="close-checks">Close</button></div>
    <p class="sub">16 representative checks per domain, the same behavior the acceptance gate checks in depth. Running them creates demo orders and empties the cart.</p>
    <div class="row">
      <button type="button" class="primary" id="run-all">Run all checks</button>
      <span class="score" id="score" role="status" aria-live="polite">not run yet</span>
      <div class="meter" aria-hidden="true"><span id="meter"></span></div>
    </div>
    <p class="sub" id="verdict">Press "Run all checks" to test every domain.</p>
  </div>
  <div class="drawer-body" id="domains"></div>
</aside>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script id="store-config" type="application/json">${CONFIG}</script>
<script>
(function () {
  "use strict";
  var config = JSON.parse(document.getElementById("store-config").textContent);
  var REJECTED = [400, 409, 422];
  // The intended behavior the page compares real responses against. Tax rates
  // are per 100000 so the expected tax is exact integer math.
  var RATES = { CA: 7250, NY: 8875, TX: 6250, OR: 0 };
  // The seeded catalog's price tags in cents (the prices the store was stocked
  // with, the same ones the acceptance gate expects to read back exactly).
  var TAGS = { p1: 1999, p2: 2450, p3: 4500, p4: 115, p5: 500, p6: 1629 };
  var state = { products: [], categories: {}, filter: "", cart: null, order: null, invoice: null, payment: null };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }
  function isCents(v) { return typeof v === "number" && isFinite(v); }
  function money(c) {
    if (!isCents(c)) { return "?"; }
    var sign = c < 0 ? "-" : "";
    return sign + "$" + (Math.abs(c) / 100).toFixed(2);
  }
  function cents(c) { return isCents(c) ? c + (Math.abs(c) === 1 ? " cent" : " cents") : String(c); }
  function chip(text) { return el("span", "warn", text); }
  function fill(node, chips) {
    node.textContent = "";
    chips.forEach(function (text) { node.appendChild(chip(text)); });
  }
  function expectedTax(subtotal, region) {
    var rate = RATES[region];
    if (!isCents(subtotal) || rate === undefined) { return undefined; }
    return Math.floor((subtotal * rate + 50000) / 100000);
  }
  var toastTimer;
  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.className = "toast show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast"; }, 3200);
  }

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

  // Count the warning chips on the page, so the summary line is backed by what
  // is visibly flagged.
  function updateFindings() {
    var n = document.querySelectorAll("main .warn, #cart .warn").length;
    var f = $("findings");
    f.textContent = n === 0 ? "No wrong values spotted on this page" : n + " wrong value" + (n === 1 ? "" : "s") + " spotted on this page";
    f.className = "findings pill " + (n === 0 ? "ok" : "bad");
  }

  // ---- catalog ----------------------------------------------------------
  var ICONS = {
    c1: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/>',
    c2: '<path d="M6 19h12l-1.5-9h-9z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/><path d="M16.5 12l3-2"/>',
    c3: '<path d="M6 18c0-7 5-12 13-12 0 8-5 13-12 13"/><path d="M6 18l7-7"/>'
  };
  function icon(categoryId) {
    var body = ICONS[categoryId] || '<rect x="5" y="7" width="14" height="12" rx="2"/><path d="M5 11h14"/>';
    return '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }

  function renderFilters() {
    var box = $("filters");
    box.textContent = "";
    var options = [["", "All"]].concat(Object.keys(state.categories).map(function (id) { return [id, state.categories[id]]; }));
    options.forEach(function (opt) {
      var b = el("button", null, opt[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", String(state.filter === opt[0]));
      b.addEventListener("click", function () { state.filter = opt[0]; renderFilters(); renderProducts(); });
      box.appendChild(b);
    });
  }

  function renderProducts() {
    var grid = $("products");
    grid.textContent = "";
    var list = state.products.filter(function (p) { return !state.filter || p.categoryId === state.filter; });
    if (list.length === 0) { grid.appendChild(el("p", "empty", "No products to show.")); }
    list.forEach(function (p) {
      var card = el("article", "product");
      card.setAttribute("aria-label", String(p.name));
      var thumb = el("div", "thumb");
      thumb.innerHTML = icon(p.categoryId);
      card.appendChild(thumb);
      var body = el("div", "pbody");
      body.appendChild(el("span", "cat", state.categories[p.categoryId] || p.categoryId || ""));
      body.appendChild(el("span", "pname", String(p.name)));
      var price = el("div", "price");
      price.appendChild(el("strong", null, money(p.priceCents)));
      price.appendChild(el("span", "raw mono", "API: " + cents(p.priceCents)));
      body.appendChild(price);
      var chips = [];
      var tag = Object.hasOwn(TAGS, p.id) ? TAGS[p.id] : undefined;
      if (tag !== undefined && p.priceCents !== tag) {
        chips.push("Price tag is " + money(tag) + ", but the API returned " + cents(p.priceCents));
      } else if (!Number.isInteger(p.priceCents)) {
        chips.push("Price is not whole cents: " + cents(p.priceCents));
      }
      if (chips.length) { var c = el("div", "chips"); fill(c, chips); body.appendChild(c); }
      var buy = el("div", "buy");
      var qtyId = "qty-" + p.id;
      var label = el("label", "sr", "Quantity of " + p.name);
      label.htmlFor = qtyId;
      var qty = el("input");
      qty.type = "number"; qty.min = "1"; qty.max = "99"; qty.value = "1"; qty.id = qtyId; qty.inputMode = "numeric";
      var add = el("button", "primary", "Add to cart");
      add.type = "button";
      add.addEventListener("click", function () { addToCart(p, Number(qty.value)); });
      buy.appendChild(label); buy.appendChild(qty); buy.appendChild(add);
      body.appendChild(buy);
      card.appendChild(body);
      grid.appendChild(card);
    });
    updateFindings();
  }

  async function loadCatalog() {
    try {
      var cats = await call("GET", "/categories");
      state.categories = {};
      ((cats.body && cats.body.categories) || []).forEach(function (c) { state.categories[c.id] = c.name; });
      var r = await call("GET", "/products");
      state.products = (r.body && r.body.products) || [];
    } catch (e) {
      state.products = [];
      toast("Could not load the catalog: " + (e && e.message ? e.message : e));
    }
    renderFilters();
    renderProducts();
  }

  // ---- cart and checkout ------------------------------------------------
  function lineChecks(lines, subtotal, where) {
    var chips = [], sum = 0, ok = true;
    lines.forEach(function (l) {
      var want = l.unitPriceCents * l.qty;
      if (isCents(l.lineTotalCents) && isCents(want) && l.lineTotalCents !== want) {
        chips.push(l.name + ": line total is " + cents(l.lineTotalCents) + ", but " + l.qty + " x " + cents(l.unitPriceCents) + " is " + want);
      }
      if (isCents(l.lineTotalCents)) { sum += l.lineTotalCents; } else { ok = false; }
    });
    if (ok && isCents(subtotal) && subtotal !== sum) {
      chips.push(where + " subtotal is " + cents(subtotal) + ", but its lines add up to " + sum);
    }
    return chips;
  }

  function renderLines(list, lines, removable) {
    list.textContent = "";
    lines.forEach(function (l) {
      var li = el("li");
      li.appendChild(el("span", null, l.name));
      li.appendChild(el("strong", null, money(l.lineTotalCents)));
      li.appendChild(el("span", "meta", l.qty + " x " + money(l.unitPriceCents) + " (" + cents(l.lineTotalCents) + ")"));
      if (removable) {
        var rm = el("button", "rm ghost", "Remove");
        rm.type = "button";
        rm.setAttribute("aria-label", "Remove " + l.name + " from the cart");
        rm.addEventListener("click", function () { removeFromCart(l.productId); });
        li.appendChild(rm);
      }
      list.appendChild(li);
    });
  }

  function renderCart() {
    var cart = state.cart || { lines: [], subtotalCents: 0 };
    var lines = cart.lines || [];
    var list = $("cart-lines");
    renderLines(list, lines, true);
    if (lines.length === 0) { list.appendChild(el("li", "empty", "Your cart is empty.")); }
    $("cart-subtotal").textContent = money(cart.subtotalCents);
    var count = 0;
    lines.forEach(function (l) { count += Number(l.qty) || 0; });
    $("cart-count").textContent = String(count);
    $("checkout").disabled = lines.length === 0;
    fill($("cart-chips"), lineChecks(lines, cart.subtotalCents, "Cart"));
    updateFindings();
  }

  async function loadCart() {
    var r = await call("GET", "/cart", undefined, true);
    if (r.status === 200 && r.body && Array.isArray(r.body.lines)) { state.cart = r.body; }
    renderCart();
  }

  async function addToCart(p, qty) {
    var r = await call("POST", "/cart/items", { productId: p.id, qty: qty }, true);
    if (r.status === 200 || r.status === 201) {
      state.cart = r.body;
      renderCart();
      toast("Added " + qty + " x " + p.name);
    } else {
      toast("The API refused that (" + r.status + "): " + ((r.body && r.body.error) || "no detail"));
    }
  }

  async function removeFromCart(productId) {
    var r = await call("DELETE", "/cart/items/" + encodeURIComponent(productId), undefined, true);
    if (r.status === 200 && r.body && Array.isArray(r.body.lines)) { state.cart = r.body; }
    renderCart();
  }

  async function checkout() {
    var btn = $("checkout");
    btn.disabled = true;
    var r = await call("POST", "/checkout", { region: $("region").value }, true);
    if (r.status === 201 && r.body && r.body.id) {
      state.order = r.body;
      state.payment = null;
      $("pay-log").textContent = "";
      $("pay-log").appendChild(el("li", "empty", "No payments or refunds tried yet."));
      toast("Order " + r.body.id + " placed");
      await loadOrderAndInvoice();
      $("order-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      toast("Checkout refused (" + r.status + "): " + ((r.body && r.body.error) || "no detail"));
    }
    await loadCart();
  }

  // ---- order, invoice, payments -----------------------------------------
  async function loadOrderAndInvoice() {
    var o = state.order;
    if (!o) { return; }
    var inv = await call("GET", "/invoices/" + encodeURIComponent(o.invoiceId), undefined, true);
    state.invoice = inv.status === 200 && inv.body && typeof inv.body === "object" ? inv.body : null;
    var rc = await call("GET", "/invoices/" + encodeURIComponent(o.invoiceId) + "/receipt", undefined, true);
    $("receipt").textContent = typeof rc.body === "string" ? rc.body : JSON.stringify(rc.body, null, 2);
    renderOrder();
    renderPayments();
  }

  function renderOrder() {
    var o = state.order, i = state.invoice || {};
    $("order-panel").hidden = !o;
    if (!o) { return; }
    $("order-sub").textContent = o.id + ", ships to " + o.region + ", invoice " + o.invoiceId;
    renderLines($("order-lines"), o.lines || [], false);
    var tbody = $("compare");
    tbody.textContent = "";
    var chips = lineChecks(o.lines || [], o.subtotalCents, "Order");
    [["Subtotal", "subtotalCents"], ["Tax (" + o.region + ")", "taxCents"], ["Total", "totalCents"]].forEach(function (row) {
      var a = o[row[1]], b = i[row[1]], same = a === b;
      var tr = el("tr");
      tr.appendChild(el("th", null, row[0])).scope = "row";
      tr.appendChild(el("td", "mono", money(a)));
      tr.appendChild(el("td", "mono", state.invoice ? money(b) : "-"));
      var mark = el("td", "mark " + (same ? "ok" : "bad"), same ? "match" : "differs");
      tr.appendChild(mark);
      tbody.appendChild(tr);
      if (state.invoice && !same) { chips.push("Invoice " + row[0].toLowerCase() + " is " + cents(b) + ", but the order says " + cents(a)); }
    });
    if (!state.invoice) { chips.push("The invoice could not be read"); }
    var want = expectedTax(o.subtotalCents, o.region);
    if (want !== undefined && o.taxCents !== want) {
      chips.push(o.region + " tax on " + cents(o.subtotalCents) + " should be " + want + " (rounded to the nearest cent), but the API charged " + cents(o.taxCents));
    }
    if (isCents(o.subtotalCents) && isCents(o.taxCents) && o.totalCents !== o.subtotalCents + o.taxCents) {
      chips.push("Order total is " + cents(o.totalCents) + ", but subtotal plus tax is " + (o.subtotalCents + o.taxCents));
    }
    fill($("order-chips"), chips);
    updateFindings();
  }

  function renderPayments() {
    var i = state.invoice;
    $("pay-panel").hidden = !state.order;
    if (!state.order) { return; }
    $("pay-sub").textContent = "invoice " + state.order.invoiceId;
    var sum = $("pay-sum");
    sum.textContent = "";
    [["Invoice total", "totalCents"], ["Paid", "paidCents"], ["Refunded", "refundedCents"], ["Balance due", "balanceCents"]].forEach(function (row) {
      sum.appendChild(el("span", null, row[0]));
      sum.appendChild(el("strong", "mono" + (row[1] === "balanceCents" ? " total" : ""), i ? money(i[row[1]]) : "-"));
    });
    var chips = [];
    if (i && isCents(i.balanceCents) && i.balanceCents < 0) { chips.push("Balance due is " + cents(i.balanceCents) + ": the invoice was paid more than it is worth"); }
    if (i && isCents(i.totalCents) && isCents(i.paidCents) && isCents(i.balanceCents) && i.balanceCents !== i.totalCents - i.paidCents) {
      chips.push("Balance due is " + cents(i.balanceCents) + ", but total minus paid is " + (i.totalCents - i.paidCents));
    }
    if (i && isCents(i.paidCents) && i.paidCents < 0) { chips.push("Paid is " + cents(i.paidCents) + ": more was refunded than was ever paid"); }
    fill($("pay-chips"), chips);
    var p = state.payment;
    $("refund-full").disabled = !p;
    $("refund-over").disabled = !p;
    updateFindings();
  }

  async function freshPayment() {
    if (!state.payment) { return null; }
    var r = await call("GET", "/payments?limit=100", undefined, true);
    var list = (r.body && r.body.payments) || [];
    var found = list.filter(function (p) { return p.id === state.payment.id; })[0];
    if (found) { state.payment = found; }
    return state.payment;
  }

  function logAttempt(what, amount, reply, probe) {
    var log = $("pay-log");
    var empty = log.querySelector(".empty");
    if (empty) { empty.remove(); }
    var li = el("li");
    li.appendChild(el("span", null, what + " of " + money(amount)));
    var refused = REJECTED.indexOf(reply.status) >= 0;
    var ok = reply.status === 201;
    var text, cls;
    if (probe) {
      cls = refused ? "pill ok" : "pill bad";
      text = refused ? "Refused (" + reply.status + "), as it should be" : "Accepted (" + reply.status + "): it should have been refused";
    } else {
      cls = ok ? "pill ok" : "pill bad";
      text = ok ? "Accepted (201)" : "Failed (" + reply.status + ")";
    }
    li.appendChild(el("span", cls, text));
    if (probe && !refused && ok) { li.appendChild(chip(what + " of " + cents(amount) + " went through although it is 1 cent over the limit")); }
    log.insertBefore(li, log.firstChild);
  }

  async function pay(probe) {
    if (!state.invoice) { return; }
    var due = isCents(state.invoice.balanceCents) ? state.invoice.balanceCents : 0;
    var amount = probe ? Math.max(due, 0) + 1 : due;
    if (!probe && amount <= 0) { toast("Nothing is due on this invoice"); return; }
    var r = await call("POST", "/payments", { invoiceId: state.order.invoiceId, amountCents: amount }, true);
    if (!probe && r.status === 201 && r.body && r.body.id) { state.payment = r.body; }
    logAttempt(probe ? "Overpayment" : "Payment", amount, r, probe);
    await loadOrderAndInvoice();
  }

  async function refund(probe) {
    var p = await freshPayment();
    if (!p) { return; }
    var left = (isCents(p.amountCents) ? p.amountCents : 0) - (isCents(p.refundedCents) ? p.refundedCents : 0);
    var amount = probe ? Math.max(left, 0) + 1 : left;
    if (!probe && amount <= 0) { toast("That payment is already fully refunded"); return; }
    var r = await call("POST", "/refunds", { paymentId: p.id, amountCents: amount }, true);
    logAttempt(probe ? "Over-refund" : "Refund", amount, r, probe);
    await freshPayment();
    await loadOrderAndInvoice();
  }

  // ---- health checks ----------------------------------------------------
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
  var domains = [];
  var runAll = $("run-all");

  function excerpt(body) {
    var out = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    return out.length > 800 ? out.slice(0, 800) + " ... (truncated)" : out;
  }

  CHECKS.forEach(function (check, index) {
    var group = $("group-" + check.domain);
    if (!group) {
      domains.push(check.domain);
      group = el("section", "group");
      group.id = "group-" + check.domain;
      var head = el("div", "group-head");
      head.appendChild(el("h3", null, check.domain));
      var tally = el("span", "sub", "not run");
      tally.id = "tally-" + check.domain;
      head.appendChild(tally);
      group.appendChild(head);
      $("domains").appendChild(group);
    }
    var row = el("details", "check");
    row.id = "check-" + index;
    var summary = el("summary");
    summary.appendChild(el("span", null, check.label));
    var badge = el("span", "pill", "NOT RUN");
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
    group.appendChild(row);
    row._parts = { badge: badge, codes: codes, req: req, body: body };
  });

  function render(index, outcome, error) {
    var check = CHECKS[index];
    var row = $("check-" + index);
    var parts = row._parts;
    var passed = error === undefined && outcome.ok;
    results[index] = passed;
    row.className = "check " + (passed ? "pass" : "fail");
    parts.badge.textContent = passed ? "PASS" : "FAIL";
    parts.badge.className = "pill " + (passed ? "ok" : "bad");
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
      $("tally-" + domain).textContent = done === 0 ? "not run" : ok + " of " + all + " correct";
    });
    var score = $("score");
    score.textContent = ran === 0 ? "not run yet" : good + " of " + TOTAL + " checks correct" + (ran < TOTAL ? " (" + ran + " run)" : "");
    score.className = "score " + (ran === TOTAL && good === TOTAL ? "all" : ran > 0 && good < ran ? "some" : "");
    var pill = $("score-pill");
    pill.textContent = ran === 0 ? "not run" : good + "/" + TOTAL;
    pill.className = "pill " + (ran === 0 ? "" : ran === TOTAL && good === TOTAL ? "ok" : good < ran ? "bad" : "");
    $("meter").style.width = Math.round((good / TOTAL) * 100) + "%";
    var verdict = $("verdict");
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
      await loadCatalog();
      await loadCart();
    }
  }

  var lastFocus = null;
  function openChecks() {
    lastFocus = document.activeElement;
    $("checks").hidden = false;
    $("scrim").hidden = false;
    $("open-checks").setAttribute("aria-expanded", "true");
    $("close-checks").focus();
  }
  function closeChecks() {
    $("checks").hidden = true;
    $("scrim").hidden = true;
    $("open-checks").setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); }
  }

  $("open-checks").addEventListener("click", openChecks);
  $("close-checks").addEventListener("click", closeChecks);
  $("scrim").addEventListener("click", closeChecks);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("checks").hidden) { closeChecks(); } });
  runAll.addEventListener("click", runChecks);
  $("checkout").addEventListener("click", checkout);
  $("pay-balance").addEventListener("click", function () { pay(false); });
  $("pay-over").addEventListener("click", function () { pay(true); });
  $("refund-full").addEventListener("click", function () { refund(false); });
  $("refund-over").addEventListener("click", function () { refund(true); });
  updateScore();

  // #checks opens the drawer on load; #run-checks also runs every check.
  if (window.matchMedia && window.matchMedia("(max-width: 520px)").matches) { document.querySelector(".expect").open = false; }
  (async function start() {
    await loadCatalog();
    await loadCart();
    if (location.hash === "#checks" || location.hash === "#run-checks") { openChecks(); }
    if (location.hash === "#run-checks") { await runChecks(); }
  })();
})();
</script>
</body>
</html>
`;

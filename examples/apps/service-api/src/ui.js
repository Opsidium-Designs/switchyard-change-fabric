// service-api interactive tester page, served at GET / by src/index.js.
//
// A self-contained HTML page (inline CSS and JS, no external scripts, fonts, or
// CDNs) that lets a human run the SAME three checks the gate runs, against the
// live Worker it is served from, for every resource:
//   1. an UNAUTHENTICATED write is rejected (401 or 403),
//   2. an authenticated but INVALID request is rejected (400),
//   3. an authenticated, VALID request succeeds (2xx).
// Search is a GET, so its checks mirror the gate: an unauthenticated search, an
// authenticated search with no `q`, and an authenticated search with a term.
//
// The page makes the before/after story visible: on the planted gap the
// unauthenticated and invalid checks fail (writes return 201 with no token), so
// the score is low; once every resource calls requireAuth and validates its
// input, all 18 checks pass. This module only renders the page: it changes no
// resource, contract, or route behavior.

import { DEMO_TOKEN } from "./contracts/auth.js";

/**
 * The checks per resource. Each check is { method, path, auth, body? }; the
 * bodies mirror the gate's valid and invalid inputs.
 */
const RESOURCES = [
  {
    name: "users",
    unauth: { method: "POST", path: "/users", body: { email: "a@example.com" } },
    invalid: { method: "POST", path: "/users", body: {} },
    valid: { method: "POST", path: "/users", body: { email: "a@example.com" } },
  },
  {
    name: "orders",
    unauth: { method: "POST", path: "/orders", body: { sku: "abc", qty: 2 } },
    invalid: { method: "POST", path: "/orders", body: { sku: "", qty: 0 } },
    valid: { method: "POST", path: "/orders", body: { sku: "abc", qty: 2 } },
  },
  {
    name: "products",
    unauth: { method: "POST", path: "/products", body: { name: "widget", price: 9 } },
    invalid: { method: "POST", path: "/products", body: { name: "", price: -1 } },
    valid: { method: "POST", path: "/products", body: { name: "widget", price: 9 } },
  },
  {
    name: "auth",
    unauth: { method: "POST", path: "/auth", body: { label: "ci" } },
    invalid: { method: "POST", path: "/auth", body: {} },
    valid: { method: "POST", path: "/auth", body: { label: "ci" } },
  },
  {
    name: "search",
    unauth: { method: "GET", path: "/search?q=widgets" },
    invalid: { method: "GET", path: "/search" },
    valid: { method: "GET", path: "/search?q=widgets" },
  },
  {
    name: "notifications",
    unauth: { method: "POST", path: "/notifications", body: { to: "a@example.com", message: "hi" } },
    invalid: { method: "POST", path: "/notifications", body: { to: "", message: "" } },
    valid: { method: "POST", path: "/notifications", body: { to: "a@example.com", message: "hi" } },
  },
];

/** The configuration the inline script reads, safe to embed in a script tag. */
const CONFIG = JSON.stringify({ token: DEMO_TOKEN, resources: RESOURCES }).replace(/</g, "\\u003c");

/** The resource names, as listed in the static (no-JS) part of the page. */
const NAMES = RESOURCES.map((r) => r.name);

/** The tester page HTML. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>service-api tester</title>
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
  button.secondary { background: transparent; color: var(--accent); padding: 0.25rem 0.7rem; font-size: 0.9rem; }
  button:disabled { opacity: 0.6; cursor: progress; }
  button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .score { font-size: 1.15rem; font-weight: 700; }
  .score.all { color: var(--pass); }
  .score.some { color: var(--fail); }
  .meter { flex: 1 1 10rem; min-width: 8rem; height: 0.6rem; background: var(--idle-bg); border-radius: 999px; overflow: hidden; }
  .meter > span { display: block; height: 100%; width: 0; background: var(--pass); transition: width 0.2s; }
  .verdict { width: 100%; margin: 0; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 30rem), 1fr)); gap: 1rem; }
  .resource { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 0.85rem 1rem; }
  .resource header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .resource header .tally { color: var(--muted); font-size: 0.9rem; }
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
  .detail .hint { margin: 0.25rem 0 0.5rem; }
  .fail .detail .hint { color: var(--fail); }
  pre { margin: 0.35rem 0 0; background: var(--code); padding: 0.5rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
  @media (prefers-reduced-motion: reduce) { .meter > span { transition: none; } }
</style>
</head>
<body>
<main>
<h1>service-api tester</h1>
<p class="lede">
  A multi-resource JSON API served by one Worker: ${NAMES.join(", ")}. Each
  resource is owned by its own module. This page runs the same three checks the
  gate runs, against this Worker, for every resource.
</p>
<section class="story" aria-labelledby="story-title">
  <h2 id="story-title">What to expect</h2>
  <ul>
    <li><strong>Before the fix</strong> (the planted gap): resources skip auth and validation, so a write with no token returns <code>201</code> and an invalid body is accepted. Most checks fail.</li>
    <li><strong>After the fix</strong>: every resource calls <code>requireAuth</code> and validates its input, so a missing token is <code>401</code>, a bad body is <code>400</code>, and a valid authenticated request still succeeds. All 18 checks pass.</li>
  </ul>
  <p>Authenticated checks send <code>Authorization: Bearer &lt;demo token&gt;</code> (the token from <code>src/contracts/auth.js</code>). Valid writes create demo records in this Worker's memory.</p>
</section>
<div class="bar">
  <button type="button" class="primary" id="run-all">Run all checks</button>
  <span class="score" id="score" role="status" aria-live="polite">0 of 18 checks secure (not run yet)</span>
  <div class="meter" aria-hidden="true"><span id="meter"></span></div>
  <p class="verdict" id="verdict">Press "Run all checks" to test every resource.</p>
</div>
<div class="grid" id="resources">
  <noscript><p>This tester needs JavaScript. The resources are: ${NAMES.join(", ")}.</p></noscript>
</div>
</main>
<script id="tester-config" type="application/json">${CONFIG}</script>
<script>
(function () {
  "use strict";
  var config = JSON.parse(document.getElementById("tester-config").textContent);
  var KINDS = [
    { key: "unauth", label: "Unauthenticated write is rejected", expected: "401 or 403", auth: false,
      ok: function (s) { return s === 401 || s === 403; },
      hint: function (s) { return s >= 200 && s < 300 ? "Accepted with no token (" + s + "): this resource is not calling requireAuth." : "Expected the auth contract's 401 (or 403)."; } },
    { key: "invalid", label: "Authenticated but invalid input is rejected", expected: "400", auth: true,
      ok: function (s) { return s === 400; },
      hint: function (s) { return s >= 200 && s < 300 ? "Invalid input was accepted (" + s + "): this resource is not validating its input." : "Expected 400 for invalid input with a valid token."; } },
    { key: "valid", label: "Authenticated, valid request succeeds", expected: "2xx", auth: true,
      ok: function (s) { return s >= 200 && s < 300; },
      hint: function () { return "A valid, authenticated request must still succeed."; } }
  ];
  var TOTAL = config.resources.length * KINDS.length;
  var results = {};
  var root = document.getElementById("resources");
  var runAll = document.getElementById("run-all");

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function describe(req, auth) {
    var line = req.method + " " + req.path;
    if (req.body !== undefined) { line += " " + JSON.stringify(req.body); }
    return line + (auth ? "  (with bearer token)" : "  (no Authorization header)");
  }

  function excerpt(text) {
    var out = text;
    try { out = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* not JSON: show as text */ }
    return out.length > 800 ? out.slice(0, 800) + "\\n... (truncated)" : out;
  }

  // Build one card per resource with one expandable row per check.
  config.resources.forEach(function (resource) {
    var card = el("section", "resource");
    card.setAttribute("aria-labelledby", "res-" + resource.name);
    var header = el("header");
    var title = el("h2", null, resource.name);
    title.id = "res-" + resource.name;
    var tally = el("span", "tally", "not run");
    tally.id = "tally-" + resource.name;
    var run = el("button", "secondary", "Run");
    run.type = "button";
    run.setAttribute("aria-label", "Run the " + resource.name + " checks");
    run.addEventListener("click", function () { runChecks([resource]); });
    var right = el("span");
    right.appendChild(tally);
    right.appendChild(document.createTextNode(" "));
    right.appendChild(run);
    header.appendChild(title);
    header.appendChild(right);
    card.appendChild(header);
    KINDS.forEach(function (kind) {
      var req = resource[kind.key];
      var row = el("details", "idle");
      row.id = "check-" + resource.name + "-" + kind.key;
      var summary = el("summary");
      var label = kind.key === "unauth" && req.method === "GET" ? "Unauthenticated request is rejected" : kind.label;
      summary.appendChild(el("span", "what", label));
      var badge = el("span", "badge", "NOT RUN");
      summary.appendChild(badge);
      var codes = el("span", "codes", "expected " + kind.expected + ", actual -");
      summary.appendChild(codes);
      row.appendChild(summary);
      var detail = el("div", "detail");
      var hint = el("p", "hint", "Run the check to see the response.");
      detail.appendChild(hint);
      detail.appendChild(el("div", null, "Request:"));
      detail.appendChild(el("pre", null, describe(req, kind.auth)));
      detail.appendChild(el("div", null, "Response body:"));
      var body = el("pre", null, "(not run)");
      detail.appendChild(body);
      row.appendChild(detail);
      card.appendChild(row);
      row._parts = { badge: badge, codes: codes, hint: hint, body: body };
    });
    root.appendChild(card);
  });

  function render(resource, kind, status, text, error) {
    var row = document.getElementById("check-" + resource.name + "-" + kind.key);
    var parts = row._parts;
    var passed = error === undefined && kind.ok(status);
    results[resource.name + ":" + kind.key] = passed;
    row.className = passed ? "pass" : "fail";
    parts.badge.textContent = passed ? "PASS" : "FAIL";
    parts.codes.textContent = "expected " + kind.expected + ", actual " + (error === undefined ? status : "error");
    parts.hint.textContent = error !== undefined ? "The request failed: " + error : passed ? "As expected." : kind.hint(status);
    parts.body.textContent = error !== undefined ? "(no response)" : text === "" ? "(empty body)" : excerpt(text);
  }

  function updateScore() {
    var secure = 0;
    var ran = 0;
    Object.keys(results).forEach(function (k) { ran += 1; if (results[k]) { secure += 1; } });
    config.resources.forEach(function (resource) {
      var done = 0;
      var good = 0;
      KINDS.forEach(function (kind) {
        var v = results[resource.name + ":" + kind.key];
        if (v !== undefined) { done += 1; if (v) { good += 1; } }
      });
      document.getElementById("tally-" + resource.name).textContent = done === 0 ? "not run" : good + " of " + KINDS.length + " pass";
    });
    var score = document.getElementById("score");
    score.textContent = secure + " of " + TOTAL + " checks secure" + (ran < TOTAL ? " (" + ran + " run)" : "");
    score.className = "score " + (ran === TOTAL && secure === TOTAL ? "all" : ran > 0 && secure < ran ? "some" : "");
    document.getElementById("meter").style.width = Math.round((secure / TOTAL) * 100) + "%";
    var verdict = document.getElementById("verdict");
    if (ran === 0) {
      verdict.textContent = "Press \\"Run all checks\\" to test every resource.";
    } else if (ran === TOTAL && secure === TOTAL) {
      verdict.textContent = "Fixed: every resource requires a token and rejects invalid input, and valid requests still succeed.";
    } else if (secure < ran) {
      verdict.textContent = (ran - secure) + " check(s) failing: some resources still accept requests with no token or with invalid input (the planted gap). Open a failing check to see the response.";
    } else {
      verdict.textContent = "Every check run so far passes. Run all checks for the full score.";
    }
  }

  async function runOne(resource, kind) {
    var req = resource[kind.key];
    var headers = {};
    if (req.body !== undefined) { headers["content-type"] = "application/json"; }
    if (kind.auth) { headers.authorization = "Bearer " + config.token; }
    var init = { method: req.method, headers: headers, cache: "no-store" };
    if (req.body !== undefined) { init.body = JSON.stringify(req.body); }
    try {
      var response = await fetch(req.path, init);
      render(resource, kind, response.status, await response.text());
    } catch (e) {
      render(resource, kind, 0, "", e && e.message ? e.message : String(e));
    }
  }

  async function runChecks(list) {
    runAll.disabled = true;
    try {
      for (var i = 0; i < list.length; i += 1) {
        for (var j = 0; j < KINDS.length; j += 1) {
          await runOne(list[i], KINDS[j]);
        }
        updateScore();
      }
    } finally {
      runAll.disabled = false;
    }
  }

  runAll.addEventListener("click", function () {
    results = {};
    runChecks(config.resources);
  });
  updateScore();
})();
</script>
</body>
</html>
`;

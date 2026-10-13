// cityhall self-test page, served at GET / by src/index.ts.
//
// A self-contained HTML page (inline CSS and JS, no external scripts, fonts, or
// CDNs) that runs representative checks for every domain against the real API
// of the Worker it is served from, and shows a passed/total score per domain
// and overall. A deployed preview of any revision therefore shows its quality
// at a glance: a low score on the planted baseline, all green after a correct
// fix.
//
// Each check states the intended behavior (mirroring the acceptance gate) and,
// on click, the expected and actual values. Nothing is keyed to a specific
// planted gap. Checks create their own records (with a per-run tag where a
// name or date must be unique), so a rerun starts clean; the records stay in
// the Worker's memory. This module only renders the page: it changes no route
// behavior.

import { DEMO_TOKENS } from "./contracts/auth.ts";

const CONFIG = JSON.stringify({ tokens: DEMO_TOKENS }).replace(/</g, "\\u003c");

/** The self-test page HTML. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<link rel="icon" href="data:," />
<title>City Hall services - self-test</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f3f5f7; --fg: #1b232c; --muted: #5d6874; --card: #ffffff; --line: #dde3e9;
    --accent: #1f5f8b; --ok: #1d7a46; --ok-bg: #e2f4ea; --bad: #b42318; --bad-bg: #fde8e6; --soft: #eef1f4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12171c; --fg: #e6ebf0; --muted: #98a4b0; --card: #1a2128; --line: #2b343d;
      --accent: #6fb3e0; --ok: #5fd08f; --ok-bg: #173826; --bad: #ff8a80; --bad-bg: #3d1d1b; --soft: #222a32;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; justify-content: space-between; padding: 0.8rem 1.2rem; background: var(--card); border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font-size: 1.15rem; }
  h1 small { display: block; font-size: 0.8rem; font-weight: 400; color: var(--muted); }
  .bar { display: flex; gap: 0.6rem; align-items: center; }
  button { font: inherit; padding: 0.4rem 0.9rem; border-radius: 8px; border: 1px solid var(--line); background: var(--accent); color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: progress; }
  .pill { display: inline-block; font-size: 0.8rem; font-weight: 700; padding: 0.1rem 0.6rem; border-radius: 999px; background: var(--soft); color: var(--muted); white-space: nowrap; }
  .pill.ok { background: var(--ok-bg); color: var(--ok); }
  .pill.bad { background: var(--bad-bg); color: var(--bad); }
  .pill.big { font-size: 1rem; padding: 0.25rem 0.9rem; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; padding: 1rem 1.2rem 2rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 0.8rem 0.9rem; }
  section h2 { display: flex; justify-content: space-between; align-items: center; margin: 0 0 0.5rem; font-size: 1rem; text-transform: capitalize; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-top: 1px solid var(--line); }
  details summary { display: flex; gap: 0.5rem; align-items: baseline; padding: 0.35rem 0; cursor: pointer; list-style: none; }
  details summary::-webkit-details-marker { display: none; }
  .mark { flex: none; width: 1.1rem; font-weight: 800; text-align: center; color: var(--muted); }
  .pass .mark { color: var(--ok); }
  .fail .mark { color: var(--bad); }
  .detail { margin: 0 0 0.5rem 1.6rem; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
  footer { padding: 0 1.2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<header>
  <h1>City Hall services<small>Self-test: representative checks per domain, run against this Worker's API</small></h1>
  <div class="bar">
    <span class="pill big" id="score" role="status" aria-live="polite">not run</span>
    <button type="button" id="run">Run checks</button>
  </div>
</header>
<main id="domains"></main>
<footer>Every check runs a real request against this deployment with the demo tokens and writes demo records into the Worker's memory. A failed check shows what was expected and what came back.</footer>
<script>
(function () {
  "use strict";
  var CONFIG = ${CONFIG};
  var T = CONFIG.tokens;
  var TAG = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }
  async function call(method, path, body, token) {
    var headers = {};
    if (body !== undefined) { headers["content-type"] = "application/json"; }
    if (token) { headers.authorization = "Bearer " + token; }
    var res = await fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var text = await res.text();
    var parsed = text;
    try { parsed = JSON.parse(text); } catch (e) { /* keep text */ }
    return { status: res.status, body: parsed };
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function result(ok, expected, actual) { return { ok: ok, expected: expected, actual: actual }; }
  function expectStatus(reply, status) { return result(reply.status === status, "status " + status, "status " + reply.status + " " + JSON.stringify(reply.body)); }
  function expectValue(actual, expected) { return result(same(actual, expected), JSON.stringify(expected), JSON.stringify(actual)); }
  function field(reply, name) { return reply.body && typeof reply.body === "object" ? reply.body[name] : undefined; }
  function randomDay() {
    var start = Date.UTC(2030, 0, 1);
    var offset = Math.floor(Math.random() * 3000);
    return new Date(start + offset * 86400000).toISOString().slice(0, 10);
  }
  function sumOf(list) { return (list || []).reduce(function (a, b) { return a + b; }, 0); }

  var CHECKS = [
    ["contracts", "Pagination refuses limit=0", async function () { return expectStatus(await call("GET", "/parks/programs?limit=0"), 400); }],
    ["contracts", "Pagination refuses limit=101", async function () { return expectStatus(await call("GET", "/transit/fares?limit=101"), 400); }],
    ["contracts", "Pagination refuses limit=abc", async function () { return expectStatus(await call("GET", "/parking/meters?limit=abc"), 400); }],
    ["contracts", "Pagination defaults to limit 20, offset 0", async function () {
      var r = await call("GET", "/transit/fares");
      return expectValue([field(r, "limit"), field(r, "offset")], [20, 0]);
    }],

    ["permits", "A resident lists only their own applications", async function () {
      var r = await call("GET", "/permits/applications?limit=100", undefined, T.resident);
      var owners = ((r.body && r.body.items) || []).map(function (p) { return p.ownerId; }).filter(function (o) { return o !== "res-ana"; });
      return expectValue(owners, []);
    }],
    ["permits", "A resident cannot decide a permit", async function () {
      var app = await call("POST", "/permits/applications", { kind: "fence", address: "1 Test St", valuationCents: 100000 }, T.resident);
      return expectStatus(await call("POST", "/permits/applications/" + field(app, "id") + "/decision", { decision: "approved", decidedOn: "2026-03-02" }, T.resident), 403);
    }],
    ["permits", "Inspection on the 3rd business day after Mon 2026-03-02", async function () {
      var r = await call("POST", "/permits/inspections", { permitId: "prm-1", requestedOn: "2026-03-02" }, T.resident);
      return expectValue(field(r, "scheduledFor"), "2026-03-05");
    }],
    ["permits", "Fee rounds 0.5% of valuation half up", async function () {
      var r = await call("POST", "/permits/fees", { permitId: "prm-3", installments: 1 }, T.resident);
      return expectValue(field(r, "feeCents"), 13673);
    }],
    ["permits", "Installments add up to the fee", async function () {
      var r = await call("POST", "/permits/fees", { permitId: "prm-1", installments: 4 }, T.resident);
      return expectValue(field(r, "installments"), [4563, 4563, 4562, 4562]);
    }],

    ["parking", "A late-evening citation is dated on the city calendar", async function () {
      var r = await call("POST", "/parking/citations", { residentId: "res-ana", plate: "UI" + TAG.slice(0, 4), violation: "expired-meter", issuedAt: "2026-03-06T23:30:00-06:00" }, T.clerk);
      return expectValue(field(r, "issuedOn"), "2026-03-06");
    }],
    ["parking", "A resident cannot issue a citation", async function () {
      return expectStatus(await call("POST", "/parking/citations", { residentId: "res-ben", plate: "XYZ1", violation: "hydrant", issuedAt: "2026-03-02T12:00:00-06:00" }, T.resident), 403);
    }],
    ["parking", "A started 15-minute block is billed whole", async function () {
      return expectValue(field(await call("GET", "/parking/meters/m-100/quote?minutes=31"), "costCents"), 225);
    }],
    ["parking", "Plates are stored in canonical form", async function () {
      var raw = "q-" + TAG.slice(-5);
      var r = await call("POST", "/parking/permits", { zone: "A", plate: raw, months: 1 }, T.resident);
      return expectValue(field(r, "plate"), raw.replace("-", "").toUpperCase());
    }],
    ["parking", "An appeal on the 21st business day is accepted", async function () {
      var c = await call("POST", "/parking/citations", { residentId: "res-ana", plate: "AP" + TAG.slice(0, 4), violation: "no-permit", issuedAt: "2026-03-02T12:00:00-06:00" }, T.clerk);
      return expectStatus(await call("POST", "/parking/appeals", { citationId: field(c, "id"), reason: "self-test", filedOn: "2026-03-31" }, T.resident), 201);
    }],

    ["utilities", "A started 100 gallons is billed as a unit", async function () {
      return expectValue(field(await call("POST", "/utilities/water", { accountId: "acct-ana", period: "2026-03", gallons: 5001 }, T.clerk), "amountCents"), 6185);
    }],
    ["utilities", "A building bill splits without losing a cent", async function () {
      var bill = await call("POST", "/utilities/water", { accountId: "acct-elm", period: "2026-03", gallons: 10000 }, T.clerk);
      var r = await call("POST", "/utilities/water/" + field(bill, "id") + "/split", { unitGallons: [1000, 1000, 1000] }, T.clerk);
      return expectValue(field(r, "split"), [5084, 5083, 5083]);
    }],
    ["utilities", "Usage is grouped by city calendar day", async function () {
      var r = await call("GET", "/utilities/usage/acct-ana", undefined, T.resident);
      return expectValue(field(r, "items"), [{ date: "2026-03-01", gallons: 200 }, { date: "2026-03-02", gallons: 210 }, { date: "2026-03-03", gallons: 90 }]);
    }],
    ["utilities", "Another resident's usage is hidden", async function () {
      return expectStatus(await call("GET", "/utilities/usage/acct-ana", undefined, T.otherResident), 404);
    }],
    ["utilities", "A second outage report joins the open outage", async function () {
      var a = await call("POST", "/utilities/outages", { area: "downtown", reportedAt: "2026-03-02T06:00:00-06:00" }, T.resident);
      var b = await call("POST", "/utilities/outages", { area: "downtown", reportedAt: "2026-03-02T06:05:00-06:00" }, T.otherResident);
      return expectValue([b.status, field(b, "id") === field(a, "id")], [200, true]);
    }],
    ["utilities", "An autopay cap of 0 is refused", async function () {
      return expectStatus(await call("PUT", "/utilities/autopay", { capCents: 0 }, T.otherResident), 400);
    }],

    ["licensing", "A blank business name is refused", async function () {
      return expectStatus(await call("POST", "/licensing/business", { name: "   ", category: "retail" }, T.resident), 400);
    }],
    ["licensing", "A duplicate business name is refused", async function () {
      await call("POST", "/licensing/business", { name: "Check Co " + TAG, category: "retail" }, T.resident);
      return expectStatus(await call("POST", "/licensing/business", { name: " CHECK co " + TAG.toUpperCase(), category: "retail" }, T.otherResident), 409);
    }],
    ["licensing", "A spayed cat's fee is half, rounded half up", async function () {
      return expectValue(field(await call("POST", "/licensing/pets", { name: "Miso", species: "cat", spayed: true }, T.resident), "feeCents"), 763);
    }],
    ["licensing", "An event filed 9 business days ahead is refused", async function () {
      return expectStatus(await call("POST", "/licensing/events", { name: "Fair", attendance: 100, eventDate: "2026-03-13", filedOn: "2026-03-02" }, T.resident), 422);
    }],
    ["licensing", "A vendor license ends the day before", async function () {
      return expectValue(field(await call("POST", "/licensing/vendors", { businessName: "Cart", zone: "market", startsOn: "2026-04-01", months: 3 }, T.resident), "expiresOn"), "2026-06-30");
    }],
    ["licensing", "An anonymous vendor application is refused", async function () {
      return expectStatus(await call("POST", "/licensing/vendors", { businessName: "Cart", zone: "market", startsOn: "2026-04-01", months: 3 }), 401);
    }],

    ["records", "A request is due 10 business days later", async function () {
      return expectValue(field(await call("POST", "/records/requests", { subject: "Self-test", receivedAt: "2026-03-02T10:00:00-06:00" }, T.resident), "dueOn"), "2026-03-16");
    }],
    ["records", "Phone numbers are redacted", async function () {
      return expectValue(field(await call("POST", "/records/redaction", { text: "call 555-123-4567" }, T.clerk), "redacted"), "call [PHONE]");
    }],
    ["records", "Redaction is for staff only", async function () {
      return expectStatus(await call("POST", "/records/redaction", { text: "123-45-6789" }, T.resident), 403);
    }],
    ["records", "A leap-day record clamps to Feb 28", async function () {
      return expectValue(field(await call("GET", "/records/retention/schedule?recordClass=correspondence&createdOn=2024-02-29", undefined, T.clerk), "destroyAfter"), "2026-02-28");
    }],
    ["records", "More than 10 copies are refused", async function () {
      return expectStatus(await call("POST", "/records/certificates/orders", { kind: "birth", copies: 11 }, T.resident), 400);
    }],

    ["transit", "A one-zone reduced fare is 113 cents", async function () {
      return expectValue(field(await call("GET", "/transit/fares/quote?zones=1&rider=reduced"), "fareCents"), 113);
    }],
    ["transit", "Five zones are refused", async function () {
      return expectStatus(await call("GET", "/transit/fares/quote?zones=5&rider=adult"), 400);
    }],
    ["transit", "An expired certificate is denied", async function () {
      return expectValue(field(await call("POST", "/transit/eligibility", { certificateId: "cert-ben-disability", appliedOn: "2026-04-15" }, T.otherResident), "status"), "denied");
    }],
    ["transit", "Another resident's certificate is refused", async function () {
      return expectStatus(await call("POST", "/transit/eligibility", { certificateId: "cert-ana-senior", appliedOn: "2026-03-02" }, T.otherResident), 404);
    }],
    ["transit", "A prorated refund keeps the resident's cent", async function () {
      var pass = await call("POST", "/transit/passes", { kind: "adult", month: "2026-03" }, T.otherResident);
      return expectValue(field(await call("POST", "/transit/refunds", { passId: field(pass, "id"), cancelOn: "2026-03-11" }, T.otherResident), "refundCents"), 6097);
    }],

    ["parks", "Co-renter shares add up to the cost", async function () {
      var r = await call("POST", "/parks/reservations", { facility: "pavilion-b", date: randomDay(), hours: 2, coRenters: ["Jo", "Sam"] }, T.resident);
      return expectValue((field(r, "shares") || []).map(function (s) { return s.shareCents; }), [1834, 1833, 1833]);
    }],
    ["parks", "A facility cannot be double-booked", async function () {
      var day = randomDay();
      await call("POST", "/parks/reservations", { facility: "field-1", date: day, hours: 1 }, T.resident);
      return expectStatus(await call("POST", "/parks/reservations", { facility: "field-1", date: day, hours: 1 }, T.otherResident), 409);
    }],
    ["parks", "Age ranges include both ends, capacity is enforced", async function () {
      var p = await call("POST", "/parks/programs", { name: "Self-test " + TAG, minAge: 6, maxAge: 12, capacity: 2 }, T.clerk);
      var id = field(p, "id");
      var path = "/parks/programs/" + id + "/enrollments";
      var a = await call("POST", path, { participantName: "A", age: 6 }, T.resident);
      var b = await call("POST", path, { participantName: "B", age: 12 }, T.resident);
      var c = await call("POST", path, { participantName: "C", age: 8 }, T.resident);
      return expectValue([a.status, b.status, c.status], [201, 201, 409]);
    }],
    ["parks", "A waitlist offer is held 2 business days", async function () {
      var p = await call("POST", "/parks/programs", { name: "Waitlist " + TAG, minAge: 0, maxAge: 99, capacity: 1 }, T.clerk);
      var w = await call("POST", "/parks/waitlists", { programId: field(p, "id") }, T.resident);
      return expectValue(field(await call("POST", "/parks/waitlists/" + field(w, "id") + "/offer", { offeredOn: "2026-03-06" }, T.clerk), "offerExpiresOn"), "2026-03-10");
    }],
    ["parks", "Income at the threshold waives 100%", async function () {
      return expectValue(field(await call("POST", "/parks/waivers", { householdSize: 3, monthlyIncomeCents: 250000 }, T.otherResident), "waiverPercent"), 100);
    }],

    ["housing", "A resident cannot record an inspection", async function () {
      return expectStatus(await call("POST", "/housing/inspections", { unitId: "unit-1", inspectedOn: "2026-03-02", violations: 0 }, T.otherResident), 403);
    }],
    ["housing", "No heat must be fixed the next business day", async function () {
      return expectValue(field(await call("POST", "/housing/complaints", { unitId: "unit-1", category: "heat", filedOn: "2026-03-06" }, T.resident), "repairBy"), "2026-03-09");
    }],
    ["housing", "A 5% raise over the latest rent is allowed", async function () {
      var head = await call("GET", "/housing/rents?unitId=unit-1&limit=1", undefined, T.otherResident);
      var total = field(head, "total") || 1;
      var last = await call("GET", "/housing/rents?unitId=unit-1&limit=1&offset=" + (total - 1), undefined, T.otherResident);
      var latest = ((last.body && last.body.items) || [])[0] || { rentCents: 126000, effectiveOn: "2025-01-01" };
      var next = (Number(latest.effectiveOn.slice(0, 4)) + 1) + latest.effectiveOn.slice(4);
      var rent = latest.rentCents + Math.floor((latest.rentCents * 500 + 5000) / 10000);
      return expectStatus(await call("POST", "/housing/rents", { unitId: "unit-1", rentCents: rent, effectiveOn: next }, T.otherResident), 201);
    }],
    ["housing", "Relocation aid splits without losing a cent", async function () {
      var members = [{ name: "A", weight: 1 }, { name: "B", weight: 1 }, { name: "C", weight: 1 }];
      var r = await call("POST", "/housing/relocation", { unitId: "unit-1", totalAidCents: 100000, members: members }, T.clerk);
      var shares = (field(r, "shares") || []).map(function (s) { return s.shareCents; });
      return expectValue([shares, sumOf(shares)], [[33334, 33333, 33333], 100000]);
    }],
    ["housing", "Relocation aid is for staff only", async function () {
      return expectStatus(await call("POST", "/housing/relocation", { unitId: "unit-1", totalAidCents: 1000, members: [{ name: "A", weight: 1 }] }, T.otherResident), 403);
    }],
  ];

  var domains = [];
  var rows = {};
  CHECKS.forEach(function (check, i) {
    var domain = check[0];
    if (!rows[domain]) {
      domains.push(domain);
      var section = el("section");
      var h2 = el("h2", null, domain);
      var pill = el("span", "pill", "-");
      pill.id = "pill-" + domain;
      h2.appendChild(pill);
      section.appendChild(h2);
      var ul = el("ul");
      section.appendChild(ul);
      $("domains").appendChild(section);
      rows[domain] = ul;
    }
    var li = el("li");
    li.id = "check-" + i;
    var details = el("details");
    var summary = el("summary");
    summary.appendChild(el("span", "mark", "."));
    summary.appendChild(el("span", null, check[1]));
    details.appendChild(summary);
    details.appendChild(el("div", "detail", "not run"));
    li.appendChild(details);
    rows[domain].appendChild(li);
  });

  function setPill(node, passed, total) {
    node.textContent = passed + "/" + total;
    node.className = node.className.replace(/ ?(ok|bad)/g, "") + (passed === total ? " ok" : " bad");
  }

  async function runAll() {
    $("run").disabled = true;
    $("score").textContent = "running";
    var passed = 0;
    var perDomain = {};
    for (var i = 0; i < CHECKS.length; i += 1) {
      var check = CHECKS[i];
      var li = $("check-" + i);
      var outcome;
      try {
        outcome = await check[2]();
      } catch (err) {
        outcome = result(false, "a reply", "error: " + (err && err.message ? err.message : String(err)));
      }
      li.className = outcome.ok ? "pass" : "fail";
      li.querySelector(".mark").textContent = outcome.ok ? "\\u2713" : "\\u2717";
      li.querySelector(".detail").textContent = "expected: " + outcome.expected + "\\nactual:   " + outcome.actual;
      var d = perDomain[check[0]] || (perDomain[check[0]] = { passed: 0, total: 0 });
      d.total += 1;
      if (outcome.ok) { d.passed += 1; passed += 1; }
      setPill($("pill-" + check[0]), d.passed, d.total);
    }
    setPill($("score"), passed, CHECKS.length);
    $("score").className = "pill big" + (passed === CHECKS.length ? " ok" : " bad");
    $("run").disabled = false;
  }

  $("run").addEventListener("click", runAll);
  runAll();
})();
</script>
</body>
</html>
`;

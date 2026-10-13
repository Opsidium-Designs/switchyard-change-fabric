# cityhall

A city-services API served by one Cloudflare Worker, written in TypeScript with
a plain `fetch` handler (no framework, no runtime dependencies). It is the
largest example app: eight departments of four small route modules each (32
modules), over five shared contracts.

## Why it exists

The storefront app has about a dozen natural work items; cityhall is shaped for
agent coordination at the scale of roughly 30 agents (a lead, sub-leads, and
workers). Every one of its 32 modules carries its own independent planted gaps
(about 30 to 40 genuinely parallel items with disjoint write sets, one file per
module), while three shared seams, a few cross-department dependencies, and two
pinned developer tests force real ordering, waiting, and a human decision. The
gate has 237 fine-grained acceptance tests, so the progress of each integrated
revision is visible as a count (106/237 on the baseline, 237/237 when done).

## Layout

| Department | Modules (`src/<department>/<module>.ts`, routes under `/<department>/<module>`) |
|------------|------------------------------------------------------------------------------|
| permits    | `applications`, `inspections`, `fees`, `renewals` |
| parking    | `citations`, `permits`, `meters`, `appeals` |
| utilities  | `water`, `usage`, `outages`, `autopay` |
| licensing  | `business`, `pets`, `events`, `vendors` |
| records    | `requests`, `redaction`, `retention`, `certificates` |
| transit    | `passes`, `fares`, `eligibility`, `refunds` |
| parks      | `reservations`, `programs`, `waitlists`, `waivers` |
| housing    | `inspections`, `complaints`, `rents`, `relocation` |

Each module's header comment lists its routes and the rules it owns. The
shared contracts in `src/contracts/`:

- `money.ts`: integer cents (`isCents`, `sum`, `percentOf` in basis points with
  half-up rounding, `format`).
- `time.ts`: the city calendar (America/Chicago): `cityDate`, `addDays`,
  `addMonths`, `daysBetween`, `daysInMonth`, `isBusinessDay`, the city
  holidays, and `addBusinessDays`.
- `validate.ts`: field checks (`text`, `positiveCents`, `intIn`, `date`, `month`,
  `instant`, `choice`) and the one pagination rule (`readPage`, `pageOf`).
- `auth.ts`: bearer tokens to principals and roles (`requireUser`,
  `requireStaff`, `isStaff`).
- `http.ts`: `json`, `problem` (`{"error": detail}`), `notFound`, `readBody`.

`src/store.ts` holds named in-memory tables and the seed data, `src/index.ts`
routes `/<department>/<module>/...` to the owning module and exports
`createCityHall()` (a fresh instance; the default export is the deployed one),
and `src/ui.ts` is the self-test page.

## The intended API

What the goal asks for and the acceptance gate checks, through the public HTTP
surface (and, for the shared contracts, the contract modules themselves):

- Demo tokens: `resident-ana` and `resident-ben` (residents), `clerk-token`
  (clerk), `admin-token` (admin). Clerks and admins are staff. Without a token
  a protected route is `401`; a resident attempting a staff action is `403`; a
  resident asking for someone else's record gets `404`.
- Money is integer cents. Percentages round to the nearest cent with an exact
  half cent up. Any amount split between people, units, installments, or used
  and unused days adds up to the whole exactly: largest remainders get the
  leftover cents, an earlier share wins a tie (1000 three ways is 334, 333,
  333).
- Promised deadlines count business days AFTER the start date, skipping
  weekends and city holidays. Dates of instants are read on the city's
  calendar (a 23:30 report on March 6 in the city belongs to March 6).
- Every list endpoint takes `limit` (an integer 1 to 100, default 20) and
  `offset` (an integer 0 or more, default 0) and rejects anything else with
  `400`. Lists answer `{ items, total, limit, offset }`.
- Every write validates its input (`400`), refuses conflicts (`409`), and
  enforces its business rules (`422`), recording nothing when refused.

## Planted gaps (test fixture, do not fix)

The baseline is deliberately wrong. These gaps are the test fixture a run
fixes; do not fix them in this directory. The engine treats this app like any
other project (nothing in the engine names it). A working solution lives
outside the app, in `examples/reference/` (see its README); a run never sees it.

a. **Shared seams that several modules wait on.** Each is its own item, and
   only that item writes the shared file:

   - `money.ts` has no proportional split operation, so six modules split
     amounts their own way and lose or invent cents: `permits/fees`
     (installments), `parking/citations` (payment plans), `utilities/water`
     (building bills), `transit/refunds` (prorating), `parks/reservations`
     (co-renter shares), `housing/relocation` (aid by weight). The contract
     needs an `allocate(total, weights)` they can all use.
   - `time.ts` counts the start date as a business day and ignores city
     holidays, so every promised deadline is early: `permits/inspections`,
     `parking/appeals`, `licensing/events`, `records/requests`,
     `parks/waitlists`, `housing/complaints`.
   - `validate.ts` reads `limit` and `offset` with a bare `Number(...)` and no
     bounds, so all 33 list endpoints accept anything.

b. **Independent per-module gaps (one or two in every module).** The same
   kinds recur across departments, so similar fixes can be shared:

   - Missing staff checks: permit decisions, issuing citations, restoring
     outages, redaction, approving park fee waivers, recording housing
     inspections, relocation aid.
   - Ownership leaks: permit and records-request lists, another resident's
     usage, citation, certificate, or pass.
   - Missing auth: vendor licenses can be filed anonymously.
   - Missing validation: inspection dates, parking-permit months, autopay
     caps, business names, pet species, event attendance, copy counts, pass
     months, fare zones, inspection violations, rents.
   - Rounding: permit valuation fees, spayed-pet discounts, and reduced fares
     truncate instead of rounding half up; water and meters bill partial
     units down instead of up.
   - Boundaries and calendars: the renewal window and late fee are off by a
     day, program age ranges exclude their ends, vendor licenses run a day
     long, waivers miss the exact income threshold, retention mishandles a
     leap day, and citations, records requests, and usage read instants in UTC
     instead of on the city calendar.
   - Missing business rules: inspecting unapproved permits, duplicate
     appeals, duplicate waitlist entries, double-booked facilities,
     over-capacity programs, joined outage reports, duplicate business names,
     destroying records under a legal hold, a rent cap measured from the wrong
     registration, emergency repair deadlines.

c. **Cross-department dependencies.** A few modules rely on another
   department's module, so their acceptance tests pass only after that module
   is fixed: `permits/fees` and `parking/citations` pay through
   `utilities/autopay` (which ignores the cap); `transit/eligibility` asks
   `records/certificates` (which ignores expiry); `transit/passes` and
   `parks/waivers` read transit eligibility in turn.

d. **Two developer tests that pin the old behavior.** `tests/contracts/time.test.ts`
   asserts that five business days from Monday 2026-03-02 is Friday 2026-03-06
   (the gate requires Monday 2026-03-09), and `tests/licensing/pets.test.ts`
   asserts a spayed cat pays 762 cents (the gate requires 763). The developer
   tests are the gate's protected contract, so changing them is a contract
   change a human decides: accept it and a correct fix can pass; reject it and
   the original tests are restored before every gate run, so the gate fails
   honestly.

e. **Real dependencies with a lockfile.** `typescript` and `vitest` are pinned
   devDependencies with a committed `package-lock.json`, so a run installs
   dependencies (`npm ci`) before its gate can typecheck or test anything.

## Verify

```bash
npm ci
npm run gate   # typecheck + the developer suite (tests/) + the acceptance suite (gate/)
```

or `make cityhall-gate` from the repository root. The gate is deterministic and
offline: the suites build a fresh `createCityHall()` per test and assert on real
Responses, with no network and no wrangler; it finishes in under ten seconds.
On the baseline the typecheck and the developer suite pass and the acceptance
suite fails 131 of its 237 tests; after a correct fix with both pinned tests
updated, all of it passes (`make cityhall-reference-check` proves this against
the reference solution).

The protected contract the engine derives for `npm run gate` covers the files
under `tests/` and `gate/` (including `gate/harness.ts`), both vitest configs,
`tsconfig.json`, and the `gate` and `typecheck` scripts in `package.json`.
`src/` (including `src/contracts/*`) is application code, not part of it.

## Self-test page

`GET /` serves a self-test page (`src/ui.ts`, inline HTML/CSS/JS, no external
scripts or fonts, light and dark, phone-width friendly) that runs 46
representative checks (mirroring the gate, four to six per department plus the
shared pagination rule) against the Worker it is served from, with a
passed/total pill per department and overall, and expected vs actual on click.
It runs on load: about 1 of 46 on the baseline, 46 of 46 after a correct fix,
so a deployed preview of any revision shows its quality at a glance. Checks
create their own records (tagged per run where a name or date must be unique),
so a rerun stays meaningful; every check writes demo records into the Worker's
memory.

## Deploy and tear down

See [`docs/LIVE-DEPLOY.md`](../../../docs/LIVE-DEPLOY.md):

```bash
make deploy-app APP=cityhall
make delete-app APP=cityhall
```

The Worker is in-memory demo data, one city per isolate.

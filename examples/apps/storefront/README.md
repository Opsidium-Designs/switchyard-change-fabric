# storefront

A small multi-domain store served by one Cloudflare Worker, written in
TypeScript with a plain `fetch` handler (no framework). It is the larger of the
two example apps: three domains, each a folder of modules that own their
routes, over three shared contracts every domain imports.

| Domain | Module | Routes |
|--------|--------|--------|
| catalog | `src/catalog/products.ts` | `GET /products?category=&limit=&offset=`, `GET /products/:id`, `POST /products {name, categoryId, priceCents}` |
| catalog | `src/catalog/categories.ts` | `GET /categories?limit=&offset=`, `POST /categories {name}` |
| catalog | `src/catalog/search.ts` | `GET /search?q=&limit=&offset=` |
| orders | `src/orders/cart.ts` | `GET /cart`, `POST /cart/items {productId, qty}`, `DELETE /cart/items/:productId` |
| orders | `src/orders/checkout.ts` | `POST /checkout {region}` (creates the order and its invoice) |
| orders | `src/orders/history.ts` | `GET /orders?limit=&offset=`, `GET /orders/:id` |
| billing | `src/billing/invoices.ts` | `GET /invoices?limit=&offset=`, `GET /invoices/:id`, `GET /invoices/:id/receipt` |
| billing | `src/billing/tax.ts` | (no routes) the sales tax rates and the tax on an order |
| billing | `src/billing/payments.ts` | `GET /payments?limit=&offset=`, `POST /payments {invoiceId, amountCents}` |
| billing | `src/billing/refunds.ts` | `GET /refunds?limit=&offset=`, `POST /refunds {paymentId, amountCents}` |

The shared contracts:

- `src/contracts/money.ts`: the `Money` type and its arithmetic (`fromCents`,
  `toCents`, `add`, `subtract`, `multiply`, `percent`, `sum`, `format`).
- `src/contracts/http.ts`: `json(body, status)`, `problem(status, detail)`
  (`{"error": detail}`), and `readBody(request)`.
- `src/contracts/auth.ts`: `requireAuth(request)` (a `401` Response, or `null`
  when the bearer token is valid) and the demo token `demo-token`.

`src/store.ts` holds the seeded in-memory records, `src/index.ts` routes by the
first path segment and exports `createStorefront()` (a fresh instance; the
default export is the deployed one), and `src/ui.ts` is the tester page.

## The intended API

This is what the goal asks for and what the acceptance gate checks, through the
public HTTP surface only:

- Money is integer cents in every request and response, exact to the cent:
  a price reads back exactly as it was set, a line total is unit price times
  quantity, a subtotal is the sum of its lines, and a total is subtotal plus
  tax.
- Tax is the subtotal times the region's rate (CA 7.25%, NY 8.875%, TX 6.25%,
  OR 0%), rounded to the nearest cent with an exact half cent rounding up. An
  invoice states the same subtotal, tax, and total as its order.
- A payment may not exceed its invoice's balance due; the refunds of a payment
  may never add up to more than that payment. A refused payment or refund is
  `400`, `409`, or `422` and records nothing. `paidCents` is payments minus
  their refunds; `balanceCents` is total minus `paidCents`.
- The catalog's reads are public. Every write and everything a customer owns
  (cart, checkout, orders, invoices, payments, refunds) needs
  `Authorization: Bearer demo-token`; without it the response is `401`.
- Every write rejects invalid input with `400` (missing or blank names, an
  unknown category, amounts that are not positive whole cents, a quantity
  outside 1 to 99, a region the store does not ship to). An unknown product,
  invoice, or payment is `400` or `404`; checkout with an empty cart is
  rejected.
- Every list endpoint takes `limit` (an integer 1 to 100, default 20) and
  `offset` (an integer 0 or more, default 0) and rejects anything else with
  `400`. Search needs a non-blank `q` of at most 100 characters.

## Planted gaps (test fixture, do not fix)

The baseline is deliberately wrong. These gaps are the test fixture a run fixes;
do not fix them in this directory. Each is shaped so a different coordination
path has a genuine reason to happen, while the engine treats this app like any
other project (nothing in the engine names it).

a. **One mechanical change repeated across many handlers.** No handler calls
   `requireAuth`, and every list endpoint reads `limit`/`offset` with a bare
   `Number(...)` and no bounds (seven list endpoints across catalog, orders, and
   billing; eight modules need auth). Writes skip input validation. The same
   edit in ten handler modules is where a scanner and a codemod pay off.

b. **A billing domain with several distinct sub-changes.** `tax.ts` truncates
   tax instead of rounding; `invoices.ts` recomputes its totals with its own raw
   float arithmetic (so an invoice can disagree with its order by a cent);
   `payments.ts` accepts overpayment; `refunds.ts` lets refunds exceed the
   payment. One billing item naturally splits, or asks for help.

c. **A shared contract that must change.** `src/contracts/money.ts` represents
   money as floating-point dollars and `toCents` truncates, so a $19.99 price
   reads back as 1998 cents and a $1.15 one as 114. A correct fix changes the
   contract (integer cents, exact rounding), and every domain that imports it
   rebases onto the new contract.

d. **An existing test that pins the old behavior.** `tests/billing/tax.test.ts`
   asserts that a $10.00 order shipped to CA is taxed 72 cents (truncated).
   The acceptance gate requires 73 (72.5 rounds up) for the same request, so
   the two cannot both pass. The existing tests are the gate's protected
   contract, so changing that test is a contract change a human decides:

   - accept it, and a correct fix can pass the gate;
   - reject it (or never get asked), and the original test is restored before
     every gate run, so the gate fails on that test, and the run reports it
     honestly instead of shipping.

   This is the deliberate, simpler design: the human decision matters, and
   there is no path where keeping the old test passes. A `run-live` run has no
   contract-change route, so it restores the test and its gate cannot pass;
   run this app with agents on the board to reach the decision.

e. **Real dependencies with a lockfile.** `typescript` and `vitest` are pinned
   devDependencies with a committed `package-lock.json`, so a run installs
   dependencies (`npm ci`) before its gate can typecheck or test anything.

## Verify

```bash
npm ci
npm run gate   # typecheck + the developer suite (tests/) + the acceptance suite (gate/)
```

or `make storefront-gate` from the repository root. The gate is deterministic
and offline: the suites build a fresh `createStorefront()` per test and assert
on real Responses, with no network and no wrangler. On the baseline the
typecheck and the developer suite pass and the acceptance suite fails (113 of
its 129 tests); after a correct fix with the pinned tax test updated, all of it
passes.

The protected contract the engine derives for `npm run gate` covers the files
under `tests/` and `gate/` (including `gate/harness.ts`, which the gate suites
import), both vitest configs, `tsconfig.json`, and the `gate` and `typecheck`
scripts in `package.json`. `src/` (including `src/contracts/*`) is application
code, not part of it.

## Tester page

`GET /` serves an interactive tester (`src/ui.ts`, inline HTML/CSS/JS, no
external scripts). It runs 16 representative checks per domain against the
Worker it is served from (exact prices, tax rounding, invoice consistency,
payment and refund caps, auth, input validation, pagination bounds) and shows
expected vs actual, the request and response on click, and a score: about 1 of
16 checks correct on the baseline, 16 of 16 after a correct fix.

## Deploy and tear down

See [`docs/LIVE-DEPLOY.md`](../../../docs/LIVE-DEPLOY.md):

```bash
make deploy-app APP=storefront
make delete-app APP=storefront
```

The Worker is in-memory demo data, one store per isolate.

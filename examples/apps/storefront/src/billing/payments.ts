// storefront billing: payments.
//
// Routes:
//   GET  /payments?limit=&offset=          a page of payments, newest first
//   POST /payments {invoiceId, amountCents}  pay toward an invoice
//
// A payment is reported with what has been refunded from it so far.

import { fromCents, sum, toCents } from "../contracts/money.ts";
import { json, problem, readBody } from "../contracts/http.ts";
import type { Ctx, Payment, Store } from "../store.ts";

/** The public JSON shape of a payment (amounts in integer cents). */
export function paymentView(store: Store, payment: Payment) {
  const refunded = sum(store.refunds.filter((r) => r.paymentId === payment.id).map((r) => r.amount));
  return {
    id: payment.id,
    invoiceId: payment.invoiceId,
    amountCents: toCents(payment.amount),
    refundedCents: toCents(refunded),
  };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, parts } = ctx;
  if (request.method === "GET" && parts.length === 1) {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const newestFirst = [...store.payments].reverse();
    return json({
      payments: newestFirst.slice(offset, offset + limit).map((p) => paymentView(store, p)),
      total: store.payments.length,
      limit,
      offset,
    });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    const payment: Payment = {
      id: store.nextId("pay"),
      invoiceId: String(body.invoiceId ?? ""),
      amount: fromCents(Number(body.amountCents)),
    };
    store.payments.push(payment);
    return json(paymentView(store, payment), 201);
  }
  return problem(404, "not found");
}

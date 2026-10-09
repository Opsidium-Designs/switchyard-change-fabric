// storefront billing: refunds.
//
// Routes:
//   GET  /refunds?limit=&offset=           a page of refunds, newest first
//   POST /refunds {paymentId, amountCents}  refund part or all of a payment
//
// A refund gives money back from one payment, which raises the balance due on
// that payment's invoice again.

import { fromCents, toCents } from "../contracts/money.ts";
import { json, problem, readBody } from "../contracts/http.ts";
import type { Ctx, Refund } from "../store.ts";

function refundView(refund: Refund) {
  return { id: refund.id, paymentId: refund.paymentId, amountCents: toCents(refund.amount) };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, parts } = ctx;
  if (request.method === "GET" && parts.length === 1) {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const newestFirst = [...store.refunds].reverse();
    return json({
      refunds: newestFirst.slice(offset, offset + limit).map(refundView),
      total: store.refunds.length,
      limit,
      offset,
    });
  }
  if (request.method === "POST" && parts.length === 1) {
    const body = await readBody(request);
    const payment = store.payments.find((p) => p.id === body.paymentId);
    if (!payment) {
      return problem(404, "payment not found");
    }
    const refund: Refund = {
      id: store.nextId("ref"),
      paymentId: payment.id,
      amount: fromCents(Number(body.amountCents)),
    };
    store.refunds.push(refund);
    return json(refundView(refund), 201);
  }
  return problem(404, "not found");
}

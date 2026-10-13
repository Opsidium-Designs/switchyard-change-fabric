// cityhall transit: pass refunds.
//
// Routes:
//   GET  /transit/refunds?limit=&offset=   a resident's own; staff see all
//   POST /transit/refunds {passId, cancelOn}
//
// Cancelling a pass on a day of its month refunds the unused days, that day
// included. The price splits between unused and used days in proportion to
// their counts with no cent lost (the money contract's split), and the refund
// is the unused share. A pass is refunded at most once; only its holder (or
// staff) may cancel it.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { allocate } from "../contracts/money.ts";
import { daysInMonth } from "../contracts/time.ts";
import { date, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import { findPass } from "./passes.ts";

export interface PassRefund {
  id: string;
  passId: string;
  ownerId: string;
  cancelOn: string;
  unusedDays: number;
  refundCents: number;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const refunds = store.table<PassRefund>("passRefunds");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? refunds : refunds.filter((r) => r.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const cancelOn = date(body.cancelOn);
    if (!cancelOn) return problem(400, "cancelOn must be a date");
    const pass = findPass(store, body.passId, user);
    if (!pass) return notFound("pass not found");
    if (!cancelOn.startsWith(`${pass.month}-`)) {
      return problem(422, "cancelOn must fall inside the pass month");
    }
    if (refunds.some((r) => r.passId === pass.id)) {
      return problem(409, "pass already refunded");
    }
    const days = daysInMonth(pass.month);
    const usedDays = Number(cancelOn.slice(8, 10)) - 1;
    const unusedDays = days - usedDays;
    const [refundCents] = allocate(pass.priceCents, [unusedDays, usedDays]);
    const refund: PassRefund = { id: store.nextId("tref"), passId: pass.id, ownerId: pass.ownerId, cancelOn, unusedDays, refundCents: refundCents! };
    refunds.push(refund);
    return json(refund, 201);
  }
  return notFound();
}

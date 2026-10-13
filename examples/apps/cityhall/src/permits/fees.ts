// cityhall permits: permit fees and installment plans.
//
// Routes:
//   GET  /permits/fees?limit=&offset=          a resident's own; staff see all
//   POST /permits/fees {permitId, installments}  assess the fee (1 to 4 installments)
//   GET  /permits/fees/:id
//   POST /permits/fees/:id/autopay              pay the whole fee through utilities autopay
//
// A fee is the kind's base fee plus 0.5% (50 basis points) of the valuation,
// rounded to the nearest cent with a half cent up. The installments split the
// fee into equal parts that add up to it exactly.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { intIn, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import { charge } from "../utilities/autopay.ts";
import { findPermit, type PermitKind } from "./applications.ts";

export const BASE_FEE_CENTS: Readonly<Record<PermitKind, number>> = { fence: 5000, deck: 9000, roof: 7500, addition: 25000 };
export const VALUATION_BPS = 50;

export interface PermitFee {
  id: string;
  permitId: string;
  ownerId: string;
  feeCents: number;
  installments: number[];
  paid: boolean;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const fees = store.table<PermitFee>("permitFees");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? fees : fees.filter((f) => f.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const count = intIn(body.installments ?? 1, 1, 4);
    if (count === null) {
      return problem(400, "installments must be 1 to 4");
    }
    const permit = findPermit(store, body.permitId, user);
    if (!permit) return notFound("permit not found");
    if (permit.status === "denied") {
      return problem(409, "a denied permit has no fee");
    }
    const feeCents = BASE_FEE_CENTS[permit.kind] + Math.floor((permit.valuationCents * VALUATION_BPS) / 10000);
    const fee: PermitFee = {
      id: store.nextId("fee"),
      permitId: permit.id,
      ownerId: permit.ownerId,
      feeCents,
      installments: new Array<number>(count).fill(Math.round(feeCents / count)),
      paid: false,
    };
    fees.push(fee);
    return json(fee, 201);
  }
  const fee = fees.find((f) => f.id === rest[0] && (isStaff(user) || f.ownerId === user.id));
  if (rest.length === 1 && request.method === "GET") {
    return fee ? json(fee) : notFound("fee not found");
  }
  if (rest.length === 2 && rest[1] === "autopay" && request.method === "POST") {
    if (!fee) return notFound("fee not found");
    if (fee.paid) {
      return problem(409, "fee already paid");
    }
    const result = charge(store, fee.ownerId, fee.feeCents, `permit fee ${fee.id}`);
    if (!result.ok) {
      return problem(409, result.reason);
    }
    fee.paid = true;
    return json({ fee, charge: result.entry }, 201);
  }
  return notFound();
}

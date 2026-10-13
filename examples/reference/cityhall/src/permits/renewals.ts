// cityhall permits: renewals.
//
// Routes:
//   GET  /permits/renewals?limit=&offset=    a resident's own; staff see all
//   POST /permits/renewals {permitId, renewOn}
//
// An approved permit may be renewed from 60 days before it expires (that day
// included). Renewing on or before the expiry date costs the kind's renewal
// fee; renewing AFTER it adds a 10% late fee (half cent up). A renewal extends
// the permit by twelve months from its old expiry date.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { percentOf } from "../contracts/money.ts";
import { addMonths, daysBetween } from "../contracts/time.ts";
import { date, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import { findPermit, type PermitKind } from "./applications.ts";

export const RENEWAL_FEE_CENTS: Readonly<Record<PermitKind, number>> = { fence: 2500, deck: 4500, roof: 3500, addition: 12500 };
export const RENEWAL_WINDOW_DAYS = 60;
export const LATE_FEE_BPS = 1000;

export interface Renewal {
  id: string;
  permitId: string;
  ownerId: string;
  renewOn: string;
  feeCents: number;
  lateFeeCents: number;
  totalCents: number;
  newExpiresOn: string;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const renewals = store.table<Renewal>("permitRenewals");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? renewals : renewals.filter((r) => r.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const renewOn = date(body.renewOn);
    if (!renewOn) {
      return problem(400, "renewOn must be a date");
    }
    const permit = findPermit(store, body.permitId, user);
    if (!permit) return notFound("permit not found");
    if (permit.status !== "approved" || !permit.expiresOn) {
      return problem(409, "only an approved permit can be renewed");
    }
    const daysEarly = daysBetween(renewOn, permit.expiresOn);
    if (daysEarly > RENEWAL_WINDOW_DAYS) {
      return problem(422, `renewal opens ${RENEWAL_WINDOW_DAYS} days before expiry`);
    }
    const feeCents = RENEWAL_FEE_CENTS[permit.kind];
    const lateFeeCents = renewOn > permit.expiresOn ? percentOf(feeCents, LATE_FEE_BPS) : 0;
    const renewal: Renewal = {
      id: store.nextId("ren"),
      permitId: permit.id,
      ownerId: permit.ownerId,
      renewOn,
      feeCents,
      lateFeeCents,
      totalCents: feeCents + lateFeeCents,
      newExpiresOn: addMonths(permit.expiresOn, 12),
    };
    permit.expiresOn = renewal.newExpiresOn;
    renewals.push(renewal);
    return json(renewal, 201);
  }
  return notFound();
}

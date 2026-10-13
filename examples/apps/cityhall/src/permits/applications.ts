// cityhall permits: building permit applications.
//
// Routes:
//   GET  /permits/applications?limit=&offset=   a resident's own; staff see all
//   POST /permits/applications {kind, address, valuationCents}
//   GET  /permits/applications/:id               the owner or staff
//   POST /permits/applications/:id/decision {decision, decidedOn}   staff only
//
// An approved permit is valid for twelve months from its decision date. The
// other permits modules (inspections, fees, renewals) read permits through
// findPermit.

import { isStaff, requireUser, type Principal } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addMonths } from "../contracts/time.ts";
import { choice, date, pageOf, positiveCents, readPage, text } from "../contracts/validate.ts";
import type { Ctx, Store } from "../store.ts";

export const PERMIT_KINDS = ["fence", "deck", "roof", "addition"] as const;
export type PermitKind = (typeof PERMIT_KINDS)[number];

export interface Permit {
  id: string;
  ownerId: string;
  kind: PermitKind;
  address: string;
  valuationCents: number;
  status: "submitted" | "approved" | "denied";
  decidedOn: string | null;
  expiresOn: string | null;
}

/** The permit `id` when `user` may see it (its owner or staff), else undefined. */
export function findPermit(store: Store, id: unknown, user: Principal): Permit | undefined {
  const permit = store.table<Permit>("permits").find((p) => p.id === id);
  return permit && (isStaff(user) || permit.ownerId === user.id) ? permit : undefined;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const permits = store.table<Permit>("permits");
  if (rest.length === 0 && request.method === "GET") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(permits, page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const body = await readBody(request);
    const kind = choice(body.kind, PERMIT_KINDS);
    const address = text(body.address);
    const valuationCents = positiveCents(body.valuationCents);
    if (!kind || !address || valuationCents === null) {
      return problem(400, "kind, address, and a positive valuationCents are required");
    }
    const permit: Permit = { id: store.nextId("app"), ownerId: user.id, kind, address, valuationCents, status: "submitted", decidedOn: null, expiresOn: null };
    permits.push(permit);
    return json(permit, 201);
  }
  if (rest.length === 1 && request.method === "GET") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const permit = findPermit(store, rest[0], user);
    return permit ? json(permit) : notFound("permit not found");
  }
  if (rest.length === 2 && rest[1] === "decision" && request.method === "POST") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const permit = findPermit(store, rest[0], user);
    if (!permit) return notFound("permit not found");
    const body = await readBody(request);
    const decision = choice(body.decision, ["approved", "denied"] as const);
    const decidedOn = date(body.decidedOn);
    if (!decision || !decidedOn) {
      return problem(400, "decision (approved or denied) and decidedOn are required");
    }
    if (permit.status !== "submitted") {
      return problem(409, "permit already decided");
    }
    permit.status = decision;
    permit.decidedOn = decidedOn;
    permit.expiresOn = decision === "approved" ? addMonths(decidedOn, 12) : null;
    return json(permit);
  }
  return notFound();
}

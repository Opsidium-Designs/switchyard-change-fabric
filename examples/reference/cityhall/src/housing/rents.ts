// cityhall housing: the rent registry.
//
// Routes:
//   GET  /housing/rents?unitId=&limit=&offset=   staff see all; a landlord sees their units'
//   POST /housing/rents {unitId, rentCents, effectiveOn}   the unit's landlord or staff
//
// rentCents is a positive whole number of cents. A new registration must take
// effect after the unit's most recent one (409 otherwise), and may raise the
// rent by at most 5% (half cent up) over that MOST RECENT registered rent (422
// above it). A unit's first registration has no cap.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { percentOf } from "../contracts/money.ts";
import { date, pageOf, positiveCents, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import type { Unit } from "./inspections.ts";

export const MAX_INCREASE_BPS = 500;

export interface RentRegistration {
  id: string;
  unitId: string;
  rentCents: number;
  effectiveOn: string;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const registry = store.table<RentRegistration>("rentRegistrations");
  const units = store.table<Unit>("housingUnits");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    const unitId = url.searchParams.get("unitId");
    const owned = new Set(units.filter((u) => isStaff(user) || u.ownerId === user.id).map((u) => u.id));
    return json(pageOf(registry.filter((r) => owned.has(r.unitId) && (unitId === null || r.unitId === unitId)), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const rentCents = positiveCents(body.rentCents);
    const effectiveOn = date(body.effectiveOn);
    if (rentCents === null || !effectiveOn) {
      return problem(400, "a positive whole rentCents and effectiveOn are required");
    }
    const unit = units.find((u) => u.id === body.unitId);
    if (!unit) return notFound("unit not found");
    if (!isStaff(user) && unit.ownerId !== user.id) {
      return problem(403, "only the unit's landlord may register its rent");
    }
    const history = registry.filter((r) => r.unitId === unit.id).sort((a, b) => (a.effectiveOn < b.effectiveOn ? -1 : 1));
    const latest = history[history.length - 1];
    if (latest && effectiveOn <= latest.effectiveOn) {
      return problem(409, "a newer registration already exists");
    }
    if (latest && rentCents > latest.rentCents + percentOf(latest.rentCents, MAX_INCREASE_BPS)) {
      return problem(422, "increase exceeds 5% over the most recent registered rent");
    }
    const registration: RentRegistration = { id: store.nextId("rent"), unitId: unit.id, rentCents, effectiveOn };
    registry.push(registration);
    return json(registration, 201);
  }
  return notFound();
}

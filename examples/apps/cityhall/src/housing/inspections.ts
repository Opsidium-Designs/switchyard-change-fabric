// cityhall housing: rental unit inspections.
//
// Routes:
//   GET  /housing/inspections?limit=&offset=   staff see all; a landlord sees their units'
//   POST /housing/inspections {unitId, inspectedOn, violations}   staff only
//
// violations is a whole number 0 to 50. A clean inspection is free and needs no
// follow-up; otherwise the fee is 7500 cents plus 2500 for each violation after
// the third, and the unit must be re-inspected within 30 calendar days.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addDays } from "../contracts/time.ts";
import { date, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export interface Unit {
  id: string;
  ownerId: string;
  address: string;
}

export interface UnitInspection {
  id: string;
  unitId: string;
  ownerId: string;
  inspectedOn: string;
  violations: number;
  feeCents: number;
  reinspectBy: string | null;
}

/** The fee for an inspection with this many violations. */
export function inspectionFee(violations: number): number {
  return violations === 0 ? 0 : 7500 + 2500 * Math.max(0, violations - 3);
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const inspections = store.table<UnitInspection>("unitInspections");
  if (rest.length === 0 && request.method === "POST") {
    const inspector = requireUser(request);
    if (inspector instanceof Response) return inspector;
    const body = await readBody(request);
    const inspectedOn = date(body.inspectedOn);
    const violations = Number(body.violations);
    if (!inspectedOn) {
      return problem(400, "inspectedOn and violations 0 to 50 are required");
    }
    const unit = store.table<Unit>("housingUnits").find((u) => u.id === body.unitId);
    if (!unit) return notFound("unit not found");
    const inspection: UnitInspection = {
      id: store.nextId("hin"),
      unitId: unit.id,
      ownerId: unit.ownerId,
      inspectedOn,
      violations,
      feeCents: inspectionFee(violations),
      reinspectBy: violations > 0 ? addDays(inspectedOn, 30) : null,
    };
    inspections.push(inspection);
    return json(inspection, 201);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? inspections : inspections.filter((i) => i.ownerId === user.id), page));
  }
  return notFound();
}

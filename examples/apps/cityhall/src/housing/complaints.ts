// cityhall housing: tenant complaints.
//
// Routes:
//   GET  /housing/complaints?limit=&offset=   a resident's own; staff see all
//   POST /housing/complaints {unitId, category, filedOn}
//
// The landlord must repair by a business-day deadline after filedOn: no heat
// and no water are emergencies (1 business day); mold, pests, and anything
// else get 5 business days.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addBusinessDays } from "../contracts/time.ts";
import { choice, date, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import type { Unit } from "./inspections.ts";

export const CATEGORIES = ["heat", "water", "mold", "pests", "other"] as const;
export type ComplaintCategory = (typeof CATEGORIES)[number];
export const EMERGENCY: readonly ComplaintCategory[] = ["heat", "water"];
export const EMERGENCY_BUSINESS_DAYS = 5;
export const STANDARD_BUSINESS_DAYS = 5;

export interface Complaint {
  id: string;
  filerId: string;
  unitId: string;
  category: ComplaintCategory;
  filedOn: string;
  repairBy: string;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const complaints = store.table<Complaint>("complaints");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? complaints : complaints.filter((c) => c.filerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const category = choice(body.category, CATEGORIES);
    const filedOn = date(body.filedOn);
    if (!category || !filedOn) {
      return problem(400, `category (${CATEGORIES.join(", ")}) and filedOn are required`);
    }
    const unit = store.table<Unit>("housingUnits").find((u) => u.id === body.unitId);
    if (!unit) return notFound("unit not found");
    const days = EMERGENCY.includes(category) ? EMERGENCY_BUSINESS_DAYS : STANDARD_BUSINESS_DAYS;
    const complaint: Complaint = { id: store.nextId("cmp"), filerId: user.id, unitId: unit.id, category, filedOn, repairBy: addBusinessDays(filedOn, days) };
    complaints.push(complaint);
    return json(complaint, 201);
  }
  return notFound();
}

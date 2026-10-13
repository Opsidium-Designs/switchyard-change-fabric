// cityhall parks: program fee waivers.
//
// Routes:
//   GET  /parks/waivers?limit=&offset=   a resident's own; staff see all
//   POST /parks/waivers {householdSize, monthlyIncomeCents}
//   POST /parks/waivers/:id/approve      staff only
//
// The income threshold is 150000 cents a month for one person plus 50000 for
// each extra household member. Income AT or below the threshold waives 100%,
// at or below 1.5 times it waives 50%, above that 0%. A resident with an
// approved reduced-fare eligibility (transit) always gets at least 50%.

import { isStaff, requireStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { percentOf } from "../contracts/money.ts";
import { intIn, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import { hasApprovedEligibility } from "../transit/eligibility.ts";

export interface Waiver {
  id: string;
  residentId: string;
  householdSize: number;
  monthlyIncomeCents: number;
  waiverPercent: number;
  status: "pending" | "approved";
}

/** The monthly income threshold for a household. */
export function threshold(householdSize: number): number {
  return 150_000 + 50_000 * (householdSize - 1);
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const waivers = store.table<Waiver>("waivers");
  if (rest.length === 2 && rest[1] === "approve" && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const waiver = waivers.find((w) => w.id === rest[0]);
    if (!waiver) return notFound("waiver not found");
    waiver.status = "approved";
    return json(waiver);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? waivers : waivers.filter((w) => w.residentId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const householdSize = intIn(body.householdSize, 1, 12);
    const monthlyIncomeCents = intIn(body.monthlyIncomeCents, 0, 1_000_000_000);
    if (householdSize === null || monthlyIncomeCents === null) {
      return problem(400, "householdSize 1 to 12 and a whole monthlyIncomeCents are required");
    }
    const limit = threshold(householdSize);
    let waiverPercent = monthlyIncomeCents <= limit ? 100 : monthlyIncomeCents <= percentOf(limit, 15000) ? 50 : 0;
    if (hasApprovedEligibility(store, user.id)) {
      waiverPercent = Math.max(waiverPercent, 50);
    }
    const waiver: Waiver = { id: store.nextId("wvr"), residentId: user.id, householdSize, monthlyIncomeCents, waiverPercent, status: "pending" };
    waivers.push(waiver);
    return json(waiver, 201);
  }
  return notFound();
}

// cityhall permits: inspections.
//
// Routes:
//   GET  /permits/inspections?limit=&offset=   a resident's own; staff see all
//   POST /permits/inspections {permitId, requestedOn}
//
// Only an approved permit can be inspected. The city promises the visit on the
// third business day after the request (src/contracts/time.ts).

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addBusinessDays } from "../contracts/time.ts";
import { date, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import { findPermit } from "./applications.ts";

export const INSPECTION_BUSINESS_DAYS = 3;

export interface Inspection {
  id: string;
  permitId: string;
  ownerId: string;
  requestedOn: string;
  scheduledFor: string;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const inspections = store.table<Inspection>("permitInspections");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    const visible = isStaff(user) ? inspections : inspections.filter((i) => i.ownerId === user.id);
    return json(pageOf(visible, page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const requestedOn = date(body.requestedOn);
    if (!requestedOn) {
      return problem(400, "requestedOn must be a date");
    }
    const permit = findPermit(store, body.permitId, user);
    if (!permit) return notFound("permit not found");
    if (permit.status !== "approved") {
      return problem(409, "only an approved permit can be inspected");
    }
    const inspection: Inspection = {
      id: store.nextId("insp"),
      permitId: permit.id,
      ownerId: permit.ownerId,
      requestedOn,
      scheduledFor: addBusinessDays(requestedOn, INSPECTION_BUSINESS_DAYS),
    };
    inspections.push(inspection);
    return json(inspection, 201);
  }
  return notFound();
}

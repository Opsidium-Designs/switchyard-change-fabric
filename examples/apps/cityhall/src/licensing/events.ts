// cityhall licensing: special event permits.
//
// Routes:
//   GET  /licensing/events?limit=&offset=   a resident's own; staff see all
//   POST /licensing/events {name, eventDate, attendance, filedOn}
//
// An application must be filed at least 10 business days before the event:
// the 10th business day after filedOn may not fall after eventDate. Expected
// attendance is a whole number 1 to 20000; above 500 the event needs a staff
// review, otherwise it is approved on filing.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addBusinessDays } from "../contracts/time.ts";
import { date, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const NOTICE_BUSINESS_DAYS = 10;
export const REVIEW_ABOVE = 500;

export interface EventPermit {
  id: string;
  ownerId: string;
  name: string;
  eventDate: string;
  attendance: number;
  filedOn: string;
  status: "approved" | "review";
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const events = store.table<EventPermit>("eventPermits");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? events : events.filter((e) => e.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const name = text(body.name, 120);
    const eventDate = date(body.eventDate);
    const filedOn = date(body.filedOn);
    const attendance = Number(body.attendance);
    if (!name || !eventDate || !filedOn) {
      return problem(400, "name, eventDate, filedOn, and attendance 1 to 20000 are required");
    }
    if (addBusinessDays(filedOn, NOTICE_BUSINESS_DAYS) > eventDate) {
      return problem(422, `file at least ${NOTICE_BUSINESS_DAYS} business days before the event`);
    }
    const permit: EventPermit = { id: store.nextId("evt"), ownerId: user.id, name, eventDate, attendance, filedOn, status: attendance > REVIEW_ABOVE ? "review" : "approved" };
    events.push(permit);
    return json(permit, 201);
  }
  return notFound();
}

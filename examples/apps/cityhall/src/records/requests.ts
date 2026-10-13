// cityhall records: public records requests.
//
// Routes:
//   GET  /records/requests?limit=&offset=   a resident's own; staff see all
//   POST /records/requests {subject, receivedAt}
//   GET  /records/requests/:id               the requester or staff
//   POST /records/requests/:id/close         staff only
//
// A request is received on the CITY's calendar date of receivedAt, and the
// city must answer by the 10th business day after that date.

import { isStaff, requireStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addBusinessDays } from "../contracts/time.ts";
import { instant, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const RESPONSE_BUSINESS_DAYS = 10;

export interface RecordsRequest {
  id: string;
  requesterId: string;
  subject: string;
  receivedOn: string;
  dueOn: string;
  status: "open" | "closed";
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const requests = store.table<RecordsRequest>("recordsRequests");
  if (rest.length === 2 && rest[1] === "close" && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const found = requests.find((r) => r.id === rest[0]);
    if (!found) return notFound("request not found");
    found.status = "closed";
    return json(found);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(requests, page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const subject = text(body.subject, 300);
    const receivedAt = instant(body.receivedAt);
    if (!subject || !receivedAt) {
      return problem(400, "subject and receivedAt are required");
    }
    const receivedOn = new Date(receivedAt).toISOString().slice(0, 10);
    const created: RecordsRequest = {
      id: store.nextId("rr"),
      requesterId: user.id,
      subject,
      receivedOn,
      dueOn: addBusinessDays(receivedOn, RESPONSE_BUSINESS_DAYS),
      status: "open",
    };
    requests.push(created);
    return json(created, 201);
  }
  if (rest.length === 1 && request.method === "GET") {
    const found = requests.find((r) => r.id === rest[0] && (isStaff(user) || r.requesterId === user.id));
    return found ? json(found) : notFound("request not found");
  }
  return notFound();
}

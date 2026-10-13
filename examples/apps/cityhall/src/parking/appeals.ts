// cityhall parking: citation appeals.
//
// Routes:
//   GET  /parking/appeals?limit=&offset=    a resident's own; staff see all
//   POST /parking/appeals {citationId, reason, filedOn}   the cited resident
//   POST /parking/appeals/:id/decision {decision}         staff only
//
// An appeal must be filed within 21 business days after the citation's issue
// date (the 21st business day is the last day). A citation has at most one
// appeal. A granted appeal dismisses the citation.

import { isStaff, requireStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addBusinessDays } from "../contracts/time.ts";
import { choice, date, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import { findCitation, type Citation } from "./citations.ts";

export const APPEAL_BUSINESS_DAYS = 21;

export interface Appeal {
  id: string;
  citationId: string;
  residentId: string;
  reason: string;
  filedOn: string;
  status: "pending" | "granted" | "denied";
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const appeals = store.table<Appeal>("parkingAppeals");
  if (rest.length === 2 && rest[1] === "decision" && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const appeal = appeals.find((a) => a.id === rest[0]);
    if (!appeal) return notFound("appeal not found");
    const body = await readBody(request);
    const decision = choice(body.decision, ["granted", "denied"] as const);
    if (!decision) return problem(400, "decision must be granted or denied");
    if (appeal.status !== "pending") return problem(409, "appeal already decided");
    appeal.status = decision;
    const citation = findCitation(store, appeal.citationId, staff);
    if (citation && decision === "granted") {
      citation.status = "dismissed";
    }
    return json(appeal);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? appeals : appeals.filter((a) => a.residentId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const reason = text(body.reason, 1000);
    const filedOn = date(body.filedOn);
    if (!reason || !filedOn) {
      return problem(400, "reason and filedOn are required");
    }
    const citation = store.table<Citation>("citations").find((c) => c.id === body.citationId);
    if (!citation) return notFound("citation not found");
    if (filedOn > addBusinessDays(citation.issuedOn, APPEAL_BUSINESS_DAYS)) {
      return problem(422, `appeals close ${APPEAL_BUSINESS_DAYS} business days after the citation`);
    }
    const appeal: Appeal = { id: store.nextId("apl"), citationId: citation.id, residentId: citation.residentId, reason, filedOn, status: "pending" };
    appeals.push(appeal);
    return json(appeal, 201);
  }
  return notFound();
}

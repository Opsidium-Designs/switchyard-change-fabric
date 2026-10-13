// cityhall records: retention schedule, legal holds, and destruction.
//
// Routes (staff only):
//   GET  /records/retention/schedule?recordClass=&createdOn=   when a record may be destroyed
//   GET  /records/retention/holds?limit=&offset=               the legal holds
//   POST /records/retention/holds {recordId, reason}           place a hold
//   POST /records/retention/destructions {recordId, recordClass, createdOn, destroyOn}
//
// A record may be destroyed on or after createdOn plus its class's retention
// years; a date past the end of the target month clamps to its last day (a
// record created 2024-02-29 with 2 years is destroyable on 2026-02-28). A
// record under a legal hold may never be destroyed (409).

import { requireStaff } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addMonths } from "../contracts/time.ts";
import { choice, date, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const RETENTION_YEARS = { permits: 7, licenses: 5, correspondence: 2, payroll: 10 } as const;
export type RecordClass = keyof typeof RETENTION_YEARS;
const CLASSES = Object.keys(RETENTION_YEARS) as RecordClass[];

export interface Hold {
  id: string;
  recordId: string;
  reason: string;
}

export interface Destruction {
  id: string;
  recordId: string;
  destroyOn: string;
}

/** The first date a record of this class may be destroyed. */
export function destroyAfter(recordClass: RecordClass, createdOn: string): string {
  return addMonths(createdOn, RETENTION_YEARS[recordClass] * 12);
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const holds = store.table<Hold>("retentionHolds");
  const staff = requireStaff(request);
  if (staff instanceof Response) return staff;
  if (rest.length === 1 && rest[0] === "schedule" && request.method === "GET") {
    const recordClass = choice(url.searchParams.get("recordClass"), CLASSES);
    const createdOn = date(url.searchParams.get("createdOn"));
    if (!recordClass || !createdOn) {
      return problem(400, `recordClass (${CLASSES.join(", ")}) and createdOn are required`);
    }
    return json({ recordClass, createdOn, years: RETENTION_YEARS[recordClass], destroyAfter: destroyAfter(recordClass, createdOn) });
  }
  if (rest.length === 1 && rest[0] === "holds" && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(holds, page));
  }
  if (rest.length === 1 && rest[0] === "holds" && request.method === "POST") {
    const body = await readBody(request);
    const recordId = text(body.recordId, 60);
    const reason = text(body.reason, 500);
    if (!recordId || !reason) return problem(400, "recordId and reason are required");
    const hold: Hold = { id: store.nextId("hold"), recordId, reason };
    holds.push(hold);
    return json(hold, 201);
  }
  if (rest.length === 1 && rest[0] === "destructions" && request.method === "POST") {
    const body = await readBody(request);
    const recordId = text(body.recordId, 60);
    const recordClass = choice(body.recordClass, CLASSES);
    const createdOn = date(body.createdOn);
    const destroyOn = date(body.destroyOn);
    if (!recordId || !recordClass || !createdOn || !destroyOn) {
      return problem(400, "recordId, recordClass, createdOn, and destroyOn are required");
    }
    if (holds.some((h) => h.recordId === recordId)) {
      return problem(409, "record is under a legal hold");
    }
    if (destroyOn < destroyAfter(recordClass, createdOn)) {
      return problem(422, "record is still inside its retention period");
    }
    const destruction: Destruction = { id: store.nextId("des"), recordId, destroyOn };
    store.table<Destruction>("destructions").push(destruction);
    return json(destruction, 201);
  }
  return notFound();
}

// cityhall parking: citations.
//
// Routes:
//   GET  /parking/citations?limit=&offset=   a resident's own; staff see all
//   POST /parking/citations {residentId, plate, violation, issuedAt}   staff only
//   GET  /parking/citations/:id
//   POST /parking/citations/:id/plan {installments}   split the fine (2 to 6 parts)
//   POST /parking/citations/:id/pay                   pay the fine through utilities autopay
//
// A citation is issued on the CITY's calendar date of issuedAt and is due 30
// calendar days later. A payment plan splits the fine into equal parts that add
// up to it exactly.

import { isStaff, requireStaff, requireUser, type Principal } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { allocate } from "../contracts/money.ts";
import { addDays, cityDate } from "../contracts/time.ts";
import { choice, instant, intIn, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx, Store } from "../store.ts";
import { charge } from "../utilities/autopay.ts";

export const FINE_CENTS = { "expired-meter": 4500, "street-cleaning": 6500, "no-permit": 7700, hydrant: 25000 } as const;
export type Violation = keyof typeof FINE_CENTS;
const VIOLATIONS = Object.keys(FINE_CENTS) as Violation[];

export interface Citation {
  id: string;
  residentId: string;
  plate: string;
  violation: Violation;
  fineCents: number;
  issuedOn: string;
  dueOn: string;
  status: "open" | "paid" | "dismissed";
  plan: number[] | null;
}

/** The citation `id` when `user` may see it (the cited resident or staff). */
export function findCitation(store: Store, id: unknown, user: Principal): Citation | undefined {
  const citation = store.table<Citation>("citations").find((c) => c.id === id);
  return citation && (isStaff(user) || citation.residentId === user.id) ? citation : undefined;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const citations = store.table<Citation>("citations");
  if (rest.length === 0 && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const body = await readBody(request);
    const residentId = text(body.residentId, 40);
    const plate = text(body.plate, 12);
    const violation = choice(body.violation, VIOLATIONS);
    const issuedAt = instant(body.issuedAt);
    if (!residentId || !plate || !violation || !issuedAt) {
      return problem(400, "residentId, plate, violation, and issuedAt are required");
    }
    const issuedOn = cityDate(issuedAt);
    const citation: Citation = {
      id: store.nextId("cit"),
      residentId,
      plate: plate.toUpperCase(),
      violation,
      fineCents: FINE_CENTS[violation],
      issuedOn,
      dueOn: addDays(issuedOn, 30),
      status: "open",
      plan: null,
    };
    citations.push(citation);
    return json(citation, 201);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? citations : citations.filter((c) => c.residentId === user.id), page));
  }
  const citation = findCitation(store, rest[0], user);
  if (!citation) return notFound("citation not found");
  if (rest.length === 1 && request.method === "GET") {
    return json(citation);
  }
  if (rest.length === 2 && rest[1] === "plan" && request.method === "POST") {
    const body = await readBody(request);
    const parts = intIn(body.installments, 2, 6);
    if (parts === null) {
      return problem(400, "installments must be 2 to 6");
    }
    if (citation.status !== "open") {
      return problem(409, "citation is not open");
    }
    citation.plan = allocate(citation.fineCents, new Array<number>(parts).fill(1));
    return json(citation);
  }
  if (rest.length === 2 && rest[1] === "pay" && request.method === "POST") {
    if (citation.status !== "open") {
      return problem(409, "citation is not open");
    }
    const result = charge(store, citation.residentId, citation.fineCents, `citation ${citation.id}`);
    if (!result.ok) {
      return problem(409, result.reason);
    }
    citation.status = "paid";
    return json(citation);
  }
  return notFound();
}

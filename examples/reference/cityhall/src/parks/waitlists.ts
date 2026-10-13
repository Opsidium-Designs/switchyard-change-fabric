// cityhall parks: program waitlists.
//
// Routes:
//   GET  /parks/waitlists?limit=&offset=   a resident's own entries; staff see all
//   POST /parks/waitlists {programId}      join a program's waitlist
//   POST /parks/waitlists/:id/offer {offeredOn}   staff only: offer the spot
//
// A resident holds at most one entry per program (409 on a second). Positions
// count from 1 in joining order. An offered spot is held until the end of the
// 2nd business day after the offer.

import { isStaff, requireStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addBusinessDays } from "../contracts/time.ts";
import { date, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import { findProgram } from "./programs.ts";

export const OFFER_BUSINESS_DAYS = 2;

export interface WaitlistEntry {
  id: string;
  programId: string;
  residentId: string;
  position: number;
  status: "waiting" | "offered";
  offerExpiresOn: string | null;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const entries = store.table<WaitlistEntry>("waitlist");
  if (rest.length === 2 && rest[1] === "offer" && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const entry = entries.find((e) => e.id === rest[0]);
    if (!entry) return notFound("waitlist entry not found");
    const body = await readBody(request);
    const offeredOn = date(body.offeredOn);
    if (!offeredOn) return problem(400, "offeredOn must be a date");
    entry.status = "offered";
    entry.offerExpiresOn = addBusinessDays(offeredOn, OFFER_BUSINESS_DAYS);
    return json(entry);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? entries : entries.filter((e) => e.residentId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const program = findProgram(store, body.programId);
    if (!program) return notFound("program not found");
    if (entries.some((e) => e.programId === program.id && e.residentId === user.id)) {
      return problem(409, "already on this waitlist");
    }
    const entry: WaitlistEntry = {
      id: store.nextId("wait"),
      programId: program.id,
      residentId: user.id,
      position: entries.filter((e) => e.programId === program.id).length + 1,
      status: "waiting",
      offerExpiresOn: null,
    };
    entries.push(entry);
    return json(entry, 201);
  }
  return notFound();
}

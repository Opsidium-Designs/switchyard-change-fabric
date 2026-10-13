// cityhall parks: facility reservations.
//
// Routes:
//   GET    /parks/reservations?limit=&offset=   a resident's own; staff see all
//   POST   /parks/reservations {facility, date, hours, coRenters}
//   DELETE /parks/reservations/:id              cancel (the renter or staff)
//
// A facility is booked by the day: a second ACTIVE reservation for the same
// facility and date is 409. The cost is the facility's hourly rate times 1 to
// 8 hours, split equally between the renter and up to 5 co-renters with every
// cent accounted for (the shares add up to the cost exactly).

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { choice, date, intIn, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const HOURLY_CENTS = { "pavilion-a": 3500, "pavilion-b": 2750, "field-1": 4000, gym: 6000 } as const;
export type Facility = keyof typeof HOURLY_CENTS;
const FACILITIES = Object.keys(HOURLY_CENTS) as Facility[];

export interface Reservation {
  id: string;
  ownerId: string;
  facility: Facility;
  date: string;
  hours: number;
  costCents: number;
  shares: { renter: string; shareCents: number }[];
  status: "active" | "cancelled";
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const reservations = store.table<Reservation>("reservations");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? reservations : reservations.filter((r) => r.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const facility = choice(body.facility, FACILITIES);
    const day = date(body.date);
    const hours = intIn(body.hours, 1, 8);
    const coRenters = Array.isArray(body.coRenters ?? []) ? ((body.coRenters ?? []) as unknown[]).map((r) => text(r, 60)) : [null];
    if (!facility || !day || hours === null || coRenters.length > 5 || coRenters.some((r) => r === null)) {
      return problem(400, "facility, date, hours 1 to 8, and at most 5 named coRenters are required");
    }
    const costCents = HOURLY_CENTS[facility] * hours;
    const renters = [user.id, ...(coRenters as string[])];
    const split = renters.map(() => Math.round(costCents / renters.length));
    const reservation: Reservation = {
      id: store.nextId("res"),
      ownerId: user.id,
      facility,
      date: day,
      hours,
      costCents,
      shares: renters.map((renter, i) => ({ renter, shareCents: split[i]! })),
      status: "active",
    };
    reservations.push(reservation);
    return json(reservation, 201);
  }
  if (rest.length === 1 && request.method === "DELETE") {
    const reservation = reservations.find((r) => r.id === rest[0] && (isStaff(user) || r.ownerId === user.id));
    if (!reservation) return notFound("reservation not found");
    reservation.status = "cancelled";
    return json(reservation);
  }
  return notFound();
}

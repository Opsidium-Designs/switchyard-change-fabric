// cityhall parking: residential parking permits.
//
// Routes:
//   GET  /parking/permits?limit=&offset=     a resident's own; staff see all
//   POST /parking/permits {zone, plate, months}
//
// A plate is stored in its canonical form: upper case, spaces and dashes
// removed, 2 to 8 letters and digits ("abc 123" is "ABC123"). One plate holds at
// most one permit per zone. The price is the zone's monthly rate times 1 to 12
// months.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { choice, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const MONTHLY_CENTS = { A: 2500, B: 1800, C: 1200 } as const;
export type Zone = keyof typeof MONTHLY_CENTS;
const ZONES = Object.keys(MONTHLY_CENTS) as Zone[];

export interface ParkingPermit {
  id: string;
  ownerId: string;
  zone: Zone;
  plate: string;
  months: number;
  priceCents: number;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const permits = store.table<ParkingPermit>("parkingPermits");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? permits : permits.filter((p) => p.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const zone = choice(body.zone, ZONES);
    const plate = text(body.plate, 12);
    const months = typeof body.months === "number" ? body.months : null;
    if (!zone || !plate || months === null) {
      return problem(400, "zone (A, B, C), a plate, and months 1 to 12 are required");
    }
    if (permits.some((p) => p.zone === zone && p.plate === plate)) {
      return problem(409, "that plate already has a permit in this zone");
    }
    const permit: ParkingPermit = { id: store.nextId("pp"), ownerId: user.id, zone, plate, months, priceCents: MONTHLY_CENTS[zone] * months };
    permits.push(permit);
    return json(permit, 201);
  }
  return notFound();
}

// cityhall parking: meters.
//
// Routes:
//   GET  /parking/meters?limit=&offset=         public: the city's meters
//   GET  /parking/meters/:id/quote?minutes=     public: the price of a stay
//   POST /parking/meters/:id/sessions {minutes, plate}   start a paid session
//
// Meters bill in 15-minute blocks: any started block is a whole block. A stay
// is 1 minute up to the meter's maximum.

import { requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { intIn, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const BLOCK_MINUTES = 15;

export interface Meter {
  id: string;
  street: string;
  rate15Cents: number;
  maxMinutes: number;
}

export interface MeterSession {
  id: string;
  meterId: string;
  ownerId: string;
  plate: string;
  minutes: number;
  costCents: number;
}

function quote(meter: Meter, minutes: unknown): number | null {
  const stay = intIn(minutes, 1, Number.MAX_SAFE_INTEGER);
  return stay === null ? null : Math.floor(stay / BLOCK_MINUTES) * meter.rate15Cents;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const meters = store.table<Meter>("parkingMeters");
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(meters, page));
  }
  const meter = meters.find((m) => m.id === rest[0]);
  if (!meter) return notFound("meter not found");
  if (rest.length === 2 && rest[1] === "quote" && request.method === "GET") {
    const raw = url.searchParams.get("minutes");
    const costCents = quote(meter, raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN);
    if (costCents === null) {
      return problem(400, `minutes must be 1 to ${meter.maxMinutes}`);
    }
    return json({ meterId: meter.id, minutes: Number(raw), costCents });
  }
  if (rest.length === 2 && rest[1] === "sessions" && request.method === "POST") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const body = await readBody(request);
    const plate = text(body.plate, 12);
    const costCents = quote(meter, body.minutes);
    if (!plate || costCents === null) {
      return problem(400, `a plate and minutes 1 to ${meter.maxMinutes} are required`);
    }
    const session: MeterSession = { id: store.nextId("ses"), meterId: meter.id, ownerId: user.id, plate, minutes: body.minutes as number, costCents };
    store.table<MeterSession>("meterSessions").push(session);
    return json(session, 201);
  }
  return notFound();
}

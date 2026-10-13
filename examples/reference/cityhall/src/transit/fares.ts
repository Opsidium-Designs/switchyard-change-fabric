// cityhall transit: fares (public).
//
// Routes:
//   GET /transit/fares?limit=&offset=          the fare table, every rider x zones
//   GET /transit/fares/quote?zones=&rider=     one fare
//
// A trip crosses 1 to 4 zones. An adult fare is 225 cents plus 50 for each
// zone after the first; a reduced fare is half the adult fare rounded to the
// nearest cent with a half cent up; a youth fare is a flat 100 cents.

import { json, notFound, problem } from "../contracts/http.ts";
import { percentOf } from "../contracts/money.ts";
import { choice, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const RIDERS = ["adult", "reduced", "youth"] as const;
export type Rider = (typeof RIDERS)[number];
export const MAX_ZONES = 4;

/** The fare in cents for a rider over 1 to 4 zones. */
export function fare(rider: Rider, zones: number): number {
  const adult = 225 + 50 * (zones - 1);
  if (rider === "reduced") return percentOf(adult, 5000);
  if (rider === "youth") return 100;
  return adult;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { url, rest } = ctx;
  if (request.method !== "GET") {
    return notFound();
  }
  if (rest.length === 0) {
    const page = readPage(url);
    if (page instanceof Response) return page;
    const table = RIDERS.flatMap((rider) => [1, 2, 3, 4].map((zones) => ({ rider, zones, fareCents: fare(rider, zones) })));
    return json(pageOf(table, page));
  }
  if (rest.length === 1 && rest[0] === "quote") {
    const rawZones = url.searchParams.get("zones") ?? "";
    const zones = /^\d+$/.test(rawZones) ? Number(rawZones) : NaN;
    const rider = choice(url.searchParams.get("rider") ?? "adult", RIDERS);
    if (!rider || !(zones >= 1 && zones <= MAX_ZONES)) {
      return problem(400, `zones must be 1 to ${MAX_ZONES} and rider one of ${RIDERS.join(", ")}`);
    }
    return json({ rider, zones, fareCents: fare(rider, zones) });
  }
  return notFound();
}

// cityhall utilities: daily water usage.
//
// Routes:
//   GET /utilities/usage/:accountId?from=&to=&limit=&offset=
//       the account's meter readings summed per CITY calendar day, oldest
//       first, optionally between from and to (both dates included). Only the
//       account's owner or staff may read it.
//
// A reading at 22:30 in the city on March 1 belongs to March 1, whatever the
// UTC date of that instant is.

import { requireUser } from "../contracts/auth.ts";
import { json, notFound, problem } from "../contracts/http.ts";
import { date, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

interface Account {
  id: string;
  ownerId: string;
}

export interface MeterReading {
  accountId: string;
  at: string;
  gallons: number;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length !== 1 || request.method !== "GET") {
    return notFound();
  }
  const account = store.table<Account>("utilityAccounts").find((a) => a.id === rest[0]);
  if (!account) {
    return notFound("account not found");
  }
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const from = rawFrom === null ? "0000-01-01" : date(rawFrom);
  const to = rawTo === null ? "9999-12-31" : date(rawTo);
  if (!from || !to) {
    return problem(400, "from and to must be dates");
  }
  const page = readPage(url);
  if (page instanceof Response) return page;
  const perDay = new Map<string, number>();
  for (const reading of store.table<MeterReading>("meterReadings")) {
    if (reading.accountId !== account.id) continue;
    const day = new Date(reading.at).toISOString().slice(0, 10);
    if (day < from || day > to) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + reading.gallons);
  }
  const days = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, gallons]) => ({ date: day, gallons }));
  const totalGallons = days.reduce((s, d) => s + d.gallons, 0);
  return json({ accountId: account.id, totalGallons, ...pageOf(days, page) });
}

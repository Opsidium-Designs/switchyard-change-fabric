// cityhall utilities: water bills.
//
// Routes:
//   GET  /utilities/water?limit=&offset=     bills on the caller's accounts; staff see all
//   POST /utilities/water {accountId, period, gallons}   staff only
//   GET  /utilities/water/:id
//   POST /utilities/water/:id/split {unitGallons}       staff only: split a building bill
//
// Water is billed per started 100 gallons (a "unit"): the first 50 units at
// 120 cents, every unit after that at 185 cents. A building's bill splits
// across its units in proportion to each unit's gallons, adding up to the bill
// exactly.

import { isStaff, requireStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { intIn, month, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const GALLONS_PER_UNIT = 100;
export const TIER1_UNITS = 50;
export const TIER1_CENTS = 120;
export const TIER2_CENTS = 185;

interface Account {
  id: string;
  ownerId: string;
}

export interface WaterBill {
  id: string;
  accountId: string;
  ownerId: string;
  period: string;
  gallons: number;
  units: number;
  amountCents: number;
  split: number[] | null;
}

/** The bill amount for a period's gallons. */
export function waterCharge(gallons: number): { units: number; amountCents: number } {
  const units = Math.floor(gallons / GALLONS_PER_UNIT);
  const tier1 = Math.min(units, TIER1_UNITS);
  return { units, amountCents: tier1 * TIER1_CENTS + (units - tier1) * TIER2_CENTS };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const bills = store.table<WaterBill>("waterBills");
  if (rest.length === 0 && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const body = await readBody(request);
    const account = store.table<Account>("utilityAccounts").find((a) => a.id === body.accountId);
    const period = month(body.period);
    const gallons = intIn(body.gallons, 0, 10_000_000);
    if (!account || !period || gallons === null) {
      return problem(400, "a known accountId, a period YYYY-MM, and whole gallons are required");
    }
    const bill: WaterBill = { id: store.nextId("wb"), accountId: account.id, ownerId: account.ownerId, period, gallons, ...waterCharge(gallons), split: null };
    bills.push(bill);
    return json(bill, 201);
  }
  if (rest.length === 2 && rest[1] === "split" && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const bill = bills.find((b) => b.id === rest[0]);
    if (!bill) return notFound("bill not found");
    const body = await readBody(request);
    const unitGallons = Array.isArray(body.unitGallons) ? body.unitGallons.map((g) => intIn(g, 1, 10_000_000)) : [];
    if (unitGallons.length < 2 || unitGallons.length > 20 || unitGallons.some((g) => g === null)) {
      return problem(400, "unitGallons must list 2 to 20 positive whole gallons");
    }
    const totalGallons = (unitGallons as number[]).reduce((s, g) => s + g, 0);
    bill.split = (unitGallons as number[]).map((g) => Math.round((bill.amountCents * g) / totalGallons));
    return json(bill);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? bills : bills.filter((b) => b.ownerId === user.id), page));
  }
  if (rest.length === 1 && request.method === "GET") {
    const bill = bills.find((b) => b.id === rest[0] && (isStaff(user) || b.ownerId === user.id));
    return bill ? json(bill) : notFound("bill not found");
  }
  return notFound();
}

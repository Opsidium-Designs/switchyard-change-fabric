// cityhall licensing: street vendor licenses.
//
// Routes:
//   GET  /licensing/vendors?limit=&offset=   a resident's own; staff see all
//   POST /licensing/vendors {businessName, zone, startsOn, months}
//
// A license runs for 1 to 12 whole months and expires the day BEFORE the same
// date that many months later (starting 2026-04-01 for 3 months expires
// 2026-06-30). It costs 3000 cents per month. Both routes need a signed-in
// caller.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { addDays, addMonths } from "../contracts/time.ts";
import { choice, date, intIn, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const VENDOR_ZONES = ["downtown", "parks", "market"] as const;
export const MONTHLY_FEE_CENTS = 3000;

export interface VendorLicense {
  id: string;
  ownerId: string;
  businessName: string;
  zone: (typeof VENDOR_ZONES)[number];
  startsOn: string;
  months: number;
  expiresOn: string;
  feeCents: number;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const vendors = store.table<VendorLicense>("vendorLicenses");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? vendors : vendors.filter((v) => v.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const businessName = text(body.businessName, 120);
    const zone = choice(body.zone, VENDOR_ZONES);
    const startsOn = date(body.startsOn);
    const months = intIn(body.months, 1, 12);
    if (!businessName || !zone || !startsOn || months === null) {
      return problem(400, "businessName, zone, startsOn, and months 1 to 12 are required");
    }
    const license: VendorLicense = {
      id: store.nextId("ven"),
      ownerId: user.id,
      businessName,
      zone,
      startsOn,
      months,
      expiresOn: addDays(addMonths(startsOn, months), -1),
      feeCents: MONTHLY_FEE_CENTS * months,
    };
    vendors.push(license);
    return json(license, 201);
  }
  return notFound();
}

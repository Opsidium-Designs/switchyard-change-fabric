// cityhall licensing: business licenses.
//
// Routes:
//   GET  /licensing/business?limit=&offset=   a resident's own; staff see all
//   POST /licensing/business {name, category}
//   POST /licensing/business/:id/approve      staff only
//
// A business name is required (non-blank, at most 120 characters) and unique
// across the city ignoring case and surrounding spaces. The fee depends on the
// category.

import { isStaff, requireStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { choice, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const CATEGORY_FEE_CENTS = { food: 15000, retail: 8000, services: 6000, contractor: 12000 } as const;
export type Category = keyof typeof CATEGORY_FEE_CENTS;
const CATEGORIES = Object.keys(CATEGORY_FEE_CENTS) as Category[];

export interface BusinessLicense {
  id: string;
  ownerId: string;
  name: string;
  category: Category;
  feeCents: number;
  status: "pending" | "approved";
  licenseNumber: string | null;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const licenses = store.table<BusinessLicense>("businessLicenses");
  if (rest.length === 2 && rest[1] === "approve" && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const license = licenses.find((l) => l.id === rest[0]);
    if (!license) return notFound("license not found");
    if (license.status === "approved") return problem(409, "already approved");
    license.status = "approved";
    license.licenseNumber = `BL-${String(licenses.filter((l) => l.status === "approved").length).padStart(4, "0")}`;
    return json(license);
  }
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? licenses : licenses.filter((l) => l.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const name = text(body.name, 120);
    const category = choice(body.category, CATEGORIES);
    if (!name || !category) {
      return problem(400, `a name and a category (${CATEGORIES.join(", ")}) are required`);
    }
    if (licenses.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      return problem(409, "a business with that name is already licensed");
    }
    const license: BusinessLicense = { id: store.nextId("biz"), ownerId: user.id, name, category, feeCents: CATEGORY_FEE_CENTS[category], status: "pending", licenseNumber: null };
    licenses.push(license);
    return json(license, 201);
  }
  return notFound();
}

// cityhall housing: relocation aid.
//
// Routes (staff only):
//   GET  /housing/relocation?limit=&offset=
//   POST /housing/relocation {unitId, totalAidCents, members}
//   GET  /housing/relocation/:id
//
// When a unit is condemned the city grants the household a total aid amount,
// split across its 1 to 12 members in proportion to each member's weight (a
// whole number 1 to 10). The shares add up to the total exactly.

import { requireStaff } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { allocate } from "../contracts/money.ts";
import { intIn, pageOf, positiveCents, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";
import type { Unit } from "./inspections.ts";

export interface RelocationGrant {
  id: string;
  unitId: string;
  totalAidCents: number;
  shares: { name: string; weight: number; shareCents: number }[];
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const grants = store.table<RelocationGrant>("relocationGrants");
  const staff = requireStaff(request);
  if (staff instanceof Response) return staff;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(grants, page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const totalAidCents = positiveCents(body.totalAidCents);
    const raw = Array.isArray(body.members) ? (body.members as unknown[]) : [];
    const members = raw.map((m) => {
      const member = (m ?? {}) as Record<string, unknown>;
      return { name: text(member.name, 80), weight: intIn(member.weight, 1, 10) };
    });
    if (totalAidCents === null || members.length < 1 || members.length > 12 || members.some((m) => !m.name || m.weight === null)) {
      return problem(400, "totalAidCents and 1 to 12 members with a name and a weight 1 to 10 are required");
    }
    const unit = store.table<Unit>("housingUnits").find((u) => u.id === body.unitId);
    if (!unit) return notFound("unit not found");
    const split = allocate(totalAidCents, members.map((m) => m.weight!));
    const grant: RelocationGrant = {
      id: store.nextId("rel"),
      unitId: unit.id,
      totalAidCents,
      shares: members.map((m, i) => ({ name: m.name!, weight: m.weight!, shareCents: split[i]! })),
    };
    grants.push(grant);
    return json(grant, 201);
  }
  if (rest.length === 1 && request.method === "GET") {
    const grant = grants.find((g) => g.id === rest[0]);
    return grant ? json(grant) : notFound("grant not found");
  }
  return notFound();
}

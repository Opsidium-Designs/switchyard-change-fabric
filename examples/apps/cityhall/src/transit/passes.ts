// cityhall transit: monthly passes.
//
// Routes:
//   GET  /transit/passes?limit=&offset=   a resident's own; staff see all
//   POST /transit/passes {kind, month}    buy an adult or reduced pass for a month "YYYY-MM"
//   GET  /transit/passes/:id
//
// An adult pass is 9000 cents and a reduced pass 4500. Only a resident with an
// APPROVED reduced-fare eligibility (transit/eligibility) may buy a reduced
// pass; anyone else gets 409.

import { isStaff, requireUser, type Principal } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { choice, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx, Store } from "../store.ts";
import type { Eligibility } from "./eligibility.ts";

export const PASS_CENTS = { adult: 9000, reduced: 4500 } as const;
export type PassKind = keyof typeof PASS_CENTS;

export interface Pass {
  id: string;
  ownerId: string;
  kind: PassKind;
  month: string;
  priceCents: number;
}

/** The pass `id` when `user` may see it (its holder or staff). */
export function findPass(store: Store, id: unknown, user: Principal): Pass | undefined {
  const pass = store.table<Pass>("passes").find((p) => p.id === id);
  return pass && (isStaff(user) || pass.ownerId === user.id) ? pass : undefined;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const passes = store.table<Pass>("passes");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? passes : passes.filter((p) => p.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const kind = choice(body.kind, ["adult", "reduced"] as const);
    const passMonth = text(body.month, 20);
    if (!kind || !passMonth) {
      return problem(400, "kind (adult or reduced) and month YYYY-MM are required");
    }
    if (kind === "reduced" && !store.table<Eligibility>("eligibility").some((e) => e.residentId === user.id)) {
      return problem(409, "a reduced pass needs an approved reduced-fare eligibility");
    }
    const pass: Pass = { id: store.nextId("pass"), ownerId: user.id, kind, month: passMonth, priceCents: PASS_CENTS[kind] };
    passes.push(pass);
    return json(pass, 201);
  }
  if (rest.length === 1 && request.method === "GET") {
    const pass = findPass(store, rest[0], user);
    return pass ? json(pass) : notFound("pass not found");
  }
  return notFound();
}

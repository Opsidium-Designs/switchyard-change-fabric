// cityhall licensing: pet licenses.
//
// Routes:
//   GET  /licensing/pets?limit=&offset=   a resident's own; staff see all
//   POST /licensing/pets {name, species, spayed}
//
// Dogs and cats only. A spayed or neutered pet pays half the fee, rounded to
// the nearest cent with a half cent up (a 1525 cent cat license is 763 cents).

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const PET_FEE_CENTS = { dog: 2025, cat: 1525 } as const;
export type Species = keyof typeof PET_FEE_CENTS;

export interface PetLicense {
  id: string;
  ownerId: string;
  name: string;
  species: Species;
  spayed: boolean;
  feeCents: number;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const pets = store.table<PetLicense>("petLicenses");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? pets : pets.filter((p) => p.ownerId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const name = text(body.name, 60);
    const species = String(body.species) as Species;
    if (!name || typeof body.spayed !== "boolean") {
      return problem(400, "name, species (dog or cat), and spayed (true or false) are required");
    }
    const fullFee = PET_FEE_CENTS[species];
    const feeCents = body.spayed ? Math.floor(fullFee / 2) : fullFee;
    const pet: PetLicense = { id: store.nextId("pet"), ownerId: user.id, name, species, spayed: body.spayed, feeCents };
    pets.push(pet);
    return json(pet, 201);
  }
  return notFound();
}

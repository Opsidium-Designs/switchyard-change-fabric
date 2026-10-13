// cityhall parks: recreation programs.
//
// Routes:
//   GET  /parks/programs?limit=&offset=                 public: every program
//   POST /parks/programs {name, minAge, maxAge, capacity}   staff only
//   POST /parks/programs/:id/enrollments {participantName, age}
//
// A participant's age must be within the program's range, both ends included
// (a 6 to 12 program takes a 6 year old and a 12 year old). A program never
// enrolls more than its capacity (409 when full).

import { requireStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { intIn, pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx, Store } from "../store.ts";

export interface Program {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
  capacity: number;
  enrolled: number;
}

export interface Enrollment {
  id: string;
  programId: string;
  ownerId: string;
  participantName: string;
  age: number;
}

/** A program by id. */
export function findProgram(store: Store, id: unknown): Program | undefined {
  return store.table<Program>("parkPrograms").find((p) => p.id === id);
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const programs = store.table<Program>("parkPrograms");
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(programs, page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const staff = requireStaff(request);
    if (staff instanceof Response) return staff;
    const body = await readBody(request);
    const name = text(body.name, 120);
    const minAge = intIn(body.minAge, 0, 120);
    const maxAge = intIn(body.maxAge, 0, 120);
    const capacity = intIn(body.capacity, 1, 500);
    if (!name || minAge === null || maxAge === null || capacity === null || minAge > maxAge) {
      return problem(400, "name, minAge <= maxAge (0 to 120), and capacity 1 to 500 are required");
    }
    const program: Program = { id: store.nextId("prog"), name, minAge, maxAge, capacity, enrolled: 0 };
    programs.push(program);
    return json(program, 201);
  }
  if (rest.length === 2 && rest[1] === "enrollments" && request.method === "POST") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const program = findProgram(store, rest[0]);
    if (!program) return notFound("program not found");
    const body = await readBody(request);
    const participantName = text(body.participantName, 80);
    const age = intIn(body.age, 0, 120);
    if (!participantName || age === null) {
      return problem(400, "participantName and age are required");
    }
    if (age < program.minAge || age > program.maxAge) {
      return problem(422, `ages ${program.minAge} to ${program.maxAge} only`);
    }
    if (program.enrolled >= program.capacity) {
      return problem(409, "program is full");
    }
    program.enrolled += 1;
    const enrollment: Enrollment = { id: store.nextId("enr"), programId: program.id, ownerId: user.id, participantName, age };
    store.table<Enrollment>("programEnrollments").push(enrollment);
    return json(enrollment, 201);
  }
  return notFound();
}

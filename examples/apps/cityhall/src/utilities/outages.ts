// cityhall utilities: outage reports.
//
// Routes:
//   GET  /utilities/outages?limit=&offset=          public: every outage, newest first
//   POST /utilities/outages {area, reportedAt}      report an outage in an area
//   POST /utilities/outages/:id/restore {restoredAt}  staff only
//
// An area has at most one OPEN outage: a report in an area with an open outage
// joins it (200, its report count goes up) instead of opening another (201).

import { requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { choice, instant, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

export const AREAS = ["north", "south", "east", "west", "downtown"] as const;

export interface Outage {
  id: string;
  area: (typeof AREAS)[number];
  status: "open" | "restored";
  reports: number;
  firstReportedAt: string;
  restoredAt: string | null;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const outages = store.table<Outage>("outages");
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf([...outages].reverse(), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const body = await readBody(request);
    const area = choice(body.area, AREAS);
    const reportedAt = instant(body.reportedAt);
    if (!area || !reportedAt) {
      return problem(400, `area (${AREAS.join(", ")}) and reportedAt are required`);
    }
    const outage: Outage = { id: store.nextId("out"), area, status: "open", reports: 1, firstReportedAt: reportedAt, restoredAt: null };
    outages.push(outage);
    return json(outage, 201);
  }
  if (rest.length === 2 && rest[1] === "restore" && request.method === "POST") {
    const user = requireUser(request);
    if (user instanceof Response) return user;
    const outage = outages.find((o) => o.id === rest[0]);
    if (!outage) return notFound("outage not found");
    const body = await readBody(request);
    const restoredAt = instant(body.restoredAt);
    if (!restoredAt) return problem(400, "restoredAt is required");
    if (outage.status !== "open") return problem(409, "outage already restored");
    outage.status = "restored";
    outage.restoredAt = restoredAt;
    return json(outage);
  }
  return notFound();
}

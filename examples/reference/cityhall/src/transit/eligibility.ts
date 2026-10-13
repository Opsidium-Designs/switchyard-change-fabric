// cityhall transit: reduced-fare eligibility.
//
// Routes:
//   GET  /transit/eligibility?limit=&offset=   a resident's own; staff see all
//   POST /transit/eligibility {certificateId, appliedOn}
//
// A resident qualifies for reduced fares with their OWN senior or disability
// certificate that is valid on appliedOn (records/certificates decides). Using
// a certificate that is not yours is 404, as if it did not exist; a
// certificate that does not qualify is recorded as denied.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { date, pageOf, readPage } from "../contracts/validate.ts";
import { qualifyingCertificate, type Certificate } from "../records/certificates.ts";
import type { Ctx, Store } from "../store.ts";

export interface Eligibility {
  id: string;
  residentId: string;
  certificateId: string;
  appliedOn: string;
  status: "approved" | "denied";
}

/** True when the resident holds an approved reduced-fare eligibility. */
export function hasApprovedEligibility(store: Store, residentId: string): boolean {
  return store.table<Eligibility>("eligibility").some((e) => e.residentId === residentId && e.status === "approved");
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const records = store.table<Eligibility>("eligibility");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? records : records.filter((e) => e.residentId === user.id), page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const appliedOn = date(body.appliedOn);
    if (!appliedOn) {
      return problem(400, "appliedOn must be a date");
    }
    const cert = store.table<Certificate>("certificates").find((c) => c.id === body.certificateId && c.ownerId === user.id);
    if (!cert) return notFound("certificate not found");
    const approved = qualifyingCertificate(store, cert.id, user.id, appliedOn) !== null;
    const record: Eligibility = { id: store.nextId("elig"), residentId: user.id, certificateId: cert.id, appliedOn, status: approved ? "approved" : "denied" };
    records.push(record);
    return json(record, 201);
  }
  return notFound();
}

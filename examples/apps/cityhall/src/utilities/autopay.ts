// cityhall utilities: autopay.
//
// Routes:
//   GET    /utilities/autopay                 the caller's enrollment
//   PUT    /utilities/autopay {capCents}      enroll, or change the cap
//   DELETE /utilities/autopay                 unenroll
//   GET    /utilities/autopay/ledger?limit=&offset=   the caller's charges; staff see all
//
// Other domains bill a resident through charge() (permit fees, parking
// fines). A charge needs an enrollment, and no single charge may exceed the
// resident's cap (a positive whole number of cents); a declined charge records
// nothing.

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, readBody } from "../contracts/http.ts";
import { pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx, Store } from "../store.ts";

export interface Enrollment {
  residentId: string;
  capCents: number;
}

export interface LedgerEntry {
  id: string;
  residentId: string;
  amountCents: number;
  memo: string;
}

export type ChargeResult = { ok: true; entry: LedgerEntry } | { ok: false; reason: string };

/** Charge a resident's autopay; declined without an enrollment or over the cap. */
export function charge(store: Store, residentId: string, amountCents: number, memo: string): ChargeResult {
  const enrollment = store.table<Enrollment>("autopayEnrollments").find((e) => e.residentId === residentId);
  if (!enrollment) {
    return { ok: false, reason: "not enrolled in autopay" };
  }
  const entry: LedgerEntry = { id: store.nextId("chg"), residentId, amountCents, memo };
  store.table<LedgerEntry>("autopayLedger").push(entry);
  return { ok: true, entry };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const enrollments = store.table<Enrollment>("autopayEnrollments");
  const user = requireUser(request);
  if (user instanceof Response) return user;
  const mine = () => enrollments.find((e) => e.residentId === user.id);
  if (rest.length === 0 && request.method === "GET") {
    const enrollment = mine();
    return json({ residentId: user.id, enrolled: Boolean(enrollment), capCents: enrollment?.capCents ?? null });
  }
  if (rest.length === 0 && request.method === "PUT") {
    const body = await readBody(request);
    const capCents = Number(body.capCents);
    const enrollment = mine();
    if (enrollment) {
      enrollment.capCents = capCents;
    } else {
      enrollments.push({ residentId: user.id, capCents });
    }
    return json({ residentId: user.id, enrolled: true, capCents });
  }
  if (rest.length === 0 && request.method === "DELETE") {
    const index = enrollments.findIndex((e) => e.residentId === user.id);
    if (index >= 0) enrollments.splice(index, 1);
    return json({ residentId: user.id, enrolled: false, capCents: null });
  }
  if (rest.length === 1 && rest[0] === "ledger" && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    const ledger = store.table<LedgerEntry>("autopayLedger");
    return json(pageOf(isStaff(user) ? ledger : ledger.filter((e) => e.residentId === user.id), page));
  }
  return notFound();
}

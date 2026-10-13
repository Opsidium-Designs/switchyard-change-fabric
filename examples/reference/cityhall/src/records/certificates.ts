// cityhall records: certificates and certified copies.
//
// Routes:
//   GET  /records/certificates?limit=&offset=          a resident's own; staff see all
//   GET  /records/certificates/:id                      the holder or staff
//   GET  /records/certificates/orders?limit=&offset=   a resident's own copy orders
//   POST /records/certificates/orders {kind, copies}   order 1 to 10 certified copies
//
// A copy order costs 2500 cents for the first copy and 400 for each extra.
// Other domains ask qualifyingCertificate() whether a resident holds a senior
// or disability certificate that is valid on a date (issuedOn through
// validUntil, both included).

import { isStaff, requireUser } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { choice, intIn, pageOf, readPage } from "../contracts/validate.ts";
import type { Ctx, Store } from "../store.ts";

export const CERTIFICATE_KINDS = ["birth", "residency", "senior", "disability"] as const;
export const QUALIFYING_KINDS: readonly string[] = ["senior", "disability"];
export const FIRST_COPY_CENTS = 2500;
export const EXTRA_COPY_CENTS = 400;

export interface Certificate {
  id: string;
  ownerId: string;
  kind: (typeof CERTIFICATE_KINDS)[number];
  issuedOn: string;
  validUntil: string;
}

export interface CopyOrder {
  id: string;
  ownerId: string;
  kind: (typeof CERTIFICATE_KINDS)[number];
  copies: number;
  feeCents: number;
}

/** The certificate when it is the resident's, of a qualifying kind, and valid on `onDate`. */
export function qualifyingCertificate(store: Store, id: unknown, residentId: string, onDate: string): Certificate | null {
  const cert = store.table<Certificate>("certificates").find((c) => c.id === id);
  if (!cert || cert.ownerId !== residentId || !QUALIFYING_KINDS.includes(cert.kind)) {
    return null;
  }
  return onDate >= cert.issuedOn && onDate <= cert.validUntil ? cert : null;
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const user = requireUser(request);
  if (user instanceof Response) return user;
  const certificates = store.table<Certificate>("certificates");
  const orders = store.table<CopyOrder>("certificateOrders");
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? certificates : certificates.filter((c) => c.ownerId === user.id), page));
  }
  if (rest.length === 1 && rest[0] === "orders" && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(isStaff(user) ? orders : orders.filter((o) => o.ownerId === user.id), page));
  }
  if (rest.length === 1 && rest[0] === "orders" && request.method === "POST") {
    const body = await readBody(request);
    const kind = choice(body.kind, CERTIFICATE_KINDS);
    const copies = intIn(body.copies, 1, 10);
    if (!kind || copies === null) {
      return problem(400, "kind and copies 1 to 10 are required");
    }
    const order: CopyOrder = { id: store.nextId("ord"), ownerId: user.id, kind, copies, feeCents: FIRST_COPY_CENTS + EXTRA_COPY_CENTS * (copies - 1) };
    orders.push(order);
    return json(order, 201);
  }
  if (rest.length === 1 && request.method === "GET") {
    const cert = certificates.find((c) => c.id === rest[0] && (isStaff(user) || c.ownerId === user.id));
    return cert ? json(cert) : notFound("certificate not found");
  }
  return notFound();
}

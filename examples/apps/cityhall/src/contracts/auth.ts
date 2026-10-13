// cityhall SHARED auth contract.
//
// Every caller presents `Authorization: Bearer <token>`. A token maps to a
// principal with one of three roles:
//
//   resident  a member of the public; sees and changes only their own records
//   clerk     city staff; may decide, issue, and see everyone's records
//   admin     city staff with every clerk power
//
// "Staff" means clerk or admin. A module that needs a signed-in caller does:
//
//   const user = requireUser(request);
//   if (user instanceof Response) return user;   // 401
//
// and a staff-only action uses requireStaff (401 without a token, 403 for a
// resident). Ownership ("only your own") is each module's job: a resident
// asking for someone else's record gets 404, as if it did not exist.

import { problem } from "./http.ts";

export type Role = "resident" | "clerk" | "admin";

export interface Principal {
  id: string;
  role: Role;
  name: string;
}

/** The demo tokens (documented in the README; demo data, not secrets). */
export const DEMO_TOKENS = {
  resident: "resident-ana",
  otherResident: "resident-ben",
  clerk: "clerk-token",
  admin: "admin-token",
} as const;

const PRINCIPALS: Readonly<Record<string, Principal>> = {
  "resident-ana": { id: "res-ana", role: "resident", name: "Ana Ruiz" },
  "resident-ben": { id: "res-ben", role: "resident", name: "Ben Okafor" },
  "clerk-token": { id: "clerk-1", role: "clerk", name: "City clerk" },
  "admin-token": { id: "admin-1", role: "admin", name: "City administrator" },
};

/** The principal behind the request's bearer token, or null. */
export function principalOf(request: Request): Principal | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  return Object.hasOwn(PRINCIPALS, token) ? PRINCIPALS[token]! : null;
}

/** True for clerks and admins. */
export function isStaff(user: Principal): boolean {
  return user.role === "clerk" || user.role === "admin";
}

/** The signed-in principal, or a 401 Response. */
export function requireUser(request: Request): Principal | Response {
  const user = principalOf(request);
  return user ?? problem(401, "authentication required");
}

/** A signed-in staff principal, or a 401 (no token) / 403 (resident) Response. */
export function requireStaff(request: Request): Principal | Response {
  const user = principalOf(request);
  if (!user) {
    return problem(401, "authentication required");
  }
  return isStaff(user) ? user : problem(403, "city staff only");
}

// cityhall in-memory store: named tables of records plus the request context
// handed to every route module.
//
// Each route module owns the tables it writes (and declares their record
// types), so two modules never share a write set. A module may READ another
// module's table through that module's exported helpers or types. One Store
// backs one createCityHall() instance, so a test starts from fresh seed data;
// the deployed Worker keeps one instance per isolate (demo data, not durable).

export interface Store {
  /** The records of a named table (created empty on first use). */
  table<T>(name: string): T[];
  /** The next id for a record kind, for example nextId("app") is "app-1". */
  nextId(prefix: string): string;
}

/** What a route module receives besides the request. */
export interface Ctx {
  store: Store;
  url: URL;
  /** The path segments after /<domain>/<module>, for example ["app-1", "decision"]. */
  rest: string[];
}

/** The seed records a fresh city starts with. */
const SEED: Readonly<Record<string, readonly unknown[]>> = {
  permits: [
    { id: "prm-1", ownerId: "res-ana", kind: "deck", address: "14 Birch Ln", valuationCents: 1_850_000, status: "approved", decidedOn: "2025-06-30", expiresOn: "2026-06-30" },
    { id: "prm-2", ownerId: "res-ben", kind: "fence", address: "3 Elm St", valuationCents: 420_000, status: "submitted", decidedOn: null, expiresOn: null },
    { id: "prm-3", ownerId: "res-ana", kind: "roof", address: "14 Birch Ln", valuationCents: 1_234_567, status: "approved", decidedOn: "2025-09-15", expiresOn: "2026-09-15" },
  ],
  utilityAccounts: [
    { id: "acct-ana", ownerId: "res-ana", address: "14 Birch Ln" },
    { id: "acct-ben", ownerId: "res-ben", address: "3 Elm St" },
    { id: "acct-elm", ownerId: "res-ben", address: "12 Elm St (six units)" },
  ],
  meterReadings: [
    { accountId: "acct-ana", at: "2026-03-01T08:00:00-06:00", gallons: 120 },
    { accountId: "acct-ana", at: "2026-03-01T22:30:00-06:00", gallons: 80 },
    { accountId: "acct-ana", at: "2026-03-02T07:00:00-06:00", gallons: 150 },
    { accountId: "acct-ana", at: "2026-03-02T23:15:00-06:00", gallons: 60 },
    { accountId: "acct-ana", at: "2026-03-03T12:00:00-06:00", gallons: 90 },
    { accountId: "acct-ben", at: "2026-03-01T09:00:00-06:00", gallons: 300 },
  ],
  autopayEnrollments: [{ residentId: "res-ana", capCents: 15_000 }],
  parkingMeters: [
    { id: "m-100", street: "Main St", rate15Cents: 75, maxMinutes: 120 },
    { id: "m-200", street: "Harbor Rd", rate15Cents: 50, maxMinutes: 240 },
  ],
  certificates: [
    { id: "cert-ana-senior", ownerId: "res-ana", kind: "senior", issuedOn: "2025-01-01", validUntil: "2026-12-31" },
    { id: "cert-ben-disability", ownerId: "res-ben", kind: "disability", issuedOn: "2025-04-01", validUntil: "2026-03-31" },
    { id: "cert-ben-residency", ownerId: "res-ben", kind: "residency", issuedOn: "2025-02-01", validUntil: "2027-01-31" },
  ],
  parkPrograms: [
    { id: "prog-swim", name: "Learn to swim", minAge: 6, maxAge: 12, capacity: 2, enrolled: 0 },
    { id: "prog-tennis", name: "Junior tennis", minAge: 13, maxAge: 17, capacity: 10, enrolled: 0 },
    { id: "prog-yoga", name: "Sunrise yoga", minAge: 18, maxAge: 99, capacity: 20, enrolled: 0 },
  ],
  housingUnits: [
    { id: "unit-1", ownerId: "res-ben", address: "12 Elm St #1" },
    { id: "unit-2", ownerId: "res-ben", address: "12 Elm St #2" },
    { id: "unit-3", ownerId: "res-ana", address: "88 Pier Ave" },
  ],
  rentRegistrations: [
    { id: "rent-seed-1", unitId: "unit-1", rentCents: 120_000, effectiveOn: "2024-01-01" },
    { id: "rent-seed-2", unitId: "unit-1", rentCents: 126_000, effectiveOn: "2025-01-01" },
  ],
};

/** A fresh store over a private copy of the seed data. */
export function createStore(): Store {
  const tables = new Map<string, unknown[]>();
  for (const [name, rows] of Object.entries(SEED)) {
    tables.set(name, structuredClone([...rows]));
  }
  const counters = new Map<string, number>();
  return {
    table<T>(name: string): T[] {
      let rows = tables.get(name);
      if (!rows) {
        rows = [];
        tables.set(name, rows);
      }
      return rows as T[];
    },
    nextId(prefix: string): string {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-${next}`;
    },
  };
}

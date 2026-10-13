// cityhall: a city-services API served by one Cloudflare Worker.
//
// Eight domains of four route modules each. A request to /<domain>/<module>/...
// goes to that module's handler, which owns its routes and its tables:
//
//   permits    applications, inspections, fees, renewals
//   parking    citations, permits, meters, appeals
//   utilities  water, usage, outages, autopay
//   licensing  business, pets, events, vendors
//   records    requests, redaction, retention, certificates
//   transit    passes, fares, eligibility, refunds
//   parks      reservations, programs, waitlists, waivers
//   housing    inspections, complaints, rents, relocation
//
// over five shared contracts every module imports (src/contracts/): money,
// time, validate, auth, and http.
//
// GET / serves a self-test page (src/ui.ts) that runs representative checks
// for every domain against the Worker it is served from and shows the score.
//
// createCityHall() builds one instance over a fresh, seeded in-memory store;
// the default export is the instance the deployed Worker serves.

import { notFound, problem } from "./contracts/http.ts";
import { createStore, type Ctx } from "./store.ts";
import { PAGE } from "./ui.ts";
import { handle as permitApplications } from "./permits/applications.ts";
import { handle as permitInspections } from "./permits/inspections.ts";
import { handle as permitFees } from "./permits/fees.ts";
import { handle as permitRenewals } from "./permits/renewals.ts";
import { handle as parkingCitations } from "./parking/citations.ts";
import { handle as parkingPermits } from "./parking/permits.ts";
import { handle as parkingMeters } from "./parking/meters.ts";
import { handle as parkingAppeals } from "./parking/appeals.ts";
import { handle as utilityWater } from "./utilities/water.ts";
import { handle as utilityUsage } from "./utilities/usage.ts";
import { handle as utilityOutages } from "./utilities/outages.ts";
import { handle as utilityAutopay } from "./utilities/autopay.ts";
import { handle as licensingBusiness } from "./licensing/business.ts";
import { handle as licensingPets } from "./licensing/pets.ts";
import { handle as licensingEvents } from "./licensing/events.ts";
import { handle as licensingVendors } from "./licensing/vendors.ts";
import { handle as recordRequests } from "./records/requests.ts";
import { handle as recordRedaction } from "./records/redaction.ts";
import { handle as recordRetention } from "./records/retention.ts";
import { handle as recordCertificates } from "./records/certificates.ts";
import { handle as transitPasses } from "./transit/passes.ts";
import { handle as transitFares } from "./transit/fares.ts";
import { handle as transitEligibility } from "./transit/eligibility.ts";
import { handle as transitRefunds } from "./transit/refunds.ts";
import { handle as parkReservations } from "./parks/reservations.ts";
import { handle as parkPrograms } from "./parks/programs.ts";
import { handle as parkWaitlists } from "./parks/waitlists.ts";
import { handle as parkWaivers } from "./parks/waivers.ts";
import { handle as housingInspections } from "./housing/inspections.ts";
import { handle as housingComplaints } from "./housing/complaints.ts";
import { handle as housingRents } from "./housing/rents.ts";
import { handle as housingRelocation } from "./housing/relocation.ts";

type Handler = (request: Request, ctx: Ctx) => Promise<Response>;

/** The route registry: "<domain>/<module>" to its owning module's handler. */
const ROUTES: Readonly<Record<string, Handler>> = {
  "permits/applications": permitApplications,
  "permits/inspections": permitInspections,
  "permits/fees": permitFees,
  "permits/renewals": permitRenewals,
  "parking/citations": parkingCitations,
  "parking/permits": parkingPermits,
  "parking/meters": parkingMeters,
  "parking/appeals": parkingAppeals,
  "utilities/water": utilityWater,
  "utilities/usage": utilityUsage,
  "utilities/outages": utilityOutages,
  "utilities/autopay": utilityAutopay,
  "licensing/business": licensingBusiness,
  "licensing/pets": licensingPets,
  "licensing/events": licensingEvents,
  "licensing/vendors": licensingVendors,
  "records/requests": recordRequests,
  "records/redaction": recordRedaction,
  "records/retention": recordRetention,
  "records/certificates": recordCertificates,
  "transit/passes": transitPasses,
  "transit/fares": transitFares,
  "transit/eligibility": transitEligibility,
  "transit/refunds": transitRefunds,
  "parks/reservations": parkReservations,
  "parks/programs": parkPrograms,
  "parks/waitlists": parkWaitlists,
  "parks/waivers": parkWaivers,
  "housing/inspections": housingInspections,
  "housing/complaints": housingComplaints,
  "housing/rents": housingRents,
  "housing/relocation": housingRelocation,
};

/** A city hall instance over a fresh, seeded store. */
export function createCityHall(): { fetch(request: Request): Promise<Response> } {
  const store = createStore();
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let parts: string[];
      try {
        parts = url.pathname.split("/").filter((p) => p !== "").map(decodeURIComponent);
      } catch {
        return problem(400, "malformed path");
      }
      if (request.method === "GET" && parts.length === 0) {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const key = `${parts[0] ?? ""}/${parts[1] ?? ""}`;
      const handler = Object.hasOwn(ROUTES, key) ? ROUTES[key] : undefined;
      if (!handler) {
        return notFound();
      }
      try {
        return await handler(request, { store, url, rest: parts.slice(2) });
      } catch {
        return problem(500, "internal error");
      }
    },
  };
}

export default createCityHall();

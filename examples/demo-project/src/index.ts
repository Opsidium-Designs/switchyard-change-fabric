/**
 * Demo service entry point: wires the audit store to the read API.
 *
 * This is the Change target for `examples/changes/audit-logging.change.yaml`.
 * It is deliberately tiny and framework-free so the Change Fabric's
 * deterministic verification (build + tests + path-scope checks) is fast and
 * reproducible.
 */

import { AuditStore } from "./audit/store.js";
import { createAuditApi, type AuditApi } from "./api/audit/handler.js";

export { AuditStore } from "./audit/store.js";
export { createAuditApi } from "./api/audit/handler.js";
export type { AuditEvent, NewAuditEvent, AuditAction } from "./audit/events.js";

export interface DemoService {
  store: AuditStore;
  api: AuditApi;
}

export function createService(): DemoService {
  const store = new AuditStore();
  const api = createAuditApi(store);
  return { store, api };
}

// Seed a couple of events when run directly, then print the API response.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { store, api } = createService();
  store.record({ orgId: "org-1", actor: "alice", action: "create", resource: "project/1" });
  store.record({ orgId: "org-1", actor: "bob", action: "read", resource: "project/1" });
  const res = api.handle({ path: "/audit/events", query: { orgId: "org-1" } });
  console.log(JSON.stringify(res, null, 2));
}

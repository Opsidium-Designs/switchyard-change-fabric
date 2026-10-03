/**
 * Audit read API (the `api` WorkUnit target in the example Change).
 *
 * A framework-free request handler so the demo stays dependency-light and fast
 * to test. It depends on the `model` WorkUnit's AuditStore, matching the
 * `api -> model` dependency edge in the example Change.
 */

import { type AuditStore } from "../../audit/store.js";
import { isAuditAction } from "../../audit/events.js";

export interface ApiRequest {
  /** Path without query string, e.g. "/audit/events". */
  path: string;
  /** Parsed query parameters. */
  query?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * Minimal router for the two read endpoints:
 *   GET /audit/events        list events (optional orgId/actor/action filters)
 *   GET /audit/events/:id    fetch a single event
 */
export function createAuditApi(store: AuditStore) {
  function handle(req: ApiRequest): ApiResponse {
    const single = req.path.match(/^\/audit\/events\/(\d+)$/);
    if (single) {
      const event = store.get(Number(single[1]));
      return event
        ? { status: 200, body: event }
        : { status: 404, body: { error: "not found" } };
    }

    if (req.path === "/audit/events") {
      const q = req.query ?? {};
      if (q.action && !isAuditAction(q.action)) {
        return { status: 400, body: { error: `invalid action: ${q.action}` } };
      }
      const events = store.query({
        orgId: q.orgId,
        actor: q.actor,
        action: q.action && isAuditAction(q.action) ? q.action : undefined,
      });
      return { status: 200, body: { events, count: events.length } };
    }

    return { status: 404, body: { error: "not found" } };
  }

  return { handle };
}

export type AuditApi = ReturnType<typeof createAuditApi>;

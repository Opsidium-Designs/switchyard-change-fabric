/**
 * Audit event persistence (the `model` WorkUnit target in the example Change).
 *
 * An intentionally tiny in-memory store: it owns id assignment and querying so
 * the API layer (`src/api/audit`) stays a thin read surface over it.
 */

import {
  type AuditEvent,
  type NewAuditEvent,
  makeAuditEvent,
} from "./events.js";

export interface AuditQuery {
  orgId?: string;
  actor?: string;
  action?: AuditEvent["action"];
}

export class AuditStore {
  private readonly events: AuditEvent[] = [];
  private nextId = 1;

  /** Persist a new event, assigning its id and timestamp. */
  record(input: NewAuditEvent, now?: number): AuditEvent {
    const event = makeAuditEvent(input, this.nextId++, now);
    this.events.push(event);
    return event;
  }

  /** Return events matching every provided filter, newest first. */
  query(filter: AuditQuery = {}): AuditEvent[] {
    return this.events
      .filter((e) => (filter.orgId ? e.orgId === filter.orgId : true))
      .filter((e) => (filter.actor ? e.actor === filter.actor : true))
      .filter((e) => (filter.action ? e.action === filter.action : true))
      .sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
  }

  /** Fetch a single event by id, or undefined if it does not exist. */
  get(id: number): AuditEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Total number of recorded events. */
  get size(): number {
    return this.events.length;
  }
}

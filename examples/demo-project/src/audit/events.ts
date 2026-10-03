/**
 * Audit event types and construction.
 *
 * NOTE: This module is intentionally touched by multiple WorkUnits in the
 * example Change (`api` and `tests` both declare `src/audit/events.ts`). It is
 * the deterministic path-collision point used to demonstrate the Change
 * Fabric's lease/conflict coordination. Keep its surface small and stable.
 */

export type AuditAction = "create" | "read" | "update" | "delete";

export interface AuditEvent {
  /** Monotonic identifier assigned by the store. */
  readonly id: number;
  /** Organization the event belongs to. */
  readonly orgId: string;
  /** Actor (user or service) responsible for the action. */
  readonly actor: string;
  /** What happened. */
  readonly action: AuditAction;
  /** The resource the action targeted (e.g. "project/42"). */
  readonly resource: string;
  /** Epoch milliseconds when the event was recorded. */
  readonly timestamp: number;
}

/** Fields a caller supplies; `id` and `timestamp` are assigned by the store. */
export type NewAuditEvent = Omit<AuditEvent, "id" | "timestamp">;

const VALID_ACTIONS: ReadonlySet<AuditAction> = new Set([
  "create",
  "read",
  "update",
  "delete",
]);

export function isAuditAction(value: string): value is AuditAction {
  return VALID_ACTIONS.has(value as AuditAction);
}

/**
 * Validate and normalize a candidate event. Throws on invalid input so the
 * store never persists a malformed event.
 */
export function makeAuditEvent(
  input: NewAuditEvent,
  id: number,
  now: number = Date.now(),
): AuditEvent {
  if (!input.orgId.trim()) {
    throw new Error("audit event requires a non-empty orgId");
  }
  if (!input.actor.trim()) {
    throw new Error("audit event requires a non-empty actor");
  }
  if (!isAuditAction(input.action)) {
    throw new Error(`unknown audit action: ${String(input.action)}`);
  }
  if (!input.resource.trim()) {
    throw new Error("audit event requires a non-empty resource");
  }
  return {
    id,
    orgId: input.orgId,
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    timestamp: now,
  };
}

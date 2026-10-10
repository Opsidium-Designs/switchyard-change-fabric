/**
 * call-usage: what a model-backed step actually spent, also when it failed.
 *
 * An executor (or a tool-region filler) may call the model more than once for
 * one step (a transient failure is retried) and may fail AFTER a paid call (an
 * unusable reply, an edit that does not anchor). A cost meter must count every
 * paid attempt, so the step reports its attempts and token usage on success
 * (`ExecutionCost.attempts`) and attaches them to the error it throws
 * (`withCallUsage`), where `executorCallUsage` reads them back. Nothing here
 * carries a credential.
 */

/** The model calls one step made: the attempts and the usage the provider reported (for the successful one). */
export interface ExecutorCallUsage {
  readonly model?: string;
  /** Model calls made (each counts, including transient retries). At least 1 once a call was attempted. */
  readonly attempts: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

const KEY = "callUsage";

/**
 * Attach `usage` to a thrown value (non-enumerable, never overwriting usage
 * already attached) and return it, for `throw withCallUsage(error, usage)`.
 * A non-object thrown value is wrapped in an Error first.
 */
export function withCallUsage(error: unknown, usage: ExecutorCallUsage): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  if (executorCallUsage(target) === undefined) {
    Object.defineProperty(target, KEY, { value: usage, enumerable: false, configurable: true, writable: false });
  }
  return target;
}

/** The usage attached to a thrown value, if any. */
export function executorCallUsage(error: unknown): ExecutorCallUsage | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[KEY];
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const attempts = (value as { attempts?: unknown }).attempts;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts >= 0 ? (value as ExecutorCallUsage) : undefined;
}

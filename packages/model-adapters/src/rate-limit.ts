/**
 * rate-limit: the gateway's "slow down" answer, classified as its own
 * transient failure.
 *
 * An HTTP 429 from the AI Gateway (or a 503 that carries a Retry-After header)
 * is the provider's rate or quota limit: no model looked at the request, so
 * nothing about the work was decided. Every gateway transport (the executor's
 * edit call, the schema-constrained planner and agent-turn calls, and the
 * typed-decision call) throws a RateLimitError for it, carrying the status, the
 * model, and the Retry-After delay when the gateway sent one, so a caller can
 * back off instead of recording the call as an agent decision or a failed
 * edit. It is transient: a retry may succeed, and a retry never switches model.
 * No response body, header other than Retry-After, or credential is read into
 * it.
 */

/** Thrown when the gateway answers HTTP 429 (or 503 with Retry-After). */
export class RateLimitError extends Error {
  /** The HTTP status the gateway answered (429, or 503 with Retry-After). */
  readonly status: number;
  /** The model the call was for. */
  readonly model: string;
  /** The Retry-After delay the gateway asked for, in ms (absent when it sent none). */
  readonly retryAfterMs?: number;

  constructor(message: string, options: { readonly status: number; readonly model: string; readonly retryAfterMs?: number }) {
    super(message);
    this.name = "RateLimitError";
    this.status = options.status;
    this.model = options.model;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/** True for a RateLimitError (by type, or by name across module copies). */
export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError || (error instanceof Error && error.name === "RateLimitError");
}

/** The longest Retry-After honoured as given (a day); a longer one is clamped. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a Retry-After header: delta seconds (`"20"`) or an HTTP date. Returns
 * the delay in ms (0 for a date in the past), or undefined when absent or
 * unparseable. Clamped to a day so a hostile value cannot overflow a timer.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") {
    return undefined;
  }
  if (/^[0-9]+(\.[0-9]+)?$/.test(raw)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(raw) * 1000));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

/** A Retry-After delay in words ("retry-after 20 s"), for messages. */
export function describeRetryAfter(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined) {
    return "no retry-after";
  }
  return retryAfterMs < 1000 ? `retry-after ${retryAfterMs} ms` : `retry-after ${Math.round(retryAfterMs / 1000)} s`;
}

/**
 * The RateLimitError for a gateway response, or undefined when the response is
 * not a rate limit: HTTP 429 always is; HTTP 503 is only when the gateway sent
 * Retry-After (a plain 503 stays an ordinary transient 5xx). `label` names the
 * call ("agent turn", "plan", "decision"; empty for the executor's edit call).
 */
export function rateLimitErrorFor(res: Pick<Response, "status" | "headers">, model: string, label = ""): RateLimitError | undefined {
  const retryHeader = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
  const retryAfterMs = parseRetryAfter(retryHeader);
  if (res.status !== 429 && !(res.status === 503 && retryAfterMs !== undefined)) {
    return undefined;
  }
  const what = label === "" ? "call" : `${label} call`;
  return new RateLimitError(
    `AI Gateway ${what} was rate limited for ${model} (HTTP ${res.status}, ${describeRetryAfter(retryAfterMs)}): the provider's rate or quota limit`,
    { status: res.status, model, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
}

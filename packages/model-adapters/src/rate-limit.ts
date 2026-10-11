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
 *
 * One 429 is NOT transient: an exhausted provider balance (OpenAI answers
 * `insufficient_quota` / `credit_balance_exhausted` with no Retry-After) never
 * recovers by waiting. To tell it apart, `rateLimitErrorFromResponse` reads a
 * bounded slice (MAX_RATE_LIMIT_BODY_BYTES) of a 429's body and classifies it as
 * a QuotaExhaustedError (a RateLimitError subtype, so every existing rate-limit
 * path stays safe: no turn budget, not billed) that a run ends on at once.
 * Only the provider's error `code` and `type` (each a short identifier) are
 * kept from that body, never its message or anything else; no header other than
 * Retry-After, and no credential, is read into either error.
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

/** True for a RateLimitError, a QuotaExhaustedError included (by type, or by name across module copies). */
export function isRateLimitError(error: unknown): error is RateLimitError {
  return (
    error instanceof RateLimitError ||
    (error instanceof Error && (error.name === "RateLimitError" || error.name === "QuotaExhaustedError"))
  );
}

/**
 * The provider error codes (OpenAI's `error.code`, or `error.type` for the
 * first) that mean the account's balance or hard billing limit is spent: a 429
 * carrying one never recovers by waiting. Kept deliberately small:
 * - `insufficient_quota`: no quota or credits left (also OpenAI's `error.type`).
 * - `credit_balance_exhausted`: the prepaid credit balance is spent.
 * - `billing_hard_limit_reached`: the account's hard spend limit is reached.
 */
export const QUOTA_EXHAUSTED_CODES: readonly string[] = ["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"];

/** The most of a 429 body read to classify it, in bytes; anything past it is never read. */
export const MAX_RATE_LIMIT_BODY_BYTES = 4096;

/** The longest provider code/type kept on a QuotaExhaustedError (an identifier, never prose). */
const MAX_PROVIDER_CODE = 64;

/**
 * Thrown when the gateway answers HTTP 429 because the provider account has no
 * credits (or hit its hard billing limit). It IS a RateLimitError (no model
 * looked at the call: not billed, no turn budget), but waiting does not help,
 * so a run ends on it at once instead of backing off. It carries the model, the
 * status, and the provider's error code/type only (bounded identifiers).
 */
export class QuotaExhaustedError extends RateLimitError {
  readonly kind = "quota-exhausted";
  /** The provider's error code (for example "credit_balance_exhausted"), when it sent one. */
  readonly providerCode?: string;
  /** The provider's error type (for example "insufficient_quota"), when it sent one. */
  readonly providerType?: string;

  constructor(
    message: string,
    options: { readonly status: number; readonly model: string; readonly providerCode?: string; readonly providerType?: string },
  ) {
    super(message, { status: options.status, model: options.model });
    this.name = "QuotaExhaustedError";
    if (options.providerCode !== undefined) {
      this.providerCode = options.providerCode;
    }
    if (options.providerType !== undefined) {
      this.providerType = options.providerType;
    }
  }
}

/** True for a QuotaExhaustedError (by type, or by name across module copies). */
export function isQuotaExhaustedError(error: unknown): error is QuotaExhaustedError {
  return error instanceof QuotaExhaustedError || (error instanceof Error && error.name === "QuotaExhaustedError");
}

/** The provider reason of a quota-exhausted error in one identifier (works across module copies). */
export function quotaReasonCode(error: { readonly providerCode?: string; readonly providerType?: string }): string {
  return error.providerCode ?? error.providerType ?? "insufficient_quota";
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

/** A short identifier from a provider error field, or undefined (prose, or too long, is dropped). */
function providerIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= MAX_PROVIDER_CODE && /^[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Read at most `maxBytes` of a response body as text, then cancel the rest.
 * Returns undefined when there is no body or it cannot be read.
 */
async function readBoundedText(res: Pick<Response, "body" | "text">, maxBytes: number): Promise<string | undefined> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (body === undefined || body === null || typeof body.getReader !== "function") {
    // No stream to bound (a test double): a text() that is itself bounded here.
    if (typeof res.text !== "function") {
      return undefined;
    }
    const text = await res.text();
    return text.slice(0, maxBytes);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        break;
      }
      const take = value.subarray(0, maxBytes - total);
      chunks.push(take);
      total += take.byteLength;
    }
  } finally {
    // Whatever was not read is discarded, never buffered.
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Classify a bounded 429 body: the provider's quota code/type when it says the
 * balance is spent, else undefined. Defensive: anything but a JSON object with
 * an `error` object yields undefined.
 */
export function quotaExhaustionIn(text: string): { readonly providerCode?: string; readonly providerType?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const error = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const providerCode = providerIdentifier((error as { code?: unknown }).code);
  const providerType = providerIdentifier((error as { type?: unknown }).type);
  if (providerType !== "insufficient_quota" && (providerCode === undefined || !QUOTA_EXHAUSTED_CODES.includes(providerCode))) {
    return undefined;
  }
  return { ...(providerCode !== undefined ? { providerCode } : {}), ...(providerType !== undefined ? { providerType } : {}) };
}

/**
 * Like `rateLimitErrorFor`, but for an HTTP 429 it first reads at most
 * MAX_RATE_LIMIT_BODY_BYTES of the body to tell an exhausted provider balance
 * (a QuotaExhaustedError) from an ordinary rate limit. A body that cannot be
 * read or parsed, or names no quota code, stays a RateLimitError. Call it
 * BEFORE consuming the body; it consumes (at most the bound of) the body only
 * for a 429. Undefined when the response is not a rate limit.
 */
export async function rateLimitErrorFromResponse(
  res: Pick<Response, "status" | "headers" | "body" | "text">,
  model: string,
  label = "",
): Promise<RateLimitError | undefined> {
  const limited = rateLimitErrorFor(res, model, label);
  if (limited === undefined || res.status !== 429) {
    return limited;
  }
  let text: string | undefined;
  try {
    text = await readBoundedText(res, MAX_RATE_LIMIT_BODY_BYTES);
  } catch {
    return limited;
  }
  const quota = text === undefined ? undefined : quotaExhaustionIn(text);
  if (quota === undefined) {
    return limited;
  }
  const what = label === "" ? "call" : `${label} call`;
  const reason = quotaReasonCode(quota);
  return new QuotaExhaustedError(
    `AI Gateway ${what} was refused for ${model} (HTTP ${res.status}, ${reason}): the provider account has no credits left; add credits and re-run`,
    { status: res.status, model, ...quota },
  );
}

/**
 * rate-limit-backoff: one shared backoff for every agent of a board run when
 * the AI Gateway rate limits the run.
 *
 * An HTTP 429 (or a 503 with Retry-After) is the provider's rate or quota
 * limit, not an agent's behavior: no model decided anything. So a rate-limited
 * call never spends a turn budget, and instead of every agent hammering the
 * gateway with its own retries, the whole process pauses: the backoff honours
 * the gateway's Retry-After when it sent one, else waits an exponentially
 * growing, jittered, bounded delay (5 s doubling to 120 s by default). Calls
 * already in flight when the backoff starts may come back rate limited too;
 * they extend the pause (to their Retry-After) but do not escalate it again.
 * Any call the gateway answers other than with a rate limit ends the streak.
 *
 * When rate limiting persists for the bounded window (10 minutes by default)
 * with no call getting through, the driver stops the run with stop reason
 * "rate-limited" and `stopDetail()` says so honestly. The clock and the
 * jitter source are injected, so tests stay deterministic.
 */

import { isRateLimitError, describeRetryAfter, type AgentTurnTransport, type ExecutionResult, type ExecutorContext, type ExecutorProvider } from "@switchyard-change/model-adapters";

/** The default first backoff delay (doubles per escalation). */
export const DEFAULT_RATE_LIMIT_BASE_MS = 5_000;
/** The default longest backoff delay without a Retry-After. */
export const DEFAULT_RATE_LIMIT_MAX_MS = 120_000;
/** The default window of consecutive rate limits after which the run stops. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** One rate-limited call (what the gateway answered). */
export interface RateLimitNote {
  readonly model: string;
  readonly status: number;
  readonly retryAfterMs?: number;
}

/** A backoff the shared gate started or extended. */
export interface RateLimitBackoffEvent extends RateLimitNote {
  /** How long every agent now pauses, in ms. */
  readonly backoffMs: number;
  /** Rate-limited calls in the current streak (no call got through since the first). */
  readonly consecutive: number;
  /** How long the run has been rate limited without a call getting through, in ms. */
  readonly limitedForMs: number;
}

/** Options for the shared backoff (every delay in ms). */
export interface RateLimitBackoffOptions {
  /** Stop the run after this long of consecutive rate limits with no call getting through (default 10 min). */
  readonly windowMs?: number;
  /** The first delay without a Retry-After (default 5 s); doubles per escalation. */
  readonly baseMs?: number;
  /** The longest delay without a Retry-After (default 120 s). */
  readonly maxMs?: number;
  readonly now?: () => number;
  /** A [0, 1) jitter source (default Math.random). */
  readonly random?: () => number;
  /** Called whenever a backoff starts or is extended. */
  readonly onBackoff?: (event: RateLimitBackoffEvent) => void;
}

/** A duration in words for the stop detail ("10 min", "45 s", "200 ms"). */
function duration(ms: number): string {
  if (ms >= 60_000) {
    return `${Math.round(ms / 60_000)} min`;
  }
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.max(0, Math.round(ms))} ms`;
}

/** The process-wide rate-limit backoff shared by every agent of a run (see the module comment). */
export class RateLimitBackoff {
  /** Rate-limited calls in the current streak. */
  consecutive = 0;
  /** Every rate-limited call this run. */
  total = 0;
  /** The last rate-limited call. */
  last?: RateLimitNote;
  readonly windowMs: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onBackoff: ((event: RateLimitBackoffEvent) => void) | undefined;
  private streakStart: number | undefined;
  private until = 0;
  private level = 0;
  private readonly statuses = new Set<number>();

  constructor(options: RateLimitBackoffOptions = {}) {
    const positive = (value: number | undefined, fallback: number): number =>
      value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
    this.windowMs = positive(options.windowMs, DEFAULT_RATE_LIMIT_WINDOW_MS);
    this.baseMs = positive(options.baseMs, DEFAULT_RATE_LIMIT_BASE_MS);
    this.maxMs = Math.max(this.baseMs, positive(options.maxMs, DEFAULT_RATE_LIMIT_MAX_MS));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onBackoff = options.onBackoff;
  }

  /**
   * Record a rate-limited call and (re)start the shared pause; returns the
   * pause in ms. A Retry-After is honoured (bounded by the window); otherwise
   * the delay escalates exponentially with jitter, within [base, max]. A rate
   * limit arriving while already paused (a call in flight when the pause
   * began) only extends the pause to its Retry-After.
   */
  note(limit: RateLimitNote): number {
    const now = this.now();
    this.consecutive += 1;
    this.total += 1;
    this.last = limit;
    this.statuses.add(limit.status);
    this.streakStart ??= now;
    const retryAfter = limit.retryAfterMs !== undefined && limit.retryAfterMs > 0 ? Math.min(limit.retryAfterMs, this.windowMs) : undefined;
    if (now < this.until) {
      if (retryAfter !== undefined) {
        this.until = Math.max(this.until, now + retryAfter);
      }
    } else {
      this.level += 1;
      const exponential = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(30, this.level - 1));
      const r = this.random();
      const jitter = 0.75 + 0.5 * (Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5);
      const jittered = Math.min(this.maxMs, Math.max(this.baseMs, Math.round(exponential * jitter)));
      this.until = now + (retryAfter ?? jittered);
    }
    const backoffMs = this.until - now;
    this.onBackoff?.({ ...limit, backoffMs, consecutive: this.consecutive, limitedForMs: now - this.streakStart });
    return backoffMs;
  }

  /** A call got through (anything but a rate limit): the streak and the pause end. */
  succeeded(): void {
    this.consecutive = 0;
    this.streakStart = undefined;
    this.until = 0;
    this.level = 0;
    this.statuses.clear();
  }

  /** True while every agent is paused. */
  get backingOff(): boolean {
    return this.now() < this.until;
  }

  /** The pause left, in ms (0 when not paused). */
  get remainingMs(): number {
    return Math.max(0, this.until - this.now());
  }

  /** True while a rate-limit streak is open (no call got through since the first 429). */
  get limited(): boolean {
    return this.streakStart !== undefined;
  }

  /** How long the current streak has lasted, in ms (0 with no streak). */
  get limitedForMs(): number {
    return this.streakStart === undefined ? 0 : this.now() - this.streakStart;
  }

  /** True once the streak has lasted the whole window: the run stops (rate-limited). */
  get exceeded(): boolean {
    return this.streakStart !== undefined && this.limitedForMs >= this.windowMs;
  }

  /** The honest stop detail for a run ended by rate limiting. */
  stopDetail(): string {
    const statuses = [...this.statuses].sort((a, b) => a - b);
    const status = statuses.length === 1 && statuses[0] === 429 ? "HTTP 429" : statuses.map((s) => `HTTP ${s}`).join(" or ") + " (rate limited)";
    const last = this.last ? `${this.last.model}, ${describeRetryAfter(this.last.retryAfterMs)}` : "no call recorded";
    return (
      `the AI Gateway returned ${status} for every call for ${duration(this.limitedForMs)} (last: ${last}; ${this.consecutive} rate-limited call(s)): ` +
      "the provider's rate or quota limit; nothing was decided by a model in that window"
    );
  }

  /** Wait out the current pause (resolves early on `signal`). */
  async wait(signal?: AbortSignal): Promise<void> {
    const ms = this.remainingMs;
    if (ms <= 0 || signal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/**
 * A turn transport that feeds the shared backoff: a rate-limited outcome
 * (`outcome.rateLimited`) starts or extends the pause; any other outcome means
 * the gateway answered, so the streak ends.
 */
export function rateLimitedTransport<D, M>(transport: AgentTurnTransport<D, M>, backoff: RateLimitBackoff): AgentTurnTransport<D, M> {
  return async (input) => {
    const outcome = await transport(input);
    if (outcome.rateLimited !== undefined) {
      backoff.note(outcome.rateLimited);
    } else {
      backoff.succeeded();
    }
    return outcome;
  };
}

/**
 * An executor that feeds the shared backoff: an edit that throws a
 * RateLimitError (after the executor's own bounded same-model retry) starts or
 * extends the pause; a successful edit ends the streak. Other failures leave
 * it unchanged.
 */
export function rateLimitedExecutor(executor: ExecutorProvider, backoff: RateLimitBackoff): ExecutorProvider {
  return {
    name: executor.name,
    async execute(context: ExecutorContext): Promise<ExecutionResult> {
      let result: ExecutionResult;
      try {
        result = await executor.execute(context);
      } catch (error) {
        if (isRateLimitError(error)) {
          backoff.note({ model: error.model, status: error.status, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) });
        }
        throw error;
      }
      backoff.succeeded();
      return result;
    },
  };
}

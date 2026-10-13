/**
 * inflight-limiter: one bound on the model calls a board run has in flight at
 * once, shared by every caller of the run (agent turns, edits, the planner,
 * tool authoring, typed decisions).
 *
 * Agents are not model calls: a run may have 30 agents in its pool while only
 * a handful of their calls run at the same moment (each local CLI call is a
 * process; each gateway call counts against the provider's rate limit). A call
 * beyond the limit waits for a slot in arrival order (FIFO), so no agent is
 * starved. The shared rate-limit backoff (rate-limit-backoff.ts) composes with
 * it: a paused agent takes no turn, so it never asks for a slot.
 *
 * Never a deadlock: a call made while the same async call path already holds a
 * slot (for example a decision asked from inside a planner call) runs on that
 * slot instead of asking for a second one, so nested calls can never wait on
 * themselves. A slot is always released, on a return, a throw, or an abort.
 * Waiting is bounded only by the calls ahead of it, each of which carries its
 * own timeout.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { AgentTurnTransport, ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";

import type { ToolAuthor } from "./board-tools.ts";

/** The most model calls a run may allow in flight at once (the --max-inflight bound). */
export const MAX_INFLIGHT = 64;
/** The default in-flight limit when the dial allows more agents than this. */
export const DEFAULT_MAX_INFLIGHT = 8;

/** The default in-flight limit for a dial max: min(dial max, 8), at least 1. */
export function defaultMaxInflight(dialMax: number): number {
  return Math.max(1, Math.min(Number.isFinite(dialMax) ? Math.floor(dialMax) : 1, DEFAULT_MAX_INFLIGHT));
}

/** True for a valid explicit in-flight limit (an integer from 1 to MAX_INFLIGHT). */
export function validMaxInflight(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_INFLIGHT;
}

/** Thrown to a waiter whose signal aborted before it got a slot. */
export class InflightAbortedError extends Error {
  constructor(message = "the run ended while this call waited for a model-call slot") {
    super(message);
    this.name = "InflightAbortedError";
  }
}

/** What the limiter observed over a run. */
export interface InflightStats {
  /** The limit (the last one set). */
  readonly max: number;
  /** The most calls that were in flight at once. */
  readonly peak: number;
  /** Calls that ran under the limiter (nested calls on a held slot not counted again). */
  readonly calls: number;
  /** Calls that had to wait for a slot. */
  readonly queuedCalls: number;
  /** The total time calls spent waiting for a slot, in ms. */
  readonly queuedWaitMs: number;
}

interface Waiter {
  readonly enqueuedAt: number;
  readonly grant: () => void;
}

/** The shared in-flight bound of one run (see the module comment). */
export class InflightLimiter {
  private limitValue: number;
  private active = 0;
  private peakValue = 0;
  private callsValue = 0;
  private queuedCallsValue = 0;
  private queuedWaitValue = 0;
  private readonly queue: Waiter[] = [];
  private readonly held = new AsyncLocalStorage<InflightLimiter>();
  private readonly now: () => number;

  constructor(limit: number, now: () => number = Date.now) {
    if (!validMaxInflight(limit)) {
      throw new Error(`the in-flight model-call limit must be an integer from 1 to ${MAX_INFLIGHT} (got ${limit})`);
    }
    this.limitValue = limit;
    this.now = now;
  }

  /** The current limit. */
  get limit(): number {
    return this.limitValue;
  }

  /** Calls in flight now. */
  get inFlight(): number {
    return this.active;
  }

  /** Calls waiting for a slot now. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Change the limit; a raised limit lets queued calls in at once, a lowered one takes effect as calls finish. */
  setLimit(limit: number): void {
    if (!validMaxInflight(limit)) {
      throw new Error(`the in-flight model-call limit must be an integer from 1 to ${MAX_INFLIGHT} (got ${limit})`);
    }
    this.limitValue = limit;
    this.drain();
  }

  /** What the limiter observed so far. */
  stats(): InflightStats {
    return { max: this.limitValue, peak: this.peakValue, calls: this.callsValue, queuedCalls: this.queuedCallsValue, queuedWaitMs: this.queuedWaitValue };
  }

  /**
   * Run `fn` holding one slot: at once when one is free, else after every
   * call queued before it. A call on a path that already holds a slot of this
   * limiter runs on it (no second acquire). `signal` aborting while queued
   * rejects with InflightAbortedError (no slot taken).
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.held.getStore() === this) {
      return fn();
    }
    await this.acquire(signal);
    try {
      return await this.held.run(this, fn);
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new InflightAbortedError());
    }
    this.callsValue += 1;
    if (this.queue.length === 0 && this.active < this.limitValue) {
      this.take();
      return Promise.resolve();
    }
    this.queuedCallsValue += 1;
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const at = this.queue.indexOf(waiter);
        if (at >= 0) {
          this.queue.splice(at, 1);
          this.queuedWaitValue += Math.max(0, this.now() - waiter.enqueuedAt);
          reject(new InflightAbortedError());
        }
      };
      const waiter: Waiter = {
        enqueuedAt: this.now(),
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.queuedWaitValue += Math.max(0, this.now() - waiter.enqueuedAt);
          this.take();
          resolve();
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private take(): void {
    this.active += 1;
    this.peakValue = Math.max(this.peakValue, this.active);
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  /** Grant slots to queued calls, oldest first, while the limit allows. */
  private drain(): void {
    while (this.queue.length > 0 && this.active < this.limitValue) {
      this.queue.shift()!.grant();
    }
  }
}

/**
 * A turn transport whose every call holds a slot. A turn still queued when
 * `signal` aborts (the agent phase ended) is answered `wait` without calling
 * the model.
 */
export function limitedTransport<D, M>(transport: AgentTurnTransport<D, M>, limiter: InflightLimiter, signal?: AbortSignal): AgentTurnTransport<D, M> {
  return async (input) => {
    try {
      return await limiter.run(() => transport(input), signal);
    } catch (error) {
      if (error instanceof InflightAbortedError) {
        return { action: { type: "wait", reason: error.message } };
      }
      throw error;
    }
  };
}

/** An executor whose every edit holds one slot for all the model calls the edit makes. */
export function limitedExecutor(executor: ExecutorProvider, limiter: InflightLimiter, signal?: AbortSignal): ExecutorProvider {
  return {
    name: executor.name,
    execute(context: ExecutorContext): Promise<ExecutionResult> {
      return limiter.run(() => executor.execute(context), signal);
    },
  };
}

/** A tool author whose authoring holds a slot. */
export function limitedToolAuthor(author: ToolAuthor, limiter: InflightLimiter, signal?: AbortSignal): ToolAuthor {
  return (request) => limiter.run(() => author(request), signal);
}

/** Any other model call (a typed decision, the planner) holding a slot. */
export function limitedCall<A extends readonly unknown[], R>(call: (...args: A) => Promise<R>, limiter: InflightLimiter, signal?: AbortSignal): (...args: A) => Promise<R> {
  return (...args: A) => limiter.run(() => call(...args), signal);
}

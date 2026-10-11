/**
 * Rate limits at the gateway transports: an HTTP 429 (or a 503 with
 * Retry-After) is a distinct, transient RateLimitError carrying the status,
 * the model, and the Retry-After delay, on the executor's edit call, the
 * planner call, and the typed-decision call. The executor's bounded retry
 * treats it as transient on the SAME model, honours a short Retry-After, and
 * throws a long one at once (the board's shared backoff waits it out).
 * Offline: every transport is driven with a fake fetch or a fake invoke.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAiGatewayJevInvoke,
  createAiGatewayPlannerInvoke,
  createAiGatewayRestInvoke,
  isQuotaExhaustedError,
  isRateLimitError,
  MAX_RATE_LIMIT_BODY_BYTES,
  QuotaExhaustedError,
  rateLimitErrorFromResponse,
  isTransientWorkersAiError,
  MAX_EXECUTOR_RETRY_AFTER_MS,
  parseRetryAfter,
  RateLimitError,
  WorkersAiExecutor,
  type WorkersAiInvoke,
} from "../src/index.ts";

const limited = (status: number, headers: Record<string, string> = {}) =>
  (async () => new Response("rate limit body with secret-token", { status, headers })) as unknown as typeof fetch;

describe("parseRetryAfter", () => {
  it("reads delta seconds and an HTTP date; ignores an absent or unparseable value", () => {
    expect(parseRetryAfter("20")).toBe(20_000);
    expect(parseRetryAfter("1.5")).toBe(1500);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    // Clamped to a day.
    expect(parseRetryAfter("999999999")).toBe(24 * 60 * 60 * 1000);
  });
});

describe("the gateway transports classify a rate limit", () => {
  it("the executor's edit call throws a RateLimitError on 429 and on 503 with Retry-After; a plain 503 stays a plain error", async () => {
    const call = (fetchFn: typeof fetch) =>
      createAiGatewayRestInvoke({ gatewayUrl: "https://gw", gatewayToken: "secret-token", fetchFn })({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] });
    const err429 = await call(limited(429, { "retry-after": "7" })).catch((e: unknown) => e);
    expect(err429).toBeInstanceOf(RateLimitError);
    expect(err429).toMatchObject({ status: 429, model: "gpt-4o", retryAfterMs: 7000, name: "RateLimitError" });
    expect(String((err429 as Error).message)).not.toContain("secret-token");
    expect(isTransientWorkersAiError(err429)).toBe(true);
    const bare = await call(limited(429)).catch((e: unknown) => e);
    expect(isRateLimitError(bare)).toBe(true);
    expect((bare as RateLimitError).retryAfterMs).toBeUndefined();
    const err503 = await call(limited(503, { "retry-after": "2" })).catch((e: unknown) => e);
    expect(err503).toMatchObject({ status: 503, retryAfterMs: 2000 });
    const plain503 = await call(limited(503)).catch((e: unknown) => e);
    expect(isRateLimitError(plain503)).toBe(false);
    expect(String((plain503 as Error).message)).toMatch(/HTTP 503/);
    expect(isTransientWorkersAiError(plain503)).toBe(true);
  });

  it("the planner call throws a RateLimitError on 429", async () => {
    const invoke = createAiGatewayPlannerInvoke({ gatewayUrl: "https://gw", gatewayToken: "secret-token", fetchFn: limited(429, { "retry-after": "60" }) });
    const error = await invoke({ model: "gpt-4.1", messages: [{ role: "user", content: "plan" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ status: 429, model: "gpt-4.1", retryAfterMs: 60_000 });
    expect(String((error as Error).message)).toMatch(/AI Gateway plan call was rate limited for gpt-4\.1 \(HTTP 429, retry-after 60 s\)/);
  });

  it("the typed-decision call throws a RateLimitError on 429", async () => {
    const invoke = createAiGatewayJevInvoke({ accountId: "acct", apiToken: "secret-token", gatewayId: "g", fetchFn: limited(429) });
    const error = await invoke({ state: "s", questions: {} }).catch((e: unknown) => e);
    expect(isRateLimitError(error)).toBe(true);
    expect(String((error as Error).message)).toMatch(/decision call was rate limited/);
    expect(String((error as Error).message)).not.toContain("secret-token");
  });
});

describe("the executor's bounded retry on a rate limit", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "scf-rate-limit-"));
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/x.ts"), "export const x = 0;\n", "utf8");
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });
  const edit = JSON.stringify({ edits: [{ path: "src/x.ts", search: "export const x = 0;", replace: "export const x = 1;" }] });
  const context = () => ({ worktreeDir: worktree, workUnitId: "x", objective: "set x", paths: ["src/x.ts"], baselineRef: "HEAD", model: "gpt-4o" });

  it("retries the SAME model, waiting out a short Retry-After", async () => {
    const models: string[] = [];
    const slept: number[] = [];
    let calls = 0;
    const invoke: WorkersAiInvoke = async (request) => {
      models.push(request.model);
      calls += 1;
      if (calls === 1) {
        throw new RateLimitError("rate limited", { status: 429, model: request.model, retryAfterMs: 4000 });
      }
      return { text: edit };
    };
    const result = await new WorkersAiExecutor({ invoke, retryBackoffMs: 10, sleep: async (ms) => void slept.push(ms) }).execute(context());
    expect(result.status).toBe("changed");
    expect(models).toEqual(["gpt-4o", "gpt-4o"]);
    expect(slept).toEqual([4000]);
  });

  it("never retries a QuotaExhaustedError (no credits: waiting never helps)", async () => {
    let calls = 0;
    const invoke: WorkersAiInvoke = async (request) => {
      calls += 1;
      throw new QuotaExhaustedError("no credits", { status: 429, model: request.model, providerCode: "credit_balance_exhausted" });
    };
    const error = await new WorkersAiExecutor({ invoke, maxRetries: 3, retryBackoffMs: 0, sleep: async () => undefined }).execute(context()).catch((e: unknown) => e);
    expect(isQuotaExhaustedError(error)).toBe(true);
    expect(calls).toBe(1);
  });

  it("throws at once when Retry-After is longer than the executor waits out", async () => {
    let calls = 0;
    const invoke: WorkersAiInvoke = async (request) => {
      calls += 1;
      throw new RateLimitError("rate limited", { status: 429, model: request.model, retryAfterMs: MAX_EXECUTOR_RETRY_AFTER_MS + 1 });
    };
    const error = await new WorkersAiExecutor({ invoke, retryBackoffMs: 0, sleep: async () => undefined }).execute(context()).catch((e: unknown) => e);
    expect(isRateLimitError(error)).toBe(true);
    expect(calls).toBe(1);
  });
});

/** The exact body OpenAI (through the gateway) answers when the account has no credits. */
const NO_CREDITS_BODY = JSON.stringify({
  error: {
    message: "You have no credits remaining. Add credits to your account to continue (contains secret-token).",
    type: "insufficient_quota",
    param: null,
    code: "credit_balance_exhausted",
  },
});

const noCredits = (body: string = NO_CREDITS_BODY, headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status: 429, headers })) as unknown as typeof fetch;

describe("an exhausted provider balance (HTTP 429 insufficient_quota)", () => {
  it("classifies the exact no-credits body as a QuotaExhaustedError keeping only the code and type", async () => {
    const error = await rateLimitErrorFromResponse(new Response(NO_CREDITS_BODY, { status: 429 }), "gpt-4o", "agent turn");
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(isQuotaExhaustedError(error)).toBe(true);
    expect(isRateLimitError(error)).toBe(true);
    expect(error).toMatchObject({ status: 429, model: "gpt-4o", providerCode: "credit_balance_exhausted", providerType: "insufficient_quota", kind: "quota-exhausted" });
    expect((error as QuotaExhaustedError).retryAfterMs).toBeUndefined();
    expect(error!.message).toBe(
      "AI Gateway agent turn call was refused for gpt-4o (HTTP 429, credit_balance_exhausted): the provider account has no credits left; add credits and re-run",
    );
    // Nothing of the provider's prose (or anything in it) is kept.
    expect(error!.message).not.toContain("secret-token");
    expect(error!.message).not.toContain("You have no credits");
    // A type alone, or each documented code alone, is quota exhaustion too.
    for (const body of [
      { error: { type: "insufficient_quota" } },
      { error: { code: "insufficient_quota" } },
      { error: { code: "billing_hard_limit_reached", type: "invalid_request_error" } },
    ]) {
      expect(isQuotaExhaustedError(await rateLimitErrorFromResponse(new Response(JSON.stringify(body), { status: 429 }), "m"))).toBe(true);
    }
  });

  it("a plain 429 (with or without Retry-After) stays a RateLimitError; a 503 with Retry-After is unchanged; a non-limit is undefined", async () => {
    const plain = await rateLimitErrorFromResponse(new Response(JSON.stringify({ error: { type: "requests", code: "rate_limit_exceeded" } }), { status: 429 }), "m");
    expect(plain).toBeInstanceOf(RateLimitError);
    expect(isQuotaExhaustedError(plain)).toBe(false);
    const after = await rateLimitErrorFromResponse(new Response("slow down", { status: 429, headers: { "retry-after": "7" } }), "m");
    expect(isQuotaExhaustedError(after)).toBe(false);
    expect(after).toMatchObject({ status: 429, retryAfterMs: 7000, name: "RateLimitError" });
    const res503 = new Response(NO_CREDITS_BODY, { status: 503, headers: { "retry-after": "2" } });
    const e503 = await rateLimitErrorFromResponse(res503, "m");
    expect(e503).toMatchObject({ status: 503, retryAfterMs: 2000, name: "RateLimitError" });
    // A 503 body is never read to classify it.
    expect(res503.bodyUsed).toBe(false);
    expect(await rateLimitErrorFromResponse(new Response("x", { status: 503 }), "m")).toBeUndefined();
    expect(await rateLimitErrorFromResponse(new Response("x", { status: 500 }), "m")).toBeUndefined();
  });

  it("a malformed, unreadable, or huge body stays a RateLimitError, reading no further than the bound", async () => {
    expect(isQuotaExhaustedError(await rateLimitErrorFromResponse(new Response("{not json", { status: 429 }), "m"))).toBe(false);
    expect(isQuotaExhaustedError(await rateLimitErrorFromResponse(new Response(JSON.stringify({ error: "insufficient_quota" }), { status: 429 }), "m"))).toBe(false);
    // A prose "code" is not an identifier: dropped, so not a match.
    expect(isQuotaExhaustedError(await rateLimitErrorFromResponse(new Response(JSON.stringify({ error: { code: "insufficient quota please" } }), { status: 429 }), "m"))).toBe(false);
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("stream broke");
        },
      }),
      { status: 429 },
    );
    expect(await rateLimitErrorFromResponse(broken, "m")).toMatchObject({ name: "RateLimitError", status: 429 });
    // A huge body (the quota code past the bound): only the bound is pulled.
    const encoder = new TextEncoder();
    const chunk = encoder.encode(" ".repeat(1024));
    let pulled = 0;
    const huge = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"pad":"'));
        },
        pull(controller) {
          pulled += chunk.byteLength;
          if (pulled > 1024 * 1024) {
            controller.enqueue(encoder.encode('","error":{"type":"insufficient_quota"}}'));
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
      }, { highWaterMark: 0 }),
      { status: 429 },
    );
    const error = await rateLimitErrorFromResponse(huge, "m");
    expect(error).toMatchObject({ name: "RateLimitError", status: 429 });
    expect(pulled).toBeLessThanOrEqual(MAX_RATE_LIMIT_BODY_BYTES + chunk.byteLength);
  });

  it("the executor, planner, and typed-decision transports throw it; it is not transient", async () => {
    const edit = await createAiGatewayRestInvoke({ gatewayUrl: "https://gw", gatewayToken: "secret-token", fetchFn: noCredits() })({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
    }).catch((e: unknown) => e);
    expect(isQuotaExhaustedError(edit)).toBe(true);
    expect(isTransientWorkersAiError(edit)).toBe(false);
    expect(String((edit as Error).message)).not.toContain("secret-token");

    const plan = await createAiGatewayPlannerInvoke({ gatewayUrl: "https://gw", gatewayToken: "secret-token", fetchFn: noCredits() })({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "plan" }],
    }).catch((e: unknown) => e);
    expect(plan).toBeInstanceOf(QuotaExhaustedError);
    expect(String((plan as Error).message)).toMatch(/^AI Gateway plan call was refused for gpt-4\.1 \(HTTP 429, credit_balance_exhausted\)/);

    const decision = await createAiGatewayJevInvoke({ accountId: "acct", apiToken: "secret-token", gatewayId: "g", fetchFn: noCredits() })({ state: "s", questions: {} }).catch(
      (e: unknown) => e,
    );
    expect(isQuotaExhaustedError(decision)).toBe(true);
    expect(String((decision as Error).message)).toMatch(/decision call was refused/);

  });
});

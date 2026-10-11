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
  isRateLimitError,
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

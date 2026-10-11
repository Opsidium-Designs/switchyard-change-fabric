/**
 * Rate limits are the provider's limit, not agent behavior: the shared backoff
 * honours Retry-After, else escalates exponentially with jitter within its
 * bounds; calls in flight when it starts extend it without escalating; a call
 * getting through ends the streak; and a streak lasting the window says so
 * honestly. The meter reports rate-limited attempts separately (not billed,
 * not capped). The planner's fall-back banner says when every planner call
 * was rate limited, and --require-model-plan refuses a heuristic plan. A fake
 * clock, fake transports, and a fake plan transport; no network.
 */
import { describe, expect, it } from "vitest";

import { planGoal } from "@switchyard-change/change-core";
import { QuotaExhaustedError, RateLimitError, type AgentTurnInput, type AgentTurnOutcome, type ExecutorContext, type ExecutorProvider } from "@switchyard-change/model-adapters";

import { allPlannerCallsRateLimited, modelPlanRefusal, plannerFallbackBanner, REQUIRE_MODEL_PLAN_FLAG } from "../src/executor-select.ts";
import { RateLimitBackoff, rateLimitedExecutor, rateLimitedTransport, type RateLimitBackoffEvent } from "../src/rate-limit-backoff.ts";
import { meteredExecutor, meteredJev, meteredTransport, RunMeter } from "../src/run-meter.ts";

describe("RateLimitBackoff", () => {
  it("escalates 5 s -> 120 s with jitter inside the bounds, honours Retry-After, and a success ends the streak", () => {
    let now = 0;
    const events: RateLimitBackoffEvent[] = [];
    const backoff = new RateLimitBackoff({ now: () => now, random: () => 0.5, onBackoff: (e) => events.push(e) });
    const delays: number[] = [];
    for (let k = 0; k < 7; k += 1) {
      delays.push(backoff.note({ model: "gpt-4o", status: 429 }));
      expect(backoff.backingOff).toBe(true);
      now += delays.at(-1)!;
      expect(backoff.backingOff).toBe(false);
    }
    // random 0.5 is the midpoint of the jitter (x1.0): the plain doubling, capped at 120 s.
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
    expect(backoff.consecutive).toBe(7);
    expect(events.at(-1)).toMatchObject({ model: "gpt-4o", status: 429, consecutive: 7, limitedForMs: 275_000 });
    // Jitter stays within [base, max].
    const low = new RateLimitBackoff({ now: () => 0, random: () => 0 });
    expect(low.note({ model: "m", status: 429 })).toBe(5_000);
    const high = new RateLimitBackoff({ now: () => 0, random: () => 0.999 });
    expect(high.note({ model: "m", status: 429 })).toBeLessThanOrEqual(6_250);
    // A Retry-After is honoured as given.
    expect(backoff.note({ model: "gpt-4o", status: 429, retryAfterMs: 33_000 })).toBe(33_000);
    backoff.succeeded();
    expect(backoff.limited).toBe(false);
    expect(backoff.backingOff).toBe(false);
    expect(backoff.consecutive).toBe(0);
    expect(backoff.note({ model: "gpt-4o", status: 429 })).toBe(5_000);
  });

  it("a rate limit from a call in flight extends the pause to its Retry-After without escalating", () => {
    let now = 0;
    const backoff = new RateLimitBackoff({ now: () => now, random: () => 0.5 });
    expect(backoff.note({ model: "m", status: 429 })).toBe(5_000);
    now = 1_000;
    // No Retry-After: the pause is unchanged (4 s left).
    expect(backoff.note({ model: "m", status: 429 })).toBe(4_000);
    // A longer Retry-After extends it.
    expect(backoff.note({ model: "m", status: 429, retryAfterMs: 9_000 })).toBe(9_000);
    now = 10_000;
    // The next escalation is the second step, not the fourth.
    expect(backoff.note({ model: "m", status: 429 })).toBe(10_000);
  });

  it("is exceeded once the streak lasts the window, with an honest stop detail", () => {
    let now = 0;
    const backoff = new RateLimitBackoff({ now: () => now, windowMs: 10 * 60 * 1000, random: () => 0.5 });
    backoff.note({ model: "gpt-4o", status: 429 });
    now = 9 * 60 * 1000;
    backoff.note({ model: "gpt-4o", status: 429, retryAfterMs: 20_000 });
    expect(backoff.exceeded).toBe(false);
    now = 10 * 60 * 1000;
    expect(backoff.exceeded).toBe(true);
    expect(backoff.stopDetail()).toBe(
      "the AI Gateway returned HTTP 429 for every call for 10 min (last: gpt-4o, retry-after 20 s; 2 rate-limited call(s)): " +
        "the provider's rate or quota limit; nothing was decided by a model in that window",
    );
    backoff.succeeded();
    expect(backoff.exceeded).toBe(false);
  });

  it("the transport and executor wrappers feed it: a rate limit pauses, anything else ends the streak", async () => {
    const backoff = new RateLimitBackoff({ now: () => 0, random: () => 0.5 });
    const outcomes: AgentTurnOutcome[] = [
      { action: { type: "wait", reason: "429" }, rateLimited: { status: 429, model: "m", retryAfterMs: 7_000 } },
      { action: { type: "wait", reason: "ok" } },
    ];
    const transport = rateLimitedTransport(async () => outcomes.shift()!, backoff);
    await transport({} as AgentTurnInput);
    expect(backoff.remainingMs).toBe(7_000);
    await transport({} as AgentTurnInput);
    expect(backoff.limited).toBe(false);
    const failing: ExecutorProvider = {
      name: "fake",
      execute: async () => {
        throw new RateLimitError("limited", { status: 429, model: "m" });
      },
    };
    await expect(rateLimitedExecutor(failing, backoff).execute({} as ExecutorContext)).rejects.toThrow("limited");
    expect(backoff.limited).toBe(true);
  });
});

describe("an exhausted provider balance (quota-exhausted)", () => {
  it("starts no pause, holds every agent for good, survives a later success, and says so honestly", () => {
    const now = 0;
    const events: RateLimitBackoffEvent[] = [];
    const backoff = new RateLimitBackoff({ now: () => now, random: () => 0.5, onBackoff: (e) => events.push(e) });
    expect(backoff.quotaExhausted).toBe(false);
    expect(backoff.note({ model: "gpt-4o", status: 429, quotaExhausted: "credit_balance_exhausted" })).toBe(0);
    expect(events).toEqual([]);
    expect(backoff.remainingMs).toBe(0);
    expect(backoff.quotaExhausted).toBe(true);
    expect(backoff.backingOff).toBe(true);
    expect(backoff.limited).toBe(true);
    // Not the window: it is not "exceeded" (that is the waited-out rate limit).
    expect(backoff.exceeded).toBe(false);
    // A later refusal on another model does not replace the first one reported.
    backoff.note({ model: "gpt-4.1", status: 429, quotaExhausted: "insufficient_quota" });
    backoff.succeeded();
    expect(backoff.quotaExhausted).toBe(true);
    expect(backoff.quotaStopDetail()).toBe(
      "the provider account has no credits left (credit_balance_exhausted from gpt-4o): add credits and re-run; nothing was decided by a model after it",
    );
  });

  it("the transport and executor wrappers record it from a flagged outcome or a thrown QuotaExhaustedError", async () => {
    const viaTurn = new RateLimitBackoff({ now: () => 0 });
    const transport = rateLimitedTransport(
      async (): Promise<AgentTurnOutcome> => ({ action: { type: "wait", reason: "no credits" }, rateLimited: { status: 429, model: "m", quotaExhausted: "insufficient_quota" } }),
      viaTurn,
    );
    await transport({} as AgentTurnInput);
    expect(viaTurn.quotaExhausted).toBe(true);
    const viaEdit = new RateLimitBackoff({ now: () => 0 });
    const failing: ExecutorProvider = {
      name: "fake",
      execute: async () => {
        throw new QuotaExhaustedError("no credits", { status: 429, model: "gpt-4o", providerCode: "credit_balance_exhausted", providerType: "insufficient_quota" });
      },
    };
    await expect(rateLimitedExecutor(failing, viaEdit).execute({} as ExecutorContext)).rejects.toThrow("no credits");
    expect(viaEdit.quotaExhausted).toBe(true);
    expect(viaEdit.quotaStopDetail()).toContain("(credit_balance_exhausted from gpt-4o)");
    // Metered like any rate limit: an attempt, never a billed call.
    const meter = new RunMeter({});
    await expect(meteredExecutor(failing, meter).execute({ workUnitId: "a" } as ExecutorContext)).rejects.toThrow();
    expect(meter.calls).toBe(0);
    expect(meter.rateLimitedCalls).toBe(1);
  });
});

describe("the meter reports rate-limited attempts separately", () => {
  it("a rate-limited turn, edit, or decision is an attempt: not a billed call, not unpriced, not against the call cap", async () => {
    const meter = new RunMeter({ maxCalls: 1 });
    const turns = meteredTransport(
      async (): Promise<AgentTurnOutcome> => ({ action: { type: "wait", reason: "x" }, invalid: "x", model: "m", rateLimited: { status: 429, model: "m" } }),
      meter,
    );
    await turns({} as AgentTurnInput);
    await turns({} as AgentTurnInput);
    const executor: ExecutorProvider = {
      name: "fake",
      execute: async () => {
        throw Object.assign(new RateLimitError("limited", { status: 429, model: "m" }), {});
      },
    };
    await expect(meteredExecutor(executor, meter).execute({ workUnitId: "a" } as ExecutorContext)).rejects.toThrow();
    await expect(
      meteredJev(async () => {
        throw new RateLimitError("limited", { status: 429, model: "typesafe/jev" });
      }, meter)("s", {}),
    ).rejects.toThrow();
    expect(meter.calls).toBe(0);
    expect(meter.unpricedCalls).toBe(0);
    expect(meter.rateLimitedCalls).toBe(4);
    expect(meter.itemCalls("a")).toBe(0);
    expect(meter.reached()).toBeUndefined();
    expect(meter.describe()).toMatch(/4 rate-limited call attempt\(s\) \(HTTP 429, not billed, not capped\)/);
  });
});

describe("the planner under rate limits", () => {
  it("records a rate-limited ladder model, and the fall-back banner says every planner call was rate limited", async () => {
    const planned = await planGoal({
      goal: "add audit logging",
      repo: [
        { path: "src/a.ts", content: "export const a = 1;\n" },
        { path: "src/b.ts", content: "export const b = 2;\n" },
      ],
      baseModel: "gpt-4o",
      escalationModels: ["gpt-4.1", "gpt-5"],
      plan: async ({ model }) => {
        throw new RateLimitError(`AI Gateway plan call was rate limited for ${model} (HTTP 429, no retry-after)`, { status: 429, model });
      },
    });
    expect(planned.change.plan?.source).toBe("heuristic-fallback");
    expect(planned.diagnostics.map((d) => [d.model, d.rateLimited])).toEqual([
      ["gpt-4o", true],
      ["gpt-4.1", true],
      ["gpt-5", true],
    ]);
    expect(allPlannerCallsRateLimited(planned.diagnostics)).toBe(true);
    const banner = plannerFallbackBanner(planned.diagnostics);
    expect(banner).toContain("All planner calls were rate limited (HTTP 429) on gpt-4o, gpt-4.1, gpt-5");
    expect(banner).toContain("the provider's rate or quota limit, so no model planned this run");
    // A mixed failure is not called a rate limit.
    const mixed = [...planned.diagnostics, { model: "gpt-5", reason: "invalid plan" }];
    expect(allPlannerCallsRateLimited(mixed)).toBe(false);
    expect(plannerFallbackBanner(mixed)).not.toContain("rate limited (HTTP 429) on");
  });

  it("fails fast on an exhausted provider balance: no further ladder model and no heuristic fall-back", async () => {
    const asked: string[] = [];
    const error = await planGoal({
      goal: "add audit logging",
      repo: [
        { path: "src/a.ts", content: "export const a = 1;\n" },
        { path: "src/b.ts", content: "export const b = 2;\n" },
      ],
      baseModel: "gpt-4o",
      escalationModels: ["gpt-4.1", "gpt-5"],
      plan: async ({ model }) => {
        asked.push(model);
        throw new QuotaExhaustedError(`AI Gateway plan call was refused for ${model} (HTTP 429, credit_balance_exhausted)`, {
          status: 429,
          model,
          providerCode: "credit_balance_exhausted",
        });
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(asked).toEqual(["gpt-4o"]);
  });

  it(`${REQUIRE_MODEL_PLAN_FLAG} refuses a heuristic-fallback plan and accepts a model plan`, () => {
    expect(modelPlanRefusal({ source: "planner", diagnostics: [] })).toBeUndefined();
    const limited = modelPlanRefusal({
      source: "heuristic-fallback",
      diagnostics: [{ model: "gpt-4o", reason: "HTTP 429", rateLimited: true }],
    });
    expect(limited).toMatch(/^--require-model-plan: the planner produced no plan \(all planner calls were rate limited \(HTTP 429\)/);
    expect(limited).toContain("Nothing was created");
    const invalid = modelPlanRefusal({ source: "heuristic-fallback", diagnostics: [{ model: "gpt-4o", reason: "invalid plan" }] });
    expect(invalid).toContain("every model in the planner ladder failed to produce a usable plan");
    expect(invalid).toContain("gpt-4o: invalid plan");
  });
});

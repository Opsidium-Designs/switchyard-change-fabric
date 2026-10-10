/**
 * Cost and time caps: the run meter counts every model call, estimates spend
 * from usage and configured prices (an unpriced call is counted, never free),
 * and once a cap is reached the metered transport answers wait WITHOUT
 * calling the model. A fake clock and fake transports; no network.
 */
import { describe, expect, it } from "vitest";

import { executorCallUsage, UnusableModelOutputError, withCallUsage, WorkersAiExecutor } from "@switchyard-change/model-adapters";
import type { AgentTurnInput, AgentTurnOutcome, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";

import { meteredExecutor, meteredJev, meteredToolAuthor, meteredTransport, parsePrice, parsePrices, RunMeter, validateSpendCap } from "../src/run-meter.ts";

describe("RunMeter", () => {
  it("estimates spend from tokens x the configured price, else the executor's own cost; counts the rest as unpriced", () => {
    const meter = new RunMeter({ prices: { "gpt-x": { inputPerMTok: 2, outputPerMTok: 8 } } });
    meter.count({ model: "gpt-x", inputTokens: 500_000, outputTokens: 100_000 });
    meter.count({ usd: 0.25 });
    meter.count({ model: "unknown-model", inputTokens: 10 });
    expect(meter.calls).toBe(3);
    expect(meter.spendUsd).toBeCloseTo(1 + 0.8 + 0.25, 6);
    expect(meter.unpricedCalls).toBe(1);
    expect(meter.describe()).toMatch(/no call cap \(used 3\), no spend cap \(2\.0500 USD estimated \(\+1 unpriced call\(s\)\)\)/);
  });

  it("reports the cap reached: model calls, spend, wall clock (on its own clock), and calls per item", () => {
    let now = 1_000;
    const meter = new RunMeter({ maxCalls: 2, maxSpendUsd: 1, maxWallMs: 60_000, maxCallsPerItem: 1 }, () => now);
    expect(meter.reached()).toBeUndefined();
    meter.count({ usd: 0.5, item: "one" });
    expect(meter.itemReached("one")).toBeUndefined();
    meter.noteItem("one");
    expect(meter.itemReached("one")).toEqual({ kind: "item-calls", limit: 1, used: 2, item: "one" });
    meter.count({ usd: 0.6 });
    expect(meter.reached()).toEqual({ kind: "model-calls", limit: 2, used: 2 });
    const spend = new RunMeter({ maxSpendUsd: 1 }, () => now);
    spend.count({ usd: 1.5 });
    expect(spend.reached()).toEqual({ kind: "spend", limit: 1, used: 1.5 });
    const wall = new RunMeter({ maxWallMs: 60_000 }, () => now);
    now += 60_000;
    expect(wall.reached()).toEqual({ kind: "wall-clock", limit: 60_000, used: 60_000 });
  });

  it("the metered transport stops calling the model once a cap is reached; the metered executor counts usage per item", async () => {
    const meter = new RunMeter({ maxCalls: 2 });
    let calls = 0;
    const transport = meteredTransport(async (): Promise<AgentTurnOutcome> => {
      calls += 1;
      return { action: { type: "wait", reason: "thinking" }, model: "m", inputTokens: 10, outputTokens: 5 };
    }, meter);
    const input = {} as AgentTurnInput;
    await transport(input);
    const executor: ExecutorProvider = {
      name: "fake",
      execute: async () => ({ status: "changed", changedPaths: ["a"], logs: [], cost: { usd: 0, inputTokens: 100, outputTokens: 20, model: "m" }, commitMessage: "e" }),
    };
    await meteredExecutor(executor, meter).execute({ workUnitId: "item-a", paths: [], worktreeDir: "/tmp", objective: "o", baselineRef: "HEAD" } as ExecutorContext);
    expect(meter.calls).toBe(2);
    expect(meter.itemCalls("item-a")).toBe(1);
    const capped = await transport(input);
    expect(calls).toBe(1);
    expect(capped.action).toEqual({ type: "wait", reason: "the run reached its model-calls cap (2 of 2): no new turns" });
  });
});

describe("metering gaps: failed edits, retries, tool authoring, decisions", () => {
  const context = { workUnitId: "item-a", paths: [], worktreeDir: "/tmp", objective: "o", baselineRef: "HEAD", model: "m" } as unknown as ExecutorContext;

  it("an edit that throws counts the calls the executor attached (or one unpriced call); retries on success count each attempt", async () => {
    const meter = new RunMeter({ prices: { m: { inputPerMTok: 1, outputPerMTok: 1 } } });
    const unusable: ExecutorProvider = {
      name: "unusable",
      execute: async () => {
        throw withCallUsage(new UnusableModelOutputError("no usable edit"), { model: "m", attempts: 2, inputTokens: 1_000_000 });
      },
    };
    await expect(meteredExecutor(unusable, meter).execute(context)).rejects.toThrow(/no usable edit/);
    expect(meter.calls).toBe(2);
    expect(meter.spendUsd).toBeCloseTo(1, 6);
    expect(meter.unpricedCalls).toBe(1);
    const bare: ExecutorProvider = { name: "bare", execute: async () => Promise.reject(new Error("boom")) };
    await expect(meteredExecutor(bare, meter).execute(context)).rejects.toThrow("boom");
    expect(meter.calls).toBe(3);
    expect(meter.unpricedCalls).toBe(2);
    const retried: ExecutorProvider = {
      name: "retried",
      execute: async () => ({ status: "changed", changedPaths: ["a"], logs: [], cost: { usd: 0, inputTokens: 10, outputTokens: 5, model: "m", attempts: 3 }, commitMessage: "e" }),
    };
    await meteredExecutor(retried, meter).execute(context);
    expect(meter.calls).toBe(6);
    expect(meter.itemCalls("item-a")).toBe(6);
  });

  it("the Workers AI executor reports its attempts on success and attaches them to an unusable reply", async () => {
    let calls = 0;
    const flaky = new WorkersAiExecutor({
      model: "m",
      retryBackoffMs: 0,
      readScopedFiles: async () => [{ path: "a.ts", contents: "const a = 1;\n" }],
      writeFile: async () => undefined,
      invoke: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("AI Gateway call failed (HTTP 500)");
        }
        return { text: calls === 2 ? "not an edit" : "", usage: { inputTokens: 7, outputTokens: 3 } };
      },
    });
    const error = await flaky.execute(context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableModelOutputError);
    expect(executorCallUsage(error)).toEqual({ model: "m", attempts: 2, inputTokens: 7, outputTokens: 3 });
  });

  it("meteredToolAuthor counts a model-backed author's usage against the tool item and refuses past a cap; a template author counts nothing", async () => {
    const meter = new RunMeter({ maxCalls: 2 });
    const request = { agent: "w", capability: "scan", kind: "scanner", inputs: [], outputs: [], worktreeDir: "/tmp", projectDir: "/tmp" } as const;
    await meteredToolAuthor(async () => undefined, meter)(request);
    expect(meter.calls).toBe(0);
    await meteredToolAuthor(async () => ({ model: "m", attempts: 1, inputTokens: 1, outputTokens: 1 }), meter)(request);
    expect(meter.calls).toBe(1);
    expect(meter.itemCalls("tool-scan")).toBe(1);
    await expect(meteredToolAuthor(async () => Promise.reject(new Error("bad fill")), meter)(request)).rejects.toThrow("bad fill");
    expect(meter.calls).toBe(2);
    await expect(meteredToolAuthor(async () => undefined, meter)(request)).rejects.toThrow(/model-calls cap .*: no tool authoring/);
  });

  it("meteredJev counts each ask (unpriced, never free) even when it fails, and refuses past a cap", async () => {
    const meter = new RunMeter({ maxCalls: 2, maxSpendUsd: 5 });
    const ask = meteredJev(async () => ({ pick: { type: "choice", choice: "a", confidence: 0.9 } }), meter, "jev-model");
    await ask("state", {});
    await expect(meteredJev(async () => Promise.reject(new Error("transport")), meter, "jev-model")("s", {})).rejects.toThrow("transport");
    expect(meter.calls).toBe(2);
    expect(meter.unpricedCalls).toBe(2);
    expect(meter.warnings).toEqual([expect.stringMatching(/unpriced model call \(jev-model\) under the 5 USD spend cap/)]);
    await expect(ask("state", {})).rejects.toThrow(/cap .*: no decision call/);
    expect(meter.calls).toBe(2);
  });
});

describe("spend cap honesty", () => {
  it("parsePrice accepts finite non-negative amounts and refuses malformed, non-finite, and duplicate prices", () => {
    expect(parsePrice("gpt-x=2/8")).toEqual({ model: "gpt-x", price: { inputPerMTok: 2, outputPerMTok: 8 } });
    expect(parsePrices(["a=0/0.5", "b=1.25/10"])).toEqual({ a: { inputPerMTok: 0, outputPerMTok: 0.5 }, b: { inputPerMTok: 1.25, outputPerMTok: 10 } });
    for (const bad of ["a=1.2.3/4", "a=1/", "a=-1/2", "a=Infinity/1", "a=NaN/1", "=1/2", "a=1/2/3", "a 1/2"]) {
      expect(() => parsePrice(bad), bad).toThrow(/--price/);
    }
    expect(() => parsePrices(["a=1/2", "a=3/4"])).toThrow(/more than once/);
  });

  it("validateSpendCap names every configured model without a usable price", () => {
    const prices = { a: { inputPerMTok: 1, outputPerMTok: 2 }, bad: { inputPerMTok: Number.NaN, outputPerMTok: 1 } };
    expect(validateSpendCap(["a", "b", "bad", "a"], prices)).toEqual(["b", "bad"]);
    expect(validateSpendCap(["a"], prices)).toEqual([]);
    expect(validateSpendCap(["toString"], {})).toEqual(["toString"]);
  });

  it("never adds NaN: non-finite usage or prices count the call as unpriced, and an unpriced call under a spend cap is a recorded warning", () => {
    const warnings: string[] = [];
    const meter = new RunMeter({ maxSpendUsd: 1, prices: { m: { inputPerMTok: Number.NaN, outputPerMTok: 1 }, ok: { inputPerMTok: 1, outputPerMTok: 1 } } });
    meter.onWarning = (w) => warnings.push(w);
    meter.count({ model: "m", inputTokens: 10 });
    meter.count({ model: "ok", inputTokens: Number.POSITIVE_INFINITY });
    meter.count({ model: "ok", inputTokens: -5 });
    meter.count({ usd: Number.NaN });
    expect(Number.isFinite(meter.spendUsd)).toBe(true);
    expect(meter.spendUsd).toBe(0);
    expect(meter.unpricedCalls).toBe(4);
    expect(warnings).toHaveLength(3);
    expect(meter.describe()).toMatch(/the spend cap does not bound the unpriced calls/);
    expect(meter.reached()).toBeUndefined();
  });
});

/**
 * Cost and time caps: the run meter counts every model call, estimates spend
 * from usage and configured prices (an unpriced call is counted, never free),
 * and once a cap is reached the metered transport answers wait WITHOUT
 * calling the model. A fake clock and fake transports; no network.
 */
import { describe, expect, it } from "vitest";

import type { AgentTurnInput, AgentTurnOutcome, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";

import { meteredExecutor, meteredTransport, RunMeter } from "../src/run-meter.ts";

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

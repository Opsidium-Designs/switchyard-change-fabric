/**
 * The shared in-flight bound on a run's model calls: never more than the limit
 * at once, queued calls served in arrival order, a nested call on a held slot
 * never deadlocks, and a slot is released on a return, a throw, or an abort.
 */
import { describe, expect, it } from "vitest";

import type { AgentTurnTransport, ExecutorProvider } from "@switchyard-change/model-adapters";

import {
  defaultMaxInflight,
  InflightAbortedError,
  InflightLimiter,
  limitedExecutor,
  limitedTransport,
  MAX_INFLIGHT,
  validMaxInflight,
} from "../src/inflight-limiter.ts";

/** A promise with its resolver, for calls the test finishes by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("InflightLimiter", () => {
  it("bounds the limit and its default", () => {
    expect(defaultMaxInflight(3)).toBe(3);
    expect(defaultMaxInflight(30)).toBe(8);
    expect(defaultMaxInflight(0)).toBe(1);
    expect(validMaxInflight(1)).toBe(true);
    expect(validMaxInflight(MAX_INFLIGHT)).toBe(true);
    expect(validMaxInflight(0)).toBe(false);
    expect(validMaxInflight(MAX_INFLIGHT + 1)).toBe(false);
    expect(validMaxInflight(2.5)).toBe(false);
    expect(() => new InflightLimiter(0)).toThrow(/from 1 to 64/);
  });

  it("never runs more than the limit at once and serves queued calls first in, first out", async () => {
    let clock = 0;
    const limiter = new InflightLimiter(2, () => clock);
    const gates = Array.from({ length: 5 }, gate);
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const calls = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
        return i;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.waiting).toBe(3);
    clock = 100;
    // Finish out of order: the freed slots still go to the oldest waiters.
    gates[1]!.open();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.open();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    for (const g of gates) g.open();
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    const stats = limiter.stats();
    expect(stats).toMatchObject({ max: 2, peak: 2, calls: 5, queuedCalls: 3 });
    expect(stats.queuedWaitMs).toBe(300);
    expect(limiter.inFlight).toBe(0);
  });

  it("runs a nested call on the slot its caller holds (no deadlock at limit 1)", async () => {
    const limiter = new InflightLimiter(1);
    const order: string[] = [];
    const result = await limiter.run(async () => {
      order.push("outer");
      // An executor call made inside a turn, a decision inside the planner: same path, same slot.
      const inner = await limiter.run(async () => {
        order.push("inner");
        return "inner done";
      });
      return `${inner}, outer done`;
    });
    expect(result).toBe("inner done, outer done");
    expect(order).toEqual(["outer", "inner"]);
    expect(limiter.stats()).toMatchObject({ peak: 1, calls: 1, queuedCalls: 0 });
  });

  it("a nested call does not let a concurrent caller past the limit", async () => {
    const limiter = new InflightLimiter(1);
    const held = gate();
    let otherRan = false;
    const outer = limiter.run(async () => {
      await held.promise;
      await limiter.run(async () => undefined);
    });
    const other = limiter.run(async () => {
      otherRan = true;
    });
    await tick();
    expect(otherRan).toBe(false);
    held.open();
    await Promise.all([outer, other]);
    expect(otherRan).toBe(true);
    expect(limiter.stats().peak).toBe(1);
  });

  it("releases the slot when the call throws", async () => {
    const limiter = new InflightLimiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error("model failed")))).rejects.toThrow("model failed");
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("an aborted waiter leaves the queue without a slot; the others keep their order", async () => {
    const limiter = new InflightLimiter(1);
    const held = gate();
    const first = limiter.run(() => held.promise);
    const controller = new AbortController();
    const aborted = limiter.run(async () => "never", controller.signal);
    const third = limiter.run(async () => "third");
    await tick();
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(InflightAbortedError);
    expect(limiter.waiting).toBe(1);
    held.open();
    await first;
    await expect(third).resolves.toBe("third");
    expect(limiter.inFlight).toBe(0);
    // Already aborted: refused at once, nothing taken.
    await expect(limiter.run(async () => "late", controller.signal)).rejects.toBeInstanceOf(InflightAbortedError);
    expect(limiter.inFlight).toBe(0);
  });

  it("a raised limit lets queued calls in at once", async () => {
    const limiter = new InflightLimiter(1);
    const held = gate();
    const started: number[] = [];
    const calls = [0, 1, 2].map((i) =>
      limiter.run(async () => {
        started.push(i);
        await held.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0]);
    limiter.setLimit(3);
    await tick();
    expect(started).toEqual([0, 1, 2]);
    held.open();
    await Promise.all(calls);
  });

  it("a turn still queued when the agent phase ends is answered wait without calling the model; an edit is refused", async () => {
    const limiter = new InflightLimiter(1);
    const held = gate();
    let modelCalls = 0;
    const transport: AgentTurnTransport = async () => {
      modelCalls += 1;
      await held.promise;
      return { action: { type: "wait", reason: "model" } };
    };
    const executor: ExecutorProvider = {
      name: "fake",
      async execute() {
        modelCalls += 1;
        return { status: "changed", changedPaths: [], logs: [], cost: { usd: 0 }, commitMessage: "none" };
      },
    };
    const controller = new AbortController();
    const turns = limitedTransport(transport, limiter, controller.signal);
    const edits = limitedExecutor(executor, limiter, controller.signal);
    const first = turns({} as never);
    const queuedTurn = turns({} as never);
    const queuedEdit = edits.execute({ worktreeDir: "/nowhere", workUnitId: "i", objective: "o", paths: [], baselineRef: "HEAD" });
    await tick();
    controller.abort();
    await expect(queuedTurn).resolves.toMatchObject({ action: { type: "wait", reason: expect.stringMatching(/waited for a model-call slot/) } });
    await expect(queuedEdit).rejects.toBeInstanceOf(InflightAbortedError);
    held.open();
    await first;
    expect(modelCalls).toBe(1);
  });
});

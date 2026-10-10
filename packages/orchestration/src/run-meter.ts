/**
 * run-meter: engine-enforced cost and time caps for a board run (demo
 * safety).
 *
 * The meter counts every model call the run makes (agent turns, executor
 * edits, the planner) and estimates spend: tokens times the configured price
 * per model when a call reports usage and a price is configured, else the
 * executor's own cost estimate when it reports one; a call with neither is
 * counted as UNPRICED, never as free. Caps: total model calls, estimated spend
 * in USD, the run's wall-clock time, and calls per item (across agents).
 *
 * Reaching a run cap stops new turns (the metered transport answers `wait`
 * without calling the model); the driver records `run.capped` once per cap,
 * lets the integrator finish what is in flight, and ends with an honest
 * verdict. An item at its cap gets no more turns. The clock is injected.
 */

import type { AgentTurnTransport, ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";

/** USD per million tokens for one model. */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** The caps of a run (absent: no cap of that kind). */
export interface RunCaps {
  readonly maxCalls?: number;
  readonly maxSpendUsd?: number;
  readonly maxWallMs?: number;
  readonly maxCallsPerItem?: number;
  /** Prices per model id, for the spend estimate. */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
}

/** A cap the run reached. */
export interface RunCapReached {
  readonly kind: "model-calls" | "spend" | "wall-clock" | "item-calls";
  readonly limit: number;
  readonly used: number;
  readonly item?: string;
}

/** Counts calls and spend against a run's caps (see the module comment). */
export class RunMeter {
  calls = 0;
  spendUsd = 0;
  /** Calls with no usage and no price (their spend is unknown, never zero). */
  unpricedCalls = 0;
  private readonly perItem = new Map<string, number>();
  private readonly started: number;

  constructor(
    /** The caps (the driver sets the plan-scaled defaults once the plan is known). */
    public caps: RunCaps,
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
  }

  /** Milliseconds since the run started (on the meter's clock). */
  get elapsedMs(): number {
    return this.now() - this.started;
  }

  /** Count one model call, its usage (and model) when known, and the item it was for. */
  count(call: { readonly model?: string; readonly inputTokens?: number; readonly outputTokens?: number; readonly usd?: number; readonly item?: string }): void {
    this.calls += 1;
    const price = call.model !== undefined ? this.caps.prices?.[call.model] : undefined;
    if (price && (call.inputTokens !== undefined || call.outputTokens !== undefined)) {
      this.spendUsd += ((call.inputTokens ?? 0) * price.inputPerMTok + (call.outputTokens ?? 0) * price.outputPerMTok) / 1_000_000;
    } else if (call.usd !== undefined && call.usd > 0) {
      this.spendUsd += call.usd;
    } else {
      this.unpricedCalls += 1;
    }
    if (call.item !== undefined) {
      this.perItem.set(call.item, (this.perItem.get(call.item) ?? 0) + 1);
    }
  }

  /** Attribute one already counted call to an item (a turn whose action is about it). */
  noteItem(item: string): void {
    this.perItem.set(item, (this.perItem.get(item) ?? 0) + 1);
  }

  /** Calls counted for one item. */
  itemCalls(item: string): number {
    return this.perItem.get(item) ?? 0;
  }

  /** The run cap reached now (calls, spend, wall clock), or undefined. */
  reached(): RunCapReached | undefined {
    const c = this.caps;
    if (c.maxCalls !== undefined && this.calls >= c.maxCalls) {
      return { kind: "model-calls", limit: c.maxCalls, used: this.calls };
    }
    if (c.maxSpendUsd !== undefined && this.spendUsd >= c.maxSpendUsd) {
      return { kind: "spend", limit: c.maxSpendUsd, used: Math.round(this.spendUsd * 1e6) / 1e6 };
    }
    if (c.maxWallMs !== undefined && this.elapsedMs >= c.maxWallMs) {
      return { kind: "wall-clock", limit: c.maxWallMs, used: this.elapsedMs };
    }
    return undefined;
  }

  /** The item cap `item` is over (more calls than its limit), or undefined. */
  itemReached(item: string): RunCapReached | undefined {
    const limit = this.caps.maxCallsPerItem;
    const used = this.itemCalls(item);
    return limit !== undefined && used > limit ? { kind: "item-calls", limit, used, item } : undefined;
  }

  /** One line for the budgets summary. */
  describe(): string {
    const c = this.caps;
    const spend = `${this.spendUsd.toFixed(4)} USD estimated${this.unpricedCalls > 0 ? ` (+${this.unpricedCalls} unpriced call(s))` : ""}`;
    return (
      `caps: ${c.maxCalls !== undefined ? `${c.maxCalls} model call(s)` : "no call cap"} (used ${this.calls}), ` +
      `${c.maxSpendUsd !== undefined ? `${c.maxSpendUsd} USD` : "no spend cap"} (${spend}), ` +
      `${c.maxWallMs !== undefined ? `${Math.round(c.maxWallMs / 1000)} s wall clock` : "no wall-clock cap"}, ` +
      `${c.maxCallsPerItem !== undefined ? `${c.maxCallsPerItem} call(s) per item` : "no per-item cap"}`
    );
  }
}

/**
 * A turn transport that counts every call on the meter and, once a run cap is
 * reached, answers `wait` WITHOUT calling the model (no new turns).
 */
export function meteredTransport<D, M>(transport: AgentTurnTransport<D, M>, meter: RunMeter): AgentTurnTransport<D, M> {
  return async (input) => {
    const capped = meter.reached();
    if (capped !== undefined) {
      return { action: { type: "wait", reason: `the run reached its ${capped.kind} cap (${capped.used} of ${capped.limit}): no new turns` } };
    }
    const outcome = await transport(input);
    meter.count({
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
    });
    return outcome;
  };
}

/** An executor that counts every edit (a model call) on the meter, with its usage and cost when reported. */
export function meteredExecutor(executor: ExecutorProvider, meter: RunMeter): ExecutorProvider {
  return {
    name: executor.name,
    async execute(context: ExecutorContext): Promise<ExecutionResult> {
      const result = await executor.execute(context);
      meter.count({
        ...(result.cost.model !== undefined ? { model: result.cost.model } : context.model !== undefined ? { model: context.model } : {}),
        ...(result.cost.inputTokens !== undefined ? { inputTokens: result.cost.inputTokens } : {}),
        ...(result.cost.outputTokens !== undefined ? { outputTokens: result.cost.outputTokens } : {}),
        usd: result.cost.usd,
        item: context.workUnitId,
      });
      return result;
    },
  };
}

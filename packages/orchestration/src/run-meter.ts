/**
 * run-meter: engine-enforced cost and time caps for a board run (demo
 * safety).
 *
 * The meter counts every model call the run makes that is routed through
 * one of its wrappers: agent turns (`meteredTransport`), executor edits
 * (`meteredExecutor`, every paid attempt: a transient retry counts, and an
 * edit that throws counts the calls it made, at least one), tool authoring
 * (`meteredToolAuthor`), typed decisions (`meteredJev`), and the planner
 * (counted by the driver). It estimates spend: tokens times the configured
 * price per model when a call reports usage and a price is configured, else
 * the executor's own cost estimate when it reports one; a call with neither
 * is counted as UNPRICED, never as free, and under an active spend cap each
 * unpriced model is recorded as a warning (the cap cannot see that spend;
 * `validateSpendCap` lets a caller refuse such a cap up front). Non-finite or
 * negative usage or prices are never added (the call is unpriced instead).
 * Caps: total model calls, estimated spend in USD, the run's wall-clock time,
 * and calls per item (across agents).
 *
 * Reaching a run cap stops new turns (the metered transport answers `wait`
 * without calling the model; the metered tool author and decision caller
 * refuse); the driver records `run.capped` once per cap, lets the integrator
 * finish what is in flight, and ends with an honest verdict. An item at its
 * cap gets no more turns. The clock is injected.
 */

import {
  executorCallUsage,
  type AgentTurnTransport,
  type AskJev,
  type ExecutionResult,
  type ExecutorCallUsage,
  type ExecutorContext,
  type ExecutorProvider,
} from "@switchyard-change/model-adapters";
import { toolItemId } from "@switchyard-change/change-core";

import type { ToolAuthor } from "./board-tools.ts";

/** USD per million tokens for one model. */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** A finite, non-negative number (a usable price or token count). */
function usable(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/**
 * Parse one `<model>=<input USD per Mtok>/<output USD per Mtok>` price (the
 * CLI's `--price`). Both amounts must be finite and non-negative; a model
 * already in `existing` is refused (one price per model). Throws with the
 * reason otherwise.
 */
export function parsePrice(spec: string, existing: Readonly<Record<string, ModelPrice>> = {}): { readonly model: string; readonly price: ModelPrice } {
  const match = /^([^=\s]+)=([^/\s]+)\/([^/\s]+)$/.exec(spec.trim());
  if (!match) {
    throw new Error(`--price must be <model>=<input USD per Mtok>/<output USD per Mtok> (got ${JSON.stringify(spec)})`);
  }
  const model = match[1]!;
  const amount = (raw: string, which: string): number => {
    const value = /^[0-9]+(\.[0-9]+)?$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`--price ${model}: the ${which} price must be a finite, non-negative number (got ${JSON.stringify(raw)})`);
    }
    return value;
  };
  const price = { inputPerMTok: amount(match[2]!, "input"), outputPerMTok: amount(match[3]!, "output") };
  if (Object.prototype.hasOwnProperty.call(existing, model)) {
    throw new Error(`--price ${model} is given more than once`);
  }
  return { model, price };
}

/** Parse every `--price` spec (duplicates and invalid amounts refused). */
export function parsePrices(specs: readonly string[]): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const spec of specs) {
    const { model, price } = parsePrice(spec, out);
    out[model] = price;
  }
  return out;
}

/**
 * The configured models with no usable price. A spend cap is only honest when
 * this is empty: an unpriced call's spend is unknown, so a caller should
 * refuse `--max-spend-usd` unless every model the run uses has a price.
 */
export function validateSpendCap(models: readonly string[], prices: Readonly<Record<string, ModelPrice>> = {}): string[] {
  const out = new Set<string>();
  for (const model of models) {
    const price = Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined;
    if (!price || !usable(price.inputPerMTok) || !usable(price.outputPerMTok)) {
      out.add(model);
    }
  }
  return [...out].sort();
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
  /** Warnings recorded while counting (an unpriced model under an active spend cap), once each. */
  readonly warnings: string[] = [];
  /** Called once per new warning (the driver may record it on the board). */
  onWarning?: (warning: string) => void;
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
    const prices = this.caps.prices;
    const price = call.model !== undefined && prices && Object.prototype.hasOwnProperty.call(prices, call.model) ? prices[call.model] : undefined;
    const tokens = call.inputTokens !== undefined || call.outputTokens !== undefined;
    const tokenCost =
      price && tokens && usable(price.inputPerMTok) && usable(price.outputPerMTok) && (call.inputTokens === undefined || usable(call.inputTokens)) && (call.outputTokens === undefined || usable(call.outputTokens))
        ? ((call.inputTokens ?? 0) * price.inputPerMTok + (call.outputTokens ?? 0) * price.outputPerMTok) / 1_000_000
        : undefined;
    if (tokenCost !== undefined && Number.isFinite(tokenCost)) {
      this.spendUsd += tokenCost;
    } else if (usable(call.usd) && call.usd > 0) {
      this.spendUsd += call.usd;
    } else {
      this.unpricedCalls += 1;
      if (this.caps.maxSpendUsd !== undefined) {
        this.warn(
          `an unpriced model call (${call.model ?? "model unknown"}) under the ${this.caps.maxSpendUsd} USD spend cap: its spend is unknown and not in the estimate, so the cap does not bound it`,
        );
      }
    }
    if (call.item !== undefined) {
      this.perItem.set(call.item, (this.perItem.get(call.item) ?? 0) + 1);
    }
  }

  /** Count the model calls one step made (its attempts; the usage belongs to the successful one). */
  countUsage(usage: ExecutorCallUsage & { readonly usd?: number }, item?: string): void {
    const attempts = Math.max(1, Number.isFinite(usage.attempts) ? Math.floor(usage.attempts) : 1);
    this.count({
      ...(usage.model !== undefined ? { model: usage.model } : {}),
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.usd !== undefined ? { usd: usage.usd } : {}),
      ...(item !== undefined ? { item } : {}),
    });
    for (let i = 1; i < attempts; i += 1) {
      // The failed attempts before the successful one: paid, usage unknown.
      this.count({ ...(usage.model !== undefined ? { model: usage.model } : {}), ...(item !== undefined ? { item } : {}) });
    }
  }

  private warn(warning: string): void {
    if (!this.warnings.includes(warning)) {
      this.warnings.push(warning);
      this.onWarning?.(warning);
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
    const spend =
      `${this.spendUsd.toFixed(4)} USD estimated${this.unpricedCalls > 0 ? ` (+${this.unpricedCalls} unpriced call(s))` : ""}` +
      `${c.maxSpendUsd !== undefined && this.unpricedCalls > 0 ? "; the spend cap does not bound the unpriced calls" : ""}`;
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
    let outcome;
    try {
      outcome = await transport(input);
    } catch (error) {
      // A transport that throws may still have made (paid) calls: at least one counts.
      meter.countUsage(executorCallUsage(error) ?? { attempts: 1 });
      throw error;
    }
    meter.count({
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
    });
    return outcome;
  };
}

/**
 * An executor that counts every model call an edit makes on the meter: each
 * paid attempt (`cost.attempts`, a transient retry counts), with the usage and
 * cost when reported. An edit that THROWS counts the calls the executor
 * attached to the error (`executorCallUsage`), else one unpriced call: a
 * failed edit is never free.
 */
export function meteredExecutor(executor: ExecutorProvider, meter: RunMeter): ExecutorProvider {
  return {
    name: executor.name,
    async execute(context: ExecutorContext): Promise<ExecutionResult> {
      let result: ExecutionResult;
      try {
        result = await executor.execute(context);
      } catch (error) {
        const usage = executorCallUsage(error);
        meter.countUsage(
          usage !== undefined
            ? { ...usage, ...(usage.model === undefined && context.model !== undefined ? { model: context.model } : {}) }
            : { attempts: 1, ...(context.model !== undefined ? { model: context.model } : {}) },
          context.workUnitId,
        );
        throw error;
      }
      const model = result.cost.model ?? context.model;
      meter.countUsage(
        {
          attempts: result.cost.attempts ?? 1,
          ...(model !== undefined ? { model } : {}),
          ...(result.cost.inputTokens !== undefined ? { inputTokens: result.cost.inputTokens } : {}),
          ...(result.cost.outputTokens !== undefined ? { outputTokens: result.cost.outputTokens } : {}),
          usd: result.cost.usd,
        },
        context.workUnitId,
      );
      return result;
    },
  };
}

/**
 * A tool author whose model calls are counted on the meter (attributed to the
 * tool's item): the usage a model-backed author returns, or attaches to the
 * error it throws; an author that throws without usage counts one unpriced
 * call (conservative). A template author (returns nothing) counts nothing.
 * Past a run cap it refuses before authoring. Wrap only an author that does
 * NOT call the already metered executor (`executorToolAuthor` is counted by
 * the metered executor it is given).
 */
export function meteredToolAuthor(author: ToolAuthor, meter: RunMeter): ToolAuthor {
  return async (request) => {
    const capped = meter.reached();
    if (capped !== undefined) {
      throw new Error(`the run reached its ${capped.kind} cap (${capped.used} of ${capped.limit}): no tool authoring`);
    }
    const item = toolItemId(request.capability);
    let usage;
    try {
      usage = await author(request);
    } catch (error) {
      meter.countUsage(executorCallUsage(error) ?? { attempts: 1 }, item);
      throw error;
    }
    if (usage) {
      meter.countUsage(usage, item);
    }
    return usage;
  };
}

/**
 * A typed-decision caller whose every ask is counted on the meter as one
 * model call (the decision transport reports no token usage, so it is
 * counted as unpriced; `model` labels it). Past a run cap
 * it refuses (throws) before calling: the decision layer is advisory, so the
 * refusal is recorded as a decision error and the mechanical result stands.
 */
export function meteredJev(ask: AskJev, meter: RunMeter, model?: string): AskJev {
  return async (state, questions) => {
    const capped = meter.reached();
    if (capped !== undefined) {
      throw new Error(`the run reached its ${capped.kind} cap (${capped.used} of ${capped.limit}): no decision call`);
    }
    try {
      return await ask(state, questions);
    } finally {
      meter.count(model !== undefined ? { model } : {});
    }
  };
}

/**
 * model-budget: the per-model completion-token ceiling and reasoning effort the
 * AI Gateway transports send.
 *
 * A reasoning model (gpt-5, the o-series, deepseek-r1, qwq) spends hidden
 * reasoning tokens against `max_completion_tokens` before it writes any reply.
 * A flat ceiling sized for a non-reasoning model can be spent entirely on
 * reasoning, so the reply comes back empty with `finish_reason: "length"`. Each
 * transport therefore picks its ceiling per model: a reasoning model gets a much
 * larger ceiling plus an explicit `reasoning_effort`, and a non-reasoning model
 * gets a ceiling sized for its reply (it never receives `reasoning_effort`,
 * which non-reasoning models reject).
 *
 * The ceilings are defaults; a caller (the environment, via executor-select)
 * may override the reasoning and non-reasoning ceilings separately, so one
 * override can never push a non-reasoning model past its output limit.
 */

/** Model ids treated as reasoning models (their reasoning counts against the completion ceiling). */
const REASONING_MODEL = /(^|[/:])(o\d+(-[a-z]+)?|gpt-5[\w.-]*|deepseek-r1[\w.-]*|qwq[\w.-]*)$|reason|think/i;

/** True when `model` is a reasoning model whose hidden reasoning spends the completion ceiling. */
export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL.test(model);
}

/** The reasoning effort a reasoning model is asked for (OpenAI `reasoning_effort`). */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** The executor (edit) ceiling for a non-reasoning model: a whole anchored edit must fit. */
export const DEFAULT_EXECUTOR_MAX_TOKENS = 8192;
/** The executor (edit) ceiling for a reasoning model: reasoning plus the whole edit. */
export const DEFAULT_REASONING_EXECUTOR_MAX_TOKENS = 32768;
/** The executor's reasoning effort: an anchored edit needs little deliberation. */
export const EXECUTOR_REASONING_EFFORT: ReasoningEffort = "low";
/** The planner ceiling for a reasoning model (the non-reasoning ceiling is DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS). */
export const DEFAULT_REASONING_PLANNER_MAX_TOKENS = 16384;
/** The planner's reasoning effort: a decomposition benefits from more deliberation than an edit. */
export const PLANNER_REASONING_EFFORT: ReasoningEffort = "medium";

/** The completion budget one call sends: the ceiling, plus the effort for a reasoning model. */
export interface ModelBudget {
  readonly maxTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
}

/** Separate ceilings for reasoning and non-reasoning models (each a positive integer). */
export interface ModelBudgetCeilings {
  readonly maxTokens?: number;
  readonly reasoningMaxTokens?: number;
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The budget for one call on `model`: a reasoning model gets `reasoningMaxTokens`
 * (else `reasoningDefault`) and `effort`; any other model gets `maxTokens` (else
 * `defaultMaxTokens`) and no effort. A non-positive or non-integer override is
 * ignored rather than sent.
 */
export function modelBudget(
  model: string,
  defaults: { readonly maxTokens: number; readonly reasoningMaxTokens: number; readonly effort: ReasoningEffort },
  ceilings: ModelBudgetCeilings = {},
): ModelBudget {
  if (isReasoningModel(model)) {
    return {
      maxTokens: positive(ceilings.reasoningMaxTokens) ?? defaults.reasoningMaxTokens,
      reasoningEffort: defaults.effort,
    };
  }
  return { maxTokens: positive(ceilings.maxTokens) ?? defaults.maxTokens };
}

/** The executor (edit) budget for `model`. */
export function executorModelBudget(model: string, ceilings: ModelBudgetCeilings = {}): ModelBudget {
  return modelBudget(
    model,
    {
      maxTokens: DEFAULT_EXECUTOR_MAX_TOKENS,
      reasoningMaxTokens: DEFAULT_REASONING_EXECUTOR_MAX_TOKENS,
      effort: EXECUTOR_REASONING_EFFORT,
    },
    ceilings,
  );
}

/**
 * Parse a token-ceiling environment value: a positive integer of at most seven
 * digits, else undefined (so a typo falls back to the per-model default rather
 * than sending a bad ceiling).
 */
export function parseTokenCeiling(raw: string | undefined): number | undefined {
  const value = (raw ?? "").trim();
  return /^[1-9][0-9]{0,6}$/.test(value) ? Number(value) : undefined;
}

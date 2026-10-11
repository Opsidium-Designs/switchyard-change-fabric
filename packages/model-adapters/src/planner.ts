/**
 * planner: a schema-constrained plan transport that runs a goal-driven
 * decomposition through a Cloudflare AI Gateway (BYOK) OpenAI-compatible
 * endpoint, asking the model for a plan that MUST conform to a JSON schema.
 *
 * This is deliberately a SEPARATE transport from the executor's edit path. The
 * executor reuses `createAiGatewayRestInvoke` / `WorkersAiInvokeRequest`, whose
 * body shape is `{ model, messages, max_completion_tokens }` with no
 * `response_format`. A plan call instead sends
 * `response_format: { type: "json_schema", json_schema: { name, strict, schema } }`
 * so the gateway constrains the reply to a parseable plan object. Routing the
 * plan request through the executor transport would either break every executor
 * call (if the body changed) or silently drop the schema (if it did not), so the
 * plan call lives here with its own body builder.
 *
 * It reuses everything else from the executor transport in spirit: the same
 * gateway URL and `cf-aig-authorization: Bearer <token>` header (NO provider
 * `authorization` header, so the raw provider key never lives here), the same
 * AbortController timeout pattern, and the same no-leak error drain. The reply
 * still arrives at `choices[0].message.content` as a JSON string, which this
 * parses into the plan object. No credential lives in this package at rest: the
 * gateway token is held in the closure only and is never logged or returned.
 */

import { callGatewayJsonSchema, type JsonSchemaCaller } from "./gateway-json-schema.ts";
import {
  DEFAULT_REASONING_PLANNER_MAX_TOKENS,
  modelBudget,
  PLANNER_REASONING_EFFORT,
  type ModelBudget,
  type ModelBudgetCeilings,
} from "./model-budget.ts";
import { DEFAULT_WORKERS_AI_TIMEOUT_MS, type WorkersAiMessage } from "./workers-ai.ts";

/** The default plan model when the caller does not pass one. */
export const DEFAULT_AI_GATEWAY_PLANNER_MODEL = "gpt-4o-mini";

/**
 * The generous token ceiling for a plan reply. A plan is small (a list of units
 * and contracts), so this is far smaller than an edit, but still roomy enough
 * for a large modular repo's module list plus the model's hidden reasoning
 * tokens on an o-series model.
 */
export const DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS = 4096;

/**
 * The plan budget for `model`: a reasoning model gets
 * DEFAULT_REASONING_PLANNER_MAX_TOKENS (or the reasoning override) and
 * `reasoning_effort: "medium"`; any other model gets
 * DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS (or the non-reasoning override).
 */
export function plannerModelBudget(model: string, ceilings: ModelBudgetCeilings = {}): ModelBudget {
  return modelBudget(
    model,
    {
      maxTokens: DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS,
      reasoningMaxTokens: DEFAULT_REASONING_PLANNER_MAX_TOKENS,
      effort: PLANNER_REASONING_EFFORT,
    },
    ceilings,
  );
}

/**
 * The schema-constrained plan the model returns, before it is validated against
 * the real repository snapshot. It is intentionally the minimal plan shape the
 * decomposer can project onto a Change: a set of units (each owning real repo
 * paths, with an objective and an optional dependency order) plus the frozen
 * read-only contract paths. The caller re-validates every path against the real
 * snapshot, so a schema-conforming plan is still rejected when it invents a path
 * or lets a unit own a contract.
 */
export interface PlannerPlanUnit {
  /** A stable, filesystem-safe unit id. */
  readonly id: string;
  /** A human-readable objective for the unit. */
  readonly objective: string;
  /** The real repo file paths this unit owns (must exist in the snapshot). */
  readonly paths: readonly string[];
  /** The ids of other units this one depends on (import/write order). */
  readonly dependsOn: readonly string[];
}

/** The whole plan the model returns under the JSON schema. */
export interface PlannerPlan {
  readonly units: readonly PlannerPlanUnit[];
  /** The frozen read-only contract paths (owned by no unit). */
  readonly contracts: readonly string[];
  /**
   * A short, optional explanation of WHY the model decomposed the goal this way
   * (which modules it put in scope, why it grouped the units as it did, and why
   * it froze those contracts). It is OPTIONAL in the schema, so a plan without a
   * rationale still conforms and still validates; when present it is surfaced in
   * the console's planner detail panel. It is never a credential and never
   * drives any decision; it is purely explanatory.
   */
  readonly rationale?: string;
}

/** What the caller hands the plan transport: the goal and the structural map. */
export interface PlannerRequest {
  /** The model id to run the plan call on. */
  readonly model: string;
  /** The chat messages (a system prompt plus the goal and the structural map). */
  readonly messages: readonly WorkersAiMessage[];
}

/** The plan transport: a goal + structure in, a schema-conforming plan out. */
export type PlannerInvoke = (request: PlannerRequest) => Promise<PlannerPlan>;

/** Options for the live AI Gateway plan transport (holds the gateway credential). */
export interface AiGatewayPlannerOptions {
  /**
   * The AI Gateway base URL (for example
   * `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`). The transport
   * appends `/openai/chat/completions`; a trailing slash is tolerated.
   */
  readonly gatewayUrl: string;
  /**
   * The Cloudflare AI Gateway credential, sent as `cf-aig-authorization: Bearer
   * <token>`. This is NOT a raw provider key: the provider key lives in the
   * Cloudflare account and the gateway injects it. Never logged or returned.
   */
  readonly gatewayToken: string;
  /** How long a single plan call may run before it is aborted, in ms. */
  readonly timeoutMs?: number;
  /** The plan ceiling for a non-reasoning model (default DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS). */
  readonly maxTokens?: number;
  /** The plan ceiling for a reasoning model (default DEFAULT_REASONING_PLANNER_MAX_TOKENS). */
  readonly reasoningMaxTokens?: number;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/**
 * The JSON schema the plan call constrains the reply to. It is `strict`, so the
 * gateway rejects any reply that does not match: an object with a `units` array
 * (each unit an object with `id`, `objective`, a `paths` string array, and a
 * `dependsOn` string array) and a `contracts` string array. The strict schema
 * is the first line of defense; the caller re-validates the plan against the
 * real snapshot (every path exists, no unit owns a contract) as the second.
 */
export const PLANNER_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // Under OpenAI strict json_schema, `required` MUST list every key in
  // `properties` (a property absent from `required` is a schema error that the
  // gateway rejects with HTTP 400), so every property below is required.
  required: ["units", "contracts", "rationale"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "objective", "paths", "dependsOn"],
        properties: {
          id: { type: "string" },
          objective: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
    contracts: {
      type: "array",
      items: { type: "string" },
    },
    // A short explanation of why the model decomposed the goal this way. Strict
    // json_schema does not support optional properties, so `rationale` is in
    // `required`; the model always emits it (it may be a short string) and the
    // console surfaces it in the planner detail panel. The caller still tolerates
    // an empty rationale.
    rationale: { type: "string" },
  },
} as const;

/** The name the gateway uses for the schema in the response_format envelope. */
export const PLANNER_PLAN_SCHEMA_NAME = "change_plan";

/** Thrown when the plan reply is missing, non-JSON, or not the plan shape. */
export class PlannerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerResponseError";
  }
}

/**
 * Build a live AI Gateway plan transport that calls the OpenAI-compatible
 * chat-completions endpoint with a strict JSON schema `response_format`, so the
 * reply is a plan object the caller can validate against the real repository.
 * The call is NON-STREAMING and bounded by a timeout via an AbortController,
 * exactly like the executor transport, so a hung call cannot wedge the planner.
 */
export function createAiGatewayPlannerInvoke(options: AiGatewayPlannerOptions): PlannerInvoke {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;
  const ceilings: ModelBudgetCeilings = {
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoningMaxTokens !== undefined ? { reasoningMaxTokens: options.reasoningMaxTokens } : {}),
  };
  return async (request: PlannerRequest): Promise<PlannerPlan> => {
    // The ceiling is per model: a reasoning model's hidden reasoning spends the
    // completion budget, so it gets a larger ceiling and an explicit effort.
    const budget = plannerModelBudget(request.model, ceilings);
    // The shared schema-constrained call (see gateway-json-schema.ts): the same
    // gateway header (no provider key), the strict json_schema response_format,
    // the timeout, and the no-leak error drain the plan call always used.
    const reply = await callGatewayJsonSchema({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      model: request.model,
      messages: request.messages,
      schemaName: PLANNER_PLAN_SCHEMA_NAME,
      schema: PLANNER_PLAN_JSON_SCHEMA,
      maxTokens: budget.maxTokens,
      ...(budget.reasoningEffort !== undefined ? { reasoningEffort: budget.reasoningEffort } : {}),
      timeoutMs,
      fetchFn,
      label: "plan",
      responseError: (message) => new PlannerResponseError(message),
    });
    return parsePlannerPlan(reply.content);
  };
}

/**
 * Build a plan transport over any schema-constrained caller (the AI Gateway's,
 * or an operator-selected local CLI's): the same strict plan schema, the same
 * reply parsing. The caller decides how the call is made.
 */
export function createPlannerInvoke(call: JsonSchemaCaller): PlannerInvoke {
  return async (request: PlannerRequest): Promise<PlannerPlan> => {
    const reply = await call({
      model: request.model,
      messages: request.messages,
      schemaName: PLANNER_PLAN_SCHEMA_NAME,
      schema: PLANNER_PLAN_JSON_SCHEMA,
      label: "plan",
      responseError: (message) => new PlannerResponseError(message),
    });
    return parsePlannerPlan(reply.content);
  };
}

/**
 * Parse the model's reply text into a PlannerPlan, validating the SHAPE only
 * (the structural json_schema contract). It does NOT validate the plan against
 * any repository; the caller does that against the real snapshot. A reply that
 * is not JSON, or is JSON of the wrong shape, is rejected with a clear error so
 * the caller can escalate or fall back rather than ship a broken plan.
 */
export function parsePlannerPlan(replyText: string): PlannerPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(replyText);
  } catch {
    throw new PlannerResponseError("plan reply was not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new PlannerResponseError("plan must be a JSON object");
  }
  const rawUnits = parsed["units"];
  if (!Array.isArray(rawUnits)) {
    throw new PlannerResponseError("plan.units must be an array");
  }
  const units: PlannerPlanUnit[] = rawUnits.map((item, index) => {
    if (!isRecord(item)) {
      throw new PlannerResponseError(`plan.units[${index}] must be an object`);
    }
    const id = requireNonEmptyString(item["id"], `plan.units[${index}].id`);
    const objective = requireNonEmptyString(
      item["objective"],
      `plan.units[${index}].objective`,
    );
    const paths = requireStringArray(item["paths"], `plan.units[${index}].paths`);
    const dependsOn = requireStringArray(
      item["dependsOn"],
      `plan.units[${index}].dependsOn`,
    );
    return { id, objective, paths, dependsOn };
  });
  const contracts = requireStringArray(parsed["contracts"], "plan.contracts");
  // The rationale is OPTIONAL: a plan may omit it (then it is simply absent), and
  // only a non-empty string is carried. A non-string is ignored rather than
  // rejected, so a slightly loose reply still yields a usable plan.
  const rawRationale = parsed["rationale"];
  const rationale =
    typeof rawRationale === "string" && rawRationale.trim() !== ""
      ? rawRationale
      : undefined;
  return { units, contracts, ...(rationale !== undefined ? { rationale } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlannerResponseError(`${where} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new PlannerResponseError(`${where} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new PlannerResponseError(`${where}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

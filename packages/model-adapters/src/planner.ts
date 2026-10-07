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

import {
  DEFAULT_WORKERS_AI_TIMEOUT_MS,
  WorkersAiTimeoutError,
  type WorkersAiMessage,
} from "./workers-ai.ts";

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
  /** The maximum tokens the plan reply may use. */
  readonly maxTokens?: number;
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
  required: ["units", "contracts"],
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
    // An OPTIONAL short explanation of why the model decomposed the goal this
    // way. It is not in `required`, so a plan that omits it still conforms to the
    // strict schema; a model that can explain its plan may include it, and the
    // console surfaces it in the planner detail panel.
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
  const base = options.gatewayUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS;
  return async (request: PlannerRequest): Promise<PlannerPlan> => {
    const url = `${base}/openai/chat/completions`;
    const controller = timeoutMs > 0 ? new AbortController() : undefined;
    const timer =
      controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          // The gateway credential, NOT a provider key. There is deliberately no
          // provider `authorization` header: the gateway injects the stored
          // provider key (BYOK), so the raw key never lives here.
          "cf-aig-authorization": `Bearer ${options.gatewayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_completion_tokens: maxTokens,
          // The schema constraint. `strict: true` makes the gateway reject a
          // reply that does not conform, so the content is a parseable plan.
          response_format: {
            type: "json_schema",
            json_schema: {
              name: PLANNER_PLAN_SCHEMA_NAME,
              strict: true,
              schema: PLANNER_PLAN_JSON_SCHEMA,
            },
          },
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new WorkersAiTimeoutError(
          `AI Gateway plan call for ${request.model} timed out after ${timeoutMs}ms`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    if (res.status >= 400) {
      // Drain the body (do not include it in the error) and fail without leaking.
      await res.text().catch(() => "");
      throw new Error(`AI Gateway plan call failed for ${request.model} (HTTP ${res.status})`);
    }
    const text = await res.text();
    let body: {
      choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new PlannerResponseError(
        `AI Gateway returned a non-JSON response for the plan call (${request.model})`,
      );
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new PlannerResponseError(
        `AI Gateway plan reply had no message content for ${request.model}`,
      );
    }
    return parsePlannerPlan(content);
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

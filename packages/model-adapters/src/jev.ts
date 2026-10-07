/**
 * jev: a typed-decision transport that asks a schema-constrained decision model
 * a small set of questions through a Cloudflare AI Gateway (BYOK) run endpoint,
 * and parses a typed answer per question (noul, choice, or score) with a
 * calibrated confidence and optional per-option probabilities.
 *
 * This is deliberately a SEPARATE transport from both the executor edit path and
 * the planner plan path. The executor posts a chat-completions body; the planner
 * posts a chat-completions body with a json_schema response_format. A decision
 * call instead posts to the NATIVE Cloudflare account run endpoint
 * (`/accounts/<accountId>/ai/run`) with the gateway routing header
 * `cf-aig-gateway-id` and a body of
 * `{ model: "typesafe/jev", input: { state, questions } }`, so routing a
 * decision through either of the other transports would break their body shape
 * or silently drop the decision contract. The decision call lives here with its
 * own body builder and parser.
 *
 * It authenticates the account run endpoint with the account API token
 * (`Authorization: Bearer <CLOUDFLARE_API_TOKEN>`) and routes through the gateway
 * with `cf-aig-gateway-id`, so the gateway injects the stored provider key (BYOK)
 * and no raw provider key lives here. It reuses the same AbortController timeout
 * pattern and the same no-leak error drain as the other transports. No credential
 * lives in this package at rest: the account token is held in the closure only
 * and is never logged or returned.
 *
 * The transport is injectable (its `fetchFn` defaults to the global fetch) so a
 * test drives it with a deterministic fake and never touches the network, and
 * the typed `askJev` closure it returns is handed to the orchestration layer so
 * change-core stays pure and the whole decision path is faked offline.
 */

import {
  DEFAULT_WORKERS_AI_TIMEOUT_MS,
  WorkersAiTimeoutError,
} from "./workers-ai.ts";

/** The decision model the gateway routes a Jev call to. */
export const DEFAULT_JEV_MODEL = "typesafe/jev";

/** The generous token ceiling for a decision reply (a small set of answers). */
export const DEFAULT_JEV_MAX_TOKENS = 1024;

/** The kind of a typed answer the decision model may return per question. */
export type JevAnswerType = "noul" | "choice" | "score";

/**
 * One question the caller asks the decision model, keyed by name in the request
 * map. It names the kind of answer it expects, the human-readable instructions,
 * and (for a choice) the allowed option ids the model must pick from. The
 * question's NAME is the map key under which its answer comes back, so the
 * request and the reply are object-keyed the same way (no positional array).
 */
export interface JevQuestion {
  /** The kind of answer expected: a noul (yes/no/unsure), a choice, or a score. */
  readonly type: JevAnswerType;
  /** The human-readable instructions describing what to decide. */
  readonly instructions: string;
  /** For a choice question, the allowed option ids the model must pick among. */
  readonly criteria?: readonly string[];
}

/**
 * The set of questions a caller asks, keyed by question name. The reply's answers
 * come back keyed the same way, so each answer maps straight back to its question
 * name with no positional array.
 */
export type JevQuestions = Readonly<Record<string, JevQuestion>>;

/**
 * A typed answer the decision model returned for one question, after the reply
 * is validated against its shape. A noul answer carries one of "yes"/"no"/
 * "unsure"; a choice answer carries the chosen option id; a score answer carries
 * a numeric score. Every answer carries a calibrated `confidence` in [0, 1] and
 * may carry per-option/per-outcome `probabilities`.
 */
export interface JevAnswer {
  readonly type: JevAnswerType;
  /** The noul verdict for a noul answer. */
  readonly noul?: "yes" | "no" | "unsure";
  /** The chosen option id for a choice answer. */
  readonly choice?: string;
  /** The numeric score for a score answer. */
  readonly score?: number;
  /** The model's calibrated confidence in this answer, in [0, 1]. */
  readonly confidence: number;
  /** Optional per-outcome probabilities, keyed by outcome/option id. */
  readonly probabilities?: Readonly<Record<string, number>>;
}

/** What the caller hands the decision transport: the state summary + questions. */
export interface JevRequest {
  /**
   * A readable, secret-free summary of the state the decision is about (the
   * plan, the failing evidence, or the integrated fix). It is derived
   * deterministically by the caller and never carries a credential.
   */
  readonly state: string;
  /** The set of questions to answer, keyed by name so the reply maps back to each. */
  readonly questions: JevQuestions;
}

/** The decision transport: a state + questions in, a typed answer per key out. */
export type JevInvoke = (request: JevRequest) => Promise<Readonly<Record<string, JevAnswer>>>;

/** The typed decision caller the orchestration injects into the junctures. */
export type AskJev = (
  state: string,
  questions: JevQuestions,
) => Promise<Readonly<Record<string, JevAnswer>>>;

/** The native Cloudflare account run API base the decision call posts under. */
export const DEFAULT_CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Options for the live AI Gateway decision transport (holds the credential). */
export interface AiGatewayJevOptions {
  /**
   * The Cloudflare account id. The decision call posts to the NATIVE account run
   * endpoint `<apiBase>/accounts/<accountId>/ai/run`, so the URL is built from
   * the account id, not from the gateway URL.
   */
  readonly accountId: string;
  /**
   * The Cloudflare account API token, sent as `Authorization: Bearer <token>`.
   * The native account run endpoint authenticates with the account API token
   * (the gateway still injects the stored provider key via `cf-aig-gateway-id`
   * routing). It is held in the closure only and is never logged or returned.
   */
  readonly apiToken: string;
  /**
   * The gateway id (slug) the decision call routes through, sent as the
   * `cf-aig-gateway-id` header. Derived from the gateway URL or supplied
   * explicitly by the caller (see `gatewaySlugFromUrl`).
   */
  readonly gatewayId: string;
  /**
   * An optional Cloudflare API base override (for tests), defaulting to the
   * public `https://api.cloudflare.com/client/v4`. A trailing slash is tolerated.
   */
  readonly apiBase?: string;
  /** How long a single decision call may run before it is aborted, in ms. */
  readonly timeoutMs?: number;
  /** The maximum tokens the decision reply may use. */
  readonly maxTokens?: number;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/** Thrown when the decision reply is missing, non-JSON, or not the answer shape. */
export class JevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}

/**
 * Derive the gateway id (slug) from a gateway URL. A Cloudflare AI Gateway URL
 * has the shape `.../v1/<account>/<gateway>[/...]`, so the gateway slug is the
 * last non-empty path segment after the account id. Returns an empty string when
 * no slug can be derived, so the caller can prefer an explicit env slug.
 */
export function gatewaySlugFromUrl(gatewayUrl: string): string {
  const trimmed = gatewayUrl.replace(/\/+$/, "");
  const match = trimmed.match(/\/v1\/[^/]+\/([^/]+)/);
  if (match && match[1]) {
    return match[1];
  }
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "";
}

/**
 * Build a live AI Gateway decision transport. It posts to the NATIVE Cloudflare
 * account run endpoint (`<apiBase>/accounts/<accountId>/ai/run`) with the account
 * API token as `Authorization: Bearer <token>` and the gateway routing header
 * `cf-aig-gateway-id`, asking the decision model the caller's questions over the
 * state summary, and parses the typed answers. The call is NON-STREAMING and
 * bounded by a timeout via an AbortController, exactly like the planner
 * transport, so a hung call cannot wedge a decision juncture.
 */
export function createAiGatewayJevInvoke(options: AiGatewayJevOptions): JevInvoke {
  const fetchFn = options.fetchFn ?? fetch;
  const apiBase = (options.apiBase ?? DEFAULT_CLOUDFLARE_API_BASE).replace(/\/+$/, "");
  const accountId = options.accountId;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_JEV_MAX_TOKENS;
  return async (request: JevRequest): Promise<Readonly<Record<string, JevAnswer>>> => {
    // Post to the NATIVE account run endpoint, NOT the gateway URL or the OpenAI
    // chat-completions path: the decision model is a typed-decision endpoint
    // reached through the account run API and routed by the gateway id header,
    // so its path, auth, and body differ from the executor/planner.
    const url = `${apiBase}/accounts/${accountId}/ai/run`;
    const controller = timeoutMs > 0 ? new AbortController() : undefined;
    const timer =
      controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          // The account API token authenticates the native run endpoint. The
          // gateway still injects the stored provider key (BYOK); this token is
          // the account credential, held in the closure only and never logged.
          Authorization: `Bearer ${options.apiToken}`,
          // The gateway routing header: which gateway this decision call runs
          // through, derived from the gateway URL or supplied as an env slug.
          "cf-aig-gateway-id": options.gatewayId,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: DEFAULT_JEV_MODEL,
          input: {
            state: request.state,
            // The questions ride as an OBJECT keyed by question name, the same
            // shape the reply's answers come back in, so there is no positional
            // array and each answer maps straight back to its question name.
            questions: Object.fromEntries(
              Object.entries(request.questions).map(([name, question]) => [
                name,
                {
                  type: question.type,
                  instructions: question.instructions,
                  ...(question.criteria ? { criteria: [...question.criteria] } : {}),
                },
              ]),
            ),
          },
          ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new WorkersAiTimeoutError(
          `AI Gateway decision call for ${DEFAULT_JEV_MODEL} timed out after ${timeoutMs}ms`,
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
      throw new Error(
        `AI Gateway decision call failed for ${DEFAULT_JEV_MODEL} (HTTP ${res.status})`,
      );
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new JevResponseError(
        `AI Gateway returned a non-JSON response for the decision call (${DEFAULT_JEV_MODEL})`,
      );
    }
    // The native run response nests the inner run result TWO levels deep:
    // `{ result: { state, result: { answers: { <name>: {...} } } } }`. Unwrap to
    // the inner run result before parsing; tolerate a flatter `{ result: {...} }`
    // or a bare body for the fake/offline path.
    return parseJevAnswers(unwrapRunResult(body));
  };
}

/**
 * Unwrap the native account run response to the object that carries the answers
 * map. The working response nests the inner run result under
 * `body.result.result` (with `body.result.state`), so prefer that; fall back to
 * `body.result` and then the bare body so the fake/offline shapes still parse.
 */
function unwrapRunResult(body: unknown): unknown {
  if (isRecord(body) && isRecord(body["result"])) {
    const outer = body["result"] as Record<string, unknown>;
    if (isRecord(outer["result"])) {
      return outer["result"];
    }
    // A flatter `{ result: { answers: {...} } }` (or `{ result: { <key>: {...} } }`).
    return outer;
  }
  return body;
}

/**
 * Parse the decision model's reply into a map of key -> typed answer, validating
 * the SHAPE only. A reply that is not the expected `{ answers: { <key>: {...} } }`
 * object, or whose answers are of the wrong shape, is rejected with a clear
 * error so the caller can escalate or fall back rather than act on a malformed
 * decision. The reply may also be the bare `{ <key>: {...} }` map (no `answers`
 * wrapper), so both shapes are accepted.
 */
export function parseJevAnswers(reply: unknown): Readonly<Record<string, JevAnswer>> {
  if (!isRecord(reply)) {
    throw new JevResponseError("decision reply must be a JSON object");
  }
  const rawAnswers = isRecord(reply["answers"]) ? reply["answers"] : reply;
  if (!isRecord(rawAnswers)) {
    throw new JevResponseError("decision reply.answers must be an object");
  }
  const out: Record<string, JevAnswer> = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    out[key] = parseOneAnswer(value, `answers.${key}`);
  }
  return out;
}

/** Parse one typed answer, validating its shape against its declared type. */
function parseOneAnswer(value: unknown, where: string): JevAnswer {
  if (!isRecord(value)) {
    throw new JevResponseError(`${where} must be an object`);
  }
  const type = value["type"];
  if (type !== "noul" && type !== "choice" && type !== "score") {
    throw new JevResponseError(`${where}.type must be one of noul, choice, score`);
  }
  const confidence = requireUnitInterval(value["confidence"], `${where}.confidence`);
  const probabilities = parseProbabilities(value["probabilities"], `${where}.probabilities`);
  if (type === "noul") {
    const noul = value["noul"];
    if (noul !== "yes" && noul !== "no" && noul !== "unsure") {
      throw new JevResponseError(`${where}.noul must be one of yes, no, unsure`);
    }
    return {
      type,
      noul,
      confidence,
      ...(probabilities !== undefined ? { probabilities } : {}),
    };
  }
  if (type === "choice") {
    const choice = value["choice"];
    if (typeof choice !== "string" || choice.trim() === "") {
      throw new JevResponseError(`${where}.choice must be a non-empty string`);
    }
    return {
      type,
      choice,
      confidence,
      ...(probabilities !== undefined ? { probabilities } : {}),
    };
  }
  const score = value["score"];
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new JevResponseError(`${where}.score must be a finite number`);
  }
  return {
    type,
    score,
    confidence,
    ...(probabilities !== undefined ? { probabilities } : {}),
  };
}

/** Parse an optional probabilities map, keeping only finite numeric entries. */
function parseProbabilities(
  value: unknown,
  where: string,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new JevResponseError(`${where} must be an object when present`);
  }
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Require a number in [0, 1] (a calibrated confidence or probability). */
function requireUnitInterval(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JevResponseError(`${where} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new JevResponseError(`${where} must be within [0, 1]`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

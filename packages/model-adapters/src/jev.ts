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

import { rateLimitErrorFor } from "./rate-limit.ts";
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
  /**
   * For a choice question, the allowed option ids the model must pick among;
   * for a score question, the scoring criteria. (The wire shapes differ: the
   * transport sends a choice's options as a record option -> description and a
   * score's criteria as an array; a noul sends none.)
   */
  readonly criteria?: readonly string[];
  /** For a choice question, an optional short description per option id. */
  readonly descriptions?: Readonly<Record<string, string>>;
}

/**
 * The question as the decision model's API expects it on the wire: a choice's
 * criteria is a RECORD option -> description, a score's criteria an ARRAY of
 * strings, and a noul carries no criteria.
 */
export function serializeJevQuestion(question: JevQuestion): Record<string, unknown> {
  const base = { type: question.type, instructions: question.instructions };
  if (question.type === "choice" && question.criteria && question.criteria.length > 0) {
    return {
      ...base,
      criteria: Object.fromEntries(question.criteria.map((option) => [option, question.descriptions?.[option] ?? option])),
    };
  }
  if (question.type === "score" && question.criteria && question.criteria.length > 0) {
    return { ...base, criteria: [...question.criteria] };
  }
  return base;
}

/**
 * A short, credential-free reason for a failed decision call: the first line of
 * its message, bounded (callers record it; nothing here carries headers).
 */
export function jevErrorReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "decision call failed";
  return line
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .slice(0, 200);
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
  /** For a score answer: what each score value means. */
  readonly legend?: Readonly<Record<string, string>>;
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
              Object.entries(request.questions).map(([name, question]) => [name, serializeJevQuestion(question)]),
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
      // Read the error MESSAGE from the body (never headers or the request), so
      // the caller can record why the call failed.
      const errorText = await res.text().catch(() => "");
      const limited = rateLimitErrorFor(res, DEFAULT_JEV_MODEL, "decision");
      if (limited !== undefined) {
        throw limited;
      }
      throw new Error(`AI Gateway decision call failed for ${DEFAULT_JEV_MODEL} (HTTP ${res.status}): ${errorMessageOf(errorText)}`);
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
    return parseJevAnswers(
      unwrapRunResult(body),
      Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, q.type])),
    );
  };
}

/** The first meaningful message line of an API error body (JSON `errors[].message` / `error` / `message`, else text). */
function errorMessageOf(text: string): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { errors?: { message?: unknown }[]; error?: unknown; message?: unknown };
    const first = Array.isArray(parsed.errors) ? parsed.errors.find((e) => typeof e?.message === "string")?.message : undefined;
    message = String(first ?? (typeof parsed.error === "string" ? parsed.error : undefined) ?? parsed.message ?? text);
  } catch {
    // Not JSON: use the text.
  }
  return (message.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim().slice(0, 200);
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
export function parseJevAnswers(
  reply: unknown,
  expected: Readonly<Record<string, JevAnswerType>> = {},
): Readonly<Record<string, JevAnswer>> {
  if (!isRecord(reply)) {
    throw new JevResponseError("decision reply must be a JSON object");
  }
  const rawAnswers = isRecord(reply["answers"]) ? reply["answers"] : reply;
  if (!isRecord(rawAnswers)) {
    throw new JevResponseError("decision reply.answers must be an object");
  }
  const out: Record<string, JevAnswer> = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    // A reply may omit `type`; the question's declared type stands in.
    const typed = isRecord(value) && value["type"] === undefined && expected[key] !== undefined ? { ...value, type: expected[key] } : value;
    out[key] = parseOneAnswer(typed, `answers.${key}`);
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
  const probabilities = parseProbabilities(value["probabilities"], `${where}.probabilities`);
  if (type === "noul") {
    // The decision model returns `noul` as a NUMBER: the probability the answer
    // is "yes" (verified against the live API, which returns e.g. {noul: 0.95}),
    // NOT a yes/no/unsure string. Map it to the verdict plus a derived
    // confidence: the probability toward yes gives "yes", below 0.5 gives "no",
    // and the confidence is how far the probability is from an even 0.5 (so a
    // noul near 0.5 is low-confidence and the juncture escalates). A caller may
    // still send an explicit `confidence`; honor it when present.
    const rawNoul = value["noul"];
    if (typeof rawNoul !== "number" || !Number.isFinite(rawNoul)) {
      throw new JevResponseError(`${where}.noul must be a finite number in [0, 1]`);
    }
    const p = clampUnit(rawNoul);
    const noul: "yes" | "no" = p >= 0.5 ? "yes" : "no";
    // The confidence reflects the CHOSEN verdict: the probability toward yes for
    // a "yes", and its complement for a "no", so a decisive answer in either
    // direction is high-confidence and a noul near 0.5 is low-confidence (and the
    // juncture escalates). A caller may still send an explicit confidence.
    const derivedConfidence = noul === "yes" ? p : 1 - p;
    const confidence =
      optionalUnitInterval(value["confidence"], `${where}.confidence`) ?? derivedConfidence;
    return {
      type,
      noul,
      confidence,
      ...(probabilities !== undefined ? { probabilities } : {}),
    };
  }
  if (type === "choice") {
    // A choice answer carries the chosen option id as a string. The live API may
    // also return per-option `probabilities`; when `choice` is absent but
    // probabilities are present, the chosen option is the argmax, and the
    // confidence is that option's probability.
    const rawChoice = value["choice"];
    let choice: string | undefined =
      typeof rawChoice === "string" && rawChoice.trim() !== "" ? rawChoice : undefined;
    let derivedConfidence: number | undefined;
    if (choice === undefined && probabilities !== undefined) {
      const best = argmax(probabilities);
      if (best !== undefined) {
        choice = best.key;
        derivedConfidence = best.value;
      }
    } else if (choice !== undefined && probabilities !== undefined) {
      // The chosen option's own probability is its confidence when the model
      // returns a per-option distribution alongside an explicit choice.
      const p = probabilities[choice];
      if (typeof p === "number" && Number.isFinite(p)) {
        derivedConfidence = p;
      }
    }
    if (choice === undefined) {
      throw new JevResponseError(`${where}.choice must be a non-empty string or have probabilities`);
    }
    const confidence =
      optionalUnitInterval(value["confidence"], `${where}.confidence`) ?? derivedConfidence ?? 1;
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
  const confidence = optionalUnitInterval(value["confidence"], `${where}.confidence`) ?? 1;
  // The score's legend maps score values to their meaning ({"0": ..., "1": ...}).
  const rawLegend = value["legend"];
  const legend = isRecord(rawLegend)
    ? Object.fromEntries(Object.entries(rawLegend).filter((e): e is [string, string] => typeof e[1] === "string"))
    : undefined;
  return {
    type,
    score,
    confidence,
    ...(probabilities !== undefined ? { probabilities } : {}),
    ...(legend !== undefined && Object.keys(legend).length > 0 ? { legend } : {}),
  };
}

/** Clamp a number into [0, 1]. */
function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** The entry with the largest finite value in a probabilities map, if any. */
function argmax(
  probabilities: Readonly<Record<string, number>>,
): { key: string; value: number } | undefined {
  let best: { key: string; value: number } | undefined;
  for (const [key, value] of Object.entries(probabilities)) {
    if (best === undefined || value > best.value) {
      best = { key, value };
    }
  }
  return best;
}

/**
 * Parse an OPTIONAL confidence in [0, 1]: the live decision model does not send
 * a separate `confidence` field (it is derived from the noul probability), but a
 * caller or a future model may, so honor it when present and reject only a
 * present-but-malformed value.
 */
function optionalUnitInterval(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireUnitInterval(value, where);
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

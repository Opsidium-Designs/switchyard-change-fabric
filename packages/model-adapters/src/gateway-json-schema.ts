/**
 * gateway-json-schema: one schema-constrained chat call through a Cloudflare AI
 * Gateway (BYOK) OpenAI-compatible endpoint.
 *
 * The planner and the board agent turn both ask the model for a reply that MUST
 * conform to a JSON schema, so they share this call: the same gateway URL and
 * `cf-aig-authorization: Bearer <token>` header (NO provider `authorization`
 * header, so the raw provider key never lives here), the same
 * `response_format: { type: "json_schema", json_schema: { name, strict, schema } }`
 * body, the same AbortController timeout, and the same no-leak error drain. The
 * gateway token is held by the caller's closure only and is never logged or
 * returned.
 */

import type { ReasoningEffort } from "./model-budget.ts";
import { rateLimitErrorFromResponse } from "./rate-limit.ts";
import { WorkersAiTimeoutError, type WorkersAiMessage } from "./workers-ai.ts";

/** One schema-constrained call. */
export interface GatewayJsonSchemaCall {
  /** The AI Gateway base URL; `/openai/chat/completions` is appended. */
  readonly gatewayUrl: string;
  /** The gateway credential (never a provider key). */
  readonly gatewayToken: string;
  readonly model: string;
  readonly messages: readonly WorkersAiMessage[];
  readonly schemaName: string;
  readonly schema: unknown;
  readonly maxTokens: number;
  /**
   * The reasoning effort for a reasoning model (sent as `reasoning_effort`).
   * Omitted for a non-reasoning model, which rejects the field.
   */
  readonly reasoningEffort?: ReasoningEffort;
  /** Abort after this many ms (0 disables the timeout). */
  readonly timeoutMs: number;
  readonly fetchFn: typeof fetch;
  /** What the call is for, used in error messages (for example "plan"). */
  readonly label: string;
  /** Builds the error thrown for a missing or non-JSON reply. */
  readonly responseError: (message: string) => Error;
}

/** The reply content (a JSON string) and the token usage the gateway reported. */
export interface GatewayJsonSchemaReply {
  readonly content: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/**
 * Run one NON-STREAMING schema-constrained call and return the reply content.
 * Throws a timeout error when the call is aborted, a RateLimitError on HTTP 429
 * (or 503 with Retry-After), a plain error (without the response body) on any
 * other HTTP failure, and `responseError` when the reply is not
 * JSON or carries no message content.
 */
export async function callGatewayJsonSchema(call: GatewayJsonSchemaCall): Promise<GatewayJsonSchemaReply> {
  const url = `${call.gatewayUrl.replace(/\/$/, "")}/openai/chat/completions`;
  const controller = call.timeoutMs > 0 ? new AbortController() : undefined;
  const timer = controller !== undefined ? setTimeout(() => controller.abort(), call.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await call.fetchFn(url, {
      method: "POST",
      headers: {
        // The gateway credential, NOT a provider key. There is deliberately no
        // provider `authorization` header: the gateway injects the stored
        // provider key (BYOK), so the raw key never lives here.
        "cf-aig-authorization": `Bearer ${call.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: call.model,
        messages: call.messages,
        max_completion_tokens: call.maxTokens,
        ...(call.reasoningEffort !== undefined ? { reasoning_effort: call.reasoningEffort } : {}),
        // `strict: true` makes the gateway reject a reply that does not conform.
        response_format: {
          type: "json_schema",
          json_schema: { name: call.schemaName, strict: true, schema: call.schema },
        },
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new WorkersAiTimeoutError(
        `AI Gateway ${call.label} call for ${call.model} timed out after ${call.timeoutMs}ms`,
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  if (res.status >= 400) {
    // A rate limit (HTTP 429, or 503 with Retry-After) is a RateLimitError; a
    // 429 whose bounded body says the provider balance is spent is a QuotaExhaustedError.
    const limited = await rateLimitErrorFromResponse(res, call.model, call.label).catch(() => undefined);
    // Drain the body (do not include it in the error) and fail without leaking.
    await res.text().catch(() => "");
    throw limited ?? new Error(`AI Gateway ${call.label} call failed for ${call.model} (HTTP ${res.status})`);
  }
  const text = await res.text();
  let body: {
    choices?: ReadonlyArray<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw call.responseError(
      `AI Gateway returned a non-JSON response for the ${call.label} call (${call.model})`,
    );
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    // Why it stopped (a short provider token only, never reply text): "length"
    // means the token ceiling was spent before any content (a reasoning model).
    const raw = body.choices?.[0]?.finish_reason;
    const finish = typeof raw === "string" && /^[A-Za-z_-]{1,40}$/.test(raw) ? raw : "unknown";
    throw call.responseError(
      `AI Gateway ${call.label} reply had no message content for ${call.model} (finish_reason: ${finish})` +
        (finish === "length" ? `: the reply hit max_completion_tokens (${call.maxTokens}); raise the token ceiling for this model` : ""),
    );
  }
  const inputTokens = typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : undefined;
  const outputTokens = typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : undefined;
  return {
    content,
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          },
        }
      : {}),
  };
}

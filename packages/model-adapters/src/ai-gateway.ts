/**
 * ai-gateway: a live transport that runs the agent's coding reasoning through a
 * Cloudflare AI Gateway (BYOK) OpenAI-compatible endpoint, so the whole
 * WorkersAiExecutor edit path (prompt building, edit parsing, bounded same-model
 * retry, worktree write) is reused unchanged behind one injected transport.
 *
 * The transport differs from the direct Workers AI REST transport in exactly
 * three ways:
 *   - URL: it POSTs to `${CLOUDFLARE_AI_GATEWAY_URL}/openai/chat/completions`
 *     (the model goes in the body, not the path);
 *   - auth: it sends the gateway credential as `cf-aig-authorization: Bearer
 *     <token>` and sends NO provider `authorization` header. The real provider
 *     key is stored in the Cloudflare account (BYOK) and injected by the gateway
 *     on the way out; it never lives in this repo;
 *   - body: it sends the OpenAI chat-completions shape
 *     `{ model, messages, max_tokens }`.
 *
 * The response is the OpenAI top-level `choices[0].message.content`, which the
 * reused `extractReplyText` already handles, so there is no new parser here.
 *
 * No credential lives in this package at rest. The gateway token is held in this
 * closure only (read from the environment by `selectExecutor`) and is never
 * returned, logged, or embedded. On an HTTP error the response body is drained
 * without being included in the thrown error, so a token can never leak.
 */

import {
  DEFAULT_WORKERS_AI_MAX_TOKENS,
  DEFAULT_WORKERS_AI_TIMEOUT_MS,
  extractReplyText,
  WorkersAiTimeoutError,
  type WorkersAiInvoke,
  type WorkersAiInvokeRequest,
  type WorkersAiInvokeResult,
  type WorkersAiStreamCallbacks,
} from "./workers-ai.ts";

/** The default base model for the AI Gateway executor's first attempt. */
export const DEFAULT_AI_GATEWAY_MODEL = "gpt-4o-mini";

/** The default verify-fail escalation model for the AI Gateway executor. */
export const DEFAULT_AI_GATEWAY_ESCALATION_MODEL = "gpt-4o";

/** The default bounded retry rounds past the base round for the gateway ladder. */
export const DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES = 3;

/** Options for the live AI Gateway REST transport (holds the gateway credential). */
export interface AiGatewayRestOptions {
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
  /**
   * How long a single model call may run before it is aborted and surfaced as a
   * WorkersAiTimeoutError, in milliseconds. Defaults to the shared 75 second
   * ceiling; set to 0 to disable (not recommended for a live run).
   */
  readonly timeoutMs?: number;
  /**
   * The maximum tokens the model may generate for one call. A full-file edit
   * must fit the whole new contents, so this defaults to a generous value to
   * avoid a truncated, unparseable reply.
   */
  readonly maxTokens?: number;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/**
 * Build a live AI Gateway transport that calls the OpenAI-compatible
 * chat-completions endpoint behind a Cloudflare AI Gateway with a BYOK
 * credential. The call is always NON-STREAMING and is bounded by a timeout via
 * an AbortController, exactly like the direct Workers AI transport, so a hung
 * call cannot wedge the agent forever and the executor's bounded retry treats a
 * timeout as transient.
 */
export function createAiGatewayRestInvoke(options: AiGatewayRestOptions): WorkersAiInvoke {
  const fetchFn = options.fetchFn ?? fetch;
  const base = options.gatewayUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_WORKERS_AI_MAX_TOKENS;
  return async (
    request: WorkersAiInvokeRequest,
    _callbacks?: WorkersAiStreamCallbacks,
  ): Promise<WorkersAiInvokeResult> => {
    const url = `${base}/openai/chat/completions`;
    // Bound the call with an AbortController so a slow or hung model cannot hang
    // the agent forever. The timer is always cleared on settle, and an abort is
    // surfaced as a distinct timeout error rather than an opaque fetch failure.
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
          max_tokens: maxTokens,
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      // An abort (the timeout fired) is reported as a distinct timeout error; any
      // other fetch-level failure is passed through. Neither path leaks the token.
      if (controller?.signal.aborted) {
        throw new WorkersAiTimeoutError(
          `AI Gateway call for ${request.model} timed out after ${timeoutMs}ms`,
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
      throw new Error(`AI Gateway call failed for ${request.model} (HTTP ${res.status})`);
    }
    const text = await res.text();
    let body: {
      choices?: ReadonlyArray<{
        message?: { content?: unknown; reasoning?: unknown };
        text?: unknown;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`AI Gateway returned a non-JSON response for ${request.model}`);
    }
    // The AI Gateway OpenAI endpoint returns the OpenAI top-level
    // `choices[0].message.content` shape, which extractReplyText already handles.
    const response = extractReplyText(body);
    const usage = body.usage;
    return {
      text: response,
      ...(usage
        ? {
            usage: {
              ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
              ...(usage.completion_tokens !== undefined
                ? { outputTokens: usage.completion_tokens }
                : {}),
            },
          }
        : {}),
    };
  };
}

/**
 * executor-select: choose the executor a live run uses from the environment,
 * keeping the credential handling in one place and out of the CLI.
 *
 * The selection mirrors the `.env` contract: `EXECUTOR` picks the inference
 * path. For `workers-ai`, this builds the live Workers AI executor over the REST
 * transport, reading the base model from `WORKERS_AI_MODEL` (defaulting to the
 * llama-3.3-70b fast model), the verify-fail escalation model from
 * `WORKERS_AI_ESCALATION_MODEL` (defaulting to qwen2.5-coder-32b), and the credential from
 * `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`. For `ai-gateway`, this builds
 * the same executor shape over the AI Gateway (BYOK) transport, reading the base
 * model from `AI_GATEWAY_MODEL` (default gpt-4o-mini), the ORDERED escalation
 * ladder from `AI_GATEWAY_ESCALATION_MODELS` (a comma-separated list, e.g.
 * `gpt-4.1,gpt-5`, falling back to the singular `AI_GATEWAY_ESCALATION_MODEL`
 * for backward compatibility, then to gpt-4o), the bounded retry budget from
 * `AI_GATEWAY_MAX_MODEL_RETRIES` (default 3), and the gateway endpoint/credential
 * from `CLOUDFLARE_AI_GATEWAY_URL` / `CLOUDFLARE_AI_GATEWAY_TOKEN`. Every token is
 * read from the environment and passed into the transport closure only; it is
 * never returned, logged, or written here, and no raw provider key is ever read
 * (the gateway injects the stored provider key).
 *
 * Any other value (or an unset `EXECUTOR`) selects the deterministic scoped-noop
 * executor, so an offline run and `make check` never call the network.
 */

import type { ExecutorProvider } from "@switchyard-change/model-adapters";
import {
  createAiGatewayRestInvoke,
  createWorkersAiRestInvoke,
  DEFAULT_AI_GATEWAY_ESCALATION_MODEL,
  DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES,
  DEFAULT_AI_GATEWAY_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  ScopedNoopExecutor,
  WorkersAiExecutor,
} from "@switchyard-change/model-adapters";

/**
 * The default escalation model for the bounded verify-fail retry ladder. The
 * base attempt runs the headline model (DEFAULT_WORKERS_AI_MODEL); a verify-fail
 * retry runs this stronger model fed the failing evidence. It is a different
 * axis from the executor's transport fallback (that fires on a thrown call, not
 * a verify verdict), so it has its own default and its own env override.
 */
export const DEFAULT_WORKERS_AI_ESCALATION_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

/** A minimal environment view, so this is testable without process.env. */
export interface ExecutorEnv {
  readonly EXECUTOR?: string;
  readonly WORKERS_AI_MODEL?: string;
  readonly WORKERS_AI_FALLBACK_MODEL?: string;
  readonly WORKERS_AI_ESCALATION_MODEL?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly AI_GATEWAY_MODEL?: string;
  readonly AI_GATEWAY_ESCALATION_MODEL?: string;
  readonly AI_GATEWAY_ESCALATION_MODELS?: string;
  readonly AI_GATEWAY_MAX_MODEL_RETRIES?: string;
  readonly CLOUDFLARE_AI_GATEWAY_URL?: string;
  readonly CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
}

/** The outcome of selecting an executor: the provider plus a readable label. */
export interface SelectedExecutor {
  readonly executor: ExecutorProvider;
  /** A human-readable description of what was selected (no secrets). */
  readonly description: string;
  /** True when a real inference path (Workers AI or AI Gateway) was selected. */
  readonly live: boolean;
  /** The base model id for the first attempt (empty for the noop path). */
  readonly baseModel: string;
  /**
   * The model id a verify-fail retry escalates to, so the ladder can run
   * attempt 2 on a stronger model by passing it as the per-attempt model id.
   * Empty for the deterministic noop path (no inference, no escalation). This
   * is the FIRST escalation model (escalationModels[0]); it is kept for
   * backward compatibility with callers that escalate to a single model.
   */
  readonly escalationModel: string;
  /**
   * The ORDERED escalation model ladder: each retry ROUND uses the next better
   * model, so retry round 1 uses escalationModels[0], retry round 2 uses
   * escalationModels[1], and so on (clamped to the last entry past the end).
   * The AI Gateway path reads it from AI_GATEWAY_ESCALATION_MODELS (a
   * comma-separated ordered list), falling back to the singular
   * AI_GATEWAY_ESCALATION_MODEL as a one-element list for backward
   * compatibility. Empty for the deterministic noop path.
   */
  readonly escalationModels: readonly string[];
  /**
   * The bounded max RETRY rounds the chosen executor's ladder should run past
   * the base round. The AI Gateway path reads it from AI_GATEWAY_MAX_MODEL_RETRIES
   * so the retry budget travels with the executor choice; other paths return the
   * default and let the CLI dial decide. Undefined when the caller should keep
   * its own default (the noop path).
   */
  readonly maxModelRetries?: number;
}

/**
 * Select the executor from the environment. `env` defaults to `process.env`.
 * Throws a clear error when a live path (`workers-ai` or `ai-gateway`) is
 * requested but its credentials are missing, rather than silently falling back
 * to a noop that would mask a real edit as deterministic.
 */
export function selectExecutor(env: ExecutorEnv = process.env): SelectedExecutor {
  const choice = (env.EXECUTOR ?? "").trim().toLowerCase();
  if (choice === "workers-ai") {
    const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
    const apiToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
    if (accountId === "" || apiToken === "") {
      throw new Error(
        "EXECUTOR=workers-ai requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment",
      );
    }
    const model = (env.WORKERS_AI_MODEL ?? "").trim() || DEFAULT_WORKERS_AI_MODEL;
    const escalationModel =
      (env.WORKERS_AI_ESCALATION_MODEL ?? "").trim() || DEFAULT_WORKERS_AI_ESCALATION_MODEL;
    const invoke = createWorkersAiRestInvoke({ accountId, apiToken });
    const executor = new WorkersAiExecutor({
      model,
      ...(env.WORKERS_AI_FALLBACK_MODEL
        ? { fallbackModel: env.WORKERS_AI_FALLBACK_MODEL.trim() }
        : {}),
      invoke,
    });
    return {
      executor,
      description: `workers-ai (base ${model}, escalation ${escalationModel})`,
      live: true,
      baseModel: model,
      escalationModel,
      escalationModels: [escalationModel],
    };
  }
  if (choice === "ai-gateway") {
    // BYOK: the gateway URL and the gateway credential come from the environment
    // only; the raw provider key lives in the Cloudflare account and the gateway
    // injects it. Fail clearly rather than silently falling back to a noop in a
    // run the user explicitly asked to be live.
    const gatewayUrl = (env.CLOUDFLARE_AI_GATEWAY_URL ?? "").trim();
    const gatewayToken = (env.CLOUDFLARE_AI_GATEWAY_TOKEN ?? "").trim();
    if (gatewayUrl === "" || gatewayToken === "") {
      throw new Error(
        "EXECUTOR=ai-gateway requires CLOUDFLARE_AI_GATEWAY_URL and CLOUDFLARE_AI_GATEWAY_TOKEN in the environment",
      );
    }
    const model = (env.AI_GATEWAY_MODEL ?? "").trim() || DEFAULT_AI_GATEWAY_MODEL;
    // The ORDERED escalation ladder: prefer the plural
    // AI_GATEWAY_ESCALATION_MODELS (a comma-separated ordered list, e.g.
    // "gpt-4.1,gpt-5") so each retry round steps to the next better model. For
    // backward compatibility, when the list is unset fall back to the singular
    // AI_GATEWAY_ESCALATION_MODEL as a one-element list, then to the default.
    const escalationModels = parseEscalationModels(
      env.AI_GATEWAY_ESCALATION_MODELS,
      env.AI_GATEWAY_ESCALATION_MODEL,
      DEFAULT_AI_GATEWAY_ESCALATION_MODEL,
    );
    const escalationModel = escalationModels[0] ?? DEFAULT_AI_GATEWAY_ESCALATION_MODEL;
    const maxModelRetries = parseMaxModelRetries(
      env.AI_GATEWAY_MAX_MODEL_RETRIES,
      DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES,
    );
    const invoke = createAiGatewayRestInvoke({ gatewayUrl, gatewayToken });
    // Reuse the Workers AI executor shape with the gateway transport injected:
    // the prompt building, edit parsing, and bounded same-model retry are
    // identical, and the per-attempt context.model lets the ladder pass the
    // escalation model on a verify-fail retry.
    const executor = new WorkersAiExecutor({ model, invoke });
    return {
      executor,
      description: `ai-gateway (base ${model}, escalation ${escalationModels.join(" -> ")})`,
      live: true,
      baseModel: model,
      escalationModel,
      escalationModels,
      maxModelRetries,
    };
  }
  return {
    executor: new ScopedNoopExecutor(),
    description: "noop (deterministic, zero inference)",
    live: false,
    baseModel: "",
    escalationModel: "",
    escalationModels: [],
  };
}

/**
 * Parse the ordered escalation model ladder from the environment. The plural
 * AI_GATEWAY_ESCALATION_MODELS is a comma-separated ORDERED list (each retry
 * round uses the next entry). When it is unset or empty, fall back to the
 * singular AI_GATEWAY_ESCALATION_MODEL as a one-element list for backward
 * compatibility, then to the provided default. Blank entries are dropped and
 * each entry is trimmed; the result always has at least one element.
 */
function parseEscalationModels(
  plural: string | undefined,
  singular: string | undefined,
  fallback: string,
): readonly string[] {
  const fromList = (plural ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (fromList.length > 0) {
    return fromList;
  }
  const single = (singular ?? "").trim();
  if (single !== "") {
    return [single];
  }
  return [fallback];
}

/**
 * Parse a bounded max-retries value from the environment. A missing, non-finite,
 * or negative value falls back to the provided default; the value is floored to
 * a whole number of retries.
 */
function parseMaxModelRetries(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

/**
 * executor-select: choose the executor a live run uses from the environment,
 * keeping the credential handling in one place and out of the CLI.
 *
 * The selection mirrors the `.env` contract: `EXECUTOR` picks the inference
 * path. For `workers-ai`, this builds the live Workers AI executor over the REST
 * transport, reading the base model from `WORKERS_AI_MODEL` (defaulting to the
 * llama-3.3-70b fast model), the verify-fail escalation model from
 * `WORKERS_AI_ESCALATION_MODEL` (defaulting to glm-5.3), and the credential from
 * `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`. The token is read from the
 * environment and passed into the transport closure only; it is never returned,
 * logged, or written here.
 *
 * Any other value (or an unset `EXECUTOR`) selects the deterministic scoped-noop
 * executor, so an offline run and `make check` never call the network.
 */

import type { ExecutorProvider } from "@switchyard-change/model-adapters";
import {
  createWorkersAiRestInvoke,
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
export const DEFAULT_WORKERS_AI_ESCALATION_MODEL = "@cf/zai-org/glm-5.3";

/** A minimal environment view, so this is testable without process.env. */
export interface ExecutorEnv {
  readonly EXECUTOR?: string;
  readonly WORKERS_AI_MODEL?: string;
  readonly WORKERS_AI_FALLBACK_MODEL?: string;
  readonly WORKERS_AI_ESCALATION_MODEL?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_API_TOKEN?: string;
}

/** The outcome of selecting an executor: the provider plus a readable label. */
export interface SelectedExecutor {
  readonly executor: ExecutorProvider;
  /** A human-readable description of what was selected (no secrets). */
  readonly description: string;
  /** True when a real inference path (Workers AI) was selected. */
  readonly live: boolean;
  /** The base model id for the first attempt (empty for the noop path). */
  readonly baseModel: string;
  /**
   * The model id a verify-fail retry escalates to, so the ladder can run
   * attempt 2 on a stronger model by passing it as the per-attempt model id.
   * Empty for the deterministic noop path (no inference, no escalation).
   */
  readonly escalationModel: string;
}

/**
 * Select the executor from the environment. `env` defaults to `process.env`.
 * Throws a clear error when `workers-ai` is requested but the account id or
 * token is missing, rather than silently falling back to a noop that would mask
 * a real edit as deterministic.
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
    };
  }
  return {
    executor: new ScopedNoopExecutor(),
    description: "noop (deterministic, zero inference)",
    live: false,
    baseModel: "",
    escalationModel: "",
  };
}

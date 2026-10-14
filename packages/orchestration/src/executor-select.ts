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
 *
 * `SWITCHYARD_INFERENCE` picks the inference path for EVERY model role (the
 * executor and its escalation ladder, the planner, the agent turns, and tool
 * authoring): `gateway` (the default) keeps the `EXECUTOR` selection above;
 * `claude-cli` runs every role through the operator's own locally installed,
 * logged-in Claude Code CLI (see model-adapters cli-transport.ts), ignoring
 * `EXECUTOR` and needing no gateway credential; `codex-cli` does the same
 * through the operator's own logged-in OpenAI Codex CLI. In CLI mode the models
 * come from CLI_MODEL, CLI_ESCALATION_MODELS, CLI_PLANNER_MODEL, CLI_AGENT_MODEL,
 * and CLI_TOOL_MODELS (each mode has its own defaults), the binary from
 * CLAUDE_CLI_BIN or CODEX_CLI_BIN, the per-call timeout from
 * CLI_TIMEOUT_MS, and the advisory Jev layer is off unless CLI_JEV=gateway.
 */

import { runtimeEnv } from "./credentials.ts";
import type { BoardDigest, BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport, ExecutorProvider, PlannerPlan } from "@switchyard-change/model-adapters";
import {
  createAiGatewayToolRegionFiller,
  type ToolRegionFiller,
  agentTurnMaxTokens,
  createAiGatewayAgentTurnInvoke,
  createAiGatewayJevInvoke,
  createAiGatewayPlannerInvoke,
  createAiGatewayRestInvoke,
  createWorkersAiRestInvoke,
  DEFAULT_AI_GATEWAY_ESCALATION_MODEL,
  DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES,
  DEFAULT_AI_GATEWAY_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  gatewaySlugFromUrl,
  parseTokenCeiling,
  ScopedNoopExecutor,
  WorkersAiExecutor,
  type AskJev,
  cliDriverFor,
  createAgentTurnInvoke,
  createCliInvoke,
  createCliJsonSchemaCaller,
  createPlannerInvoke,
  createToolRegionFiller,
  DEFAULT_CLI_TIMEOUT_MS,
  parseInferenceMode,
  type CliDriver,
  type InferenceMode,
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
  readonly AI_GATEWAY_PLANNER_MODEL?: string;
  readonly AI_GATEWAY_AGENT_MODEL?: string;
  /** The board turn's completion-token ceiling (a positive integer; default by model family). */
  readonly AI_GATEWAY_AGENT_MAX_TOKENS?: string;
  /** The edit ceiling for a non-reasoning model (a positive integer; default 8192). */
  readonly AI_GATEWAY_EXECUTOR_MAX_TOKENS?: string;
  /** The edit ceiling for a reasoning model (a positive integer; default 32768). */
  readonly AI_GATEWAY_EXECUTOR_REASONING_MAX_TOKENS?: string;
  /** The plan ceiling for a non-reasoning model (a positive integer; default 4096). */
  readonly AI_GATEWAY_PLANNER_MAX_TOKENS?: string;
  /** The plan ceiling for a reasoning model (a positive integer; default 16384). */
  readonly AI_GATEWAY_PLANNER_REASONING_MAX_TOKENS?: string;
  readonly AI_GATEWAY_ESCALATION_MODEL?: string;
  readonly AI_GATEWAY_ESCALATION_MODELS?: string;
  readonly AI_GATEWAY_MAX_MODEL_RETRIES?: string;
  readonly CLOUDFLARE_AI_GATEWAY_URL?: string;
  readonly CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
  readonly CF_AIG_GATEWAY_ID?: string;
  readonly JEV_CONFIDENCE_THRESHOLD?: string;
  /** The inference path for every model role: gateway (default), claude-cli, or codex-cli. */
  readonly SWITCHYARD_INFERENCE?: string;
  /** CLI mode: the executor's base model (default sonnet). */
  readonly CLI_MODEL?: string;
  /** CLI mode: the ordered escalation ladder, comma separated (default opus). */
  readonly CLI_ESCALATION_MODELS?: string;
  /** CLI mode: the planner's base model (default sonnet). */
  readonly CLI_PLANNER_MODEL?: string;
  /** CLI mode: the board agents' turn model (default sonnet). */
  readonly CLI_AGENT_MODEL?: string;
  /** CLI mode: the tool authoring models, strongest first, comma separated (default opus,sonnet). */
  readonly CLI_TOOL_MODELS?: string;
  /** CLI mode: the Claude Code binary (default `claude` on PATH). */
  readonly CLAUDE_CLI_BIN?: string;
  /** The codex binary for codex-cli (default `codex` on PATH). */
  readonly CODEX_CLI_BIN?: string;
  /** CLI mode: the per-call timeout in ms (a positive integer; default 300000). */
  readonly CLI_TIMEOUT_MS?: string;
  /** CLI mode: `gateway` keeps the advisory Jev layer on the AI Gateway (needs its credentials); default off. */
  readonly CLI_JEV?: string;
}

/** CLI mode defaults (Claude Code model aliases). */
export const DEFAULT_CLI_MODEL = "sonnet";
export const DEFAULT_CLI_ESCALATION_MODELS: readonly string[] = ["opus"];
export const DEFAULT_CLI_PLANNER_MODEL = "sonnet";
export const DEFAULT_CLI_AGENT_MODEL = "sonnet";
export const DEFAULT_CLI_TOOL_MODELS: readonly string[] = ["opus", "sonnet"];

/**
 * The codex-cli defaults: the same base and stronger split as Claude's sonnet
 * and opus, with model ids a ChatGPT-login Codex accepts (verified 2026-10-14).
 */
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_ESCALATION_MODELS: readonly string[] = ["gpt-6.1-sol"];
export const DEFAULT_CODEX_PLANNER_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_AGENT_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_TOOL_MODELS: readonly string[] = ["gpt-6.1-sol", "gpt-5.5"];

/** The resolved local-CLI inference configuration (no secrets: the CLI holds its own login). */
export interface CliInference {
  readonly mode: Exclude<InferenceMode, "gateway">;
  readonly driver: CliDriver;
  readonly timeoutMs: number;
  readonly executorModel: string;
  readonly escalationModels: readonly string[];
  readonly plannerModel: string;
  readonly agentModel: string;
  /** Strongest first. */
  readonly toolModels: readonly string[];
  /** Whether the advisory Jev layer stays on the AI Gateway (opt-in) or is off. */
  readonly jev: "off" | "gateway";
}

/** The inference mode from the environment (SWITCHYARD_INFERENCE; default gateway). Throws on an unknown value. */
export function selectInferenceMode(env: ExecutorEnv = runtimeEnv()): InferenceMode {
  return parseInferenceMode(env.SWITCHYARD_INFERENCE);
}

/** A comma-separated model list (blank entries dropped), or the fallback when empty. */
function parseModelList(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  const list = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return list.length > 0 ? list : fallback;
}

/**
 * The local-CLI inference configuration, or undefined in gateway mode. Throws
 * a clear error for an unknown mode and for a CLI_TIMEOUT_MS that is not a
 * positive integer.
 */
export function selectCliInference(env: ExecutorEnv = runtimeEnv()): CliInference | undefined {
  const mode = selectInferenceMode(env);
  if (mode === "gateway") {
    return undefined;
  }
  const claudeBin = (env.CLAUDE_CLI_BIN ?? "").trim();
  const codexBin = (env.CODEX_CLI_BIN ?? "").trim();
  const driver = cliDriverFor(mode, { ...(claudeBin !== "" ? { claudeBin } : {}), ...(codexBin !== "" ? { codexBin } : {}) });
  const codex = mode === "codex-cli";
  const timeoutRaw = (env.CLI_TIMEOUT_MS ?? "").trim();
  const timeoutMs = timeoutRaw === "" ? DEFAULT_CLI_TIMEOUT_MS : /^[0-9]+$/.test(timeoutRaw) ? Number(timeoutRaw) : Number.NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`CLI_TIMEOUT_MS must be a positive integer number of milliseconds (got ${JSON.stringify(env.CLI_TIMEOUT_MS ?? "")})`);
  }
  const jevRaw = (env.CLI_JEV ?? "").trim().toLowerCase();
  if (jevRaw !== "" && jevRaw !== "off" && jevRaw !== "gateway") {
    throw new Error(`CLI_JEV must be off or gateway (got ${JSON.stringify(env.CLI_JEV ?? "")})`);
  }
  return {
    mode,
    driver,
    timeoutMs,
    executorModel: (env.CLI_MODEL ?? "").trim() || (codex ? DEFAULT_CODEX_MODEL : DEFAULT_CLI_MODEL),
    escalationModels: parseModelList(env.CLI_ESCALATION_MODELS, codex ? DEFAULT_CODEX_ESCALATION_MODELS : DEFAULT_CLI_ESCALATION_MODELS),
    plannerModel: (env.CLI_PLANNER_MODEL ?? "").trim() || (codex ? DEFAULT_CODEX_PLANNER_MODEL : DEFAULT_CLI_PLANNER_MODEL),
    agentModel: (env.CLI_AGENT_MODEL ?? "").trim() || (codex ? DEFAULT_CODEX_AGENT_MODEL : DEFAULT_CLI_AGENT_MODEL),
    toolModels: parseModelList(env.CLI_TOOL_MODELS, codex ? DEFAULT_CODEX_TOOL_MODELS : DEFAULT_CLI_TOOL_MODELS),
    jev: jevRaw === "gateway" ? "gateway" : "off",
  };
}

/** Every model a CLI-mode run may call (for the meter's subscription accounting). */
export function cliInferenceModels(cli: CliInference): string[] {
  return [...new Set([cli.executorModel, ...cli.escalationModels, cli.plannerModel, cli.agentModel, ...cli.toolModels])];
}

/**
 * One line naming the inference path a run uses, for the run header (no
 * secrets), for example "inference: local claude CLI (executor sonnet ->
 * opus; planner sonnet; agent turns sonnet; tools opus, sonnet); Jev off".
 */
export function describeInference(env: ExecutorEnv = runtimeEnv()): string {
  const cli = selectCliInference(env);
  const jev = selectJev(env);
  const jevPart = jev.live ? `Jev on (${jev.description})` : "Jev off";
  if (cli !== undefined) {
    return (
      `inference: local ${cli.driver.label} on this machine's own login (executor ${[cli.executorModel, ...cli.escalationModels].join(" -> ")}; ` +
      `planner ${cli.plannerModel}; agent turns ${cli.agentModel}; tools ${cli.toolModels.join(", ")}); ${jevPart}`
    );
  }
  const choice = (env.EXECUTOR ?? "").trim().toLowerCase();
  const path = choice === "ai-gateway" ? "AI Gateway" : choice === "workers-ai" ? "Workers AI (executor only)" : "none (deterministic noop executor)";
  return `inference: ${path}; ${jevPart}`;
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

/** The EXECUTOR values selectExecutor accepts (unset also selects the noop). */
export const SUPPORTED_EXECUTORS: readonly string[] = ["ai-gateway", "workers-ai", "noop"];

/**
 * Select the executor from the environment. `env` defaults to `process.env`.
 * Throws a clear error when a live path (`workers-ai` or `ai-gateway`) is
 * requested but its credentials are missing, or when EXECUTOR names an
 * unsupported executor, rather than silently falling back to a noop that would
 * mask a real edit as deterministic. Unset or "noop" selects the noop stub.
 */
export function selectExecutor(env: ExecutorEnv = runtimeEnv()): SelectedExecutor {
  const cli = selectCliInference(env);
  if (cli !== undefined) {
    // The operator's own local CLI: the same executor shape (prompt building,
    // anchored edit parsing, bounded same-model retry) over the CLI transport.
    const invoke = createCliInvoke(cli.driver, { timeoutMs: cli.timeoutMs });
    const executor = new WorkersAiExecutor({ model: cli.executorModel, invoke, providerLabel: cli.driver.label });
    return {
      executor,
      description: `${cli.mode} (base ${cli.executorModel}, escalation ${cli.escalationModels.join(" -> ")})`,
      live: true,
      baseModel: cli.executorModel,
      escalationModel: cli.escalationModels[0] ?? cli.executorModel,
      escalationModels: cli.escalationModels,
      maxModelRetries: DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES,
    };
  }
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
    // The completion ceiling is per model (a reasoning model gets a larger one
    // plus reasoning_effort); the environment may override either ceiling.
    const executorMax = parseTokenCeiling(env.AI_GATEWAY_EXECUTOR_MAX_TOKENS);
    const executorReasoningMax = parseTokenCeiling(env.AI_GATEWAY_EXECUTOR_REASONING_MAX_TOKENS);
    const invoke = createAiGatewayRestInvoke({
      gatewayUrl,
      gatewayToken,
      ...(executorMax !== undefined ? { maxTokens: executorMax } : {}),
      ...(executorReasoningMax !== undefined ? { reasoningMaxTokens: executorReasoningMax } : {}),
    });
    // Reuse the Workers AI executor shape with the gateway transport injected:
    // the prompt building, edit parsing, and bounded same-model retry are
    // identical, and the per-attempt context.model lets the ladder pass the
    // escalation model on a verify-fail retry.
    const executor = new WorkersAiExecutor({ model, invoke, providerLabel: "AI Gateway" });
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
  // Only an unset/blank EXECUTOR or an explicit "noop" selects the deterministic
  // stub. Any other value (a typo, or an executor this repo does not implement)
  // is an error: silently running the noop on a run the operator meant to be
  // live would mask the missing inference as a real edit.
  if (choice !== "" && choice !== "noop") {
    throw new Error(
      `unsupported EXECUTOR=${JSON.stringify(env.EXECUTOR ?? "")}: supported values are ` +
        `${SUPPORTED_EXECUTORS.join(", ")} (or leave it unset for the deterministic noop)`,
    );
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

/**
 * The plan transport the planner pass calls: a goal plus the structural map in,
 * a plan object out. It is structurally the model-adapters PlannerInvoke, named
 * here so the orchestration layer can hand it to change-core's planGoal without
 * change-core depending on the adapter package.
 */
export type PlanTransport = (request: {
  readonly model: string;
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }[];
}) => Promise<PlannerPlan>;

/**
 * The outcome of selecting a planner: whether the inference planner is live, the
 * injectable plan transport when it is, and the ORDERED model ladder (base plus
 * escalation models) the plan pass escalates through on an invalid plan.
 */
export interface SelectedPlanner {
  /**
   * True when a schema-constrained inference planner is configured
   * (EXECUTOR=ai-gateway with gateway credentials). When false the caller keeps
   * the deterministic heuristic decomposition, so offline runs, `make check`,
   * and the demo stay deterministic and anti-puppet holds on the heuristic path.
   */
  readonly live: boolean;
  /** A human-readable description of what was selected (no secrets). */
  readonly description: string;
  /** The injected plan transport, present only when `live` is true. */
  readonly plan?: PlanTransport;
  /** The base plan model (empty when not live). */
  readonly baseModel: string;
  /** The ORDERED escalation ladder the plan pass walks on an invalid plan. */
  readonly escalationModels: readonly string[];
}

/**
 * Select the schema-constrained planner from the environment, independently of
 * the executor. The inference planner is live ONLY for EXECUTOR=ai-gateway with
 * gateway credentials present: it builds the AI Gateway plan transport (the
 * json_schema plan call) over the same gateway URL and token the executor uses,
 * reads the plan model from AI_GATEWAY_PLANNER_MODEL (falling back to
 * AI_GATEWAY_MODEL, then the default), and reuses the ordered escalation ladder
 * from AI_GATEWAY_ESCALATION_MODELS (or the singular, then the default) so an
 * invalid plan escalates through the same models the executor does.
 *
 * For any other EXECUTOR (or an unset one, the noop/offline path), the planner
 * is NOT live: the caller keeps the deterministic heuristic decomposition, so
 * `make check`, the demo, and the anti-puppet substrate stay offline and
 * deterministic. Missing gateway credentials under EXECUTOR=ai-gateway also
 * yield a non-live planner here (the executor selection is where that misconfig
 * is surfaced as an error), so the planner never falls back to a network call it
 * cannot authenticate.
 */
export function selectPlanner(env: ExecutorEnv = runtimeEnv()): SelectedPlanner {
  const cli = selectCliInference(env);
  if (cli !== undefined) {
    const invoke = createPlannerInvoke(createCliJsonSchemaCaller(cli.driver, { timeoutMs: cli.timeoutMs }));
    return {
      live: true,
      description: `${cli.mode} planner (base ${cli.plannerModel}, escalation ${cli.escalationModels.join(" -> ")})`,
      plan: (request) => invoke(request),
      baseModel: cli.plannerModel,
      escalationModels: cli.escalationModels,
    };
  }
  const choice = (env.EXECUTOR ?? "").trim().toLowerCase();
  if (choice !== "ai-gateway") {
    return {
      live: false,
      description: "heuristic (deterministic, offline decomposition)",
      baseModel: "",
      escalationModels: [],
    };
  }
  const gatewayUrl = (env.CLOUDFLARE_AI_GATEWAY_URL ?? "").trim();
  const gatewayToken = (env.CLOUDFLARE_AI_GATEWAY_TOKEN ?? "").trim();
  if (gatewayUrl === "" || gatewayToken === "") {
    // The gateway is not configured; keep the heuristic rather than attempting an
    // unauthenticated network call.
    return {
      live: false,
      description: "heuristic (gateway credentials absent)",
      baseModel: "",
      escalationModels: [],
    };
  }
  const baseModel =
    (env.AI_GATEWAY_PLANNER_MODEL ?? "").trim() ||
    (env.AI_GATEWAY_MODEL ?? "").trim() ||
    DEFAULT_AI_GATEWAY_MODEL;
  const escalationModels = parseEscalationModels(
    env.AI_GATEWAY_ESCALATION_MODELS,
    env.AI_GATEWAY_ESCALATION_MODEL,
    DEFAULT_AI_GATEWAY_ESCALATION_MODEL,
  );
  const plannerMax = parseTokenCeiling(env.AI_GATEWAY_PLANNER_MAX_TOKENS);
  const plannerReasoningMax = parseTokenCeiling(env.AI_GATEWAY_PLANNER_REASONING_MAX_TOKENS);
  const invoke = createAiGatewayPlannerInvoke({
    gatewayUrl,
    gatewayToken,
    ...(plannerMax !== undefined ? { maxTokens: plannerMax } : {}),
    ...(plannerReasoningMax !== undefined ? { reasoningMaxTokens: plannerReasoningMax } : {}),
  });
  const plan: PlanTransport = (request) => invoke(request);
  return {
    live: true,
    description: `ai-gateway planner (base ${baseModel}, escalation ${escalationModels.join(" -> ")})`,
    plan,
    baseModel,
    escalationModels,
  };
}

/** The outcome of selecting the board agents' turn transport. */
export interface SelectedAgentTurn {
  /** True when turns run on a model through the AI Gateway. */
  readonly live: boolean;
  /** A human-readable description (no secrets). */
  readonly description: string;
  /** The model each turn runs on (empty when not live). */
  readonly model: string;
  readonly transport?: AgentTurnTransport<BoardDigest, BoardMessage>;
}

/**
 * Select the board agents' turn transport from the environment. Like the
 * planner it is live ONLY for EXECUTOR=ai-gateway with gateway credentials: each
 * turn is one strict json_schema call through the gateway (the planner's path),
 * on AI_GATEWAY_AGENT_MODEL (falling back to AI_GATEWAY_MODEL, then the
 * default). Otherwise it is not live and no transport is returned: a live board
 * run then refuses to start rather than silently substituting the offline
 * policy, which only `run-board --offline` (the demo and tests) uses.
 */
export function selectAgentTurn(env: ExecutorEnv = runtimeEnv()): SelectedAgentTurn {
  const cli = selectCliInference(env);
  if (cli !== undefined) {
    const invoke = createAgentTurnInvoke({
      model: cli.agentModel,
      call: createCliJsonSchemaCaller(cli.driver, { timeoutMs: cli.timeoutMs }),
    });
    return {
      live: true,
      description: `${cli.mode} agent turns (model ${cli.agentModel}, local ${cli.driver.label})`,
      model: cli.agentModel,
      transport: (input) => invoke(input),
    };
  }
  const choice = (env.EXECUTOR ?? "").trim().toLowerCase();
  const gatewayUrl = (env.CLOUDFLARE_AI_GATEWAY_URL ?? "").trim();
  const gatewayToken = (env.CLOUDFLARE_AI_GATEWAY_TOKEN ?? "").trim();
  if (choice !== "ai-gateway" || gatewayUrl === "" || gatewayToken === "") {
    return {
      live: false,
      description:
        choice !== "ai-gateway"
          ? "no live turn model (EXECUTOR is not ai-gateway)"
          : "no live turn model (gateway credentials absent)",
      model: "",
    };
  }
  const model =
    (env.AI_GATEWAY_AGENT_MODEL ?? "").trim() || (env.AI_GATEWAY_MODEL ?? "").trim() || DEFAULT_AI_GATEWAY_MODEL;
  const maxTokens = parseTokenCeiling(env.AI_GATEWAY_AGENT_MAX_TOKENS) ?? agentTurnMaxTokens(model);
  const invoke = createAiGatewayAgentTurnInvoke({ gatewayUrl, gatewayToken, model, maxTokens });
  return {
    live: true,
    description: `ai-gateway agent turns (model ${model}, up to ${maxTokens} completion tokens)`,
    model,
    transport: (input) => invoke(input),
  };
}

/** The run-live flag that explicitly opts a live run into the heuristic planner. */
export const ALLOW_HEURISTIC_PLANNER_FLAG = "--allow-heuristic-planner";

/**
 * The decision for which planner a LIVE goal-driven run may use. On a live run
 * the LLM is the planner; the heuristic decomposition is the offline stub and
 * must never be a SILENT live substitute. So:
 *   - "llm": the gateway planner is live, plan with it;
 *   - "heuristic-allowed": no live planner, but the operator passed the explicit
 *     opt-in flag, so plan heuristically and print `banner` loudly;
 *   - "refused": no live planner and no opt-in, so the run must fail with
 *     `error` before it creates anything on the Worker.
 * Offline commands (run, run-goal, decompose, the demo) never call this.
 */
export type LivePlannerDecision =
  | { readonly kind: "llm" }
  | { readonly kind: "heuristic-allowed"; readonly banner: string }
  | { readonly kind: "refused"; readonly error: string };

/** Decide which planner a live goal-driven run may use (pure, offline-testable). */
export function decideLivePlanner(input: {
  readonly planner: Pick<SelectedPlanner, "live" | "description">;
  readonly allowHeuristic: boolean;
}): LivePlannerDecision {
  if (input.planner.live) {
    return { kind: "llm" };
  }
  if (input.allowHeuristic) {
    return {
      kind: "heuristic-allowed",
      banner: loudBanner([
        "HEURISTIC PLANNER IN USE ON A LIVE RUN (explicit opt-in)",
        `No LLM planner is available: ${input.planner.description}.`,
        "The goal is decomposed by the deterministic heuristic, not by a model.",
        `This was allowed only because ${ALLOW_HEURISTIC_PLANNER_FLAG} was passed.`,
      ]),
    };
  }
  return {
    kind: "refused",
    error:
      `a live run needs the LLM planner, but none is available (${input.planner.description}). ` +
      "Set EXECUTOR=ai-gateway with CLOUDFLARE_AI_GATEWAY_URL and CLOUDFLARE_AI_GATEWAY_TOKEN " +
      "(or SWITCHYARD_INFERENCE=claude-cli for the local Claude Code CLI), " +
      `pass --change <change.yaml> to run a hand-authored Change, or pass ${ALLOW_HEURISTIC_PLANNER_FLAG} ` +
      "to knowingly use the heuristic decomposition.",
  };
}

/**
 * The loud banner a live run prints when the gateway planner's model ladder was
 * exhausted and the plan fell back to the heuristic decomposition. The fallback
 * is also recorded on the Change itself (`plan.source: "heuristic-fallback"`),
 * which rides the spec to the Worker so the planner node shows it.
 */
export function plannerFallbackBanner(
  diagnostics: readonly PlannerFailure[] = [],
): string {
  return loudBanner([
    "PLANNER FELL BACK TO THE HEURISTIC DECOMPOSITION",
    ...(allPlannerCallsRateLimited(diagnostics)
      ? [
          `All planner calls were rate limited (HTTP 429) on ${[...new Set(diagnostics.map((d) => d.model))].join(", ")}:`,
          "the provider's rate or quota limit, so no model planned this run.",
        ]
      : []),
    "Every model in the planner ladder failed to produce a usable plan, so this live",
    'run uses the deterministic heuristic plan (recorded as plan.source "heuristic-fallback").',
    ...diagnostics.map((d) => `  ${d.model}: ${d.reason}`),
  ]);
}

/** One planner ladder model's failure (a change-core PlanDiagnostic, or its subset). */
export interface PlannerFailure {
  readonly model: string;
  readonly reason: string;
  /** True when the call was rate limited (HTTP 429, or 503 with Retry-After). */
  readonly rateLimited?: boolean;
}

/** True when the planner ladder failed ONLY because every call was rate limited. */
export function allPlannerCallsRateLimited(diagnostics: readonly PlannerFailure[]): boolean {
  return diagnostics.length > 0 && diagnostics.every((d) => d.rateLimited === true);
}

/** The run-board flag that refuses to start when the planner fails (no heuristic fallback). */
export const REQUIRE_MODEL_PLAN_FLAG = "--require-model-plan";

/**
 * Under --require-model-plan, the error a live run refuses to start with when
 * the planner produced no plan (it fell back to the heuristic); undefined when
 * a model planned the run. Names every ladder model's failure, and says so when
 * every planner call was rate limited.
 */
export function modelPlanRefusal(input: {
  readonly source: string | undefined;
  readonly diagnostics?: readonly PlannerFailure[];
}): string | undefined {
  if (input.source !== "heuristic-fallback") {
    return undefined;
  }
  const diagnostics = input.diagnostics ?? [];
  const why = allPlannerCallsRateLimited(diagnostics)
    ? "all planner calls were rate limited (HTTP 429): the provider's rate or quota limit"
    : "every model in the planner ladder failed to produce a usable plan";
  return (
    `${REQUIRE_MODEL_PLAN_FLAG}: the planner produced no plan (${why}), and a heuristic plan was refused` +
    (diagnostics.length > 0 ? ` (${diagnostics.map((d) => `${d.model}: ${d.reason}`).join("; ")})` : "") +
    ". Nothing was created; retry later or drop the flag to accept the heuristic decomposition."
  );
}

/** Frame lines in a rule so a warning cannot be missed in the run output. */
function loudBanner(lines: readonly string[]): string {
  const rule = "=".repeat(78);
  return [rule, ...lines.map((line) => `!! ${line}`), rule].join("\n");
}

/** The default accept-when-confident threshold for the Jev decision junctures. */
export const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.75;

/**
 * The outcome of selecting the Jev typed-decision layer: whether a decision model
 * is live, the injectable typed caller when it is, and the accept-when-confident
 * threshold the junctures use. When not live the caller keeps the deterministic
 * heuristic + mechanical-gate path and Jev is simply absent (no jev nodes), so
 * offline runs, the demo, and `make check` stay deterministic and offline.
 */
export interface SelectedJev {
  /**
   * True when a decision model is configured (EXECUTOR=ai-gateway with gateway
   * credentials present). When false the caller runs no decision juncture, so
   * the heuristic + mechanical-gate path is unchanged and no jev node appears.
   */
  readonly live: boolean;
  /** A human-readable description of what was selected (no secrets). */
  readonly description: string;
  /** The injected typed-decision caller, present only when `live` is true. */
  readonly ask?: AskJev;
  /** The accept-when-confident threshold in [0, 1] the junctures use. */
  readonly threshold: number;
}

/**
 * Select the Jev typed-decision layer from the environment, independently of the
 * executor and the planner. It is live ONLY for EXECUTOR=ai-gateway with gateway
 * credentials present (exactly like selectPlanner): it builds the decision
 * transport over the NATIVE account run endpoint, sourcing the account id from
 * CLOUDFLARE_ACCOUNT_ID and the account API token from CLOUDFLARE_API_TOKEN, and
 * routing by the gateway id read from CF_AIG_GATEWAY_ID (falling back to the slug
 * derived from CLOUDFLARE_AI_GATEWAY_URL). It reads the accept-when-confident
 * threshold from JEV_CONFIDENCE_THRESHOLD (default 0.75, clamped to [0, 1]).
 *
 * For any other EXECUTOR (or an unset one, the noop/offline path), it is NOT
 * live: the caller runs no decision juncture, so Jev is simply absent and the
 * heuristic + mechanical-gate path is unchanged, keeping `make check`, the demo,
 * and the anti-puppet substrate offline and deterministic. Missing gateway or
 * account credentials under EXECUTOR=ai-gateway also yield a non-live Jev here
 * (the executor selection surfaces that misconfig as an error), so Jev never
 * attempts an unauthenticated network call.
 */
export function selectJev(env: ExecutorEnv = runtimeEnv()): SelectedJev {
  const threshold = parseConfidenceThreshold(
    env.JEV_CONFIDENCE_THRESHOLD,
    DEFAULT_JEV_CONFIDENCE_THRESHOLD,
  );
  const cli = selectCliInference(env);
  if (cli !== undefined && cli.jev === "off") {
    // Advisory only: a CLI-mode run works without it. CLI_JEV=gateway opts in.
    return { live: false, description: `jev off (local ${cli.driver.label} inference; CLI_JEV=gateway keeps it on the AI Gateway)`, threshold };
  }
  const choice = (env.EXECUTOR ?? "").trim().toLowerCase();
  if (cli === undefined && choice !== "ai-gateway") {
    return { live: false, description: "jev off (heuristic + gate path)", threshold };
  }
  const gatewayUrl = (env.CLOUDFLARE_AI_GATEWAY_URL ?? "").trim();
  const gatewayToken = (env.CLOUDFLARE_AI_GATEWAY_TOKEN ?? "").trim();
  if (gatewayUrl === "" || gatewayToken === "") {
    return { live: false, description: "jev off (gateway credentials absent)", threshold };
  }
  // The decision call posts to the NATIVE account run endpoint, so it needs the
  // account id and the account API token in addition to the gateway routing id.
  // Without them Jev is not live rather than posting an unauthenticated call.
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (accountId === "" || apiToken === "") {
    return { live: false, description: "jev off (account credentials absent)", threshold };
  }
  // The gateway id routes the decision call: prefer the explicit env slug, else
  // derive it from the gateway URL. When neither yields a slug, Jev is not live
  // rather than posting without a routing header.
  const gatewayId = (env.CF_AIG_GATEWAY_ID ?? "").trim() || gatewaySlugFromUrl(gatewayUrl);
  if (gatewayId === "") {
    return { live: false, description: "jev off (no gateway id)", threshold };
  }
  const invoke = createAiGatewayJevInvoke({ accountId, apiToken, gatewayId });
  const ask: AskJev = (state, questions) => invoke({ state, questions });
  return {
    live: true,
    description: `ai-gateway jev (gateway ${gatewayId}, threshold ${threshold})`,
    ask,
    threshold,
  };
}

/**
 * Parse the accept-when-confident threshold from the environment. A missing,
 * non-finite, or out-of-range value falls back to the provided default; a valid
 * value is clamped to [0, 1]. Mirrors parseMaxModelRetries' defensive parse.
 */
function parseConfidenceThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, n));
}

/** The tool-region filler for agent-built tools, when the AI Gateway is live. */
export interface SelectedToolFiller {
  readonly live: boolean;
  readonly description: string;
  /** The models in the order they are tried: STRONGEST first (the ladder's top), down to the base model. */
  readonly models: readonly string[];
  readonly filler?: ToolRegionFiller;
}

/**
 * Select how a live run fills tool skeletons: one schema-constrained call per
 * build through the AI Gateway, on the strongest configured model first (the
 * last entry of the escalation ladder), falling back down the ladder only on a
 * transport error. Tools are small but must be correct.
 */
export function selectToolFiller(env: ExecutorEnv = runtimeEnv()): SelectedToolFiller {
  const cli = selectCliInference(env);
  if (cli !== undefined) {
    const models = [...new Set(cli.toolModels)];
    return {
      live: true,
      description: `${cli.mode} tool fills (models, strongest first: ${models.join(", ")})`,
      models,
      filler: createToolRegionFiller({ models, call: createCliJsonSchemaCaller(cli.driver, { timeoutMs: cli.timeoutMs }) }),
    };
  }
  const choice = (env.EXECUTOR ?? "").trim().toLowerCase();
  const gatewayUrl = (env.CLOUDFLARE_AI_GATEWAY_URL ?? "").trim();
  const gatewayToken = (env.CLOUDFLARE_AI_GATEWAY_TOKEN ?? "").trim();
  if (choice !== "ai-gateway" || gatewayUrl === "" || gatewayToken === "") {
    return { live: false, description: "no live tool author (the executor writes tools)", models: [] };
  }
  const base = (env.AI_GATEWAY_MODEL ?? "").trim() || DEFAULT_AI_GATEWAY_MODEL;
  const ladder = parseEscalationModels(env.AI_GATEWAY_ESCALATION_MODELS, env.AI_GATEWAY_ESCALATION_MODEL, DEFAULT_AI_GATEWAY_ESCALATION_MODEL);
  const models = [...new Set([...[...ladder].reverse(), base])];
  return {
    live: true,
    description: `ai-gateway tool fills (models, strongest first: ${models.join(", ")})`,
    models,
    filler: createAiGatewayToolRegionFiller({ gatewayUrl, gatewayToken, models }),
  };
}

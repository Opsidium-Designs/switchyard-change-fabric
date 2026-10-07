/**
 * model-adapters: pluggable executors behind one ExecutorProvider contract.
 *
 *   - types:              the ExecutorProvider contract and its result/cost shapes
 *   - NoopExecutor:       deterministic, zero-inference executor for tests/offline
 *   - OpenAiCompatibleExecutor: thin shape for a generic OpenAI-compatible /
 *                         AI Gateway path (no secrets; transport is injected)
 *
 * Only the local runner consumes this package; the Worker never does.
 */

export type {
  DiscoveredUnit,
  ExecutionCost,
  ExecutionResult,
  ExecutionStatus,
  ExecutorContext,
  ExecutorProvider,
} from "./types.ts";

export type { NoopExecutorOptions } from "./noop.ts";
export { NoopExecutor } from "./noop.ts";

export type { ScopedNoopExecutorOptions } from "./scoped-noop.ts";
export { ScopedNoopExecutor } from "./scoped-noop.ts";

export type { DiscoveringExecutorOptions } from "./discovering.ts";
export { DiscoveringExecutor } from "./discovering.ts";

export type {
  ChatFn,
  ChatRequest,
  ChatResult,
  ChatUsage,
  OpenAiCompatibleOptions,
  ProposedEdit,
} from "./openai-compatible.ts";
export { OpenAiCompatibleExecutor } from "./openai-compatible.ts";

export type {
  WorkersAiContextFile,
  WorkersAiEdit,
  WorkersAiExecutorOptions,
  WorkersAiInvoke,
  WorkersAiInvokeRequest,
  WorkersAiInvokeResult,
  WorkersAiMessage,
  WorkersAiRestOptions,
  WorkersAiStreamCallbacks,
  WorkersAiStreamStep,
  WorkersAiUsage,
} from "./workers-ai.ts";
export {
  coerceReplyText,
  createWorkersAiRestInvoke,
  DEFAULT_WORKERS_AI_FALLBACK_MODEL,
  DEFAULT_WORKERS_AI_MAX_TOKENS,
  DEFAULT_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_TIMEOUT_MS,
  extractReplyText,
  isTransientWorkersAiError,
  UnusableModelOutputError,
  WorkersAiExecutor,
  WorkersAiTimeoutError,
} from "./workers-ai.ts";

export type { AiGatewayRestOptions } from "./ai-gateway.ts";
export {
  createAiGatewayRestInvoke,
  DEFAULT_AI_GATEWAY_ESCALATION_MODEL,
  DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES,
  DEFAULT_AI_GATEWAY_MODEL,
} from "./ai-gateway.ts";

export type {
  AiGatewayPlannerOptions,
  PlannerInvoke,
  PlannerPlan,
  PlannerPlanUnit,
  PlannerRequest,
} from "./planner.ts";
export {
  createAiGatewayPlannerInvoke,
  DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS,
  DEFAULT_AI_GATEWAY_PLANNER_MODEL,
  parsePlannerPlan,
  PLANNER_PLAN_JSON_SCHEMA,
  PLANNER_PLAN_SCHEMA_NAME,
  PlannerResponseError,
} from "./planner.ts";

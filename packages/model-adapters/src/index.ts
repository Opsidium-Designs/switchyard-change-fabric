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

export type { ExecutorCallUsage } from "./call-usage.ts";
export { executorCallUsage, withCallUsage } from "./call-usage.ts";

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
  isModelBudgetError,
  isTransientWorkersAiError,
  MAX_EXECUTOR_RETRY_AFTER_MS,
  ModelBudgetError,
  UnusableModelOutputError,
  WorkersAiExecutor,
  WorkersAiTimeoutError,
} from "./workers-ai.ts";

export type { ModelBudget, ModelBudgetCeilings, ReasoningEffort } from "./model-budget.ts";
export {
  DEFAULT_EXECUTOR_MAX_TOKENS,
  DEFAULT_REASONING_EXECUTOR_MAX_TOKENS,
  DEFAULT_REASONING_PLANNER_MAX_TOKENS,
  EXECUTOR_REASONING_EFFORT,
  executorModelBudget,
  isReasoningModel,
  modelBudget,
  parseTokenCeiling,
  PLANNER_REASONING_EFFORT,
} from "./model-budget.ts";

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
  plannerModelBudget,
  PLANNER_PLAN_JSON_SCHEMA,
  PLANNER_PLAN_SCHEMA_NAME,
  PlannerResponseError,
} from "./planner.ts";

export type {
  AiGatewayJevOptions,
  AskJev,
  JevAnswer,
  JevAnswerType,
  JevInvoke,
  JevQuestion,
  JevQuestions,
  JevRequest,
} from "./jev.ts";
export {
  createAiGatewayJevInvoke,
  DEFAULT_CLOUDFLARE_API_BASE,
  DEFAULT_JEV_MAX_TOKENS,
  DEFAULT_JEV_MODEL,
  gatewaySlugFromUrl,
  jevErrorReason,
  JevResponseError,
  parseJevAnswers,
  serializeJevQuestion,
} from "./jev.ts";

export type { GatewayJsonSchemaCall, GatewayJsonSchemaReply } from "./gateway-json-schema.ts";
export { callGatewayJsonSchema } from "./gateway-json-schema.ts";

export type {
  AgentAction,
  AgentActionType,
  AgentCapsule,
  AgentChildItem,
  AgentMessageKind,
  AgentMessagePayload,
  AgentRepoExcerpt,
  AgentReviewFinding,
  AgentToolKind,
  AgentTurnHistoryEntry,
  AgentTurnInput,
  AgentTurnOutcome,
  AgentTurnRateLimit,
  AgentTurnTransport,
  AiGatewayAgentTurnOptions,
} from "./agent-turn.ts";
export {
  AGENT_ACTION_LIMITS,
  CLAMP_MARKER,
  AGENT_ACTION_TYPES,
  AGENT_MESSAGE_KINDS,
  AGENT_TOOL_KINDS,
  AGENT_TURN_JSON_SCHEMA,
  AGENT_TURN_MAX_CONTEXT_CHARS,
  AGENT_TURN_SCHEMA_NAME,
  AgentActionError,
  agentActionOrWait,
  buildAgentTurnMessages,
  createAiGatewayAgentTurnInvoke,
  agentTurnMaxTokens,
  DEFAULT_AGENT_TURN_MAX_TOKENS,
  DEFAULT_REASONING_AGENT_TURN_MAX_TOKENS,
  DIGEST_INLINE_PATHS,
  parseAgentAction,
  slugifyNeed,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
} from "./agent-turn.ts";

export type { AiGatewayToolRegionOptions, ToolRegionFill, ToolRegionFiller, ToolRegionRequest, ToolRegionSpec } from "./tool-regions.ts";
export {
  buildToolRegionMessages,
  CODEMOD_REGION_EXAMPLES,
  createAiGatewayToolRegionFiller,
  MAX_REGION_CODE,
  parseToolRegionFills,
  TOOL_REGIONS_JSON_SCHEMA,
  ToolRegionError,
} from "./tool-regions.ts";

export {
  describeRetryAfter,
  isRateLimitError,
  parseRetryAfter,
  RateLimitError,
  rateLimitErrorFor,
} from "./rate-limit.ts";
export { brokenByEdit, syntaxCheckAvailable, syntaxError } from "./syntax-check.ts";

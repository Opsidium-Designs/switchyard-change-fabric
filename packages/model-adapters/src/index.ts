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

export type {
  ChatFn,
  ChatRequest,
  ChatResult,
  ChatUsage,
  OpenAiCompatibleOptions,
  ProposedEdit,
} from "./openai-compatible.ts";
export { OpenAiCompatibleExecutor } from "./openai-compatible.ts";

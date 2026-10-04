/**
 * model-adapters: the ExecutorProvider contract and pluggable executors.
 *
 * An ExecutorProvider makes the actual change inside a cloned workspace. It is
 * consumed only by the local runner, never by the Worker, so inference concerns
 * stay out of the coordination core. The Change, workspace, verification, and
 * integration behavior are identical regardless of which executor is selected.
 */

/** Where an executor does its work: a checked-out workspace on disk. */
export interface ExecutorContext {
  /** Absolute path to the cloned worktree the executor may modify. */
  readonly worktreeDir: string;
  /** The WorkUnit id being executed (for logging and determinism). */
  readonly workUnitId: string;
  /** The WorkUnit objective, passed through to an inference executor. */
  readonly objective: string;
  /** Declared path globs this WorkUnit is allowed to touch. */
  readonly paths: readonly string[];
  /** The Git ref the workspace was seeded from (e.g. "HEAD" or a branch). */
  readonly baselineRef: string;
  /**
   * Optional, best-effort observability callbacks a caller (the live runner)
   * sets per WorkUnit so an inference executor can surface the real agent
   * activity as it happens: a readable summary of the prompt, each streamed
   * model token, and tool-call / phase steps. A deterministic executor simply
   * ignores them. A thrown callback must never fail the run (the executor wraps
   * each in a guard), and no callback is ever passed a credential: the prompt
   * summary and steps are the genuine agent activity, bounded and secret-free.
   */
  readonly onPromptSummary?: (summary: string) => void;
  /** Called with each chunk of REAL streamed model text as it arrives. */
  readonly onToken?: (chunk: string) => void;
  /** Called with a tool-call / phase step the executor exposes. */
  readonly onStep?: (step: { readonly phase: string; readonly message: string }) => void;
}

/** Status of an executor run. */
export type ExecutionStatus = "changed" | "no-change" | "failed";

/**
 * A cost record for one executor run. Deterministic executors report zero cost
 * and zero tokens; inference executors fill these in from provider usage.
 */
export interface ExecutionCost {
  /** Estimated cost in US dollars for this run. */
  readonly usd: number;
  /** Input tokens consumed, when the executor reports them. */
  readonly inputTokens?: number;
  /** Output tokens produced, when the executor reports them. */
  readonly outputTokens?: number;
  /** The model identifier used, when applicable. */
  readonly model?: string;
}

/** The result of an executor run inside a worktree. */
export interface ExecutionResult {
  readonly status: ExecutionStatus;
  /** Repository-relative paths the executor changed. */
  readonly changedPaths: readonly string[];
  /** Human-readable log lines for the run. */
  readonly logs: readonly string[];
  /** The cost of the run. */
  readonly cost: ExecutionCost;
  /** A suggested commit message describing the change. */
  readonly commitMessage: string;
}

/**
 * Portable executor contract. Implementations map to the project's inference
 * modes (a deterministic noop for tests and offline demos, plus a thin
 * OpenAI-compatible / AI Gateway adapter shape). An executor only touches files
 * inside `worktreeDir`; committing and pushing are the runner's job.
 */
export interface ExecutorProvider {
  /** A stable identifier, e.g. "noop" or "openai-compatible". */
  readonly name: string;
  execute(context: ExecutorContext): Promise<ExecutionResult>;
}

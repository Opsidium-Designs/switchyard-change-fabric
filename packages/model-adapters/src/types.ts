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
   * Optional frozen contract paths the Change's cohesion blueprint declared as
   * read-only seams (the shared interfaces every module imports). An inference
   * executor lists these in the prompt as read-only so the model IMPORTS and
   * honors them rather than rewriting them, which is what keeps a module edit
   * from silently diverging a shared seam. Optional and defaulting to empty, so
   * a deterministic executor and every existing caller are unchanged.
   */
  readonly frozenContracts?: readonly string[];
  /**
   * Optional ACTUAL CONTENTS of the frozen contract files, so an inference
   * executor can show the model the real API it must import and call rather than
   * only the paths. A model that is shown a path but never the file body cannot
   * know which functions a contract exports, so it invents helper names that do
   * not exist and writes a wrong call signature; including the real contents as
   * read-only reference lets it write against the genuine interface. Each entry
   * carries the contract's repo-relative path and its full file contents (bounded
   * by the executor's per-file byte cap). Optional and defaulting to empty, so a
   * deterministic executor and every existing caller are unchanged, and a Change
   * with no contracts (or whose contract files could not be read) omits it.
   */
  readonly frozenContractFiles?: readonly {
    readonly path: string;
    readonly contents: string;
  }[];
  /**
   * Optional names of the symbols THIS unit's module must keep exporting: its
   * EXPORTED INTERFACE, which other modules (and the entry point) import by
   * name. An inference executor lists these in the prompt so the model changes
   * the implementation without dropping or renaming an export an importer
   * depends on, which is what keeps one module's rewrite from breaking the whole
   * service. Optional and defaulting to empty, so a deterministic executor and
   * every existing caller are unchanged, and a module with no exports omits it.
   */
  readonly requiredExports?: readonly string[];
  /**
   * Optional per-attempt model id. A caller that runs more than one attempt for
   * the same unit (for example a verify-fail retry that escalates to a stronger
   * model) sets this to the model id that attempt should use. An executor that
   * supports it runs this model id for the call and records it in
   * `ExecutionResult.cost.model`. When unset the executor falls back to its own
   * configured base model, so every existing caller keeps its current behavior.
   * This is a different axis from an executor's internal transport fallback: it
   * selects WHICH model this attempt runs, not what happens when a call throws.
   */
  readonly model?: string;
  /**
   * Optional, best-effort observability callbacks a caller (the live runner)
   * sets per WorkUnit so an inference executor can surface the real agent
   * activity: a readable summary of the prompt and tool-call / phase steps. A
   * deterministic executor simply ignores them. A thrown callback must never
   * fail the run (the executor wraps each in a guard), and no callback is ever
   * passed a credential: the prompt summary and steps are the genuine agent
   * activity, bounded and secret-free. There is no live token stream: the model
   * is called non-streaming and the console shows a static transcript.
   */
  readonly onPromptSummary?: (summary: string) => void;
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

/**
 * A newly DISCOVERED unit of work an executor found while completing its own
 * WorkUnit: fixing one thing revealed more work (for example the agent fixing a
 * bug finds the same fix is needed in other files or call sites). It is a
 * genuine finding derived from the real worktree, not a scripted step: the
 * executor only reports a discovered unit it actually found in the repo it is
 * editing. The runner feeds these to the control plane, which appends them to
 * the live WorkGraph as real, backed WorkUnits so the graph grows mid-run.
 *
 * Discovery is goal-agnostic: the executor derives it from the work it did and
 * the repo it saw, never from a per-template table. Each discovered unit must
 * declare at least one real path it will touch so the appended unit is scoped
 * and backed exactly like a declared one.
 */
export interface DiscoveredUnit {
  /**
   * A short id suffix for the discovered unit, unique among the siblings this
   * run discovered. The control plane roots it under the discovering parent and
   * namespaces it, so this need only be locally unique (e.g. a file label).
   */
  readonly idSuffix: string;
  /** What the discovered unit is for (becomes the WorkUnit objective). */
  readonly objective: string;
  /** The repo-relative path globs the discovered unit will touch (its scope). */
  readonly paths: readonly string[];
  /** A short, human-readable reason this follow-up work was discovered. */
  readonly reason: string;
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
  /**
   * Follow-up WorkUnits the executor DISCOVERED while doing this unit's work:
   * fixing one thing revealed more work it found in the real worktree. Optional
   * and usually empty; when present, the runner reports them to the control
   * plane, which appends them to the live WorkGraph as real backed units so the
   * graph grows mid-run and the new units get recruited in later waves. A
   * deterministic executor can report a fixed, repo-derived set so the growth is
   * reproducible offline; an inference executor can report what it genuinely
   * found. Either way the units are real (scoped, backed, scheduled), never a UI
   * animation.
   */
  readonly discoveredUnits?: readonly DiscoveredUnit[];
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

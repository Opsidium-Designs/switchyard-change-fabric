/**
 * WorkersAiExecutor: a real executor that performs an agent's reasoning through
 * Cloudflare Workers AI and applies the model's concrete code edit to the cloned
 * workspace.
 *
 * The per-WorkUnit flow is:
 *   1. read the in-scope repo files the WorkUnit is allowed to touch (the real
 *      current contents of the cloned workspace);
 *   2. prompt the model with the unit objective plus those file contents and ask
 *      for a concrete code edit as a strict JSON document;
 *   3. parse the model's reply into a set of file edits, validate them, and
 *      write them into the worktree.
 *
 * Honesty: committing and pushing are the runner's job, exactly as for every
 * other executor. If the model returns nothing usable (an empty reply, a reply
 * that is not the expected JSON, no edits, or an edit that escapes the worktree)
 * the executor FAILS the run rather than silently writing a decorative marker.
 * It never falls back to a noop that masquerades as a real edit.
 *
 * No credential lives in this package. The actual Workers AI request is made by
 * an injected `invoke` transport, so the model call is testable with a
 * deterministic fake (keeping `make check` offline) and the live transport that
 * holds the scoped token is wired separately (see `createWorkersAiRestInvoke`).
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "./types.ts";

/** The headline Workers AI model for the agent's coding reasoning. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Deprecated. This id used to be a cross-model transport fallback that ran a
 * different, cheaper model when the base model call threw. That behavior is
 * removed: a transient streaming or transport error must never change which
 * model does the work, so the base model now stays attached and a transient
 * failure retries the SAME model (non-streaming on a retry). The constant is
 * kept exported so existing imports and config do not break, but it no longer
 * drives a model swap. The only deliberate model change is the verify-fail
 * escalation handled by the live runner.
 */
export const DEFAULT_WORKERS_AI_FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** One chat message handed to the Workers AI transport. */
export interface WorkersAiMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** What the executor hands to the injected transport. */
export interface WorkersAiInvokeRequest {
  /** The model id to run (the chosen base model, or a per-attempt escalation). */
  readonly model: string;
  /** The chat messages (a system prompt plus the user task). */
  readonly messages: readonly WorkersAiMessage[];
}

/** Token usage reported by Workers AI, when the provider returns it. */
export interface WorkersAiUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** The structured result the transport returns from a Workers AI call. */
export interface WorkersAiInvokeResult {
  /** The model's raw text reply (expected to contain the edit JSON). */
  readonly text: string;
  /** Usage, when the provider reports it. */
  readonly usage?: WorkersAiUsage;
}

/**
 * Optional callbacks the executor passes into the transport so a Workers AI call
 * can surface tool-call / reasoning steps the executor exposes. A transport that
 * does not surface steps simply ignores this second argument (it is optional),
 * which keeps every existing fake and the REST transport working unchanged. The
 * callbacks are best-effort: a thrown callback must never fail the model call, so
 * the executor wraps each in a guard.
 *
 * Note: live token streaming has been removed. The model is always called
 * non-streaming, and the console shows a static transcript (the prompt summary
 * plus the proposed edit and commit message) once a unit is done, so there is no
 * per-token relay here.
 */
export interface WorkersAiStreamCallbacks {
  /** Called with a tool-call / reasoning step the executor exposes, if any. */
  readonly onStep?: (step: WorkersAiStreamStep) => void;
}

/** A tool-call or reasoning step surfaced by a streaming transport. */
export interface WorkersAiStreamStep {
  /** A short machine phase for the step (e.g. "tool-call", "reasoning"). */
  readonly phase: string;
  /** A short human-readable description of the step (never a secret). */
  readonly message: string;
}

/**
 * The injected Workers AI transport. An implementor calls Workers AI (through
 * the Worker `env.AI` binding, or the REST API with a scoped token) and returns
 * the model's reply. No credential is passed through this package, so the key
 * stays out of the repo and the model call is fakeable in tests.
 *
 * The optional second argument carries step callbacks only. The model is always
 * called non-streaming, so the transport makes one request and returns the full
 * assembled reply for the edit-parsing path. A transport that surfaces no steps
 * ignores the argument.
 */
export type WorkersAiInvoke = (
  request: WorkersAiInvokeRequest,
  callbacks?: WorkersAiStreamCallbacks,
) => Promise<WorkersAiInvokeResult>;

/** A single file edit the model proposed, applied by this executor. */
export interface WorkersAiEdit {
  /** Repository-relative path to write. */
  readonly path: string;
  /** Full file contents to write. */
  readonly contents: string;
}

/** Options for the Workers AI executor (no secrets). */
export interface WorkersAiExecutorOptions {
  /** The headline model id. Defaults to the qwen coder model. */
  readonly model?: string;
  /**
   * Deprecated and unused: previously a cheaper model tried when the base model
   * call threw. A transient failure now retries the SAME model instead of
   * switching, so this never changes which model runs. The field is still
   * accepted so existing config does not error.
   */
  readonly fallbackModel?: string;
  /** The transport that performs the real Workers AI call (holds any credential). */
  readonly invoke: WorkersAiInvoke;
  /**
   * The maximum number of in-scope files to read and send to the model, to keep
   * the prompt (and the cost) bounded. Defaults to a small number so inference
   * stays cheap on the seeded demo project.
   */
  readonly maxContextFiles?: number;
  /** The maximum bytes of any one file sent to the model. Defaults to 8 KiB. */
  readonly maxFileBytes?: number;
  /**
   * How many times to retry a TRANSIENT model-call failure (a provider internal
   * error, a 5xx, or a timeout) before giving up. This is a small bounded cap so
   * a single flaky call on a hosted model does not fail the whole unit, while a
   * hard cap keeps it from looping forever. Each retry runs the SAME model (a
   * retry after a streaming failure drops streaming), so the model stays
   * attached. Defaults to 2. A non-transient failure (for example a bad model
   * reply) is not retried: that is an honest failure, not a flaky call.
   */
  readonly maxRetries?: number;
  /**
   * Backoff before each retry, in milliseconds. Injectable so tests retry with
   * zero delay and stay fast and offline. Defaults to a short 500 ms base; a real
   * run can leave the default.
   */
  readonly retryBackoffMs?: number;
  /**
   * Classify whether a thrown error is a transient provider failure worth
   * retrying (a 5xx, an internal error, or a timeout) versus a hard failure that
   * should fail immediately. Injectable for tests; defaults to a conservative
   * matcher over the error message.
   */
  readonly isTransientError?: (error: unknown) => boolean;
  /** Injectable sleep, for tests (so a retry does not actually wait). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable reader, for tests. Defaults to reading the real worktree. */
  readonly readScopedFiles?: (
    worktreeDir: string,
    paths: readonly string[],
    limits: { readonly maxFiles: number; readonly maxBytes: number },
  ) => Promise<readonly WorkersAiEdit[]>;
  /** Injectable writer, for tests. Defaults to writing the real worktree. */
  readonly writeFile?: (absPath: string, contents: string) => Promise<void>;
  /**
   * Called once with the chat messages before the model is invoked, so a caller
   * (the live runner) can record a readable summary of the agent's real prompt
   * for the console's click-detail. Best-effort; a thrown callback never fails
   * the run. The messages are the genuine prompt, so the summary is real.
   */
  readonly onPrompt?: (messages: readonly WorkersAiMessage[]) => void;
  /**
   * Called with a tool-call / reasoning step the executor exposes (model-call,
   * applied-edit). Best-effort; relayed by the runner as an activity step.
   */
  readonly onStep?: (step: WorkersAiStreamStep) => void;
}

const DEFAULT_MAX_CONTEXT_FILES = 6;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 500;

/** Thrown when the model returns something the executor cannot use as an edit. */
export class UnusableModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableModelOutputError";
  }
}

/**
 * Thrown when a Workers AI call does not settle within the configured timeout.
 * It is a distinct type so the retry classifier (and a caller) can tell a hung
 * call apart from a provider error, and so a timeout is clearly surfaced rather
 * than hanging the agent forever.
 */
export class WorkersAiTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkersAiTimeoutError";
  }
}

/**
 * The default transient-error classifier: a provider internal error, a 5xx, an
 * aborted/timed-out call, or a network-level fetch failure is transient and
 * worth a bounded retry. A UnusableModelOutputError (a bad model reply) is NOT
 * transient: retrying it would not help and would hide an honest failure.
 */
export function isTransientWorkersAiError(error: unknown): boolean {
  if (error instanceof UnusableModelOutputError) {
    return false;
  }
  if (error instanceof WorkersAiTimeoutError) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (message === "") {
    return false;
  }
  return (
    message.includes("http 5") ||
    message.includes("internal error") ||
    message.includes("internalerror") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted") ||
    message.includes("abort") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("service unavailable") ||
    message.includes("temporarily")
  );
}

export class WorkersAiExecutor implements ExecutorProvider {
  readonly name = "workers-ai";

  private readonly model: string;

  constructor(private readonly options: WorkersAiExecutorOptions) {
    if (typeof options.invoke !== "function") {
      throw new Error(
        "WorkersAiExecutor requires an `invoke` transport; it never embeds a credential",
      );
    }
    this.model = options.model ?? DEFAULT_WORKERS_AI_MODEL;
    // `options.fallbackModel` (and WORKERS_AI_FALLBACK_MODEL) is deprecated and
    // intentionally unused: a transient streaming or transport error must never
    // switch which model does the work. The chosen model stays attached and a
    // transient failure retries the SAME model (non-streaming on a retry). The
    // option is still accepted so existing config does not error. The only place
    // the model changes is the deliberate verify-fail escalation, which lives in
    // the live runner, not here.
    void options.fallbackModel;
  }

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const maxFiles = this.options.maxContextFiles ?? DEFAULT_MAX_CONTEXT_FILES;
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const readScoped = this.options.readScopedFiles ?? defaultReadScopedFiles;
    const write = this.options.writeFile ?? defaultWriteFile;

    // The model this attempt runs. A caller that escalates on a verify-fail
    // passes a per-attempt `context.model` (for example the stronger escalation
    // model); when unset we run the executor's configured base model, so every
    // existing caller is unchanged. This selects WHICH model runs, and once
    // chosen it stays attached: a transient streaming or transport error retries
    // the SAME model rather than switching to another one.
    const baseModel = (context.model ?? "").trim() || this.model;

    const contextFiles = await readScoped(context.worktreeDir, context.paths, {
      maxFiles,
      maxBytes,
    });

    const messages = buildMessages(context, contextFiles);

    // Resolve the observability callbacks: a per-unit context callback (set by
    // the live runner) takes precedence over an executor-wide option. Both are
    // best-effort and never receive a credential.
    const onStep = (step: WorkersAiStreamStep): void => {
      guard(() => context.onStep?.(step));
      guard(() => this.options.onStep?.(step));
    };

    // Surface the real prompt to a caller so the console's click-detail shows a
    // readable summary of what the agent actually asked. Best-effort: a thrown
    // callback must never fail the run. The summary is derived from the genuine
    // messages (objective, declared scope, and the in-scope file names), with no
    // file contents dumped, so it stays readable and carries no secret.
    const promptSummary = summarizePrompt(context, contextFiles);
    guard(() => context.onPromptSummary?.(promptSummary));
    guard(() => this.options.onPrompt?.(messages));

    // Step callbacks relayed into the transport: a transport that surfaces
    // tool-call steps calls onStep. There is no per-token relay; the model is
    // always called non-streaming and the console shows a static transcript.
    const stepCallbacks: WorkersAiStreamCallbacks = {
      onStep: (step) => onStep(step),
    };

    const maxRetries = Math.max(0, this.options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const backoffMs = this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const isTransient = this.options.isTransientError ?? isTransientWorkersAiError;
    const sleep = this.options.sleep ?? defaultSleep;

    // Every attempt runs the SAME chosen model: a transport hiccup must never
    // change which model does the work. The model only ever changes through the
    // deliberate, visible verify-fail escalation, which is a separate axis
    // handled by the caller (it passes a per-attempt `context.model`); it is NOT
    // this transient-retry path.
    //
    // The attempt is wrapped in a bounded retry: a transient provider failure or
    // a timeout (a flaky hosted-model call) is retried up to `maxRetries` times
    // with a short backoff, so one wedged or internal-error call does not fail
    // the unit. The retry cap is hard, so it can never loop forever, and a
    // non-transient failure (for example a bad model reply) is thrown
    // immediately rather than retried. `usedModel` is always `baseModel`.
    const usedModel = baseModel;

    const invokeOnce = async (): Promise<WorkersAiInvokeResult> => {
      onStep({ phase: "model-call", message: `calling model ${baseModel}` });
      return this.options.invoke({ model: baseModel, messages }, stepCallbacks);
    };

    let result: WorkersAiInvokeResult;
    let lastError: unknown;
    for (let tryNo = 0; tryNo <= maxRetries; tryNo += 1) {
      try {
        result = await invokeOnce();
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        // Stop immediately on a hard (non-transient) failure, or once the bounded
        // retries are exhausted. Otherwise back off and retry the SAME model.
        if (tryNo >= maxRetries || !isTransient(error)) {
          throw error;
        }
        if (backoffMs > 0) {
          await sleep(backoffMs * (tryNo + 1));
        }
      }
    }
    if (lastError !== undefined) {
      throw lastError;
    }
    // After a successful break, result is assigned; the non-null assertion is
    // safe because the loop either assigns result and breaks or throws.
    result = result!;

    const parsed = parseEdits(result.text);
    if (parsed.edits.length === 0) {
      throw new UnusableModelOutputError(
        `Workers AI model ${usedModel} returned no usable edit for WorkUnit ${context.workUnitId}`,
      );
    }

    const changedPaths: string[] = [];
    for (const edit of parsed.edits) {
      const abs = containedWorktreePath(context.worktreeDir, edit.path);
      await write(abs, edit.contents);
      changedPaths.push(edit.path);
    }
    guard(() => {
      onStep({
        phase: "applied-edit",
        message: `applied ${changedPaths.length} model edit(s): ${changedPaths.join(", ")}`,
      });
    });

    const inputTokens = result.usage?.inputTokens;
    const outputTokens = result.usage?.outputTokens;

    return {
      status: "changed",
      changedPaths,
      logs: [
        `workers-ai executor used model ${usedModel}`,
        `read ${contextFiles.length} in-scope file(s) as context`,
        `applied ${changedPaths.length} model-proposed edit(s): ${changedPaths.join(", ")}`,
      ],
      cost: {
        // Workers AI usage-based billing is account-plan dependent; we do not
        // guess a dollar figure, so we report tokens and a zero explicit cost
        // rather than a fabricated price.
        usd: 0,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        model: usedModel,
      },
      commitMessage:
        parsed.commitMessage && parsed.commitMessage.trim() !== ""
          ? parsed.commitMessage.trim()
          : `WorkUnit ${context.workUnitId}: ${context.objective}`,
    };
  }
}

/**
 * A readable, secret-free summary of the prompt the agent sends the model, for
 * the console's click-detail. It names the objective, the declared path scope,
 * and the in-scope file NAMES sent as context (not their contents), so a human
 * can see what the agent was actually asked without dumping file bodies.
 */
function summarizePrompt(
  context: ExecutorContext,
  contextFiles: readonly WorkersAiEdit[],
): string {
  const scope = context.paths.length > 0 ? context.paths.join(", ") : "(no declared paths)";
  const files =
    contextFiles.length > 0
      ? contextFiles.map((f) => f.path).join(", ")
      : "(no in-scope files; the agent may create one in scope)";
  return [
    `Objective: ${context.objective}`,
    `Allowed paths: ${scope}`,
    `Context files sent: ${files}`,
    `Instruction: make the smallest concrete edit satisfying the objective, returned as one JSON edit document.`,
  ].join("\n");
}

/** The strict JSON contract the model is asked to return. */
interface ModelEditDocument {
  readonly commitMessage?: string;
  readonly edits?: readonly { readonly path?: string; readonly contents?: string }[];
}

/**
 * Build the chat messages. The system prompt pins the output contract (a single
 * JSON document of edits), and the user message carries the objective, the
 * declared path scope, and the real current contents of the in-scope files.
 */
function buildMessages(
  context: ExecutorContext,
  contextFiles: readonly WorkersAiEdit[],
): readonly WorkersAiMessage[] {
  const requiredExportsForSystem = context.requiredExports ?? [];
  const exportRule =
    requiredExportsForSystem.length > 0
      ? [
          "Your module MUST keep exporting these names EXACTLY, with the same signatures: " +
            `${requiredExportsForSystem.join(", ")}.`,
          "The updated file you return MUST still contain each one as a real export, for example " +
            `${requiredExportsForSystem
              .map((name) => `\`export function ${name}\``)
              .join(" or ")}` +
            " (or an equivalent `export { " +
            requiredExportsForSystem.join(", ") +
            " }`). Never remove, rename, or comment out any of these exports; dropping even one breaks the modules that import it.",
        ]
      : [
          "Your module has a PUBLIC EXPORTED INTERFACE other modules import by name. Change the implementation, not the exported names or signatures, and keep every existing `export` present. Never remove or rename an export other modules import.",
        ];

  const system = [
    "You are a careful software engineering agent working inside one isolated Git workspace.",
    "You are given one WorkUnit objective, the exact file paths you are allowed to change, and the current contents of the in-scope files.",
    "START FROM THE CURRENT CONTENTS of the in-scope file shown below and make the MINIMAL change needed to satisfy the objective. Do NOT regenerate the file from scratch and do NOT rewrite a whole file when a focused change is enough. Preserve the existing imports EXACTLY (keep importing the frozen contracts), keep every existing export, and do not restyle or reformat code unrelated to the objective.",
    "Some files are FROZEN CONTRACTS: shared read-only interfaces other modules import. You must IMPORT and honor a frozen contract as it is; never rewrite, re-export, or change its shape, and never list it as an edit.",
    "Call ONLY functions these contracts actually export; do not invent helper names. The frozen contract contents are shown below as read-only reference, so import and call the real exported names with their real signatures rather than guessing.",
    "Preserve the exported interface your module already provides.",
    ...exportRule,
    "Reply with ONE JSON document and nothing else, in this exact shape:",
    '{"commitMessage": "<short message>", "edits": [{"path": "<repo-relative path within the declared scope>", "contents": "<full updated file contents>"}]}',
    "Each edit must give the FULL updated contents of the file (the current contents with your minimal change applied), not a diff and not a from-scratch rewrite that drops anything.",
    "Only write files inside the declared path scope. Do not invent paths outside it.",
    "Do not wrap the JSON in markdown fences and do not add any prose before or after it.",
  ].join("\n");

  const scopeLines = context.paths.length > 0 ? context.paths.join("\n") : "(no declared paths)";
  const frozenContracts = context.frozenContracts ?? [];
  const frozenLines =
    frozenContracts.length > 0
      ? frozenContracts.join("\n")
      : "(none declared for this change)";
  // The ACTUAL CONTENTS of the frozen contract files, rendered as read-only
  // reference so the model writes against the real exported API (the genuine
  // function names and signatures) rather than inventing helpers that do not
  // exist. Each contract is bounded by the executor's per-file byte cap so the
  // prompt stays small (contract files are tiny), and the block is empty-safe:
  // a Change with no contract files produces the exact same prompt as before.
  const frozenContractFiles = context.frozenContractFiles ?? [];
  const maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  const frozenContractBlocks =
    frozenContractFiles.length > 0
      ? frozenContractFiles
          .map((file) => {
            const bounded =
              file.contents.length > maxFileBytes
                ? `${file.contents.slice(0, maxFileBytes)}\n... (contract truncated)`
                : file.contents;
            return `--- FROZEN CONTRACT: ${file.path} ---\n${bounded}`;
          })
          .join("\n\n")
      : "";
  const requiredExports = context.requiredExports ?? [];
  const fileBlocks =
    contextFiles.length > 0
      ? contextFiles
          .map((file) => `--- FILE: ${file.path} ---\n${file.contents}`)
          .join("\n\n")
      : "(no in-scope files exist yet; you may create a new file within the declared scope)";

  const user = [
    `WorkUnit: ${context.workUnitId}`,
    `Objective: ${context.objective}`,
    `Baseline ref: ${context.baselineRef}`,
    "",
    "Declared path scope (you may only write these paths):",
    scopeLines,
    "",
    "Frozen contract files (READ-ONLY; import and honor these, never rewrite or edit them):",
    frozenLines,
    // The frozen contract CONTENTS block only appears when the caller threaded
    // the real file bodies, so a Change with no contract files produces the
    // exact same prompt as before. When present it shows the genuine exported
    // API so the model imports and calls the real names rather than inventing
    // helpers that do not exist.
    ...(frozenContractBlocks !== ""
      ? [
          "",
          "Frozen contract files (READ-ONLY REFERENCE - import and call these exactly; do NOT edit them, do NOT invent other names):",
          frozenContractBlocks,
        ]
      : []),
    // The required-exports block only appears when this module has a captured
    // exported interface, so a module with no exports (or any existing caller
    // that passes none) produces the exact same prompt as before.
    ...(requiredExports.length > 0
      ? [
          "",
          "Required exports (your module MUST keep exporting these names EXACTLY; the updated file MUST still contain each one as a real export):",
          requiredExports
            .map((name) => `  ${name}  (must stay as \`export function ${name}\` / \`export { ${name} }\`)`)
            .join("\n"),
        ]
      : []),
    "",
    "Current in-scope file contents:",
    fileBlocks,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Parse the model reply into edits. It is lenient about surrounding whitespace
 * and a single markdown code fence (models sometimes add one despite the
 * instruction), but strict about the resulting shape: a valid document has an
 * `edits` array of `{ path, contents }`. Anything else yields zero edits, which
 * the caller turns into an honest failure.
 */
function parseEdits(text: string): { edits: WorkersAiEdit[]; commitMessage?: string } {
  const candidate = extractJson(text);
  if (candidate === null) {
    return { edits: [] };
  }
  let doc: ModelEditDocument;
  try {
    doc = JSON.parse(candidate) as ModelEditDocument;
  } catch {
    return { edits: [] };
  }
  if (!doc || !Array.isArray(doc.edits)) {
    return { edits: [] };
  }
  const edits: WorkersAiEdit[] = [];
  for (const raw of doc.edits) {
    if (
      !raw ||
      typeof raw.path !== "string" ||
      raw.path.trim() === "" ||
      typeof raw.contents !== "string"
    ) {
      // A malformed edit entry invalidates the whole reply: we refuse to apply a
      // partial, half-understood change rather than guess.
      return { edits: [] };
    }
    edits.push({ path: raw.path.trim(), contents: raw.contents });
  }
  return {
    edits,
    ...(typeof doc.commitMessage === "string" ? { commitMessage: doc.commitMessage } : {}),
  };
}

/**
 * Extract the JSON object from a model reply. Handles a bare JSON object and a
 * reply wrapped in a single ```json ... ``` (or ``` ... ```) fence. Returns null
 * when no plausible JSON object is present.
 */
function extractJson(text: string): string | null {
  const asString = typeof text === "string" ? text : String(text ?? "");
  const trimmed = asString.trim();
  if (trimmed === "") {
    return null;
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] ?? "" : trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return body.slice(start, end + 1);
}

/**
 * Default in-scope file reader: for each declared path, read the matching files
 * that currently exist in the worktree, bounded by the file and byte limits so
 * the prompt stays small. Exact file paths are read directly; a directory glob
 * (for example "src/audit/**") reads the existing files under its literal base
 * directory. Files that do not exist yet are simply omitted (the model is told
 * it may create one).
 */
async function defaultReadScopedFiles(
  worktreeDir: string,
  paths: readonly string[],
  limits: { readonly maxFiles: number; readonly maxBytes: number },
): Promise<readonly WorkersAiEdit[]> {
  const collected = new Map<string, string>();
  for (const glob of paths) {
    if (collected.size >= limits.maxFiles) {
      break;
    }
    const candidates = isExactFile(glob)
      ? [glob]
      : await listUnder(worktreeDir, globBaseDir(glob));
    for (const rel of candidates) {
      if (collected.size >= limits.maxFiles) {
        break;
      }
      if (collected.has(rel)) {
        continue;
      }
      const abs = join(worktreeDir, rel);
      try {
        const info = await stat(abs);
        if (!info.isFile() || info.size > limits.maxBytes) {
          continue;
        }
        collected.set(rel, await readFile(abs, "utf8"));
      } catch {
        // Not present (or unreadable): skip; the model may create it in scope.
      }
    }
  }
  return [...collected.entries()].map(([path, contents]) => ({ path, contents }));
}

/** Recursively list repo-relative files under a base directory in the worktree. */
async function listUnder(worktreeDir: string, baseRel: string): Promise<string[]> {
  const baseAbs = baseRel === "" ? worktreeDir : join(worktreeDir, baseRel);
  const out: string[] = [];
  async function walk(dirAbs: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const childAbs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs);
      } else if (entry.isFile()) {
        out.push(relative(worktreeDir, childAbs).split(sep).join("/"));
      }
    }
  }
  await walk(baseAbs);
  return out.sort();
}

async function defaultWriteFile(absPath: string, contents: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents, "utf8");
}

/** A path with no glob metacharacters is an exact file. */
function isExactFile(glob: string): boolean {
  return !/[*?]/.test(glob);
}

/** The literal directory prefix of a glob, up to the first glob segment. */
function globBaseDir(glob: string): string {
  const segments = glob.split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?]/.test(segment)) {
      break;
    }
    literal.push(segment);
  }
  // The last literal segment of a glob like "src/audit/**" is the directory;
  // for "src/foo.ts" (handled as exact elsewhere) this is not reached.
  return literal.join("/");
}

/**
 * Resolve an edit path inside the worktree, rejecting any path that escapes it.
 * This mirrors the containment guard the OpenAI-compatible executor uses.
 */
function containedWorktreePath(worktreeDir: string, relPath: string): string {
  if (relPath.startsWith("/") || relPath.includes("..")) {
    throw new UnusableModelOutputError(
      `edit path must be worktree-relative and contained: ${relPath}`,
    );
  }
  const abs = resolve(worktreeDir, relPath);
  const root = resolve(worktreeDir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new UnusableModelOutputError(
      `edit path escapes the worktree: ${relPath}`,
    );
  }
  return abs;
}

/** Options for the live Workers AI REST transport (holds the credential). */
export interface WorkersAiRestOptions {
  /** The Cloudflare account id the Workers AI model runs under. */
  readonly accountId: string;
  /** The scoped Cloudflare API token with Workers AI access. Never logged. */
  readonly apiToken: string;
  /** Override the API base, for a proxy or a test. Defaults to the public API. */
  readonly baseUrl?: string;
  /**
   * How long a single model call may run before it is aborted and surfaced as a
   * WorkersAiTimeoutError, in milliseconds. This is the safety net for a slow or
   * hung hosted-model call: without it a wedged request would hang the agent
   * forever and freeze the wave. Defaults to 75 seconds, comfortably long for a
   * real coding model while still bounding a hang. Set to 0 to disable (not
   * recommended for a live run).
   */
  readonly timeoutMs?: number;
  /**
   * The maximum number of tokens the model may generate for one call. Workers AI
   * applies a SMALL default (around 256) when this is omitted, which truncates a
   * full-file edit mid-string and makes the reply unparseable. A real edit must
   * fit the whole new file contents, so this defaults to a generous value. Raise
   * it for very large files; lower it only if you know replies are small.
   */
  readonly maxTokens?: number;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/** The default per-call timeout for the live REST transport (75 seconds). */
export const DEFAULT_WORKERS_AI_TIMEOUT_MS = 75_000;

/**
 * The default max output tokens for one call. Workers AI otherwise caps output
 * at a small default (around 256) that truncates a full-file edit, so a generous
 * ceiling is required for the edit JSON to come back complete and parseable.
 */
export const DEFAULT_WORKERS_AI_MAX_TOKENS = 4096;

/** A real (non-injected) sleep used between bounded retries. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a best-effort callback, swallowing any error. The streaming / step / prompt
 * callbacks are observability hooks: a thrown callback must never fail the model
 * call or the edit it would otherwise have applied.
 */
function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    // Best-effort: an observability callback must not break the run.
  }
}

/** Coerce a reply value to the text the edit parser expects. */
export function coerceReplyText(value: unknown): string {
  // Workers AI usually returns a string, but some models return an
  // already-parsed JSON object when the reply itself is JSON. Coerce an object
  // back to its JSON text so the executor's parser always sees a string.
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
}

/**
 * Pull the model's reply text out of a Workers AI non-streaming body, supporting
 * BOTH shapes the account returns:
 *
 *   - the classic chat text-generation shape `{ result: { response: "..." } }`;
 *   - the OpenAI-style chat completion shape `choices[0].message.content`
 *     (seen on the qwen3.8 family), whether nested under `result` or at the top
 *     level. The separate `reasoning` field some models emit alongside the
 *     content is intentionally IGNORED: it is the model's chain-of-thought, not
 *     the edit JSON, so reading it would feed the parser the wrong text.
 *
 * Trying `result.response` first keeps every existing model working unchanged;
 * the OpenAI-shape fallback is what stops the qwen3.8 base (and the glm-5.3
 * escalation) model from returning a silently empty reply that would otherwise
 * trip UnusableModelOutputError for a parsing reason rather than a real one.
 */
export function extractReplyText(body: {
  result?: {
    response?: unknown;
    choices?: ReadonlyArray<{ message?: { content?: unknown }; text?: unknown }>;
  };
  choices?: ReadonlyArray<{ message?: { content?: unknown }; text?: unknown }>;
}): string {
  const classic = coerceReplyText(body.result?.response);
  if (classic !== "") {
    return classic;
  }
  // Prefer the OpenAI shape nested under `result`, then at the top level.
  const choices = body.result?.choices ?? body.choices;
  const choice = choices?.[0];
  if (choice) {
    const content = coerceReplyText(choice.message?.content);
    if (content !== "") {
      return content;
    }
    // Some providers expose the text as `choices[0].text` for a completion.
    const legacyText = coerceReplyText(choice.text);
    if (legacyText !== "") {
      return legacyText;
    }
  }
  return "";
}

/**
 * Build a live Workers AI transport that calls the Cloudflare REST API with a
 * scoped token. This is the local-runner path: a runner is an ordinary Node
 * process (it runs Git), so it reaches Workers AI over HTTPS rather than through
 * a Worker `env.AI` binding. The token is held in this closure only and is never
 * returned, logged, or written anywhere.
 *
 * The call is always NON-STREAMING: it makes one request and parses the full
 * reply. It is bounded by a timeout via an AbortController: if the model does
 * not respond within `timeoutMs` the request is aborted and surfaced as a
 * distinct WorkersAiTimeoutError, so a hung call cannot wedge the agent forever.
 * The executor's bounded retry treats that timeout as a transient failure.
 *
 * The REST response shape is `{ result: { response: "..." }, ... }` for the chat
 * text-generation models; usage, when present, is read from `result.usage`.
 */
export function createWorkersAiRestInvoke(options: WorkersAiRestOptions): WorkersAiInvoke {
  const fetchFn = options.fetchFn ?? fetch;
  const base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_WORKERS_AI_MAX_TOKENS;
  return async (
    request: WorkersAiInvokeRequest,
    _callbacks?: WorkersAiStreamCallbacks,
  ): Promise<WorkersAiInvokeResult> => {
    const url = `${base}/accounts/${encodeURIComponent(options.accountId)}/ai/run/${request.model}`;
    // Bound the call with an AbortController so a slow or hung model cannot hang
    // the agent forever. The timer is always cleared on settle, and an abort is
    // surfaced as a distinct timeout error rather than an opaque fetch failure.
    const controller = timeoutMs > 0 ? new AbortController() : undefined;
    const timer =
      controller !== undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ messages: request.messages, max_tokens: maxTokens }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      // An abort (the timeout fired) is reported as a distinct timeout error; any
      // other fetch-level failure is passed through. Neither path leaks the token.
      if (controller?.signal.aborted) {
        throw new WorkersAiTimeoutError(
          `Workers AI call for ${request.model} timed out after ${timeoutMs}ms`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      // The whole body is read below within this function, so the timer is
      // cleared here on settle.
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    if (res.status >= 400) {
      // Drain the body (do not include it in the error) and fail without leaking.
      await res.text().catch(() => "");
      throw new Error(`Workers AI call failed for ${request.model} (HTTP ${res.status})`);
    }
    const text = await res.text();
    let body: {
      result?: {
        response?: unknown;
        // Some Workers AI models (the qwen3.8 family) return an OpenAI-style
        // chat completion under `result`: the reply text lives in
        // `choices[0].message.content`, with any chain-of-thought in a SEPARATE
        // `reasoning` field we intentionally ignore (it is not the edit JSON).
        choices?: ReadonlyArray<{
          message?: { content?: unknown; reasoning?: unknown };
          text?: unknown;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // A few deployments return the OpenAI shape at the TOP level rather than
      // nested under `result`; accept that too so neither base nor escalation
      // model returns a silently empty reply for a shape difference.
      choices?: ReadonlyArray<{
        message?: { content?: unknown; reasoning?: unknown };
        text?: unknown;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`Workers AI returned a non-JSON response for ${request.model}`);
    }
    const response = extractReplyText(body);
    const usage = body.result?.usage ?? body.usage;
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

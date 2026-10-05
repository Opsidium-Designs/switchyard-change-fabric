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
export const DEFAULT_WORKERS_AI_MODEL = "@cf/qwen/qwen3.8-27b";

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
 * Optional streaming callbacks the executor passes into the transport so a
 * streaming Workers AI call can relay the model output live, token by token, and
 * surface tool-call steps the executor exposes. A non-streaming transport simply
 * ignores this second argument (it is optional), which keeps every existing fake
 * and the REST transport working unchanged while a streaming transport can relay
 * the real tokens. The callbacks are best-effort: a thrown callback must never
 * fail the model call, so the executor wraps each in a guard.
 */
export interface WorkersAiStreamCallbacks {
  /** Called with each chunk of REAL streamed model text as it arrives. */
  readonly onToken?: (chunk: string) => void;
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
 * The optional second argument carries streaming callbacks: a streaming
 * transport relays each token through `onToken` (and any tool-call step through
 * `onStep`) as the model produces them, then still returns the full assembled
 * reply so the edit-parsing path is unchanged. A non-streaming transport ignores
 * the argument. The streamed text is the genuine model output.
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
   * Called with each chunk of REAL streamed model text as it arrives (when the
   * injected transport streams). The live runner relays these to the Worker so
   * the console renders the model output live on the running node. Best-effort.
   */
  readonly onToken?: (chunk: string) => void;
  /**
   * Called with a tool-call / reasoning step a streaming transport exposes.
   * Best-effort; relayed by the runner as an activity step. The executor also
   * emits its own concrete steps (model-call, applied-edit) through this.
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
    const onToken = context.onToken ?? this.options.onToken;
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

    // Streaming callbacks relayed into the transport: a streaming transport
    // calls onToken with each real token and onStep with any tool-call step, so
    // the console renders the live model output and step events on the node.
    const streamCallbacks: WorkersAiStreamCallbacks = {
      onToken: (chunk) => guard(() => onToken?.(chunk)),
      onStep: (step) => onStep(step),
    };

    const maxRetries = Math.max(0, this.options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const backoffMs = this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const isTransient = this.options.isTransientError ?? isTransientWorkersAiError;
    const sleep = this.options.sleep ?? defaultSleep;

    // Every attempt runs the SAME chosen model: a streaming or transport hiccup
    // must never change which model does the work. The model only ever changes
    // through the deliberate, visible verify-fail escalation, which is a
    // separate axis handled by the caller (it passes a per-attempt
    // `context.model`); it is NOT this transient-retry path.
    //
    // The attempt is wrapped in a bounded retry: a transient provider failure or
    // a timeout (a flaky hosted-model call) is retried up to `maxRetries` times
    // with a short backoff, so one wedged or internal-error call does not fail
    // the unit. The retry cap is hard, so it can never loop forever, and a
    // non-transient failure (for example a bad model reply) is thrown
    // immediately rather than retried.
    //
    // Streaming is decided by the presence of an onToken callback. If the FIRST
    // (streaming) attempt throws a transient error, the retry of the SAME model
    // drops streaming (invokes without the streaming callbacks) so a
    // persistently-flaky stream still yields the same model's output as a plain
    // non-streaming request. The live token view is lost for that attempt only;
    // the model is unchanged. `usedModel` is always `baseModel`.
    const wantStream = typeof onToken === "function";
    const usedModel = baseModel;

    // The first attempt streams when a token callback is present; a retry after a
    // transient failure drops streaming so a flaky stream still produces output
    // from the same model.
    const invokeOnce = async (stream: boolean): Promise<WorkersAiInvokeResult> => {
      onStep({
        phase: "model-call",
        message: stream
          ? `calling model ${baseModel}`
          : `streaming call failed (transient); retrying ${baseModel} without streaming`,
      });
      return this.options.invoke(
        { model: baseModel, messages },
        stream ? streamCallbacks : undefined,
      );
    };

    let result: WorkersAiInvokeResult;
    let lastError: unknown;
    for (let tryNo = 0; tryNo <= maxRetries; tryNo += 1) {
      // Stream only on the first try when a token callback is present; any retry
      // of the same model drops streaming to survive a persistently-flaky stream.
      const stream = wantStream && tryNo === 0;
      try {
        result = await invokeOnce(stream);
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
  const system = [
    "You are a careful software engineering agent working inside one isolated Git workspace.",
    "You are given one WorkUnit objective, the exact file paths you are allowed to change, and the current contents of the in-scope files.",
    "Make the smallest concrete code edit that satisfies the objective.",
    "Reply with ONE JSON document and nothing else, in this exact shape:",
    '{"commitMessage": "<short message>", "edits": [{"path": "<repo-relative path within the declared scope>", "contents": "<full new file contents>"}]}',
    "Each edit must give the FULL new contents of the file, not a diff.",
    "Only write files inside the declared path scope. Do not invent paths outside it.",
    "Do not wrap the JSON in markdown fences and do not add any prose before or after it.",
  ].join("\n");

  const scopeLines = context.paths.length > 0 ? context.paths.join("\n") : "(no declared paths)";
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
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/** The default per-call timeout for the live REST transport (75 seconds). */
export const DEFAULT_WORKERS_AI_TIMEOUT_MS = 75_000;

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
function coerceReplyText(value: unknown): string {
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
function extractReplyText(body: {
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
 * The call is bounded by a timeout via an AbortController: if the model does not
 * respond within `timeoutMs` the request is aborted and surfaced as a distinct
 * WorkersAiTimeoutError, so a hung call cannot wedge the agent forever. The
 * executor's bounded retry treats that timeout as a transient failure.
 *
 * The REST response shape is `{ result: { response: "..." }, ... }` for the chat
 * text-generation models; usage, when present, is read from `result.usage`.
 */
export function createWorkersAiRestInvoke(options: WorkersAiRestOptions): WorkersAiInvoke {
  const fetchFn = options.fetchFn ?? fetch;
  const base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;
  return async (
    request: WorkersAiInvokeRequest,
    callbacks?: WorkersAiStreamCallbacks,
  ): Promise<WorkersAiInvokeResult> => {
    const url = `${base}/accounts/${encodeURIComponent(options.accountId)}/ai/run/${request.model}`;
    // Stream only when a caller actually wants tokens relayed. Workers AI
    // streams chat text generation as SSE when `stream: true` is set, each event
    // carrying `{ "response": "<delta>" }` and a final `[DONE]`. When no token
    // callback is given, keep the simpler non-streaming request so the existing
    // behavior (and the account's default usage reporting) is unchanged.
    const wantStream = typeof callbacks?.onToken === "function";
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
        body: JSON.stringify({ messages: request.messages, ...(wantStream ? { stream: true } : {}) }),
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
      // For a NON-streaming call the whole body is read below within this
      // function, so the timer is cleared here on settle. For a STREAMING call
      // the body is consumed later in readStreamingResponse, so clearing the
      // timer here would leave the SSE read unbounded (a stalled or server-erroring
      // stream would then hang the Worker until the runtime cancels it). In the
      // streaming case we therefore DEFER clearing the timer to the reader, which
      // clears it when the stream completes or aborts.
      if (timer !== undefined && !(wantStream && res! !== undefined && res!.body)) {
        clearTimeout(timer);
      }
    }
    if (res.status >= 400) {
      // Drain the body (do not include it in the error) and fail without leaking.
      await res.text().catch(() => "");
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      throw new Error(`Workers AI call failed for ${request.model} (HTTP ${res.status})`);
    }
    if (wantStream && res.body) {
      // Relay the SSE token stream: emit each delta through onToken as it lands
      // and assemble the full reply so the executor's edit parser is unchanged.
      // The controller + timer are passed in so the deadline stays live for the
      // whole read: a stalled or server-erroring stream aborts and fails cleanly
      // rather than hanging the Worker forever (the hang the runtime cancels).
      return readStreamingResponse(res, request.model, callbacks, controller, timer);
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

/**
 * Read a Workers AI SSE streaming response: parse each `data:` line (the chat
 * models stream `{ "response": "<delta>" }` events, ending with `[DONE]`),
 * relay each delta through onToken as it arrives, and assemble the full reply
 * text (plus usage if a final event carries it) so the executor parses the
 * complete JSON edit document exactly as the non-streaming path does. The
 * streamed deltas are the genuine model output.
 */
async function readStreamingResponse(
  res: Response,
  model: string,
  callbacks?: WorkersAiStreamCallbacks,
  controller?: AbortController,
  timer?: ReturnType<typeof setTimeout>,
): Promise<WorkersAiInvokeResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembled = "";
  let usage: WorkersAiUsage | undefined;
  const handleEvent = (dataLine: string): void => {
    const payload = dataLine.replace(/^data:\s*/, "").trim();
    if (payload === "" || payload === "[DONE]") {
      return;
    }
    try {
      const event = JSON.parse(payload) as {
        response?: unknown;
        choices?: ReadonlyArray<{
          delta?: { content?: unknown; reasoning?: unknown };
          message?: { content?: unknown };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // The classic chat text-generation stream carries `response` deltas; the
      // OpenAI-style stream (the qwen3.8 family) carries them in
      // `choices[0].delta.content`, with any chain-of-thought in a separate
      // `reasoning` delta we intentionally ignore. Reading both keeps every
      // model honest instead of assembling an empty reply for a shape it does
      // not recognize.
      const choice = event.choices?.[0];
      const openAiDelta =
        typeof choice?.delta?.content === "string"
          ? choice.delta.content
          : typeof choice?.message?.content === "string"
            ? choice.message.content
            : "";
      const delta = typeof event.response === "string" && event.response !== "" ? event.response : openAiDelta;
      if (delta !== "") {
        assembled += delta;
        callbacks?.onToken?.(delta);
      }
      if (event.usage) {
        usage = {
          ...(event.usage.prompt_tokens !== undefined ? { inputTokens: event.usage.prompt_tokens } : {}),
          ...(event.usage.completion_tokens !== undefined
            ? { outputTokens: event.usage.completion_tokens }
            : {}),
        };
      }
    } catch {
      // A non-JSON SSE line (a keep-alive or comment) is ignored.
    }
  };
  // A per-read stall watchdog: if no chunk (and no clean `done`) arrives within
  // this window, abort the body so the read cannot block forever. This is a
  // second guard beneath the overall AbortController deadline, covering the case
  // where the stream stays open but silent (e.g. the model errored mid-stream).
  const STALL_MS = 30000;
  let aborted = false;
  const abortStream = (): void => {
    aborted = true;
    try {
      controller?.abort();
    } catch {
      // ignore
    }
    void reader.cancel().catch(() => {});
  };
  try {
    for (;;) {
      let stall: ReturnType<typeof setTimeout> | undefined;
      const read = reader.read();
      const stalled = new Promise<{ stalled: true }>((resolve) => {
        stall = setTimeout(() => resolve({ stalled: true }), STALL_MS);
      });
      // Also race the overall deadline: when the caller's AbortController fires
      // (the timeoutMs elapsed), a stalled reader.read() would otherwise block
      // until the 30s stall watchdog. Listening for the abort event lets the
      // deadline interrupt the read immediately, so the stream can never outlive
      // the deadline that bounds the whole call.
      const abortedP = new Promise<{ aborted: true }>((resolve) => {
        const sig = controller?.signal;
        if (!sig) {
          return;
        }
        if (sig.aborted) {
          resolve({ aborted: true });
          return;
        }
        sig.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
      });
      let outcome:
        | { done?: boolean; value?: Uint8Array }
        | { stalled: true }
        | { aborted: true };
      try {
        outcome = await Promise.race([read, stalled, abortedP]);
      } finally {
        if (stall !== undefined) {
          clearTimeout(stall);
        }
      }
      if ("aborted" in outcome) {
        abortStream();
        throw new WorkersAiTimeoutError(`Workers AI stream for ${model} timed out`);
      }
      if ("stalled" in outcome) {
        abortStream();
        throw new WorkersAiTimeoutError(
          `Workers AI stream for ${model} stalled with no data for ${STALL_MS}ms`,
        );
      }
      const { done, value } = outcome;
      if (done) {
        break;
      }
      if (controller?.signal.aborted) {
        throw new WorkersAiTimeoutError(`Workers AI stream for ${model} timed out`);
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith("data:")) {
          handleEvent(line);
        }
      }
    }
    // Flush any trailing buffered line.
    if (buffer.startsWith("data:")) {
      handleEvent(buffer);
    }
    if (assembled === "") {
      throw new Error(`Workers AI returned an empty stream for ${model}`);
    }
    return { text: assembled, ...(usage ? { usage } : {}) };
  } finally {
    // Always clear the overall deadline timer when the stream settles (success,
    // error, or abort), so the deferred timer from the caller is never leaked.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (!aborted) {
      void reader.cancel().catch(() => {});
    }
  }
}

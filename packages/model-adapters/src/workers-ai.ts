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
export const DEFAULT_WORKERS_AI_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

/** A cheaper, smaller fallback model when the headline model is unavailable. */
export const DEFAULT_WORKERS_AI_FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** One chat message handed to the Workers AI transport. */
export interface WorkersAiMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** What the executor hands to the injected transport. */
export interface WorkersAiInvokeRequest {
  /** The model id to run (the headline model or its configured fallback). */
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
 * The injected Workers AI transport. An implementor calls Workers AI (through
 * the Worker `env.AI` binding, or the REST API with a scoped token) and returns
 * the model's reply. No credential is passed through this package, so the key
 * stays out of the repo and the model call is fakeable in tests.
 */
export type WorkersAiInvoke = (
  request: WorkersAiInvokeRequest,
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
  /** A cheaper small model tried when the headline model call fails. */
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
  /** Injectable reader, for tests. Defaults to reading the real worktree. */
  readonly readScopedFiles?: (
    worktreeDir: string,
    paths: readonly string[],
    limits: { readonly maxFiles: number; readonly maxBytes: number },
  ) => Promise<readonly WorkersAiEdit[]>;
  /** Injectable writer, for tests. Defaults to writing the real worktree. */
  readonly writeFile?: (absPath: string, contents: string) => Promise<void>;
}

const DEFAULT_MAX_CONTEXT_FILES = 6;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024;

/** Thrown when the model returns something the executor cannot use as an edit. */
export class UnusableModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableModelOutputError";
  }
}

export class WorkersAiExecutor implements ExecutorProvider {
  readonly name = "workers-ai";

  private readonly model: string;
  private readonly fallbackModel: string;

  constructor(private readonly options: WorkersAiExecutorOptions) {
    if (typeof options.invoke !== "function") {
      throw new Error(
        "WorkersAiExecutor requires an `invoke` transport; it never embeds a credential",
      );
    }
    this.model = options.model ?? DEFAULT_WORKERS_AI_MODEL;
    this.fallbackModel = options.fallbackModel ?? DEFAULT_WORKERS_AI_FALLBACK_MODEL;
  }

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const maxFiles = this.options.maxContextFiles ?? DEFAULT_MAX_CONTEXT_FILES;
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const readScoped = this.options.readScopedFiles ?? defaultReadScopedFiles;
    const write = this.options.writeFile ?? defaultWriteFile;

    const contextFiles = await readScoped(context.worktreeDir, context.paths, {
      maxFiles,
      maxBytes,
    });

    const messages = buildMessages(context, contextFiles);

    // Try the headline model, then the cheaper fallback model once if the
    // headline call throws (a provider error, not a bad reply). A bad reply from
    // either model is an honest failure, not grounds for a silent noop.
    let result: WorkersAiInvokeResult;
    let usedModel = this.model;
    try {
      result = await this.options.invoke({ model: this.model, messages });
    } catch (headlineError) {
      if (this.fallbackModel && this.fallbackModel !== this.model) {
        usedModel = this.fallbackModel;
        result = await this.options.invoke({ model: this.fallbackModel, messages });
      } else {
        throw headlineError;
      }
    }

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
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/**
 * Build a live Workers AI transport that calls the Cloudflare REST API with a
 * scoped token. This is the local-runner path: a runner is an ordinary Node
 * process (it runs Git), so it reaches Workers AI over HTTPS rather than through
 * a Worker `env.AI` binding. The token is held in this closure only and is never
 * returned, logged, or written anywhere.
 *
 * The REST response shape is `{ result: { response: "..." }, ... }` for the chat
 * text-generation models; usage, when present, is read from `result.usage`.
 */
export function createWorkersAiRestInvoke(options: WorkersAiRestOptions): WorkersAiInvoke {
  const fetchFn = options.fetchFn ?? fetch;
  const base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  return async (request: WorkersAiInvokeRequest): Promise<WorkersAiInvokeResult> => {
    const url = `${base}/accounts/${encodeURIComponent(options.accountId)}/ai/run/${request.model}`;
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: request.messages }),
    });
    const text = await res.text();
    if (res.status >= 400) {
      // Do not include the request body or headers in the error (no token leak).
      throw new Error(`Workers AI call failed for ${request.model} (HTTP ${res.status})`);
    }
    let body: {
      result?: {
        response?: unknown;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`Workers AI returned a non-JSON response for ${request.model}`);
    }
    const rawResponse = body.result?.response;
    // Workers AI usually returns `result.response` as a string, but some models
    // return it as an already-parsed JSON object when the reply is JSON. Coerce
    // an object back to its JSON text so the executor's parser sees a string.
    const response =
      typeof rawResponse === "string"
        ? rawResponse
        : rawResponse === undefined || rawResponse === null
          ? ""
          : JSON.stringify(rawResponse);
    const usage = body.result?.usage;
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

/**
 * OpenAiCompatibleExecutor: the thin shape of a generic OpenAI-compatible
 * executor, usable against a Cloudflare AI Gateway endpoint or any
 * OpenAI-compatible API.
 *
 * This is intentionally a thin adapter: it defines how configuration and usage
 * flow, how a change would be applied, and how cost is reported, without
 * embedding any provider logic or secrets. The actual request is delegated to an
 * injected `chat` function so no credential ever lives in this package. In the
 * spike the real request path is a separately gated concern; by default the
 * executor refuses to run unless a `chat` implementation is supplied, so it never
 * silently pretends to do inference.
 */

import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "./types.ts";

/** Token usage returned by an OpenAI-compatible endpoint. */
export interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A single file edit proposed by the model, applied by the runner. */
export interface ProposedEdit {
  /** Repository-relative path to write. */
  readonly path: string;
  /** Full file contents to write. */
  readonly contents: string;
}

/** The structured response an OpenAI-compatible chat call must return here. */
export interface ChatResult {
  readonly edits: readonly ProposedEdit[];
  readonly usage: ChatUsage;
  readonly commitMessage: string;
}

/**
 * The injected transport. Implementors send the prompt to an OpenAI-compatible
 * endpoint (for example an AI Gateway URL) using a credential they hold, and
 * return a structured ChatResult. No credential is passed through this package.
 */
export type ChatFn = (request: ChatRequest) => Promise<ChatResult>;

/** What the executor hands to the transport. */
export interface ChatRequest {
  readonly model: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly baselineRef: string;
  readonly worktreeDir: string;
}

/** Configuration for the OpenAI-compatible executor (no secrets). */
export interface OpenAiCompatibleOptions {
  /** Model identifier, e.g. "provider/model" for an AI Gateway route. */
  readonly model: string;
  /**
   * Dollars per 1000 input/output tokens, used to compute reported cost from
   * usage. Defaults to zero so cost is explicit rather than guessed.
   */
  readonly pricePer1kInputUsd?: number;
  readonly pricePer1kOutputUsd?: number;
  /** The transport that performs the actual request (holds any credential). */
  readonly chat: ChatFn;
  /** How edits are written to disk. Injectable for tests. */
  readonly writeFile?: (absPath: string, contents: string) => Promise<void>;
}

export class OpenAiCompatibleExecutor implements ExecutorProvider {
  readonly name = "openai-compatible";

  constructor(private readonly options: OpenAiCompatibleOptions) {
    if (typeof options.chat !== "function") {
      throw new Error(
        "OpenAiCompatibleExecutor requires a `chat` transport; it never embeds a credential",
      );
    }
  }

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const result = await this.options.chat({
      model: this.options.model,
      objective: context.objective,
      paths: context.paths,
      baselineRef: context.baselineRef,
      worktreeDir: context.worktreeDir,
    });

    const write = this.options.writeFile ?? defaultWriteFile;
    const changedPaths: string[] = [];
    for (const edit of result.edits) {
      await write(joinWorktree(context.worktreeDir, edit.path), edit.contents);
      changedPaths.push(edit.path);
    }

    const inUsd = ((result.usage.inputTokens / 1000) * (this.options.pricePer1kInputUsd ?? 0));
    const outUsd = ((result.usage.outputTokens / 1000) * (this.options.pricePer1kOutputUsd ?? 0));

    return {
      status: changedPaths.length > 0 ? "changed" : "no-change",
      changedPaths,
      logs: [
        `openai-compatible executor used model ${this.options.model}`,
        `applied ${changedPaths.length} edit(s)`,
      ],
      cost: {
        usd: Number((inUsd + outUsd).toFixed(6)),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: this.options.model,
      },
      commitMessage: result.commitMessage,
    };
  }
}

async function defaultWriteFile(absPath: string, contents: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents, "utf8");
}

function joinWorktree(worktreeDir: string, relPath: string): string {
  // Keep edits inside the worktree; reject path escapes defensively.
  if (relPath.startsWith("/") || relPath.includes("..")) {
    throw new Error(`edit path must be worktree-relative and contained: ${relPath}`);
  }
  return `${worktreeDir}/${relPath}`;
}

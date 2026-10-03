/**
 * NoopExecutor: a deterministic executor with zero real inference.
 *
 * It makes one trivial, deterministic edit inside the worktree: it writes a
 * marker file recording which WorkUnit ran, derived only from the WorkUnit id
 * and the fixed clock the caller provides. This lets the full clone, execute,
 * commit, and push loop run in tests and offline demos without any model call,
 * and the content is a pure function of its inputs so results are reproducible.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "./types.ts";

/** Options for the deterministic noop executor. */
export interface NoopExecutorOptions {
  /**
   * Directory under the worktree where the marker file is written. The runner
   * passes a WorkUnit-specific path so two concurrent runs never touch the same
   * file. Defaults to ".switchyard".
   */
  readonly markerDir?: string;
  /**
   * A fixed timestamp (ISO 8601) written into the marker, kept out of the file
   * name so the change is deterministic for a given WorkUnit id. Defaults to a
   * constant so runs are byte-for-byte reproducible.
   */
  readonly stamp?: string;
}

const DEFAULT_MARKER_DIR = ".switchyard";
const DEFAULT_STAMP = "1970-01-01T00:00:00.000Z";

export class NoopExecutor implements ExecutorProvider {
  readonly name = "noop";

  constructor(private readonly options: NoopExecutorOptions = {}) {}

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const markerDir = this.options.markerDir ?? DEFAULT_MARKER_DIR;
    const stamp = this.options.stamp ?? DEFAULT_STAMP;
    const relPath = join(markerDir, `${context.workUnitId}.done`);
    const absPath = join(context.worktreeDir, relPath);

    const body = [
      `work-unit: ${context.workUnitId}`,
      `objective: ${context.objective}`,
      `baseline: ${context.baselineRef}`,
      `executor: noop`,
      `stamp: ${stamp}`,
      "",
    ].join("\n");

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, body, "utf8");

    return {
      status: "changed",
      changedPaths: [relPath],
      logs: [
        `noop executor wrote deterministic marker ${relPath}`,
        `WorkUnit ${context.workUnitId} edit complete (zero inference)`,
      ],
      cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      commitMessage: `WorkUnit ${context.workUnitId}: deterministic noop change`,
    };
  }
}

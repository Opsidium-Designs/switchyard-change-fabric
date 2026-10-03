/**
 * ScopedNoopExecutor: a deterministic executor with zero real inference that
 * respects a WorkUnit's declared path scope.
 *
 * The plain NoopExecutor writes a marker under a fixed ".switchyard" directory,
 * which is useful for a bare isolation test but falls outside a WorkUnit's
 * declared paths, so the deterministic path-scope verification would reject it.
 * ScopedNoopExecutor instead derives a concrete, in-scope file from each
 * WorkUnit's first declared path glob and writes a deterministic marker there,
 * so the full run (including path-scope verification) passes offline with no
 * model call.
 *
 * For a directory glob such as "src/audit/**" it writes
 * "src/audit/<unitId>.done". For an exact path such as "src/audit/events.ts" it
 * writes that exact file, stamped with the owning WorkUnit id. Two WorkUnits
 * that both declare the same exact path therefore both write it with different
 * content, which is exactly the collision the fabric coordinates. The content is
 * a pure function of the WorkUnit id and the path, so results are reproducible.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "./types.ts";

/** Options for the scope-respecting deterministic executor. */
export interface ScopedNoopExecutorOptions {
  /**
   * A fixed timestamp written into each marker, kept out of file names so the
   * change is deterministic for a given WorkUnit id. Defaults to a constant so
   * runs are byte-for-byte reproducible.
   */
  readonly stamp?: string;
}

const DEFAULT_STAMP = "1970-01-01T00:00:00.000Z";

export class ScopedNoopExecutor implements ExecutorProvider {
  readonly name = "noop";

  constructor(private readonly options: ScopedNoopExecutorOptions = {}) {}

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const stamp = this.options.stamp ?? DEFAULT_STAMP;
    const targets = scopeTargets(context.workUnitId, context.paths);

    const changed: string[] = [];
    for (const rel of targets) {
      const abs = join(context.worktreeDir, rel);
      const body = markerBody(context, rel, stamp);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body, "utf8");
      changed.push(rel);
    }

    return {
      status: "changed",
      changedPaths: changed,
      logs: [
        `scoped noop executor wrote ${changed.join(", ")} (zero inference)`,
        `WorkUnit ${context.workUnitId} edit complete, within declared scope`,
      ],
      cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      commitMessage: `WorkUnit ${context.workUnitId}: deterministic in-scope change`,
    };
  }
}

/**
 * Derive the concrete in-scope files to write for a WorkUnit from its declared
 * path globs. Exact file paths (no glob characters) are written verbatim; a
 * directory glob yields a "<unitId>.done" marker inside that directory. The
 * result is deterministic and always within the declared scope.
 */
function scopeTargets(unitId: string, paths: readonly string[]): readonly string[] {
  const targets = new Set<string>();
  for (const glob of paths) {
    if (isExactFile(glob)) {
      targets.add(glob);
      continue;
    }
    const base = globBaseDir(glob);
    targets.add(base === "" ? `${unitId}.done` : `${base}/${unitId}.done`);
  }
  if (targets.size === 0) {
    // No declared paths: fall back to a clearly-labelled marker directory.
    targets.add(`.switchyard/${unitId}.done`);
  }
  return [...targets].sort();
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
  return literal.join("/");
}

/** The deterministic body written to a marker or stamped file. */
function markerBody(context: ExecutorContext, rel: string, stamp: string): string {
  return [
    `work-unit: ${context.workUnitId}`,
    `objective: ${context.objective}`,
    `path: ${rel}`,
    `baseline: ${context.baselineRef}`,
    `executor: noop`,
    `owner: ${context.workUnitId}`,
    `stamp: ${stamp}`,
    "",
  ].join("\n");
}

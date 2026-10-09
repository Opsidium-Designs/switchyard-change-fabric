/**
 * work-root: removing a finished run's scratch work root.
 *
 * Every run makes a private work root (`scf-run-*`, `scf-board-*`,
 * `scf-full-*`, ...) for its clones, worktrees, revisions, and caches. An
 * offline demo removes all of it at the end unless asked to keep it; a live
 * run keeps only the promoted repo (its path is printed and used to verify
 * the run) and removes everything else. Only a disposable root is touched:
 * an absolute path, not a filesystem root, whose name starts with `scf-`.
 */
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The flag that keeps a run's work root. */
export const KEEP_WORK_ROOT_FLAG = "--keep-work-root";

/** True for a path a run created as its scratch root (refuses anything else). */
export function isDisposableWorkRoot(workRoot: string): boolean {
  if (!isAbsolute(workRoot)) {
    return false;
  }
  const root = resolve(workRoot);
  return dirname(root) !== root && basename(root).startsWith("scf-");
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Remove everything under `workRoot` except the `keep` paths (and the
 * directories leading to them); with nothing to keep, remove the root itself.
 * Returns what was removed. A root that is not disposable is left untouched.
 */
export async function pruneWorkRoot(workRoot: string, keep: readonly string[] = []): Promise<string[]> {
  if (!isDisposableWorkRoot(workRoot)) {
    return [];
  }
  const root = resolve(workRoot);
  const kept = keep.map((k) => resolve(k)).filter((k) => within(k, root) && k !== root);
  if (kept.length === 0) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    return [root];
  }
  const removed: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}${sep}${entry.name}`;
      if (kept.includes(path)) {
        continue;
      }
      if (entry.isDirectory() && kept.some((k) => within(k, path))) {
        await walk(path);
        continue;
      }
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      removed.push(path);
    }
  };
  await walk(root);
  return removed;
}

/**
 * Finish a run's work root and say what happened, in one line: kept (with the
 * flag), pruned to the kept repo (live), or removed (offline).
 */
export async function finishWorkRoot(input: {
  readonly workRoot: string | undefined;
  readonly keepAll: boolean;
  /** Paths inside the root to keep (a live run's promoted repo). */
  readonly keep?: readonly string[];
}): Promise<string | undefined> {
  const { workRoot } = input;
  if (workRoot === undefined) {
    return undefined;
  }
  if (input.keepAll) {
    return `work root kept: ${workRoot}`;
  }
  if (!isDisposableWorkRoot(workRoot)) {
    return `work root left in place (not a run scratch directory): ${workRoot}`;
  }
  const keep = (input.keep ?? []).filter((k) => within(resolve(k), resolve(workRoot)) && resolve(k) !== resolve(workRoot));
  await pruneWorkRoot(workRoot, keep);
  return keep.length > 0
    ? `work root cleaned: kept ${keep.join(", ")}; removed the rest of ${workRoot} (${KEEP_WORK_ROOT_FLAG} keeps everything)`
    : `work root removed: ${workRoot} (${KEEP_WORK_ROOT_FLAG} keeps it)`;
}

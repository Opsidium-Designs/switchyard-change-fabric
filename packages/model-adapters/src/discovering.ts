/**
 * DiscoveringExecutor: wrap any executor so that, after it changes a WorkUnit,
 * it REPORTS follow-up work it discovered in the real worktree.
 *
 * This is the honest mechanism behind dynamic branching. Fixing one thing often
 * reveals more of the same work: the agent that fixed a bug in one file finds
 * the identical pattern in other files that also need it. This wrapper surfaces
 * that as real, repo-derived discovery, NOT a scripted animation:
 *
 *   1. it runs the wrapped executor normally (the real edit happens);
 *   2. then it scans the cloned worktree for OTHER files that carry a generic
 *      discovery marker (a configurable literal substring) and are NOT the
 *      file(s) this unit just handled;
 *   3. each such file becomes one discovered follow-up unit scoped to that file.
 *
 * It is goal-agnostic: discovery is derived from a generic repo scan (files
 * containing a marker), never from a per-template or per-goal table. It is
 * deterministic: the same worktree yields the same discovered set, so an offline
 * run and `make check` reproduce the growth exactly, mirroring how the
 * deterministic executor and the escalation beat stay reproducible. It only ever
 * fires once per originating unit: a discovered unit's id is namespaced under its
 * parent and scoped to a single file, and this wrapper does not re-discover a
 * file that is already a unit's sole declared path, so the graph grows and then
 * settles rather than branching without bound.
 *
 * The wrapper reports discovery only for a PRIMARY unit (one whose id is not
 * itself a discovered-unit id), so a discovered unit fixing its own file does not
 * spawn a third generation. This keeps the growth a single, bounded ripple from
 * the first fix out to the sibling files that share the pattern.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type {
  DiscoveredUnit,
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "./types.ts";

/** Options for the discovery wrapper. */
export interface DiscoveringExecutorOptions {
  /**
   * The literal marker a file must contain to be discovered as follow-up work.
   * It is a generic repo fact (for example a planted "TODO: validate" or a
   * shared buggy call), scanned across the target repo. Defaults to a
   * conservative marker so a repo without the marker discovers nothing.
   */
  readonly marker?: string;
  /** The repo-relative directory to scan for the marker. Defaults to "src". */
  readonly scanDir?: string;
  /** A cap on how many follow-up units one unit may discover. Defaults to 6. */
  readonly maxDiscovered?: number;
  /**
   * The absolute path of the real target repository to scan for follow-up work.
   * In this substrate each agent works in a freshly-provisioned (initially
   * empty) repo rather than a clone of the project, so the honest source of a
   * "the same fix is needed elsewhere" fact is the ACTUAL project the Change is
   * changing. When set, discovery scans this directory; when unset, it falls
   * back to the agent's worktree (useful when the worktree is a real clone).
   */
  readonly projectDir?: string;
}

const DEFAULT_MARKER = "FABRIC-FOLLOWUP";
const DEFAULT_SCAN_DIR = "src";
const DEFAULT_MAX_DISCOVERED = 6;

export class DiscoveringExecutor implements ExecutorProvider {
  readonly name: string;

  constructor(
    private readonly base: ExecutorProvider,
    private readonly options: DiscoveringExecutorOptions = {},
  ) {
    this.name = base.name;
  }

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const result = await this.base.execute(context);
    // Only a real, successful change discovers follow-up work; a failed or
    // no-change run reports nothing (there is no fix to ripple out).
    if (result.status !== "changed") {
      return result;
    }
    // A discovered unit (namespaced id with "+") does not itself discover more:
    // the ripple is one generation from the originating primary unit.
    if (context.workUnitId.includes("+")) {
      return result;
    }
    const discovered = await this.scanForFollowups(context, result.changedPaths);
    if (discovered.length === 0) {
      return result;
    }
    return { ...result, discoveredUnits: discovered };
  }

  /**
   * Scan the worktree for other files carrying the discovery marker that this
   * unit did not just handle, and turn each into a discovered follow-up unit
   * scoped to that single file. Reads the REAL cloned worktree, so the discovery
   * is a genuine repo fact. Deterministic: files are sorted, so the discovered
   * set is reproducible.
   */
  private async scanForFollowups(
    context: ExecutorContext,
    changedPaths: readonly string[],
  ): Promise<DiscoveredUnit[]> {
    const marker = this.options.marker ?? DEFAULT_MARKER;
    const scanDir = this.options.scanDir ?? DEFAULT_SCAN_DIR;
    const maxDiscovered = this.options.maxDiscovered ?? DEFAULT_MAX_DISCOVERED;
    const changed = new Set(changedPaths);
    // The files this unit was already scoped to: never discover one of these.
    const ownScope = new Set(context.paths.filter((p) => !/[*?]/.test(p)));

    // Scan the real target repo when configured (each agent's worktree is a
    // freshly-provisioned empty repo in this substrate, so the honest source of
    // a "same fix needed elsewhere" fact is the actual project the Change is
    // changing); otherwise scan the agent's worktree (a real clone).
    const scanRoot = this.options.projectDir ?? context.worktreeDir;
    const absScan = join(scanRoot, scanDir);
    let files: string[];
    try {
      files = await listFiles(absScan);
    } catch {
      return [];
    }

    const discovered: DiscoveredUnit[] = [];
    const sorted = files.sort();
    for (const abs of sorted) {
      const rel = relative(scanRoot, abs).split(sep).join("/");
      if (changed.has(rel) || ownScope.has(rel)) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (!content.includes(marker)) {
        continue;
      }
      discovered.push({
        idSuffix: labelFor(rel),
        objective: `Apply the same fix in ${rel} (discovered follow-up)`,
        paths: [rel],
        reason: `found the "${marker}" marker in ${rel} while fixing ${context.workUnitId}`,
      });
      if (discovered.length >= maxDiscovered) {
        break;
      }
    }
    return discovered;
  }
}

/** A short, id-safe label derived from a file path. */
function labelFor(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.[cm]?tsx?$/i, "");
  return base.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "file";
}

/** Recursively list regular files under a directory (absolute paths). */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      out.push(...(await listFiles(abs)));
    } else {
      const info = await stat(abs).catch(() => null);
      if (info?.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

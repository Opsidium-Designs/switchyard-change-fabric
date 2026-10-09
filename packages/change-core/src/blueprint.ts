/**
 * The cohesion blueprint: a pure, goal-agnostic structural pass that reads a
 * RepoSnapshot and, when the repo is clearly modular, groups work by COHESIVE
 * MODULE rather than by file.
 *
 * Why a separate pass
 * -------------------
 * The decomposer shapes work from how a goal's generic features meet the repo's
 * structure. For a repo built as a set of independent sibling modules that all
 * lean on a few shared seams (a resources directory where each resource imports
 * a common response/auth helper, say), fanning out one unit per FILE would split
 * a single shared concern across the seam files and hand two agents the same
 * frozen interface. The honest shape is one owner per module, with the shared
 * seams frozen read-only so no unit rewrites them. This pass derives that shape
 * from structure alone, so the decomposer can project units from it on its one
 * code path without ever branching on the goal string.
 *
 * How it stays goal-agnostic
 * --------------------------
 * The blueprint consumes only the RepoSnapshot (modules, exports, the resolved
 * import graph, entry-point flags). It never sees the goal. A seam is identified
 * by import IN-DEGREE (a file many siblings import), not by the word "contract";
 * a module owner is a sibling leaf under a common feature directory, not a named
 * file. The same structural rule produces a module blueprint for a modular repo
 * and NO blueprint for a small, single-file, or tightly coupled repo. That is
 * the "do not parallelize" guard: when the structure does not justify many
 * owners, the blueprint is absent and the decomposer keeps its existing shape.
 */

import type { RepoSnapshot, SourceFileFacts } from "./repo-snapshot.ts";

/** One owned module in the blueprint: exactly one unit may write its file(s). */
export interface BlueprintModule {
  /** A stable, filesystem-safe label for the module (derived from its path). */
  readonly label: string;
  /** The source file paths this module owns (disjoint across modules). */
  readonly paths: readonly string[];
  /**
   * The labels of other OWNED modules this module depends on, because it imports
   * a file they own. A dependency on a frozen contract is NOT listed here (a
   * contract has no owner), so this is only the real inter-module write order.
   */
  readonly dependsOn: readonly string[];
  /**
   * The names of the symbols this module's file(s) export. This is the module's
   * EXPORTED INTERFACE: the public surface other modules (and the entry point)
   * import by name, so it is a contract the rest of the service depends on. The
   * owner unit must keep every one of these present and exported when it changes
   * the implementation, or an importer breaks. It is a pure structural read of
   * the snapshot's already-parsed exports (the union across the module's files,
   * sorted and de-duplicated), so it never branches on the goal or any single
   * symbol name. A module whose files export nothing yields an empty list.
   */
  readonly exports: readonly string[];
}

/**
 * A frozen read-only interface at a seam: a file many modules import. No unit
 * owns it, so no unit may rewrite it; modules read and import it only.
 */
export interface BlueprintContract {
  /** The seam file path (read-only; owned by no unit). */
  readonly path: string;
  /** How many source files import this seam (its import in-degree). */
  readonly importedByCount: number;
}

/**
 * The structural blueprint of a modular repo: the owned modules, the frozen
 * contracts at the seams, and the inter-module dependency edges. Present only
 * when the repo is clearly modular; otherwise the decomposer keeps its existing
 * behavior (one unit, the do-not-parallelize guard).
 */
export interface CohesionBlueprint {
  readonly modules: readonly BlueprintModule[];
  readonly contracts: readonly BlueprintContract[];
  /** Inter-module dependency edges (from a prerequisite owner to a dependent). */
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  /**
   * Every feature group the structure has (a directory of sibling owners over
   * shared seams), each with its module labels and the seams it leans on.
   * The modules and contracts above are the union over all groups.
   */
  readonly groups?: readonly { readonly dir: string; readonly modules: readonly string[]; readonly contracts: readonly string[] }[];
}

/** The minimum number of sibling owner modules for the modular shape to apply. */
const MIN_MODULES = 3;

/**
 * The minimum share of a group's modules that must import a seam for it to count
 * as a shared contract. A seam the whole sibling set leans on (every resource
 * importing the response helper) is the clear case; a file one sibling happens
 * to import is not a shared contract. Kept as a majority so the signal is a
 * genuinely shared seam, not an incidental import.
 */
const SHARED_SEAM_FRACTION = 0.5;

/**
 * Derive the cohesion blueprint from a snapshot, or undefined when the repo is
 * not clearly modular. Pure and deterministic.
 *
 * The structural rule, in one place:
 *   1. Group the source files by their directory (the snapshot's modules).
 *   2. Find EVERY "feature group": a directory whose siblings are many (>= MIN)
 *      leaf files that share a common imported seam. The siblings become owner
 *      modules; the shared seams become frozen contracts (a file one group
 *      owns stays owned). A directory where at least half (and two) of the
 *      files are seams is a seam directory: all its files are frozen.
 *   3. A file is a candidate OWNER when it is not an entry point and is not
 *      itself a shared seam within the group (a shared seam is read-only).
 *   4. Dependency edges run between owners only: if an owner imports a file
 *      another owner owns, the importer depends on it. Importing a frozen
 *      contract adds no edge (a contract has no owner to wait for).
 *
 * None of this reads the goal; it is a function of the repo's structure alone.
 */
export function deriveCohesionBlueprint(snapshot: RepoSnapshot): CohesionBlueprint | undefined {
  const byPath = new Map(snapshot.sourceFiles.map((f) => [f.path, f] as const));

  // 1-3. Every directory group that is clearly modular is a FEATURE GROUP: its
  // sibling owners and the seams they share. A repo of several feature
  // directories (catalog, orders, billing, ...) yields one group each, so a
  // planner sees the whole structure, not only the first group it met.
  const groups: { dir: string; owners: SourceFileFacts[]; seams: Set<string>; importCounts: Map<string, number> }[] = [];
  for (const module of snapshot.modules) {
    const siblings = module.files
      .map((p) => byPath.get(p))
      .filter((f): f is SourceFileFacts => f !== undefined);

    // A seam for this group is a file (anywhere in the repo) that a majority of
    // the group's siblings import. Count, per imported file, how many of the
    // siblings import it.
    const importCounts = new Map<string, number>();
    for (const sib of siblings) {
      for (const target of sib.importsFiles) {
        importCounts.set(target, (importCounts.get(target) ?? 0) + 1);
      }
    }
    const threshold = Math.max(2, Math.ceil(siblings.length * SHARED_SEAM_FRACTION));
    const seamPaths = new Set(
      [...importCounts.entries()]
        .filter(([, count]) => count >= threshold)
        .map(([path]) => path),
    );

    // Candidate owner files in this group: a sibling that is not an entry point
    // and is not itself a shared seam. These are the independent leaf modules.
    const owners = siblings
      .filter((f) => !f.isEntryPoint && !seamPaths.has(f.path))
      .sort((a, b) => comparePath(a.path, b.path));

    if (owners.length < MIN_MODULES || seamPaths.size === 0) {
      continue;
    }
    groups.push({ dir: dirOf(module.files[0] ?? ""), owners, seams: seamPaths, importCounts });
  }
  if (groups.length === 0) {
    return undefined;
  }

  // An owner in one group stays an owner (a file another group leans on is a
  // real write dependency, not a frozen seam).
  const ownedPaths = new Set(groups.flatMap((g) => g.owners.map((f) => f.path)));
  const seamsAll = new Set(groups.flatMap((g) => [...g.seams]).filter((p) => !ownedPaths.has(p)));
  // A SEAM DIRECTORY: when at least half (and two) of a directory's files are
  // shared seams, its other files are part of the same shared surface (a
  // contracts directory whose helper no group calls yet is still a contract),
  // so they are frozen too, never owned.
  for (const module of snapshot.modules) {
    const files = module.files.filter((p) => byPath.has(p));
    const seamCount = files.filter((p) => seamsAll.has(p)).length;
    if (files.length >= 2 && seamCount >= 2 && seamCount * 2 >= files.length) {
      for (const path of files) {
        if (!ownedPaths.has(path) && !byPath.get(path)!.isEntryPoint) {
          seamsAll.add(path);
        }
      }
    }
  }

  const owners = groups.flatMap((g) => g.owners).sort((a, b) => comparePath(a.path, b.path));
  const labelByPath = new Map(owners.map((f) => [f.path, moduleLabel(f.path)] as const));

  const modules: BlueprintModule[] = [];
  const edges: { from: string; to: string }[] = [];
  for (const owner of owners) {
    const label = labelByPath.get(owner.path)!;
    const dependsOn: string[] = [];
    for (const target of owner.importsFiles) {
      // An edge only to another OWNED module (a real write dependency, in any
      // group), never to a frozen contract (read-only, no owner to wait for).
      if (ownedPaths.has(target) && target !== owner.path) {
        const depLabel = labelByPath.get(target)!;
        dependsOn.push(depLabel);
        edges.push({ from: depLabel, to: label });
      }
    }
    modules.push({
      label,
      paths: [owner.path],
      dependsOn: dedupe(dependsOn).sort(compareString),
      // The module's exported interface: the union of its file(s)' exported
      // symbol names from the snapshot's already-parsed exports. A pure
      // structural read (sorted, de-duplicated), never a goal/name branch.
      exports: moduleExports([owner.path], byPath),
    });
  }

  const importedBy = (path: string): number =>
    byPath.get(path)?.importedByCount ?? groups.reduce((n, g) => Math.max(n, g.importCounts.get(path) ?? 0), 0);
  const contracts: BlueprintContract[] = [...seamsAll]
    .map((path) => ({ path, importedByCount: importedBy(path) }))
    .sort((a, b) => comparePath(a.path, b.path));

  return {
    modules: modules.sort((a, b) => compareString(a.label, b.label)),
    contracts,
    edges: edges.sort((a, b) => compareString(a.from, b.from) || compareString(a.to, b.to)),
    groups: groups
      .map((g) => ({
        dir: g.dir,
        modules: g.owners.map((f) => labelByPath.get(f.path)!).sort(compareString),
        contracts: [...g.seams].filter((p) => seamsAll.has(p)).sort(comparePath),
      }))
      .sort((a, b) => comparePath(a.dir, b.dir)),
  };
}

/** The directory of a repo-relative path ("" at the root). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** A short, filesystem-safe label for a path (mirrors the decomposer's). */
function moduleLabel(path: string): string {
  return path
    .replace(/\.[cm]?[jt]sx?$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * The exported interface of a module: the union of the exported symbol names of
 * its file(s), read from the snapshot's already-parsed `SourceFileFacts.exports`
 * (sorted and de-duplicated). This is a pure structural read of the repo, not a
 * goal-specific or named-symbol branch, so it stays goal-agnostic: a module that
 * exports `handle` carries `["handle"]` for exactly the same reason a module that
 * exports anything else carries those names. A module whose files export nothing
 * yields an empty list.
 */
function moduleExports(
  paths: readonly string[],
  byPath: ReadonlyMap<string, SourceFileFacts>,
): readonly string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const file = byPath.get(path);
    if (!file) {
      continue;
    }
    for (const symbol of file.exports) {
      if (symbol.name !== "") {
        names.add(symbol.name);
      }
    }
  }
  return [...names].sort(compareString);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

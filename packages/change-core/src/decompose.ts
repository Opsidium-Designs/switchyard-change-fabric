/**
 * The decomposer: goal + target-repo state produces a WorkGraph, with no
 * per-goal scripting.
 *
 * This is the engine M1 is about. It takes a plain-text goal and a structural
 * snapshot of the repository the goal will change, and emits a Change (whose
 * WorkUnits and dependency edges are the WorkGraph). The hand-authored YAML
 * Change remains a valid alternate input to the same Change type (see the
 * loader); the decomposer is the goal-driven path that replaces authoring YAML
 * by hand.
 *
 * How it stays goal-agnostic (the anti-puppet contract)
 * -----------------------------------------------------
 * The decomposer never branches on the goal string and holds no table keyed on
 * known goals. It consumes a `GoalIntent` (a generic reduction of the goal into
 * action families, target terms, and a universal-quantifier flag) and a
 * `RepoSnapshot` (generic structural facts about the repo). It then applies a
 * fixed set of structural rules that are the same for every goal:
 *
 *   1. Match the goal's target terms against the repo's modules, file names, and
 *      exported symbols to find the relevant surface. The matching is scored
 *      over real repo structure, so what a goal touches is derived from the repo,
 *      not from the goal literal.
 *   2. Shape the work from the goal's action families and quantifier:
 *        - a universal goal ("every"/"all") over a surface fans OUT into one
 *          WorkUnit per matching source file (wide, shallow graph);
 *        - a non-universal goal produces one WorkUnit per matched module, plus a
 *          dependent "wire" unit when the goal asks to connect pieces and the
 *          repo has an entry/router surface to wire into (narrow, layered graph);
 *        - a "test" action adds a tests WorkUnit depending on the units it covers,
 *          when the repo has a test layout.
 *   3. Derive dependency edges structurally: a wiring/integration unit depends on
 *      the units that produce what it wires; a tests unit depends on the units it
 *      exercises.
 *
 * Because the shape is a function of (how the goal's features interact with the
 * repo's structure), two structurally different goals produce two structurally
 * different graphs through this one code path, and swapping the goal string for
 * one with the same features would produce the same graph. That is the property
 * the anti-puppet test pins.
 */

import { HeuristicGoalAnalyzer, type ActionFamily, type GoalAnalyzer, type GoalIntent } from "./goal.ts";
import {
  buildRepoSnapshot,
  type ModuleGroup,
  type RepoFile,
  type RepoSnapshot,
  type SourceFileFacts,
} from "./repo-snapshot.ts";
import {
  deriveCohesionBlueprint,
  type CohesionBlueprint,
} from "./blueprint.ts";
import type { AssuranceLevel, Change, WorkUnit } from "./types.ts";
import { normalizeChange } from "./loader.ts";

/** Options for a single decomposition. */
export interface DecomposeOptions {
  /** The human-stated goal (plain text intent). */
  readonly goal: string;
  /** The target repository, either a flat file list or a prebuilt snapshot. */
  readonly repo: readonly RepoFile[] | RepoSnapshot;
  /**
   * The analyzer that reduces the goal to a GoalIntent. Defaults to the
   * deterministic, offline `HeuristicGoalAnalyzer` so decomposition requires no
   * live inference. An inference-backed analyzer may be injected; it must return
   * the same `GoalIntent` shape and the decomposer treats it identically.
   */
  readonly analyzer?: GoalAnalyzer;
  /** A stable Change id. Defaults to a slug derived from the goal text. */
  readonly changeId?: string;
  /** Budget to record on the Change (illustrative). Defaults to 5. */
  readonly budgetUsd?: number;
  /** Assurance level to record. Defaults to "standard". */
  readonly assurance?: AssuranceLevel;
}

/** The full result of a decomposition: the Change plus the intent that drove it. */
export interface DecomposeResult {
  readonly change: Change;
  readonly intent: GoalIntent;
  readonly snapshot: RepoSnapshot;
  /**
   * The cohesion blueprint, when the repo was clearly modular and the work was
   * decomposed by module. It names the owned modules, the frozen read-only
   * contracts at the seams (owned by no unit), and the inter-module dependency
   * edges. Absent when the repo was not modular enough to parallelize, in which
   * case the Change keeps its single-unit / per-file shape.
   */
  readonly blueprint?: CohesionBlueprint;
}

/**
 * Decompose a goal against a target repository into a Change. Pure and
 * deterministic given a deterministic analyzer (the default), so the same goal
 * and repo always produce the same WorkGraph.
 */
export function decompose(options: DecomposeOptions): DecomposeResult {
  const analyzer = options.analyzer ?? new HeuristicGoalAnalyzer();
  const snapshot = isSnapshot(options.repo) ? options.repo : buildRepoSnapshot(options.repo);
  const intent = analyzer.analyze(options.goal);

  // The cohesion blueprint is a goal-agnostic structural pass: it groups work by
  // module and marks the shared seams frozen read-only when the repo is clearly
  // modular, and is undefined otherwise (the do-not-parallelize guard). When it
  // is present the decomposer projects one owner unit per module from it; when
  // absent the decomposer keeps its per-file / per-module shape.
  const blueprint = deriveCohesionBlueprint(snapshot);

  const work = planWorkUnits(intent, snapshot, blueprint);
  if (work.length === 0) {
    // A goal that matched nothing in the repo still yields one honest unit so the
    // graph is never empty; it targets the repo's primary source directory.
    work.push(fallbackUnit(intent, snapshot));
  }

  const change: Change = normalizeChange({
    id: options.changeId ?? slug(intent.text),
    objective: intent.text,
    baseline: "HEAD",
    budget_usd: options.budgetUsd ?? 5,
    assurance: options.assurance ?? "standard",
    work: work.map((unit) => ({
      id: unit.id,
      objective: unit.objective,
      depends_on: [...unit.dependsOn],
      paths: [...unit.paths],
    })),
  });

  if (!blueprint) {
    return { change, intent, snapshot };
  }

  // Project the structural blueprint onto the Change's own WorkUnit ids, so a
  // later stage reading the Change sees which unit owns which module file and
  // which seam files are frozen read-only. The owner unit for a module is the
  // one whose declared paths are exactly that module's file(s); a module whose
  // owner was not emitted (a narrowed goal) is simply left off the carried
  // blueprint, keeping it consistent with the Change's actual units.
  const unitByPath = new Map<string, string>();
  for (const unit of change.work) {
    for (const path of unit.paths) {
      unitByPath.set(path, unit.id);
    }
  }
  const carriedModules = blueprint.modules
    .map((module) => {
      const unitId = module.paths.map((p) => unitByPath.get(p)).find((id) => id !== undefined);
      if (!unitId) {
        return undefined;
      }
      const dependsOn = module.dependsOn
        .map((depLabel) => {
          const dep = blueprint.modules.find((m) => m.label === depLabel);
          const depPath = dep?.paths[0];
          return depPath ? unitByPath.get(depPath) : undefined;
        })
        .filter((id): id is string => id !== undefined);
      return { unitId, paths: [...module.paths], dependsOn };
    })
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  const changeBlueprint = {
    modules: carriedModules,
    contracts: blueprint.contracts.map((c) => ({
      path: c.path,
      importedByCount: c.importedByCount,
    })),
  };

  return { change: { ...change, blueprint: changeBlueprint }, intent, snapshot, blueprint };
}

/** Convenience: decompose and return just the Change. */
export function decomposeToChange(options: DecomposeOptions): Change {
  return decompose(options).change;
}

/**
 * Apply the structural rules to produce the WorkUnits. This is the one code path
 * every goal flows through; the branches below are over generic goal FEATURES
 * and repo STRUCTURE, never over the goal string.
 */
function planWorkUnits(
  intent: GoalIntent,
  snapshot: RepoSnapshot,
  blueprint: CohesionBlueprint | undefined,
): WorkUnit[] {
  const matched = matchSurface(intent, snapshot);
  const action = primaryAction(intent.actions);

  const units: WorkUnit[] = [];

  if (blueprint) {
    // Cohesion-aware shape: one owner unit per module, with the shared seams
    // frozen read-only (no unit owns a contract path). This is the honest shape
    // for a modular repo and replaces both the universal per-file fan-out and
    // the per-module directory grouping below. It is still goal-sensitive: the
    // goal's matched surface narrows WHICH modules are owned when the goal
    // singles some out, and the goal's structural actions still add their own
    // dependent units; only the module boundary and the frozen contracts come
    // from structure. The dependency edges are the blueprint's inter-module
    // import order, so a repo with real inter-module deps orders correctly and a
    // repo of independent siblings fans out in one wave.
    const selected = selectBlueprintModules(blueprint, matched);
    for (const module of selected) {
      units.push({
        id: unitId(action, module.label),
        objective: `${verbPhrase(action, intent)} in ${module.paths[0] ?? module.label}`,
        // Only depend on selected owners, so a narrowed selection never dangles
        // an edge to a module that was not emitted.
        dependsOn: module.dependsOn.filter((dep) =>
          selected.some((m) => m.label === dep),
        ).map((dep) => unitId(action, dep)),
        paths: [...module.paths],
      });
    }
  } else if (intent.isUniversal) {
    // Universal quantifier: fan out one WorkUnit per matching source file.
    const files = matched.files.length > 0 ? matched.files : snapshot.sourceFiles;
    for (const file of files) {
      units.push({
        id: unitId(action, moduleLabel(file.path)),
        objective: `${verbPhrase(action, intent)} in ${file.path}`,
        dependsOn: [],
        paths: [file.path],
      });
    }
  } else {
    // Non-universal. Prefer the specifically matched files when the goal's
    // targets singled out particular files; otherwise fall back to matched
    // modules (directory groupings), then to the repo's leaf modules. This keeps
    // the scope as tight as the goal and repo justify, derived from the match.
    const specificFiles = specificMatchedFiles(matched, snapshot);
    if (specificFiles.length > 0) {
      for (const file of specificFiles) {
        units.push({
          id: unitId(action, moduleLabel(file.path)),
          objective: `${verbPhrase(action, intent)} in ${file.path}`,
          dependsOn: [],
          paths: [file.path],
        });
      }
    } else {
      const modules = matched.modules.length > 0 ? matched.modules : primaryModules(snapshot);
      for (const module of modules) {
        units.push({
          id: unitId(action, moduleLabel(module.dir)),
          objective: `${verbPhrase(action, intent)} in ${module.dir || "the project root"}`,
          dependsOn: [],
          paths: [`${module.dir}/**`.replace(/^\/+/, "")],
        });
      }
    }
  }

  // A wiring/integration action adds a dependent unit that connects the produced
  // work into the repo's entry/router surface, when such a surface exists. The
  // wiring target must not be a frozen contract: a contract is read-only and
  // owned by no unit, so a wire unit never claims a contract path.
  if (intent.actions.includes("wire")) {
    const target = wiringTarget(snapshot);
    const frozen = new Set((blueprint?.contracts ?? []).map((c) => c.path));
    if (target && units.length > 0 && !frozen.has(target.path)) {
      units.push({
        id: unitId("wire", moduleLabel(target.path)),
        objective: `Wire the new work into ${target.path}`,
        dependsOn: units.map((u) => u.id),
        paths: [target.path],
      });
    }
  }

  // A test action adds a tests unit covering the produced work, when the repo
  // has a recognizable test layout. It depends on the units it exercises.
  if (intent.actions.includes("test") && snapshot.hasTests && units.length > 0) {
    const testDir = testRoot(snapshot);
    units.push({
      id: "tests",
      objective: `Add tests covering ${intent.text}`,
      dependsOn: units.map((u) => u.id),
      paths: [`${testDir}/**`],
    });
  }

  return dedupeUnits(units);
}

/**
 * Choose which blueprint modules to emit as owner units. When the goal singled
 * out particular modules (its matched surface names some owner files or a
 * directory containing them), scope to those; otherwise own every module in the
 * blueprint. This keeps the module shape goal-sensitive (a goal about one
 * resource owns one module) while a service-wide goal owns them all, all through
 * the one structural blueprint. The selection is derived from the match, never
 * from the goal string.
 */
function selectBlueprintModules(
  blueprint: CohesionBlueprint,
  matched: MatchedSurface,
): readonly CohesionBlueprint["modules"][number][] {
  const matchedPaths = new Set(matched.files.map((f) => f.path));
  const matchedDirs = new Set(matched.modules.map((m) => m.dir));
  const narrowed = blueprint.modules.filter(
    (module) =>
      module.paths.some((p) => matchedPaths.has(p)) ||
      module.paths.some((p) => matchedDirs.has(dirOf(p))),
  );
  // A narrowed selection only applies when it is a strict, non-empty subset; a
  // match that touches every module (or none specifically) owns them all, which
  // is the service-wide case.
  if (narrowed.length > 0 && narrowed.length < blueprint.modules.length) {
    return narrowed;
  }
  return blueprint.modules;
}

/**
 * The matched repo surface a goal's targets point at. */
interface MatchedSurface {
  readonly modules: readonly ModuleGroup[];
  readonly files: readonly SourceFileFacts[];
  /** The lower-cased target terms the match was computed from. */
  readonly terms: readonly string[];
}

/**
 * Match the goal's target terms against the repo's structure, scoring each
 * module and file by how many target terms appear in its path or exported
 * symbol names. Modules/files with a positive score are the matched surface.
 * This is where "what the goal touches" is derived from the repo, not the goal.
 */
function matchSurface(intent: GoalIntent, snapshot: RepoSnapshot): MatchedSurface {
  const terms = intent.targets;

  const scoredFiles = snapshot.sourceFiles
    .map((file) => ({ file, score: scoreFile(file, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || comparePath(a.file.path, b.file.path));

  const scoredModules = snapshot.modules
    .map((module) => ({ module, score: scoreModule(module, snapshot, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || comparePath(a.module.dir, b.module.dir));

  return {
    files: scoredFiles.map((entry) => entry.file),
    modules: scoredModules.map((entry) => entry.module),
    terms,
  };
}

/**
 * The matched files that are name-specific: a target term appears in the file's
 * own base name (not merely in its directory or re-exported content), and the
 * matched set is a strict subset of the repo's source files. A goal that names a
 * particular file ("the geometry helpers") therefore scopes to that file, while
 * a goal that matches a whole area through a directory name ("audit logging")
 * does not fan out per file and falls back to module scope. This keeps scoping
 * derived from the match, not from the goal string.
 */
function specificMatchedFiles(
  matched: MatchedSurface,
  snapshot: RepoSnapshot,
): readonly SourceFileFacts[] {
  if (matched.files.length === 0 || matched.files.length >= snapshot.sourceFiles.length) {
    return [];
  }
  const nameSpecific = matched.files.filter((file) => {
    const base = file.path.slice(file.path.lastIndexOf("/") + 1).toLowerCase();
    return matched.terms.some((term) => base.includes(term));
  });
  // Drop entry-point files from a specific fan-out; they are wiring surface, not
  // the substantive target of a non-universal content goal.
  const substantive = nameSpecific.filter((file) => !file.isEntryPoint);
  return substantive;
}

/** Score a file by target-term hits in its path and exported symbol names. */
function scoreFile(file: SourceFileFacts, terms: readonly string[]): number {
  let score = 0;
  const haystack = `${file.path.toLowerCase()} ${file.exports.map((e) => e.name.toLowerCase()).join(" ")}`;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

/** Score a module by summing its files' scores plus a hit on the directory name. */
function scoreModule(
  module: ModuleGroup,
  snapshot: RepoSnapshot,
  terms: readonly string[],
): number {
  let score = 0;
  const dir = module.dir.toLowerCase();
  for (const term of terms) {
    if (dir.includes(term)) {
      score += 2;
    }
  }
  for (const path of module.files) {
    const file = snapshot.sourceFiles.find((f) => f.path === path);
    if (file) {
      score += scoreFile(file, terms);
    }
  }
  return score;
}

/**
 * The file a wiring action connects into: the first router-like file, else the
 * first entry point, else undefined. Deterministic by snapshot order.
 */
function wiringTarget(snapshot: RepoSnapshot): SourceFileFacts | undefined {
  return (
    snapshot.sourceFiles.find((f) => f.isRouterLike) ??
    snapshot.sourceFiles.find((f) => f.isEntryPoint)
  );
}

/** When no module matched, fall back to the top-level source directories. */
function primaryModules(snapshot: RepoSnapshot): readonly ModuleGroup[] {
  if (snapshot.modules.length === 0) {
    return [];
  }
  // Prefer the leaf modules (deepest directories) so work is scoped tightly.
  const maxDepth = Math.max(...snapshot.modules.map((m) => depth(m.dir)));
  const leaves = snapshot.modules.filter((m) => depth(m.dir) === maxDepth);
  return leaves.length > 0 ? leaves : [snapshot.modules[0] as ModuleGroup];
}

/** The directory tests should be added under. */
function testRoot(snapshot: RepoSnapshot): string {
  const existing = snapshot.testFiles[0];
  if (existing) {
    const dir = existing.slice(0, existing.lastIndexOf("/"));
    return dir === "" ? "tests" : dir;
  }
  return "tests";
}

/** A single honest unit for a goal that matched nothing structural. */
function fallbackUnit(intent: GoalIntent, snapshot: RepoSnapshot): WorkUnit {
  const dir = snapshot.modules[0]?.dir ?? "src";
  return {
    id: unitId(primaryAction(intent.actions), moduleLabel(dir)),
    objective: intent.text,
    dependsOn: [],
    paths: [`${dir}/**`.replace(/^\/+/, "")],
  };
}

/**
 * Choose a single leading CONTENT action for naming the base WorkUnits. The
 * structural actions (test, wire) drive their own dependent units and must not
 * relabel the base work, so they are excluded here; a goal that only asks to
 * test or wire still falls back to "add" for its base units.
 */
function primaryAction(actions: readonly ActionFamily[]): ActionFamily {
  const STRUCTURAL: ReadonlySet<ActionFamily> = new Set<ActionFamily>(["test", "wire"]);
  const content = actions.filter((a) => !STRUCTURAL.has(a));
  // Prefer a specific content action over the generic "add" when both are present.
  const specific = content.find((a) => a !== "add");
  return specific ?? content[0] ?? "add";
}

/** A verb phrase for a WorkUnit objective, from the action family. */
function verbPhrase(action: ActionFamily, intent: GoalIntent): string {
  switch (action) {
    case "validate":
      return "Add input validation";
    case "wire":
      return "Integrate the change";
    case "test":
      return "Add tests";
    case "refactor":
      return "Refactor";
    case "document":
      return "Document";
    case "add":
    default:
      return `Implement ${intent.targets[0] ?? "the change"}`;
  }
}

/** Deterministically remove duplicate unit ids, keeping the first occurrence. */
function dedupeUnits(units: readonly WorkUnit[]): WorkUnit[] {
  const seen = new Set<string>();
  const result: WorkUnit[] = [];
  for (const unit of units) {
    if (seen.has(unit.id)) {
      continue;
    }
    seen.add(unit.id);
    result.push(unit);
  }
  return result;
}

/** A stable WorkUnit id from an action and a module label. */
function unitId(action: ActionFamily, label: string): string {
  const base = label === "" ? "root" : label;
  return `${action}-${base}`;
}

/** A short, filesystem-safe label for a path or directory. */
function moduleLabel(path: string): string {
  const cleaned = path
    .replace(/\.[cm]?tsx?$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned;
}

/** A slug for a Change id derived from the goal text. */
function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `change-${base || "goal"}`;
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isSnapshot(repo: readonly RepoFile[] | RepoSnapshot): repo is RepoSnapshot {
  return !Array.isArray(repo) && "sourceFiles" in (repo as RepoSnapshot);
}

/**
 * toolneed: recognize, from a decomposed Change alone, when the work needs a
 * capability the target repo lacks and a tool should be built for the agents.
 *
 * This is the agent-for-agent tooling trigger, and it is deliberately derived
 * from the SHAPE of the work, never from the goal string. The condition is a
 * structural property of the Change: when many WorkUnits must each make the
 * SAME mechanical edit across different files (a repeated, consistent change
 * fanned out over a surface), the sensible move is for one agent to build a
 * small tool (a codemod/scanner) once and the others to run it, rather than
 * every agent re-deriving the same edit by hand. The repo "lacks a capability"
 * precisely when the work repeats an identical mechanical transform enough times
 * that a reusable tool pays for itself.
 *
 * How it stays goal-agnostic (the anti-puppet contract)
 * -----------------------------------------------------
 * The analyzer reads only the Change: its WorkUnits, their declared paths, and a
 * generic per-unit "edit kind" tag (the action family the decomposer already
 * computes, carried on the unit, not re-derived from text here). It fires when:
 *
 *   1. a group of WorkUnits shares the same edit kind (the same mechanical
 *      transform), AND
 *   2. that group spans at least `minFanout` distinct files (so the transform is
 *      genuinely repeated across a surface, not a one-off), AND
 *   3. no WorkUnit in the Change already provides that capability (there is no
 *      existing tool unit), so building one is not redundant.
 *
 * A narrow, layered Change (a handful of distinct units doing different work,
 * such as a module + an api + a tests unit) does NOT satisfy (1)+(2): its units
 * do not share one repeated mechanical transform over many files, so no tool is
 * built. A wide fan-out (one unit per file, all applying the same transform)
 * does, so a tool is built once and consumed by the fanned-out units. The
 * difference is the structure of the work, not which goal produced it.
 *
 * Pure and deterministic: a Change always yields the same ToolRequirement (or
 * none). No I/O, no clock, no goal-string branching.
 */

import { entryWithin } from "./path-overlap.ts";
import type { Change, WorkUnit } from "./types.ts";

/**
 * A generic, repo-level edit kind carried on a WorkUnit so the tool-need
 * analyzer can group units by the mechanical transform they perform without
 * re-parsing the goal. It mirrors the decomposer's action family, kept as a
 * plain string so change-core does not depend on the goal module.
 */
export type EditKind = string;

/** The structural recommendation to build one tool for a group of WorkUnits. */
export interface ToolRequirement {
  /** The repeated edit kind the tool automates (e.g. "validate"). */
  readonly editKind: EditKind;
  /**
   * A stable id for the tool unit the engine should add, derived from the edit
   * kind so it is deterministic and legible (e.g. "tool-validate").
   */
  readonly toolUnitId: string;
  /** A stable id for the capability the tool provides, for consumption records. */
  readonly capability: string;
  /** The WorkUnit ids that will consume the tool (the fanned-out group). */
  readonly consumers: readonly string[];
  /** The distinct files the repeated transform spans (the fan-out surface). */
  readonly files: readonly string[];
  /** A short, human-readable reason, for the summary and the node label. */
  readonly reason: string;
}

/** Options governing when a tool is deemed worth building. */
export interface ToolNeedOptions {
  /**
   * The minimum number of distinct files the same transform must span before a
   * tool is built. Below this the repetition is not enough to justify a tool and
   * each unit just does its own edit. Defaults to 3.
   */
  readonly minFanout?: number;
  /**
   * How to read a WorkUnit's edit kind. Defaults to deriving it from the unit id
   * prefix the decomposer uses ("validate-foo" -> "validate"), which needs no
   * extra field on the Change. A caller with richer metadata may override it.
   */
  readonly editKindOf?: (unit: WorkUnit) => EditKind;
}

const DEFAULT_MIN_FANOUT = 3;

/**
 * The default edit-kind reader: the decomposer names a fanned-out unit
 * `<action>-<fileLabel>` (see decompose.ts `unitId`), so the action family is
 * the id prefix up to the first hyphen. This is a generic structural read of the
 * id the decomposer already produces, not a goal-string branch.
 */
export function defaultEditKindOf(unit: WorkUnit): EditKind {
  const idx = unit.id.indexOf("-");
  return idx === -1 ? unit.id : unit.id.slice(0, idx);
}

/**
 * Decide whether a Change needs one agent-built tool, and for whom. Returns the
 * single most-justified ToolRequirement (the largest qualifying fan-out), or
 * undefined when no group of units repeats one mechanical transform across
 * enough files. Exactly one tool is recommended for legibility, even if more
 * than one group would qualify, matching the design cut-list.
 */
export function detectToolRequirement(
  change: Change,
  options: ToolNeedOptions = {},
): ToolRequirement | undefined {
  const minFanout = options.minFanout ?? DEFAULT_MIN_FANOUT;
  const editKindOf = options.editKindOf ?? defaultEditKindOf;

  // A unit that itself provides a tool/structural capability is not a consumer
  // and must not be grouped as repeated content work.
  const contentUnits = change.work.filter((unit) => !isStructuralUnit(unit));

  // Group units by the mechanical transform (edit kind) they perform.
  const groups = new Map<EditKind, WorkUnit[]>();
  for (const unit of contentUnits) {
    const kind = editKindOf(unit);
    const list = groups.get(kind) ?? [];
    list.push(unit);
    groups.set(kind, list);
  }

  let best: ToolRequirement | undefined;
  let bestFanout = 0;
  for (const [editKind, units] of groups) {
    if (units.length < 2) {
      // A single unit is not a repeated transform: no tool pays for itself.
      continue;
    }
    const files = distinctConcreteFiles(units);
    if (files.length < minFanout) {
      // The transform does not span enough of a surface to justify a tool.
      continue;
    }
    // Already provided? If any unit's id signals it builds this capability, the
    // tool exists and we do not add a second (redundancy guard).
    if (change.work.some((u) => u.id === toolUnitId(editKind))) {
      continue;
    }
    if (files.length > bestFanout) {
      bestFanout = files.length;
      best = {
        editKind,
        toolUnitId: toolUnitId(editKind),
        capability: capabilityId(editKind),
        consumers: units.map((u) => u.id),
        files,
        reason:
          `${units.length} WorkUnits apply the same "${editKind}" transform across ` +
          `${files.length} files; one agent builds a ${editKind} codemod the others run`,
      };
    }
  }
  return best;
}

/** The deterministic tool unit id for an edit kind. */
export function toolUnitId(editKind: EditKind): string {
  return `tool-${editKind}`;
}

/** The deterministic capability id a tool provides, for consumption records. */
export function capabilityId(editKind: EditKind): string {
  return `codemod:${editKind}`;
}

/** A unit is structural when it wires, tests, or is itself a tool builder. */
function isStructuralUnit(unit: WorkUnit): boolean {
  return (
    unit.id === "tests" ||
    unit.id.startsWith("wire-") ||
    unit.id.startsWith("tool-")
  );
}

/**
 * The distinct concrete (non-glob) files a group of units declares. A fanned-out
 * universal decomposition declares one exact file per unit, which is exactly the
 * surface a codemod would sweep; directory globs are not counted as a concrete
 * fan-out file (they are whole-module work, not a repeated per-file transform).
 */
function distinctConcreteFiles(units: readonly WorkUnit[]): readonly string[] {
  const files = new Set<string>();
  for (const unit of units) {
    for (const path of unit.paths) {
      if (!/[*?]/.test(path)) {
        files.add(path);
      }
    }
  }
  return [...files].sort();
}

// ---------------------------------------------------------------------------
// The same structural rule over a board's items (agents decide; this only
// tells them when a tool pays for itself)
// ---------------------------------------------------------------------------

/** One board item as the board-level rule reads it. */
export interface BoardToolNeedItem {
  readonly item: string;
  readonly scopeHint: readonly string[];
  readonly status: string;
  /** The item's objective (compared with its siblings' after removing its own scope and id words). */
  readonly objective?: string;
  /** A tool item (it builds a tool) or an item proposed from a tool's findings: never grouped. */
  readonly tool?: boolean;
}

/** A repeated mechanical change across a board's items, and the scope a tool for it would cover. */
export interface BoardToolNeed {
  /** A short name for the shared change (the id prefix, or the leading words the objectives share). */
  readonly editKind: string;
  /** Which signal grouped them: a shared id prefix, or near-identical objectives over sibling files. */
  readonly signal: "id-prefix" | "objective";
  /** The items applying it (still outstanding). */
  readonly items: readonly string[];
  /** The distinct existing, unprotected files their scopes cover. */
  readonly files: readonly string[];
  /** The union of their scope hints: the tool's intended inputs. */
  readonly scope: readonly string[];
  /** Deterministic tool capabilities for it: a scanner (find every place) and a codemod (apply the change). */
  readonly scanner: string;
  readonly codemod: string;
}

const OUTSTANDING: ReadonlySet<string> = new Set(["open", "claimed", "contested"]);

/** Objectives at least this similar (token Jaccard, after removing each item's own words) are one change. */
export const OBJECTIVE_SIMILARITY = 0.7;
/**
 * Or: the overlap coefficient |A∩B| / min(|A|, |B|) of the full objectives'
 * words at least this (a planner adds item-specific detail after an identical
 * lead), when both have at least OVERLAP_MIN_WORDS words.
 */
export const OBJECTIVE_OVERLAP = 0.6;
export const OVERLAP_MIN_WORDS = 3;

/** A capability id from free parts: lower-case, [a-z0-9._-], at most 64 characters. */
export function toolCapabilityFor(prefix: string, editKind: string): string {
  const slug = `${prefix}-${editKind}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-._]+$/, "");
  return slug === "" ? prefix : slug;
}

/** Lower-case word tokens of a text (letters and digits). */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}

/**
 * An objective's words with the item's OWN words removed: its scope's path
 * tokens (directories, file names, extensions), its id's tokens, numbers, and
 * words of fewer than three letters. What remains is the change itself.
 */
export function objectiveChangeWords(item: Pick<BoardToolNeedItem, "item" | "scopeHint" | "objective">, part: "all" | "first" = "all"): string[] {
  const own = new Set([...item.scopeHint.flatMap(tokens), ...tokens(item.item)]);
  // The first sentence or clause: split on . ; : that END a phrase (not the dot in "auth.js").
  const text = part === "first" ? (item.objective ?? "").split(/[.;:](?:\s|$)/)[0] ?? "" : item.objective ?? "";
  const out: string[] = [];
  for (const t of tokens(text)) {
    if (t.length < 3 || /^\d+$/.test(t) || own.has(t) || out.includes(t)) {
      continue;
    }
    out.push(t);
  }
  return out;
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length < OVERLAP_MIN_WORDS || b.length < OVERLAP_MIN_WORDS) {
    return 0;
  }
  const sb = new Set(b);
  return a.filter((t) => sb.has(t)).length / Math.min(a.length, b.length);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const sb = new Set(b);
  const shared = a.filter((t) => sb.has(t)).length;
  return shared / (new Set([...a, ...b]).size);
}

/** The literal (wildcard-free) path of a scope entry's first segments. */
function literalPath(entry: string): string {
  const out: string[] = [];
  for (const seg of entry.split("#")[0]!.split("/")) {
    if (seg === "" || /[*?]/.test(seg)) {
      break;
    }
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Where an item works, for the sibling rule: the parent directory of its
 * first concrete scope file (a glob's literal directory), and the file's
 * "pattern" (its name in a sibling directory: `<grandparent>/*\/<name>`).
 */
function siblingKeys(item: BoardToolNeedItem): string[] {
  const first = item.scopeHint[0];
  if (first === undefined) {
    return [];
  }
  const literal = literalPath(first);
  const concrete = !/[*?]/.test(first);
  const parts = literal === "" ? [] : literal.split("/");
  if (!concrete) {
    return [`dir:${parts.join("/")}`];
  }
  const keys = [`dir:${parts.slice(0, -1).join("/")}`];
  if (parts.length >= 2) {
    keys.push(`pattern:${parts.slice(0, -2).join("/")}/*/${parts.at(-1)}`);
  }
  return keys;
}

/**
 * The board form of the structural trigger, from two goal-agnostic signals:
 *   - a shared id prefix (the decomposer names a fanned-out action
 *     `<action>-<file>`), as before;
 *   - near-identical objectives over sibling files: after removing each
 *     item's own words (its scope's path tokens, its id's tokens, numbers),
 *     the objectives' first clauses have token Jaccard of at least
 *     OBJECTIVE_SIMILARITY, or the full objectives an overlap coefficient of
 *     at least OBJECTIVE_OVERLAP (an identical lead, item-specific tails), and the
 *     items' scopes are siblings (the same parent directory, or the same file
 *     name in sibling directories). A planner that numbers or names its items
 *     freely (`u1-auth-resource`, `u2-notifications-resource`) still groups.
 * A group needs at least two OUTSTANDING items whose scopes cover at least
 * `minFanout` distinct existing, unprotected files. The largest group wins
 * (an id-prefix group on a tie). Pure: ids, scopes, objectives, and the file
 * listing; never a goal-specific word.
 */
export function detectBoardToolNeed(
  items: readonly BoardToolNeedItem[],
  files: readonly string[],
  options: { readonly minFanout?: number; readonly protected?: readonly string[] } = {},
): BoardToolNeed | undefined {
  const minFanout = options.minFanout ?? DEFAULT_MIN_FANOUT;
  const guarded = options.protected ?? [];
  const candidates = items.filter((i) => !i.tool && OUTSTANDING.has(i.status));

  const groups: { readonly editKind: string; readonly signal: BoardToolNeed["signal"]; readonly members: BoardToolNeedItem[] }[] = [];
  // Signal 1: a shared id prefix.
  const byPrefix = new Map<string, BoardToolNeedItem[]>();
  for (const item of candidates.filter((i) => i.item.includes("-"))) {
    const kind = item.item.slice(0, item.item.indexOf("-"));
    byPrefix.set(kind, [...(byPrefix.get(kind) ?? []), item]);
  }
  for (const [editKind, members] of [...byPrefix.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    groups.push({ editKind, signal: "id-prefix", members });
  }
  // Signal 2: near-identical objectives over sibling files (greedy, in item order, per sibling key).
  const words = new Map(candidates.map((i) => [i.item, objectiveChangeWords(i)]));
  const firsts = new Map(candidates.map((i) => [i.item, objectiveChangeWords(i, "first")]));
  // One change: the first clauses nearly identical, or the full objectives overlapping strongly.
  const similar = (a: string, b: string): boolean =>
    jaccard(firsts.get(a)!, firsts.get(b)!) >= OBJECTIVE_SIMILARITY || overlap(words.get(a)!, words.get(b)!) >= OBJECTIVE_OVERLAP;
  const byKey = new Map<string, BoardToolNeedItem[]>();
  for (const item of candidates.filter((i) => (words.get(i.item) ?? []).length > 0)) {
    for (const key of siblingKeys(item)) {
      byKey.set(key, [...(byKey.get(key) ?? []), item]);
    }
  }
  for (const [, siblings] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const left = [...siblings];
    while (left.length > 0) {
      const seed = left.shift()!;
      const seedWords = words.get(seed.item)!;
      const members = [seed, ...left.filter((i) => similar(seed.item, i.item))];
      for (const m of members.slice(1)) {
        left.splice(left.indexOf(m), 1);
      }
      if (members.length >= 2) {
        // The words every member shares (the first clause first), in the seed's order, name the change.
        const firstShared = firsts.get(seed.item)!.filter((w) => members.every((m) => words.get(m.item)!.includes(w)));
        const shared = firstShared.length > 0 ? firstShared : seedWords.filter((w) => members.every((m) => words.get(m.item)!.includes(w)));
        groups.push({ editKind: shared.slice(0, 2).join("-") || "change", signal: "objective", members });
      }
    }
  }

  let best: BoardToolNeed | undefined;
  for (const group of groups) {
    if (group.members.length < 2) {
      continue;
    }
    const scope = [...new Set(group.members.flatMap((i) => i.scopeHint))];
    const covered = files.filter(
      (f) => scope.some((entry) => entryWithin(f, entry)) && !guarded.some((p) => entryWithin(f, p) || f === p),
    );
    if (covered.length < minFanout || (best !== undefined && covered.length <= best.files.length)) {
      continue;
    }
    best = {
      editKind: group.editKind,
      signal: group.signal,
      items: group.members.map((i) => i.item),
      files: [...covered].sort(),
      scope,
      scanner: toolCapabilityFor("scan", group.editKind),
      codemod: toolCapabilityFor("codemod", group.editKind),
    };
  }
  return best;
}

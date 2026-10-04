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

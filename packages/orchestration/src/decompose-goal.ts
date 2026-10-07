/**
 * decompose-goal: the Node-side driver that turns a goal plus a target project
 * directory into a Change, prints the resulting WorkGraph (plan + schedule), and
 * can hand the Change straight into the offline run loop.
 *
 * It scans the project with scanRepoFiles, calls the pure change-core decomposer
 * (deterministic by default: the heuristic analyzer, no live inference), and
 * reuses describeChange/formatChangePlan so the printed plan is the same format
 * the hand-authored YAML path produces. The YAML Change therefore remains a
 * valid alternate input to exactly the same type and schedule, and the goal is
 * the new default input.
 */

import {
  buildWorkGraph,
  decompose,
  planGoal,
  type Change,
  type DecomposeResult,
  type GoalAnalyzer,
  type PlanTransport,
  type RecordedPlan,
  type WorkGraph,
} from "@switchyard-change/change-core";

import { scanRepoFiles } from "./scan-repo.ts";
import { describeChange } from "./run-change.ts";
import { formatChangePlan } from "./summary.ts";

/** Options for decomposing a goal against a project directory. */
export interface DecomposeGoalOptions {
  /** The human-stated goal text. */
  readonly goal: string;
  /** Absolute path to the target project directory to scan and reason over. */
  readonly projectDir: string;
  /** An optional injected analyzer; defaults to the deterministic heuristic. */
  readonly analyzer?: GoalAnalyzer;
  /** An optional stable Change id override. */
  readonly changeId?: string;
  /**
   * An optional inference-backed, schema-constrained planner. When present AND
   * live (an injected plan transport plus a base model), decomposition is
   * goal-driven: the planner decides the in-scope modules, each unit objective,
   * the agent count, and the dependency order within the real structural
   * backbone, with a bounded escalation ladder and a fall-back to the heuristic
   * on an invalid/unusable plan. When absent (the default, offline/noop path),
   * the deterministic heuristic `decompose` is used, so `make check`, the demo,
   * and the anti-puppet substrate stay deterministic and offline.
   */
  readonly planner?: PlannerInjection;
}

/**
 * The injected planner: the plan transport plus the ordered model ladder it
 * escalates through. The caller (the CLI) builds this from `selectPlanner` only
 * when inference is configured, so a bare `decomposeGoal` call stays on the
 * deterministic heuristic path.
 */
export interface PlannerInjection {
  readonly plan: PlanTransport;
  readonly baseModel: string;
  readonly escalationModels?: readonly string[];
}

/** The outcome of decomposing a goal: the Change, its graph, and the intent. */
export interface DecomposeGoalResult extends DecomposeResult {
  readonly graph: WorkGraph;
  /**
   * The recorded plan that drove the Change, present when the inference planner
   * ran (planner or heuristic-fallback). Absent on the plain heuristic path (no
   * planner injected), where the Change is the deterministic decomposition and
   * there is no separate plan record. A caller that wants a planner graph node
   * backs it with this record.
   */
  readonly plan?: RecordedPlan;
}

/**
 * Decompose a goal against a project directory on disk. Scans the project into a
 * file list, then either runs the inference-backed schema-constrained planner
 * (when a live planner is injected) or the pure deterministic decomposer (the
 * default). The planner honors the structural backbone, so single-writer
 * ownership and the frozen contracts are preserved either way; the planned
 * Change round-trips through the spec YAML exactly like the heuristic Change.
 */
export async function decomposeGoal(options: DecomposeGoalOptions): Promise<DecomposeGoalResult> {
  const files = await scanRepoFiles(options.projectDir);
  if (options.planner) {
    const planned = await planGoal({
      goal: options.goal,
      repo: files,
      plan: options.planner.plan,
      baseModel: options.planner.baseModel,
      ...(options.planner.escalationModels
        ? { escalationModels: options.planner.escalationModels }
        : {}),
      ...(options.changeId ? { changeId: options.changeId } : {}),
    });
    return { ...planned, graph: buildWorkGraph(planned.change) };
  }
  const result = decompose({
    goal: options.goal,
    repo: files,
    analyzer: options.analyzer,
    changeId: options.changeId,
  });
  return { ...result, graph: buildWorkGraph(result.change) };
}

/**
 * Render a decomposition as a readable report: the derived intent (so the
 * goal-agnostic features are visible), followed by the standard Change plan and
 * schedule used everywhere else.
 */
export function formatDecomposition(result: DecomposeGoalResult): string {
  const lines: string[] = [];
  const { intent, change, graph } = result;

  lines.push(`Goal: ${intent.text}`);
  lines.push("");
  lines.push("Derived intent (goal-agnostic features the engine keyed on):");
  lines.push(`  actions:   ${intent.actions.join(", ")}`);
  lines.push(`  targets:   ${intent.targets.join(", ") || "(none)"}`);
  lines.push(`  universal: ${intent.isUniversal ? "yes (fan out per file)" : "no"}`);
  lines.push("");
  lines.push(
    `WorkGraph: ${graph.nodes.length} unit(s), ${graph.edges.length} dependency edge(s)`,
  );
  lines.push("");

  const { waves } = describeChange(changeToSpecYaml(change));
  lines.push(formatChangePlan(change, waves));
  return lines.join("\n");
}

/**
 * Serialize a Change back to the YAML spec shape the loader expects. This keeps
 * a single scheduling and run path (the YAML loader feeding runChange and
 * describeChange) for both the hand-authored and the decomposed inputs, so a
 * decomposed goal runs through exactly the same loop as a hand-authored Change
 * and there is no second code path to drift.
 */
export function changeToSpecYaml(change: Change): string {
  const lines: string[] = [];
  lines.push(`id: ${change.id}`);
  lines.push(`objective: ${quote(change.objective)}`);
  lines.push(`baseline: ${change.baseline}`);
  lines.push(`budget_usd: ${change.budgetUsd}`);
  lines.push(`assurance: ${change.assurance}`);
  lines.push("work:");
  for (const unit of change.work) {
    lines.push(`  - id: ${unit.id}`);
    lines.push(`    objective: ${quote(unit.objective)}`);
    if (unit.dependsOn.length > 0) {
      lines.push("    depends_on:");
      for (const dep of unit.dependsOn) {
        lines.push(`      - ${dep}`);
      }
    }
    lines.push("    paths:");
    for (const path of unit.paths) {
      lines.push(`      - ${quote(path)}`);
    }
  }
  // Serialize the cohesion blueprint when the Change carries one, so the frozen
  // read-only contracts and the module ownership survive the spec round-trip to
  // the Worker (which reconstructs the Change from this YAML). Without this the
  // Worker-side Change would have no blueprint, so the live run's frozen-contract
  // list would be empty and the agents would never be told which files are the
  // frozen read-only seams. The loader parses these keys back into the blueprint.
  if (change.blueprint) {
    const { modules, contracts } = change.blueprint;
    lines.push("blueprint:");
    if (modules.length > 0) {
      lines.push("  modules:");
      for (const module of modules) {
        lines.push(`    - unit_id: ${quote(module.unitId)}`);
        if (module.paths.length > 0) {
          lines.push("      paths:");
          for (const path of module.paths) {
            lines.push(`        - ${quote(path)}`);
          }
        }
        if (module.dependsOn.length > 0) {
          lines.push("      depends_on:");
          for (const dep of module.dependsOn) {
            lines.push(`        - ${quote(dep)}`);
          }
        }
        if (module.exports.length > 0) {
          // The module's exported interface rides the spec round-trip so the
          // Worker-reconstructed Change can tell the owning unit's agent to keep
          // these exports present. Omitted when the module exports nothing.
          lines.push("      exports:");
          for (const name of module.exports) {
            lines.push(`        - ${quote(name)}`);
          }
        }
      }
    }
    if (contracts.length > 0) {
      lines.push("  contracts:");
      for (const contract of contracts) {
        lines.push(`    - path: ${quote(contract.path)}`);
        lines.push(`      imported_by_count: ${contract.importedByCount}`);
      }
    }
  }
  // Serialize the recorded plan when the Change carries one, so the planner pass
  // provenance (how the Change was decomposed) survives the spec round-trip to
  // the Worker. The loader parses this `plan:` block back into Change.plan, and
  // the live/offline state views expose it so the graph projection can root a
  // real `planner` node (goal -> planner -> agents). Absent on the plain
  // heuristic path, so that path emits no `plan:` block and renders no planner
  // node, exactly as before.
  if (change.plan) {
    const { source, model, units, contracts } = change.plan;
    lines.push("plan:");
    lines.push(`  source: ${quote(source)}`);
    lines.push(`  model: ${quote(model)}`);
    // The prompt summary and rationale ride the round-trip so the Worker-side
    // Change carries them and the console's planner detail panel can show what
    // the planner was asked and why it decomposed as it did. Both are optional
    // and empty-safe: omitted when the plan has none, so a plan without them
    // still round-trips and validates.
    if (change.plan.promptSummary) {
      lines.push(`  prompt_summary: ${quote(change.plan.promptSummary)}`);
    }
    if (change.plan.rationale) {
      lines.push(`  rationale: ${quote(change.plan.rationale)}`);
    }
    if (units.length > 0) {
      lines.push("  units:");
      for (const unit of units) {
        lines.push(`    - id: ${quote(unit.id)}`);
        lines.push(`      objective: ${quote(unit.objective)}`);
        if (unit.dependsOn.length > 0) {
          lines.push("      depends_on:");
          for (const dep of unit.dependsOn) {
            lines.push(`        - ${quote(dep)}`);
          }
        }
        if (unit.paths.length > 0) {
          lines.push("      paths:");
          for (const path of unit.paths) {
            lines.push(`        - ${quote(path)}`);
          }
        }
      }
    }
    if (contracts.length > 0) {
      lines.push("  contracts:");
      for (const contract of contracts) {
        lines.push(`    - ${quote(contract)}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Double-quote a YAML scalar, escaping embedded quotes and backslashes, plus the
 * control characters (newline, carriage return, tab) that would otherwise fold
 * or corrupt a multi-line value in a double-quoted YAML scalar. Single-line
 * values are unaffected; a multi-line value (the plan's prompt summary) survives
 * the round-trip because the parser decodes `\n` back to a real newline.
 */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

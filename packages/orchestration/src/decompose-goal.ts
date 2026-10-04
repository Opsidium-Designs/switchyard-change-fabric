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
  type Change,
  type DecomposeResult,
  type GoalAnalyzer,
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
}

/** The outcome of decomposing a goal: the Change, its graph, and the intent. */
export interface DecomposeGoalResult extends DecomposeResult {
  readonly graph: WorkGraph;
}

/**
 * Decompose a goal against a project directory on disk. Scans the project into a
 * file list, then calls the pure decomposer. Deterministic given the default
 * analyzer.
 */
export async function decomposeGoal(options: DecomposeGoalOptions): Promise<DecomposeGoalResult> {
  const files = await scanRepoFiles(options.projectDir);
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
  return lines.join("\n");
}

/** Double-quote a YAML scalar, escaping embedded quotes and backslashes. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

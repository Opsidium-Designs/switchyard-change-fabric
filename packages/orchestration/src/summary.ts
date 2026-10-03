/**
 * summary: render a RunChangeResult (or a live state view) as a readable,
 * plain-text report for the console and the CLI.
 *
 * The report tells the coordination story: which WorkUnits ran and in what
 * order, each unit's verification verdict, how a contested path was coordinated,
 * the cost against budget, and the promoted local Git commit. It is pure text
 * with no color codes, so it reads the same in a terminal, a log, or a test
 * assertion.
 */

import type { Change } from "@switchyard-change/change-core";

import type { ChangeStateView } from "./local-control.ts";
import type { RunChangeResult } from "./run-change.ts";

/** Render the full end-to-end run as a readable report. */
export function formatRunSummary(result: RunChangeResult): string {
  const lines: string[] = [];
  const inference = result.executor === "noop" ? "zero inference" : `executor ${result.executor}`;

  lines.push(`Change ${result.changeId}: ${result.objective}`);
  lines.push(
    `Mode: ${result.offline ? "offline local fallback" : "cloudflare"} (${inference})`,
  );
  lines.push("");

  lines.push("WorkUnits (in run order):");
  let waveNo = 0;
  for (const wave of result.waves) {
    waveNo += 1;
    const concurrency = wave.length > 1 ? ` (ran concurrently, ${wave.length} units)` : "";
    lines.push(`  Wave ${waveNo}: ${wave.join(", ")}${concurrency}`);
  }
  lines.push("");

  for (const unit of result.units) {
    const verdict = result.evidence.units.find((u) => u.unitId === unit.unitId)?.verdict ?? "unknown";
    const commit = unit.commit === "" ? "(no change)" : short(unit.commit);
    const paths = unit.changedPaths.length > 0 ? unit.changedPaths.join(", ") : "(none)";
    lines.push(`  - ${unit.unitId}: ${verdict}`);
    lines.push(`      objective: ${unit.objective}`);
    lines.push(`      workspace: ${unit.workspaceName} [${unit.backend}]`);
    lines.push(`      commit:    ${commit}`);
    lines.push(`      changed:   ${paths}`);
  }
  lines.push("");

  // Conflict coordination.
  const coord = result.evidence.coordination;
  if (coord && coord.decisions.length > 0) {
    lines.push("Conflict coordination:");
    for (const d of coord.decisions) {
      if (d.resolution === "serialized") {
        lines.push(
          `  - ${d.path}: write lease to ${d.owner ?? "(none)"}, ` +
            `${d.waiters.length > 0 ? `${d.waiters.join(", ")} waited` : "no waiters"} ` +
            "(single writer, no silent merge)",
        );
      } else {
        lines.push(`  - ${d.path}: flagged for attention (${d.reason})`);
      }
    }
    if (coord.needsAttention) {
      lines.push("  Note: at least one contested path needs human attention.");
    }
    lines.push("");
  } else {
    lines.push("Conflict coordination: no declared path collisions.");
    lines.push("");
  }

  // Integration + verification.
  const integration = result.evidence.integration;
  lines.push("Verification + integration:");
  lines.push(`  Integration verdict: ${integration.verdict}`);
  lines.push(
    `  Integrated units:    ${[...integration.integratedUnits].join(", ") || "(none)"}`,
  );
  if (integration.excludedUnits.length > 0) {
    lines.push(`  Excluded units:      ${[...integration.excludedUnits].join(", ")}`);
  }
  lines.push(`  Final check:         ${integration.finalCheck.summary}`);
  lines.push("");

  // Cost against budget.
  lines.push(
    `Cost: $${result.spentUsd.toFixed(2)} spent of $${result.budgetUsd.toFixed(2)} budget`,
  );
  lines.push("");

  // Promotion result.
  const p = result.promotion;
  if (p.committed) {
    lines.push("Promoted to local Git:");
    lines.push(`  branch: ${p.branch}`);
    lines.push(`  commit: ${short(p.commit)}`);
    lines.push(`  repo:   ${result.sourceRepoDir}`);
    lines.push(`  files:  ${p.deliveredPaths.length} delivered`);
  } else {
    lines.push("Promotion: nothing to promote (no changes).");
  }
  lines.push("");

  lines.push(`Cleanup: archived ${result.cleanup.archived.length} workspace(s).`);
  if (result.cleanup.failed.length > 0) {
    lines.push(`  Failed to archive: ${result.cleanup.failed.map((f) => f.name).join(", ")}`);
  }

  return lines.join("\n");
}

/** Render a Change's declared plan (no run) as a readable report, for status. */
export function formatChangePlan(change: Change, waves: readonly (readonly string[])[]): string {
  const lines: string[] = [];
  lines.push(`Change ${change.id}: ${change.objective}`);
  lines.push(`  baseline: ${change.baseline}`);
  lines.push(`  budget:   $${change.budgetUsd.toFixed(2)}`);
  lines.push(`  assurance: ${change.assurance}`);
  lines.push("");
  lines.push("Planned WorkUnits (schedule order):");
  let waveNo = 0;
  for (const wave of waves) {
    waveNo += 1;
    lines.push(`  Wave ${waveNo}: ${wave.join(", ")}`);
  }
  lines.push("");
  lines.push("WorkUnits:");
  for (const unit of change.work) {
    const deps = unit.dependsOn.length > 0 ? ` (depends on: ${unit.dependsOn.join(", ")})` : "";
    lines.push(`  - ${unit.id}: ${unit.objective}${deps}`);
    lines.push(`      paths: ${unit.paths.join(", ") || "(none)"}`);
  }
  return lines.join("\n");
}

/** Render a live state view (as `status` prints after a run started). */
export function formatStateView(state: ChangeStateView): string {
  const lines: string[] = [];
  lines.push(`Change ${state.id}: ${state.objective}`);
  lines.push(`  spent $${state.spentUsd.toFixed(2)} of $${state.budgetUsd.toFixed(2)} budget`);
  lines.push("");
  lines.push("WorkUnits:");
  for (const unit of state.work) {
    lines.push(`  - ${unit.id}: ${unit.status}${unit.leased ? " (leased)" : ""}`);
  }
  if (state.collisions.length > 0) {
    lines.push("");
    lines.push("Declared path collisions:");
    for (const c of state.collisions) {
      lines.push(`  - ${c.path}: ${c.unitIds.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function short(commit: string): string {
  return commit.length >= 10 ? commit.slice(0, 10) : commit;
}

/**
 * tool-smoke: build one agent tool with the region filler and run its OWN gate,
 * without a board run, so the reliability of model-built tools can be measured
 * cheaply (`make tool-smoke`, opt-in, live; never part of `make check`).
 *
 * Each attempt writes the runtime's skeleton into a private scratch worktree,
 * asks the filler for its regions exactly as a board build does
 * (`regionToolAuthor`), and runs `runToolGate` on a fresh copy of the project
 * (the same checks, the same strictness, as on a board). With `rebuilds`, a
 * failing build is rebuilt with its gate evidence, as the board's fix flow
 * does. Nothing is pushed, published, or recorded anywhere.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolKind } from "@switchyard-change/change-core";
import type { ToolRegionFiller } from "@switchyard-change/model-adapters";
import { materializeToolTree, runToolGate, type ToolGateCheck } from "@switchyard-change/verification";

import { regionToolAuthor } from "./board-tools.ts";

/** Options for a tool smoke run. */
export interface ToolSmokeOptions {
  readonly filler: ToolRegionFiller;
  /** The project the tool acts on (copied; never written). */
  readonly projectDir: string;
  readonly goal: string;
  readonly capability: string;
  readonly kind: ToolKind;
  /** The tool's declared inputs (repo-relative paths or globs). */
  readonly inputs: readonly string[];
  /** Independent attempts (default 1). */
  readonly attempts?: number;
  /** Rebuilds per attempt after a failing gate, with its evidence (default 0: first-build reliability). */
  readonly rebuilds?: number;
  /** Where the private scratch root is made (default: the OS temp dir). */
  readonly scratchParent?: string;
  /** Called after every build's gate. */
  readonly onBuild?: (attempt: number, build: number, result: ToolSmokeBuild) => void;
}

/** One build's outcome. */
export interface ToolSmokeBuild {
  readonly passed: boolean;
  readonly checks: readonly ToolGateCheck[];
  /** Files the tool changed on the baseline (a codemod's). */
  readonly changed: readonly string[];
  /** The failing gate's bounded output, or why the build could not be made. */
  readonly output: string;
  /** Set when the build itself failed (a filler or splice error) before any gate ran. */
  readonly error?: string;
}

/** One attempt: its builds, and whether any passed. */
export interface ToolSmokeAttempt {
  readonly attempt: number;
  readonly passed: boolean;
  readonly builds: readonly ToolSmokeBuild[];
}

/** Build the tool and gate it, `attempts` times (each from a fresh skeleton). */
export async function runToolSmoke(options: ToolSmokeOptions): Promise<ToolSmokeAttempt[]> {
  const author = regionToolAuthor(options.filler);
  const out: ToolSmokeAttempt[] = [];
  const attempts = Math.max(1, options.attempts ?? 1);
  const rebuilds = Math.max(0, options.rebuilds ?? 0);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const root = await mkdtemp(join(options.scratchParent ?? tmpdir(), "scf-toolsmoke-"));
    const builds: ToolSmokeBuild[] = [];
    try {
      const baseline = join(root, "baseline");
      await materializeToolTree([options.projectDir], baseline);
      const worktree = join(root, "tools");
      await mkdir(worktree, { recursive: true });
      let gateFailure: string | undefined;
      for (let build = 1; build <= 1 + rebuilds; build += 1) {
        let result: ToolSmokeBuild;
        try {
          await author({
            agent: "smoke",
            capability: options.capability,
            kind: options.kind,
            inputs: options.inputs,
            outputs: [],
            worktreeDir: worktree,
            projectDir: baseline,
            goal: options.goal,
            ...(gateFailure !== undefined ? { gateFailure } : {}),
          });
          const scratch = join(root, `gate-${build}`);
          await mkdir(scratch, { recursive: true });
          const gate = await runToolGate({
            toolCheckoutDir: worktree,
            capability: options.capability,
            kind: options.kind,
            inputs: options.inputs,
            baselineDir: baseline,
            scratchParent: scratch,
          });
          result = { passed: gate.passed, checks: gate.checks, changed: gate.changed, output: gate.output };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result = { passed: false, checks: [], changed: [], output: message, error: message };
        }
        builds.push(result);
        options.onBuild?.(attempt, build, result);
        if (result.passed) {
          break;
        }
        // The next build sees exactly what failed, as on a board.
        const failed = result.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`);
        gateFailure = [...failed, result.output].filter((l) => l !== "").join("\n").slice(0, 4000);
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    out.push({ attempt, passed: builds.some((b) => b.passed), builds });
  }
  return out;
}

/** One line per build, for a terminal. */
export function formatToolSmokeBuild(attempt: number, build: number, result: ToolSmokeBuild): string {
  const checks = result.checks.map((c) => `${c.check} ${c.passed ? "ok" : "FAIL"}`).join(", ");
  const head = `  attempt ${attempt} build ${build}: ${result.passed ? "PASS" : "FAIL"}`;
  if (result.error !== undefined) {
    return `${head} (the build could not be made: ${result.error.slice(0, 300)})`;
  }
  const changed = result.changed.length > 0 ? `; changed ${result.changed.join(", ")}` : "";
  const why = result.passed ? "" : `\n${result.output.split("\n").slice(0, 12).map((l) => `      ${l.slice(0, 240)}`).join("\n")}`;
  return `${head} (${checks})${changed}${why}`;
}

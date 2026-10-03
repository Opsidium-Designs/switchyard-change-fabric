/**
 * The VerificationProvider: deterministic verification of one WorkUnit's result.
 *
 * Given a workspace checkout (a cloned, pushed WorkUnit workspace) plus a
 * verification contract, it runs four checks in a fixed order and returns typed
 * evidence:
 *
 *   1. clean-state: the required files are present and the worktree has no
 *      uncommitted junk (the runner should have committed everything it wrote).
 *   2. path-scope:  every file the WorkUnit changed since the baseline is inside
 *      the WorkUnit's declared path globs.
 *   3. test:        the configured test command exits zero (skipped if none).
 *   4. lint:        the configured lint/static command exits zero (skipped if
 *      none).
 *
 * The verdict is "verified" only when every non-skipped check passed. Nothing
 * here calls a model, so a given checkout and contract always produce the same
 * evidence.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  ChildProcessCommandRunner,
  boundOutput,
  type CommandOutcome,
  type CommandRunner,
} from "./command.ts";
import { changedPathsSinceBaseline, hasChanges } from "./git.ts";
import { partitionByScope } from "./pathscope.ts";
import type {
  CheckKind,
  CheckResult,
  OutputRef,
  VerificationContract,
  Verdict,
  WorkUnitVerification,
} from "./types.ts";

/** Inputs for verifying one WorkUnit checkout. */
export interface VerifyOptions {
  /** Absolute path to the cloned WorkUnit workspace checkout. */
  readonly worktreeDir: string;
  /** The Git ref the workspace was seeded from (used to derive changed paths). */
  readonly baselineRef: string;
  /** What the WorkUnit must satisfy. */
  readonly contract: VerificationContract;
}

/** Options for constructing the verifier. */
export interface VerificationProviderOptions {
  /** Injectable command runner (defaults to a real child-process runner). */
  readonly commandRunner?: CommandRunner;
}

export class VerificationProvider {
  private readonly commandRunner: CommandRunner;

  constructor(options: VerificationProviderOptions = {}) {
    this.commandRunner = options.commandRunner ?? new ChildProcessCommandRunner();
  }

  /** Verify one WorkUnit checkout and return its typed evidence. */
  async verify(options: VerifyOptions): Promise<WorkUnitVerification> {
    const { worktreeDir, baselineRef, contract } = options;

    const cleanState = await this.checkCleanState(worktreeDir, contract);
    const pathScope = await this.checkPathScope(worktreeDir, baselineRef, contract);
    const test = await this.checkCommand("test", contract.testCommand, worktreeDir);
    const lint = await this.checkCommand("lint", contract.lintCommand, worktreeDir);

    const checks: readonly CheckResult[] = [cleanState, pathScope, test, lint];
    const verdict: Verdict = checks.every((c) => c.skipped || c.passed) ? "verified" : "failed";
    return { unitId: contract.unitId, verdict, checks };
  }

  /**
   * clean-state: every expected file exists and the worktree is committed (no
   * uncommitted changes left behind by the runner).
   */
  private async checkCleanState(
    worktreeDir: string,
    contract: VerificationContract,
  ): Promise<CheckResult> {
    const missing: string[] = [];
    for (const rel of contract.expectedFiles ?? []) {
      if (!(await fileExists(join(worktreeDir, rel)))) {
        missing.push(rel);
      }
    }

    let dirty = false;
    try {
      dirty = await hasChanges(worktreeDir);
    } catch (error) {
      return failed(
        "clean-state",
        `could not inspect worktree state: ${messageOf(error)}`,
        [{ stream: "summary", text: messageOf(error) }],
      );
    }

    if (missing.length > 0 || dirty) {
      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(`missing expected files: ${missing.join(", ")}`);
      }
      if (dirty) {
        parts.push("worktree has uncommitted changes");
      }
      return failed("clean-state", parts.join("; "), [
        { stream: "summary", text: parts.join("; ") },
      ]);
    }
    return passed("clean-state", "required files present and worktree committed");
  }

  /**
   * path-scope: every changed path is inside the declared globs. Prefers the
   * runner-reported changed paths; otherwise derives them from Git.
   */
  private async checkPathScope(
    worktreeDir: string,
    baselineRef: string,
    contract: VerificationContract,
  ): Promise<CheckResult> {
    let changed: readonly string[];
    if (contract.changedPaths) {
      changed = contract.changedPaths;
    } else {
      try {
        changed = await changedPathsSinceBaseline(worktreeDir, baselineRef);
      } catch (error) {
        return failed("path-scope", `could not derive changed paths: ${messageOf(error)}`, [
          { stream: "summary", text: messageOf(error) },
        ]);
      }
    }

    const { inScope, outOfScope } = partitionByScope(changed, contract.paths);
    if (outOfScope.length > 0) {
      return failed(
        "path-scope",
        `changed ${outOfScope.length} path(s) outside declared scope: ${outOfScope.join(", ")}`,
        [{ stream: "summary", text: `out of scope: ${outOfScope.join(", ")}` }],
      );
    }
    return passed(
      "path-scope",
      `all ${inScope.length} changed path(s) within declared scope`,
    );
  }

  /** Run a configured command check, or skip it when no command is configured. */
  private async checkCommand(
    kind: Extract<CheckKind, "test" | "lint">,
    argv: readonly string[] | undefined,
    worktreeDir: string,
  ): Promise<CheckResult> {
    if (!argv || argv.length === 0) {
      return skipped(kind, `no ${kind} command configured`);
    }
    let outcome: CommandOutcome;
    try {
      outcome = await this.commandRunner.run(argv, worktreeDir);
    } catch (error) {
      return failed(kind, `${kind} command could not run: ${messageOf(error)}`, [
        { stream: "summary", text: messageOf(error) },
      ]);
    }
    const outputs: OutputRef[] = [];
    if (outcome.stdout.trim() !== "") {
      outputs.push({ stream: "stdout", text: boundOutput(outcome.stdout) });
    }
    if (outcome.stderr.trim() !== "") {
      outputs.push({ stream: "stderr", text: boundOutput(outcome.stderr) });
    }
    if (outcome.code === 0) {
      return {
        kind,
        passed: true,
        skipped: false,
        summary: `${kind} command passed (exit 0)`,
        outputs,
      };
    }
    return {
      kind,
      passed: false,
      skipped: false,
      summary: `${kind} command failed (exit ${outcome.code ?? "none"})`,
      outputs,
    };
  }
}

function passed(kind: CheckKind, summary: string): CheckResult {
  return { kind, passed: true, skipped: false, summary, outputs: [] };
}

function failed(kind: CheckKind, summary: string, outputs: readonly OutputRef[]): CheckResult {
  return { kind, passed: false, skipped: false, summary, outputs };
}

function skipped(kind: CheckKind, summary: string): CheckResult {
  return { kind, passed: true, skipped: true, summary, outputs: [] };
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

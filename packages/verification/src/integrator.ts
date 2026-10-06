/**
 * Integration: combine verified WorkUnits into one workspace, then verify the
 * combined result.
 *
 * After each WorkUnit's result verifies, its workspace holds the files that
 * WorkUnit changed. Integration seeds a fresh integration workspace from the
 * Change baseline, applies each verified WorkUnit's changed files on top (in a
 * deterministic order), commits one combined result, and runs the final test
 * suite over it. WorkUnits that failed verification are kept out of integration
 * and recorded as excluded.
 *
 * The integration workspace is provisioned through the same portable
 * WorkspaceProvider contract the rest of the fabric uses, so it is a real
 * Artifact repo in production and the honest local fallback offline. Combining
 * is done over ordinary Git, so it runs in Node, not inside a Worker.
 */

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { WorkspaceProvider, WorkspaceRef } from "@switchyard-change/artifact-workspace";

import {
  ChildProcessCommandRunner,
  boundOutput,
  type CommandOutcome,
  type CommandRunner,
} from "./command.ts";
import {
  changedPathsSinceBaseline,
  clone,
  commitAll,
  git,
  type GitIdentity,
} from "./git.ts";
import type { CheckResult, IntegrationResult, OutputRef, Verdict } from "./types.ts";

/** One verified WorkUnit's workspace to feed into integration. */
export interface VerifiedWorkspace {
  readonly unitId: string;
  /** Clone URL of the verified WorkUnit workspace (file:// or https). */
  readonly gitUrl: string;
  /** The Git ref that workspace was seeded from, for deriving changed files. */
  readonly baselineRef: string;
  /**
   * Contested paths this WorkUnit must yield to another lease owner. The
   * integrator skips these files when applying this unit, so the single lease
   * owner is the only contributor of each contested path. This is what turns a
   * would-be silent merge collision into a coordinated, single-writer result.
   */
  readonly yieldedPaths?: readonly string[];
}

/** Inputs to integrate verified WorkUnits into one combined workspace. */
export interface IntegrateOptions {
  /** The integration workspace to combine verified work into. */
  readonly integrationRef: WorkspaceRef;
  /** A write token's plaintext for pushing to the integration workspace. */
  readonly integrationToken: string;
  /** The verified WorkUnit workspaces, in the order they should be applied. */
  readonly verified: readonly VerifiedWorkspace[];
  /** WorkUnit ids that failed verification and must be excluded. */
  readonly excludedUnits: readonly string[];
  /** The final test command to run over the combined result, as argv. */
  readonly finalTestCommand?: readonly string[];
  /**
   * The per-app BEHAVIORAL gate command to run over the INTEGRATED tree, as
   * argv. This is the authoritative gate: it runs on the exact combined tree the
   * integrator produces and pushes (baseline + verified units, with each unit's
   * yielded contested paths and every excluded unit removed), which is the same
   * tree promotion then clones and deploys. Running the gate here guarantees the
   * gated composition is identical to the promoted/deployed composition, so a
   * pass means the SHIPPED artifact is fixed, not some other overlay. When
   * supplied, this result settles the integration verdict (it takes precedence
   * over the optional finalTestCommand).
   */
  readonly integrationGateCommand?: readonly string[];
  /**
   * True when the integrated tree MUST satisfy the per-app behavioral gate. When
   * true and no `integrationGateCommand` is supplied, the integration verdict is
   * FAILED (absence of a required gate is cannot-pass, never auto-pass). This is
   * the integration-level analog of the per-unit `requiresAppGate` rule and is
   * what makes it impossible to green a tree that cannot be gated.
   */
  readonly requiresIntegrationGate?: boolean;
  /** Root under which disposable worktrees are created. Defaults to OS temp. */
  readonly workRoot?: string;
  /** Deterministic committer identity for the integration commit. */
  readonly identity?: GitIdentity;
}

/** Options for constructing the integrator. */
export interface IntegratorOptions {
  readonly commandRunner?: CommandRunner;
}

export class Integrator {
  private readonly commandRunner: CommandRunner;

  constructor(
    private readonly workspaces: WorkspaceProvider,
    options: IntegratorOptions = {},
  ) {
    this.commandRunner = options.commandRunner ?? new ChildProcessCommandRunner();
  }

  /**
   * Combine the verified workspaces into the integration workspace and run the
   * final suite. The integration workspace must already be seeded from the
   * Change baseline (so the combined result starts from the same base the
   * WorkUnits did).
   */
  async integrate(options: IntegrateOptions): Promise<IntegrationResult> {
    const {
      integrationRef,
      verified,
      excludedUnits,
      finalTestCommand,
      integrationGateCommand,
      requiresIntegrationGate,
      identity,
    } = options;

    const workRoot = options.workRoot ?? tmpdir();
    const integrationDir = await mkdtemp(join(workRoot, "scf-integration-"));

    try {
      await clone(authenticated(integrationRef.gitUrl, options.integrationToken), integrationDir);

      // Apply each verified WorkUnit's changed files on top of the baseline.
      for (const unit of verified) {
        await this.applyUnit(unit, integrationDir, workRoot);
      }

      let committed = false;
      // Commit the combined result when the integration workspace changed.
      if (await git(integrationDir, ["status", "--porcelain"]).then((s) => s.trim() !== "")) {
        await commitAll(integrationDir, "Integrate verified WorkUnits", identity);
        committed = true;
      }
      if (committed) {
        await git(integrationDir, [
          "push",
          authenticated(integrationRef.gitUrl, options.integrationToken),
          `HEAD:${integrationRef.defaultBranch}`,
        ]);
      }

      // HARD ERROR on a silent baseline, enforced on the LIVE path (not only in a
      // unit test). When a fix was EXPECTED (the integrated tree requires the
      // per-app gate AND at least one verified unit was handed in to apply) but
      // applying every verified unit produced NO change (nothing committed, so
      // the composed tree is byte-identical to the baseline seed), the "apply"
      // vanished the fixes. Running the gate on that baseline tree and reporting
      // a verdict would let the unfixed baseline ship green (the exact false-green
      // this guard closes). Fail loudly instead, so a silent baseline-ship is a
      // hard error rather than a passing-but-unfixed deploy. A change that
      // expected no fix (no gate required, or no verified unit to apply) is
      // exempt: an unchanged integration there is a legitimate no-op.
      const fixesExpected = (requiresIntegrationGate ?? false) && verified.length > 0;
      if (fixesExpected && !committed) {
        throw new Error(
          `integration refused: ${verified.length} verified unit(s) were expected to land a fix ` +
            "but applying them produced no change, so the integrated tree is identical to the " +
            "baseline. A pass here would ship the unfixed baseline. The verified units' real edits " +
            "must reach the integration tree (gated tree == integrated tree == promoted tree).",
        );
      }

      // The AUTHORITATIVE gate. It runs the per-app behavioral gate on THIS exact
      // integrationDir, which is the tree we just committed and pushed to the
      // integration workspace and which promotion then clones and deploys. So the
      // composition that is gated here is byte-for-byte the composition that
      // promotes/deploys (baseline + verified units, with yielded contested paths
      // and every excluded unit already removed above). This is what makes a pass
      // mean the SHIPPED artifact is fixed, rather than some other overlay. When
      // an integration gate is configured it SETTLES the verdict; the optional
      // finalTestCommand remains only as a secondary check when no app gate is
      // configured (so existing non-app callers are unchanged).
      const finalCheck = await this.runIntegrationGate(
        integrationGateCommand,
        requiresIntegrationGate ?? false,
        finalTestCommand,
        integrationDir,
      );
      const verdict: Verdict = finalCheck.skipped || finalCheck.passed ? "verified" : "failed";

      return {
        verdict,
        // On a failed integration gate NOTHING is treated as integrated: the
        // promoted tree did not pass, so no unit may be reported as a landed fix.
        // This keeps the integratedUnits list honest about what actually shipped,
        // which the redeploy guard reads to decide whether a fix landed.
        integratedUnits: verdict === "failed" ? [] : verified.map((u) => u.unitId),
        excludedUnits: [...excludedUnits],
        finalCheck,
      };
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
    }
  }

  /**
   * Clone one verified WorkUnit's workspace, derive the files it changed since
   * the baseline, and copy those files into the integration checkout. Because
   * verified WorkUnits touch non-overlapping declared paths, copies do not
   * clobber one another. Any path this unit yielded to a lease owner is skipped
   * so the owner is the only contributor of a contested path.
   */
  private async applyUnit(
    unit: VerifiedWorkspace,
    integrationDir: string,
    workRoot: string,
  ): Promise<void> {
    const yielded = new Set(unit.yieldedPaths ?? []);
    const unitDir = await mkdtemp(join(workRoot, `scf-unit-${sanitize(unit.unitId)}-`));
    try {
      await clone(unit.gitUrl, unitDir);
      const changed = await changedPathsSinceBaseline(unitDir, unit.baselineRef);
      for (const rel of changed) {
        if (yielded.has(rel)) {
          // This contested path belongs to another lease owner; skip it so the
          // single owner's version is the one that lands in the integration.
          continue;
        }
        const from = join(unitDir, rel);
        const to = join(integrationDir, rel);
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { recursive: true });
      }
    } finally {
      await rm(unitDir, { recursive: true, force: true });
    }
  }

  /**
   * Run the AUTHORITATIVE per-app behavioral gate over the integrated checkout
   * and return it as the final check. This is the gate on the promoted artifact:
   *
   *   - When an `integrationGateCommand` is supplied, run it on the integrated
   *     tree. Its exit code settles the verdict (exit 0 passes, anything else
   *     fails). This takes precedence over any finalTestCommand.
   *   - When no gate command is supplied but the integrated tree REQUIRES one
   *     (`requiresIntegrationGate`), FAIL honestly: absence of a required gate is
   *     cannot-pass, never auto-pass, so a tree that cannot be gated can never
   *     green. This is the honesty invariant at the integration level.
   *   - Otherwise fall back to the optional finalTestCommand (or skip when none),
   *     preserving the behavior of existing non-app callers unchanged.
   */
  private async runIntegrationGate(
    gateArgv: readonly string[] | undefined,
    requiresGate: boolean,
    finalTestCommand: readonly string[] | undefined,
    integrationDir: string,
  ): Promise<CheckResult> {
    if (gateArgv && gateArgv.length > 0) {
      let outcome: CommandOutcome;
      try {
        outcome = await this.commandRunner.run(gateArgv, integrationDir);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return {
          kind: "app-gate",
          passed: false,
          skipped: false,
          summary: `integration app-gate could not run over the promoted tree: ${text}`,
          outputs: [{ stream: "summary", text }],
        };
      }
      const outputs: OutputRef[] = [];
      if (outcome.stdout.trim() !== "") {
        outputs.push({ stream: "stdout", text: boundOutput(outcome.stdout) });
      }
      if (outcome.stderr.trim() !== "") {
        outputs.push({ stream: "stderr", text: boundOutput(outcome.stderr) });
      }
      const ok = outcome.code === 0;
      return {
        kind: "app-gate",
        passed: ok,
        skipped: false,
        summary: ok
          ? "integration app-gate passed over the promoted tree (exit 0)"
          : `integration app-gate failed over the promoted tree (exit ${outcome.code ?? "none"})`,
        outputs,
      };
    }
    if (requiresGate) {
      // Honesty invariant: a tree that requires a gate but has none cannot pass.
      return {
        kind: "app-gate",
        passed: false,
        skipped: false,
        summary:
          "integrated tree requires a per-app behavioral gate but none was supplied: cannot verify the promoted artifact (absence of a gate is cannot-pass, not auto-pass)",
        outputs: [{ stream: "summary", text: "no integration app-gate for a tree that requires one" }],
      };
    }
    return this.runFinalSuite(finalTestCommand, integrationDir);
  }

  /** Run the final suite over the combined checkout, or skip when none set. */
  private async runFinalSuite(
    argv: readonly string[] | undefined,
    integrationDir: string,
  ): Promise<CheckResult> {
    if (!argv || argv.length === 0) {
      return { kind: "test", passed: true, skipped: true, summary: "no final test command configured", outputs: [] };
    }
    let outcome: CommandOutcome;
    try {
      outcome = await this.commandRunner.run(argv, integrationDir);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        kind: "test",
        passed: false,
        skipped: false,
        summary: `final suite could not run: ${text}`,
        outputs: [{ stream: "summary", text }],
      };
    }
    const outputs: OutputRef[] = [];
    if (outcome.stdout.trim() !== "") {
      outputs.push({ stream: "stdout", text: boundOutput(outcome.stdout) });
    }
    if (outcome.stderr.trim() !== "") {
      outputs.push({ stream: "stderr", text: boundOutput(outcome.stderr) });
    }
    const ok = outcome.code === 0;
    return {
      kind: "test",
      passed: ok,
      skipped: false,
      summary: ok
        ? "final suite passed over the integrated workspace (exit 0)"
        : `final suite failed over the integrated workspace (exit ${outcome.code ?? "none"})`,
      outputs,
    };
  }
}

/**
 * Build an authenticated clone/push URL. For an HTTPS remote, inject the scoped
 * token as the basic-auth password. For a file:// remote, return it unchanged
 * (the local fallback needs no credential).
 */
function authenticated(gitUrl: string, token: string): string {
  if (gitUrl.startsWith("https://")) {
    const rest = gitUrl.slice("https://".length);
    return `https://token:${encodeURIComponent(token)}@${rest}`;
  }
  return gitUrl;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

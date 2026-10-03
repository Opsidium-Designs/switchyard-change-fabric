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

      const finalCheck = await this.runFinalSuite(finalTestCommand, integrationDir);
      const verdict: Verdict = finalCheck.skipped || finalCheck.passed ? "verified" : "failed";

      return {
        verdict,
        integratedUnits: verified.map((u) => u.unitId),
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

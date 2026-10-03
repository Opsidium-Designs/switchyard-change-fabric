/**
 * ChangeVerification: wire WorkUnit verification and integration into one flow.
 *
 * This is the driver the runner flow calls once WorkUnits have completed: it
 * verifies each completed WorkUnit's workspace, feeds the verified ones into an
 * integration workspace, runs the final suite over the combined result, and
 * returns the Change's evidence summary.
 *
 * It reuses change-core's graph logic (findWorkUnit) to resolve a WorkUnit's
 * declared paths from the Change, so the verification contract's scope comes
 * straight from the coordination model. It holds no tenant, organizational, or
 * governance concepts: it only verifies work and reports evidence.
 */

import { findWorkUnit, type Change } from "@switchyard-change/change-core";
import type { WorkspaceProvider, WorkspaceRef } from "@switchyard-change/artifact-workspace";

import { Integrator, type VerifiedWorkspace } from "./integrator.ts";
import type { GitIdentity } from "./git.ts";
import { VerificationProvider } from "./verifier.ts";
import { clone } from "./git.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EvidenceSummary,
  IntegrationResult,
  VerificationContract,
  WorkUnitVerification,
} from "./types.ts";

/** A completed WorkUnit workspace handed to the verification flow. */
export interface CompletedWorkUnit {
  readonly unitId: string;
  /** Clone URL of the completed WorkUnit workspace. */
  readonly gitUrl: string;
  /** The Git ref the workspace was seeded from. */
  readonly baselineRef: string;
  /** Paths the runner reported as changed (used when provided). */
  readonly changedPaths?: readonly string[];
  /** Repository-relative files that must exist in the checkout. */
  readonly expectedFiles?: readonly string[];
  /** The per-unit test command, as argv (optional). */
  readonly testCommand?: readonly string[];
  /** The per-unit lint command, as argv (optional). */
  readonly lintCommand?: readonly string[];
}

/** Inputs for verifying and integrating a Change's completed WorkUnits. */
export interface VerifyAndIntegrateOptions {
  readonly change: Change;
  readonly completed: readonly CompletedWorkUnit[];
  /** A freshly created integration workspace, seeded from the Change baseline. */
  readonly integrationRef: WorkspaceRef;
  /** Write token plaintext for the integration workspace. */
  readonly integrationToken: string;
  /** The final test command run over the combined workspace, as argv. */
  readonly finalTestCommand?: readonly string[];
  readonly workRoot?: string;
  readonly identity?: GitIdentity;
}

export class ChangeVerification {
  private readonly verifier: VerificationProvider;
  private readonly integrator: Integrator;

  constructor(
    workspaces: WorkspaceProvider,
    options: {
      readonly verifier?: VerificationProvider;
      readonly integrator?: Integrator;
    } = {},
  ) {
    this.verifier = options.verifier ?? new VerificationProvider();
    this.integrator = options.integrator ?? new Integrator(workspaces);
  }

  /**
   * Verify every completed WorkUnit, integrate the verified ones, and produce
   * the evidence summary. Each WorkUnit's declared paths come from the Change
   * (via change-core), so scope is driven by the coordination model.
   */
  async verifyAndIntegrate(options: VerifyAndIntegrateOptions): Promise<EvidenceSummary> {
    const { change, completed } = options;
    const workRoot = options.workRoot ?? tmpdir();

    const units: WorkUnitVerification[] = [];
    const verifiedWorkspaces: VerifiedWorkspace[] = [];
    const excludedUnits: string[] = [];

    // Verify in the Change's declared WorkUnit order for deterministic evidence.
    const completedById = new Map(completed.map((c) => [c.unitId, c]));
    for (const unit of change.work) {
      const done = completedById.get(unit.id);
      if (!done) {
        continue;
      }
      const contract = this.contractFor(change, done);
      const verification = await this.verifyOne(done, contract, workRoot);
      units.push(verification);
      if (verification.verdict === "verified") {
        verifiedWorkspaces.push({
          unitId: done.unitId,
          gitUrl: done.gitUrl,
          baselineRef: done.baselineRef,
        });
      } else {
        excludedUnits.push(done.unitId);
      }
    }

    const integration: IntegrationResult = await this.integrator.integrate({
      integrationRef: options.integrationRef,
      integrationToken: options.integrationToken,
      verified: verifiedWorkspaces,
      excludedUnits,
      finalTestCommand: options.finalTestCommand,
      workRoot,
      identity: options.identity,
    });

    return { changeId: change.id, units, integration };
  }

  /** Build a verification contract for one completed WorkUnit from the Change. */
  private contractFor(change: Change, done: CompletedWorkUnit): VerificationContract {
    const unit = findWorkUnit(change, done.unitId);
    const paths = unit?.paths ?? [];
    return {
      unitId: done.unitId,
      paths,
      expectedFiles: done.expectedFiles,
      testCommand: done.testCommand,
      lintCommand: done.lintCommand,
      changedPaths: done.changedPaths,
    };
  }

  /** Clone a completed WorkUnit workspace and verify its checkout. */
  private async verifyOne(
    done: CompletedWorkUnit,
    contract: VerificationContract,
    workRoot: string,
  ): Promise<WorkUnitVerification> {
    const worktreeDir = await mkdtemp(join(workRoot, `scf-verify-${sanitize(done.unitId)}-`));
    try {
      await clone(done.gitUrl, worktreeDir);
      return await this.verifier.verify({
        worktreeDir,
        baselineRef: done.baselineRef,
        contract,
      });
    } finally {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

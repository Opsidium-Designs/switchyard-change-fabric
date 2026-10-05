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

import {
  detectPathCollisions,
  findWorkUnit,
  planWriteLeases,
  unitLeaseViews,
  type Change,
} from "@switchyard-change/change-core";
import type { WorkspaceProvider, WorkspaceRef } from "@switchyard-change/artifact-workspace";

import { Integrator, type VerifiedWorkspace } from "./integrator.ts";
import type { GitIdentity } from "./git.ts";
import { VerificationProvider } from "./verifier.ts";
import type { CommandRunner } from "./command.ts";
import { clone } from "./git.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CoordinationSummary,
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
  /**
   * The per-app behavioral gate command, as argv (optional). When supplied, the
   * verifier runs it as the real mechanical check that the planted bug is fixed.
   */
  readonly appGateCommand?: readonly string[];
  /**
   * True when this unit MUST satisfy a per-app behavioral gate. When true and no
   * `appGateCommand` is supplied, the app-gate check FAILS (absence of a gate is
   * cannot-pass, never auto-pass).
   */
  readonly requiresAppGate?: boolean;
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
  /**
   * The per-app BEHAVIORAL gate command to run over the INTEGRATED tree, as
   * argv. When supplied, it is the AUTHORITATIVE verdict: it runs on the exact
   * combined tree the integrator produces, pushes, and promotion then clones and
   * deploys (baseline + verified units, with yielded contested paths and every
   * excluded unit removed), so the gated composition is identical to the
   * promoted/deployed composition. A pass therefore means the SHIPPED artifact is
   * fixed. Prefer this over `finalTestCommand` for app changes.
   */
  readonly integrationGateCommand?: readonly string[];
  /**
   * True when the integrated tree MUST satisfy the per-app behavioral gate. When
   * true and no `integrationGateCommand` is supplied, the integration verdict is
   * FAILED (absence of a required gate is cannot-pass, never auto-pass). The
   * driver sets this automatically when any completed unit required an app gate,
   * so a change whose fix depends on an app gate can never green a tree that
   * cannot be gated.
   */
  readonly requiresIntegrationGate?: boolean;
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
      /**
       * An injectable command runner used by BOTH the per-unit verifier and the
       * final-suite integrator when they are not supplied directly. The live run
       * passes a real child-process runner; a test passes a deterministic fake so
       * the per-app gate and the final suite stay offline. When a `verifier` or
       * `integrator` is supplied directly it is used as-is.
       */
      readonly commandRunner?: CommandRunner;
    } = {},
  ) {
    this.verifier =
      options.verifier ??
      new VerificationProvider(
        options.commandRunner ? { commandRunner: options.commandRunner } : {},
      );
    this.integrator =
      options.integrator ??
      new Integrator(workspaces, options.commandRunner ? { commandRunner: options.commandRunner } : {});
  }

  /**
   * Verify every completed WorkUnit, coordinate any declared path collisions
   * with a write-lease plan, integrate the verified ones, and produce the
   * evidence summary. Each WorkUnit's declared paths come from the Change (via
   * change-core), so scope is driven by the coordination model.
   *
   * Coordination happens before integration: declared path collisions are
   * detected, a deterministic write-lease plan grants each contested path to a
   * single owner (or flags it), and the decision is recorded in the evidence.
   * A waiter's contested files are then kept out of integration so the owner is
   * the only contributor, which turns a would-be silent merge collision into a
   * coordinated single-writer result.
   *
   * The authoritative verdict is the per-app behavioral gate run on the
   * INTEGRATED tree (after lease yields and unit exclusions), which is the exact
   * tree the integrator pushes and promotion deploys. Running the gate there, not
   * on a separate overlay, guarantees the gated composition is identical to the
   * promoted/deployed composition, so a pass means the shipped artifact is fixed.
   * When the integrated tree requires an app gate but none is available, the
   * integration verdict is FAILED (absence is cannot-pass, never a green).
   */
  async verifyAndIntegrate(options: VerifyAndIntegrateOptions): Promise<EvidenceSummary> {
    const { change, completed } = options;
    const workRoot = options.workRoot ?? tmpdir();

    // Coordinate declared path collisions before integration. The plan is a
    // pure function of the Change, so it is reproducible every run.
    const collisions = detectPathCollisions(change);
    const leasePlan = planWriteLeases(change, collisions);
    const leaseViews = unitLeaseViews(leasePlan);
    const coordination: CoordinationSummary | undefined =
      collisions.length === 0
        ? undefined
        : {
            needsAttention: leasePlan.needsAttention,
            decisions: leasePlan.decisions.map((d) => ({
              path: d.path,
              contenders: d.contenders,
              resolution: d.resolution,
              owner: d.owner,
              waiters: d.waiters,
              reason: d.reason,
            })),
          };

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
          // Keep this unit's yielded contested paths out of integration so the
          // single lease owner is the only contributor of that path.
          yieldedPaths: leaseViews.get(done.unitId)?.yields ?? [],
        });
      } else {
        excludedUnits.push(done.unitId);
      }
    }

    // The integrated tree requires the authoritative app gate when any completed
    // unit required a per-app gate (or the caller forced it). This drives the
    // honesty invariant in the integrator: a tree that depends on an app gate but
    // has none cannot green. A unit's gate command is per-app, so when the caller
    // did not pass an explicit `integrationGateCommand` we fall back to the first
    // app-gate command any completed unit declared, since every app unit shares
    // the one per-app gate.
    const unitGateCommand = completed.find(
      (c) => c.appGateCommand && c.appGateCommand.length > 0,
    )?.appGateCommand;
    const requiresIntegrationGate =
      options.requiresIntegrationGate ?? completed.some((c) => c.requiresAppGate === true);
    const integrationGateCommand = options.integrationGateCommand ?? unitGateCommand;

    const integration: IntegrationResult = await this.integrator.integrate({
      integrationRef: options.integrationRef,
      integrationToken: options.integrationToken,
      verified: verifiedWorkspaces,
      excludedUnits,
      finalTestCommand: options.finalTestCommand,
      ...(integrationGateCommand && integrationGateCommand.length > 0
        ? { integrationGateCommand }
        : {}),
      requiresIntegrationGate,
      workRoot,
      identity: options.identity,
    });

    return { changeId: change.id, units, integration, coordination };
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
      appGateCommand: done.appGateCommand,
      requiresAppGate: done.requiresAppGate,
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

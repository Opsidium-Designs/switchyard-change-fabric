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

import { IntegrationAbortedError, Integrator, type UnitPart, type VerifiedWorkspace } from "./integrator.ts";
import type { GitIdentity } from "./git.ts";
import type { TestInventory } from "./test-inventory.ts";
import { VerificationProvider } from "./verifier.ts";
import type { CommandRunner } from "./command.ts";
import { checkoutCommit, clone, isAncestor } from "./git.ts";
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
   * Pin the unit to this exact commit: after cloning, verification and
   * integration check out this commit (detached), never the branch head, so what
   * is verified and integrated is exactly what was announced. A commit that is
   * not in the repo fails the unit.
   */
  readonly commit?: string;
  /**
   * Commits that must be contained in `commit` (ancestors of it, or equal):
   * the earlier announced pushes a caller reports as merged by integrating
   * this unit. A listed commit that is not in `commit`'s history fails the unit,
   * so what a caller records as merged is provably what was integrated.
   */
  readonly includes?: readonly string[];
  /**
   * Globs the unit yields to other owners (see VerificationContract.yieldedScope):
   * excluded from the scope check and never applied from this unit.
   */
  readonly yieldedScope?: readonly string[];
  /** Protected paths an accepted contract released for this unit only. */
  readonly releasedPaths?: readonly string[];
  /**
   * Per-item path selection (see VerifiedWorkspace.parts): each part's files
   * are applied from its own commit, which must be the pinned commit or one of
   * `includes` (anything else fails the integration).
   */
  readonly parts?: readonly UnitPart[];
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
  /**
   * Resolved human lease-owner decisions (contested path -> chosen WorkUnit id).
   * A valid choice is authoritative for that path: the chosen unit's write
   * integrates and the other contenders yield the path. An invalid choice (not a
   * contender, or cyclic) is rejected and the deterministic owner is kept, with
   * the reason recorded in the coordination evidence.
   */
  readonly leaseOwnerOverrides?: Readonly<Record<string, string>>;
  /**
   * Globs that define the gate (its test files, the project manifest): the
   * integrator restores them from the baseline before the gate runs, and a unit
   * that changed one fails the integration verdict (see IntegrateOptions).
   */
  readonly protectedPaths?: readonly string[];
  /** See IntegrateOptions.protectedJsonKeys. */
  readonly protectedJsonKeys?: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[];
  /** See IntegrateOptions.onProtectedChange. */
  readonly onProtectedChange?: "fail" | "restore";
  /** See IntegrateOptions.baseCommit. */
  readonly integrationBaseCommit?: string;
  /** See IntegrateOptions.deferBranchPush. */
  readonly deferIntegrationPush?: boolean;
  /** See IntegrateOptions.keepFailedGatedCommit. */
  readonly keepFailedGatedCommit?: boolean;
  /** See IntegrateOptions.testInventory. */
  readonly testInventory?: TestInventory;
  readonly workRoot?: string;
  readonly identity?: GitIdentity;
  /**
   * Abort (an interrupted run): every running check and gate command is
   * stopped, and verifyAndIntegrate rejects with IntegrationAbortedError
   * (never evidence) once its temp dirs are removed.
   */
  readonly signal?: AbortSignal;
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
    // pure function of the Change and any resolved human owner decisions, so it
    // is reproducible every run.
    const collisions = detectPathCollisions(change);
    const leasePlan = planWriteLeases(
      change,
      collisions,
      options.leaseOwnerOverrides ? { ownerOverrides: options.leaseOwnerOverrides } : {},
    );
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
              ...(d.ownerSource !== undefined ? { ownerSource: d.ownerSource } : {}),
              ...(d.requestedOwner !== undefined ? { requestedOwner: d.requestedOwner } : {}),
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
      if (options.signal?.aborted) {
        throw new IntegrationAbortedError();
      }
      const contract = this.contractFor(change, done);
      const verification = await this.verifyOne(done, contract, workRoot, options.signal);
      units.push(verification);
      if (verification.verdict === "verified") {
        verifiedWorkspaces.push({
          unitId: done.unitId,
          gitUrl: done.gitUrl,
          baselineRef: done.baselineRef,
          ...(done.commit !== undefined ? { commit: done.commit } : {}),
          ...(done.yieldedScope !== undefined ? { yieldedScope: done.yieldedScope } : {}),
          ...(done.releasedPaths !== undefined ? { releasedPaths: done.releasedPaths } : {}),
          ...(done.parts !== undefined ? { parts: done.parts } : {}),
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

    if (options.signal?.aborted) {
      throw new IntegrationAbortedError();
    }
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
      ...(options.protectedPaths && options.protectedPaths.length > 0 ? { protectedPaths: options.protectedPaths } : {}),
      ...(options.protectedJsonKeys && options.protectedJsonKeys.length > 0 ? { protectedJsonKeys: options.protectedJsonKeys } : {}),
      ...(options.onProtectedChange ? { onProtectedChange: options.onProtectedChange } : {}),
      ...(options.integrationBaseCommit ? { baseCommit: options.integrationBaseCommit } : {}),
      ...(options.deferIntegrationPush ? { deferBranchPush: true } : {}),
      ...(options.keepFailedGatedCommit ? { keepFailedGatedCommit: true } : {}),
      ...(options.testInventory ? { testInventory: options.testInventory } : {}),
      workRoot,
      identity: options.identity,
      ...(options.signal ? { signal: options.signal } : {}),
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
      ...(done.yieldedScope !== undefined ? { yieldedScope: done.yieldedScope } : {}),
    };
  }

  /** Clone a completed WorkUnit workspace and verify its checkout. */
  private async verifyOne(
    done: CompletedWorkUnit,
    contract: VerificationContract,
    workRoot: string,
    signal?: AbortSignal,
  ): Promise<WorkUnitVerification> {
    const worktreeDir = await mkdtemp(join(workRoot, `scf-verify-${sanitize(done.unitId)}-`));
    try {
      await clone(done.gitUrl, worktreeDir);
      if (done.commit !== undefined) {
        const refuse = (summary: string): WorkUnitVerification => ({
          unitId: done.unitId,
          verdict: "failed",
          checks: [{ kind: "clean-state", passed: false, skipped: false, summary, outputs: [{ stream: "summary", text: summary }] }],
        });
        try {
          await checkoutCommit(worktreeDir, done.commit);
        } catch {
          return refuse(`the pinned commit ${done.commit} is not in the unit's repo`);
        }
        for (const earlier of [...new Set([...(done.includes ?? []), ...(done.parts ?? []).map((p) => p.commit)])]) {
          if (!(await isAncestor(worktreeDir, earlier, done.commit))) {
            return refuse(`commit ${earlier} is not in the history of the pinned commit ${done.commit}`);
          }
        }
      }
      return await this.verifier.verify({
        worktreeDir,
        baselineRef: done.baselineRef,
        contract,
        ...(signal ? { signal } : {}),
      });
    } finally {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

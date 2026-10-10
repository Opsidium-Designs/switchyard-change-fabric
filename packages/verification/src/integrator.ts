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

import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import type { WorkspaceProvider, WorkspaceRef } from "@switchyard-change/artifact-workspace";
import { runGit } from "@switchyard-change/artifact-workspace/git-transport";

import {
  ChildProcessCommandRunner,
  boundOutput,
  type CommandOutcome,
  type CommandRunner,
} from "./command.ts";
import {
  changedPathsSinceBaseline,
  checkoutCommit,
  clone,
  commitAll,
  git,
  type GitIdentity,
} from "./git.ts";
import { matchesAny } from "./pathscope.ts";
import {
  readDependencySnapshot,
  readDependencySnapshotFromDir,
  runnerPackagesFromJsonKeys,
  runnerResolutionViolations,
} from "./runner-resolution.ts";
import { inventoryShortfall, readStreamInventory, readTestProgress, type TestInventory } from "./test-inventory.ts";
import type { CheckResult, IntegrationResult, OutputRef, PromotionPush, Verdict } from "./types.ts";

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
  /**
   * Globs this unit yields to other owners (for example an item it handed off):
   * changed files matching them are never applied from this unit.
   */
  readonly yieldedScope?: readonly string[];
  /**
   * The exact commit to apply: the clone is checked out at this commit
   * (detached) instead of the branch head, so what is integrated is exactly the
   * announced commit. A commit missing from the repo fails the integration.
   */
  readonly commit?: string;
  /**
   * Protected paths an accepted contract released for THIS unit only: its
   * version of them is applied and not restored. Other units' writes to them
   * are refused like any protected change.
   */
  readonly releasedPaths?: readonly string[];
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
  /**
   * The CONTRACT: paths and globs whose baseline content defines the gate (the
   * original code's existing tests, test-runner and package-manager configs,
   * the files the gate command names). After the verified units are applied,
   * every protected path that differs from the integration baseline is put
   * back BEFORE the gate runs (a changed or deleted file is restored, an added
   * one is removed), so a unit can never run a rewritten gate. The commit the
   * gate ran on carries the restored files. See `onProtectedChange` for what a
   * restore means for the verdict.
   */
  readonly protectedPaths?: readonly string[];
  /**
   * Keys inside otherwise editable JSON files that define the gate (for
   * example a manifest's gate scripts), as dotted segment lists. A changed key
   * is put back to its baseline value (an added one removed) before the gate
   * runs; a file that no longer parses is restored whole.
   */
  readonly protectedJsonKeys?: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[];
  /**
   * What a restore means for the verdict: "fail" (the default) fails the
   * integration with the paths named, since a unit that touched the contract
   * must not pass; "restore" keeps the gate's verdict on the restored tree (the
   * tree that ships) and only records the paths in `protectedViolations`.
   */
  readonly onProtectedChange?: "fail" | "restore";
  /**
   * Build on exactly this commit of the integration workspace (the caller's
   * last RECORDED passing revision) instead of whatever its branch head is.
   */
  readonly baseCommit?: string;
  /**
   * Do not advance the integration branch: on a verified verdict the gated
   * commit is pushed to a candidate ref only (`gatedRef(commit)`), and the
   * caller advances the branch with `advanceIntegrationBranch` once it has
   * recorded the revision. A discarded result then never moves the branch.
   */
  readonly deferBranchPush?: boolean;
  /**
   * The BASELINE gate run's executed-test inventory. When given, the gate fails
   * unless this run executed at least those tests (by name where the runner
   * prints names, and never fewer by count), so code under test that exits
   * early (`process.exit(0)` at import) cannot green the gate with tests that
   * never ran. The gate command itself is unchanged; only its output is read.
   */
  readonly testInventory?: TestInventory;
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
    // A trusted bare repo OUTSIDE the checkout the gate runs in, under its own
    // fresh private (0700) root outside workRoot: the gated commit is staged
    // here before the gate runs, and every git operation after the gate
    // (verifying the checkout, pushing) runs here, never in a directory agent
    // code could have planted hooks or config into. Before it is used after the
    // gate it is reset to known content (see resetTrustedRepo), since code
    // running as the same user could still reach it by absolute path.
    const trustedRoot = await mkdtemp(join(tmpdir(), "scf-trusted-"));
    const trusted = join(trustedRoot, "repo.git");

    try {
      await clone(authenticated(integrationRef.gitUrl, options.integrationToken), integrationDir);
      // The trunk value this integration builds on: the branch head at clone
      // time (empty when the branch does not exist yet). The final push is a
      // compare-and-swap against exactly this value, read before any agent
      // code runs in the checkout.
      const expectedBase = (
        await git(integrationDir, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${integrationRef.defaultBranch}^{commit}`]).catch(() => "")
      ).trim();
      if (options.baseCommit !== undefined) {
        // The base is the last RECORDED passing revision: candidate refs hold
        // gated commits the branch has not (yet) been advanced to.
        await git(integrationDir, [
          "fetch",
          "-q",
          authenticated(integrationRef.gitUrl, options.integrationToken),
          `+${gatedRef(options.baseCommit)}:${gatedRef(options.baseCommit)}`,
        ]).catch(() => "");
        await checkoutCommit(integrationDir, options.baseCommit);
      }

      // Apply each verified WorkUnit's changed files on top of the baseline.
      // Writes to the contract are applied only for the unit an accepted
      // contract released them for; unsafe paths (symlinks, dependency trees,
      // writes that would leave the checkout) are never applied.
      const refused: string[] = [];
      const appliedReleased: string[] = [];
      for (const unit of verified) {
        await this.applyUnit(unit, integrationDir, workRoot, options.protectedPaths ?? [], refused, appliedReleased);
      }

      // Defense in depth: the files that define the gate always come from the
      // baseline. Anything a unit changed there is put back before the gate runs
      // and fails the verdict below.
      const protectedViolations = [
        ...refused,
        ...(await restoreProtected(
          integrationDir,
          options.protectedPaths ?? [],
          options.protectedJsonKeys ?? [],
          appliedReleased,
        )),
      ];
      // The gate's own toolchain: what its runner packages resolve to. A key
      // list cannot catch everything (a nested lockfile entry that shadows a
      // runner dependency, a new package claiming a runner's bin), so the
      // applied tree's manifest and lockfiles are compared with the baseline
      // (HEAD is still the baseline here: nothing is committed yet). Such a
      // change cannot be restored key by key, so it always fails the
      // revision, whatever `onProtectedChange` says.
      const runnerViolations = await runnerResolutionCheck(integrationDir, options.protectedJsonKeys ?? []);
      protectedViolations.push(...runnerViolations);
      const failOnProtected =
        ((options.onProtectedChange ?? "fail") === "fail" && protectedViolations.length > 0) || runnerViolations.length > 0;

      let committed = false;
      // Commit the combined result when the integration workspace changed. The
      // commit is NOT pushed yet: it is pushed only after the authoritative gate
      // below passes, so the integration workspace (the tree promotion clones)
      // only ever advances to a tree that was gated and verified.
      if (await git(integrationDir, ["status", "--porcelain"]).then((s) => s.trim() !== "")) {
        await commitAll(integrationDir, "Integrate verified WorkUnits", identity);
        committed = true;
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
      if (fixesExpected && !committed && !failOnProtected) {
        throw new Error(
          `integration refused: ${verified.length} verified unit(s) were expected to land a fix ` +
            "but applying them produced no change, so the integrated tree is identical to the " +
            "baseline. A pass here would ship the unfixed baseline. The verified units' real edits " +
            "must reach the integration tree (gated tree == integrated tree == promoted tree).",
        );
      }

      // The AUTHORITATIVE gate. It runs the per-app behavioral gate on THIS exact
      // integrationDir, which is the tree we just committed and (on a pass) push
      // to the integration workspace, which promotion then clones and deploys. So the
      // composition that is gated here is byte-for-byte the composition that
      // promotes/deploys (baseline + verified units, with yielded contested paths
      // and every excluded unit already removed above). This is what makes a pass
      // mean the SHIPPED artifact is fixed, rather than some other overlay. When
      // an integration gate is configured it SETTLES the verdict; the optional
      // finalTestCommand remains only as a secondary check when no app gate is
      // configured (so existing non-app callers are unchanged).
      // Capture the gated commit BEFORE the gate runs agent code, and stage it
      // in the trusted repo (hooks disabled).
      const gated = (await git(integrationDir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
      await runGit(["init", "-q", "--bare", trusted]);
      if (gated !== "") {
        await safeGit(trusted, ["fetch", "-q", integrationDir, `+HEAD:${gatedRef(gated)}`]);
        if (expectedBase !== "") {
          // The expected trunk object too, so the ancestry check before the
          // push runs in the trusted repo, never in the gate's checkout.
          await safeGit(trusted, [
            "fetch",
            "-q",
            integrationDir,
            `+refs/remotes/origin/${integrationRef.defaultBranch}:${EXPECTED_BASE_REF}`,
          ]);
        }
      }

      const ranGate = await this.runIntegrationGate(
        integrationGateCommand,
        requiresIntegrationGate ?? false,
        finalTestCommand,
        integrationDir,
        options.testInventory,
      );
      // Gate-equals-deploy: the tracked files must be exactly the gated
      // commit's after the gate ran (agent code could rewrite itself, or commit
      // something else, while or after the tests ran). Checked from the trusted
      // repo, never with the checkout's own .git.
      if (gated !== "") {
        await resetTrustedRepo(trusted, gated);
      }
      const drifted = gated !== "" && !ranGate.skipped ? await trackedDrift(trusted, gated, integrationDir) : [];
      const gateCheck: CheckResult =
        drifted.length === 0
          ? ranGate
          : {
              ...ranGate,
              passed: false,
              summary:
                `integration refused: the gate run changed tracked files of the gated tree (${drifted.slice(0, 10).join(", ")}${drifted.length > 10 ? ", ..." : ""}), ` +
                `so what was tested is not what would ship. Gate: ${ranGate.summary}`,
            };
      // A unit that changed a protected path fails the integration honestly,
      // whatever the (baseline) gate said: its edit to the gate's definition was
      // discarded, so the tree it asked for is not the tree that was gated.
      const finalCheck: CheckResult =
        protectedViolations.length === 0
          ? gateCheck
          : !failOnProtected
            ? {
                ...gateCheck,
                summary: `${gateCheck.summary}; protected path(s) the units changed were restored from the baseline before the gate ran: ${protectedViolations.join(", ")}`,
              }
            : {
              ...gateCheck,
              passed: false,
              skipped: false,
              summary:
                runnerViolations.length === 0
                  ? `integration refused: the verified units changed protected path(s) that define the gate ` +
                    `(${protectedViolations.join(", ")}); they were restored from the baseline for the gate run ` +
                    `and the revision fails. Gate on the restored tree: ${gateCheck.summary}`
                  : `integration refused: the verified units changed protected path(s) that define the gate ` +
                    `(${protectedViolations.join(", ")}); a change to the gate's runner resolution cannot be restored ` +
                    `key by key, so the revision fails whatever the gate said. Gate: ${gateCheck.summary}`,
              outputs: [
                { stream: "summary", text: `protected paths changed: ${protectedViolations.join(", ")}` },
                ...gateCheck.outputs,
              ],
            };
      const verdict: Verdict = finalCheck.skipped || finalCheck.passed ? "verified" : "failed";
      // The commit is the one captured BEFORE the gate, never re-read after it.
      const commit = gated;

      // Push the gated commit only on a verified verdict, from the trusted repo
      // (hooks off, minimal environment), so gated tree == pushed tree and no
      // hook or config the gate's code planted can see the credential. The
      // branch push is a compare-and-swap against the trunk value read at clone
      // time: a trunk that moved meanwhile throws PromotionRefusedError
      // ("trunk-moved") and the branch is left as the other writer set it. A
      // deferred push goes to the commit's own candidate ref (named by the
      // commit, so there is nothing to race on).
      let promotion: PromotionPush | undefined;
      if (committed && verdict === "verified") {
        const remote = authenticated(integrationRef.gitUrl, options.integrationToken);
        if (options.deferBranchPush) {
          await safeGit(trusted, ["push", "-q", remote, `${commit}:${gatedRef(commit)}`]);
        } else {
          promotion = await compareAndSwapBranch(trusted, remote, integrationRef.defaultBranch, commit, expectedBase === "" ? null : expectedBase);
        }
      }

      return {
        verdict,
        // On a failed integration gate NOTHING is treated as integrated: the
        // promoted tree did not pass, so no unit may be reported as a landed fix.
        // This keeps the integratedUnits list honest about what actually shipped,
        // which the redeploy guard reads to decide whether a fix landed.
        integratedUnits: verdict === "failed" ? [] : verified.map((u) => u.unitId),
        excludedUnits: [...excludedUnits],
        finalCheck,
        ...(commit !== "" ? { commit } : {}),
        ...(protectedViolations.length > 0 ? { protectedViolations } : {}),
        ...(promotion !== undefined ? { promotion } : {}),
      };
    } finally {
      await rm(integrationDir, { recursive: true, force: true });
      await rm(trustedRoot, { recursive: true, force: true });
    }
  }

  /**
   * Clone one verified WorkUnit's workspace, derive the files it changed since
   * the baseline, and copy those files into the integration checkout. Because
   * verified WorkUnits touch non-overlapping declared paths, copies do not
   * clobber one another. Any path this unit yielded to a lease owner is skipped
   * so the owner is the only contributor of a contested path. A changed path
   * that no longer exists in the unit's tree is a deletion, so it is removed
   * from the integration checkout rather than copied.
   */
  private async applyUnit(
    unit: VerifiedWorkspace,
    integrationDir: string,
    workRoot: string,
    protectedPaths: readonly string[],
    refused: string[],
    appliedReleased: string[],
  ): Promise<void> {
    const released = unit.releasedPaths ?? [];
    const root = await realpath(integrationDir);
    const yielded = new Set(unit.yieldedPaths ?? []);
    const yieldedScope = unit.yieldedScope ?? [];
    const unitDir = await mkdtemp(join(workRoot, `scf-unit-${sanitize(unit.unitId)}-`));
    try {
      await clone(unit.gitUrl, unitDir);
      if (unit.commit !== undefined) {
        // Apply exactly the announced commit, never whatever the branch head is now.
        await checkoutCommit(unitDir, unit.commit);
      }
      const unitRoot = await realpath(unitDir);
      const changed = await changedPathsSinceBaseline(unitDir, unit.baselineRef);
      for (const rel of changed) {
        if (yielded.has(rel) || (yieldedScope.length > 0 && matchesAny(rel, yieldedScope))) {
          // This contested path belongs to another lease owner; skip it so the
          // single owner's version is the one that lands in the integration.
          continue;
        }
        const from = join(unitDir, rel);
        const to = join(integrationDir, rel);
        if (rel.split("/").some((segment) => segment === "node_modules" || segment === ".git") || /(^|\/)(\.bin|vendor\/bin)\//.test(rel)) {
          refused.push(`${rel} (dependency or tool tree: never applied from a unit)`);
          continue;
        }
        if (protectedPaths.length > 0 && matchesAny(rel, protectedPaths)) {
          if (released.length === 0 || !matchesAny(rel, released)) {
            // Not this unit's to change: the baseline version stays (the
            // restore below would put it back anyway; this keeps it from
            // ever being written).
            refused.push(rel);
            continue;
          }
          appliedReleased.push(rel);
        }
        if ((await lstat(from).catch(() => undefined))?.isSymbolicLink()) {
          refused.push(`${rel} (a symlink: never applied)`);
          continue;
        }
        // Every read stays inside the unit's checkout (a symlinked parent
        // directory could point anywhere) ...
        const fromParent = await deepestRealpath(dirname(from));
        if (!within(unitRoot, fromParent)) {
          refused.push(`${rel} (its directory resolves outside the unit's checkout)`);
          continue;
        }
        // ... and every write inside the integration checkout, checked BEFORE
        // any directory is created, so nothing is ever made outside it.
        if (!within(root, await deepestRealpath(dirname(to)))) {
          refused.push(`${rel} (resolves outside the integration checkout)`);
          continue;
        }
        await mkdir(dirname(to), { recursive: true });
        if ((await lstat(to).catch(() => undefined))?.isSymbolicLink()) {
          refused.push(`${rel} (would write through a symlink)`);
          continue;
        }
        if (!(await pathExists(from))) {
          // The unit deleted this file: carry the deletion into the integrated
          // tree so it matches the unit's verified result.
          await rm(to, { force: true });
          continue;
        }
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
    baselineInventory?: TestInventory,
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
      const exitOk = outcome.code === 0;
      // The tests the baseline run executed must all have executed again: an
      // early exit cannot green the gate by skipping them.
      const shortfall =
        baselineInventory !== undefined ? inventoryShortfall(baselineInventory, readStreamInventory(outcome.stdout, outcome.stderr)) : undefined;
      const ok = exitOk && shortfall === undefined;
      // The cause leads: a gate that exited non-zero failed on its own output
      // (the inventory is secondary); the inventory is THE cause only when the
      // gate exited 0, which is the early exit it protects against.
      return {
        kind: "app-gate",
        passed: ok,
        skipped: false,
        summary: ok
          ? "integration app-gate passed over the promoted tree (exit 0)"
          : !exitOk
            ? `integration app-gate failed over the promoted tree (exit ${outcome.code ?? "none"})` +
              (shortfall !== undefined ? `; also, test inventory: ${shortfall}` : "")
            : `integration app-gate exited 0 but did not run its tests: test inventory: ${shortfall}`,
        outputs,
        // Advisory progress from the FULL output (the captured outputs are bounded).
        ...((): { progress?: ReturnType<typeof readTestProgress> } => {
          const progress = readTestProgress(`${outcome.stdout}\n${outcome.stderr}`);
          return progress ? { progress } : {};
        })(),
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
 * Build an authenticated clone/push URL. For an HTTPS remote, the scoped token
 * is carried as the URL's password inside this process; runGit sends it as a
 * Bearer header and never puts it on git's command line. For a file:// remote,
 * return it unchanged (the local fallback needs no credential).
 */
function authenticated(gitUrl: string, token: string): string {
  if (gitUrl.startsWith("https://")) {
    const rest = gitUrl.slice("https://".length);
    return `https://token:${encodeURIComponent(token)}@${rest}`;
  }
  return gitUrl;
}

/** Where a deferred push leaves a gated commit until the caller records it. */
export const GATED_REF_PREFIX = "refs/switchyard/gated/";

/** The candidate ref a deferred push uses for `commit`. */
export function gatedRef(commit: string): string {
  return `${GATED_REF_PREFIX}${commit}`;
}

/** Where the trusted repo keeps the expected trunk object for the ancestry check. */
const EXPECTED_BASE_REF = "refs/switchyard/expected-base";

/** Why a compare-and-swap branch push was refused. */
export type PromotionRefusalReason = "trunk-moved" | "not-descendant";

/**
 * A branch promotion that did not happen, for a named reason, instead of a
 * generic git error:
 *   - "trunk-moved": the branch is no longer at the value this promotion was
 *     built on (another writer advanced it); `actual` is what it holds now when
 *     it could be read. Nothing was pushed; do not retry blindly, rebuild on
 *     the new trunk.
 *   - "not-descendant": the commit does not descend from the expected trunk
 *     value, so pushing it would move the branch sideways. Nothing was pushed.
 * Carries only ref names and commit ids (never a credential).
 */
export class PromotionRefusedError extends Error {
  readonly reason: PromotionRefusalReason;
  readonly ref: string;
  readonly commit: string;
  readonly expected: string | null;
  readonly actual?: string | null;
  constructor(input: {
    readonly reason: PromotionRefusalReason;
    readonly ref: string;
    readonly commit: string;
    readonly expected: string | null;
    readonly actual?: string | null;
  }) {
    const expected = input.expected ?? "(absent)";
    super(
      input.reason === "trunk-moved"
        ? `promotion refused (trunk-moved): ${input.ref} is no longer at ${expected}` +
            `${input.actual !== undefined ? ` (now ${input.actual ?? "(absent)"})` : ""}; ${input.commit} was not pushed`
        : `promotion refused (not-descendant): ${input.commit} does not descend from ${expected} on ${input.ref}; nothing was pushed`,
    );
    this.name = "PromotionRefusedError";
    this.reason = input.reason;
    this.ref = input.ref;
    this.commit = input.commit;
    this.expected = input.expected;
    if (input.actual !== undefined) {
      this.actual = input.actual;
    }
  }
}

/** Is `error` a refused promotion (optionally for one reason)? */
export function isPromotionRefused(error: unknown, reason?: PromotionRefusalReason): error is PromotionRefusedError {
  return error instanceof PromotionRefusedError && (reason === undefined || error.reason === reason);
}

/**
 * Move `refs/heads/<branch>` on `remote` from exactly `expected` (null: the
 * branch must not exist) to `commit`, as a compare-and-swap:
 *   1. locally (in `dir`, which holds both objects), `commit` must descend
 *      from `expected` (`merge-base --is-ancestor`), so the move is a
 *      fast-forward of the value the caller built on;
 *   2. the push carries an explicit lease naming `expected`, which the server
 *      checks against the ref in the same push, so a concurrent advance makes
 *      the push fail instead of being overwritten.
 * A failed push whose ref no longer reads `expected` is "trunk-moved". The
 * pushed value is always `commit` itself (gate-equals-deploy holds). Never
 * retries.
 */
async function compareAndSwapBranch(
  dir: string,
  remote: string,
  branch: string,
  commit: string,
  expected: string | null,
): Promise<PromotionPush> {
  const ref = `refs/heads/${branch}`;
  if (expected !== null) {
    try {
      await safeGit(dir, ["merge-base", "--is-ancestor", expected, commit]);
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) {
        throw new PromotionRefusedError({ reason: "not-descendant", ref, commit, expected });
      }
      throw new Error(`promotion refused: could not check that ${commit} descends from ${expected} (${errorText(error)})`);
    }
  }
  try {
    await safeGit(dir, ["push", "-q", `--force-with-lease=${ref}:${expected ?? ""}`, remote, `${commit}:${ref}`]);
  } catch (error) {
    const actual = await remoteRefValue(dir, remote, ref).catch(() => undefined);
    if (actual !== undefined && actual !== expected) {
      throw new PromotionRefusedError({ reason: "trunk-moved", ref, commit, expected, actual });
    }
    throw error;
  }
  return { ref, commit, expectedOld: expected };
}

/** What `ref` holds on `remote` now (null when it does not exist). */
async function remoteRefValue(dir: string, remote: string, ref: string): Promise<string | null> {
  const listed = await safeGit(dir, ["ls-remote", remote, ref]);
  for (const line of listed.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha !== undefined) {
      return sha;
    }
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Options for advancing the integration branch. */
export interface AdvanceBranchOptions {
  /**
   * The trunk value the caller built the recorded revision on. When given, the
   * branch must still hold exactly this value or the advance is refused as
   * "trunk-moved" without pushing. Omitted, the branch value read at the start
   * of the advance is the expected value (still a compare-and-swap: a writer
   * that moves the branch between that read and the push makes it fail).
   */
  readonly expectedBase?: string;
}

/**
 * Advance the integration branch to a gated commit a deferred integration left
 * on its candidate ref (call this only after the revision was recorded). The
 * move is a compare-and-swap fast-forward (see compareAndSwapBranch): it
 * throws PromotionRefusedError ("trunk-moved" or "not-descendant") instead of
 * a generic git error when another writer got there first. A branch already at
 * `commit` is left as is.
 */
export async function advanceIntegrationBranch(
  integrationRef: WorkspaceRef,
  token: string,
  commit: string,
  workRoot: string = tmpdir(),
  options: AdvanceBranchOptions = {},
): Promise<PromotionPush> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new Error(`not a commit id: ${commit}`);
  }
  if (options.expectedBase !== undefined && !/^[0-9a-f]{40,64}$/.test(options.expectedBase)) {
    throw new Error(`not a full commit id: ${options.expectedBase}`);
  }
  const remote = authenticated(integrationRef.gitUrl, token);
  const branchRef = `refs/heads/${integrationRef.defaultBranch}`;
  const dir = await mkdtemp(join(workRoot, "scf-advance-"));
  try {
    await git(dir, ["init", "-q", "--bare"]);
    // The branch value now (the expected old value unless the caller named one).
    const observed = await git(dir, ["fetch", "-q", remote, `+${branchRef}:${EXPECTED_BASE_REF}`])
      .then(async () => (await git(dir, ["rev-parse", "--verify", "-q", `${EXPECTED_BASE_REF}^{commit}`])).trim())
      .catch(() => null);
    await git(dir, ["fetch", "-q", remote, `${gatedRef(commit)}:${gatedRef(commit)}`]).catch(async () => {
      // Already on the branch (nothing was committed for it): fetch the branch.
      await git(dir, ["fetch", "-q", remote, `+${branchRef}:${branchRef}`]);
    });
    let promotion: PromotionPush;
    if (observed !== null && observed.startsWith(commit)) {
      promotion = { ref: branchRef, commit: observed, expectedOld: observed };
    } else {
      if (options.expectedBase !== undefined && observed !== options.expectedBase) {
        throw new PromotionRefusedError({ reason: "trunk-moved", ref: branchRef, commit, expected: options.expectedBase, actual: observed });
      }
      // A fast-forward only, leased on the value read above: the branch can
      // never be moved sideways, nor over a concurrent advance.
      promotion = await compareAndSwapBranch(dir, remote, integrationRef.defaultBranch, commit, observed);
    }
    // Prune candidate refs: the recorded commit is on the branch now, and any
    // other candidate was a discarded result.
    const listed = await git(dir, ["ls-remote", remote, `${GATED_REF_PREFIX}*`]).catch(() => "");
    for (const ref of listed.split("\n").map((l) => l.trim().split(/\s+/)[1]).filter((r): r is string => !!r)) {
      await git(dir, ["push", "-q", remote, `:${ref}`]).catch(() => "");
    }
    return promotion;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run the gate once on the integration workspace's BASELINE (its branch head,
 * or `commit`) and read the executed-test inventory from its output. Returns
 * undefined when the gate's output shape is not recognized ("test inventory
 * unavailable"); the caller records that and falls back to the exit code.
 */
export async function recordBaselineInventory(input: {
  readonly integrationRef: WorkspaceRef;
  readonly integrationToken: string;
  readonly gateCommand: readonly string[];
  readonly commandRunner?: CommandRunner;
  /** Where the checkout is made (the gate's shared harness must resolve from here). */
  readonly workRoot?: string;
  readonly commit?: string;
}): Promise<TestInventory | undefined> {
  const dir = await mkdtemp(join(input.workRoot ?? tmpdir(), "scf-integration-baseline-"));
  try {
    await clone(authenticated(input.integrationRef.gitUrl, input.integrationToken), dir);
    if (input.commit !== undefined) {
      await checkoutCommit(dir, input.commit);
    }
    const runner = input.commandRunner ?? new ChildProcessCommandRunner();
    const outcome = await runner.run(input.gateCommand, dir).catch(() => undefined);
    return outcome ? readStreamInventory(outcome.stdout, outcome.stderr) : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The value at a key path (undefined when absent). */
function getKey(value: unknown, keys: readonly string[]): unknown {
  let cur: unknown = value;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Set (or, for undefined, delete) the value at a key path, creating objects on the way. */
function setKey(value: Record<string, unknown>, keys: readonly string[], next: unknown): void {
  let cur = value;
  for (const key of keys.slice(0, -1)) {
    const child = cur[key];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      if (next === undefined) {
        return;
      }
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (next === undefined) {
    delete cur[last];
  } else {
    cur[last] = next;
  }
}

/**
 * Put every protected path back to the integration baseline (the checkout's
 * HEAD) and return what had changed. A protected file the units modified or
 * deleted is restored; one they added is removed. Protected JSON keys are
 * restored key by key (the rest of the file keeps the units' edits). Released
 * paths are left alone.
 */
async function restoreProtected(
  dir: string,
  patterns: readonly string[],
  jsonKeys: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[],
  released: readonly string[],
): Promise<string[]> {
  if (patterns.length === 0 && jsonKeys.length === 0) {
    return [];
  }
  await git(dir, ["add", "-A"]);
  const changed = (await git(dir, ["diff", "--cached", "--name-only", "--no-renames", "HEAD"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const free = (path: string) => released.length > 0 && matchesAny(path, released);
  const restoreWhole = async (path: string): Promise<void> => {
    const inBaseline = (await git(dir, ["ls-tree", "--name-only", "HEAD", "--", path])).trim() !== "";
    if (inBaseline) {
      await git(dir, ["checkout", "HEAD", "--", path]);
    } else {
      await git(dir, ["rm", "-q", "-f", "--cached", "--", path]);
      await rm(join(dir, path), { force: true });
    }
  };
  const touched: string[] = [];
  for (const path of changed.filter((p) => matchesAny(p, patterns) && !free(p)).sort()) {
    await restoreWhole(path);
    touched.push(path);
  }
  for (const { file, keys } of jsonKeys) {
    if (!changed.includes(file) || touched.includes(file) || free(file)) {
      continue;
    }
    const baseText = await git(dir, ["show", `HEAD:${file}`]).catch(() => undefined);
    const workText = await readFile(join(dir, file), "utf8").catch(() => undefined);
    let base: unknown;
    let work: unknown;
    try {
      base = baseText === undefined ? {} : JSON.parse(baseText);
      work = workText === undefined ? undefined : JSON.parse(workText);
    } catch {
      work = undefined;
    }
    if (typeof work !== "object" || work === null || Array.isArray(work)) {
      // Deleted or no longer valid JSON: the keys cannot be checked, so the
      // whole file goes back.
      await restoreWhole(file);
      touched.push(file);
      continue;
    }
    const differ = keys.filter((k) => JSON.stringify(getKey(base, k)) !== JSON.stringify(getKey(work, k)));
    if (differ.length === 0) {
      continue;
    }
    for (const k of differ) {
      setKey(work as Record<string, unknown>, k, getKey(base, k));
      touched.push(`${file}#${k.join(".")}`);
    }
    const indent = /\n([ \t]+)"/.exec(workText ?? "")?.[1] ?? "  ";
    await writeFile(join(dir, file), `${JSON.stringify(work, null, indent)}${(workText ?? "").endsWith("\n") ? "\n" : ""}`);
  }
  if (touched.length > 0) {
    await git(dir, ["add", "-A"]);
  }
  return touched;
}

/**
 * The runner-resolution violations of the applied tree in `dir` against its
 * HEAD (the baseline, before the integration commit), for the runner packages
 * the protected manifest keys name. Empty when the gate runs no packages.
 * Blobs are read raw (`cat-file blob`, no textconv); git's default output
 * buffer (64 MiB) holds a large lockfile.
 */
async function runnerResolutionCheck(
  dir: string,
  jsonKeys: readonly { readonly file: string; readonly keys: readonly (readonly string[])[] }[],
): Promise<string[]> {
  const runnerPackages = runnerPackagesFromJsonKeys(jsonKeys);
  if (runnerPackages.length === 0) {
    return [];
  }
  const baseline = await readDependencySnapshot((name) =>
    git(dir, ["cat-file", "blob", `HEAD:${name}`]).then(
      (text): string | undefined => text,
      () => undefined,
    ),
  );
  return runnerResolutionViolations(baseline, await readDependencySnapshotFromDir(dir), runnerPackages);
}

/**
 * Run git in a repo the orchestrator controls, hardened (no global or system
 * config, private empty HOME, hooks and fsmonitor off, any token sent as a
 * header and never on the command line; see runGit).
 */
async function safeGit(dir: string, args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Promise<string> {
  const { stdout } = await runGit(["-C", dir, ...args], { env: extraEnv, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** The only configuration the trusted repo may have when it is used after the gate. */
const TRUSTED_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n";

/**
 * Put the trusted repo back to known content after the gate ran: its config is
 * rewritten, hooks/, info/ and any object alternates are removed, and the
 * gated commit must still be present. Code the gate ran as the same user could
 * have reached it by absolute path; after this nothing it planted there (a
 * pushInsteadOf, a hook, an alternate object store) is read by the push.
 */
async function resetTrustedRepo(trusted: string, commit: string): Promise<void> {
  const info = await lstat(trusted).catch(() => undefined);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("integration refused: the trusted repository was replaced while the gate ran");
  }
  await rm(join(trusted, "hooks"), { recursive: true, force: true });
  await rm(join(trusted, "info"), { recursive: true, force: true });
  await rm(join(trusted, "objects", "info", "alternates"), { force: true });
  await rm(join(trusted, "objects", "info", "http-alternates"), { force: true });
  await rm(join(trusted, "config"), { force: true });
  await writeFile(join(trusted, "config"), TRUSTED_CONFIG, { mode: 0o600 });
  const found = (await safeGit(trusted, ["rev-parse", "--verify", "-q", `${commit}^{commit}`]).catch(() => "")).trim();
  if (found !== commit) {
    throw new Error("integration refused: the gated commit is missing from the trusted repository after the gate ran");
  }
}

/**
 * The tracked files of `commit` whose content in `worktree` differs (or that
 * are gone), read through the TRUSTED repo with a throwaway index: the
 * worktree's own .git (which agent code may have changed) is never consulted.
 */
async function trackedDrift(trusted: string, commit: string, worktree: string): Promise<string[]> {
  const index = join(trusted, "drift-index");
  const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: worktree };
  const base = ["--work-tree", worktree];
  await safeGit(trusted, [...base, "read-tree", commit], env);
  await safeGit(trusted, [...base, "update-index", "-q", "--refresh"], env).catch(() => "");
  const out = await safeGit(trusted, [...base, "diff-files", "--name-only"], env);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Is `path` the root or inside it (both already real paths)? */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * The real path of `path`'s deepest EXISTING ancestor (itself when it exists),
 * with the missing tail appended: where a write to `path` would really land,
 * computed without creating anything.
 */
async function deepestRealpath(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return path;
      }
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/** True when a path exists (a symlink counts, even a dangling one). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

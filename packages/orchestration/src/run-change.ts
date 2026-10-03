/**
 * runChange: drive one Change through the whole fabric, deterministically and
 * offline.
 *
 * The flow, in order:
 *   1. orchestration: create the Change and schedule its WorkUnits in dependency
 *      order (independent units run concurrently);
 *   2. runners:       each runnable WorkUnit is leased, its isolated workspace is
 *      cloned, the chosen executor makes the edit, and the result is committed
 *      and pushed back;
 *   3. verification + integration: every completed WorkUnit's workspace is
 *      verified, declared path collisions are coordinated with a write-lease
 *      plan, and the verified work is combined in an integration workspace;
 *   4. conflict coordination: the recorded lease plan is surfaced in the result
 *      so a contested path is resolved to a single owner, never a silent merge;
 *   5. promotion:     the integrated result is promoted into an ordinary local
 *      Git repository as a real branch and commit;
 *   6. cleanup:       the per-WorkUnit and integration workspaces are expired.
 *
 * By default it uses the deterministic noop executor and the honest
 * local-filesystem fallback workspace provider, so the whole pipeline runs with
 * no Cloudflare account and no model inference, and the same Change always
 * produces the same promoted result.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildWorkGraph,
  findDependencyCycle,
  runnableUnits,
  type Change,
} from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { WorkspaceRef } from "@switchyard-change/artifact-workspace";
import type { ExecutorProvider } from "@switchyard-change/model-adapters";
import { ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import {
  runWorkUnit,
  WorkerClient,
  DEFAULT_IDENTITY as RUNNER_IDENTITY,
  type GitIdentity,
  type RunWorkUnitResult,
} from "@switchyard-change/local-runner";
import {
  ChangeVerification,
  type CompletedWorkUnit,
  type EvidenceSummary,
} from "@switchyard-change/verification";
import {
  LocalGitDeliveryProvider,
  cleanupWorkspaces,
  defaultBranch,
  type ChangeWorkspaces,
  type CleanupResult,
  type PromotionResult,
} from "@switchyard-change/git-promotion";

import { LocalChangeControl, workspaceNameFor } from "./local-control.ts";

const run = promisify(execFile);

/** How a WorkUnit ran, surfaced for the human-readable summary. */
export interface UnitRunReport {
  readonly unitId: string;
  readonly objective: string;
  readonly workspaceName: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly commit: string;
  readonly changedPaths: readonly string[];
  readonly costUsd: number;
  readonly executor: string;
}

/** The full, structured outcome of running a Change end to end. */
export interface RunChangeResult {
  readonly changeId: string;
  readonly objective: string;
  readonly executor: string;
  /** True when every workspace used the honest local fallback. */
  readonly offline: boolean;
  /** The order WorkUnits became runnable and ran, as scheduling waves. */
  readonly waves: readonly (readonly string[])[];
  readonly units: readonly UnitRunReport[];
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly evidence: EvidenceSummary;
  readonly promotion: PromotionResult;
  readonly cleanup: CleanupResult;
  /** Absolute path to the local source repository the result was promoted into. */
  readonly sourceRepoDir: string;
}

/** Options for runChange. */
export interface RunChangeOptions {
  /** The Change spec YAML text. */
  readonly specYaml: string;
  /**
   * Absolute path to the project directory to use as the Change baseline and the
   * promotion target. runChange seeds a disposable Git clone of this directory
   * so the caller's working tree is never touched.
   */
  readonly projectDir: string;
  /**
   * Root under which all disposable state (workspaces, worktrees, the source
   * clone) is created. Defaults to a fresh OS temp directory.
   */
  readonly workRoot?: string;
  /**
   * The executor each runner uses. Defaults to the deterministic noop executor
   * (zero inference), which keeps the whole run offline and reproducible.
   */
  readonly executor?: ExecutorProvider;
  /** Deterministic committer identity, for reproducible commits. */
  readonly identity?: GitIdentity;
  /** An optional progress sink for human-readable console output. */
  readonly onEvent?: (event: RunEvent) => void;
}

/** A progress event emitted during a run, for live console output. */
export type RunEvent =
  | { readonly kind: "change-created"; readonly change: Change }
  | { readonly kind: "wave-start"; readonly units: readonly string[] }
  | { readonly kind: "unit-done"; readonly report: UnitRunReport }
  | { readonly kind: "verifying" }
  | { readonly kind: "promoting"; readonly branch: string }
  | { readonly kind: "cleaned-up"; readonly archived: readonly string[] };

/**
 * Run a Change end to end and return the structured result. Everything runs in
 * the given work root and is cleaned up on the way out; the caller's project
 * directory is cloned, never mutated.
 */
export async function runChange(options: RunChangeOptions): Promise<RunChangeResult> {
  const executor = options.executor ?? new ScopedNoopExecutor();
  const identity = options.identity ?? RUNNER_IDENTITY;
  const emit = options.onEvent ?? (() => {});
  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), "scf-run-")));
  await mkdir(workRoot, { recursive: true });

  const artifactsRoot = join(workRoot, "artifacts");
  const worktreeRoot = join(workRoot, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });

  const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: artifactsRoot });
  const control = new LocalChangeControl(workspaces);
  const change = control.createChange(options.specYaml);
  emit({ kind: "change-created", change });

  const cycle = findDependencyCycle(change);
  if (cycle) {
    throw new Error(`Change ${change.id} has a dependency cycle: ${cycle.join(" -> ")}`);
  }

  const client = new WorkerClient("http://local-control", control.fetch);

  // 1 + 2. Schedule WorkUnits in dependency order. Each wave is the set of units
  // that became runnable at once; units in a wave run concurrently.
  const waves: string[][] = [];
  const unitReports: UnitRunReport[] = [];
  const completed = new Set<string>();
  while (completed.size < change.work.length) {
    const wave = runnableUnits(change, completed);
    if (wave.length === 0) {
      // Not reachable for an acyclic graph, but guard against a stuck schedule.
      throw new Error(
        `Change ${change.id} stalled: no runnable WorkUnits with ${completed.size}/${change.work.length} complete`,
      );
    }
    waves.push([...wave]);
    emit({ kind: "wave-start", units: [...wave] });

    const results = await Promise.all(
      wave.map((unitId) =>
        runWorkUnit({
          client,
          executor,
          changeId: change.id,
          unitId,
          workRoot: worktreeRoot,
          identity,
        }),
      ),
    );
    for (let i = 0; i < wave.length; i += 1) {
      const unitId = wave[i] ?? "";
      const result = results[i] as RunWorkUnitResult;
      const unit = change.work.find((u) => u.id === unitId);
      const report: UnitRunReport = {
        unitId,
        objective: unit?.objective ?? "",
        workspaceName: result.workspaceName,
        backend: result.backend,
        fallback: result.fallback,
        commit: result.commit,
        changedPaths: result.changedPaths,
        costUsd: result.costUsd,
        executor: executor.name,
      };
      unitReports.push(report);
      completed.add(unitId);
      emit({ kind: "unit-done", report });
    }
  }

  // 3 + 4. Verify every completed WorkUnit, coordinate declared path collisions,
  // and integrate the verified work into a fresh integration workspace.
  emit({ kind: "verifying" });
  const completedInputs: CompletedWorkUnit[] = change.work.map((unit) => {
    const lease = control.leases(change.id).get(unit.id);
    if (!lease) {
      throw new Error(`missing lease for completed WorkUnit: ${unit.id}`);
    }
    return { unitId: unit.id, gitUrl: lease.ref.gitUrl, baselineRef: change.baseline };
  });

  const integrationRef = await workspaces.create(workspaceNameFor(change.id, "integration"), {
    defaultBranch: "main",
  });
  const integrationToken = await workspaces.issueWriteToken(integrationRef);
  await seedFromProject(integrationRef, options.projectDir, join(workRoot, "seed"), identity);

  const verification = new ChangeVerification(workspaces);
  const evidence = await verification.verifyAndIntegrate({
    change,
    completed: completedInputs,
    integrationRef,
    integrationToken: integrationToken.token,
    workRoot: worktreeRoot,
    identity,
  });

  // 5. Promote the integrated result into an ordinary local Git repository. We
  // clone the project into the work root first so the caller's tree is untouched.
  const sourceRepoDir = join(workRoot, "source");
  await cloneProject(options.projectDir, sourceRepoDir);
  const startPoint = await currentBranch(sourceRepoDir);
  emit({ kind: "promoting", branch: defaultBranch(change.id) });

  const delivery = new LocalGitDeliveryProvider({ workRoot: worktreeRoot });
  const promotion = await delivery.promote(
    {
      changeId: change.id,
      objective: change.objective,
      integrationGitUrl: integrationRef.gitUrl,
      integrationBranch: integrationRef.defaultBranch,
    },
    { repoDir: sourceRepoDir, startPoint, identity },
  );

  // 6. Expire the per-WorkUnit and integration workspaces.
  const changeWorkspaces: ChangeWorkspaces = {
    unitWorkspaces: change.work.map((unit) => {
      const lease = control.leases(change.id).get(unit.id);
      if (!lease) {
        throw new Error(`missing lease for ${unit.id}`);
      }
      return lease.ref;
    }),
    integrationWorkspace: integrationRef,
  };
  const cleanup = await cleanupWorkspaces(workspaces, changeWorkspaces);
  emit({ kind: "cleaned-up", archived: cleanup.archived });

  const offline = unitReports.every((r) => r.fallback) && integrationRef.fallback;

  return {
    changeId: change.id,
    objective: change.objective,
    executor: executor.name,
    offline,
    waves,
    units: unitReports,
    spentUsd: control.spentUsd(change.id),
    budgetUsd: change.budgetUsd,
    evidence,
    promotion,
    cleanup,
    sourceRepoDir,
  };
}

/** Expose the WorkGraph for a spec without running it (used by `status`). */
export function describeChange(specYaml: string): {
  readonly change: Change;
  readonly waves: readonly (readonly string[])[];
} {
  const control = new LocalChangeControl(
    new LocalFilesystemWorkspaceProvider({ rootDir: join(tmpdir(), "scf-describe-unused") }),
  );
  const change = control.createChange(specYaml);
  // Compute the scheduling waves without provisioning anything.
  const waves: string[][] = [];
  const completed = new Set<string>();
  const total = change.work.length;
  // Guard against cycles so a malformed spec does not loop forever.
  if (findDependencyCycle(change)) {
    return { change, waves: [buildWorkGraph(change).nodes] };
  }
  while (completed.size < total) {
    const wave = runnableUnits(change, completed);
    if (wave.length === 0) {
      break;
    }
    waves.push([...wave]);
    for (const id of wave) {
      completed.add(id);
    }
  }
  return { change, waves };
}

/**
 * Seed the integration workspace from the project baseline so integration and
 * promotion start from the real project tree, not an empty repo. We clone the
 * project (its tracked files), re-point it at the bare integration repo, and
 * push the baseline in.
 */
async function seedFromProject(
  ref: WorkspaceRef,
  projectDir: string,
  scratchRoot: string,
  identity: GitIdentity,
): Promise<void> {
  await mkdir(scratchRoot, { recursive: true });
  const work = await mkdtemp(join(scratchRoot, "seed-"));
  try {
    await cloneProject(projectDir, work);
    await run("git", [
      "-C",
      work,
      "-c",
      `user.name=${identity.name}`,
      "-c",
      `user.email=${identity.email}`,
      "push",
      ref.gitUrl,
      `HEAD:${ref.defaultBranch}`,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Clone a project directory into a fresh working repository. If the project is
 * its own Git repository root we clone it directly; otherwise (for example a
 * plain directory, or a subdirectory of some other repository) we initialize a
 * repo from its files so the baseline always has its own HEAD commit to build
 * on and the caller's tree is never touched.
 */
async function cloneProject(projectDir: string, targetDir: string): Promise<void> {
  if (await isGitRepoRoot(projectDir)) {
    await run("git", ["clone", projectDir, targetDir]);
    return;
  }
  await initRepoFromFiles(projectDir, targetDir);
}

/** True only when projectDir is the top level of its own Git repository. */
async function isGitRepoRoot(dir: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return resolvePath(stdout.trim()) === resolvePath(dir);
  } catch {
    return false;
  }
}

/** Initialize a Git repo in targetDir from the (non-Git) project files. */
async function initRepoFromFiles(projectDir: string, targetDir: string): Promise<void> {
  const { cp } = await import("node:fs/promises");
  const projectRoot = resolvePath(projectDir);
  const skip = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
  await mkdir(targetDir, { recursive: true });
  await cp(projectDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const rel = resolvePath(src).slice(projectRoot.length).replace(/^[/\\]/, "");
      if (rel === "") {
        return true;
      }
      const top = rel.split(/[/\\]/)[0] ?? "";
      if (skip.has(top)) {
        return false;
      }
      return !rel.endsWith(".tsbuildinfo");
    },
  });
  await run("git", ["-C", targetDir, "init", "--initial-branch=main"]);
  await run("git", ["-C", targetDir, "add", "-A"]);
  await run("git", [
    "-C",
    targetDir,
    "-c",
    "user.name=Switchyard Baseline",
    "-c",
    "user.email=baseline@switchyard.local",
    "commit",
    "--no-verify",
    "-m",
    "baseline",
  ]);
  // If the project had no files, make an empty baseline commit so HEAD exists.
  await ensureHead(targetDir);
}

async function ensureHead(dir: string): Promise<void> {
  try {
    await run("git", ["-C", dir, "rev-parse", "HEAD"]);
  } catch {
    await writeFile(join(dir, ".gitkeep"), "", "utf8");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", [
      "-C",
      dir,
      "-c",
      "user.name=Switchyard Baseline",
      "-c",
      "user.email=baseline@switchyard.local",
      "commit",
      "--no-verify",
      "-m",
      "baseline",
    ]);
  }
}

async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

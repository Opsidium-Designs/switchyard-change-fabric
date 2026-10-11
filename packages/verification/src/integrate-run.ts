/**
 * Run one integration job (see integrate-job.ts): the same verifier and
 * integrator the local driver uses, with the egress phases made explicit.
 *
 *   fetch  the integrator clones the integration repo and every unit's pinned
 *          commit, verifies each unit, composes the tree, restores the
 *          contract, and commits (only the Artifacts host is reachable);
 *   deps   the gated tree's dependencies are installed from its lockfile with
 *          install scripts off (only the package registry is reachable);
 *   gate   the gate runs (nothing is reachable);
 *   push   every process the install and the gate left is killed, then the
 *          integrator verifies the tree did not drift and pushes the gated
 *          commit from its trusted repo to the candidate ref (only the
 *          Artifacts host is reachable).
 * The job asks for each phase through `hooks.phase` and waits until the
 * orchestrator has moved the egress policy. Nothing here holds a credential:
 * every URL is tokenless, and the orchestrator's egress handler authenticates
 * the requests it allows.
 *
 * With `sandbox`, the install and the gate run as an unprivileged user (their
 * own uid: they cannot read the integrator's trusted repo, its memory, or its
 * protocol streams), capped at SANDBOX_MAX_PROCESSES processes (RLIMIT_NPROC),
 * with a HOME and temp dir of their own inside this job's root. Containment
 * (GateContainment) is enforced, never assumed:
 *   - before the job, whatever that user left anywhere outside the job root is
 *     removed, and the job refuses to start if anything remains;
 *   - after the install and after the gate, every process of that user is
 *     killed with kill(-1) issued AS that user (the kernel signals every
 *     process of the uid in one pass, so a respawning child cannot outrun it),
 *     and the job throws if one survives;
 *   - before any phase that opens credentialed egress (fetch, push), the job
 *     throws if any process of that user is alive.
 * A containment failure is an infrastructure failure: the result is refused
 * and transient (no verdict, and the push phase is never entered).
 *
 * Node only (the gate container's CLI and tests).
 */

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Change } from "@switchyard-change/change-core";
import type { WorkspaceProvider } from "@switchyard-change/artifact-workspace";

import { ChangeVerification, type CompletedWorkUnit } from "./change-verification.ts";
import { ChildProcessCommandRunner, type CommandOutcome, type CommandRunner, type CommandRunOptions } from "./command.ts";
import {
  dependencyInstallFailureLine,
  LockfileDependencyInstaller,
  type DependencyInstaller,
  type DependencyInstallOutcome,
} from "./dependency-install.ts";
import { gateFailureLine } from "./gate-failure.ts";
import { advanceIntegrationBranch, isPromotionRefused } from "./integrator.ts";
import {
  INTEGRATE_JOB_VERSION,
  scrubJobText,
  type AdvanceJob,
  type AdvanceJobResult,
  type EgressPhase,
  type GateJob,
  type GateJobResult,
  type IntegrateJob,
  type IntegrateJobResult,
  type JobPhaseRecord,
} from "./integrate-job.ts";
import { inventoryAfterContracts, readStreamInventory, type TestInventory } from "./test-inventory.ts";
import type { EvidenceSummary } from "./types.ts";

const run = promisify(execFile);

/** How the job asks the orchestrator for an egress phase. */
export interface GateJobHooks {
  /** Resolves once the orchestrator has put `phase`'s egress policy in force. */
  phase(phase: EgressPhase): Promise<void>;
}

/** The unprivileged user the install and the gate run as. */
export interface GateSandbox {
  readonly uid: number;
  readonly gid: number;
  /** A home directory that user owns. */
  readonly home: string;
}

/** Options for running a job. */
export interface RunGateJobOptions {
  /** Where checkouts are made (the gate support files are written here). */
  readonly workRoot: string;
  readonly hooks: GateJobHooks;
  readonly sandbox?: GateSandbox;
  /** The environment commands inherit from (allowlisted further by the runner). */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** Builds the runner a command runs through, for a timeout (tests inject a fake). */
  readonly commandRunner?: (timeoutMs: number, extraEnv: Readonly<Record<string, string>>) => CommandRunner;
  /** The dependency installer (default: the lockfile installer through the runner). */
  readonly installer?: DependencyInstaller;
  /**
   * How the sandbox user is contained (default with `sandbox`: the real one
   * over /proc and the filesystem; tests inject a fake).
   */
  readonly containment?: GateContainment;
  readonly now?: () => number;
}

/** A provider the integrator is constructed with; the job never provisions anything. */
const NO_PROVISIONING: WorkspaceProvider = new Proxy({} as WorkspaceProvider, {
  get() {
    return () => Promise.reject(new Error("an integration job does not provision workspaces"));
  },
});

/** Runs argv as the sandbox user (setpriv), with a home and temp dir that user owns. */
export class SandboxedCommandRunner implements CommandRunner {
  constructor(
    private readonly inner: CommandRunner,
    private readonly sandbox: GateSandbox,
    private readonly tempDir: string,
  ) {}

  run(argv: readonly string[], cwd: string, options?: CommandRunOptions): Promise<CommandOutcome> {
    const { uid, gid, home } = this.sandbox;
    return this.inner.run(
      [
        "setpriv",
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--clear-groups",
        "--no-new-privs",
        "--",
        "prlimit",
        `--nproc=${SANDBOX_MAX_PROCESSES}:${SANDBOX_MAX_PROCESSES}`,
        "--",
        "env",
        `HOME=${home}`,
        `TMPDIR=${this.tempDir}`,
        `TMP=${this.tempDir}`,
        `TEMP=${this.tempDir}`,
        ...argv,
      ],
      cwd,
      options,
    );
  }
}

/** The most processes the sandbox user may have at once (RLIMIT_NPROC): a fork bomb stalls, it does not grow. */
export const SANDBOX_MAX_PROCESSES = 512;

/** How the job keeps the sandbox user contained (injectable for tests). */
export interface GateContainment {
  /** Before the job: remove what the sandbox user left outside the job root; throw if anything remains. */
  scrub(): Promise<void>;
  /** Kill every process of the sandbox user; throw if one survives. Returns how many were alive. */
  reap(): Promise<number>;
  /** Throw if any process of the sandbox user is alive. */
  assertNone(): Promise<void>;
}

/** The live (not zombie) processes owned by `uid` (Linux /proc). A zombie cannot run anything. */
export async function userProcesses(uid: number): Promise<number[]> {
  const pids: number[] = [];
  const entries = await readdir("/proc").catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const status = await readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
    const owner = /^Uid:\s+(\d+)/m.exec(status);
    const state = /^State:\s+(\S)/m.exec(status);
    if (owner && Number(owner[1]) === uid && state?.[1] !== "Z" && state?.[1] !== "X") {
      pids.push(Number(entry));
    }
  }
  return pids;
}

/**
 * Kill every process owned by the sandbox user: kill(-1, SIGKILL) issued AS
 * that user signals every process of the uid in one kernel pass (a forking
 * child cannot outrun it), repeated until none is alive. Throws when one
 * survives, so the caller never moves on with a sandbox process alive.
 */
export async function reapSandbox(sandbox: Pick<GateSandbox, "uid" | "gid">): Promise<number> {
  const before = (await userProcesses(sandbox.uid)).length;
  for (let round = 0; round < 10; round += 1) {
    if ((await userProcesses(sandbox.uid)).length === 0) {
      return before;
    }
    await run("setpriv", [`--reuid=${sandbox.uid}`, `--regid=${sandbox.gid}`, "--clear-groups", "--", "bash", "-c", "kill -9 -1 2>/dev/null; exit 0"]).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const left = await userProcesses(sandbox.uid);
  if (left.length > 0) {
    throw new Error(`${left.length} sandbox process(es) survived the reap`);
  }
  return before;
}

/**
 * The real containment of a sandbox user. `writable` are the places that user
 * can write outside a job (its image home and the temp dirs: in the gate image
 * it can write nowhere else); everything it owns there is removed before a
 * job, and every leftover under the work root (a failed job's) is removed.
 * The job refuses to start if the user still owns anything there but its home
 * directory itself.
 */
export function sandboxContainment(sandbox: GateSandbox, places: { readonly writable: readonly string[]; readonly workRoot: string }): GateContainment {
  const assertNone = async (): Promise<void> => {
    const alive = await userProcesses(sandbox.uid);
    if (alive.length > 0) {
      throw new Error(`${alive.length} sandbox process(es) are alive before credentialed egress`);
    }
  };
  return {
    async scrub() {
      await reapSandbox(sandbox);
      for (const root of places.writable) {
        for (const entry of await readdir(root).catch(() => [] as string[])) {
          const path = join(root, entry);
          const info = await lstat(path).catch(() => undefined);
          if (info && info.uid === sandbox.uid) {
            await rm(path, { recursive: true, force: true });
          }
        }
      }
      // The work root holds only jobs (each removes its own root): a leftover is a failed job's.
      for (const entry of await readdir(places.workRoot).catch(() => [] as string[])) {
        await rm(join(places.workRoot, entry), { recursive: true, force: true });
      }
      const owned = new Set<string>();
      for (const root of [...places.writable, places.workRoot]) {
        const found = await run("find", [root, "-xdev", "(", "-path", "/proc", "-o", "-path", "/sys", ")", "-prune", "-o", "-user", String(sandbox.uid), "-print"], {
          maxBuffer: 4 * 1024 * 1024,
        }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
        for (const line of found.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "" && l !== sandbox.home)) {
          owned.add(line);
        }
      }
      if (owned.size > 0) {
        throw new Error(`the sandbox user still owns ${owned.size} path(s) before the job (for example ${[...owned].slice(0, 3).join(", ")})`);
      }
    },
    reap: () => reapSandbox(sandbox),
    assertNone,
  };
}

/**
 * The gate runner of a job: the first (and only) command the integrator runs
 * is the gate on the composed tree. Before it, the tree is handed to the
 * sandbox user and its dependencies are installed under the deps policy;
 * the gate runs under the gate policy; afterwards everything the sandbox user
 * left is killed and the push policy is asked for.
 */
class PhasedGateRunner implements CommandRunner {
  install: DependencyInstallOutcome | undefined;
  inventory: TestInventory | undefined;
  /** An egress phase that could not be entered, or containment that did not hold: nothing this job gated is recordable. */
  phaseFailure: string | undefined;
  /** Sandbox processes the reaps found alive (and killed). */
  reaped = 0;
  private ran = 0;

  constructor(
    private readonly gate: CommandRunner,
    private readonly installer: DependencyInstaller,
    private readonly enterPhase: (phase: EgressPhase) => Promise<void>,
    private readonly prepare: (dir: string) => Promise<void>,
    private readonly reapSandbox: () => Promise<number>,
  ) {}

  private async reap(): Promise<void> {
    try {
      this.reaped += await this.reapSandbox();
    } catch (error) {
      this.phaseFailure ??= `sandbox containment failed: ${message(error)}`;
      throw error;
    }
  }

  async run(argv: readonly string[], cwd: string, options: CommandRunOptions = {}): Promise<CommandOutcome> {
    this.ran += 1;
    if (this.ran > 1) {
      // One gate per revision: a second command would run outside the phases.
      return { code: null, stdout: "", stderr: "an integration job runs exactly one gate command" };
    }
    await this.prepare(cwd);
    await this.enter("deps");
    let outcome: CommandOutcome;
    try {
      const install = await this.installer.install(cwd, options);
      this.install = install;
      await this.reap();
      await this.enter("gate");
      outcome = install.status === "failed" ? { code: 1, stdout: "", stderr: dependencyInstallFailureLine(install) } : await this.gate.run(argv, cwd, options);
    } finally {
      // Nothing the install or the gate started survives into the push phase.
      await this.reap();
    }
    this.inventory = readStreamInventory(outcome.stdout, outcome.stderr);
    await this.enter("push");
    return outcome;
  }

  private async enter(phase: EgressPhase): Promise<void> {
    try {
      await this.enterPhase(phase);
    } catch (error) {
      this.phaseFailure ??= `the ${phase} egress phase could not be entered: ${message(error)}`;
      throw error;
    }
  }
}

/** The places the gate image's sandbox user can write outside a job. */
function defaultContainment(sandbox: GateSandbox, workRoot: string): GateContainment {
  return sandboxContainment(sandbox, { writable: ["/tmp", "/var/tmp", "/dev/shm", "/run/lock", sandbox.home], workRoot });
}

/** Run a job and return its result (never throws for a job-level failure). */
export async function runGateJob(job: GateJob, options: RunGateJobOptions): Promise<GateJobResult> {
  return job.kind === "advance" ? runAdvanceJob(job, options) : runIntegrateJob(job, options);
}

function phaseTracker(
  options: RunGateJobOptions,
  containment?: GateContainment,
): { readonly phases: JobPhaseRecord[]; enter(phase: EgressPhase): Promise<void> } {
  const phases: JobPhaseRecord[] = [];
  return {
    phases,
    async enter(phase: EgressPhase) {
      if (phases.at(-1)?.phase === phase) {
        return;
      }
      if (phase === "fetch" || phase === "push") {
        // Credentialed egress opens only with no sandbox process alive.
        await containment?.assertNone();
      }
      await options.hooks.phase(phase);
      phases.push({ phase, at: new Date((options.now ?? Date.now)()).toISOString() });
    },
  };
}

function message(error: unknown): string {
  return scrubJobText(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** Fast-forward the integration branch to a recorded passing revision (Artifacts egress only). */
export async function runAdvanceJob(job: AdvanceJob, options: RunGateJobOptions): Promise<AdvanceJobResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const tracker = phaseTracker(options, options.containment ?? (options.sandbox ? defaultContainment(options.sandbox, options.workRoot) : undefined));
  try {
    await tracker.enter("push");
    await mkdir(options.workRoot, { recursive: true });
    await advanceIntegrationBranch(
      { id: "", name: "integration", gitUrl: job.integration.repoUrl, defaultBranch: job.integration.defaultBranch, backend: "cloudflare-artifacts", fallback: false },
      "",
      job.commit,
      options.workRoot,
      job.expectedBase !== undefined ? { expectedBase: job.expectedBase } : {},
    );
    return { version: INTEGRATE_JOB_VERSION, kind: "advance", advanced: true, commit: job.commit, phases: tracker.phases, durationMs: now() - started };
  } catch (error) {
    return {
      version: INTEGRATE_JOB_VERSION,
      kind: "advance",
      advanced: false,
      commit: job.commit,
      phases: tracker.phases,
      error: message(error),
      // A lost compare-and-swap is a named outcome, not a generic error.
      ...(isPromotionRefused(error)
        ? {
            refused: {
              reason: error.reason,
              expected: error.expected,
              ...(error.actual !== undefined ? { actual: error.actual } : {}),
            },
          }
        : {}),
      durationMs: now() - started,
    };
  }
}

/** Build one gated revision from the job's pinned pushes. */
export async function runIntegrateJob(job: IntegrateJob, options: RunGateJobOptions): Promise<IntegrateJobResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const containment =
    options.containment ??
    (options.sandbox ? defaultContainment(options.sandbox, options.workRoot) : undefined);
  const tracker = phaseTracker(options, containment);
  const refused = (error: string, evidence?: EvidenceSummary, transient = false): IntegrateJobResult => ({
    version: INTEGRATE_JOB_VERSION,
    kind: "integrate",
    outcome: "refused",
    error,
    ...(transient ? { transient: true } : {}),
    ...(evidence ? { evidence } : {}),
    phases: tracker.phases,
    durationMs: now() - started,
  });

  await mkdir(options.workRoot, { recursive: true });
  if (containment) {
    try {
      // Nothing an earlier job's sandbox left may reach this one.
      await containment.scrub();
    } catch (error) {
      return refused(`sandbox containment failed before the job: ${message(error)}`, undefined, true);
    }
  }
  const jobRoot = await mkdtemp(join(options.workRoot, "job-"));
  // Traversable by the sandbox user (the checkouts below are handed to it).
  await chmod(jobRoot, 0o755);
  // Checkouts are made one level below the job root, so a gate that imports a
  // shared harness from `../../<file>` (beside the app) resolves it here.
  const worktreeRoot = join(jobRoot, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  try {
    await tracker.enter("fetch");
    for (const file of job.gateSupportFiles ?? []) {
      await writeFile(join(worktreeRoot, file.name), file.content);
    }

    const sandbox = options.sandbox;
    const sandboxTemp = join(jobRoot, "sandbox-tmp");
    // The sandbox user's HOME for this job only (never the image's home).
    const sandboxHome = join(jobRoot, "sandbox-home");
    await mkdir(sandboxHome, { recursive: true });
    const packageCache = join(jobRoot, "package-cache");
    await mkdir(sandboxTemp, { recursive: true });
    await mkdir(packageCache, { recursive: true });
    const handTo = async (path: string): Promise<void> => {
      if (sandbox) {
        await run("chown", ["-R", `${sandbox.uid}:${sandbox.gid}`, path]);
      }
    };
    await handTo(sandboxTemp);
    await handTo(sandboxHome);
    await handTo(packageCache);

    const parentEnv = options.parentEnv ?? process.env;
    const makeRunner = (timeoutMs: number, extraEnv: Readonly<Record<string, string>>): CommandRunner => {
      const inner = options.commandRunner
        ? options.commandRunner(timeoutMs, extraEnv)
        : new ChildProcessCommandRunner({ timeoutMs, parentEnv: { ...parentEnv, ...extraEnv } });
      return sandbox ? new SandboxedCommandRunner(inner, { ...sandbox, home: sandboxHome }, sandboxTemp) : inner;
    };
    const installer =
      options.installer ??
      new LockfileDependencyInstaller({
        runner: makeRunner(job.timeouts.installMs, { npm_config_cache: packageCache }),
        timeoutMs: job.timeouts.installMs,
        cacheDir: packageCache,
      });
    const gateRunner = new PhasedGateRunner(
      makeRunner(job.timeouts.gateMs, { npm_config_cache: packageCache }),
      installer,
      (phase) => tracker.enter(phase),
      handTo,
      async () => (containment ? containment.reap() : 0),
    );

    const requiresIntegrationGate = Boolean(job.gateCommand && job.gateCommand.length > 0) || job.requireGate;
    const change: Change = {
      id: job.changeId,
      objective: job.objective,
      baseline: "HEAD",
      budgetUsd: 0,
      assurance: "standard",
      work: job.units.map((u) => ({
        id: u.agent,
        objective: `the announced pushes of ${u.agent} (items ${u.items.join(", ")})`,
        dependsOn: [],
        paths: [...u.scope],
      })),
    };
    const completed: CompletedWorkUnit[] = job.units.map((u) => ({
      unitId: u.agent,
      gitUrl: u.repoUrl,
      baselineRef: u.baselineRef,
      commit: u.commit,
      includes: [...u.includes],
      ...(u.yieldedScope ? { yieldedScope: [...u.yieldedScope] } : {}),
      ...(u.releasedPaths ? { releasedPaths: [...u.releasedPaths] } : {}),
      ...(u.parts ? { parts: u.parts.map((p) => ({ item: p.item, commit: p.commit, baselineRef: p.baselineRef, scope: [...p.scope] })) } : {}),
    }));
    const adjusted = job.testInventory ? inventoryAfterContracts(job.testInventory, [...(job.acceptedContracts ?? [])]) : {};
    const verification = new ChangeVerification(NO_PROVISIONING, { commandRunner: gateRunner });
    let evidence: EvidenceSummary;
    try {
      evidence = await verification.verifyAndIntegrate({
        change,
        completed,
        integrationRef: {
          id: "",
          name: "integration",
          gitUrl: job.integration.repoUrl,
          defaultBranch: job.integration.defaultBranch,
          backend: "cloudflare-artifacts",
          fallback: false,
        },
        // No credential: the orchestrator's egress handler authenticates.
        integrationToken: "",
        ...(requiresIntegrationGate
          ? {
              ...(job.gateCommand && job.gateCommand.length > 0 ? { integrationGateCommand: job.gateCommand } : {}),
              requiresIntegrationGate,
            }
          : {}),
        ...(job.protectedPaths.length > 0 || job.protectedJsonKeys.length > 0
          ? { protectedPaths: job.protectedPaths, protectedJsonKeys: job.protectedJsonKeys, onProtectedChange: "fail" as const }
          : {}),
        ...(adjusted.inventory ? { testInventory: adjusted.inventory } : {}),
        ...(job.baseCommit !== undefined ? { integrationBaseCommit: job.baseCommit } : {}),
        deferIntegrationPush: true,
        workRoot: worktreeRoot,
        ...(job.identity ? { identity: job.identity } : {}),
      });
    } catch (error) {
      return gateRunner.phaseFailure !== undefined ? refused(gateRunner.phaseFailure, undefined, true) : refused(`the integrator refused: ${message(error)}`);
    }
    if (gateRunner.phaseFailure !== undefined) {
      // The gate's verdict says nothing when the phases did not hold.
      return refused(gateRunner.phaseFailure, undefined, true);
    }
    const excluded = evidence.units
      .filter((u) => u.verdict !== "verified")
      .map((u) => `${u.unitId}: failed verification (${u.checks.filter((c) => !c.passed && !c.skipped).map((c) => `${c.kind}: ${c.summary}`).join("; ") || "verdict failed"})`);
    if (evidence.units.every((u) => u.verdict !== "verified")) {
      // Nothing an agent pushed is in the gated tree: no revision to record.
      return refused(scrubJobText(`every pending push was excluded: ${excluded.join("; ")}`).slice(0, 2000), scrubEvidence(evidence));
    }
    const commit = evidence.integration.commit;
    if (commit === undefined) {
      return refused("the integrator reported no commit for the gated tree", evidence);
    }
    const check = evidence.integration.finalCheck;
    const gate: "pass" | "fail" = evidence.integration.verdict === "verified" ? "pass" : "fail";
    const failureLine =
      gate === "fail"
        ? (/exited 0 but/.test(check.summary) ? undefined : gateFailureLine(check.outputs.map((o) => o.text).join("\n"))) ?? check.summary
        : undefined;
    const install = check.skipped ? undefined : gateRunner.install;
    return {
      version: INTEGRATE_JOB_VERSION,
      kind: "integrate",
      outcome: "gated",
      verdict: evidence.integration.verdict,
      gate,
      gated: !(gate === "pass" && check.skipped),
      commit,
      ...(failureLine !== undefined ? { failureLine: scrubJobText(failureLine).slice(0, 500) } : {}),
      evidence: scrubEvidence(evidence),
      ...(install ? { install: { status: install.status, ...(install.tool ? { tool: install.tool } : {}), detail: scrubJobText(install.detail), durationMs: install.durationMs } } : {}),
      ...(gateRunner.inventory ? { inventory: { format: gateRunner.inventory.format, count: gateRunner.inventory.count } } : {}),
      ...(adjusted.relaxed !== undefined ? { inventoryNote: adjusted.relaxed } : {}),
      ...(gateRunner.reaped > 0 ? { sandboxReaped: gateRunner.reaped } : {}),
      phases: tracker.phases,
      durationMs: now() - started,
    };
  } catch (error) {
    return refused(`the integration job failed: ${message(error)}`, undefined, true);
  } finally {
    await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The evidence with every text field scrubbed (it leaves the container). */
function scrubEvidence(evidence: EvidenceSummary): EvidenceSummary {
  return JSON.parse(JSON.stringify(evidence), (_key, value: unknown) => (typeof value === "string" ? scrubJobText(value) : value)) as EvidenceSummary;
}

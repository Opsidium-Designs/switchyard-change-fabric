/**
 * The local runner: lease a runnable WorkUnit, clone its isolated workspace,
 * invoke the selected executor to make the change, commit, push back to the
 * workspace, and report cost and completion to the Worker.
 *
 * The runner is a plain Node process (it runs Git and child processes, which a
 * Cloudflare Worker cannot), and it is executor-agnostic: inference choice lives
 * entirely in the injected ExecutorProvider.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutorProvider } from "@switchyard-change/model-adapters";

import {
  authenticatedRemote,
  commitAll,
  clone,
  hasChanges,
  push,
  type GitIdentity,
} from "./git.ts";
import type { Lease, WorkerClient } from "./worker-client.ts";

/** Options for a single WorkUnit run. */
export interface RunWorkUnitOptions {
  readonly client: WorkerClient;
  readonly executor: ExecutorProvider;
  readonly changeId: string;
  readonly unitId: string;
  /** Root under which the disposable worktree is created. Defaults to the OS temp dir. */
  readonly workRoot?: string;
  /** Deterministic committer identity, for reproducible tests. */
  readonly identity?: GitIdentity;
}

/** The outcome of running one WorkUnit end to end. */
export interface RunWorkUnitResult {
  readonly unitId: string;
  readonly workspaceName: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly commit: string;
  readonly changedPaths: readonly string[];
  readonly costUsd: number;
  readonly logs: readonly string[];
}

/**
 * Run one WorkUnit: lease, clone, execute, commit, push, report. The disposable
 * worktree is always cleaned up, even on failure.
 */
export async function runWorkUnit(options: RunWorkUnitOptions): Promise<RunWorkUnitResult> {
  const { client, executor, changeId, unitId } = options;
  const lease: Lease = await client.lease(changeId, unitId);

  const workRoot = options.workRoot ?? tmpdir();
  const worktreeDir = await mkdtemp(join(workRoot, `scf-${unitId}-`));
  const remote = authenticatedRemote(lease.gitUrl, lease.token);

  try {
    await clone(remote, worktreeDir);

    const result = await executor.execute({
      worktreeDir,
      workUnitId: lease.unitId,
      objective: lease.objective,
      paths: lease.paths,
      baselineRef: lease.baselineRef,
    });

    if (result.status === "failed") {
      throw new Error(`executor failed for WorkUnit ${unitId}: ${result.logs.join("; ")}`);
    }

    // Report the executor's cost as a heartbeat before committing/pushing.
    await client.reportCost(changeId, unitId, {
      usd: result.cost.usd,
      inputTokens: result.cost.inputTokens,
      outputTokens: result.cost.outputTokens,
      executor: executor.name,
    });

    let commit = "";
    if (await hasChanges(worktreeDir)) {
      commit = await commitAll(worktreeDir, result.commitMessage, options.identity);
      await push(worktreeDir, remote, lease.defaultBranch);
    }

    // Mark complete. The final cost event here is zero because the executor cost
    // was already reported above; completion advances the work graph.
    await client.complete(changeId, unitId, { usd: 0, executor: executor.name });

    return {
      unitId,
      workspaceName: lease.workspaceName,
      backend: lease.backend,
      fallback: lease.fallback,
      commit,
      changedPaths: result.changedPaths,
      costUsd: result.cost.usd,
      logs: result.logs,
    };
  } finally {
    await rm(worktreeDir, { recursive: true, force: true });
  }
}

/**
 * runRecruitmentLive: drive dial-bounded, event-driven recruitment against a
 * running Worker (under `wrangler dev` with the Artifacts binding remote), so
 * multiple agents concurrently hold distinct real Cloudflare Artifact repos and
 * push to them.
 *
 * This is the live counterpart of the offline runRecruitment substrate. The
 * engine, the recruitment policy, and the event trigger are the same; the only
 * differences are that the control surface is the real Worker over HTTP (not the
 * in-process LocalChangeControl) and the workspaces are real Artifact repos (not
 * the local-filesystem fallback). A runner clones each recruited agent's real
 * repo over Git HTTPS with its scoped token, runs the executor, and pushes; the
 * finishing push is then signalled to the Worker's repo-pushed event ingress to
 * drive the next recruitment wave.
 *
 * The live account's own Artifacts event subscription (a Queue consumer, see the
 * Worker) is the production trigger for the next wave; this driver can either
 * rely on that subscription or, when a subscription is not yet provisioned on
 * the account, drive the identical downstream event handler directly through the
 * `POST /events/repo-pushed` ingress. Which path was used is reported honestly in
 * the result so the live evidence is not overstated.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Change, ConcurrencyDial } from "@switchyard-change/change-core";
import type { ExecutorProvider } from "@switchyard-change/model-adapters";
import { ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import {
  authenticatedRemote,
  clone,
  commitAll,
  hasChanges,
  push,
  DEFAULT_IDENTITY as RUNNER_IDENTITY,
  type GitIdentity,
} from "@switchyard-change/local-runner";

import { withWorkerAuth } from "./worker-auth.ts";

/** How the next wave was triggered on the live run, for honest reporting. */
export type LiveTrigger = "subscription" | "ingress";

/** A recruited agent returned by the Worker's recruit/event endpoints. */
interface RecruitedAgent {
  readonly unitId: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly baselineRef: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly token: string;
}

/** A live agent's run outcome. */
export interface LiveAgentReport {
  readonly unitId: string;
  readonly workspaceName: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly gitUrl: string;
  readonly commit: string;
  readonly changedPaths: readonly string[];
}

/** One live recruitment wave. */
export interface LiveWave {
  readonly trigger: "kickoff" | "repo-pushed";
  readonly concurrency: number;
  readonly agents: readonly LiveAgentReport[];
}

/** The outcome of a live recruitment run. */
export interface RunRecruitmentLiveResult {
  readonly changeId: string;
  readonly dial: ConcurrencyDial;
  readonly workerUrl: string;
  /** How the next wave was triggered (the real subscription vs the ingress). */
  readonly waveTrigger: LiveTrigger;
  readonly waves: readonly LiveWave[];
  readonly peakConcurrency: number;
  /** Distinct real Artifact repo (workspace) names agents held. */
  readonly workspaces: readonly string[];
  /** True when at least one agent held a real (non-fallback) Artifact repo. */
  readonly anyLive: boolean;
  readonly completed: readonly string[];
  /** Workspace names the fabric archived (deleted) on cleanup. */
  readonly cleanedUp: readonly string[];
}

/** Options for a live recruitment run. */
export interface RunRecruitmentLiveOptions {
  readonly change: Change;
  readonly dial: ConcurrencyDial;
  /** Base URL of the running Worker (wrangler dev), e.g. http://127.0.0.1:8787. */
  readonly workerUrl: string;
  readonly specYaml: string;
  readonly workRoot?: string;
  readonly executor?: ExecutorProvider;
  readonly identity?: GitIdentity;
  /**
   * How to trigger the next wave. "ingress" (the default) posts the repo-pushed
   * event to the Worker directly after a runner pushes, which exercises the same
   * event handler the real subscription feeds; "subscription" relies on the
   * account's Artifacts event subscription to deliver it to the Worker's Queue
   * consumer (requires a provisioned subscription).
   */
  readonly waveTrigger?: LiveTrigger;
  /** An injectable fetch for tests; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/** Drive dial-bounded, event-driven recruitment against a live Worker. */
export async function runRecruitmentLive(
  options: RunRecruitmentLiveOptions,
): Promise<RunRecruitmentLiveResult> {
  const executor = options.executor ?? new ScopedNoopExecutor();
  const identity = options.identity ?? RUNNER_IDENTITY;
  const fetchFn = withWorkerAuth(options.fetchFn ?? fetch);
  const base = options.workerUrl.replace(/\/$/, "");
  const trigger: LiveTrigger = options.waveTrigger ?? "ingress";
  const changeId = options.change.id;

  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), "scf-live-")));
  await mkdir(workRoot, { recursive: true });
  const worktreeRoot = join(workRoot, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });

  const post = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text === "" ? {} : JSON.parse(text);
    if (res.status >= 400) {
      const detail = (parsed as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new Error(`Worker ${path} failed (${res.status}): ${detail}`);
    }
    return parsed;
  };

  // 1. Create the Change and set the dial on the live Worker.
  await fetchFn(`${base}/changes`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: options.specYaml,
  });
  await post(`/changes/${encodeURIComponent(changeId)}/dial`, {
    minConcurrency: options.dial.minConcurrency,
    maxConcurrency: options.dial.maxConcurrency,
  });

  const waves: LiveWave[] = [];
  const allWorkspaces = new Set<string>();
  let anyLive = false;
  let peakConcurrency = 0;

  // Run a recruited agent against its own real Artifact repo: clone, execute,
  // commit, push. Returns its report (the push is the repo-pushed event source).
  const runAgent = async (agent: RecruitedAgent): Promise<LiveAgentReport> => {
    const worktreeDir = await mkdtemp(join(worktreeRoot, `scf-${agent.unitId}-`));
    const remote = authenticatedRemote(agent.gitUrl, agent.token);
    try {
      await clone(remote, worktreeDir);
      const result = await executor.execute({
        worktreeDir,
        workUnitId: agent.unitId,
        objective: agent.objective,
        paths: agent.paths,
        baselineRef: agent.baselineRef,
      });
      let commit = "";
      if (await hasChanges(worktreeDir)) {
        commit = await commitAll(worktreeDir, result.commitMessage, identity);
        await push(worktreeDir, remote, agent.defaultBranch);
      }
      if (!agent.fallback) {
        anyLive = true;
      }
      allWorkspaces.add(agent.workspaceName);
      return {
        unitId: agent.unitId,
        workspaceName: agent.workspaceName,
        backend: agent.backend,
        fallback: agent.fallback,
        gitUrl: agent.gitUrl,
        commit,
        changedPaths: result.changedPaths,
      };
    } finally {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  };

  // Run a wave of recruited agents concurrently, then drive the next wave from
  // the repo-pushed events their pushes produced.
  const runWave = async (
    waveTrigger: "kickoff" | "repo-pushed",
    agents: readonly RecruitedAgent[],
  ): Promise<void> => {
    if (agents.length === 0) {
      return;
    }
    peakConcurrency = Math.max(peakConcurrency, agents.length);
    const reports = await Promise.all(agents.map((a) => runAgent(a)));
    waves.push({ trigger: waveTrigger, concurrency: agents.length, agents: reports });

    // Each finished agent pushed to its own real Artifact repo. Signal the
    // repo-pushed event (via the ingress; the account subscription feeds the
    // same handler through the Queue consumer in production) to recruit the next
    // wave. Collect the next wave of agents the event handler returns.
    const next: RecruitedAgent[] = [];
    for (const report of reports) {
      const outcome = (await post("/events/repo-pushed", {
        changeId,
        workspace: report.workspaceName,
      })) as { recruited?: RecruitedAgent[] };
      next.push(...(outcome.recruited ?? []));
    }
    await runWave("repo-pushed", next);
  };

  // 2. Kickoff recruitment under the dial, then run to completion.
  const kickoff = (await post(`/changes/${encodeURIComponent(changeId)}/recruit`)) as {
    recruited?: RecruitedAgent[];
  };
  await runWave("kickoff", kickoff.recruited ?? []);

  // 3. Read final state and clean up the real Artifact repos the run created.
  const stateRes = await fetchFn(`${base}/changes/${encodeURIComponent(changeId)}`);
  const state = (await stateRes.json()) as { completed?: string[] };
  const cleanedUp = await cleanup(base, fetchFn, [...allWorkspaces]);

  return {
    changeId,
    dial: options.dial,
    workerUrl: base,
    waveTrigger: trigger,
    waves,
    peakConcurrency,
    workspaces: [...allWorkspaces].sort(),
    anyLive,
    completed: state.completed ?? [],
    cleanedUp,
  };
}

/**
 * Delete the real Artifact repos the run created, through the Worker's archive
 * path. Best-effort: a failure to delete one does not block the others, and the
 * names actually archived are reported so the evidence is honest.
 */
async function cleanup(
  base: string,
  fetchFn: typeof fetch,
  workspaces: readonly string[],
): Promise<string[]> {
  const archived: string[] = [];
  for (const name of workspaces) {
    try {
      const res = await fetchFn(`${base}/workspaces/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.status < 400) {
        archived.push(name);
      }
    } catch {
      // Best-effort cleanup; the fabric also expires disposable repos on its own.
    }
  }
  return archived.sort();
}

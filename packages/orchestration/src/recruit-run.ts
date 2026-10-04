/**
 * runRecruitment: drive a Change through evidence-governed, dial-bounded agent
 * recruitment where each wave after the first is triggered by a repo-pushed
 * event, not a poll or a timer.
 *
 * This is the offline, deterministic substrate for the live recruitment path
 * the Worker runs under `wrangler dev` with real Artifacts. It uses the honest
 * local-filesystem workspace provider and the deterministic noop executor, so
 * `make check` exercises the whole recruitment and event loop with no Cloudflare
 * account and no inference, and the same inputs always produce the same trace.
 *
 * The shared contract with the live path is the recruitment policy and the
 * event trigger:
 *   - recruitment is `recruit()` from change-core, a bounded window over the
 *     runnable set under a min/max dial. The engine never recruits a hardcoded
 *     count; raising the dial max widens the window through that one function.
 *   - the next wave is driven by a repo-pushed event. Here a runner pushing to
 *     its own workspace synthesizes a `repo.pushed` event that is handed to the
 *     SAME event handler the live Queue consumer calls (recordRepoPushed), which
 *     completes the pushing unit and recruits the next wave. Swapping the fake
 *     event for the real queued one is the only difference live.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Change, ConcurrencyDial } from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { ExecutorProvider } from "@switchyard-change/model-adapters";
import { ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import {
  runWorkUnit,
  WorkerClient,
  DEFAULT_IDENTITY as RUNNER_IDENTITY,
  type GitIdentity,
} from "@switchyard-change/local-runner";

import {
  LocalChangeControl,
  type RecruitmentEvent,
} from "./local-control.ts";

/** A repo-pushed event: the trigger that drives the next recruitment wave. */
export interface RepoPushedEvent {
  readonly type: "repo.pushed";
  readonly changeId: string;
  /** The backend workspace (Artifact repo) name that was pushed. */
  readonly workspace: string;
}

/** A recruited agent's run outcome, recorded for the trace. */
export interface AgentRunReport {
  readonly unitId: string;
  readonly workspaceName: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly commit: string;
  readonly changedPaths: readonly string[];
}

/** One recruitment wave: what triggered it and which agents it recruited. */
export interface RecruitmentWave {
  readonly trigger: "kickoff" | "repo-pushed";
  /** Number of agents in flight at once during this wave. */
  readonly concurrency: number;
  readonly agents: readonly AgentRunReport[];
}

/** The full trace of a dial-bounded, event-driven recruitment run. */
export interface RunRecruitmentResult {
  readonly changeId: string;
  readonly dial: ConcurrencyDial;
  /** True when every workspace used the honest local fallback. */
  readonly offline: boolean;
  /** The recruitment waves in the order they were triggered. */
  readonly waves: readonly RecruitmentWave[];
  /** The peak number of agents that held a workspace at once across the run. */
  readonly peakConcurrency: number;
  /** The distinct workspace names provisioned (one per recruited agent). */
  readonly workspaces: readonly string[];
  /** Every WorkUnit id completed, in completion order. */
  readonly completed: readonly string[];
  /** The inspectable recruitment-event log (why/what triggered each wave). */
  readonly recruitments: readonly RecruitmentEvent[];
  /** The repo-pushed events that drove the non-kickoff waves. */
  readonly pushEvents: readonly RepoPushedEvent[];
}

/** Options for an offline recruitment run. */
export interface RunRecruitmentOptions {
  readonly change: Change;
  readonly dial: ConcurrencyDial;
  readonly workRoot?: string;
  readonly executor?: ExecutorProvider;
  readonly identity?: GitIdentity;
}

/**
 * Run dial-bounded recruitment to completion offline, driving each wave after
 * the first from a synthesized repo-pushed event through the shared event
 * handler. Returns the trace, including the peak concurrency actually reached
 * (so a wider dial is observably wider) and the push events that drove the run.
 */
export async function runRecruitment(
  options: RunRecruitmentOptions,
): Promise<RunRecruitmentResult> {
  const executor = options.executor ?? new ScopedNoopExecutor();
  const identity = options.identity ?? RUNNER_IDENTITY;
  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), "scf-recruit-")));
  await mkdir(workRoot, { recursive: true });

  const artifactsRoot = join(workRoot, "artifacts");
  const worktreeRoot = join(workRoot, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });

  const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: artifactsRoot });
  const control = new LocalChangeControl(workspaces);
  const changeId = options.change.id;
  // Create the Change in the control surface from its spec. We round-trip through
  // the loader so the offline substrate holds the identical parsed Change.
  control.createChange(serializeChange(options.change));
  const dial = control.configureDial(changeId, options.dial);

  const client = new WorkerClient("http://local-control", control.fetch);

  const waves: RecruitmentWave[] = [];
  const pushEvents: RepoPushedEvent[] = [];
  const allWorkspaces = new Set<string>();
  let peakConcurrency = 0;

  /**
   * Recruit and run one wave: provision a workspace per recruited unit (each
   * agent gets its OWN workspace), run all recruited agents concurrently, and
   * record the recruitment event. Returns the push events the finished agents
   * emit, which drive the next wave.
   */
  const runWave = async (
    trigger: "kickoff" | "repo-pushed",
    unitIds: readonly string[],
    inFlightBefore: number,
    pushContext?: { readonly pushedWorkspace: string; readonly completedUnit: string | null },
  ): Promise<RepoPushedEvent[]> => {
    if (unitIds.length === 0) {
      return [];
    }
    const plan = control.planRecruitment(changeId);
    control.recordRecruitment(changeId, {
      trigger,
      pushedWorkspace: pushContext?.pushedWorkspace,
      completedUnit: pushContext?.completedUnit ?? undefined,
      recruited: unitIds,
      ceiling: plan.ceiling,
      inFlightAfter: inFlightBefore + unitIds.length,
    });

    // All recruited agents run concurrently, each in its own workspace. The peak
    // concurrency reached is the observable effect of the dial width.
    peakConcurrency = Math.max(peakConcurrency, inFlightBefore + unitIds.length);

    const agents = await Promise.all(
      unitIds.map(async (unitId) => {
        const result = await runWorkUnit({
          client,
          executor,
          changeId,
          unitId,
          workRoot: worktreeRoot,
          identity,
        });
        allWorkspaces.add(result.workspaceName);
        const report: AgentRunReport = {
          unitId,
          workspaceName: result.workspaceName,
          backend: result.backend,
          fallback: result.fallback,
          commit: result.commit,
          changedPaths: result.changedPaths,
        };
        return report;
      }),
    );

    waves.push({ trigger, concurrency: inFlightBefore + unitIds.length, agents });

    // Each finished agent pushed to its own workspace: synthesize the repo-pushed
    // event that drives the next wave. In the live path this event is delivered
    // by the Artifacts event subscription to the Worker's Queue consumer.
    return agents.map((agent) => ({
      type: "repo.pushed" as const,
      changeId,
      workspace: agent.workspaceName,
    }));
  };

  // The runWorkUnit helper leases, runs, and completes the unit itself, which
  // marks it complete in the control surface. To keep the EVENT (not the
  // completion call) the trigger for the next wave, we recruit the kickoff wave,
  // then for every push event ingest it through recordRepoPushed and recruit the
  // next wave from the plan that event produces. The completion is idempotent,
  // so ingesting the event after the runner already completed the unit is safe
  // and the recruitment decision is still driven by the event arrival.

  // Kickoff: recruit the first wave under the dial.
  const kickoff = control.planRecruitment(changeId);
  let pending: RepoPushedEvent[] = await runWave("kickoff", kickoff.recruit, 0);

  // Event loop: drain push events, each driving the next recruitment wave. There
  // is no poll and no timer here: the loop advances only when an event arrives.
  while (pending.length > 0) {
    const nextPending: RepoPushedEvent[] = [];
    for (const event of pending) {
      pushEvents.push(event);
      // The shared event handler: complete the pushing unit and recruit the next
      // wave under the dial over the now-wider runnable set.
      const outcome = control.recordRepoPushed(changeId, event.workspace);
      const inFlightBefore = control.planRecruitment(changeId).inFlight;
      const produced = await runWave("repo-pushed", outcome.recruited, inFlightBefore, {
        pushedWorkspace: event.workspace,
        completedUnit: outcome.completedUnit,
      });
      nextPending.push(...produced);
    }
    pending = nextPending;
  }

  const completed = control.completed(changeId);
  const offline =
    [...allWorkspaces].length > 0 && waves.every((w) => w.agents.every((a) => a.fallback));

  return {
    changeId,
    dial,
    offline,
    waves,
    peakConcurrency,
    workspaces: [...allWorkspaces].sort(),
    completed,
    recruitments: control.recruitments(changeId),
    pushEvents,
  };
}

/**
 * Serialize a parsed Change back to spec YAML so the control surface can parse
 * it with the same loader the HTTP path uses. Kept local and minimal: it mirrors
 * changeToSpecYaml in decompose-goal without importing it, so this module has no
 * dependency on the decomposition path.
 */
function serializeChange(change: Change): string {
  const lines: string[] = [];
  lines.push(`id: ${change.id}`);
  lines.push(`objective: ${quote(change.objective)}`);
  lines.push(`baseline: ${change.baseline}`);
  lines.push(`budget_usd: ${change.budgetUsd}`);
  lines.push(`assurance: ${change.assurance}`);
  lines.push("work:");
  for (const unit of change.work) {
    lines.push(`  - id: ${unit.id}`);
    lines.push(`    objective: ${quote(unit.objective)}`);
    if (unit.dependsOn.length > 0) {
      lines.push("    depends_on:");
      for (const dep of unit.dependsOn) {
        lines.push(`      - ${dep}`);
      }
    }
    lines.push("    paths:");
    for (const path of unit.paths) {
      lines.push(`      - ${quote(path)}`);
    }
  }
  return lines.join("\n");
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Remove a disposable work root, for callers that own the root. */
export async function cleanupRunRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

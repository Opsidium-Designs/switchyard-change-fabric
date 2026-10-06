/**
 * runFullLive: the full end-to-end live run of the Change Fabric.
 *
 * It takes a decomposed Change and drives it, against a running Worker (under
 * `wrangler dev` with the Artifacts binding remote), through the whole chain:
 *
 *   1. create the Change and set the min/max dial on the live Worker;
 *   2. recruit real agents against runnable units under the dial, each in its
 *      OWN real Cloudflare Artifact repo, with each agent running the chosen
 *      executor (Workers AI live, a deterministic fake offline/in tests);
 *   3. drive the next recruitment wave from the repo-pushed event each agent's
 *      push produces (the real Artifacts event subscription delivers it to the
 *      Worker's Queue consumer in production; the ingress path exercises the
 *      identical handler when a subscription is not provisioned);
 *   4. the human escalation beat: when the engine hits a fork mechanical
 *      evidence cannot settle (a shared contested path whose single writer is a
 *      human's call), it raises an escalation on the Worker and WAITS for a
 *      human decision (a durable record read back from state, never a sleep),
 *      then proceeds using the chosen owner;
 *   5. deterministic verification of each completed WorkUnit's real repo, then
 *      integration of the verified work (the model never grades its own work);
 *   6. local-Git promotion of the integrated result to a real branch and commit;
 *   7. cleanup: archive (delete) every real Artifact repo the run created.
 *
 * The Worker transport, the executor, and the human-decision resolver are all
 * injectable, so the same orchestration runs live against the account and runs
 * deterministically offline in a test (a fake fetch over the in-process control
 * surface, the scoped-noop executor, and an auto-resolver) without touching the
 * network. That is what keeps `make check` offline while the live `run-live`
 * command exercises the real account.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  detectPathCollisions,
  planWriteLeases,
  type Change,
  type ConcurrencyDial,
  type LeaseDecision,
} from "@switchyard-change/change-core";
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
import {
  ChangeVerification,
  type CommandOutcome as VerificationCommandOutcome,
  type CommandRunner as VerificationCommandRunner,
  type CompletedWorkUnit,
  type EvidenceSummary,
} from "@switchyard-change/verification";
import {
  LocalGitDeliveryProvider,
  defaultBranch,
  type PromotionResult,
} from "@switchyard-change/git-promotion";

import { maybeBuildTool, type ToolBuildResult } from "./tool-build.ts";
import { stableAppWorkerName } from "./app-deploy.ts";
import type { Escalation } from "./local-control.ts";
import type { LiveTrigger } from "./recruit-live.ts";

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
  /** The model id used, when an inference executor reported one. */
  readonly model?: string;
  /**
   * True when this agent ultimately failed (its executor errored past the
   * bounded retries, or timed out) and the unit was reported FAILED to the
   * Worker. A failed agent did not push a result; the wave advanced without it.
   */
  readonly failed?: boolean;
  /** A short failure reason when `failed` is true (never a secret or a token). */
  readonly failureReason?: string;
}

/** One live recruitment wave. */
export interface LiveWave {
  readonly trigger: "kickoff" | "repo-pushed";
  readonly concurrency: number;
  readonly agents: readonly LiveAgentReport[];
}

/**
 * The decision a human made to resolve an escalation. The engine waits for this
 * before proceeding past the fork; in a live run it is supplied by a human (CLI
 * input), and in a test by an auto-resolver.
 */
export interface EscalationResolution {
  readonly escalationId: string;
  readonly decision: string;
}

/**
 * A resolver for a pending escalation: given the escalation, return the human
 * decision text (for a lease-owner escalation, the chosen owner unit id). The
 * live CLI prompts a human; a test supplies a deterministic function.
 */
export type EscalationResolver = (escalation: Escalation) => Promise<string>;

/** The escalation beat outcome, surfaced for honest reporting. */
export interface EscalationReport {
  readonly raised: Escalation | null;
  readonly resolved: Escalation | null;
  /** True when the engine actually waited on a durable pending record. */
  readonly waited: boolean;
}

/** The outcome of a full live run. */
export interface RunFullLiveResult {
  readonly changeId: string;
  readonly dial: ConcurrencyDial;
  readonly workerUrl: string;
  readonly waveTrigger: LiveTrigger;
  readonly waves: readonly LiveWave[];
  readonly peakConcurrency: number;
  /** Distinct real Artifact repo (workspace) names agents held. */
  readonly workspaces: readonly string[];
  /** True when at least one agent held a real (non-fallback) Artifact repo. */
  readonly anyLive: boolean;
  readonly completed: readonly string[];
  /**
   * The WorkUnits an agent ultimately failed on (after the executor's bounded
   * retries, or a timeout). Each is terminal-for-that-unit: the scheduler
   * advanced the rest of the wave rather than freezing, so the run completes
   * with these units failed instead of hanging. Backed by the Change state's
   * failed set.
   */
  readonly failedUnits: readonly { readonly unitId: string; readonly reason: string }[];
  /** The escalation beat: what was raised, how it was resolved, and that it waited. */
  readonly escalation: EscalationReport;
  /**
   * The agent-built tool for this Change, when the work needed a capability the
   * repo lacked and a tool-builder agent produced one; otherwise undefined. The
   * tool is built in its OWN real Artifact repo (the honest local fallback
   * offline) and recorded on the Worker, so the live console graph shows it as a
   * real tool node (its own repo) genuinely cloned and run by downstream units,
   * never a decorative edge. Its repo is torn down with the run.
   */
  readonly tool?: ToolBuildResult;
  /** The deterministic verification + integration evidence. */
  readonly evidence: EvidenceSummary;
  /** The local-Git promotion result (a real branch and commit). */
  readonly promotion: PromotionResult;
  /** Absolute path to the local source repository the result was promoted into. */
  readonly sourceRepoDir: string;
  /** Workspace names the fabric archived (deleted) on cleanup. */
  readonly cleanedUp: readonly string[];
  /**
   * The live deployment of the fixed app, when this run deployed one as
   * end-of-run proof. Present only when a deployer and app were supplied AND
   * verification passed; absent otherwise (so a failed fix never reports a URL).
   */
  readonly deployment?: { readonly url: string; readonly app: string };
}

/**
 * An injectable app deployer: given the app directory and name, deploy it to a
 * live workers.dev URL and return the reachable URL. The live implementation
 * runs `wrangler deploy` in the app directory (the M8.0 deploy hop); a test
 * passes a deterministic fake so `make check` never touches the network. It is
 * only ever called AFTER verification passed, so a broken fix is never deployed.
 */
export type DeployApp = (input: {
  readonly appDir: string;
  readonly appName: string;
}) => Promise<{ readonly url: string }>;

/** An injectable app teardown: delete the deployed app so it stops billing. */
export type TeardownApp = (input: {
  readonly appDir: string;
  readonly appName: string;
}) => Promise<void>;

/** Options for a full live run. */
export interface RunFullLiveOptions {
  readonly change: Change;
  readonly dial: ConcurrencyDial;
  /** Base URL of the running Worker (wrangler dev), e.g. http://127.0.0.1:8787. */
  readonly workerUrl: string;
  readonly specYaml: string;
  /** Absolute path to the project directory used as the promotion baseline. */
  readonly projectDir: string;
  readonly workRoot?: string;
  /** The executor each recruited agent runs. Defaults to the scoped-noop. */
  readonly executor?: ExecutorProvider;
  readonly identity?: GitIdentity;
  /** How to trigger the next wave (the real subscription vs the HTTP ingress). */
  readonly waveTrigger?: LiveTrigger;
  /**
   * The human-decision resolver for the escalation beat. Required for a real
   * run; a test passes an auto-resolver. When omitted, the beat auto-resolves
   * to the deterministic lease owner so an unattended offline run still proves
   * the full chain (but then `waited` reports the auto path honestly).
   */
  readonly resolveEscalation?: EscalationResolver;
  /**
   * When true, the escalation beat does NOT resolve the fork itself. It raises
   * the durable escalation on the Worker and then BLOCKS, polling the Worker's
   * state until an external actor (the console, where a human clicks an answer)
   * resolves it, then proceeds using that human-supplied decision. This is what
   * makes the browser the control plane for the escalating template: the run
   * genuinely pauses on a real pending record and only advances once the human
   * answers in the UI. When false (the default), the beat uses `resolveEscalation`
   * (or the deterministic default owner) and resolves the record itself, which
   * keeps the offline/CLI/test path non-interactive and unattended.
   */
  readonly awaitExternalResolution?: boolean;
  /**
   * How long to wait for an external resolution before giving up, in
   * milliseconds (only used with `awaitExternalResolution`). Defaults to ten
   * minutes, which is comfortably long for a human to answer a single question
   * in the browser without hanging an abandoned run forever.
   */
  readonly externalResolutionTimeoutMs?: number;
  /**
   * How often to poll the Worker for the external resolution, in milliseconds
   * (only used with `awaitExternalResolution`). Defaults to one second.
   */
  readonly externalResolutionPollMs?: number;
  /**
   * When true, leave the real Artifact repos and the Change state in place
   * after the run instead of archiving them, so a human can watch the finished
   * graph morph in the console before tearing it down. The result still lists
   * the workspaces it created (as `workspaces`), and `cleanedUp` is empty; a
   * separate cleanup command (`switchyard-change cleanup-live`) removes them
   * when the watcher is done. The per-unit repos are also never torn down
   * mid-run (cleanup only ever runs at the very end), so watch mode simply
   * skips that final step.
   */
  readonly skipCleanup?: boolean;
  /** An injectable fetch for tests; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
  /** Optional progress sink for human-readable console output. */
  readonly onEvent?: (event: FullLiveEvent) => void;
  /**
   * For a real-app run, the app directory (under examples/apps) and its STABLE
   * worker name (derived from the app, e.g. switchyard-change-fabric-<app>), not
   * the per-run id. The run NEVER deploys fresh: deploy is a manual, pre-run
   * human step. When a prior manual deploy exists for this app (see
   * `appAlreadyDeployed`) AND verification passed, the run REDEPLOYS the fixed
   * code to that same stable name, updating the existing deployment in place at
   * the same URL. When no manual deploy exists, the run deploys nothing and still
   * promotes to Git and completes normally.
   */
  readonly deployAppDir?: string;
  readonly deployAppName?: string;
  /**
   * The injectable redeployer and teardown. The live path runs wrangler against
   * the app's stable name; a test passes deterministic fakes so `make check`
   * stays offline. The redeployer is only called when verification passed AND a
   * prior manual deployment already exists, so the run only ever REFRESHES an
   * existing deployment, never creates one.
   */
  readonly deployApp?: DeployApp;
  readonly teardownApp?: TeardownApp;
  /**
   * An injectable lookup for whether this app was ALREADY deployed by a manual,
   * pre-run human Deploy. It returns the existing stable workers.dev URL when a
   * deployment exists, or undefined when none does. The run redeploys in place
   * only when this resolves a URL; otherwise it does not deploy at all. The live
   * path reads a per-app marker a manual deploy wrote; a test injects it, so the
   * run's deploy-or-not decision is deterministic offline.
   */
  readonly appAlreadyDeployed?: (input: {
    readonly appName: string;
  }) => Promise<string | undefined>;
  /**
   * The per-unit per-app BEHAVIORAL gate command, as argv. Given a WorkUnit id,
   * return the argv the verifier runs to prove that unit's candidate edit fixes
   * the planted bug (it imports the app's fetch handler and asserts on the
   * Response, with a syntax/typecheck step so a broken edit fails first), or
   * undefined when the unit has no app gate. When this resolves a command for a
   * unit, that unit REQUIRES the gate: a missing or failing gate is a verify-fail
   * (absence of a gate is cannot-pass, never auto-pass), which drives the bounded
   * model-escalation ladder and, on exhaustion, a real red node with no redeploy.
   * The live path returns the real gate argv; a test injects a fake command the
   * injected `verifyCommandRunner` interprets, so the ladder stays offline.
   */
  readonly appGateCommandFor?: (unitId: string) => readonly string[] | undefined;
  /**
   * The injectable command runner the per-app gate runs through, used by BOTH
   * the ladder's per-attempt gate and the final integration verify, so a single
   * deterministic fake keeps `make check` offline. Defaults to the verification
   * package's real child-process runner on the live path.
   */
  readonly verifyCommandRunner?: VerificationCommandRunner;
  /**
   * The bounded max-retries dial for the model-escalation ladder: how many RETRY
   * attempts past the base attempt the ladder may run on a verify-fail. Default
   * 1 (base attempt, then one escalation retry). Data-driven and N-capable: a
   * higher value allows more escalation attempts with no code change, each still
   * gated mechanically. Zero disables escalation (base attempt only).
   */
  readonly maxModelRetries?: number;
  /**
   * The model id a verify-fail retry escalates to (the stronger model the ladder
   * runs attempt 2+ on, passed to the executor as the per-attempt model id). On
   * the live path this is the selected escalation model; a test passes the id its
   * model-id-aware executor fake treats as the passing model. When empty, the
   * ladder cannot escalate (no stronger model), so a base verify-fail is terminal.
   */
  readonly escalationModel?: string;
  /**
   * The base model id for the first ladder attempt, recorded on the base
   * verify attempt so the console shows which model produced the graded edit.
   * Informational only (the base edit was already produced by the executor);
   * empty for the deterministic noop path.
   */
  readonly baseModel?: string;
  /**
   * Opt in to the agent-for-agent tool build. Off by default: an ordinary
   * multi-module change does NOT build or emit a tool node (the tool path is a
   * leftover of the old file-split model and must not fire on a normal change).
   * The tool-capability path sets this to exercise the feature; the structural
   * `detectToolRequirement` still decides whether a tool is warranted once opted
   * in, and no tool node can appear when none is built.
   */
  readonly enableToolBuild?: boolean;
}

/** A progress event emitted during a full live run. */
export type FullLiveEvent =
  | { readonly kind: "change-created"; readonly changeId: string }
  | { readonly kind: "tool-built"; readonly tool: ToolBuildResult }
  | { readonly kind: "wave"; readonly wave: LiveWave }
  | { readonly kind: "agent-failed"; readonly unitId: string; readonly reason: string }
  | { readonly kind: "discovered"; readonly unitId: string; readonly added: readonly string[] }
  | { readonly kind: "escalation-raised"; readonly escalation: Escalation }
  | { readonly kind: "escalation-resolved"; readonly escalation: Escalation }
  | { readonly kind: "verifying" }
  | {
      readonly kind: "verify-attempt";
      readonly round: number;
      readonly outcome: "pass" | "fail";
      readonly model: string;
    }
  | {
      readonly kind: "model-escalation";
      readonly round: number;
      readonly fromModel: string;
      readonly toModel: string;
      readonly implicatedUnits: readonly string[];
    }
  | { readonly kind: "promoting"; readonly branch: string }
  | { readonly kind: "redeployed"; readonly url: string; readonly app: string }
  | { readonly kind: "deploy-skipped"; readonly reason: string }
  | { readonly kind: "cleaned-up"; readonly archived: readonly string[] };

/**
 * Drive the full end-to-end live run and return the structured result. The
 * repos the run creates are archived only after verification, integration, and
 * promotion complete, so the whole chain runs against real repos before cleanup.
 */
export async function runFullLive(options: RunFullLiveOptions): Promise<RunFullLiveResult> {
  const executor = options.executor ?? new ScopedNoopExecutor();
  const identity = options.identity ?? RUNNER_IDENTITY;
  const fetchFn = options.fetchFn ?? fetch;
  const base = options.workerUrl.replace(/\/$/, "");
  const trigger: LiveTrigger = options.waveTrigger ?? "ingress";
  const changeId = options.change.id;
  const emit = options.onEvent ?? (() => {});

  // The frozen contract paths the Change's cohesion blueprint declared as
  // read-only seams. Threaded into every executor call (the kickoff wave below
  // and the ladder re-fan) so the base and retry prompts list them as read-only,
  // steering the model to import and honor them rather than rewrite a shared
  // interface. Empty when the Change carries no blueprint contracts.
  const frozenContracts: readonly string[] = (options.change.blueprint?.contracts ?? []).map(
    (c) => c.path,
  );

  // The per-unit exported interface the Change's cohesion blueprint captured for
  // each owner module: the names other modules import from that unit. Threaded
  // into THAT unit's executor call (the kickoff wave below and the ladder re-fan)
  // so its base and retry prompts tell the model to keep those exports present
  // rather than drop one and break an importer. Empty for a Change with no
  // blueprint modules, so a non-modular Change and every existing caller are
  // unchanged.
  const requiredExportsByUnit = new Map<string, readonly string[]>();
  for (const module of options.change.blueprint?.modules ?? []) {
    if (module.exports.length > 0) {
      requiredExportsByUnit.set(module.unitId, module.exports);
    }
  }

  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), "scf-full-")));
  await mkdir(workRoot, { recursive: true });
  const worktreeRoot = join(workRoot, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });

  // Make the app's shared gate harness resolvable inside every composed worktree
  // the gate runs in. An app's per-app gate test lives at `<app>/gate/*.test.mjs`
  // and may import a SHARED helper one level above the app directory (for
  // example `import ... from "../../gate-harness.mjs"`). The worktrees the gate
  // runs in are seeded from the app project directory ALONE (the per-unit verify
  // clone, the integrator's integration checkout, and the change-level ladder
  // overlay are all created directly under `worktreeRoot`), so that sibling file
  // lives OUTSIDE the copied tree and `node --test gate/gate.test.mjs` would fail
  // to resolve its import (ERR_MODULE_NOT_FOUND) before any assertion runs.
  //
  // Copy the app project's sibling shared `.mjs` files into `worktreeRoot` once,
  // so a gate test at `<worktreeRoot>/<worktree>/gate/gate.test.mjs` resolves
  // `../../gate-harness.mjs` to `<worktreeRoot>/gate-harness.mjs`. This is
  // app-agnostic (it copies whatever shared `.mjs` siblings the app dir has, not
  // a service-api-specific file) and preserves the gate's authoring unchanged, so
  // the gate fails only on real assertions, never on a missing module.
  await materializeSiblingGateDeps(options.projectDir, worktreeRoot);

  const post = async (path: string, body?: unknown, contentType = "application/json") => {
    const res = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text === "" ? {} : safeJson(text);
    if (res.status >= 400) {
      const detail = (parsed as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new Error(`Worker ${path} failed (${res.status}): ${detail}`);
    }
    return parsed as Record<string, unknown>;
  };
  const getJson = async (path: string) => {
    const res = await fetchFn(`${base}${path}`);
    const text = await res.text();
    return (text === "" ? {} : safeJson(text)) as Record<string, unknown>;
  };

  // Fire-and-forget reporters for the live per-node feedback. They post the REAL
  // run steps and the model detail to the Worker so the console's activity log
  // and the static model transcript (prompt summary + proposed edit/diff +
  // commit message) render real state. They never throw into the run: a feedback
  // post failing must not fail the agent (the run's correctness does not depend
  // on observability landing).
  const unitPath = (unitId: string, suffix: string) =>
    `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/${suffix}`;
  const reportStep = (unitId: string, phase: string, message: string): void => {
    void post(unitPath(unitId, "step"), { phase, message }).catch(() => {});
  };
  const reportDetail = (unitId: string, detail: Record<string, unknown>): void => {
    void post(unitPath(unitId, "detail"), detail).catch(() => {});
  };

  // 1. Create the Change and set the dial.
  await post(`/changes`, options.specYaml, "text/plain");
  await post(`/changes/${encodeURIComponent(changeId)}/dial`, {
    minConcurrency: options.dial.minConcurrency,
    maxConcurrency: options.dial.maxConcurrency,
  });
  emit({ kind: "change-created", changeId });

  const waves: LiveWave[] = [];
  const allWorkspaces = new Set<string>();
  const unitWorkspaceGitUrls = new Map<string, string>();
  // The authenticated clone URL per unit (gitUrl with its scoped token), used to
  // clone the real repo for verification. For a file:// fallback the token is
  // ignored, so this is also correct offline.
  const unitAuthRemotes = new Map<string, string>();
  // Next-wave agents the fail route returned for a failed unit, keyed by unit id,
  // so runWave can advance from a failed unit the same way it advances from a
  // repo-pushed event for a successful one.
  const failRecruited = new Map<string, RecruitedAgent[]>();
  let anyLive = false;
  let peakConcurrency = 0;

  const runAgent = async (agent: RecruitedAgent): Promise<LiveAgentReport> => {
    const worktreeDir = await mkdtemp(join(worktreeRoot, `scf-${agent.unitId}-`));
    const remote = authenticatedRemote(agent.gitUrl, agent.token);
    // The lease was recorded by the Worker when this agent was recruited; record
    // it as the first real step in this unit's activity log so the console shows
    // the run beginning. Each step below corresponds to a concrete run action.
    reportStep(agent.unitId, "leased", `leased ${agent.workspaceName} (${agent.backend})`);
    try {
      reportStep(agent.unitId, "cloning", `cloning ${agent.workspaceName}`);
      await clone(remote, worktreeDir);
      const result = await executor.execute({
        worktreeDir,
        workUnitId: agent.unitId,
        objective: agent.objective,
        paths: agent.paths,
        baselineRef: agent.baselineRef,
        ...(frozenContracts.length > 0 ? { frozenContracts } : {}),
        ...((requiredExportsByUnit.get(agent.unitId) ?? []).length > 0
          ? { requiredExports: requiredExportsByUnit.get(agent.unitId)! }
          : {}),
        // Per-unit observability callbacks: the executor surfaces the real agent
        // activity through these, and the runner relays it to the Worker so the
        // console renders it. A deterministic executor ignores them. There is no
        // live token relay: the model is called non-streaming and the console
        // shows a static transcript once the unit is done.
        onPromptSummary: (summary) => reportDetail(agent.unitId, { promptSummary: summary }),
        onStep: (step) => reportStep(agent.unitId, step.phase, step.message),
      });
      // Record the model transcript as rich detail: the model id, the proposed
      // edit (changed paths), a readable diff reconstructed from the real
      // worktree, the proposed commit message, and token usage / cost the
      // executor reported. Together with the prompt summary reported above
      // (onPromptSummary), these ARE the static transcript the console renders
      // when the unit is done: the real recorded prompt + the real proposed
      // edit + the real commit message, read straight from the executor result,
      // never synthesized.
      const diff = await buildEditDiff(worktreeDir, result.changedPaths);
      reportDetail(agent.unitId, {
        ...(result.cost.model ? { model: result.cost.model } : {}),
        editedPaths: result.changedPaths,
        ...(diff ? { diff } : {}),
        commitMessage: result.commitMessage,
        ...(result.cost.inputTokens !== undefined ? { inputTokens: result.cost.inputTokens } : {}),
        ...(result.cost.outputTokens !== undefined ? { outputTokens: result.cost.outputTokens } : {}),
        ...(result.cost.usd !== undefined ? { usd: result.cost.usd } : {}),
      });
      let commit = "";
      if (await hasChanges(worktreeDir)) {
        reportStep(agent.unitId, "commit", `committing: ${result.commitMessage}`);
        commit = await commitAll(worktreeDir, result.commitMessage, identity);
        reportStep(agent.unitId, "push", `pushing to ${agent.defaultBranch}`);
        await push(worktreeDir, remote, agent.defaultBranch);
      } else {
        reportStep(agent.unitId, "no-change", "the executor produced no change to push");
      }
      reportStep(agent.unitId, "pushed", "work pushed; awaiting verification");
      // Dynamic branching: if the executor DISCOVERED follow-up work while
      // fixing this unit (more files/call sites needing the same fix), report it
      // to the control plane so those units are appended to the live WorkGraph
      // as real backed units BEFORE the next wave is driven from this push. The
      // repo-pushed event below then recomputes the runnable set over the grown
      // graph and recruits the freshly-added units, so the graph grows mid-run.
      // This is a real state append (scoped, rooted under this unit), not a UI
      // animation; a feedback/append failure never fails the agent's own result.
      if (result.discoveredUnits && result.discoveredUnits.length > 0) {
        try {
          const outcome = await post(
            `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(agent.unitId)}/discovered`,
            { units: result.discoveredUnits },
          );
          const added = (outcome.added as string[] | undefined) ?? [];
          if (added.length > 0) {
            reportStep(
              agent.unitId,
              "discovered",
              `discovered ${added.length} follow-up unit(s): ${added.join(", ")}`,
            );
            emit({ kind: "discovered", unitId: agent.unitId, added });
          }
        } catch {
          // Best-effort: a control plane that does not know the discovered route
          // still runs the rest of the chain; the agent's own push is unaffected.
        }
      }
      if (!agent.fallback) {
        anyLive = true;
      }
      allWorkspaces.add(agent.workspaceName);
      unitWorkspaceGitUrls.set(agent.unitId, agent.gitUrl);
      unitAuthRemotes.set(agent.unitId, remote);
      return {
        unitId: agent.unitId,
        workspaceName: agent.workspaceName,
        backend: agent.backend,
        fallback: agent.fallback,
        gitUrl: agent.gitUrl,
        commit,
        changedPaths: result.changedPaths,
        ...(result.cost.model ? { model: result.cost.model } : {}),
      };
    } catch (error) {
      // The agent ultimately failed: its executor errored past the bounded
      // retries, or timed out, or the clone/push failed. Rather than letting the
      // throw propagate (which would reject the whole wave and freeze every other
      // unit), report the unit FAILED to the Worker. That releases the lease and
      // frees the dial slot, so the scheduler advances the remaining runnable
      // units instead of blocking forever. We return a report marked failed so
      // the wave aggregation records it; we do NOT rethrow.
      const reason = failureReason(error);
      allWorkspaces.add(agent.workspaceName);
      reportStep(agent.unitId, "failed", reason);
      let recruitedAfterFail: RecruitedAgent[] = [];
      try {
        const outcome = await post(
          `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(agent.unitId)}/fail`,
          { reason },
        );
        recruitedAfterFail = (outcome.recruited as RecruitedAgent[] | undefined) ?? [];
      } catch {
        // Best-effort: even if the fail signal itself fails to send, we still
        // record the agent as failed locally so the run does not hang on it.
      }
      failRecruited.set(agent.unitId, recruitedAfterFail);
      emit({ kind: "agent-failed", unitId: agent.unitId, reason });
      return {
        unitId: agent.unitId,
        workspaceName: agent.workspaceName,
        backend: agent.backend,
        fallback: agent.fallback,
        gitUrl: agent.gitUrl,
        commit: "",
        changedPaths: [],
        failed: true,
        failureReason: reason,
      };
    } finally {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  };

  const runWave = async (
    waveTrigger: "kickoff" | "repo-pushed",
    agents: readonly RecruitedAgent[],
  ): Promise<void> => {
    if (agents.length === 0) {
      return;
    }
    peakConcurrency = Math.max(peakConcurrency, agents.length);
    // Use allSettled, not all: one agent's failure must NOT cancel its siblings.
    // runAgent itself converts an executor failure into a FAILED report (it
    // reports the unit failed to the Worker and returns a failed report rather
    // than throwing), so a rejection here would be an unexpected internal error;
    // we still guard with allSettled so a single bad unit can never wedge the
    // wave or stop the surviving agents from driving the next wave.
    const settled = await Promise.allSettled(agents.map((a) => runAgent(a)));
    const reports: LiveAgentReport[] = [];
    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i]!;
      if (outcome.status === "fulfilled") {
        reports.push(outcome.value);
      } else {
        // Defensive: runAgent is written not to throw, but if it ever does, fail
        // the unit to the Worker so the wave still advances rather than freezing.
        const agent = agents[i]!;
        const reason = failureReason(outcome.reason);
        allWorkspaces.add(agent.workspaceName);
        try {
          const failOut = await post(
            `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(agent.unitId)}/fail`,
            { reason },
          );
          failRecruited.set(agent.unitId, (failOut.recruited as RecruitedAgent[] | undefined) ?? []);
        } catch {
          failRecruited.set(agent.unitId, []);
        }
        emit({ kind: "agent-failed", unitId: agent.unitId, reason });
        reports.push({
          unitId: agent.unitId,
          workspaceName: agent.workspaceName,
          backend: agent.backend,
          fallback: agent.fallback,
          gitUrl: agent.gitUrl,
          commit: "",
          changedPaths: [],
          failed: true,
          failureReason: reason,
        });
      }
    }
    const wave: LiveWave = { trigger: waveTrigger, concurrency: agents.length, agents: reports };
    waves.push(wave);
    emit({ kind: "wave", wave });

    const next: RecruitedAgent[] = [];
    for (const report of reports) {
      // A failed agent already signalled its failure through the fail route,
      // which released its lease, freed the dial slot, and returned the next
      // wave the freed slot allows (if any). Use that recruited set to drive the
      // wave forward instead of a repo-pushed event, since a failed unit
      // produced no push. A successful agent drives the next wave from its
      // repo-pushed event as before.
      if (report.failed) {
        next.push(...(failRecruited.get(report.unitId) ?? []));
        continue;
      }
      const outcome = await post("/events/repo-pushed", {
        changeId,
        workspace: report.workspaceName,
      });
      next.push(...((outcome.recruited as RecruitedAgent[] | undefined) ?? []));
    }
    await runWave("repo-pushed", next);
  };

  // The agent-for-agent tooling moment on the live path. When the WORK (not the
  // goal string) needs a capability the repo lacks, one agent provisions its OWN
  // real Artifact repo (the honest local fallback offline), builds the codemod
  // there, commits and pushes it, and downstream agents CLONE that repo and run
  // the tool. The tool build itself is Node-side Git work (the Worker runtime
  // cannot run Git), exactly like the agent runners; we then RECORD the tool and
  // its real consumptions on the Worker so the live console graph shows the tool
  // node (its own repo) and consumed-tool edges backed by real state, not a
  // decorative edge. The trigger is structural, so a layered Change builds no
  // tool and this is a no-op. The tool's own repo is tracked in allWorkspaces so
  // cleanup tears it down with the run.
  const tool = await buildAndRecordTool(
    options.change,
    workRoot,
    post,
    options.enableToolBuild ?? false,
  );
  if (tool) {
    allWorkspaces.add(tool.workspace.workspaceName);
    emit({ kind: "tool-built", tool });
  }

  // 2 + 3. Kickoff recruitment under the dial, then run to completion driven by
  // the repo-pushed events each push produces.
  const kickoff = await post(`/changes/${encodeURIComponent(changeId)}/recruit`);
  await runWave("kickoff", (kickoff.recruited as RecruitedAgent[] | undefined) ?? []);

  // 4. The human escalation beat. A shared contested path whose single writer is
  // a human's call is a genuine evidence-unsettled fork: the lease plan can pick
  // a deterministic default owner, but which agent OWNS a shared file is a human
  // decision, so the engine escalates it and waits for the answer rather than
  // self-certifying. We raise it on the Worker (a durable record), confirm the
  // Worker reports it pending (the wait), get the human decision, and resolve it.
  const escalation = await runEscalationBeat(
    options.change,
    changeId,
    post,
    getJson,
    options.resolveEscalation,
    emit,
    {
      awaitExternal: options.awaitExternalResolution ?? false,
      timeoutMs: options.externalResolutionTimeoutMs ?? 10 * 60 * 1000,
      pollMs: options.externalResolutionPollMs ?? 1000,
    },
  );

  // 5. Verify + integrate. Clone each completed unit's real repo and verify it
  // deterministically, then integrate the verified work. Ground truth is
  // mechanical; the model never grades its own work.
  emit({ kind: "verifying" });
  // Read the live state so the Change we verify/integrate includes any units
  // DISCOVERED mid-run (dynamic branching appended them to the Worker's state,
  // not to options.change). The effective Change's work set is the state's work
  // set, so discovered units are verified and integrated like declared ones.
  const grownState = await getJson(`/changes/${encodeURIComponent(changeId)}`);
  const effectiveChange = effectiveChangeFromState(options.change, grownState);

  // T6: the bounded, verify-verdict-driven CHANGE-LEVEL model-escalation ladder.
  // After the wave completed, run the per-app gate ONCE for the whole change
  // (round 1, a `verify` node hung off the goal). On a change-level verify-FAIL,
  // if a stronger escalation model and a retry budget remain, identify the
  // IMPLICATED units (those whose declared paths cover the file[s] named in the
  // failing gate output; falling back to ALL units when the failure cannot be
  // attributed), re-fan ONLY those units on the escalation model fed the failing
  // evidence (a `retry` node + a `model-escalation` edge carrying the implicated
  // units), push their new edits, and re-run the gate ONCE more (round 2, a
  // second `verify` node). This is bounded by the max-retries dial (default 1,
  // kept N-capable) and is a DIFFERENT axis from the executor's transport
  // fallback: it fires on a mechanical gate verdict, never on a thrown call.
  //
  // HONESTY NOTE on which composition the ladder gates: the ladder's per-round
  // gate runs over an ADVISORY naive overlay (baseline + every gated unit's
  // changed files) only to decide whether to RETRY/escalate. It is NOT the thing
  // that declares final success, because that overlay is NOT the tree that
  // ships: the authoritative integrator applies write-lease coordination
  // (yielded contested paths and excluded units are removed), so the promoted
  // tree can differ from this overlay. Final success is settled later by running
  // the SAME per-app gate on the real INTEGRATED tree inside verifyAndIntegrate
  // (see completedInputs below, which carry appGateCommand/requiresAppGate so the
  // integrator gates the exact tree it promotes). That guarantees the gated
  // composition equals the promoted/deployed composition. When the ladder never
  // passes its advisory overlay, every gated unit is marked FAILED (real red
  // nodes) and kept out of integration, so a non-fixing or broken change can
  // never green or redeploy. The verifier is mechanical on every round (the
  // escalation model gets another round, it never grades itself).
  const gateCommandRunner = options.verifyCommandRunner;
  const maxModelRetries = Math.max(0, Math.floor(options.maxModelRetries ?? 1));
  const escalationModel = (options.escalationModel ?? "").trim();
  // The gated units: completed units that both declare a gate and pushed a repo
  // the ladder can clone. The gate is per-app, so the same command applies to
  // every unit; a unit that never pushed (e.g. already failed) is not gated.
  const gatedUnits = effectiveChange.work.filter((unit) => {
    const gateCommand = options.appGateCommandFor?.(unit.id);
    return (
      gateCommand !== undefined &&
      gateCommand.length > 0 &&
      unitAuthRemotes.get(unit.id) !== undefined
    );
  });
  // Whether the whole change passed the change-level gate. Starts true so a run
  // with no gate (no gated units, or no runner) behaves exactly as before: no
  // ladder, nothing marked failed, integration proceeds unchanged.
  let changePassed = true;
  if (options.appGateCommandFor && gateCommandRunner && gatedUnits.length > 0) {
    changePassed = await runChangeLevelEscalationLadder({
      changeId,
      baselineRef: effectiveChange.baseline,
      projectDir: options.projectDir,
      gatedUnits: gatedUnits.map((unit) => ({
        unitId: unit.id,
        objective: unit.objective,
        paths: unit.paths,
        authRemote: unitAuthRemotes.get(unit.id)!,
        gateCommand: options.appGateCommandFor!(unit.id)!,
        requiredExports: requiredExportsByUnit.get(unit.id) ?? [],
      })),
      gateCommandRunner,
      executor,
      escalationModel,
      maxModelRetries,
      baseModel: options.baseModel ?? "",
      frozenContracts,
      refanConcurrency: options.dial.maxConcurrency,
      defaultBranch: "main",
      worktreeRoot,
      identity,
      post,
      emit,
    });
  }

  const completedInputs: CompletedWorkUnit[] = [];
  for (const unit of effectiveChange.work) {
    const gitUrl = unitWorkspaceGitUrls.get(unit.id);
    if (!gitUrl) {
      continue;
    }
    // Use the authenticated remote so verification can clone the real Artifacts
    // repo over HTTPS with the scoped token (a file:// fallback ignores it).
    const authRemote = unitAuthRemotes.get(unit.id) ?? gitUrl;
    // When the unit has a per-app gate, thread it into the final verify so the
    // integration gate runs the SAME mechanical check against the final edit the
    // ladder left on the repo HEAD. A unit that requires a gate but has no
    // command cannot auto-pass (the verifier fails the absent gate).
    const gateCommand = options.appGateCommandFor?.(unit.id);
    const requiresAppGate = Boolean(gateCommand && gateCommand.length > 0);
    completedInputs.push({
      unitId: unit.id,
      gitUrl: authRemote,
      baselineRef: effectiveChange.baseline,
      ...(requiresAppGate ? { appGateCommand: gateCommand, requiresAppGate: true } : {}),
    });
  }

  // When the change-level ladder never passed the gate (both rounds failed, or
  // escalation was disabled), every gated unit is marked FAILED on the Worker,
  // so they become real red nodes, are excluded from integration, and block any
  // redeploy. This is the honest terminal of the change-level ladder: a
  // non-fixing or broken change is never greened.
  const ladderFailed = new Set<string>();
  if (!changePassed) {
    for (const unit of gatedUnits) {
      ladderFailed.add(unit.id);
      await post(
        `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unit.id)}/verify-fail`,
        { reason: "change-level model-escalation ladder exhausted: the change did not pass the per-app gate" },
      ).catch(() => {});
      reportStep(unit.id, "failed", "change-level verify failed after the bounded model-escalation ladder");
    }
  }

  // The integration workspace is a disposable local bare repo seeded from the
  // project baseline. Integration and promotion are Node-side Git work, so they
  // use the local provider even though the unit repos are live Artifacts.
  const { integrationRef, integrationToken, workspaces: integrationProvider } =
    await createIntegrationWorkspace(workRoot, options.projectDir, options.change.id, identity);

  const verification = new ChangeVerification(
    integrationProvider,
    gateCommandRunner ? { commandRunner: gateCommandRunner } : {},
  );
  const evidence = await verification.verifyAndIntegrate({
    change: effectiveChange,
    completed: completedInputs,
    integrationRef,
    integrationToken,
    workRoot: worktreeRoot,
    identity,
  });

  // Record the mechanical verification verdict per unit as a real activity step,
  // so a completed node's log ends with the honest, deterministic outcome (the
  // model never grades its own work; this is the verifier's verdict).
  const integratedSet = new Set(evidence.integration.integratedUnits);
  for (const unit of effectiveChange.work) {
    if (!unitWorkspaceGitUrls.has(unit.id)) {
      continue;
    }
    if (integratedSet.has(unit.id)) {
      reportStep(unit.id, "verified", "deterministic verification passed; integrated");
    } else {
      reportStep(unit.id, "not-integrated", "verification did not integrate this unit");
    }
  }

  // 6. Promote the integrated result into a local Git repository.
  const sourceRepoDir = join(workRoot, "source");
  await cloneProjectForPromotion(options.projectDir, sourceRepoDir);
  const startPoint = await currentBranch(sourceRepoDir);
  emit({ kind: "promoting", branch: defaultBranch(options.change.id) });
  const delivery = new LocalGitDeliveryProvider({ workRoot: worktreeRoot });
  const promotion = await delivery.promote(
    {
      changeId: options.change.id,
      objective: options.change.objective,
      integrationGitUrl: integrationRef.gitUrl,
      integrationBranch: integrationRef.defaultBranch,
    },
    { repoDir: sourceRepoDir, startPoint, identity },
  );

  // 6b. Redeploy-in-place proof: the run NEVER deploys fresh. Deploy is a manual
  // human step taken BEFORE the fix (so a watcher sees the break at a stable
  // URL). On a verified fix, when a prior manual deployment already exists for
  // this app, the run REDEPLOYS the fixed code to the app's STABLE worker name,
  // updating that existing deployment in place at the SAME URL. When no manual
  // deploy happened, the run deploys nothing: it still promotes to Git and
  // completes normally, and the console simply shows no live URL. So the only way
  // a deployment exists is a human Deploy; the run only refreshes it. The
  // redeployer and the already-deployed lookup are injectable (wrangler + a
  // per-app marker live, fakes in tests), so this is deterministic offline.
  let deployment: { url: string; app: string } | undefined;
  if (
    options.deployAppDir &&
    options.deployAppName &&
    options.deployApp &&
    options.appAlreadyDeployed
  ) {
    const verdict = evidence.integration.verdict;
    const integratedCount = evidence.integration.integratedUnits.length;
    // Only a verified run where at least one unit integrated has a real fix to
    // refresh. A run where nothing integrated has no fix to redeploy even though
    // an empty integration verifies vacuously; a failed fix is shown honestly.
    const existingUrl = await options
      .appAlreadyDeployed({ appName: options.deployAppName })
      .catch(() => undefined);
    if (!existingUrl) {
      // No manual pre-deploy: the run does NOT deploy. It still promoted to Git.
      emit({
        kind: "deploy-skipped",
        reason:
          "app was not deployed before the run (no manual Deploy): not deploying; the fix was still promoted to Git",
      });
    } else if (verdict !== "verified" || integratedCount === 0) {
      emit({
        kind: "deploy-skipped",
        reason:
          verdict !== "verified"
            ? `verification verdict was "${verdict}", not "verified": not redeploying a broken app`
            : "no unit was integrated (no fix landed): not redeploying",
      });
    } else {
      try {
        // Redeploy the fixed code to the SAME stable worker name, so the
        // existing deployment is updated in place at the same URL.
        const { url } = await options.deployApp({
          appDir: options.deployAppDir,
          appName: options.deployAppName,
        });
        deployment = { url, app: options.deployAppName };
        await post(`/changes/${encodeURIComponent(changeId)}/deployment`, {
          url,
          app: options.deployAppName,
        }).catch(() => {});
        emit({ kind: "redeployed", url, app: options.deployAppName });
      } catch (error) {
        emit({ kind: "deploy-skipped", reason: `redeploy failed: ${failureReason(error)}` });
      }
    }
  }

  // 7. Clean up the real Artifact repos the run created (and the local
  // integration repo). Only now, after the whole chain ran against them. In
  // watch mode (skipCleanup) this final step is skipped so a human can watch the
  // finished graph in the console; the repos are torn down later by the separate
  // cleanup-live command. Note cleanup ONLY ever runs here, at the very end, so
  // the per-unit repos are never torn down mid-run in either mode.
  const completedState = await getJson(`/changes/${encodeURIComponent(changeId)}`);
  const cleanedUp = options.skipCleanup
    ? []
    : await cleanup(base, fetchFn, [...allWorkspaces]);
  if (!options.skipCleanup) {
    await integrationProvider.archive(integrationRef).catch(() => {});
    // The redeployed app is intentionally NOT torn down here. A deployment is
    // owned by the manual human Deploy, not by the run: it exists before the run
    // and must survive the run so the same stable URL shows the break, then the
    // fix. Teardown is the explicit Tear down control (console) / cleanup-live,
    // which deletes the app by its stable name and clears its marker.
  }
  emit({ kind: "cleaned-up", archived: cleanedUp });

  return {
    changeId,
    dial: options.dial,
    workerUrl: base,
    waveTrigger: trigger,
    waves,
    peakConcurrency,
    workspaces: [...allWorkspaces].sort(),
    anyLive,
    completed: (completedState.completed as string[] | undefined) ?? [],
    failedUnits: (
      (completedState.failed as { unitId?: string; reason?: string }[] | undefined) ?? []
    ).map((f) => ({ unitId: String(f.unitId ?? ""), reason: String(f.reason ?? "agent failed") })),
    escalation,
    evidence,
    promotion,
    sourceRepoDir,
    cleanedUp,
    ...(tool ? { tool } : {}),
    ...(deployment ? { deployment } : {}),
  };
}

/** One gated unit the change-level ladder may re-fan on a verify-fail. */
interface GatedUnitInput {
  readonly unitId: string;
  readonly objective: string;
  readonly paths: readonly string[];
  /** The authenticated clone/push remote for the unit's repo. */
  readonly authRemote: string;
  /** The per-app gate argv (same command for every unit of the app). */
  readonly gateCommand: readonly string[];
  /**
   * The names this unit's module must keep exporting (its captured exported
   * interface), threaded into the re-fan prompt so an escalation retry does not
   * drop an export other modules import. Empty when the unit has no captured
   * exports.
   */
  readonly requiredExports: readonly string[];
}

/** Inputs to run the bounded CHANGE-LEVEL model-escalation ladder. */
interface ChangeLevelLadderInput {
  readonly changeId: string;
  readonly baselineRef: string;
  /** The project baseline the integration worktree is seeded from. */
  readonly projectDir: string;
  /** The gated units (completed, declare a gate, pushed a repo). */
  readonly gatedUnits: readonly GatedUnitInput[];
  readonly gateCommandRunner: VerificationCommandRunner;
  readonly executor: ExecutorProvider;
  /** The stronger model id a verify-fail retry escalates to (empty disables it). */
  readonly escalationModel: string;
  /** The bounded max RETRY rounds past the base round (default 1). */
  readonly maxModelRetries: number;
  /** The base model id, recorded on the round-1 verify attempt (informational). */
  readonly baseModel: string;
  /**
   * The frozen contract paths from the Change's cohesion blueprint, passed to
   * the executor on a re-fan so the escalation prompt lists them as read-only
   * seams the model must import and honor rather than rewrite. Empty when the
   * Change carries no blueprint contracts.
   */
  readonly frozenContracts: readonly string[];
  /**
   * The bounded concurrency cap for re-fanning implicated units on a retry
   * round. Reuses the run's dial max so a retry round completes in roughly one
   * model-latency instead of N (each implicated unit has its own cloned
   * worktree, so running them in parallel is safe). Never unbounded: when the
   * dial max is absent or non-positive the ladder falls back to a small cap.
   */
  readonly refanConcurrency: number;
  readonly defaultBranch: string;
  readonly worktreeRoot: string;
  readonly identity: GitIdentity;
  readonly post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>;
  readonly emit: (event: FullLiveEvent) => void;
}

/**
 * Run the bounded, verify-verdict-driven CHANGE-LEVEL model-escalation ladder
 * and return whether the whole change finally PASSED the per-app gate.
 *
 * The chain is CHANGE-LEVEL (one gate run per round, not one per unit): build an
 * integration worktree from the project baseline overlaid with every gated
 * unit's pushed edit -> run the gate once (verify round 1). If it passes, done
 * (green). If it fails and a stronger escalation model and a retry budget
 * remain, identify the IMPLICATED units (those whose declared paths cover the
 * file[s] the failing gate output named; falling back to ALL gated units when
 * the failure cannot be attributed), re-run the executor on the escalation model
 * for ONLY those units fed the failing evidence, commit and push each new edit,
 * record one change-level retry (with the implicated units + from/to model), and
 * re-run the gate once more (verify round 2). Repeat up to the max-retries
 * bound. When the change never passes, return false so the caller marks the
 * gated units FAILED (real red nodes) with no redeploy.
 *
 * Honesty rails: the gate (the verifier) runs mechanically every round, so the
 * escalation model never grades its own output; the retry count is strictly
 * bounded by maxModelRetries; escalation is driven only by the gate verdict,
 * never by a thrown executor call. Each verify/retry round is recorded as real
 * durable change-level state on the Worker, so the graph nodes/edges that render
 * are backed, now at the change level (one per round, hung off the goal).
 */
async function runChangeLevelEscalationLadder(input: ChangeLevelLadderInput): Promise<boolean> {
  const {
    changeId,
    gatedUnits,
    gateCommandRunner,
    executor,
    escalationModel,
    maxModelRetries,
    worktreeRoot,
    identity,
    post,
    emit,
  } = input;

  // The bounded concurrency cap for re-fanning implicated units. Reuse the run's
  // dial max when it is a positive number; otherwise fall back to a small cap so
  // the re-fan is never strictly sequential (slow on Workers AI) and never
  // unbounded parallel.
  const refanConcurrency =
    Number.isFinite(input.refanConcurrency) && input.refanConcurrency >= 1
      ? Math.floor(input.refanConcurrency)
      : 3;

  // The per-unit per-round worktrees the ladder clones/re-runs, created lazily
  // and torn down at the end. Each retry round clones a FRESH worktree keyed by
  // (unitId, round) rather than reusing one dir across rounds: reusing a single
  // dir meant an identical-or-again-dropped rewrite left a clean `git status`,
  // so the push was skipped and the retry changed nothing. A fresh clone per
  // round compares the new edit against the unit repo HEAD, so a genuinely
  // different edit is committed and pushed and the next round's integration
  // worktree picks it up.
  const unitWorktrees = new Map<string, string>();
  const ensureWorktree = async (
    unitId: string,
    round: number,
    authRemote: string,
  ): Promise<string> => {
    const key = `${unitId}#${round}`;
    const existing = unitWorktrees.get(key);
    if (existing) {
      return existing;
    }
    const dir = await mkdtemp(join(worktreeRoot, `scf-ladder-${unitId}-r${round}-`));
    await clone(authRemote, dir);
    unitWorktrees.set(key, dir);
    return dir;
  };

  try {
    // The gate command is per-app, so any gated unit's command is the change's
    // gate command. Use the first gated unit's command.
    const gateCommand = gatedUnits[0]!.gateCommand;

    let round = 1;
    let currentModel = input.baseModel;
    let lastEvidence = "";

    const runChangeGate = async (): Promise<{ passed: boolean; evidence: string }> => {
      // Build a fresh integration worktree for this round: the project baseline
      // overlaid with every gated unit's current pushed edit, so the gate runs
      // ONCE against the whole change rather than one unit's repo.
      const integrationDir = await buildIntegrationWorktree(
        input.projectDir,
        gatedUnits.map((u) => ({ unitId: u.unitId, authRemote: u.authRemote })),
        worktreeRoot,
      );
      try {
        return await runGate(gateCommand, gateCommandRunner, integrationDir);
      } finally {
        await rm(integrationDir, { recursive: true, force: true });
      }
    };

    let outcome = await runChangeGate();
    await recordVerifyAttempt(
      post,
      changeId,
      round,
      outcome.passed,
      currentModel,
      gateCommand,
      outcome.evidence,
    );
    emit({ kind: "verify-attempt", round, outcome: outcome.passed ? "pass" : "fail", model: currentModel });
    if (outcome.passed) {
      return true;
    }
    lastEvidence = outcome.evidence;

    // Bounded escalation retry rounds. Each round re-fans the implicated units on
    // a stronger model fed the failing evidence, then re-verifies the whole
    // change mechanically. Bounded by maxModelRetries, only when an escalation
    // model is configured.
    for (let retry = 0; retry < maxModelRetries; retry += 1) {
      if (escalationModel === "") {
        break; // no stronger model to escalate to; the base change-fail is terminal
      }
      const fromModel = currentModel;
      const nextRound = round + 1;

      // Attribution: pick the units whose declared paths cover the file(s) the
      // failing gate output named. When the failure cannot be attributed to any
      // specific unit, FALL BACK to re-fanning ALL gated units (never silently
      // skip). This narrowing is best-effort; the fallback keeps it honest.
      const implicated = selectImplicatedUnits(gatedUnits, lastEvidence);

      // Record the change-level model-escalation beat (a retry node + a
      // model-escalation edge, carrying the implicated units) BEFORE running it,
      // so the console shows the hop.
      await post(`/changes/${encodeURIComponent(changeId)}/retry-attempt`, {
        round: nextRound,
        fromModel,
        toModel: escalationModel,
        implicatedUnits: implicated.map((u) => u.unitId),
        reason: `verify round ${round} failed; re-fanning ${implicated.length} implicated unit(s) on a stronger model fed the failing evidence`,
      }).catch(() => {});
      emit({
        kind: "model-escalation",
        round: nextRound,
        fromModel,
        toModel: escalationModel,
        implicatedUnits: implicated.map((u) => u.unitId),
      });

      // Re-fan the implicated units on the escalation model, fed the failing
      // gate evidence, with BOUNDED CONCURRENCY (never unbounded parallel). Each
      // implicated unit has its own cloned worktree, so running them in parallel
      // is isolation-safe: a unit's clone, executor run, commit, and push touch
      // only that unit's repo. The cap reuses the run's dial max so a round
      // completes in roughly one model-latency instead of N sequential calls,
      // which matters because Workers AI is slow. We do not escalate on a thrown
      // call here (that is the transport axis); a genuinely unusable reply is an
      // honest round fail that the re-verify below settles.
      //
      // Each implicated unit also gets a real per-unit activity step recording
      // that it re-ran in this round on the escalation model, so the console
      // renders a visible SECOND WAVE: the unit shows a transient "retrying" step
      // while the round runs, then a settled step once its edit is committed or
      // the round produced no change. Combined with the re-fan edges the graph
      // model draws from the retry node to each implicated unit, the user can SEE
      // which agents the retry re-ran and that they ran.
      const refanOne = async (unit: GatedUnitInput): Promise<void> => {
        reportLadderStep(
          post,
          changeId,
          unit.unitId,
          "retrying",
          `retry round ${nextRound} on ${escalationModel}`,
        );
        // Spawn a BRAND NEW round-N agent for this (unit, round): lease it its
        // OWN real Artifact repo and record the lease on the control plane,
        // exactly as the kickoff wave leases a unit its own repo. The round-N
        // agent then tracks a real status lifecycle (running -> integrated |
        // failed) and reports its real run steps and model detail through the
        // round-scoped routes, so the graph reads the round-N node's state from
        // recorded state rather than a hardcoded literal. If the lease fails we
        // fall back to the unit's kickoff repo so the ladder still makes progress.
        const roundReportStep = (phase: string, message: string): void =>
          reportRoundStep(post, changeId, unit.unitId, nextRound, phase, message);
        const roundReportDetail = (detail: Record<string, unknown>): void =>
          reportRoundDetail(post, changeId, unit.unitId, nextRound, detail);
        let roundRemote: string | undefined;
        let roundLeased = false;
        try {
          const leaseOut = await post(
            `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unit.unitId)}/round/${nextRound}/lease`,
          );
          const gitUrl = typeof leaseOut.gitUrl === "string" ? leaseOut.gitUrl : "";
          const token = typeof leaseOut.token === "string" ? leaseOut.token : "";
          const workspaceName =
            typeof leaseOut.workspaceName === "string" ? leaseOut.workspaceName : "";
          const backend = typeof leaseOut.backend === "string" ? leaseOut.backend : "";
          if (gitUrl !== "") {
            roundRemote = authenticatedRemote(gitUrl, token);
            roundLeased = true;
            roundReportStep("leased", `leased ${workspaceName} (${backend})`);
          }
        } catch {
          // Could not lease a round-N workspace: fall through to the unit's own
          // repo so the ladder still re-fans the implicated unit.
        }
        // Clone the UNIT's kickoff repo into the round worktree: it shares the
        // unit repo history, so the committed round edit pushes fast-forward back
        // to the unit repo (which the authoritative change-level gate and the
        // integration overlay read, preserving gate-equals-deploy). The round-N
        // agent's OWN repo was freshly provisioned (an empty bare repo), so the
        // same commit is also pushed there to make it a real repo the round-N
        // agent populated, recorded as that agent's workspace.
        const worktreeDir = await ensureWorktree(unit.unitId, nextRound, unit.authRemote);
        if (roundLeased) {
          roundReportStep("cloning", `cloning the round ${nextRound} workspace`);
        }
        let executed = false;
        let modelId = escalationModel;
        try {
          const result = await executor.execute({
            worktreeDir,
            workUnitId: unit.unitId,
            objective: escalationObjective(unit.objective, lastEvidence, nextRound),
            paths: unit.paths,
            baselineRef: input.baselineRef,
            model: escalationModel,
            ...(input.frozenContracts.length > 0
              ? { frozenContracts: input.frozenContracts }
              : {}),
            ...(unit.requiredExports.length > 0
              ? { requiredExports: unit.requiredExports }
              : {}),
            // Thread the per-unit observability callbacks into the retry's
            // executor call, exactly as the base wave does. Each real step and
            // prompt summary is relayed to BOTH the kickoff unit's activity log
            // (so the original unit shows the second wave) AND the round-N
            // agent's own activity log (so the round-N node carries real steps),
            // proving the escalation model ran this round.
            onPromptSummary: (summary) => {
              reportLadderStep(post, changeId, unit.unitId, "prompt", summary);
              roundReportDetail({ promptSummary: summary });
            },
            onStep: (step) => {
              reportLadderStep(post, changeId, unit.unitId, step.phase, step.message);
              roundReportStep(step.phase, step.message);
            },
          });
          executed = true;
          modelId = result.cost.model ?? escalationModel;
          // Record the round-N agent's rich model detail (the model id, edited
          // paths, a readable diff, the commit message, and token usage/cost),
          // exactly as the kickoff agent records its detail, so the round-N node
          // carries real activity/detail (model, edited paths, diff).
          const diff = await buildEditDiff(worktreeDir, result.changedPaths);
          roundReportDetail({
            ...(result.cost.model ? { model: result.cost.model } : {}),
            editedPaths: result.changedPaths,
            ...(diff ? { diff } : {}),
            commitMessage: result.commitMessage,
            ...(result.cost.inputTokens !== undefined ? { inputTokens: result.cost.inputTokens } : {}),
            ...(result.cost.outputTokens !== undefined ? { outputTokens: result.cost.outputTokens } : {}),
            ...(result.cost.usd !== undefined ? { usd: result.cost.usd } : {}),
          });
        } catch {
          // Fall through: the re-verify fails the gate and, if the budget is
          // exhausted, the gated units are marked red.
        }
        if (await hasChanges(worktreeDir)) {
          const commitMessage = `WorkUnit ${unit.unitId}: change-level model-escalation retry round ${nextRound}`;
          roundReportStep("commit", `committing: ${commitMessage}`);
          await commitAll(worktreeDir, commitMessage, identity);
          // Push to the unit's kickoff repo first (fast-forward, since the round
          // worktree was cloned from it) so the authoritative change-level gate
          // and the integration overlay read the edit (gate-equals-deploy). Then
          // push the SAME commit to the round-N agent's OWN repo (its recorded
          // workspace, a fresh bare repo) so that node is a real pushed agent.
          await push(worktreeDir, unit.authRemote, input.defaultBranch);
          if (roundRemote) {
            roundReportStep("push", `pushing to the round ${nextRound} workspace`);
            await push(worktreeDir, roundRemote, input.defaultBranch).catch(() => {});
          }
          roundReportStep("pushed", `pushed round ${nextRound} edit by ${modelId}`);
          reportLadderStep(
            post,
            changeId,
            unit.unitId,
            "retried",
            `retry round ${nextRound} on ${escalationModel}: pushed re-fanned edit`,
          );
          // The round-N agent completed its work (it pushed an edit), so walk
          // its instance to the terminal "integrated" status, exactly as a
          // kickoff agent that pushed does. The authoritative change-level gate
          // still decides whether the whole change passed: a round-N agent going
          // green individually does NOT mean the change passed.
          await reportRoundComplete(post, changeId, unit.unitId, nextRound);
        } else {
          reportLadderStep(
            post,
            changeId,
            unit.unitId,
            "retried",
            `retry round ${nextRound} on ${escalationModel}: no change produced`,
          );
          // The round-N agent produced no usable edit (its executor errored or
          // dropped the rewrite), so walk its instance to the terminal "failed"
          // status, exactly as a kickoff agent that failed does.
          await reportRoundFail(
            post,
            changeId,
            unit.unitId,
            nextRound,
            executed
              ? `retry round ${nextRound} produced no change`
              : `retry round ${nextRound} executor call failed`,
          );
        }
      };
      await runBounded(implicated, refanConcurrency, refanOne);

      currentModel = escalationModel;
      round = nextRound;
      outcome = await runChangeGate();
      await recordVerifyAttempt(
        post,
        changeId,
        round,
        outcome.passed,
        currentModel,
        gateCommand,
        outcome.evidence,
      );
      emit({ kind: "verify-attempt", round, outcome: outcome.passed ? "pass" : "fail", model: currentModel });
      if (outcome.passed) {
        return true;
      }
      lastEvidence = outcome.evidence;
    }

    return false;
  } finally {
    for (const dir of unitWorktrees.values()) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Pick the IMPLICATED units for a change-level gate failure: the units whose
 * declared paths (WorkUnit.paths) cover a file the failing gate output named. A
 * declared path matches a failing file when the failing path equals it, is under
 * it (a declared directory/prefix), or matches a simple `*`/`**` glob. When no
 * failing file can be extracted, or none maps to a declared path, FALL BACK to
 * ALL gated units (never silently skip): the change genuinely failed, so
 * attribution is best-effort narrowing, not a correctness claim.
 */
function selectImplicatedUnits(
  gatedUnits: readonly GatedUnitInput[],
  evidence: string,
): readonly GatedUnitInput[] {
  const failingFiles = extractFailingFiles(evidence);
  if (failingFiles.length === 0) {
    return gatedUnits; // nothing to attribute to: re-fan all
  }
  const implicated = gatedUnits.filter((unit) =>
    unit.paths.some((declared) => failingFiles.some((file) => pathCovers(declared, file))),
  );
  // Honest fallback: if the named files do not map to any unit's declared paths,
  // re-fan all rather than silently skip (the change failed either way).
  return implicated.length > 0 ? implicated : gatedUnits;
}

/**
 * Extract repo-relative file paths named in a failing gate output. node:test and
 * typecheck output name source files (e.g. `src/routes/create.js`) in assertion
 * and stack-trace lines, so a conservative path-shaped match pulls those out.
 * Returns a deduplicated list; an empty list means nothing attributable.
 */
function extractFailingFiles(evidence: string): readonly string[] {
  const found = new Set<string>();
  // Match path-shaped tokens: one or more segments separated by `/`, ending in a
  // file with an extension. Strips surrounding punctuation and line/col suffixes.
  const re = /([A-Za-z0-9_.-]+\/[A-Za-z0-9/_.-]+\.[A-Za-z0-9]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(evidence)) !== null) {
    const raw = match[1];
    if (raw) {
      found.add(raw);
    }
  }
  return [...found];
}

/**
 * Whether a declared WorkUnit path covers a failing file path. Supports an exact
 * match, a directory/prefix match (the declared path is a parent of the file),
 * and a simple `*`/`**` glob (as the example apps declare, e.g. `src/routes/**`).
 */
function pathCovers(declared: string, file: string): boolean {
  const d = declared.replace(/^\.\//, "").replace(/\/+$/, "");
  const f = file.replace(/^\.\//, "");
  if (d === f) {
    return true;
  }
  if (d.includes("*")) {
    // Translate a simple glob to a RegExp: `**` matches across segments, `*`
    // within a segment. Anchored to the whole path.
    const escaped = d
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}$`).test(f);
  }
  // Directory/prefix match: the declared path is a parent directory of the file.
  return f === d || f.startsWith(`${d}/`);
}

/**
 * Build a disposable integration worktree for a change-level gate round: clone
 * the project baseline, then overlay each gated unit's current pushed edit (the
 * files that differ from the unit repo's first commit) onto it, so the gate runs
 * ONCE against the whole change. The caller removes the directory after the gate
 * runs. This keeps the gate honest at the change level: it verifies the combined
 * result of every unit's edit, not one unit's repo in isolation.
 */
async function buildIntegrationWorktree(
  projectDir: string,
  units: readonly { readonly unitId: string; readonly authRemote: string }[],
  worktreeRoot: string,
): Promise<string> {
  const { cp } = await import("node:fs/promises");
  const integrationDir = await mkdtemp(join(worktreeRoot, "scf-change-gate-"));
  // Seed from the project baseline so the gate's package.json / gate script and
  // the unedited app source are present.
  await cloneProjectForPromotion(projectDir, integrationDir);
  // Overlay each unit's pushed edit. Clone the unit repo to a scratch dir and
  // copy its changed files (vs the baseline) onto the integration worktree.
  for (const unit of units) {
    const unitDir = await mkdtemp(join(worktreeRoot, `scf-overlay-${unit.unitId}-`));
    try {
      await clone(unit.authRemote, unitDir);
      const changed = await changedPathsVsBaseline(unitDir);
      for (const rel of changed) {
        const from = join(unitDir, rel);
        const to = join(integrationDir, rel);
        await mkdir(dirname(to), { recursive: true }).catch(() => {});
        await cp(from, to, { recursive: true }).catch(() => {});
      }
    } finally {
      await rm(unitDir, { recursive: true, force: true });
    }
  }
  return integrationDir;
}

/**
 * List the repo-relative files a cloned unit repo changed versus its baseline
 * commit (the seeded app). The runner commits the edit on top of the seeded
 * baseline, so diffing HEAD against its parent names the edited files; when the
 * repo has a single commit (seeded + edit squashed), fall back to listing all
 * tracked files that are not part of the known baseline is unnecessary, so the
 * HEAD~1..HEAD diff is used, falling back to the full tracked set.
 */
async function changedPathsVsBaseline(repoDir: string): Promise<readonly string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // Prefer the diff of the last commit against its parent (the edit on top of
  // the seeded baseline). Fall back to the tree of HEAD when there is no parent.
  try {
    const { stdout } = await run("git", [
      "-C",
      repoDir,
      "--no-pager",
      "diff",
      "--name-only",
      "HEAD~1",
      "HEAD",
    ]);
    const list = stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "");
    if (list.length > 0) {
      return list;
    }
  } catch {
    // No parent commit: fall through to listing tracked files.
  }
  try {
    const { stdout } = await run("git", ["-C", repoDir, "ls-files"]);
    return stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  } catch {
    return [];
  }
}

/** Run the per-app gate once and return a mechanical pass/fail plus evidence. */
async function runGate(
  gateCommand: readonly string[],
  runner: VerificationCommandRunner,
  worktreeDir: string,
): Promise<{ readonly passed: boolean; readonly evidence: string }> {
  let outcome: VerificationCommandOutcome;
  try {
    outcome = await runner.run(gateCommand, worktreeDir);
  } catch (error) {
    return { passed: false, evidence: failureReason(error) };
  }
  const passed = outcome.code === 0;
  const evidence = [outcome.stderr, outcome.stdout]
    .map((s) => (s ?? "").trim())
    .filter((s) => s !== "")
    .join("\n")
    .slice(0, 4000);
  return { passed, evidence };
}

/** Record one mechanical CHANGE-LEVEL verify round on the Worker (best-effort). */
async function recordVerifyAttempt(
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  changeId: string,
  round: number,
  passed: boolean,
  model: string,
  gateCommand: readonly string[],
  evidence: string,
): Promise<void> {
  await post(`/changes/${encodeURIComponent(changeId)}/verify-attempt`, {
    round,
    outcome: passed ? "pass" : "fail",
    model,
    gateCommand: gateCommand.join(" "),
    // The real failing gate output, recorded only on a fail (truncated by the
    // DO), so the console can show WHY the round failed. Never on a pass.
    ...(passed ? {} : { failingOutput: evidence }),
  }).catch(() => {});
}

/**
 * Record one REAL per-unit activity step for the change-level ladder (best-effort,
 * never throws into the run). This is the same `/work/<unit>/step` route the
 * kickoff wave posts to, so a retry round's re-fan surfaces in the unit's
 * activity log exactly like its first-wave steps: the console renders it as a
 * visible second wave for that unit (a transient "retrying" step while the round
 * runs, then a settled "retried" step). The step is backed by a real re-fan
 * action, so it is not a synthesized log line.
 */
function reportLadderStep(
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  changeId: string,
  unitId: string,
  phase: string,
  message: string,
): void {
  void post(
    `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/step`,
    { phase, message },
  ).catch(() => {});
}

/**
 * Report one real run step for a ROUND-N agent instance (best-effort, never
 * throws into the run). This is the round-scoped parallel of the kickoff wave's
 * reportStep: a retry round's re-fanned agent reports its own real steps
 * (leased, cloning, model-call, applied-edit, commit, push, pushed) to its own
 * (unit, round) activity log, so the round-N graph node carries real steps
 * exactly like a kickoff agent node.
 */
function reportRoundStep(
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  changeId: string,
  unitId: string,
  round: number,
  phase: string,
  message: string,
): void {
  void post(
    `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/round/${round}/step`,
    { phase, message },
  ).catch(() => {});
}

/**
 * Report the rich model detail for a ROUND-N agent instance (best-effort). The
 * round-scoped parallel of the kickoff wave's reportDetail: the round-N agent
 * reports its model id, edited paths, diff, commit message, and token usage to
 * its own (unit, round) detail, so the round-N node carries real detail.
 */
function reportRoundDetail(
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  changeId: string,
  unitId: string,
  round: number,
  detail: Record<string, unknown>,
): void {
  void post(
    `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/round/${round}/detail`,
    detail,
  ).catch(() => {});
}

/**
 * Mark a ROUND-N agent instance COMPLETE (best-effort): its round pushed an
 * edit, so the round-N instance walks to the terminal "integrated" status and
 * the graph greens that node. Awaited so the terminal status is recorded before
 * the next change-level verify reads state, but a failure to record it never
 * fails the run (the authoritative gate still decides the change outcome).
 */
async function reportRoundComplete(
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  changeId: string,
  unitId: string,
  round: number,
): Promise<void> {
  await post(
    `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/round/${round}/complete`,
  ).catch(() => {});
}

/**
 * Mark a ROUND-N agent instance FAILED (best-effort): its round's executor
 * errored or produced no usable edit, so the round-N instance walks to the
 * terminal "failed" status and the graph reds that node.
 */
async function reportRoundFail(
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  changeId: string,
  unitId: string,
  round: number,
  reason: string,
): Promise<void> {
  await post(
    `/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/round/${round}/fail`,
    { reason },
  ).catch(() => {});
}

/**
 * Run `task` over `items` with BOUNDED concurrency: at most `limit` tasks are
 * in flight at once, never unbounded parallel and never strictly sequential
 * (unless the limit is 1). A small fixed pool of workers pulls from a shared
 * cursor, so N items complete in roughly ceil(N / limit) waves of task latency.
 * Rejections propagate (the first failure rejects the whole run) after the
 * in-flight tasks settle, matching an awaited sequential loop's error behavior.
 */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      await task(items[index]!);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < cap && i < items.length; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * Fold the failing gate evidence into the escalation attempt's objective, and
 * ROTATE the strategy per retry round so each retry both varies the instruction
 * and feeds the REAL failing gate output. Varying the text per round also means
 * the gateway cache is naturally bypassed on a retry (a different prompt is a
 * different cache key), so a retry gets a fresh attempt rather than the cached
 * failing reply.
 *
 *   - round <= 1 (the base attempt): the minimal-edit base prompt, no evidence.
 *     The base round runs the executor's own buildMessages, so this returns the
 *     objective unchanged.
 *   - the first retry round: "the previous edit failed this check; fix precisely
 *     what failed", with the real failing gate evidence, steering a focused fix
 *     rather than a rewrite.
 *   - a later retry round: escalate the strategy to "return the FULL corrected
 *     file, honoring the frozen contract", still with the real failing evidence,
 *     for the case a focused patch was not enough.
 *
 * The text is goal-agnostic (no per-app wording): it only references the
 * objective and the mechanical gate evidence, so it works for any Change.
 */
function escalationObjective(objective: string, evidence: string, round: number): string {
  const trimmed = evidence.trim();
  if (round <= 1 || trimmed === "") {
    return objective;
  }
  const clippedEvidence = trimmed.slice(0, 2000);
  const strategy =
    round === 2
      ? [
          "The previous edit failed this behavioral gate check. Fix PRECISELY what failed:",
          "make the smallest change that resolves the failure below, keep every other file as it is,",
          "and import and honor the frozen contract files unchanged.",
        ].join(" ")
      : [
          "The previous edits still fail this behavioral gate check. Return the FULL corrected contents",
          "of only the file(s) you must change to resolve the failure below, honoring the frozen contract",
          "files unchanged. Do not rewrite or edit any frozen contract.",
        ].join(" ");
  return `${objective}\n\n${strategy}\n\nFailing gate evidence:\n${clippedEvidence}`;
}

/**
 * The agent-for-agent tool-build step for the live run. If the Change's WORK
 * needs a capability the repo lacks, one agent provisions its OWN real Artifact
 * repo (the honest local-filesystem fallback when offline, exactly as the agent
 * runners use), builds the codemod there, commits and pushes it, and downstream
 * agents clone that repo and genuinely run the tool (a real effect, changed=
 * true). We then record the tool and each real consumption on the Worker so the
 * live console graph projects the tool node (backed by its own repo) and the
 * consumed-tool edges from real state. Returns undefined when the work needs no
 * such tool (the trigger is structural), so a layered Change records nothing.
 */
async function buildAndRecordTool(
  change: Change,
  workRoot: string,
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  enableToolBuild: boolean,
): Promise<ToolBuildResult | undefined> {
  // Off by default: an ordinary multi-module change builds no tool, so no tool
  // node (backed or otherwise) can appear. Only an explicit opt-in takes the
  // tool path.
  if (!enableToolBuild) {
    return undefined;
  }
  const { LocalFilesystemWorkspaceProvider } = await import(
    "@switchyard-change/artifact-workspace/local"
  );
  const toolRoot = join(workRoot, "tool-build");
  await mkdir(toolRoot, { recursive: true });
  const workspaces = new LocalFilesystemWorkspaceProvider({
    rootDir: join(toolRoot, "artifacts"),
  });
  // The builder is a REAL recruited agent (the first fanned-out unit of the
  // group), so the tool node hangs off a backed agent that already exists in the
  // Change and the Worker accepts the record; the remaining units consume it.
  const { detectToolRequirement } = await import("@switchyard-change/change-core");
  const requirement = detectToolRequirement(change);
  const builderUnitId = requirement?.consumers[0];
  const tool = await maybeBuildTool({
    change,
    workRoot: toolRoot,
    workspaces,
    enableToolBuild: true,
    ...(builderUnitId ? { builderUnitId } : {}),
  });
  if (!tool) {
    return undefined;
  }
  // Record the tool and its real downstream consumptions on the Worker, so the
  // console's tool node is backed by the Change's live state. Only consumers
  // that actually ran the tool (changed=true) are recorded as consumed-tool
  // edges, keeping the graph honest about genuine use.
  await post(`/changes/${encodeURIComponent(change.id)}/tool`, {
    builderUnitId: tool.builderUnitId,
    capability: tool.capability,
    toolPath: tool.toolPath,
    label: tool.label,
    workspace: tool.workspace,
    consumers: tool.consumptions.filter((c) => c.changed).map((c) => c.consumerUnitId),
  }).catch(() => {
    // Best-effort: a Worker that does not know the tool route still runs the
    // rest of the chain; the tool repo is already real and tracked for cleanup.
  });
  return tool;
}

/**
 * Run the escalation beat against the live Worker. If the Change has a contested
 * shared path, raise a lease-owner escalation, confirm the Worker reports it
 * pending (the durable wait), obtain the human decision, and proceed. When there
 * is no contested path, there is nothing to escalate and the beat reports it did
 * not raise one.
 *
 * Two resolution modes:
 *   - external (awaitExternal: true): the beat raises the escalation and then
 *     BLOCKS, polling the Worker until some external actor (the console, where a
 *     human clicks an answer) resolves the durable record. The beat never
 *     resolves the fork itself, so the run genuinely pauses on a real pending
 *     escalation until the human answers in the browser. This is the escalating
 *     template's path.
 *   - self (the default): the beat asks the `resolver` (or falls back to the
 *     deterministic default owner) for the decision and resolves the record
 *     itself, so an unattended offline/CLI/test run still proves the full chain
 *     without a human in the loop.
 */
async function runEscalationBeat(
  change: Change,
  changeId: string,
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  getJson: (path: string) => Promise<Record<string, unknown>>,
  resolver: EscalationResolver | undefined,
  emit: (event: FullLiveEvent) => void,
  external: { readonly awaitExternal: boolean; readonly timeoutMs: number; readonly pollMs: number },
): Promise<EscalationReport> {
  const collisions = detectPathCollisions(change);
  const plan = planWriteLeases(change, collisions);
  // Pick the first serialized contested path with real contention (2+ writers).
  const contested = plan.decisions.find(
    (d: LeaseDecision) => d.contenders.length > 1,
  );
  if (!contested) {
    return { raised: null, resolved: null, waited: false };
  }

  const question =
    `Shared path ${contested.path} is written by ${contested.contenders.join(", ")}. ` +
    `Mechanical evidence cannot decide which agent should own the single write lease. ` +
    `Choose the owner.`;
  const raisedResp = await post(`/changes/${encodeURIComponent(changeId)}/escalations`, {
    kind: "lease-owner",
    path: contested.path,
    question,
    options: contested.contenders,
  });
  const raised = raisedResp.escalation as Escalation;
  emit({ kind: "escalation-raised", escalation: raised });

  // The wait: confirm the Worker durably reports a pending escalation. This is a
  // real durable record read back from state, not a sleep.
  const state = await getJson(`/changes/${encodeURIComponent(changeId)}`);
  const escalations = (state.escalations as Escalation[] | undefined) ?? [];
  const waited = escalations.some((e) => e.id === raised.id && e.status === "pending");

  if (external.awaitExternal) {
    // Block on the browser. Poll the durable escalation record until a human has
    // resolved it in the console (which POSTs the resolve to the Worker). The
    // engine proceeds only AFTER that external decision lands, so the run truly
    // pauses on the real pending fork. The beat never resolves the record here.
    const resolved = await awaitExternalResolution(
      changeId,
      raised.id,
      getJson,
      external.timeoutMs,
      external.pollMs,
    );
    emit({ kind: "escalation-resolved", escalation: resolved });
    return { raised, resolved, waited };
  }

  // The self-resolve path: in an unattended run a resolver supplies the owner
  // (offline/in a test an auto-resolver returns the deterministic default owner
  // so the chain still proves end to end). Either way the engine proceeds only
  // AFTER a decision resolves the durable record.
  const defaultOwner = contested.owner ?? contested.contenders[0] ?? "";
  const decision = resolver ? await resolver(raised) : defaultOwner;
  const resolvedResp = await post(
    `/changes/${encodeURIComponent(changeId)}/escalations/${encodeURIComponent(raised.id)}/resolve`,
    { decision },
  );
  const resolved = resolvedResp.escalation as Escalation;
  emit({ kind: "escalation-resolved", escalation: resolved });

  return { raised, resolved, waited };
}

/**
 * Poll the Worker until the given escalation is resolved by an external actor
 * (the human clicking an answer in the console, which POSTs the resolve to the
 * Worker). Returns the resolved escalation record. Throws if the escalation is
 * not resolved within the timeout, so an abandoned run does not hang forever.
 */
async function awaitExternalResolution(
  changeId: string,
  escalationId: string,
  getJson: (path: string) => Promise<Record<string, unknown>>,
  timeoutMs: number,
  pollMs: number,
): Promise<Escalation> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getJson(`/changes/${encodeURIComponent(changeId)}`);
    const escalations = (state.escalations as Escalation[] | undefined) ?? [];
    const found = escalations.find((e) => e.id === escalationId);
    if (found && found.status === "resolved") {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `escalation ${escalationId} on Change ${changeId} was not resolved within ` +
          `${Math.round(timeoutMs / 1000)}s; the run was waiting on a human answer in the console`,
      );
    }
    await delay(pollMs);
  }
}

/** A small awaitable delay used by the external-resolution poll loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a disposable local integration workspace seeded from the project
 * baseline. Integration/promotion are Node-side Git operations, so this uses the
 * local-filesystem provider regardless of where the unit repos live.
 */
async function createIntegrationWorkspace(
  workRoot: string,
  projectDir: string,
  changeId: string,
  identity: GitIdentity,
): Promise<{
  integrationRef: import("@switchyard-change/artifact-workspace").WorkspaceRef;
  integrationToken: string;
  workspaces: import("@switchyard-change/artifact-workspace/local").LocalFilesystemWorkspaceProvider;
}> {
  const { LocalFilesystemWorkspaceProvider } = await import(
    "@switchyard-change/artifact-workspace/local"
  );
  const artifactsRoot = join(workRoot, "integration-artifacts");
  await mkdir(artifactsRoot, { recursive: true });
  const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: artifactsRoot });
  const name = `${changeId}--integration`.replace(/[^A-Za-z0-9._-]+/g, "-");
  const integrationRef = await workspaces.create(name, { defaultBranch: "main" });
  const token = await workspaces.issueWriteToken(integrationRef);
  await seedFromProject(integrationRef, projectDir, join(workRoot, "seed"), identity);
  return { integrationRef, integrationToken: token.token, workspaces };
}

async function seedFromProject(
  ref: import("@switchyard-change/artifact-workspace").WorkspaceRef,
  projectDir: string,
  scratchRoot: string,
  identity: GitIdentity,
): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await mkdir(scratchRoot, { recursive: true });
  const work = await mkdtemp(join(scratchRoot, "seed-"));
  try {
    await cloneProjectForPromotion(projectDir, work);
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
 * Materialize an app's SHARED gate dependencies so its per-app gate resolves
 * inside a composed worktree. An app under a shared apps directory keeps its
 * per-app gate test at `<app>/gate/*.test.mjs` and may import a shared helper
 * one directory ABOVE the app (for example `../../gate-harness.mjs`). The
 * worktrees the gate runs in are seeded from the app directory alone and are
 * created directly under `parentDir`, so a gate test at
 * `<parentDir>/<worktree>/gate/gate.test.mjs` resolves `../../gate-harness.mjs`
 * to `<parentDir>/gate-harness.mjs`. Copying the app's sibling shared `.mjs`
 * files into `parentDir` therefore makes that import resolve for ANY app that
 * follows this shared-harness layout, without editing the gate or the app.
 *
 * It copies only top-level `.mjs` files that sit BESIDE the app directory (the
 * shared seam helpers), never the app dir itself or anything deeper, so it does
 * not drag unrelated apps or large trees into the worktree parent. A missing
 * sibling directory, or a project directory with no parent (a repo-root target),
 * is a no-op: an app with no shared sibling simply needs nothing copied.
 */
async function materializeSiblingGateDeps(projectDir: string, parentDir: string): Promise<void> {
  const { readdir, copyFile } = await import("node:fs/promises");
  const { resolve, dirname, join: joinPath } = await import("node:path");
  const appDir = resolve(projectDir);
  const siblingDir = dirname(appDir);
  if (siblingDir === appDir) {
    // projectDir is a filesystem root; there is no sibling directory to read.
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(siblingDir, { withFileTypes: true });
  } catch {
    // No readable parent directory: nothing shared to materialize.
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
      .map((entry) =>
        copyFile(joinPath(siblingDir, entry.name), joinPath(parentDir, entry.name)).catch(() => {
          // Best-effort: a copy that fails leaves the gate to fail honestly with
          // its own resolution error rather than masking it here.
        }),
      ),
  );
}

/**
 * Clone a project directory into a fresh working repository for promotion. A Git
 * repo root is cloned directly; a plain directory is initialized into a repo so
 * the baseline always has a HEAD commit and the caller's tree is never touched.
 */
async function cloneProjectForPromotion(projectDir: string, targetDir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { cp } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const run = promisify(execFile);

  const isRepoRoot = await (async () => {
    try {
      const { stdout } = await run("git", ["-C", projectDir, "rev-parse", "--show-toplevel"]);
      return resolve(stdout.trim()) === resolve(projectDir);
    } catch {
      return false;
    }
  })();

  if (isRepoRoot) {
    await run("git", ["clone", projectDir, targetDir]);
    return;
  }

  const projectRoot = resolve(projectDir);
  const skip = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
  await mkdir(targetDir, { recursive: true });
  await cp(projectDir, targetDir, {
    recursive: true,
    filter: (src: string) => {
      const rel = resolve(src).slice(projectRoot.length).replace(/^[/\\]/, "");
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
}

async function currentBranch(dir: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

/** Archive the real Artifact repos the run created, through the Worker. */
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
      // Best-effort: the fabric also expires disposable repos on its own.
    }
  }
  return archived.sort();
}

/** The outcome of a watch-mode cleanup pass. */
export interface CleanupLiveResult {
  readonly changeId: string;
  readonly workerUrl: string;
  /** The workspace (Artifact repo) names the Change recorded. */
  readonly workspaces: readonly string[];
  /** The workspace names actually archived (deleted). */
  readonly archived: readonly string[];
  /** The app name torn down (its deployed Worker deleted), when one was. */
  readonly appTornDown?: string;
}

/**
 * Tear down the real Artifact repos a watch-mode run left in place. It reads the
 * Change's live state from the Worker, collects every recorded workspace, and
 * archives each through the Worker's archive path. This is the human-triggered
 * cleanup the `--watch` / `--no-cleanup` run defers to, so a watcher can study
 * the finished graph in the console first and then remove the repos on demand.
 *
 * It also tears down the manually DEPLOYED app so nothing leaks. A deployment is
 * per-app and keyed by the stable worker name, so teardown deletes the app by
 * that stable name. The app is taken from `options.app` when the caller knows it
 * (the console passes the active template's app), falling back to the app the
 * run recorded on state. The optional `onAppTornDown` hook clears the per-app
 * deployment marker so a later run sees the app as no longer deployed.
 */
export async function cleanupLive(options: {
  readonly changeId: string;
  readonly workerUrl: string;
  readonly fetchFn?: typeof fetch;
  /** The app to tear down (its examples/apps/<app> dir name). Preferred source. */
  readonly app?: string;
  /** Injectable app teardown; called with the stable worker name. */
  readonly teardownApp?: TeardownApp;
  /** Called with the app name after a successful teardown, to clear its marker. */
  readonly onAppTornDown?: (app: string) => Promise<void>;
}): Promise<CleanupLiveResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const base = options.workerUrl.replace(/\/$/, "");
  const res = await fetchFn(`${base}/changes/${encodeURIComponent(options.changeId)}`);
  if (res.status >= 400) {
    const text = await res.text();
    const detail = (safeJson(text) as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(`cannot read Change ${options.changeId}: ${detail}`);
  }
  const state = (safeJson(await res.text()) as {
    work?: ReadonlyArray<{ workspace?: { workspaceName?: string } }>;
    deployment?: { url?: string; app?: string };
  });
  const workspaces = (state.work ?? [])
    .map((u) => u.workspace?.workspaceName)
    .filter((n): n is string => typeof n === "string" && n !== "")
    .sort();
  const archived = await cleanup(base, fetchFn, workspaces);
  // Tear down the manually deployed app too. Prefer the caller-supplied app (the
  // console knows the active template's app even when the run never redeployed),
  // falling back to whatever the run recorded on state. Deployment is per-app and
  // keyed by the stable worker name, so teardown deletes that stable worker. A
  // worker already gone is a safe no-op. The marker is cleared on success.
  let appTornDown: string | undefined;
  const app = options.app ?? state.deployment?.app;
  if (app && options.teardownApp) {
    try {
      await options.teardownApp({ appDir: app, appName: stableAppWorkerName(app) });
      appTornDown = app;
      await options.onAppTornDown?.(app).catch(() => {});
    } catch {
      // Best-effort: the Makefile delete-app is the authoritative teardown path.
    }
  }
  return {
    changeId: options.changeId,
    workerUrl: base,
    workspaces,
    archived,
    ...(appTornDown ? { appTornDown } : {}),
  };
}

/**
 * A short, readable failure reason from a thrown executor error, bounded in
 * length. The executor never puts a credential in its error, but bound the
 * length defensively so a huge stack trace does not bloat the state. The DO
 * sanitizes it again before storing it.
 */
function failureReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? "agent failed"))
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") {
    return "agent failed";
  }
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Build the effective Change to verify, integrate, and promote from the live
 * Worker state. Dynamic branching appends DISCOVERED units to the Worker's state
 * (not to the in-memory options.change), so the state's work set is the grown
 * graph. This reconstructs a Change whose `work` is that grown set (keeping the
 * original id/objective/baseline/budget/assurance), so verification and
 * integration cover the discovered units exactly like the declared ones. When
 * the state carries no work (an unexpected read failure), it falls back to the
 * original Change rather than dropping the whole run.
 */
function effectiveChangeFromState(original: Change, state: Record<string, unknown>): Change {
  const rawWork = state.work as
    | ReadonlyArray<{
        id?: string;
        objective?: string;
        dependsOn?: readonly string[];
        paths?: readonly string[];
      }>
    | undefined;
  if (!Array.isArray(rawWork) || rawWork.length === 0) {
    return original;
  }
  const work = rawWork.map((u) => ({
    id: String(u.id ?? ""),
    objective: String(u.objective ?? ""),
    dependsOn: Array.isArray(u.dependsOn) ? u.dependsOn.map((d: unknown) => String(d)) : [],
    paths: Array.isArray(u.paths) ? u.paths.map((p: unknown) => String(p)) : [],
  }));
  return { ...original, work };
}

/**
 * Build a readable unified diff of the model's edit from the cloned worktree,
 * for the console's click-detail. The edit was written into the worktree but not
 * yet committed, so `git diff` (including untracked files) shows exactly what the
 * model proposed against the baseline. The result is bounded so a huge edit does
 * not bloat the state, and it is the REAL diff of the real edit, not synthesized.
 * Returns an empty string when there is nothing to diff or Git is unavailable.
 */
async function buildEditDiff(
  worktreeDir: string,
  changedPaths: readonly string[],
): Promise<string> {
  if (changedPaths.length === 0) {
    return "";
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    // Stage intent-to-add so untracked new files appear in the diff too.
    await run("git", ["-C", worktreeDir, "add", "-AN"]).catch(() => {});
    // Diff against HEAD when the repo has one; otherwise diff against the empty
    // tree so a brand-new file in a freshly-provisioned (commitless) workspace
    // still shows its full added contents rather than nothing.
    let hasHead = true;
    try {
      await run("git", ["-C", worktreeDir, "rev-parse", "--verify", "HEAD"]);
    } catch {
      hasHead = false;
    }
    const against = hasHead
      ? ["HEAD"]
      : // The well-known empty-tree object id; diffing against it shows new files.
        ["4b825dc642cb6eb9a060e54bf8d69288fbee4904"];
    const { stdout } = await run(
      "git",
      ["-C", worktreeDir, "--no-pager", "diff", "--no-color", ...against],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const text = stdout.trim();
    if (text === "") {
      return "";
    }
    // Bound the stored diff; the console shows the head of a very large edit.
    return text.length > 16_000 ? `${text.slice(0, 16_000)}\n... (diff truncated)` : text;
  } catch {
    return "";
  }
}

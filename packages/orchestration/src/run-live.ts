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
import { join } from "node:path";

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
  type CompletedWorkUnit,
  type EvidenceSummary,
} from "@switchyard-change/verification";
import {
  LocalGitDeliveryProvider,
  defaultBranch,
  type PromotionResult,
} from "@switchyard-change/git-promotion";

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
  /** The escalation beat: what was raised, how it was resolved, and that it waited. */
  readonly escalation: EscalationReport;
  /** The deterministic verification + integration evidence. */
  readonly evidence: EvidenceSummary;
  /** The local-Git promotion result (a real branch and commit). */
  readonly promotion: PromotionResult;
  /** Absolute path to the local source repository the result was promoted into. */
  readonly sourceRepoDir: string;
  /** Workspace names the fabric archived (deleted) on cleanup. */
  readonly cleanedUp: readonly string[];
}

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
  /** An injectable fetch for tests; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
  /** Optional progress sink for human-readable console output. */
  readonly onEvent?: (event: FullLiveEvent) => void;
}

/** A progress event emitted during a full live run. */
export type FullLiveEvent =
  | { readonly kind: "change-created"; readonly changeId: string }
  | { readonly kind: "wave"; readonly wave: LiveWave }
  | { readonly kind: "escalation-raised"; readonly escalation: Escalation }
  | { readonly kind: "escalation-resolved"; readonly escalation: Escalation }
  | { readonly kind: "verifying" }
  | { readonly kind: "promoting"; readonly branch: string }
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

  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), "scf-full-")));
  await mkdir(workRoot, { recursive: true });
  const worktreeRoot = join(workRoot, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });

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
  let anyLive = false;
  let peakConcurrency = 0;

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
    const reports = await Promise.all(agents.map((a) => runAgent(a)));
    const wave: LiveWave = { trigger: waveTrigger, concurrency: agents.length, agents: reports };
    waves.push(wave);
    emit({ kind: "wave", wave });

    const next: RecruitedAgent[] = [];
    for (const report of reports) {
      const outcome = await post("/events/repo-pushed", {
        changeId,
        workspace: report.workspaceName,
      });
      next.push(...((outcome.recruited as RecruitedAgent[] | undefined) ?? []));
    }
    await runWave("repo-pushed", next);
  };

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
  );

  // 5. Verify + integrate. Clone each completed unit's real repo and verify it
  // deterministically, then integrate the verified work. Ground truth is
  // mechanical; the model never grades its own work.
  emit({ kind: "verifying" });
  const completedInputs: CompletedWorkUnit[] = [];
  for (const unit of options.change.work) {
    const gitUrl = unitWorkspaceGitUrls.get(unit.id);
    if (!gitUrl) {
      continue;
    }
    // Use the authenticated remote so verification can clone the real Artifacts
    // repo over HTTPS with the scoped token (a file:// fallback ignores it).
    const authRemote = unitAuthRemotes.get(unit.id) ?? gitUrl;
    completedInputs.push({ unitId: unit.id, gitUrl: authRemote, baselineRef: options.change.baseline });
  }

  // The integration workspace is a disposable local bare repo seeded from the
  // project baseline. Integration and promotion are Node-side Git work, so they
  // use the local provider even though the unit repos are live Artifacts.
  const { integrationRef, integrationToken, workspaces: integrationProvider } =
    await createIntegrationWorkspace(workRoot, options.projectDir, options.change.id, identity);

  const verification = new ChangeVerification(integrationProvider);
  const evidence = await verification.verifyAndIntegrate({
    change: options.change,
    completed: completedInputs,
    integrationRef,
    integrationToken,
    workRoot: worktreeRoot,
    identity,
  });

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

  // 7. Clean up the real Artifact repos the run created (and the local
  // integration repo). Only now, after the whole chain ran against them.
  const completedState = await getJson(`/changes/${encodeURIComponent(changeId)}`);
  const cleanedUp = await cleanup(base, fetchFn, [...allWorkspaces]);
  await integrationProvider.archive(integrationRef).catch(() => {});
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
    escalation,
    evidence,
    promotion,
    sourceRepoDir,
    cleanedUp,
  };
}

/**
 * Run the escalation beat against the live Worker. If the Change has a contested
 * shared path, raise a lease-owner escalation, confirm the Worker reports it
 * pending (the durable wait), ask the resolver for the human decision, and
 * resolve it. When there is no contested path, there is nothing to escalate and
 * the beat reports it did not raise one.
 */
async function runEscalationBeat(
  change: Change,
  changeId: string,
  post: (path: string, body?: unknown, contentType?: string) => Promise<Record<string, unknown>>,
  getJson: (path: string) => Promise<Record<string, unknown>>,
  resolver: EscalationResolver | undefined,
  emit: (event: FullLiveEvent) => void,
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

  // The human decision: in a live run a human supplies the owner; offline/in a
  // test an auto-resolver returns the deterministic default owner so the chain
  // still proves end to end. Either way the engine proceeds only AFTER a
  // decision resolves the durable record.
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

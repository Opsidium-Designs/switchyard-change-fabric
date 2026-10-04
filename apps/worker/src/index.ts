import { parseChangeSpec } from "@switchyard-change/change-core";

import type { LeaseWorkspace } from "./change-state.ts";
import type { EnvWithProvisioner } from "./workspace-provisioner.ts";
import { selectProvisioner } from "./workspace-provisioner.ts";

// Durable Object and Workflow classes MUST be exported from the entry module so
// the runtime can instantiate them from their bindings.
export { ChangeState } from "./change-state.ts";
export { ChangeWorkflow } from "./workflow.ts";

export type { EnvWithProvisioner } from "./workspace-provisioner.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      // The console is served from a separate origin in local dev.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

/** Get the ChangeState Durable Object stub addressed by Change id. */
function changeStateStub(env: EnvWithProvisioner, changeId: string) {
  const id = env.CHANGE_STATE.idFromName(changeId);
  return env.CHANGE_STATE.get(id);
}

/** A stable, filesystem-safe workspace name for a Change's WorkUnit. */
export function workspaceNameFor(changeId: string, unitId: string): string {
  return `${changeId}--${unitId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * The Worker is the Change control surface. It exposes:
 *   - a health probe
 *   - create a Change from a spec and read its live orchestration state
 *   - lease a runnable WorkUnit (provision a workspace + scoped token)
 *   - receive runner cost heartbeats
 *   - mark a WorkUnit complete (runner-driven), advancing the work graph
 *   - create/delete an Artifact repo directly (workspace provider wiring)
 */
export async function handleRequest(request: Request, env: EnvWithProvisioner): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return json({}, 204);
  }

  // Health / readiness probe.
  if (request.method === "GET" && url.pathname === "/") {
    return json({
      service: "switchyard-change-fabric",
      status: "ok",
      artifactsBinding: env.ARTIFACTS ? "live" : "fallback",
    });
  }

  // Create a Change from a spec. The request body is the Change spec YAML.
  if (request.method === "POST" && url.pathname === "/changes") {
    const specYaml = await request.text();
    if (specYaml.trim() === "") {
      return json({ error: "empty Change spec body" }, 400);
    }
    let probeId: string;
    try {
      probeId = parseChangeSpec(specYaml).id;
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
    const stub = changeStateStub(env, probeId);
    try {
      const state = await stub.createFromSpec(specYaml);
      return json(state, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Read a Change's live orchestration state.
  const stateMatch = url.pathname.match(/^\/changes\/([^/]+)$/);
  if (request.method === "GET" && stateMatch) {
    const changeId = decodeURIComponent(stateMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    return json(await stub.getState());
  }

  // Lease a runnable WorkUnit: provision a workspace + scoped write token and
  // hand the clone URL and plaintext token to the runner exactly once.
  const leaseMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/lease$/);
  if (request.method === "POST" && leaseMatch) {
    const changeId = decodeURIComponent(leaseMatch[1] ?? "");
    const unitId = decodeURIComponent(leaseMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const provisioner = selectProvisioner(env);
    let provisioned;
    try {
      provisioned = await provisioner.provision(workspaceNameFor(changeId, unitId));
    } catch (error) {
      return json({ error: errorMessage(error) }, 502);
    }
    const workspace: LeaseWorkspace = {
      workspaceId: provisioned.workspaceId,
      workspaceName: provisioned.workspaceName,
      gitUrl: provisioned.gitUrl,
      defaultBranch: provisioned.defaultBranch,
      backend: provisioned.backend,
      fallback: provisioned.fallback,
      tokenId: provisioned.tokenId,
      tokenExpiresAt: provisioned.tokenExpiresAt,
    };
    try {
      const record = await stub.recordLease(unitId, workspace);
      // The plaintext token is returned once to the runner and never persisted.
      return json({ ...record, token: provisioned.token }, 201);
    } catch (error) {
      // Could not record the lease: revoke the just-issued token to avoid leaks.
      await provisioner.revoke(provisioned.workspaceName, provisioned.tokenId).catch(() => {});
      return json({ error: errorMessage(error) }, 409);
    }
  }

  // Record a runner cost heartbeat for a WorkUnit.
  const costMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/cost$/);
  if (request.method === "POST" && costMatch) {
    const changeId = decodeURIComponent(costMatch[1] ?? "");
    const unitId = decodeURIComponent(costMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: CostBody;
    try {
      body = (await request.json()) as CostBody;
    } catch {
      return json({ error: "invalid cost body" }, 400);
    }
    try {
      const state = await stub.recordCost({
        unitId,
        usd: numberOr(body.usd, 0),
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        executor: body.executor,
      });
      return json(state);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Mark a WorkUnit complete (runner-driven), optionally with a final cost
  // event. Revokes the lease's token and advances the work graph.
  const completeMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/complete$/);
  if (request.method === "POST" && completeMatch) {
    const changeId = decodeURIComponent(completeMatch[1] ?? "");
    const unitId = decodeURIComponent(completeMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: CompleteBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as CompleteBody;
      } catch {
        return json({ error: "invalid completion body" }, 400);
      }
    }
    const lease = await stub.getLease(unitId);
    try {
      const cost = body.cost
        ? {
            usd: numberOr(body.cost.usd, 0),
            inputTokens: body.cost.inputTokens,
            outputTokens: body.cost.outputTokens,
            executor: body.cost.executor,
          }
        : undefined;
      const state = await stub.completeUnit(unitId, cost);
      if (lease) {
        const provisioner = selectProvisioner(env);
        await provisioner.revoke(lease.workspaceName, lease.tokenId).catch(() => {});
      }
      return json(state);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Configure the min/max concurrency dial for a Change. The dial is the single
  // lever that governs how many agents recruitment runs at once.
  const dialMatch = url.pathname.match(/^\/changes\/([^/]+)\/dial$/);
  if (request.method === "POST" && dialMatch) {
    const changeId = decodeURIComponent(dialMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: DialBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as DialBody;
      } catch {
        return json({ error: "invalid dial body" }, 400);
      }
    }
    const dial = await stub.configureDial({
      minConcurrency: body.minConcurrency ?? body.min ?? 1,
      maxConcurrency: body.maxConcurrency ?? body.max ?? 3,
    });
    return json({ dial });
  }

  // Kick off recruitment: recruit the first wave of agents under the dial. Each
  // recruited agent gets its OWN workspace (its own Artifact repo) and a scoped
  // token. This is the engine-driven start; subsequent waves are driven by real
  // repo-pushed events, not by polling.
  const recruitMatch = url.pathname.match(/^\/changes\/([^/]+)\/recruit$/);
  if (request.method === "POST" && recruitMatch) {
    const changeId = decodeURIComponent(recruitMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const plan = await stub.planRecruitment();
    const recruited = await provisionAndRecordWave(env, changeId, plan.recruit);
    await stub.recordRecruitment({
      trigger: "kickoff",
      recruited: recruited.map((r) => r.unitId),
      ceiling: plan.ceiling,
      inFlightAfter: plan.inFlight + recruited.length,
    });
    return json({ dial: plan.dial, ceiling: plan.ceiling, recruited }, 201);
  }

  // Ingest a repo-pushed event (the real Artifacts event, or a faked one in a
  // deterministic test). The push a runner makes when it finishes a WorkUnit is
  // the trigger for the next recruitment wave. This path drives recruitment from
  // an EVENT, never from a poll or a timer.
  if (request.method === "POST" && url.pathname === "/events/repo-pushed") {
    let body: RepoPushedBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as RepoPushedBody;
      } catch {
        return json({ error: "invalid repo-pushed event body" }, 400);
      }
    }
    const changeId = body.changeId ?? changeIdFromWorkspace(body.workspace ?? "");
    const workspace = body.workspace ?? "";
    if (changeId === "" || workspace === "") {
      return json({ error: "repo-pushed event requires changeId and workspace" }, 400);
    }
    const result = await handleRepoPushed(env, changeId, workspace);
    return json(result);
  }

  // Archive (delete) an Artifact repo workspace directly. Used by the live
  // recruitment driver to clean up the real repos a run created.
  const archiveMatch = url.pathname.match(/^\/workspaces\/([^/]+)$/);
  if (request.method === "DELETE" && archiveMatch) {
    const workspaceName = decodeURIComponent(archiveMatch[1] ?? "");
    const provisioner = selectProvisioner(env);
    try {
      await provisioner.archive(workspaceName);
      return json({ archived: workspaceName });
    } catch (error) {
      return json({ error: errorMessage(error) }, 502);
    }
  }

  return json({ error: "not found" }, 404);
}

/**
 * Provision an isolated workspace and scoped write token for each recruited
 * WorkUnit and record the lease on the Durable Object. This is the exact same
 * provision-then-record path the single-unit lease endpoint uses, applied to a
 * recruited wave: every recruited agent gets its OWN workspace and token. The
 * plaintext token is returned once per unit so a runner can clone and push.
 */
async function provisionAndRecordWave(
  env: EnvWithProvisioner,
  changeId: string,
  unitIds: readonly string[],
): Promise<RecruitedAgent[]> {
  const stub = changeStateStub(env, changeId);
  const provisioner = selectProvisioner(env);
  const recruited: RecruitedAgent[] = [];
  for (const unitId of unitIds) {
    let provisioned;
    try {
      provisioned = await provisioner.provision(workspaceNameFor(changeId, unitId));
    } catch {
      continue;
    }
    const workspace: LeaseWorkspace = {
      workspaceId: provisioned.workspaceId,
      workspaceName: provisioned.workspaceName,
      gitUrl: provisioned.gitUrl,
      defaultBranch: provisioned.defaultBranch,
      backend: provisioned.backend,
      fallback: provisioned.fallback,
      tokenId: provisioned.tokenId,
      tokenExpiresAt: provisioned.tokenExpiresAt,
    };
    try {
      const record = await stub.recordLease(unitId, workspace);
      recruited.push({
        unitId: record.unitId,
        objective: record.objective,
        paths: record.paths,
        baselineRef: record.baselineRef,
        workspaceId: record.workspaceId,
        workspaceName: record.workspaceName,
        gitUrl: record.gitUrl,
        defaultBranch: record.defaultBranch,
        backend: record.backend,
        fallback: record.fallback,
        tokenId: record.tokenId,
        tokenExpiresAt: record.tokenExpiresAt,
        token: provisioned.token,
      });
    } catch {
      // Could not record (already leased or no longer runnable): revoke to avoid
      // a leaked token, and skip this unit.
      await provisioner.revoke(provisioned.workspaceName, provisioned.tokenId).catch(() => {});
    }
  }
  return recruited;
}

/**
 * Drive the event-triggered next wave: mark the pushing unit complete on the
 * DO, then provision and record a lease for each unit the dial policy recruits
 * in response, and append the inspectable recruitment event. One shared code
 * path serves the live Queue consumer and the HTTP event ingress.
 */
async function handleRepoPushed(
  env: EnvWithProvisioner,
  changeId: string,
  workspace: string,
): Promise<RepoPushedHandled> {
  const stub = changeStateStub(env, changeId);
  if (!(await stub.isInitialized())) {
    return { completedUnit: null, recruited: [], done: false };
  }
  const outcome = await stub.recordRepoPushed(workspace);
  const recruited = await provisionAndRecordWave(env, changeId, outcome.recruited);
  await stub.recordRecruitment({
    trigger: "repo-pushed",
    pushedWorkspace: workspace,
    completedUnit: outcome.completedUnit ?? undefined,
    recruited: recruited.map((r) => r.unitId),
    ceiling: outcome.event.ceiling,
    inFlightAfter: outcome.event.inFlightAfter,
  });
  return {
    completedUnit: outcome.completedUnit,
    recruited,
    done: outcome.done && recruited.length === 0,
  };
}

/**
 * Recover a Change id from a workspace name. Workspace names are
 * `<changeId>--<unitId>` (see workspaceNameFor), so the Change id is the part
 * before the last `--`. The real Artifacts repo.pushed event carries the repo
 * (workspace) name; this maps it back to the Change without a separate index.
 */
function changeIdFromWorkspace(workspace: string): string {
  const idx = workspace.lastIndexOf("--");
  return idx === -1 ? "" : workspace.slice(0, idx);
}

interface CostBody {
  readonly usd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly executor?: string;
}

interface CompleteBody {
  readonly cost?: CostBody;
}

/** Body of POST /changes/:id/dial. Accepts min/max under either spelling. */
interface DialBody {
  readonly minConcurrency?: number;
  readonly maxConcurrency?: number;
  readonly min?: number;
  readonly max?: number;
}

/** Body of POST /events/repo-pushed. */
interface RepoPushedBody {
  /** The Change id. Optional: recovered from the workspace name when omitted. */
  readonly changeId?: string;
  /** The backend workspace (Artifact repo) name that was pushed. */
  readonly workspace?: string;
}

/** A recruited agent: its WorkUnit, its own workspace, and its one-time token. */
export interface RecruitedAgent {
  readonly unitId: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly baselineRef: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId: string;
  readonly tokenExpiresAt: string;
  /** The plaintext token, returned once so a runner can clone and push. */
  readonly token: string;
}

/** The outcome of handling a repo-pushed event (shared HTTP + Queue path). */
interface RepoPushedHandled {
  readonly completedUnit: string | null;
  readonly recruited: readonly RecruitedAgent[];
  readonly done: boolean;
}

/** The shape of a repo-pushed message delivered to the Queue consumer. */
interface RepoPushedMessageBody {
  readonly type?: string;
  readonly changeId?: string;
  /** The pushed Artifact repo (workspace) name, under either field name. */
  readonly workspace?: string;
  readonly repo?: string;
  readonly repository?: string;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default {
  fetch(request: Request, env: EnvWithProvisioner): Promise<Response> {
    return handleRequest(request, env);
  },
  /**
   * Queue consumer for Artifacts repo-pushed events.
   *
   * Cloudflare Artifacts event subscriptions deliver repo lifecycle events (the
   * `repo.pushed` event among them) to a Queue; this Worker is wired as that
   * queue's consumer (see the `queues.consumers` binding in wrangler.jsonc). A
   * runner finishing a WorkUnit pushes to its own Artifact repo, which emits a
   * `repo.pushed` event that lands here and drives the next recruitment wave.
   *
   * This is the live event-driven nervous system: the next wave is triggered by
   * this message, never by a poll or a timer. The offline test substrate drives
   * the identical downstream path (`handleRepoPushed`) with a faked event via
   * the `POST /events/repo-pushed` ingress, so `make check` stays deterministic
   * while the live path uses the real queued event.
   */
  async queue(
    batch: MessageBatch<RepoPushedMessageBody>,
    env: EnvWithProvisioner,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body;
        const workspace = body.workspace ?? body.repo ?? body.repository ?? "";
        if (workspace === "") {
          message.ack();
          continue;
        }
        const changeId = body.changeId ?? changeIdFromWorkspace(workspace);
        if (changeId === "") {
          message.ack();
          continue;
        }
        await handleRepoPushed(env, changeId, workspace);
        message.ack();
      } catch {
        // Let the queue redeliver on a transient failure; the DO completion is
        // idempotent, so a redelivered push cannot double-advance the graph.
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<EnvWithProvisioner, RepoPushedMessageBody>;

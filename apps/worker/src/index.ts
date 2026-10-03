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

  return json({ error: "not found" }, 404);
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
} satisfies ExportedHandler<EnvWithProvisioner>;

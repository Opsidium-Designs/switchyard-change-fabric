import {
  BOARD_AGENT_ID_PATTERN,
  BOARD_LIMITS,
  BOARD_WORKSPACE_TTL_BOUNDS,
  boardAgentWorkspaceName,
  boardHelpForkWorkspaceName,
  toolsWorkspaceName,
  boardErrorStatus,
  parseBoardJoinWorkspace,
  parseChangeSpec,
  type BoardErrorCode,
} from "@switchyard-change/change-core";
import type { DiscoveredWorkUnit } from "@switchyard-change/change-core";

import { configuredApiToken, hasValidBearer, requiresAuth } from "./auth.ts";
import type { EscalationKind, IntegrationVerdict, JevDecisionView, JevJuncture, LeaseWorkspace, PlanningChangeHeader, RefanSource, SupersededLease, UnitDetail, WorkspaceIdentity } from "./change-state.ts";
import { BOARD_PAGE_DEFAULT, BOARD_PAGE_MAX, STATUS_CONFLICT_PREFIX } from "./change-state.ts";
import type { ChangeState } from "./change-state.ts";
import type { EnvWithProvisioner } from "./workspace-provisioner.ts";
import { selectProvisioner } from "./workspace-provisioner.ts";

// Durable Object and Workflow classes MUST be exported from the entry module so
// the runtime can instantiate them from their bindings.
export { ChangeState } from "./change-state.ts";
export { ChangeWorkflow } from "./workflow.ts";
// Integration on Cloudflare: the gate container's owner, its egress handler,
// and the Workflow that integrates a board's pushes.
export { GateEgress, GateRunner } from "./gate-runner.ts";
export { IntegrationWorkflow } from "./integration-workflow.ts";

export type { EnvWithProvisioner } from "./workspace-provisioner.ts";

// CORS: the console is served from a separate origin in local dev, so the
// Worker answers any origin. That is safe with the optional bearer auth because
// the credential is an explicit `authorization` header (never a cookie), so a
// foreign origin cannot ride a browser's ambient credentials; it would have to
// already hold the token. `authorization` is listed so a preflighted request
// carrying the bearer header is allowed.
const CORS_ALLOW_HEADERS = "content-type, authorization, x-board-agent-token";

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      ...extraHeaders,
    },
  });
}

// A CORS preflight reply. It must be a bodiless 204: a 204 response cannot
// carry a body, so this cannot reuse json(). Browsers fire this OPTIONS
// preflight before any POST that sets a content-type, so a dial or recruit
// action from the console depends on it.
function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-max-age": "86400",
    },
  });
}

/** Get the ChangeState Durable Object stub addressed by Change id. */
function changeStateStub(env: EnvWithProvisioner, changeId: string) {
  const id = env.CHANGE_STATE.idFromName(changeId);
  return env.CHANGE_STATE.get(id);
}

/**
 * A stable, filesystem-safe workspace name for a Change's WorkUnit. When a
 * `round` is given, the name carries an `r<round>` suffix so a retry round's
 * re-fanned agent gets its OWN Artifact repo distinct from the kickoff repo (and
 * distinct from any other round), exactly as the kickoff wave gives each unit its
 * own repo. The kickoff wave omits `round`, so its names are unchanged.
 */
export function workspaceNameFor(changeId: string, unitId: string, round?: number): string {
  const base =
    round !== undefined && Number.isFinite(round) && round > 0
      ? `${changeId}--${unitId}--r${Math.floor(round)}`
      : `${changeId}--${unitId}`;
  return base.replace(/[^A-Za-z0-9._-]+/g, "-");
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
    // A preflight never carries the authorization header (browsers strip it), so
    // it is answered before the auth check; the real request is then gated.
    return corsPreflight();
  }

  // Optional bearer auth (see auth.ts): when SWITCHYARD_API_TOKEN is set, every
  // mutating request must present it. Read-only GETs stay open.
  // The one exception is an agent's own board post: it authenticates with the
  // agent's board token (issued by the bearer-protected join route), so an
  // agent process never needs the shared bearer, which would let it act as the
  // human or record integration results.
  const apiToken = configuredApiToken(env);
  const agentBoardPost = request.method === "POST" && /^\/changes\/[^/]+\/board$/.test(url.pathname);
  if (apiToken !== undefined && requiresAuth(request.method) && !agentBoardPost && !hasValidBearer(request, apiToken)) {
    return json({ error: "unauthorized: this route requires a bearer token" }, 401, {
      "www-authenticate": 'Bearer realm="switchyard-change-fabric"',
    });
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
      const { state, superseded } = await stub.createFromSpec(specYaml);
      // Re-creating an existing id is a fresh run: revoke every lease the prior
      // run still held (the DO captured them atomically with the wipe).
      const revokeFailures = await revokeSuperseded(env, superseded);
      return json(withSuperseded(state, superseded, revokeFailures), 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Create a "planning" PLACEHOLDER Change from just its header, BEFORE the
  // planner has decided the work. The body is a JSON header (id, objective,
  // baseline, budgetUsd, assurance). This exists so a live run can create the
  // Change on the Worker the instant it begins (status "planning", empty work),
  // and the console can attach and see the Change within one poll instead of
  // 404ing for the whole LLM planner latency. The plan is attached afterwards via
  // POST /changes/:id/plan, which fills in the real work and flips the status to
  // "running".
  if (request.method === "POST" && url.pathname === "/changes/planning") {
    let body: PlanningBody;
    try {
      body = (await request.json()) as PlanningBody;
    } catch {
      return json({ error: "invalid planning-change body" }, 400);
    }
    if (!body.id || !body.objective || !body.baseline) {
      return json({ error: "a planning Change requires id, objective, and baseline" }, 400);
    }
    const stub = changeStateStub(env, body.id);
    try {
      // A planning create on an id a prior run used (the stable watch-mode id,
      // or an explicit --id re-run) starts a fresh run: the DO wipes every
      // per-run key and hands back the leases the prior run still held, which
      // are revoked here so none is dropped without revocation.
      const { state, superseded } = await stub.createPlanning({
        id: body.id,
        objective: body.objective,
        baseline: body.baseline,
        budgetUsd: numberOr(body.budgetUsd, 0),
        assurance: (body.assurance ?? "standard") as PlanningChangeHeader["assurance"],
      });
      const revokeFailures = await revokeSuperseded(env, superseded);
      return json(withSuperseded(state, superseded, revokeFailures), 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Attach the decomposed plan to a "planning" placeholder Change: the body is
  // the full Change spec YAML (now carrying the real work units and the recorded
  // plan). It replaces the stored placeholder with the full Change and flips the
  // status from "planning" to "running", so the console (already attached to the
  // planning placeholder) now sees the real graph and the rooted planner node.
  const planMatch = url.pathname.match(/^\/changes\/([^/]+)\/plan$/);
  if (request.method === "POST" && planMatch) {
    const changeId = decodeURIComponent(planMatch[1] ?? "");
    const specYaml = await request.text();
    if (specYaml.trim() === "") {
      return json({ error: "empty Change spec body" }, 400);
    }
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    // A plan can only be attached to a Change that is still "planning". Attaching
    // to a running (or prior-run) Change would wipe a live run's leases and
    // history, so it is a 409; a caller that means to start over re-creates the
    // Change instead (the run-live driver falls back to POST /changes on any
    // attach failure, which supersedes the prior run and revokes its leases).
    const status = await stub.getStatus();
    if (status !== "planning") {
      return json(
        { error: `a plan can only be attached while the Change is planning (it is ${status})` },
        409,
      );
    }
    try {
      const state = await stub.attachPlan(specYaml);
      return json(state, 200);
    } catch (error) {
      const message = errorMessage(error);
      return json({ error: message }, message.includes(STATUS_CONFLICT_PREFIX) ? 409 : 400);
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

  // Record one ordered activity step a runner reported for a WorkUnit (a real
  // run step: leased, cloning, calling the model, applying the edit, committing,
  // pushing, verified, or failed). The runner emits these from the ACTUAL run
  // steps, so the console's per-node activity log is backed by real steps, never
  // synthesized in the UI.
  const stepMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/step$/);
  if (request.method === "POST" && stepMatch) {
    const changeId = decodeURIComponent(stepMatch[1] ?? "");
    const unitId = decodeURIComponent(stepMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: StepBody;
    try {
      body = (await request.json()) as StepBody;
    } catch {
      return json({ error: "invalid step body" }, 400);
    }
    if (!body.phase && !body.message) {
      return json({ error: "a step requires a phase or a message" }, 400);
    }
    try {
      const step = await stub.recordStep(unitId, body.phase ?? "step", body.message ?? "");
      return json({ step }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Record (merge) the rich per-unit detail a runner reported: a readable prompt
  // summary, the model's proposed edit (changed paths and a readable diff), the
  // model id, the proposed commit message, and token usage / cost. This is what
  // the console's click-detail reads from real state.
  const detailMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/detail$/);
  if (request.method === "POST" && detailMatch) {
    const changeId = decodeURIComponent(detailMatch[1] ?? "");
    const unitId = decodeURIComponent(detailMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: DetailBody;
    try {
      body = (await request.json()) as DetailBody;
    } catch {
      return json({ error: "invalid detail body" }, 400);
    }
    try {
      const detail = await stub.recordDetail(unitId, body);
      return json({ detail }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
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

  // Mark a WorkUnit FAILED (runner-driven): an agent ultimately could not
  // complete it after the executor's bounded retries, or it timed out. This
  // mirrors the /complete route but records a terminal failure instead of a
  // completion: it revokes the lease's token (exactly as /complete does) and
  // advances the work graph by freeing the dial slot, so one flaky model call
  // fails just that unit rather than freezing the whole wave.
  const failMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/fail$/);
  if (request.method === "POST" && failMatch) {
    const changeId = decodeURIComponent(failMatch[1] ?? "");
    const unitId = decodeURIComponent(failMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: FailBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as FailBody;
      } catch {
        return json({ error: "invalid failure body" }, 400);
      }
    }
    const lease = await stub.getLease(unitId);
    try {
      await stub.failUnit(unitId, body.reason);
      if (lease) {
        const provisioner = selectProvisioner(env);
        await provisioner.revoke(lease.workspaceName, lease.tokenId).catch(() => {});
      }
      // A failed unit freed a dial slot. Recruit the next wave the freed slot
      // now allows (if any), exactly as a repo-pushed event does, so the wave
      // advances instead of freezing. The runner drives these recruited agents.
      const plan = await stub.planRecruitment();
      const recruited = await provisionAndRecordWave(env, changeId, plan.recruit);
      await stub.recordRecruitment({
        trigger: "repo-pushed",
        completedUnit: undefined,
        recruited: recruited.map((r) => r.unitId),
        ceiling: plan.ceiling,
        inFlightAfter: plan.inFlight + recruited.length,
      });
      const state = await stub.getState();
      return json({ ...state, recruited });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Append DISCOVERED follow-up WorkUnits a completing unit reported (dynamic
  // branching). The runner POSTs the units an executor found while fixing its
  // own unit; the DO admits them to the live WorkGraph as real backed units, so
  // the next recruitment wave recruits them and the graph grows mid-run. This is
  // a real state append, not a UI animation: the appended units are scoped,
  // rooted under the discovering parent, and projected by the same graph model.
  const discoveredMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/discovered$/);
  if (request.method === "POST" && discoveredMatch) {
    const changeId = decodeURIComponent(discoveredMatch[1] ?? "");
    const unitId = decodeURIComponent(discoveredMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: DiscoveredBody;
    try {
      body = (await request.json()) as DiscoveredBody;
    } catch {
      return json({ error: "invalid discovered-units body" }, 400);
    }
    const units = Array.isArray(body.units) ? body.units : [];
    try {
      const added = await stub.addWorkUnits(unitId, units);
      return json({ added }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Record the live deployment of the fixed app: the clickable workers.dev URL
  // the run deployed as end-of-run proof the fix works. The run posts this only
  // after verification passed and the deploy succeeded, so the console surfaces
  // a real reachable URL, never one for a broken or undeployed app.
  const deploymentMatch = url.pathname.match(/^\/changes\/([^/]+)\/deployment$/);
  if (request.method === "POST" && deploymentMatch) {
    const changeId = decodeURIComponent(deploymentMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: DeploymentBody;
    try {
      body = (await request.json()) as DeploymentBody;
    } catch {
      return json({ error: "invalid deployment body" }, 400);
    }
    if (!body.url || !body.app) {
      return json({ error: "deployment requires url and app" }, 400);
    }
    const deployment = await stub.recordDeployment({ url: body.url, app: body.app });
    return json({ deployment }, 201);
  }

  // Mark a "planning" placeholder as FAILED before its plan was attached (the
  // planner threw, or the run could not proceed). Without this the placeholder
  // would sit in "planning" forever on the console. Only a planning Change can
  // move to planning-failed (409 otherwise); the reason is recorded and backs
  // the goal node's terminal red.
  const planningFailedMatch = url.pathname.match(/^\/changes\/([^/]+)\/planning-failed$/);
  if (request.method === "POST" && planningFailedMatch) {
    const changeId = decodeURIComponent(planningFailedMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: PlanningFailedBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as PlanningFailedBody;
      } catch {
        return json({ error: "invalid planning-failed body" }, 400);
      }
    }
    const reason = typeof body?.reason === "string" && body.reason.trim() !== "" ? body.reason : "planning failed";
    try {
      const state = await stub.failPlanning(reason);
      return json(state, 200);
    } catch (error) {
      const message = errorMessage(error);
      return json({ error: message }, message.includes(STATUS_CONFLICT_PREFIX) ? 409 : 400);
    }
  }

  // Record the AUTHORITATIVE whole-change integration verdict: the outcome of
  // the final integration gate on the exact integrated/promoted tree. The run
  // posts this once, after that gate ran. It is the sole source of truth for the
  // goal node's verified/failed state (the ladder verify attempts are an
  // advisory overlay), so the console greens the goal only on a real verdict.
  const integrationMatch = url.pathname.match(/^\/changes\/([^/]+)\/integration$/);
  if (request.method === "POST" && integrationMatch) {
    const changeId = decodeURIComponent(integrationMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: IntegrationBody;
    try {
      body = (await request.json()) as IntegrationBody;
    } catch {
      return json({ error: "invalid integration body" }, 400);
    }
    if (body === null || typeof body !== "object") {
      return json({ error: "invalid integration body" }, 400);
    }
    if (body.verdict !== "verified" && body.verdict !== "failed") {
      return json({ error: 'integration verdict must be "verified" or "failed"' }, 400);
    }
    if (!isStringArray(body.integratedUnits) || !isStringArray(body.excludedUnits)) {
      return json({ error: "integratedUnits and excludedUnits must be string arrays" }, 400);
    }
    if (body.gated !== undefined && (body.gated !== false || body.verdict !== "verified")) {
      return json({ error: "gated, when present, must be false (no gate ran) on a verified verdict" }, 400);
    }
    try {
      const integration = await stub.recordIntegration({
        verdict: body.verdict,
        integratedUnits: body.integratedUnits,
        excludedUnits: body.excludedUnits,
        ...(body.gated === false ? { gated: false as const } : {}),
      });
      return json({ integration }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Record one mechanical CHANGE-LEVEL VERIFY attempt: a single run of the
  // per-app behavioral gate against the integrated change for one ladder round.
  // This is the real backing for a `verify` graph node, so a verify node can
  // only exist once this record does. The verifier is mechanical on every round
  // (the escalation model gets another round, never grades its own output), so
  // this is the ground-truth verdict the ladder and the console read. The gate
  // command and failing output are recorded so the console can show what ran and
  // why it failed.
  const verifyAttemptMatch = url.pathname.match(/^\/changes\/([^/]+)\/verify-attempt$/);
  if (request.method === "POST" && verifyAttemptMatch) {
    const changeId = decodeURIComponent(verifyAttemptMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: VerifyAttemptBody;
    try {
      body = (await request.json()) as VerifyAttemptBody;
    } catch {
      return json({ error: "invalid verify-attempt body" }, 400);
    }
    try {
      const attempt = await stub.recordVerifyAttempt({
        round: numberOr(body.round, 1),
        outcome: body.outcome === "pass" ? "pass" : "fail",
        model: body.model ?? "",
        ...(body.gateCommand ? { gateCommand: body.gateCommand } : {}),
        ...(body.failingOutput ? { failingOutput: body.failingOutput } : {}),
        ...(Array.isArray(body.implicatedUnits) ? { implicatedUnits: body.implicatedUnits } : {}),
        ...(body.refanSource ? { refanSource: body.refanSource } : {}),
      });
      return json({ verifyAttempt: attempt }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Patch the implicated units and the re-fan source onto the LAST verify
  // attempt for a round (the failing verify that produced a re-fan). The ladder
  // records the failing verify before it computes attribution, then calls this
  // once the resulting re-fan is chosen, so the console detail panel can show
  // WHY that round failed and which units it re-fanned.
  const verifyRefanMatch = url.pathname.match(/^\/changes\/([^/]+)\/verify-attempt\/refan$/);
  if (request.method === "POST" && verifyRefanMatch) {
    const changeId = decodeURIComponent(verifyRefanMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: VerifyAttemptBody;
    try {
      body = (await request.json()) as VerifyAttemptBody;
    } catch {
      return json({ error: "invalid verify-attempt refan body" }, 400);
    }
    try {
      await stub.updateVerifyAttempt({
        round: numberOr(body.round, 1),
        ...(Array.isArray(body.implicatedUnits) ? { implicatedUnits: body.implicatedUnits } : {}),
        ...(body.refanSource ? { refanSource: body.refanSource } : {}),
      });
      return json({ ok: true });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Record one CHANGE-LEVEL model-escalation RETRY: after a change-level
  // verify-fail, the ladder re-fanned the implicated units on a stronger model
  // fed the failing evidence. This is the real backing for a `retry` graph node
  // and the `model-escalation` edge; it is kept wholly separate from the
  // human-escalation `escalated` flag. It carries the implicated unit ids.
  const retryAttemptMatch = url.pathname.match(/^\/changes\/([^/]+)\/retry-attempt$/);
  if (request.method === "POST" && retryAttemptMatch) {
    const changeId = decodeURIComponent(retryAttemptMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: RetryAttemptBody;
    try {
      body = (await request.json()) as RetryAttemptBody;
    } catch {
      return json({ error: "invalid retry-attempt body" }, 400);
    }
    try {
      const attempt = await stub.recordRetryAttempt({
        round: numberOr(body.round, 2),
        fromModel: body.fromModel ?? "",
        toModel: body.toModel ?? "",
        implicatedUnits: Array.isArray(body.implicatedUnits) ? body.implicatedUnits : [],
        ...(body.refanSource ? { refanSource: body.refanSource } : {}),
        reason: body.reason ?? "verify-fail escalation",
        ...(Array.isArray(body.revisedUnits) && body.revisedUnits.length > 0
          ? {
              revisedUnits: body.revisedUnits
                .filter((u) => u && typeof u.id === "string")
                .map((u) => ({ id: String(u.id), objective: String(u.objective ?? "") })),
            }
          : {}),
        ...(typeof body.rationale === "string" && body.rationale !== ""
          ? { rationale: body.rationale }
          : {}),
      });
      return json({ retryAttempt: attempt }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Record one Jev typed decision at one juncture (plan-review, attribution, or
  // fix-confidence). This is the real backing for a `jev` graph node, so a jev
  // node can only exist once this record does. A fix-confidence decision is
  // ADVISORY only: recording it never touches the completed/failed/integrated
  // sets, so the mechanical gate and gate-equals-deploy remain authoritative and
  // Jev never flips a verdict or gates promotion/deploy.
  const jevDecisionMatch = url.pathname.match(/^\/changes\/([^/]+)\/jev-decision$/);
  if (request.method === "POST" && jevDecisionMatch) {
    const changeId = decodeURIComponent(jevDecisionMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: JevDecisionBody;
    try {
      body = (await request.json()) as JevDecisionBody;
    } catch {
      return json({ error: "invalid jev-decision body" }, 400);
    }
    try {
      const decision = await stub.recordJevDecision({
        juncture: (body.juncture ?? "plan-review") as JevJuncture,
        question: body.question ?? "",
        answerType: body.answerType === "choice" || body.answerType === "score" ? body.answerType : "noul",
        ...(body.noul ? { noul: body.noul } : {}),
        ...(body.choice ? { choice: body.choice } : {}),
        ...(typeof body.score === "number" ? { score: body.score } : {}),
        confidence: numberOr(body.confidence, 0),
        ...(body.probabilities ? { probabilities: body.probabilities } : {}),
        accepted: body.accepted === true,
        ...(typeof body.error === "string" ? { error: body.error } : {}),
      });
      return json({ jevDecision: decision }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Lease a ROUND-N agent instance: provision its OWN Artifact repo (keyed by
  // (changeId, unitId, round) so it is distinct from the kickoff repo) and
  // record it on the DO like a kickoff lease, setting the round-N instance's
  // status to running. This is the round-N parallel of the kickoff lease route:
  // a retry round's re-fanned unit is a BRAND NEW agent that spawns with its own
  // repo and tracks a real status lifecycle, so the graph reads its state rather
  // than a hardcoded literal. The plaintext token is returned once so the runner
  // can clone and push the round-N repo.
  const roundLeaseMatch = url.pathname.match(
    /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/lease$/,
  );
  if (request.method === "POST" && roundLeaseMatch) {
    const changeId = decodeURIComponent(roundLeaseMatch[1] ?? "");
    const unitId = decodeURIComponent(roundLeaseMatch[2] ?? "");
    const round = Number(decodeURIComponent(roundLeaseMatch[3] ?? ""));
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const provisioner = selectProvisioner(env);
    let provisioned;
    try {
      provisioned = await provisioner.provision(workspaceNameFor(changeId, unitId, round));
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
      const record = await stub.recordRoundLease(unitId, round, workspace);
      // The plaintext token is returned once to the runner and never persisted.
      return json({ ...record, token: provisioned.token }, 201);
    } catch (error) {
      // Could not record: revoke the just-issued token to avoid a leak.
      await provisioner.revoke(provisioned.workspaceName, provisioned.tokenId).catch(() => {});
      return json({ error: errorMessage(error) }, 409);
    }
  }

  // Record one ordered activity step a round-N agent reported, keyed by
  // (unit, round). The round-N parallel of the kickoff /step route.
  const roundStepMatch = url.pathname.match(
    /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/step$/,
  );
  if (request.method === "POST" && roundStepMatch) {
    const changeId = decodeURIComponent(roundStepMatch[1] ?? "");
    const unitId = decodeURIComponent(roundStepMatch[2] ?? "");
    const round = Number(decodeURIComponent(roundStepMatch[3] ?? ""));
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: StepBody;
    try {
      body = (await request.json()) as StepBody;
    } catch {
      return json({ error: "invalid step body" }, 400);
    }
    if (!body.phase && !body.message) {
      return json({ error: "a step requires a phase or a message" }, 400);
    }
    try {
      const step = await stub.recordRoundStep(unitId, round, body.phase ?? "step", body.message ?? "");
      return json({ step }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Record (merge) the rich per-unit detail a round-N agent reported, keyed by
  // (unit, round). The round-N parallel of the kickoff /detail route.
  const roundDetailMatch = url.pathname.match(
    /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/detail$/,
  );
  if (request.method === "POST" && roundDetailMatch) {
    const changeId = decodeURIComponent(roundDetailMatch[1] ?? "");
    const unitId = decodeURIComponent(roundDetailMatch[2] ?? "");
    const round = Number(decodeURIComponent(roundDetailMatch[3] ?? ""));
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: DetailBody;
    try {
      body = (await request.json()) as DetailBody;
    } catch {
      return json({ error: "invalid detail body" }, 400);
    }
    try {
      const detail = await stub.recordRoundDetail(unitId, round, body);
      return json({ detail }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Mark a round-N agent COMPLETE, keyed by (unit, round): the round pushed its
  // edit, so the round-N instance greens. Revokes its lease token (its workspace
  // is kept so the node still reveals the real repo). The round-N parallel of
  // the kickoff /complete route. The change-level gate remains the authority on
  // whether the whole change passed.
  const roundCompleteMatch = url.pathname.match(
    /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/complete$/,
  );
  if (request.method === "POST" && roundCompleteMatch) {
    const changeId = decodeURIComponent(roundCompleteMatch[1] ?? "");
    const unitId = decodeURIComponent(roundCompleteMatch[2] ?? "");
    const round = Number(decodeURIComponent(roundCompleteMatch[3] ?? ""));
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    try {
      const agent = await stub.completeRoundAgent(unitId, round);
      const provisioner = selectProvisioner(env);
      await provisioner
        .revoke(agent.workspace.workspaceName, agent.workspace.tokenId)
        .catch(() => {});
      return json({ roundAgent: agent }, 200);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Mark a round-N agent FAILED, keyed by (unit, round): the round's executor
  // errored or produced no usable edit, so the round-N instance reds. Revokes
  // its lease token. The round-N parallel of the kickoff /fail route. The
  // change-level gate remains the authority on the whole change's pass/fail.
  const roundFailMatch = url.pathname.match(
    /^\/changes\/([^/]+)\/work\/([^/]+)\/round\/([^/]+)\/fail$/,
  );
  if (request.method === "POST" && roundFailMatch) {
    const changeId = decodeURIComponent(roundFailMatch[1] ?? "");
    const unitId = decodeURIComponent(roundFailMatch[2] ?? "");
    const round = Number(decodeURIComponent(roundFailMatch[3] ?? ""));
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: FailBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as FailBody;
      } catch {
        return json({ error: "invalid failure body" }, 400);
      }
    }
    try {
      const agent = await stub.failRoundAgent(unitId, round, body.reason);
      const provisioner = selectProvisioner(env);
      await provisioner
        .revoke(agent.workspace.workspaceName, agent.workspace.tokenId)
        .catch(() => {});
      return json({ roundAgent: agent }, 200);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Mark a WorkUnit FAILED on a verify-fail verdict: its candidate edit did not
  // pass the mechanical per-app gate after the bounded model-escalation ladder.
  // Unlike /fail (agent-infra failure), this is the VERDICT on the pushed edit,
  // so it overrides a prior pushed/completed marker: the unit becomes a real RED
  // node and is kept out of integration, closing the vacuous-green trap.
  const verifyFailMatch = url.pathname.match(
    /^\/changes\/([^/]+)\/work\/([^/]+)\/verify-fail$/,
  );
  if (request.method === "POST" && verifyFailMatch) {
    const changeId = decodeURIComponent(verifyFailMatch[1] ?? "");
    const unitId = decodeURIComponent(verifyFailMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: FailBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as FailBody;
      } catch {
        return json({ error: "invalid verify-fail body" }, 400);
      }
    }
    try {
      const state = await stub.recordVerifyFailure(unitId, body.reason);
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

  // Record the agent-built tool published for a Change. A Node tool-builder
  // (which can run Git) publishes a real codemod repo, then records the tool and
  // which downstream units consumed it here, so the live console graph can show
  // the tool node and consumed-tool edges backed by that real state. The Worker
  // runtime cannot run Git, so building the tool is a Node-side step; recording
  // it is this control-plane endpoint.
  const toolMatch = url.pathname.match(/^\/changes\/([^/]+)\/tool$/);
  if (request.method === "POST" && toolMatch) {
    const changeId = decodeURIComponent(toolMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: ToolBody;
    try {
      body = (await request.json()) as ToolBody;
    } catch {
      return json({ error: "invalid tool body" }, 400);
    }
    if (!body.builderUnitId || !body.capability || !body.workspace) {
      return json({ error: "tool requires builderUnitId, capability, and workspace" }, 400);
    }
    try {
      const tool = await stub.recordTool({
        builderUnitId: body.builderUnitId,
        capability: body.capability,
        toolPath: body.toolPath ?? "",
        workspace: body.workspace,
        label: body.label ?? body.capability,
      });
      for (const consumerUnitId of body.consumers ?? []) {
        await stub
          .recordToolConsumption({ capability: body.capability, consumerUnitId })
          .catch(() => {});
      }
      return json({ tool }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Integration on Cloudflare (see docs/BOARD.md "Integration on Cloudflare").
  //   POST /changes/:id/integration/cloud            (bearer) configure it for this Change
  //   GET  /changes/:id/integration/cloud            the configuration (no inventory names), the Workflow, every attempt (open)
  //   POST /changes/:id/integration/cloud/kick       (bearer) start or coalesce an integration now
  //   POST /changes/:id/integration/cloud/workspace  (bearer) {ttlSeconds} provision the integration repo (+ a write token, once)
  //   POST /changes/:id/integration/cloud/token      (bearer) {scope, ttlSeconds} a short-lived token for the integration repo
  //   POST /changes/:id/integration/cloud/token/revoke (bearer) {tokenId}
  //   POST /changes/:id/integration/cloud/attribution (bearer) {key, items} the run's advisory attribution of a held failing revision
  // The configuration (the gate command, the contract, the baseline inventory)
  // is accepted once, before the goal is posted, and is fixed from then on.
  const cloudMatch = url.pathname.match(/^\/changes\/([^/]+)\/integration\/cloud(?:\/(kick|workspace|token|token\/revoke|attribution))?$/);
  if (cloudMatch) {
    const changeId = decodeURIComponent(cloudMatch[1] ?? "");
    const action = cloudMatch[2];
    const stub = changeStateStub(env, changeId);
    // The integration repo can be provisioned before the Change is created (a
    // run seeds it and records the baseline inventory first); the rest needs
    // the Change.
    const repoAction = action === "workspace" || action === "token" || action === "token/revoke";
    if (!repoAction && !(await stub.isInitialized())) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    if (request.method === "GET" && action === undefined) {
      return json(await stub.getCloudIntegration());
    }
    if (request.method !== "POST") {
      return json({ error: "not found" }, 404);
    }
    const body = await readBoardBody(request);
    if (!body.ok) {
      return json({ code: body.code, error: body.error }, body.status);
    }
    const value = isPlainObject(body.value) ? body.value : {};
    if (action === undefined) {
      const configured = await stub.configureCloudIntegration(body.value);
      return configured.ok ? json(configured, 201) : json({ code: configured.code, error: configured.error }, configured.code === "INVALID_STATE" ? 409 : 400);
    }
    if (action === "attribution") {
      const answered = await stub.answerCloudAttribution(body.value);
      if (!answered.ok) {
        return json({ code: answered.code, error: answered.error }, answered.code === "BAD_PAYLOAD" ? 400 : 409);
      }
      if (answered.instanceId && env.INTEGRATION_WORKFLOW && typeof value.key === "string") {
        // Wake the Workflow waiting for it (it records with the parse alone if this is lost).
        await env.INTEGRATION_WORKFLOW.get(answered.instanceId)
          .then((instance) => instance.sendEvent({ type: `attribution-${value.key}`, payload: { key: value.key } }))
          .catch(() => undefined);
      }
      return json({ accepted: true }, 201);
    }
    if (action === "kick") {
      return json(await kickCloudIntegration(env, changeId));
    }
    const ttl = value.ttlSeconds === undefined ? 900 : value.ttlSeconds;
    const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
    if (action !== "token/revoke" && (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max)) {
      return json({ code: "BAD_PAYLOAD", error: `ttlSeconds must be an integer from ${min} to ${max}` }, 400);
    }
    const provisioner = selectProvisioner(env);
    const workspaceName = ((await stub.isInitialized()) ? (await stub.getCloudIntegrationRepo())?.workspaceName : undefined) ?? integrationWorkspaceName(changeId);
    try {
      if (action === "workspace") {
        return json(await provisioner.provision(integrationWorkspaceName(changeId), { ttlSeconds: ttl as number }), 201);
      }
      if (action === "token") {
        const scope = value.scope ?? "read";
        const issue = scope === "write" ? provisioner.issueWriteToken?.bind(provisioner) : scope === "read" ? provisioner.issueReadToken?.bind(provisioner) : undefined;
        if (!issue) {
          return json({ code: "BAD_PAYLOAD", error: 'scope must be "read" or "write" (and this Worker must be able to issue it)' }, 400);
        }
        return json({ workspaceName, ...(await issue(workspaceName, ttl as number)) }, 201);
      }
      if (typeof value.tokenId !== "string" || value.tokenId === "") {
        return json({ code: "BAD_PAYLOAD", error: "a revoke names a tokenId" }, 400);
      }
      await provisioner.revoke(workspaceName, value.tokenId);
      return json({ revoked: value.tokenId });
    } catch (error) {
      return json({ code: "INVALID_STATE", error: `the integration repo operation failed: ${errorMessage(error)}` }, 502);
    }
  }

  // The Change's TOOLS repo (agent-built tools; see docs/BOARD.md "Agent-built tools"):
  //   POST /changes/:id/tools/workspace     (bearer) {ttlSeconds} provision it once (a repeat returns it with a fresh write token)
  //   POST /changes/:id/tools/token         (bearer) {scope, ttlSeconds} a short-lived read or write token for it
  //   POST /changes/:id/tools/token/revoke  (bearer) {tokenId}
  const toolsRepoMatch = url.pathname.match(/^\/changes\/([^/]+)\/tools\/(workspace|token|token\/revoke)$/);
  if (request.method === "POST" && toolsRepoMatch) {
    const changeId = decodeURIComponent(toolsRepoMatch[1] ?? "");
    const action = toolsRepoMatch[2];
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    const body = await readBoardBody(request);
    if (!body.ok) {
      return json({ code: body.code, error: body.error }, body.status);
    }
    const value = isPlainObject(body.value) ? body.value : {};
    const provisioner = selectProvisioner(env);
    const repo = await stub.getToolsRepo();
    try {
      if (action === "token/revoke") {
        if (!repo || typeof value.tokenId !== "string" || value.tokenId === "") {
          return json({ code: "BAD_PAYLOAD", error: "a revoke names a tokenId of a provisioned tools repo" }, 400);
        }
        await provisioner.revoke(repo.workspaceName, value.tokenId);
        return json({ revoked: value.tokenId });
      }
      const ttl = value.ttlSeconds === undefined ? 900 : value.ttlSeconds;
      const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max) {
        return json({ code: "BAD_PAYLOAD", error: `ttlSeconds must be an integer from ${min} to ${max}` }, 400);
      }
      if (action === "token") {
        const scope = value.scope ?? "read";
        const issue = scope === "write" ? provisioner.issueWriteToken?.bind(provisioner) : scope === "read" ? provisioner.issueReadToken?.bind(provisioner) : undefined;
        if (!repo || !issue) {
          return json({ code: repo ? "BAD_PAYLOAD" : "INVALID_STATE", error: repo ? 'scope must be "read" or "write" (and this Worker must be able to issue it)' : "the tools repo is not provisioned yet" }, 400);
        }
        return json({ workspaceName: repo.workspaceName, ...(await issue(repo.workspaceName, ttl)) }, 201);
      }
      if (repo) {
        // Provisioned once per Change: a repeat hands out a fresh write token
        // (a provisioner that cannot issue one on its own re-provisions, idempotently).
        if (!provisioner.issueWriteToken) {
          const again = await provisioner.provision(repo.workspaceName, { ttlSeconds: ttl });
          return json({ ...repo, tokenId: again.tokenId, token: again.token, tokenExpiresAt: again.tokenExpiresAt }, 201);
        }
        return json({ ...repo, ...(await provisioner.issueWriteToken(repo.workspaceName, ttl)) }, 201);
      }
      const provisioned = await provisioner.provision(toolsWorkspaceName(changeId), { ttlSeconds: ttl });
      await stub.recordToolsRepo({
        workspaceName: provisioned.workspaceName,
        gitUrl: provisioned.gitUrl,
        defaultBranch: provisioned.defaultBranch,
        backend: provisioned.backend,
        fallback: provisioned.fallback,
      });
      return json(provisioned, 201);
    } catch (error) {
      return json({ code: "INVALID_STATE", error: `the tools repo operation failed: ${errorMessage(error)}` }, 502);
    }
  }

  // The Change board. Identity is established by the route, never by the
  // message body:
  //   POST /changes/:id/board/join      (bearer) an agent joins; returns its board token
  //   POST /changes/:id/board           (agent board token) an agent posts as itself
  //   POST /changes/:id/board/human     (bearer) the human posts (goal, items, decisions)
  //   POST /changes/:id/integration/revision (bearer) the integrator records a revision
  //   GET  /changes/:id/board?after=&limit=  the log page and reduced state (open)
  //   GET  /changes/:id/board?for=<agent>    that agent's digest (agent board token)
  //   GET  /changes/:id/board/verify         re-verify the stored log against the state
  //   POST /changes/:id/tools/gate           (bearer) the operator records a tool's own gate result
  //   POST /changes/:id/tools/used           (bearer) the operator records a run of a pinned tool version
  // The engine's own messages are never accepted from any route.
  const boardRoute = url.pathname.match(
    /^\/changes\/([^/]+)\/(board|board\/join|board\/human|board\/verify|board\/decision|integration\/revision|tools\/gate|tools\/used)$/,
  );
  if (boardRoute) {
    const changeId = decodeURIComponent(boardRoute[1] ?? "");
    const kind = boardRoute[2];
    const stub = changeStateStub(env, changeId);
    if (request.method === "POST" && kind !== "board/verify") {
      if (!(await stub.isInitialized())) {
        return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
      }
      const body = await readBoardBody(request);
      if (!body.ok) {
        return json({ code: body.code, error: body.error }, body.status);
      }
      let outcome;
      if (kind === "board/join") {
        const join = isPlainObject(body.value) ? body.value : {};
        if (typeof join.agent !== "string") {
          return json({ code: "BAD_PAYLOAD", error: "a join requires an agent id" }, 400);
        }
        // An agent that will do work can ask for its own workspace in the same
        // join: the Worker provisions the agent's repo and a repo-scoped write
        // token with the explicit short TTL the caller asked for, then joins.
        // The plaintext token is returned once and never stored; a join the
        // board refuses revokes the just-issued token.
        const wanted = parseBoardJoinWorkspace(join.workspace);
        if (!wanted.ok) {
          return json({ code: "BAD_PAYLOAD", error: wanted.error }, 400);
        }
        if (!wanted.request) {
          outcome = await stub.joinBoard(join.agent, { role: join.role, rationale: join.rationale });
        } else {
          if (!BOARD_AGENT_ID_PATTERN.test(join.agent)) {
            return json({ code: "BAD_PAYLOAD", error: "agent must be an id (letters, digits, . _ : -)" }, 400);
          }
          // Validate the join FIRST, so a join the board would refuse never
          // provisions a repo or a token.
          const precheck = await stub.checkBoardJoin(join.agent, { role: join.role, rationale: join.rationale });
          if (!precheck.ok) {
            return json({ code: precheck.code, error: precheck.error }, boardErrorStatus(precheck.code as BoardErrorCode));
          }
          const provisioner = selectProvisioner(env);
          let provisioned;
          try {
            provisioned = await provisioner.provision(boardAgentWorkspaceName(changeId, join.agent), {
              ttlSeconds: wanted.request.ttlSeconds,
            });
          } catch (error) {
            return json({ code: "INVALID_STATE", error: `could not provision the agent workspace: ${errorMessage(error)}` }, 502);
          }
          // A join refused (or failing) after provisioning leaves nothing
          // behind: the token is revoked AND the repo is archived.
          const undo = async () => {
            await provisioner.revoke(provisioned.workspaceName, provisioned.tokenId).catch(() => {});
            await provisioner.archive(provisioned.workspaceName).catch(() => {});
          };
          try {
            outcome = await stub.joinBoard(
              join.agent,
              { role: join.role, rationale: join.rationale },
              {
                withWorkspace: true,
                repo: { workspaceName: provisioned.workspaceName, gitUrl: provisioned.gitUrl, defaultBranch: provisioned.defaultBranch },
              },
            );
          } catch (error) {
            await undo();
            return json({ code: "INVALID_STATE", error: `the join failed: ${errorMessage(error)}` }, 500);
          }
          if (!outcome.ok) {
            await undo();
          } else {
            return json({ ...outcome, workspace: provisioned }, 201);
          }
        }
      } else if (kind === "board/human") {
        outcome = await stub.postBoardAsHuman(body.value);
      } else if (kind === "integration/revision") {
        outcome = await stub.recordBoardIntegration(body.value);
      } else if (kind === "board/decision") {
        outcome = await stub.recordBoardDecision(body.value);
      } else if (kind === "tools/gate") {
        outcome = await stub.recordToolGate(body.value);
      } else if (kind === "tools/used") {
        outcome = await stub.recordToolUse(body.value);
      } else {
        const token = request.headers.get(BOARD_TOKEN_HEADER);
        if (!token) {
          return json({ code: "AUTH", error: `an agent board post requires the ${BOARD_TOKEN_HEADER} header` }, 401);
        }
        outcome = await stub.postBoardAsAgent(token, body.value);
        if (outcome.ok && outcome.appended.some((m) => m.type === "push.announced")) {
          // An announced push is what integration on Cloudflare reacts to (when
          // configured): start the Change's integration Workflow, or coalesce
          // into the running one. Never fails the agent's post.
          await kickCloudIntegration(env, changeId).catch(() => undefined);
        }
      }
      return outcome.ok
        ? json(outcome, 201)
        : json({ code: outcome.code, error: outcome.error }, boardErrorStatus(outcome.code as BoardErrorCode));
    }
    if (request.method === "GET" && (kind === "board" || kind === "board/verify")) {
      if (!(await stub.isInitialized())) {
        return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
      }
      if (kind === "board/verify") {
        const verified = await stub.verifyStoredBoard();
        return json(verified, verified.ok ? 200 : 409);
      }
      const after = parseAfterSeq(url.searchParams.get("after"));
      const limit = parseBoardLimit(url.searchParams.get("limit"));
      if (after === undefined || limit === undefined) {
        return json({ code: "BAD_PAYLOAD", error: `after must be a non-negative seq and limit 1..${BOARD_PAGE_MAX}` }, 400);
      }
      const forAgent = url.searchParams.get("for");
      if (forAgent !== null) {
        const token = request.headers.get(BOARD_TOKEN_HEADER);
        if (!token) {
          return json({ code: "AUTH", error: `a digest requires the ${BOARD_TOKEN_HEADER} header` }, 401);
        }
        const digest = await stub.getBoardDigest(token, forAgent, after, limit);
        return digest.ok ? json(digest) : json({ code: digest.code, error: digest.error }, 401);
      }
      return json(await stub.getBoard(after, limit));
    }
  }

  // A short-lived READ token for a joined board agent's workspace (bearer). The
  // integrator reads each agent's repo with these operator credentials at
  // integration time, so an agent's own (short) write token expiring never
  // blocks integration, and the integrator never holds an agent's credential.
  //   POST /changes/:id/board/read-token  {agent, ttlSeconds?}  -> {workspaceName, tokenId, token, tokenExpiresAt}
  // Revoke a read token the operator is done with (bearer):
  //   POST /changes/:id/board/read-token/revoke  {agent, tokenId}
  const revokeReadMatch = url.pathname.match(/^\/changes\/([^/]+)\/board\/read-token\/revoke$/);
  if (request.method === "POST" && revokeReadMatch) {
    const changeId = decodeURIComponent(revokeReadMatch[1] ?? "");
    const body = await readBoardBody(request);
    if (!body.ok) {
      return json({ code: body.code, error: body.error }, body.status);
    }
    const wanted = isPlainObject(body.value) ? body.value : {};
    if (typeof wanted.agent !== "string" || !BOARD_AGENT_ID_PATTERN.test(wanted.agent) || typeof wanted.tokenId !== "string" || wanted.tokenId === "") {
      return json({ code: "BAD_PAYLOAD", error: "a revoke names a board agent id and a tokenId" }, 400);
    }
    if (wanted.help !== undefined && (typeof wanted.help !== "string" || !BOARD_AGENT_ID_PATTERN.test(wanted.help))) {
      return json({ code: "BAD_PAYLOAD", error: "help, when present, names a help request id" }, 400);
    }
    try {
      const repo = typeof wanted.help === "string" ? boardHelpForkWorkspaceName(changeId, wanted.help) : boardAgentWorkspaceName(changeId, wanted.agent);
      await selectProvisioner(env).revoke(repo, wanted.tokenId);
      return json({ revoked: wanted.tokenId });
    } catch (error) {
      return json({ code: "INVALID_STATE", error: `could not revoke the read token: ${errorMessage(error)}` }, 502);
    }
  }

  const readTokenMatch = url.pathname.match(/^\/changes\/([^/]+)\/board\/read-token$/);
  if (request.method === "POST" && readTokenMatch) {
    const changeId = decodeURIComponent(readTokenMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    const body = await readBoardBody(request);
    if (!body.ok) {
      return json({ code: body.code, error: body.error }, body.status);
    }
    const wanted = isPlainObject(body.value) ? body.value : {};
    const agent = wanted.agent;
    if (typeof agent !== "string" || !BOARD_AGENT_ID_PATTERN.test(agent)) {
      return json({ code: "BAD_PAYLOAD", error: "a read token names a board agent id" }, 400);
    }
    const ttl = wanted.ttlSeconds === undefined ? 600 : wanted.ttlSeconds;
    const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max) {
      return json({ code: "BAD_PAYLOAD", error: `ttlSeconds must be an integer from ${min} to ${max}` }, 400);
    }
    // `help`: read the granted helper's FORK (the requester pulls its delivered commit).
    const help = wanted.help;
    if (help !== undefined && (typeof help !== "string" || !BOARD_AGENT_ID_PATTERN.test(help))) {
      return json({ code: "BAD_PAYLOAD", error: "help, when present, names a help request id" }, 400);
    }
    const allowed = typeof help === "string" ? await stub.checkBoardHelpRead(help, agent) : await stub.checkBoardRepoAgent(agent);
    if (!allowed.ok) {
      return json({ code: allowed.code, error: allowed.error }, 400);
    }
    const provisioner = selectProvisioner(env);
    if (!provisioner.issueReadToken) {
      return json({ code: "INVALID_STATE", error: "this Worker cannot issue read tokens" }, 501);
    }
    const workspaceName = typeof help === "string" ? boardHelpForkWorkspaceName(changeId, help) : boardAgentWorkspaceName(changeId, agent);
    try {
      return json({ workspaceName, ...(await provisioner.issueReadToken(workspaceName, ttl)) }, 201);
    } catch (error) {
      return json({ code: "INVALID_STATE", error: `could not issue a read token: ${errorMessage(error)}` }, 502);
    }
  }

  // A helper's FORK of the requester's repo for a help request that grants a
  // sub-scope (bearer; the operator calls it for the helper, which never holds
  // the bearer):
  //   POST /changes/:id/board/help-fork  {request, agent, ttlSeconds?}
  //     -> {workspaceName, gitUrl, defaultBranch, backend, fallback, tokenId, token, tokenExpiresAt, forkOf}
  // The board checks the grant FIRST (a fork the board would refuse is never
  // made); the fork's creation token is revoked and a short write token is
  // returned once. The helper then posts help.offered {forkOf, forkCommit, fork}.
  const helpForkMatch = url.pathname.match(/^\/changes\/([^/]+)\/board\/help-fork$/);
  if (request.method === "POST" && helpForkMatch) {
    const changeId = decodeURIComponent(helpForkMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ code: "UNKNOWN_REF", error: `no such Change: ${changeId}` }, 404);
    }
    const body = await readBoardBody(request);
    if (!body.ok) {
      return json({ code: body.code, error: body.error }, body.status);
    }
    const wanted = isPlainObject(body.value) ? body.value : {};
    if (typeof wanted.request !== "string" || !BOARD_AGENT_ID_PATTERN.test(wanted.request) || typeof wanted.agent !== "string" || !BOARD_AGENT_ID_PATTERN.test(wanted.agent)) {
      return json({ code: "BAD_PAYLOAD", error: "a help fork names a help request and a board agent id" }, 400);
    }
    const ttl = wanted.ttlSeconds === undefined ? 900 : wanted.ttlSeconds;
    const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max) {
      return json({ code: "BAD_PAYLOAD", error: `ttlSeconds must be an integer from ${min} to ${max}` }, 400);
    }
    const allowed = await stub.checkBoardHelpFork(wanted.request, wanted.agent);
    if (!allowed.ok) {
      return json({ code: allowed.code, error: allowed.error }, boardErrorStatus(allowed.code as BoardErrorCode));
    }
    const provisioner = selectProvisioner(env);
    if (!provisioner.fork) {
      return json({ code: "INVALID_STATE", error: "this Worker cannot fork repos" }, 501);
    }
    try {
      const forked = await provisioner.fork(boardAgentWorkspaceName(changeId, allowed.requester), boardHelpForkWorkspaceName(changeId, wanted.request), { ttlSeconds: ttl });
      return json({ ...forked, forkOf: allowed.requester }, 201);
    } catch (error) {
      return json({ code: "INVALID_STATE", error: `could not fork the requester's repo: ${errorMessage(error)}` }, 502);
    }
  }

  // Raise a human escalation for a fork mechanical evidence cannot settle. The
  // engine records it and WAITS (a durable record in the DO, not a sleep) until
  // a human posts a decision. A pending escalation lights the graph's escalated
  // node flag so the console/CLI can show the pending decision.
  const escalateMatch = url.pathname.match(/^\/changes\/([^/]+)\/escalations$/);
  if (request.method === "POST" && escalateMatch) {
    const changeId = decodeURIComponent(escalateMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: EscalationBody;
    try {
      body = (await request.json()) as EscalationBody;
    } catch {
      return json({ error: "invalid escalation body" }, 400);
    }
    if (!body.question || !body.kind) {
      return json({ error: "escalation requires a kind and a question" }, 400);
    }
    try {
      const escalation = await stub.raiseEscalation({
        kind: body.kind,
        unitId: body.unitId,
        path: body.path,
        question: body.question,
        options: body.options,
      });
      return json({ escalation }, 201);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  // Read the escalations recorded for a Change (pending and resolved).
  const listEscalationsMatch = url.pathname.match(/^\/changes\/([^/]+)\/escalations$/);
  if (request.method === "GET" && listEscalationsMatch) {
    const changeId = decodeURIComponent(listEscalationsMatch[1] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    return json({ escalations: await stub.getEscalations() });
  }

  // Resolve a pending escalation with a human decision. This is the input that
  // ends the durable wait and lets the graph advance past the fork.
  const resolveMatch = url.pathname.match(/^\/changes\/([^/]+)\/escalations\/([^/]+)\/resolve$/);
  if (request.method === "POST" && resolveMatch) {
    const changeId = decodeURIComponent(resolveMatch[1] ?? "");
    const escalationId = decodeURIComponent(resolveMatch[2] ?? "");
    const stub = changeStateStub(env, changeId);
    if (!(await stub.isInitialized())) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    let body: ResolveBody = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as ResolveBody;
      } catch {
        return json({ error: "invalid resolve body" }, 400);
      }
    }
    if (!body.decision || body.decision.trim() === "") {
      return json({ error: "a resolution requires a decision" }, 400);
    }
    try {
      const escalation = await stub.resolveEscalation(escalationId, body.decision);
      return json({ escalation });
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
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
  // The pushed unit's token is deliberately NOT revoked here: verify-and-integrate
  // clones the unit's repo with it after the waves finish, so revoking on push
  // makes integration fail with an expired token. The run's cleanup revokes it.
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
 * Revoke every lease a re-create superseded. Best-effort per lease (a token in
 * a repo a prior cleanup already deleted cannot be revoked and has nothing left
 * to protect), but every lease gets a revocation attempt, and the ones that
 * failed are reported back to the caller rather than silently dropped.
 */
async function revokeSuperseded(
  env: EnvWithProvisioner,
  superseded: readonly SupersededLease[],
): Promise<SupersededLease[]> {
  if (superseded.length === 0) {
    return [];
  }
  const provisioner = selectProvisioner(env);
  const failures: SupersededLease[] = [];
  for (const lease of superseded) {
    try {
      await provisioner.revoke(lease.workspaceName, lease.tokenId);
    } catch {
      failures.push(lease);
    }
  }
  return failures;
}

/**
 * Attach the superseded-lease report to a create response, only when a prior
 * run's leases were actually superseded, so a plain create's body is unchanged.
 */
function withSuperseded<T extends object>(
  state: T,
  superseded: readonly SupersededLease[],
  revokeFailures: readonly SupersededLease[],
): T | (T & { supersededLeases: readonly SupersededLease[]; revokeFailures: readonly SupersededLease[] }) {
  if (superseded.length === 0) {
    return state;
  }
  return { ...state, supersededLeases: superseded, revokeFailures };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
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

/** Body of POST /changes/:id/work/:unit/fail: an optional short failure reason. */
interface FailBody {
  readonly reason?: string;
}

/** Body of POST /changes/:id/work/:unit/discovered: discovered follow-up units. */
interface DiscoveredBody {
  readonly units?: readonly DiscoveredWorkUnit[];
}

/** Body of POST /changes/:id/deployment: the live app deployment proof. */
interface DeploymentBody {
  readonly url?: string;
  readonly app?: string;
}

/** Body of POST /changes/planning: the header for a planning placeholder Change. */
interface PlanningBody {
  readonly id?: string;
  readonly objective?: string;
  readonly baseline?: string;
  readonly budgetUsd?: number;
  readonly assurance?: string;
}

/** Body of POST /changes/:id/planning-failed: why the planning placeholder failed. */
interface PlanningFailedBody {
  readonly reason?: unknown;
}

/** Body of POST /changes/:id/integration: the authoritative final integration verdict. */
interface IntegrationBody {
  readonly verdict?: IntegrationVerdict;
  readonly integratedUnits?: unknown;
  readonly excludedUnits?: unknown;
  readonly gated?: unknown;
}

/** Body of POST /changes/:id/verify-attempt: one change-level mechanical gate run. */
interface VerifyAttemptBody {
  readonly round?: number;
  readonly outcome?: "pass" | "fail";
  readonly model?: string;
  readonly gateCommand?: string;
  readonly failingOutput?: string;
  readonly implicatedUnits?: readonly string[];
  readonly refanSource?: RefanSource;
}

/** Body of POST /changes/:id/retry-attempt: one change-level model-escalation retry. */
interface RetryAttemptBody {
  readonly round?: number;
  readonly fromModel?: string;
  readonly toModel?: string;
  readonly implicatedUnits?: readonly string[];
  readonly refanSource?: RefanSource;
  readonly reason?: string;
  /** The revised units (with objectives) a re-plan chose this round, when any. */
  readonly revisedUnits?: readonly { readonly id?: string; readonly objective?: string }[];
  /** The re-plan rationale, when a re-plan round carried one. */
  readonly rationale?: string;
  /** The re-plan model, when the transport reported one distinct from toModel. */
  readonly replanModel?: string;
}

/** Body of POST /changes/:id/jev-decision: one Jev typed decision at a juncture. */
interface JevDecisionBody {
  readonly juncture?: JevJuncture;
  readonly question?: string;
  readonly answerType?: "noul" | "choice" | "score";
  readonly noul?: "yes" | "no" | "unsure";
  readonly choice?: string;
  readonly score?: number;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly accepted?: boolean;
  readonly error?: string;
}

/** Body of POST /changes/:id/dial. Accepts min/max under either spelling. */
interface DialBody {
  readonly minConcurrency?: number;
  readonly maxConcurrency?: number;
  readonly min?: number;
  readonly max?: number;
}

/** Body of POST /changes/:id/tool: an agent-built tool and its consumers. */
interface ToolBody {
  readonly builderUnitId?: string;
  readonly capability?: string;
  readonly toolPath?: string;
  readonly label?: string;
  readonly workspace?: WorkspaceIdentity;
  readonly consumers?: readonly string[];
}

/** Body of POST /changes/:id/work/:unit/step: one real run step. */
interface StepBody {
  readonly phase?: string;
  readonly message?: string;
}

/** Body of POST /changes/:id/work/:unit/detail: rich per-unit model detail. */
type DetailBody = UnitDetail;

/** Body of POST /events/repo-pushed. */
interface RepoPushedBody {
  /** The Change id. Optional: recovered from the workspace name when omitted. */
  readonly changeId?: string;
  /** The backend workspace (Artifact repo) name that was pushed. */
  readonly workspace?: string;
}

/** The header an agent presents its board token in. */
const BOARD_TOKEN_HEADER = "x-board-agent-token";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a board request body as JSON, refusing anything over the board's body
 * limit (413) before parsing it.
 */
async function readBoardBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: string; error: string }> {
  const max = BOARD_LIMITS.maxBodyBytes;
  const tooLarge = { ok: false as const, status: 413, code: "LIMIT", error: `a board request body is at most ${max} bytes` };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    return tooLarge;
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) {
    return tooLarge;
  }
  try {
    return { ok: true, value: text.trim() === "" ? {} : (JSON.parse(text) as unknown) };
  } catch {
    return { ok: false, status: 400, code: "BAD_PAYLOAD", error: "the board request body is not valid JSON" };
  }
}

/** Parse the board page `limit`: absent means the default; invalid is undefined. */
export function parseBoardLimit(value: string | null): number | undefined {
  if (value === null || value === "") {
    return BOARD_PAGE_DEFAULT;
  }
  if (!/^\d{1,4}$/.test(value)) {
    return undefined;
  }
  const limit = Number(value);
  return limit >= 1 && limit <= BOARD_PAGE_MAX ? limit : undefined;
}

/** Parse the board `after` query value: absent means 0; invalid is undefined. */
export function parseAfterSeq(value: string | null): number | undefined {
  if (value === null || value === "") {
    return 0;
  }
  return /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** Body of POST /changes/:id/escalations: a fork for a human to settle. */
interface EscalationBody {
  readonly kind?: EscalationKind;
  readonly unitId?: string;
  readonly path?: string;
  readonly question?: string;
  readonly options?: readonly string[];
}

/** Body of POST /changes/:id/escalations/:escId/resolve: the human decision. */
interface ResolveBody {
  readonly decision?: string;
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

/**
 * The shape of a repo-pushed message delivered to the Queue consumer.
 *
 * The real Cloudflare Artifacts event (verified live) is delivered as:
 *   { "type": "cf.artifacts.repo.pushed",
 *     "source": { "namespace": "...", "repoName": "<workspace>", "type": "artifacts" },
 *     "payload": { "ref": "...", "commits": [...] }, ... }
 * so the pushed workspace (Artifact repo) name is `source.repoName`. The older
 * flat fields are kept as fallbacks for a hand-posted or test event, and the
 * HTTP ingress path still uses the flat `{ changeId, workspace }` body.
 */
interface RepoPushedMessageBody {
  readonly type?: string;
  readonly changeId?: string;
  /** The pushed Artifact repo (workspace) name, under the real nested field. */
  readonly source?: {
    readonly namespace?: string;
    readonly repoName?: string;
    readonly type?: string;
  };
  /** Flat fallbacks for a hand-posted or test event. */
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

/** The integration repo of a Change run integrated on Cloudflare. */
export function integrationWorkspaceName(changeId: string): string {
  return `${changeId}--integration`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** What asking for integration on Cloudflare did. */
export interface CloudIntegrationKick {
  readonly started: boolean;
  readonly coalesced?: boolean;
  readonly instanceId?: string;
  readonly reason?: string;
}

/**
 * Ask for integration on Cloudflare: start the Change's IntegrationWorkflow,
 * or coalesce into the active one. An active instance that ended without
 * finishing (errored, terminated) is cleared and replaced.
 */
export async function kickCloudIntegration(env: EnvWithProvisioner, changeId: string): Promise<CloudIntegrationKick> {
  const workflow = env.INTEGRATION_WORKFLOW;
  if (!workflow) {
    return { started: false, reason: "this Worker has no INTEGRATION_WORKFLOW binding" };
  }
  const stub = changeStateStub(env, changeId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request = await stub.requestCloudIntegration();
    if (request.start && request.instanceId) {
      try {
        await workflow.create({ id: request.instanceId, params: { changeId, instanceId: request.instanceId } });
        return { started: true, instanceId: request.instanceId };
      } catch (error) {
        await stub.clearCloudIntegration(request.instanceId);
        return { started: false, reason: `the integration Workflow could not start: ${errorMessage(error)}` };
      }
    }
    if (request.coalesced && request.activeInstance) {
      const status = await workflow
        .get(request.activeInstance)
        .then((instance) => instance.status())
        .then((s) => s.status as string)
        .catch(() => "missing");
      if (["errored", "terminated", "complete", "missing"].includes(status)) {
        await stub.clearCloudIntegration(request.activeInstance);
        continue;
      }
      return { started: false, coalesced: true, instanceId: request.activeInstance };
    }
    return { started: false, ...(request.reason ? { reason: request.reason } : {}) };
  }
  return { started: false, reason: "the integration Workflow could not be started" };
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
        // The real Artifacts event carries the pushed repo as source.repoName;
        // a hand-posted or test event may use a flat workspace/repo field.
        const workspace =
          body.source?.repoName ?? body.workspace ?? body.repo ?? body.repository ?? "";
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

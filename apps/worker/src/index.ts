import { parseChangeSpec } from "@switchyard-change/change-core";
import type { DiscoveredWorkUnit } from "@switchyard-change/change-core";

import type { EscalationKind, LeaseWorkspace, UnitDetail, WorkspaceIdentity } from "./change-state.ts";
import type { ChangeState } from "./change-state.ts";
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
      "access-control-allow-headers": "content-type",
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
    return corsPreflight();
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
      });
      return json({ verifyAttempt: attempt }, 201);
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
        reason: body.reason ?? "verify-fail escalation",
      });
      return json({ retryAttempt: attempt }, 201);
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

/** Body of POST /changes/:id/verify-attempt: one change-level mechanical gate run. */
interface VerifyAttemptBody {
  readonly round?: number;
  readonly outcome?: "pass" | "fail";
  readonly model?: string;
  readonly gateCommand?: string;
  readonly failingOutput?: string;
}

/** Body of POST /changes/:id/retry-attempt: one change-level model-escalation retry. */
interface RetryAttemptBody {
  readonly round?: number;
  readonly fromModel?: string;
  readonly toModel?: string;
  readonly implicatedUnits?: readonly string[];
  readonly reason?: string;
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

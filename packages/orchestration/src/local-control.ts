/**
 * local-control: an in-process Change control surface for Node callers.
 *
 * The Cloudflare Worker's ChangeState Durable Object imports the
 * `cloudflare:workers` runtime module, which does not resolve under plain Node
 * (the CLI, the demo, and tests). This module provides a faithful, in-process
 * stand-in that reuses the real change-core scheduling (runnableUnits,
 * workUnitStatuses, detectPathCollisions), so the coordination behavior is the
 * genuine logic rather than a reimplementation.
 *
 * It exposes the same lease, cost, complete, and state operations the Worker
 * exposes over HTTP, and provisions workspaces through the honest
 * local-filesystem fallback provider, so the whole clone, execute, commit, and
 * push loop runs offline with zero Cloudflare setup. It is deliberately not the
 * real service: every workspace it hands out is labelled as a local fallback.
 */

import {
  buildWorkGraph,
  detectPathCollisions,
  normalizeDial,
  parseChangeSpec,
  planWriteLeases,
  recruit,
  runnableUnits,
  workUnitStatuses,
  type Change,
  type ConcurrencyDial,
  type Dependency,
  type LeaseDecision,
  type PathCollision,
  type RecruitDecision,
  type WorkUnitStatus,
} from "@switchyard-change/change-core";
import type {
  LocalFilesystemWorkspaceProvider,
} from "@switchyard-change/artifact-workspace/local";
import type { ScopedToken, WorkspaceRef } from "@switchyard-change/artifact-workspace";
import type { FetchLike } from "@switchyard-change/local-runner";

/** A recorded cost event, mirroring the Worker's cost bookkeeping. */
export interface CostEvent {
  readonly unitId: string;
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly executor?: string;
  readonly at: string;
}

/** A lease the control surface is holding for a WorkUnit. */
export interface LeaseRecord {
  readonly unitId: string;
  readonly ref: WorkspaceRef;
  readonly token: ScopedToken;
  readonly leasedAt: string;
}

/** A read-only view of one WorkUnit's live state. */
export interface WorkUnitView {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
  readonly leased: boolean;
  /**
   * The real workspace (Artifact repo) identity backing this unit, present once
   * a lease has provisioned one. Mirrors the Worker's WorkUnitView.workspace so
   * the console projects the offline substrate and the live Worker identically.
   * The plaintext token is never included (only the token id).
   */
  readonly workspace?: WorkspaceIdentity;
}

/** The real backing identity of a WorkUnit's workspace, mirroring the Worker. */
export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId: string;
  readonly leasedAt: string;
}

/** The live, serializable projection of a Change's orchestration state. */
export interface ChangeStateView {
  readonly id: string;
  readonly objective: string;
  readonly baseline: string;
  readonly budgetUsd: number;
  readonly assurance: Change["assurance"];
  readonly work: readonly WorkUnitView[];
  readonly edges: readonly Dependency[];
  readonly collisions: readonly PathCollision[];
  readonly completed: readonly string[];
  readonly spentUsd: number;
  readonly costEvents: readonly CostEvent[];
  readonly dial: ConcurrencyDial;
  readonly recruitments: readonly RecruitmentEvent[];
  /** The agent-built tool for this Change, when one was recorded. */
  readonly tool?: ToolRecord;
  /** Real tool-consumption records; each backs one consumed-tool edge. */
  readonly toolConsumptions: readonly ToolConsumption[];
  /** Write-lease coordination on contested paths (owner vs waiters). */
  readonly leaseEdges: readonly LeaseEdge[];
}

/** The agent-built tool recorded on the Change (mirrors the Worker). */
export interface ToolRecord {
  readonly builderUnitId: string;
  readonly capability: string;
  readonly toolPath: string;
  readonly workspace: WorkspaceIdentity;
  readonly label: string;
}

/** A recorded tool-consumption by a downstream unit (mirrors the Worker). */
export interface ToolConsumption {
  readonly capability: string;
  readonly consumerUnitId: string;
  readonly at: string;
}

/** A write-lease coordination record for a contested path (mirrors the Worker). */
export interface LeaseEdge {
  readonly path: string;
  readonly owner: string;
  readonly waiters: readonly string[];
}

/** A recruitment plan for one wave in the offline substrate (mirrors the DO). */
export interface RecruitmentPlan extends RecruitDecision {
  readonly inFlight: number;
  readonly dial: ConcurrencyDial;
  readonly runnable: readonly string[];
}

/** A recorded recruitment event (mirrors the DO's inspectable log). */
export interface RecruitmentEvent {
  readonly trigger: "kickoff" | "repo-pushed";
  readonly pushedWorkspace?: string;
  readonly completedUnit?: string;
  readonly recruited: readonly string[];
  readonly ceiling: number;
  readonly inFlightAfter: number;
  readonly at: string;
}

/** The outcome of ingesting a repo-pushed event offline (mirrors the DO). */
export interface RepoPushedResult {
  readonly completedUnit: string | null;
  readonly recruited: readonly string[];
  readonly done: boolean;
  readonly event: RecruitmentEvent;
}

/** One Change's in-process bookkeeping. */
class ChangeRecord {
  readonly completed = new Set<string>();
  readonly leases = new Map<string, LeaseRecord>();
  readonly costEvents: CostEvent[] = [];
  readonly change: Change;
  /** The min/max concurrency dial governing recruitment. */
  dial: ConcurrencyDial = normalizeDial(undefined);
  /** The inspectable recruitment-event log. */
  readonly recruitments: RecruitmentEvent[] = [];
  /** Backend workspace name -> unit id, so a repo-pushed event resolves a unit. */
  readonly workspaceUnits = new Map<string, string>();
  /** The agent-built tool recorded for this Change, when one was built. */
  tool: ToolRecord | null = null;
  /** Real tool-consumption records (downstream units that ran the tool). */
  readonly toolConsumptions: ToolConsumption[] = [];
  constructor(change: Change) {
    this.change = change;
  }
}

/**
 * In-process Change control surface. Create a Change from spec text, then let a
 * runner drive it through the same lease, cost, and complete operations the
 * Worker exposes. The lease records are kept so the caller can read each
 * completed WorkUnit's workspace for verification and integration afterwards.
 */
export class LocalChangeControl {
  private readonly records = new Map<string, ChangeRecord>();

  constructor(private readonly workspaces: LocalFilesystemWorkspaceProvider) {}

  /** Create a Change from spec YAML text (as POST /changes does). */
  createChange(specYaml: string): Change {
    const change = parseChangeSpec(specYaml);
    this.records.set(change.id, new ChangeRecord(change));
    return change;
  }

  /** Set the min/max concurrency dial (as POST /changes/:id/dial does). */
  configureDial(changeId: string, dial: Partial<ConcurrencyDial> | undefined): ConcurrencyDial {
    const record = this.require(changeId);
    record.dial = normalizeDial(dial);
    return record.dial;
  }

  /** The dial currently in force for a Change. */
  dial(changeId: string): ConcurrencyDial {
    return this.require(changeId).dial;
  }

  /** The inspectable recruitment-event log for a Change. */
  recruitments(changeId: string): readonly RecruitmentEvent[] {
    return this.require(changeId).recruitments;
  }

  /**
   * Record the agent-built tool published for this Change (mirrors the DO). The
   * builder unit must exist, so a tool node is backed by a real builder.
   */
  recordTool(changeId: string, tool: ToolRecord): ToolRecord {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === tool.builderUnitId)) {
      throw new Error(`unknown tool builder WorkUnit: ${tool.builderUnitId}`);
    }
    record.tool = tool;
    return tool;
  }

  /**
   * Record that a downstream unit actually ran the tool (mirrors the DO). A tool
   * must be recorded and the consumer must be a WorkUnit, so a consumed-tool
   * edge always maps to a real consumption.
   */
  recordToolConsumption(
    changeId: string,
    consumption: Omit<ToolConsumption, "at">,
  ): ToolConsumption {
    const record = this.require(changeId);
    if (!record.tool) {
      throw new Error("no agent-built tool recorded for this Change");
    }
    if (!record.change.work.some((u) => u.id === consumption.consumerUnitId)) {
      throw new Error(`unknown consumer WorkUnit: ${consumption.consumerUnitId}`);
    }
    const stored: ToolConsumption = { ...consumption, at: new Date().toISOString() };
    record.toolConsumptions.push(stored);
    return stored;
  }

  /**
   * Compute the recruitment plan for the next wave: exactly the DO's policy,
   * sharing the same `recruit` function from change-core. The window over the
   * runnable set is bounded by the dial and by how many agents are in flight.
   */
  planRecruitment(changeId: string): RecruitmentPlan {
    const record = this.require(changeId);
    const runnable = runnableUnits(record.change, record.completed);
    const openRunnable = runnable.filter((id) => !record.leases.has(id));
    // In flight = agents still running: leased but not yet completed. Completed
    // leases are retained for later verification, so they must not count toward
    // the concurrency ceiling or recruitment would stall after the first wave.
    const inFlight = [...record.leases.keys()].filter((id) => !record.completed.has(id)).length;
    const decision = recruit({ runnable: openRunnable, inFlight, dial: record.dial });
    return { ...decision, inFlight, dial: record.dial, runnable: openRunnable };
  }

  /** Append a recruitment event to the log (as the Worker does after a wave). */
  recordRecruitment(changeId: string, event: Omit<RecruitmentEvent, "at">): RecruitmentEvent {
    const record = this.require(changeId);
    const stored: RecruitmentEvent = { ...event, at: new Date().toISOString() };
    record.recruitments.push(stored);
    return stored;
  }

  /**
   * Ingest a repo-pushed event: the offline mirror of the DO's recordRepoPushed.
   * It resolves the pushed workspace to its WorkUnit, marks that unit complete
   * (idempotent), and computes the next recruitment plan under the dial. This is
   * the identical event-driven code path the live Worker runs; offline it is
   * driven by a faked event rather than a real queued one.
   */
  recordRepoPushed(changeId: string, workspaceName: string): RepoPushedResult {
    const record = this.require(changeId);
    const unitId = record.workspaceUnits.get(workspaceName);

    let completedUnit: string | null = null;
    if (unitId && record.change.work.some((u) => u.id === unitId)) {
      // The push event names the unit it pertains to. Mark it complete if it is
      // not already (a runner may have reported completion first); either way,
      // this event is what drives recruitment of the next wave, so report the
      // unit the push completed so the log names it.
      record.completed.add(unitId);
      record.leases.delete(unitId);
      completedUnit = unitId;
    }

    const plan = this.planRecruitment(changeId);
    const done = record.completed.size >= record.change.work.length && plan.recruit.length === 0;
    const event: RecruitmentEvent = {
      trigger: "repo-pushed",
      pushedWorkspace: workspaceName,
      completedUnit: completedUnit ?? undefined,
      recruited: plan.recruit,
      ceiling: plan.ceiling,
      inFlightAfter: plan.inFlight + plan.recruit.length,
      at: new Date().toISOString(),
    };
    return { completedUnit, recruited: plan.recruit, done, event };
  }

  /** The parsed Change held under an id. */
  change(changeId: string): Change {
    return this.require(changeId).change;
  }

  /** The lease records held for a Change, keyed by WorkUnit id. */
  leases(changeId: string): ReadonlyMap<string, LeaseRecord> {
    return this.require(changeId).leases;
  }

  /** The completed WorkUnit ids for a Change. */
  completed(changeId: string): readonly string[] {
    return [...this.require(changeId).completed];
  }

  /** The total recorded cost across all cost events for a Change. */
  spentUsd(changeId: string): number {
    const record = this.require(changeId);
    return Number(record.costEvents.reduce((sum, e) => sum + e.usd, 0).toFixed(6));
  }

  /** All recorded cost events for a Change. */
  costEvents(changeId: string): readonly CostEvent[] {
    return this.require(changeId).costEvents;
  }

  /** The live state projection for a Change (as GET /changes/:id does). */
  state(changeId: string): ChangeStateView {
    const record = this.require(changeId);
    const change = record.change;
    const statuses = workUnitStatuses(change, record.completed);
    const collisions = detectPathCollisions(change);
    const graph = buildWorkGraph(change);
    const leasePlan = planWriteLeases(change, collisions);
    const leaseEdges: LeaseEdge[] = [];
    for (const decision of leasePlan.decisions as readonly LeaseDecision[]) {
      if (decision.resolution === "serialized" && decision.owner !== undefined) {
        leaseEdges.push({ path: decision.path, owner: decision.owner, waiters: decision.waiters });
      }
    }
    const work: WorkUnitView[] = change.work.map((unit) => {
      const base = statuses.get(unit.id) ?? "waiting";
      const leased = record.leases.has(unit.id);
      const lease = record.leases.get(unit.id);
      const workspace: WorkspaceIdentity | undefined = lease
        ? {
            workspaceId: lease.ref.id,
            workspaceName: lease.ref.name,
            gitUrl: lease.ref.gitUrl,
            defaultBranch: lease.ref.defaultBranch,
            backend: lease.ref.backend,
            fallback: lease.ref.fallback,
            tokenId: lease.token.id,
            leasedAt: lease.leasedAt,
          }
        : undefined;
      return {
        id: unit.id,
        objective: unit.objective,
        dependsOn: unit.dependsOn,
        paths: unit.paths,
        status: base === "runnable" && leased ? "running" : base,
        leased,
        ...(workspace ? { workspace } : {}),
      };
    });
    return {
      id: change.id,
      objective: change.objective,
      baseline: change.baseline,
      budgetUsd: change.budgetUsd,
      assurance: change.assurance,
      work,
      edges: graph.edges,
      collisions,
      completed: [...record.completed],
      spentUsd: this.spentUsd(changeId),
      costEvents: record.costEvents,
      dial: record.dial,
      recruitments: record.recruitments,
      ...(record.tool ? { tool: record.tool } : {}),
      toolConsumptions: record.toolConsumptions,
      leaseEdges,
    };
  }

  /** A fetch-shaped transport the WorkerClient can be pointed at. */
  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://local-control");
    const method = (init?.method ?? "GET").toUpperCase();

    const lease = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/lease$/);
    if (method === "POST" && lease) {
      return this.handleLease(dec(lease[1]), dec(lease[2]));
    }
    const cost = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/cost$/);
    if (method === "POST" && cost) {
      return this.handleCost(dec(cost[1]), dec(cost[2]), parseBody(init));
    }
    const complete = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/complete$/);
    if (method === "POST" && complete) {
      return this.handleComplete(dec(complete[1]), dec(complete[2]), parseBody(init));
    }
    return json({ error: "not found" }, 404);
  };

  private async handleLease(changeId: string, unitId: string): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const unit = record.change.work.find((u) => u.id === unitId);
    if (!unit) {
      return json({ error: `unknown WorkUnit: ${unitId}` }, 404);
    }
    if (!runnableUnits(record.change, record.completed).includes(unitId)) {
      return json({ error: `WorkUnit is not runnable: ${unitId}` }, 409);
    }
    if (record.leases.has(unitId)) {
      return json({ error: `WorkUnit already leased: ${unitId}` }, 409);
    }
    const workspaceName = workspaceNameFor(changeId, unitId);
    const ref = await this.workspaces.create(workspaceName, { defaultBranch: "main" });
    const token = await this.workspaces.issueWriteToken(ref);
    record.leases.set(unitId, { unitId, ref, token, leasedAt: new Date().toISOString() });
    record.workspaceUnits.set(ref.name, unitId);
    return json(
      {
        unitId,
        objective: unit.objective,
        paths: unit.paths,
        baselineRef: record.change.baseline,
        workspaceId: ref.id,
        workspaceName: ref.name,
        gitUrl: ref.gitUrl,
        defaultBranch: ref.defaultBranch,
        backend: ref.backend,
        fallback: ref.fallback,
        tokenId: token.id,
        tokenExpiresAt: token.expiresAt,
        token: token.token,
      },
      201,
    );
  }

  private async handleCost(
    changeId: string,
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    record.costEvents.push({
      unitId,
      usd: numberOr(body.usd, 0),
      inputTokens: body.inputTokens as number | undefined,
      outputTokens: body.outputTokens as number | undefined,
      executor: body.executor as string | undefined,
      at: new Date().toISOString(),
    });
    return json({ ok: true }, 200);
  }

  private async handleComplete(
    changeId: string,
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    const costBody = body.cost as Record<string, unknown> | undefined;
    if (costBody) {
      record.costEvents.push({
        unitId,
        usd: numberOr(costBody.usd, 0),
        inputTokens: costBody.inputTokens as number | undefined,
        outputTokens: costBody.outputTokens as number | undefined,
        executor: costBody.executor as string | undefined,
        at: new Date().toISOString(),
      });
    }
    record.completed.add(unitId);
    const lease = record.leases.get(unitId);
    if (lease) {
      // Revoke the token but keep the workspace ref so verification and
      // integration can still read the pushed result afterwards.
      await this.workspaces.revokeToken(lease.ref, lease.token.id);
    }
    const statuses = workUnitStatuses(record.change, record.completed);
    return json(
      { completed: [...record.completed], statuses: Object.fromEntries(statuses) },
      200,
    );
  }

  private require(changeId: string): ChangeRecord {
    const record = this.records.get(changeId);
    if (!record) {
      throw new Error(`no such Change: ${changeId}`);
    }
    return record;
  }
}

/** A stable, filesystem-safe workspace name for a Change's WorkUnit. */
export function workspaceNameFor(changeId: string, unitId: string): string {
  return `${changeId}--${unitId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (!init?.body || typeof init.body !== "string" || init.body.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function dec(segment: string | undefined): string {
  return decodeURIComponent(segment ?? "");
}

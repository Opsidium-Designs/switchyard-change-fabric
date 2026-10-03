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
  detectPathCollisions,
  parseChangeSpec,
  runnableUnits,
  workUnitStatuses,
  type Change,
  type PathCollision,
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
}

/** A read-only view of one WorkUnit's live state. */
export interface WorkUnitView {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
  readonly leased: boolean;
}

/** The live, serializable projection of a Change's orchestration state. */
export interface ChangeStateView {
  readonly id: string;
  readonly objective: string;
  readonly baseline: string;
  readonly budgetUsd: number;
  readonly assurance: Change["assurance"];
  readonly work: readonly WorkUnitView[];
  readonly collisions: readonly PathCollision[];
  readonly completed: readonly string[];
  readonly spentUsd: number;
  readonly costEvents: readonly CostEvent[];
}

/** One Change's in-process bookkeeping. */
class ChangeRecord {
  readonly completed = new Set<string>();
  readonly leases = new Map<string, LeaseRecord>();
  readonly costEvents: CostEvent[] = [];
  readonly change: Change;
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
    const work: WorkUnitView[] = change.work.map((unit) => {
      const base = statuses.get(unit.id) ?? "waiting";
      const leased = record.leases.has(unit.id);
      return {
        id: unit.id,
        objective: unit.objective,
        dependsOn: unit.dependsOn,
        paths: unit.paths,
        status: base === "runnable" && leased ? "running" : base,
        leased,
      };
    });
    return {
      id: change.id,
      objective: change.objective,
      baseline: change.baseline,
      budgetUsd: change.budgetUsd,
      assurance: change.assurance,
      work,
      collisions,
      completed: [...record.completed],
      spentUsd: this.spentUsd(changeId),
      costEvents: record.costEvents,
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
    record.leases.set(unitId, { unitId, ref, token });
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

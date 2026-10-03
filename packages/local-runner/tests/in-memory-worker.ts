/**
 * In-memory Worker control surface for deterministic, offline integration tests.
 *
 * This is a faithful stand-in for the real Cloudflare Worker's HTTP routes
 * (lease, cost, complete, state). It reuses the real change-core scheduling
 * (runnableUnits/workUnitStatuses), so the coordination behavior under test is
 * the genuine logic, not a reimplementation. Workspaces are provisioned by the
 * honest local-filesystem fallback provider so runners do real Git clone/commit/
 * push over file:// remotes with zero Cloudflare setup.
 *
 * The real Durable Object (change-state.ts) imports `cloudflare:workers`, which
 * does not resolve under plain Node vitest; this harness lets the full runner
 * path be exercised in-process without a live `wrangler dev`.
 */

import {
  parseChangeSpec,
  runnableUnits,
  workUnitStatuses,
  type Change,
} from "@switchyard-change/change-core";
import {
  LocalFilesystemWorkspaceProvider,
} from "@switchyard-change/artifact-workspace/local";
import type {
  ScopedToken,
  WorkspaceRef,
} from "@switchyard-change/artifact-workspace";

import type { FetchLike } from "../src/worker-client.ts";

interface CostEvent {
  readonly unitId: string;
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly executor?: string;
  readonly at: string;
}

interface LeaseRecord {
  readonly unitId: string;
  readonly ref: WorkspaceRef;
  readonly token: ScopedToken;
}

/** A single Change's in-memory state. */
class ChangeRecord {
  readonly completed = new Set<string>();
  readonly leases = new Map<string, LeaseRecord>();
  readonly costEvents: CostEvent[] = [];
  constructor(readonly change: Change) {}
}

export class InMemoryWorker {
  private readonly changes = new Map<string, ChangeRecord>();

  constructor(private readonly workspaces: LocalFilesystemWorkspaceProvider) {}

  /** Create a Change from spec YAML, as POST /changes does. */
  createChange(specYaml: string): Change {
    const change = parseChangeSpec(specYaml);
    this.changes.set(change.id, new ChangeRecord(change));
    return change;
  }

  /** The spent total across recorded cost events for a Change. */
  spentUsd(changeId: string): number {
    const record = this.require(changeId);
    return Number(record.costEvents.reduce((sum, e) => sum + e.usd, 0).toFixed(6));
  }

  /** All recorded cost events for a Change. */
  costEvents(changeId: string): readonly CostEvent[] {
    return this.require(changeId).costEvents;
  }

  /** The completed WorkUnit ids for a Change. */
  completed(changeId: string): readonly string[] {
    return [...this.require(changeId).completed];
  }

  /** A fetch-shaped transport the WorkerClient can be pointed at. */
  fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://worker.local");
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
    const record = this.changes.get(changeId);
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

    const workspaceName = `${changeId}--${unitId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
    const ref = await this.workspaces.create(workspaceName, {
      defaultBranch: "main",
    });
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
    const record = this.changes.get(changeId);
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
    const record = this.changes.get(changeId);
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
      await this.workspaces.revokeToken(lease.ref, lease.token.id);
      record.leases.delete(unitId);
    }
    const statuses = workUnitStatuses(record.change, record.completed);
    return json({ completed: [...record.completed], statuses: Object.fromEntries(statuses) }, 200);
  }

  private require(changeId: string): ChangeRecord {
    const record = this.changes.get(changeId);
    if (!record) {
      throw new Error(`no such Change: ${changeId}`);
    }
    return record;
  }
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

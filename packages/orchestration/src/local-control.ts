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
  appendDiscoveredUnits,
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
  type DiscoveredWorkUnit,
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

/** One ordered real run step a runner reported for a unit (mirrors the DO). */
export interface ActivityStep {
  readonly phase: string;
  readonly message: string;
  readonly at: string;
}

/** The rich per-unit model detail a runner reported (mirrors the DO). */
export interface UnitDetail {
  readonly promptSummary?: string;
  readonly model?: string;
  readonly editedPaths?: readonly string[];
  readonly diff?: string;
  readonly commitMessage?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly usd?: number;
  readonly at?: string;
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
  /**
   * The ordered real run steps the agent for this unit emitted (mirrors the DO),
   * so the console's per-node activity log is backed by real steps offline too.
   */
  readonly activity?: readonly ActivityStep[];
  /**
   * The rich per-unit detail (prompt summary, proposed edit/diff, model, tokens
   * and cost) the runner reported (mirrors the DO), so click-detail reads real
   * state offline too.
   */
  readonly detail?: UnitDetail;
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
  /** Human escalations recorded for this Change (pending and resolved). */
  readonly escalations: readonly Escalation[];
  /**
   * The WorkUnits an agent ultimately failed on, with the reason. A failed unit
   * is terminal-for-that-unit and does not block the rest of the wave. Mirrors
   * the Worker's ChangeStateView so the console projects both identically.
   */
  readonly failed: readonly FailureRecord[];
  /** The live deployment of the fixed app for this run (mirrors the Worker). */
  readonly deployment?: DeploymentRecord;
  /** Mechanical verify attempts (mirrors the Worker); back the `verify` nodes. */
  readonly verifyAttempts: readonly VerifyAttempt[];
  /** Model-escalation retries (mirrors the Worker); back `retry` nodes/edges. */
  readonly retryAttempts: readonly RetryAttempt[];
}

/** A recorded WorkUnit failure (mirrors the Worker's FailureRecord). */
export interface FailureRecord {
  readonly unitId: string;
  readonly reason: string;
  readonly at: string;
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

/** A recorded live deployment of the fixed app (mirrors the Worker). */
export interface DeploymentRecord {
  readonly url: string;
  readonly app: string;
  readonly at: string;
}

/** A write-lease coordination record for a contested path (mirrors the Worker). */
export interface LeaseEdge {
  readonly path: string;
  readonly owner: string;
  readonly waiters: readonly string[];
}

/** The outcome of one mechanical verification attempt (mirrors the Worker). */
export type VerifyOutcome = "pass" | "fail";

/** One recorded mechanical VERIFY attempt for a WorkUnit (mirrors the Worker). */
export interface VerifyAttempt {
  readonly unitId: string;
  readonly attempt: number;
  readonly outcome: VerifyOutcome;
  readonly model: string;
  readonly evidence?: string;
  readonly at: string;
}

/** One recorded model-escalation RETRY for a WorkUnit (mirrors the Worker). */
export interface RetryAttempt {
  readonly unitId: string;
  readonly attempt: number;
  readonly fromModel: string;
  readonly toModel: string;
  readonly reason: string;
  readonly at: string;
}

/** The kind of a fork that must be escalated to a human (mirrors the Worker). */
export type EscalationKind = "lease-owner" | "verification-ambiguous" | "decision";

/** Whether an escalation is still pending or resolved (mirrors the Worker). */
export type EscalationStatus = "pending" | "resolved";

/** A human escalation record (mirrors the Worker's durable escalation). */
export interface Escalation {
  readonly id: string;
  readonly kind: EscalationKind;
  readonly unitId?: string;
  readonly path?: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly status: EscalationStatus;
  readonly decision?: string;
  readonly raisedAt: string;
  readonly resolvedAt?: string;
}

/** The input to raise an escalation offline (mirrors the Worker). */
export interface RaiseEscalationInput {
  readonly kind: EscalationKind;
  readonly unitId?: string;
  readonly path?: string;
  readonly question: string;
  readonly options?: readonly string[];
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
  /**
   * The Change this record coordinates. Mutable because dynamic branching
   * appends DISCOVERED WorkUnits to the live graph: a completing unit can reveal
   * follow-up work, which is admitted as real backed units via addWorkUnits,
   * replacing this with an augmented Change whose `work` includes them. Every
   * downstream read (runnable/waiting, recruitment, state projection) reads this
   * field, so appended units are picked up with no other change.
   */
  change: Change;
  /** The min/max concurrency dial governing recruitment. */
  dial: ConcurrencyDial = normalizeDial(undefined);
  /** The inspectable recruitment-event log. */
  readonly recruitments: RecruitmentEvent[] = [];
  /** Backend workspace name -> unit id, so a repo-pushed event resolves a unit. */
  readonly workspaceUnits = new Map<string, string>();
  /**
   * Per-unit real workspace (Artifact repo) identity, recorded at lease time and
   * KEPT past completion so a completed node still reveals the real repo it ran
   * in. Mirrors the Worker DO's `workspaces` map; without it a completed unit
   * (whose lease is released on the repo-pushed event) would lose its workspace
   * and project back to a plain work node, diverging from the live Worker.
   */
  readonly workspaceIdentities = new Map<string, WorkspaceIdentity>();
  /** The agent-built tool recorded for this Change, when one was built. */
  tool: ToolRecord | null = null;
  /** Real tool-consumption records (downstream units that ran the tool). */
  readonly toolConsumptions: ToolConsumption[] = [];
  /** Human escalations recorded for this Change (pending and resolved). */
  readonly escalations: Escalation[] = [];
  /** WorkUnits an agent ultimately failed on (mirrors the DO's failed set). */
  readonly failed = new Map<string, FailureRecord>();
  /** Per-unit ordered real run steps (mirrors the DO's activity log). */
  readonly activity = new Map<string, ActivityStep[]>();
  /** Per-unit rich model detail (mirrors the DO's detail). */
  readonly detail = new Map<string, UnitDetail>();
  /** The live deployment of the fixed app recorded for this run (mirrors DO). */
  deployment: DeploymentRecord | null = null;
  /** Mechanical verify attempts recorded for this Change (mirrors the DO). */
  readonly verifyAttempts: VerifyAttempt[] = [];
  /** Model-escalation retries recorded for this Change (mirrors the DO). */
  readonly retryAttempts: RetryAttempt[] = [];
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

  /** All escalations recorded for a Change (pending and resolved). */
  escalations(changeId: string): readonly Escalation[] {
    return this.require(changeId).escalations;
  }

  /**
   * Raise a human escalation for a fork mechanical evidence cannot settle
   * (mirrors the DO). Idempotent for the same pending (kind, unitId, path), so a
   * re-driven engine does not pile up duplicates. The engine then waits on it.
   */
  raiseEscalation(changeId: string, input: RaiseEscalationInput): Escalation {
    const record = this.require(changeId);
    if (input.unitId && !record.change.work.some((u) => u.id === input.unitId)) {
      throw new Error(`unknown WorkUnit for escalation: ${input.unitId}`);
    }
    const existing = record.escalations.find(
      (e) =>
        e.status === "pending" &&
        e.kind === input.kind &&
        e.unitId === input.unitId &&
        e.path === input.path,
    );
    if (existing) {
      return existing;
    }
    const escalation: Escalation = {
      id: `esc-${record.escalations.length + 1}-${Date.now().toString(36)}`,
      kind: input.kind,
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      question: input.question,
      options: input.options ?? [],
      status: "pending",
      raisedAt: new Date().toISOString(),
    };
    record.escalations.push(escalation);
    return escalation;
  }

  /**
   * Resolve a pending escalation with the human's decision (mirrors the DO).
   * This is the input that ends the durable wait and lets the graph advance.
   */
  resolveEscalation(changeId: string, id: string, decision: string): Escalation {
    const record = this.require(changeId);
    const index = record.escalations.findIndex((e) => e.id === id);
    if (index === -1) {
      throw new Error(`unknown escalation: ${id}`);
    }
    const current = record.escalations[index] as Escalation;
    if (current.status === "resolved") {
      throw new Error(`escalation already resolved: ${id}`);
    }
    const resolved: Escalation = {
      ...current,
      status: "resolved",
      decision,
      resolvedAt: new Date().toISOString(),
    };
    record.escalations[index] = resolved;
    return resolved;
  }

  /** Whether a pending escalation exists (optionally for a specific unit). */
  hasPendingEscalation(changeId: string, unitId?: string): boolean {
    const record = this.require(changeId);
    return record.escalations.some(
      (e) => e.status === "pending" && (unitId === undefined || e.unitId === unitId),
    );
  }

  /** The WorkUnits an agent ultimately failed on for a Change. */
  failures(changeId: string): readonly FailureRecord[] {
    return [...this.require(changeId).failed.values()];
  }

  /**
   * Mark a WorkUnit FAILED (mirrors the DO's failUnit). An agent ultimately
   * could not complete it after the executor's bounded retries, or it timed out.
   * It releases the lease so the dial frees the slot and the wave advances, and
   * records a durable failure so the unit projects status "failed". A failed
   * unit is terminal-for-that-unit and NOT added to completed, so its dependents
   * stay blocked while the rest of the open runnable set advances. Idempotent:
   * failing an already-completed unit is a safe no-op (a late failure signal
   * does not undo a real success).
   */
  failUnit(changeId: string, unitId: string, reason?: string): FailureRecord | null {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    if (record.completed.has(unitId)) {
      return record.failed.get(unitId) ?? null;
    }
    let failure = record.failed.get(unitId);
    if (!failure) {
      failure = {
        unitId,
        reason: ((reason ?? "agent failed").toString().replace(/\s+/g, " ").trim() || "agent failed").slice(0, 300),
        at: new Date().toISOString(),
      };
      record.failed.set(unitId, failure);
    }
    record.leases.delete(unitId);
    return failure;
  }

  /**
   * Record one ordered real run step a runner reported for a WorkUnit (mirrors
   * the DO's recordStep): the real step in the run (leased, cloning, calling the
   * model, applying the edit, committing, pushing, verified, failed). The unit
   * must exist; the message is bounded and secret-stripped before storage, so
   * the offline activity log is backed by real steps just like the live Worker.
   */
  recordStep(changeId: string, unitId: string, phase: string, message: string): ActivityStep {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const step: ActivityStep = {
      phase: boundedPhase(phase),
      message: sanitizeText(message, 300) || "step",
      at: new Date().toISOString(),
    };
    const list = record.activity.get(unitId) ?? [];
    list.push(step);
    record.activity.set(unitId, list.length > 200 ? list.slice(-200) : list);
    return step;
  }

  /**
   * Record (merge) the rich per-unit model detail a runner reported (mirrors the
   * DO's recordDetail): prompt summary, proposed edit/diff, model, commit
   * message, tokens, and cost. Merging lets detail accrue across calls. The unit
   * must exist; the free-text fields are bounded and secret-stripped.
   */
  recordDetail(changeId: string, unitId: string, detail: UnitDetail): UnitDetail {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    const merged: UnitDetail = {
      ...(record.detail.get(unitId) ?? {}),
      ...sanitizeDetail(detail),
      at: new Date().toISOString(),
    };
    record.detail.set(unitId, merged);
    return merged;
  }

  /** The ordered real run steps recorded for a WorkUnit (mirrors the DO). */
  activityFor(changeId: string, unitId: string): readonly ActivityStep[] {
    return this.require(changeId).activity.get(unitId) ?? [];
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
    const openRunnable = runnable.filter((id) => !record.leases.has(id) && !record.failed.has(id));
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
    // The wave is done when nothing is left to recruit and every unit has reached
    // a terminal state (completed or failed). A failed unit is terminal, so a run
    // with some failures still finishes rather than waiting forever for a count
    // of completed units it can never reach.
    const terminal = record.completed.size + record.failed.size;
    const done = terminal >= record.change.work.length && plan.recruit.length === 0;
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

  /**
   * Append DISCOVERED follow-up WorkUnits to the live Change (the offline mirror
   * of the DO's addWorkUnits). This is the dynamic-branching mechanism: a
   * completing unit reported that fixing one thing revealed more work, so the
   * engine adds those units to the live WorkGraph and the next wave recruits
   * them. The append is validated by the shared change-core guard (parent must
   * exist, each discovered unit must declare a path, each is rooted under the
   * parent, ids are namespaced and unique). Already-present ids are treated as a
   * no-op (an idempotent re-report), so a re-driven engine does not pile up
   * duplicates. The augmented Change replaces the stored one; everything
   * downstream reads change.work, so the new units are scheduled, recruited, and
   * projected with no other change.
   */
  addWorkUnits(
    changeId: string,
    parentUnitId: string,
    discovered: readonly DiscoveredWorkUnit[],
  ): readonly string[] {
    const record = this.require(changeId);
    // Filter out any discovered unit whose namespaced id already exists, so a
    // repeated report is an idempotent no-op rather than an error.
    const existing = new Set(record.change.work.map((u) => u.id));
    const fresh = discovered.filter(
      (u) =>
        !existing.has(
          `${parentUnitId}+${u.idSuffix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "found"}`,
        ),
    );
    if (fresh.length === 0) {
      return [];
    }
    const { change, added } = appendDiscoveredUnits(record.change, parentUnitId, fresh);
    record.change = change;
    return added.map((u) => u.id);
  }

  /** The lease records held for a Change, keyed by WorkUnit id. */
  leases(changeId: string): ReadonlyMap<string, LeaseRecord> {
    return this.require(changeId).leases;
  }

  /**
   * Record the live deployment of the fixed app (mirrors the DO). Recorded only
   * after verification passed and the deploy succeeded, so the console surfaces
   * a real reachable URL and never one for a broken or undeployed app.
   */
  recordDeployment(changeId: string, deployment: Omit<DeploymentRecord, "at">): DeploymentRecord {
    const record = this.require(changeId);
    const stored: DeploymentRecord = { ...deployment, at: new Date().toISOString() };
    record.deployment = stored;
    return stored;
  }

  /**
   * Record one mechanical VERIFY attempt for a WorkUnit (mirrors the DO). This
   * is the real backing for a `verify` graph node, so a verify node can only
   * exist once this record does. The verifier is mechanical on every attempt, so
   * this is the ground-truth verdict, never the model grading itself.
   */
  recordVerifyAttempt(changeId: string, input: Omit<VerifyAttempt, "at">): VerifyAttempt {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === input.unitId)) {
      throw new Error(`unknown WorkUnit: ${input.unitId}`);
    }
    const stored: VerifyAttempt = {
      unitId: input.unitId,
      attempt: Number.isFinite(input.attempt) && input.attempt > 0 ? Math.floor(input.attempt) : 1,
      outcome: input.outcome === "pass" ? "pass" : "fail",
      model: typeof input.model === "string" ? input.model.slice(0, 120) : "",
      ...(typeof input.evidence === "string" && input.evidence !== ""
        ? { evidence: sanitizeText(input.evidence, 20_000) }
        : {}),
      at: new Date().toISOString(),
    };
    record.verifyAttempts.push(stored);
    return stored;
  }

  /**
   * Record one model-escalation RETRY for a WorkUnit (mirrors the DO). This is
   * the real backing for a `retry` graph node and the `model-escalation` edge,
   * kept wholly separate from the human-escalation `escalated` flag.
   */
  recordRetryAttempt(changeId: string, input: Omit<RetryAttempt, "at">): RetryAttempt {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === input.unitId)) {
      throw new Error(`unknown WorkUnit: ${input.unitId}`);
    }
    const stored: RetryAttempt = {
      unitId: input.unitId,
      attempt: Number.isFinite(input.attempt) && input.attempt > 1 ? Math.floor(input.attempt) : 2,
      fromModel: typeof input.fromModel === "string" ? input.fromModel.slice(0, 120) : "",
      toModel: typeof input.toModel === "string" ? input.toModel.slice(0, 120) : "",
      reason: sanitizeText(input.reason ?? "verify-fail escalation", 300) || "verify-fail escalation",
      at: new Date().toISOString(),
    };
    record.retryAttempts.push(stored);
    return stored;
  }

  /**
   * Mark a WorkUnit FAILED on a verify-fail verdict (mirrors the DO's
   * recordVerifyFailure): its candidate edit did not pass the mechanical per-app
   * gate after the bounded ladder. This is the VERDICT on the pushed edit, so it
   * overrides a prior pushed/completed marker (removes it from completed) and
   * records a durable failure, making the unit a real RED node. Verification is
   * the authority on green vs red, not the mere fact that an agent pushed.
   */
  recordVerifyFailure(changeId: string, unitId: string, reason?: string): FailureRecord {
    const record = this.require(changeId);
    if (!record.change.work.some((u) => u.id === unitId)) {
      throw new Error(`unknown WorkUnit: ${unitId}`);
    }
    record.completed.delete(unitId);
    const existing = record.failed.get(unitId);
    if (existing) {
      return existing;
    }
    const stored: FailureRecord = {
      unitId,
      reason:
        sanitizeText(reason ?? "verify failed after the bounded model-escalation ladder", 300) ||
        "verify failed",
      at: new Date().toISOString(),
    };
    record.failed.set(unitId, stored);
    const lease = record.leases.get(unitId);
    if (lease) {
      void this.workspaces.revokeToken(lease.ref, lease.token.id).catch(() => {});
    }
    return stored;
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
      // Prefer the retained workspace identity (kept past completion) so a
      // completed node still reveals its real repo, mirroring the Worker DO.
      const retained = record.workspaceIdentities.get(unit.id);
      const workspace: WorkspaceIdentity | undefined = retained
        ? retained
        : lease
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
      // A failed unit projects "failed" over any derived status, mirroring the
      // Worker: it is terminal-for-that-unit even though it released its lease.
      const status: WorkUnitStatus = record.failed.has(unit.id)
        ? "failed"
        : base === "runnable" && leased
          ? "running"
          : base;
      return {
        id: unit.id,
        objective: unit.objective,
        dependsOn: unit.dependsOn,
        paths: unit.paths,
        status,
        leased,
        ...(workspace ? { workspace } : {}),
        ...(record.activity.get(unit.id) && record.activity.get(unit.id)!.length > 0
          ? { activity: record.activity.get(unit.id) }
          : {}),
        ...(record.detail.get(unit.id) ? { detail: record.detail.get(unit.id) } : {}),
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
      escalations: record.escalations,
      failed: [...record.failed.values()].sort((a, b) =>
        a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0,
      ),
      ...(record.deployment ? { deployment: record.deployment } : {}),
      verifyAttempts: record.verifyAttempts,
      retryAttempts: record.retryAttempts,
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
    const fail = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/fail$/);
    if (method === "POST" && fail) {
      return this.handleFail(dec(fail[1]), dec(fail[2]), parseBody(init));
    }
    const discovered = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/discovered$/);
    if (method === "POST" && discovered) {
      const b = parseBody(init);
      const units = Array.isArray(b.units) ? (b.units as DiscoveredWorkUnit[]) : [];
      try {
        const added = this.addWorkUnits(dec(discovered[1]), dec(discovered[2]), units);
        return json({ added }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const step = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/step$/);
    if (method === "POST" && step) {
      const b = parseBody(init);
      const recorded = this.recordStep(
        dec(step[1]),
        dec(step[2]),
        String(b.phase ?? "step"),
        String(b.message ?? ""),
      );
      return json({ step: recorded }, 201);
    }
    const detail = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/detail$/);
    if (method === "POST" && detail) {
      const recorded = this.recordDetail(dec(detail[1]), dec(detail[2]), parseBody(init) as UnitDetail);
      return json({ detail: recorded }, 201);
    }
    const deploymentRoute = url.pathname.match(/^\/changes\/([^/]+)\/deployment$/);
    if (method === "POST" && deploymentRoute) {
      const b = parseBody(init);
      const recorded = this.recordDeployment(dec(deploymentRoute[1]), {
        url: String(b.url ?? ""),
        app: String(b.app ?? ""),
      });
      return json({ deployment: recorded }, 201);
    }
    const verifyAttemptRoute = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/verify-attempt$/,
    );
    if (method === "POST" && verifyAttemptRoute) {
      const b = parseBody(init);
      try {
        const recorded = this.recordVerifyAttempt(dec(verifyAttemptRoute[1]), {
          unitId: dec(verifyAttemptRoute[2]),
          attempt: numberOr(b.attempt, 1),
          outcome: b.outcome === "pass" ? "pass" : "fail",
          model: String(b.model ?? ""),
          ...(typeof b.evidence === "string" && b.evidence !== ""
            ? { evidence: String(b.evidence) }
            : {}),
        });
        return json({ verifyAttempt: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const retryAttemptRoute = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/retry-attempt$/,
    );
    if (method === "POST" && retryAttemptRoute) {
      const b = parseBody(init);
      try {
        const recorded = this.recordRetryAttempt(dec(retryAttemptRoute[1]), {
          unitId: dec(retryAttemptRoute[2]),
          attempt: numberOr(b.attempt, 2),
          fromModel: String(b.fromModel ?? ""),
          toModel: String(b.toModel ?? ""),
          reason: String(b.reason ?? "verify-fail escalation"),
        });
        return json({ retryAttempt: recorded }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const verifyFailRoute = url.pathname.match(
      /^\/changes\/([^/]+)\/work\/([^/]+)\/verify-fail$/,
    );
    if (method === "POST" && verifyFailRoute) {
      const b = parseBody(init);
      try {
        this.recordVerifyFailure(dec(verifyFailRoute[1]), dec(verifyFailRoute[2]), String(b.reason ?? ""));
        return json(this.state(dec(verifyFailRoute[1])), 200);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
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
    // Keep the workspace identity past completion (mirrors the Worker DO) so a
    // completed node still reveals the real repo it ran in.
    record.workspaceIdentities.set(unitId, {
      workspaceId: ref.id,
      workspaceName: ref.name,
      gitUrl: ref.gitUrl,
      defaultBranch: ref.defaultBranch,
      backend: ref.backend,
      fallback: ref.fallback,
      tokenId: token.id,
      leasedAt: new Date().toISOString(),
    });
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

  private async handleFail(
    changeId: string,
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const record = this.records.get(changeId);
    if (!record) {
      return json({ error: `no such Change: ${changeId}` }, 404);
    }
    if (!record.change.work.some((u) => u.id === unitId)) {
      return json({ error: `unknown WorkUnit: ${unitId}` }, 404);
    }
    const lease = record.leases.get(unitId);
    const failure = this.failUnit(changeId, unitId, body.reason as string | undefined);
    if (lease) {
      // Revoke the token exactly as completion does; the workspace ref is kept
      // for any later inspection, but the unit is terminal and not integrated.
      await this.workspaces.revokeToken(lease.ref, lease.token.id).catch(() => {});
    }
    return json({ failed: failure, completed: [...record.completed] }, 200);
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

/** Keep an activity-step phase short, lowercase, and metadata-safe. */
function boundedPhase(phase: string | undefined): string {
  const text = (phase ?? "step").toString().replace(/\s+/g, "-").trim().toLowerCase();
  const bounded = text.length > 40 ? text.slice(0, 40) : text;
  return bounded === "" ? "step" : bounded;
}

/** Bound a text field and strip credential-looking fragments defensively. */
function sanitizeText(text: string, max: number): string {
  const redacted = (text ?? "")
    .toString()
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return redacted.length > max ? `${redacted.slice(0, max - 3)}...` : redacted;
}

/** Sanitize a reported UnitDetail (bound text, keep finite numbers). */
function sanitizeDetail(detail: UnitDetail): UnitDetail {
  const out: Record<string, unknown> = {};
  if (typeof detail.promptSummary === "string") out.promptSummary = sanitizeText(detail.promptSummary, 20_000);
  if (typeof detail.model === "string") out.model = detail.model.slice(0, 120);
  if (Array.isArray(detail.editedPaths)) {
    out.editedPaths = detail.editedPaths
      .filter((p): p is string => typeof p === "string")
      .slice(0, 50)
      .map((p) => p.slice(0, 300));
  }
  if (typeof detail.diff === "string") out.diff = sanitizeText(detail.diff, 20_000);
  if (typeof detail.commitMessage === "string") out.commitMessage = sanitizeText(detail.commitMessage, 500);
  if (typeof detail.inputTokens === "number" && Number.isFinite(detail.inputTokens)) out.inputTokens = detail.inputTokens;
  if (typeof detail.outputTokens === "number" && Number.isFinite(detail.outputTokens)) out.outputTokens = detail.outputTokens;
  if (typeof detail.usd === "number" && Number.isFinite(detail.usd)) out.usd = detail.usd;
  return out as UnitDetail;
}

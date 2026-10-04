/**
 * graph-model: the pure projection from a live ChangeState snapshot to the
 * typed node-and-edge graph the console renders.
 *
 * This is the heart of the honesty constraint. The console does NOT animate a
 * script and does NOT invent nodes. It renders exactly this projection of the
 * real durable state the Worker (or the offline control surface) reports. Every
 * node and every edge produced here is derived from a concrete element of the
 * snapshot and carries a `backing` object naming the real state it came from. A
 * node that has no backing state cannot be produced: `buildWorkGraphModel`
 * throws if a derivation ever tries to emit an unbacked node, and
 * `assertBacked` is the single guard every node passes through.
 *
 * It is free of I/O, React, and the Cloudflare runtime, so the same projection
 * runs in the browser console, in a Node test, and anywhere else. The console
 * imports these types and this function; the tests assert the mapping and the
 * no-unbacked-node rule against real snapshots.
 *
 * Typed-but-not-yet-populated hooks (so the shape is stable before the behavior
 * lands) are marked explicitly: the `tool` node kind and the `consumed-tool`
 * edge kind are reserved for the agent-for-agent tooling milestone and are
 * never emitted yet; the `escalated` node flag is reserved for the human
 * escalation milestone and is always false until the engine surfaces an
 * escalation. They are part of the type now so the view and its tests do not
 * change shape when that behavior arrives.
 */

/** The WorkUnit lifecycle status, mirrored from change-core without importing it. */
export type WorkUnitStatus =
  | "waiting"
  | "runnable"
  | "running"
  | "verified"
  | "failed"
  | "integrated";

/** The real Artifact repo identity backing a work/agent node (no token). */
export interface WorkspaceIdentitySnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId?: string;
  readonly tokenExpiresAt?: string;
  readonly leasedAt?: string;
}

/** One WorkUnit as the state projection reports it. */
export interface WorkUnitSnapshot {
  readonly id: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly paths: readonly string[];
  readonly status: WorkUnitStatus;
  readonly leased: boolean;
  /** Present once an agent has been recruited (a lease recorded) for the unit. */
  readonly workspace?: WorkspaceIdentitySnapshot;
}

/** A dependency edge between two WorkUnits, as reported by the state. */
export interface DependencySnapshot {
  readonly from: string;
  readonly to: string;
}

/** A recorded recruitment event, as reported by the state. */
export interface RecruitmentEventSnapshot {
  readonly trigger: "kickoff" | "repo-pushed";
  readonly pushedWorkspace?: string;
  readonly completedUnit?: string;
  readonly recruited: readonly string[];
  readonly ceiling: number;
  readonly inFlightAfter: number;
  readonly at: string;
}

/** A recorded cost event, as reported by the state. */
export interface CostEventSnapshot {
  readonly unitId: string;
  readonly usd: number;
  readonly at: string;
}

/** The min/max concurrency dial currently in force. */
export interface DialSnapshot {
  readonly minConcurrency: number;
  readonly maxConcurrency: number;
}

/**
 * The subset of the live ChangeState projection the graph model reads. Both the
 * Worker's `ChangeStateView` and the offline control surface's view are
 * structurally assignable to this, so the model projects either without a
 * cross-package runtime import.
 */
export interface ChangeStateSnapshot {
  readonly id: string;
  readonly objective: string;
  readonly work: readonly WorkUnitSnapshot[];
  readonly edges: readonly DependencySnapshot[];
  readonly completed: readonly string[];
  readonly dial?: DialSnapshot;
  readonly recruitments?: readonly RecruitmentEventSnapshot[];
  readonly costEvents?: readonly CostEventSnapshot[];
}

/** The kind of a node in the rendered graph. */
export type GraphNodeKind =
  | "goal" // the Change itself: the root the graph self-organizes toward
  | "work" // a declared WorkUnit before an agent is recruited for it
  | "agent" // a WorkUnit an agent has been recruited for (a real repo exists)
  | "tool"; // RESERVED (agent-for-agent tooling milestone); never emitted yet

/** The kind of an edge in the rendered graph. */
export type GraphEdgeKind =
  | "dependency" // a declared WorkGraph dependency between two units
  | "data-flow" // a dependency an agent push has made live (data has flowed)
  | "spawn" // an event-driven recruitment: a push recruited the target
  | "consumed-tool"; // RESERVED (tooling milestone); never emitted yet

/**
 * The real state element a node is backed by. Every node carries one. There is
 * no node kind without a backing variant, which is what makes an unbacked node
 * unrepresentable rather than merely discouraged.
 */
export type NodeBacking =
  | { readonly kind: "change"; readonly changeId: string }
  | {
      readonly kind: "work-unit";
      readonly unitId: string;
      readonly status: WorkUnitStatus;
    }
  | {
      readonly kind: "workspace";
      readonly unitId: string;
      readonly workspace: WorkspaceIdentitySnapshot;
    };

/** The real state element an edge is backed by. */
export type EdgeBacking =
  | { readonly kind: "dependency"; readonly from: string; readonly to: string }
  | {
      readonly kind: "recruitment-event";
      readonly at: string;
      readonly pushedWorkspace?: string;
      readonly completedUnit?: string;
    };

/** A node in the rendered graph. */
export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly status: WorkUnitStatus;
  /** True once this unit's work is verified/integrated (the node greens). */
  readonly verified: boolean;
  /**
   * RESERVED for the human escalation milestone. Always false until the engine
   * surfaces an evidence-unsettled fork; the console highlights it when true.
   */
  readonly escalated: boolean;
  /** The real Artifact repo backing an agent node, when one exists. */
  readonly workspace?: WorkspaceIdentitySnapshot;
  /** The concrete state element this node was derived from. */
  readonly backing: NodeBacking;
}

/** An edge in the rendered graph. */
export interface GraphEdge {
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly from: string;
  readonly to: string;
  /** The concrete state element this edge was derived from. */
  readonly backing: EdgeBacking;
}

/** The full graph model projected from one ChangeState snapshot. */
export interface WorkGraphModel {
  readonly changeId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly dial?: DialSnapshot;
}

/** The id used for the single goal node (the Change root). */
export function goalNodeId(changeId: string): string {
  return `goal:${changeId}`;
}

/** The id used for a WorkUnit's node. */
export function unitNodeId(unitId: string): string {
  return `unit:${unitId}`;
}

/**
 * The honesty guard every node passes through. It verifies the node carries a
 * backing that actually resolves against the snapshot, and throws otherwise. A
 * node whose backing does not name a real Change, a real WorkUnit, or a real
 * recorded workspace is rejected here, so an unbacked node can never reach the
 * returned model (and therefore never reach the screen).
 */
export function assertBacked(node: GraphNode, snapshot: ChangeStateSnapshot): GraphNode {
  const backing = node.backing;
  switch (backing.kind) {
    case "change":
      if (backing.changeId !== snapshot.id) {
        throw new Error(
          `unbacked node ${node.id}: goal backing ${backing.changeId} is not the Change ${snapshot.id}`,
        );
      }
      return node;
    case "work-unit": {
      const unit = snapshot.work.find((u) => u.id === backing.unitId);
      if (!unit) {
        throw new Error(
          `unbacked node ${node.id}: no WorkUnit ${backing.unitId} in the state snapshot`,
        );
      }
      return node;
    }
    case "workspace": {
      const unit = snapshot.work.find((u) => u.id === backing.unitId);
      if (!unit || !unit.workspace) {
        throw new Error(
          `unbacked node ${node.id}: WorkUnit ${backing.unitId} has no recorded workspace in the state`,
        );
      }
      return node;
    }
    default: {
      // Exhaustiveness: a new backing kind must be handled above.
      const _never: never = backing;
      throw new Error(`unbacked node ${node.id}: unknown backing ${JSON.stringify(_never)}`);
    }
  }
}

/** Whether a status counts as verified/integrated (the node greens). */
function isVerified(status: WorkUnitStatus): boolean {
  return status === "verified" || status === "integrated";
}

/**
 * Project a live ChangeState snapshot into the typed graph the console renders.
 *
 * The mapping, in one place:
 *   - the goal node is the Change root, backed by the Change id;
 *   - each WorkUnit is one node: it is an `agent` node (backed by its real
 *     workspace) once a lease has recorded a workspace for it, otherwise a
 *     plain `work` node (backed by the WorkUnit). A node greens when its status
 *     is verified/integrated. The `escalated` flag is reserved (always false).
 *   - every WorkUnit node gets a `dependency` edge from the goal, so the graph
 *     is rooted and nothing floats unattached to the Change it serves;
 *   - each declared dependency edge is a `dependency` edge, promoted to a
 *     `data-flow` edge once its prerequisite is complete (data has actually
 *     flowed from the finished prerequisite to the dependent);
 *   - each repo-pushed recruitment event becomes a `spawn` edge from the pushing
 *     unit to each unit that push recruited (the event-driven nervous system),
 *     backed by the real recruitment-event log entry.
 *
 * Because the whole graph is derived from the snapshot and every node is passed
 * through `assertBacked`, the morphing the console shows over time is purely a
 * projection of real state transitions between successive snapshots, never a
 * timed animation. Nodes appear when the state gains a unit/lease, green when
 * the state marks them verified/integrated, and fade when the state removes
 * them.
 */
export function buildWorkGraphModel(snapshot: ChangeStateSnapshot): WorkGraphModel {
  const completed = new Set(snapshot.completed);
  const unitIds = new Set(snapshot.work.map((u) => u.id));
  const nodes: GraphNode[] = [];

  // The goal node: the Change root the graph self-organizes toward.
  nodes.push(
    assertBacked(
      {
        id: goalNodeId(snapshot.id),
        kind: "goal",
        label: snapshot.objective || snapshot.id,
        // The goal reads verified only when every unit is integrated.
        status: snapshot.work.every((u) => isVerified(u.status)) && snapshot.work.length > 0
          ? "integrated"
          : "running",
        verified:
          snapshot.work.length > 0 && snapshot.work.every((u) => isVerified(u.status)),
        escalated: false,
        backing: { kind: "change", changeId: snapshot.id },
      },
      snapshot,
    ),
  );

  // One node per WorkUnit. An agent node is backed by a real recorded workspace;
  // a work node is backed by the WorkUnit itself. There is no third option, so
  // every unit node has concrete backing.
  for (const unit of snapshot.work) {
    const hasWorkspace = unit.workspace !== undefined;
    const node: GraphNode = hasWorkspace
      ? {
          id: unitNodeId(unit.id),
          kind: "agent",
          label: unit.id,
          status: unit.status,
          verified: isVerified(unit.status),
          escalated: false,
          workspace: unit.workspace,
          backing: { kind: "workspace", unitId: unit.id, workspace: unit.workspace! },
        }
      : {
          id: unitNodeId(unit.id),
          kind: "work",
          label: unit.id,
          status: unit.status,
          verified: isVerified(unit.status),
          escalated: false,
          backing: { kind: "work-unit", unitId: unit.id, status: unit.status },
        };
    nodes.push(assertBacked(node, snapshot));
  }

  const edges: GraphEdge[] = [];

  // Root every unit to the goal, so the graph is a tree over the Change. These
  // are backed by the Change-to-unit relationship the snapshot declares (the
  // unit exists in this Change's work set).
  for (const unit of snapshot.work) {
    edges.push({
      id: `goal->${unit.id}`,
      kind: "dependency",
      from: goalNodeId(snapshot.id),
      to: unitNodeId(unit.id),
      backing: { kind: "dependency", from: snapshot.id, to: unit.id },
    });
  }

  // Declared dependency edges. An edge whose prerequisite is complete is a
  // data-flow edge (data has flowed from the finished prerequisite); otherwise
  // it is a plain dependency edge. Both are backed by the real edge in state.
  for (const edge of snapshot.edges) {
    if (!unitIds.has(edge.from) || !unitIds.has(edge.to)) {
      // Defensive: the state should never report an edge to a unit it does not
      // also list, but if it does, skip it rather than draw an unbacked edge.
      continue;
    }
    const live = completed.has(edge.from);
    edges.push({
      id: `${edge.from}->${edge.to}`,
      kind: live ? "data-flow" : "dependency",
      from: unitNodeId(edge.from),
      to: unitNodeId(edge.to),
      backing: { kind: "dependency", from: edge.from, to: edge.to },
    });
  }

  // Event-driven spawn edges: each repo-pushed recruitment event spawned the
  // units it recruited. The edge runs from the pushing unit (the one whose push
  // drove the wave) to each recruited unit, backed by the real event log entry.
  for (const event of snapshot.recruitments ?? []) {
    if (event.trigger !== "repo-pushed" || !event.completedUnit) {
      continue;
    }
    const fromUnit = event.completedUnit;
    if (!unitIds.has(fromUnit)) {
      continue;
    }
    for (const recruitedId of event.recruited) {
      if (!unitIds.has(recruitedId)) {
        continue;
      }
      edges.push({
        id: `spawn:${fromUnit}->${recruitedId}@${event.at}`,
        kind: "spawn",
        from: unitNodeId(fromUnit),
        to: unitNodeId(recruitedId),
        backing: {
          kind: "recruitment-event",
          at: event.at,
          pushedWorkspace: event.pushedWorkspace,
          completedUnit: event.completedUnit,
        },
      });
    }
  }

  return { changeId: snapshot.id, nodes, edges, dial: snapshot.dial };
}

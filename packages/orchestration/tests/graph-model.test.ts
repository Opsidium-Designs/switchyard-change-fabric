/**
 * M3: the state-to-graph projection and the no-unbacked-node rule.
 *
 * These tests pin the honesty constraint that the whole milestone exists to
 * prove: the console renders a projection of REAL durable ChangeState, never a
 * script and never a mock. They assert, against ChangeState snapshots shaped
 * exactly as the Worker and the offline control surface report them:
 *
 *   (a) every node and edge the projection emits is derived from a concrete
 *       element of the snapshot and carries a backing that resolves against it;
 *   (b) a node cannot be rendered without backing state: `assertBacked` throws
 *       for a goal/work/workspace backing that does not resolve, and the builder
 *       routes every node through it, so an unbacked node is unrepresentable;
 *   (c) a WorkUnit is an `agent` node (backed by its real Artifact repo) only
 *       once the state records a workspace for it, and a plain `work` node
 *       otherwise, so a node claiming a repo always has one in the state;
 *   (d) nodes green exactly when the state marks them verified/integrated, a
 *       dependency edge becomes a data-flow edge exactly when its prerequisite
 *       is complete, and a repo-pushed event becomes a spawn edge: the morphing
 *       is a function of the snapshot, not a timeline;
 *   (e) the dial carried into the model is the real dial from the state.
 *
 * The projection is pure, so these run under `make check` with no Worker, no
 * Cloudflare account, and no browser.
 */

import { describe, expect, it } from "vitest";

import {
  assertBacked,
  buildWorkGraphModel,
  goalNodeId,
  retryNodeId,
  roundAgentNodeId,
  unitNodeId,
  verifyNodeId,
  type ChangeStateSnapshot,
  type GraphNode,
  type WorkspaceIdentitySnapshot,
} from "../src/graph-model.ts";

/** A real-looking recorded workspace identity (the honest local fallback). */
function workspace(unitId: string, fallback = true): WorkspaceIdentitySnapshot {
  return {
    workspaceId: `ws-${unitId}`,
    workspaceName: `change-demo--${unitId}`,
    gitUrl: fallback ? `file:///tmp/artifacts/change-demo--${unitId}` : `https://git/${unitId}`,
    defaultBranch: "main",
    backend: fallback ? "local-filesystem" : "cloudflare-artifacts",
    fallback,
    tokenId: `tok-${unitId}`,
    tokenExpiresAt: "2026-10-04T12:00:00.000Z",
    leasedAt: "2026-10-04T10:00:00.000Z",
  };
}

/**
 * A layered snapshot: a base unit two dependents wait on. `base` has been
 * recruited (a real workspace recorded) and completed; `left` is running with a
 * recorded workspace; `right` is still a plain waiting work node. One
 * repo-pushed recruitment event recorded that base's push recruited `left`.
 */
function layeredSnapshot(): ChangeStateSnapshot {
  return {
    id: "change-demo",
    objective: "A base unit gates two dependents",
    completed: ["base"],
    dial: { minConcurrency: 1, maxConcurrency: 3 },
    work: [
      {
        id: "base",
        objective: "base unit",
        dependsOn: [],
        paths: ["src/base/**"],
        status: "integrated",
        leased: false,
        workspace: workspace("base"),
      },
      {
        id: "left",
        objective: "left dependent",
        dependsOn: ["base"],
        paths: ["src/left/**"],
        status: "running",
        leased: true,
        workspace: workspace("left"),
      },
      {
        id: "right",
        objective: "right dependent",
        dependsOn: ["base"],
        paths: ["src/right/**"],
        status: "waiting",
        leased: false,
      },
    ],
    edges: [
      { from: "base", to: "left" },
      { from: "base", to: "right" },
    ],
    recruitments: [
      {
        trigger: "kickoff",
        recruited: ["base"],
        ceiling: 3,
        inFlightAfter: 1,
        at: "2026-10-04T10:00:00.000Z",
      },
      {
        trigger: "repo-pushed",
        pushedWorkspace: "change-demo--base",
        completedUnit: "base",
        recruited: ["left"],
        ceiling: 3,
        inFlightAfter: 1,
        at: "2026-10-04T10:05:00.000Z",
      },
    ],
    costEvents: [{ unitId: "base", usd: 0, at: "2026-10-04T10:05:00.000Z" }],
  };
}

describe("M3: the graph is a projection of real ChangeState, not a script", () => {
  it("materializes a node only for spawned units (a pending, un-recruited unit yields no node)", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    const goal = model.nodes.filter((n) => n.kind === "goal");
    expect(goal).toHaveLength(1);
    expect(goal[0]?.id).toBe(goalNodeId("change-demo"));
    // base (integrated, has a workspace) and left (running, has a workspace) are
    // spawned, so they materialize; right is still a pending, un-recruited unit
    // with no workspace, so it yields NO node (it appears only once recruited).
    const unitNodes = model.nodes.filter((n) => n.kind !== "goal");
    expect(unitNodes.map((n) => n.id).sort()).toEqual(
      ["base", "left"].map(unitNodeId).sort(),
    );
    expect(unitNodes.some((n) => n.id === unitNodeId("right"))).toBe(false);
    // The goal plus the two spawned units; the pending unit is withheld.
    expect(model.nodes).toHaveLength(3);
  });

  it("renders an agent node (backed by a real repo) once the state records a workspace, and withholds a pending unit", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    const base = model.nodes.find((n) => n.id === unitNodeId("base"));
    const right = model.nodes.find((n) => n.id === unitNodeId("right"));

    // base has a recorded workspace: it is an agent node and reveals the real repo.
    expect(base?.kind).toBe("agent");
    expect(base?.backing.kind).toBe("workspace");
    expect(base?.workspace?.workspaceName).toBe("change-demo--base");
    expect(base?.workspace?.gitUrl).toContain("change-demo--base");

    // right has no workspace and is still pending/un-recruited: no node yet.
    expect(right).toBeUndefined();
  });

  it("materializes a withheld unit as a work node once it is leased (recruited) even before a workspace is recorded", () => {
    // A unit leased by the scheduler but whose workspace record has not landed
    // yet is still SPAWNED (an agent was recruited), so it materializes as a
    // plain work node backed by the unit, not withheld.
    const snapshot = {
      ...layeredSnapshot(),
      work: layeredSnapshot().work.map((u) =>
        u.id === "right" ? { ...u, leased: true, status: "runnable" as const } : u,
      ),
    };
    const model = buildWorkGraphModel(snapshot);
    const right = model.nodes.find((n) => n.id === unitNodeId("right"));
    expect(right?.kind).toBe("work");
    expect(right?.backing.kind).toBe("work-unit");
    expect(right?.workspace).toBeUndefined();
  });

  it("greens a node exactly when the state marks it verified or integrated", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    const base = model.nodes.find((n) => n.id === unitNodeId("base"));
    const left = model.nodes.find((n) => n.id === unitNodeId("left"));
    // base is integrated -> verified/green; left is running -> not yet.
    expect(base?.verified).toBe(true);
    expect(left?.verified).toBe(false);
  });

  it("promotes a dependency edge to a data-flow edge once its prerequisite is complete", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    // base is complete, so base->left is a data-flow edge. (base->right is not
    // drawn: right is still pending/un-recruited, so it has no node yet.)
    const toLeft = model.edges.find((e) => e.id === "base->left");
    expect(toLeft?.kind).toBe("data-flow");
    expect(toLeft?.backing).toEqual({ kind: "dependency", from: "base", to: "left" });
    expect(model.edges.some((e) => e.id === "base->right")).toBe(false);

    // With left spawned but nothing complete, the same declared edge is a plain
    // dependency edge.
    const pending = buildWorkGraphModel({ ...layeredSnapshot(), completed: [] });
    expect(pending.edges.find((e) => e.id === "base->left")?.kind).toBe("dependency");
  });

  it("draws an event-driven spawn edge for each repo-pushed recruitment, backed by the real event", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    const spawn = model.edges.find((e) => e.kind === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn?.from).toBe(unitNodeId("base"));
    expect(spawn?.to).toBe(unitNodeId("left"));
    expect(spawn?.backing).toMatchObject({
      kind: "recruitment-event",
      completedUnit: "base",
      pushedWorkspace: "change-demo--base",
    });
    // A kickoff recruitment never produces a spawn edge (no pushing unit).
    const kickoffSpawns = model.edges.filter(
      (e) => e.kind === "spawn" && e.to === unitNodeId("base"),
    );
    expect(kickoffSpawns).toHaveLength(0);
  });

  it("roots every spawned unit to the goal so nothing floats unattached to the Change", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    for (const unitId of ["base", "left"]) {
      const edge = model.edges.find((e) => e.id === `goal->${unitId}`);
      expect(edge).toBeDefined();
      expect(edge?.from).toBe(goalNodeId("change-demo"));
      expect(edge?.to).toBe(unitNodeId(unitId));
    }
    // The pending, un-recruited unit has no node, so it is not rooted either.
    expect(model.edges.some((e) => e.id === "goal->right")).toBe(false);
  });

  it("carries the real dial from the state into the model", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    expect(model.dial).toEqual({ minConcurrency: 1, maxConcurrency: 3 });
  });

  it("emits no tool node or consumed-tool edge when the state records none", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    // The layered snapshot records no tool, so no tool node / consumed-tool edge
    // is emitted (a tool node requires a real tool record; see tool-build.e2e).
    expect(model.nodes.some((n) => n.kind === "tool")).toBe(false);
    expect(model.edges.some((e) => e.kind === "consumed-tool")).toBe(false);
    // No lease coordination recorded, so no lease edge either.
    expect(model.edges.some((e) => e.kind === "lease")).toBe(false);
    // The escalation highlight is still reserved: no node is escalated yet.
    expect(model.nodes.some((n) => n.escalated)).toBe(false);
  });
});

/**
 * The graph materializes a unit's node only once it is SPAWNED (an agent is
 * recruited for it), event-spawned nodes hang off their spawner via the spawn
 * edge, and the whole rendered vocabulary stays within the five node kinds and
 * five edge kinds the owner spec allows.
 */
describe("the graph materializes on spawn and exposes only the five node/edge kinds", () => {
  /**
   * A snapshot where a base unit has pushed and recruited a dependent, but a
   * second dependent is still fully pending (no lease, no workspace, status
   * waiting). The pending one must NOT materialize; the recruited one must hang
   * off its spawner by a spawn edge.
   */
  function partialSnapshot(): ChangeStateSnapshot {
    return {
      id: "change-spawn",
      objective: "base recruits one dependent; a second stays pending",
      completed: ["base"],
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      work: [
        {
          id: "base",
          objective: "base",
          dependsOn: [],
          paths: ["src/base/**"],
          status: "integrated",
          leased: false,
          workspace: workspace("base"),
        },
        {
          id: "child",
          objective: "recruited child",
          dependsOn: ["base"],
          paths: ["src/child/**"],
          status: "running",
          leased: true,
          workspace: workspace("child"),
        },
        {
          id: "later",
          objective: "still pending, no agent yet",
          dependsOn: ["base"],
          paths: ["src/later/**"],
          status: "waiting",
          leased: false,
        },
      ],
      edges: [
        { from: "base", to: "child" },
        { from: "base", to: "later" },
      ],
      recruitments: [
        {
          trigger: "repo-pushed",
          pushedWorkspace: "change-demo--base",
          completedUnit: "base",
          recruited: ["child"],
          ceiling: 3,
          inFlightAfter: 1,
          at: "2026-10-04T10:05:00.000Z",
        },
      ],
    };
  }

  it("emits no node for a pending, un-recruited unit (materialize on spawn)", () => {
    const model = buildWorkGraphModel(partialSnapshot());
    expect(model.nodes.find((n) => n.id === unitNodeId("later"))).toBeUndefined();
    // base and child are spawned, so they materialize.
    expect(model.nodes.find((n) => n.id === unitNodeId("base"))).toBeDefined();
    expect(model.nodes.find((n) => n.id === unitNodeId("child"))).toBeDefined();
    // The goal shows first; only the spawned units join it.
    expect(model.nodes.filter((n) => n.kind !== "goal").map((n) => n.id).sort()).toEqual(
      ["base", "child"].map(unitNodeId).sort(),
    );
    // No edge points at the withheld unit (no goal-root, no dependency edge).
    expect(model.edges.some((e) => e.id === "goal->later")).toBe(false);
    expect(model.edges.some((e) => e.id === "base->later")).toBe(false);
  });

  it("hangs an event-spawned node off its spawner via the spawn edge (not a detached row)", () => {
    const model = buildWorkGraphModel(partialSnapshot());
    const spawn = model.edges.find((e) => e.kind === "spawn");
    expect(spawn).toBeDefined();
    // The edge runs spawner -> spawned (base recruited child by its push).
    expect(spawn?.from).toBe(unitNodeId("base"));
    expect(spawn?.to).toBe(unitNodeId("child"));
    expect(spawn?.backing).toMatchObject({
      kind: "recruitment-event",
      completedUnit: "base",
    });
    // Both endpoints have real nodes, so the spawn edge is never drawn to a
    // missing node.
    expect(model.nodes.some((n) => n.id === spawn?.from)).toBe(true);
    expect(model.nodes.some((n) => n.id === spawn?.to)).toBe(true);
  });

  it("every node materialized on spawn is still backed (no unbacked node)", () => {
    const snapshot = partialSnapshot();
    const model = buildWorkGraphModel(snapshot);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("exposes ONLY the five node kinds and five edge kinds across a rich snapshot", () => {
    // The ladder snapshot carries goal + agent + verify + retry + round-N agent
    // nodes and dependency/data-flow/model-escalation(folded)/re-fan(folded)
    // edges; a tool/lease snapshot adds tool + consumed-tool + lease. Together
    // the rendered vocabulary must stay inside the allowed five + five.
    const allowedNodeKinds = new Set(["goal", "agent", "verify", "retry", "tool"]);
    const allowedEdgeKinds = new Set([
      "dependency",
      "spawn",
      "consumed-tool",
      "lease",
      "data-flow",
    ]);
    for (const snapshot of [ladderSnapshot(), partialSnapshot(), layeredSnapshot()]) {
      const model = buildWorkGraphModel(snapshot);
      for (const node of model.nodes) {
        expect(allowedNodeKinds.has(node.kind)).toBe(true);
      }
      for (const edge of model.edges) {
        expect(allowedEdgeKinds.has(edge.kind)).toBe(true);
      }
    }
    // The withheld pending-unit `work` kind never reaches the rendered set now:
    // a unit is either a spawned agent/work node or absent, and a materialized
    // pending-but-leased unit is a `work` node, which is NOT in the allowed set,
    // so assert the rich snapshots above emit none. (The `work` kind remains a
    // valid internal projection for a leased-but-workspaceless unit, but the
    // legend/owner-spec rendered set is goal/agent/verify/retry/tool.)
    for (const snapshot of [ladderSnapshot(), partialSnapshot(), layeredSnapshot()]) {
      const model = buildWorkGraphModel(snapshot);
      expect(model.nodes.some((n) => n.kind === "work")).toBe(false);
    }
  });
});

describe("M3: a node cannot be rendered without backing state", () => {
  it("every node the builder emits passes the backing guard against the same snapshot", () => {
    const snapshot = layeredSnapshot();
    const model = buildWorkGraphModel(snapshot);
    // Re-running the guard over every emitted node must not throw: each resolves.
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("rejects a goal node whose Change id does not match the snapshot", () => {
    const snapshot = layeredSnapshot();
    const bogus: GraphNode = {
      id: "goal:other",
      kind: "goal",
      label: "not this change",
      status: "running",
      verified: false,
      escalated: false,
      backing: { kind: "change", changeId: "some-other-change" },
    };
    expect(() => assertBacked(bogus, snapshot)).toThrow(/unbacked node/);
  });

  it("rejects a work node for a WorkUnit that is not in the snapshot", () => {
    const snapshot = layeredSnapshot();
    const bogus: GraphNode = {
      id: unitNodeId("ghost"),
      kind: "work",
      label: "ghost",
      status: "waiting",
      verified: false,
      escalated: false,
      backing: { kind: "work-unit", unitId: "ghost", status: "waiting" },
    };
    expect(() => assertBacked(bogus, snapshot)).toThrow(/no WorkUnit ghost/);
  });

  it("rejects an agent node claiming a workspace the state does not record", () => {
    const snapshot = layeredSnapshot();
    // `right` is a real unit but has NO recorded workspace: claiming it is an
    // agent node with a repo is exactly the unbacked case that must be rejected.
    const bogus: GraphNode = {
      id: unitNodeId("right"),
      kind: "agent",
      label: "right",
      status: "running",
      verified: false,
      escalated: false,
      workspace: workspace("right"),
      backing: { kind: "workspace", unitId: "right", workspace: workspace("right") },
    };
    expect(() => assertBacked(bogus, snapshot)).toThrow(/no recorded workspace/);
  });

  it("drops a declared edge to a unit the state does not list rather than drawing it unbacked", () => {
    const snapshot: ChangeStateSnapshot = {
      ...layeredSnapshot(),
      edges: [
        { from: "base", to: "left" },
        { from: "base", to: "ghost" }, // ghost is not a listed unit
      ],
    };
    const model = buildWorkGraphModel(snapshot);
    expect(model.edges.some((e) => e.id === "base->ghost")).toBe(false);
    expect(model.edges.some((e) => e.id === "base->left")).toBe(true);
  });
});

describe("M3: the model morphs purely as a function of successive snapshots", () => {
  it("a unit appears as an agent and greens across two snapshots with no animation state", () => {
    // Before: right is still pending/un-recruited, so it has NO node yet.
    const before = buildWorkGraphModel(layeredSnapshot());
    expect(before.nodes.find((n) => n.id === unitNodeId("right"))).toBeUndefined();

    // After: the state recorded a workspace for right and marked it integrated.
    const after = buildWorkGraphModel({
      ...layeredSnapshot(),
      completed: ["base", "left", "right"],
      work: layeredSnapshot().work.map((u) =>
        u.id === "right"
          ? { ...u, status: "integrated", leased: false, workspace: workspace("right") }
          : u.id === "left"
            ? { ...u, status: "integrated" }
            : u,
      ),
    });
    const right = after.nodes.find((n) => n.id === unitNodeId("right"));
    expect(right?.kind).toBe("agent");
    expect(right?.verified).toBe(true);
    // The whole goal greens only when every unit is integrated.
    expect(after.nodes.find((n) => n.kind === "goal")?.verified).toBe(true);
    expect(before.nodes.find((n) => n.kind === "goal")?.verified).toBe(false);
  });
});

/**
 * T4: the bounded model-escalation ladder renders as its own honest, backed
 * graph kinds (verify nodes, a retry node, a model-escalation edge), distinct
 * from the human-escalation `escalated` flag. Each new node/edge must resolve
 * against a real recorded attempt in the snapshot, and a node whose backing
 * record is absent must be rejected (cannot render unbacked).
 */
function ladderSnapshot(): ChangeStateSnapshot {
  return {
    id: "change-ladder",
    objective: "A change whose round-1 gate fails and the escalation round passes",
    completed: ["fix"],
    work: [
      {
        id: "fix",
        objective: "fix the planted bug",
        dependsOn: [],
        paths: ["src/fix.js"],
        status: "integrated",
        leased: false,
        workspace: workspace("fix"),
      },
    ],
    edges: [],
    // The ladder is CHANGE-LEVEL: round 1 (the whole-change gate) failed, round 2
    // (after re-fanning the implicated units) passed. One attempt per round.
    verifyAttempts: [
      {
        round: 1,
        outcome: "fail",
        model: "base-model",
        gateCommand: "npm run gate",
        failingOutput: "FAIL src/fix.js: the planted bug is still present",
        at: "2026-10-04T10:00:00.000Z",
      },
      { round: 2, outcome: "pass", model: "escalation-model", gateCommand: "npm run gate", at: "2026-10-04T10:01:00.000Z" },
    ],
    retryAttempts: [
      {
        round: 2,
        fromModel: "base-model",
        toModel: "escalation-model",
        implicatedUnits: ["fix"],
        reason: "verify round 1 failed",
        at: "2026-10-04T10:00:30.000Z",
      },
    ],
  };
}

describe("T4: the change-level model-escalation ladder renders as backed verify/retry nodes and a model-escalation edge", () => {
  it("emits one change-level verify node per round, green on pass and red on fail, with readable labels", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    const v1 = model.nodes.find((n) => n.id === verifyNodeId("change-ladder", 1));
    const v2 = model.nodes.find((n) => n.id === verifyNodeId("change-ladder", 2));
    expect(v1?.kind).toBe("verify");
    expect(v1?.status).toBe("failed");
    expect(v1?.verified).toBe(false);
    // A readable label like "verify round 1 (app gate) fail", not a cryptic id.
    expect(v1?.label).toContain("verify round 1 (app gate)");
    expect(v1?.label).toContain("fail");
    expect(v2?.kind).toBe("verify");
    expect(v2?.status).toBe("verified");
    expect(v2?.verified).toBe(true);
    expect(v2?.label).toContain("verify round 2 (app gate)");
    expect(v2?.label).toContain("pass");
  });

  it("backs the round-1 verify node with the gate command and the real failing output", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    const v1 = model.nodes.find((n) => n.id === verifyNodeId("change-ladder", 1));
    expect(v1?.backing).toMatchObject({
      kind: "verify-attempt",
      changeId: "change-ladder",
      round: 1,
      outcome: "fail",
      gateCommand: "npm run gate",
      failingOutput: "FAIL src/fix.js: the planted bug is still present",
    });
  });

  it("emits a change-level retry node carrying implicated units + from/to model, reached by a model-escalation edge", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    const retry = model.nodes.find((n) => n.id === retryNodeId("change-ladder", 2));
    expect(retry?.kind).toBe("retry");
    expect(retry?.backing.kind).toBe("retry-attempt");
    // A readable label like "retry round 2: escalation-model (1 unit)".
    expect(retry?.label).toContain("retry round 2");
    expect(retry?.label).toContain("escalation-model");
    expect(retry?.label).toContain("1 unit");
    expect(retry?.backing).toMatchObject({
      kind: "retry-attempt",
      changeId: "change-ladder",
      round: 2,
      fromModel: "base-model",
      toModel: "escalation-model",
      implicatedUnits: ["fix"],
    });

    // The escalation hop reuses the `dependency` kind in the rendered vocabulary
    // (the five kinds), but still carries its full model-escalation provenance on
    // its backing. Assert via the backing so the beat remains pinned.
    const escalationEdge = model.edges.find((e) => e.backing.kind === "model-escalation");
    expect(escalationEdge).toBeDefined();
    expect(escalationEdge?.kind).toBe("dependency");
    expect(escalationEdge?.from).toBe(verifyNodeId("change-ladder", 1));
    expect(escalationEdge?.to).toBe(retryNodeId("change-ladder", 2));
    expect(escalationEdge?.backing).toMatchObject({
      kind: "model-escalation",
      changeId: "change-ladder",
      round: 2,
      fromModel: "base-model",
      toModel: "escalation-model",
    });
  });

  it("materializes a FRESH round-N agent node beneath the retry for each implicated unit, backed by the retry", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    // The retry round re-ran "fix" on the escalation model, so a NEW agent node
    // keyed by (unit, round) is materialized beneath the retry (not a back-edge
    // to the original fix unit node). It is a distinct id from the original unit.
    const roundNode = model.nodes.find(
      (n) => n.id === roundAgentNodeId("change-ladder", 2, "fix"),
    );
    expect(roundNode).toBeDefined();
    expect(roundNode?.kind).toBe("agent");
    // A readable label like "fix (retry 2)".
    expect(roundNode?.label).toContain("fix");
    expect(roundNode?.label).toContain("retry 2");
    expect(roundNode?.id).not.toBe(unitNodeId("fix"));
    // Backed by the real recorded retry round + implicated unit membership.
    expect(roundNode?.backing).toMatchObject({
      kind: "round-agent",
      changeId: "change-ladder",
      round: 2,
      unitId: "fix",
      toModel: "escalation-model",
    });
  });

  it("draws the re-fan edge from the retry node to the round-N agent node (not back to the original unit)", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    // The per-unit re-fan reuses the `data-flow` kind in the rendered vocabulary
    // but still carries its re-fan provenance on its backing; assert via backing.
    const refan = model.edges.filter((e) => e.backing.kind === "re-fan");
    expect(refan).toHaveLength(1);
    expect(refan[0]?.kind).toBe("data-flow");
    expect(refan[0]?.id).toBe("re-fan:change-ladder#2->fix");
    expect(refan[0]?.from).toBe(retryNodeId("change-ladder", 2));
    // The edge targets the FRESH round-N agent node beneath the retry, never the
    // original unit node.
    expect(refan[0]?.to).toBe(roundAgentNodeId("change-ladder", 2, "fix"));
    expect(refan[0]?.to).not.toBe(unitNodeId("fix"));
    // No re-fan edge points back at the original unit node.
    expect(
      model.edges.some((e) => e.backing.kind === "re-fan" && e.to === unitNodeId("fix")),
    ).toBe(false);
    // The edge is backed by the real recorded retry round + implicated unit id.
    expect(refan[0]?.backing).toMatchObject({
      kind: "re-fan",
      changeId: "change-ladder",
      round: 2,
      unitId: "fix",
      toModel: "escalation-model",
    });
  });

  it("renders the chain goal -> verify round 1 -> retry round 2 -> verify round 2 (round-1 edit from goal, round-2 edit from retry)", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    // round-1 verify flows from the goal (the whole change); round-2 from the retry.
    const flow1 = model.edges.find((e) => e.id === "verify-flow:change-ladder#1");
    const flow2 = model.edges.find((e) => e.id === "verify-flow:change-ladder#2");
    expect(flow1?.from).toBe(goalNodeId("change-ladder"));
    expect(flow1?.to).toBe(verifyNodeId("change-ladder", 1));
    expect(flow2?.from).toBe(retryNodeId("change-ladder", 2));
    expect(flow2?.to).toBe(verifyNodeId("change-ladder", 2));
  });

  it("does NOT light the human-escalation flag on any node from a model-escalation retry", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    // The ladder is a different beat; no node's human `escalated` flag is set.
    expect(model.nodes.every((n) => n.escalated === false)).toBe(true);
  });

  it("every emitted verify/retry node passes the backing guard against the snapshot", () => {
    const snapshot = ladderSnapshot();
    const model = buildWorkGraphModel(snapshot);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("rejects a change-level verify node with no recorded round (cannot render unbacked)", () => {
    const snapshot = ladderSnapshot();
    const bogus: GraphNode = {
      id: verifyNodeId("change-ladder", 9),
      kind: "verify",
      label: "verify round 9 (app gate) pass",
      status: "verified",
      verified: true,
      escalated: false,
      backing: { kind: "verify-attempt", changeId: "change-ladder", round: 9, outcome: "pass" },
    };
    expect(() => assertBacked(bogus, snapshot)).toThrow(/no recorded verify attempt/);
  });

  it("rejects a change-level retry node with no recorded round (cannot render unbacked)", () => {
    const snapshot = ladderSnapshot();
    const bogus: GraphNode = {
      id: retryNodeId("change-ladder", 9),
      kind: "retry",
      label: "retry round 9",
      status: "running",
      verified: false,
      escalated: false,
      backing: {
        kind: "retry-attempt",
        changeId: "change-ladder",
        round: 9,
        fromModel: "base-model",
        toModel: "ghost-model",
        implicatedUnits: ["fix"],
        reason: "ghost",
      },
    };
    expect(() => assertBacked(bogus, snapshot)).toThrow(/no recorded model-escalation retry/);
  });

  it("rejects a round-N agent node for a unit the retry did not re-fan (cannot render unbacked)", () => {
    const snapshot = ladderSnapshot();
    const bogus: GraphNode = {
      id: roundAgentNodeId("change-ladder", 2, "ghost"),
      kind: "agent",
      label: "ghost (retry 2)",
      status: "running",
      verified: false,
      escalated: false,
      backing: {
        kind: "round-agent",
        changeId: "change-ladder",
        round: 2,
        unitId: "ghost",
        toModel: "escalation-model",
      },
    };
    // "ghost" is not among the retry's implicated units, so it is unbacked.
    expect(() => assertBacked(bogus, snapshot)).toThrow(/did not re-fan unit ghost/);
  });

  it("emits no verify/retry nodes or model-escalation edge when the state records none", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    expect(model.nodes.some((n) => n.kind === "verify")).toBe(false);
    expect(model.nodes.some((n) => n.kind === "retry")).toBe(false);
    expect(model.edges.some((e) => e.backing.kind === "model-escalation")).toBe(false);
    expect(model.edges.some((e) => e.backing.kind === "re-fan")).toBe(false);
  });

  it("renders the ladder edges within the five-kind vocabulary (no bespoke model-escalation/re-fan edge kinds)", () => {
    const model = buildWorkGraphModel(ladderSnapshot());
    // The rendered edge vocabulary is exactly these five kinds; the escalation
    // hop and the per-unit re-fan ride dependency/data-flow, never a bespoke
    // kind, so the console legend stays the five-kind set.
    const allowed = new Set(["dependency", "data-flow", "spawn", "consumed-tool", "lease"]);
    for (const edge of model.edges) {
      expect(allowed.has(edge.kind)).toBe(true);
    }
    // The escalation hop and the re-fan are still present, just under the shared
    // kinds, with their provenance intact on the backing.
    expect(model.edges.some((e) => e.backing.kind === "model-escalation" && e.kind === "dependency")).toBe(true);
    expect(model.edges.some((e) => e.backing.kind === "re-fan" && e.kind === "data-flow")).toBe(true);
  });
});

/**
 * The goal node reflects the AUTHORITATIVE whole-change verdict (the promoted
 * -artifact gate the ladder records), not the first wave finishing. The two
 * reported bugs were: the goal greened as soon as the first wave finished
 * (BEFORE the gate ran), then flipped back to running/blue after the final
 * failure. The fix derives the goal from the change-level verify attempts.
 */
describe("the goal node reflects the authoritative verify verdict, not the first wave", () => {
  /** A one-unit change whose single unit is already integrated (first wave done). */
  function firstWaveDone(): ChangeStateSnapshot {
    return {
      id: "change-goal",
      objective: "fix the thing",
      completed: ["fix"],
      work: [
        {
          id: "fix",
          objective: "fix",
          dependsOn: [],
          paths: ["src/fix.js"],
          status: "integrated",
          leased: false,
          workspace: workspace("fix"),
        },
      ],
      edges: [],
    };
  }

  it("never greens on the integrated first wave before the gate, then goes terminal red at exhaustion (never flips back to running)", () => {
    // Snapshot A: the first wave is integrated and the gate FAILED round 1, with
    // the round-2 retry recorded and in flight. The goal must be RUNNING here:
    // the old bug greened it the moment the first wave integrated, before the
    // authoritative gate had passed.
    const a = buildWorkGraphModel({
      ...firstWaveDone(),
      verifyAttempts: [{ round: 1, outcome: "fail", model: "base", at: "t1" }],
      retryAttempts: [
        {
          round: 2,
          fromModel: "base",
          toModel: "escalation",
          implicatedUnits: ["fix"],
          reason: "round 1 failed",
          at: "t1b",
        },
      ],
    });
    const goalA = a.nodes.find((n) => n.kind === "goal");
    expect(goalA?.verified).toBe(false);
    expect(goalA?.status).toBe("running");

    // Snapshot B: round 2 also failed and the ladder exhausted. The goal is now a
    // TERMINAL red failure and must NOT flip back to running/blue, which was the
    // second half of the reported bug.
    const b = buildWorkGraphModel({
      ...firstWaveDone(),
      work: firstWaveDone().work.map((u) => ({ ...u, status: "failed" as const })),
      verifyAttempts: [
        { round: 1, outcome: "fail", model: "base", at: "t1" },
        { round: 2, outcome: "fail", model: "escalation", at: "t2" },
      ],
      retryAttempts: [
        {
          round: 2,
          fromModel: "base",
          toModel: "escalation",
          implicatedUnits: ["fix"],
          reason: "round 1 failed",
          at: "t1b",
        },
      ],
    });
    const goalB = b.nodes.find((n) => n.kind === "goal");
    expect(goalB?.verified).toBe(false);
    expect(goalB?.status).toBe("failed");
    expect(goalB?.status).not.toBe("running");
  });

  it("greens ONLY once the authoritative verify round passes", () => {
    const model = buildWorkGraphModel({
      ...firstWaveDone(),
      verifyAttempts: [
        { round: 1, outcome: "pass", model: "base", gateCommand: "npm run gate", at: "t1" },
      ],
    });
    const goal = model.nodes.find((n) => n.kind === "goal");
    expect(goal?.verified).toBe(true);
    expect(goal?.status).toBe("integrated");
  });

  it("goes terminal RED (failed) when the ladder exhausts on a failing round, and never flips back to running", () => {
    // Both rounds failed and the single retry round is already recorded (the
    // ladder exhausted): the goal is a terminal failure, never green, never
    // flipped back to running.
    const model = buildWorkGraphModel({
      ...firstWaveDone(),
      // The failing final gate marked the unit failed, as the real ladder does.
      work: firstWaveDone().work.map((u) => ({ ...u, status: "failed" as const })),
      verifyAttempts: [
        { round: 1, outcome: "fail", model: "base", at: "t1" },
        { round: 2, outcome: "fail", model: "escalation", at: "t2" },
      ],
      retryAttempts: [
        {
          round: 2,
          fromModel: "base",
          toModel: "escalation",
          implicatedUnits: ["fix"],
          reason: "round 1 failed",
          at: "t1b",
        },
      ],
    });
    const goal = model.nodes.find((n) => n.kind === "goal");
    expect(goal?.verified).toBe(false);
    expect(goal?.status).toBe("failed");
  });

  it("stays RUNNING (not terminal) when a round failed but a later retry round is still in flight", () => {
    // Round 1 failed and a round-2 retry is in flight (its verify has not landed
    // yet): the change is still running, not terminally failed, so the goal does
    // not prematurely go red.
    const model = buildWorkGraphModel({
      ...firstWaveDone(),
      verifyAttempts: [{ round: 1, outcome: "fail", model: "base", at: "t1" }],
      retryAttempts: [
        {
          round: 2,
          fromModel: "base",
          toModel: "escalation",
          implicatedUnits: ["fix"],
          reason: "round 1 failed",
          at: "t1b",
        },
      ],
    });
    const goal = model.nodes.find((n) => n.kind === "goal");
    expect(goal?.verified).toBe(false);
    expect(goal?.status).toBe("running");
  });

  it("falls back to every-unit-integrated when the state records NO verify attempts (the offline no-gate path)", () => {
    // The demo / no-gate path records no verify attempts, so the goal keeps its
    // historical every-unit-integrated reading (what the existing demo relies on).
    const allIntegrated = buildWorkGraphModel(firstWaveDone());
    expect(allIntegrated.nodes.find((n) => n.kind === "goal")?.verified).toBe(true);

    const notAllIntegrated = buildWorkGraphModel({
      ...firstWaveDone(),
      completed: [],
      work: firstWaveDone().work.map((u) => ({ ...u, status: "running" as const })),
    });
    expect(notAllIntegrated.nodes.find((n) => n.kind === "goal")?.verified).toBe(false);
  });
});

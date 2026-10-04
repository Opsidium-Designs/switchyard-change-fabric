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
  unitNodeId,
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
  it("maps each WorkUnit to exactly one node plus the single goal node", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    const goal = model.nodes.filter((n) => n.kind === "goal");
    expect(goal).toHaveLength(1);
    expect(goal[0]?.id).toBe(goalNodeId("change-demo"));
    // One node per WorkUnit, no extras, no missing.
    const unitNodes = model.nodes.filter((n) => n.kind !== "goal");
    expect(unitNodes.map((n) => n.id).sort()).toEqual(
      ["base", "left", "right"].map(unitNodeId).sort(),
    );
    // No node is invented beyond the goal and the three real units.
    expect(model.nodes).toHaveLength(4);
  });

  it("renders an agent node (backed by a real repo) only once the state records a workspace", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    const base = model.nodes.find((n) => n.id === unitNodeId("base"));
    const right = model.nodes.find((n) => n.id === unitNodeId("right"));

    // base has a recorded workspace: it is an agent node and reveals the real repo.
    expect(base?.kind).toBe("agent");
    expect(base?.backing.kind).toBe("workspace");
    expect(base?.workspace?.workspaceName).toBe("change-demo--base");
    expect(base?.workspace?.gitUrl).toContain("change-demo--base");

    // right has no workspace yet: it is a plain work node backed by the unit.
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
    // base is complete, so base->left and base->right are data-flow edges.
    const toLeft = model.edges.find((e) => e.id === "base->left");
    const toRight = model.edges.find((e) => e.id === "base->right");
    expect(toLeft?.kind).toBe("data-flow");
    expect(toRight?.kind).toBe("data-flow");
    expect(toLeft?.backing).toEqual({ kind: "dependency", from: "base", to: "left" });

    // With nothing complete, the same declared edges are plain dependency edges.
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

  it("roots every unit to the goal so nothing floats unattached to the Change", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    for (const unitId of ["base", "left", "right"]) {
      const edge = model.edges.find((e) => e.id === `goal->${unitId}`);
      expect(edge).toBeDefined();
      expect(edge?.from).toBe(goalNodeId("change-demo"));
      expect(edge?.to).toBe(unitNodeId(unitId));
    }
  });

  it("carries the real dial from the state into the model", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    expect(model.dial).toEqual({ minConcurrency: 1, maxConcurrency: 3 });
  });

  it("reserves the tool node kind and consumed-tool edge kind for later (never emitted yet)", () => {
    const model = buildWorkGraphModel(layeredSnapshot());
    expect(model.nodes.some((n) => n.kind === "tool")).toBe(false);
    expect(model.edges.some((e) => e.kind === "consumed-tool")).toBe(false);
    // The escalation highlight is reserved too: no node is escalated yet.
    expect(model.nodes.some((n) => n.escalated)).toBe(false);
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
    // Before: right is a plain waiting work node with no repo.
    const before = buildWorkGraphModel(layeredSnapshot());
    expect(before.nodes.find((n) => n.id === unitNodeId("right"))?.kind).toBe("work");

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

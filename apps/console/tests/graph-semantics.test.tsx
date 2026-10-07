/**
 * Offline tests for three graph-semantics fixes, all pure / server-rendered so
 * `make check` stays offline and deterministic (no jsdom, no browser, no
 * network):
 *
 *   1. a re-plan renders as a PLAIN `planner` node (same upward triangle, same
 *      teal fill as the kickoff planner), and its NodeDetail renders the planner
 *      detail panel carrying the round + the revised unit set, exactly like the
 *      kickoff planner;
 *   2. the ladder control-flow rides the `trigger` edge kind, drawn with a
 *      visually distinct stroke, clearly different from the event-driven `spawn`
 *      edge and the `dependency` edge;
 *   3. an early 404 (before the launched run has created the Change) is
 *      classified as PENDING (no error surfaced), while a later 404 and any other
 *      non-ok status is a real error.
 *
 * The markup is produced with react-dom/server (renderToStaticMarkup), matching
 * the other console tests.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GraphView } from "../src/graph-view.tsx";
import { NodeDetail, classifyChangeResponse } from "../src/App.tsx";
import type { GraphNode, WorkGraphModel } from "@switchyard-change/orchestration/graph-model";

/** A round-N re-plan planner node, exactly as the graph model now builds it. */
function replanPlannerNode(): GraphNode {
  return {
    id: "replan:change-ladder#2",
    kind: "planner",
    label: "re-plan round 2: glm-5.3 (1 unit)",
    status: "integrated",
    verified: true,
    escalated: false,
    plannerDetail: {
      source: "planner",
      model: "glm-5.3",
      units: [{ id: "users", objective: "validate users and require auth" }],
      agentCount: 1,
      contracts: [],
    },
    backing: { kind: "planner", changeId: "change-ladder", source: "planner", round: 2 },
  } as GraphNode;
}

/**
 * A tiny model with the goal, a failing verify, a re-plan planner node, and a
 * round-N agent, wired by `trigger` edges (verify -> planner -> agent). Enough to
 * exercise the planner triangle and the trigger edge styling.
 */
function replanModel(): WorkGraphModel {
  const nodes: GraphNode[] = [
    {
      id: "goal:change-ladder",
      kind: "goal",
      label: "the change",
      status: "integrated",
      verified: true,
      escalated: false,
      backing: { kind: "change", changeId: "change-ladder" },
    } as GraphNode,
    {
      id: "verify:change-ladder#1",
      kind: "verify",
      label: "verify round 1 (app gate) fail",
      status: "failed",
      verified: false,
      escalated: false,
      backing: {
        kind: "verify-attempt",
        changeId: "change-ladder",
        round: 1,
        outcome: "fail",
      },
    } as GraphNode,
    replanPlannerNode(),
    {
      id: "round-agent:change-ladder#2:users",
      kind: "agent",
      label: "users (retry 2)",
      status: "integrated",
      verified: true,
      escalated: false,
      backing: {
        kind: "round-agent",
        changeId: "change-ladder",
        round: 2,
        unitId: "users",
        toModel: "glm-5.3",
      },
    } as GraphNode,
  ];
  const edges = [
    {
      id: "replan-trigger:change-ladder#1->2",
      kind: "trigger" as const,
      from: "verify:change-ladder#1",
      to: "replan:change-ladder#2",
      backing: {
        kind: "model-escalation" as const,
        changeId: "change-ladder",
        round: 2,
        fromModel: "base",
        toModel: "glm-5.3",
      },
    },
    {
      id: "replan-refan:change-ladder#2->users",
      kind: "trigger" as const,
      from: "replan:change-ladder#2",
      to: "round-agent:change-ladder#2:users",
      backing: {
        kind: "re-fan" as const,
        changeId: "change-ladder",
        round: 2,
        unitId: "users",
        toModel: "glm-5.3",
      },
    },
  ];
  return { changeId: "change-ladder", nodes, edges };
}

describe("concern 1: a re-plan renders as a plain planner node", () => {
  it("draws the re-plan node as a planner TRIANGLE with the SAME treatment as the kickoff planner (no distinct replan shape/color)", () => {
    // Render a model whose ONLY non-goal node is the re-plan planner, and a model
    // whose only non-goal node is a kickoff planner with the same status/verified.
    // The re-plan planner must render with the SAME shape (an apex-up <polygon>)
    // and the SAME fill as the kickoff planner, since a re-plan is just a plain
    // planner node.
    const kickoff: GraphNode = {
      ...replanPlannerNode(),
      id: "planner:change-ladder",
      label: "planner: glm-5.3",
      backing: { kind: "planner", changeId: "change-ladder", source: "planner" },
    } as GraphNode;
    const goal: GraphNode = {
      id: "goal:change-ladder",
      kind: "goal",
      label: "the change",
      status: "integrated",
      verified: true,
      escalated: false,
      backing: { kind: "change", changeId: "change-ladder" },
    } as GraphNode;
    const render = (planner: GraphNode): string =>
      renderToStaticMarkup(
        createElement(GraphView, {
          model: { changeId: "change-ladder", nodes: [goal, planner], edges: [] },
          selectedId: null,
          onSelect: () => {},
        }),
      );
    const replanMarkup = render(replanPlannerNode());
    const kickoffMarkup = render(kickoff);
    // Both render an apex-up triangle (a <polygon>), the planner shape.
    expect(replanMarkup).toContain("<polygon");
    expect(kickoffMarkup).toContain("<polygon");
    // The planner fill the kickoff uses is the fill the re-plan uses too: pull
    // the kickoff planner's fill color and assert the re-plan node carries it.
    const fillMatch = /<polygon[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(kickoffMarkup);
    expect(fillMatch).not.toBeNull();
    const plannerFill = fillMatch![1]!;
    expect(replanMarkup).toContain(`fill="${plannerFill}"`);
    // The retired teal-violet replan fill is gone entirely (a re-plan is a plain
    // planner node now, not a distinct colored kind).
    expect(replanMarkup).not.toContain("#6f7bd6");
    expect(kickoffMarkup).not.toContain("#6f7bd6");
  });

  it("renders the planner DETAIL panel for a re-plan node, carrying the round and the revised unit set", () => {
    const markup = renderToStaticMarkup(
      createElement(NodeDetail, { node: replanPlannerNode(), onClose: () => {} }),
    );
    // The generic head reads the planner kind for a re-plan.
    expect(markup).toContain("[planner]");
    // The round is visible in the node label.
    expect(markup).toContain("re-plan round 2");
    // The planner detail panel shows the revised unit set it chose to re-fan.
    expect(markup).toContain("Planned units");
    expect(markup).toContain("users");
    expect(markup).toContain("validate users and require auth");
    // The agent count equals the revised unit count.
    expect(markup).toContain("Agents");
    expect(markup).toContain(">1<");
    // The escalation model is shown.
    expect(markup).toContain("glm-5.3");
  });
});

describe("concern 2: the trigger edge kind is drawn distinctly from spawn and dependency", () => {
  it("renders trigger edges with their own group class and a stroke distinct from spawn/dependency", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, {
        model: replanModel(),
        selectedId: null,
        onSelect: () => {},
      }),
    );
    // The trigger edges carry their own edge-group class so they are styleable
    // and visually separable from spawn and dependency.
    expect(markup).toContain("edge-group-trigger");
    // The trigger stroke is the gold control-flow hue, distinct from the violet
    // spawn dash (#d2a8ff) and the grey dependency line (#5a6472).
    expect(markup).toContain("#d9a441");
    expect(markup).not.toContain("#d2a8ff");
  });
});

describe("concern 3: an early launch-time 404 is pending, not an error", () => {
  it("treats a 404 before the change has appeared as PENDING (keep polling, no error)", () => {
    expect(classifyChangeResponse(404, false, false)).toBe("pending");
  });

  it("treats a 404 AFTER the change has appeared as a real error (the launch race is over)", () => {
    expect(classifyChangeResponse(404, false, true)).toBe("error");
  });

  it("treats any other non-ok status as a real error immediately, even before the change appears", () => {
    expect(classifyChangeResponse(500, false, false)).toBe("error");
    expect(classifyChangeResponse(503, false, true)).toBe("error");
  });

  it("treats an ok response as ok (the change has appeared)", () => {
    expect(classifyChangeResponse(200, true, false)).toBe("ok");
    expect(classifyChangeResponse(200, true, true)).toBe("ok");
  });
});

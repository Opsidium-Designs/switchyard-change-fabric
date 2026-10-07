/**
 * Offline test for the PLANNER node detail panel: when the selected node is the
 * planner, the console renders a readable plan detail panel at parity with the
 * agent model detail. It shows the plan source (inference planner vs heuristic
 * fallback), the model, the prompt summary, the rationale (when present), and
 * the PLAN it produced (the planned units with their objectives, the agent
 * count, and the frozen contracts).
 *
 * The markup is produced with react-dom/server (renderToStaticMarkup), exactly
 * like the node-selection test, so `make check` stays offline and deterministic
 * with no jsdom or browser.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NodeDetail } from "../src/App.tsx";
import type { GraphNode } from "@switchyard-change/orchestration/graph-model";

/** A planner node carrying the inspectable plan detail, as the graph model builds it. */
function plannerNode(): GraphNode {
  return {
    id: "planner:change-service",
    kind: "planner",
    label: "planner: gpt-4o-mini",
    status: "integrated",
    verified: true,
    escalated: false,
    plannerDetail: {
      source: "planner",
      model: "gpt-4o-mini",
      promptSummary:
        "Goal: Add input validation\n\nStructural module map: 2 module(s), 2 frozen contract(s).",
      rationale: "one owner per resource keeps the two shared seams frozen",
      units: [
        { id: "users", objective: "validate users and require auth" },
        { id: "orders", objective: "validate orders and require auth" },
      ],
      agentCount: 2,
      contracts: ["src/contracts/auth.js", "src/contracts/response.js"],
    },
    backing: { kind: "planner", changeId: "change-service", source: "planner" },
  } as GraphNode;
}

/** A heuristic-fallback planner node: no model, no prompt summary, no rationale. */
function fallbackPlannerNode(): GraphNode {
  return {
    id: "planner:change-service",
    kind: "planner",
    label: "planner: heuristic fallback",
    status: "integrated",
    verified: true,
    escalated: false,
    plannerDetail: {
      source: "heuristic-fallback",
      model: "",
      units: [
        { id: "users", objective: "validate users" },
        { id: "orders", objective: "validate orders" },
      ],
      agentCount: 2,
      contracts: [],
    },
    backing: { kind: "planner", changeId: "change-service", source: "heuristic-fallback" },
  } as GraphNode;
}

describe("the planner node detail panel", () => {
  it("renders source, model, prompt summary, rationale, units+objectives, agent count and contracts", () => {
    const markup = renderToStaticMarkup(
      createElement(NodeDetail, { node: plannerNode(), onClose: () => {} }),
    );

    // Source names the inference planner (not the heuristic fallback).
    expect(markup).toContain("inference planner");
    // The model id is shown.
    expect(markup).toContain("gpt-4o-mini");
    // The agent count equals the number of planned units.
    expect(markup).toContain("Agents");
    expect(markup).toContain(">2<");
    // The prompt summary (what the planner was asked) is shown.
    expect(markup).toContain("Prompt summary");
    expect(markup).toContain("Structural module map");
    // The model's rationale is shown.
    expect(markup).toContain("Rationale");
    expect(markup).toContain("one owner per resource");
    // The planned units with their objectives are shown.
    expect(markup).toContain("Planned units");
    expect(markup).toContain("users");
    expect(markup).toContain("validate users and require auth");
    expect(markup).toContain("orders");
    // The frozen contracts are shown.
    expect(markup).toContain("Frozen contracts");
    expect(markup).toContain("src/contracts/auth.js");
    expect(markup).toContain("src/contracts/response.js");

    // The agent-only "Model transcript" panel is NOT rendered for the planner
    // node (the planner panel is distinct from the agent/model detail panel).
    expect(markup).not.toContain("Model transcript");
  });

  it("renders source=heuristic fallback with its units and no prompt/rationale when the fallback produced the plan", () => {
    const markup = renderToStaticMarkup(
      createElement(NodeDetail, { node: fallbackPlannerNode(), onClose: () => {} }),
    );

    // The fallback source is shown honestly.
    expect(markup).toContain("heuristic fallback");
    // Its planned units are still shown.
    expect(markup).toContain("Planned units");
    expect(markup).toContain("users");
    expect(markup).toContain("orders");
    // No prompt summary or rationale sections (the fallback carried none).
    expect(markup).not.toContain("Prompt summary");
    expect(markup).not.toContain("Rationale");
    // It froze no contracts.
    expect(markup).toContain("Frozen contracts");
    expect(markup).toContain("The plan froze no read-only contracts");
  });
});

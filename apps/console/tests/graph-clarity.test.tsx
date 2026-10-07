/**
 * Offline tests for the graph clarity batch (no browser, no network):
 *
 *   item 3  the planner NODE shape and the legend SWATCH are the same upward
 *           triangle (the rendered node is an apex-up polygon; the legend uses an
 *           apex-up clip-path triangle, both teal), so legend and graph agree;
 *   item 4  SPACING: no two placed nodes overlap for a dense
 *           planner+verify+retry+round-N graph (a coordinate min-distance check);
 *   item 5  SHORTER labels: an agent/round-N label is shortened to the module
 *           tail (keeping any "(retry N)" suffix), with the full id preserved;
 *   item 6  a failed round-N agent in a PASSING change is rendered without
 *           implying the change failed (a muted tone + a clarity note), while the
 *           change still reads as passed.
 *
 * The markup is produced with react-dom/server (renderToStaticMarkup) and the
 * layout/label helpers are pure functions, so no jsdom or browser is needed and
 * `make check` stays offline and deterministic.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GraphView,
  changeHasPassed,
  isNonBlockingRoundFail,
  shortNodeLabel,
} from "../src/graph-view.tsx";
import { NodeDetail } from "../src/App.tsx";
import type { GraphNode, WorkGraphModel } from "@switchyard-change/orchestration/graph-model";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A dense model exercising every ladder kind: goal, a planner, two agents, a
 * verify (passed), a retry, and two round-N agents (one failed). It is enough to
 * stress the layout spacing and the clarity treatments.
 */
function denseModel(): WorkGraphModel {
  const node = (
    id: string,
    kind: GraphNode["kind"],
    label: string,
    extra: Partial<GraphNode>,
  ): GraphNode =>
    ({
      id,
      kind,
      label,
      status: "integrated",
      verified: false,
      escalated: false,
      backing: { kind: "change", changeId: "c" },
      ...extra,
    }) as GraphNode;

  const nodes: GraphNode[] = [
    node("goal:c", "goal", "the change", { status: "integrated", verified: true }),
    node("planner:c", "planner", "planner", { verified: false }),
    node("unit:validate-src-resources-users", "agent", "validate-src-resources-users", {
      status: "integrated",
      verified: true,
      backing: { kind: "round-agent", changeId: "c", round: 1, unitId: "users", toModel: "m" },
    }),
    node(
      "unit:validate-src-resources-notifications",
      "agent",
      "validate-src-resources-notifications",
      { status: "integrated", verified: true },
    ),
    node("verify:c#1", "verify", "verify round 1 (app gate) pass", {
      status: "verified",
      verified: true,
      backing: { kind: "verify-attempt", changeId: "c", round: 1, outcome: "pass" },
    }),
    node("retry:c#2", "retry", "retry round 2: m2 (1 unit)", {
      status: "running",
      backing: {
        kind: "retry-attempt",
        changeId: "c",
        round: 2,
        fromModel: "m",
        toModel: "m2",
        implicatedUnits: ["notifications"],
        reason: "re-planned",
      },
    }),
    // A round-N agent that FAILED its own attempt while the change still passed.
    node(
      "round:c#2:validate-src-resources-notifications",
      "agent",
      "validate-src-resources-notifications (retry 2)",
      {
        status: "failed",
        verified: false,
        backing: {
          kind: "round-agent",
          changeId: "c",
          round: 2,
          unitId: "validate-src-resources-notifications",
          toModel: "m2",
        },
      },
    ),
    node("round:c#2:validate-src-resources-users", "agent", "validate-src-resources-users (retry 2)", {
      status: "integrated",
      verified: true,
      backing: {
        kind: "round-agent",
        changeId: "c",
        round: 2,
        unitId: "validate-src-resources-users",
        toModel: "m2",
      },
    }),
  ];

  const edge = (from: string, to: string): WorkGraphModel["edges"][number] =>
    ({
      id: `${from}->${to}`,
      kind: "dependency",
      from,
      to,
      backing: { kind: "dependency", from, to },
    }) as WorkGraphModel["edges"][number];

  const edges = [
    edge("goal:c", "planner:c"),
    edge("planner:c", "unit:validate-src-resources-users"),
    edge("planner:c", "unit:validate-src-resources-notifications"),
    edge("goal:c", "verify:c#1"),
    edge("verify:c#1", "retry:c#2"),
    edge("retry:c#2", "round:c#2:validate-src-resources-notifications"),
    edge("retry:c#2", "round:c#2:validate-src-resources-users"),
  ];

  return { nodes, edges, dial: { minConcurrency: 1, maxConcurrency: 3 } } as unknown as WorkGraphModel;
}

describe("item 3: the planner node shape matches the legend swatch (both upward triangles)", () => {
  it("renders the planner node as an apex-up triangle polygon in teal", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: denseModel(), selectedId: null, onSelect: () => {} }),
    );
    // The planner node is a <polygon> (a triangle), filled teal, never a circle.
    expect(markup).toContain("#2bb3a3");
    expect(markup).toContain("<polygon");
    // The planner triangle is apex-UP: its three points start at the top vertex
    // (a negative y above the origin) with a flat base below (two positive y).
    // trianglePoints(24) => "0.00,-24.00 20.78,12.00 -20.78,12.00".
    expect(markup).toContain("0.00,-24.00");
    expect(markup).toContain("20.78,12.00");
    expect(markup).toContain("-20.78,12.00");
  });

  it("draws the legend planner swatch as an apex-up clip-path triangle in the same teal", async () => {
    const css = await readFile(join(here, "..", "src", "styles.css"), "utf8");
    const normalized = css.replace(/\s+/g, " ");
    // The legend triangle is a clip-path triangle (not a border triangle), apex
    // at top-center with a flat base at the bottom, matching the SVG node shape.
    expect(normalized).toMatch(/\.swatch-triangle[^{]*\{[^}]*clip-path: polygon\(50% 0%, 100% 100%, 0% 100%\)/);
    // The same teal fill as the node (so legend and node agree on shape + color).
    expect(normalized).toMatch(/\.swatch-triangle[^{]*\{[^}]*background: #2bb3a3/);
    // The old border-triangle shape is gone (it was a different proportion).
    expect(normalized).not.toMatch(/\.swatch-triangle[^{]*\{[^}]*border-bottom: 0\.8rem solid/);
  });
});

describe("item 4: spacing: no two placed nodes overlap in a dense planner+verify+retry+round-N graph", () => {
  it("keeps every pair of node centers at least a node-diameter apart", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: denseModel(), selectedId: null, onSelect: () => {} }),
    );
    // Pull every node translate(x, y) from the rendered markup.
    const coords: { x: number; y: number }[] = [];
    const re = /translate\(([-\d.]+), ([-\d.]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markup)) !== null) {
      coords.push({ x: Number(m[1]), y: Number(m[2]) });
    }
    expect(coords.length).toBeGreaterThanOrEqual(8);
    // No two node centers are closer than a node diameter (2 * NODE_RADIUS = 48),
    // so the circles/polygons never overlap. The deterministic layout makes this
    // reproducible run to run.
    const MIN_CENTER_DISTANCE = 48;
    for (let i = 0; i < coords.length; i += 1) {
      for (let j = i + 1; j < coords.length; j += 1) {
        const dx = coords[i]!.x - coords[j]!.x;
        const dy = coords[i]!.y - coords[j]!.y;
        const dist = Math.hypot(dx, dy);
        expect(dist).toBeGreaterThanOrEqual(MIN_CENTER_DISTANCE);
      }
    }
  });

  it("grows the SVG viewBox with content so nothing is clipped", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: denseModel(), selectedId: null, onSelect: () => {} }),
    );
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(markup);
    expect(vb).not.toBeNull();
    // The viewBox width and height are both ample for the dense graph (the width
    // scales with the widest layer, the height with the layer count).
    expect(Number(vb?.[1])).toBeGreaterThanOrEqual(400);
    expect(Number(vb?.[2])).toBeGreaterThanOrEqual(400);
  });
});

describe("item 5: shorter labels (module tail), full id preserved", () => {
  it("derives the module tail from a full unit id, keeping any (retry N) suffix", () => {
    expect(shortNodeLabel("validate-src-resources-notifications")).toBe("notifications");
    expect(shortNodeLabel("validate-src-resources-notifications (retry 2)")).toBe(
      "notifications (retry 2)",
    );
    expect(shortNodeLabel("users")).toBe("users");
    // A slash-separated path id also reduces to its tail.
    expect(shortNodeLabel("src/resources/orders (retry 1)")).toBe("orders (retry 1)");
  });

  it("renders the short label on an agent node but keeps the FULL id in the title tooltip", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: denseModel(), selectedId: null, onSelect: () => {} }),
    );
    // The visible label text is the shortened module tail.
    expect(markup).toContain(">notifications (retry 2)<");
    // The full unit id is preserved in the SVG <title> tooltip.
    expect(markup).toContain("validate-src-resources-notifications (retry 2)");
  });
});

describe("item 6: a failed round-N agent in a passing change does not imply the change failed", () => {
  it("renders the non-blocking round fail in a muted tone (not the terminal dead-red) and notes the pass", () => {
    const model = denseModel();
    // The change passed (a verify node is verified).
    expect(changeHasPassed(model)).toBe(true);
    const roundFail = model.nodes.find(
      (n) => n.id === "round:c#2:validate-src-resources-notifications",
    )!;
    expect(roundFail.status).toBe("failed");
    expect(isNonBlockingRoundFail(roundFail, true)).toBe(true);

    const markup = renderToStaticMarkup(
      createElement(GraphView, { model, selectedId: null, onSelect: () => {} }),
    );
    // The muted slate tone is used, and the terminal dead-red (#8b2c22) is NOT
    // applied to this per-attempt failure.
    expect(markup).toContain("#495366");
    // The tooltip makes clear the failure did not block the change.
    expect(markup).toContain("per-attempt retry failure; the change still passed");
  });

  it("the detail panel notes a per-attempt retry failure that did not block a passing change", () => {
    const model = denseModel();
    const roundFail = model.nodes.find(
      (n) => n.id === "round:c#2:validate-src-resources-notifications",
    )!;
    const markup = renderToStaticMarkup(
      createElement(NodeDetail, {
        node: roundFail,
        changePassed: true,
        onClose: () => {},
      }),
    );
    expect(markup).toContain("per-attempt retry failure that did not block");
  });
});

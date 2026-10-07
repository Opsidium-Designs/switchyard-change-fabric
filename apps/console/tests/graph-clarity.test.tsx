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

describe("item 4b: tighter agent spacing (seam 5): a wide agent fan is closer together, still non-overlapping and non-collinear", () => {
  /** A goal with a single wide row of six agent nodes (the service-api fan). */
  function wideFanModel(): WorkGraphModel {
    const node = (id: string, kind: GraphNode["kind"], label: string): GraphNode =>
      ({
        id,
        kind,
        label,
        status: "integrated",
        verified: true,
        escalated: false,
        backing: { kind: "change", changeId: "c" },
      }) as GraphNode;
    const names = ["users", "orders", "products", "auth", "search", "notifications"];
    const nodes: GraphNode[] = [node("goal:c", "goal", "the change")];
    for (const n of names) {
      nodes.push(node(`unit:${n}`, "agent", n));
    }
    const edges = names.map(
      (n) =>
        ({
          id: `goal:c->unit:${n}`,
          kind: "dependency",
          from: "goal:c",
          to: `unit:${n}`,
          backing: { kind: "dependency", from: "goal:c", to: `unit:${n}` },
        }) as WorkGraphModel["edges"][number],
    );
    return { nodes, edges, dial: { minConcurrency: 1, maxConcurrency: 6 } } as unknown as WorkGraphModel;
  }

  function coordsOf(markup: string): { x: number; y: number }[] {
    const coords: { x: number; y: number }[] = [];
    const re = /translate\(([-\d.]+), ([-\d.]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markup)) !== null) {
      coords.push({ x: Number(m[1]), y: Number(m[2]) });
    }
    return coords;
  }

  it("packs a 6-agent row tighter than the pre-tightening baseline (old MIN_NODE_GAP=200)", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: wideFanModel(), selectedId: null, onSelect: () => {} }),
    );
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(markup);
    expect(vb).not.toBeNull();
    const width = Number(vb?.[1]);
    // The OLD layout gave width = max(1100, (6+1)*200) = 1400 for this fan. The
    // tightened layout gives max(760, (6+1)*130) = 910, so the row is visibly
    // closer together. Assert it is well under the old 1400 baseline.
    expect(width).toBeLessThan(1200);
    // The agent centers are also closer than the old per-node gap of ~200: the
    // mean gap between adjacent agent x's is around the new MIN_NODE_GAP (130).
    const coords = coordsOf(markup).sort((a, b) => a.x - b.x);
    // Drop the goal (centered); compare the six agent x's.
    const xs = coords.map((c) => c.x);
    const gaps: number[] = [];
    for (let i = 1; i < xs.length; i += 1) {
      gaps.push(xs[i]! - xs[i - 1]!);
    }
    const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(meanGap).toBeLessThan(200);
  });

  it("keeps the tightened row non-overlapping (>= a node diameter apart) and non-collinear (jitter preserved)", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: wideFanModel(), selectedId: null, onSelect: () => {} }),
    );
    const coords = coordsOf(markup);
    expect(coords.length).toBeGreaterThanOrEqual(7);
    // No two centers closer than a node diameter (2 * NODE_RADIUS = 48).
    for (let i = 0; i < coords.length; i += 1) {
      for (let j = i + 1; j < coords.length; j += 1) {
        const dx = coords[i]!.x - coords[j]!.x;
        const dy = coords[i]!.y - coords[j]!.y;
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(48);
      }
    }
    // The agent row is NOT collinear: the deterministic stagger/jitter is kept,
    // so the six agents (all in one layer) do not share a single y. Prove at
    // least two distinct y values among the agents.
    const agentYs = coords
      .filter((c) => c.y > 200) // below the goal row
      .map((c) => Math.round(c.y));
    const distinct = new Set(agentYs);
    expect(distinct.size).toBeGreaterThan(1);
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

describe("verify/retry detail panel surfaces the gate output, implicated units, and re-fan source", () => {
  it("a FAILING verify node shows its gate output, the units it re-fanned, and the re-fan source", () => {
    const verifyFail: GraphNode = {
      id: "verify:c#1",
      kind: "verify",
      label: "verify round 1 (app gate) fail",
      status: "failed",
      verified: false,
      escalated: false,
      backing: {
        kind: "verify-attempt",
        changeId: "c",
        round: 1,
        outcome: "fail",
        gateCommand: "node gate/run.mjs",
        failingOutput: "✖ auth: unauthenticated request is rejected (401/403)",
        implicatedUnits: ["auth"],
        refanSource: "parse",
      },
    } as GraphNode;
    const markup = renderToStaticMarkup(
      createElement(NodeDetail, { node: verifyFail, changePassed: false, onClose: () => {} }),
    );
    // The failing gate output is shown.
    expect(markup).toContain("Failing gate output");
    expect(markup).toContain("✖ auth:");
    // The re-fanned units and the re-fan source are both surfaced.
    expect(markup).toContain("Re-fanned units (1)");
    expect(markup).toContain(">auth<");
    expect(markup).toContain("gate-output parse");
  });

  it("a RETRY node shows the re-fan source (how the implicated units were chosen)", () => {
    const retry: GraphNode = {
      id: "retry:c#2",
      kind: "retry",
      label: "retry round 2: m2 (1 unit)",
      status: "running",
      verified: false,
      escalated: false,
      backing: {
        kind: "retry-attempt",
        changeId: "c",
        round: 2,
        fromModel: "m",
        toModel: "m2",
        implicatedUnits: ["auth"],
        reason: "re-planned to 1 unit(s)",
        refanSource: "re-plan",
      },
    } as GraphNode;
    const markup = renderToStaticMarkup(
      createElement(NodeDetail, { node: retry, changePassed: false, onClose: () => {} }),
    );
    expect(markup).toContain("Re-fan source");
    expect(markup).toContain("re-plan");
    expect(markup).toContain(">auth<");
  });
});

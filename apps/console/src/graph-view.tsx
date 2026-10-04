import { useMemo } from "react";

import type {
  GraphEdge,
  GraphNode,
  WorkGraphModel,
} from "@switchyard-change/orchestration/graph-model";
import { goalNodeId } from "@switchyard-change/orchestration/graph-model";

/**
 * GraphView: the morphing SVG rendering of the living work graph.
 *
 * It renders exactly the nodes and edges of the WorkGraphModel it is handed,
 * which is a pure projection of the live ChangeState (see graph-model). It does
 * NOT animate a script: every node and edge on screen corresponds to a real
 * state element, and the view re-derives from each fresh snapshot, so the
 * morphing a watcher sees (nodes appearing, greening, fading) is the state
 * changing underneath, not a timeline.
 *
 * Layout is deterministic and hand-rolled (no graph library, no new
 * dependency): the goal sits at the top center, and the WorkUnits are placed in
 * dependency layers (a node's layer is its longest dependency depth), spread
 * evenly across each layer's row. The same snapshot always lays out the same
 * way, so a node does not jump around between polls; a newly appearing node
 * fades in where its layer puts it.
 */

const WIDTH = 960;
const LAYER_HEIGHT = 170;
const TOP_MARGIN = 80;
const NODE_RADIUS = 24;
const GOAL_RADIUS = 32;
/** Vertical gap between a node's circle edge and its label row (outside it). */
const LABEL_GAP = 10;

interface Placed {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
}

/** Compute each unit node's dependency layer (its longest path from a root). */
function computeLayers(model: WorkGraphModel): Map<string, number> {
  const deps = new Map<string, string[]>();
  // Build the per-unit dependency list from the declared dependency/data-flow
  // edges between unit nodes (ignore the goal-rooting edges and spawn edges).
  for (const node of model.nodes) {
    if (node.kind !== "goal") {
      deps.set(node.id, []);
    }
  }
  for (const edge of model.edges) {
    if (edge.from === goalNodeId(model.changeId)) {
      continue;
    }
    if (edge.kind === "dependency" || edge.kind === "data-flow") {
      const list = deps.get(edge.to);
      if (list) {
        list.push(edge.from);
      }
    }
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(id)) {
      return 0; // defensive against an unexpected cycle; the DAG should have none
    }
    visiting.add(id);
    const parents = deps.get(id) ?? [];
    const depth = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(depthOf));
    visiting.delete(id);
    layer.set(id, depth);
    return depth;
  };
  for (const id of deps.keys()) {
    depthOf(id);
  }
  return layer;
}

/** Place the goal and every unit node at a deterministic coordinate. */
function placeNodes(model: WorkGraphModel): { placed: Placed[]; height: number } {
  const layers = computeLayers(model);
  const unitNodes = model.nodes.filter((n) => n.kind !== "goal");
  // Group unit nodes by layer (layer 0 is the first row beneath the goal).
  const byLayer = new Map<number, GraphNode[]>();
  for (const node of unitNodes) {
    const l = layers.get(node.id) ?? 0;
    const row = byLayer.get(l) ?? [];
    row.push(node);
    byLayer.set(l, row);
  }
  const placed: Placed[] = [];
  const goal = model.nodes.find((n) => n.kind === "goal");
  if (goal) {
    placed.push({ node: goal, x: WIDTH / 2, y: TOP_MARGIN });
  }
  const maxLayer = byLayer.size === 0 ? 0 : Math.max(...byLayer.keys());
  for (const [l, row] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    // Sort each row by id for a stable left-to-right order between polls.
    const sorted = [...row].sort((a, b) => a.id.localeCompare(b.id));
    const y = TOP_MARGIN + (l + 1) * LAYER_HEIGHT;
    const n = sorted.length;
    sorted.forEach((node, i) => {
      const x = n === 1 ? WIDTH / 2 : ((i + 1) * WIDTH) / (n + 1);
      placed.push({ node, x, y });
    });
  }
  const height = TOP_MARGIN + (maxLayer + 2) * LAYER_HEIGHT;
  return { placed, height };
}

/** The stroke style per edge kind. */
function edgeStyle(kind: GraphEdge["kind"]): { stroke: string; dash?: string } {
  switch (kind) {
    case "data-flow":
      return { stroke: "#3fb950" }; // data has flowed from a completed prerequisite
    case "spawn":
      return { stroke: "#d2a8ff", dash: "2 5" }; // event-driven recruitment
    case "consumed-tool":
      return { stroke: "#f0883e", dash: "6 4" }; // a downstream agent ran the tool
    case "lease":
      return { stroke: "#db6d28", dash: "1 4" }; // waiter waits for the lease owner
    case "dependency":
    default:
      return { stroke: "#5a6472" };
  }
}

/**
 * The four points of a diamond (a square rotated 45deg) whose half-diagonal is
 * `r`, centered at the node origin. Used for the tool node so it reads as a
 * distinct tool/output artifact rather than another agent circle, while keeping
 * the same visual footprint as a circle of radius `r`.
 */
function diamondPoints(r: number): string {
  return `0,${-r} ${r},0 0,${r} ${-r},0`;
}

/** The fill color for a node from its kind and verified/escalated/failed state. */
function nodeFill(node: GraphNode): string {
  if (node.escalated) {
    return "#f85149"; // a pending human escalation lights this node (the human beat)
  }
  if (node.status === "failed") {
    // A failed unit is a distinct terminal state: a dark, muted red, clearly not
    // the healthy green of a verified node and not the blue of a running one, so
    // a watcher sees a dead unit at a glance rather than a stuck-green or
    // perpetually-running node.
    return "#8b2c22";
  }
  if (node.kind === "tool") {
    return "#9e6a03"; // agent-built tool, published to its own repo
  }
  if (node.verified) {
    return "#238636"; // greened: evidence landed (verified/integrated)
  }
  switch (node.kind) {
    case "goal":
      return "#1f6feb";
    case "agent":
      return node.status === "running" ? "#388bfd" : "#30497a";
    case "work":
    default:
      return node.status === "running" ? "#388bfd" : "#21262d";
  }
}

interface GraphViewProps {
  readonly model: WorkGraphModel;
  readonly selectedId: string | null;
  readonly onSelect: (nodeId: string) => void;
}

export function GraphView({ model, selectedId, onSelect }: GraphViewProps) {
  const { placed, height } = useMemo(() => placeNodes(model), [model]);
  const byId = useMemo(() => {
    const map = new Map<string, Placed>();
    for (const p of placed) {
      map.set(p.node.id, p);
    }
    return map;
  }, [placed]);

  return (
    <svg
      className="graph-svg"
      viewBox={`0 0 ${WIDTH} ${height}`}
      role="img"
      aria-label="Living work graph"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#5a6472" />
        </marker>
      </defs>

      {/* Edges first, so nodes draw on top. */}
      <g className="edges">
        {model.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) {
            return null;
          }
          const style = edgeStyle(edge.kind);
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={style.stroke}
              strokeWidth={edge.kind === "data-flow" ? 2.5 : 1.5}
              strokeDasharray={style.dash}
              markerEnd="url(#arrow)"
              className={`edge edge-${edge.kind}`}
            >
              <title>{`${edge.kind}: ${edge.from} to ${edge.to}`}</title>
            </line>
          );
        })}
      </g>

      {/* Nodes. Each is keyed by its stable id so React fades it in/out as the
          state gains or loses it, rather than redrawing the whole set. */}
      <g className="nodes">
        {placed.map(({ node, x, y }) => {
          const r = node.kind === "goal" ? GOAL_RADIUS : NODE_RADIUS;
          const selected = node.id === selectedId;
          return (
            <g
              key={node.id}
              className={`node node-${node.kind} ${node.verified ? "is-verified" : ""} ${
                node.escalated ? "is-escalated" : ""
              } ${node.status === "failed" ? "is-failed" : ""} ${selected ? "is-selected" : ""}`}
              transform={`translate(${x}, ${y})`}
              tabIndex={0}
              role="button"
              aria-label={`${node.kind} ${node.label} (${node.status})`}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              {/* The tool node is a DISTINCT shape (a diamond), so an
                  agent-built tool published to its own repo reads as a tool/
                  output artifact at a glance, not another agent circle. Every
                  other node stays a circle. The diamond's half-diagonal matches
                  the circle radius so it occupies the same visual footprint and
                  the deterministic layout is unchanged. */}
              {node.kind === "tool" ? (
                <polygon
                  points={diamondPoints(r)}
                  fill={nodeFill(node)}
                  stroke={selected ? "#e6edf3" : "#0d1117"}
                  strokeWidth={selected ? 3 : 1.5}
                />
              ) : (
                <circle
                  r={r}
                  fill={nodeFill(node)}
                  stroke={selected ? "#e6edf3" : "#0d1117"}
                  strokeWidth={selected ? 3 : 1.5}
                />
              )}
              {/* Labels sit OUTSIDE the node, below it, so they are legible and
                  never crammed inside the small node. The full label is shown
                  (not truncated into the node); the kind is a smaller caption
                  line beneath it. */}
              <text
                className="node-label"
                textAnchor="middle"
                y={r + LABEL_GAP + 11}
              >
                {node.label}
              </text>
              <text
                className="node-kind"
                textAnchor="middle"
                y={r + LABEL_GAP + 24}
              >
                {node.kind}
              </text>
              <title>{`${node.label} [${node.kind}] status=${node.status}`}</title>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

import { useCallback, useMemo, useRef, useState } from "react";

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
    // The ladder reads top to bottom: a verify node hangs below its unit (fed by
    // a data-flow edge), and a retry node hangs below the failing verify it
    // escalated from (the model-escalation edge). Following the escalation edge
    // for layering keeps the chain unit -> verify#1 -> retry#2 -> verify#2
    // ordered down the rows instead of letting the retry float to the top row.
    if (
      edge.kind === "dependency" ||
      edge.kind === "data-flow" ||
      edge.kind === "model-escalation"
    ) {
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
      // A real tool run: a bright AMBER edge, drawn solid (no dash), so it reads
      // as a distinct tool-consumption and is never confused with the lease
      // edge. A consumed-tool edge only ever appears next to a diamond tool node.
      return { stroke: "#f0883e" };
    case "lease":
      // Owner-coordination (a waiter waiting for the single write lease): a TEAL
      // dotted edge, a clearly different hue and pattern from the amber tool
      // edge, so the two are visually unmistakable even at render scale.
      return { stroke: "#2dd4bf", dash: "1 5" };
    case "model-escalation":
      // The bounded model-escalation beat: a verify-fail handed the next attempt
      // to a stronger model. Drawn as a bright MAGENTA long-dashed edge, a hue
      // and pattern distinct from BOTH the lease teal dotted edge AND the human
      // escalation red/amber highlight, so the smarter-model hop reads as its own
      // beat and is never confused with human escalation or lease coordination.
      return { stroke: "#db61a2", dash: "7 4" };
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
  // A verify node is a mechanical gate run: GREEN on a real pass, a bright RED on
  // a real fail. This is the ladder's pass/fail beat and is checked before the
  // generic failed-unit case so a failing gate run reads as a vivid red verdict
  // (not the muted dead-unit red), and before the kind switch so a verify node is
  // never drawn as a generic running node.
  if (node.kind === "verify") {
    return node.verified ? "#238636" : "#da3633";
  }
  // A retry node is the smarter-model re-attempt beat: a MAGENTA fill matching
  // the model-escalation edge that reaches it, so the escalation hop (edge) and
  // the escalated attempt (node) read as one beat, visibly distinct from both a
  // normal running agent (blue) and the human-escalation red.
  if (node.kind === "retry") {
    return "#a371f7";
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

/** The pan/zoom view transform: a scale `k` and a translation in SVG units. */
interface ViewTransform {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

const IDENTITY_VIEW: ViewTransform = { k: 1, tx: 0, ty: 0 };
const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
/** Pixels of mouse movement before a press is treated as a drag, not a click. */
const DRAG_THRESHOLD = 4;

/** Clamp a zoom scale into the allowed range. */
function clampScale(k: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, k));
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

  const svgRef = useRef<SVGSVGElement | null>(null);
  // The view transform (pan/zoom) is a pure VIEW concern layered over the
  // deterministic layout: the node coordinates are unchanged, only the wrapping
  // <g> is translated and scaled. Resetting restores the identity view.
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
  // Pan drag bookkeeping. `moved` lets a press be told apart from a drag so a
  // click still selects a node but a drag only pans and does not select.
  const drag = useRef<{
    startX: number;
    startY: number;
    originTx: number;
    originTy: number;
    moved: boolean;
  } | null>(null);

  /**
   * Convert a mouse event's client position to a coordinate in the SVG's own
   * viewBox space, so wheel-zoom can keep the point under the cursor fixed. It
   * maps through the element rect to the fixed viewBox (WIDTH x height), which
   * is the untransformed space the view <g> sits in.
   */
  const clientToSvg = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const svg = svgRef.current;
      if (!svg) {
        return { x: 0, y: 0 };
      }
      const rect = svg.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * WIDTH;
      const y = ((clientY - rect.top) / rect.height) * height;
      return { x, y };
    },
    [height],
  );

  // Wheel to zoom, centered on the cursor: solve for the translation that keeps
  // the SVG-space point under the pointer fixed as the scale changes.
  const onWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      // Zoom is gated behind the ctrl (or cmd) key: a plain wheel scrolls the
      // page as normal, and ctrl/cmd + wheel zooms the graph. Without the
      // modifier we do not preventDefault, so page scrolling is never hijacked.
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const { x, y } = clientToSvg(event.clientX, event.clientY);
      setView((prev) => {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const k = clampScale(prev.k * factor);
        if (k === prev.k) {
          return prev;
        }
        // Keep (x,y) fixed: x = tx + k * sx  =>  sx = (x - tx)/k ; after zoom,
        // tx' = x - k' * sx.
        const sx = (x - prev.tx) / prev.k;
        const sy = (y - prev.ty) / prev.k;
        return { k, tx: x - k * sx, ty: y - k * sy };
      });
    },
    [clientToSvg],
  );

  // Begin a potential pan on left-button press anywhere in the SVG background.
  const onMouseDown = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (event.button !== 0) {
        return;
      }
      drag.current = {
        startX: event.clientX,
        startY: event.clientY,
        originTx: view.tx,
        originTy: view.ty,
        moved: false,
      };
    },
    [view.tx, view.ty],
  );

  const onMouseMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const d = drag.current;
      if (!d) {
        return;
      }
      const dxClient = event.clientX - d.startX;
      const dyClient = event.clientY - d.startY;
      if (!d.moved && Math.hypot(dxClient, dyClient) < DRAG_THRESHOLD) {
        return; // below the threshold: still a click candidate, not a pan yet
      }
      d.moved = true;
      const svg = svgRef.current;
      const rect = svg?.getBoundingClientRect();
      // Scale the client-pixel delta into SVG-space so panning tracks the cursor
      // one-to-one regardless of how the SVG is sized in the layout.
      const scaleX = rect ? WIDTH / rect.width : 1;
      const scaleY = rect ? height / rect.height : 1;
      setView((prev) => ({
        ...prev,
        tx: d.originTx + dxClient * scaleX,
        ty: d.originTy + dyClient * scaleY,
      }));
    },
    [height],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  // A node click selects it only when the press did not become a drag, so
  // dragging to pan over a node never accidentally selects it.
  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (drag.current?.moved) {
        return;
      }
      onSelect(nodeId);
    },
    [onSelect],
  );

  const resetView = useCallback(() => setView(IDENTITY_VIEW), []);
  const transformed = view.k !== 1 || view.tx !== 0 || view.ty !== 0;

  return (
    <div className="graph-stage">
      {/* A small, always-present view control: reset returns to the identity
          view (the deterministic layout at 1:1). It only enables once the view
          has been panned or zoomed. */}
      <div className="graph-controls">
        <button
          type="button"
          className="graph-reset"
          onClick={resetView}
          disabled={!transformed}
          title="Reset the pan/zoom view to fit"
        >
          Reset view
        </button>
        <span className="graph-hint muted">ctrl + scroll to zoom, drag to pan</span>
      </div>
      <svg
        ref={svgRef}
        className={`graph-svg${drag.current ? " is-panning" : ""}`}
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label="Living work graph"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
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

        {/* The view transform wraps BOTH edges and nodes, so pan/zoom moves the
            whole graph as one. The layout coordinates inside are untouched: this
            is purely a view transform (translate + scale), so determinism and
            every node's placement are unchanged. */}
        <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.k})`}>
          {/* Edges first, so nodes draw on top. */}
          <g className="edges">
            {model.edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) {
                return null;
              }
              const style = edgeStyle(edge.kind);
              // The model-escalation edge carries the real model ids from its
              // backing: the base model that failed and the stronger model the
              // ladder escalated to. Render that hop as a label on the edge
              // ("base -> escalation") so a watcher sees WHICH model took over,
              // read straight from state, never synthesized.
              const escalationLabel =
                edge.kind === "model-escalation" && edge.backing.kind === "model-escalation"
                  ? `${edge.backing.fromModel || "base"} -> ${edge.backing.toModel || "escalation"}`
                  : null;
              const midX = (from.x + to.x) / 2;
              const midY = (from.y + to.y) / 2;
              return (
                <g key={edge.id} className={`edge-group edge-group-${edge.kind}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={style.stroke}
                    strokeWidth={
                      edge.kind === "data-flow"
                        ? 2.5
                        : edge.kind === "model-escalation"
                          ? 2.5
                          : 1.5
                    }
                    strokeDasharray={style.dash}
                    markerEnd="url(#arrow)"
                    className={`edge edge-${edge.kind}`}
                  >
                    <title>
                      {escalationLabel
                        ? `model-escalation: ${escalationLabel} (${edge.from} to ${edge.to})`
                        : `${edge.kind}: ${edge.from} to ${edge.to}`}
                    </title>
                  </line>
                  {escalationLabel ? (
                    <text
                      className="edge-escalation-label"
                      x={midX}
                      y={midY - 4}
                      textAnchor="middle"
                    >
                      {escalationLabel}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* Nodes. Each is keyed by its stable id so React fades it in/out as
              the state gains or loses it, rather than redrawing the whole set. */}
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
                  onClick={() => handleNodeClick(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(node.id);
                    }
                  }}
                >
                  {/* The tool node is a DISTINCT shape (a diamond), so an
                      agent-built tool published to its own repo reads as a tool/
                      output artifact at a glance, not another agent circle.
                      Every other node stays a circle. The diamond's
                      half-diagonal matches the circle radius so it occupies the
                      same visual footprint and the deterministic layout is
                      unchanged. */}
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
                  {/* Labels sit OUTSIDE the node, below it, so they are legible
                      and never crammed inside the small node. The full label is
                      shown (not truncated into the node); the kind is a smaller
                      caption line beneath it. */}
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
        </g>
      </svg>
    </div>
  );
}

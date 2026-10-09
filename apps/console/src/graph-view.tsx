import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  IDENTITY_VIEW,
  shouldZoomOnWheel,
  zoomAt,
  type ViewTransform,
} from "./graph-interactions";

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

const WIDTH = 760;
const LAYER_HEIGHT = 280;
const TOP_MARGIN = 80;
const NODE_RADIUS = 24;
const GOAL_RADIUS = 32;
/** Vertical gap between a node's circle edge and its label row (outside it). */
const LABEL_GAP = 10;
/**
 * Minimum horizontal gap between adjacent node centers in a dense row. Tightened
 * from the earlier 200 so a wide agent fan reads as a cohesive wave rather than
 * a sparse spread, while staying comfortably above the no-overlap floor: with
 * the per-node X jitter (X_JITTER below) the closest two centers can get is
 * MIN_NODE_GAP - 2*X_JITTER, which must stay >= 2*NODE_RADIUS (a node diameter),
 * so 150 - 44 = 106 >= 48 holds. Widened from 130 so adjacent labels (an agent
 * beside a jev decision) do not run into each other. The positional variance (jitter/stagger) is
 * deliberately kept unchanged, so the row stays organic, not collinear.
 */
const MIN_NODE_GAP = 150;
/** Vertical stagger step applied by column so siblings are not on one flat row. */
const STAGGER_STEP = 34;
/** Deterministic per-node horizontal jitter amplitude (SVG units). */
const X_JITTER = 22;
/** Deterministic per-node vertical jitter amplitude (SVG units). */
const Y_JITTER = 18;
/**
 * Extra vertical gap pushed onto a retry node so it is not cramped against the
 * verify node directly above it in the ladder tail. Applied only to a `retry`
 * node's y, so the rest of the layout spacing is unchanged.
 */
const RETRY_EXTRA_GAP = 70;

interface Placed {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
  /**
   * A small vertical offset applied to this node's label row so adjacent dense
   * labels do not overlap: even columns sit at the normal gap, odd columns are
   * pushed further below. Purely a label concern; the node coordinate is
   * unchanged, so edges and layout determinism are untouched.
   */
  readonly labelTier: number;
}

/**
 * Build the per-node parent list from the dependency AND spawn edges, so a node
 * can be ordered within its layer by the mean x of its parents (its barycenter)
 * and an event-spawned node hangs off its spawner rather than floating in a tidy
 * row. Goal-rooting edges are ignored, exactly as in computeLayers. The ladder
 * chain (escalation hop, per-unit re-fan) rides the dependency kind, so
 * following it also follows the ladder; the spawn kind is followed too so a
 * recruited node branches beneath the unit whose push recruited it.
 */
function buildParentLists(model: WorkGraphModel): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const node of model.nodes) {
    if (node.kind !== "goal") {
      parents.set(node.id, []);
    }
  }
  for (const edge of model.edges) {
    if (edge.from === goalNodeId(model.changeId)) {
      continue;
    }
    if (edge.kind === "dependency" || edge.kind === "spawn" || edge.kind === "trigger") {
      const list = parents.get(edge.to);
      if (list) {
        list.push(edge.from);
      }
    }
  }
  return parents;
}

/** Place the goal and every unit node at a deterministic coordinate. */
function placeNodes(model: WorkGraphModel): { placed: Placed[]; height: number; width: number } {
  const layers = computeLayers(model);
  const parents = buildParentLists(model);
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
  const xOf = new Map<string, number>();
  const goal = model.nodes.find((n) => n.kind === "goal");
  // The row width is the widest layer, so a dense row gets enough horizontal
  // room (MIN_NODE_GAP per node) instead of cramming labels together.
  const widest = byLayer.size === 0 ? 1 : Math.max(1, ...[...byLayer.values()].map((r) => r.length));
  const width = Math.max(WIDTH, (widest + 1) * MIN_NODE_GAP);
  if (goal) {
    placed.push({ node: goal, x: width / 2, y: TOP_MARGIN, labelTier: 0 });
    xOf.set(goal.id, width / 2);
  }
  const maxLayer = byLayer.size === 0 ? 0 : Math.max(...byLayer.keys());
  for (const [l, row] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    // Order each row by its BARYCENTER: the mean x of a node's already-placed
    // parents, so a node sits beneath the nodes it depends on and edges do not
    // cross. Nodes with no placed parent fall back to a stable id order. The
    // ladder chain (goal -> verify -> retry -> verify) reads top to bottom
    // because each verify/retry node's single parent fixes its column.
    const sorted = [...row].sort((a, b) => {
      const ba = barycenter(a.id, parents, xOf);
      const bb = barycenter(b.id, parents, xOf);
      if (ba !== null && bb !== null && ba !== bb) {
        return ba - bb;
      }
      if (ba !== null && bb === null) {
        return -1;
      }
      if (ba === null && bb !== null) {
        return 1;
      }
      return a.id.localeCompare(b.id);
    });
    const y = TOP_MARGIN + (l + 1) * LAYER_HEIGHT;
    const n = sorted.length;
    sorted.forEach((node, i) => {
      const baseX = n === 1 ? width / 2 : ((i + 1) * width) / (n + 1);
      // Positional variance so the graph reads organic, not a rigid lattice:
      // stagger each node's y by column (alternating up/down tiers) and nudge x
      // and y by a small, STABLE per-node jitter derived from the node id. The
      // jitter is deterministic (the same id always yields the same offset), so
      // the layout is reproducible for tests and a node never jumps between
      // polls, yet siblings no longer sit on one dead-straight row/column.
      const stagger = ((i % 3) - 1) * STAGGER_STEP;
      // A retry node sits an extra gap below its layer row so it is not cramped
      // against the verify node directly above it in the ladder tail.
      const retryGap = node.kind === "retry" ? RETRY_EXTRA_GAP : 0;
      const x = baseX + jitter(node.id, "x", X_JITTER);
      const yv = y + retryGap + stagger + jitter(node.id, "y", Y_JITTER);
      placed.push({ node, x, y: yv, labelTier: i % 2 });
      xOf.set(node.id, x);
    });
  }
  const height = TOP_MARGIN + (maxLayer + 2) * LAYER_HEIGHT;
  return { placed, height, width };
}

/**
 * The barycenter (mean x) of a node's already-placed parents, or null when none
 * of its parents has been placed yet (so it falls back to id order). Reading
 * from the running xOf map makes earlier layers anchor later ones, so the whole
 * graph settles top-down with few crossings.
 */
function barycenter(
  id: string,
  parents: Map<string, string[]>,
  xOf: Map<string, number>,
): number | null {
  const ps = parents.get(id) ?? [];
  const xs = ps.map((p) => xOf.get(p)).filter((x): x is number => x !== undefined);
  if (xs.length === 0) {
    return null;
  }
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * A small, STABLE pseudo-random offset in [-amp, amp] derived from a node id and
 * an axis tag. It is a pure function of its inputs (a simple string hash folded
 * into the range), so the same node always lands at the same offset: the layout
 * is deterministic and reproducible for tests, while giving each node its own
 * positional nudge so a row of siblings is no longer a dead-straight lattice.
 */
function jitter(id: string, axis: string, amp: number): number {
  const seed = `${id}:${axis}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Fold the unsigned hash into a fraction in [0, 1), then map to [-amp, amp].
  const frac = (hash >>> 0) / 0xffffffff;
  return (frac * 2 - 1) * amp;
}

/** The longest visible agent label before it is truncated with an ellipsis. */
export const MAX_AGENT_LABEL = 22;

/** Split a trailing parenthetical suffix (e.g. " (retry 2)") off a label. */
function splitSuffix(label: string): { id: string; suffix: string } {
  const match = /^(.*?)(\s*\([^)]*\))?$/.exec(label.trim());
  return { id: (match?.[1] ?? label).trim(), suffix: (match?.[2] ?? "").trim() };
}

/** Strip the planner's `unit-` prefix and any path head, keeping the meaningful id. */
function baseUnitLabel(id: string): string {
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const stripped = tail.replace(/^unit-/, "");
  return stripped === "" ? tail : stripped;
}

/** Truncate a label to `max` characters with a trailing ellipsis. */
function truncateLabel(label: string, max: number = MAX_AGENT_LABEL): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}\u2026`;
}

/**
 * A SHORT, legible display label for one agent/work node, from its full label
 * (the unit id, optionally with a "(retry N)" suffix). It strips the planner's
 * `unit-` prefix and any path head, then truncates a very long id, so
 * "unit-auth-resource-guards (retry 2)" reads "auth-resource-guards (retry 2)".
 * The FULL unit id stays in the SVG <title> tooltip and the node detail panel.
 * Pure and deterministic.
 */
export function shortNodeLabel(label: string): string {
  const { id, suffix } = splitSuffix(label);
  return [truncateLabel(baseUnitLabel(id)), suffix].filter((s) => s !== "").join(" ");
}

/**
 * Distinguishable display labels for every agent/work node in a model, keyed by
 * node id. Sibling unit ids usually share a prefix and/or suffix (for example
 * `unit-<resource>-resource-guards`), so a per-label tail would collapse them
 * all to the same word. This strips the dash-separated tokens EVERY distinct
 * base id shares at the start and at the end, leaving the part that tells them
 * apart ("auth", "orders", ...). With a single distinct id, or when stripping
 * would empty a label, it falls back to shortNodeLabel. Pure and deterministic.
 */
export function agentDisplayLabels(nodes: readonly GraphNode[]): Map<string, string> {
  const agents = nodes.filter((n) => n.kind === "agent" || n.kind === "work");
  const parts = agents.map((n) => {
    const { id, suffix } = splitSuffix(n.label);
    return { node: n, base: baseUnitLabel(id), suffix };
  });
  const distinct = [...new Set(parts.map((p) => p.base))];
  const tokenLists = distinct.map((b) => b.split("-"));
  let prefix = 0;
  let suffixLen = 0;
  if (distinct.length >= 2) {
    const shortest = Math.min(...tokenLists.map((t) => t.length));
    while (
      prefix < shortest - 1 &&
      tokenLists.every((t) => t[prefix] === tokenLists[0]![prefix])
    ) {
      prefix += 1;
    }
    while (
      suffixLen < shortest - prefix - 1 &&
      tokenLists.every(
        (t) => t[t.length - 1 - suffixLen] === tokenLists[0]![tokenLists[0]!.length - 1 - suffixLen],
      )
    ) {
      suffixLen += 1;
    }
  }
  const out = new Map<string, string>();
  for (const { node, base, suffix } of parts) {
    const tokens = base.split("-");
    const core = tokens.slice(prefix, tokens.length - suffixLen).join("-");
    const label = core === "" ? base : core;
    out.set(node.id, [truncateLabel(label), suffix].filter((s) => s !== "").join(" "));
  }
  return out;
}

/** The small caption under a node: its kind, plus a jev decision's outcome. */
function nodeCaption(node: GraphNode): string {
  if (node.kind === "jev") {
    const outcome = /\s(accepted|escalated)$/.exec(node.label)?.[1];
    return outcome ? `jev ${outcome}` : "jev";
  }
  return node.kind;
}

/**
 * The visible label for a non-agent node. The kind is already drawn as the
 * caption beneath, so a jev node shows only its juncture (its outcome moves to
 * the caption) and a verify node drops its "verify"/"(app gate)" words; the full
 * label stays in the tooltip.
 */
function compactLabel(node: GraphNode): string {
  if (node.kind === "jev") {
    return node.label.replace(/^jev:\s*/, "").replace(/\s+(accepted|escalated)$/, "");
  }
  if (node.kind === "verify") {
    return node.label.replace(/^verify\s+/, "").replace(/\s*\(app gate\)/, "");
  }
  return node.label;
}

function computeLayers(model: WorkGraphModel): Map<string, number> {
  const deps = new Map<string, string[]>();
  // Build the per-unit dependency list from the declared dependency AND spawn
  // edges between unit nodes (ignore only the goal-rooting edges).
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
    // a dependency edge), a retry node hangs below the failing verify it
    // escalated from (a trigger edge), and a round-N agent hangs below its retry
    // (a trigger re-fan edge). The escalation hop and the per-unit re-fan ride
    // the `trigger` kind, so following it lays the whole ladder chain down the
    // rows. The spawn kind is followed too, so an event-spawned (recruited) node
    // sits a layer BELOW the unit whose push recruited it, hanging off its
    // spawner instead of floating in a flat, detached row.
    if (edge.kind === "dependency" || edge.kind === "spawn" || edge.kind === "trigger") {
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

/** The stroke style per edge kind. */
function edgeStyle(kind: GraphEdge["kind"]): { stroke: string; dash?: string } {
  switch (kind) {
    case "spawn":
      return { stroke: "#d2a8ff", dash: "2 5" }; // event-driven Artifact recruitment ONLY
    case "trigger":
      // Ladder control-flow (verify-fail -> planner(re-plan) -> retry, the
      // escalation hop, the re-fan, the verify flow): a distinct AMBER-GOLD
      // dashed stroke, clearly different from the violet event-driven spawn dash
      // and the muted grey dependency line, with a longer dash cadence so a
      // watcher reads it as a caused control-flow hop, not a declared dependency.
      return { stroke: "#d9a441", dash: "6 4" };
    case "consumed-tool":
      // A real tool run: a bright AMBER edge, drawn solid (no dash), so it reads
      // as a distinct tool-consumption. A consumed-tool edge only ever appears
      // next to a tool node.
      return { stroke: "#f0883e" };
    case "dependency":
    default:
      return { stroke: "#5a6472" };
  }
}

/**
 * The four points of a diamond (a square rotated 45deg) whose half-diagonal is
 * `r`, centered at the node origin. Used for the GOAL node so the Change root
 * reads as a distinct diamond among the agent circles, while keeping the same
 * visual footprint as a circle of radius `r`.
 */
function diamondPoints(r: number): string {
  return `0,${-r} ${r},0 0,${r} ${-r},0`;
}

/**
 * The six points of a regular hexagon with circumradius `r`, centered at the
 * node origin (flat-ish top). Used for BOTH the verify and the retry node so
 * the mechanical gate run and its smarter-model re-attempt share one distinct
 * shape (set apart from the agent circles and the goal diamond); the two are
 * told apart by COLOR, not shape (see nodeFill).
 */
function hexagonPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i - Math.PI / 2; // start at the top
    const x = r * Math.cos(angle);
    const y = r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

/**
 * The four points of an axis-aligned square whose half-side is `r`, centered at
 * the node origin. Used for the agent-built TOOL node (drawn yellow) so it reads
 * as a distinct yellow square tool/output artifact, not another agent circle.
 */
function squarePoints(r: number): string {
  return `${-r},${-r} ${r},${-r} ${r},${r} ${-r},${r}`;
}

/**
 * The three points of an upward equilateral triangle with circumradius `r`,
 * centered at the node origin. Used for the PLANNER node so the decomposer reads
 * as a distinct triangle, set apart from the goal diamond, the agent circles,
 * the tool square, and the verify/retry hexagons, while keeping the same visual
 * footprint as a circle of radius `r`.
 */
function trianglePoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const angle = (2 * Math.PI / 3) * i - Math.PI / 2; // start at the top
    const x = r * Math.cos(angle);
    const y = r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

/**
 * The five points of a regular pentagon with circumradius `r`, centered at the
 * node origin (point up). Used for the JEV decision node so a typed-decision
 * beat reads as its own distinct shape, set apart from the goal diamond, the
 * planner triangle, the agent circles, the tool square, and the verify/retry
 * hexagons, while keeping the same visual footprint as a circle of radius `r`.
 */
function pentagonPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const angle = (2 * Math.PI / 5) * i - Math.PI / 2; // start at the top
    const x = r * Math.cos(angle);
    const y = r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

/**
 * Whether a round-N retry agent node failed on its own attempt WHILE the whole
 * change ultimately PASSED. Such a node is an honest per-attempt failure (its
 * re-fan produced no edit, or an earlier edit already sufficed), NOT a failure
 * that blocked the change, so it is rendered in a muted neutral tone rather than
 * the terminal dead-red of a change that genuinely failed. The round-N instance
 * is identified by its round-agent backing; the overall pass is read from the
 * model's verify nodes (a verified verify round means the change passed).
 */
export function isNonBlockingRoundFail(node: GraphNode, changePassed: boolean): boolean {
  return (
    changePassed &&
    node.kind === "agent" &&
    node.status === "failed" &&
    node.backing.kind === "round-agent"
  );
}

/**
 * Whether the whole change PASSED. When the goal node carries the authoritative
 * integration verdict (the final integration gate on the integrated tree), that
 * verdict alone decides; a passing ladder round is only an advisory overlay and
 * cannot override it. Without a recorded verdict on the goal (still in progress,
 * or a legacy/offline snapshot) a verified verify round stands in, as before.
 * Used only for DISPLAY clarity (a non-blocking round fail), never to change a
 * verdict.
 */
export function changeHasPassed(model: WorkGraphModel): boolean {
  const goal = model.nodes.find((n) => n.kind === "goal");
  if (goal && goal.backing.kind === "change" && goal.backing.integrationVerdict !== undefined) {
    // A pass with no gate checked nothing: it is not a pass to lean on.
    return goal.backing.integrationVerdict === "verified" && goal.backing.gated !== false;
  }
  return model.nodes.some((n) => n.kind === "verify" && n.verified);
}

/** The amber used for a node that completed in a degraded way (node.warning). */
export const WARNING_FILL = "#d29922";

/**
 * The YELLOW used for a node awaiting a human decision (a pending escalation).
 * It is not an error, so it is never the failed red, and it is a lighter lemon
 * yellow set apart from the darker WARNING_FILL amber and the orange jev fills.
 */
export const AWAITING_FILL = "#f5d547";

/** The fill color for a node from its kind and verified/escalated/failed state. */
function nodeFill(node: GraphNode, changePassed = false): string {
  if (node.escalated) {
    return AWAITING_FILL; // a pending human escalation lights this node (the human beat)
  }
  // A round-N retry agent that failed its own attempt while the change still
  // PASSED is an honest per-attempt failure that did NOT block the change, so it
  // is drawn in a MUTED SLATE tone, visibly distinct from the terminal dead-red
  // of a change that genuinely failed. Checked before the generic failed case so
  // this clarity treatment wins for a non-blocking round fail; a round fail in a
  // change that did NOT pass still reads as the terminal dead-red below.
  if (isNonBlockingRoundFail(node, changePassed)) {
    return "#495366";
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
  // normal running agent (blue) and the awaiting-you yellow.
  if (node.kind === "retry") {
    return "#a371f7";
  }
  // A jev node is a typed-decision beat: a distinct AMBER/ORANGE fill, set apart
  // from the teal planner and every other kind. An ACCEPTED decision (confident
  // use) reads as a brighter amber; an ESCALATED one reads as a muted amber, so
  // a glance distinguishes confident-use from escalate. It is checked before the
  // generic verified-green and the kind switch so a jev node is always drawn in
  // its own hue, never as a generic green/running node. It is display only and
  // never changes an authoritative verdict.
  if (node.kind === "jev") {
    return node.verified ? "#e3883e" : "#9a5a1f";
  }
  if (node.status === "failed") {
    // A failed unit is a distinct terminal state: a dark, muted red, clearly not
    // the healthy green of a verified node and not the blue of a running one, so
    // a watcher sees a dead unit at a glance rather than a stuck-green or
    // perpetually-running node.
    return "#8b2c22";
  }
  if (node.kind === "tool") {
    return "#e3b341"; // agent-built tool: a distinct YELLOW square, its own repo
  }
  if (node.warning) {
    // Completed, but in a degraded way that must not read as plain success (a
    // heuristic-fallback plan): AMBER, never the healthy green.
    return WARNING_FILL;
  }
  if (node.verified) {
    return "#238636"; // greened: evidence landed (verified/integrated)
  }
  switch (node.kind) {
    case "goal":
      return "#1f6feb";
    case "planner":
      // The schema-constrained decomposer: a distinct TEAL, set apart from the
      // goal diamond (blue), the agent circles (blue), the tool square (yellow),
      // and the verify/retry hexagons (green/red/magenta), so the planner reads
      // as its own beat between the goal and the first agent wave.
      return "#2bb3a3";
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

/** Pixels of mouse movement before a press is treated as a drag, not a click. */
const DRAG_THRESHOLD = 4;

export function GraphView({ model, selectedId, onSelect }: GraphViewProps) {
  const { placed, height, width } = useMemo(() => placeNodes(model), [model]);
  // Whether the whole change passed, read from the model's verify nodes. Used
  // only for DISPLAY clarity: a round-N retry agent that failed its own attempt
  // while the change still passed is drawn muted (a non-blocking per-attempt
  // failure), never recolored into or out of a verdict.
  const changePassed = useMemo(() => changeHasPassed(model), [model]);
  const agentLabels = useMemo(() => agentDisplayLabels(model.nodes), [model]);
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
      const x = ((clientX - rect.left) / rect.width) * width;
      const y = ((clientY - rect.top) / rect.height) * height;
      return { x, y };
    },
    [height, width],
  );

  // Wheel to zoom, centered on the cursor: solve for the translation that keeps
  // the SVG-space point under the pointer fixed as the scale changes.
  //
  // This is attached as a NATIVE, NON-PASSIVE wheel listener (see the useEffect
  // below), not via React's onWheel prop. React registers wheel listeners as
  // PASSIVE at its root, which makes event.preventDefault() a silent no-op there;
  // a native listener added with { passive: false } is the only way preventDefault
  // actually blocks the page from scrolling while alt + wheel zooms the graph. A
  // plain wheel (no alt) returns early WITHOUT preventDefault, so the page scrolls
  // normally and only alt + wheel is intercepted.
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      // Zoom is gated behind the ALT key: a plain wheel scrolls the page as
      // normal, and alt + wheel zooms the graph. Without the modifier we do not
      // preventDefault, so page scrolling is never hijacked.
      if (!shouldZoomOnWheel(event)) {
        return;
      }
      event.preventDefault();
      const { x, y } = clientToSvg(event.clientX, event.clientY);
      setView((prev) => zoomAt(prev, x, y, event.deltaY));
    },
    [clientToSvg],
  );

  // Register the wheel handler natively with { passive: false } on the svg, so
  // event.preventDefault() inside it genuinely blocks the page scroll (a React
  // onWheel prop cannot, because React's wheel listener is passive). Re-attached
  // if handleWheel changes and cleaned up on unmount.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      svg.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

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
      const scaleX = rect ? width / rect.width : 1;
      const scaleY = rect ? height / rect.height : 1;
      setView((prev) => ({
        ...prev,
        tx: d.originTx + dxClient * scaleX,
        ty: d.originTy + dyClient * scaleY,
      }));
    },
    [height, width],
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
        <span className="graph-hint muted">alt + scroll to zoom, drag to pan</span>
      </div>
      <svg
        ref={svgRef}
        className={`graph-svg${drag.current ? " is-panning" : ""}`}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Living work graph"
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
              // The escalation hop now rides the `dependency` kind, so read the
              // model ids from its BACKING (which still records the base model
              // that failed and the stronger model the ladder escalated to) and
              // render that hop as a label on the edge ("base -> escalation") so
              // a watcher sees WHICH model took over, straight from state.
              const escalationLabel =
                edge.backing.kind === "model-escalation"
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
                    strokeWidth={edge.backing.kind === "model-escalation" ? 2.5 : 1.5}
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
            {placed.map(({ node, x, y, labelTier }) => {
              const r = node.kind === "goal" ? GOAL_RADIUS : NODE_RADIUS;
              const selected = node.id === selectedId;
              // Offset dense-row labels so adjacent ones do not collide: tier 1
              // (odd columns) sits one label-row lower than tier 0.
              const labelOffset = labelTier * 26;
              return (
                <g
                  key={node.id}
                  className={`node node-${node.kind} ${node.verified ? "is-verified" : ""} ${
                    node.escalated ? "is-escalated" : ""
                  } ${node.status === "failed" ? "is-failed" : ""} ${node.warning ? "is-warning" : ""} ${
                    selected ? "is-selected" : ""
                  }`}
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
                  {/* The node SHAPE encodes its kind, and the selection ring
                      (a bright stroke) is applied uniformly to EVERY shape, so a
                      click selects any kind of node and draws the white ring on
                      all of them (goal, agent, verify, retry, tool, work):
                        goal   -> diamond
                        agent  -> circle (a round-N retry agent is an agent too)
                        verify -> hexagon
                        retry  -> hexagon, SAME shape as verify but a different
                                  color (its magenta fill, set in nodeFill)
                        tool   -> yellow square
                        work   -> circle (a declared unit before recruitment)
                      The polygon half-extents match the circle radius so each
                      shape keeps the same footprint and the deterministic layout
                      is unchanged. */}
                  {node.kind === "goal" ? (
                    <polygon
                      points={diamondPoints(r)}
                      fill={nodeFill(node, changePassed)}
                      stroke={selected ? "#e6edf3" : "#0d1117"}
                      strokeWidth={selected ? 3 : 1.5}
                    />
                  ) : node.kind === "planner" ? (
                    <polygon
                      points={trianglePoints(r)}
                      fill={nodeFill(node, changePassed)}
                      stroke={selected ? "#e6edf3" : "#0d1117"}
                      strokeWidth={selected ? 3 : 1.5}
                    />
                  ) : node.kind === "tool" ? (
                    <polygon
                      points={squarePoints(r)}
                      fill={nodeFill(node, changePassed)}
                      stroke={selected ? "#e6edf3" : "#0d1117"}
                      strokeWidth={selected ? 3 : 1.5}
                    />
                  ) : node.kind === "verify" || node.kind === "retry" ? (
                    <polygon
                      points={hexagonPoints(r)}
                      fill={nodeFill(node, changePassed)}
                      stroke={selected ? "#e6edf3" : "#0d1117"}
                      strokeWidth={selected ? 3 : 1.5}
                    />
                  ) : node.kind === "jev" ? (
                    <polygon
                      points={pentagonPoints(r)}
                      fill={nodeFill(node, changePassed)}
                      stroke={selected ? "#e6edf3" : "#0d1117"}
                      strokeWidth={selected ? 3 : 1.5}
                    />
                  ) : (
                    <circle
                      r={r}
                      fill={nodeFill(node, changePassed)}
                      stroke={selected ? "#e6edf3" : "#0d1117"}
                      strokeWidth={selected ? 3 : 1.5}
                    />
                  )}
                  {/* Labels sit OUTSIDE the node, below it, so they are legible
                      and never crammed inside the small node. An agent (and
                      round-N retry agent) node's visible label is the part of its
                      unit id that tells it apart from its siblings (e.g.
                      "orders (retry 2)"); the FULL unit id is kept in the SVG
                      <title> tooltip (and the node detail panel). jev and verify
                      labels drop the words the kind caption already says. */}
                  <text
                    className="node-label"
                    textAnchor="middle"
                    y={r + LABEL_GAP + 11 + labelOffset}
                  >
                    {node.kind === "agent" || node.kind === "work"
                      ? (agentLabels.get(node.id) ?? shortNodeLabel(node.label))
                      : compactLabel(node)}
                  </text>
                  <text
                    className="node-kind"
                    textAnchor="middle"
                    y={r + LABEL_GAP + 24 + labelOffset}
                  >
                    {nodeCaption(node)}
                  </text>
                  {/* The tooltip keeps the FULL label and, for a round-N retry
                      agent that failed its own attempt while the change still
                      passed, a short note making clear it is a per-attempt
                      failure that did NOT block the change. */}
                  <title>{`${node.label} [${node.kind}] status=${node.status}${
                    isNonBlockingRoundFail(node, changePassed)
                      ? " (per-attempt retry failure; the change still passed)"
                      : ""
                  }${node.warning ? ` WARNING: ${node.warning}` : ""}`}</title>
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}

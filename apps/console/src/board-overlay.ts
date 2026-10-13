/**
 * Pure projections of the board log for mission control's overlays: the
 * agent-to-agent COMMUNICATION overlay (who asked, proposed, handed off, or
 * contested whom), the compact GATE TIMELINE (one marker per integrated
 * revision), the ACCEPTANCE-OVER-REVISIONS chart data, smarter hull titles, and
 * the advisory Jev rows.
 *
 * None of these adds a graph element: the communication overlay is an
 * annotation layer drawn over the graph (never a graph edge, whose kinds stay
 * dependency | spawn | trigger | consumed-tool, plus the board's message and
 * contest), and every arrow, marker, point, and row here is derived from one
 * recorded board message at or before the cursor and carries that message's
 * seq, so nothing on screen is decorative.
 */

import {
  boardMessageFamily,
  boardPrefix,
  participantNode,
  type BoardGraphEdge,
  type BoardGraphModel,
  type BoardMessage,
} from "@switchyard-change/orchestration/board-graph";

// ---------------------------------------------------------------------------
// The communication overlay
// ---------------------------------------------------------------------------

/** One short-lived overlay arrow (or a mark, when the message addresses no one drawn). */
export interface CommArrow {
  /** Stable per message and target, for keys. */
  readonly id: string;
  /** The board message that backs it. */
  readonly seq: number;
  readonly type: BoardMessage["type"];
  /** The acting participant's node (`agent:<id>` or `human`). */
  readonly from: string;
  /** The addressed or concerned participant's node, or null for a mark on `from` alone. */
  readonly to: string | null;
  /** A 1-3 word verb (`proposes`, `asks help`, `hands off`, ...). */
  readonly verb: string;
  /** What kind of exchange it is (its colour on the overlay), from the message type. */
  readonly kind: CommKind;
  /** How many seqs ago it landed (0 = the message at the cursor). */
  readonly age: number;
  /** Hover text: who, what, to whom, and the backing message. */
  readonly tooltip: string;
}

/** The kinds of agent talk, each drawn in its own colour. */
export const COMM_KINDS = ["proposal", "contract", "help", "handoff", "conflict"] as const;
export type CommKind = (typeof COMM_KINDS)[number];

/**
 * The kind of a talk arrow, from its message type alone: a proposal (items,
 * tools, and their acceptance or re-plan), a contract exchange, help, a
 * handoff, or a conflict (a contested or overlapping claim, a predicted
 * clash). Null for a message type the overlay never draws.
 */
export function commKind(type: string): CommKind | null {
  switch (type) {
    case "item.proposed":
    case "tool.proposed":
    case "item.accepted":
    case "item.rejected":
    case "item.replanned":
      return "proposal";
    case "contract.proposed":
    case "contract.accepted":
    case "contract.rejected":
    case "contract.escalated":
      return "contract";
    case "help.requested":
    case "help.volunteered":
    case "help.offered":
    case "help.delivered":
    case "help.declined":
      return "help";
    case "handoff":
      return "handoff";
    case "claim.contested":
    case "claim.kept":
    case "claim.ceded":
    case "claim.narrowed":
    case "claim.overlap":
    case "clash.predicted":
      return "conflict";
    default:
      return null;
  }
}

/** How many seqs an arrow stays on screen after its message lands. */
export const COMM_WINDOW = 10;
/** The most arrows drawn at once (newest first), so a busy moment stays readable. */
export const COMM_MAX = 6;

function agentId(node: string): string {
  return node.replace(/^agent:/, "");
}

/**
 * The communication arrows at seq `k`: every coordination message in the last
 * `window` seqs (k - window, k], newest first, capped at `max`. A message
 * becomes an arrow from the participant that acted to the participant it
 * addresses or concerns:
 *
 *   contract.proposed  proposer -> lead (or its addressees)     "proposes"
 *   contract.accepted / .rejected  decider -> proposer          "accepts" / "rejects"
 *   contract.escalated proposer -> human                        "to a human"
 *   item.proposed (a worker's)  worker -> lead                  "proposes item"
 *   tool.proposed (a worker's)  worker -> lead                  "proposes tool"
 *   item.accepted / .rejected   lead -> the worker who proposed "accepts" / "rejects"
 *   help.requested     requester -> each addressee              "asks help" ("grants help" with a scope)
 *   help.volunteered   volunteer -> the owner                   "volunteers"
 *   help.offered / .delivered  helper -> requester              "offers help" / "delivers"
 *   help.declined      owner -> volunteer                       "declines"
 *   handoff            from -> to                               "hands off"
 *   claim.contested    claimant -> owner                        "contests"
 *   claim.kept / .ceded / .narrowed  party -> the other party   "keeps" / "cedes" / "narrows"
 *   claim.overlap      agent -> withAgent                       "overlap"
 *   clash.predicted    a.agent -> b.agent (conflict only)       "clash"
 *   item.replanned     lead -> the item's last owner            "re-plans"
 *
 * A message whose target cannot be named from the log (a help request
 * addressed to no one, a re-plan of an item nobody held) is a mark on its
 * sender (`to: null`), never an invented arrow. Pure: the same log and k always
 * give the same arrows.
 */
export function communicationArrows(
  log: readonly BoardMessage[],
  k: number,
  options: { readonly window?: number; readonly max?: number } = {},
): CommArrow[] {
  const window = options.window ?? COMM_WINDOW;
  const max = options.max ?? COMM_MAX;
  const messages = boardPrefix(log, k);
  // Facts the targets need, folded from the prefix in order.
  const leads: string[] = [];
  const contractProposer = new Map<string, string>();
  const itemProposer = new Map<string, string>();
  const owner = new Map<string, string>();
  const lastOwner = new Map<string, string>();
  const contests = new Map<string, { claimant: string; owner: string }>();
  const helpRequester = new Map<string, string>();
  const out: CommArrow[] = [];
  // A window of 0 or less keeps every message up to K.
  const from = window <= 0 ? Number.NEGATIVE_INFINITY : k - window;
  for (const m of messages) {
    const add = (fromNode: string, toNodes: readonly string[] | null, verb: string) => {
      if (m.seq <= from) return;
      const kind = commKind(m.type);
      if (kind === null) return;
      const targets = toNodes === null ? [] : [...new Set(toNodes)].filter((t) => t !== fromNode);
      const age = k - m.seq;
      if (targets.length === 0) {
        out.push({ id: `comm:${m.seq}`, seq: m.seq, type: m.type, from: fromNode, to: null, verb, kind, age, tooltip: `${agentId(fromNode)} ${verb} (seq ${m.seq}, ${m.type})` });
        return;
      }
      for (const to of targets) {
        out.push({
          id: `comm:${m.seq}->${to}`,
          seq: m.seq,
          type: m.type,
          from: fromNode,
          to,
          verb,
          kind,
          age,
          tooltip: `${agentId(fromNode)} ${verb} -> ${agentId(to)} (seq ${m.seq}, ${m.type})`,
        });
      }
    };
    const sender = participantNode(m.from);
    const addressed = (m.to ?? []).map(participantNode);
    const leadNodes = () => leads.map(participantNode);
    switch (m.type) {
      case "agent.joined":
        if (m.payload.role === "lead") leads.push(m.from);
        break;
      case "item.proposed":
        itemProposer.set(m.payload.item, m.from);
        if (m.from !== "engine" && m.from !== "human" && !leads.includes(m.from)) {
          add(sender, addressed.length > 0 ? addressed : leadNodes(), "proposes item");
        }
        break;
      case "tool.proposed":
        // A tool proposal files its build item (`tool-<capability>`), which the lead accepts like any worker proposal.
        itemProposer.set(`tool-${m.payload.capability}`, m.from);
        if (m.from !== "engine" && m.from !== "human" && !leads.includes(m.from)) {
          add(sender, addressed.length > 0 ? addressed : leadNodes(), "proposes tool");
        }
        break;
      case "item.accepted":
      case "item.rejected": {
        const proposer = itemProposer.get(m.payload.item);
        if (m.from !== "engine" && proposer !== undefined && proposer !== "engine") {
          add(sender, [participantNode(proposer)], m.type === "item.accepted" ? "accepts" : "rejects");
        }
        break;
      }
      case "claim.granted":
        owner.set(m.payload.item, m.payload.agent);
        lastOwner.set(m.payload.item, m.payload.agent);
        break;
      case "claim.lapsed":
        owner.delete(m.payload.item);
        break;
      case "item.reopened":
        owner.delete(m.payload.item);
        break;
      case "handoff":
        owner.set(m.payload.item, m.payload.to);
        lastOwner.set(m.payload.item, m.payload.to);
        add(sender, [participantNode(m.payload.to)], "hands off");
        break;
      case "contract.proposed":
        contractProposer.set(m.payload.contract, m.from);
        add(sender, addressed.length > 0 ? addressed : leadNodes(), "proposes");
        break;
      case "contract.accepted":
      case "contract.rejected": {
        const proposer = contractProposer.get(m.payload.contract);
        if (proposer !== undefined && m.from !== "engine") {
          add(sender, [participantNode(proposer)], m.type === "contract.accepted" ? "accepts" : "rejects");
        }
        break;
      }
      case "contract.escalated": {
        const proposer = contractProposer.get(m.payload.contract);
        if (proposer !== undefined) add(participantNode(proposer), ["human"], "to a human");
        break;
      }
      case "help.requested":
        helpRequester.set(m.payload.request, m.from);
        add(sender, addressed, m.payload.scope !== undefined && m.payload.scope.length > 0 && addressed.length > 0 ? "grants help" : "asks help");
        break;
      case "help.volunteered": {
        const held = owner.get(m.payload.item);
        add(sender, addressed.length > 0 ? addressed : held !== undefined ? [participantNode(held)] : null, "volunteers");
        break;
      }
      case "help.offered":
      case "help.delivered": {
        const requester = (m.type === "help.offered" ? m.payload.forkOf : undefined) ?? helpRequester.get(m.payload.request);
        add(sender, requester !== undefined ? [participantNode(requester)] : addressed, m.type === "help.offered" ? "offers help" : "delivers");
        break;
      }
      case "help.declined":
        add(sender, [participantNode(m.payload.volunteer)], "declines");
        break;
      case "claim.contested":
        contests.set(m.payload.contest, { claimant: m.payload.claimant, owner: m.payload.owner });
        add(participantNode(m.payload.claimant), [participantNode(m.payload.owner)], "contests");
        break;
      case "claim.kept":
      case "claim.ceded":
      case "claim.narrowed": {
        const c = contests.get(m.payload.contest);
        const other = c === undefined ? undefined : c.claimant === m.from ? c.owner : c.claimant;
        add(sender, other !== undefined ? [participantNode(other)] : null, m.type === "claim.kept" ? "keeps" : m.type === "claim.ceded" ? "cedes" : "narrows");
        break;
      }
      case "claim.overlap":
        add(participantNode(m.payload.agent), [participantNode(m.payload.withAgent)], "overlap");
        break;
      case "clash.predicted":
        if (m.payload.status === "conflict") add(participantNode(m.payload.a.agent), [participantNode(m.payload.b.agent)], "clash");
        break;
      case "item.replanned": {
        const held = lastOwner.get(m.payload.item);
        add(sender, held !== undefined ? [participantNode(held)] : null, "re-plans");
        break;
      }
      default:
        break;
    }
  }
  return out.sort((a, b) => b.seq - a.seq || a.id.localeCompare(b.id)).slice(0, Math.max(0, max));
}

/** The opacity of an arrow by its age: full when it lands, fading to a floor over the window. */
export function commOpacity(age: number, window = COMM_WINDOW): number {
  if (window <= 0) return 1;
  return Math.max(0.25, 1 - age / window);
}

/** A curved arrow between two points: the quadratic path and its label point (the curve's midpoint). */
export function commCurve(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  bend = 0.22,
  inset = 20,
): CommCurve {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Stop short of both nodes so the arrowhead is not hidden under a node.
  const cut = Math.min(inset, len / 3);
  const sx = a.x + (dx / len) * cut;
  const sy = a.y + (dy / len) * cut;
  const ex = b.x - (dx / len) * cut;
  const ey = b.y - (dy / len) * cut;
  // Bend to the left of the direction of travel, so A->B and B->A never overlap.
  const cx = (sx + ex) / 2 + (-dy / len) * len * bend;
  const cy = (sy + ey) / 2 + (dx / len) * len * bend;
  const r = (n: number) => Number(n.toFixed(1));
  return {
    d: `M ${r(sx)} ${r(sy)} Q ${r(cx)} ${r(cy)} ${r(ex)} ${r(ey)}`,
    mid: { x: r(0.25 * sx + 0.5 * cx + 0.25 * ex), y: r(0.25 * sy + 0.5 * cy + 0.25 * ey) },
    start: { x: sx, y: sy },
    control: { x: cx, y: cy },
    end: { x: ex, y: ey },
  };
}

interface XY {
  readonly x: number;
  readonly y: number;
}

/** A drawn talk curve: its path, its midpoint, and the quadratic's three points. */
export interface CommCurve {
  readonly d: string;
  readonly mid: XY;
  readonly start: XY;
  readonly control: XY;
  readonly end: XY;
}

/** An axis-aligned box in layout units (x, y is its top-left corner). */
export interface LabelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where along a talk curve its label may go, in order of preference. */
export const TALK_LABEL_TS = [0.5, 0.4, 0.6, 0.3, 0.7] as const;

/**
 * Candidate label centers along a talk curve, in order of preference: on the
 * curve at each t of TALK_LABEL_TS first, then the same points nudged `offset`
 * to either side of the curve (along its normal there), then twice as far.
 */
export function talkLabelCandidates(curve: CommCurve, offset: number): XY[] {
  const { start: s, control: c, end: e } = curve;
  const on: XY[] = [];
  const off: XY[] = [];
  const far: XY[] = [];
  for (const t of TALK_LABEL_TS) {
    const u = 1 - t;
    const p = { x: u * u * s.x + 2 * u * t * c.x + t * t * e.x, y: u * u * s.y + 2 * u * t * c.y + t * t * e.y };
    on.push(p);
    // The quadratic's tangent at t, and its unit normal.
    const tx = 2 * u * (c.x - s.x) + 2 * t * (e.x - c.x);
    const ty = 2 * u * (c.y - s.y) + 2 * t * (e.y - c.y);
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    off.push({ x: p.x + nx * offset, y: p.y + ny * offset }, { x: p.x - nx * offset, y: p.y - ny * offset });
    far.push({ x: p.x + 2 * nx * offset, y: p.y + 2 * ny * offset }, { x: p.x - 2 * nx * offset, y: p.y - 2 * ny * offset });
  }
  const r = (n: number) => Number(n.toFixed(1));
  return [...on, ...off, ...far].map((q) => ({ x: r(q.x), y: r(q.y) }));
}

/** True when two boxes share any area (touching edges do not overlap). */
export function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Place a label of `size` at the first candidate center whose box, grown by
 * `gap` on every side, hits none of the `occupied` boxes and lies inside
 * `bounds` (when given). Null when every candidate is taken: the caller then
 * draws no label. Pure: the same inputs always give the same spot.
 */
export function placeLabel(
  size: { readonly w: number; readonly h: number },
  candidates: readonly XY[],
  occupied: readonly LabelRect[],
  options: { readonly bounds?: LabelRect; readonly gap?: number } = {},
): LabelRect | null {
  const gap = options.gap ?? 2;
  const b = options.bounds;
  for (const c of candidates) {
    const box = { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h };
    if (b && (box.x < b.x || box.y < b.y || box.x + box.w > b.x + b.w || box.y + box.h > b.y + b.h)) continue;
    const padded = { x: box.x - gap, y: box.y - gap, w: box.w + 2 * gap, h: box.h + 2 * gap };
    if (occupied.some((o) => rectsOverlap(padded, o))) continue;
    return box;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Open fix requests of the latest revision
// ---------------------------------------------------------------------------

/**
 * The "fix asked" lines drawn without a revision focused: the recorded
 * rev -> item trigger edges (each backed by its fix.requested message) of the
 * LATEST integrated revision at K, keeping only the requests still open. A
 * push for the item after the request answers it; a later revision replaces
 * the whole set (it is then the latest); a passing latest revision draws
 * none. Null when nothing is open. Pure: read from the model and the log.
 */
export function outstandingFixLinks(
  model: BoardGraphModel,
  log: readonly BoardMessage[],
): { readonly rev: BoardGraphModel["nodes"][number]; readonly edges: readonly BoardGraphEdge[] } | null {
  let latest: BoardGraphModel["nodes"][number] | undefined;
  for (const node of model.nodes) {
    if (node.detail.kind !== "rev") continue;
    if (!latest || (latest.detail.kind === "rev" && node.detail.n > latest.detail.n)) latest = node;
  }
  if (!latest || latest.detail.kind !== "rev") return null;
  if (latest.detail.gated && latest.detail.gate === "pass") return null;
  const pushes = boardPrefix(log, model.k).filter((m) => m.type === "push.announced");
  const edges = model.edges.filter((e) => {
    if (e.kind !== "trigger" || e.from !== latest!.id || e.type !== "fix.requested" || !e.to.startsWith("item:")) return false;
    const item = e.to.slice("item:".length);
    const asked = e.seqs[0]!;
    return !pushes.some((m) => m.seq > asked && m.type === "push.announced" && m.payload.item === item);
  });
  return edges.length > 0 ? { rev: latest, edges } : null;
}

// ---------------------------------------------------------------------------
// The on-screen legend
// ---------------------------------------------------------------------------

/** How a drawn line looks: a graph edge kind, split by its style (fork, merged, escalated contest). */
export type EdgeVariant = "dependency" | "fork" | "merged" | "trigger" | "consumed-tool" | "contest" | "contest-escalated" | "message";
export const EDGE_VARIANTS: readonly EdgeVariant[] = ["dependency", "fork", "merged", "trigger", "consumed-tool", "contest", "contest-escalated", "message"];

/** The style variant a graph edge is drawn in (null for `spawn`, which the board graph never emits). */
export function edgeVariant(edge: BoardGraphEdge): EdgeVariant | null {
  switch (edge.kind) {
    case "dependency":
      return edge.label === "fork" ? "fork" : edge.label === "merged" ? "merged" : "dependency";
    case "contest":
      return edge.contest === "escalated" ? "contest-escalated" : "contest";
    case "trigger":
    case "consumed-tool":
    case "message":
      return edge.kind;
    default:
      return null;
  }
}

/** A legend key: an edge variant, or a talk kind (`talk-help`, ...). */
export type LegendKey = EdgeVariant | `talk-${CommKind}`;

export interface LegendEntry {
  readonly key: LegendKey;
  /** What the line means, shown beside its swatch when it is on screen. */
  readonly label: string;
  /** Its short name in the "not on screen now" line. */
  readonly name: string;
  /** When it appears (the hover title of an absent entry). */
  readonly hint: string;
  /** How many are drawn now. */
  readonly count: number;
}

const LEGEND_TEXT: Readonly<Record<LegendKey, { readonly label: string; readonly name: string; readonly hint: string }>> = {
  dependency: {
    label: "dependency: goal or parent item -> item (proposed, split); item -> the revision that merged it; revision -> next revision",
    name: "dependency",
    hint: "goal links: select an item; revision links: hover a revision on the gate timeline",
  },
  fork: { label: "fork: a helper forked the requester's repo to help", name: "fork", hint: "fork: a helper copies a requester's repo" },
  merged: { label: "merged: a sub-lead merged a child item's push into its split item", name: "merged", hint: "merged: a sub-lead merges a child item (a large board nests children inside their parent instead)" },
  trigger: {
    label: "trigger: fix asked by a failing revision, an item waiting on a human, a tool's build published, a tool's findings filed as an item",
    name: "trigger",
    hint: "fix asked: open fix requests of the latest failing revision; also escalations to a human and tools",
  },
  "consumed-tool": { label: "consumed tool: an agent used a published tool", name: "consumed tool", hint: "consumed tool: an agent uses a published tool" },
  contest: { label: "contest: two agents claim the same file (until resolved)", name: "contest", hint: "contest: two agents claim the same file" },
  "contest-escalated": { label: "escalated contest: waiting on a human (pulsing)", name: "escalated contest", hint: "escalated contest: a contest handed to a human" },
  message: { label: "message: an addressed message (messages toggle: as they land, or all)", name: "message", hint: "message: turn messages on (as they land, or all)" },
  "talk-proposal": { label: "proposal", name: "talk: proposal", hint: "talk: an item or tool proposed, accepted, rejected, or re-planned (talk on)" },
  "talk-contract": { label: "contract", name: "talk: contract", hint: "talk: a contract proposed, decided, or escalated (talk on)" },
  "talk-help": { label: "help", name: "talk: help", hint: "talk: help asked, volunteered, offered, delivered, or declined (talk on)" },
  "talk-handoff": { label: "handoff", name: "talk: handoff", hint: "talk: an item handed to another agent (talk on)" },
  "talk-conflict": { label: "conflict", name: "talk: conflict", hint: "talk: a claim contested, kept, ceded, narrowed, overlapping, or a predicted clash (talk on)" },
};

/**
 * The legend for what is drawn now: one entry per edge variant and talk kind
 * on screen (with its count), and the ones not on screen (with when they
 * appear). Pure: a function of the drawn edges and talk arrows only.
 */
export function drawnLegend(
  edges: readonly BoardGraphEdge[],
  arrows: readonly Pick<CommArrow, "kind">[],
): { readonly present: readonly LegendEntry[]; readonly absent: readonly LegendEntry[] } {
  const counts = new Map<LegendKey, number>();
  for (const e of edges) {
    const v = edgeVariant(e);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const a of arrows) counts.set(`talk-${a.kind}`, (counts.get(`talk-${a.kind}`) ?? 0) + 1);
  const keys: LegendKey[] = [...EDGE_VARIANTS, ...COMM_KINDS.map((k): LegendKey => `talk-${k}`)];
  const entries = keys.map((key): LegendEntry => ({ key, ...LEGEND_TEXT[key], count: counts.get(key) ?? 0 }));
  return { present: entries.filter((e) => e.count > 0), absent: entries.filter((e) => e.count === 0) };
}

// ---------------------------------------------------------------------------
// The gate timeline
// ---------------------------------------------------------------------------

/** One integrated revision on the gate timeline (backed by its integrated.rev). */
export interface GateMarker {
  readonly n: number;
  readonly seq: number;
  readonly verdict: "pass" | "fail" | "no-gate";
  /** The verdict text, exactly as the revision node reads it. */
  readonly verdictLabel: string;
  /** The acceptance suite's count, when it ran and was recognized. */
  readonly acceptance?: { readonly passed: number; readonly total: number };
  /** Why the acceptance suite has no count on this revision. */
  readonly acceptanceNotRun?: string;
  /** The short count shown on the marker (`16/20`, `--` when the suite did not run, or all tests). */
  readonly count: string;
  /** The items whose pushes this revision merged (its dependency edges). */
  readonly mergedItems: readonly string[];
  /** Items the failing gate implicated. */
  readonly implicated: readonly string[];
  /** The latest passing (gated) revision at K: the one that would land. */
  readonly landed: boolean;
  readonly tooltip: string;
}

/**
 * The gate timeline at K: one marker per integrated revision in the model, in
 * order. Read from the revision nodes and their recorded edges only.
 */
export function gateTimeline(model: BoardGraphModel, log: readonly BoardMessage[]): GateMarker[] {
  const bySeq = new Map(log.map((m) => [m.seq, m]));
  const revNodes = model.nodes.filter((n) => n.detail.kind === "rev");
  const lastPass = [...revNodes].reverse().find((n) => n.detail.kind === "rev" && n.detail.gate === "pass" && n.detail.gated);
  return revNodes.flatMap((node) => {
    const d = node.detail;
    if (d.kind !== "rev") return [];
    const m = bySeq.get(node.seqs[0]!);
    const progress = m?.type === "integrated.rev" ? m.payload.progress : undefined;
    const acceptance = progress ? acceptanceOf(progress) : undefined;
    const notRun = progress?.acceptanceNotRun;
    const merged = model.edges
      .filter((e) => e.kind === "dependency" && e.to === node.id && e.from.startsWith("item:"))
      .map((e) => e.from.slice("item:".length));
    const verdict = !d.gated ? "no-gate" : d.gate;
    const count = acceptance
      ? `${acceptance.passed}/${acceptance.total}`
      : notRun !== undefined
        ? "--"
        : progress && progress.total > 0
          ? `${progress.passed}/${progress.total}`
          : "";
    return [
      {
        n: d.n,
        seq: node.seqs[0]!,
        verdict,
        verdictLabel: d.verdictLabel,
        ...(acceptance ? { acceptance } : {}),
        ...(notRun !== undefined ? { acceptanceNotRun: notRun } : {}),
        count,
        mergedItems: merged,
        implicated: d.failing?.items ?? [],
        landed: node === lastPass,
        tooltip: `rev ${d.n} ${d.verdictLabel}${acceptance ? `, acceptance ${acceptance.passed}/${acceptance.total}` : notRun !== undefined ? `, acceptance did not run: ${notRun}` : ""}; merged ${merged.length} item(s) (seq ${node.seqs[0]}, integrated.rev)`,
      },
    ];
  });
}

/** The edges a revision owns in the graph: item -> rev (merged pushes) and rev -> item (fix asked, reopened). */
export function revisionLinks(model: BoardGraphModel, n: number): BoardGraphEdge[] {
  const id = `rev:${n}`;
  return model.edges.filter(
    (e) => (e.kind === "dependency" && e.to === id && e.from.startsWith("item:")) || (e.kind === "trigger" && e.from === id && e.to.startsWith("item:")),
  );
}

// ---------------------------------------------------------------------------
// Acceptance over revisions
// ---------------------------------------------------------------------------

type RevProgress = NonNullable<Extract<BoardMessage, { readonly type: "integrated.rev" }>["payload"]["progress"]>;

function acceptanceOf(p: RevProgress): { passed: number; total: number } | undefined {
  if (p.acceptance) return { passed: p.acceptance.passed, total: p.acceptance.total };
  const suite = p.suites?.find((s) => s.suite === "acceptance");
  return suite ? { passed: suite.passed, total: suite.total } : undefined;
}

function developerOf(p: RevProgress): { passed: number; total: number } | undefined {
  const suites = (p.suites ?? []).filter((s) => s.suite === "developer");
  if (suites.length === 0) return undefined;
  return { passed: suites.reduce((a, s) => a + s.passed, 0), total: suites.reduce((a, s) => a + s.total, 0) };
}

/** One revision's point on a suite's chart: a count, or a gap with its stated reason (never a zero). */
export interface ChartPoint {
  readonly n: number;
  readonly seq: number;
  readonly passed?: number;
  readonly total?: number;
  /** No count on this revision: why (`acceptance did not run: typecheck failed`). */
  readonly gap?: string;
  readonly verdict: "pass" | "fail" | "no-gate";
}

/** A speculative candidate's count, drawn beside the revision of its round. */
export interface ChartCandidate {
  readonly seq: number;
  readonly round: number;
  readonly index: number;
  /** The revision it is drawn at (its own, or its round's). */
  readonly n: number;
  readonly passed: number;
  readonly total: number;
  readonly verdict: "pass" | "fail";
  readonly outcome: "landed" | "passed" | "blamed" | "retest";
}

export interface SuiteSeries {
  readonly suite: "acceptance" | "developer" | "tests";
  readonly points: readonly ChartPoint[];
  readonly candidates: readonly ChartCandidate[];
  /** The largest recorded total: the line the gate's checks add up to. */
  readonly total: number;
}

export interface ProgressChart {
  readonly series: readonly SuiteSeries[];
  /** The latest passing (gated) revision at K, if any. */
  readonly landed?: number;
}

/**
 * The acceptance-over-revisions chart data at K, per suite, from each
 * integrated revision's recorded (advisory) progress. A revision whose
 * acceptance suite did not run is a GAP with its reason, never a zero. The
 * developer series appears only when a revision recorded developer suites;
 * when no revision labelled any suite, one `tests` series of all checks
 * stands in. Speculative candidates with recorded progress are attached at
 * the revision of their round.
 */
export function progressChart(log: readonly BoardMessage[], k: number): ProgressChart {
  const messages = boardPrefix(log, k);
  const revs = messages.flatMap((m) => (m.type === "integrated.rev" ? [m] : []));
  if (revs.length === 0) return { series: [] };
  const verdictOf = (p: { gate: "pass" | "fail"; gated?: false }) => (p.gated === false ? "no-gate" : p.gate);
  const landed = [...revs].reverse().find((m) => m.payload.gate === "pass" && m.payload.gated !== false)?.payload.n;
  const anyAcceptance = revs.some((m) => m.payload.progress && (acceptanceOf(m.payload.progress) || m.payload.progress.acceptanceNotRun !== undefined));
  const anyDeveloper = revs.some((m) => m.payload.progress && developerOf(m.payload.progress));
  // Candidates: their own revision, else the revision their round recorded.
  const candidateMsgs = messages.flatMap((m) => (m.type === "candidate.gated" ? [m] : []));
  const roundRev = new Map<number, number>();
  for (const c of candidateMsgs) if (c.payload.rev !== undefined && !roundRev.has(c.payload.round)) roundRev.set(c.payload.round, c.payload.rev);
  const candidatesFor = (pick: (p: RevProgress) => { passed: number; total: number } | undefined): ChartCandidate[] =>
    candidateMsgs.flatMap((c) => {
      const n = c.payload.rev ?? roundRev.get(c.payload.round);
      const counts = c.payload.progress ? pick(c.payload.progress) : undefined;
      if (n === undefined || !counts) return [];
      return [{ seq: c.seq, round: c.payload.round, index: c.payload.index, n, passed: counts.passed, total: counts.total, verdict: c.payload.verdict, outcome: c.payload.outcome }];
    });
  const build = (
    suite: SuiteSeries["suite"],
    pick: (p: RevProgress) => { passed: number; total: number } | undefined,
    gapOf: (p: RevProgress | undefined) => string,
  ): SuiteSeries => {
    const points: ChartPoint[] = revs.map((m) => {
      const p = m.payload.progress;
      const counts = p ? pick(p) : undefined;
      const base = { n: m.payload.n, seq: m.seq, verdict: verdictOf(m.payload) } as const;
      return counts ? { ...base, passed: counts.passed, total: counts.total } : { ...base, gap: gapOf(p) };
    });
    const candidates = candidatesFor(pick);
    const total = Math.max(0, ...points.map((p) => p.total ?? 0), ...candidates.map((c) => c.total));
    return { suite, points, candidates, total };
  };
  const series: SuiteSeries[] = [];
  if (anyAcceptance) {
    series.push(build("acceptance", acceptanceOf, (p) => (p?.acceptanceNotRun !== undefined ? `acceptance did not run: ${p.acceptanceNotRun}` : "no acceptance count recorded")));
  }
  if (anyDeveloper) {
    series.push(build("developer", developerOf, (p) => (p?.acceptanceNotRun !== undefined ? `no suite ran: ${p.acceptanceNotRun}` : "no developer count recorded")));
  }
  if (!anyAcceptance && !anyDeveloper && revs.some((m) => (m.payload.progress?.total ?? 0) > 0)) {
    series.push(
      build(
        "tests",
        (p) => (p.total > 0 ? { passed: p.passed, total: p.total } : undefined),
        () => "no test count recorded",
      ),
    );
  }
  return { series, ...(landed !== undefined ? { landed } : {}) };
}

/** The story line of a series: `10/20 -> 16/20 -> 20/20` (gaps read `--`), or first, best, last for a long run (`r1 --, best r6 35/129, r9 --`). */
export function seriesStory(series: SuiteSeries, maxSteps = 5): string {
  const text = (p: ChartPoint) => (p.passed !== undefined ? `${p.passed}/${p.total}` : "--");
  if (series.points.length <= maxSteps) return series.points.map(text).join(" -> ");
  const counted = series.points.filter((p) => p.passed !== undefined);
  const best = counted.reduce<ChartPoint | undefined>((b, p) => (!b || p.passed! > b.passed! ? p : b), undefined);
  const first = series.points[0]!;
  const last = series.points[series.points.length - 1]!;
  const parts = [`r${first.n} ${text(first)}`];
  if (best && best !== first && best !== last) parts.push(`best r${best.n} ${text(best)}`);
  parts.push(`r${last.n} ${text(last)}${best === last && best !== first ? " (best)" : ""}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Hull titles
// ---------------------------------------------------------------------------

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "").replace(/\/\*\*?$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/**
 * Smarter display titles for items whose ids are machine-shaped, from their
 * recorded origin: a SEAM item the engine filed for an accepted contract
 * (`seam-agent-3-contract-1`) reads `seam: money.ts` (the contract's recorded
 * target), and a tool's build item (`tool-scan-unit`) reads `tool: scan-unit`.
 * Every other item keeps the label it is given. The full id stays in the
 * tooltip and the detail pane.
 */
export function smartItemTitles(log: readonly BoardMessage[], base: ReadonlyMap<string, string>): Map<string, string> {
  const contractTarget = new Map<string, string>();
  const seamOf = new Map<string, string>();
  const toolItems = new Map<string, string>();
  for (const m of log) {
    if (m.type === "contract.proposed") contractTarget.set(m.payload.contract, m.payload.target);
    else if (m.type === "item.proposed" && m.payload.fromContract !== undefined) seamOf.set(m.payload.item, m.payload.fromContract);
    else if (m.type === "tool.proposed") toolItems.set(`tool-${m.payload.capability}`, m.payload.capability);
  }
  const out = new Map(base);
  const used = new Set<string>();
  for (const [id, label] of base) {
    const contract = seamOf.get(id);
    const target = contract !== undefined ? contractTarget.get(contract) : undefined;
    let next = label;
    if (target !== undefined) next = `seam: ${basename(target)}`;
    else if (toolItems.has(id)) next = `tool: ${toolItems.get(id)!}`;
    // Two seams on one file keep apart by their contract's agent.
    if (used.has(next) && contract !== undefined) next = `${next} (${contract.replace(/-contract-\d+$/, "")})`;
    used.add(next);
    out.set(id, next);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advisory decisions (Jev)
// ---------------------------------------------------------------------------

/** One advisory decision row (backed by its decision.recorded, and its decision.resolved when resolved). */
export interface JevRow {
  readonly node: string;
  readonly seq: number;
  readonly juncture: string;
  /** What it recommends (`yes`, `reject`, an item id), or the call's failure. */
  readonly recommendation: string;
  readonly confidence?: number;
  /** Confident enough to be used (still advisory). */
  readonly confident: boolean;
  /** The mechanical outcome, once resolved (never "correct"). */
  readonly outcome?: string;
  /** What it is about: a revision or a contract. */
  readonly about?: string;
  readonly error: boolean;
}

/** The advisory decisions at K, newest first. */
export function jevRows(model: BoardGraphModel): JevRow[] {
  return model.nodes
    .flatMap((n): JevRow[] => {
      const d = n.detail;
      if (d.kind !== "jev") return [];
      return [
        {
          node: n.id,
          seq: n.seqs[0]!,
          juncture: d.juncture,
          recommendation: d.error !== undefined ? "call failed" : (d.answer ?? "no answer"),
          ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
          confident: d.accepted,
          ...(d.resolved ? { outcome: d.resolved.text } : {}),
          ...(d.rev !== undefined ? { about: `rev ${d.rev}` } : d.contract !== undefined ? { about: d.contract } : {}),
          error: d.error !== undefined,
        },
      ];
    })
    .sort((a, b) => b.seq - a.seq);
}

/** Whether a message family is a coordination family (used for the legend count). */
export function isCoordination(type: BoardMessage["type"]): boolean {
  const family = boardMessageFamily(type);
  return family === "contract" || family === "contest" || type.startsWith("help.") || type === "handoff" || type === "claim.overlap" || type === "clash.predicted" || type === "item.replanned";
}

// ---------------------------------------------------------------------------
// Speculative rounds: what of a failing revision already landed
// ---------------------------------------------------------------------------

/** The pushes of a blamed (failing) speculative revision that a passing revision of its round landed. */
export interface LandedPart {
  /** The passing revision that landed them, and its candidate.gated record. */
  readonly rev: number;
  readonly seq: number;
  readonly items: readonly string[];
  readonly agents: readonly string[];
  readonly commits: readonly string[];
  /** The rest of the failing candidate's stack: the pushes the failure is about. */
  readonly failingItems: readonly string[];
  readonly failingAgents: readonly string[];
}

/**
 * For failing revision `n` of a speculative round (a blamed candidate: the
 * landed prefix plus the push that broke it), the pushes it shares with the
 * round's LANDED candidate. Those landed in a passing revision and are not
 * contributors to this failure. Undefined when `n` is not such a revision.
 */
export function speculativeLanded(log: readonly BoardMessage[], k: number, n: number): LandedPart | undefined {
  const candidates = boardPrefix(log, k).flatMap((m) => (m.type === "candidate.gated" ? [m] : []));
  const blamed = candidates.find((c) => c.payload.rev === n && c.payload.verdict === "fail");
  if (!blamed) return undefined;
  const landed = candidates.find((c) => c.payload.round === blamed.payload.round && c.payload.outcome === "landed" && c.payload.rev !== undefined);
  if (!landed || landed.payload.rev === undefined) return undefined;
  const landedCommits = new Set(landed.payload.prefix.map((p) => p.commit));
  const kept = blamed.payload.prefix.filter((p) => landedCommits.has(p.commit));
  if (kept.length === 0) return undefined;
  const rest = blamed.payload.prefix.filter((p) => !landedCommits.has(p.commit));
  const unique = (xs: readonly string[]) => [...new Set(xs)];
  return {
    rev: landed.payload.rev,
    seq: landed.seq,
    items: unique(kept.flatMap((p) => p.items)),
    agents: unique(kept.map((p) => p.agent)),
    commits: kept.map((p) => p.commit),
    failingItems: unique(rest.flatMap((p) => p.items)),
    failingAgents: unique(rest.map((p) => p.agent)),
  };
}

// ---------------------------------------------------------------------------
// The drawing's extent without the revision and decision columns
// ---------------------------------------------------------------------------

/** The minimal layout fields the drawing extent reads. */
interface ExtentLayout {
  readonly goal: { readonly x: number; readonly y: number };
  readonly human: { readonly x: number; readonly y: number };
  readonly leads: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly items: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>;
  readonly bench: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly tools: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
}

/**
 * The width and height the graph needs once revisions live on the gate
 * timeline and decisions in their panel: the hulls, the bench, the tools, the
 * goal, the lead, and the human. The fitted drawing then spends the pane on
 * the hulls instead of an empty column.
 */
export function drawingExtent(layout: ExtentLayout): { readonly width: number; readonly height: number } {
  let maxX = Math.max(layout.goal.x + 40, layout.human.x + 70);
  let maxY = layout.goal.y + 70;
  for (const p of layout.leads.values()) maxX = Math.max(maxX, p.x + 40);
  for (const r of layout.items.values()) {
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  for (const p of layout.bench.values()) {
    maxX = Math.max(maxX, p.x + 50);
    maxY = Math.max(maxY, p.y + 45);
  }
  for (const p of layout.tools.values()) {
    maxX = Math.max(maxX, p.x + 100);
    maxY = Math.max(maxY, p.y + 62);
  }
  return { width: Math.ceil(maxX + 24), height: Math.ceil(maxY + 12) };
}

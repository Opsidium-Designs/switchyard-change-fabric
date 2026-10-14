/**
 * The board graph at scale: a console-side layout for a LARGE board run (many
 * items or many agents), so 30 to 100 agents and 35 to 100 items stay
 * readable. A small board keeps the orchestration layout (`boardLayout`)
 * unchanged.
 *
 * A large board's top-level items are grouped into LANES: a split item (its
 * sub-lead's cluster, with its children nested inside) and the items that
 * share its domain prefix (`parking-meter-rates` -> `parking`), else their
 * scope directory (`src/billing/tax.ts` -> `billing`). Lanes are boxes packed
 * into columns (shortest column first), with the number of columns chosen so
 * the drawing is landscape and zooms to fit the pane. Item hulls are compact,
 * and free agents (idle, or left) collapse into one bench chip with counts
 * instead of a hundred dots.
 *
 * Like `boardLayout`, every position is a function of the FULL log (slots are
 * assigned on first appearance and never move while scrubbing). The layout
 * only places elements the graph model already backs with recorded messages;
 * it never adds a node, an edge, or a verdict. A lane's label and counts are
 * drawn from the model at K by the view.
 */
import {
  boardLayout,
  boardNodePoint,
  type BoardGraphModel,
  type BoardGraphNode,
  type BoardHullRect,
  type BoardLayout,
  type BoardMessage,
  type BoardPoint,
} from "@switchyard-change/orchestration/board-graph";

/** Above this many items (or LARGE_WORKERS workers) the board is drawn at scale. */
export const LARGE_ITEMS = 24;
export const LARGE_WORKERS = 16;

/** Compact hull sizes (a top-level hull, a nested child hull) and gaps. */
export const COMPACT_HULL_W = 190;
export const COMPACT_HULL_H = 92;
export const COMPACT_NESTED_H = 74;
/** Where the dot row sits below a compact hull's top (below its title bar). */
export const COMPACT_DOT_Y = 60;
export const COMPACT_NESTED_DOT_Y = 54;
/** The dot step and radius of an agent drawn inside a compact hull. */
export const COMPACT_DOT_STEP = 24;
export const COMPACT_DOT_R = 9;
/** A compact hull draws at most this many agent dots, else a count. */
export const COMPACT_MAX_AGENTS = 4;
const GAP = 20;
const NESTED_GAP = 8;
/** A lane's own header row and padding. */
export const LANE_HEAD = 26;
const LANE_PAD = 10;
const LANE_GAP = 32;
/** Items per lane row (a split item spans the whole row). */
const LANE_COLS = 2;
const TOP_BAND = 172;
const MARGIN = 24;
/** The bench chip (every free agent, as counts). */
export const BENCH_CHIP_W = 380;
export const BENCH_CHIP_H = 40;
/** The aspect (width / height) the lane packing aims for: a landscape pane. */
const TARGET_ASPECT = 1.5;

export interface BoardLane {
  /** The lane key: a domain prefix, a scope directory, a split item, or `other`. */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Its top-level items, in slot order (split items carry their children nested). */
  readonly items: readonly string[];
}

/** A board layout, plus what the scaled view draws: lanes, compact hulls, the bench chip. */
export interface ScaledBoardLayout extends BoardLayout {
  /** True for a large board: compact hulls, lanes, and the collapsed bench. */
  readonly compact: boolean;
  readonly lanes: readonly BoardLane[];
  /** Where the bench chip sits (large boards only); every bench agent's point is its center. */
  readonly benchChip?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

interface LogFacts {
  readonly itemOrder: readonly string[];
  readonly parentOf: ReadonlyMap<string, string>;
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly scopeOf: ReadonlyMap<string, readonly string[]>;
  readonly workers: readonly string[];
  readonly leads: readonly string[];
  readonly agentSlots: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly revs: readonly number[];
  readonly tools: readonly string[];
  readonly jev: readonly number[];
}

function readLog(log: readonly BoardMessage[]): LogFacts {
  const itemOrder: string[] = [];
  const seen = new Set<string>();
  const scopeOf = new Map<string, readonly string[]>();
  const addItem = (id: string, scope?: readonly string[]): void => {
    if (!seen.has(id)) {
      seen.add(id);
      itemOrder.push(id);
    }
    if (scope !== undefined && !scopeOf.has(id)) scopeOf.set(id, scope);
  };
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const agentSlots = new Map<string, Map<string, number>>();
  const associate = (item: string, agent: string): void => {
    const slots = agentSlots.get(item) ?? new Map<string, number>();
    if (!slots.has(agent)) slots.set(agent, slots.size);
    agentSlots.set(item, slots);
  };
  const leads: string[] = [];
  const workers: string[] = [];
  const revs: number[] = [];
  const tools: string[] = [];
  const jev: number[] = [];
  for (const m of log) {
    switch (m.type) {
      case "item.proposed":
        addItem(m.payload.item, m.payload.scopeHint);
        break;
      case "item.discovered":
        addItem(m.payload.item, m.payload.scopeHint);
        break;
      case "item.split":
      case "item.replanned":
        for (const c of m.payload.children) {
          addItem(c.item, c.scopeHint);
          if (!parentOf.has(c.item)) {
            parentOf.set(c.item, m.payload.item);
            childrenOf.set(m.payload.item, [...(childrenOf.get(m.payload.item) ?? []), c.item]);
          }
        }
        break;
      case "item.claimed":
        associate(m.payload.item, m.from);
        break;
      case "claim.granted":
        associate(m.payload.item, m.payload.agent);
        break;
      case "claim.contested":
        associate(m.payload.item, m.payload.claimant);
        break;
      case "handoff":
        associate(m.payload.item, m.payload.to);
        break;
      case "agent.joined":
        (m.payload.role === "lead" ? leads : workers).push(m.from);
        break;
      case "integrated.rev":
        revs.push(m.payload.n);
        break;
      case "tool.proposed":
      case "tool.published":
        if (!tools.includes(m.payload.capability)) tools.push(m.payload.capability);
        break;
      case "decision.recorded":
        jev.push(m.seq);
        break;
      default:
        break;
    }
  }
  return { itemOrder, parentOf, childrenOf, scopeOf, workers, leads, agentSlots, revs, tools, jev };
}

/** True when the board needs the scaled layout (many items or many agents). */
export function isLargeBoard(log: readonly BoardMessage[]): boolean {
  const facts = readLog(log);
  return facts.itemOrder.length > LARGE_ITEMS || facts.workers.length > LARGE_WORKERS;
}

/** The item count above which Board cards are compact. */
export function compactCards(itemCount: number): boolean {
  return itemCount > LARGE_ITEMS;
}

const PLANNER_PREFIX = /^(?:unit|item|u)-(?=[A-Za-z0-9])/;
/** An item a worker proposed: the board names it after its proposer (`agent-1-item-1`). */
const AGENT_PROPOSED = /^agent-\d+-/;
/** Source roots a scope directory skips (`src/billing` is the `billing` domain). */
const SCOPE_ROOTS = new Set(["src", "lib", "app", "apps", "packages"]);

/** The first token of an item id (`parking-meter-rates` -> `parking`, `permits.fee` -> `permits`), or undefined for a one-token id. */
export function domainPrefix(item: string): string | undefined {
  const stripped = item.replace(PLANNER_PREFIX, "");
  const m = /^([A-Za-z0-9]+)[-._/]/.exec(stripped);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** The scope directory of an item (`src/billing/tax.ts` -> `billing`), from its first scope hint. */
export function scopeDirectory(scope: readonly string[] | undefined): string | undefined {
  const first = scope?.[0];
  if (first === undefined) return undefined;
  const parts = first.split("/").filter((p) => p !== "" && p !== "." && !p.includes("*"));
  // The last segment of a file path is the file, not a directory.
  if (parts.length > 0 && parts[parts.length - 1]!.includes(".")) parts.pop();
  return parts.filter((p) => !SCOPE_ROOTS.has(p))[0]?.toLowerCase();
}

/**
 * The lane of every top-level item: a split item's lane is its domain (its id,
 * or its prefix); other items join the lane of their domain prefix when two or
 * more items share it, else of their scope directory when shared, else `other`.
 * A prefix more than half the board shares, over two or more shared scope
 * directories, is an action verb, not a domain: those items take their
 * directory's lane.
 */
export function boardLanes(
  topLevel: readonly string[],
  isSplit: (item: string) => boolean,
  scopeOf: (item: string) => readonly string[] | undefined,
): Map<string, string> {
  const prefixCount = new Map<string, number>();
  const dirCount = new Map<string, number>();
  const prefixOf = new Map<string, string>();
  const dirOf = new Map<string, string>();
  for (const item of topLevel) {
    // An agent-proposed id (`agent-1-item-1`) names who proposed it, not a domain.
    const prefix = AGENT_PROPOSED.test(item)
      ? undefined
      : (domainPrefix(item) ?? (isSplit(item) ? item.replace(PLANNER_PREFIX, "").toLowerCase() : undefined));
    if (prefix !== undefined) {
      prefixOf.set(item, prefix);
      prefixCount.set(prefix, (prefixCount.get(prefix) ?? 0) + 1);
    }
    const dir = scopeDirectory(scopeOf(item));
    if (dir !== undefined) {
      dirOf.set(item, dir);
      dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
    }
  }
  // A prefix most of the board shares (a fanned-out action's verb, `validate-src-...`)
  // says nothing about where the work is: when its items' scope directories
  // split it into shared domains, those win.
  const prefixDirs = new Map<string, Set<string>>();
  for (const item of topLevel) {
    const prefix = prefixOf.get(item);
    const dir = dirOf.get(item);
    if (prefix !== undefined && dir !== undefined && (dirCount.get(dir) ?? 0) >= 2) {
      prefixDirs.set(prefix, (prefixDirs.get(prefix) ?? new Set()).add(dir));
    }
  }
  const verbLike = (prefix: string) => (prefixCount.get(prefix) ?? 0) * 2 > topLevel.length && (prefixDirs.get(prefix)?.size ?? 0) >= 2;
  const lanes = new Map<string, string>();
  for (const item of topLevel) {
    const prefix = prefixOf.get(item);
    const dir = dirOf.get(item);
    if (prefix !== undefined && !isSplit(item) && verbLike(prefix) && dir !== undefined && (dirCount.get(dir) ?? 0) >= 2) lanes.set(item, dir);
    else if (prefix !== undefined && (isSplit(item) || (prefixCount.get(prefix) ?? 0) >= 2)) lanes.set(item, prefix);
    // A split agent-proposed item: its scope's domain, else its own id.
    else if (prefix === undefined && isSplit(item)) lanes.set(item, dir ?? item.toLowerCase());
    else if (dir !== undefined && ((dirCount.get(dir) ?? 0) >= 2 || prefixCount.has(dir))) lanes.set(item, dir);
    else lanes.set(item, "other");
  }
  return lanes;
}

/**
 * The layout of a board run from its FULL log: the orchestration layout for a
 * small board, else the scaled lane layout (compact hulls, collapsed bench).
 */
export function scaledBoardLayout(log: readonly BoardMessage[]): ScaledBoardLayout {
  const facts = readLog(log);
  if (facts.itemOrder.length <= LARGE_ITEMS && facts.workers.length <= LARGE_WORKERS) {
    return { ...boardLayout(log), compact: false, lanes: [] };
  }
  const { itemOrder, parentOf, childrenOf } = facts;
  const slotOf = new Map(itemOrder.map((id, slot) => [id, slot]));
  const topLevel = itemOrder.filter((id) => !parentOf.has(id));
  const laneOf = boardLanes(topLevel, (id) => (childrenOf.get(id)?.length ?? 0) > 0, (id) => facts.scopeOf.get(id));
  const laneKeys: string[] = [];
  const laneItems = new Map<string, string[]>();
  for (const item of topLevel) {
    const key = laneOf.get(item) ?? "other";
    if (!laneItems.has(key)) {
      laneKeys.push(key);
      laneItems.set(key, []);
    }
    laneItems.get(key)!.push(item);
  }
  // `other` (items that share nothing) goes last.
  if (laneItems.has("other")) laneKeys.push(...laneKeys.splice(laneKeys.indexOf("other"), 1));

  const rowW = LANE_COLS * COMPACT_HULL_W + (LANE_COLS - 1) * GAP;
  const laneW = rowW + 2 * LANE_PAD;
  // A hull's height at width w (its own band, then its children two per row).
  const heightOf = (id: string, w: number, depth: number): number => {
    const own = depth === 0 ? COMPACT_HULL_H : COMPACT_NESTED_H;
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) return own;
    const perRow = w >= 2 * 80 + 3 * NESTED_GAP ? 2 : 1;
    const kw = (w - (perRow + 1) * NESTED_GAP) / perRow;
    let total = own;
    for (let i = 0; i < kids.length; i += perRow) {
      total += Math.max(...kids.slice(i, i + perRow).map((k) => heightOf(k, kw, depth + 1))) + NESTED_GAP;
    }
    return total;
  };
  // The rows of a lane: a split item takes a whole row, others pair up.
  const laneRows = (items: readonly string[]): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    for (const item of items) {
      if ((childrenOf.get(item)?.length ?? 0) > 0) {
        if (row.length > 0) rows.push(row);
        rows.push([item]);
        row = [];
        continue;
      }
      row.push(item);
      if (row.length === LANE_COLS) {
        rows.push(row);
        row = [];
      }
    }
    if (row.length > 0) rows.push(row);
    return rows;
  };
  const rowHeight = (row: readonly string[]): number =>
    row.length === 1 && (childrenOf.get(row[0]!)?.length ?? 0) > 0 ? heightOf(row[0]!, rowW, 0) : COMPACT_HULL_H;
  const laneHeight = (key: string): number => {
    const rows = laneRows(laneItems.get(key)!);
    return LANE_HEAD + LANE_PAD + rows.reduce((h, row) => h + rowHeight(row), 0) + (rows.length - 1) * GAP + LANE_PAD;
  };
  const heights = new Map(laneKeys.map((k) => [k, laneHeight(k)]));

  // Pack the lanes into m columns (shortest first), m chosen for a landscape drawing.
  const pack = (m: number): { col: number; y: number }[] => {
    const tops = new Array<number>(m).fill(0);
    return laneKeys.map((k) => {
      let col = 0;
      for (let c = 1; c < m; c += 1) if (tops[c]! < tops[col]!) col = c;
      const y = tops[col]!;
      tops[col] = y + heights.get(k)! + LANE_GAP;
      return { col, y };
    });
  };
  let best = { m: 1, score: Number.POSITIVE_INFINITY };
  for (let m = 1; m <= Math.max(1, Math.min(8, laneKeys.length)); m += 1) {
    const placed = pack(m);
    const h = Math.max(...placed.map((p, i) => p.y + heights.get(laneKeys[i]!)!));
    const w = m * laneW + (m - 1) * LANE_GAP;
    const score = Math.abs(Math.log(w / (h + TOP_BAND + 120) / TARGET_ASPECT));
    if (score < best.score - 1e-9) best = { m, score };
  }
  const placed = pack(best.m);

  const items = new Map<string, BoardHullRect>();
  const place = (id: string, x: number, y: number, w: number, depth: number, parent?: string): number => {
    const h = heightOf(id, w, depth);
    items.set(id, { x, y, w, h, slot: slotOf.get(id) ?? 0, ...(parent !== undefined ? { parent, depth } : {}) });
    const kids = childrenOf.get(id) ?? [];
    const perRow = w >= 2 * 80 + 3 * NESTED_GAP ? 2 : 1;
    const kw = (w - (perRow + 1) * NESTED_GAP) / perRow;
    let rowY = y + (depth === 0 ? COMPACT_HULL_H : COMPACT_NESTED_H);
    for (let i = 0; i < kids.length; i += perRow) {
      const row = kids.slice(i, i + perRow);
      rowY += Math.max(...row.map((k, j) => place(k, x + NESTED_GAP + j * (kw + NESTED_GAP), rowY, kw, depth + 1, id))) + NESTED_GAP;
    }
    return h;
  };
  const lanes: BoardLane[] = [];
  laneKeys.forEach((key, i) => {
    const { col, y } = placed[i]!;
    const lx = MARGIN + col * (laneW + LANE_GAP);
    const ly = TOP_BAND + y;
    let rowY = ly + LANE_HEAD + LANE_PAD;
    for (const row of laneRows(laneItems.get(key)!)) {
      if (row.length === 1 && (childrenOf.get(row[0]!)?.length ?? 0) > 0) {
        place(row[0]!, lx + LANE_PAD, rowY, rowW, 0);
      } else {
        row.forEach((item, c) => place(item, lx + LANE_PAD + c * (COMPACT_HULL_W + GAP), rowY, COMPACT_HULL_W, 0));
      }
      rowY += rowHeight(row) + GAP;
    }
    lanes.push({ key, x: lx, y: ly, w: laneW, h: heights.get(key)!, items: laneItems.get(key)! });
  });

  const gridW = best.m * laneW + (best.m - 1) * LANE_GAP;
  const gridBottom = Math.max(TOP_BAND, ...lanes.map((l) => l.y + l.h));
  const benchChip = { x: MARGIN, y: gridBottom + 24, w: BENCH_CHIP_W, h: BENCH_CHIP_H };
  const chipCenter = { x: benchChip.x + benchChip.w / 2, y: benchChip.y + benchChip.h / 2 };
  const bench = new Map<string, BoardPoint>(facts.workers.map((agent) => [agent, chipCenter]));
  const tools = new Map<string, BoardPoint>();
  facts.tools.forEach((cap, i) => tools.set(cap, { x: MARGIN + BENCH_CHIP_W + 120 + i * 200, y: benchChip.y + 22 }));
  const goal = { x: MARGIN + gridW / 2, y: 58 };
  const leads = new Map<string, BoardPoint>();
  facts.leads.forEach((agent, i) => leads.set(agent, { x: Math.max(MARGIN + 40, goal.x - 230 - i * 70), y: 64 }));
  const human = { x: goal.x + 230, y: 64 };
  const revX = MARGIN + gridW - 40;
  const revs = new Map<number, BoardPoint>(facts.revs.map((n, i) => [n, { x: revX, y: TOP_BAND + 30 + i * 76 }]));
  const jev = new Map<number, BoardPoint>(facts.jev.map((seq, i) => [seq, { x: revX, y: TOP_BAND + 30 + (facts.revs.length + i) * 44 }]));
  const width = Math.max(MARGIN * 2 + gridW, human.x + 120, 640);
  const height = benchChip.y + benchChip.h + (facts.tools.length > 0 ? 70 : 0) + MARGIN;
  return {
    width,
    height,
    goal,
    human,
    leads,
    items,
    agentSlots: facts.agentSlots,
    bench,
    revs,
    tools,
    jev,
    compact: true,
    lanes,
    benchChip,
  };
}

/** Where an agent's dot sits inside a compact hull: a row below the title, by its index in the hull's agents at K. */
export function compactAgentPoint(hull: BoardHullRect, index: number, dot: CompactDot = { r: COMPACT_DOT_R, step: COMPACT_DOT_STEP }): BoardPoint {
  const nested = (hull.depth ?? 0) > 0;
  const perRow = Math.max(1, Math.min(COMPACT_MAX_AGENTS, Math.floor((hull.w - 24) / dot.step)));
  return { x: hull.x + 18 + (index % perRow) * dot.step, y: hull.y + (nested ? COMPACT_NESTED_DOT_Y : COMPACT_DOT_Y) };
}

/** The largest compact dot radius: the dot row keeps clear of the title bar and the hull's done and struggling marks. */
export const COMPACT_DOT_R_MAX = 14;

/** A compact hull's dot: its radius and the step between dots. */
export interface CompactDot {
  readonly r: number;
  readonly step: number;
}

/**
 * The dot an agent is drawn with in a compact hull at a drawing boost. The
 * text of a fitted drawing is boosted (textBoost) so it keeps a minimum
 * on-screen size; the dots grow by the SAME factor, so a large board's dots
 * keep their size next to its titles instead of shrinking under them. The
 * growth is capped so the hull's dots (up to COMPACT_MAX_AGENTS) still fit
 * one row left of the hull's marks: radius COMPACT_DOT_R (the unboosted size)
 * to COMPACT_DOT_R_MAX, step 2r + 4. A hull too narrow for bigger dots keeps
 * the unboosted dot.
 */
export function compactDot(hullWidth: number, agents: number, boost = 1): CompactDot {
  const n = Math.max(1, Math.min(COMPACT_MAX_AGENTS, agents));
  const wanted = Math.min(COMPACT_DOT_R_MAX, Math.max(COMPACT_DOT_R, COMPACT_DOT_R * (Number.isFinite(boost) ? boost : 1)));
  // The row runs from x = 18 and ends 40 short of the hull's right edge (the done check and struggling mark).
  const room = hullWidth - 40 - 18;
  // 18 + (n - 1) * (2r + 4) + r <= hullWidth - 40
  const fits = Math.floor((room - (n - 1) * 4) / (2 * (n - 1) + 1));
  const r = Math.max(COMPACT_DOT_R, Math.min(wanted, fits));
  return { r, step: Math.max(COMPACT_DOT_STEP, Math.ceil(2 * r + 4)) };
}

/**
 * The position of a node at K in a scaled layout: the orchestration point on a
 * small board; on a large board an agent in a hull sits in the hull's dot row
 * (a sub-lead on its split hull's left border, level with that row).
 */
export function scaledNodePoint(layout: ScaledBoardLayout, node: BoardGraphNode, model: BoardGraphModel | null = null, boost = 1): BoardPoint | undefined {
  if (!layout.compact || node.detail.kind !== "agent" || node.kind === "lead" || node.detail.hull === undefined) {
    return boardNodePoint(layout, node);
  }
  const d = node.detail;
  const hull = layout.items.get(d.hull!);
  if (!hull) return boardNodePoint(layout, node);
  if (d.subLeadOf?.includes(d.hull!)) return { x: hull.x, y: hull.y + COMPACT_DOT_Y };
  const itemNode = model?.nodes.find((n) => n.id === `item:${d.hull}`);
  const agents = itemNode?.detail.kind === "item" ? itemNode.detail.agents : [];
  const index = Math.max(0, agents.indexOf(d.agent));
  return compactAgentPoint(hull, index, compactDot(hull.w, agents.length, boost));
}

/** The bench at K: free agents still on the board (idle) and those who left, for the bench chip. */
export function benchCounts(model: BoardGraphModel): { readonly idle: readonly string[]; readonly left: readonly string[] } {
  const idle: string[] = [];
  const left: string[] = [];
  for (const n of model.nodes) {
    if (n.detail.kind !== "agent" || n.kind === "lead" || n.detail.hull !== undefined) continue;
    (n.detail.left ? left : idle).push(n.detail.agent);
  }
  return { idle, left };
}

/** The bench chip's line: only the counts that are not zero (`bench: 64 idle, 3 left`). */
export function benchLine(idle: number, left: number): string {
  const parts = [...(idle > 0 ? [`${idle} idle`] : []), ...(left > 0 ? [`${left} left`] : [])];
  return `bench: ${parts.join(", ")}`;
}

/** One sub-lead's team at K: the split item(s) it leads and the active agents working inside them. */
export interface SubLeadTeam {
  readonly agent: string;
  readonly items: readonly string[];
  /** Active agents in the split item's hull or its children's hulls (the sub-lead included). */
  readonly active: number;
}

/** The sub-leads at K, with how many active agents work under each (for the ticker). */
export function subLeadTeams(model: BoardGraphModel): SubLeadTeam[] {
  const parentOf = new Map<string, string>();
  for (const n of model.nodes) {
    if (n.detail.kind === "item" && n.detail.parent !== undefined) parentOf.set(n.detail.item, n.detail.parent);
  }
  const rootOf = (item: string): string => {
    let at = item;
    for (let guard = 0; guard < 16 && parentOf.has(at); guard += 1) at = parentOf.get(at)!;
    return at;
  };
  const teams: SubLeadTeam[] = [];
  const agents = model.nodes.filter((n) => n.detail.kind === "agent" && n.kind !== "lead");
  for (const n of agents) {
    if (n.detail.kind !== "agent" || n.detail.subLeadOf === undefined || n.detail.left) continue;
    const led = new Set(n.detail.subLeadOf);
    // The sub-lead itself (it is not left) and every active agent drawn in its split item or a child of it.
    const self = n.detail.agent;
    const active = agents.filter(
      (a) =>
        a.detail.kind === "agent" &&
        !a.detail.left &&
        (a.detail.agent === self || (a.detail.hull !== undefined && (led.has(a.detail.hull) || led.has(rootOf(a.detail.hull))))),
    ).length;
    teams.push({ agent: self, items: n.detail.subLeadOf, active });
  }
  return teams;
}

/** A lane's caption at K: its key, its items done of shown, and its sub-lead(s); undefined when none of its items exist yet. */
export function laneCaption(
  lane: BoardLane,
  model: BoardGraphModel,
): { readonly title: string; readonly detail: string; readonly subLeads: readonly string[] } | undefined {
  const byItem = new Map<string, BoardGraphNode>();
  for (const n of model.nodes) if (n.detail.kind === "item") byItem.set(n.detail.item, n);
  const present = lane.items.filter((id) => byItem.has(id));
  if (present.length === 0) return undefined;
  // Count the lane's work units: a split item counts by its children.
  const units: BoardGraphNode[] = [];
  const add = (id: string): void => {
    const n = byItem.get(id);
    if (!n || n.detail.kind !== "item") return;
    if (n.detail.children.length > 0) n.detail.children.forEach(add);
    else units.push(n);
  };
  present.forEach(add);
  const done = units.filter((n) => n.status === "done").length;
  const subLeads = present.flatMap((id) => {
    const n = byItem.get(id);
    return n?.detail.kind === "item" && n.detail.subLead !== undefined ? [n.detail.subLead] : [];
  });
  return {
    title: lane.key,
    detail: `${done}/${units.length} done`,
    subLeads,
  };
}

/**
 * A compact hull's title: the part of the item id after its parent item or
 * its lane (`permits.fee-calc` in `permits` reads `fee-calc`,
 * `parking-meter-rates` in lane `parking` reads `meter-rates`). A label that
 * is not the id's own tail (a seam or tool item read by its origin) is kept.
 * The full id stays in the hull's tooltip.
 */
export function compactHullTitle(item: string, label: string, context: string | undefined): string {
  if (context === undefined || context === "other") return label;
  const stripped = item.replace(PLANNER_PREFIX, "");
  const head = context.replace(PLANNER_PREFIX, "").toLowerCase();
  // An origin label that starts with the lane's own word (`seam: fees.ts` in lane `seam`) drops it.
  if (label.toLowerCase().startsWith(`${head}: `) && label.length > head.length + 2) return label.slice(head.length + 2);
  for (const sep of [".", "-", "_", "/"]) {
    if (stripped.toLowerCase().startsWith(`${head}${sep}`) && stripped.length > head.length + 1) {
      const rest = stripped.slice(head.length + 1);
      // Only when the label is the id or a shortening of it: a label read from the item's origin stays.
      return label === item || label === stripped || rest.endsWith(label) || label.endsWith(rest) ? rest : label;
    }
  }
  // The lane's word inside the id (`validate-src-parking-appeals` in lane `parking`),
  // or leading a shortened label of it (`parking-appeals`): what follows it.
  if (label === item || label === stripped || stripped.endsWith(label)) {
    const lower = label.toLowerCase();
    for (const sep of [".", "-", "_", "/"]) {
      if (lower.startsWith(`${head}${sep}`) && label.length > head.length + 1) return label.slice(head.length + 1);
      const at = lower.indexOf(`${sep}${head}${sep}`);
      if (at >= 0 && at + head.length + 2 < label.length) return label.slice(at + head.length + 2);
    }
  }
  return label;
}

/** A short "a, b, c and N more" list (for folded lists and titles). */
export function shortList(names: readonly string[], max: number): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
}

/** Whether a model point exists for an agent drawn on the collapsed bench. */
export function onBenchChip(layout: ScaledBoardLayout, node: BoardGraphNode): boolean {
  return layout.compact && node.detail.kind === "agent" && node.kind !== "lead" && node.detail.hull === undefined;
}

export type { BoardHullRect };

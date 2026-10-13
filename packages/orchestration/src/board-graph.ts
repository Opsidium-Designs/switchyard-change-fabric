/**
 * board-graph: the pure projection from a Change BOARD log to the typed graph
 * the console's mission-control view renders for a board run.
 *
 * The graph at seq K is a function of `log[0..K]` only: the board state comes
 * from `foldBoard(log, K)` (the same reducer the board itself uses), and every
 * node and edge is derived from recorded messages at or before K. Replaying a
 * run is therefore the same function at a smaller K, so replay cannot show
 * anything the board did not record.
 *
 * Honesty (no-unbacked-node): every node and edge carries the seq(s) of the
 * board messages that back it, and `assertBoardBacked` re-checks each one
 * against the log (the seq exists, is at or before K, and has a type that can
 * back that element). `buildBoardGraph` runs it before returning, so a
 * decorative element cannot reach the screen.
 *
 * Edge kinds: `dependency | spawn | trigger | consumed-tool` as for run-live,
 * plus `message` (an addressed or replying board message between participants)
 * and `contest` (an open claim contest between two agents). Each `message`
 * and `contest` edge is backed by its recorded message seq. A `spawn` edge
 * means only that an Artifact repo-pushed event recruited the target; the
 * board has no such message, so a board graph never draws one. Formation
 * reuses `dependency`, labelled: a FORK edge (requester -> helper) is backed by
 * the help.offered that recorded the fork, and a MERGED edge (child -> split
 * item) by the sub-lead's push that merged the child's push.
 *
 * Gate verdicts appear only on revision nodes (and the ticker). Typed
 * decisions (Jev) are advisory nodes; a resolved attribution reads where the
 * pick landed ("changed before the next pass"), never "correct".
 *
 * Layout (`boardLayout`) is computed from the FULL log, never from K: an item
 * gets a slot on its first appearance (in seq order) and keeps it, agents sit
 * at stable sub-slots inside an item hull (by their first association with
 * the item), and revisions form a chain to the side, so scrubbing never moves
 * anything that has not changed.
 *
 * No I/O, no clock, no React: it runs the same in the browser and in tests.
 */

import {
  contractTriageRecommendation,
  describeProgress,
  describeWaitReason,
  itemWaitReason,
  liveClashes,
  progressHeadline,
  foldBoard,
  toolItemId,
  type BoardItemStatus,
  type BoardMessage,
  type BoardMessageOf,
  type BoardMessageType,
  type BoardPayloads,
  type BoardRules,
  type BoardState,
  type BoardTestInventory,
  type BoardWaitReason,
} from "@switchyard-change/change-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { BoardMessage, BoardState } from "@switchyard-change/change-core";
// Re-exported so the console can validate a recorded log with the board's own
// reducer through its declared dependency on this package.
export { reduceBoard } from "@switchyard-change/change-core";
// The pre-pass ratchet's one line for the board pane (arbitration revision 5; never a verdict).
export { ratchetLine } from "@switchyard-change/change-core";

export type BoardGraphNodeKind = "goal" | "lead" | "agent" | "item" | "rev" | "tool" | "jev" | "human";

/**
 * The edge kinds of a board graph: the four run-live kinds plus `message` and
 * `contest`, each of which must be backed by a recorded board message seq.
 */
export type BoardGraphEdgeKind = "dependency" | "spawn" | "trigger" | "consumed-tool" | "message" | "contest";

export const BOARD_GRAPH_EDGE_KINDS: readonly BoardGraphEdgeKind[] = [
  "dependency",
  "spawn",
  "trigger",
  "consumed-tool",
  "message",
  "contest",
];

/** A coarse grouping of message types, for tick colors and filters. */
export type BoardMessageFamily = "goal" | "item" | "claim" | "contest" | "rev" | "contract" | "decision" | "tool" | "agent";

export interface GoalNodeDetail {
  readonly kind: "goal";
  readonly objective: string;
  readonly rules: BoardRules;
  readonly protected: readonly string[];
  readonly testInventory: BoardTestInventory | null;
}

export interface AgentNodeDetail {
  readonly kind: "agent";
  readonly agent: string;
  readonly role?: string;
  readonly joinedSeq: number;
  readonly left: boolean;
  /** Items this agent holds (owner of a live claim) or waits on (claimant), at K. */
  readonly items: readonly string[];
  /** The item hull the agent is drawn in, or undefined (the bench). */
  readonly hull?: string;
  /** Told to rebase onto the latest passing revision and has not posted since. */
  readonly rebasing: boolean;
  readonly rebaseTo?: number;
  /** The split items this agent is the sub-lead of (drawn on that hull's border). */
  readonly subLeadOf?: readonly string[];
}

export interface ItemNodeDetail {
  readonly kind: "item";
  readonly item: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly scopeHint: readonly string[];
  readonly status: BoardItemStatus;
  readonly proposedBy: string;
  /** The lead's (or a human's) decision on a worker's proposal. */
  readonly triage?: { readonly decision: "accepted" | "rejected"; readonly by: string; readonly seq: number };
  readonly owner?: string;
  readonly claimant?: string;
  readonly write: readonly string[];
  readonly read: readonly string[];
  readonly parent?: string;
  readonly children: readonly string[];
  /** A split item's sub-lead (its children integrate into its repo first). */
  readonly subLead?: string;
  /** Its owner reported it going badly (a cue: idle agents may volunteer), until it pushes again. */
  readonly struggling?: { readonly reason: string; readonly turnsSpent: number; readonly seq: number };
  /** Volunteers who offered help on it, and the owner's answers. */
  readonly volunteers?: readonly { readonly agent: string; readonly seq: number; readonly answer?: "accepted" | "declined" }[];
  /** The owner proposed done: a hollow check until a passing revision completes it. */
  readonly doneProposed: boolean;
  readonly completed?: {
    readonly n?: number;
    readonly via: "integrated" | "children" | "tool";
    readonly version?: string;
    /** Closed by the engine: the owner did not propose done; its latest push (`pushSeq`) passed in rev `n` (recorded at `seq`). */
    readonly closedBy?: "engine";
    readonly pushSeq?: number;
    readonly seq?: number;
  };
  readonly fixAttempts: number;
  readonly fixRequested?: number;
  readonly fixExhausted: boolean;
  /** An open or escalated contest involves this item. */
  readonly contested: boolean;
  /** The agents drawn in this item's hull at K (owner first, then claimants). */
  readonly agents: readonly string[];
  readonly lastPush?: { readonly seq: number; readonly commit: string; readonly agent: string; readonly integratedIn?: number };
  /** Why it is not moving, derived from the folded board (one short line per card), when it is not. */
  readonly wait?: { readonly kind: BoardWaitReason["kind"]; readonly line: string };
  /** Recorded clash predictions still about its pending push (advisory). */
  readonly clashes?: readonly { readonly with: string; readonly status: string; readonly scope?: "shared" | "local"; readonly seq: number }[];
}

export interface RevNodeDetail {
  readonly kind: "rev";
  readonly n: number;
  readonly commit: string;
  readonly gate: "pass" | "fail";
  /** False when no gate ran: its "pass" checked nothing. */
  readonly gated: boolean;
  /** The verdict text shown on the node and the ticker. */
  readonly verdictLabel: string;
  readonly merged: readonly string[];
  readonly paths: readonly string[];
  readonly contributors: readonly string[];
  readonly failing?: { readonly output: string; readonly items: readonly string[] };
  /** The first line of the failing output (the stated reason). */
  readonly failureLine?: string;
  /** The dependency install outcome, when the revision recorded one. */
  readonly install?: string;
  /** ADVISORY: how many of the gate's checks passed, and the change since the previous revision that recorded it. */
  readonly progress?: GraphProgress;
  /**
   * The speculative round this revision came from (candidate.gated records,
   * each backed by its seq): every candidate it gated and what became of it.
   * Records, not nodes: only revisions are drawn.
   */
  readonly candidates?: readonly RevCandidate[];
}

/** One speculative candidate in a revision's detail. */
export interface RevCandidate {
  readonly seq: number;
  readonly index: number;
  /** The items of each push in the candidate's stack, in order (`a then b+c`). */
  readonly prefix: string;
  readonly commit: string;
  readonly verdict: "pass" | "fail";
  readonly outcome: "landed" | "passed" | "blamed" | "retest";
  readonly rev?: number;
  readonly blamed?: readonly string[];
}

/**
 * A revision's ADVISORY progress as the graph shows it: the stated line
 * (`acceptance 40/129 passing; developer 9/9`, or `acceptance suite did not
 * run: typecheck failed (1 error)`), the headline count when there is one (the
 * acceptance suite's, else all suites'), and its change since the previous
 * revision with a comparable headline.
 */
export interface GraphProgress {
  readonly label: string;
  readonly passed?: number;
  readonly total?: number;
  /** True when the headline is the acceptance suite's own count. */
  readonly acceptance?: boolean;
  readonly delta?: number;
}

export interface ToolNodeDetail {
  readonly kind: "tool";
  readonly capability: string;
  readonly proposedBy?: string;
  /** The tool kind (scanner, codemod, check, ...). */
  readonly toolKind?: string;
  readonly inputs?: readonly string[];
  /** The board item that builds it, and its current owner (the builder). */
  readonly item?: string;
  readonly builder?: string;
  readonly versions: readonly {
    readonly version: string;
    readonly tool: string;
    readonly publishedBy: string;
    readonly seq: number;
    readonly uses: number;
    readonly commit?: string;
    readonly repo?: string;
    readonly usage?: string;
    /** The tool.gated message whose checks it passed (its gate evidence). */
    readonly gateSeq?: number;
    readonly joinsGate?: false;
  }[];
  /** Every gate run of its builds: the evidence, pass or fail. */
  readonly gates?: readonly { readonly seq: number; readonly commit: string; readonly passed: boolean; readonly checks: readonly { readonly check: string; readonly passed: boolean; readonly detail: string }[] }[];
  /** Who used it, from the engine's tool.used records. */
  readonly users?: readonly { readonly agent: string; readonly uses: number }[];
  readonly uses: number;
  /** Published (passed its own gate), or only proposed so far. */
  readonly published: boolean;
}

export interface JevNodeDetail {
  readonly kind: "jev";
  readonly juncture: BoardPayloads["decision.recorded"]["juncture"];
  readonly question: string;
  readonly answer?: string;
  readonly confidence?: number;
  readonly accepted: boolean;
  readonly error?: string;
  readonly rev?: number;
  readonly contract?: string;
  readonly parsed?: readonly string[];
  /** The mechanical outcome of an attribution decision, once the next pass resolved it. */
  readonly resolved?: {
    readonly seq: number;
    readonly passed: number;
    readonly outcome: "in-fixed-set" | "not-in-fixed-set";
    readonly fixed: readonly string[];
    /** "Jev picked X; X changed before the next pass" (never "correct"). */
    readonly text: string;
  };
  /** A short chip text, always advisory. */
  readonly chip: string;
}

export interface BoardEscalationAtK {
  /** The escalating message (claim.escalated or contract.escalated). */
  readonly seq: number;
  readonly kind: "contest" | "contract";
  /** The contest or contract id. */
  readonly ref: string;
  readonly item: string;
  readonly question: string;
  readonly options: readonly string[];
  /** The advisory triage line, when a contract-triage decision was recorded. */
  readonly recommendation?: string;
  readonly recommendationSeq?: number;
}

export interface HumanNodeDetail {
  readonly kind: "human";
  /** Escalations waiting on a human at K. */
  readonly pending: readonly BoardEscalationAtK[];
  /** Messages the human posted up to K. */
  readonly posts: number;
}

export type BoardNodeDetail =
  | GoalNodeDetail
  | AgentNodeDetail
  | ItemNodeDetail
  | RevNodeDetail
  | ToolNodeDetail
  | JevNodeDetail
  | HumanNodeDetail;

export interface BoardGraphNode {
  readonly id: string;
  readonly kind: BoardGraphNodeKind;
  readonly label: string;
  /** A kind-specific status word (an item status, a gate verdict, active/left, ...). */
  readonly status: string;
  /** The backing message seqs, ascending; the first created the element. */
  readonly seqs: readonly number[];
  /** Hover text; always ends with its backing message: "(seq N, type)". */
  readonly tooltip: string;
  readonly detail: BoardNodeDetail;
}

export interface BoardGraphEdge {
  readonly id: string;
  readonly kind: BoardGraphEdgeKind;
  readonly from: string;
  readonly to: string;
  /** The backing message seqs, ascending (an aggregated edge has several). */
  readonly seqs: readonly number[];
  /** The message type of a `message` edge, or the latest backing type. */
  readonly type: BoardMessageType;
  /** A `contest` edge's state at K. */
  readonly contest?: "open" | "escalated";
  /** How many messages an aggregated edge stands for (consumed-tool: uses). */
  readonly count: number;
  readonly tooltip: string;
  /** A short label drawn on the edge (formation: "fork", "merged"). */
  readonly label?: "fork" | "merged";
}

export interface BoardTicker {
  readonly goal: string | null;
  readonly goalSeq?: number;
  /** The latest integrated revision (pass or fail) at K. */
  readonly rev: {
    readonly n: number;
    readonly seq: number;
    readonly gate: "pass" | "fail";
    readonly gated: boolean;
    readonly label: string;
    /** ADVISORY progress of the latest revision that recorded it. */
    readonly progress?: GraphProgress;
  } | null;
  readonly rebasing: readonly string[];
  readonly agents: { readonly active: number; readonly joined: number };
  readonly jev: { readonly calls: number; readonly accepted: number; readonly errors: number; readonly label: string };
  readonly items: { readonly proposed: number; readonly open: number; readonly claimed: number; readonly contested: number; readonly done: number };
}

export interface BoardColumns {
  /** Workers' proposals awaiting the lead (not claimable); rejected proposals are in no column. */
  readonly proposed: readonly string[];
  readonly open: readonly string[];
  readonly claimed: readonly string[];
  readonly contested: readonly string[];
  readonly done: readonly string[];
}

export interface BoardGraphModel {
  /** The seq the graph is folded to. */
  readonly k: number;
  /** The last seq in the log (the live head). */
  readonly lastSeq: number;
  readonly state: BoardState;
  readonly nodes: readonly BoardGraphNode[];
  readonly edges: readonly BoardGraphEdge[];
  readonly ticker: BoardTicker;
  /** Item ids per board column, in slot order. */
  readonly columns: BoardColumns;
  /** Escalations waiting on a human at K (pinned on the board). */
  readonly escalations: readonly BoardEscalationAtK[];
}

// ---------------------------------------------------------------------------
// Ids and small helpers
// ---------------------------------------------------------------------------

export const BOARD_GOAL_NODE = "goal";
export const BOARD_HUMAN_NODE = "human";
export function boardAgentNodeId(agent: string): string {
  return `agent:${agent}`;
}
export function boardItemNodeId(item: string): string {
  return `item:${item}`;
}
export function boardRevNodeId(n: number): string {
  return `rev:${n}`;
}
export function boardToolNodeId(capability: string): string {
  return `tool:${capability}`;
}
export function boardJevNodeId(seq: number): string {
  return `jev:${seq}`;
}

/** The family a message type belongs to (tick colors, filters). */
export function boardMessageFamily(type: BoardMessageType): BoardMessageFamily {
  switch (type) {
    case "goal.posted":
      return "goal";
    case "item.proposed":
    case "item.accepted":
    case "item.rejected":
    case "item.discovered":
    case "item.split":
    case "item.completed":
    case "item.reopened":
    case "done.proposed":
    case "handoff":
    case "item.struggling":
    case "seam.stalled":
    case "item.replanned":
    case "item.escalated":
      return "item";
    case "item.claimed":
    case "claim.granted":
    case "claim.ceded":
    case "claim.kept":
    case "claim.narrowed":
    case "claim.resolved":
    case "claim.lapsed":
    case "claim.extended":
    case "claim.overlap":
      return "claim";
    case "claim.contested":
    case "claim.escalated":
      return "contest";
    case "push.announced":
    case "integrated.rev":
    case "rebase.needed":
    case "clash.predicted":
    case "trunk.moved":
    case "revision.promoted":
    case "candidate.gated":
    case "push.excluded":
    case "push.regressed":
    case "fix.requested":
    case "fix.exhausted":
      return "rev";
    case "contract.proposed":
    case "contract.escalated":
    case "contract.accepted":
    case "contract.rejected":
      return "contract";
    case "decision.recorded":
    case "decision.resolved":
      return "decision";
    case "tool.proposed":
    case "tool.built":
    case "tool.gated":
    case "tool.published":
    case "tool.used":
      return "tool";
    default:
      return "agent";
  }
}

/** "(seq N, type)": the backing suffix every tooltip ends with. */
export function backingSuffix(message: Pick<BoardMessage, "seq" | "type">): string {
  return `(seq ${message.seq}, ${message.type})`;
}

/** The verdict label of an integrated revision: gate verdicts are shown only here and on the ticker. */
export function revVerdictLabel(payload: BoardPayloads["integrated.rev"]): string {
  if (payload.gated === false) {
    return "no gate: nothing checked";
  }
  return payload.gate === "pass" ? "GATE PASS" : "GATE FAIL";
}

/** The messages at or before seq K (the log is in seq order). */
export function boardPrefix(log: readonly BoardMessage[], k: number): readonly BoardMessage[] {
  let end = log.length;
  while (end > 0 && log[end - 1]!.seq > k) {
    end -= 1;
  }
  return end === log.length ? log : log.slice(0, end);
}

function isType<K extends BoardMessageType>(message: BoardMessage, type: K): message is Extract<BoardMessage, { readonly type: K }> {
  return message.type === type;
}

function firstLine(text: string, max = 300): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** The optional dependency-install outcome a revision payload may carry. */
function installOf(payload: BoardPayloads["integrated.rev"]): string | undefined {
  const raw = (payload as unknown as { readonly install?: unknown }).install;
  if (typeof raw === "string") {
    return raw;
  }
  if (raw !== null && typeof raw === "object") {
    const status = (raw as { readonly status?: unknown }).status;
    const reason = (raw as { readonly reason?: unknown }).reason;
    if (typeof status === "string") {
      return typeof reason === "string" && reason !== "" ? `${status}: ${reason}` : status;
    }
  }
  return undefined;
}

/** The items a message names (for threads and backing checks). */
export function messageItems(message: BoardMessage, state?: BoardState): string[] {
  const payload = message.payload as unknown as Record<string, unknown>;
  const out: string[] = [];
  if (typeof payload.item === "string") {
    out.push(payload.item);
  }
  // A tool proposal creates (and a build or gate concerns) the tool's item.
  if ((isType(message, "tool.proposed") || isType(message, "tool.built") || isType(message, "tool.gated")) && typeof payload.capability === "string") {
    out.push(toolItemId(payload.capability));
  }
  if (typeof payload.ownerItem === "string" && payload.ownerItem !== payload.item) {
    out.push(payload.ownerItem);
  }
  if (isType(message, "item.split") || isType(message, "item.replanned")) {
    for (const child of message.payload.children) {
      out.push(child.item);
    }
  }
  if (isType(message, "item.replanned") && message.payload.with !== undefined) {
    out.push(message.payload.with);
  }
  if (isType(message, "item.escalated")) {
    out.push(message.payload.replanOf);
  }
  if (isType(message, "clash.predicted")) {
    out.push(message.payload.a.item, message.payload.b.item);
  }
  if (isType(message, "integrated.rev") && message.payload.failing) {
    out.push(...message.payload.failing.items);
  }
  if (isType(message, "push.announced") && message.payload.merges) {
    out.push(...message.payload.merges.map((m) => m.item));
  }
  if (state && (isType(message, "help.offered") || isType(message, "help.delivered"))) {
    const help = state.help[message.payload.request];
    if (help) {
      out.push(help.item);
    }
  }
  if (state && typeof payload.contest === "string") {
    const contest = state.contests[payload.contest];
    if (contest) {
      out.push(contest.item, contest.ownerItem);
    }
  }
  if (state && typeof payload.contract === "string") {
    const contract = state.contracts[payload.contract];
    if (contract?.item !== undefined) {
      out.push(contract.item);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// The graph at K
// ---------------------------------------------------------------------------

/**
 * Build the board graph at seq K (default: the whole log). A pure function of
 * `log[0..K]`: the same K always yields the same model, live or replayed.
 */
export function buildBoardGraph(log: readonly BoardMessage[], k: number = Number.POSITIVE_INFINITY): BoardGraphModel {
  const lastSeq = log.length === 0 ? 0 : log[log.length - 1]!.seq;
  const kk = Math.max(0, Math.min(k, lastSeq));
  const messages = boardPrefix(log, kk);
  const state = foldBoard(messages);
  const bySeq = new Map<number, BoardMessage>();
  for (const m of messages) {
    bySeq.set(m.seq, m);
  }

  const nodes: BoardGraphNode[] = [];
  const edges: BoardGraphEdge[] = [];
  const nodeIds = new Set<string>();
  const push = (node: BoardGraphNode): void => {
    nodes.push(node);
    nodeIds.add(node.id);
  };

  // Goal.
  const goalMessage = messages.find((m) => m.type === "goal.posted");
  if (goalMessage && isType(goalMessage, "goal.posted")) {
    push({
      id: BOARD_GOAL_NODE,
      kind: "goal",
      label: goalMessage.payload.objective,
      status: "posted",
      seqs: [goalMessage.seq],
      tooltip: `goal: ${goalMessage.payload.objective} ${backingSuffix(goalMessage)}`,
      detail: {
        kind: "goal",
        objective: goalMessage.payload.objective,
        rules: state.rules,
        protected: state.protected,
        testInventory: state.testInventory,
      },
    });
  }

  // Agents (the lead included), with their live holdings.
  const contestsOpen = Object.values(state.contests).filter((c) => c.status !== "resolved");
  const holdings = new Map<string, string[]>();
  for (const item of Object.values(state.items)) {
    if (item.owner !== undefined && item.intent !== undefined && item.status !== "done") {
      const list = holdings.get(item.owner) ?? [];
      list.push(item.id);
      holdings.set(item.owner, list);
    }
    if (item.claimant !== undefined) {
      const list = holdings.get(item.claimant.agent) ?? [];
      if (!list.includes(item.id)) {
        list.push(item.id);
      }
      holdings.set(item.claimant.agent, list);
    }
  }
  const latestPassing = state.integrated?.n;
  const rebasing = rebasingAgents(messages, state);
  const hullOf = new Map<string, string>();
  for (const agent of Object.values(state.agents)) {
    const isLead = agent.role === "lead";
    const items = holdings.get(agent.id) ?? [];
    // The hull: the earliest-proposed item the agent holds (or waits on).
    const hull = isLead
      ? undefined
      : [...items].sort((a, b) => (state.items[a]?.proposedSeq ?? 0) - (state.items[b]?.proposedSeq ?? 0))[0];
    if (hull !== undefined && agent.leftSeq === undefined) {
      hullOf.set(agent.id, hull);
    }
    const joined = bySeq.get(agent.joinedSeq)!;
    const seqs = agent.leftSeq !== undefined ? [agent.joinedSeq, agent.leftSeq] : [agent.joinedSeq];
    const last = bySeq.get(seqs[seqs.length - 1]!)!;
    push({
      id: boardAgentNodeId(agent.id),
      kind: isLead ? "lead" : "agent",
      label: agent.id,
      status: agent.leftSeq !== undefined ? "left" : rebasing.has(agent.id) ? "rebasing" : items.length > 0 ? "working" : "free",
      seqs,
      tooltip:
        `${isLead ? "lead" : "agent"} ${agent.id}${agent.role && !isLead ? ` (${agent.role})` : ""}` +
        `${items.length > 0 ? `, holds ${items.join(", ")}` : ""}${rebasing.has(agent.id) ? `, rebasing onto rev ${latestPassing}` : ""} ` +
        backingSuffix(agent.leftSeq !== undefined ? last : joined),
      detail: {
        kind: "agent",
        agent: agent.id,
        ...(agent.role !== undefined ? { role: agent.role } : {}),
        joinedSeq: agent.joinedSeq,
        left: agent.leftSeq !== undefined,
        items,
        ...(hull !== undefined && agent.leftSeq === undefined ? { hull } : {}),
        rebasing: rebasing.has(agent.id),
        ...(agent.rebaseTo !== undefined ? { rebaseTo: agent.rebaseTo } : {}),
        ...((): { subLeadOf?: string[] } => {
          const led = Object.values(state.items).filter((i) => i.status === "split" && i.subLead === agent.id).map((i) => i.id);
          return led.length > 0 && agent.leftSeq === undefined ? { subLeadOf: led } : {};
        })(),
      },
    });
  }

  // Items (hulls). The creating message is the proposal, discovery, or split.
  const itemOrigin = new Map<string, BoardMessage>();
  for (const m of messages) {
    if (isType(m, "tool.proposed")) {
      // A tool proposal creates the item that builds the tool.
      if (!itemOrigin.has(toolItemId(m.payload.capability))) {
        itemOrigin.set(toolItemId(m.payload.capability), m);
      }
    } else if (isType(m, "item.proposed") || isType(m, "item.discovered")) {
      if (!itemOrigin.has(m.payload.item)) {
        itemOrigin.set(m.payload.item, m);
      }
    } else if (isType(m, "item.split") || isType(m, "item.replanned")) {
      // A split's children, or a re-plan's replacements, are created by it.
      for (const child of m.payload.children) {
        if (!itemOrigin.has(child.item)) {
          itemOrigin.set(child.item, m);
        }
      }
    }
  }
  const contestedItems = new Set<string>();
  for (const c of contestsOpen) {
    contestedItems.add(c.item);
    contestedItems.add(c.ownerItem);
  }
  const hullAgents = new Map<string, string[]>();
  for (const [agent, hull] of hullOf) {
    const list = hullAgents.get(hull) ?? [];
    list.push(agent);
    hullAgents.set(hull, list);
  }
  const itemsInOrder = Object.values(state.items).sort((a, b) => a.proposedSeq - b.proposedSeq);
  for (const item of itemsInOrder) {
    const origin = itemOrigin.get(item.id);
    if (!origin) {
      continue; // cannot happen for a folded state; the backing check would refuse it anyway
    }
    const agentsHere = (hullAgents.get(item.id) ?? []).sort((a, b) => {
      if (a === item.owner) return -1;
      if (b === item.owner) return 1;
      return a.localeCompare(b);
    });
    const seqs = new Set<number>([origin.seq]);
    if (item.grantedSeq !== undefined) seqs.add(item.grantedSeq);
    if (item.lastPush) seqs.add(item.lastPush.seq);
    // An engine close is backed by its recorded item.completed (and the push it cites, above).
    if (item.completed?.closedBy === "engine" && item.completed.seq !== undefined) seqs.add(item.completed.seq);
    const struggle =
      item.struggling && item.struggling.owner === item.owner && item.status === "claimed" && !(item.lastPush && item.lastPush.agent === item.owner && item.lastPush.seq > item.struggling.seq)
        ? item.struggling
        : undefined;
    if (struggle) seqs.add(struggle.seq);
    const volunteers = Object.values(state.volunteers ?? {}).filter((v) => v.item === item.id);
    if (item.triage) seqs.add(item.triage.seq);
    const status = contestedItems.has(item.id) && item.status !== "done" ? "contested" : item.status;
    const waitReason = itemWaitReason(state, item.id);
    const ownerText = item.owner !== undefined ? `, owner ${item.owner}` : "";
    const doneText =
      item.status === "done"
        ? item.completed?.via === "tool"
          ? `, done: its tool passed its own gate and was published (v${item.completed.version ?? "?"})`
          : item.completed?.closedBy === "engine"
            ? `, done at rev ${item.completed.n ?? "?"}: closed by the engine (its push #${item.completed.pushSeq ?? "?"} passed in rev ${item.completed.n ?? "?"}; the owner did not propose done)`
            : `, done at rev ${item.completed?.n ?? "?"}`
        : item.doneProposed
          ? ", done proposed (not yet on a passing revision)"
          : item.status === "proposed"
            ? `, proposed by ${item.proposedBy}: awaiting the lead's decision (not claimable)`
            : item.triage !== undefined
              ? `, ${item.triage.decision} by ${item.triage.by}`
              : "";
    push({
      id: boardItemNodeId(item.id),
      kind: "item",
      label: item.id,
      status,
      seqs: [...seqs].sort((a, b) => a - b),
      tooltip: `item ${item.id}: ${item.objective} [${status}${ownerText}${doneText}]${waitReason ? ` (${describeWaitReason(waitReason)})` : ""} ${backingSuffix(origin)}`,
      detail: {
        kind: "item",
        item: item.id,
        objective: item.objective,
        acceptance: item.acceptance,
        scopeHint: item.scopeHint,
        status,
        proposedBy: item.proposedBy,
        ...(item.triage !== undefined ? { triage: item.triage } : {}),
        ...(item.owner !== undefined ? { owner: item.owner } : {}),
        ...(item.claimant !== undefined ? { claimant: item.claimant.agent } : {}),
        write: item.intent?.write ?? [],
        read: item.intent?.read ?? [],
        ...(item.parent !== undefined ? { parent: item.parent } : {}),
        children: item.children,
        ...(item.subLead !== undefined ? { subLead: item.subLead } : {}),
        ...(struggle ? { struggling: { reason: struggle.reason, turnsSpent: struggle.turnsSpent, seq: struggle.seq } } : {}),
        ...(volunteers.length > 0
          ? { volunteers: volunteers.map((v) => ({ agent: v.agent, seq: v.seq, ...(v.answered ? { answer: v.answered.how } : {}) })) }
          : {}),
        doneProposed: item.doneProposed,
        ...(item.completed !== undefined ? { completed: item.completed } : {}),
        fixAttempts: item.fixAttempts ?? 0,
        ...(item.fixRequested !== undefined ? { fixRequested: item.fixRequested } : {}),
        fixExhausted: item.fixExhausted === true,
        contested: contestedItems.has(item.id),
        agents: agentsHere,
        ...(item.lastPush
          ? {
              lastPush: {
                seq: item.lastPush.seq,
                commit: item.lastPush.commit,
                agent: item.lastPush.agent,
                ...(item.lastPush.integratedIn !== undefined ? { integratedIn: item.lastPush.integratedIn } : {}),
              },
            }
          : {}),
        ...(waitReason ? { wait: { kind: waitReason.kind, line: describeWaitReason(waitReason) } } : {}),
        ...((): { clashes?: { with: string; status: string; scope?: "shared" | "local"; seq: number }[] } => {
          const live = liveClashes(state, item.id);
          return live.length > 0
            ? { clashes: live.map((c) => ({ with: c.a.item === item.id ? c.b.item : c.a.item, status: c.status, ...(c.scope !== undefined ? { scope: c.scope } : {}), seq: c.seq })) }
            : {};
        })(),
      },
    });
    // goal -> item, or parent -> child (dependency, backed by the creating message).
    const parent = item.parent;
    const from = parent !== undefined && nodeIds.has(boardItemNodeId(parent)) ? boardItemNodeId(parent) : BOARD_GOAL_NODE;
    if (nodeIds.has(from) && from !== boardItemNodeId(item.id)) {
      edges.push({
        id: `dep:${from}->${item.id}`,
        kind: "dependency",
        from,
        to: boardItemNodeId(item.id),
        seqs: [origin.seq],
        type: origin.type,
        count: 1,
        tooltip: `${parent !== undefined ? `split/discovered from ${parent}` : "proposed for the goal"} ${backingSuffix(origin)}`,
      });
    }
  }

  // Integrated revisions: a chain; merged pushes feed each one.
  const pushByCommit = new Map<string, BoardMessageOf<"push.announced">>();
  let previousRev: BoardMessageOf<"integrated.rev"> | undefined;
  let latestRev: BoardMessageOf<"integrated.rev"> | undefined;
  let previousProgress: { passed: number; acceptance: boolean } | undefined;
  let latestProgress: GraphProgress | undefined;
  // Each speculative round's candidates, attached to every revision the round recorded.
  const candidateRounds = new Map<number, RevCandidate[]>();
  for (const m of messages) {
    if (isType(m, "candidate.gated")) {
      const c = m.payload;
      const list = candidateRounds.get(c.round) ?? [];
      list.push({
        seq: m.seq,
        index: c.index,
        prefix: c.prefix.map((x) => x.items.join("+")).join(" then "),
        commit: c.commit,
        verdict: c.verdict,
        outcome: c.outcome,
        ...(c.rev !== undefined ? { rev: c.rev } : {}),
        ...(c.blamed !== undefined ? { blamed: c.blamed } : {}),
      });
      candidateRounds.set(c.round, list);
    }
  }
  const candidatesByRev = new Map<number, RevCandidate[]>();
  for (const list of candidateRounds.values()) {
    for (const c of list) {
      if (c.rev !== undefined) {
        candidatesByRev.set(c.rev, list);
      }
    }
  }
  for (const m of messages) {
    if (isType(m, "push.announced")) {
      pushByCommit.set(m.payload.commit, m);
      continue;
    }
    if (!isType(m, "integrated.rev")) {
      continue;
    }
    latestRev = m;
    const p = m.payload;
    const headline = p.progress ? progressHeadline(p.progress) : undefined;
    const progress: GraphProgress | undefined = p.progress
      ? {
          label: describeProgress(p.progress),
          ...(headline
            ? {
                passed: headline.passed,
                total: headline.total,
                acceptance: headline.acceptance,
                ...(previousProgress !== undefined && previousProgress.acceptance === headline.acceptance ? { delta: headline.passed - previousProgress.passed } : {}),
              }
            : {}),
        }
      : undefined;
    if (headline) {
      previousProgress = { passed: headline.passed, acceptance: headline.acceptance };
    }
    if (progress) {
      latestProgress = progress;
    }
    const id = boardRevNodeId(p.n);
    const verdictLabel = revVerdictLabel(p);
    const install = installOf(p);
    const failureLine = p.failing ? firstLine(p.failing.output) : undefined;
    push({
      id,
      kind: "rev",
      label: `rev ${p.n}`,
      status: p.gated === false ? "no-gate" : p.gate,
      seqs: [m.seq],
      tooltip:
        `rev ${p.n} ${verdictLabel}${failureLine ? `: ${failureLine}` : ""}; merged ${p.merged.length} push(es) from ` +
        `${p.contributors.join(", ") || "nobody"} ${backingSuffix(m)}`,
      detail: {
        kind: "rev",
        n: p.n,
        commit: p.commit,
        gate: p.gate,
        gated: p.gated !== false,
        verdictLabel,
        merged: p.merged,
        paths: p.paths,
        contributors: p.contributors,
        ...(p.failing ? { failing: { output: p.failing.output, items: p.failing.items } } : {}),
        ...(failureLine !== undefined ? { failureLine } : {}),
        ...(install !== undefined ? { install } : {}),
        ...(progress ? { progress } : {}),
        ...(candidatesByRev.has(p.n) ? { candidates: candidatesByRev.get(p.n)! } : {}),
      },
    });
    if (previousRev) {
      edges.push({
        id: `dep:${boardRevNodeId(previousRev.payload.n)}->${id}`,
        kind: "dependency",
        from: boardRevNodeId(previousRev.payload.n),
        to: id,
        seqs: [m.seq],
        type: m.type,
        count: 1,
        tooltip: `rev ${p.n} follows rev ${previousRev.payload.n} ${backingSuffix(m)}`,
      });
    }
    previousRev = m;
    // item -> rev for each merged push (aggregated per item).
    const perItem = new Map<string, number[]>();
    for (const commit of p.merged) {
      const pushed = pushByCommit.get(commit);
      if (pushed && nodeIds.has(boardItemNodeId(pushed.payload.item))) {
        const list = perItem.get(pushed.payload.item) ?? [];
        list.push(pushed.seq);
        perItem.set(pushed.payload.item, list);
      }
    }
    for (const [item, pushSeqs] of perItem) {
      edges.push({
        id: `dep:${item}->${id}`,
        kind: "dependency",
        from: boardItemNodeId(item),
        to: id,
        seqs: [...pushSeqs, m.seq].sort((a, b) => a - b),
        type: "integrated.rev",
        count: pushSeqs.length,
        tooltip: `rev ${p.n} merged ${item}'s push ${backingSuffix(m)}`,
      });
    }
  }

  // Fix requests and reopenings: ladder control flow from a failing revision to an item.
  for (const m of messages) {
    if (isType(m, "fix.requested") || isType(m, "fix.exhausted") || isType(m, "item.reopened")) {
      if (m.payload.n === undefined) {
        continue; // a tool item reopened after its builds failed their own gate (no revision)
      }
      const rev = boardRevNodeId(m.payload.n);
      const item = boardItemNodeId(m.payload.item);
      if (nodeIds.has(rev) && nodeIds.has(item)) {
        edges.push({
          id: `trigger:${m.seq}`,
          kind: "trigger",
          from: rev,
          to: item,
          seqs: [m.seq],
          type: m.type,
          count: 1,
          tooltip:
            (isType(m, "fix.requested")
              ? `rev ${m.payload.n} asks for fix attempt ${m.payload.attempt} on ${m.payload.item}`
              : isType(m, "fix.exhausted")
                ? `fix budget spent on ${m.payload.item}`
                : `${m.payload.item} reopened for another agent`) + ` ${backingSuffix(m)}`,
        });
      }
    }
  }

  // Tools: one node per capability (the registry), backed by its proposal and
  // every gate and publication; consumed-tool edges aggregated per user,
  // backed by the ENGINE's tool.used records only.
  const toolFirst = new Map<string, BoardMessage>();
  const toolUses = new Map<string, Map<string, number[]>>();
  const toolGates = new Map<string, BoardMessageOf<"tool.gated">[]>();
  for (const m of messages) {
    if ((isType(m, "tool.proposed") || isType(m, "tool.published")) && !toolFirst.has(m.payload.capability)) {
      toolFirst.set(m.payload.capability, m);
    }
    if (isType(m, "tool.gated")) {
      toolGates.set(m.payload.capability, [...(toolGates.get(m.payload.capability) ?? []), m]);
    }
    if (isType(m, "tool.used")) {
      const users = toolUses.get(m.payload.capability) ?? new Map<string, number[]>();
      const list = users.get(m.payload.by) ?? [];
      list.push(m.seq);
      users.set(m.payload.by, list);
      toolUses.set(m.payload.capability, users);
    }
  }
  for (const [capability, first] of toolFirst) {
    const versions = state.tools.published.filter((t) => t.capability === capability);
    const proposal = Object.values(state.tools.proposed).find((t) => t.capability === capability);
    const uses = versions.reduce((sum, v) => sum + v.uses, 0);
    const gates = toolGates.get(capability) ?? [];
    const lastGate = gates.at(-1);
    const seqs = [first.seq, ...gates.map((g) => g.seq), ...versions.map((v) => v.seq)];
    const item = proposal ? state.items[proposal.item] : undefined;
    const status = versions.length > 0 ? "published" : lastGate && !lastGate.payload.passed ? "gate-failed" : item?.status === "claimed" ? "building" : item?.status === "rejected" ? "rejected" : "proposed";
    push({
      id: boardToolNodeId(capability),
      kind: "tool",
      label: capability,
      status,
      seqs: [...new Set(seqs)].sort((a, b) => a - b),
      tooltip:
        `tool ${capability}${proposal ? ` (${proposal.kind})` : ""}: ${
          versions.length > 0
            ? `published v${versions[versions.length - 1]!.version} by ${versions[versions.length - 1]!.publishedBy}, used x${uses}`
            : lastGate && !lastGate.payload.passed
              ? `its own gate failed (${lastGate.payload.checks.filter((c) => !c.passed).map((c) => c.check).join(", ")}): not published`
              : "proposed, not published"
        } ` + backingSuffix(first),
      detail: {
        kind: "tool",
        capability,
        ...(proposal ? { proposedBy: proposal.proposedBy, toolKind: proposal.kind, inputs: proposal.inputs, item: proposal.item } : {}),
        ...(item?.owner !== undefined ? { builder: item.owner } : {}),
        versions: versions.map((v) => ({
          version: v.version,
          tool: v.tool,
          publishedBy: v.publishedBy,
          seq: v.seq,
          uses: v.uses,
          commit: v.commit,
          repo: v.repo,
          usage: v.usage,
          gateSeq: v.gateSeq,
          ...(v.joinsGate === false ? { joinsGate: false as const } : {}),
        })),
        gates: gates.map((g) => ({ seq: g.seq, commit: g.payload.commit, passed: g.payload.passed, checks: g.payload.checks })),
        users: [...(toolUses.get(capability) ?? new Map<string, number[]>()).entries()].map(([agent, useSeqs]) => ({ agent, uses: useSeqs.length })),
        uses,
        published: versions.length > 0,
      },
    });
    // The tool item's passing build published the tool (control flow: a trigger).
    const publishedMessage = versions.length > 0 ? bySeq.get(versions[0]!.seq) : undefined;
    if (proposal && publishedMessage && nodeIds.has(boardItemNodeId(proposal.item))) {
      edges.push({
        id: `trigger:item:${proposal.item}->tool:${capability}`,
        kind: "trigger",
        from: boardItemNodeId(proposal.item),
        to: boardToolNodeId(capability),
        seqs: [publishedMessage.seq],
        type: publishedMessage.type,
        count: 1,
        tooltip: `${proposal.item}'s build passed the tool's own gate and was published ${backingSuffix(publishedMessage)}`,
      });
    }
    for (const [user, useSeqs] of toolUses.get(capability) ?? []) {
      const to = boardAgentNodeId(user);
      if (!nodeIds.has(to)) {
        continue;
      }
      edges.push({
        id: `tool:${capability}->${user}`,
        kind: "consumed-tool",
        from: boardToolNodeId(capability),
        to,
        seqs: useSeqs,
        type: "tool.used",
        count: useSeqs.length,
        tooltip: `${user} used ${capability} x${useSeqs.length} ${backingSuffix(bySeq.get(useSeqs[useSeqs.length - 1]!)!)}`,
      });
    }
  }
  // Work a tool's findings generated: tool -> item (a trigger, backed by the proposal citing it).
  for (const m of messages) {
    if (!isType(m, "item.proposed") || m.payload.fromTool === undefined) {
      continue;
    }
    const from = boardToolNodeId(m.payload.fromTool.capability);
    const to = boardItemNodeId(m.payload.item);
    if (nodeIds.has(from) && nodeIds.has(to)) {
      edges.push({
        id: `trigger:${from}->${to}`,
        kind: "trigger",
        from,
        to,
        seqs: [m.seq],
        type: m.type,
        count: 1,
        tooltip: `${m.payload.fromTool.capability}@${m.payload.fromTool.version} findings became ${m.payload.item} ${backingSuffix(m)}`,
      });
    }
  }

  // Formation. Fork lineage: requester -> helper, backed by the help.offered
  // that recorded the fork (forkOf, forkCommit). Sub-lead merges: child ->
  // split item, backed by the sub-lead's push that merged the child's push.
  for (const m of messages) {
    if (isType(m, "help.offered") && m.payload.forkOf !== undefined) {
      const from = boardAgentNodeId(m.payload.forkOf);
      const to = boardAgentNodeId(m.from);
      if (nodeIds.has(from) && nodeIds.has(to)) {
        edges.push({
          id: `fork:${m.payload.request}`,
          kind: "dependency",
          from,
          to,
          seqs: [m.seq],
          type: m.type,
          count: 1,
          label: "fork",
          tooltip: `fork: ${m.from} forked ${m.payload.forkOf}'s repo at ${m.payload.forkCommit?.slice(0, 10) ?? "its empty state"} for help request ${m.payload.request} ${backingSuffix(m)}`,
        });
      }
    }
    if (isType(m, "push.announced") && m.payload.merges !== undefined) {
      for (const merge of m.payload.merges) {
        const from = boardItemNodeId(merge.item);
        const to = boardItemNodeId(m.payload.item);
        if (nodeIds.has(from) && nodeIds.has(to)) {
          edges.push({
            id: `merged:${m.seq}:${merge.item}`,
            kind: "dependency",
            from,
            to,
            seqs: [m.seq],
            type: m.type,
            count: 1,
            label: "merged",
            tooltip: `merged: sub-lead ${m.from} merged ${merge.item}'s push ${merge.commit.slice(0, 10)} into its push for ${m.payload.item} ${backingSuffix(m)}`,
          });
        }
      }
    }
  }

  // Typed decisions (advisory).
  const resolvedBy = new Map<number, BoardMessageOf<"decision.resolved">>();
  for (const m of messages) {
    if (isType(m, "decision.resolved")) {
      resolvedBy.set(m.payload.decisionSeq, m);
    }
  }
  for (const m of messages) {
    if (!isType(m, "decision.recorded")) {
      continue;
    }
    const p = m.payload;
    const resolved = resolvedBy.get(m.seq);
    const resolution = resolved
      ? {
          seq: resolved.seq,
          passed: resolved.payload.passed,
          outcome: resolved.payload.outcome,
          fixed: resolved.payload.fixed,
          text:
            resolved.payload.outcome === "in-fixed-set"
              ? `Jev picked ${resolved.payload.answer}; ${resolved.payload.answer} changed before the next pass`
              : `Jev picked ${resolved.payload.answer}; ${resolved.payload.answer} did not change before the next pass`,
        }
      : undefined;
    const chip =
      p.error !== undefined
        ? `${p.juncture}: call failed (advisory)`
        : `${p.juncture}: ${p.answer ?? "no answer"}${p.confidence !== undefined ? ` ${p.confidence.toFixed(2)}` : ""}${
            p.accepted ? "" : " (not confident)"
          } (advisory)`;
    push({
      id: boardJevNodeId(m.seq),
      kind: "jev",
      label: p.juncture,
      status: p.error !== undefined ? "error" : p.accepted ? "accepted" : "not-confident",
      seqs: resolved ? [m.seq, resolved.seq] : [m.seq],
      tooltip: `${chip}${resolution ? `; ${resolution.text}` : ""} ${backingSuffix(m)}`,
      detail: {
        kind: "jev",
        juncture: p.juncture,
        question: p.question,
        ...(p.answer !== undefined ? { answer: p.answer } : {}),
        ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
        accepted: p.accepted,
        ...(p.error !== undefined ? { error: p.error } : {}),
        ...(p.rev !== undefined ? { rev: p.rev } : {}),
        ...(p.contract !== undefined ? { contract: p.contract } : {}),
        ...(p.parsed !== undefined ? { parsed: p.parsed } : {}),
        ...(resolution ? { resolved: resolution } : {}),
        chip,
      },
    });
  }

  // Escalations waiting on a human, and the human node.
  const escalations = pendingEscalations(messages, state);
  const humanPosts = messages.filter((m) => m.from === "human");
  const escalationMessages = messages.filter((m) => m.type === "claim.escalated" || m.type === "contract.escalated");
  if (escalationMessages.length > 0) {
    // Backed by the escalations, then the human's answers that followed them.
    const firstEscalation = escalationMessages[0]!.seq;
    const answers = humanPosts.filter((m) => m.seq > firstEscalation && m.type !== "goal.posted").map((m) => m.seq);
    const seqs = [...new Set([...escalationMessages.map((m) => m.seq), ...answers])].sort((a, b) => a - b);
    const lastEscalation = escalationMessages[escalationMessages.length - 1]!;
    push({
      id: BOARD_HUMAN_NODE,
      kind: "human",
      label: "human",
      status: escalations.length > 0 ? "awaiting" : "idle",
      seqs,
      tooltip: `human: ${escalations.length} decision(s) waiting ${backingSuffix(lastEscalation)}`,
      detail: { kind: "human", pending: escalations, posts: humanPosts.length },
    });
    for (const e of escalations) {
      const from = boardItemNodeId(e.item);
      if (nodeIds.has(from)) {
        const m = bySeq.get(e.seq)!;
        edges.push({
          id: `trigger:${e.seq}`,
          kind: "trigger",
          from,
          to: BOARD_HUMAN_NODE,
          seqs: [e.seq],
          type: m.type,
          count: 1,
          tooltip: `${e.kind} ${e.ref} waits for a human decision ${backingSuffix(m)}`,
        });
      }
    }
  }

  // Contest edges: claimant -> owner while the contest is open or escalated.
  for (const contest of contestsOpen) {
    const from = boardAgentNodeId(contest.claimant);
    const to = boardAgentNodeId(contest.owner);
    const opened = bySeq.get(contest.openedSeq);
    if (!opened || !nodeIds.has(from) || !nodeIds.has(to)) {
      continue;
    }
    const escalated = messages.find((m) => isType(m, "claim.escalated") && m.payload.contest === contest.id);
    const seqs = escalated ? [contest.openedSeq, escalated.seq] : [contest.openedSeq];
    edges.push({
      id: `contest:${contest.id}`,
      kind: "contest",
      from,
      to,
      seqs,
      type: opened.type,
      contest: contest.status === "escalated" ? "escalated" : "open",
      count: 1,
      tooltip:
        `contest ${contest.id}: ${contest.claimant} (${contest.item}) vs ${contest.owner} (${contest.ownerItem}) on ` +
        `${contest.overlap.join(", ")}, ${contest.turns} turn(s)${contest.status === "escalated" ? ", escalated to a human" : ""} ` +
        backingSuffix(escalated ?? opened),
    });
  }

  // Message edges: an addressed message (to) or a reply (inReplyTo), between participants.
  for (const m of messages) {
    const fromId = participantNode(m.from);
    if (!nodeIds.has(fromId)) {
      continue;
    }
    const targets = new Set<string>();
    for (const to of m.to ?? []) {
      targets.add(participantNode(to));
    }
    if (m.inReplyTo !== undefined) {
      const original = bySeq.get(m.inReplyTo);
      if (original) {
        targets.add(participantNode(original.from));
      }
    }
    for (const to of targets) {
      if (to === fromId || !nodeIds.has(to)) {
        continue;
      }
      edges.push({
        id: `msg:${m.seq}->${to}`,
        kind: "message",
        from: fromId,
        to,
        seqs: [m.seq],
        type: m.type,
        count: 1,
        tooltip: `${m.from} -> ${to.replace(/^agent:/, "")}: ${m.type}${m.rationale ? ` "${clip(m.rationale, 120)}"` : ""} ${backingSuffix(m)}`,
      });
    }
  }

  const ticker = buildTicker(messages, state, latestRev, rebasing, latestProgress);
  const columns = buildColumns(itemsInOrder.map((i) => i.id), nodes);
  const model: BoardGraphModel = { k: kk, lastSeq, state, nodes, edges, ticker, columns, escalations };
  assertBoardBacked(model, log);
  return model;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** The node a board participant is drawn as. */
export function participantNode(from: string): string {
  return from === "human" ? BOARD_HUMAN_NODE : boardAgentNodeId(from);
}

/**
 * Agents told to rebase onto the latest PASSING revision that have not posted
 * anything since (still active).
 */
function rebasingAgents(messages: readonly BoardMessage[], state: BoardState): Set<string> {
  const latest = state.integrated?.n;
  const out = new Set<string>();
  if (latest === undefined) {
    return out;
  }
  const toldAt = new Map<string, number>();
  const lastPost = new Map<string, number>();
  for (const m of messages) {
    if (isType(m, "rebase.needed") && m.payload.n === latest) {
      toldAt.set(m.payload.agent, m.seq);
    }
    lastPost.set(m.from, m.seq);
  }
  for (const [agent, seq] of toldAt) {
    const a = state.agents[agent];
    if (a && a.leftSeq === undefined && (lastPost.get(agent) ?? 0) < seq) {
      out.add(agent);
    }
  }
  return out;
}

/** Escalations a human still has to answer at K (from the log, not from any snapshot). */
export function pendingEscalations(messages: readonly BoardMessage[], state: BoardState): BoardEscalationAtK[] {
  const triage = new Map<string, { text: string; seq: number }>();
  for (const m of messages) {
    if (isType(m, "decision.recorded") && m.payload.juncture === "contract-triage" && m.payload.contract !== undefined) {
      triage.set(m.payload.contract, { text: contractTriageRecommendation(m.payload), seq: m.seq });
    }
  }
  const out: BoardEscalationAtK[] = [];
  for (const m of messages) {
    if (isType(m, "claim.escalated")) {
      const contest = state.contests[m.payload.contest];
      if (contest?.status === "escalated") {
        out.push({
          seq: m.seq,
          kind: "contest",
          ref: m.payload.contest,
          item: m.payload.item,
          question: `${m.payload.claimant} (item ${m.payload.item}) and ${m.payload.owner} both need ${m.payload.overlap.join(", ")}. Which agent keeps it?`,
          options: [m.payload.owner, m.payload.claimant],
        });
      }
    } else if (isType(m, "contract.escalated")) {
      const contract = state.contracts[m.payload.contract];
      if (contract?.status === "proposed") {
        const advice = triage.get(m.payload.contract);
        out.push({
          seq: m.seq,
          kind: "contract",
          ref: m.payload.contract,
          item: m.payload.item,
          question: `An agent asks to ${m.payload.kind} ${m.payload.target} (an existing test or gate configuration) for item ${m.payload.item}. Accept or reject?`,
          options: ["accept", "reject"],
          ...(advice ? { recommendation: advice.text, recommendationSeq: advice.seq } : {}),
        });
      }
    }
  }
  return out;
}

function buildTicker(
  messages: readonly BoardMessage[],
  state: BoardState,
  latestRev: BoardMessageOf<"integrated.rev"> | undefined,
  rebasing: Set<string>,
  progress?: GraphProgress,
): BoardTicker {
  const agents = Object.values(state.agents);
  const counts = { proposed: 0, open: 0, claimed: 0, contested: 0, done: 0 };
  const contested = new Set<string>();
  for (const c of Object.values(state.contests)) {
    if (c.status !== "resolved") {
      contested.add(c.item);
      contested.add(c.ownerItem);
    }
  }
  for (const item of Object.values(state.items)) {
    if (item.status === "rejected") continue;
    if (item.status === "proposed") counts.proposed += 1;
    else if (item.status === "done") counts.done += 1;
    else if (item.status === "contested" || contested.has(item.id)) counts.contested += 1;
    else if (item.status === "open") counts.open += 1;
    else counts.claimed += 1;
  }
  const d = state.decisions;
  const goal = messages.find((m) => m.type === "goal.posted");
  return {
    goal: state.goal?.objective ?? null,
    ...(goal ? { goalSeq: goal.seq } : {}),
    rev: latestRev
      ? {
          n: latestRev.payload.n,
          seq: latestRev.seq,
          gate: latestRev.payload.gate,
          gated: latestRev.payload.gated !== false,
          label: revVerdictLabel(latestRev.payload),
          ...(progress ? { progress } : {}),
        }
      : null,
    rebasing: [...rebasing].sort(),
    agents: { active: agents.filter((a) => a.leftSeq === undefined).length, joined: agents.length },
    jev: {
      calls: d.calls,
      accepted: d.accepted,
      errors: d.errors,
      label: d.calls === 0 ? "jev: no calls" : `jev: ${d.calls} call(s), ${d.accepted} accepted, ${d.errors} error(s) (advisory)`,
    },
    items: counts,
  };
}

function buildColumns(order: readonly string[], nodes: readonly BoardGraphNode[]): BoardColumns {
  const status = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind === "item" && n.detail.kind === "item") {
      status.set(n.detail.item, n.status);
    }
  }
  const proposed: string[] = [];
  const open: string[] = [];
  const claimed: string[] = [];
  const contested: string[] = [];
  const done: string[] = [];
  for (const id of order) {
    const s = status.get(id);
    if (s === "rejected") continue;
    if (s === "proposed") proposed.push(id);
    else if (s === "open") open.push(id);
    else if (s === "contested") contested.push(id);
    else if (s === "done") done.push(id);
    else if (s !== undefined) claimed.push(id);
  }
  return { proposed, open, claimed, contested, done };
}

// ---------------------------------------------------------------------------
// The backing check
// ---------------------------------------------------------------------------

const NODE_BACKING_TYPES: Record<BoardGraphNodeKind, readonly BoardMessageType[]> = {
  goal: ["goal.posted"],
  lead: ["agent.joined"],
  agent: ["agent.joined"],
  item: ["item.proposed", "item.discovered", "item.split", "item.replanned", "tool.proposed"],
  rev: ["integrated.rev"],
  tool: ["tool.proposed", "tool.published"],
  jev: ["decision.recorded"],
  human: ["claim.escalated", "contract.escalated"],
};

/**
 * The no-unbacked-node check for a board graph: every node and edge must name
 * at least one backing seq, each backing seq must be a recorded message at or
 * before K, the element's first backing message must be of a type that can
 * create it (and name it), and a `message` or `contest` edge must match its
 * message's sender and recipient or contest. Throws on the first violation.
 */
export function assertBoardBacked(model: BoardGraphModel, log: readonly BoardMessage[]): void {
  const bySeq = new Map<number, BoardMessage>();
  for (const m of log) {
    if (m.seq <= model.k) {
      bySeq.set(m.seq, m);
    }
  }
  const nodeIds = new Set(model.nodes.map((n) => n.id));
  const need = (seq: number, what: string): BoardMessage => {
    const m = bySeq.get(seq);
    if (!m) {
      throw new Error(`unbacked ${what}: seq ${seq} is not a recorded board message at or before seq ${model.k}`);
    }
    return m;
  };
  for (const node of model.nodes) {
    if (node.seqs.length === 0) {
      throw new Error(`unbacked node ${node.id}: no backing message`);
    }
    for (const seq of node.seqs) {
      need(seq, `node ${node.id}`);
    }
    const first = need(node.seqs[0]!, `node ${node.id}`);
    if (!NODE_BACKING_TYPES[node.kind].includes(first.type)) {
      throw new Error(`unbacked node ${node.id}: seq ${first.seq} is ${first.type}, which cannot back a ${node.kind} node`);
    }
    const names = (): boolean => {
      switch (node.kind) {
        case "lead":
        case "agent":
          return node.detail.kind === "agent" && first.from === node.detail.agent;
        case "item":
          return node.detail.kind === "item" && messageItems(first).includes(node.detail.item);
        case "rev":
          return node.detail.kind === "rev" && isType(first, "integrated.rev") && first.payload.n === node.detail.n;
        case "tool":
          return (
            node.detail.kind === "tool" &&
            (isType(first, "tool.proposed") || isType(first, "tool.published")) &&
            first.payload.capability === node.detail.capability
          );
        case "jev":
          return node.id === boardJevNodeId(first.seq);
        default:
          return true;
      }
    };
    if (!names()) {
      throw new Error(`unbacked node ${node.id}: seq ${first.seq} (${first.type}) does not name it`);
    }
  }
  for (const edge of model.edges) {
    if (!BOARD_GRAPH_EDGE_KINDS.includes(edge.kind)) {
      throw new Error(`edge ${edge.id}: unknown kind ${edge.kind}`);
    }
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`unbacked edge ${edge.id}: an endpoint is not a node`);
    }
    if (edge.seqs.length === 0) {
      throw new Error(`unbacked edge ${edge.id}: no backing message`);
    }
    const backing = edge.seqs.map((seq) => need(seq, `edge ${edge.id}`));
    if (edge.kind === "spawn") {
      // Only an Artifact repo-pushed recruitment can back a spawn; the board records none.
      throw new Error(`unbacked edge ${edge.id}: a spawn edge needs a repo-pushed recruitment, which the board does not record`);
    }
    if (edge.kind === "message") {
      const m = backing[0]!;
      const recipients = new Set((m.to ?? []).map(participantNode));
      if (m.inReplyTo !== undefined) {
        const original = bySeq.get(m.inReplyTo);
        if (original) recipients.add(participantNode(original.from));
      }
      if (participantNode(m.from) !== edge.from || !recipients.has(edge.to)) {
        throw new Error(`unbacked edge ${edge.id}: seq ${m.seq} is not a message from ${edge.from} to ${edge.to}`);
      }
    }
    if (edge.kind === "contest") {
      const m = backing[0]!;
      if (!isType(m, "claim.contested") || `contest:${m.payload.contest}` !== edge.id) {
        throw new Error(`unbacked edge ${edge.id}: seq ${m.seq} is not the claim.contested that opened it`);
      }
    }
    if (edge.label === "fork") {
      const m = backing[0]!;
      if (!isType(m, "help.offered") || m.payload.forkOf === undefined || boardAgentNodeId(m.payload.forkOf) !== edge.from || participantNode(m.from) !== edge.to) {
        throw new Error(`unbacked edge ${edge.id}: seq ${m.seq} is not the help.offered fork from ${edge.from} to ${edge.to}`);
      }
    }
    if (edge.label === "merged") {
      const m = backing[0]!;
      if (!isType(m, "push.announced") || boardItemNodeId(m.payload.item) !== edge.to || !(m.payload.merges ?? []).some((x) => boardItemNodeId(x.item) === edge.from)) {
        throw new Error(`unbacked edge ${edge.id}: seq ${m.seq} is not a sub-lead push merging ${edge.from} into ${edge.to}`);
      }
    }
    if (edge.kind === "consumed-tool" && backing.some((m) => m.type !== "tool.used")) {
      throw new Error(`unbacked edge ${edge.id}: a consumed-tool edge must be backed by tool.used messages`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stable layout (from the FULL log)
// ---------------------------------------------------------------------------

export interface BoardPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoardHullRect extends BoardPoint {
  readonly w: number;
  readonly h: number;
  /** The item's slot (its order of first appearance). */
  readonly slot: number;
  /** A split child is drawn NESTED inside its parent's hull: the parent item, and the nesting depth (0 = top level). */
  readonly parent?: string;
  readonly depth?: number;
}

export interface BoardLayout {
  readonly width: number;
  readonly height: number;
  readonly goal: BoardPoint;
  readonly human: BoardPoint;
  /** Lead agents, by join order, beside the goal. */
  readonly leads: ReadonlyMap<string, BoardPoint>;
  readonly items: ReadonlyMap<string, BoardHullRect>;
  /** Item -> agent -> sub-slot index (order of first association with the item). */
  readonly agentSlots: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Free agents sit on the bench, by join order. */
  readonly bench: ReadonlyMap<string, BoardPoint>;
  readonly revs: ReadonlyMap<number, BoardPoint>;
  readonly tools: ReadonlyMap<string, BoardPoint>;
  readonly jev: ReadonlyMap<number, BoardPoint>;
}

export const HULL_W = 250;
export const HULL_H = 180;
const HULL_GAP = 30;
const TOP_BAND = 160;
/** The title bar at the top of a hull (captions avoid it). */
export const HULL_TITLE_H = 32;
const MARGIN = 24;
/** How many agents a hull shows before it collapses to a count. */
export const HULL_MAX_AGENTS = 6;
/** The height of a nested (split child) hull, and the gap between nested hulls. */
export const NESTED_HULL_H = 104;
const NESTED_GAP = 10;

/** A stable offset in [-amp, amp] from a string (FNV-1a). */
export function stableJitter(seed: string, amp: number): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (((hash >>> 0) / 0xffffffff) * 2 - 1) * amp;
}

/**
 * The layout of a board run, from its FULL log: every slot is assigned on
 * first appearance and never reassigned, so the same element sits in the same
 * place at every K.
 */
export function boardLayout(log: readonly BoardMessage[]): BoardLayout {
  const itemOrder: string[] = [];
  const seenItem = new Set<string>();
  const addItem = (id: string): void => {
    if (!seenItem.has(id)) {
      seenItem.add(id);
      itemOrder.push(id);
    }
  };
  const agentSlots = new Map<string, Map<string, number>>();
  const associate = (item: string, agent: string): void => {
    const slots = agentSlots.get(item) ?? new Map<string, number>();
    if (!slots.has(agent)) {
      slots.set(agent, slots.size);
    }
    agentSlots.set(item, slots);
  };
  const leads: string[] = [];
  const workers: string[] = [];
  const revs: number[] = [];
  const tools: string[] = [];
  const jev: number[] = [];
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const m of log) {
    if (isType(m, "item.proposed") || isType(m, "item.discovered")) addItem(m.payload.item);
    else if (isType(m, "item.split") || isType(m, "item.replanned")) {
      m.payload.children.forEach((c) => {
        addItem(c.item);
        if (!parentOf.has(c.item)) {
          parentOf.set(c.item, m.payload.item);
          childrenOf.set(m.payload.item, [...(childrenOf.get(m.payload.item) ?? []), c.item]);
        }
      });
    }
    else if (isType(m, "item.claimed")) associate(m.payload.item, m.from);
    else if (isType(m, "claim.granted")) associate(m.payload.item, m.payload.agent);
    else if (isType(m, "claim.contested")) associate(m.payload.item, m.payload.claimant);
    else if (isType(m, "handoff")) associate(m.payload.item, m.payload.to);
    else if (isType(m, "agent.joined")) (m.payload.role === "lead" ? leads : workers).push(m.from);
    else if (isType(m, "integrated.rev")) revs.push(m.payload.n);
    else if ((isType(m, "tool.proposed") || isType(m, "tool.published")) && !tools.includes(m.payload.capability)) tools.push(m.payload.capability);
    else if (isType(m, "decision.recorded")) jev.push(m.seq);
  }
  // A portrait-leaning grid (2 columns for up to 6 items, 3 up to 13, then 4) so the
  // graph fills a tall center pane instead of a wide strip. Only top-level
  // items take grid slots: a split item's children are hulls NESTED inside
  // its hull (two per row, below the parent's own agents), so a split reads
  // as one piece of work with its parts inside.
  const topLevel = itemOrder.filter((id) => !parentOf.has(id));
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(Math.max(1, topLevel.length) / 1.5))));
  const rows = Math.max(1, Math.ceil(topLevel.length / cols));
  const gridW = cols * HULL_W + (cols - 1) * HULL_GAP;
  const slotOf = new Map(itemOrder.map((id, slot) => [id, slot]));
  // The height a hull needs at width w: its own band plus its nested children.
  const heightOf = (id: string, w: number, depth: number): number => {
    const own = depth === 0 ? HULL_H : NESTED_HULL_H;
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) {
      return own;
    }
    const perRow = w >= 2 * 90 + 3 * NESTED_GAP ? 2 : 1;
    const kw = (w - (perRow + 1) * NESTED_GAP) / perRow;
    let total = own;
    for (let i = 0; i < kids.length; i += perRow) {
      total += Math.max(...kids.slice(i, i + perRow).map((k) => heightOf(k, kw, depth + 1))) + NESTED_GAP;
    }
    return total;
  };
  const items = new Map<string, BoardHullRect>();
  const place = (id: string, x: number, y: number, w: number, depth: number, parent?: string): number => {
    const h = heightOf(id, w, depth);
    items.set(id, { x, y, w, h, slot: slotOf.get(id) ?? 0, ...(parent !== undefined ? { parent, depth } : {}) });
    const kids = childrenOf.get(id) ?? [];
    const perRow = w >= 2 * 90 + 3 * NESTED_GAP ? 2 : 1;
    const kw = (w - (perRow + 1) * NESTED_GAP) / perRow;
    let rowY = y + (depth === 0 ? HULL_H : NESTED_HULL_H);
    for (let i = 0; i < kids.length; i += perRow) {
      const row = kids.slice(i, i + perRow);
      const rowH = Math.max(...row.map((k, j) => place(k, x + NESTED_GAP + j * (kw + NESTED_GAP), rowY, kw, depth + 1, id)));
      rowY += rowH + NESTED_GAP;
    }
    return h;
  };
  // Each grid row is as tall as its tallest hull (a split hull grows).
  let rowTop = TOP_BAND;
  for (let r = 0; r < rows; r += 1) {
    const row = topLevel.slice(r * cols, r * cols + cols);
    const heights = row.map((id, c) => place(id, MARGIN + c * (HULL_W + HULL_GAP), rowTop, HULL_W, 0));
    rowTop += Math.max(HULL_H, ...heights) + HULL_GAP;
  }
  const gridBottom = rowTop;
  const benchPerRow = Math.max(1, Math.floor(gridW / 100));
  const bench = new Map<string, BoardPoint>();
  workers.forEach((agent, i) => {
    bench.set(agent, { x: MARGIN + 40 + (i % benchPerRow) * 100, y: gridBottom + 44 + Math.floor(i / benchPerRow) * 64 });
  });
  const benchBottom = gridBottom + 44 + Math.ceil(Math.max(1, workers.length) / benchPerRow) * 64;
  const toolMap = new Map<string, BoardPoint>();
  tools.forEach((cap, i) => toolMap.set(cap, { x: MARGIN + 60 + i * 200, y: benchBottom + 34 }));
  const revX = MARGIN + gridW + 80;
  const revMap = new Map<number, BoardPoint>();
  revs.forEach((n, i) => revMap.set(n, { x: revX, y: TOP_BAND + 30 + i * 76 }));
  // Jev decisions stack below the revision chain, in the same column.
  const jevX = revX;
  const jevTop = TOP_BAND + 30 + revs.length * 76 + 20;
  const jevMap = new Map<number, BoardPoint>();
  jev.forEach((seq, i) => jevMap.set(seq, { x: jevX, y: jevTop + i * 44 }));
  const goal = { x: MARGIN + gridW / 2, y: 64 };
  const leadMap = new Map<string, BoardPoint>();
  leads.forEach((agent, i) => leadMap.set(agent, { x: Math.max(MARGIN + 40, goal.x - 230 - i * 70), y: 70 }));
  const human = { x: goal.x + 230, y: 70 };
  const height =
    Math.max(benchBottom + (tools.length > 0 ? 110 : 20), jevTop + jev.length * 44 + 10) + MARGIN;
  const width = Math.max(revX + 230, human.x + 120, 640);
  return { width, height, goal, human, leads: leadMap, items, agentSlots, bench, revs: revMap, tools: toolMap, jev: jevMap };
}

/** Where an agent's sub-slot sits inside an item hull (a narrow nested hull stacks fewer per row). */
export function hullAgentPoint(hull: BoardHullRect, slot: number, agent: string): BoardPoint {
  const i = slot % HULL_MAX_AGENTS;
  const perRow = hull.w >= 230 ? 3 : hull.w >= 150 ? 2 : 1;
  const step = perRow === 1 ? 0 : Math.min(79, (hull.w - 60) / (perRow - 1));
  const nested = (hull.depth ?? 0) > 0;
  return {
    x: hull.x + (perRow === 1 ? hull.w / 2 : 30 + (i % perRow) * step) + stableJitter(`${agent}:x`, 5),
    y: hull.y + (nested ? 62 : 80) + Math.floor(i / perRow) * (nested ? 40 : 56) + stableJitter(`${agent}:y`, 4),
  };
}

/** Where a sub-lead sits: ON the border of the split item's hull (it integrates the children inside). */
export function subLeadBorderPoint(hull: BoardHullRect): BoardPoint {
  return { x: hull.x, y: hull.y + HULL_TITLE_H + 36 };
}

/** The position of a node in the layout at K (an agent sits in its hull, else on the bench). */
export function boardNodePoint(layout: BoardLayout, node: BoardGraphNode): BoardPoint | undefined {
  const d = node.detail;
  switch (d.kind) {
    case "goal":
      return layout.goal;
    case "human":
      return layout.human;
    case "item": {
      const hull = layout.items.get(d.item);
      return hull ? { x: hull.x + hull.w / 2, y: hull.y + hull.h / 2 } : undefined;
    }
    case "agent": {
      if (node.kind === "lead") {
        return layout.leads.get(d.agent);
      }
      if (d.hull !== undefined) {
        const hull = layout.items.get(d.hull);
        if (hull && d.subLeadOf?.includes(d.hull)) {
          return subLeadBorderPoint(hull);
        }
        const slot = layout.agentSlots.get(d.hull)?.get(d.agent);
        if (hull && slot !== undefined) {
          return hullAgentPoint(hull, slot, d.agent);
        }
      }
      return layout.bench.get(d.agent);
    }
    case "rev":
      return layout.revs.get(d.n);
    case "tool":
      return layout.tools.get(d.capability);
    case "jev":
      return layout.jev.get(node.seqs[0]!);
  }
}

// ---------------------------------------------------------------------------
// Threads, captions, and aggregation (pure helpers for the console panes)
// ---------------------------------------------------------------------------

/** A console selection: an item, an agent, a node, or one message seq. */
export type BoardSelection =
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "seq"; readonly seq: number };

/**
 * The typed messages of a thread at K, in seq order: for an item, every
 * message that names it (directly, or through its contest or contract); for an
 * agent, every message it sent or that was addressed to it; for a seq, the
 * message, what it replies to, and its replies.
 */
export function boardThread(log: readonly BoardMessage[], k: number, selection: BoardSelection, state?: BoardState): BoardMessage[] {
  const messages = boardPrefix(log, k);
  const folded = state ?? foldBoard(messages);
  switch (selection.kind) {
    case "item":
      return messages.filter((m) => messageItems(m, folded).includes(selection.id));
    case "agent":
      return messages.filter(
        (m) =>
          m.from === selection.id ||
          (m.to ?? []).includes(selection.id) ||
          (isType(m, "rebase.needed") && m.payload.agent === selection.id) ||
          (isType(m, "claim.granted") && m.payload.agent === selection.id),
      );
    case "seq": {
      const target = messages.find((m) => m.seq === selection.seq);
      if (!target) return [];
      return messages.filter((m) => m.seq === target.seq || m.seq === target.inReplyTo || m.inReplyTo === target.seq);
    }
    case "node": {
      const id = selection.id;
      if (id.startsWith("item:")) return boardThread(log, k, { kind: "item", id: id.slice(5) }, folded);
      if (id.startsWith("agent:")) return boardThread(log, k, { kind: "agent", id: id.slice(6) }, folded);
      if (id.startsWith("rev:")) {
        const n = Number(id.slice(4));
        return messages.filter(
          (m) =>
            (isType(m, "integrated.rev") && m.payload.n === n) ||
            ((isType(m, "fix.requested") || isType(m, "fix.exhausted") || isType(m, "rebase.needed") || isType(m, "item.reopened")) &&
              m.payload.n === n) ||
            (isType(m, "decision.recorded") && m.payload.rev === n),
        );
      }
      if (id.startsWith("tool:")) {
        const cap = id.slice(5);
        return messages.filter(
          (m) => (isType(m, "tool.proposed") || isType(m, "tool.published") || isType(m, "tool.used")) && m.payload.capability === cap,
        );
      }
      if (id.startsWith("jev:")) {
        const seq = Number(id.slice(4));
        return messages.filter((m) => m.seq === seq || (isType(m, "decision.resolved") && m.payload.decisionSeq === seq));
      }
      if (id === BOARD_HUMAN_NODE) {
        return messages.filter((m) => m.from === "human" || m.type === "claim.escalated" || m.type === "contract.escalated");
      }
      return messages.filter((m) => m.type === "goal.posted");
    }
  }
}

export interface BoardCaption {
  readonly seq: number;
  /** The node the caption floats over (the sender). */
  readonly node: string;
  readonly text: string;
}

/**
 * Captions for messages that landed in (fromSeq, toSeq]: the latest `max`
 * messages from participants that are drawn as nodes, newest first.
 */
export function boardCaptions(
  log: readonly BoardMessage[],
  fromSeq: number,
  toSeq: number,
  nodeIds: ReadonlySet<string>,
  max = 3,
): BoardCaption[] {
  const out: BoardCaption[] = [];
  for (let i = log.length - 1; i >= 0 && out.length < max; i -= 1) {
    const m = log[i]!;
    if (m.seq > toSeq) continue;
    if (m.seq <= fromSeq) break;
    const node = participantNode(m.from);
    if (!nodeIds.has(node)) continue;
    out.push({ seq: m.seq, node, text: `${m.type}${m.rationale ? `: "${clip(m.rationale, 60)}"` : ""}` });
  }
  return out;
}

/** Message edges aggregated per (from, to) pair, for the "all" view. */
export function aggregateMessageEdges(edges: readonly BoardGraphEdge[]): BoardGraphEdge[] {
  const byPair = new Map<string, BoardGraphEdge>();
  for (const e of edges) {
    if (e.kind !== "message") continue;
    const key = `${e.from}->${e.to}`;
    const prev = byPair.get(key);
    if (!prev) {
      byPair.set(key, { ...e, id: `msgs:${key}` });
    } else {
      const seqs = [...prev.seqs, ...e.seqs].sort((a, b) => a - b);
      byPair.set(key, {
        ...prev,
        seqs,
        count: prev.count + e.count,
        type: e.type,
        tooltip: `${prev.count + e.count} messages ${e.from.replace(/^agent:/, "")} -> ${e.to.replace(/^agent:/, "")} (latest seq ${seqs[seqs.length - 1]}, ${e.type})`,
      });
    }
  }
  return [...byPair.values()];
}

/** The seqs of contest openings and integrated revisions (replay jump targets). */
export function boardJumpTargets(log: readonly BoardMessage[]): { readonly contests: number[]; readonly revs: number[] } {
  const contests: number[] = [];
  const revs: number[] = [];
  for (const m of log) {
    if (m.type === "claim.contested" || m.type === "claim.escalated" || m.type === "contract.escalated") contests.push(m.seq);
    if (m.type === "integrated.rev") revs.push(m.seq);
  }
  return { contests, revs };
}

/**
 * The Change BOARD: a single ordered, durable log of typed coordination
 * messages, and the pure rules that turn it into state.
 *
 * A goal is posted to the board. Agents join, read it, claim items with a
 * declared intent (what they will read and write), split what is too big, ask
 * for help, propose contract changes and tools, announce pushes, and propose
 * completion. The engine arbitrates mechanically and only the gate decides what
 * ships: an item is done only when the engine derives its completion from a
 * passing integrated revision that merged the owner's latest push.
 *
 * Who may say what is part of the model, not a convention:
 *   - an AGENT posts as itself only (the substrate authenticates it and passes
 *     its id as the origin; `from` is never taken from the message body);
 *   - the HUMAN posts through its own origin (goal, items, decisions);
 *   - the ENGINE never posts through a participant route. Its messages are
 *     either derived by arbitration from another message, or (for
 *     `integrated.rev`) produced from a recorded integration result by
 *     `appendIntegratedRev`.
 *
 * Everything here is pure and deterministic. There is no clock (the caller
 * supplies each message's `at`), no I/O, and no randomness, so the same log
 * always reduces to the same state and the same input always yields the same
 * engine messages. The arbitration rules (turn and idle limits) are recorded
 * in `goal.posted`, so a log is self-describing. The Worker's ChangeState
 * Durable Object and the offline local control both call the append functions
 * here, so the rules live in exactly one place.
 *
 * Free text appears only in a message's `rationale`. Payload strings are ids,
 * paths, or short bounded fields that define an item (objective, acceptance).
 */

import {
  entriesOverlap,
  hasWildcard,
  intentPath,
  intentWithin,
  MAX_INTENT_ENTRY_LENGTH,
  normalizeIntentEntry,
  overlappingEntries,
} from "./path-overlap.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The human operator. */
export const BOARD_HUMAN = "human";
/** The mechanical engine (arbitration and the integrator). */
export const BOARD_ENGINE = "engine";
/** The role of the seeding lead: an agent like any other, with this role. */
export const LEAD_ROLE = "lead";

const RESERVED_SENDERS: ReadonlySet<string> = new Set([BOARD_HUMAN, BOARD_ENGINE]);

/** The arbitration rules a board runs under, recorded in goal.posted. */
export interface BoardRules {
  /** Owner/claimant turns a contest may take before it escalates. */
  readonly maxContestTurns: number;
  /** Board messages a contest may sit with no party acting before it escalates. */
  readonly contestIdleMessages: number;
}

export const DEFAULT_BOARD_RULES: BoardRules = { maxContestTurns: 3, contestIdleMessages: 25 };

/** Hard bounds that keep a board's work and storage finite. */
export const BOARD_LIMITS = {
  /** Messages per Change board (a batch reserve keeps engine batches whole). */
  maxMessages: 20000,
  batchReserve: 512,
  maxItems: 1000,
  maxAgents: 100,
  maxChildren: 32,
  maxIntentEntries: 64,
  maxEntryLength: MAX_INTENT_ENTRY_LENGTH,
  maxPaths: 256,
  maxShortList: 32,
  maxRecipients: 16,
  maxTools: 200,
  maxObjective: 500,
  maxAcceptance: 20,
  maxRationale: 2000,
  /** Largest request body a board route accepts, in bytes. */
  maxBodyBytes: 65536,
} as const;

/** What an agent will read and write. Entries are paths, globs, or `path#symbol`. */
export interface BoardIntent {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** A child item declared by an `item.split`. */
export interface BoardChildItem {
  readonly item: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly scopeHint: readonly string[];
}

/** How a contest ended. */
export type ContestResolution =
  | "owner-ceded"
  | "claimant-withdrew"
  | "narrowed"
  | "owner-released"
  | "human-decided";

/** A review finding: advisory, or a failing test the owner must make pass. */
export interface BoardFinding {
  readonly kind: "advisory" | "failing-test";
  readonly path?: string;
}

/** The payload of each message type. */
export interface BoardPayloads {
  "goal.posted": { readonly objective: string; readonly rules: BoardRules };
  "item.proposed": {
    readonly item: string;
    readonly objective: string;
    readonly acceptance: readonly string[];
    readonly scopeHint: readonly string[];
  };
  "item.claimed": { readonly item: string; readonly intent: BoardIntent };
  "claim.granted": { readonly item: string; readonly agent: string; readonly intent: BoardIntent };
  "claim.contested": {
    readonly contest: string;
    readonly item: string;
    readonly claimant: string;
    readonly owner: string;
    readonly ownerItem: string;
    readonly overlap: readonly string[];
    /** The intent the claimant asked for (held pending the contest). */
    readonly intent: BoardIntent;
  };
  "claim.ceded": { readonly contest: string };
  "claim.kept": { readonly contest: string };
  "claim.narrowed": { readonly contest: string; readonly write: readonly string[] };
  "claim.resolved": {
    readonly contest: string;
    readonly how: ContestResolution;
    readonly winner?: string;
  };
  "claim.escalated": {
    readonly contest: string;
    readonly item: string;
    readonly owner: string;
    readonly claimant: string;
    readonly overlap: readonly string[];
    readonly turns: number;
    /** Escalated after too many turns, or after too long with no party acting. */
    readonly reason: "turns" | "idle";
  };
  "item.split": { readonly item: string; readonly children: readonly BoardChildItem[] };
  "item.discovered": {
    readonly item: string;
    readonly objective: string;
    readonly reason: string;
    readonly parent?: string;
  };
  "help.requested": { readonly request: string; readonly item: string; readonly need: string };
  "help.offered": { readonly request: string };
  "contract.proposed": {
    readonly contract: string;
    readonly target: string;
    readonly kind: "add" | "modify" | "remove";
  };
  "contract.accepted": { readonly contract: string };
  "contract.rejected": { readonly contract: string };
  "push.announced": { readonly item: string; readonly commit: string; readonly paths: readonly string[] };
  "integrated.rev": {
    readonly n: number;
    readonly commit: string;
    readonly gate: "pass" | "fail";
    /** The announced push commits this revision merged. */
    readonly merged: readonly string[];
    /** Derived: the paths those pushes changed. */
    readonly paths: readonly string[];
    /** Derived: the agents whose pushes were merged. */
    readonly contributors: readonly string[];
  };
  "rebase.needed": { readonly agent: string; readonly n: number; readonly paths: readonly string[] };
  "review.requested": { readonly review: string; readonly item: string };
  "review.result": { readonly review: string; readonly findings: readonly BoardFinding[] };
  handoff: {
    readonly item: string;
    readonly to: string;
    readonly capsule: { readonly repo: string; readonly commit?: string };
  };
  "done.proposed": { readonly item: string; readonly commit?: string };
  "item.completed": { readonly item: string; readonly n: number; readonly via: "integrated" | "children" };
  "tool.proposed": {
    readonly tool: string;
    readonly capability: string;
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
  };
  "tool.published": {
    readonly tool: string;
    readonly capability: string;
    readonly version: string;
    readonly repo: string;
    readonly commit: string;
    readonly verified: true;
  };
  "tool.used": {
    readonly capability: string;
    readonly version: string;
    readonly changedFiles: readonly string[];
  };
  "agent.joined": { readonly role?: string };
  "agent.left": Record<string, never>;
}

export type BoardMessageType = keyof BoardPayloads;

/** Every message type, in vocabulary order. */
export const BOARD_MESSAGE_TYPES: readonly BoardMessageType[] = [
  "goal.posted",
  "item.proposed",
  "item.claimed",
  "claim.granted",
  "claim.contested",
  "claim.ceded",
  "claim.kept",
  "claim.narrowed",
  "claim.resolved",
  "claim.escalated",
  "item.split",
  "item.discovered",
  "help.requested",
  "help.offered",
  "contract.proposed",
  "contract.accepted",
  "contract.rejected",
  "push.announced",
  "integrated.rev",
  "rebase.needed",
  "review.requested",
  "review.result",
  "handoff",
  "done.proposed",
  "item.completed",
  "tool.proposed",
  "tool.published",
  "tool.used",
  "agent.joined",
  "agent.left",
];

interface Envelope<K extends BoardMessageType> {
  readonly seq: number;
  readonly at: string;
  /** An agent id, "human", or "engine". */
  readonly from: string;
  readonly type: K;
  readonly payload: BoardPayloads[K];
  /** The only free-text field. */
  readonly rationale?: string;
  /** The seq of the message this one answers. */
  readonly inReplyTo?: number;
  /** The agents this message is addressed to (joined agents). */
  readonly to?: readonly string[];
}

/** One recorded board message. */
export type BoardMessage = { [K in BoardMessageType]: Envelope<K> }[BoardMessageType];

/** A message before the board assigns its seq and time. */
export type BoardDraft = {
  [K in BoardMessageType]: Omit<Envelope<K>, "seq" | "at">;
}[BoardMessageType];

/** A message of one specific type. */
export type BoardMessageOf<K extends BoardMessageType> = Envelope<K>;

/**
 * Who is posting, as established by the substrate (never by the message):
 *   - `agent`: an authenticated, joined agent posting as itself;
 *   - `join`: an agent joining (the only way to post `agent.joined`);
 *   - `human`: the human operator.
 */
export type BoardOrigin =
  | { readonly kind: "agent"; readonly agent: string }
  | { readonly kind: "join"; readonly agent: string }
  | { readonly kind: "human" };

/** Machine-readable rejection codes. */
export type BoardErrorCode =
  | "BAD_PAYLOAD"
  | "AUTH"
  | "NOT_ALLOWED"
  | "NO_GOAL"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_REF"
  | "DUPLICATE"
  | "ITEM_NOT_OPEN"
  | "NOT_OWNER"
  | "CONTEST_OPEN"
  | "CONTEST_CLOSED"
  | "INTENT_OVERLAP"
  | "OUTSIDE_INTENT"
  | "NOT_WITHIN"
  | "INVALID_STATE"
  | "LIMIT"
  | "LOG_MISMATCH";

/** A rejected message or an inconsistent log, with a machine-readable code. */
export class BoardError extends Error {
  constructor(
    readonly code: BoardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardError";
  }
}

function fail(code: BoardErrorCode, message: string): never {
  throw new BoardError(code, message);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type BoardItemStatus = "open" | "claimed" | "contested" | "split" | "done";

/** The latest push announced for an item, and the revision that merged it. */
export interface BoardItemPush {
  readonly seq: number;
  readonly commit: string;
  readonly agent: string;
  readonly paths: readonly string[];
  integratedIn?: number;
}

export interface BoardItem {
  readonly id: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly scopeHint: readonly string[];
  status: BoardItemStatus;
  readonly proposedBy: string;
  readonly proposedSeq: number;
  readonly parent?: string;
  children: string[];
  readonly discovered?: { readonly by: string; readonly reason: string };
  /** The agent holding the claim (kept after completion for attribution). */
  owner?: string;
  /** The live intent of the claim, while it is held. */
  intent?: BoardIntent;
  /** The seq of the grant that gave the current owner the claim. */
  grantedSeq?: number;
  /** A claim waiting on a contest. */
  claimant?: { readonly agent: string; intent: BoardIntent; contest: string };
  doneProposed: boolean;
  lastPush?: BoardItemPush;
  completed?: { readonly n: number; readonly via: "integrated" | "children" };
}

export type BoardContestStatus = "open" | "escalated" | "resolved";

export interface BoardContest {
  readonly id: string;
  /** The claimant's item. */
  readonly item: string;
  readonly claimant: string;
  readonly owner: string;
  readonly ownerItem: string;
  readonly overlap: readonly string[];
  status: BoardContestStatus;
  turns: number;
  readonly openedSeq: number;
  /** The seq of the last message a party posted on this contest. */
  lastActionSeq: number;
  how?: ContestResolution;
  winner?: string;
}

export interface BoardAgent {
  readonly id: string;
  readonly role?: string;
  readonly joinedSeq: number;
  leftSeq?: number;
  /** The latest integrated revision this agent was told to rebase onto. */
  rebaseTo?: number;
}

export interface BoardHelpRequest {
  readonly request: string;
  readonly item: string;
  readonly need: string;
  readonly by: string;
  offers: string[];
}

export interface BoardContract {
  readonly contract: string;
  readonly target: string;
  readonly kind: "add" | "modify" | "remove";
  readonly proposedBy: string;
  status: "proposed" | "accepted" | "rejected";
  decidedBy?: string;
}

export interface BoardReview {
  readonly review: string;
  readonly item: string;
  readonly by: string;
  reviewer?: string;
  findings?: readonly BoardFinding[];
}

export interface BoardToolProposal {
  readonly tool: string;
  readonly capability: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly proposedBy: string;
}

export interface BoardPublishedTool {
  readonly tool: string;
  readonly capability: string;
  readonly version: string;
  readonly repo: string;
  readonly commit: string;
  readonly publishedBy: string;
  readonly seq: number;
  /** How many tool.used messages pinned this version (the uses stay in the log). */
  uses: number;
}

export interface BoardIntegratedRev {
  readonly n: number;
  readonly commit: string;
  readonly seq: number;
}

/**
 * The reduced board. JSON-serializable; key order follows the log. Per-event
 * records that grow without bound (each push, each tool use) stay in the log;
 * the state keeps counts and the latest value that rules need.
 */
export interface BoardState {
  lastSeq: number;
  goal: { readonly objective: string; readonly seq: number } | null;
  rules: BoardRules;
  agents: Record<string, BoardAgent>;
  items: Record<string, BoardItem>;
  contests: Record<string, BoardContest>;
  help: Record<string, BoardHelpRequest>;
  contracts: Record<string, BoardContract>;
  reviews: Record<string, BoardReview>;
  tools: {
    proposed: Record<string, BoardToolProposal>;
    published: BoardPublishedTool[];
  };
  /** Total push.announced messages. */
  pushes: number;
  /** The latest PASSING integrated revision: the shared baseline. */
  integrated: BoardIntegratedRev | null;
  /** The number of the latest integrated revision, pass or fail (0 = none). */
  lastRevN: number;
  /** Every passing revision number, ascending. */
  passingRevs: number[];
}

/** An empty board. */
export function emptyBoard(): BoardState {
  return {
    lastSeq: 0,
    goal: null,
    rules: { ...DEFAULT_BOARD_RULES },
    agents: {},
    items: {},
    contests: {},
    help: {},
    contracts: {},
    reviews: {},
    tools: { proposed: {}, published: [] },
    pushes: 0,
    integrated: null,
    lastRevN: 0,
    passingRevs: [],
  };
}

/** A deep copy (the state is plain JSON data). */
function cloneState(state: BoardState): BoardState {
  return JSON.parse(JSON.stringify(state)) as BoardState;
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(raw: Raw, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("BAD_PAYLOAD", `${field} must be an id (letters, digits, . _ : -; at most 128 chars)`);
  }
  return value;
}

function optionalId(raw: Raw, field: string): string | undefined {
  return raw[field] === undefined ? undefined : id(raw, field);
}

function text(raw: Raw, field: string, max: number): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    fail("BAD_PAYLOAD", `${field} must be a non-empty string`);
  }
  if (value.length > max) {
    fail("BAD_PAYLOAD", `${field} must be at most ${max} characters`);
  }
  return value.trim();
}

function textList(raw: Raw, field: string, maxItems: number, maxLength: number): string[] {
  const value = raw[field];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    fail("BAD_PAYLOAD", `${field} must be an array of at most ${maxItems} strings`);
  }
  return value.map((entry, index) => text({ [`${field}[${index}]`]: entry }, `${field}[${index}]`, maxLength));
}

function pathList(
  raw: Raw,
  field: string,
  options: { readonly concrete?: boolean; readonly optional?: boolean; readonly max?: number } = {},
): string[] {
  const value = raw[field];
  const max = options.max ?? BOARD_LIMITS.maxPaths;
  if (value === undefined && options.optional) {
    return [];
  }
  if (!Array.isArray(value) || value.length > max) {
    fail("BAD_PAYLOAD", `${field} must be an array of at most ${max} paths`);
  }
  const out: string[] = [];
  for (const entry of value) {
    const normalized = typeof entry === "string" ? normalizeIntentEntry(entry) : undefined;
    if (normalized === undefined) {
      fail(
        "BAD_PAYLOAD",
        `${field} has an invalid path ${JSON.stringify(String(entry).slice(0, 80))} ` +
          `(relative repo paths, globs, or path#symbol, at most ${BOARD_LIMITS.maxEntryLength} chars)`,
      );
    }
    if (options.concrete && (hasWildcard(normalized) || normalized.includes("#"))) {
      fail("BAD_PAYLOAD", `${field} must list concrete file paths, not ${JSON.stringify(entry)}`);
    }
    if (!out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

function intent(raw: Raw, field: string): BoardIntent {
  const value = raw[field];
  if (!isRecord(value)) {
    fail("BAD_PAYLOAD", `${field} must be an object {read: string[], write: string[]}`);
  }
  const max = BOARD_LIMITS.maxIntentEntries;
  return {
    read: pathList(value, "read", { optional: true, max }),
    write: pathList(value, "write", { max }),
  };
}

function positiveInt(raw: Raw, field: string, max = Number.MAX_SAFE_INTEGER): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    fail("BAD_PAYLOAD", `${field} must be an integer from 1 to ${max}`);
  }
  return value;
}

function nonNegativeInt(raw: Raw, field: string): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("BAD_PAYLOAD", `${field} must be a non-negative integer`);
  }
  return value;
}

function oneOf<T extends string>(raw: Raw, field: string, values: readonly T[]): T {
  const value = raw[field];
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail("BAD_PAYLOAD", `${field} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function idList(raw: Raw, field: string, options: { readonly optional?: boolean; readonly max?: number } = {}): string[] {
  const value = raw[field];
  const max = options.max ?? BOARD_LIMITS.maxShortList;
  if (value === undefined && options.optional) {
    return [];
  }
  if (!Array.isArray(value) || value.length > max) {
    fail("BAD_PAYLOAD", `${field} must be an array of at most ${max} ids`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !ID_PATTERN.test(entry)) {
      fail("BAD_PAYLOAD", `${field} has an invalid id ${JSON.stringify(entry)}`);
    }
    if (!out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

function children(raw: Raw): BoardChildItem[] {
  const value = raw.children;
  if (!Array.isArray(value) || value.length === 0 || value.length > BOARD_LIMITS.maxChildren) {
    fail("BAD_PAYLOAD", `children must be a non-empty array of at most ${BOARD_LIMITS.maxChildren} items`);
  }
  const seen = new Set<string>();
  return value.map((child) => {
    if (!isRecord(child)) {
      fail("BAD_PAYLOAD", "each child must be an object {item, objective, acceptance}");
    }
    const item = id(child, "item");
    if (seen.has(item)) {
      fail("BAD_PAYLOAD", `duplicate child item ${item}`);
    }
    seen.add(item);
    return {
      item,
      objective: text(child, "objective", BOARD_LIMITS.maxObjective),
      acceptance: textList(child, "acceptance", BOARD_LIMITS.maxAcceptance, BOARD_LIMITS.maxObjective),
      scopeHint: pathList(child, "scopeHint", { optional: true, max: BOARD_LIMITS.maxIntentEntries }),
    };
  });
}

function findings(raw: Raw): BoardFinding[] {
  const value = raw.findings;
  if (!Array.isArray(value) || value.length > BOARD_LIMITS.maxIntentEntries) {
    fail("BAD_PAYLOAD", `findings must be an array of at most ${BOARD_LIMITS.maxIntentEntries} findings`);
  }
  return value.map((finding) => {
    if (!isRecord(finding)) {
      fail("BAD_PAYLOAD", "each finding must be an object {kind, path?}");
    }
    const kind = oneOf(finding, "kind", ["advisory", "failing-test"] as const);
    if (finding.path === undefined) {
      return { kind };
    }
    const [path] = pathList({ path: [finding.path] }, "path");
    return { kind, path: path! };
  });
}

function rules(raw: Raw): BoardRules {
  const value = raw.rules;
  if (value === undefined) {
    return { ...DEFAULT_BOARD_RULES };
  }
  if (!isRecord(value)) {
    fail("BAD_PAYLOAD", "rules must be an object {maxContestTurns?, contestIdleMessages?}");
  }
  return {
    maxContestTurns:
      value.maxContestTurns === undefined ? DEFAULT_BOARD_RULES.maxContestTurns : positiveInt(value, "maxContestTurns", 20),
    contestIdleMessages:
      value.contestIdleMessages === undefined
        ? DEFAULT_BOARD_RULES.contestIdleMessages
        : positiveInt(value, "contestIdleMessages", 10000),
  };
}

/** Validate and normalize one payload by type. */
function parsePayload(type: BoardMessageType, raw: Raw): BoardPayloads[BoardMessageType] {
  const L = BOARD_LIMITS;
  switch (type) {
    case "goal.posted":
      return { objective: text(raw, "objective", L.maxRationale), rules: rules(raw) };
    case "item.proposed":
      return {
        item: id(raw, "item"),
        objective: text(raw, "objective", L.maxObjective),
        acceptance: textList(raw, "acceptance", L.maxAcceptance, L.maxObjective),
        scopeHint: pathList(raw, "scopeHint", { optional: true, max: L.maxIntentEntries }),
      };
    case "item.claimed":
      return { item: id(raw, "item"), intent: intent(raw, "intent") };
    case "claim.granted":
      return { item: id(raw, "item"), agent: id(raw, "agent"), intent: intent(raw, "intent") };
    case "claim.contested":
      return {
        contest: id(raw, "contest"),
        item: id(raw, "item"),
        claimant: id(raw, "claimant"),
        owner: id(raw, "owner"),
        ownerItem: id(raw, "ownerItem"),
        overlap: pathList(raw, "overlap"),
        intent: intent(raw, "intent"),
      };
    case "claim.ceded":
    case "claim.kept":
      return { contest: id(raw, "contest") };
    case "claim.narrowed":
      return { contest: id(raw, "contest"), write: pathList(raw, "write", { max: L.maxIntentEntries }) };
    case "claim.resolved": {
      const winner = optionalId(raw, "winner");
      return {
        contest: id(raw, "contest"),
        how: oneOf(raw, "how", [
          "owner-ceded",
          "claimant-withdrew",
          "narrowed",
          "owner-released",
          "human-decided",
        ] as const),
        ...(winner !== undefined ? { winner } : {}),
      };
    }
    case "claim.escalated":
      return {
        contest: id(raw, "contest"),
        item: id(raw, "item"),
        owner: id(raw, "owner"),
        claimant: id(raw, "claimant"),
        overlap: pathList(raw, "overlap"),
        turns: nonNegativeInt(raw, "turns"),
        reason: oneOf(raw, "reason", ["turns", "idle"] as const),
      };
    case "item.split":
      return { item: id(raw, "item"), children: children(raw) };
    case "item.discovered": {
      const parent = optionalId(raw, "parent");
      return {
        item: id(raw, "item"),
        objective: text(raw, "objective", L.maxObjective),
        reason: text(raw, "reason", 200),
        ...(parent !== undefined ? { parent } : {}),
      };
    }
    case "help.requested":
      return { request: id(raw, "request"), item: id(raw, "item"), need: id(raw, "need") };
    case "help.offered":
      return { request: id(raw, "request") };
    case "contract.proposed": {
      const [target] = pathList({ target: [raw.target] }, "target");
      return {
        contract: id(raw, "contract"),
        target: target!,
        kind: oneOf(raw, "kind", ["add", "modify", "remove"] as const),
      };
    }
    case "contract.accepted":
    case "contract.rejected":
      return { contract: id(raw, "contract") };
    case "push.announced":
      return { item: id(raw, "item"), commit: id(raw, "commit"), paths: pathList(raw, "paths", { concrete: true }) };
    case "integrated.rev":
      return {
        n: positiveInt(raw, "n"),
        commit: id(raw, "commit"),
        gate: oneOf(raw, "gate", ["pass", "fail"] as const),
        merged: idList(raw, "merged", { max: L.maxIntentEntries }),
        paths: pathList(raw, "paths", { max: L.maxPaths * L.maxIntentEntries }),
        contributors: idList(raw, "contributors", { max: L.maxAgents }),
      };
    case "rebase.needed":
      return { agent: id(raw, "agent"), n: positiveInt(raw, "n"), paths: pathList(raw, "paths", { max: L.maxPaths * L.maxIntentEntries }) };
    case "review.requested":
      return { review: id(raw, "review"), item: id(raw, "item") };
    case "review.result":
      return { review: id(raw, "review"), findings: findings(raw) };
    case "handoff": {
      const capsule = raw.capsule;
      if (!isRecord(capsule)) {
        fail("BAD_PAYLOAD", "capsule must be an object {repo, commit?}");
      }
      const commit = optionalId(capsule, "commit");
      return {
        item: id(raw, "item"),
        to: id(raw, "to"),
        capsule: { repo: text(capsule, "repo", L.maxObjective), ...(commit !== undefined ? { commit } : {}) },
      };
    }
    case "done.proposed": {
      const commit = optionalId(raw, "commit");
      return { item: id(raw, "item"), ...(commit !== undefined ? { commit } : {}) };
    }
    case "item.completed":
      return {
        item: id(raw, "item"),
        n: positiveInt(raw, "n"),
        via: oneOf(raw, "via", ["integrated", "children"] as const),
      };
    case "tool.proposed":
      return {
        tool: id(raw, "tool"),
        capability: id(raw, "capability"),
        inputs: idList(raw, "inputs", { optional: true }),
        outputs: idList(raw, "outputs", { optional: true }),
      };
    case "tool.published": {
      if (raw.verified !== true) {
        fail("INVALID_STATE", "a tool can only be published after it passed its own gate (verified must be true)");
      }
      return {
        tool: id(raw, "tool"),
        capability: id(raw, "capability"),
        version: id(raw, "version"),
        repo: text(raw, "repo", L.maxObjective),
        commit: id(raw, "commit"),
        verified: true,
      };
    }
    case "tool.used":
      return {
        capability: id(raw, "capability"),
        version: id(raw, "version"),
        changedFiles: pathList(raw, "changedFiles", { concrete: true, optional: true }),
      };
    case "agent.joined": {
      const role = optionalId(raw, "role");
      return role !== undefined ? { role } : {};
    }
    case "agent.left":
      return {};
  }
}

/**
 * Structurally validate one incoming message (envelope plus per-type payload)
 * and return the normalized draft, attributed to `from` (the authenticated
 * sender). A `from` in the body must match it. Unknown types, unknown envelope
 * fields, and malformed payloads are rejected.
 */
export function parseBoardDraft(raw: unknown, from: string): BoardDraft {
  if (!isRecord(raw)) {
    fail("BAD_PAYLOAD", "a board message must be a JSON object");
  }
  for (const key of Object.keys(raw)) {
    if (!["from", "type", "payload", "rationale", "inReplyTo", "to"].includes(key)) {
      fail("BAD_PAYLOAD", `unknown envelope field ${JSON.stringify(key)} (seq and at are assigned by the board)`);
    }
  }
  if (raw.from !== undefined && raw.from !== from) {
    fail("AUTH", `from ${JSON.stringify(raw.from)} does not match the authenticated sender ${from}`);
  }
  const type = raw.type;
  if (typeof type !== "string" || !BOARD_MESSAGE_TYPES.includes(type as BoardMessageType)) {
    fail("BAD_PAYLOAD", `unknown message type ${JSON.stringify(type)}`);
  }
  const payloadRaw = raw.payload === undefined ? {} : raw.payload;
  if (!isRecord(payloadRaw)) {
    fail("BAD_PAYLOAD", "payload must be an object");
  }
  const payload = parsePayload(type as BoardMessageType, payloadRaw);
  let rationale: string | undefined;
  if (raw.rationale !== undefined) {
    if (typeof raw.rationale !== "string" || raw.rationale.length > BOARD_LIMITS.maxRationale) {
      fail("BAD_PAYLOAD", `rationale must be a string of at most ${BOARD_LIMITS.maxRationale} characters`);
    }
    rationale = raw.rationale;
  }
  const inReplyTo = raw.inReplyTo === undefined ? undefined : positiveInt(raw, "inReplyTo");
  let to: string[] | undefined;
  if (raw.to !== undefined) {
    to = typeof raw.to === "string" ? idList({ to: [raw.to] }, "to") : idList(raw, "to", { max: BOARD_LIMITS.maxRecipients });
    if (to.length === 0) {
      fail("BAD_PAYLOAD", "to must name at least one agent when present");
    }
  }
  return {
    from,
    type,
    payload,
    ...(rationale !== undefined ? { rationale } : {}),
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(to !== undefined ? { to } : {}),
  } as BoardDraft;
}

// ---------------------------------------------------------------------------
// Transition rules (semantic validation against the current state)
// ---------------------------------------------------------------------------

type Senders = "human" | "engine" | "agent" | "lead";

const ALLOWED_SENDERS: Record<BoardMessageType, readonly Senders[]> = {
  "goal.posted": ["human"],
  "item.proposed": ["human", "agent"],
  "item.claimed": ["agent"],
  "claim.granted": ["engine"],
  "claim.contested": ["engine"],
  "claim.ceded": ["agent"],
  "claim.kept": ["agent"],
  "claim.narrowed": ["agent"],
  "claim.resolved": ["engine", "human"],
  "claim.escalated": ["engine"],
  "item.split": ["agent"],
  "item.discovered": ["agent"],
  "help.requested": ["agent"],
  "help.offered": ["agent"],
  "contract.proposed": ["agent"],
  "contract.accepted": ["lead", "human"],
  "contract.rejected": ["lead", "human"],
  "push.announced": ["agent"],
  "integrated.rev": ["engine"],
  "rebase.needed": ["engine"],
  "review.requested": ["agent"],
  "review.result": ["agent"],
  handoff: ["agent"],
  "done.proposed": ["agent"],
  "item.completed": ["engine"],
  "tool.proposed": ["agent"],
  "tool.published": ["agent"],
  "tool.used": ["agent"],
  "agent.joined": ["agent"],
  "agent.left": ["agent"],
};

function senderKinds(state: BoardState, from: string): Senders[] {
  if (from === BOARD_HUMAN) {
    return ["human"];
  }
  if (from === BOARD_ENGINE) {
    return ["engine"];
  }
  return state.agents[from]?.role === LEAD_ROLE ? ["agent", "lead"] : ["agent"];
}

function requireItem(state: BoardState, item: string): BoardItem {
  return state.items[item] ?? fail("UNKNOWN_REF", `unknown item ${item}`);
}

function requireOwner(state: BoardState, item: string, agent: string): BoardItem {
  const found = requireItem(state, item);
  if (found.status !== "claimed" || found.owner !== agent) {
    fail("NOT_OWNER", `${agent} does not hold the claim on item ${item} (it is ${found.status})`);
  }
  return found;
}

function activeAgent(state: BoardState, agent: string): boolean {
  const record = state.agents[agent];
  return record !== undefined && record.leftSeq === undefined;
}

function requireContestParty(state: BoardState, contestId: string, agent: string): BoardContest {
  const contest = state.contests[contestId] ?? fail("UNKNOWN_REF", `unknown contest ${contestId}`);
  if (contest.status === "resolved") {
    fail("CONTEST_CLOSED", `contest ${contestId} is already resolved`);
  }
  if (agent !== contest.owner && agent !== contest.claimant) {
    fail("NOT_ALLOWED", `${agent} is not a party to contest ${contestId}`);
  }
  return contest;
}

function pendingContestOn(state: BoardState, item: string): BoardContest | undefined {
  return Object.values(state.contests).find(
    (c) => c.status !== "resolved" && (c.ownerItem === item || c.item === item),
  );
}

/** Live claims held by agents other than `except`, excluding `skipItem`. */
function liveClaims(state: BoardState, except: string, skipItem?: string): BoardItem[] {
  return Object.values(state.items)
    .filter((i) => i.status === "claimed" && i.owner !== undefined && i.owner !== except && i.intent && i.id !== skipItem)
    .sort((a, b) => (a.grantedSeq ?? 0) - (b.grantedSeq ?? 0));
}

/** The item whose latest, not yet integrated push has this commit. */
function itemForPendingPush(state: BoardState, commit: string): BoardItem | undefined {
  return Object.values(state.items).find(
    (i) => i.lastPush !== undefined && i.lastPush.commit === commit && i.lastPush.integratedIn === undefined,
  );
}

/**
 * Check that `draft` is a valid next message for `state`. `mode` is "posted"
 * for a participant's message (agent or human) and "engine" for a message the
 * engine produced (derived by arbitration, or an integrated revision).
 */
export function checkBoardTransition(state: BoardState, draft: BoardDraft, mode: "posted" | "engine"): void {
  const kinds = senderKinds(state, draft.from);
  if (mode === "posted" && draft.from === BOARD_ENGINE) {
    fail("NOT_ALLOWED", "engine messages are never posted by a participant");
  }
  if (!ALLOWED_SENDERS[draft.type].some((k) => kinds.includes(k))) {
    const who = kinds.includes("agent") ? "an agent" : draft.from;
    fail("NOT_ALLOWED", `${draft.type} cannot be sent by ${who}`);
  }
  if (draft.inReplyTo !== undefined && draft.inReplyTo > state.lastSeq) {
    fail("UNKNOWN_REF", `inReplyTo ${draft.inReplyTo} names no recorded message`);
  }
  if (draft.type === "goal.posted") {
    if (state.goal !== null) {
      fail("DUPLICATE", "the board already has a goal");
    }
    return;
  }
  if (state.goal === null) {
    fail("NO_GOAL", "the board has no goal yet; post goal.posted first");
  }
  if (kinds.includes("agent")) {
    if (draft.type === "agent.joined") {
      if (RESERVED_SENDERS.has(draft.from)) {
        fail("NOT_ALLOWED", `${draft.from} is reserved and cannot join as an agent`);
      }
      if (state.agents[draft.from] !== undefined) {
        fail("DUPLICATE", `agent ${draft.from} already joined this board`);
      }
      if (Object.keys(state.agents).length >= BOARD_LIMITS.maxAgents) {
        fail("LIMIT", `a board admits at most ${BOARD_LIMITS.maxAgents} agents`);
      }
      if (
        draft.payload.role === LEAD_ROLE &&
        Object.values(state.agents).some((a) => a.role === LEAD_ROLE && a.leftSeq === undefined)
      ) {
        fail("DUPLICATE", "the board already has an active lead");
      }
      return;
    }
    if (!activeAgent(state, draft.from)) {
      fail("UNKNOWN_AGENT", `agent ${draft.from} has not joined this board (or has left)`);
    }
  }
  for (const recipient of draft.to ?? []) {
    if (recipient === draft.from || !activeAgent(state, recipient)) {
      fail("UNKNOWN_AGENT", `to names ${recipient}, which is not another joined agent`);
    }
  }

  const itemCount = Object.keys(state.items).length;
  switch (draft.type) {
    case "item.proposed":
    case "item.discovered": {
      if (state.items[draft.payload.item]) {
        fail("DUPLICATE", `item ${draft.payload.item} already exists`);
      }
      if (itemCount + 1 > BOARD_LIMITS.maxItems) {
        fail("LIMIT", `a board holds at most ${BOARD_LIMITS.maxItems} items`);
      }
      if (draft.type === "item.discovered" && draft.payload.parent !== undefined) {
        requireItem(state, draft.payload.parent);
      }
      return;
    }
    case "item.claimed": {
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "open") {
        const by = item.owner ?? item.claimant?.agent;
        fail("ITEM_NOT_OPEN", `item ${item.id} is ${item.status}${by ? ` (by ${by})` : ""} and cannot be claimed`);
      }
      if (draft.payload.intent.write.length === 0) {
        fail("BAD_PAYLOAD", "a claim must declare at least one write intent");
      }
      return;
    }
    case "claim.granted": {
      const item = requireItem(state, draft.payload.item);
      const pendingForAgent = item.status === "contested" && item.claimant?.agent === draft.payload.agent;
      if (item.status !== "open" && !pendingForAgent) {
        fail("ITEM_NOT_OPEN", `item ${item.id} is ${item.status} and cannot be granted`);
      }
      const clash = liveClaims(state, draft.payload.agent).find(
        (holder) => overlappingEntries(draft.payload.intent.write, holder.intent!.write).length > 0,
      );
      if (clash) {
        fail("INTENT_OVERLAP", `a grant of ${item.id} would overlap ${clash.owner}'s claim on ${clash.id}`);
      }
      return;
    }
    case "claim.contested": {
      const item = requireItem(state, draft.payload.item);
      requireOwner(state, draft.payload.ownerItem, draft.payload.owner);
      if (item.status !== "open" && item.claimant?.agent !== draft.payload.claimant) {
        fail("ITEM_NOT_OPEN", `item ${item.id} is ${item.status} and cannot be contested`);
      }
      if (state.contests[draft.payload.contest]) {
        fail("DUPLICATE", `contest ${draft.payload.contest} already exists`);
      }
      return;
    }
    case "claim.kept": {
      const contest = requireContestParty(state, draft.payload.contest, draft.from);
      if (contest.status === "escalated") {
        fail("CONTEST_OPEN", `contest ${contest.id} is escalated and waits for a human decision`);
      }
      return;
    }
    case "claim.ceded":
      requireContestParty(state, draft.payload.contest, draft.from);
      return;
    case "claim.narrowed": {
      const contest = requireContestParty(state, draft.payload.contest, draft.from);
      const current =
        draft.from === contest.owner
          ? state.items[contest.ownerItem]?.intent?.write ?? []
          : state.items[contest.item]?.claimant?.intent.write ?? [];
      if (draft.payload.write.length === 0) {
        fail("BAD_PAYLOAD", "a narrowed write intent cannot be empty (cede the claim instead)");
      }
      if (!intentWithin(draft.payload.write, current)) {
        fail("NOT_WITHIN", `a narrowed write intent must stay within the previous one (${current.join(", ")})`);
      }
      return;
    }
    case "claim.resolved": {
      const contest = state.contests[draft.payload.contest] ?? fail("UNKNOWN_REF", `unknown contest ${draft.payload.contest}`);
      if (contest.status === "resolved") {
        fail("CONTEST_CLOSED", `contest ${contest.id} is already resolved`);
      }
      if (draft.from === BOARD_HUMAN) {
        if (draft.payload.how !== "human-decided") {
          fail("BAD_PAYLOAD", 'a human resolution must use how "human-decided"');
        }
      } else if (draft.payload.how === "human-decided") {
        fail("NOT_ALLOWED", 'only a human can resolve a contest with how "human-decided"');
      }
      if (
        draft.payload.winner !== undefined &&
        draft.payload.winner !== contest.owner &&
        draft.payload.winner !== contest.claimant
      ) {
        fail("BAD_PAYLOAD", `winner must be ${contest.owner} or ${contest.claimant}`);
      }
      if (draft.payload.how === "human-decided" && draft.payload.winner === undefined) {
        fail("BAD_PAYLOAD", "a human-decided resolution must name the winner");
      }
      return;
    }
    case "claim.escalated": {
      const contest = state.contests[draft.payload.contest];
      if (!contest || contest.status !== "open") {
        fail("CONTEST_CLOSED", `contest ${draft.payload.contest} is not open`);
      }
      return;
    }
    case "item.split": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      if (pendingContestOn(state, item.id)) {
        fail("CONTEST_OPEN", `item ${item.id} is in a contest; resolve it before splitting`);
      }
      if (itemCount + draft.payload.children.length > BOARD_LIMITS.maxItems) {
        fail("LIMIT", `a board holds at most ${BOARD_LIMITS.maxItems} items`);
      }
      for (const child of draft.payload.children) {
        if (state.items[child.item]) {
          fail("DUPLICATE", `item ${child.item} already exists`);
        }
      }
      return;
    }
    case "help.requested":
      requireOwner(state, draft.payload.item, draft.from);
      if (state.help[draft.payload.request]) {
        fail("DUPLICATE", `help request ${draft.payload.request} already exists`);
      }
      return;
    case "help.offered": {
      const request = state.help[draft.payload.request] ?? fail("UNKNOWN_REF", `unknown help request ${draft.payload.request}`);
      if (request.by === draft.from) {
        fail("NOT_ALLOWED", "an agent cannot offer help on its own request");
      }
      if (request.offers.includes(draft.from)) {
        fail("DUPLICATE", `${draft.from} already offered help on ${request.request}`);
      }
      return;
    }
    case "contract.proposed":
      if (state.contracts[draft.payload.contract]) {
        fail("DUPLICATE", `contract ${draft.payload.contract} already exists`);
      }
      return;
    case "contract.accepted":
    case "contract.rejected": {
      const contract = state.contracts[draft.payload.contract] ?? fail("UNKNOWN_REF", `unknown contract ${draft.payload.contract}`);
      if (contract.status !== "proposed") {
        fail("INVALID_STATE", `contract ${contract.contract} is already ${contract.status}`);
      }
      return;
    }
    case "push.announced": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      const write = item.intent?.write ?? [];
      const outside = draft.payload.paths.filter((p) => !write.some((w) => entriesOverlap(p, w)));
      if (outside.length > 0) {
        fail("OUTSIDE_INTENT", `pushed paths outside the claim's write intent: ${outside.join(", ")}`);
      }
      const other = itemForPendingPush(state, draft.payload.commit);
      if (other && other.id !== item.id) {
        fail("DUPLICATE", `commit ${draft.payload.commit} is already the pending push of item ${other.id}`);
      }
      return;
    }
    case "integrated.rev": {
      const expected = integratedRevPayload(state, {
        commit: draft.payload.commit,
        gate: draft.payload.gate,
        merged: draft.payload.merged,
      });
      if (!sameJson(expected, draft.payload)) {
        fail("LOG_MISMATCH", "integrated.rev does not match the pushes it claims to merge");
      }
      return;
    }
    case "rebase.needed":
      if (!state.agents[draft.payload.agent]) {
        fail("UNKNOWN_AGENT", `unknown agent ${draft.payload.agent}`);
      }
      return;
    case "review.requested":
      requireOwner(state, draft.payload.item, draft.from);
      if (state.reviews[draft.payload.review]) {
        fail("DUPLICATE", `review ${draft.payload.review} already exists`);
      }
      return;
    case "review.result": {
      const review = state.reviews[draft.payload.review] ?? fail("UNKNOWN_REF", `unknown review ${draft.payload.review}`);
      if (review.findings !== undefined) {
        fail("DUPLICATE", `review ${review.review} already has a result`);
      }
      if (review.by === draft.from) {
        fail("NOT_ALLOWED", "an agent cannot review its own item");
      }
      return;
    }
    case "handoff": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      if (pendingContestOn(state, item.id)) {
        fail("CONTEST_OPEN", `item ${item.id} is in a contest; resolve it before handing off`);
      }
      if (draft.payload.to === draft.from || !activeAgent(state, draft.payload.to)) {
        fail("UNKNOWN_AGENT", `cannot hand off to ${draft.payload.to}: not another joined agent`);
      }
      // After the handoff the recipient writes this intent, so it must not
      // overlap any claim held by anyone else (the sender's other claims too).
      const clash = liveClaims(state, draft.payload.to, item.id).find(
        (holder) => overlappingEntries(item.intent?.write ?? [], holder.intent!.write).length > 0,
      );
      if (clash) {
        fail(
          "INTENT_OVERLAP",
          `handing ${item.id} to ${draft.payload.to} would overlap ${clash.owner}'s claim on ${clash.id}`,
        );
      }
      return;
    }
    case "done.proposed":
      requireOwner(state, draft.payload.item, draft.from);
      return;
    case "item.completed": {
      const item = requireItem(state, draft.payload.item);
      if (item.status === "done") {
        fail("INVALID_STATE", `item ${item.id} is already done`);
      }
      if (!state.passingRevs.includes(draft.payload.n)) {
        fail("INVALID_STATE", `item.completed must cite a passing integrated revision (rev ${draft.payload.n} did not pass)`);
      }
      if (draft.payload.via === "integrated") {
        if (item.status !== "claimed" || !item.doneProposed) {
          fail("INVALID_STATE", `item ${item.id} has no done proposal from its owner`);
        }
        if (item.lastPush?.integratedIn !== draft.payload.n) {
          fail("INVALID_STATE", `the owner's latest push for ${item.id} was not merged by passing rev ${draft.payload.n}`);
        }
      } else if (item.status !== "split" || !item.children.every((c) => state.items[c]?.status === "done")) {
        fail("INVALID_STATE", `item ${item.id} still has unfinished children`);
      }
      return;
    }
    case "tool.proposed":
      if (state.tools.proposed[draft.payload.tool]) {
        fail("DUPLICATE", `tool ${draft.payload.tool} was already proposed`);
      }
      return;
    case "tool.published": {
      const proposal =
        state.tools.proposed[draft.payload.tool] ??
        fail("UNKNOWN_REF", `tool ${draft.payload.tool} must be proposed (tool.proposed) before it is published`);
      if (proposal.proposedBy !== draft.from) {
        fail("NOT_ALLOWED", `only ${proposal.proposedBy}, who proposed tool ${proposal.tool}, can publish it`);
      }
      if (proposal.capability !== draft.payload.capability) {
        fail("BAD_PAYLOAD", `tool ${proposal.tool} was proposed with capability ${proposal.capability}`);
      }
      if (state.tools.published.some((t) => t.capability === draft.payload.capability && t.version === draft.payload.version)) {
        fail("DUPLICATE", `${draft.payload.capability}@${draft.payload.version} is already published`);
      }
      if (state.tools.published.length >= BOARD_LIMITS.maxTools) {
        fail("LIMIT", `a board publishes at most ${BOARD_LIMITS.maxTools} tool versions`);
      }
      return;
    }
    case "tool.used":
      if (!state.tools.published.some((t) => t.capability === draft.payload.capability && t.version === draft.payload.version)) {
        fail("UNKNOWN_REF", `${draft.payload.capability}@${draft.payload.version} is not a published tool version`);
      }
      return;
    case "agent.left": {
      const holding = Object.values(state.items).filter(
        (i) => (i.status === "claimed" && i.owner === draft.from) || i.claimant?.agent === draft.from,
      );
      if (holding.length > 0) {
        fail("INVALID_STATE", `${draft.from} still holds ${holding.map((i) => i.id).join(", ")}; hand off or complete first`);
      }
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply one already-validated message. Returns a new state; the input is not
 * modified. Use `foldBoard` to apply many messages in linear time.
 */
export function applyBoardMessage(previous: BoardState, message: BoardMessage): BoardState {
  const state = cloneState(previous);
  applyInPlace(state, message);
  return state;
}

/** Apply one message by mutating `state`. */
function applyInPlace(state: BoardState, message: BoardMessage): void {
  state.lastSeq = message.seq;
  const from = message.from;
  switch (message.type) {
    case "goal.posted":
      state.goal = { objective: message.payload.objective, seq: message.seq };
      state.rules = { ...message.payload.rules };
      break;
    case "item.proposed":
      state.items[message.payload.item] = {
        id: message.payload.item,
        objective: message.payload.objective,
        acceptance: message.payload.acceptance,
        scopeHint: message.payload.scopeHint,
        status: "open",
        proposedBy: from,
        proposedSeq: message.seq,
        children: [],
        doneProposed: false,
      };
      break;
    case "item.discovered": {
      const p = message.payload;
      state.items[p.item] = {
        id: p.item,
        objective: p.objective,
        acceptance: [],
        scopeHint: [],
        status: "open",
        proposedBy: from,
        proposedSeq: message.seq,
        ...(p.parent !== undefined ? { parent: p.parent } : {}),
        children: [],
        discovered: { by: from, reason: p.reason },
        doneProposed: false,
      };
      break;
    }
    case "item.claimed":
      // The claim takes effect through the engine's claim.granted or
      // claim.contested, appended in the same board call.
      break;
    case "claim.granted": {
      const item = state.items[message.payload.item]!;
      item.status = "claimed";
      item.owner = message.payload.agent;
      item.intent = message.payload.intent;
      item.grantedSeq = message.seq;
      delete item.claimant;
      break;
    }
    case "claim.contested": {
      const p = message.payload;
      const item = state.items[p.item]!;
      item.status = "contested";
      item.claimant = { agent: p.claimant, intent: p.intent, contest: p.contest };
      state.contests[p.contest] = {
        id: p.contest,
        item: p.item,
        claimant: p.claimant,
        owner: p.owner,
        ownerItem: p.ownerItem,
        overlap: p.overlap,
        status: "open",
        turns: 0,
        openedSeq: message.seq,
        lastActionSeq: message.seq,
      };
      break;
    }
    case "claim.kept": {
      const contest = state.contests[message.payload.contest]!;
      contest.turns += 1;
      contest.lastActionSeq = message.seq;
      break;
    }
    case "claim.narrowed": {
      const contest = state.contests[message.payload.contest]!;
      contest.turns += 1;
      contest.lastActionSeq = message.seq;
      if (from === contest.owner) {
        const ownerItem = state.items[contest.ownerItem]!;
        ownerItem.intent = { read: ownerItem.intent?.read ?? [], write: message.payload.write };
      } else {
        const claimant = state.items[contest.item]!.claimant!;
        claimant.intent = { read: claimant.intent.read, write: message.payload.write };
      }
      break;
    }
    case "claim.ceded": {
      const contest = state.contests[message.payload.contest]!;
      contest.lastActionSeq = message.seq;
      if (from === contest.owner) {
        releaseClaim(state.items[contest.ownerItem]!);
      } else {
        const item = state.items[contest.item]!;
        item.status = "open";
        delete item.claimant;
      }
      break;
    }
    case "claim.resolved": {
      const p = message.payload;
      const contest = state.contests[p.contest]!;
      contest.status = "resolved";
      contest.how = p.how;
      if (p.winner !== undefined) {
        contest.winner = p.winner;
      }
      if (p.how === "human-decided") {
        if (p.winner === contest.owner) {
          const item = state.items[contest.item]!;
          if (item.claimant?.contest === contest.id) {
            item.status = "open";
            delete item.claimant;
          }
        } else {
          releaseClaim(state.items[contest.ownerItem]!);
        }
      }
      break;
    }
    case "claim.escalated":
      state.contests[message.payload.contest]!.status = "escalated";
      break;
    case "item.split": {
      const parent = state.items[message.payload.item]!;
      parent.status = "split";
      delete parent.intent;
      for (const child of message.payload.children) {
        parent.children.push(child.item);
        state.items[child.item] = {
          id: child.item,
          objective: child.objective,
          acceptance: child.acceptance,
          scopeHint: child.scopeHint,
          status: "open",
          proposedBy: from,
          proposedSeq: message.seq,
          parent: parent.id,
          children: [],
          doneProposed: false,
        };
      }
      break;
    }
    case "help.requested":
      state.help[message.payload.request] = {
        request: message.payload.request,
        item: message.payload.item,
        need: message.payload.need,
        by: from,
        offers: [],
      };
      break;
    case "help.offered":
      state.help[message.payload.request]!.offers.push(from);
      break;
    case "contract.proposed":
      state.contracts[message.payload.contract] = {
        contract: message.payload.contract,
        target: message.payload.target,
        kind: message.payload.kind,
        proposedBy: from,
        status: "proposed",
      };
      break;
    case "contract.accepted":
    case "contract.rejected": {
      const contract = state.contracts[message.payload.contract]!;
      contract.status = message.type === "contract.accepted" ? "accepted" : "rejected";
      contract.decidedBy = from;
      break;
    }
    case "push.announced":
      state.pushes += 1;
      state.items[message.payload.item]!.lastPush = {
        seq: message.seq,
        commit: message.payload.commit,
        agent: from,
        paths: message.payload.paths,
      };
      break;
    case "integrated.rev":
      state.lastRevN = message.payload.n;
      if (message.payload.gate === "pass") {
        state.integrated = { n: message.payload.n, commit: message.payload.commit, seq: message.seq };
        state.passingRevs.push(message.payload.n);
        for (const commit of message.payload.merged) {
          const item = itemForPendingPush(state, commit);
          if (item?.lastPush) {
            item.lastPush.integratedIn = message.payload.n;
          }
        }
      }
      break;
    case "rebase.needed":
      state.agents[message.payload.agent]!.rebaseTo = message.payload.n;
      break;
    case "review.requested":
      state.reviews[message.payload.review] = {
        review: message.payload.review,
        item: message.payload.item,
        by: from,
      };
      break;
    case "review.result": {
      const review = state.reviews[message.payload.review]!;
      review.reviewer = from;
      review.findings = message.payload.findings;
      break;
    }
    case "handoff": {
      const item = state.items[message.payload.item]!;
      item.owner = message.payload.to;
      // The new owner proposes done for itself.
      item.doneProposed = false;
      break;
    }
    case "done.proposed":
      state.items[message.payload.item]!.doneProposed = true;
      break;
    case "item.completed": {
      const item = state.items[message.payload.item]!;
      item.status = "done";
      item.completed = { n: message.payload.n, via: message.payload.via };
      delete item.intent;
      break;
    }
    case "tool.proposed":
      state.tools.proposed[message.payload.tool] = {
        tool: message.payload.tool,
        capability: message.payload.capability,
        inputs: message.payload.inputs,
        outputs: message.payload.outputs,
        proposedBy: from,
      };
      break;
    case "tool.published":
      state.tools.published.push({
        tool: message.payload.tool,
        capability: message.payload.capability,
        version: message.payload.version,
        repo: message.payload.repo,
        commit: message.payload.commit,
        publishedBy: from,
        seq: message.seq,
        uses: 0,
      });
      break;
    case "tool.used": {
      const tool = state.tools.published.find(
        (t) => t.capability === message.payload.capability && t.version === message.payload.version,
      );
      if (tool) {
        tool.uses += 1;
      }
      break;
    }
    case "agent.joined":
      state.agents[from] = {
        id: from,
        ...(message.payload.role !== undefined ? { role: message.payload.role } : {}),
        joinedSeq: message.seq,
      };
      break;
    case "agent.left":
      state.agents[from]!.leftSeq = message.seq;
      break;
  }
}

/** Release a held claim: the item reopens for anyone to claim. */
function releaseClaim(item: BoardItem): void {
  delete item.intent;
  delete item.owner;
  delete item.grantedSeq;
  delete item.lastPush;
  item.doneProposed = false;
  item.status = "open";
}

/**
 * Fold the log up to and including `k` (default: all) WITHOUT re-checking, in
 * linear time: one copy of the empty board, then each message applied in
 * place. Engine messages are applied as they come, so a `k` in the middle of an
 * engine batch shows the board partway through that batch, exactly as the
 * messages were recorded. For console replay at an arbitrary point; use
 * `reduceBoard` to verify a log.
 */
export function foldBoard(messages: readonly BoardMessage[], k = Number.POSITIVE_INFINITY): BoardState {
  const state = emptyBoard();
  for (const message of messages) {
    if (message.seq > k) {
      break;
    }
    applyInPlace(state, message);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Arbitration
// ---------------------------------------------------------------------------

/** Check a message against the state, then apply it in place. */
function step(state: BoardState, message: BoardMessage, mode: "posted" | "engine"): void {
  checkBoardTransition(state, message, mode);
  applyInPlace(state, message);
}

/**
 * Decide a claim against every live claim held by OTHER agents: the
 * earliest-granted overlapping write intent opens a contest, otherwise the
 * claim is granted. Read intents never block. An agent's own claims never
 * contest each other (it is a single writer); handoff re-checks overlap so two
 * agents can never end up owning overlapping writes that way.
 */
function decideClaim(
  state: BoardState,
  item: string,
  agent: string,
  intent: BoardIntent,
  contestId: string,
): BoardDraft {
  for (const holder of liveClaims(state, agent)) {
    const overlap = overlappingEntries(intent.write, holder.intent!.write);
    if (overlap.length > 0) {
      return {
        from: BOARD_ENGINE,
        type: "claim.contested",
        payload: { contest: contestId, item, claimant: agent, owner: holder.owner!, ownerItem: holder.id, overlap, intent },
      };
    }
  }
  return { from: BOARD_ENGINE, type: "claim.granted", payload: { item, agent, intent } };
}

/**
 * Apply `incoming` to `work` (mutating it) and every engine message it
 * triggers, returning those engine messages. Rules:
 *   1. item.claimed: a free write intent is granted; an overlapping one opens
 *      a contest naming the owner and the overlap. Read intents never block.
 *   2. claim.ceded by the owner releases its claim and the claimant is
 *      re-decided; ceded by the claimant withdraws the claim.
 *   3. claim.narrowed that removes the overlap resolves the contest and the
 *      claimant is re-decided. An owner's narrowing re-checks EVERY contest
 *      on its item. claim.kept, or a narrowing that still overlaps, counts a
 *      turn; at the turn limit the contest escalates.
 *   4. A contest no party has acted on for the idle limit (in board messages)
 *      escalates too. Escalation asks a human; it never decides.
 *   5. claim.resolved by a human for the claimant re-decides the claimant.
 *   6. A released owner claim (completion or split) resolves any contest
 *      waiting on it, and the claimant is re-decided.
 *   7. An item completes when its owner proposed done AND a passing
 *      integrated revision merged its latest push (checked on both events).
 *      Completing the last child of a split item completes the parent.
 *   8. A passing integrated.rev sends rebase.needed to every active agent
 *      (other than the contributors) whose live read or write intent
 *      intersects the changed paths.
 */
function arbitrateInPlace(work: BoardState, incoming: BoardMessage): BoardDraft[] {
  step(work, incoming, incoming.from === BOARD_ENGINE ? "engine" : "posted");
  const out: BoardDraft[] = [];
  let seq = incoming.seq;
  // A contest is named after the seq its claim.contested message receives.
  const nextContestId = (): string => `contest-${seq + 1}`;
  const rules = work.rules;

  const emit = (draft: BoardDraft): void => {
    seq += 1;
    const withReply = { ...draft, inReplyTo: incoming.seq } as BoardDraft;
    step(work, { ...withReply, seq, at: incoming.at } as BoardMessage, "engine");
    out.push(withReply);
  };

  const redecide = (contest: BoardContest): void => {
    const item = work.items[contest.item];
    if (!item || item.claimant === undefined || item.claimant.contest !== contest.id) {
      return;
    }
    emit(decideClaim(work, item.id, item.claimant.agent, item.claimant.intent, nextContestId()));
  };

  const resolveIfClear = (contest: BoardContest): boolean => {
    const claimantWrite = work.items[contest.item]?.claimant?.intent.write ?? [];
    const ownerWrite = work.items[contest.ownerItem]?.intent?.write ?? [];
    if (overlappingEntries(claimantWrite, ownerWrite).length > 0) {
      return false;
    }
    emit({ from: BOARD_ENGINE, type: "claim.resolved", payload: { contest: contest.id, how: "narrowed" } });
    redecide(work.contests[contest.id]!);
    return true;
  };

  const escalate = (contest: BoardContest, reason: "turns" | "idle"): void => {
    const claimantWrite = work.items[contest.item]?.claimant?.intent.write ?? [];
    const ownerWrite = work.items[contest.ownerItem]?.intent?.write ?? [];
    emit({
      from: BOARD_ENGINE,
      type: "claim.escalated",
      payload: {
        contest: contest.id,
        item: contest.item,
        owner: contest.owner,
        claimant: contest.claimant,
        overlap: overlappingEntries(claimantWrite, ownerWrite),
        turns: contest.turns,
        reason,
      },
    });
  };

  const resolveWaitersOn = (ownerItem: string): void => {
    for (const contest of Object.values(work.contests)) {
      if (contest.status !== "resolved" && contest.ownerItem === ownerItem) {
        emit({
          from: BOARD_ENGINE,
          type: "claim.resolved",
          payload: { contest: contest.id, how: "owner-released", winner: contest.claimant },
        });
        redecide(work.contests[contest.id]!);
      }
    }
  };

  const completeIfReady = (itemId: string): void => {
    const item = work.items[itemId];
    const n = item?.lastPush?.integratedIn;
    if (!item || item.status !== "claimed" || !item.doneProposed || n === undefined) {
      return;
    }
    emit({ from: BOARD_ENGINE, type: "item.completed", payload: { item: item.id, n, via: "integrated" } });
    resolveWaitersOn(item.id);
    let parentId = item.parent;
    while (parentId !== undefined) {
      const parent: BoardItem | undefined = work.items[parentId];
      if (!parent || parent.status !== "split" || !parent.children.every((c) => work.items[c]?.status === "done")) {
        break;
      }
      emit({ from: BOARD_ENGINE, type: "item.completed", payload: { item: parent.id, n, via: "children" } });
      parentId = parent.parent;
    }
  };

  switch (incoming.type) {
    case "item.claimed":
      emit(decideClaim(work, incoming.payload.item, incoming.from, incoming.payload.intent, nextContestId()));
      break;
    case "claim.ceded": {
      const contest = work.contests[incoming.payload.contest]!;
      const ownerCeded = incoming.from === contest.owner;
      emit({
        from: BOARD_ENGINE,
        type: "claim.resolved",
        payload: {
          contest: contest.id,
          how: ownerCeded ? "owner-ceded" : "claimant-withdrew",
          winner: ownerCeded ? contest.claimant : contest.owner,
        },
      });
      if (ownerCeded) {
        redecide(work.contests[contest.id]!);
        resolveWaitersOn(contest.ownerItem);
      }
      break;
    }
    case "claim.narrowed": {
      const named = work.contests[incoming.payload.contest]!;
      if (incoming.from === named.owner) {
        // The owner's write intent changed: every contest on its item may clear.
        for (const contest of Object.values(work.contests)) {
          if (contest.status !== "resolved" && contest.ownerItem === named.ownerItem) {
            resolveIfClear(contest);
          }
        }
      } else {
        resolveIfClear(named);
      }
      const after = work.contests[named.id]!;
      if (after.status === "open" && after.turns >= rules.maxContestTurns) {
        escalate(after, "turns");
      }
      break;
    }
    case "claim.kept": {
      const contest = work.contests[incoming.payload.contest]!;
      if (contest.status === "open" && contest.turns >= rules.maxContestTurns) {
        escalate(contest, "turns");
      }
      break;
    }
    case "claim.resolved": {
      const contest = work.contests[incoming.payload.contest]!;
      if (incoming.payload.how === "human-decided" && incoming.payload.winner === contest.claimant) {
        redecide(contest);
        resolveWaitersOn(contest.ownerItem);
      }
      break;
    }
    case "item.split":
      resolveWaitersOn(incoming.payload.item);
      break;
    case "done.proposed":
      completeIfReady(incoming.payload.item);
      break;
    case "integrated.rev":
      if (incoming.payload.gate === "pass") {
        for (const item of Object.values(work.items)) {
          if (item.lastPush?.integratedIn === incoming.payload.n) {
            completeIfReady(item.id);
          }
        }
        for (const draft of rebaseTargets(work, incoming.payload)) {
          emit(draft);
        }
      }
      break;
    default:
      break;
  }

  // Idle contests: escalate any open contest no party has acted on for the
  // idle limit, measured in board messages. Count-based, so deterministic.
  for (const contest of Object.values(work.contests)) {
    if (contest.status === "open" && incoming.seq - contest.lastActionSeq >= rules.contestIdleMessages) {
      escalate(contest, "idle");
    }
  }
  return out;
}

/**
 * The engine messages an incoming message triggers, in order. `state` is the
 * board BEFORE `incoming` (which must already carry its seq) and is not
 * modified.
 */
export function arbitrate(state: BoardState, incoming: BoardMessage): BoardDraft[] {
  return arbitrateInPlace(cloneState(state), incoming);
}

/** rebase.needed for every active agent whose live intent meets the change. */
function rebaseTargets(state: BoardState, rev: BoardPayloads["integrated.rev"]): BoardDraft[] {
  const out: BoardDraft[] = [];
  for (const agent of Object.values(state.agents)) {
    if (agent.leftSeq !== undefined || rev.contributors.includes(agent.id)) {
      continue;
    }
    const entries: string[] = [];
    for (const item of Object.values(state.items)) {
      if (item.status === "claimed" && item.owner === agent.id && item.intent) {
        entries.push(...item.intent.read, ...item.intent.write);
      }
    }
    const paths = rev.paths.filter((p) => entries.some((e) => entriesOverlap(p, e)));
    if (paths.length > 0) {
      out.push({ from: BOARD_ENGINE, type: "rebase.needed", payload: { agent: agent.id, n: rev.n, paths } });
    }
  }
  return out;
}

/** What the integrator recorded: the revision commit, its gate, and the pushes it merged. */
export interface IntegratedRevInput {
  readonly commit: string;
  readonly gate: "pass" | "fail";
  /** The commits of announced, not yet integrated pushes this revision merged. */
  readonly merged: readonly string[];
}

/**
 * The integrated.rev payload for a recorded integration result: numbered next,
 * with paths and contributors derived from the merged pushes, never taken on
 * trust. Throws when a merged commit is not an announced, unintegrated push.
 */
function integratedRevPayload(state: BoardState, input: IntegratedRevInput): BoardPayloads["integrated.rev"] {
  const paths: string[] = [];
  const contributors: string[] = [];
  for (const commit of input.merged) {
    const item = itemForPendingPush(state, commit);
    if (!item?.lastPush) {
      fail("UNKNOWN_REF", `commit ${commit} is not the latest, unintegrated push of any item`);
    }
    for (const path of item.lastPush.paths) {
      if (!paths.includes(path)) {
        paths.push(path);
      }
    }
    if (!contributors.includes(item.lastPush.agent)) {
      contributors.push(item.lastPush.agent);
    }
  }
  return { n: state.lastRevN + 1, commit: input.commit, gate: input.gate, merged: [...input.merged], paths, contributors };
}

// ---------------------------------------------------------------------------
// Log operations
// ---------------------------------------------------------------------------

/**
 * Replay a log into state. Replay is a full re-verification, not a blind fold:
 * each participant message is re-checked exactly as the board route checks it,
 * each integrated revision is re-derived from the pushes it names, arbitration
 * is re-run, and the engine messages that follow must be exactly the ones
 * arbitration produces (under the rules recorded in goal.posted). A gapped,
 * reordered, or forged log is rejected. Linear in the log apart from the
 * arbitration work itself (the working state is mutated, never re-copied).
 */
export function reduceBoard(messages: readonly BoardMessage[]): BoardState {
  const work = emptyBoard();
  let index = 0;
  while (index < messages.length) {
    const incoming = messages[index]!;
    if (incoming.seq !== work.lastSeq + 1) {
      fail("LOG_MISMATCH", `board log is not contiguous at seq ${incoming.seq} (expected ${work.lastSeq + 1})`);
    }
    if (incoming.from === BOARD_ENGINE && incoming.type !== "integrated.rev") {
      fail("LOG_MISMATCH", `engine ${incoming.type} at seq ${incoming.seq} was not produced by arbitration`);
    }
    const expected = arbitrateInPlace(work, incoming);
    for (let k = 0; k < expected.length; k += 1) {
      const recorded = messages[index + 1 + k];
      const derived = { ...expected[k]!, seq: incoming.seq + 1 + k, at: incoming.at };
      if (recorded === undefined || !sameJson(recorded, derived)) {
        fail(
          "LOG_MISMATCH",
          `board log does not match arbitration at seq ${incoming.seq + 1 + k} ` +
            `(expected ${derived.type}, found ${recorded?.type ?? "end of log"})`,
        );
      }
    }
    index += 1 + expected.length;
  }
  return work;
}

/**
 * Verify that a stored board state is exactly what its stored log reduces to.
 * Throws BoardError(LOG_MISMATCH) on any divergence.
 */
export function verifyBoard(messages: readonly BoardMessage[], state: BoardState): void {
  const reduced = reduceBoard(messages);
  if (!sameJson(reduced, state)) {
    fail("LOG_MISMATCH", "the stored board state does not equal the reduction of its log");
  }
}

/** Structural equality of two JSON values, ignoring key order and undefined. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) {
    return false;
  }
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
  return keysA.length === keysB.length && keysA.every((key) => sameJson(a[key], b[key]));
}

/** The result of appending to the board. */
export interface BoardAppendResult {
  /** The appended message followed by the engine messages it triggered. */
  readonly appended: readonly BoardMessage[];
  /** The board after every appended message. */
  readonly state: BoardState;
}

function appendChecked(state: BoardState, draft: BoardDraft, at: string): BoardAppendResult {
  if (state.lastSeq + BOARD_LIMITS.batchReserve > BOARD_LIMITS.maxMessages) {
    fail("LIMIT", `the board is full (${state.lastSeq} of at most ${BOARD_LIMITS.maxMessages} messages)`);
  }
  // Check before copying so a rejection costs nothing; then one copy, mutated.
  checkBoardTransition(state, draft, draft.from === BOARD_ENGINE ? "engine" : "posted");
  const work = cloneState(state);
  const incoming = { ...draft, seq: state.lastSeq + 1, at } as BoardMessage;
  const engine = arbitrateInPlace(work, incoming);
  const appended: BoardMessage[] = [incoming];
  let seq = incoming.seq;
  for (const draftOut of engine) {
    seq += 1;
    appended.push({ ...draftOut, seq, at } as BoardMessage);
  }
  return { appended, state: work };
}

/**
 * Append one participant message: validate it as coming from `origin` (the
 * sender the substrate authenticated), assign its seq, run arbitration, and
 * return the message plus every engine message it triggered, all stamped with
 * `at`. Throws BoardError (and appends nothing) when the message is invalid.
 * Engine messages cannot be appended this way.
 */
export function appendBoardMessage(
  state: BoardState,
  origin: BoardOrigin,
  raw: unknown,
  at: string,
): BoardAppendResult {
  const from = origin.kind === "human" ? BOARD_HUMAN : origin.agent;
  if (origin.kind !== "human" && RESERVED_SENDERS.has(origin.agent)) {
    fail("AUTH", `${origin.agent} is reserved and cannot be an agent`);
  }
  const draft = parseBoardDraft(raw, from);
  if (origin.kind === "join" && draft.type !== "agent.joined") {
    fail("NOT_ALLOWED", "the join route only accepts agent.joined");
  }
  if (origin.kind === "agent" && draft.type === "agent.joined") {
    fail("NOT_ALLOWED", "agents join through the join route");
  }
  return appendChecked(state, draft, at);
}

/**
 * Append the engine's integrated.rev for a recorded integration result. The
 * revision is numbered by the board and its paths and contributors are derived
 * from the merged pushes, so the board can only report what the integrator
 * recorded. A passing revision completes items whose owners proposed done and
 * sends targeted rebase.needed messages.
 */
export function appendIntegratedRev(state: BoardState, input: unknown, at: string): BoardAppendResult {
  if (!isRecord(input)) {
    fail("BAD_PAYLOAD", "an integration result must be an object {commit, gate, merged}");
  }
  const parsed: IntegratedRevInput = {
    commit: id(input, "commit"),
    gate: oneOf(input, "gate", ["pass", "fail"] as const),
    merged: idList(input, "merged", { max: BOARD_LIMITS.maxIntentEntries }),
  };
  if (state.goal === null) {
    fail("NO_GOAL", "the board has no goal yet");
  }
  return appendChecked(
    state,
    { from: BOARD_ENGINE, type: "integrated.rev", payload: integratedRevPayload(state, parsed) },
    at,
  );
}

/** Messages with seq greater than `after`. */
export function boardMessagesAfter(messages: readonly BoardMessage[], after: number): BoardMessage[] {
  return messages.filter((m) => m.seq > after);
}

// ---------------------------------------------------------------------------
// Snapshot summary, per-agent digest, and escalation bridge
// ---------------------------------------------------------------------------

/** A small count summary of the board for the Change snapshot. */
export interface BoardSummary {
  readonly messages: number;
  readonly agents: number;
  readonly items: Readonly<Record<BoardItemStatus, number>>;
  readonly contests: Readonly<Record<BoardContestStatus, number>>;
  readonly toolsPublished: number;
  /** The latest passing integrated revision number, or null. */
  readonly integratedRev: number | null;
}

export function summarizeBoard(state: BoardState): BoardSummary {
  const items: Record<BoardItemStatus, number> = { open: 0, claimed: 0, contested: 0, split: 0, done: 0 };
  for (const item of Object.values(state.items)) {
    items[item.status] += 1;
  }
  const contests: Record<BoardContestStatus, number> = { open: 0, escalated: 0, resolved: 0 };
  for (const contest of Object.values(state.contests)) {
    contests[contest.status] += 1;
  }
  return {
    messages: state.lastSeq,
    agents: Object.values(state.agents).filter((a) => a.leftSeq === undefined).length,
    items,
    contests,
    toolsPublished: state.tools.published.length,
    integratedRev: state.integrated?.n ?? null,
  };
}

/** A compact, per-agent view of the board: what one agent needs for its next turn. */
export interface BoardDigest {
  readonly agent: string;
  readonly role?: string;
  readonly active: boolean;
  readonly lastSeq: number;
  /** The messages below are those after this seq. */
  readonly after: number;
  readonly claims: readonly {
    readonly item: string;
    readonly objective: string;
    readonly intent: BoardIntent;
    readonly doneProposed: boolean;
    readonly lastPush?: { readonly commit: string; readonly integratedIn?: number };
  }[];
  readonly pending: readonly { readonly item: string; readonly contest: string }[];
  readonly contests: readonly BoardContest[];
  readonly openItems: readonly {
    readonly item: string;
    readonly objective: string;
    readonly acceptance: readonly string[];
    readonly scopeHint: readonly string[];
    readonly parent?: string;
  }[];
  readonly integrated: { readonly n: number; readonly commit: string } | null;
  /** The latest revision this agent was told to rebase onto, if any. */
  readonly rebaseTo: number | null;
  /** Messages after `after` addressed to this agent or touching its work. */
  readonly messages: readonly BoardMessage[];
}

const BROADCAST_TYPES: ReadonlySet<BoardMessageType> = new Set([
  "goal.posted",
  "item.proposed",
  "item.discovered",
  "item.split",
  "integrated.rev",
  "contract.proposed",
  "contract.accepted",
  "contract.rejected",
  "tool.published",
]);

const DIGEST_OPEN_ITEMS = 100;

/**
 * Build one agent's digest from the board state and the messages after
 * `after`. A message is relevant when it is addressed to the agent (`to`),
 * names it (agent, owner, claimant, winner, handoff recipient), concerns an
 * item it owns or is waiting on, answers its help request or review, or is a
 * board-wide event (goal, new items, contracts, revisions, tools). The agent's
 * own messages are omitted.
 */
export function boardDigest(
  state: BoardState,
  messages: readonly BoardMessage[],
  agent: string,
  after: number,
): BoardDigest {
  const record = state.agents[agent];
  const mine = new Set<string>();
  for (const item of Object.values(state.items)) {
    if (item.owner === agent || item.claimant?.agent === agent) {
      mine.add(item.id);
    }
  }
  const myRequests = new Set(Object.values(state.help).filter((h) => h.by === agent).map((h) => h.request));
  const myReviews = new Set(Object.values(state.reviews).filter((r) => r.by === agent).map((r) => r.review));
  const relevant = (m: BoardMessage): boolean => {
    if (m.from === agent) {
      return false;
    }
    if (m.to?.includes(agent) || BROADCAST_TYPES.has(m.type)) {
      return true;
    }
    const p = m.payload as Record<string, unknown>;
    if (["agent", "owner", "claimant", "winner", "to"].some((k) => p[k] === agent)) {
      return true;
    }
    if (typeof p.item === "string" && mine.has(p.item)) {
      return true;
    }
    if (typeof p.ownerItem === "string" && mine.has(p.ownerItem)) {
      return true;
    }
    if (m.type === "help.offered" && myRequests.has(m.payload.request)) {
      return true;
    }
    return m.type === "review.result" && myReviews.has(m.payload.review);
  };
  return {
    agent,
    ...(record?.role !== undefined ? { role: record.role } : {}),
    active: record !== undefined && record.leftSeq === undefined,
    lastSeq: state.lastSeq,
    after,
    claims: Object.values(state.items)
      .filter((i) => i.status === "claimed" && i.owner === agent && i.intent)
      .map((i) => ({
        item: i.id,
        objective: i.objective,
        intent: i.intent!,
        doneProposed: i.doneProposed,
        ...(i.lastPush
          ? {
              lastPush: {
                commit: i.lastPush.commit,
                ...(i.lastPush.integratedIn !== undefined ? { integratedIn: i.lastPush.integratedIn } : {}),
              },
            }
          : {}),
      })),
    pending: Object.values(state.items)
      .filter((i) => i.claimant?.agent === agent)
      .map((i) => ({ item: i.id, contest: i.claimant!.contest })),
    contests: Object.values(state.contests).filter(
      (c) => c.status !== "resolved" && (c.owner === agent || c.claimant === agent),
    ),
    openItems: Object.values(state.items)
      .filter((i) => i.status === "open")
      .slice(0, DIGEST_OPEN_ITEMS)
      .map((i) => ({
        item: i.id,
        objective: i.objective,
        acceptance: i.acceptance,
        scopeHint: i.scopeHint,
        ...(i.parent !== undefined ? { parent: i.parent } : {}),
      })),
    integrated: state.integrated ? { n: state.integrated.n, commit: state.integrated.commit } : null,
    rebaseTo: record?.rebaseTo ?? null,
    messages: messages.filter((m) => m.seq > after && relevant(m)),
  };
}

/**
 * The human escalation a claim.escalated message asks for, in the shape the
 * existing escalation records take. `boardContest` links the escalation back
 * to its contest so a human decision can be posted to the board.
 */
export interface BoardEscalationRequest {
  readonly kind: "decision";
  readonly path?: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly boardContest: string;
}

/** Escalation requests for every claim.escalated among `messages`. */
export function boardEscalationRequests(messages: readonly BoardMessage[]): BoardEscalationRequest[] {
  const out: BoardEscalationRequest[] = [];
  for (const message of messages) {
    if (message.type !== "claim.escalated") {
      continue;
    }
    const p = message.payload;
    const why = p.reason === "idle" ? "with no party acting" : `after ${p.turns} turns`;
    out.push({
      kind: "decision",
      ...(p.overlap[0] !== undefined ? { path: intentPath(p.overlap[0]) } : {}),
      question:
        `Board contest ${p.contest}: ${p.claimant} (item ${p.item}) and ${p.owner} both need write access to ` +
        `${p.overlap.join(", ")} ${why}. Which agent keeps it?`,
      options: [p.owner, p.claimant],
      boardContest: p.contest,
    });
  }
  return out;
}

/**
 * Contest id -> decision text for every contest a claim.resolved among
 * `messages` settled (the winner, or how it ended when there is no winner).
 * Used to close a still-pending escalation once its contest is settled on the
 * board by any route.
 */
export function boardContestClosures(messages: readonly BoardMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of messages) {
    if (message.type === "claim.resolved") {
      out.set(message.payload.contest, message.payload.winner ?? message.payload.how);
    }
  }
  return out;
}

/**
 * The board message a human's escalation decision becomes: a claim.resolved
 * naming the winner, to append with the human origin. Returns undefined when
 * the contest is already resolved (nothing to post). Throws when the decision
 * names neither party.
 */
export function boardResolutionForDecision(
  state: BoardState,
  contestId: string,
  decision: string,
): BoardDraft | undefined {
  const contest = state.contests[contestId] ?? fail("UNKNOWN_REF", `unknown contest ${contestId}`);
  if (contest.status === "resolved") {
    return undefined;
  }
  const winner = decision.trim();
  if (winner !== contest.owner && winner !== contest.claimant) {
    fail("BAD_PAYLOAD", `the decision for contest ${contestId} must be ${contest.owner} or ${contest.claimant}`);
  }
  return { from: BOARD_HUMAN, type: "claim.resolved", payload: { contest: contestId, how: "human-decided", winner } };
}

/**
 * The minimal shape of a recorded human escalation that the board keeps in
 * step with. It matches the Worker's and the local control's records.
 */
export interface BoardEscalationRecord {
  readonly id: string;
  readonly kind: string;
  readonly unitId?: string;
  readonly path?: string;
  readonly boardContest?: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly status: "pending" | "resolved";
  readonly decision?: string;
  readonly raisedAt: string;
  readonly resolvedAt?: string;
}

/**
 * Keep escalation records in step with appended board messages: a contest
 * settled by a claim.resolved closes its pending escalation, and a
 * claim.escalated raises a linked `decision` escalation (one pending record per
 * contest). `nowMs` is the caller's clock (used for the timestamps and the id
 * suffix); this function has none of its own.
 */
export function applyBoardEscalations<E extends BoardEscalationRecord>(
  list: readonly E[],
  appended: readonly BoardMessage[],
  nowMs: number,
): { readonly list: E[]; readonly raised: E[] } {
  const at = new Date(nowMs).toISOString();
  const settled = boardContestClosures(appended);
  const out = list.map((e): E => {
    const decision = e.boardContest !== undefined ? settled.get(e.boardContest) : undefined;
    return e.status === "pending" && decision !== undefined ? { ...e, status: "resolved", decision, resolvedAt: at } : e;
  });
  const raised: E[] = [];
  for (const request of boardEscalationRequests(appended)) {
    const existing = out.find((e) => e.status === "pending" && e.boardContest === request.boardContest);
    if (existing) {
      raised.push(existing);
      continue;
    }
    const escalation = {
      id: `esc-${out.length + 1}-${nowMs.toString(36)}`,
      kind: request.kind,
      ...(request.path !== undefined ? { path: request.path } : {}),
      boardContest: request.boardContest,
      question: request.question,
      options: [...request.options],
      status: "pending",
      raisedAt: at,
    } as BoardEscalationRecord as E;
    out.push(escalation);
    raised.push(escalation);
  }
  return { list: out, raised };
}

/** The HTTP status a board rejection maps to. */
export function boardErrorStatus(code: BoardErrorCode): number {
  if (code === "AUTH") {
    return 401;
  }
  if (code === "LIMIT") {
    return 409;
  }
  return 400;
}

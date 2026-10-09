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
  resolveAttributionOutcome,
  type AttributionOutcome,
  type AttributionTally,
  type ParseAttributionOutcome,
} from "./attribution-outcome.ts";
import {
  entriesOverlap,
  entryWithin,
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
  /**
   * Fix requests a failing integrated revision may send for one item before the
   * engine records the item's fix budget as exhausted instead.
   */
  readonly maxFixAttempts: number;
}

export const DEFAULT_BOARD_RULES: BoardRules = { maxContestTurns: 3, contestIdleMessages: 25, maxFixAttempts: 2 };

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
  /** Findings one tool.used may carry, and the characters of each finding's message. */
  maxToolFindings: 64,
  maxToolFindingMessage: 200,
  /** Checks one tool.gated may carry, the characters of each detail, and of its failing output. */
  maxToolChecks: 16,
  maxToolCheckDetail: 300,
  maxToolOutput: 2000,
  /** Times a tool item whose builds keep failing their own gate is reopened for another agent. */
  toolReopens: 2,
  /** Board messages a claim waits for an unpublished tool before the tool counts as unavailable. */
  toolWaitMessages: 60,
  maxObjective: 500,
  maxAcceptance: 20,
  maxRationale: 2000,
  /** Failing gate output a failing integrated revision may carry, in characters. */
  maxFailingOutput: 8192,
  /** Repo-relative paths a goal may declare protected (never writable by an agent). */
  maxProtected: 512,
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

/** Where an advisory typed decision was made. */
export type BoardDecisionJuncture = "plan-review" | "attribution" | "fix-confidence" | "contract-triage";

/** The juncture values, in order. */
export const BOARD_DECISION_JUNCTURES: readonly BoardDecisionJuncture[] = ["plan-review", "attribution", "fix-confidence", "contract-triage"];

/**
 * The kinds of tool an agent can build for other agents:
 *   - scanner: finds every place that needs a change (JSON lines {path, line?, message});
 *   - codemod: applies one mechanical transform across many files;
 *   - check: a scanner run in reverse (it FAILS while a violation remains);
 *   - harness, repro, index: shared fixtures, a failing command for a bug, a
 *     repo index other agents query instead of rereading files.
 */
export const TOOL_KINDS = ["scanner", "codemod", "check", "harness", "repro", "index"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** Where every tool lives in the Change's tools repo: `tools/<capability>/`. */
export const TOOLS_DIR = "tools";

/** A tool capability: lower-case, at most 64 characters (it names a directory and a branch). */
export const TOOL_CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The board item a tool proposal becomes (building the tool is claimable work). */
export function toolItemId(capability: string): string {
  return `tool-${capability}`;
}

/** The only path a tool's builder may write: its own directory in the tools repo. */
export function toolScope(capability: string): string {
  return `${TOOLS_DIR}/${capability}/**`;
}

/** One finding a tool reported: a repo path, an optional line, and a short message. */
export interface BoardToolFinding {
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

/** One named check of a tool's own gate and its outcome. */
export interface BoardToolGateCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** The payload of each message type. */
/** The baseline gate run's executed-test inventory, as posted with the goal. */
export interface BoardTestInventory {
  readonly status: "recorded" | "unavailable";
  readonly format?: string;
  /** How many tests the baseline run executed. (Names stay with the integrator, never on the board.) */
  readonly count?: number;
}

/** The failing evidence a failing integrated revision carries. */
export interface BoardFailingEvidence {
  /** The gate's failing output, bounded and stripped of credentials by the integrator. */
  readonly output: string;
  /** The items the integrator's attribution implicated (all of the revision's items when it could not narrow). */
  readonly items: readonly string[];
}

export interface BoardPayloads {
  "goal.posted": {
    readonly objective: string;
    readonly rules: BoardRules;
    /**
     * Paths and globs no agent may write: the files that define the gate (the
     * gate's own test files and directory, the project manifest and lockfile).
     * Posted with the goal so the protected set is visible on the board; claims
     * overlapping it are refused and items cannot be scoped inside it.
     */
    readonly protected?: readonly string[];
    /**
     * Keys inside otherwise editable files that define the gate (for example
     * the manifest's gate scripts), shown for visibility. Claims are not
     * checked against them; the integrator restores them before the gate runs.
     */
    readonly protectedKeys?: readonly string[];
    /**
     * What the BASELINE gate run executed (recorded at goal time): every later
     * revision must execute at least these tests. `unavailable` means the gate's
     * output could not be read, so revisions fall back to the exit code.
     */
    readonly testInventory?: BoardTestInventory;
  };
  "item.proposed": {
    readonly item: string;
    readonly objective: string;
    readonly acceptance: readonly string[];
    readonly scopeHint: readonly string[];
    /**
     * The published tool whose findings this proposal comes from (a scanner's
     * owner turning findings into work). Only that tool's builder may cite it;
     * the proposal still needs the lead's acceptance.
     */
    readonly fromTool?: { readonly capability: string; readonly version: string };
  };
  /**
   * The lead (or a human) accepts an item a WORKER proposed: it becomes open
   * (claimable). Until then a worker's proposal is `proposed`, not claimable,
   * and not counted toward the run's completion.
   */
  "item.accepted": { readonly item: string };
  /** The lead (or a human) rejects a worker's proposed item (a rationale is required). */
  "item.rejected": { readonly item: string };
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
    /** The paths a claim on the discovered item may write (claims must stay within). */
    readonly scopeHint?: readonly string[];
  };
  "help.requested": { readonly request: string; readonly item: string; readonly need: string };
  "help.offered": { readonly request: string };
  "contract.proposed": {
    readonly contract: string;
    readonly target: string;
    readonly kind: "add" | "modify" | "remove";
    /**
     * The item the change is for. An ACCEPTED contract whose target covers
     * protected paths makes exactly those paths writable for this item (and the
     * integrator stops restoring them): a changed existing test is a contract
     * change the lead or a human decides, never an agent alone.
     */
    readonly item?: string;
  };
  /** Engine: a contract on a protected path waits for a HUMAN decision (an escalation). */
  "contract.escalated": { readonly contract: string; readonly item: string; readonly target: string; readonly kind: "add" | "modify" | "remove" };
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
    /** A failing revision's evidence: the bounded gate output and the implicated items. */
    readonly failing?: BoardFailingEvidence;
    /**
     * False when NO gate ran on this revision (the project has none): its
     * "pass" means nothing was checked. Absent when a gate ran.
     */
    readonly gated?: false;
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
  /**
   * Engine: an item completed. `via: integrated` and `children` cite the passing
   * revision `n`; `via: tool` completes a tool item when its tool passed its own
   * gate and was published (`version`), which no integrated revision decides.
   */
  "item.completed": {
    readonly item: string;
    readonly n?: number;
    readonly via: "integrated" | "children" | "tool";
    readonly version?: string;
  };
  /** Engine: a failing revision implicated this item; its owner is asked (`to`) for fix `attempt`. */
  "fix.requested": { readonly item: string; readonly n: number; readonly attempt: number };
  /** Engine: a failing revision implicated this item after its fix budget was spent. */
  "fix.exhausted": { readonly item: string; readonly n: number; readonly attempts: number };
  /**
   * Engine: after its owner spent the fix budget the item is reopened for a
   * DIFFERENT agent (fresh eyes), who starts from the previous owner's latest
   * push (`commit`); the previous owner may not claim it again.
   */
  "item.reopened": {
    readonly item: string;
    readonly previousOwner: string;
    readonly commit?: string;
    /** The failing revision; absent for a TOOL item, reopened after its builds failed their own gate. */
    readonly n?: number;
  };
  /**
   * An agent proposes a tool. It becomes a board item (`tool-<capability>`,
   * scoped to `tools/<capability>/**`) that the lead accepts like any worker
   * proposal; whoever claims it builds it. `inputs` are the repo paths or globs
   * the tool acts on (a codemod must declare them: its intended scope);
   * `outputs` name what it produces. The reason goes in the rationale.
   */
  "tool.proposed": {
    readonly tool: string;
    readonly capability: string;
    readonly kind: ToolKind;
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
  };
  /** The tool item's owner pushed a build of the tool to the tools repo (paths inside its write intent). */
  "tool.built": { readonly capability: string; readonly commit: string; readonly paths: readonly string[] };
  /**
   * Engine (recorded by the operator after it ran the tool's OWN gate on the
   * built commit): the checks and their outcomes. A pass derives
   * `tool.published`; a fail publishes nothing.
   */
  "tool.gated": {
    readonly capability: string;
    readonly commit: string;
    readonly passed: boolean;
    readonly checks: readonly BoardToolGateCheck[];
    /** The tools repo the commit lives in (a name, never a credential). */
    readonly repo: string;
    /** How a consumer runs the tool (for example `node tools/<capability>/run.mjs [paths...]`). */
    readonly usage: string;
    /** A failing gate's bounded, credential-free output. */
    readonly output?: string;
  };
  /**
   * Engine (derived from a passing `tool.gated`): the tool is in the registry.
   * `verified` is always true: only a tool that passed its own gate is ever
   * published. A check tool does not join the Change's gate (`joinsGate: false`).
   */
  "tool.published": {
    readonly tool: string;
    readonly capability: string;
    readonly version: string;
    readonly repo: string;
    readonly commit: string;
    readonly verified: true;
    readonly kind: ToolKind;
    readonly usage: string;
    readonly joinsGate?: false;
  };
  /**
   * Engine (recorded by the operator after the runtime ran the pinned tool
   * version in the consumer's own repo): agents can never post a use record.
   * A codemod's `changedFiles` were committed and announced as `commit`, the
   * latest push of `item`, inside its write intent.
   */
  "tool.used": {
    readonly capability: string;
    readonly version: string;
    readonly by: string;
    readonly item?: string;
    readonly commit?: string;
    readonly changedFiles: readonly string[];
    readonly findings?: readonly BoardToolFinding[];
    readonly exit?: number;
  };
  /**
   * Engine: one ADVISORY typed decision (a plan review, a failure attribution,
   * a fix-confidence check) and its outcome, recorded for visibility. It never
   * affects arbitration, completion, or the verdict.
   */
  "decision.recorded": {
    readonly juncture: BoardDecisionJuncture;
    readonly question: string;
    readonly answer?: string;
    readonly confidence?: number;
    readonly accepted: boolean;
    readonly error?: string;
    /**
     * Attribution only: the failing revision the decision is about. It must be
     * the latest revision, and failing, when recorded; the engine then resolves
     * the decision mechanically at the next passing revision (decision.resolved).
     */
    readonly rev?: number;
    /** Attribution only: the items the string-parse attributed (empty: it attributed nothing). */
    readonly parsed?: readonly string[];
    /** Contract triage only: the protected contract the advice is about. */
    readonly contract?: string;
  };
  /**
   * Engine (derived when a passing revision is recorded): the mechanical outcome
   * of an attribution decision. `fixed` are the items whose pushes changed
   * between the failing revision `rev` and the passing revision `passed`;
   * `outcome` says whether the decision's pick (`answer`) is among them, and
   * `parseOutcome` the same for the parse attribution. This is where the pick
   * landed, not whether it was right: attribution chose whom to ask to fix.
   * Advisory: it changes only the outcome counts.
   */
  "decision.resolved": {
    readonly decisionSeq: number;
    readonly rev: number;
    readonly passed: number;
    readonly answer: string;
    readonly outcome: AttributionOutcome;
    readonly fixed: readonly string[];
    readonly parsed: readonly string[];
    readonly parseOutcome: ParseAttributionOutcome;
  };
  "agent.joined": { readonly role?: string };
  "agent.left": Record<string, never>;
}

export type BoardMessageType = keyof BoardPayloads;

/** Every message type, in vocabulary order. */
export const BOARD_MESSAGE_TYPES: readonly BoardMessageType[] = [
  "goal.posted",
  "item.proposed",
  "item.accepted",
  "item.rejected",
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
  "contract.escalated",
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
  "fix.requested",
  "fix.exhausted",
  "item.reopened",
  "tool.proposed",
  "tool.built",
  "tool.gated",
  "tool.published",
  "tool.used",
  "decision.recorded",
  "decision.resolved",
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
  | "OUTSIDE_SCOPE"
  | "PROTECTED"
  | "CONTRACT_REJECTED"
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

/**
 * `proposed`: a worker proposed the item and the lead has not decided it (not
 * claimable); `rejected`: the lead (or a human) rejected that proposal. Neither
 * counts toward a run's completion.
 */
export type BoardItemStatus = "proposed" | "rejected" | "open" | "claimed" | "contested" | "split" | "done";

/** True for an item that counts toward the Change: neither an undecided nor a rejected proposal. */
export function isAcceptedItem(item: Pick<BoardItem, "status">): boolean {
  return item.status !== "proposed" && item.status !== "rejected";
}

/**
 * True for an item that is part of the Change's deliverable: accepted (see
 * `isAcceptedItem`) and not a tool item. A tool is internal infrastructure other
 * agents run; it is decided by its own gate and reported in the tool registry,
 * never counted toward (or against) the Change's completion.
 */
export function isChangeItem(item: Pick<BoardItem, "status" | "tool">): boolean {
  return isAcceptedItem(item) && item.tool === undefined;
}

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
  /** The lead's (or a human's) decision on a worker's proposal. */
  triage?: { readonly decision: "accepted" | "rejected"; readonly by: string; readonly seq: number };
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
  completed?: { readonly n?: number; readonly via: "integrated" | "children" | "tool"; readonly version?: string };
  /** Fix requests failing revisions sent for this item so far. */
  fixAttempts?: number;
  /** The failing revision whose fix request is still unanswered (cleared by the owner's next push). */
  fixRequested?: number;
  /** A failing revision implicated the item after its fix budget was spent. */
  fixExhausted?: boolean;
  /** Agents that spent this item's fix budget: they may not claim it again. */
  exhaustedBy?: string[];
  /** The previous owner's latest push a reopened item starts from. */
  reopenedFrom?: { readonly agent: string; readonly commit?: string };
  /** A tool item: building the tool `capability` (its own gate decides it, not an integrated revision). */
  readonly tool?: { readonly capability: string; readonly kind: ToolKind };
  /** A tool item's builds that failed their own gate under its current owner. */
  toolFailures?: number;
  /** A tool item's latest build (tool.built) and, once recorded, its own gate's outcome. */
  toolBuild?: { readonly commit: string; readonly paths: readonly string[]; readonly seq: number; gated?: boolean; passed?: boolean };
  /** The published tool whose findings this item was proposed from. */
  readonly fromTool?: { readonly capability: string; readonly version: string };
  /** The seq at which a human last rejected a contract change for this item. */
  contractRejectedSeq?: number;
  /** The seq of the latest failing revision whose evidence implicated this item. */
  implicatedSeq?: number;
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
  readonly item?: string;
  /** The target is part of the gate's contract: only a human decides it. */
  readonly guarded?: boolean;
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
  readonly kind: ToolKind;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly proposedBy: string;
  readonly seq: number;
  /** The board item building it is (tool-<capability>). */
  readonly item: string;
  /** Builds pushed (tool.built) and builds whose own gate failed. */
  builds: number;
  failedGates: number;
}

export interface BoardPublishedTool {
  readonly tool: string;
  readonly capability: string;
  readonly version: string;
  readonly repo: string;
  readonly commit: string;
  readonly kind: ToolKind;
  readonly usage: string;
  /** The agent that built it (the tool item's owner when its gate passed). */
  readonly publishedBy: string;
  readonly seq: number;
  /** The tool.gated message whose checks it passed (the gate evidence). */
  readonly gateSeq: number;
  /** A check tool never joins the Change's gate in this slice. */
  readonly joinsGate?: false;
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
  /** Paths no agent may write, as posted with the goal. */
  protected: string[];
  /** Gate-defining keys inside editable files, as posted with the goal (display only). */
  protectedKeys: string[];
  /** The baseline gate run's test inventory, as posted with the goal. */
  testInventory: BoardTestInventory | null;
  /** Advisory typed decisions recorded: how many, accepted, and failed calls. */
  decisions: { calls: number; accepted: number; errors: number };
  /** Attribution decisions awaiting, and resolved to, a mechanical outcome (advisory). */
  attribution: BoardAttributionState;
  /** The latest failing revision's evidence (bounded), or null. */
  lastFailure: ({ readonly n: number } & BoardFailingEvidence) | null;
}

/** An attribution decision waiting for the next passing revision. */
export interface BoardOpenAttribution {
  readonly decisionSeq: number;
  /** The failing revision it is about. */
  readonly rev: number;
  /** The model's choice (an item id). */
  readonly answer: string;
  readonly parsed: readonly string[];
  /** Item -> the push commit the failing revision merged (a later different commit is a change). */
  readonly base: Readonly<Record<string, string>>;
  /** Items whose pushes changed in revisions after `rev` (so far). */
  changed: string[];
}

/** The board's attribution-outcome bookkeeping. */
export interface BoardAttributionState {
  /** The latest revision's merged pushes, item -> commit (the base of a decision about it). */
  lastRev: { readonly n: number; readonly merged: Readonly<Record<string, string>> } | null;
  open: BoardOpenAttribution[];
  /** Picks that were (not) among the items changed before the next pass. */
  inFixedSet: number;
  notInFixedSet: number;
  parse: { inFixedSet: number; notInFixedSet: number; none: number; extra: number };
  /** Resolved decisions whose pick differed from the parse, by which landed in the fixed set. */
  differed: { total: number; pickOnly: number; parseOnly: number; both: number; neither: number };
}

/** Empty attribution bookkeeping. */
function emptyAttribution(): BoardAttributionState {
  return {
    lastRev: null,
    open: [],
    inFixedSet: 0,
    notInFixedSet: 0,
    parse: { inFixedSet: 0, notInFixedSet: 0, none: 0, extra: 0 },
    differed: { total: 0, pickOnly: 0, parseOnly: 0, both: 0, neither: 0 },
  };
}

/** The attribution bookkeeping, created on a state stored before it existed. */
function attributionOf(state: BoardState): BoardAttributionState {
  if (state.attribution === undefined) {
    state.attribution = emptyAttribution();
  }
  return state.attribution;
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
    protected: [],
    protectedKeys: [],
    testInventory: null,
    decisions: { calls: 0, accepted: 0, errors: 0 },
    attribution: emptyAttribution(),
    lastFailure: null,
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

/** An optional `gated` flag: only `false` is meaningful (absent means a gate ran). */
function ungatedFlag(raw: Raw): boolean {
  if (raw.gated === undefined) {
    return false;
  }
  if (raw.gated !== false) {
    fail("BAD_PAYLOAD", "gated, when present, must be false (no gate ran)");
  }
  return true;
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
    fail("BAD_PAYLOAD", "rules must be an object {maxContestTurns?, contestIdleMessages?, maxFixAttempts?}");
  }
  return {
    maxContestTurns:
      value.maxContestTurns === undefined ? DEFAULT_BOARD_RULES.maxContestTurns : positiveInt(value, "maxContestTurns", 20),
    contestIdleMessages:
      value.contestIdleMessages === undefined
        ? DEFAULT_BOARD_RULES.contestIdleMessages
        : positiveInt(value, "contestIdleMessages", 10000),
    maxFixAttempts:
      value.maxFixAttempts === undefined ? DEFAULT_BOARD_RULES.maxFixAttempts : positiveInt(value, "maxFixAttempts", 20),
  };
}

/** Validate a failing revision's evidence: bounded output text and the implicated item ids. */
function failingEvidence(value: unknown): BoardFailingEvidence {
  if (!isRecord(value)) {
    fail("BAD_PAYLOAD", "failing must be an object {output, items}");
  }
  for (const key of Object.keys(value)) {
    if (key !== "output" && key !== "items") {
      fail("BAD_PAYLOAD", `failing has an unknown field ${JSON.stringify(key)}`);
    }
  }
  const output = value.output;
  if (typeof output !== "string" || output.length > BOARD_LIMITS.maxFailingOutput) {
    fail("BAD_PAYLOAD", `failing.output must be a string of at most ${BOARD_LIMITS.maxFailingOutput} characters`);
  }
  return { output, items: idList(value, "items", { max: BOARD_LIMITS.maxIntentEntries }) };
}

/** Validate a goal's test inventory: a status, and bounded format, count, and names. */
function testInventory(value: unknown): BoardTestInventory {
  if (!isRecord(value)) {
    fail("BAD_PAYLOAD", "testInventory must be an object {status, format?, count?, names?}");
  }
  const status = oneOf(value, "status", ["recorded", "unavailable"] as const);
  for (const key of Object.keys(value)) {
    if (!["status", "format", "count"].includes(key)) {
      fail("BAD_PAYLOAD", `testInventory has an unknown field ${JSON.stringify(key)} (only status, format, count are published)`);
    }
  }
  return {
    status,
    ...(value.format !== undefined ? { format: text(value, "format", 64) } : {}),
    ...(value.count !== undefined ? { count: nonNegativeInt(value, "count") } : {}),
  };
}

/** A tool capability id (lower-case; it names the tool's directory and branch). */
function capability(raw: Raw, field = "capability"): string {
  const value = raw[field];
  if (typeof value !== "string" || !TOOL_CAPABILITY_PATTERN.test(value)) {
    fail("BAD_PAYLOAD", `${field} must be a tool capability (lower-case letters, digits, . _ -; at most 64 chars)`);
  }
  return value;
}

function bool(raw: Raw, field: string): boolean {
  if (typeof raw[field] !== "boolean") {
    fail("BAD_PAYLOAD", `${field} must be a boolean`);
  }
  return raw[field] as boolean;
}

/** Bounded tool findings: {path (concrete repo path), line?, message}. */
function toolFindings(value: unknown): BoardToolFinding[] {
  const L = BOARD_LIMITS;
  if (!Array.isArray(value) || value.length > L.maxToolFindings) {
    fail("BAD_PAYLOAD", `findings must be an array of at most ${L.maxToolFindings} findings`);
  }
  return value.map((finding, index) => {
    if (!isRecord(finding)) {
      fail("BAD_PAYLOAD", `findings[${index}] must be an object {path, line?, message}`);
    }
    for (const key of Object.keys(finding)) {
      if (!["path", "line", "message"].includes(key)) {
        fail("BAD_PAYLOAD", `findings[${index}] has an unknown field ${JSON.stringify(key)}`);
      }
    }
    const [path] = pathList({ path: [finding.path] }, "path", { concrete: true });
    const line = finding.line === undefined ? undefined : positiveInt(finding, "line");
    return { path: path!, ...(line !== undefined ? { line } : {}), message: text(finding, "message", L.maxToolFindingMessage) };
  });
}

/** Bounded tool-gate checks: {check (id), passed, detail}. */
function toolChecks(value: unknown): BoardToolGateCheck[] {
  const L = BOARD_LIMITS;
  if (!Array.isArray(value) || value.length === 0 || value.length > L.maxToolChecks) {
    fail("BAD_PAYLOAD", `checks must be a non-empty array of at most ${L.maxToolChecks} checks`);
  }
  return value.map((check, index) => {
    if (!isRecord(check)) {
      fail("BAD_PAYLOAD", `checks[${index}] must be an object {check, passed, detail}`);
    }
    for (const key of Object.keys(check)) {
      if (!["check", "passed", "detail"].includes(key)) {
        fail("BAD_PAYLOAD", `checks[${index}] has an unknown field ${JSON.stringify(key)}`);
      }
    }
    return { check: id(check, "check"), passed: bool(check, "passed"), detail: text(check, "detail", L.maxToolCheckDetail) };
  });
}

/** An optional {capability, version} reference to a published tool. */
function toolRef(value: unknown, field: string): { capability: string; version: string } {
  if (!isRecord(value)) {
    fail("BAD_PAYLOAD", `${field} must be an object {capability, version}`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "capability" && key !== "version") {
      fail("BAD_PAYLOAD", `${field} has an unknown field ${JSON.stringify(key)}`);
    }
  }
  return { capability: capability(value), version: id(value, "version") };
}

/** Validate and normalize one payload by type. */
function parsePayload(type: BoardMessageType, raw: Raw): BoardPayloads[BoardMessageType] {
  const L = BOARD_LIMITS;
  switch (type) {
    case "goal.posted": {
      const guarded = pathList(raw, "protected", { optional: true, max: L.maxProtected });
      const keys = textList(raw, "protectedKeys", L.maxProtected, L.maxEntryLength);
      const inventory = raw.testInventory === undefined ? undefined : testInventory(raw.testInventory);
      return {
        objective: text(raw, "objective", L.maxRationale),
        rules: rules(raw),
        ...(guarded.length > 0 ? { protected: guarded } : {}),
        ...(keys.length > 0 ? { protectedKeys: keys } : {}),
        ...(inventory !== undefined ? { testInventory: inventory } : {}),
      };
    }
    case "item.proposed":
      return {
        item: id(raw, "item"),
        objective: text(raw, "objective", L.maxObjective),
        acceptance: textList(raw, "acceptance", L.maxAcceptance, L.maxObjective),
        scopeHint: pathList(raw, "scopeHint", { optional: true, max: L.maxIntentEntries }),
        ...(raw.fromTool !== undefined ? { fromTool: toolRef(raw.fromTool, "fromTool") } : {}),
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
      const scopeHint = pathList(raw, "scopeHint", { optional: true, max: L.maxIntentEntries });
      return {
        item: id(raw, "item"),
        objective: text(raw, "objective", L.maxObjective),
        reason: text(raw, "reason", 200),
        ...(parent !== undefined ? { parent } : {}),
        ...(scopeHint.length > 0 ? { scopeHint } : {}),
      };
    }
    case "help.requested":
      return { request: id(raw, "request"), item: id(raw, "item"), need: id(raw, "need") };
    case "help.offered":
      return { request: id(raw, "request") };
    case "contract.proposed": {
      const [target] = pathList({ target: [raw.target] }, "target");
      const item = optionalId(raw, "item");
      return {
        contract: id(raw, "contract"),
        target: target!,
        kind: oneOf(raw, "kind", ["add", "modify", "remove"] as const),
        ...(item !== undefined ? { item } : {}),
      };
    }
    case "contract.escalated": {
      const [target] = pathList({ target: [raw.target] }, "target");
      return {
        contract: id(raw, "contract"),
        item: id(raw, "item"),
        target: target!,
        kind: oneOf(raw, "kind", ["add", "modify", "remove"] as const),
      };
    }
    case "contract.accepted":
    case "contract.rejected":
      return { contract: id(raw, "contract") };
    case "item.accepted":
    case "item.rejected":
      return { item: id(raw, "item") };
    case "push.announced":
      return { item: id(raw, "item"), commit: id(raw, "commit"), paths: pathList(raw, "paths", { concrete: true }) };
    case "integrated.rev": {
      const failing = raw.failing === undefined ? undefined : failingEvidence(raw.failing);
      return {
        n: positiveInt(raw, "n"),
        commit: id(raw, "commit"),
        gate: oneOf(raw, "gate", ["pass", "fail"] as const),
        merged: idList(raw, "merged", { max: L.maxIntentEntries }),
        paths: pathList(raw, "paths", { max: L.maxPaths * L.maxIntentEntries }),
        contributors: idList(raw, "contributors", { max: L.maxAgents }),
        ...(failing !== undefined ? { failing } : {}),
        ...(ungatedFlag(raw) ? { gated: false as const } : {}),
      };
    }
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
    case "item.completed": {
      const via = oneOf(raw, "via", ["integrated", "children", "tool"] as const);
      if (via === "tool") {
        if (raw.n !== undefined) {
          fail("BAD_PAYLOAD", "a tool item completes by its own gate, not by an integrated revision (no n)");
        }
        return { item: id(raw, "item"), via, version: id(raw, "version") };
      }
      if (raw.version !== undefined) {
        fail("BAD_PAYLOAD", "version belongs to a tool item's completion");
      }
      return { item: id(raw, "item"), n: positiveInt(raw, "n"), via };
    }
    case "fix.requested":
      return { item: id(raw, "item"), n: positiveInt(raw, "n"), attempt: positiveInt(raw, "attempt") };
    case "fix.exhausted":
      return { item: id(raw, "item"), n: positiveInt(raw, "n"), attempts: nonNegativeInt(raw, "attempts") };
    case "item.reopened": {
      const commit = optionalId(raw, "commit");
      const n = raw.n === undefined ? undefined : positiveInt(raw, "n");
      return { item: id(raw, "item"), previousOwner: id(raw, "previousOwner"), ...(n !== undefined ? { n } : {}), ...(commit !== undefined ? { commit } : {}) };
    }
    case "tool.proposed":
      return {
        tool: id(raw, "tool"),
        capability: capability(raw),
        kind: oneOf(raw, "kind", TOOL_KINDS),
        inputs: pathList(raw, "inputs", { optional: true, max: L.maxIntentEntries }),
        outputs: idList(raw, "outputs", { optional: true }),
      };
    case "tool.built":
      return { capability: capability(raw), commit: id(raw, "commit"), paths: pathList(raw, "paths", { concrete: true }) };
    case "tool.gated":
      return {
        capability: capability(raw),
        commit: id(raw, "commit"),
        passed: bool(raw, "passed"),
        checks: toolChecks(raw.checks),
        repo: text(raw, "repo", L.maxObjective),
        usage: text(raw, "usage", L.maxObjective),
        ...(raw.output !== undefined ? { output: text(raw, "output", L.maxToolOutput) } : {}),
      };
    case "tool.published": {
      if (raw.verified !== true) {
        fail("INVALID_STATE", "a tool can only be published after it passed its own gate (verified must be true)");
      }
      if (raw.joinsGate !== undefined && raw.joinsGate !== false) {
        fail("BAD_PAYLOAD", "joinsGate, when present, must be false (a tool never joins the gate in this slice)");
      }
      return {
        tool: id(raw, "tool"),
        capability: capability(raw),
        version: id(raw, "version"),
        repo: text(raw, "repo", L.maxObjective),
        commit: id(raw, "commit"),
        verified: true,
        kind: oneOf(raw, "kind", TOOL_KINDS),
        usage: text(raw, "usage", L.maxObjective),
        ...(raw.joinsGate === false ? { joinsGate: false as const } : {}),
      };
    }
    case "tool.used": {
      const item = optionalId(raw, "item");
      const commit = optionalId(raw, "commit");
      const findingList = raw.findings === undefined ? undefined : toolFindings(raw.findings);
      let exit: number | undefined;
      if (raw.exit !== undefined) {
        if (typeof raw.exit !== "number" || !Number.isInteger(raw.exit) || raw.exit < 0 || raw.exit > 255) {
          fail("BAD_PAYLOAD", "exit must be an integer from 0 to 255");
        }
        exit = raw.exit;
      }
      return {
        capability: capability(raw),
        version: id(raw, "version"),
        by: id(raw, "by"),
        ...(item !== undefined ? { item } : {}),
        ...(commit !== undefined ? { commit } : {}),
        changedFiles: pathList(raw, "changedFiles", { concrete: true, optional: true }),
        ...(findingList !== undefined ? { findings: findingList } : {}),
        ...(exit !== undefined ? { exit } : {}),
      };
    }
    case "decision.recorded": {
      const answer = raw.answer === undefined ? undefined : text(raw, "answer", 200);
      const error = raw.error === undefined ? undefined : text(raw, "error", 300);
      let confidence: number | undefined;
      if (raw.confidence !== undefined) {
        if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
          fail("BAD_PAYLOAD", "confidence must be a number in [0, 1]");
        }
        confidence = raw.confidence;
      }
      if (typeof raw.accepted !== "boolean") {
        fail("BAD_PAYLOAD", "accepted must be a boolean");
      }
      const juncture = oneOf(raw, "juncture", BOARD_DECISION_JUNCTURES);
      const rev = raw.rev === undefined ? undefined : positiveInt(raw, "rev");
      const parsed = raw.parsed === undefined ? undefined : idList(raw, "parsed", { max: L.maxIntentEntries });
      const contract = optionalId(raw, "contract");
      if ((rev !== undefined || parsed !== undefined) && juncture !== "attribution") {
        fail("BAD_PAYLOAD", "rev and parsed belong to an attribution decision");
      }
      if (parsed !== undefined && rev === undefined) {
        fail("BAD_PAYLOAD", "parsed needs the rev it attributes");
      }
      if (juncture === "contract-triage" && contract === undefined) {
        fail("BAD_PAYLOAD", "a contract-triage decision names its contract");
      }
      if (contract !== undefined && juncture !== "contract-triage") {
        fail("BAD_PAYLOAD", "contract belongs to a contract-triage decision");
      }
      return {
        juncture,
        question: text(raw, "question", 500),
        ...(answer !== undefined ? { answer } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        accepted: raw.accepted,
        ...(error !== undefined ? { error } : {}),
        ...(rev !== undefined ? { rev } : {}),
        ...(parsed !== undefined ? { parsed } : {}),
        ...(contract !== undefined ? { contract } : {}),
      };
    }
    case "decision.resolved":
      return {
        decisionSeq: positiveInt(raw, "decisionSeq"),
        rev: positiveInt(raw, "rev"),
        passed: positiveInt(raw, "passed"),
        answer: id(raw, "answer"),
        outcome: oneOf(raw, "outcome", ["in-fixed-set", "not-in-fixed-set"] as const),
        fixed: idList(raw, "fixed", { max: L.maxIntentEntries }),
        parsed: idList(raw, "parsed", { max: L.maxIntentEntries }),
        parseOutcome: oneOf(raw, "parseOutcome", ["in-fixed-set", "not-in-fixed-set", "none"] as const),
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
  "item.accepted": ["lead", "human"],
  "item.rejected": ["lead", "human"],
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
  "contract.escalated": ["engine"],
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
  "fix.requested": ["engine"],
  "fix.exhausted": ["engine"],
  "item.reopened": ["engine"],
  "tool.proposed": ["agent"],
  "tool.built": ["agent"],
  // A tool's gate result, its publication, and every use are the ENGINE's:
  // recorded from what the operator's runtime actually ran, never posted by an
  // agent (an agent cannot claim its tool passed, or fake a use).
  "tool.gated": ["engine"],
  "tool.published": ["engine"],
  "tool.used": ["engine"],
  "decision.recorded": ["engine"],
  "decision.resolved": ["engine"],
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

/**
 * The targets of ACCEPTED contracts for `item` (all items when omitted): the
 * protected paths those contracts released for writing.
 */
export function releasedTargets(state: BoardState, item?: string): string[] {
  return Object.values(state.contracts)
    .filter((c) => c.status === "accepted" && c.item !== undefined && (item === undefined || c.item === item))
    .map((c) => c.target);
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
      if (draft.type === "item.proposed" && draft.payload.fromTool !== undefined) {
        // A tool's findings become work only through its builder, citing a
        // version that is in the registry (the lead still decides the proposal).
        const ref = draft.payload.fromTool;
        const tool = state.tools.published.find((t) => t.capability === ref.capability && t.version === ref.version);
        if (!tool) {
          fail("UNKNOWN_REF", `${ref.capability}@${ref.version} is not a published tool version`);
        }
        if (tool.publishedBy !== draft.from) {
          fail("NOT_ALLOWED", `only ${tool.publishedBy}, who built ${ref.capability}, proposes work from its findings`);
        }
      }
      return;
    }
    case "item.accepted":
    case "item.rejected": {
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "proposed") {
        fail("INVALID_STATE", `item ${item.id} is ${item.status}, not a proposal awaiting a decision`);
      }
      if (draft.type === "item.rejected" && (draft.rationale === undefined || draft.rationale.trim() === "")) {
        fail("BAD_PAYLOAD", "item.rejected needs a rationale (why the proposal is not taken)");
      }
      return;
    }
    case "item.claimed": {
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "open") {
        const by = item.owner ?? item.claimant?.agent;
        fail("ITEM_NOT_OPEN", `item ${item.id} is ${item.status}${by ? ` (by ${by})` : ""} and cannot be claimed`);
      }
      const write = draft.payload.intent.write;
      if (write.length === 0) {
        fail("BAD_PAYLOAD", "a claim must declare at least one write intent");
      }
      if (item.exhaustedBy?.includes(draft.from)) {
        fail("NOT_ALLOWED", `${draft.from} already spent item ${item.id}'s fix budget; it was reopened for another agent`);
      }
      // The contract (the original code's existing tests and the gate's own
      // files) is never writable by an agent alone, however the claim is
      // phrased: any write entry that could name a protected path is refused,
      // unless an accepted contract for this item released that path.
      const released = releasedTargets(state, item.id);
      const hit = state.protected.filter((p) => write.some((w) => entriesOverlap(w, p)));
      const locked = hit.filter((p) => !released.some((t) => entryWithin(p, t)));
      if (locked.length > 0) {
        const entries = overlappingEntries(write, locked);
        fail(
          "PROTECTED",
          `write intent ${entries.join(", ")} overlaps protected path(s) ${locked.slice(0, 8).join(", ")}${locked.length > 8 ? ", ..." : ""}: ` +
            "changing an existing test or the gate's configuration is a contract change; post contract.proposed " +
            "{target, kind, item} and claim again once the lead or a human accepts it",
        );
      }
      // A claim writes only inside the item's declared scope.
      if (item.scopeHint.length === 0) {
        fail("OUTSIDE_SCOPE", `item ${item.id} declares no scope hint, so no write intent can be claimed on it`);
      }
      const outside = write.filter((w) => !item.scopeHint.some((hint) => entryWithin(w, hint)));
      if (outside.length > 0) {
        fail(
          "OUTSIDE_SCOPE",
          `write intent ${outside.join(", ")} is outside item ${item.id}'s scope hint (${item.scopeHint.join(", ")})`,
        );
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
        // A split narrows the work: no child may reach outside the parent's scope.
        const outside = child.scopeHint.filter((entry) => !item.scopeHint.some((hint) => entryWithin(entry, hint)));
        if (outside.length > 0) {
          fail(
            "OUTSIDE_SCOPE",
            `child ${child.item}'s scope hint ${outside.join(", ")} is outside item ${item.id}'s scope hint (${item.scopeHint.join(", ")})`,
          );
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
      if (draft.payload.item !== undefined) {
        requireItem(state, draft.payload.item);
      }
      if (state.protected.some((p) => entriesOverlap(draft.payload.target, p))) {
        // A contract change to the original tests or the gate's configuration:
        // bounded to one listed path, inside the item's own scope.
        const target = draft.payload.target;
        if (draft.payload.item === undefined) {
          fail("NOT_ALLOWED", `a contract on the protected path ${target} must name the item it is for`);
        }
        if (hasWildcard(target) && !state.protected.includes(target)) {
          fail("NOT_ALLOWED", `a contract on protected paths must name one concrete path from the contract (not ${target})`);
        }
        if (!state.protected.some((p) => p === target || entryWithin(target, p))) {
          fail("NOT_ALLOWED", `${target} is not itself in the contract; name the protected path you need to change`);
        }
        const item = requireItem(state, draft.payload.item);
        if (!item.scopeHint.some((hint) => entryWithin(target, hint))) {
          fail("OUTSIDE_SCOPE", `${target} is outside item ${item.id}'s scope hint (${item.scopeHint.join(", ")})`);
        }
        // A human said no for this item: asking again is only legitimate once
        // new evidence (a failing revision implicating the item) exists.
        if (item.contractRejectedSeq !== undefined && !((item.implicatedSeq ?? 0) > item.contractRejectedSeq)) {
          fail(
            "CONTRACT_REJECTED",
            `a human rejected a contract change for item ${item.id} (at seq ${item.contractRejectedSeq}); the original tests stay as they are. ` +
              "Propose again only after a failing revision implicates this item. New test files may still be added (they never lower or replace the baseline tests the gate must run)",
          );
        }
      }
      return;
    case "contract.accepted":
    case "contract.rejected": {
      const contract = state.contracts[draft.payload.contract] ?? fail("UNKNOWN_REF", `unknown contract ${draft.payload.contract}`);
      if (contract.status !== "proposed") {
        fail("INVALID_STATE", `contract ${contract.contract} is already ${contract.status}`);
      }
      if (contract.guarded && draft.from !== BOARD_HUMAN) {
        fail("NOT_ALLOWED", `contract ${contract.contract} changes the original tests or the gate's configuration: only a human decides it`);
      }
      return;
    }
    case "contract.escalated": {
      const contract = state.contracts[draft.payload.contract];
      if (!contract || !contract.guarded || contract.status !== "proposed") {
        fail("INVALID_STATE", `contract ${draft.payload.contract} is not a pending protected contract`);
      }
      return;
    }
    case "push.announced": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      if (item.tool) {
        fail("NOT_ALLOWED", `item ${item.id} builds a tool: announce its build with tool.built (a tool is gated by its own gate, never integrated)`);
      }
      const write = item.intent?.write ?? [];
      // Each announced path is a concrete file that must lie INSIDE the write
      // intent (a symbol-scoped entry covers its file), not merely touch it.
      const outside = draft.payload.paths.filter((p) => !write.some((w) => entryWithin(p, intentPath(w))));
      if (outside.length > 0) {
        fail("OUTSIDE_INTENT", `pushed paths outside the claim's write intent: ${outside.join(", ")}`);
      }
      const unsafe = draft.payload.paths.filter((p) => p.split("/").some((seg) => seg === "node_modules" || seg === ".git") || /(^|\/)(\.bin|vendor\/bin)\//.test(p));
      if (unsafe.length > 0) {
        fail("PROTECTED", `pushed paths inside dependency or tool trees are never integrated: ${unsafe.join(", ")}`);
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
        ...(draft.payload.failing !== undefined ? { failing: draft.payload.failing } : {}),
        ...(draft.payload.gated === false ? { gated: false as const } : {}),
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
      if (draft.payload.via === "tool") {
        // A tool item completes when its tool passed its own gate and was published.
        const published = item.tool
          ? state.tools.published.find((t) => t.capability === item.tool!.capability && t.version === draft.payload.version)
          : undefined;
        if (item.status !== "claimed" || !published || item.toolBuild?.commit !== published.commit || item.toolBuild?.passed !== true) {
          fail("INVALID_STATE", `item ${item.id} has no published tool build to complete it`);
        }
        return;
      }
      if (!state.passingRevs.includes(draft.payload.n!)) {
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
    case "fix.requested": {
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "claimed" || item.owner === undefined) {
        fail("INVALID_STATE", `item ${item.id} has no owner to ask for a fix`);
      }
      if (draft.payload.attempt !== (item.fixAttempts ?? 0) + 1 || draft.payload.attempt > state.rules.maxFixAttempts) {
        fail("INVALID_STATE", `fix attempt ${draft.payload.attempt} is not the next attempt within the budget for ${item.id}`);
      }
      return;
    }
    case "fix.exhausted":
      requireItem(state, draft.payload.item);
      return;
    case "item.reopened": {
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "claimed" || item.owner !== draft.payload.previousOwner) {
        fail("INVALID_STATE", `item ${item.id} is not held by ${draft.payload.previousOwner}`);
      }
      if (draft.payload.n === undefined && !item.tool) {
        fail("BAD_PAYLOAD", `item.reopened names the failing revision for item ${item.id}`);
      }
      return;
    }
    case "tool.proposed": {
      const p = draft.payload;
      if (state.tools.proposed[p.tool]) {
        fail("DUPLICATE", `tool ${p.tool} was already proposed`);
      }
      const same = Object.values(state.tools.proposed).find((t) => t.capability === p.capability);
      if (same) {
        fail("DUPLICATE", `a tool with capability ${p.capability} was already proposed (${same.tool} by ${same.proposedBy})`);
      }
      if (state.items[toolItemId(p.capability)]) {
        fail("DUPLICATE", `item ${toolItemId(p.capability)} already exists`);
      }
      if (itemCount + 1 > BOARD_LIMITS.maxItems) {
        fail("LIMIT", `a board holds at most ${BOARD_LIMITS.maxItems} items`);
      }
      if (p.kind === "codemod" && p.inputs.length === 0) {
        fail("BAD_PAYLOAD", "a codemod must declare its inputs: the paths or globs it may change (its intended scope)");
      }
      if (draft.rationale === undefined || draft.rationale.trim() === "") {
        fail("BAD_PAYLOAD", "tool.proposed needs a rationale (why a tool beats hand edits here)");
      }
      return;
    }
    case "tool.built": {
      const item = requireOwner(state, toolItemId(draft.payload.capability), draft.from);
      if (!item.tool) {
        fail("INVALID_STATE", `item ${item.id} is not a tool item`);
      }
      // Each built path is a concrete file INSIDE the claim's write intent,
      // which itself lies inside tools/<capability>/: one writer per tool path.
      const write = item.intent?.write ?? [];
      const outside = draft.payload.paths.filter(
        (p) => !write.some((w) => entryWithin(p, intentPath(w))) || !entryWithin(p, toolScope(draft.payload.capability)),
      );
      if (outside.length > 0) {
        fail("OUTSIDE_INTENT", `built paths outside the tool item's write intent (${toolScope(draft.payload.capability)}): ${outside.join(", ")}`);
      }
      if (item.toolBuild !== undefined && item.toolBuild.gated !== true) {
        fail("INVALID_STATE", `the previous build of ${draft.payload.capability} (${item.toolBuild.commit}) has not been gated yet`);
      }
      return;
    }
    case "tool.gated": {
      const item = requireItem(state, toolItemId(draft.payload.capability));
      if (!item.tool || item.status !== "claimed" || item.owner === undefined) {
        fail("INVALID_STATE", `tool item ${item.id} is not being built`);
      }
      if (item.toolBuild?.commit !== draft.payload.commit || item.toolBuild.gated === true) {
        fail("INVALID_STATE", `${draft.payload.commit} is not the latest, ungated build of ${draft.payload.capability}`);
      }
      if (draft.payload.passed !== draft.payload.checks.every((c) => c.passed)) {
        fail("BAD_PAYLOAD", "a tool gate passes exactly when every one of its checks passed");
      }
      return;
    }
    case "tool.published": {
      const p = draft.payload;
      const proposal =
        state.tools.proposed[p.tool] ?? fail("UNKNOWN_REF", `tool ${p.tool} must be proposed (tool.proposed) before it is published`);
      if (proposal.capability !== p.capability || proposal.kind !== p.kind) {
        fail("BAD_PAYLOAD", `tool ${proposal.tool} was proposed as the ${proposal.kind} ${proposal.capability}`);
      }
      const item = state.items[proposal.item];
      if (!item || item.toolBuild?.commit !== p.commit || item.toolBuild.passed !== true) {
        fail("INVALID_STATE", `${p.capability}@${p.commit} did not pass its own gate: an unverified tool is never published`);
      }
      if (state.tools.published.some((t) => t.capability === p.capability && t.version === p.version)) {
        fail("DUPLICATE", `${p.capability}@${p.version} is already published`);
      }
      if (state.tools.published.length >= BOARD_LIMITS.maxTools) {
        fail("LIMIT", `a board publishes at most ${BOARD_LIMITS.maxTools} tool versions`);
      }
      return;
    }
    case "tool.used": {
      const p = draft.payload;
      if (!state.tools.published.some((t) => t.capability === p.capability && t.version === p.version)) {
        fail("UNKNOWN_REF", `${p.capability}@${p.version} is not a published tool version (a consumer pins a published version)`);
      }
      if (!activeAgent(state, p.by)) {
        fail("UNKNOWN_AGENT", `${p.by} is not a joined agent`);
      }
      if (p.item !== undefined) {
        requireOwner(state, p.item, p.by);
      }
      if (p.changedFiles.length > 0) {
        // A tool's changes count only as the consumer's own announced push,
        // inside the write intent of the item it holds.
        if (p.item === undefined || p.commit === undefined) {
          fail("BAD_PAYLOAD", "a use that changed files names the item and the pushed commit");
        }
        const item = state.items[p.item]!;
        if (item.lastPush?.commit !== p.commit || item.lastPush.agent !== p.by) {
          fail("INVALID_STATE", `${p.commit} is not ${p.by}'s latest push for item ${p.item}`);
        }
        const write = item.intent?.write ?? [];
        const outside = p.changedFiles.filter((f) => !write.some((w) => entryWithin(f, intentPath(w))));
        if (outside.length > 0) {
          fail("OUTSIDE_INTENT", `changed files outside item ${p.item}'s write intent: ${outside.join(", ")}`);
        }
      } else if (p.commit !== undefined) {
        fail("BAD_PAYLOAD", "a use that changed no files has no commit");
      }
      return;
    }
    case "agent.left": {
      const holding = Object.values(state.items).filter(
        (i) => (i.status === "claimed" && i.owner === draft.from) || i.claimant?.agent === draft.from,
      );
      if (holding.length > 0) {
        fail("INVALID_STATE", `${draft.from} still holds ${holding.map((i) => i.id).join(", ")}; hand off or complete first`);
      }
      return;
    }
    case "decision.recorded": {
      const p = draft.payload;
      if (p.contract !== undefined) {
        const contract = state.contracts[p.contract] ?? fail("UNKNOWN_REF", `unknown contract ${p.contract}`);
        if (!contract.guarded) {
          fail("INVALID_STATE", `contract ${p.contract} is not a protected contract a human decides`);
        }
      }
      if (p.rev !== undefined) {
        // An attribution is about the LATEST revision, and it must have failed:
        // its outcome is resolved from what changes after it.
        if (p.rev !== state.lastRevN || state.lastFailure?.n !== p.rev) {
          fail("INVALID_STATE", `revision ${p.rev} is not the latest failing revision`);
        }
        // A board stored before outcomes existed has no record of what that
        // revision merged: linking would derive an outcome replay cannot.
        if (state.attribution?.lastRev?.n !== p.rev) {
          fail("INVALID_STATE", `revision ${p.rev} predates attribution outcomes on this board`);
        }
        const unknown = [...(p.answer !== undefined ? [p.answer] : []), ...(p.parsed ?? [])].filter((i) => state.items[i] === undefined);
        if (unknown.length > 0) {
          fail("UNKNOWN_REF", `unknown item(s) ${unknown.join(", ")}`);
        }
      }
      return;
    }
    case "decision.resolved": {
      const open = (state.attribution ?? emptyAttribution()).open.find((o) => o.decisionSeq === draft.payload.decisionSeq);
      if (!open || state.integrated?.n !== draft.payload.passed || state.lastRevN !== draft.payload.passed) {
        fail("INVALID_STATE", `decision ${draft.payload.decisionSeq} has no outcome at revision ${draft.payload.passed}`);
      }
      if (!sameJson(attributionResolution(open, draft.payload.passed), draft.payload)) {
        fail("LOG_MISMATCH", "decision.resolved does not match the revisions since the decision");
      }
      return;
    }
    default:
      return;
  }
}

/** The mechanical outcome of an open attribution decision at passing revision `passed`. */
function attributionResolution(open: BoardOpenAttribution, passed: number): BoardPayloads["decision.resolved"] {
  const fixed = [...open.changed].sort();
  const resolved = resolveAttributionOutcome({ choice: open.answer, parsed: open.parsed, fixed });
  return {
    decisionSeq: open.decisionSeq,
    rev: open.rev,
    passed,
    answer: open.answer,
    outcome: resolved.outcome,
    fixed,
    parsed: [...open.parsed],
    parseOutcome: resolved.parseOutcome,
  };
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

/**
 * The status a new item starts in: the lead's (and a human's) items are open
 * at once; a WORKER's proposal waits for the lead to accept or reject it.
 */
function proposalStatus(state: BoardState, from: string): BoardItemStatus {
  if (from === BOARD_HUMAN || from === BOARD_ENGINE) {
    return "open";
  }
  return state.agents[from]?.role === LEAD_ROLE ? "open" : "proposed";
}

/** Apply one message by mutating `state`. */
function applyInPlace(state: BoardState, message: BoardMessage): void {
  state.lastSeq = message.seq;
  const from = message.from;
  switch (message.type) {
    case "goal.posted":
      state.goal = { objective: message.payload.objective, seq: message.seq };
      state.rules = { ...message.payload.rules };
      state.protected = [...(message.payload.protected ?? [])];
      state.protectedKeys = [...(message.payload.protectedKeys ?? [])];
      state.testInventory = message.payload.testInventory ?? null;
      break;
    case "item.proposed":
      state.items[message.payload.item] = {
        id: message.payload.item,
        objective: message.payload.objective,
        acceptance: message.payload.acceptance,
        scopeHint: message.payload.scopeHint,
        status: proposalStatus(state, from),
        proposedBy: from,
        proposedSeq: message.seq,
        children: [],
        doneProposed: false,
        ...(message.payload.fromTool !== undefined ? { fromTool: { ...message.payload.fromTool } } : {}),
      };
      break;
    case "item.discovered": {
      const p = message.payload;
      state.items[p.item] = {
        id: p.item,
        objective: p.objective,
        acceptance: [],
        scopeHint: p.scopeHint ?? [],
        status: proposalStatus(state, from),
        proposedBy: from,
        proposedSeq: message.seq,
        ...(p.parent !== undefined ? { parent: p.parent } : {}),
        children: [],
        discovered: { by: from, reason: p.reason },
        doneProposed: false,
      };
      break;
    }
    case "item.accepted":
    case "item.rejected": {
      const item = state.items[message.payload.item]!;
      const accepted = message.type === "item.accepted";
      item.status = accepted ? "open" : "rejected";
      item.triage = { decision: accepted ? "accepted" : "rejected", by: from, seq: message.seq };
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
        ...(message.payload.item !== undefined ? { item: message.payload.item } : {}),
        ...(state.protected.some((p) => entriesOverlap(message.payload.target, p)) ? { guarded: true } : {}),
        proposedBy: from,
        status: "proposed",
      };
      break;
    case "contract.escalated":
      // The decision is a human's: the escalation record carries it.
      break;
    case "contract.accepted":
    case "contract.rejected": {
      const contract = state.contracts[message.payload.contract]!;
      contract.status = message.type === "contract.accepted" ? "accepted" : "rejected";
      contract.decidedBy = from;
      if (message.type === "contract.rejected" && contract.guarded && contract.item !== undefined && state.items[contract.item]) {
        state.items[contract.item]!.contractRejectedSeq = message.seq;
      }
      break;
    }
    case "push.announced": {
      state.pushes += 1;
      const item = state.items[message.payload.item]!;
      item.lastPush = {
        seq: message.seq,
        commit: message.payload.commit,
        agent: from,
        paths: message.payload.paths,
      };
      // The owner answered any outstanding fix request with this push.
      delete item.fixRequested;
      break;
    }
    case "integrated.rev": {
      // Before anything is marked integrated: which item each merged push is
      // for, so open attribution decisions can see what changed since them.
      const mergedByItem: Record<string, string> = {};
      for (const commit of message.payload.merged) {
        const item = itemForPendingPush(state, commit);
        if (item) {
          mergedByItem[item.id] = commit;
        }
      }
      const attribution = attributionOf(state);
      for (const open of attribution.open) {
        if (open.rev < message.payload.n) {
          for (const [item, commit] of Object.entries(mergedByItem)) {
            if (open.base[item] !== commit && !open.changed.includes(item)) {
              open.changed.push(item);
            }
          }
        }
      }
      attribution.lastRev = { n: message.payload.n, merged: mergedByItem };
      state.lastRevN = message.payload.n;
      if (message.payload.gate === "fail" && message.payload.failing !== undefined) {
        state.lastFailure = { n: message.payload.n, ...message.payload.failing };
        for (const id of message.payload.failing.items) {
          if (state.items[id]) {
            state.items[id]!.implicatedSeq = message.seq;
          }
        }
      }
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
    }
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
      item.completed =
        message.payload.via === "tool"
          ? { via: "tool", version: message.payload.version! }
          : { n: message.payload.n!, via: message.payload.via };
      delete item.intent;
      delete item.fixRequested;
      break;
    }
    case "fix.requested": {
      const item = state.items[message.payload.item]!;
      item.fixAttempts = message.payload.attempt;
      item.fixRequested = message.payload.n;
      break;
    }
    case "fix.exhausted": {
      const item = state.items[message.payload.item]!;
      item.fixExhausted = true;
      delete item.fixRequested;
      break;
    }
    case "item.reopened": {
      const item = state.items[message.payload.item]!;
      item.exhaustedBy = [...(item.exhaustedBy ?? []), message.payload.previousOwner];
      item.reopenedFrom = { agent: message.payload.previousOwner, ...(message.payload.commit !== undefined ? { commit: message.payload.commit } : {}) };
      releaseClaim(item);
      // The next owner gets its own fix budget (and, for a tool, its own gate failures).
      item.fixAttempts = 0;
      delete item.toolFailures;
      delete item.fixExhausted;
      break;
    }
    case "tool.proposed": {
      const p = message.payload;
      const itemId = toolItemId(p.capability);
      state.tools.proposed[p.tool] = {
        tool: p.tool,
        capability: p.capability,
        kind: p.kind,
        inputs: p.inputs,
        outputs: p.outputs,
        proposedBy: from,
        seq: message.seq,
        item: itemId,
        builds: 0,
        failedGates: 0,
      };
      // Building the tool is work like any other: an item the lead accepts (a
      // worker's proposal) and an agent claims, writing only its tool directory.
      state.items[itemId] = {
        id: itemId,
        objective: `Build the ${p.kind} tool ${p.capability} in ${TOOLS_DIR}/${p.capability}/ and pass its own gate`,
        acceptance: [`the ${p.kind} tool's own gate passes and it is published`],
        scopeHint: [toolScope(p.capability)],
        status: proposalStatus(state, from),
        proposedBy: from,
        proposedSeq: message.seq,
        children: [],
        doneProposed: false,
        tool: { capability: p.capability, kind: p.kind },
      };
      break;
    }
    case "tool.built": {
      const item = state.items[toolItemId(message.payload.capability)]!;
      item.toolBuild = { commit: message.payload.commit, paths: message.payload.paths, seq: message.seq };
      const proposal = Object.values(state.tools.proposed).find((t) => t.capability === message.payload.capability);
      if (proposal) {
        proposal.builds += 1;
      }
      break;
    }
    case "tool.gated": {
      const item = state.items[toolItemId(message.payload.capability)]!;
      item.toolBuild = { ...item.toolBuild!, gated: true, passed: message.payload.passed };
      const proposal = Object.values(state.tools.proposed).find((t) => t.capability === message.payload.capability);
      if (proposal && !message.payload.passed) {
        proposal.failedGates += 1;
        item.toolFailures = (item.toolFailures ?? 0) + 1;
      }
      break;
    }
    case "tool.published": {
      const p = message.payload;
      const proposal = state.tools.proposed[p.tool];
      const item = proposal ? state.items[proposal.item] : undefined;
      state.tools.published.push({
        tool: p.tool,
        capability: p.capability,
        version: p.version,
        repo: p.repo,
        commit: p.commit,
        kind: p.kind,
        usage: p.usage,
        publishedBy: item?.owner ?? from,
        seq: message.seq,
        gateSeq: message.inReplyTo ?? message.seq,
        ...(p.joinsGate === false ? { joinsGate: false as const } : {}),
        uses: 0,
      });
      break;
    }
    case "tool.used": {
      const tool = state.tools.published.find(
        (t) => t.capability === message.payload.capability && t.version === message.payload.version,
      );
      if (tool) {
        tool.uses += 1;
      }
      break;
    }
    case "decision.recorded":
      state.decisions.calls += 1;
      if (message.payload.accepted) {
        state.decisions.accepted += 1;
      }
      if (message.payload.error !== undefined) {
        state.decisions.errors += 1;
      }
      // An attribution about a failing revision waits for its mechanical
      // outcome (a decision without an answer has nothing to confirm).
      if (message.payload.rev !== undefined && message.payload.answer !== undefined && message.payload.error === undefined) {
        const attribution = attributionOf(state);
        attribution.open.push({
          decisionSeq: message.seq,
          rev: message.payload.rev,
          answer: message.payload.answer,
          parsed: [...(message.payload.parsed ?? [])],
          base: attribution.lastRev?.n === message.payload.rev ? { ...attribution.lastRev.merged } : {},
          changed: [],
        });
      }
      break;
    case "decision.resolved": {
      const attribution = attributionOf(state);
      attribution.open = attribution.open.filter((o) => o.decisionSeq !== message.payload.decisionSeq);
      const r = resolveAttributionOutcome({ choice: message.payload.answer, parsed: message.payload.parsed, fixed: message.payload.fixed });
      if (r.outcome === "in-fixed-set") {
        attribution.inFixedSet += 1;
      } else {
        attribution.notInFixedSet += 1;
      }
      if (r.parseOutcome === "none") {
        attribution.parse.none += 1;
      } else if (r.parseOutcome === "in-fixed-set") {
        attribution.parse.inFixedSet += 1;
      } else {
        attribution.parse.notInFixedSet += 1;
      }
      attribution.parse.extra += r.parseExtra.length;
      if (r.disagreement !== undefined) {
        // Older bookkeeping may lack the field.
        const d = (attribution.differed ??= { total: 0, pickOnly: 0, parseOnly: 0, both: 0, neither: 0 });
        d.total += 1;
        d[r.disagreement === "pick-only" ? "pickOnly" : r.disagreement === "parse-only" ? "parseOnly" : r.disagreement] += 1;
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
  delete item.fixRequested;
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
    case "contract.proposed": {
      const contract = work.contracts[incoming.payload.contract];
      if (contract?.guarded && contract.item !== undefined) {
        emit({
          from: BOARD_ENGINE,
          type: "contract.escalated",
          payload: { contract: contract.contract, item: contract.item, target: contract.target, kind: contract.kind },
        });
      }
      break;
    }
    case "done.proposed":
      completeIfReady(incoming.payload.item);
      break;
    case "tool.gated": {
      // Only a build that passed its OWN gate enters the registry, as the next
      // version of its capability; the tool item completes with it.
      const p = incoming.payload;
      const proposal = Object.values(work.tools.proposed).find((t) => t.capability === p.capability);
      if (p.passed && proposal) {
        const version = String(work.tools.published.filter((t) => t.capability === p.capability).length + 1);
        emit({
          from: BOARD_ENGINE,
          type: "tool.published",
          payload: {
            tool: proposal.tool,
            capability: p.capability,
            version,
            repo: p.repo,
            commit: p.commit,
            verified: true,
            kind: proposal.kind,
            usage: p.usage,
            ...(proposal.kind === "check" ? { joinsGate: false as const } : {}),
          },
        });
        emit({ from: BOARD_ENGINE, type: "item.completed", payload: { item: proposal.item, via: "tool", version } });
        resolveWaitersOn(proposal.item);
      } else if (proposal) {
        // A builder whose builds keep failing their own gate does not hold the
        // tool forever: past the fix budget the tool item reopens for another
        // agent (who starts from the tool's branch), bounded to TOOL_REOPENS.
        const item = work.items[proposal.item];
        if (
          item?.status === "claimed" &&
          item.owner !== undefined &&
          (item.toolFailures ?? 0) >= rules.maxFixAttempts &&
          (item.exhaustedBy?.length ?? 0) < BOARD_LIMITS.toolReopens
        ) {
          emit({ from: BOARD_ENGINE, type: "item.reopened", payload: { item: item.id, previousOwner: item.owner, commit: p.commit } });
          resolveWaitersOn(item.id);
        }
      }
      break;
    }
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
        // Every open attribution decision now has its mechanical outcome.
        for (const open of [...attributionOf(work).open]) {
          emit({ from: BOARD_ENGINE, type: "decision.resolved", payload: attributionResolution(open, incoming.payload.n) });
        }
      } else {
        // A failing revision advances nothing. Each implicated item's owner is
        // asked for a fix (addressed to it) while the item's fix budget lasts;
        // past the budget the exhaustion is recorded instead.
        for (const itemId of incoming.payload.failing?.items ?? []) {
          const item = work.items[itemId];
          if (!item || item.status !== "claimed" || item.owner === undefined || item.fixExhausted) {
            continue;
          }
          const attempt = (item.fixAttempts ?? 0) + 1;
          if (attempt <= rules.maxFixAttempts && activeAgent(work, item.owner)) {
            emit({
              from: BOARD_ENGINE,
              type: "fix.requested",
              payload: { item: item.id, n: incoming.payload.n, attempt },
              to: [item.owner],
            });
          } else {
            const owner = item.owner;
            const commit = item.lastPush?.agent === owner ? item.lastPush?.commit : undefined;
            emit({
              from: BOARD_ENGINE,
              type: "fix.exhausted",
              payload: { item: item.id, n: incoming.payload.n, attempts: item.fixAttempts ?? 0 },
            });
            // A spent budget is not a dead end: the item reopens for fresh
            // eyes, starting from the previous owner's latest push.
            emit({
              from: BOARD_ENGINE,
              type: "item.reopened",
              payload: { item: item.id, previousOwner: owner, n: incoming.payload.n, ...(commit !== undefined ? { commit } : {}) },
            });
            resolveWaitersOn(item.id);
          }
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
  /** A failing revision's bounded output and implicated items (only with gate "fail"). */
  readonly failing?: BoardFailingEvidence;
  /** False when no gate ran (only with gate "pass"): nothing was checked. */
  readonly gated?: false;
}

/**
 * The integrated.rev payload for a recorded integration result: numbered next,
 * with paths and contributors derived from the merged pushes, never taken on
 * trust. Throws when a merged commit is not an announced, unintegrated push.
 */
function integratedRevPayload(state: BoardState, input: IntegratedRevInput): BoardPayloads["integrated.rev"] {
  const paths: string[] = [];
  const contributors: string[] = [];
  const mergedItems: string[] = [];
  for (const commit of input.merged) {
    const item = itemForPendingPush(state, commit);
    if (!item?.lastPush) {
      fail("UNKNOWN_REF", `commit ${commit} is not the latest, unintegrated push of any item`);
    }
    mergedItems.push(item.id);
    for (const path of item.lastPush.paths) {
      if (!paths.includes(path)) {
        paths.push(path);
      }
    }
    if (!contributors.includes(item.lastPush.agent)) {
      contributors.push(item.lastPush.agent);
    }
  }
  if (input.gated === false && input.gate !== "pass") {
    fail("BAD_PAYLOAD", "only a revision that no gate failed can be ungated");
  }
  if (input.failing !== undefined) {
    if (input.gate !== "fail") {
      fail("BAD_PAYLOAD", "only a failing revision carries failing evidence");
    }
    const strangers = input.failing.items.filter((item) => !mergedItems.includes(item));
    if (strangers.length > 0) {
      fail("UNKNOWN_REF", `implicated item(s) ${strangers.join(", ")} had no push in this revision`);
    }
  }
  return {
    n: state.lastRevN + 1,
    commit: input.commit,
    gate: input.gate,
    merged: [...input.merged],
    paths,
    contributors,
    ...(input.failing !== undefined ? { failing: { output: input.failing.output, items: [...input.failing.items] } } : {}),
    ...(input.gated === false ? { gated: false as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Log operations
// ---------------------------------------------------------------------------

/**
 * Engine messages that START a batch: each records an operator-side result
 * through its own route (an integration, an advisory decision, a tool's gate,
 * a tool use). Every other engine message is derived by arbitration.
 */
const RECORDED_ENGINE_TYPES: ReadonlySet<BoardMessageType> = new Set(["integrated.rev", "decision.recorded", "tool.gated", "tool.used"]);

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
    if (incoming.from === BOARD_ENGINE && !RECORDED_ENGINE_TYPES.has(incoming.type)) {
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
  for (const key of Object.keys(input)) {
    if (!["commit", "gate", "merged", "failing", "gated"].includes(key)) {
      fail("BAD_PAYLOAD", `an integration result has an unknown field ${JSON.stringify(key)}`);
    }
  }
  const failing = input.failing === undefined ? undefined : failingEvidence(input.failing);
  const parsed: IntegratedRevInput = {
    commit: id(input, "commit"),
    gate: oneOf(input, "gate", ["pass", "fail"] as const),
    merged: idList(input, "merged", { max: BOARD_LIMITS.maxIntentEntries }),
    ...(failing !== undefined ? { failing } : {}),
    ...(ungatedFlag(input) ? { gated: false as const } : {}),
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

/**
 * Check, without appending anything, that `agent` could join the board now
 * (as the join route would append it). Throws the same BoardError a refused
 * join would, so a substrate can refuse a join BEFORE provisioning anything
 * for it (a workspace, a token).
 */
export function checkBoardJoin(state: BoardState, agent: string, body: { readonly role?: unknown; readonly rationale?: unknown } = {}): void {
  appendBoardMessage(
    state,
    { kind: "join", agent },
    {
      type: "agent.joined",
      payload: body.role !== undefined ? { role: body.role } : {},
      ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
    },
    "1970-01-01T00:00:00.000Z",
  );
}

/**
 * Append the engine's advisory decision.recorded for a typed decision the
 * operator side made (a plan review, an attribution, a fix-confidence check)
 * and its outcome. Validated like any message; it changes nothing but the
 * decision counts.
 */
export function appendDecisionRecorded(state: BoardState, input: unknown, at: string): BoardAppendResult {
  if (state.goal === null) {
    fail("NO_GOAL", "the board has no goal yet");
  }
  if (!isRecord(input)) {
    fail("BAD_PAYLOAD", "a decision record must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!["juncture", "question", "answer", "confidence", "accepted", "error", "rev", "parsed", "contract"].includes(key)) {
      fail("BAD_PAYLOAD", `a decision record has an unknown field ${JSON.stringify(key)}`);
    }
  }
  const payload = parsePayload("decision.recorded", input) as BoardPayloads["decision.recorded"];
  return appendChecked(state, { from: BOARD_ENGINE, type: "decision.recorded", payload }, at);
}

/** Validate an operator record against the fields one engine message type accepts. */
function recordedPayload<K extends "tool.gated" | "tool.used">(type: K, input: unknown, fields: readonly string[]): BoardPayloads[K] {
  if (!isRecord(input)) {
    fail("BAD_PAYLOAD", `a ${type} record must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) {
      fail("BAD_PAYLOAD", `a ${type} record has an unknown field ${JSON.stringify(key)}`);
    }
  }
  return parsePayload(type, input) as BoardPayloads[K];
}

/**
 * Append the engine's tool.gated for a tool gate the operator ran on the
 * latest build of a tool item (`POST /changes/:id/tools/gate`). It is
 * addressed to the builder. A pass derives tool.published (the next version)
 * and completes the tool item; a fail publishes nothing.
 */
export function appendToolGated(state: BoardState, input: unknown, at: string): BoardAppendResult {
  if (state.goal === null) {
    fail("NO_GOAL", "the board has no goal yet");
  }
  const payload = recordedPayload("tool.gated", input, ["capability", "commit", "passed", "checks", "repo", "usage", "output"]);
  const owner = state.items[toolItemId(payload.capability)]?.owner;
  return appendChecked(
    state,
    { from: BOARD_ENGINE, type: "tool.gated", payload, ...(owner !== undefined && activeAgent(state, owner) ? { to: [owner] } : {}) },
    at,
  );
}

/**
 * Append the engine's tool.used for a run of a PINNED, published tool version
 * the operator's runtime executed in a consumer's own repo
 * (`POST /changes/:id/tools/used`). It is addressed to the tool's builder (so
 * a scanner's findings reach whoever can turn them into proposals).
 */
export function appendToolUsed(state: BoardState, input: unknown, at: string): BoardAppendResult {
  if (state.goal === null) {
    fail("NO_GOAL", "the board has no goal yet");
  }
  const payload = recordedPayload("tool.used", input, ["capability", "version", "by", "item", "commit", "changedFiles", "findings", "exit"]);
  const builder = state.tools.published.find((t) => t.capability === payload.capability && t.version === payload.version)?.publishedBy;
  const to = builder !== undefined && builder !== payload.by && activeAgent(state, builder) ? { to: [builder] } : {};
  return appendChecked(state, { from: BOARD_ENGINE, type: "tool.used", payload, ...to }, at);
}

/**
 * The board's attribution outcomes as a tally: resolved decisions, and those
 * still open (unresolved: no passing revision has followed them yet).
 */
export function boardAttributionTally(state: BoardState): AttributionTally {
  const a = state.attribution ?? emptyAttribution();
  return {
    decisions: a.inFixedSet + a.notInFixedSet + a.open.length,
    inFixedSet: a.inFixedSet,
    notInFixedSet: a.notInFixedSet,
    unresolved: a.open.length,
    parse: { ...a.parse },
    differed: { ...(a.differed ?? emptyAttribution().differed) },
  };
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
  const items: Record<BoardItemStatus, number> = { proposed: 0, rejected: 0, open: 0, claimed: 0, contested: 0, split: 0, done: 0 };
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
  /**
   * The last seq this page of the log covered (the next page starts after it).
   * The messages below are filtered, so page by this, never by the last message.
   */
  readonly pageEnd: number;
  readonly claims: readonly {
    readonly item: string;
    readonly objective: string;
    readonly intent: BoardIntent;
    readonly doneProposed: boolean;
    /** The item's latest push; `agent` differs from the claimant after a handoff. */
    readonly lastPush?: { readonly commit: string; readonly agent: string; readonly integratedIn?: number };
    /** An unanswered fix request: the failing revision and the attempt number. */
    readonly fix?: { readonly n: number; readonly attempt: number };
    /** The item's fix budget is spent. */
    readonly fixExhausted?: boolean;
    /**
     * Tools whose inputs cover this claim's write intent that it must NOT wait
     * for (rejected, failed their own gate, or not published within
     * `toolWaitMessages`): edit by hand instead.
     */
    readonly toolUnavailable?: readonly { readonly capability: string; readonly reason: string }[];
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
  /** The latest failing revision's evidence, when it asks this agent for a fix. */
  readonly failure: ({ readonly n: number } & BoardFailingEvidence) | null;
  /** Paths no agent may write (posted with the goal). */
  readonly protected: readonly string[];
  /** Gate-defining keys inside editable files (posted with the goal). */
  readonly protectedKeys: readonly string[];
  /** Protected paths accepted contracts released for this agent's items. */
  readonly released: readonly string[];
  /** Messages after `after` addressed to this agent or touching its work. */
  readonly messages: readonly BoardMessage[];
}

const BROADCAST_TYPES: ReadonlySet<BoardMessageType> = new Set([
  "goal.posted",
  "item.proposed",
  "item.accepted",
  "item.rejected",
  "item.discovered",
  "item.split",
  "integrated.rev",
  "contract.proposed",
  "contract.accepted",
  "contract.rejected",
  "tool.proposed",
  "tool.gated",
  "tool.published",
  "item.reopened",
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
    if (["agent", "owner", "claimant", "winner", "to", "by"].some((k) => p[k] === agent)) {
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
  const held = Object.values(state.items).filter((i) => i.status === "claimed" && i.owner === agent && i.intent);
  const failure = state.lastFailure;
  const askedToFix = failure !== null && held.some((i) => i.fixRequested === failure.n);
  return {
    agent,
    ...(record?.role !== undefined ? { role: record.role } : {}),
    active: record !== undefined && record.leftSeq === undefined,
    lastSeq: state.lastSeq,
    after,
    pageEnd: messages.reduce((end, m) => Math.max(end, m.seq), after),
    claims: held.map((i) => ({
      item: i.id,
      objective: i.objective,
      intent: i.intent!,
      doneProposed: i.doneProposed,
      ...(i.lastPush
        ? {
            lastPush: {
              commit: i.lastPush.commit,
              agent: i.lastPush.agent,
              ...(i.lastPush.integratedIn !== undefined ? { integratedIn: i.lastPush.integratedIn } : {}),
            },
          }
        : {}),
      ...(i.fixRequested !== undefined ? { fix: { n: i.fixRequested, attempt: i.fixAttempts ?? 1 } } : {}),
      ...(i.fixExhausted ? { fixExhausted: true } : {}),
      ...((): { toolUnavailable?: { capability: string; reason: string }[] } => {
        const unavailable = i.tool ? [] : unavailableToolsFor(state, i.intent!.write);
        return unavailable.length > 0 ? { toolUnavailable: unavailable } : {};
      })(),
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
    failure: askedToFix ? failure : null,
    protected: state.protected,
    protectedKeys: state.protectedKeys,
    released: [...new Set(held.flatMap((i) => releasedTargets(state, i.id)))],
    messages: messages.filter((m) => m.seq > after && relevant(m)),
  };
}

/**
 * Why a tool is unavailable to wait for, or undefined while it may still come
 * (or is published): the lead rejected it, a build failed its own gate, or it
 * was not published within `toolWaitMessages` board messages of its proposal.
 * A pure function of the board, so every substrate derives the same answer.
 */
export function toolUnavailableReason(state: BoardState, capability: string): string | undefined {
  const proposal = Object.values(state.tools.proposed).find((t) => t.capability === capability);
  if (!proposal || state.tools.published.some((t) => t.capability === capability)) {
    return undefined;
  }
  const item = state.items[proposal.item];
  if (item?.status === "rejected") {
    return "the lead rejected it";
  }
  if (proposal.failedGates > 0) {
    return `its own gate failed ${proposal.failedGates} time(s)${(item?.exhaustedBy?.length ?? 0) > 0 ? ` (reopened for another builder ${item!.exhaustedBy!.length} time(s))` : ""}`;
  }
  if (state.lastSeq - proposal.seq > BOARD_LIMITS.toolWaitMessages) {
    return `not published within ${BOARD_LIMITS.toolWaitMessages} board messages of its proposal`;
  }
  return undefined;
}

/** The unavailable tools whose inputs cover a write intent (a scanner or codemod with no inputs covers everything). */
function unavailableToolsFor(state: BoardState, write: readonly string[]): { capability: string; reason: string }[] {
  const out: { capability: string; reason: string }[] = [];
  for (const proposal of Object.values(state.tools.proposed)) {
    if (proposal.kind !== "codemod" && proposal.kind !== "scanner") {
      continue;
    }
    const covers = proposal.inputs.length === 0 || write.some((w) => proposal.inputs.some((input) => entriesOverlap(intentPath(w), input)));
    const reason = covers ? toolUnavailableReason(state, proposal.capability) : undefined;
    if (reason !== undefined) {
      out.push({ capability: proposal.capability, reason });
    }
  }
  return out;
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
  /** The contest it decides (a claim.escalated), or */
  readonly boardContest?: string;
  /** the protected contract it decides (a contract.escalated). */
  readonly boardContract?: string;
}

/** Escalation requests for every claim.escalated among `messages`. */
export function boardEscalationRequests(messages: readonly BoardMessage[]): BoardEscalationRequest[] {
  const out: BoardEscalationRequest[] = [];
  for (const message of messages) {
    if (message.type === "contract.escalated") {
      const c = message.payload;
      out.push({
        kind: "decision",
        path: c.target,
        question:
          `Board contract ${c.contract}: an agent asks to ${c.kind} ${c.target} for item ${c.item}. ` +
          "It is part of the original code's tests or the gate's configuration (the contract). Accept or reject?",
        options: ["accept", "reject"],
        boardContract: c.contract,
      });
      continue;
    }
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

/** Contract id -> "accept" / "reject" for every contract decided among `messages`. */
export function boardContractClosures(messages: readonly BoardMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of messages) {
    if (message.type === "contract.accepted" || message.type === "contract.rejected") {
      out.set(message.payload.contract, message.type === "contract.accepted" ? "accept" : "reject");
    }
  }
  return out;
}

/**
 * The human contract.accepted / contract.rejected an escalation decision on a
 * protected contract becomes. Undefined when it is already decided; throws when
 * the decision is neither "accept" nor "reject".
 */
export function boardContractDecision(state: BoardState, contractId: string, decision: string): BoardDraft | undefined {
  const contract = state.contracts[contractId] ?? fail("UNKNOWN_REF", `unknown contract ${contractId}`);
  if (contract.status !== "proposed") {
    return undefined;
  }
  const answer = decision.trim().toLowerCase();
  if (answer !== "accept" && answer !== "reject") {
    fail("BAD_PAYLOAD", `the decision for contract ${contractId} must be accept or reject`);
  }
  return { from: BOARD_HUMAN, type: answer === "accept" ? "contract.accepted" : "contract.rejected", payload: { contract: contractId } };
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
  readonly boardContract?: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly status: "pending" | "resolved";
  readonly decision?: string;
  readonly raisedAt: string;
  readonly resolvedAt?: string;
  /**
   * A protected contract's ADVISORY triage (a typed decision), shown to the
   * human beside the question: "accept (confidence 0.86)", or "no
   * recommendation (reason)". The human still decides; it never resolves.
   */
  readonly recommendation?: string;
}

/** Separates an escalation's question from its advisory triage line. */
export const CONTRACT_TRIAGE_MARKER = "\nAdvisory triage (a typed decision; the human decides): ";

/**
 * The recommendation a contract-triage decision gives the human: the answer and
 * its confidence when the decision was confident (accepted), otherwise "no
 * recommendation (reason)" (an error, no answer, or low confidence).
 */
export function contractTriageRecommendation(decision: BoardPayloads["decision.recorded"]): string {
  if (decision.error !== undefined) {
    return `no recommendation (${decision.error})`;
  }
  if (decision.answer === undefined) {
    return "no recommendation (the decision reply carried no answer)";
  }
  const confidence = decision.confidence !== undefined ? ` (confidence ${decision.confidence.toFixed(2)})` : "";
  return decision.accepted ? `${decision.answer}${confidence}` : `no recommendation (low confidence: leaning ${decision.answer}${confidence})`;
}

/** An escalation question with its triage line (replacing any earlier one). */
export function withContractTriage(question: string, recommendation: string): string {
  return `${question.split(CONTRACT_TRIAGE_MARKER)[0]}${CONTRACT_TRIAGE_MARKER}${recommendation}`;
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
  const decided = boardContractClosures(appended);
  // The latest advisory triage per contract among the appended messages.
  const triage = new Map<string, string>();
  for (const message of appended) {
    if (message.type === "decision.recorded" && message.payload.juncture === "contract-triage" && message.payload.contract !== undefined) {
      triage.set(message.payload.contract, contractTriageRecommendation(message.payload));
    }
  }
  const out = list.map((e): E => {
    const decision =
      e.boardContest !== undefined ? settled.get(e.boardContest) : e.boardContract !== undefined ? decided.get(e.boardContract) : undefined;
    if (e.status === "pending" && decision !== undefined) {
      return { ...e, status: "resolved", decision, resolvedAt: at };
    }
    // Advice only decorates a PENDING contract escalation; it never resolves one.
    const recommendation = e.boardContract !== undefined ? triage.get(e.boardContract) : undefined;
    return e.status === "pending" && recommendation !== undefined
      ? { ...e, question: withContractTriage(e.question, recommendation), recommendation }
      : e;
  });
  const raised: E[] = [];
  for (const request of boardEscalationRequests(appended)) {
    const existing = out.find(
      (e) =>
        e.status === "pending" &&
        ((request.boardContest !== undefined && e.boardContest === request.boardContest) ||
          (request.boardContract !== undefined && e.boardContract === request.boardContract)),
    );
    if (existing) {
      raised.push(existing);
      continue;
    }
    const escalation = {
      id: `esc-${out.length + 1}-${nowMs.toString(36)}`,
      kind: request.kind,
      ...(request.path !== undefined ? { path: request.path } : {}),
      ...(request.boardContest !== undefined ? { boardContest: request.boardContest } : {}),
      ...(request.boardContract !== undefined ? { boardContract: request.boardContract } : {}),
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

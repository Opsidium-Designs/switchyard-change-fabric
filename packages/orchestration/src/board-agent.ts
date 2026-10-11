/**
 * board-agent: one agent's runtime on a Change board (a local runner in the
 * driver process; one instance per agent).
 *
 * The loop is observe, decide, act:
 *   - OBSERVE: read the agent's digest of the board after the last seq it saw;
 *   - DECIDE: take a TURN only when something relevant arrived (a message
 *     addressed to it, one touching its items or contests, a rebase.needed,
 *     new open items while it is free), or its own previous action was
 *     accepted or refused (it keeps the initiative until it chooses to wait);
 *     a turn is one call to the turn transport,
 *     which returns exactly one typed action;
 *   - ACT: map the action to a board post through the agent's own token (the
 *     board validates and arbitrates it), or, for `edit`, run the existing
 *     executor in the agent's own repo inside its claimed write intent, commit,
 *     push, and announce the push.
 *
 * A refused post feeds its `{code, error}` into the next turn, so agents learn
 * from arbitration. Budgets are per item (turns spent on one item) and per run
 * (turns across all agents); exceeding either is RECORDED on the board (a
 * handoff to another agent, or a help request, or agent.left when the agent
 * holds nothing) and stops the agent.
 *
 * The lead is an agent with role `lead`. Its first turn is the existing
 * planner: the injected seed decomposes the goal and each unit becomes an
 * `item.proposed` (never an assignment). Later lead turns arbitrate contract
 * proposals through the same turn transport.
 *
 * Nothing here is goal- or app-specific: the runtime knows the board's rules,
 * the agent's intents, and the repo it is given, nothing else.
 */

import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  detectBoardToolNeed,
  entriesOverlap,
  splitCue,
  uncoveredFailureFiles,
  failingRepoFiles,
  replanEligible,
  hasWildcard,
  intentPath,
  isAcceptedItem,
  LEAD_ROLE,
  toolBranch,
  toolItemId,
  seamContractFacts,
  seamItemId,
  toolUnavailableReason,
  toolScope,
  type BoardDigest,
  type BoardMessage,
  type BoardState,
} from "@switchyard-change/change-core";
import type {
  AgentAction,
  AgentActionType,
  AgentRepoExcerpt,
  AgentTurnHistoryEntry,
  AgentTurnInput,
  AgentTurnTransport,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";
import { AGENT_ACTION_TYPES, isModelBudgetError } from "@switchyard-change/model-adapters";
import { runGit } from "@switchyard-change/artifact-workspace/git-transport";
import { authenticatedRemote, clone, push, type GitIdentity } from "@switchyard-change/local-runner";
import { gateFailureLine, matchesGlob, partitionByScope, toolSkeleton } from "@switchyard-change/verification";

import { boardReferenceFiles, type ReferenceFile } from "./board-references.ts";
import { ToolUseError, type ToolAuthor, type ToolBench } from "./board-tools.ts";
import type { RefreshableToken } from "./token-refresh.ts";
import type { RunCapReached, RunMeter } from "./run-meter.ts";

import { redactSecrets } from "./redact.ts";
import {
  BoardAgentClient,
  type BoardJoined,
  type BoardPostOutcome,
  type BoardRejection,
  type JoinedWorkspace,
} from "./board-client.ts";


/** One item the lead seeds onto the board. */
export interface BoardSeedItem {
  readonly item: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly scopeHint: readonly string[];
}

/** The run-wide turn budget, shared by every agent of a run. */
export class RunTurnBudget {
  used = 0;
  constructor(readonly maxTurns: number) {}
  get exhausted(): boolean {
    return this.used >= this.maxTurns;
  }
}

/** One recorded turn (the transcript of an agent's decisions). */
export interface AgentTurnRecord {
  readonly agent: string;
  readonly turn: number;
  readonly action: AgentAction;
  readonly outcome: "posted" | "rejected" | "local" | "seeded";
  readonly code?: string;
  readonly error?: string;
  /** Set when the model output (or call) was invalid and the action is a recorded wait. */
  readonly invalid?: string;
  /** The seqs of the board messages this turn appended (the post and what it triggered). */
  readonly seqs?: readonly number[];
}

/** Why an agent stopped. */
export interface AgentStop {
  readonly reason: "item-budget" | "run-budget" | "stopped";
  readonly detail: string;
}

/** What one step did. */
export type AgentStepResult = "acted" | "idle" | "stopped";

/** Joins an agent (the operator holds the bearer; the agent never does). */
export type BoardJoiner = (
  agent: string,
  options: { readonly role?: string; readonly rationale?: string; readonly workspaceTtlSeconds?: number },
) => Promise<BoardJoined | BoardRejection>;

/** Options for one agent runtime. */
export interface BoardAgentOptions {
  readonly id: string;
  readonly role: "worker" | "lead";
  readonly goal: string;
  readonly changeId: string;
  /** The board base URL and the plain fetch the agent's own calls use (no bearer). */
  readonly baseUrl: string;
  readonly fetchFn: typeof fetch;
  readonly join: BoardJoiner;
  readonly transport: AgentTurnTransport<BoardDigest, BoardMessage>;
  /** The executor an `edit` runs (workers). */
  readonly executor?: ExecutorProvider;
  /** The project baseline the agent reads current file contents from. */
  readonly projectDir: string;
  /** Where the agent keeps its worktree and edit views. */
  readonly workRoot: string;
  readonly identity?: GitIdentity;
  /** The explicit, short write-token lifetime its join asks for (workers). */
  readonly workspaceTtlSeconds: number;
  /** Turns the agent may spend on one item before it hands the item off. */
  readonly maxTurnsPerItem: number;
  readonly runBudget: RunTurnBudget;
  /** The lead's first turn: the planner's decomposition as board items. */
  readonly seed?: () => Promise<readonly BoardSeedItem[]>;
  /**
   * Materialize an integrated revision's tree and return its directory, so the
   * agent's next edit reads the current shared baseline after a rebase.needed.
   */
  readonly fetchRevision?: (n: number, commit: string) => Promise<string | undefined>;
  /**
   * Materialize another agent's announced push (its repo at `commit`) and return
   * the directory, so an agent that receives a handoff starts from the previous
   * owner's latest pushed version of the item's files. The driver reads the repo
   * with operator credentials; the agent never holds another agent's token.
   */
  readonly fetchPush?: (agent: string, commit: string) => Promise<string | undefined>;
  /** The ids of the agents still running (a handoff only ever goes to one of them). */
  readonly runningAgents?: () => readonly string[];
  /**
   * Fork the REQUESTER's repo for this agent, the helper of a help request
   * that grants a sub-scope (the operator calls the help-fork route; the agent
   * never holds the bearer). Returns the fork and a short write token.
   */
  readonly forkForHelp?: (agent: string, request: string) => Promise<({ readonly ok: true; readonly forkOf: string } & JoinedWorkspace) | BoardRejection>;
  /**
   * Materialize a helper's fork of help request `request` at `commit` (read
   * with an operator read token) and return the directory, so the requester
   * can pull the helper's delivered commit into its own repo.
   */
  readonly fetchFork?: (request: string, helper: string, commit: string) => Promise<string | undefined>;
  /**
   * The ordered escalation models for fix attempts: fix attempt k on an item
   * runs on escalationModels[k - 1] (clamped to the last entry). Empty keeps
   * every attempt on the executor's own base model.
   */
  readonly escalationModels?: readonly string[];
  readonly onTurn?: (record: AgentTurnRecord) => void;
  /**
   * The operator's tool bench (the tools repo, tool gates, pinned tool runs,
   * engine-recorded uses). Without it build_tool and use_tool are refused.
   */
  readonly tools?: ToolBench;
  /** Who writes a tool's files on build_tool (default: the agent's executor). */
  readonly toolAuthor?: ToolAuthor;
  /** How many of the agent's past turns its capsule carries (default 12). */
  readonly historyLimit?: number;
  /**
   * The run's cost meter: a turn on an item past its per-item cap is refused
   * (ITEM_CAP), and a worker whose held items are all at their cap (with
   * nothing else to act on) skips its turn without calling the model.
   */
  readonly meter?: RunMeter;
  /** Called when a turn hit its item's cap (the driver records run.capped once). */
  readonly onItemCap?: (cap: RunCapReached) => void;
}

/** The action types each role may return. */
const LEAD_ACTIONS: readonly AgentActionType[] = ["decide_contract", "decide_item", "extend_claim", "replan_item", "propose_item", "message", "wait"];
const LEAD_ONLY_ACTIONS: ReadonlySet<AgentActionType> = new Set(["decide_contract", "decide_item", "extend_claim", "replan_item"]);
const WORKER_ACTIONS: readonly AgentActionType[] = AGENT_ACTION_TYPES.filter((t) => !LEAD_ONLY_ACTIONS.has(t));

/** Message types that matter to an agent only while it is free to take new work. */
const NEW_WORK_TYPES: ReadonlySet<string> = new Set(["item.proposed", "item.accepted", "item.discovered", "item.split", "help.requested", "item.struggling"]);
/** Board-wide messages that are context, never a reason by themselves to take a turn. */
const CONTEXT_ONLY_TYPES: ReadonlySet<string> = new Set([
  "goal.posted",
  "integrated.rev",
  "contract.proposed",
  "contract.accepted",
  "contract.rejected",
  "item.completed",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".wrangler"]);
const MAX_LISTED_FILES = 2000;
const MAX_EXCERPTS = 6;
const MAX_EXCERPT_CHARS = 3000;
/** Of the MAX_EXCERPTS turn excerpts, how many may be read-only reference files a held claim imports. */
const MAX_TURN_REFERENCES = 2;
const MAX_PENDING_MESSAGES = 200;
/**
 * How many times a passed push is cued for propose_done if the agent ignores
 * it. The last cue says plainly that the item cannot complete otherwise: the
 * engine never proposes done on an agent's behalf.
 */
export const MAX_DONE_CUES = 5;
/** How many times a free agent that waited is told to claim the open items. */
export const MAX_CLAIM_NUDGES = 3;
/**
 * How many times a worker that waits while holding an item it has not pushed
 * (for example reading its files while a codemod for it is built) is given
 * another turn anyway: it never stalls on held work, and never waits long.
 */
export const MAX_HELD_WAIT_CUES = 2;

/**
 * How many times a worker that answers a fix request on its item with a wait
 * (or an invalid reply) is given another turn at once, per item and failing
 * revision, with the fix stated plainly. Bounded: then the fix budget and the
 * board's other cues take over.
 */
export const MAX_FIX_CUES = 2;

/**
 * How many times an agent is woken for one set of OPEN seam items (nobody
 * holds them) when it is free or holds items that import their seams, by the
 * runtime when the set appears; and, separately, how many times the driver may
 * nudge it before a quiet board could end the run. Bounded per set.
 */
export const MAX_OPEN_SEAM_CUES = 2;
/** How many times the driver may offer one set of open items (unclaimed, or a lapsed claim) to a worker on a quiet board. */
export const MAX_OFFER_CUES = 2;
/**
 * How many distinct items a worker may spend its per-item turn budget on: it
 * releases each of the first ones and stays in the pool for other open items,
 * and stops when it exhausts this many (so it cannot cycle forever).
 */
export const MAX_EXHAUSTED_ITEMS = 3;
/**
 * How many times a sub-lead is told that children's pushes wait for its merge
 * (`pull`), per set of such pushes: when the set appears, then by the driver
 * on a quiet board. Bounded: then a quiet board may end the run, naming them.
 */
export const MAX_MERGE_CUES = 3;
/** Items the lead may propose for failing files no item covers, per run. */
export const MAX_UNCOVERED_PROPOSALS = 4;
/**
 * How many times the lead that answers PENDING CONTRACTS (not protected: the
 * lead decides them) with a wait is given another turn at once, per set of
 * pending contracts; and, separately, how many times the driver may nudge it
 * on a quiet board. Bounded: nothing ever decides a contract on its behalf;
 * a quiet board then ends the run naming each undecided contract.
 */
export const MAX_CONTRACT_CUES = 2;
/** How many turns an agent is woken for one unanswered question addressed to it (arbitration revision 6 digests list them). */
export const MAX_QUESTION_CUES = 2;
/** How many times per run the lead is cued about a failing revision that points only at shared seams no item covers. */
export const MAX_SEAM_FAILURE_CUES = 2;

/**
 * The lead's cue for the contracts waiting for its decision (protected ones
 * are a human's, never cued), sorted by id, or undefined when none waits.
 */
export function pendingContractCue(state: BoardState): { readonly key: string; readonly contracts: readonly string[]; readonly text: string } | undefined {
  const pending = Object.values(state.contracts)
    .filter((c) => c.status === "proposed" && !c.guarded)
    .sort((a, b) => (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0));
  if (pending.length === 0) {
    return undefined;
  }
  const contracts = pending.map((c) => c.contract);
  const text =
    `PENDING CONTRACT(S) TO DECIDE: ${pending
      .map((c) => `${c.contract} (${c.kind} ${c.target}${c.item !== undefined ? `, for ${c.item}` : ""}${c.triage !== undefined ? `; triage ${c.triage}` : ""})`)
      .join("; ")}: ` +
    "decide_contract now; waiting leaves that item blocked (its claim cannot lapse, its holder cannot propose another)";
  return { key: contracts.join(","), contracts, text: bounded(text, 1200) };
}
/**
 * An item whose write intent covers at least this many files starts one rung
 * above the base model (below the top rung when the ladder has two or more).
 */
export const LARGE_ITEM_FILES = 3;
/** Edits a held item defers while a shared seam change it depends on is on its way. */
export const MAX_SEAM_DEFERRALS = 3;
/** The failing gate output a fix edit hands the executor, in characters. */
const MAX_FIX_EVIDENCE = 4000;

/**
 * The HELD WORK cue the driver's nudge delivers, kind-specific per item: a
 * push that made a revision worse (push.regressed), a push left out of
 * integration (push.excluded), a failing revision that asks for a fix, or
 * (none of those) held work with no push.
 */
export function heldWorkCue(digest: BoardDigest, items: readonly string[]): string {
  const plain: string[] = [];
  const parts: string[] = [];
  for (const item of items) {
    const claim = digest.claims.find((c) => c.item === item);
    if (claim?.regressed !== undefined) {
      parts.push(`my push ${claim.regressed.commit.slice(0, 10)} for ${item} made revision ${claim.regressed.rev} worse (claims.regressed has the evidence): push a fix now or hand it off`);
    } else if (claim?.excluded !== undefined) {
      parts.push(`my push ${claim.excluded.commit.slice(0, 10)} for ${item} was left out of integration (${claim.excluded.reason.slice(0, 160)}): push a fix now or hand it off`);
    } else if (claim?.fix !== undefined) {
      parts.push(`revision ${claim.fix.n} failed and implicates ${item}: push a fix now (claims.fix) or hand it off`);
    } else {
      plain.push(item);
    }
  }
  if (plain.length > 0) {
    parts.unshift(`the board went quiet and I hold ${plain.join(", ")} with no push: edit it now (or hand it off), or the claim lapses`);
  } else {
    parts[0] = `the board went quiet and ${parts[0]}`;
  }
  return bounded(`HELD WORK: ${parts.join("; ")}`, 600);
}

/** List repo-relative files under `dir` (sorted, bounded, skipping build and VCS dirs). */
export async function listRepoFiles(dir: string, limit = MAX_LISTED_FILES): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= limit) {
      return;
    }
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= limit) {
        return;
      }
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(path);
        }
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  };
  await walk("");
  return out;
}

/**
 * Resolve intent entries to concrete repo files: an exact path is itself, a
 * glob is every listed file it matches, and a glob that matches nothing stays a
 * glob (so a new file can still be created inside it).
 */
export function resolveIntentFiles(entries: readonly string[], files: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const path = intentPath(entry);
    if (!hasWildcard(path)) {
      if (!out.includes(path)) {
        out.push(path);
      }
      continue;
    }
    const matched = files.filter((f) => matchesGlob(f, path));
    for (const f of matched.length > 0 ? matched : [path]) {
      if (!out.includes(f)) {
        out.push(f);
      }
    }
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOut(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runGit(["-C", dir, ...args]);
  return stdout;
}

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Git's empty tree (the base of a first build). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Commit exactly what is staged (never `git add -A`); returns the commit. */
async function commitStaged(dir: string, message: string, identity: GitIdentity): Promise<string> {
  await gitOut(dir, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--no-verify", "-q", "-m", message]);
  return (await gitOut(dir, ["rev-parse", "HEAD"])).trim();
}

/**
 * Every path with an uncommitted change in a worktree (modified, deleted, or
 * untracked, each untracked file listed), from Git's own status.
 */
async function worktreeChanges(dir: string): Promise<string[]> {
  const out = await gitOut(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths = new Set<string>();
  for (const entry of out.split("\0")) {
    if (entry.length > 3) {
      paths.add(entry.slice(3));
    }
  }
  return [...paths].sort();
}

/** A failing tool gate's evidence as one bounded text (the checks, then the output). */
function toolGateEvidence(gate: { readonly checks: readonly { readonly check: string; readonly passed: boolean; readonly detail: string }[]; readonly output?: string }): string {
  return bounded(
    [...gate.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`), ...(gate.output ? [gate.output] : [])].join("\n"),
    4000,
  );
}

/** The situation a re-plan cue is about: the item, who spent its budget, and its stall releases. */
function replanKey(cue: { readonly item: string; readonly exhaustedBy: readonly string[]; readonly stallReleases: number }): string {
  return `${cue.item}:${cue.exhaustedBy.length}:${cue.stallReleases}`;
}

/** The item an action is about, for the per-item turn budget. */
function actionItem(action: AgentAction, digest: BoardDigest): string | undefined {
  switch (action.type) {
    case "claim":
    case "split":
    case "edit":
    case "propose_done":
      return action.itemId;
    case "contest_reply":
      return digest.contests.find((c) => c.id === action.contestId)?.item;
    case "message":
      return action.payload.itemId;
    case "build_tool":
      return toolItemId(action.capability);
    case "use_tool":
    case "pull":
    case "offer_help":
    case "answer_volunteer":
      return action.itemId;
    default:
      return undefined;
  }
}

/** The model one pushed edit used (see BoardAgent.editModels). */
export interface BoardEditModel {
  readonly item: string;
  readonly commit: string;
  readonly model: string;
  readonly why?: string;
  /** The model that spent its completion budget first (`<model> (finish_reason: <reason>)`); the edit ran one rung down. */
  readonly budgetFallbackFrom?: string;
}

/**
 * The children's pushes waiting for `agent`'s merge as sub-lead: pushed by
 * another agent, not integrated, not in its latest push, and not recorded
 * unverified (a child it pushed itself integrates directly). Pure.
 */
export function subLeadMergesDue(digest: BoardDigest, agent: string): { readonly parent: string; readonly child: string; readonly commit: string; readonly agent: string }[] {
  return (digest.subLead ?? []).flatMap((s) =>
    s.children
      .filter((c) => c.lastPush !== undefined && c.lastPush.integratedIn === undefined && !c.merged && c.unverified !== true && c.lastPush.agent !== agent)
      .map((c) => ({ parent: s.item, child: c.item, commit: c.lastPush!.commit, agent: c.lastPush!.agent })),
  );
}

/** One agent on a board. */
export class BoardAgent {
  readonly id: string;
  readonly role: "worker" | "lead";
  private client: BoardAgentClient | undefined;
  private workspace: JoinedWorkspace | undefined;
  private remote = "";
  private worktreeDir: string | undefined;
  private lastSeen = 0;
  private pending: BoardMessage[] = [];
  private history: AgentTurnHistoryEntry[] = [];
  private evidence: string[] = [];
  private lastRejection: { code: string; error: string; action: AgentActionType } | undefined;
  private followUp = true;
  private lastFreeKey: string | undefined;
  private turns = 0;
  private readonly turnsByItem = new Map<string, number>();
  /** Items whose per-item call cap THIS agent's own call reached (it releases them, once). */
  private readonly capReachedHere = new Set<string>();
  /** Items this worker spent its per-item budget on: released, never acted on again. */
  private readonly exhaustedItems = new Set<string>();
  private stop: AgentStop | undefined;
  private seeded = false;
  private rebasedTo = 0;
  private baseDir: string;
  private counter = 0;
  private edits = 0;
  /** Help/question requests seen: request id -> {seq, by}. */
  private readonly requests = new Map<string, { readonly seq: number; readonly by: string }>();
  /** Items handed to this agent: the previous owner's latest push to start from. */
  private readonly inherited = new Map<string, { readonly from: string; readonly commit: string; seeded: boolean }>();
  /** Done cues delivered per set of passed pushes (see observeAndAct). */
  private readonly doneCues = new Map<string, number>();
  /** True while a step is running (observing or acting). */
  private stepping = false;
  /** True only while the agent is taking a TURN (the driver's quiescence check reads it). */
  private acting = false;
  /** True while the driver holds the agent back (no step; see run's `hold`). */
  private heldBack = false;
  /** The tools this agent's claims may not wait for, as last seen (a change wakes it). */
  private lastUnavailable = "";
  /** The formation cues last seen (a new set wakes it once). */
  private lastCue = "";
  /** Nudges to claim open work after waiting while free, per set of open items (bounded). */
  private readonly claimNudges = new Map<string, number>();
  /** Edits (and codemod runs) on an item that were refused or failed, per item. */
  private readonly failedEdits = new Map<string, number>();
  /** Struggling reports already posted, per `<item>:<reason>[:<rev>]`. */
  private readonly struggleReported = new Set<string>();
  /** Items whose edit waited for a shared seam change (they rebase before editing). */
  private readonly seamWaited = new Set<string>();
  /** Edits deferred per item for a seam change (bounded by MAX_SEAM_DEFERRALS). */
  private readonly seamDeferrals = new Map<string, number>();
  /**
   * The model each pushed edit used (and why a complex item got a stronger
   * one); `budgetFallbackFrom` names the model whose spent completion budget
   * sent the edit one rung down, and why it stopped.
   */
  readonly editModels: BoardEditModel[] = [];
  /** Lead: items proposed for failures no item covered, and the revisions already examined. */
  private uncoveredProposals = 0;
  private readonly uncoveredSeen = new Set<number>();
  /** Waits taken while holding unpushed work, per held item set (bounded re-cues). */
  private readonly heldWaitCues = new Map<string, number>();
  /** Waits (or invalid replies) while holding work with nothing to wait for, per held item set (bounded by MAX_HELD_WAIT_CUES). */
  private readonly idleHeldCues = new Map<string, number>();
  /** The driver's held-work nudges per item (bounded by MAX_HELD_WAIT_CUES). */
  private readonly heldWorkNudges = new Map<string, number>();
  /** Set by the driver: held items to edit (or hand off) on the next step. */
  private readonly heldWorkNudge = new Set<string>();
  /** Sub-lead: merge cues per set of children's pushes awaiting its pull (bounded by MAX_MERGE_CUES). */
  private readonly mergeCues = new Map<string, number>();
  /** Sub-lead: the children's pushes awaiting its pull as last seen ("" when none). */
  private lastMergeKey = "";
  /** Set by the driver: re-deliver the merge cue on the next step. */
  private mergeNudge = false;
  /** Re-cues after a wait while a fix request is open, per `item@revision` (bounded by MAX_FIX_CUES). */
  private readonly fixCues = new Map<string, number>();
  private lastOpenSeamKey = "";
  /** The driver's nudges per set of open seam items (bounded by MAX_OPEN_SEAM_CUES). */
  private readonly driverSeamNudges = new Map<string, number>();
  /** Wakes for one set of open seam items (bounded by MAX_OPEN_SEAM_CUES). */
  private readonly openSeamCues = new Map<string, number>();
  /** Set by the driver: take a turn on the next step to look at open seam items. */
  private openSeamNudge = false;
  /** The driver's offers per set of open items nobody holds (bounded by MAX_OFFER_CUES). */
  private readonly offerNudges = new Map<string, number>();
  /** Set by the driver: open items nobody holds were offered; look at them on the next step. */
  private offerNudge = false;
  /** Lead: re-cues after a wait while contracts wait for its decision, per set of contracts (bounded by MAX_CONTRACT_CUES). */
  private readonly contractCues = new Map<string, number>();
  /** Lead: the driver's nudges per set of pending contracts (bounded by MAX_CONTRACT_CUES). */
  private readonly driverContractNudges = new Map<string, number>();
  /** Set by the driver: the lead takes a turn on the next step to decide the pending contracts. */
  private contractNudge = false;
  /** Turns an unanswered question addressed to this agent woke it, per request (bounded by MAX_QUESTION_CUES). */
  private readonly questionCues = new Map<string, number>();
  /** Lead: cues for failing revisions that point only at shared seams no item covers (bounded by MAX_SEAM_FAILURE_CUES). */
  private seamFailureCues = 0;
  /** Whether the agent was free (could claim) at its latest observation. */
  private freeSeen = false;
  /** Lead: the undecided worker proposals it last saw (a change wakes it). */
  private lastProposals = "";
  /** Lead: the claims near their deadline it last saw (a change wakes it). */
  private lastDeadlines = "";
  /**
   * Lead: re-plan cues it has had, per item and situation (`<item>:<agents
   * that spent its budget>:<stall releases>`): one bounded re-plan turn each
   * time the board finds the item not getting done again.
   */
  private readonly replanCued = new Set<string>();
  /** Lead: the re-plan cues of the turn being taken (the action carries their reason and revision). */
  private replanCues: NonNullable<BoardDigest["replan"]> = [];
  /** Items (and tool items) this agent proposed: their decision wakes it. */
  private readonly proposedItems = new Set<string>();
  /** Capabilities this agent built: a passing revision is its cue to re-run its scanner. */
  private readonly builtTools = new Set<string>();
  /** The latest failing gate evidence of each tool this agent builds (fed to a rebuild). */
  private readonly toolGateFailures = new Map<string, string>();
  /** Forks this agent made as a helper: help request -> its fork's worktree and remote. */
  private readonly forks = new Map<string, { readonly workspace: JoinedWorkspace; readonly remote: string; readonly dir: string; readonly requester: string }>();
  /** Tokens replaced by a refresh (still scrubbed from any text that leaves the agent). */
  private readonly retiredTokens: string[] = [];

  constructor(private readonly options: BoardAgentOptions) {
    this.id = options.id;
    this.role = options.role;
    this.baseDir = options.projectDir;
  }

  /** Why the agent stopped, if it did. */
  get stopped(): AgentStop | undefined {
    return this.stop;
  }

  /**
   * True only while the agent is taking a turn. Observing (reading its digest
   * while idle) is not activity: counting it kept a board where every agent
   * waits from ever looking quiet, because idle agents poll.
   */
  get busy(): boolean {
    return this.acting;
  }

  /**
   * True when the agent's next step will take a turn on its own (a follow-up
   * it was given, or a driver nudge not yet delivered). The driver never
   * judges a held claim stalled while its holder is about to act.
   */
  get turnPending(): boolean {
    return !this.stop && !this.heldBack && (this.followUp || this.heldWorkNudge.size > 0 || this.mergeNudge || this.offerNudge || this.openSeamNudge || this.contractNudge);
  }

  /** The agent's workspace (its own repo), once joined. */
  get joinedWorkspace(): JoinedWorkspace | undefined {
    return this.workspace;
  }

  /** The authenticated push/clone remote of the agent's repo ("" before joining). */
  get repoRemote(): string {
    return this.remote;
  }

  /**
   * The repo tokens this agent writes with (its own repo, and each fork it took
   * as a helper), each with a swap that puts a refreshed token into every later
   * git call (see TokenRefresher).
   */
  refreshableTokens(): RefreshableToken[] {
    const out: RefreshableToken[] = [];
    if (this.workspace) {
      const ws = this.workspace;
      out.push({
        agent: this.id,
        kind: "repo-write",
        tokenId: ws.tokenId,
        expiresAt: ws.tokenExpiresAt,
        swap: (fresh) => {
          this.retiredTokens.push(ws.token);
          this.workspace = { ...ws, token: fresh.token, tokenId: fresh.tokenId, tokenExpiresAt: fresh.tokenExpiresAt };
          this.remote = authenticatedRemote(ws.gitUrl, fresh.token);
        },
      });
    }
    for (const [request, fork] of this.forks) {
      out.push({
        agent: this.id,
        kind: "help-fork",
        request,
        tokenId: fork.workspace.tokenId,
        expiresAt: fork.workspace.tokenExpiresAt,
        swap: (fresh) => {
          this.retiredTokens.push(fork.workspace.token);
          const workspace = { ...fork.workspace, token: fresh.token, tokenId: fresh.tokenId, tokenExpiresAt: fresh.tokenExpiresAt };
          this.forks.set(request, { ...fork, workspace, remote: authenticatedRemote(workspace.gitUrl, fresh.token) });
        },
      });
    }
    return out;
  }

  /** Stop the agent (the run is over). */
  halt(detail = "run finished"): void {
    this.stop ??= { reason: "stopped", detail };
  }

  /**
   * Join the board. A worker's join also provisions its own repo with the
   * explicit short token TTL; the lead does not edit, so it joins without one.
   */
  async join(rationale?: string): Promise<void> {
    const joined = await this.options.join(this.id, {
      ...(this.role === "lead" ? { role: LEAD_ROLE } : { role: "worker" }),
      ...(rationale !== undefined ? { rationale } : {}),
      ...(this.role === "worker" ? { workspaceTtlSeconds: this.options.workspaceTtlSeconds } : {}),
    });
    if (!joined.ok) {
      throw new Error(`${this.id} could not join the board (${joined.code}): ${joined.error}`);
    }
    if (this.role === "worker" && !joined.workspace) {
      throw new Error(`${this.id} joined without a workspace; the join route did not provision one`);
    }
    this.client = new BoardAgentClient(this.options.fetchFn, this.options.baseUrl, this.options.changeId, this.id, joined.token);
    if (joined.workspace) {
      this.workspace = joined.workspace;
      this.remote = authenticatedRemote(joined.workspace.gitUrl, joined.workspace.token);
    }
    this.lastSeen = joined.appended.at(-1)?.seq ?? 0;
  }

  /** Post `agent.left` (only valid once the agent holds nothing). */
  async leave(rationale: string): Promise<BoardPostOutcome> {
    return this.requireClient().post({ type: "agent.left", rationale });
  }

  private requireClient(): BoardAgentClient {
    if (!this.client) {
      throw new Error(`${this.id} has not joined the board`);
    }
    return this.client;
  }

  /** Observe once and take at most one turn. */
  async step(): Promise<AgentStepResult> {
    if (this.stop) {
      return "stopped";
    }
    this.stepping = true;
    try {
      return await this.observeAndAct();
    } finally {
      this.stepping = false;
    }
  }

  private async observeAndAct(): Promise<AgentStepResult> {
    const client = this.requireClient();
    let digest: BoardDigest | undefined;
    let after = this.lastSeen;
    const fresh: BoardMessage[] = [];
    for (;;) {
      const page = await client.digest(after);
      digest = page.digest;
      fresh.push(...page.digest.messages);
      // Page by the last seq the page covered: the digest's messages are
      // filtered, and the reduced state may already be ahead of the page.
      const end = page.digest.pageEnd ?? after;
      if (!page.hasMore || end <= after) {
        after = Math.max(after, end);
        break;
      }
      after = end;
    }
    this.lastSeen = after;
    this.pending.push(...fresh);
    if (this.pending.length > MAX_PENDING_MESSAGES) {
      this.pending = this.pending.slice(-MAX_PENDING_MESSAGES);
    }
    for (const m of fresh) {
      if (m.type === "help.requested") {
        this.requests.set(m.payload.request, { seq: m.seq, by: m.from });
      }
      // Any failed tool gate (a reopened tool's next builder needs the evidence too).
      if (m.type === "tool.gated" && !m.payload.passed) {
        this.toolGateFailures.set(m.payload.capability, toolGateEvidence(m.payload));
      }
      if (m.type === "handoff" && m.payload.to === this.id && m.payload.capsule.commit !== undefined) {
        this.inherited.set(m.payload.item, { from: m.from, commit: m.payload.capsule.commit, seeded: false });
      }
      // A reopened item (its owner spent the fix budget): whoever claims it
      // next starts from the previous owner's latest push.
      if (m.type === "item.reopened" && m.payload.previousOwner !== this.id && m.payload.commit !== undefined) {
        this.inherited.set(m.payload.item, { from: m.payload.previousOwner, commit: m.payload.commit, seeded: false });
      }
      // A lapsed claim: whoever claims it next starts from the holder's latest push.
      if (m.type === "claim.lapsed" && m.payload.agent !== this.id && m.payload.commit !== undefined) {
        this.inherited.set(m.payload.item, { from: m.payload.agent, commit: m.payload.commit, seeded: false });
      }
      if (m.type === "claim.lapsed" && m.payload.agent === this.id) {
        this.evidence.push(
          `my claim on ${m.payload.item} LAPSED (${m.payload.reason === "deadline" ? "its deadline passed" : `no progress on it since board seq ${m.payload.lastProgressSeq}`}): it is open for any agent now; claim it again only if I can move it now`,
        );
      }
    }

    if (this.role === "lead") {
      if (!this.seeded) {
        await this.seedTurn();
        return "acted";
      }
      let state = await client.state();
      // A failing revision that points at files no item covers is work the plan
      // missed: the lead proposes it (bounded), recorded with the evidence.
      const lastFailing = fresh.filter((m) => m.type === "integrated.rev" && m.payload.gate === "fail" && m.payload.failing !== undefined).at(-1);
      if (lastFailing && lastFailing.type === "integrated.rev" && (await this.proposeUncovered(lastFailing, state))) {
        state = await client.state();
      }
      const undecided = Object.values(state.contracts).some((c) => c.status === "proposed");
      const addressed = fresh.some((m) => m.to?.includes(this.id));
      // Workers' proposals wait for the lead: a new undecided set is a reason to take a turn.
      const proposals = Object.values(state.items)
        .filter((i) => i.status === "proposed")
        .map((i) => i.id)
        .join(",");
      const newProposals = proposals !== "" && proposals !== this.lastProposals;
      this.lastProposals = proposals;
      // Claims near their firm deadline: the lead extends a progressing one or lets it lapse.
      const deadlines = (digest.deadlines ?? []).map((d) => `${d.item}@${d.deadlineSeq}`).join(",");
      const newDeadlines = deadlines !== "" && deadlines !== this.lastDeadlines;
      this.lastDeadlines = deadlines;
      // Items to re-plan the lead has not had a turn on yet: one bounded turn each.
      const newReplans = (digest.replan ?? []).some((r) => !this.replanCued.has(replanKey(r)));
      // The driver's nudge on a quiet board while contracts wait for the lead (bounded per set).
      const contractCue = this.contractNudge ? pendingContractCue(state) : undefined;
      this.contractNudge = false;
      if (contractCue) {
        this.evidence.push(contractCue.text);
      }
      if (!(this.followUp || addressed || newProposals || newDeadlines || newReplans || contractCue || (undecided && fresh.some((m) => m.type === "contract.proposed")))) {
        return "idle";
      }
      await this.turn(digest, state);
      return "acted";
    }

    // A passing revision merged this agent's push for an item it has not yet
    // proposed done: that is its cue to propose it (an integrated.rev is
    // otherwise context only), once per revision.
    const passed = digest.claims.filter(
      (c) => !c.doneProposed && c.lastPush !== undefined && c.lastPush.agent === this.id && c.lastPush.integratedIn !== undefined && c.fix === undefined,
    );
    const passedKey = passed.map((c) => `${c.item}@${c.lastPush!.integratedIn}`).join(",");
    // Cue each passed push up to MAX_DONE_CUES times: if the agent ignores the
    // cue (it waits instead of proposing done), it is cued again at its next
    // opportunity, so an item does not stall until a budget runs out.
    const cues = this.doneCues.get(passedKey) ?? 0;
    const nudged = passedKey !== "" && cues < MAX_DONE_CUES;
    const free = this.isFree(digest);
    this.freeSeen = free;
    const freeKey = free && digest.openItems.length > 0 ? digest.openItems.map((i) => i.item).join(",") : undefined;
    const relevant = fresh.some((m) => {
      if (m.to?.includes(this.id)) {
        return true;
      }
      // The lead's decision on something this agent proposed (an item or a tool).
      if ((m.type === "item.accepted" || m.type === "item.rejected") && this.proposedItems.has(m.payload.item)) {
        return true;
      }
      // A passing revision is new code a tool this agent built may have something to say about.
      if (m.type === "integrated.rev" && m.payload.gate === "pass" && this.builtTools.size > 0) {
        return true;
      }
      // A passing revision may be the seam change a held item waits for.
      if (m.type === "integrated.rev" && m.payload.gate === "pass" && digest.claims.some((c) => this.seamWaited.has(c.item))) {
        return true;
      }
      // The decision on a contract change this agent proposed.
      if ((m.type === "contract.accepted" || m.type === "contract.rejected") && m.payload.contract.startsWith(`${this.id}-contract-`)) {
        return true;
      }
      if (NEW_WORK_TYPES.has(m.type)) {
        return free;
      }
      return !CONTEXT_ONLY_TYPES.has(m.type);
    });
    // A tool this agent's claims were waiting for became unavailable: it must
    // edit by hand now, so that is a reason to take a turn.
    const unavailableKey = digest.claims
      .flatMap((c) => (c.toolUnavailable ?? []).map((t) => `${c.item}:${t.capability}`))
      .join(",");
    const newlyUnavailable = unavailableKey !== "" && unavailableKey !== this.lastUnavailable;
    this.lastUnavailable = unavailableKey;
    // Formation cues wake the agent once per distinct cue set (never a storm):
    // owners going badly while it is idle, volunteers waiting for its answer,
    // or its own struggling item while agents are idle.
    const cueKey = [
      ...(digest.busyOwners ?? []).map((b) => `busy:${b.item}:${b.agent}`),
      ...(digest.volunteers ?? []).map((v) => `volunteer:${v.item}:${v.agent}:${v.seq}`),
      ...((digest.idleAgents ?? []).length > 0 ? (digest.struggling ?? []).map((s) => `struggling:${s.item}:${s.reason}`) : []),
    ].join(",");
    const newCue = cueKey !== "" && cueKey !== this.lastCue;
    this.lastCue = cueKey;
    // A free agent whose last turn was a wait while open items exist is told,
    // a bounded number of times, to claim one: nothing on the board waits for
    // a tool (a model that waits "for the tool" left every item unclaimed).
    const lastTurn = this.history.at(-1);
    const nudgeKey = free && digest.openItems.length > 0 && lastTurn?.action.type === "wait" ? digest.openItems.map((i) => i.item).join(",") : "";
    const claimNudge = nudgeKey !== "" && (this.claimNudges.get(nudgeKey) ?? 0) < MAX_CLAIM_NUDGES;
    if (claimNudge && !this.followUp && !relevant && !nudged) {
      const count = (this.claimNudges.get(nudgeKey) ?? 0) + 1;
      this.claimNudges.set(nudgeKey, count);
      this.evidence.push(
        `I owe no work on what I hold (nothing, done, or waiting on others) and ${digest.openItems.length} open item(s) can be claimed: claim one now. Tools are accelerators, never prerequisites: when a tool is published use_tool it, otherwise edit by hand; never wait for a tool.`,
      );
    }
    // OPEN seam items (nobody holds them): wake an agent that is free or holds
    // items importing their seams, once per set (bounded), and tell it plainly
    // that it may claim one itself. The driver may nudge it once more before a
    // quiet board ends the run.
    // Free, blocked on it, or holding no change item in progress (only tool items, or all proposed done).
    const seamState = this.role === "worker" && (digest.openSeams ?? []).length > 0 ? await client.state() : undefined;
    const noChangeWork = digest.claims.every((c) => seamState?.items[c.item]?.tool !== undefined || (c.doneProposed && c.fix === undefined));
    const openSeams = this.role === "worker" ? (digest.openSeams ?? []).filter((o) => free || noChangeWork || o.blocks.length > 0) : [];
    const openSeamKey = openSeams.map((o) => o.item).join(",");
    const openSeamCue =
      openSeamKey !== "" && (this.openSeamNudge || (openSeamKey !== this.lastOpenSeamKey && (this.openSeamCues.get(openSeamKey) ?? 0) < MAX_OPEN_SEAM_CUES));
    this.lastOpenSeamKey = openSeamKey;
    this.openSeamNudge = false;
    if (openSeamCue) {
      this.openSeamCues.set(openSeamKey, (this.openSeamCues.get(openSeamKey) ?? 0) + 1);
      this.evidence.push(`OPEN SEAM ITEM: ${openSeams.map((o) => o.hint).join(" ")}`.slice(0, 1000));
    }
    // The driver offered open items nobody holds (a quiet board): a free worker
    // looks at them, with each item's stated reason.
    const offers = this.role === "worker" && this.offerNudge && free
      ? digest.openItems.filter((i) => i.wait?.reason.kind === "unclaimed" || i.wait?.reason.kind === "lease-lapsed")
      : [];
    this.offerNudge = false;
    const offerCue = offers.length > 0;
    if (offerCue) {
      this.evidence.push(`OPEN ITEMS nobody holds: ${offers.map((i) => `${i.item} (${i.wait!.line})`).join("; ")}. Claim one now if you can move it.`.slice(0, 1000));
    }
    // The driver found held work of this agent's not moving on a quiet board:
    // it edits it now (or hands it off) before the claim could lapse.
    const heldNudged = [...this.heldWorkNudge].filter((item) => digest.claims.some((c) => c.item === item));
    this.heldWorkNudge.clear();
    const heldCue = heldNudged.length > 0;
    if (heldCue) {
      this.evidence.push(heldWorkCue(digest, heldNudged));
    }
    // SUB-LEAD: children's pushes (by other agents) wait for this agent to
    // merge them; nothing integrates them until it pulls. Cued when the set
    // appears and when the driver nudges, bounded per set.
    const mergeDue = this.role === "worker" ? subLeadMergesDue(digest, this.id) : [];
    const mergeKey = mergeDue.map((m) => `${m.parent}:${m.child}@${m.commit}`).join(",");
    const mergeCue =
      mergeKey !== "" && (this.mergeNudge || mergeKey !== this.lastMergeKey) && (this.mergeCues.get(mergeKey) ?? 0) < MAX_MERGE_CUES;
    this.lastMergeKey = mergeKey;
    this.mergeNudge = false;
    if (mergeCue) {
      this.mergeCues.set(mergeKey, (this.mergeCues.get(mergeKey) ?? 0) + 1);
      const parents = [...new Set(mergeDue.map((m) => m.parent))];
      this.evidence.push(
        bounded(
          `SUB-LEAD MERGE DUE: ${parents
            .map((p) => `pull {itemId: ${p}} merges ${mergeDue.filter((m) => m.parent === p).map((m) => `${m.child}@${m.commit.slice(0, 10)} (pushed by ${m.agent})`).join(", ")}`)
            .join("; ")}. Their pushes integrate only through my merge: pull now.`,
          800,
        ),
      );
    }
    // QUESTIONS addressed to this agent and not answered yet (arbitration
    // revision 6 digests list them): a bounded number of turns per question,
    // so a question to it never becomes a dead route.
    const questions = (digest.questions ?? []).filter((q) => (this.questionCues.get(q.request) ?? 0) < MAX_QUESTION_CUES);
    const questionCue = questions.length > 0;
    if (questionCue) {
      for (const q of questions) {
        this.questionCues.set(q.request, (this.questionCues.get(q.request) ?? 0) + 1);
      }
      this.evidence.push(bounded(`QUESTION FOR ME: ${questions.map((q) => q.hint).join(" ")}`, 1000));
    }
    if (
      !(
        this.followUp ||
        relevant ||
        nudged ||
        newlyUnavailable ||
        newCue ||
        claimNudge ||
        openSeamCue ||
        offerCue ||
        heldCue ||
        mergeCue ||
        questionCue ||
        (freeKey !== undefined && freeKey !== this.lastFreeKey)
      )
    ) {
      return "idle";
    }
    // A cue counts as delivered only on a turn it caused by itself (not a
    // follow-up, not a relevant message, not new open work), so a turn the
    // agent was taking anyway does not use one up.
    if (nudged && !this.followUp && !relevant && !(freeKey !== undefined && freeKey !== this.lastFreeKey)) {
      this.doneCues.set(passedKey, cues + 1);
    }
    if (nudged) {
      const which = passed.map((c) => `${c.item} (rev ${c.lastPush!.integratedIn})`).join(", ");
      this.evidence.push(
        cues + 1 >= MAX_DONE_CUES
          ? `FINAL CUE: a passing revision merged my push for ${which}. The item cannot complete unless I return propose_done for it now; nobody proposes done on my behalf, and without it the run ends partial.`
          : `a passing revision merged my push for ${which}: propose done`,
      );
    }
    if (free) {
      this.lastFreeKey = freeKey;
    }
    await this.turn(digest, await client.state());
    return "acted";
  }

  /**
   * Lead: the items the board would let it re-plan that it has not had its
   * one re-plan turn on yet (the driver keeps the run going until it has).
   */
  replanPending(state: BoardState): string[] {
    if (this.role !== "lead" || this.stop) {
      return [];
    }
    return Object.values(state.items)
      .filter((i) => replanEligible(state, i.id) !== undefined && !this.replanCued.has(replanKey({ item: i.id, exhaustedBy: i.exhaustedBy ?? [], stallReleases: i.stallReleases ?? 0 })))
      .map((i) => i.id)
      .sort();
  }

  /**
   * The driver's nudge before a quiet board would end the run while seam items
   * are open: this agent's next step takes a turn to look at them (still
   * bounded by MAX_OPEN_SEAM_CUES per open set). Returns false when it has no
   * cue left for the current set.
   */
  nudgeOpenSeams(openItems: readonly string[]): boolean {
    const key = openItems.join(",");
    if (this.role !== "worker" || this.stop || (this.driverSeamNudges.get(key) ?? 0) >= MAX_OPEN_SEAM_CUES) {
      return false;
    }
    this.driverSeamNudges.set(key, (this.driverSeamNudges.get(key) ?? 0) + 1);
    this.openSeamNudge = true;
    return true;
  }

  /**
   * The driver's NUDGE on a quiet board, before a held claim its holder must
   * act on (no stated wait reason, or a push that made a revision worse or was
   * left out) could lapse: this agent's next step takes a turn told to act on
   * `item` now (or hand it off). Bounded by MAX_HELD_WAIT_CUES per item;
   * returns false when it has no nudge left (the driver may then lapse it).
   */
  nudgeHeldWork(item: string): boolean {
    const count = this.heldWorkNudges.get(item) ?? 0;
    if (this.role !== "worker" || this.stop || count >= MAX_HELD_WAIT_CUES) {
      return false;
    }
    this.heldWorkNudges.set(item, count + 1);
    this.heldWorkNudge.add(item);
    return true;
  }

  /**
   * The driver's NUDGE on a quiet board while children's pushes wait for this
   * sub-lead's merge: its next step re-delivers the merge cue (bounded by
   * MAX_MERGE_CUES per set). Returns false when it leads no such merge or has
   * no cue left.
   */
  nudgeSubLeadMerge(): boolean {
    if (this.role !== "worker" || this.stop || this.lastMergeKey === "" || (this.mergeCues.get(this.lastMergeKey) ?? 0) >= MAX_MERGE_CUES) {
      return false;
    }
    this.mergeNudge = true;
    return true;
  }

  /**
   * The driver's NUDGE on a quiet board while contracts wait for the lead's
   * decision and block held items: the lead's next step takes a turn told to
   * decide them (bounded by MAX_CONTRACT_CUES per set of contracts). Nothing
   * decides a contract for it. Returns false when it is not the lead or has no
   * nudge left for the set.
   */
  nudgeContracts(contracts: readonly string[]): boolean {
    const key = [...contracts].sort().join(",");
    const count = this.driverContractNudges.get(key) ?? 0;
    if (this.role !== "lead" || this.stop || key === "" || count >= MAX_CONTRACT_CUES) {
      return false;
    }
    this.driverContractNudges.set(key, count + 1);
    this.contractNudge = true;
    return true;
  }

  /**
   * The driver's OFFER on a quiet board: open items nobody holds (unclaimed,
   * or a claim that lapsed) are waiting; a free worker takes a turn on its
   * next step to claim one (bounded by MAX_OFFER_CUES per set of items).
   * Returns false when it has no offer left for the set.
   */
  offerOpenItems(items: readonly string[]): boolean {
    const key = items.join(",");
    // Only a worker that was free when it last looked can take one (an offer to a busy one changes nothing).
    if (this.role !== "worker" || this.stop || !this.freeSeen || (this.offerNudges.get(key) ?? 0) >= MAX_OFFER_CUES) {
      return false;
    }
    this.offerNudges.set(key, (this.offerNudges.get(key) ?? 0) + 1);
    this.offerNudge = true;
    return true;
  }

  /**
   * Keep stepping until halted, sleeping with backoff while idle (the live,
   * concurrent schedule). A thrown step stops the agent with the reason.
   */
  async run(options: {
    readonly signal: AbortSignal;
    readonly minPollMs?: number;
    readonly maxPollMs?: number;
    /** The driver holds the agent back (no step) while this is true; the driver bounds it. */
    readonly hold?: () => boolean | Promise<boolean>;
  }): Promise<void> {
    const min = options.minPollMs ?? 250;
    const max = options.maxPollMs ?? 4000;
    let wait = min;
    while (!options.signal.aborted && !this.stop) {
      let result: AgentStepResult;
      try {
        this.heldBack = (await options.hold?.()) === true;
        result = this.heldBack ? "idle" : await this.step();
      } catch (error) {
        this.stop = { reason: "stopped", detail: `step failed: ${this.scrub(error instanceof Error ? error.message : String(error))}` };
        return;
      }
      if (result === "stopped") {
        return;
      }
      wait = result === "acted" ? min : Math.min(max, wait * 2);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * Free: every claim it holds has a done proposal and no fix request, or is
   * waiting on others (its push was gated and not implicated, so it owes no
   * work until another revision), no claim is pending, it is under its claim
   * cap, and it holds no help grant it has not delivered yet.
   */
  private isFree(digest: BoardDigest): boolean {
    return (
      digest.claimCap === undefined &&
      digest.pending.length === 0 &&
      digest.claims.every((c) => (c.doneProposed && c.fix === undefined) || c.wait?.reason.kind === "waiting-on-others") &&
      !(digest.help?.granted ?? []).some((g) => g.live && g.delivered === undefined)
    );
  }

  private record(entry: Omit<AgentTurnRecord, "agent">, history?: AgentTurnHistoryEntry): void {
    this.options.onTurn?.({ agent: this.id, ...entry });
    if ((entry.action.type === "edit" || entry.action.type === "use_tool") && entry.outcome !== "posted" && entry.code !== undefined) {
      const item = entry.action.itemId;
      if (item !== undefined) {
        this.failedEdits.set(item, (this.failedEdits.get(item) ?? 0) + 1);
      }
    }
    if (history) {
      this.history.push(history);
      const limit = this.options.historyLimit ?? 12;
      if (this.history.length > limit) {
        this.history = this.history.slice(-limit);
      }
    }
  }

  /**
   * The lead turns a failing revision's evidence into work when it points at
   * repo files no item covers (an error location, or a failing test title
   * naming a module): one item per revision, at most MAX_UNCOVERED_PROPOSALS
   * per run, scoped to those files, with the failing line in its rationale.
   * Goal-agnostic: files come from the gate's own output and the repo listing.
   */
  private async proposeUncovered(message: Extract<BoardMessage, { type: "integrated.rev" }>, state: BoardState): Promise<boolean> {
    if (this.uncoveredProposals >= MAX_UNCOVERED_PROPOSALS || this.uncoveredSeen.has(message.payload.n)) {
      return false;
    }
    this.uncoveredSeen.add(message.payload.n);
    const output = message.payload.failing!.output;
    const pointed = failingRepoFiles(output, await listRepoFiles(this.baseDir));
    const files = uncoveredFailureFiles(state, pointed).slice(0, 16);
    if (files.length === 0) {
      // Only shared seams were left: they change through a seam contract (the
      // implicated owner's cue), never as uncovered work. Recorded, not proposed.
      // Nobody would be asked at all (the integrator implicated no item for
      // it): the lead is cued, bounded, to give the seam an owner (an item
      // scoped to it), with the failing line. Recorded, never auto-proposed.
      const seams = pointed.filter((f) => (state.seams ?? []).some((seam) => seam.path === f));
      const uncoveredSeams = seams.filter((f) => uncoveredFailureFiles({ ...state, seams: [] }, [f]).length > 0);
      if (uncoveredSeams.length > 0 && this.seamFailureCues < MAX_SEAM_FAILURE_CUES) {
        this.seamFailureCues += 1;
        const line = this.scrub(gateFailureLine(output) ?? "the gate failed");
        this.followUp = true;
        this.evidence.push(
          bounded(
            `SEAM FAILURE NOBODY OWNS: revision ${message.payload.n} failed (${line}) and points only at the shared seam(s) ${uncoveredSeams.join(", ")}, which no item covers, so no agent was asked to fix it. ` +
              `Unless an item in board.items already covers that failure, propose_item {scopeHint: [${uncoveredSeams[0]}], objective: fix exactly that failure in ${uncoveredSeams[0]}, keeping it compatible for the files that import it} so an agent takes it (an item covering a seam goes first)`,
            1000,
          ),
        );
        this.record({
          turn: this.turns,
          action: {
            type: "wait",
            reason: bounded(
              `revision ${message.payload.n} points only at the shared seam(s) ${uncoveredSeams.join(", ")} outside every item: cued to give it an owner (an item scoped to it), with the failing line`,
              500,
            ),
          },
          outcome: "local",
        });
      }
      return false;
    }
    this.uncoveredProposals += 1;
    const line = gateFailureLine(output) ?? "the gate failed";
    const action: AgentAction = {
      type: "propose_item",
      objective: bounded(`Fix what failing revision ${message.payload.n} reports in ${files.join(", ")}: no planned item covers these files`, 500),
      acceptance: ["the change gate passes on an integrated revision that merges this item's push"],
      scopeHint: files,
    };
    const outcome = await this.requireClient().post({
      type: "item.proposed",
      payload: { item: this.nextId("uncovered"), objective: action.objective, acceptance: action.acceptance, scopeHint: files },
      rationale: bounded(`revision ${message.payload.n} failed (${this.scrub(line)}) in files no item covers: ${files.join(", ")}`, 600),
    });
    this.record(
      outcome.ok
        ? { turn: this.turns, action, outcome: "seeded", seqs: outcome.appended.map((m) => m.seq) }
        : { turn: this.turns, action, outcome: "rejected", code: outcome.code, error: outcome.error },
    );
    return outcome.ok;
  }

  /** The lead's first turn: the planner's decomposition becomes proposed items. */
  private async seedTurn(): Promise<void> {
    if (!this.options.seed) {
      throw new Error(`${this.id} is the lead but has no planner seed`);
    }
    this.seeded = true;
    this.turns += 1;
    this.options.runBudget.used += 1;
    const planned = await this.options.seed();
    const client = this.requireClient();
    // The structural rule is the lead's trigger when it seeds: planned items
    // that repeat one mechanical change across several files get a scanner
    // and a codemod, proposed by the lead (open at once), and the items the
    // codemod covers say so. Goal-agnostic: ids, scopes, and the file listing.
    const need = this.options.tools
      ? detectBoardToolNeed(
          planned.map((i) => ({ item: i.item, scopeHint: i.scopeHint, status: "open", objective: i.objective })),
          await listRepoFiles(this.baseDir),
          { protected: (await client.state()).protected },
        )
      : undefined;
    const items = planned.map((item) =>
      need && need.items.includes(item.item)
        ? {
            ...item,
            objective: bounded(
              `${item.objective} (claim this item now; if the codemod ${need.codemod} is published, run it with use_tool after the scanner ${need.scanner}, otherwise edit by hand; never wait for a tool)`,
              500,
            ),
          }
        : item,
    );
    for (const item of items) {
      const action: AgentAction = {
        type: "propose_item",
        objective: item.objective,
        acceptance: item.acceptance,
        scopeHint: item.scopeHint,
      };
      const outcome = await client.post({
        type: "item.proposed",
        payload: { item: item.item, objective: item.objective, acceptance: item.acceptance, scopeHint: item.scopeHint },
        rationale: "seeded from the planner's decomposition of the goal",
      });
      if (outcome.ok) {
        this.record({ turn: this.turns, action, outcome: "seeded", seqs: outcome.appended.map((m) => m.seq) });
      } else {
        this.record({ turn: this.turns, action, outcome: "rejected", code: outcome.code, error: outcome.error });
      }
    }
    if (need) {
      const why = `${need.items.length} planned items (${need.items.join(", ")}) repeat the same "${need.editKind}" change across ${need.files.length} files`;
      const tools: Extract<AgentAction, { type: "propose_tool" }>[] = [
        { type: "propose_tool", capability: need.scanner, kind: "scanner", why: `${why}: a scanner finds every place in the repository that needs it, including any the plan missed`, inputs: [], outputs: ["findings"] },
        { type: "propose_tool", capability: need.codemod, kind: "codemod", why: `${why}: one codemod applies it the same way everywhere instead of hand edits`, inputs: [...need.scope], outputs: ["edits"] },
      ];
      for (const action of tools) {
        const outcome = await client.post({
          type: "tool.proposed",
          payload: { tool: this.nextId("tool"), capability: action.capability, kind: action.kind, inputs: action.inputs, outputs: action.outputs },
          rationale: action.why,
        });
        this.record(
          outcome.ok
            ? { turn: this.turns, action, outcome: "seeded", seqs: outcome.appended.map((m) => m.seq) }
            : { turn: this.turns, action, outcome: "rejected", code: outcome.code, error: outcome.error },
        );
      }
    }
    this.followUp = false;
  }

  /** Build the turn input, ask the transport, and act on the one action it returns. */
  private async turn(digest: BoardDigest, state: BoardState): Promise<void> {
    const budget = this.options.runBudget;
    if (budget.exhausted) {
      await this.exhaust(digest, "run-budget", `the run's turn budget (${budget.maxTurns}) is spent`);
      return;
    }
    if ((await this.skipCappedTurn(digest)) || this.skipExhaustedTurn(digest)) {
      // No model call on capped (or exhausted) items: no follow-up is owed either.
      this.followUp = false;
      return;
    }
    budget.used += 1;
    this.turns += 1;
    this.acting = true;
    try {
      await this.takeTurn(digest, state);
    } finally {
      this.acting = false;
    }
  }

  /**
   * The mechanical STRUGGLING report (a status, never a decision): an item
   * this agent holds whose edits failed or were refused twice, that used half
   * its turn budget, or that a failing revision asks it to fix is reported
   * once per reason (and revision) on the board, where the struggling and
   * busy-owner cues read it. The board bounds reports per item too.
   */
  private async reportStruggles(digest: BoardDigest, state: BoardState): Promise<boolean> {
    let reported = false;
    if (this.role !== "worker") {
      return reported;
    }
    for (const claim of digest.claims) {
      if (state.items[claim.item]?.tool || claim.doneProposed && claim.fix === undefined) {
        continue;
      }
      const turnsSpent = this.turnsByItem.get(claim.item) ?? 0;
      const failedEdits = this.failedEdits.get(claim.item) ?? 0;
      // A failing revision counts only when it failed THIS agent's own push
      // (an inherited fix request on a handed-off item is not its struggle yet).
      const ownPushFailed = claim.fix !== undefined && claim.lastPush?.agent === this.id;
      const reason: "failing-revision" | "failed-edits" | "turn-budget" | undefined =
        ownPushFailed && !this.struggleReported.has(`${claim.item}:failing-revision:${claim.fix!.n}`)
          ? "failing-revision"
          : failedEdits >= 2 && !this.struggleReported.has(`${claim.item}:failed-edits`)
            ? "failed-edits"
            : // Half the item budget spent with no push of its own yet (pushes waiting for, or past, integration are progress).
              turnsSpent >= Math.ceil(this.options.maxTurnsPerItem / 2) &&
                (!claim.lastPush || claim.lastPush.agent !== this.id) &&
                !this.struggleReported.has(`${claim.item}:turn-budget`)
              ? "turn-budget"
              : undefined;
      if (reason === undefined) {
        continue;
      }
      this.struggleReported.add(reason === "failing-revision" ? `${claim.item}:failing-revision:${claim.fix!.n}` : `${claim.item}:${reason}`);
      const lastFailure =
        reason === "failing-revision" && digest.failure
          ? // The gate's own failing line (never a command echo such as npm's "> pkg@1.0.0 gate").
            gateFailureLine(digest.failure.output) ??
            digest.failure.output.split("\n").find((l) => l.trim() !== "" && !/^\s*[>$] /.test(l) && !/^npm (error|ERR!)/.test(l.trim()))
          : // Only this item's failed edits or tool runs, never an unrelated refusal (a claim, a split).
            this.history
              .filter((h) => h.code !== undefined && (h.action.type === "edit" || h.action.type === "use_tool") && h.action.itemId === claim.item)
              .at(-1)?.error;
      const outcome = await this.requireClient().post({
        type: "item.struggling",
        payload: { item: claim.item, turnsSpent, failedEdits, reason, ...(lastFailure ? { lastFailure: bounded(this.scrub(lastFailure), 300) } : {}) },
        rationale: `reporting ${claim.item} as struggling (${reason})`,
      });
      if (outcome.ok) {
        reported = true;
        this.evidence.push(`reported ${claim.item} struggling (${reason}); idle agents may volunteer`);
      }
    }
    return reported;
  }

  /**
   * The per-item call cap BEFORE a model call: a worker whose every held item
   * is at its cap (the next call on it would exceed it), with nothing else to
   * act on (no claimable open item, no message addressed to it, no volunteer),
   * skips the turn without calling the model (a local ITEM_CAP wait; no turn
   * budget used). An item whose cap this agent's own call reached is released
   * once through the item-budget exhaust path (handed off, or help requested
   * when no agent can take it) instead of being held; an item that reached its
   * cap under another agent is only skipped (handing it on again would not
   * make another call on it possible).
   */
  private async skipCappedTurn(digest: BoardDigest): Promise<boolean> {
    const meter = this.options.meter;
    const limit = meter?.caps.maxCallsPerItem;
    if (!meter || limit === undefined || this.role !== "worker") {
      return false;
    }
    const held = digest.claims.filter((c) => !c.doneProposed || c.fix !== undefined).map((c) => c.item);
    if (held.length === 0 || !held.every((item) => meter.itemCalls(item) >= limit)) {
      return false;
    }
    const otherCue =
      (digest.openItems.length > 0 && digest.claimCap === undefined) ||
      this.pending.some((m) => m.to?.includes(this.id)) ||
      (digest.volunteers ?? []).length > 0;
    if (otherCue) {
      return false;
    }
    const reason = `every item I hold is at its call cap (${held.map((i) => `${i}: ${meter.itemCalls(i)} of ${limit}`).join(", ")}): no model call`;
    this.record({ turn: this.turns, action: { type: "wait", reason }, outcome: "local", code: "ITEM_CAP", error: reason });
    for (const item of held) {
      this.options.onItemCap?.({ kind: "item-calls", limit, used: meter.itemCalls(item), item });
    }
    const release = held.find((item) => this.capReachedHere.has(item));
    if (release !== undefined) {
      this.capReachedHere.clear();
      await this.exhaust(digest, "item-budget", `item ${release} reached its call cap (${meter.itemCalls(release)} of ${limit})`, release);
    }
    return true;
  }

  /**
   * A worker whose every held item is one it exhausted (still held only
   * because no running agent could take it, so it asked for help; the claim
   * lapses, or a helper takes it), with nothing else to act on, skips the turn
   * without a model call (a local ITEM_BUDGET wait; no turn budget used).
   */
  private skipExhaustedTurn(digest: BoardDigest): boolean {
    if (this.role !== "worker" || this.exhaustedItems.size === 0) {
      return false;
    }
    const held = digest.claims.filter((c) => !c.doneProposed || c.fix !== undefined).map((c) => c.item);
    if (held.length === 0 || !held.every((item) => this.exhaustedItems.has(item))) {
      return false;
    }
    const otherCue =
      (digest.openItems.some((i) => !this.exhaustedItems.has(i.item)) && digest.claimCap === undefined) ||
      this.pending.some((m) => m.to?.includes(this.id)) ||
      (digest.volunteers ?? []).length > 0;
    if (otherCue) {
      return false;
    }
    const reason = `every item I hold is one I spent my turn budget on (${held.join(", ")}): no model call`;
    this.record({ turn: this.turns, action: { type: "wait", reason }, outcome: "local", code: "ITEM_BUDGET", error: reason });
    return true;
  }

  /** The digest the model sees: never an item this worker exhausted (it may not act on it again). */
  private withoutExhausted(digest: BoardDigest): BoardDigest {
    if (this.exhaustedItems.size === 0) {
      return digest;
    }
    return {
      ...digest,
      claims: digest.claims.filter((c) => !this.exhaustedItems.has(c.item)),
      openItems: digest.openItems.filter((i) => !this.exhaustedItems.has(i.item)),
    };
  }

  private async takeTurn(initialDigest: BoardDigest, initialState: BoardState): Promise<void> {
    let digest = initialDigest;
    let state = initialState;
    if (await this.reportStruggles(digest, state)) {
      // The turn sees the cue it just raised (its struggling item, the idle agents).
      const client = this.requireClient();
      digest = { ...(await client.digest(this.lastSeen)).digest, messages: digest.messages };
      state = await client.state();
    }
    const input = await this.turnInput(this.withoutExhausted(digest), state);
    const outcome = await this.options.transport(input);
    const action = outcome.action;
    this.pending = [];
    this.followUp = false;
    this.lastRejection = undefined;

    const item = actionItem(action, digest);
    if (item !== undefined && this.exhaustedItems.has(item)) {
      // An item this worker already spent its turn budget on and released: never re-claimed or acted on again.
      const error = `you spent your turn budget on item ${item} and released it: it is another agent's now; take a different open item or wait`;
      this.record({ turn: this.turns, action, outcome: "local", code: "ITEM_BUDGET", error });
      this.lastRejection = { code: "ITEM_BUDGET", error, action: action.type };
      return;
    }
    if (item !== undefined && this.options.meter) {
      // The per-item call cap (across agents): no more turns on an item past it.
      this.options.meter.noteItem(item);
      const cap = this.options.meter.itemReached(item);
      if (cap !== undefined) {
        this.record({ turn: this.turns, action, outcome: "local", code: "ITEM_CAP", error: `item ${item} reached its call cap (${cap.used} of ${cap.limit})` });
        this.options.onItemCap?.(cap);
        if (this.capReachedHere.has(item) && this.role === "worker" && digest.claims.some((c) => c.item === item)) {
          // First reached by this agent's own call: release it (item-budget) instead of holding it.
          this.capReachedHere.clear();
          await this.exhaust(digest, "item-budget", `item ${item} reached its call cap (${cap.used} of ${cap.limit})`, item);
        }
        return;
      }
    }
    if (item !== undefined) {
      const spent = (this.turnsByItem.get(item) ?? 0) + 1;
      this.turnsByItem.set(item, spent);
      if (spent > this.options.maxTurnsPerItem) {
        this.record({ turn: this.turns, action, outcome: "local", code: "BUDGET", error: "per-item turn budget spent" });
        await this.exhaust(digest, "item-budget", `spent more than ${this.options.maxTurnsPerItem} turns on item ${item}`, item);
        return;
      }
    }
    await this.act(action, digest, state, outcome.invalid);
    const limit = this.options.meter?.caps.maxCallsPerItem;
    if (item !== undefined && limit !== undefined && this.options.meter!.itemCalls(item) >= limit) {
      // This turn (its call, and any edit's executor calls) brought the item to
      // its cap: the next call on it is refused, and this agent releases it.
      this.capReachedHere.add(item);
    }
  }

  private async turnInput(digest: BoardDigest, state: BoardState): Promise<AgentTurnInput<BoardDigest, BoardMessage>> {
    // A split item whose sub-lead is on the board stays its sub-lead's live claim.
    const liveClaims = Object.values(state.items)
      .filter(
        (i) =>
          (i.status === "claimed" || (i.status === "split" && i.subLead !== undefined && state.agents[i.subLead]?.leftSeq === undefined)) &&
          i.owner !== undefined &&
          i.intent,
      )
      .map((i) => ({ item: i.id, owner: i.owner!, write: [...i.intent!.write] }));
    const pendingContracts = Object.values(state.contracts)
      .filter((c) => c.status === "proposed")
      .map((c) => ({
        contract: c.contract,
        target: c.target,
        kind: c.kind,
        proposedBy: c.proposedBy,
        ...(c.item !== undefined ? { item: c.item } : {}),
        ...(c.guarded ? { protected: true } : {}),
        ...(c.seam !== undefined ? { seam: c.seam, ...seamContractFacts(state, c.contract) } : {}),
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.triage !== undefined ? { triage: c.triage } : {}),
      }));
    // Seam contracts already decided (with their seam item): nothing to decide again.
    const decidedContracts = Object.values(state.contracts)
      .filter((c) => c.seam !== undefined && c.status !== "proposed")
      .slice(-20)
      .map((c) => ({ contract: c.contract, status: c.status, seamItem: seamItemId(c.contract) }));
    // The lead decides workers' proposals against the items already on the
    // Change; every agent sees them, so a tool's findings are compared with
    // what outstanding items already cover.
    const pendingItems = Object.values(state.items)
      .filter((i) => i.status === "proposed")
      .slice(0, 200)
      .map((i) => ({
        item: i.id,
        objective: i.objective,
        scopeHint: [...i.scopeHint],
        proposedBy: i.proposedBy,
        ...(i.tool ? { tool: i.tool.capability } : {}),
        ...(i.fromTool ? { fromTool: { ...i.fromTool } } : {}),
      }));
    const acceptedItems = Object.values(state.items)
      .filter((i) => isAcceptedItem(i))
      .slice(0, 200)
      .map((i) => ({
        item: i.id,
        objective: i.objective,
        scopeHint: [...i.scopeHint],
        status: i.status,
        ...(i.status === "claimed" && i.intent ? { write: [...i.intent.write] } : {}),
        ...(i.tool ? { tool: i.tool.capability } : {}),
        ...(i.fromTool ? { fromTool: { ...i.fromTool } } : {}),
        ...(i.parent !== undefined ? { parent: i.parent } : {}),
        // Planned work (the lead's or a human's items), as opposed to a worker's proposal.
        ...(i.proposedBy === "human" || state.agents[i.proposedBy]?.role === LEAD_ROLE ? { planned: true } : {}),
      }));
    const tools = Object.values(state.tools.proposed).map((t) => {
      const item = state.items[t.item];
      return {
        capability: t.capability,
        kind: t.kind,
        item: t.item,
        status: item?.status ?? "unknown",
        proposedBy: t.proposedBy,
        ...(item?.owner !== undefined ? { owner: item.owner } : {}),
        inputs: [...t.inputs],
        failedGates: t.failedGates,
        ownerFailures: item?.toolFailures ?? 0,
        reopened: item?.exhaustedBy?.length ?? 0,
        ...((): { unavailable?: string } => {
          const why = toolUnavailableReason(state, t.capability);
          return why !== undefined ? { unavailable: why } : {};
        })(),
        versions: state.tools.published
          .filter((v) => v.capability === t.capability)
          .map((v) => ({ version: v.version, commit: v.commit, usage: v.usage, publishedBy: v.publishedBy })),
      };
    });
    const files = await listRepoFiles(this.baseDir);
    const excerpts = await this.excerpts(digest, files, state);
    const replan = this.role === "lead" ? await this.replanFacts(digest, files) : [];
    return {
      agent: this.id,
      role: this.role,
      goal: this.options.goal,
      digest,
      messages: [...this.pending],
      capsule: {
        objective: this.options.goal,
        constraints: [
          `write only inside the write intent of an item you hold`,
          `at most ${this.options.maxTurnsPerItem} turns per item`,
          `contests escalate to a human after ${state.rules.maxContestTurns} turns`,
        ],
        decisions: [...this.history],
        evidence: this.evidence.slice(-12),
      },
      board: {
        liveClaims,
        pendingContracts,
        ...(this.role === "lead" && decidedContracts.length > 0 ? { decidedContracts } : {}),
        pendingItems,
        items: acceptedItems,
        tools,
        ...(replan.length > 0 ? { replan } : {}),
        ...((): { cues?: { splittable: { item: string; files: number; subChanges: number }[] } } => {
          // No split cue where splits are not supported (the cloud integrator).
          const splittable = (state.integrator === "cloud" ? [] : (digest.struggling ?? [])).flatMap((s) => {
            const claim = digest.claims.find((c) => c.item === s.item);
            // Only where a split is legal now: no unintegrated push of its own on the item.
            if (!claim || (claim.lastPush !== undefined && claim.lastPush.integratedIn === undefined) || state.items[s.item]?.tool) return [];
            const cue = splitCue(resolveIntentFiles(claim.intent.write, files).filter((f) => !hasWildcard(f)).length, claim.objective);
            return cue.splittable ? [{ item: s.item, files: cue.files, subChanges: cue.subChanges }] : [];
          });
          return splittable.length > 0 ? { cues: { splittable } } : {};
        })(),
      },
      repo: { files, excerpts },
      ...(this.lastRejection ? { lastRejection: this.lastRejection } : {}),
      allowed:
        this.role === "lead"
          ? LEAD_ACTIONS
          : // offer_help goes to another agent's busy item: without one it could only name itself (refused).
            (digest.busyOwners ?? []).some((b) => b.agent !== this.id)
            ? WORKER_ACTIONS
            : WORKER_ACTIONS.filter((t) => t !== "offer_help"),
    };
  }

  /**
   * The lead's re-plan cues for this turn (each item once: one bounded re-plan
   * turn), with the failure attribution of the item's latest failing revision:
   * the repo files its output names and its failing test lines.
   */
  private async replanFacts(digest: BoardDigest, files: readonly string[]): Promise<NonNullable<AgentTurnInput["board"]["replan"]>> {
    const cues = (digest.replan ?? []).filter((r) => !this.replanCued.has(replanKey(r)));
    this.replanCues = cues;
    if (cues.length === 0) {
      return [];
    }
    const log = cues.some((c) => c.rev !== undefined) ? await this.requireClient().log().catch(() => undefined) : undefined;
    return cues.map((cue) => {
      this.replanCued.add(replanKey(cue));
      const rev = log?.messages.find((m) => m.type === "integrated.rev" && m.payload.n === cue.rev);
      const output = rev && rev.type === "integrated.rev" ? (rev.payload.failing?.output ?? "") : "";
      const failingTests = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^not ok\b|\bFAIL\b|\u2716|\u00d7|AssertionError|error TS\d+/.test(l))
        .slice(0, 8)
        .map((l) => bounded(this.scrub(l), 200));
      return {
        item: cue.item,
        reason: cue.reason,
        ...(cue.rev !== undefined ? { rev: cue.rev } : {}),
        objective: cue.objective,
        scopeHint: cue.scopeHint,
        exhaustedBy: cue.exhaustedBy,
        stallReleases: cue.stallReleases,
        failingFiles: output !== "" ? failingRepoFiles(output, files).slice(0, 16) : [],
        failingTests,
        neighbours: cue.neighbours,
      };
    });
  }

  /**
   * Bounded file contents inside the agent's intents (or the open items it may
   * claim), then, for held claims, the READ-ONLY reference files their write
   * intents import (seams first, `boardReferenceFiles`), so the turn plans
   * against the real types. References keep up to MAX_TURN_REFERENCES of the
   * MAX_EXCERPTS slots; all excerpts share the same per-file bound.
   */
  private async excerpts(digest: BoardDigest, files: readonly string[], state?: BoardState): Promise<AgentRepoExcerpt[]> {
    const granted = (digest.help?.granted ?? []).filter((g) => g.live).flatMap((g) => g.scope);
    const entries =
      digest.claims.length > 0 || granted.length > 0
        ? [...digest.claims.flatMap((c) => [...c.intent.write, ...c.intent.read]), ...granted]
        : digest.openItems.flatMap((i) => i.scopeHint);
    const intentFiles = resolveIntentFiles(entries, files).filter((path) => !hasWildcard(path));
    const writable = resolveIntentFiles(digest.claims.flatMap((c) => c.intent.write), files).filter((path) => !hasWildcard(path));
    const evidence = digest.claims.some((c) => c.fix !== undefined && digest.failure?.n === c.fix.n) ? (digest.failure?.output ?? "") : "";
    const references =
      writable.length > 0
        ? (
            await boardReferenceFiles({
              writable,
              files,
              seams: (state?.seams ?? []).map((seam) => seam.path),
              ...(evidence !== "" ? { evidence } : {}),
              read: (path) => this.readCurrent(path),
              maxFiles: MAX_TURN_REFERENCES,
              maxBytes: MAX_EXCERPT_CHARS,
            })
          ).filter((r) => !intentFiles.includes(r.path))
        : [];
    const out: AgentRepoExcerpt[] = [];
    for (const path of intentFiles) {
      if (out.length >= MAX_EXCERPTS - references.length) {
        break;
      }
      const contents = await this.readCurrent(path);
      if (contents !== undefined) {
        out.push({ path, contents: bounded(contents, MAX_EXCERPT_CHARS) });
      }
    }
    for (const ref of references) {
      out.push({ path: ref.path, contents: bounded(`(READ-ONLY REFERENCE: imported by a file you hold; use only what it declares; changing it takes a seam contract)\n${ref.contents}`, MAX_EXCERPT_CHARS) });
    }
    return out;
  }

  /** The current contents of a file: the agent's own version if it changed it, else the baseline's. */
  private async readCurrent(path: string): Promise<string | undefined> {
    for (const dir of [this.worktreeDir, this.baseDir]) {
      if (dir !== undefined) {
        try {
          return await readFile(join(dir, path), "utf8");
        } catch {
          // Not in this tree; try the next.
        }
      }
    }
    return undefined;
  }

  /**
   * Remove the agent's repo credential from text that may reach the model, the
   * board, or a log (git echoes the authenticated remote in its errors).
   */
  private scrub(text: string): string {
    let out = text;
    const token = this.workspace?.token;
    if (this.remote !== "" && this.workspace && this.remote !== this.workspace.gitUrl) {
      out = out.split(this.remote).join(this.workspace.gitUrl);
    }
    for (const secret of [...(token ? [token] : []), ...this.retiredTokens]) {
      out = out.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
    }
    return redactSecrets(out);
  }

  private nextId(kind: string): string {
    this.counter += 1;
    return `${this.id}-${kind}-${this.counter}`;
  }

  /** Map an action to a board post (or local work) and record the outcome. */
  private async act(action: AgentAction, digest: BoardDigest, state: BoardState, invalid?: string): Promise<void> {
    const client = this.requireClient();
    const turn = this.turns;
    const local = (code: string, error: string, note?: Record<string, string>): void => {
      this.lastRejection = { code, error, action: action.type };
      this.followUp = true;
      this.record({ turn, action, outcome: "local", code, error }, { turn, action, outcome: "local", code, error, ...(note ? { note } : {}) });
    };
    const posted = async (draft: Record<string, unknown>, note?: Record<string, string>): Promise<boolean> => {
      const outcome = await client.post(draft);
      if (outcome.ok) {
        // The agent keeps its own initiative after an accepted action: it gets
        // a follow-up turn until it chooses to wait (or an edit it starts
        // finishes), so unfinished work never stalls waiting for an event.
        this.followUp = true;
        this.record(
          { turn, action, outcome: "posted", seqs: outcome.appended.map((m) => m.seq) },
          { turn, action, outcome: "posted", ...(note ? { note } : {}) },
        );
        return true;
      }
      this.lastRejection = { code: outcome.code, error: outcome.error, action: action.type };
      this.followUp = true;
      this.record(
        { turn, action, outcome: "rejected", code: outcome.code, error: outcome.error },
        { turn, action, outcome: "rejected", code: outcome.code, error: outcome.error, ...(note ? { note } : {}) },
      );
      return false;
    };
    const rationale = (text: string | undefined) => (text !== undefined ? { rationale: text } : {});
    const allowed = this.role === "lead" ? LEAD_ACTIONS : WORKER_ACTIONS;
    if (!allowed.includes(action.type)) {
      local("NOT_ALLOWED", `a ${this.role} may not ${action.type} (allowed: ${allowed.join(", ")})`);
      return;
    }

    switch (action.type) {
      case "wait": {
        this.record(
          { turn, action, outcome: "local", ...(invalid !== undefined ? { invalid } : {}) },
          { turn, action, outcome: "local" },
        );
        // Waiting (reading its files) while holding work it has not pushed and
        // a tool for it is not published yet: the agent gets another turn
        // anyway, a bounded number of times, then must act on it (a tool that
        // never arrives, or a build failure no board message reports, never
        // stalls held work).
        const awaitingTool = (write: readonly string[]): boolean =>
          Object.values(state.tools.proposed).some(
            (t) =>
              (t.kind === "codemod" || t.kind === "scanner") &&
              !state.tools.published.some((p) => p.capability === t.capability) &&
              (t.inputs.length === 0 || write.some((w) => t.inputs.some((i) => entriesOverlap(intentPath(w), i)))),
          );
        // The lead answering pending contracts with a wait: each blocks a held
        // item (its claim cannot lapse, its holder cannot propose another), and
        // nothing else would wake the lead for them. Re-cue at once, with the
        // contracts named (bounded per set; nothing decides them for it).
        if (this.role === "lead") {
          const cue = pendingContractCue(state);
          const cues = cue ? (this.contractCues.get(cue.key) ?? 0) : 0;
          if (cue && cues < MAX_CONTRACT_CUES) {
            this.contractCues.set(cue.key, cues + 1);
            this.followUp = true;
            this.evidence.push(cue.text);
          }
          return;
        }
        // A fix request is never answered with a wait: the item FAILED the
        // gate. Re-cue at once, with the fix stated plainly (bounded).
        if (this.role === "worker") {
          const fixes = digest.claims.filter((c) => c.fix !== undefined && !state.items[c.item]?.tool);
          const key = fixes.map((c) => `${c.item}@${c.fix!.n}`).join(",");
          const cues = this.fixCues.get(key) ?? 0;
          if (key !== "" && cues < MAX_FIX_CUES) {
            this.fixCues.set(key, cues + 1);
            this.followUp = true;
            this.evidence.push(
              `FIX REQUIRED: ${fixes.map((c) => `revision ${c.fix!.n} failed the gate and implicates my item ${c.item}`).join("; ")}. ` +
                "Proposing done did not complete it and I am not waiting for integration: edit it now (or send the contract its cue names); waiting stalls it.",
            );
            return;
          }
        }
        const unpushed = digest.claims
          .filter((c) => !state.items[c.item]?.tool && (!c.lastPush || c.lastPush.agent !== this.id) && c.fix === undefined && awaitingTool(c.intent.write))
          .map((c) => c.item);
        if (this.role === "worker" && unpushed.length > 0) {
          const key = unpushed.join(",");
          const cues = this.heldWaitCues.get(key) ?? 0;
          if (cues < MAX_HELD_WAIT_CUES) {
            this.heldWaitCues.set(key, cues + 1);
            this.followUp = true;
            this.evidence.push(
              cues + 1 >= MAX_HELD_WAIT_CUES
                ? `I hold ${key} with no push of mine: edit it by hand now (never wait longer for a tool)`
                : `I hold ${key} with no push of mine: when a tool for it is published use it, otherwise edit by hand`,
            );
          }
        }
        // Waiting (or an invalid reply) while holding work it owes, with
        // nothing to wait for (no push of its own, no fix request, no stated
        // wait reason): nothing on the board would ever wake it again, so it
        // gets another turn at once, told plainly (bounded).
        const idleHeld = digest.claims
          .filter(
            (c) =>
              !state.items[c.item]?.tool &&
              !c.doneProposed &&
              (!c.lastPush || c.lastPush.agent !== this.id) &&
              c.fix === undefined &&
              c.wait === undefined &&
              !unpushed.includes(c.item),
          )
          .map((c) => c.item);
        if (this.role === "worker" && idleHeld.length > 0) {
          const key = idleHeld.join(",");
          const cues = this.idleHeldCues.get(key) ?? 0;
          if (cues < MAX_HELD_WAIT_CUES) {
            this.idleHeldCues.set(key, cues + 1);
            this.followUp = true;
            this.evidence.push(
              bounded(
                `HELD WORK: I hold ${key} with no push: edit it now (or hand it off); nothing else will wake me for it` +
                  (invalid !== undefined ? `. My last reply was invalid: ${this.scrub(invalid)}` : ""),
                600,
              ),
            );
          }
        }
        return;
      }
      case "claim":
        await posted({ type: "item.claimed", payload: { item: action.itemId, intent: action.intent }, ...rationale(action.rationale) });
        return;
      case "propose_item": {
        const item = this.nextId("item");
        this.proposedItems.add(item);
        await posted({
          type: "item.proposed",
          payload: {
            item,
            objective: action.objective,
            acceptance: action.acceptance,
            scopeHint: action.scopeHint,
            ...(action.fromTool !== undefined ? { fromTool: action.fromTool } : {}),
          },
          ...rationale(action.rationale),
        });
        return;
      }
      case "split":
        await posted({
          type: "item.split",
          payload: {
            item: action.itemId,
            children: action.children.map((child, index) => ({
              item: `${action.itemId}.${index + 1}`,
              objective: child.objective,
              acceptance: child.acceptance,
              scopeHint: child.scopeHint,
            })),
          },
          ...rationale(action.rationale),
        });
        return;
      case "contest_reply": {
        const contest = digest.contests.find((c) => c.id === action.contestId);
        const note = contest ? { owner: contest.owner, claimant: contest.claimant, item: contest.item } : undefined;
        const type = action.reply === "cede" ? "claim.ceded" : action.reply === "keep" ? "claim.kept" : "claim.narrowed";
        await posted(
          {
            type,
            payload: { contest: action.contestId, ...(action.reply === "narrow" ? { write: action.write ?? [] } : {}) },
            ...rationale(action.rationale),
          },
          note,
        );
        return;
      }
      case "message":
        if (action.kind === "reply" && action.payload.requestId !== undefined && digest.help?.wanted.some((h) => h.request === action.payload.requestId)) {
          // Taking a request that GRANTS a scope: fork the requester's repo first.
          await this.offerFork(action, digest, local, posted);
          return;
        }
        await this.message(action, posted, state);
        return;
      case "offer_help":
        if (action.toAgent === this.id) {
          local("NOT_ALLOWED", "you cannot offer help to yourself: offer_help goes to the owner of an item in digest.busyOwners");
          return;
        }
        await posted(
          { type: "help.volunteered", payload: { item: action.itemId }, rationale: action.why, to: [action.toAgent] },
          { item: action.itemId, to: action.toAgent },
        );
        return;
      case "answer_volunteer":
        if (action.accept) {
          // Accepting grants the volunteer a scope; the existing fork flow follows.
          await posted(
            {
              type: "help.requested",
              payload: { request: this.nextId("help"), item: action.itemId, need: "volunteer", scope: action.scope ?? [] },
              rationale: action.rationale ?? `accepting ${action.volunteer}'s offer: it takes ${(action.scope ?? []).join(", ")}`,
              to: [action.volunteer],
            },
            { item: action.itemId, volunteer: action.volunteer },
          );
        } else {
          await posted(
            { type: "help.declined", payload: { item: action.itemId, volunteer: action.volunteer }, rationale: action.rationale ?? "declined", to: [action.volunteer] },
            { item: action.itemId, volunteer: action.volunteer },
          );
        }
        return;
      case "pull":
        if (action.requestId !== undefined && action.decline === true) {
          await posted(
            { type: "help.closed", payload: { request: action.requestId, reason: "declined" }, ...(action.rationale !== undefined ? { rationale: action.rationale } : {}) },
            { request: action.requestId },
          );
          return;
        }
        if (action.requestId !== undefined) {
          await this.pullHelp(action, digest, local, posted);
        } else {
          await this.pullChildren(action, digest, state, local, posted);
        }
        return;
      case "edit": {
        // A tool item is built in the tools repo, never edited in the agent's own repo.
        const tool = state.items[action.itemId]?.tool;
        if (tool) {
          await this.buildTool({ type: "build_tool", capability: tool.capability, rationale: action.instruction.slice(0, 500) }, digest, state, local, posted);
          return;
        }
        // A helper edits the requester's item only inside its grant, in its fork.
        const grant = digest.help?.granted.find((g) => g.item === action.itemId && g.live);
        if (grant && !digest.claims.some((c) => c.item === action.itemId)) {
          await this.helperEdit(grant, action.instruction, local, posted, state);
          return;
        }
        await this.edit(action.itemId, action.instruction, digest, local, posted, state);
        return;
      }
      case "propose_done": {
        if (state.items[action.itemId]?.tool) {
          local("TOOL_ITEM", `${action.itemId} builds a tool: it completes when its build passes its own gate (use build_tool)`);
          return;
        }
        const claim = digest.claims.find((c) => c.item === action.itemId);
        await posted({
          type: "done.proposed",
          payload: { item: action.itemId, ...(claim?.lastPush ? { commit: claim.lastPush.commit } : {}) },
          ...rationale(action.rationale),
        });
        return;
      }
      case "propose_tool":
        this.proposedItems.add(toolItemId(action.capability));
        await posted({
          type: "tool.proposed",
          payload: { tool: this.nextId("tool"), capability: action.capability, kind: action.kind, inputs: action.inputs, outputs: action.outputs },
          rationale: action.why,
        });
        return;
      case "build_tool":
        await this.buildTool(action, digest, state, local, posted);
        return;
      case "use_tool":
        if (action.itemId !== undefined && state.items[action.itemId]?.tool) {
          local("TOOL_ITEM", `${action.itemId} builds a tool: use build_tool for it (a tool is run on the items it serves)`);
          return;
        }
        await this.useTool(action, digest, state, local);
        return;
      case "decide_item":
        if (this.role !== "lead" || !state.agents[this.id]) {
          local("NOT_ALLOWED", "only the lead decides proposed items");
          return;
        }
        await posted({
          type: action.decision === "accept" ? "item.accepted" : "item.rejected",
          payload: { item: action.itemId },
          rationale: action.rationale,
        });
        return;
      case "replan_item": {
        if (this.role !== "lead" || !state.agents[this.id]) {
          local("NOT_ALLOWED", "only the lead re-plans an item");
          return;
        }
        const reason = replanEligible(state, action.itemId);
        if (reason === undefined) {
          local("INVALID_STATE", `item ${action.itemId} is not an item to re-plan now (board.replan lists them)`);
          return;
        }
        const cue = this.replanCues.find((c) => c.item === action.itemId) ?? digest.replan?.find((c) => c.item === action.itemId);
        const prefix = action.itemId.slice(0, 120);
        await posted({
          type: "item.replanned",
          payload: {
            item: action.itemId,
            reason,
            action: action.plan,
            children: action.children.map((child, index) => ({
              item: `${prefix}.r${index + 1}`,
              objective: child.objective,
              acceptance: child.acceptance,
              scopeHint: child.scopeHint,
            })),
            ...(action.withItemId !== undefined ? { with: action.withItemId } : {}),
            ...(cue?.rev !== undefined ? { rev: cue.rev } : {}),
          },
          rationale: action.rationale,
        });
        return;
      }
      case "extend_claim":
        if (this.role !== "lead" || !state.agents[this.id]) {
          local("NOT_ALLOWED", "only the lead extends a claim's deadline");
          return;
        }
        await posted({ type: "claim.extended", payload: { item: action.itemId, reason: bounded(action.rationale, 200) }, rationale: action.rationale });
        return;
      case "decide_contract":
        if (this.role !== "lead" || !state.agents[this.id]) {
          local("NOT_ALLOWED", "only the lead decides contracts");
          return;
        }
        {
          // The contract id, or the seam item id derived from it (`seam-<contract>`).
          const contractId = state.contracts[action.contractId]
            ? action.contractId
            : (state.items[action.contractId]?.fromContract ??
              (action.contractId.startsWith("seam-") && state.contracts[action.contractId.slice(5)] ? action.contractId.slice(5) : undefined));
          const contract = contractId !== undefined ? state.contracts[contractId] : undefined;
          if (contract === undefined) {
            const pending = Object.values(state.contracts).filter((c) => c.status === "proposed").map((c) => c.contract);
            local("UNKNOWN_REF", `no contract ${action.contractId}; pending contracts: ${pending.join(", ") || "none"} (use pendingContracts[].contract exactly)`);
            return;
          }
          if (contract.status !== "proposed") {
            local(
              "INVALID_STATE",
              `contract ${contract.contract} is already ${contract.status}${contract.seam !== undefined && contract.status === "accepted" ? ` (its seam item ${seamItemId(contract.contract)} carries it out)` : ""}: nothing to decide`,
            );
            return;
          }
          await posted({
            type: action.decision === "accept" ? "contract.accepted" : "contract.rejected",
            payload: { contract: contract.contract },
            ...rationale(action.rationale),
          });
        }
        return;
    }
  }

  private async message(
    action: Extract<AgentAction, { type: "message" }>,
    posted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
    state: BoardState,
  ): Promise<void> {
    const to = action.to && action.to.length > 0 ? { to: action.to } : {};
    const p = action.payload;
    const note = action.to && action.to.length > 0 ? { to: action.to.join(",") } : undefined;
    switch (action.kind) {
      case "help":
      case "question":
        await posted(
          {
            type: "help.requested",
            payload: {
              request: this.nextId(action.kind),
              item: p.itemId,
              need: p.need ?? action.kind,
              ...(action.kind === "help" && p.scope !== undefined && p.scope.length > 0 ? { scope: p.scope } : {}),
            },
            rationale: action.rationale,
            ...to,
          },
          note,
        );
        return;
      case "reply": {
        const known = p.requestId !== undefined ? this.requests.get(p.requestId) : undefined;
        const recipients =
          action.to && action.to.length > 0 ? action.to : known && known.by !== this.id ? [known.by] : undefined;
        await posted(
          {
            type: "help.offered",
            payload: { request: p.requestId },
            rationale: action.rationale,
            ...(known ? { inReplyTo: known.seq } : {}),
            ...(recipients ? { to: recipients } : {}),
          },
          { request: p.requestId ?? "", ...(recipients ? { to: recipients.join(",") } : {}) },
        );
        return;
      }
      case "contract":
        await posted(
          {
            type: "contract.proposed",
            payload: {
              contract: this.nextId("contract"),
              target: p.target,
              kind: p.change,
              ...(p.itemId !== undefined ? { item: p.itemId } : {}),
              // The needed change; a shared seam's contract requires one (the rationale stands in when the model gave none).
              ...(p.description !== undefined
                ? { description: p.description }
                : p.target !== undefined && (state.seams ?? []).some((seam) => seam.path === p.target!.split("#")[0])
                  ? { description: action.rationale.slice(0, 400) }
                  : {}),
            },
            rationale: action.rationale,
            ...to,
          },
          note,
        );
        return;
      case "review":
        if (p.reviewId !== undefined) {
          await posted({ type: "review.result", payload: { review: p.reviewId, findings: p.findings ?? [] }, rationale: action.rationale, ...to }, note);
        } else {
          await posted({ type: "review.requested", payload: { review: this.nextId("review"), item: p.itemId }, rationale: action.rationale, ...to }, note);
        }
        return;
    }
  }

  /** Clone the agent's own repo once; later edits reuse the worktree. */
  private async ensureWorktree(): Promise<string> {
    if (this.worktreeDir) {
      return this.worktreeDir;
    }
    if (!this.workspace) {
      throw new Error(`${this.id} has no workspace to edit in`);
    }
    const dir = join(this.options.workRoot, "agents", this.id.replace(/[^A-Za-z0-9._-]+/g, "-"));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await clone(this.remote, dir);
    this.worktreeDir = dir;
    return dir;
  }

  /**
   * The executor's read view for one edit: each concrete in-scope file as the
   * agent currently sees it (its own pushed version if it changed the file,
   * else the shared baseline, which is the integrated revision after a
   * rebase). The edit itself is written into the agent's worktree.
   */
  private async editView(paths: readonly string[], worktree: string): Promise<string> {
    this.edits += 1;
    const view = join(this.options.workRoot, "views", `${this.id.replace(/[^A-Za-z0-9._-]+/g, "-")}-${this.edits}`);
    await rm(view, { recursive: true, force: true });
    await mkdir(view, { recursive: true });
    for (const path of paths) {
      if (hasWildcard(path)) {
        continue;
      }
      for (const dir of [worktree, this.baseDir]) {
        const from = join(dir, path);
        if (await exists(from)) {
          await mkdir(dirname(join(view, path)), { recursive: true });
          await cp(from, join(view, path));
          break;
        }
      }
    }
    return view;
  }

  /**
   * The bounded READ-ONLY reference files for an edit of `allowed`
   * (`boardReferenceFiles`): files the failure evidence names, then the shared
   * seams, then the other modules the allowed files import. Each is read the
   * way the edit view reads (the agent's own version in `worktree`, else the
   * shared baseline, which is the integrated revision after a rebase, so an
   * accepted seam change it rebased onto is what it sees). Never writable.
   */
  private async referencesFor(
    allowed: readonly string[],
    files: readonly string[],
    worktree: string,
    state: BoardState | undefined,
    evidence: readonly string[],
  ): Promise<ReferenceFile[]> {
    return boardReferenceFiles({
      writable: allowed.filter((f) => !hasWildcard(f)),
      files,
      seams: (state?.seams ?? []).map((seam) => seam.path),
      ...(evidence.length > 0 ? { evidence: evidence.join("\n") } : {}),
      read: async (path) => {
        for (const dir of [worktree, this.baseDir]) {
          const text = await readFile(join(dir, path), "utf8").catch(() => undefined);
          if (text !== undefined) {
            return text;
          }
        }
        return undefined;
      },
    });
  }

  /**
   * Before this agent changes its worktree: anything uncommitted there was not
   * written by this agent's current operation (another process could have
   * written into it), so it is reset and cleaned, and logged, never pushed.
   */
  private async cleanStray(worktree: string, head: string | undefined, why: string): Promise<void> {
    const stray = await worktreeChanges(worktree).catch(() => [] as string[]);
    if (stray.length === 0) {
      return;
    }
    await this.discard(worktree, head);
    this.evidence.push(
      bounded(`discarded ${stray.length} uncommitted change(s) found in my worktree before ${why} (nobody announced them; never pushed): ${stray.join(", ")}`, 500),
    );
  }

  /** Discard uncommitted work in the worktree (back to its last commit, or empty). */
  private async discard(worktree: string, head: string | undefined): Promise<void> {
    if (head) {
      await gitOut(worktree, ["reset", "-q", "--hard", head]);
    } else {
      await gitOut(worktree, ["read-tree", "--empty"]).catch(() => "");
    }
    await gitOut(worktree, ["clean", "-q", "-fdx"]).catch(() => "");
  }

  private async edit(
    itemId: string,
    instruction: string,
    digest: BoardDigest,
    plainLocal: (code: string, error: string, note?: Record<string, string>) => void,
    plainPosted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
    state?: BoardState,
  ): Promise<void> {
    const claim = digest.claims.find((c) => c.item === itemId);
    if (!claim) {
      plainLocal("NOT_OWNER", `${this.id} does not hold a granted claim on item ${itemId}`);
      return;
    }
    // An edit answering a fix request remembers which revision it answers.
    const fixNote: Record<string, string> | undefined =
      claim.fix !== undefined ? { fix: String(claim.fix.n) } : claim.excluded !== undefined ? { excluded: claim.excluded.commit } : undefined;
    const local = (code: string, error: string): void => plainLocal(code, error, fixNote);
    const posted = (draft: Record<string, unknown>): Promise<boolean> => plainPosted(draft, fixNote);
    if (!this.options.executor) {
      local("NOT_ALLOWED", `${this.id} has no executor`);
      return;
    }
    // SEAM FIRST: a change to a shared seam this item's files import is still
    // on its way: do not edit yet (bounded by the board), and rebase onto its
    // integrated revision before editing.
    const deferred = this.seamDeferrals.get(itemId) ?? 0;
    if ((claim.waitsFor ?? []).length > 0 && deferred < MAX_SEAM_DEFERRALS) {
      // Bounded in turns too (a quiet board never stalls held work).
      this.seamWaited.add(itemId);
      this.seamDeferrals.set(itemId, deferred + 1);
      plainLocal(
        "SEAM_FIRST",
        `item ${itemId} waits for the shared seam change in ${claim.waitsFor!.join(", ")} to be integrated (${deferred + 1} of ${MAX_SEAM_DEFERRALS}); it rebases then`,
      );
      return;
    }
    // A passing integrated revision changed something this agent reads or
    // writes (or a failing revision asks this agent for a fix): fetch the latest
    // passing revision once, before this edit, and read from it from now on.
    const fix = claim.fix;
    await this.rebaseIfNeeded(digest, fix !== undefined || this.seamWaited.has(itemId));
    let worktree: string;
    try {
      worktree = await this.ensureWorktree();
    } catch (error) {
      local("CLONE_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const head = (await gitOut(worktree, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || undefined;
    await this.cleanStray(worktree, head, `editing ${itemId}`);
    const writeGlobs = [...new Set(claim.intent.write.map(intentPath))];
    // A handed-off item starts from the previous owner's latest pushed version
    // of its files: copy them into this agent's worktree before the first edit.
    const inherited = this.inherited.get(itemId);
    if (inherited && !inherited.seeded && this.options.fetchPush) {
      const from = await this.options.fetchPush(inherited.from, inherited.commit);
      if (from !== undefined) {
        for (const rel of (await listRepoFiles(from)).filter((f) => writeGlobs.some((g) => matchesGlob(f, g)))) {
          await mkdir(dirname(join(worktree, rel)), { recursive: true });
          await cp(join(from, rel), join(worktree, rel));
        }
        inherited.seeded = true;
        this.evidence.push(`started ${itemId} from ${inherited.from}'s push ${inherited.commit}`);
      }
    }
    const files = [...new Set([...(await listRepoFiles(this.baseDir)), ...(await listRepoFiles(worktree))])].sort();
    // Files granted to a helper are the helper's until pulled: never edit them here.
    // (Only a grant a helper has taken; an untaken one never blocks the owner.)
    const granted = (digest.help?.mine ?? []).filter((h) => h.item === itemId && h.live && h.grantee !== undefined).flatMap((h) => h.scope.map(intentPath));
    const allowed = resolveIntentFiles(writeGlobs, files).filter((f) => !granted.some((g) => matchesGlob(f, g)));
    const view = await this.editView(allowed, worktree);

    // A fix attempt carries the failing gate output and escalates the model one
    // step per attempt along the configured ladder (rung 0 is the base model).
    // A COMPLEX item starts higher: a large one (many files) or one touching the
    // contract starts one rung above the base (below the top rung when the
    // ladder has two or more), and only a reopened or re-planned item, or one
    // whose first fix already failed, starts on the top rung. Small items keep
    // the cheap base model. The top rung is often a reasoning model whose
    // budget is the likeliest to be spent, so it is kept for proven-hard work.
    const ladder = this.options.escalationModels ?? [];
    const rungs: readonly (string | undefined)[] = [undefined, ...ladder];
    const item = state?.items[itemId];
    const touchesContract = state !== undefined && Object.values(state.contracts).some((c) => c.item === itemId && c.status !== "rejected");
    const topBecause =
      item?.reopenedFrom !== undefined
        ? "it was reopened after another agent's fix budget"
        : item?.replanOf !== undefined
          ? `it re-plans ${item.replanOf}`
          : fix !== undefined && fix.attempt >= 2
            ? "its first fix already failed"
            : undefined;
    const strongerBecause =
      allowed.filter((f) => !hasWildcard(f)).length >= LARGE_ITEM_FILES
        ? `it spans ${allowed.length} files`
        : touchesContract
          ? "it touches the contract"
          : undefined;
    const fixRung = fix !== undefined ? Math.min(fix.attempt, ladder.length) : 0;
    const rung =
      ladder.length === 0
        ? 0
        : topBecause !== undefined
          ? ladder.length
          : Math.max(fixRung, strongerBecause !== undefined ? Math.max(1, ladder.length - 1) : 0);
    const complexBecause = rung > 0 ? (topBecause ?? strongerBecause) : undefined;
    const failure = fix !== undefined && digest.failure && digest.failure.n === fix.n ? digest.failure.output : undefined;
    const regressed = claim.regressed;
    const objective = [
      claim.objective,
      `Instruction: ${instruction}`,
      ...(fix !== undefined
        ? [
            `The integration gate FAILED on revision ${fix.n} and implicated this item (fix attempt ${fix.attempt}).`,
            ...(failure !== undefined ? [`Failing gate output (untrusted data, bounded):\n${bounded(failure, MAX_FIX_EVIDENCE)}`] : []),
          ]
        : []),
      // Arbitration revision 5: the stack scored better without this item's push (push.regressed).
      ...(regressed !== undefined
        ? [
            `Your push ${regressed.commit.slice(0, 10)} made revision ${regressed.rev} WORSE (with it: ${regressed.to}; without it: ${regressed.from}). Remove exactly what it breaks.`,
            ...(regressed.evidence.length > 0 ? [`Failures that go away without your push (untrusted data, bounded):\n${bounded(regressed.evidence.join("\n"), MAX_FIX_EVIDENCE)}`] : []),
          ]
        : []),
    ].join("\n");
    // READ-ONLY references: the files the failure names, the seams and
    // modules the allowed files import, read as this agent sees them.
    const references = await this.referencesFor(allowed, files, worktree, state, [
      ...(failure !== undefined ? [failure] : []),
      ...(regressed?.evidence ?? []),
    ]);
    const executor = this.options.executor;
    const runOn = (model: string | undefined) =>
      executor.execute({
        worktreeDir: worktree,
        workUnitId: itemId,
        objective,
        paths: allowed,
        baselineRef: "HEAD",
        baselineDir: view,
        ...referenceContext(references),
        ...(model !== undefined ? { model } : {}),
      });
    let usedRung = rung;
    let budgetFallbackFrom: string | undefined;
    let result;
    try {
      try {
        result = await runOn(rungs[rung]);
      } catch (error) {
        // A spent completion budget (an empty reply, or one cut off at the
        // ceiling) says nothing about the item: retry the SAME edit once, one
        // rung down. It is recorded as a model failure (evidence and the
        // pushed edit's model record), never charged to the item's failed
        // edits, so it cannot feed the struggling report or a split. The
        // executor writes nothing before it throws one, so nothing is discarded.
        if (!isModelBudgetError(error) || rung === 0) {
          throw error;
        }
        usedRung = rung - 1;
        const spent = rungs[rung] ?? "the base model";
        budgetFallbackFrom = `${spent} (finish_reason: ${error.finishReason})`;
        this.evidence.push(
          bounded(
            `model ${spent} spent its completion budget on ${itemId} (finish_reason: ${error.finishReason}, ceiling ${error.maxTokens ?? "unset"}); ` +
              `retried the same edit once on ${rungs[usedRung] ?? "the base model"} (a model failure, not a failed edit)`,
            400,
          ),
        );
        result = await runOn(rungs[usedRung]);
      }
    } catch (error) {
      await this.discard(worktree, head);
      local("EXECUTOR_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    } finally {
      await rm(view, { recursive: true, force: true });
    }
    const model = rungs[usedRung];
    const tier = usedRung === ladder.length ? "strongest" : "stronger";
    const pushed = await this.commitPushAnnounce(itemId, worktree, head, writeGlobs, result.commitMessage, local, posted, `the edit for ${itemId}`, {
      rationale:
        `(model: ${model ?? "base"}${complexBecause !== undefined && model !== undefined ? `, ${tier}: ${complexBecause}` : ""}` +
        `${budgetFallbackFrom !== undefined ? `, after ${budgetFallbackFrom} spent its budget` : ""})`,
    });
    if (pushed === undefined) {
      return;
    }
    // Every edit records the model it used (and why a complex item got a stronger one).
    this.evidence.push(
      `pushed ${pushed.commit} for ${itemId}: ${pushed.changed.join(", ")} on ${model ?? "the base model"}` +
        (complexBecause !== undefined && model !== undefined ? ` (the ${tier} model: ${complexBecause})` : "") +
        (budgetFallbackFrom !== undefined ? ` (after ${budgetFallbackFrom} spent its budget)` : "") +
        (fix !== undefined ? ` (fix attempt ${fix.attempt} for revision ${fix.n})` : ""),
    );
    this.editModels.push({
      item: itemId,
      commit: pushed.commit,
      model: model ?? "base",
      ...(complexBecause !== undefined ? { why: complexBecause } : {}),
      ...(budgetFallbackFrom !== undefined ? { budgetFallbackFrom } : {}),
    });
  }

  /**
   * Read what changed in the worktree from Git (never from whoever changed
   * it), refuse symlinks, dependency-tree files, and anything outside the
   * write intent, then commit, push to the agent's own repo, and announce the
   * push. A refused announcement rolls the repo back. Returns the commit and
   * the changed paths, or undefined (already recorded) when nothing shipped.
   */
  private async commitPushAnnounce(
    itemId: string,
    worktree: string,
    head: string | undefined,
    writeGlobs: readonly string[],
    message: string,
    local: (code: string, error: string) => void,
    posted: (draft: Record<string, unknown>) => Promise<boolean>,
    what: string,
    extra: { readonly payload?: Record<string, unknown>; readonly allowEmpty?: boolean; readonly rationale?: string; readonly paths?: readonly string[] } = {},
  ): Promise<{ readonly commit: string; readonly changed: readonly string[] } | undefined> {
    // What changed is read from Git's status (never `git add -A`, never the
    // executor's word); only these paths are ever staged, and only after they
    // all lie inside the write intent.
    const changed = await worktreeChanges(worktree);
    if (changed.length === 0 && !extra.allowEmpty) {
      await this.discard(worktree, head);
      local("NO_CHANGE", `${what} changed nothing`);
      return undefined;
    }
    // Never push a symlink or anything inside a dependency or tool tree: the
    // integrator would refuse it, so refuse it here, before it leaves the agent.
    const unsafe: string[] = [];
    for (const rel of changed) {
      if (rel.split("/").some((seg) => seg === "node_modules" || seg === ".git") || /(^|\/)(\.bin|vendor\/bin)\//.test(rel)) {
        unsafe.push(rel);
      } else if ((await lstat(join(worktree, rel)).catch(() => undefined))?.isSymbolicLink()) {
        unsafe.push(rel);
      }
    }
    if (unsafe.length > 0) {
      await this.discard(worktree, head);
      local("UNSAFE_PATH", `${what} wrote symlinks or dependency-tree files, which are never pushed: ${unsafe.join(", ")}`);
      return undefined;
    }
    const { outOfScope } = partitionByScope(changed, writeGlobs);
    if (outOfScope.length > 0) {
      await this.discard(worktree, head);
      this.evidence.push(bounded(`discarded every uncommitted change (reset and clean) because ${what} touched paths outside my write intent: ${outOfScope.join(", ")}`, 500));
      local("OUTSIDE_INTENT", `${what} touched paths outside the write intent: ${outOfScope.join(", ")}`);
      return undefined;
    }
    if (changed.length > 0) {
      await gitOut(worktree, ["add", "--", ...changed.map((p) => `:(literal)${p}`)]);
    }
    const staged = (await gitOut(worktree, ["diff", "--cached", "--name-only", ...(head ? [head] : [])]))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const unexpected = staged.filter((p) => !changed.includes(p));
    if (unexpected.length > 0) {
      await this.discard(worktree, head);
      local("OUTSIDE_INTENT", `the staged change holds paths that were not listed as changed: ${unexpected.join(", ")}`);
      return undefined;
    }
    const identity = this.identity();
    const branch = this.workspace?.defaultBranch ?? "main";
    let commit: string;
    try {
      commit =
        changed.length > 0
          ? await commitStaged(worktree, bounded(`${itemId}: ${message}`, 200), identity)
          : await (async () => {
              await gitOut(worktree, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--no-verify", "-q", "--allow-empty", "-m", bounded(`${itemId}: ${message}`, 200)]);
              return (await gitOut(worktree, ["rev-parse", "HEAD"])).trim();
            })();
      // Never push a commit that carries a symlink inside the write intent
      // (the integrator refuses them, and a sub-lead's mirror could never match).
      const links = (await gitOut(worktree, ["ls-tree", "-r", commit])).split("\n").filter((l) => l.startsWith("120000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
      const inWrite = links.filter((l) => partitionByScope([l], writeGlobs).inScope.length > 0);
      if (inWrite.length > 0) {
        await this.discard(worktree, head);
        local("UNSAFE_PATH", `${what} would push a commit with symlinks inside the write intent, which are never pushed: ${inWrite.join(", ")}`);
        return undefined;
      }
      await push(worktree, this.remote, branch);
    } catch (error) {
      // A push that fails (an expired token, an unreachable repo) is the
      // agent's problem to report, never a crash of the run.
      await this.discard(worktree, head).catch(() => undefined);
      local("PUSH_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return undefined;
    }
    const ok = await posted({
      type: "push.announced",
      payload: { item: itemId, commit, paths: changed.length > 0 ? changed : [...(extra.paths ?? [])], ...(extra.payload ?? {}) },
      rationale: bounded(`pushed ${changed.length} file(s) for ${itemId}${extra.rationale ? ` ${extra.rationale}` : ""}`, 200),
    });
    if (!ok) {
      // The board refused the announcement: put the repo back to the last
      // announced state so it never carries an unannounced push.
      try {
        await this.discard(worktree, head);
        if (head) {
          await gitOut(worktree, ["push", "-q", "--force", this.remote, `${head}:refs/heads/${branch}`]);
        } else {
          await gitOut(worktree, ["update-ref", "-d", "HEAD"]).catch(() => "");
          await gitOut(worktree, ["push", "-q", this.remote, `:refs/heads/${branch}`]);
        }
      } catch {
        // Best-effort: the integrator also checks each repo's head against its
        // latest announced push and excludes a repo that diverged.
      }
      return undefined;
    }
    this.followUp = true;
    return { commit, changed };
  }

  /**
   * Take a help request that GRANTS a sub-scope: the operator forks the
   * requester's repo for this agent (the board checks the grant first), this
   * agent clones the fork (so it starts from the requester's in-progress
   * state), and offers with the fork's lineage: help.offered {forkOf,
   * forkCommit, fork}. The first such offer takes the grant.
   */
  private async offerFork(
    action: Extract<AgentAction, { type: "message" }>,
    digest: BoardDigest,
    local: (code: string, error: string, note?: Record<string, string>) => void,
    posted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
  ): Promise<void> {
    const requestId = action.payload.requestId!;
    const wanted = digest.help!.wanted.find((h) => h.request === requestId)!;
    const note = { request: requestId, to: wanted.by };
    if (!this.options.forkForHelp) {
      local("NOT_ALLOWED", "this run cannot fork repos for help", note);
      return;
    }
    let forked;
    try {
      forked = await this.options.forkForHelp(this.id, requestId);
    } catch (error) {
      local("FORK_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300), note);
      return;
    }
    if (!forked.ok) {
      local(forked.code, forked.error, note);
      return;
    }
    const dir = join(this.options.workRoot, "forks", `${this.id}-${requestId}`.replace(/[^A-Za-z0-9._-]+/g, "-"));
    const remote = authenticatedRemote(forked.gitUrl, forked.token);
    let head: string | undefined;
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dirname(dir), { recursive: true });
      await clone(remote, dir);
      head = (await gitOut(dir, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || undefined;
    } catch (error) {
      local("CLONE_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)).split(forked.token).join("[redacted]"), 300), note);
      return;
    }
    const known = this.requests.get(requestId);
    if (forked.baseMismatch !== undefined) {
      // The fork does not start where the requester is: say so on the board (it takes no grant), never proceed silently.
      await posted(
        {
          type: "help.offered",
          payload: { request: requestId, forkOf: wanted.by, fork: forked.workspaceName, baseMismatch: { expected: forked.baseMismatch.expected, realized: forked.baseMismatch.realized } },
          rationale: `the fork of ${wanted.by}'s repo started at ${forked.baseMismatch.realized}, not at its push ${forked.baseMismatch.expected}: I cannot take this grant from it`,
          ...(known ? { inReplyTo: known.seq } : {}),
          to: [wanted.by],
        },
        note,
      );
      this.evidence.push(`the fork for help request ${requestId} did not start at ${wanted.by}'s push (fork head ${forked.baseMismatch.realized}): recorded, grant not taken`);
      return;
    }
    this.forks.set(requestId, { workspace: forked, remote, dir, requester: wanted.by });
    const ok = await posted(
      {
        type: "help.offered",
        payload: { request: requestId, forkOf: wanted.by, ...(head !== undefined ? { forkCommit: head } : {}), fork: forked.workspaceName },
        rationale: action.rationale,
        ...(known ? { inReplyTo: known.seq } : {}),
        to: [wanted.by],
      },
      note,
    );
    if (ok) {
      this.evidence.push(
        `forked ${wanted.by}'s repo (${forked.workspaceName}) at ${head ?? "its empty state"} for help request ${requestId} on ${wanted.item}: I write only ${wanted.scope.join(", ")}`,
      );
    }
  }

  /**
   * A helper's edit: inside the granted scope only, in its FORK of the
   * requester's repo (reading each file as the requester left it, else the
   * baseline), committed and pushed to the fork, then delivered to the
   * requester (help.delivered) to pull.
   */
  private async helperEdit(
    grant: NonNullable<BoardDigest["help"]>["granted"][number],
    instruction: string,
    local: (code: string, error: string, note?: Record<string, string>) => void,
    posted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
    state?: BoardState,
  ): Promise<void> {
    const note = { request: grant.request };
    const fork = this.forks.get(grant.request);
    if (!fork) {
      local("NO_FORK", `this agent has no fork for help request ${grant.request}`, note);
      return;
    }
    if (!this.options.executor) {
      local("NOT_ALLOWED", `${this.id} has no executor`, note);
      return;
    }
    const worktree = fork.dir;
    const head = (await gitOut(worktree, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || undefined;
    await this.cleanStray(worktree, head, `helping on ${grant.item}`);
    const scope = [...new Set(grant.scope.map(intentPath))];
    const files = [...new Set([...(await listRepoFiles(this.baseDir)), ...(await listRepoFiles(worktree))])].sort();
    const allowed = resolveIntentFiles(scope, files);
    const view = await this.editView(allowed, worktree);
    const references = await this.referencesFor(allowed, files, worktree, state, []);
    try {
      await this.options.executor.execute({
        worktreeDir: worktree,
        workUnitId: grant.item,
        objective: [`Help ${grant.by} on item ${grant.item} (${grant.need}): change only ${grant.scope.join(", ")}.`, `Instruction: ${instruction}`].join("\n"),
        paths: allowed,
        baselineRef: "HEAD",
        baselineDir: view,
        ...referenceContext(references),
      });
    } catch (error) {
      await this.discard(worktree, head);
      local("EXECUTOR_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300), note);
      return;
    } finally {
      await rm(view, { recursive: true, force: true });
    }
    const changed = await worktreeChanges(worktree);
    if (changed.length === 0) {
      local("NO_CHANGE", `the help on ${grant.item} changed nothing`, note);
      return;
    }
    const { outOfScope } = partitionByScope(changed, scope);
    const unsafe = [];
    for (const rel of changed) {
      if (rel.split("/").some((seg) => seg === "node_modules" || seg === ".git") || (await lstat(join(worktree, rel)).catch(() => undefined))?.isSymbolicLink()) {
        unsafe.push(rel);
      }
    }
    if (outOfScope.length > 0 || unsafe.length > 0) {
      await this.discard(worktree, head);
      local("OUTSIDE_INTENT", `the help touched paths outside the granted scope or unsafe paths: ${[...outOfScope, ...unsafe].join(", ")}`, note);
      return;
    }
    let commit: string;
    try {
      await gitOut(worktree, ["add", "--", ...changed.map((p) => `:(literal)${p}`)]);
      commit = await commitStaged(worktree, bounded(`${grant.item}: help ${grant.request} for ${grant.by}`, 200), this.identity());
      await push(worktree, fork.remote, fork.workspace.defaultBranch);
    } catch (error) {
      await this.discard(worktree, head).catch(() => undefined);
      local("PUSH_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)).split(fork.workspace.token).join("[redacted]"), 300), note);
      return;
    }
    const ok = await posted(
      { type: "help.delivered", payload: { request: grant.request, commit, paths: changed }, rationale: bounded(`delivered ${changed.length} file(s) for ${grant.item}; pull ${commit}`, 200), to: [grant.by] },
      note,
    );
    if (ok) {
      this.evidence.push(`delivered ${commit} (${changed.join(", ")}) in my fork for ${grant.by}'s help request ${grant.request}`);
    }
  }

  /**
   * The requester pulls a helper's delivered commit: the operator materializes
   * the helper's fork at that commit, the runtime checks that everything the
   * helper changed since the fork point lies inside the grant, fetches the
   * commit into this agent's own repo and merges it (a fast-forward when
   * nothing else moved), pushes, and announces the push with `pulled`.
   */
  private async pullHelp(
    action: Extract<AgentAction, { type: "pull" }>,
    digest: BoardDigest,
    local: (code: string, error: string, note?: Record<string, string>) => void,
    posted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
  ): Promise<void> {
    const requestId = action.requestId!;
    const note = { request: requestId };
    // A pull that cannot be taken (it changes paths outside the grant, or does
    // not merge) closes the grant with the reason, so the requester is never
    // pinned by work it cannot take: the scope is its own again.
    const fail = async (code: string, error: string): Promise<void> => {
      local(code, error, note);
      if (code === "OUTSIDE_INTENT" || code === "MERGE_FAILED") {
        const outcome = await this.requireClient().post({
          type: "help.closed",
          payload: { request: requestId, reason: "pull-failed", detail: bounded(`${code}: ${error}`, 300) },
        });
        if (outcome.ok) {
          this.evidence.push(`closed help request ${requestId}: the pull failed (${code}); its scope is mine again`);
        }
      }
    };
    const claim = digest.claims.find((c) => c.item === action.itemId);
    const help = digest.help?.mine.find((h) => h.request === requestId && h.item === action.itemId);
    if (!claim || !help) {
      await fail("NOT_OWNER", `${this.id} holds no help request ${requestId} on item ${action.itemId}`);
      return;
    }
    if (help.delivered === undefined || help.grantee === undefined) {
      await fail("INVALID_STATE", `help request ${requestId} has no delivered work to pull yet`);
      return;
    }
    if (!this.options.fetchFork) {
      await fail("NOT_ALLOWED", "this run cannot read help forks");
      return;
    }
    const delivered = help.delivered.commit;
    const from = await this.options.fetchFork(requestId, help.grantee, delivered);
    if (from === undefined) {
      await fail("FETCH_FAILED", `could not read ${help.grantee}'s fork at ${delivered}`);
      return;
    }
    // Never take the helper's word for what it changed: diff its commit
    // against the fork point, and refuse anything outside the grant.
    const scope = [...new Set(help.scope.map(intentPath))];
    const touched = (
      help.forkCommit !== undefined
        ? await gitOut(from, ["diff", "--name-only", help.forkCommit, delivered])
        : await gitOut(from, ["ls-tree", "-r", "--name-only", delivered])
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const { outOfScope } = partitionByScope(touched, scope);
    if (touched.length === 0 || outOfScope.length > 0) {
      await fail("OUTSIDE_INTENT", touched.length === 0 ? `${delivered} changes nothing` : `${delivered} changes paths outside the grant: ${outOfScope.join(", ")}`);
      return;
    }
    let worktree: string;
    try {
      worktree = await this.ensureWorktree();
    } catch (error) {
      await fail("CLONE_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const head = (await gitOut(worktree, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || undefined;
    await this.cleanStray(worktree, head, `pulling ${requestId}`);
    const identity = this.identity();
    try {
      await gitOut(worktree, ["fetch", "-q", from, delivered]);
      if (head) {
        await gitOut(worktree, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "merge", "-q", "--no-edit", "-m", bounded(`${action.itemId}: pull ${requestId} from ${help.grantee}`, 200), delivered]);
      } else {
        await gitOut(worktree, ["reset", "-q", "--hard", delivered]);
      }
    } catch (error) {
      await gitOut(worktree, ["merge", "--abort"]).catch(() => "");
      await this.discard(worktree, head).catch(() => undefined);
      await fail("MERGE_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const commit = (await gitOut(worktree, ["rev-parse", "HEAD"])).trim();
    const links = (await gitOut(worktree, ["ls-tree", "-r", commit])).split("\n").filter((l) => l.startsWith("120000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
    if (links.some((l) => scope.some((g) => matchesGlob(l, g)))) {
      await this.discard(worktree, head).catch(() => undefined);
      if (head) {
        await gitOut(worktree, ["reset", "-q", "--hard", head]).catch(() => "");
      }
      await fail("OUTSIDE_INTENT", `${delivered} carries a symlink inside the grant, which is never pushed`);
      return;
    }
    const paths = (head ? await gitOut(worktree, ["diff", "--name-only", head, commit]) : await gitOut(worktree, ["ls-tree", "-r", "--name-only", commit]))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .sort();
    const branch = this.workspace?.defaultBranch ?? "main";
    const rollback = async (): Promise<void> => {
      if (head) {
        await gitOut(worktree, ["reset", "-q", "--hard", head]).catch(() => "");
        await gitOut(worktree, ["push", "-q", "--force", this.remote, `${head}:refs/heads/${branch}`]).catch(() => "");
      }
    };
    const { outOfScope: beyond } = partitionByScope(paths, [...new Set(claim.intent.write.map(intentPath))]);
    if (beyond.length > 0) {
      await rollback();
      await fail("OUTSIDE_INTENT", `the pull touches paths outside my write intent: ${beyond.join(", ")}`);
      return;
    }
    try {
      await push(worktree, this.remote, branch);
    } catch (error) {
      await rollback();
      await fail("PUSH_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const ok = await posted(
      {
        type: "push.announced",
        payload: { item: action.itemId, commit, paths, pulled: [requestId] },
        rationale: bounded(`pulled ${help.grantee}'s delivered ${delivered} (help ${requestId}) into my repo`, 200),
      },
      note,
    );
    if (!ok) {
      await rollback();
      return;
    }
    this.evidence.push(`pulled ${help.grantee}'s ${delivered} for ${action.itemId} (help ${requestId}): pushed ${commit}`);
  }

  /**
   * The SUB-LEAD's mini-integration: copy each child's latest pushed files
   * (inside that child's write intent only, read with an operator read token)
   * into this agent's own repo, commit, push, and announce ONE push for the
   * split item that `merges` every child push not yet integrated. No gate runs
   * here: the main integration gates the sub-lead's push like any other.
   */
  private async pullChildren(
    action: Extract<AgentAction, { type: "pull" }>,
    digest: BoardDigest,
    state: BoardState,
    local: (code: string, error: string, note?: Record<string, string>) => void,
    posted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
  ): Promise<void> {
    const led = digest.subLead?.find((s) => s.item === action.itemId);
    if (!led) {
      local("NOT_OWNER", `${this.id} is not the sub-lead of a split item ${action.itemId}`);
      return;
    }
    // A push a revision recorded unverified is never merged again at the same
    // commit (its child pushes again first).
    // A child this agent pushed itself integrates directly (never through its
    // own merge), so only other agents' pushes are merged here.
    const pending = led.children.filter((c) => c.lastPush !== undefined && c.lastPush.integratedIn === undefined && c.unverified !== true && c.lastPush.agent !== this.id);
    const fresh = pending.filter((c) => !c.merged);
    if (fresh.length === 0) {
      local("NO_CHANGE", `no child of ${action.itemId} has a push to merge`);
      return;
    }
    if (!this.options.fetchPush) {
      local("NOT_ALLOWED", "this run cannot read other agents' pushes");
      return;
    }
    let worktree: string;
    try {
      worktree = await this.ensureWorktree();
    } catch (error) {
      local("CLONE_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const head = (await gitOut(worktree, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || undefined;
    await this.cleanStray(worktree, head, `merging the children of ${action.itemId}`);
    for (const child of fresh) {
      const from = await this.options.fetchPush(child.lastPush!.agent, child.lastPush!.commit);
      if (from === undefined) {
        await this.discard(worktree, head);
        local("FETCH_FAILED", `could not read ${child.item}'s push ${child.lastPush!.commit}`);
        return;
      }
      // Mirror the child's tree inside its write intent exactly: its files
      // (from Git, never a directory walk) are copied, and a file the child no
      // longer has is removed here too (deletions propagate).
      const childWrite = [...new Set((state.items[child.item]?.intent?.write ?? state.items[child.item]?.scopeHint ?? []).map(intentPath))];
      const inIntent = (out: string) =>
        out
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && childWrite.some((g) => matchesGlob(l, g)));
      // A child's push never carries a symlink (refused at its push); if one
      // does, it is not merged (the integrator would never verify it).
      const links = (await gitOut(from, ["ls-tree", "-r", "HEAD"])).split("\n").filter((l) => l.startsWith("120000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
      if (links.some((l) => childWrite.some((g) => matchesGlob(l, g)))) {
        await this.discard(worktree, head);
        local("UNSAFE_PATH", `${child.item}'s push ${child.lastPush!.commit} carries a symlink inside its write intent; it is not merged`);
        return;
      }
      const theirs = inIntent(await gitOut(from, ["ls-tree", "-r", "--name-only", "HEAD"]));
      const ours = inIntent(await gitOut(worktree, ["ls-files"]).catch(() => ""));
      for (const rel of ours.filter((f) => !theirs.includes(f))) {
        await rm(join(worktree, rel), { force: true });
      }
      for (const rel of theirs) {
        if ((await lstat(join(from, rel)).catch(() => undefined))?.isSymbolicLink()) {
          continue;
        }
        await mkdir(dirname(join(worktree, rel)), { recursive: true });
        await cp(join(from, rel), join(worktree, rel));
      }
    }
    const merges = pending.map((c) => ({ item: c.item, commit: c.lastPush!.commit }));
    // The children's files this merge carries: when the sub-lead also wrote a
    // child (its own repo already holds that content) the merge commit changes
    // nothing new, and announces those files (never an empty push).
    const carried = (await gitOut(worktree, ["ls-files"]).catch(() => ""))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && pending.some((c) => (state.items[c.item]?.intent?.write ?? state.items[c.item]?.scopeHint ?? []).some((w) => matchesGlob(l, intentPath(w)))));
    if ((await worktreeChanges(worktree)).length === 0 && carried.length === 0) {
      local("NO_CHANGE", `the merge of ${action.itemId}'s children carries no file`);
      return;
    }
    const writeGlobs = [...new Set(led.write.map(intentPath))];
    const pushed = await this.commitPushAnnounce(
      action.itemId,
      worktree,
      head,
      writeGlobs,
      `merge ${merges.map((m) => m.item).join(", ")} (sub-lead)`,
      local,
      posted,
      `the merge of ${action.itemId}'s children`,
      { payload: { merges }, allowEmpty: true, paths: carried },
    );
    if (pushed !== undefined) {
      this.evidence.push(`as sub-lead of ${action.itemId}, merged ${merges.map((m) => `${m.item}@${m.commit.slice(0, 10)}`).join(", ")}: pushed ${pushed.commit}`);
    }
  }

  private identity(): GitIdentity {
    return (
      this.options.identity ?? {
        name: `Switchyard Agent ${this.id}`,
        email: `${this.id.replace(/[^A-Za-z0-9._-]+/g, "-")}@agents.switchyard.local`,
      }
    );
  }

  /**
   * Before reading the shared baseline for a change: fetch the latest passing
   * revision once when the board told this agent to rebase (or `always`).
   */
  private async rebaseIfNeeded(digest: BoardDigest, always: boolean): Promise<void> {
    const wanted = always || (digest.rebaseTo !== null && digest.rebaseTo > this.rebasedTo);
    if (wanted && digest.integrated && digest.integrated.n > this.rebasedTo && this.options.fetchRevision) {
      const dir = await this.options.fetchRevision(digest.integrated.n, digest.integrated.commit);
      if (dir !== undefined) {
        this.baseDir = dir;
        this.rebasedTo = digest.integrated.n;
        this.evidence.push(`rebased onto integrated revision ${digest.integrated.n} (${digest.integrated.commit})`);
      }
    }
  }

  /**
   * build_tool: write the tool (its author: the executor live, the template
   * offline) into the tool's own directory of the Change's tools repo, on its
   * own branch, inside the tool item's write intent; commit, push, announce
   * the build (tool.built); then the operator runs the tool's OWN gate and
   * records it. Only a pass is published, by the engine.
   */
  private async buildTool(
    action: Extract<AgentAction, { type: "build_tool" }>,
    digest: BoardDigest,
    state: BoardState,
    local: (code: string, error: string, note?: Record<string, string>) => void,
    posted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
    rebuild = 0,
  ): Promise<void> {
    const capability = action.capability;
    const itemId = toolItemId(capability);
    const claim = digest.claims.find((c) => c.item === itemId);
    const proposal = Object.values(state.tools.proposed).find((t) => t.capability === capability);
    if (!claim || !proposal) {
      local("NOT_OWNER", `${this.id} does not hold the tool item ${itemId}`);
      return;
    }
    const bench = this.options.tools;
    const author = this.options.toolAuthor;
    if (!bench || !author) {
      local("NOT_ALLOWED", "this run has no tool bench: tools cannot be built");
      return;
    }
    const writeGlobs = [...new Set(claim.intent.write.map(intentPath))];
    this.edits += 1;
    const dir = join(this.options.workRoot, "tool-builds", `${this.id.replace(/[^A-Za-z0-9._-]+/g, "-")}-${capability}-${this.edits}`);
    const branch = `refs/heads/${toolBranch(capability)}`;
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dirname(dir), { recursive: true });
      const remote = await bench.remote("write");
      await runGit(["init", "-q", dir]);
      const fetched = await runGit(["-C", dir, "fetch", "-q", remote, branch]).then(() => true, () => false);
      if (fetched) {
        await runGit(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD"]);
      }
      const head = fetched ? (await gitOut(dir, ["rev-parse", "HEAD"])).trim() : undefined;
      // A tool's first build starts from the runtime's skeleton (committed
      // first on the tool's branch): an executor that only makes anchored
      // edits cannot create files, so it completes the skeleton's FILL regions.
      // An unfilled skeleton fails the tool's own gate.
      if (!(await exists(join(dir, "tools", capability, "run.mjs")))) {
        const skeleton = toolSkeleton(proposal.kind, capability, proposal.inputs);
        const written: string[] = [];
        for (const [name, body] of Object.entries(skeleton)) {
          const rel = `tools/${capability}/${name}`;
          await mkdir(dirname(join(dir, rel)), { recursive: true });
          await writeFile(join(dir, rel), body, "utf8");
          written.push(rel);
        }
        await gitOut(dir, ["add", "--", ...written.map((p) => `:(literal)${p}`)]);
        await commitStaged(dir, `${itemId}: skeleton of the ${proposal.kind} ${capability}`, this.identity());
      }
      const gateFailure = this.toolGateFailures.get(capability);
      await author({
        agent: this.id,
        capability,
        kind: proposal.kind,
        inputs: proposal.inputs,
        outputs: proposal.outputs,
        worktreeDir: dir,
        projectDir: this.baseDir,
        goal: this.options.goal,
        ...(gateFailure !== undefined ? { gateFailure } : {}),
      });
      const changed = await worktreeChanges(dir);
      if (changed.length === 0) {
        local("NO_CHANGE", `the build of ${capability} changed nothing`);
        return;
      }
      // One writer per tool path: the build may write only inside the tool
      // item's write intent, itself inside tools/<capability>/.
      const outside = changed.filter((f) => !partitionByScope([f], writeGlobs).inScope.length || !matchesGlob(f, toolScope(capability)));
      if (outside.length > 0) {
        local("OUTSIDE_INTENT", `the build of ${capability} touched paths outside ${toolScope(capability)}: ${outside.join(", ")}`);
        return;
      }
      for (const rel of changed) {
        if ((await lstat(join(dir, rel)).catch(() => undefined))?.isSymbolicLink()) {
          local("UNSAFE_PATH", `the build of ${capability} wrote a symlink (${rel}), which is never pushed`);
          return;
        }
      }
      // Stage exactly the listed in-scope paths (never `git add -A`).
      await gitOut(dir, ["add", "--", ...changed.map((p) => `:(literal)${p}`)]);
      const commit = await commitStaged(dir, `${itemId}: build ${capability}`, this.identity());
      // The build is everything since the last announced build (the skeleton included).
      const paths = (await gitOut(dir, ["diff", "--name-only", head ?? EMPTY_TREE, commit]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .sort();
      const strayPaths = paths.filter((f) => !partitionByScope([f], writeGlobs).inScope.length || !matchesGlob(f, toolScope(capability)));
      if (strayPaths.length > 0) {
        local("OUTSIDE_INTENT", `the build of ${capability} holds paths outside the write intent: ${strayPaths.join(", ")}`);
        return;
      }
      await runGit(["-C", dir, "push", "-q", remote, `HEAD:${branch}`]);
      const ok = await posted(
        { type: "tool.built", payload: { capability, commit, paths }, ...(action.rationale !== undefined ? { rationale: action.rationale } : {}) },
        { capability },
      );
      if (!ok) {
        // A refused announcement: the branch goes back to the last announced build.
        await runGit(["-C", dir, "push", "-q", "--force", remote, head ? `${head}:${branch}` : `:${branch}`]).catch(() => undefined);
        return;
      }
      this.builtTools.add(capability);
      // The operator runs the tool's OWN gate on the original code and records
      // it; the engine publishes only a pass.
      const gated = await bench.gate(await this.requireClient().state(), capability, commit);
      const failed = gated.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`);
      if (gated.passed) {
        this.toolGateFailures.delete(capability);
      } else {
        // The next build (the fix flow) sees exactly what failed.
        this.toolGateFailures.set(capability, bounded([...failed, gated.output ?? ""].filter((l) => l !== "").join("\n"), 4000));
      }
      this.evidence.push(
        gated.passed && gated.version !== undefined
          ? `built ${capability} at ${commit}: its own gate passed; published as ${capability}@${gated.version}`
          : `built ${capability} at ${commit}: its own gate FAILED (${bounded(failed.join("; ") || gated.error || "not recorded", 300)})`,
      );
      this.followUp = true;
      if (!gated.passed) {
        // A failed tool gate is a fix request for the builder: rebuild now,
        // with the failing checks and output, whatever the schedule (no turn
        // model has to think of it). Bounded by the board's fix budget for the
        // tool item (past it the engine reopens the item for another builder).
        const after = await this.requireClient().state();
        const tool = after.items[itemId];
        if (tool?.status === "claimed" && tool.owner === this.id && (tool.toolFailures ?? 0) < after.rules.maxFixAttempts && rebuild + 1 < after.rules.maxFixAttempts) {
          this.evidence.push(`rebuilding ${capability} (rebuild ${rebuild + 1}) with its failing checks`);
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          await this.buildTool(
            { type: "build_tool", capability, rationale: `rebuilding ${capability}: its own gate failed (${bounded(failed.join("; "), 200)})` },
            digest,
            after,
            local,
            posted,
            rebuild + 1,
          );
        }
      }
    } catch (error) {
      local("TOOL_BUILD_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * use_tool: run a PINNED, published tool version over a copy of this
   * agent's own view (the shared baseline, or the revision it rebased onto,
   * with its own pushed files on top), isolated like a gate. A codemod's
   * changes are kept only when they all lie inside the write intent of the
   * item named, then committed, pushed, and announced like an edit; any other
   * tool changes nothing (whatever it wrote in its copy is discarded). The
   * ENGINE records the use (the operator route), never the agent.
   */
  private async useTool(
    action: Extract<AgentAction, { type: "use_tool" }>,
    digest: BoardDigest,
    state: BoardState,
    plainLocal: (code: string, error: string, note?: Record<string, string>) => void,
  ): Promise<void> {
    const turn = this.turns;
    const bench = this.options.tools;
    const note: Record<string, string> = { capability: action.capability, version: action.version, rev: String(digest.integrated?.n ?? 0) };
    const local = (code: string, error: string) => plainLocal(code, error, note);
    if (!bench) {
      local("NOT_ALLOWED", "this run has no tool bench: tools cannot be run");
      return;
    }
    const tool = state.tools.published.find((t) => t.capability === action.capability && t.version === action.version);
    if (!tool) {
      local("UNKNOWN_REF", `${action.capability}@${action.version} is not a published tool version (pin one from board.tools)`);
      return;
    }
    const claim = action.itemId !== undefined ? digest.claims.find((c) => c.item === action.itemId) : undefined;
    if (action.itemId !== undefined && !claim) {
      local("NOT_OWNER", `${this.id} does not hold a granted claim on item ${action.itemId}`);
      return;
    }
    if (tool.kind === "codemod" && !claim) {
      local("BAD_ACTION", "a codemod changes files: name the item you hold (itemId) whose write intent bounds its changes");
      return;
    }
    if (claim) {
      note.item = claim.item;
    }
    // A sweep (no item) reads the latest passing revision; a use on an item
    // reads what this agent's next edit would read.
    await this.rebaseIfNeeded(digest, claim === undefined || claim.fix !== undefined);
    let worktree: string | undefined;
    if (claim) {
      try {
        worktree = await this.ensureWorktree();
      } catch (error) {
        local("CLONE_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
        return;
      }
    }
    // A codemod for an item runs only on that item's files: arguments outside
    // its write intent are dropped (none left: the item's files the tool covers).
    let args = action.args;
    if (tool.kind === "codemod" && claim) {
      const write = [...new Set(claim.intent.write.map(intentPath))];
      const inside = action.args.filter((a) => write.some((w) => matchesGlob(intentPath(a), w)));
      const own = resolveIntentFiles(write, await listRepoFiles(this.baseDir)).filter((f) => !hasWildcard(f));
      args = inside.length > 0 ? inside : own;
      if (args.length !== action.args.length || args.some((a, i) => a !== action.args[i])) {
        note.args = args.join(",").slice(0, 300);
      }
    }
    let ran;
    try {
      ran = await bench.run(state, {
        capability: tool.capability,
        version: tool.version,
        args,
        layers: [this.baseDir, ...(worktree !== undefined ? [worktree] : [])],
      });
    } catch (error) {
      local(error instanceof ToolUseError ? error.code : "TOOL_RUN_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const { result } = ran;
    try {
      if (result.stopped !== undefined || result.exit === null) {
        local("TOOL_STOPPED", bounded(`${tool.capability}@${tool.version} was stopped: ${result.stopped ?? "no exit code"}`, 300));
        return;
      }
      let commit: string | undefined;
      let changedFiles: readonly string[] = [];
      if (tool.kind === "codemod") {
        if (result.exit !== 0) {
          local("TOOL_FAILED", bounded(`${tool.capability}@${tool.version} exited ${result.exit}: ${this.scrub(result.stderr).slice(0, 200)}`, 300));
          return;
        }
        if (result.deleted.length > 0) {
          local("OUTSIDE_INTENT", `the codemod deleted ${result.deleted.slice(0, 5).join(", ")}; a codemod may not delete files`);
          return;
        }
        const touched = [...result.modified, ...result.created];
        const writeGlobs = [...new Set(claim!.intent.write.map(intentPath))];
        const { outOfScope } = partitionByScope(touched, writeGlobs);
        if (outOfScope.length > 0) {
          // Path scope is enforced before anything is kept: the whole run is discarded.
          local("OUTSIDE_INTENT", `the codemod changed paths outside item ${claim!.item}'s write intent: ${outOfScope.slice(0, 8).join(", ")}`);
          return;
        }
        if (touched.length > 0) {
          const head = (await gitOut(worktree!, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || undefined;
          await this.cleanStray(worktree!, head, `applying ${tool.capability}`);
          for (const rel of touched) {
            await mkdir(dirname(join(worktree!, rel)), { recursive: true });
            await writeFile(join(worktree!, rel), await result.read(rel));
          }
          const pushed = await this.commitPushAnnounce(
            claim!.item,
            worktree!,
            head,
            writeGlobs,
            `ran ${tool.capability}@${tool.version}`,
            local,
            async (draft) => {
              const outcome = await this.requireClient().post(draft);
              if (!outcome.ok) {
                this.lastRejection = { code: outcome.code, error: outcome.error, action: action.type };
                this.followUp = true;
                this.record({ turn, action, outcome: "rejected", code: outcome.code, error: outcome.error }, { turn, action, outcome: "rejected", code: outcome.code, error: outcome.error, note });
              }
              return outcome.ok;
            },
            `the codemod ${tool.capability}`,
          );
          if (pushed === undefined) {
            return;
          }
          commit = pushed.commit;
          changedFiles = pushed.changed;
        }
      }
      // Only the engine records a use (through the operator's route).
      const findings = tool.kind === "codemod" ? [] : result.findings;
      const recorded = await bench.recordUse({
        capability: tool.capability,
        version: tool.version,
        by: this.id,
        ...(claim ? { item: claim.item } : {}),
        ...(commit !== undefined ? { commit } : {}),
        changedFiles,
        ...(findings.length > 0 ? { findings } : {}),
        exit: result.exit,
      });
      note.changed = String(changedFiles.length);
      note.findings = String(findings.length);
      const files = [...new Set(findings.map((f) => f.path))];
      if (files.length > 0) {
        note.files = files.slice(0, 32).join(",");
      }
      this.followUp = true;
      if (!recorded.ok) {
        this.lastRejection = { code: recorded.code, error: recorded.error, action: action.type };
        this.record({ turn, action, outcome: "rejected", code: recorded.code, error: recorded.error }, { turn, action, outcome: "rejected", code: recorded.code, error: recorded.error, note });
        return;
      }
      this.record({ turn, action, outcome: "posted", seqs: recorded.appended.map((m) => m.seq) }, { turn, action, outcome: "posted", note });
      this.evidence.push(
        tool.kind === "codemod"
          ? changedFiles.length > 0
            ? `ran ${tool.capability}@${tool.version} for ${claim!.item}: pushed ${commit} changing ${changedFiles.join(", ")}`
            : `ran ${tool.capability}@${tool.version} for ${claim!.item}: it changed nothing in my write intent`
          : `ran ${tool.capability}@${tool.version}: ${findings.length} finding(s)${files.length > 0 ? ` in ${files.slice(0, 8).join(", ")}` : ""} (exit ${result.exit})`,
      );
    } finally {
      await result.dispose();
    }
  }

  /**
   * A budget ran out. A worker's per-item budget on one item releases THAT
   * item (handed to another running worker when the board accepts the
   * handoff, otherwise it asks for help on it) and the worker stays in the
   * pool for other open items: it never acts on that item again, and the
   * MAX_EXHAUSTED_ITEMS-th item it exhausts stops it. Any other budget (the
   * run's, or that last item) records it on the board and stops: each item
   * the agent still holds is released the same way; an agent holding nothing
   * leaves.
   */
  private async exhaust(digest: BoardDigest, reason: AgentStop["reason"], detail: string, item?: string): Promise<void> {
    const client = this.requireClient();
    if (reason === "item-budget" && item !== undefined && this.role === "worker") {
      this.exhaustedItems.add(item);
      if (this.exhaustedItems.size < MAX_EXHAUSTED_ITEMS) {
        const held = digest.claims.some((c) => c.item === item) ? [item] : [];
        if (held.length > 0) {
          await this.release(digest, reason, detail, held);
        } else {
          this.record({ turn: this.turns, action: { type: "wait", reason: detail }, outcome: "local", code: "ITEM_BUDGET", error: detail });
        }
        this.evidence.push(`released item ${item} (${detail}): I never act on it again; I take other open items`);
        this.followUp = true;
        return;
      }
      detail = `${detail}; exhausted ${this.exhaustedItems.size} item(s) (${[...this.exhaustedItems].join(", ")}), at most ${MAX_EXHAUSTED_ITEMS}`;
    }
    this.stop = { reason, detail };
    // An item released earlier (handed off, or help already asked) is not released again.
    const held = digest.claims.filter((c) => !c.doneProposed && (c.item === item || !this.exhaustedItems.has(c.item))).map((c) => c.item);
    if (item !== undefined && !held.includes(item) && digest.claims.some((c) => c.item === item)) {
      held.unshift(item);
    }
    if (held.length === 0) {
      const outcome = await client.post({ type: "agent.left", rationale: `stopping: ${detail}` });
      this.record({
        turn: this.turns,
        action: { type: "wait", reason: detail },
        outcome: outcome.ok ? "posted" : "rejected",
        ...(outcome.ok ? { seqs: outcome.appended.map((m) => m.seq) } : { code: outcome.code, error: outcome.error }),
      });
      return;
    }
    await this.release(digest, reason, detail, held);
  }

  /**
   * Release held items: each is handed to another running worker when the
   * board accepts the handoff, otherwise the agent asks for help on it.
   */
  private async release(digest: BoardDigest, reason: AgentStop["reason"], detail: string, held: readonly string[]): Promise<void> {
    const client = this.requireClient();
    const state = await client.state();
    // A handoff only ever goes to an agent that is still running: one that has
    // stopped (or left) could never act on the item.
    const running = this.options.runningAgents ? new Set(this.options.runningAgents()) : undefined;
    const others = Object.values(state.agents)
      .filter((a) => a.id !== this.id && a.leftSeq === undefined && a.role !== LEAD_ROLE && (!running || running.has(a.id)))
      .map((a) => a.id)
      .sort();
    for (const held1 of held) {
      let recorded = false;
      for (const to of others) {
        const outcome = await client.post({
          type: "handoff",
          payload: {
            item: held1,
            to,
            capsule: {
              repo: this.workspace?.workspaceName ?? this.id,
              ...(digest.claims.find((c) => c.item === held1)?.lastPush
                ? { commit: digest.claims.find((c) => c.item === held1)!.lastPush!.commit }
                : {}),
            },
          },
          rationale: `handing off: ${detail}`,
        });
        if (outcome.ok) {
          this.record({
            turn: this.turns,
            action: { type: "wait", reason: detail },
            outcome: "posted",
            seqs: outcome.appended.map((m) => m.seq),
          });
          recorded = true;
          break;
        }
      }
      if (!recorded) {
        const outcome = await client.post({
          type: "help.requested",
          payload: { request: this.nextId("budget"), item: held1, need: reason === "run-budget" ? "run-budget" : "turn-budget" },
          rationale: `${this.stop ? "stopping" : "releasing it"}: ${detail}; this item needs another agent`,
        });
        this.record({
          turn: this.turns,
          action: { type: "wait", reason: detail },
          outcome: outcome.ok ? "posted" : "rejected",
          ...(outcome.ok ? { seqs: outcome.appended.map((m) => m.seq) } : { code: outcome.code, error: outcome.error }),
        });
      }
    }
  }
}

/** The executor context fields for an edit's read-only reference files (none: nothing, so the prompt is unchanged). */
function referenceContext(references: readonly ReferenceFile[]): { frozenContracts?: string[]; frozenContractFiles?: ReferenceFile[]; boardReferences?: true } {
  return references.length > 0 ? { frozenContracts: references.map((r) => r.path), frozenContractFiles: [...references], boardReferences: true } : {};
}

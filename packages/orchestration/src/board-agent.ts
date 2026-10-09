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

import { cp, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  hasWildcard,
  intentPath,
  isAcceptedItem,
  LEAD_ROLE,
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
import { AGENT_ACTION_TYPES } from "@switchyard-change/model-adapters";
import { runGit } from "@switchyard-change/artifact-workspace/git-transport";
import { authenticatedRemote, clone, commitAll, push, type GitIdentity } from "@switchyard-change/local-runner";
import { matchesGlob, partitionByScope } from "@switchyard-change/verification";

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
   * The ordered escalation models for fix attempts: fix attempt k on an item
   * runs on escalationModels[k - 1] (clamped to the last entry). Empty keeps
   * every attempt on the executor's own base model.
   */
  readonly escalationModels?: readonly string[];
  readonly onTurn?: (record: AgentTurnRecord) => void;
  /** How many of the agent's past turns its capsule carries (default 12). */
  readonly historyLimit?: number;
}

/** The action types each role may return. */
const LEAD_ACTIONS: readonly AgentActionType[] = ["decide_contract", "decide_item", "propose_item", "message", "wait"];
const WORKER_ACTIONS: readonly AgentActionType[] = AGENT_ACTION_TYPES.filter((t) => t !== "decide_contract" && t !== "decide_item");

/** Message types that matter to an agent only while it is free to take new work. */
const NEW_WORK_TYPES: ReadonlySet<string> = new Set(["item.proposed", "item.accepted", "item.discovered", "item.split"]);
/** Board-wide messages that are context, never a reason by themselves to take a turn. */
const CONTEXT_ONLY_TYPES: ReadonlySet<string> = new Set([
  "goal.posted",
  "integrated.rev",
  "contract.proposed",
  "contract.accepted",
  "contract.rejected",
  "tool.published",
  "item.completed",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".wrangler"]);
const MAX_LISTED_FILES = 2000;
const MAX_EXCERPTS = 6;
const MAX_EXCERPT_CHARS = 3000;
const MAX_PENDING_MESSAGES = 200;
/**
 * How many times a passed push is cued for propose_done if the agent ignores
 * it. The last cue says plainly that the item cannot complete otherwise: the
 * engine never proposes done on an agent's behalf.
 */
export const MAX_DONE_CUES = 5;
/** The failing gate output a fix edit hands the executor, in characters. */
const MAX_FIX_EVIDENCE = 4000;

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
    default:
      return undefined;
  }
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
  /** True while a step is running (the driver's quiescence check reads it). */
  private stepping = false;
  /** Lead: the undecided worker proposals it last saw (a change wakes it). */
  private lastProposals = "";

  constructor(private readonly options: BoardAgentOptions) {
    this.id = options.id;
    this.role = options.role;
    this.baseDir = options.projectDir;
  }

  /** Why the agent stopped, if it did. */
  get stopped(): AgentStop | undefined {
    return this.stop;
  }

  /** True while the agent is observing or acting (not idle between steps). */
  get busy(): boolean {
    return this.stepping;
  }

  /** The agent's workspace (its own repo), once joined. */
  get joinedWorkspace(): JoinedWorkspace | undefined {
    return this.workspace;
  }

  /** The authenticated push/clone remote of the agent's repo ("" before joining). */
  get repoRemote(): string {
    return this.remote;
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
      if (m.type === "handoff" && m.payload.to === this.id && m.payload.capsule.commit !== undefined) {
        this.inherited.set(m.payload.item, { from: m.from, commit: m.payload.capsule.commit, seeded: false });
      }
      // A reopened item (its owner spent the fix budget): whoever claims it
      // next starts from the previous owner's latest push.
      if (m.type === "item.reopened" && m.payload.previousOwner !== this.id && m.payload.commit !== undefined) {
        this.inherited.set(m.payload.item, { from: m.payload.previousOwner, commit: m.payload.commit, seeded: false });
      }
    }

    if (this.role === "lead") {
      if (!this.seeded) {
        await this.seedTurn();
        return "acted";
      }
      const state = await client.state();
      const undecided = Object.values(state.contracts).some((c) => c.status === "proposed");
      const addressed = fresh.some((m) => m.to?.includes(this.id));
      // Workers' proposals wait for the lead: a new undecided set is a reason to take a turn.
      const proposals = Object.values(state.items)
        .filter((i) => i.status === "proposed")
        .map((i) => i.id)
        .join(",");
      const newProposals = proposals !== "" && proposals !== this.lastProposals;
      this.lastProposals = proposals;
      if (!(this.followUp || addressed || newProposals || (undecided && fresh.some((m) => m.type === "contract.proposed")))) {
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
    const freeKey = free && digest.openItems.length > 0 ? digest.openItems.map((i) => i.item).join(",") : undefined;
    const relevant = fresh.some((m) => {
      if (m.to?.includes(this.id)) {
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
    if (!(this.followUp || relevant || nudged || (freeKey !== undefined && freeKey !== this.lastFreeKey))) {
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
   * Keep stepping until halted, sleeping with backoff while idle (the live,
   * concurrent schedule). A thrown step stops the agent with the reason.
   */
  async run(options: { readonly signal: AbortSignal; readonly minPollMs?: number; readonly maxPollMs?: number }): Promise<void> {
    const min = options.minPollMs ?? 250;
    const max = options.maxPollMs ?? 4000;
    let wait = min;
    while (!options.signal.aborted && !this.stop) {
      let result: AgentStepResult;
      try {
        result = await this.step();
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

  /** Free: every claim it holds has a done proposal and no fix request, and no claim is pending. */
  private isFree(digest: BoardDigest): boolean {
    return digest.pending.length === 0 && digest.claims.every((c) => c.doneProposed && c.fix === undefined);
  }

  private record(entry: Omit<AgentTurnRecord, "agent">, history?: AgentTurnHistoryEntry): void {
    this.options.onTurn?.({ agent: this.id, ...entry });
    if (history) {
      this.history.push(history);
      const limit = this.options.historyLimit ?? 12;
      if (this.history.length > limit) {
        this.history = this.history.slice(-limit);
      }
    }
  }

  /** The lead's first turn: the planner's decomposition becomes proposed items. */
  private async seedTurn(): Promise<void> {
    if (!this.options.seed) {
      throw new Error(`${this.id} is the lead but has no planner seed`);
    }
    this.seeded = true;
    this.turns += 1;
    this.options.runBudget.used += 1;
    const items = await this.options.seed();
    const client = this.requireClient();
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
    this.followUp = false;
  }

  /** Build the turn input, ask the transport, and act on the one action it returns. */
  private async turn(digest: BoardDigest, state: BoardState): Promise<void> {
    const budget = this.options.runBudget;
    if (budget.exhausted) {
      await this.exhaust(digest, "run-budget", `the run's turn budget (${budget.maxTurns}) is spent`);
      return;
    }
    budget.used += 1;
    this.turns += 1;
    const input = await this.turnInput(digest, state);
    const outcome = await this.options.transport(input);
    const action = outcome.action;
    this.pending = [];
    this.followUp = false;
    this.lastRejection = undefined;

    const item = actionItem(action, digest);
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
  }

  private async turnInput(digest: BoardDigest, state: BoardState): Promise<AgentTurnInput<BoardDigest, BoardMessage>> {
    const liveClaims = Object.values(state.items)
      .filter((i) => i.status === "claimed" && i.owner !== undefined && i.intent)
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
      }));
    // The lead decides workers' proposals against the items already on the Change.
    const lead = this.role === "lead";
    const pendingItems = lead
      ? Object.values(state.items)
          .filter((i) => i.status === "proposed")
          .map((i) => ({ item: i.id, objective: i.objective, scopeHint: [...i.scopeHint], proposedBy: i.proposedBy }))
      : [];
    const acceptedItems = lead
      ? Object.values(state.items)
          .filter((i) => isAcceptedItem(i))
          .slice(0, 200)
          .map((i) => ({ item: i.id, objective: i.objective, scopeHint: [...i.scopeHint], status: i.status }))
      : [];
    const files = await listRepoFiles(this.baseDir);
    const excerpts = await this.excerpts(digest, files);
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
      board: { liveClaims, pendingContracts, ...(lead ? { pendingItems, items: acceptedItems } : {}) },
      repo: { files, excerpts },
      ...(this.lastRejection ? { lastRejection: this.lastRejection } : {}),
      allowed: this.role === "lead" ? LEAD_ACTIONS : WORKER_ACTIONS,
    };
  }

  /** Bounded file contents inside the agent's intents (or the open items it may claim). */
  private async excerpts(digest: BoardDigest, files: readonly string[]): Promise<AgentRepoExcerpt[]> {
    const entries =
      digest.claims.length > 0
        ? digest.claims.flatMap((c) => [...c.intent.write, ...c.intent.read])
        : digest.openItems.flatMap((i) => i.scopeHint);
    const out: AgentRepoExcerpt[] = [];
    for (const path of resolveIntentFiles(entries, files)) {
      if (out.length >= MAX_EXCERPTS || hasWildcard(path)) {
        continue;
      }
      const contents = await this.readCurrent(path);
      if (contents !== undefined) {
        out.push({ path, contents: bounded(contents, MAX_EXCERPT_CHARS) });
      }
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
    if (token) {
      out = out.split(token).join("[redacted]").split(encodeURIComponent(token)).join("[redacted]");
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
      case "wait":
        this.record(
          { turn, action, outcome: "local", ...(invalid !== undefined ? { invalid } : {}) },
          { turn, action, outcome: "local" },
        );
        return;
      case "claim":
        await posted({ type: "item.claimed", payload: { item: action.itemId, intent: action.intent }, ...rationale(action.rationale) });
        return;
      case "propose_item":
        await posted({
          type: "item.proposed",
          payload: {
            item: this.nextId("item"),
            objective: action.objective,
            acceptance: action.acceptance,
            scopeHint: action.scopeHint,
          },
          ...rationale(action.rationale),
        });
        return;
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
        await this.message(action, posted);
        return;
      case "edit":
        await this.edit(action.itemId, action.instruction, digest, local, posted);
        return;
      case "propose_done": {
        const claim = digest.claims.find((c) => c.item === action.itemId);
        await posted({
          type: "done.proposed",
          payload: { item: action.itemId, ...(claim?.lastPush ? { commit: claim.lastPush.commit } : {}) },
          ...rationale(action.rationale),
        });
        return;
      }
      case "propose_tool":
        await posted({
          type: "tool.proposed",
          payload: { tool: this.nextId("tool"), capability: action.capability, inputs: [], outputs: [] },
          rationale: action.why,
        });
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
      case "decide_contract":
        if (this.role !== "lead" || !state.agents[this.id]) {
          local("NOT_ALLOWED", "only the lead decides contracts");
          return;
        }
        await posted({
          type: action.decision === "accept" ? "contract.accepted" : "contract.rejected",
          payload: { contract: action.contractId },
          ...rationale(action.rationale),
        });
        return;
    }
  }

  private async message(
    action: Extract<AgentAction, { type: "message" }>,
    posted: (draft: Record<string, unknown>, note?: Record<string, string>) => Promise<boolean>,
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
            payload: { request: this.nextId(action.kind), item: p.itemId, need: p.need ?? action.kind },
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
            payload: { contract: this.nextId("contract"), target: p.target, kind: p.change, ...(p.itemId !== undefined ? { item: p.itemId } : {}) },
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
  ): Promise<void> {
    const claim = digest.claims.find((c) => c.item === itemId);
    if (!claim) {
      plainLocal("NOT_OWNER", `${this.id} does not hold a granted claim on item ${itemId}`);
      return;
    }
    // An edit answering a fix request remembers which revision it answers.
    const fixNote = claim.fix !== undefined ? { fix: String(claim.fix.n) } : undefined;
    const local = (code: string, error: string): void => plainLocal(code, error, fixNote);
    const posted = (draft: Record<string, unknown>): Promise<boolean> => plainPosted(draft, fixNote);
    if (!this.options.executor) {
      local("NOT_ALLOWED", `${this.id} has no executor`);
      return;
    }
    // A passing integrated revision changed something this agent reads or
    // writes (or a failing revision asks this agent for a fix): fetch the latest
    // passing revision once, before this edit, and read from it from now on.
    const fix = claim.fix;
    const wantsRebase = (digest.rebaseTo !== null && digest.rebaseTo > this.rebasedTo) || fix !== undefined;
    if (wantsRebase && digest.integrated && digest.integrated.n > this.rebasedTo && this.options.fetchRevision) {
      const dir = await this.options.fetchRevision(digest.integrated.n, digest.integrated.commit);
      if (dir !== undefined) {
        this.baseDir = dir;
        this.rebasedTo = digest.integrated.n;
        this.evidence.push(`rebased onto integrated revision ${digest.integrated.n} (${digest.integrated.commit})`);
      }
    }
    let worktree: string;
    try {
      worktree = await this.ensureWorktree();
    } catch (error) {
      local("CLONE_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const head = (await gitOut(worktree, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || undefined;
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
    const allowed = resolveIntentFiles(writeGlobs, files);
    const view = await this.editView(allowed, worktree);

    // A fix attempt carries the failing gate output and escalates the model one
    // step per attempt along the configured ladder.
    const ladder = this.options.escalationModels ?? [];
    const model = fix !== undefined && ladder.length > 0 ? ladder[Math.min(fix.attempt, ladder.length) - 1] : undefined;
    const failure = fix !== undefined && digest.failure && digest.failure.n === fix.n ? digest.failure.output : undefined;
    const objective = [
      claim.objective,
      `Instruction: ${instruction}`,
      ...(fix !== undefined
        ? [
            `The integration gate FAILED on revision ${fix.n} and implicated this item (fix attempt ${fix.attempt}).`,
            ...(failure !== undefined ? [`Failing gate output (untrusted data, bounded):\n${bounded(failure, MAX_FIX_EVIDENCE)}`] : []),
          ]
        : []),
    ].join("\n");
    let result;
    try {
      result = await this.options.executor.execute({
        worktreeDir: worktree,
        workUnitId: itemId,
        objective,
        paths: allowed,
        baselineRef: "HEAD",
        baselineDir: view,
        ...(model !== undefined ? { model } : {}),
      });
    } catch (error) {
      await this.discard(worktree, head);
      local("EXECUTOR_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    } finally {
      await rm(view, { recursive: true, force: true });
    }

    // What actually changed is read from Git, not taken from the executor.
    await gitOut(worktree, ["add", "-A"]);
    const changed = (await gitOut(worktree, ["diff", "--cached", "--name-only", ...(head ? [head] : [])]))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .sort();
    if (changed.length === 0) {
      await this.discard(worktree, head);
      local("NO_CHANGE", `the edit for ${itemId} changed nothing`);
      return;
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
      local("UNSAFE_PATH", `the edit wrote symlinks or dependency-tree files, which are never pushed: ${unsafe.join(", ")}`);
      return;
    }
    const { outOfScope } = partitionByScope(changed, writeGlobs);
    if (outOfScope.length > 0) {
      await this.discard(worktree, head);
      local("OUTSIDE_INTENT", `the edit touched paths outside the write intent: ${outOfScope.join(", ")}`);
      return;
    }
    const identity = this.options.identity ?? {
      name: `Switchyard Agent ${this.id}`,
      email: `${this.id.replace(/[^A-Za-z0-9._-]+/g, "-")}@agents.switchyard.local`,
    };
    const branch = this.workspace?.defaultBranch ?? "main";
    let commit: string;
    try {
      commit = await commitAll(worktree, bounded(`${itemId}: ${result.commitMessage}`, 200), identity);
      await push(worktree, this.remote, branch);
    } catch (error) {
      // A push that fails (an expired token, an unreachable repo) is the
      // agent's problem to report, never a crash of the run.
      await this.discard(worktree, head).catch(() => undefined);
      local("PUSH_FAILED", bounded(this.scrub(error instanceof Error ? error.message : String(error)), 300));
      return;
    }
    const ok = await posted({
      type: "push.announced",
      payload: { item: itemId, commit, paths: changed },
      rationale: bounded(`pushed ${changed.length} file(s) for ${itemId}`, 200),
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
      return;
    }
    this.followUp = true;
    this.evidence.push(
      `pushed ${commit} for ${itemId}: ${changed.join(", ")}` +
        (fix !== undefined ? ` (fix attempt ${fix.attempt} for revision ${fix.n}${model !== undefined ? ` on ${model}` : ""})` : ""),
    );
  }

  /**
   * A budget ran out: record it on the board and stop. Each item the agent
   * still holds is handed to another active worker when the board accepts the
   * handoff, otherwise it asks for help on it; an agent holding nothing leaves.
   */
  private async exhaust(digest: BoardDigest, reason: AgentStop["reason"], detail: string, item?: string): Promise<void> {
    const client = this.requireClient();
    this.stop = { reason, detail };
    const held = digest.claims.filter((c) => !c.doneProposed).map((c) => c.item);
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
          rationale: `stopping: ${detail}; this item needs another agent`,
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

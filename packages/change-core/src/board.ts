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
  /**
   * Unfinished items one agent may hold at once (absent: unlimited). An item
   * is unfinished until its owner's latest push passed an integrated revision;
   * under arbitration revision 3, until that push was GATED (pass or fail)
   * with no fix owed (see waitingOnOthers). Seam items (accepted seam
   * contracts) and tool items are exempt: the cap stops hoarding, never the
   * fix or tool a held item needs.
   */
  readonly maxActiveClaims?: number;
  /**
   * The CLAIM LEASE, in board messages (absent: claims never lapse). A claim
   * stays live while its holder makes real progress on the item: a push for
   * it, a board message of the holder's that names it (struggling, a help
   * request, a contract for it, a handoff, done), its push being gated, or a
   * delivery by a granted helper. Messages elsewhere never renew it. A claim
   * with no progress for this many messages LAPSES (claim.lapsed): the item
   * is open again. Never while the holder's push waits for the gate, a
   * contract for the item waits for a decision, a helper holds a grant on it,
   * or the item waits on a seam change.
   */
  readonly claimLeaseMessages?: number;
  /**
   * The firm DEADLINE of a claim, in board messages from its grant (absent:
   * none). Progress never renews it: the lead extends it (claim.extended, with
   * a reason, at most BOARD_LIMITS.maxClaimExtensions times) or the claim
   * lapses at it. Set generously: normal work never reaches it.
   */
  readonly claimDeadlineMessages?: number;
  /**
   * OVERLAP ADVICE (absent: none). A claim granted on an item whose
   * planner-declared scope overlaps the scope of an item another agent holds
   * is recorded (claim.overlap, addressed to both: advisory, never a refusal),
   * except that a claim writing a shared seam another holder's scope covers is
   * refused (SEAM_OVERLAP): the seam contract route settles a shared seam.
   */
  readonly claimOverlap?: boolean;
  /**
   * SPECULATIVE BATCH GATING (absent: 1, no speculation). With K > 1 the
   * local integrator orders the pending pushes and gates up to K prefix
   * candidates of them on the integrated head (base + p1, base + p1 + p2,
   * ...), lands the longest passing prefix as one revision, and blames only
   * the push whose candidate failed after a passing one (candidate.gated).
   * The cloud integrator gates one revision at a time: a goal that integrates
   * on Cloudflare refuses K > 1. At most BOARD_LIMITS.maxSpeculate.
   */
  readonly speculate?: number;
  /**
   * The engine's ARBITRATION revision (absent: 1, how every board before it
   * was arbitrated, so a recorded log replays exactly as it was recorded).
   * Revision 2:
   *   - a different agent granted (or handed) an item starts with a fresh fix
   *     budget, whatever released the previous holder;
   *   - a claim's deadline is not charged for the time its push waited for
   *     the gate, and a fix request leaves its holder at least one lease
   *     window before the deadline;
   *   - the lease, deadline, lapse cooldown, contest idle, seam wait, and help
   *     wait clocks count PARTICIPANT messages only (never engine records such
   *     as clash predictions, candidates, or token refreshes).
   * Revision 3 (what a new run posts) adds WAITING ON OTHERS: an item whose
   * holder's latest push was gated in a revision (pass or fail) and is not
   * owed a fix (no fix request, not excluded, not implicated by that
   * revision) waits on the other items, not on its holder:
   *   - it no longer counts against the holder's claim cap (maxActiveClaims),
   *     so the holder may take another item;
   *   - its claim does not lapse for NO PROGRESS while it waits (the firm
   *     deadline still applies).
   * The local integrator, under it, implicates no merged item when a failing
   * gate's output maps only to items not in the revision (see
   * failure-attribution's "outstanding" source).
   * Revision 4 (what a new run posts) adds NOBODY ELSE CAN TAKE IT: a claim
   * that lapsed as STALLED on a quiet board does not bar its holder from
   * claiming it again when no other active worker could take it (every other
   * active worker not barred from the item is at its claim cap, or there is
   * none): the cooldown exists so another agent gets it first, and nobody can.
   * Revision 5 (what a new run posts) adds the PRE-PASS PROGRESS RATCHET:
   * before the first passing revision, the best-scoring failing revision (see
   * prePassRatchet) is the best so far. A stack of every latest push that
   * scores worse than it is checked LEAVE-ONE-OUT (the stack without one new
   * push, or without a seam push together with the pushes that import its
   * seam); a push whose removal makes the stack score strictly better is
   * recorded `push.regressed` (addressed to its holder) and is not stacked
   * again until its holder pushes again. Pushes that only work together are
   * never blamed: every other latest push is stacked as before. The ratchet
   * never moves the integrated head, never promotes, and never changes a
   * verdict: only a passing revision does.
   * Revision 6 (what a new run posts) adds SETTLED SEAM ITEMS and ADDRESSED
   * QUESTIONS:
   *   - a seam item (an accepted seam contract's item) whose latest push was
   *     gated with no fix owed (it waits on others) no longer owns its seam:
   *     a follow-up change to that seam is a seam contract the lead decides,
   *     never refused as "ask its owner";
   *   - a seam contract records the type-mismatch lines of the failing output
   *     it was proposed for (`failingErrors`), so a rejected one is not cued
   *     again for the identical errors;
   *   - a plain question (help.requested with no scope) records whom it asks
   *     (`askedOf`), and the addressee's digest lists it until answered.
   * Revision 7 (what a new run posts) adds ONE WRITER PER RELEASED TEST and
   * ONE CHARGE PER UNANSWERED PUSH:
   *   - a contract of any kind on a protected target another LIVE holder
   *     holds (see releaseHolder: claimed by an active owner, not escalated,
   *     fix budget not spent; outside the asking item's lineage through
   *     splits, re-plans, and merges) is refused TARGET_RELEASED, naming that
   *     item, so two agents never write the same protected file
   *     unarbitrated; so is a proposal while another live item's contract on
   *     the target is pending, and an acceptance once another live holder
   *     holds it;
   *   - a later accepted contract supersedes an earlier release of an
   *     overlapping target held outside its lineage, but never under a push
   *     of the earlier holder (live or not, such as an escalated one) that
   *     changes the target and is not integrated yet: accepting a guarded
   *     contract on it is refused TARGET_RELEASED until that push is
   *     integrated or left out;
   *   - a child of a split or re-planned item, or a merge's replacement,
   *     inherits an ancestor's release only as its HEIR (at each step, the
   *     first child in order whose scope hint covers the target);
   *   - a failing revision does not charge a fix attempt again to an item
   *     whose fix request is still unanswered (no push since).
   */
  readonly arbitration?: number;
}

/** The arbitration revision a new board run posts (see BoardRules.arbitration). */
export const CURRENT_ARBITRATION = 7;

export const DEFAULT_BOARD_RULES: BoardRules = { maxContestTurns: 3, contestIdleMessages: 25, maxFixAttempts: 2 };

/** Hard bounds that keep a board's work and storage finite. */
export const BOARD_LIMITS = {
  /** Messages per Change board (a batch reserve keeps engine batches whole). */
  maxMessages: 20000,
  batchReserve: 512,
  maxItems: 1000,
  /**
   * Agents that may join one board over its whole life (the lead, every
   * worker, and every replacement for a worker that stopped). An admission
   * bound only: it never changes how a recorded log folds.
   */
  maxAgents: 256,
  maxChildren: 32,
  maxIntentEntries: 64,
  /**
   * Pushes one integrated revision may merge, and items its failing evidence
   * may name (a wide pool's pushes can all land in one revision). A bound on
   * what a message may carry only: it never changes how a recorded log folds.
   */
  maxRevisionPushes: 256,
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
  /**
   * Board messages a help request that grants a sub-scope stays live without a
   * helper (from the request), and a granted helper has to deliver (from its
   * offer), before the grant lapses and the requester may write the scope again.
   */
  helpWaitMessages: 60,
  /** item.struggling reports per item and owner, and volunteers per agent and item. */
  maxStruggleReports: 3,
  /** Sub-lead pushes that may merge one child's push. */
  maxChildMerges: 3,
  /**
   * Board messages a dependent item waits for a seam-changing item's PROGRESS
   * (its grant or its latest push) before it proceeds anyway: a seam item that
   * stops moving stops holding anyone.
   */
  seamWaitMessages: 60,
  /** Times the lead may extend one claim's deadline (claim.extended). */
  maxClaimExtensions: 2,
  /** Quoted failure lines one push.regressed may carry, and the characters of each. */
  maxRegressionEvidence: 8,
  maxRegressionEvidenceLine: 300,
  /** Prefix candidates one speculative integration round may gate (the speculate rule's bound). */
  maxSpeculate: 8,
  /** Characters of an integration.phase detail (a short, bounded line: never gate output). */
  maxIntegrationDetail: 160,
  /**
   * Stall releases (lapsed claims, released seam stalls) after which an item
   * is not released again by a quiet board: it is the lead's to re-plan.
   */
  stallReleasesBeforeReplan: 2,
  /** Seam contracts one agent may have waiting for the lead at once. */
  maxPendingSeamContractsPerAgent: 1,
  /** Seam contracts a Change may have waiting for the lead at once. */
  maxPendingSeamContracts: 3,
  maxVolunteers: 2,
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

/** The longest description a contract carries (a seam contract's needed change). */
const MAX_CONTRACT_DESCRIPTION = 400;
/** The id of the seam item an accepted seam contract becomes. */
export function seamItemId(contract: string): string {
  return `seam-${contract}`;
}

/** What an agent will read and write. Entries are paths, globs, or `path#symbol`. */
export interface BoardIntent {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** A shared seam and the files that import it. */
export interface BoardSeam {
  readonly path: string;
  readonly importers: readonly string[];
  /** The names the seam exports (types, functions, constants), bounded: a type error naming one points at this seam. */
  readonly symbols?: readonly string[];
}

/** How many of the gate's checks passed on a revision (advisory). */
export interface BoardRevProgress {
  /** All suites of the run, summed. */
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  /** Per suite in run order; `suite` labels the acceptance suite (its files are in the immutable gate) and developer suites. */
  readonly suites?: readonly { readonly passed: number; readonly failed: number; readonly total: number; readonly suite?: "acceptance" | "developer" }[];
  /** The acceptance suite's own counts, when it ran and was recognized. */
  readonly acceptance?: { readonly passed: number; readonly failed: number; readonly total: number };
  /** Why the acceptance suite has no count on this revision (`typecheck failed (1 error)`). */
  readonly acceptanceNotRun?: string;
}

/**
 * The headline count of a revision's progress: the acceptance suite's own when
 * it was recognized, else all suites summed (`acceptance: false`). Undefined
 * when the acceptance suite did not run (there is no number to compare).
 */
export function progressHeadline(p: BoardRevProgress): { readonly passed: number; readonly total: number; readonly acceptance: boolean } | undefined {
  if (p.acceptance !== undefined) {
    return { passed: p.acceptance.passed, total: p.acceptance.total, acceptance: true };
  }
  if (p.acceptanceNotRun !== undefined) {
    return undefined;
  }
  return { passed: p.passed, total: p.total, acceptance: false };
}

/** One line for a revision's advisory progress (`acceptance 40/129 passing; developer 9/9`). */
export function describeProgress(p: BoardRevProgress): string {
  const developer = (p.suites ?? []).filter((s) => s.suite === "developer");
  const dev =
    developer.length > 0
      ? `developer ${developer.reduce((n, s) => n + s.passed, 0)}/${developer.reduce((n, s) => n + s.total, 0)}`
      : undefined;
  if (p.acceptance !== undefined) {
    return `acceptance ${p.acceptance.passed}/${p.acceptance.total} passing${dev ? `; ${dev}` : ""}`;
  }
  if (p.acceptanceNotRun !== undefined) {
    return `acceptance suite did not run: ${p.acceptanceNotRun}${dev ? ` (${dev})` : ""}`;
  }
  return `${p.passed}/${p.total} checks passing`;
}

/**
 * A revision's PROGRESS SCORE, read from its advisory progress record (under
 * arbitration revision 5 it orders the failing revisions before the first
 * pass; see compareProgressScore). Never a verdict: only the gate decides.
 */
export interface BoardProgressScore {
  /** The acceptance suite ran (or, with no acceptance gate known, the gate's checks ran). */
  readonly runs: boolean;
  /** Acceptance tests passing (with no acceptance gate known: the gate's checks passing). */
  readonly acceptance: number;
  /** The acceptance suite's total, when it ran (for display). */
  readonly acceptanceTotal?: number;
  /** Developer-suite tests passing. */
  readonly developer: number;
  /** Type errors when the acceptance suite did not run because the typecheck failed (else 0). */
  readonly typeErrors: number;
}

/**
 * The progress score of a revision's progress record, or undefined when it
 * carries nothing comparable (no record, or a record with no count and no
 * stated reason). Pure.
 */
export function progressScore(p: BoardRevProgress | undefined): BoardProgressScore | undefined {
  if (p === undefined) {
    return undefined;
  }
  const developerSuites = (p.suites ?? []).filter((s) => s.suite === "developer");
  const developer = developerSuites.reduce((n, s) => n + s.passed, 0);
  if (p.acceptance !== undefined) {
    return { runs: true, acceptance: p.acceptance.passed, acceptanceTotal: p.acceptance.total, developer, typeErrors: 0 };
  }
  if (p.acceptanceNotRun !== undefined) {
    const errors = /typecheck failed \((\d+) errors?\)/.exec(p.acceptanceNotRun);
    return { runs: false, acceptance: 0, developer, typeErrors: errors ? Number(errors[1]) : 0 };
  }
  if (p.total === 0) {
    return undefined;
  }
  // No acceptance gate is known: the gate's own checks (minus labeled developer suites) stand in.
  const checks = p.passed - developer;
  return { runs: true, acceptance: checks, acceptanceTotal: p.total - developerSuites.reduce((n, s) => n + s.total, 0), developer, typeErrors: 0 };
}

/**
 * The TOTAL ORDER of progress scores: a tree that runs the acceptance suite
 * beats one that does not; then more acceptance passes; then more developer
 * passes; then fewer type errors. Negative when `a` is worse than `b`, zero
 * when they tie, positive when `a` is better. Pure.
 */
export function compareProgressScore(a: BoardProgressScore, b: BoardProgressScore): number {
  if (a.runs !== b.runs) {
    return a.runs ? 1 : -1;
  }
  return a.acceptance - b.acceptance || a.developer - b.developer || b.typeErrors - a.typeErrors;
}

/** One line for a progress score (`acceptance 51/129`, `22 type errors`). Never styled as a verdict. */
export function describeProgressScore(s: BoardProgressScore): string {
  if (s.runs) {
    return `acceptance ${s.acceptance}${s.acceptanceTotal !== undefined ? `/${s.acceptanceTotal}` : ""}${s.developer > 0 ? `, developer ${s.developer} passing` : ""}`;
  }
  if (s.typeErrors > 0) {
    return `${s.typeErrors} type error${s.typeErrors === 1 ? "" : "s"}`;
  }
  return `acceptance did not run${s.developer > 0 ? ` (developer ${s.developer} passing)` : ""}`;
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

/** One side of a clash prediction: an agent's pending push for an item. */
export interface BoardClashHead {
  readonly agent: string;
  readonly item: string;
  readonly sha: string;
}

/** One push of a speculative candidate's stack: an agent's pinned commit and the items it carries. */
export interface BoardCandidatePush {
  readonly agent: string;
  readonly items: readonly string[];
  readonly commit: string;
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
  /**
   * Items NOT in this revision the failure maps to (their own tests fail and
   * their work is not in the gated tree). With `items` empty, the failure is
   * the outstanding items' alone: no merged item is implicated or asked to
   * fix. Advisory record only; it drives no arbitration.
   */
  readonly outstanding?: readonly string[];
}

export interface BoardPayloads {
  "goal.posted": {
    readonly objective: string;
    readonly rules: BoardRules;
    /**
     * Where integration runs, recorded with the goal. `cloud`: the integration
     * Workflow, which cannot verify a sub-lead's merge of its children's pushes
     * in this slice, so splits are refused (`NOT_SUPPORTED`). Absent: local.
     */
    readonly integrator?: "local" | "cloud";
    /**
     * The IMMUTABLE acceptance gate (a subset of `protected`): the files the
     * gate command runs or references and their harness. No contract can ever
     * change them (`IMMUTABLE`); only the rest of `protected` (developer tests
     * and configs) is contract-changeable with a human's approval.
     */
    readonly immutable?: readonly string[];
    /**
     * The shared frozen SEAMS of a modular repo (from the cohesion blueprint)
     * and the files that import each. An item that changes a seam goes first:
     * items covering its importers wait (bounded) for its integrated revision.
     */
    readonly seams?: readonly BoardSeam[];
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
    /**
     * The integration branch's head before any revision (the BASELINE commit):
     * the first integrated revision must name it as its base.
     */
    readonly baseline?: string;
    /** The gate command the integrator runs on every revision (argv, for the record and the proof). */
    readonly gateCommand?: readonly string[];
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
    /**
     * ENGINE only: the accepted SEAM contract this item carries out (a change to
     * a shared seam no item owned). It is open at once (the lead already
     * decided) and, as a seam item, goes first; its importers rebase onto it.
     */
    readonly fromContract?: string;
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
  /**
   * Engine: a claim lapsed. Derived by arbitration under the lease rules: its
   * holder made no progress on the item for `claimLeaseMessages` board
   * messages since `lastProgressSeq` (`no-progress`), or the claim reached its
   * firm deadline (`deadline`). Or recorded by the operator (`stalled`, the
   * engine-record route) when the board went quiet while the holder of a
   * leased, unsuspended claim made no progress (a quiet board advances no
   * message count). The item is open again; the next owner may start from the
   * holder's latest push (`commit`).
   */
  "claim.lapsed": {
    readonly item: string;
    readonly agent: string;
    readonly reason: "no-progress" | "deadline" | "stalled";
    readonly lastProgressSeq: number;
    readonly deadlineSeq?: number;
    readonly commit?: string;
  };
  /** The lead (or a human) extends a claim's firm deadline by one deadline period; `reason` says why. */
  "claim.extended": { readonly item: string; readonly reason: string };
  /**
   * Engine (derived under the overlap rule, ADVISORY): `agent` was granted
   * `item`, whose declared scope overlaps the scope of `with`, which
   * `withAgent` holds, on `files`. Addressed to both; it refuses nothing.
   */
  "claim.overlap": { readonly item: string; readonly agent: string; readonly with: string; readonly withAgent: string; readonly files: readonly string[] };
  "item.split": { readonly item: string; readonly children: readonly BoardChildItem[] };
  /**
   * The lead (or a human) RE-PLANS an item that is not getting done (its fix
   * budget was spent, or it was released for not moving twice; `reason` says
   * which), once, using the failure attribution of revision `rev`: `split` it
   * into several children, `rescope` it (one replacement with a new objective
   * or files), or `merge` it with the open neighbour `with` (one replacement
   * covering both). The re-planned item(s) are carried by the children and
   * complete when they do. A child that fails again escalates to a human.
   */
  "item.replanned": {
    readonly item: string;
    readonly reason: BoardReplanReason;
    readonly action: "split" | "rescope" | "merge";
    readonly children: readonly BoardChildItem[];
    readonly with?: string;
    readonly rev?: number;
  };
  /**
   * Engine (recorded by the operator, ADVISORY): a clash prediction for two
   * agents' PENDING pushes, read from git objects (merge-tree) over the
   * integration branch head. `conflict` names the conflicting `paths` and
   * whether they touch a shared seam (`scope`); `unknown` (the pair could not
   * be decided) and `unavailable` (no prediction could run) are recorded as
   * such, never as clean. A clean pair is never recorded. One record per pair
   * of commits. It never blocks or orders integration.
   */
  "clash.predicted": {
    readonly a: BoardClashHead;
    readonly b: BoardClashHead;
    readonly status: "conflict" | "unknown" | "unavailable";
    readonly paths?: readonly string[];
    readonly scope?: "shared" | "local";
    readonly reason?: string;
  };
  /**
   * Engine (recorded by the operator): after passing revision `rev` (commit
   * `commit`) was recorded, the integration branch could not be advanced to
   * it because another writer moved it (`expected` is the value the advance
   * leased, `actual` the value it found). Nothing was pushed; the revision
   * stays recorded and its commit is what was gated.
   */
  "trunk.moved": { readonly rev: number; readonly commit: string; readonly expected?: string; readonly actual?: string };
  /**
   * Engine (recorded by the operator), addressed to the holder: the
   * integrator left `agent`'s pending push `commit` for `item` out of the
   * integrated tree because it failed verification (out of its write scope,
   * or the integrator refused the tree it alone added), so no gate ran on it.
   * The push is not re-gated until the holder pushes again; meanwhile the
   * claim's lease runs (it no longer waits for the gate) and the item's wait
   * reason is `push-excluded`.
   */
  "push.excluded": { readonly item: string; readonly agent: string; readonly commit: string; readonly reason: string };
  /**
   * Engine (recorded by the operator, arbitration revision 5, before the first
   * passing revision), addressed to the holder: `agent`'s push `commit` for
   * `item` made the stack WORSE. Failing revision `rev` gated it with the rest
   * of the stack (every latest push) and scored `to`, worse than the best
   * failing revision so far (revision `ratchet`); the same stack WITHOUT this
   * push (`candidate`, a real gated tree; for a seam push, possibly without
   * the pushes that import its seam too) scored `from`, strictly better than
   * `to`. `evidence` quotes the failure lines the push's removal removes
   * (bounded); `seams` lists the shared seams the push edits. The push is not
   * stacked again until the holder pushes again; meanwhile the claim's lease
   * runs and the item's wait reason is `push-regressed`. Never a verdict: it
   * decides only what is stacked and who is told.
   */
  "push.regressed": {
    readonly item: string;
    readonly agent: string;
    readonly commit: string;
    readonly rev: number;
    readonly ratchet: number;
    readonly from: BoardProgressScore;
    readonly to: BoardProgressScore;
    readonly candidate: string;
    readonly evidence: readonly string[];
    readonly seams?: readonly string[];
  };
  /**
   * Engine (recorded by the operator): before `agent`'s repo token expired,
   * the operator minted a fresh scoped token for the same repo (`repo-write`:
   * its own repo; `help-fork`: its fork for help request `request`), swapped
   * it in, and revokes the old one. The token itself is never on the board.
   */
  "token.refreshed": { readonly agent: string; readonly kind: "repo-write" | "help-fork"; readonly request?: string };
  /**
   * Engine (recorded by the operator): the run PROMOTED revision `rev` (the
   * board's latest revision, passing): `gatedCommit` is the commit the gate ran
   * on (it must be the revision's), `commit` the delivery commit on `branch`
   * (its tree is the gated tree). Recorded once, after the promotion
   * committed; a promotion that did not commit is never recorded.
   */
  "revision.promoted": { readonly rev: number; readonly gatedCommit: string; readonly commit: string; readonly branch: string };
  /**
   * Engine (recorded by the operator): the run reached one of its caps (model
   * calls, estimated spend in USD, wall-clock ms, or calls on one `item`):
   * no new turns from here (for an item: no more turns on it). Recorded once
   * per cap; the integrator finishes what is in flight and the verdict stays
   * the gate's.
   */
  "run.capped": { readonly kind: "model-calls" | "spend" | "wall-clock" | "item-calls"; readonly limit: number; readonly used: number; readonly item?: string };
  /**
   * Engine (recorded by the operator): one candidate of a SPECULATIVE
   * integration round (rules.speculate > 1). Candidate `index` of `of` is the
   * integrated head (`base`) plus the first `index` pushes of the round's
   * stack (`prefix`, in stack order, each an agent's pinned push and the
   * items it carries), built as its own tree (`commit`) and gated by the same
   * gate. `outcome`:
   *   - landed: the longest passing prefix whose shorter prefixes all passed;
   *     `rev` is the passing revision recorded with exactly this commit;
   *   - passed: it passed, but a longer prefix landed;
   *   - blamed: it failed right after a passing prefix (or as the first
   *     candidate, base + its push alone): its last push is attributed
   *     (`blamed` items) and `rev` is the failing revision recorded with
   *     exactly this commit (its fix loop charges only those items);
   *   - retest: something ahead of it failed, so its own push is not blamed;
   *     it is gated again next round on the head.
   * Only revisions are verdicts; candidates are records that back them.
   */
  "candidate.gated": {
    readonly round: number;
    readonly index: number;
    readonly of: number;
    readonly prefix: readonly BoardCandidatePush[];
    readonly commit: string;
    readonly base?: string;
    readonly verdict: "pass" | "fail";
    readonly outcome: "landed" | "passed" | "blamed" | "retest";
    readonly rev?: number;
    readonly blamed?: readonly string[];
    readonly progress?: BoardRevProgress;
  };
  /**
   * Engine (recorded by the operator): the integrator began an integration
   * ROUND on the pending pushes `pushes` (the push.announced seqs, each an
   * item's latest push it read) of `agents`, carrying `items`. `kind` is the
   * round's shape: `integrate` (every pending push as one revision),
   * `leave-one-out` (the pre-pass ratchet: the whole stack, then, when it
   * scores worse, the stack without each new push), or `speculative` (up to
   * `candidates` prefix candidates on the passing head). PROGRESS ONLY: it
   * changes no board state, decides nothing, and is never a verdict; the
   * round ends with what it records (integrated.rev, candidate.gated,
   * push.regressed) or, when it records nothing, an integration.phase `ended`.
   */
  "integration.started": {
    readonly kind: "integrate" | "leave-one-out" | "speculative";
    readonly pushes: readonly number[];
    readonly agents: readonly string[];
    readonly items: readonly string[];
    readonly candidates?: number;
  };
  /**
   * Engine (recorded by the operator): the integration round started at seq
   * `started` reached a coarse phase: `fetch` (reading and verifying the
   * agents' pushes), `merge` (composing them onto the head), `install` (the
   * gate's dependency install), `gate` (the gate runs), `candidate` (one
   * candidate tree of the round is built and gated; `detail` says which), or
   * `ended` (the round ended without recording a revision; `detail` says
   * why). `detail` is a short bounded line (never gate output) and
   * `elapsedMs` the time since the round began. PROGRESS ONLY, like
   * integration.started; the operator records a bounded number per round.
   */
  "integration.phase": {
    readonly started: number;
    readonly phase: "fetch" | "merge" | "install" | "gate" | "candidate" | "ended";
    readonly detail?: string;
    readonly elapsedMs?: number;
  };
  /**
   * Engine (recorded by the operator): the board is quiet but the run waits
   * for HUMAN decisions (protected contracts escalated to a human:
   * `contracts`; contests escalated to a human: `contests`), so it is not
   * ended as quiescent; it waits until they are decided or the agent phase's
   * time limit. `waitedMs` is how long the board has been quiet. Recorded at a
   * bounded interval while waiting. PROGRESS ONLY: no board state changes,
   * nothing is decided, never addressed to an agent.
   */
  "run.waiting": { readonly contracts: readonly string[]; readonly contests: readonly string[]; readonly waitedMs?: number };
  /** Engine (derived): an item the lead already re-planned failed again (fix budget spent, or stalled twice): a human decides. */
  "item.escalated": { readonly item: string; readonly reason: "replan-failed"; readonly replanOf: string };
  "item.discovered": {
    readonly item: string;
    readonly objective: string;
    readonly reason: string;
    readonly parent?: string;
    /** The paths a claim on the discovered item may write (claims must stay within). */
    readonly scopeHint?: readonly string[];
  };
  /**
   * `scope` GRANTS a sub-scope of the requester's write intent on `item` to the
   * first helper whose offer forks the requester's repo: until the requester
   * pulls the helper's delivered commit (or the grant lapses), only the helper
   * writes those paths, and the requester's own pushes may not touch them.
   */
  "help.requested": { readonly request: string; readonly item: string; readonly need: string; readonly scope?: readonly string[] };
  /**
   * An offer. With `forkOf` (the requester) the helper forked the requester's
   * repo (`fork`, the fork's repo name) at `forkCommit` (the requester's latest
   * announced push; absent when it had pushed nothing) and takes the grant.
   */
  "help.offered": {
    readonly request: string;
    readonly forkOf?: string;
    readonly forkCommit?: string;
    readonly fork?: string;
    /**
     * The fork's realized head is not the head it was expected to start from
     * (read back from the fork): the offer is RECORDED with both, and it does
     * not take the grant (the helper would start from the wrong state).
     */
    readonly baseMismatch?: { readonly expected: string; readonly realized: string };
  };
  /** The granted helper's work: a commit in its fork, changing only `paths` inside the grant. */
  "help.delivered": { readonly request: string; readonly commit: string; readonly paths: readonly string[] };
  /**
   * The requester closes its help request's grant without pulling: it
   * `declined` the delivered work, or its pull failed (`pull-failed`, with the
   * reason). The scope is the requester's again.
   */
  "help.closed": { readonly request: string; readonly reason: "declined" | "pull-failed"; readonly detail?: string };
  /**
   * The owner's runtime reports that its item is going badly (a mechanical
   * status, never a decision): edits that failed or were refused, turns spent
   * against the item budget, or a failing revision implicating it. Bounded per
   * item and owner. It is what the struggling and busy-owner cues read.
   */
  "item.struggling": {
    readonly item: string;
    readonly turnsSpent: number;
    readonly failedEdits: number;
    readonly reason: "failed-edits" | "turn-budget" | "failing-revision";
    readonly lastFailure?: string;
  };
  /** An agent volunteers to help the owner of `item` (addressed `to` the owner); rate-limited per agent and item. */
  "help.volunteered": { readonly item: string };
  /** The owner declines a volunteer's offer on its item (accepting is a help.requested with scope addressed to it). */
  "help.declined": { readonly item: string; readonly volunteer: string };
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
    /**
     * The exact change needed (required for a SEAM contract: a change to a
     * shared seam, such as a type every domain imports, that no item owns).
     * The LEAD decides a seam contract; accepted, it becomes a seam item.
     */
    readonly description?: string;
  };
  /** Engine: a contract on a protected path waits for a HUMAN decision (an escalation). */
  "contract.escalated": { readonly contract: string; readonly item: string; readonly target: string; readonly kind: "add" | "modify" | "remove" };
  "contract.accepted": { readonly contract: string };
  "contract.rejected": { readonly contract: string };
  /**
   * Engine (recorded by the operator): a seam item that held dependents made
   * no progress while the board went quiet. It holds no one from now on; with
   * no push of its owner's it is released (open) for an idle agent to take.
   */
  "seam.stalled": { readonly item: string; readonly released: boolean };
  "push.announced": {
    readonly item: string;
    readonly commit: string;
    readonly paths: readonly string[];
    /**
     * A sub-lead's push for its SPLIT item: the children's pushes (each a
     * child's latest, unintegrated push) it merged into its own repo. A passing
     * revision that merges this push integrates those children's pushes too.
     */
    readonly merges?: readonly { readonly item: string; readonly commit: string }[];
    /** Help requests on this item whose delivered commit this push pulled (closing their grants). */
    readonly pulled?: readonly string[];
  };
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
    /**
     * Children a merged sub-lead push names in `merges` whose pushed content
     * the integrator could NOT verify is in the gated tree (their in-intent
     * files at the child's commit differ from the sub-lead commit's): they are
     * not integrated by this revision, with the reason.
     */
    readonly unverified?: readonly { readonly item: string; readonly reason: string }[];
    /**
     * ADVISORY progress parsed from the gate's own output: how many of its
     * checks passed (per suite when it ran several). Never a verdict.
     */
    readonly progress?: BoardRevProgress;
    /**
     * The commit this revision was BUILT ON: the board's current integrated
     * head (the latest passing revision's commit, else the goal's baseline).
     * A revision naming any other base is refused (STALE_BASE): a stale
     * integration is never recorded as current. Absent on boards before it.
     */
    readonly base?: string;
    /**
     * A RECORD of what each merged agent's unit put into the gated tree: the
     * files applied from its repo, and the changed files it yielded (files of
     * the agent's other held items ride with those items' own pushes). Never
     * a verdict. Absent on boards before it.
     */
    readonly applied?: readonly BoardAppliedUnit[];
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
   * `closedBy: engine` (via integrated) is RECORDED by the operator at the end
   * of the agent phase, never derived: the owner did not propose done, but its
   * latest push (`pushSeq`, its push.announced) was merged by the passing
   * revision `n`, the board's latest revision, with no fix request,
   * regression, exclusion, pending contract, contest, or taken help grant
   * outstanding on the item.
   */
  "item.completed": {
    readonly item: string;
    readonly n?: number;
    readonly via: "integrated" | "children" | "tool";
    readonly version?: string;
    readonly closedBy?: "engine";
    readonly pushSeq?: number;
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
  "claim.lapsed",
  "claim.extended",
  "claim.overlap",
  "item.split",
  "item.replanned",
  "item.escalated",
  "clash.predicted",
  "trunk.moved",
  "token.refreshed",
  "revision.promoted",
  "run.capped",
  "candidate.gated",
  "integration.started",
  "integration.phase",
  "run.waiting",
  "push.excluded",
  "push.regressed",
  "item.discovered",
  "help.requested",
  "help.offered",
  "help.delivered",
  "help.closed",
  "item.struggling",
  "help.volunteered",
  "help.declined",
  "contract.proposed",
  "contract.escalated",
  "contract.accepted",
  "contract.rejected",
  "seam.stalled",
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
  | "TARGET_RELEASED"
  | "NOT_WITHIN"
  | "INVALID_STATE"
  | "LIMIT"
  | "NOT_SUPPORTED"
  | "IMMUTABLE"
  | "SEAM_FIRST"
  | "CLAIM_CAP"
  | "SEAM_OVERLAP"
  | "STALE_BASE"
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

/**
 * How an item completed. An engine close (`closedBy: engine`) also cites the
 * owner's latest push (`pushSeq`) the passing revision `n` merged, and the seq
 * of the recorded item.completed (`seq`).
 */
export interface BoardItemCompletion {
  readonly n?: number;
  readonly via: "integrated" | "children" | "tool";
  readonly version?: string;
  readonly closedBy?: "engine";
  readonly pushSeq?: number;
  readonly seq?: number;
}

/** The latest push announced for an item, and the revision that merged it. */
export interface BoardItemPush {
  readonly seq: number;
  readonly commit: string;
  readonly agent: string;
  readonly paths: readonly string[];
  integratedIn?: number;
  /** The revision that first GATED this push (merged into it, pass or fail). */
  gatedIn?: number;
  /** A sub-lead's push: the children's pushes it merged. */
  readonly merges?: readonly { readonly item: string; readonly commit: string }[];
  /** Children of `merges` a revision could not verify in the gated tree (not integrated by it). */
  unverified?: string[];
  /** A child's push: how many sub-lead pushes merged it, and whether a revision recorded it unverified. */
  mergedTimes?: number;
  unverifiedIn?: number;
  /** The integrator left this push out (push.excluded): not re-gated until the holder pushes again. */
  excluded?: { readonly seq: number; readonly reason: string };
  /** Arbitration revision 5: removing this push made its stack better (push.regressed): not stacked until the holder pushes again. */
  regressed?: { readonly seq: number } & Omit<BoardPayloads["push.regressed"], "item" | "agent" | "commit" | "candidate">;
  /** Its board clock under arbitration revision 2. */
  readonly tick?: number;
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
  /**
   * A split item's SUB-LEAD (its owner when it split): its children's pushes
   * integrate into the sub-lead's repo first, and it announces one push for
   * the item upward.
   */
  subLead?: string;
  readonly discovered?: { readonly by: string; readonly reason: string };
  /** The lead's (or a human's) decision on a worker's proposal. */
  triage?: { readonly decision: "accepted" | "rejected"; readonly by: string; readonly seq: number };
  /** The agent holding the claim (kept after completion for attribution). */
  owner?: string;
  /** The live intent of the claim, while it is held. */
  intent?: BoardIntent;
  /** The seq of the grant that gave the current owner the claim. */
  grantedSeq?: number;
  /** Under arbitration revision 2: the board clock of its latest grant, push, or (a seam item) proposal. */
  activityTick?: number;
  /** Under arbitration revision 2: the agent whose fix budget the item's counters hold. */
  budgetHolder?: string;
  /** A claim waiting on a contest. */
  claimant?: { readonly agent: string; intent: BoardIntent; contest: string };
  doneProposed: boolean;
  lastPush?: BoardItemPush;
  completed?: BoardItemCompletion;
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
  /** The accepted seam contract this item carries out (engine-proposed). */
  readonly fromContract?: string;
  /** A seam item recorded stalled (seam.stalled) since its current grant: it holds no dependent. */
  seamStalledSeq?: number;
  /** The seq at which a human last rejected a contract change for this item. */
  contractRejectedSeq?: number;
  /** The current owner's latest struggling report (cleared when the claim changes hands or completes). */
  struggling?: {
    readonly owner: string;
    readonly seq: number;
    readonly turnsSpent: number;
    readonly failedEdits: number;
    readonly reason: "failed-edits" | "turn-budget" | "failing-revision";
    readonly lastFailure?: string;
    readonly reports: number;
  };
  /** The seq of the latest failing revision whose evidence implicated this item. */
  implicatedSeq?: number;
  /**
   * The live claim's LEASE (only under the lease rules): the seq of the
   * holder's latest progress on the item, its firm deadline, and the lead's
   * extensions so far. Cleared when the claim is released or completes.
   */
  lease?: { progressSeq: number; deadlineSeq?: number; extensions: number; progressTick?: number; deadlineTick?: number };
  /** The latest lapse of a claim on this item (cleared by the next grant). */
  lastLapse?: { readonly seq: number; readonly agent: string; readonly reason: "no-progress" | "deadline" | "stalled"; readonly lastProgressSeq: number; readonly tick?: number };
  /** Claims on this item released for not moving: lapsed leases and seam stalls that released it. */
  stallReleases?: number;
  /** The latest failing revision that asked for a fix on this item (or spent its budget): its failure attribution. */
  failedRev?: number;
  /** The lead's re-plan of this item (it is carried by its replacement children), or its merge into one. */
  replanned?: { readonly seq: number; readonly by: string; readonly action: "split" | "rescope" | "merge"; readonly reason: BoardReplanReason; readonly into?: string };
  /** A re-plan's replacement child: the item it re-plans (a second failure escalates, never re-plans again). */
  readonly replanOf?: string;
  /** A merge's replacement child: every item it replaces (each completes with it). */
  readonly replaces?: readonly string[];
  /** The seq of the escalation recorded after this re-planned item failed again. */
  escalatedSeq?: number;
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
  /** Its board clock under arbitration revision 2. */
  lastActionTick?: number;
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
  /** The commit of the agent's latest announced push (what a fork of its repo starts from). */
  lastPush?: string;
}

export interface BoardVolunteer {
  readonly item: string;
  readonly agent: string;
  readonly owner: string;
  seq: number;
  count: number;
  /** The owner's answer to the latest offer: a grant addressed to it, or a decline. */
  answered?: { readonly how: "accepted" | "declined"; readonly seq: number; readonly request?: string };
}

export interface BoardHelpRequest {
  readonly request: string;
  readonly item: string;
  readonly need: string;
  readonly by: string;
  offers: string[];
  /** The seq of the request. */
  readonly seq?: number;
  /** Its board clock under arbitration revision 2. */
  readonly tick?: number;
  /** The sub-scope of the requester's write intent it grants (absent: a plain request). */
  readonly scope?: readonly string[];
  /** A grant addressed to these agents (for example a volunteer): only they may take it. */
  readonly to?: readonly string[];
  /** Arbitration revision 6: a plain question (no scope) addressed to these agents; their digest lists it until they reply. */
  readonly askedOf?: readonly string[];
  /** The helper that took the grant by forking the requester's repo. */
  grant?: {
    readonly agent: string;
    readonly seq: number;
    readonly tick?: number;
    readonly forkOf: string;
    readonly forkCommit?: string;
    readonly fork?: string;
  };
  /** The helper's latest delivered commit. */
  delivered?: { readonly commit: string; readonly paths: readonly string[]; readonly seq: number; readonly tick?: number };
  /** The requester's push that pulled the delivered commit (the grant is closed). */
  pulledSeq?: number;
  /** The requester closed the grant without pulling (declined, or its pull failed). */
  closed?: { readonly seq: number; readonly reason: "declined" | "pull-failed"; readonly detail?: string };
  /** Fork offers whose fork did not start at the expected head (recorded; they took no grant). */
  forkMismatches?: { readonly agent: string; readonly seq: number; readonly expected: string; readonly realized: string }[];
}

export interface BoardContract {
  readonly contract: string;
  readonly target: string;
  readonly kind: "add" | "modify" | "remove";
  readonly item?: string;
  /** The target is part of the gate's contract: only a human decides it. */
  readonly guarded?: boolean;
  /** The target is a shared SEAM no item owns: the lead decides; accepted, it becomes a seam item. */
  readonly seam?: string;
  /** The exact change needed (a seam contract's objective). */
  readonly description?: string;
  /** The failing revision a seam contract was proposed for (one seam change per failing cause). */
  readonly failingRev?: number;
  /**
   * Arbitration revision 6: the type-mismatch lines of the failing output a
   * seam contract was proposed for (bounded), so a rejected one is not cued
   * again while the failing errors are the identical ones.
   */
  readonly failingErrors?: readonly string[];
  /** The ADVISORY triage recommendation recorded for it (decision.recorded, contract-triage). */
  triage?: string;
  readonly proposedBy: string;
  readonly proposedSeq?: number;
  status: "proposed" | "accepted" | "rejected";
  decidedBy?: string;
  decidedSeq?: number;
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
  /** Under arbitration revision 2: participant (non-engine) messages so far, the board's clock. */
  ticks?: number;
  goal: { readonly objective: string; readonly seq: number } | null;
  rules: BoardRules;
  agents: Record<string, BoardAgent>;
  items: Record<string, BoardItem>;
  contests: Record<string, BoardContest>;
  help: Record<string, BoardHelpRequest>;
  /** Volunteers by `<item>:<agent>`: the latest offer, how many, and the owner's answer. */
  volunteers?: Record<string, BoardVolunteer>;
  /** Where integration runs, as posted with the goal (absent: local). */
  integrator?: "local" | "cloud";
  /** The immutable acceptance gate, as posted with the goal (a subset of `protected`). */
  immutable?: string[];
  /** The shared seams and their importers, as posted with the goal. */
  seams?: BoardSeam[];
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
  /** Recorded clash predictions (advisory), one per pair of pushed commits; absent until the first. */
  clashes?: BoardClash[];
  /** The integration branch's baseline commit, as posted with the goal. */
  baseline?: string;
  /** Passing revisions whose branch advance found the trunk moved (trunk.moved), by revision number. */
  trunkMoved?: number[];
  /** Repo tokens the operator refreshed (token.refreshed), counted. */
  tokenRefreshes?: number;
  /** The promoted revision (revision.promoted), once the run promoted it. */
  promoted?: { readonly rev: number; readonly gatedCommit: string; readonly commit: string; readonly branch: string; readonly seq: number };
  /** The gate command, as posted with the goal. */
  gateCommand?: string[];
  /** The latest speculative candidate recorded (candidate.gated): rounds and indexes only move forward. */
  lastCandidate?: { readonly round: number; readonly index: number; readonly seq: number };
  /** The caps the run reached (run.capped). */
  capped?: { readonly kind: string; readonly limit: number; readonly used: number; readonly item?: string; readonly seq: number }[];
}

/** A recorded clash prediction for two pending pushes (advisory). */
export interface BoardClash {
  /** The pair's commits, sorted and joined: one record per pair. */
  readonly key: string;
  readonly seq: number;
  readonly a: BoardClashHead;
  readonly b: BoardClashHead;
  readonly status: "conflict" | "unknown" | "unavailable";
  readonly paths?: readonly string[];
  readonly scope?: "shared" | "local";
  readonly reason?: string;
}

/** The key of a pair of commits (order-free). */
export function clashKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
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

/** A revision's unverified sub-lead merges: [{item, reason}], bounded. */
/** What one merged unit applied to a revision's gated tree (see integrated.rev). */
export interface BoardAppliedUnit {
  readonly agent: string;
  /** Files applied from the agent's repo (concrete paths). */
  readonly paths: readonly string[];
  /** Changed files of the agent's repo that were not applied from it. */
  readonly yielded?: readonly string[];
}

/**
 * The applied record a revision carries, from the integrator's per-unit
 * result (unit id = agent): only the agents the revision merged, each path
 * list concrete, sorted, and bounded as the board accepts it (a path the
 * board could not hold is left out of the record, never failing the
 * revision). Pure.
 */
export function boardAppliedRecord(
  units: readonly { readonly unitId: string; readonly applied: readonly string[]; readonly yielded: readonly string[] }[] | undefined,
  mergedAgents: readonly string[],
): BoardAppliedUnit[] {
  const max = BOARD_LIMITS.maxPaths * BOARD_LIMITS.maxIntentEntries;
  const concrete = (paths: readonly string[]): string[] =>
    [...new Set(paths.map((p) => normalizeIntentEntry(p)).filter((p): p is string => p !== undefined && !hasWildcard(p) && !p.includes("#")))].sort().slice(0, max);
  return (units ?? [])
    .filter((u) => mergedAgents.includes(u.unitId) && ID_PATTERN.test(u.unitId))
    .slice(0, BOARD_LIMITS.maxAgents)
    .map((u) => {
      const yielded = concrete(u.yielded);
      return { agent: u.unitId, paths: concrete(u.applied), ...(yielded.length > 0 ? { yielded } : {}) };
    });
}

/** A revision's applied record: one entry per agent, each a concrete, bounded path list. */
function appliedUnits(value: unknown): BoardAppliedUnit[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > BOARD_LIMITS.maxAgents) {
    fail("BAD_PAYLOAD", `applied must be a non-empty array of at most ${BOARD_LIMITS.maxAgents} {agent, paths, yielded?}`);
  }
  const out = value.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((k) => !["agent", "paths", "yielded"].includes(k))) {
      fail("BAD_PAYLOAD", "each applied entry must be an object {agent, paths, yielded?}");
    }
    const max = BOARD_LIMITS.maxPaths * BOARD_LIMITS.maxIntentEntries;
    const yielded = pathList(entry, "yielded", { concrete: true, optional: true, max });
    return { agent: id(entry, "agent"), paths: pathList(entry, "paths", { concrete: true, max }), ...(yielded.length > 0 ? { yielded } : {}) };
  });
  if (new Set(out.map((u) => u.agent)).size !== out.length) {
    fail("BAD_PAYLOAD", "applied names an agent twice");
  }
  return out;
}

function unverifiedMerges(value: unknown): { item: string; reason: string }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > BOARD_LIMITS.maxChildren) {
    fail("BAD_PAYLOAD", `unverified must be a non-empty array of at most ${BOARD_LIMITS.maxChildren} {item, reason}`);
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      fail("BAD_PAYLOAD", "each unverified merge must be an object {item, reason}");
    }
    return { item: id(entry, "item"), reason: text(entry, "reason", 300) };
  });
}

/** A progress score {runs, acceptance, acceptanceTotal?, developer, typeErrors}. */
function progressScoreField(raw: Raw, field: string): BoardProgressScore {
  const value = raw[field];
  if (!isRecord(value) || Object.keys(value).some((k) => !["runs", "acceptance", "acceptanceTotal", "developer", "typeErrors"].includes(k))) {
    fail("BAD_PAYLOAD", `${field} must be a progress score {runs, acceptance, acceptanceTotal?, developer, typeErrors}`);
  }
  const acceptance = nonNegativeInt(value, "acceptance");
  const total = value.acceptanceTotal === undefined ? undefined : nonNegativeInt(value, "acceptanceTotal");
  if (total !== undefined && total < acceptance) {
    fail("BAD_PAYLOAD", `${field}.acceptanceTotal must be at least its acceptance count`);
  }
  return {
    runs: bool(value, "runs"),
    acceptance,
    ...(total !== undefined ? { acceptanceTotal: total } : {}),
    developer: nonNegativeInt(value, "developer"),
    typeErrors: nonNegativeInt(value, "typeErrors"),
  };
}

/** A revision's advisory progress: non-negative counts, passed + failed = total, at most 16 suites. */
function revProgress(value: unknown): BoardRevProgress {
  if (!isRecord(value)) {
    fail("BAD_PAYLOAD", "progress must be an object {passed, failed, total, suites?}");
  }
  const one = (v: Raw, where: string) => {
    const passed = nonNegativeInt(v, "passed");
    const failed = nonNegativeInt(v, "failed");
    const total = nonNegativeInt(v, "total");
    if (passed + failed !== total) {
      fail("BAD_PAYLOAD", `${where}: passed + failed must equal total`);
    }
    return { passed, failed, total };
  };
  const base = one(value, "progress");
  const acceptance =
    value.acceptance === undefined
      ? {}
      : isRecord(value.acceptance)
        ? { acceptance: one(value.acceptance, "progress.acceptance") }
        : fail("BAD_PAYLOAD", "progress.acceptance is {passed, failed, total}");
  const notRun =
    value.acceptanceNotRun === undefined
      ? {}
      : value.acceptance !== undefined
        ? fail("BAD_PAYLOAD", "progress has either acceptance counts or acceptanceNotRun, not both")
        : { acceptanceNotRun: text(value, "acceptanceNotRun", 200) };
  if (value.suites === undefined) {
    return { ...base, ...acceptance, ...notRun };
  }
  if (!Array.isArray(value.suites) || value.suites.length === 0 || value.suites.length > 16) {
    fail("BAD_PAYLOAD", "progress.suites must be a non-empty array of at most 16 suites");
  }
  const suites = value.suites.map((s, i) => {
    if (!isRecord(s)) {
      fail("BAD_PAYLOAD", "each suite is {passed, failed, total, suite?}");
    }
    if (s.suite !== undefined && s.suite !== "acceptance" && s.suite !== "developer") {
      fail("BAD_PAYLOAD", `progress.suites[${i}].suite must be "acceptance" or "developer"`);
    }
    return { ...one(s, `progress.suites[${i}]`), ...(s.suite !== undefined ? { suite: s.suite as "acceptance" | "developer" } : {}) };
  });
  return { ...base, suites, ...acceptance, ...notRun };
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
    ...(value.maxActiveClaims !== undefined ? { maxActiveClaims: positiveInt(value, "maxActiveClaims", 8) } : {}),
    ...(value.claimLeaseMessages !== undefined ? { claimLeaseMessages: positiveInt(value, "claimLeaseMessages", 10000) } : {}),
    ...(value.claimDeadlineMessages !== undefined ? { claimDeadlineMessages: positiveInt(value, "claimDeadlineMessages", 100000) } : {}),
    ...(value.claimOverlap !== undefined ? { claimOverlap: bool(value, "claimOverlap") } : {}),
    ...(value.speculate !== undefined ? { speculate: positiveInt(value, "speculate", BOARD_LIMITS.maxSpeculate) } : {}),
    ...(value.arbitration !== undefined && value.arbitration !== 1 ? { arbitration: positiveInt(value, "arbitration", CURRENT_ARBITRATION) } : {}),
  };
}

/** Validate a failing revision's evidence: bounded output text and the implicated item ids. */
function failingEvidence(value: unknown): BoardFailingEvidence {
  if (!isRecord(value)) {
    fail("BAD_PAYLOAD", "failing must be an object {output, items}");
  }
  for (const key of Object.keys(value)) {
    if (key !== "output" && key !== "items" && key !== "outstanding") {
      fail("BAD_PAYLOAD", `failing has an unknown field ${JSON.stringify(key)}`);
    }
  }
  const output = value.output;
  if (typeof output !== "string" || output.length > BOARD_LIMITS.maxFailingOutput) {
    fail("BAD_PAYLOAD", `failing.output must be a string of at most ${BOARD_LIMITS.maxFailingOutput} characters`);
  }
  const outstanding = value.outstanding === undefined ? undefined : idList(value, "outstanding", { max: BOARD_LIMITS.maxRevisionPushes });
  return { output, items: idList(value, "items", { max: BOARD_LIMITS.maxRevisionPushes }), ...(outstanding !== undefined ? { outstanding } : {}) };
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
      const goalRules = rules(raw);
      if (raw.integrator === "cloud" && (goalRules.speculate ?? 1) > 1) {
        fail(
          "NOT_SUPPORTED",
          "this run integrates on Cloudflare, whose integration Workflow gates one revision at a time: speculative batch gating (rules.speculate > 1) is not supported; integrate locally or drop it",
        );
      }
      return {
        objective: text(raw, "objective", L.maxRationale),
        rules: goalRules,
        ...(guarded.length > 0 ? { protected: guarded } : {}),
        ...(keys.length > 0 ? { protectedKeys: keys } : {}),
        ...(inventory !== undefined ? { testInventory: inventory } : {}),
        ...(raw.integrator !== undefined ? { integrator: oneOf(raw, "integrator", ["local", "cloud"] as const) } : {}),
        ...((): { seams?: BoardSeam[] } => {
          if (raw.seams === undefined) return {};
          if (!Array.isArray(raw.seams) || raw.seams.length > L.maxIntentEntries) {
            fail("BAD_PAYLOAD", `seams must be an array of at most ${L.maxIntentEntries} {path, importers}`);
          }
          return {
            seams: raw.seams.map((seam) => {
              if (!isRecord(seam)) fail("BAD_PAYLOAD", "each seam is {path, importers, symbols?}");
              const [path] = pathList({ path: [seam.path] }, "path", { concrete: true });
              const symbols = seam.symbols;
              if (symbols !== undefined && (!Array.isArray(symbols) || symbols.length > 64 || !symbols.every((n) => typeof n === "string" && /^[A-Za-z_$][\w$]{0,79}$/.test(n)))) {
                fail("BAD_PAYLOAD", "a seam's symbols are at most 64 identifiers");
              }
              return {
                path: path!,
                importers: pathList(seam, "importers", { concrete: true, max: L.maxPaths }),
                ...(symbols !== undefined && symbols.length > 0 ? { symbols: [...(symbols as string[])] } : {}),
              };
            }),
          };
        })(),
        ...((): { immutable?: string[] } => {
          const immutable = pathList(raw, "immutable", { optional: true, max: L.maxProtected });
          return immutable.length > 0 ? { immutable } : {};
        })(),
        ...(raw.baseline !== undefined ? { baseline: id(raw, "baseline") } : {}),
        ...(raw.gateCommand !== undefined ? { gateCommand: textList(raw, "gateCommand", 32, 200) } : {}),
      };
    }
    case "item.proposed":
      return {
        item: id(raw, "item"),
        objective: text(raw, "objective", L.maxObjective),
        acceptance: textList(raw, "acceptance", L.maxAcceptance, L.maxObjective),
        scopeHint: pathList(raw, "scopeHint", { optional: true, max: L.maxIntentEntries }),
        ...(raw.fromTool !== undefined ? { fromTool: toolRef(raw.fromTool, "fromTool") } : {}),
        ...(raw.fromContract !== undefined ? { fromContract: id(raw, "fromContract") } : {}),
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
    case "claim.lapsed": {
      const deadlineSeq = raw.deadlineSeq === undefined ? undefined : positiveInt(raw, "deadlineSeq");
      const commit = optionalId(raw, "commit");
      return {
        item: id(raw, "item"),
        agent: id(raw, "agent"),
        reason: oneOf(raw, "reason", ["no-progress", "deadline", "stalled"] as const),
        lastProgressSeq: positiveInt(raw, "lastProgressSeq"),
        ...(deadlineSeq !== undefined ? { deadlineSeq } : {}),
        ...(commit !== undefined ? { commit } : {}),
      };
    }
    case "claim.extended":
      return { item: id(raw, "item"), reason: text(raw, "reason", 200) };
    case "claim.overlap":
      return {
        item: id(raw, "item"),
        agent: id(raw, "agent"),
        with: id(raw, "with"),
        withAgent: id(raw, "withAgent"),
        files: pathList(raw, "files", { max: 16 }),
      };
    case "item.split":
      return { item: id(raw, "item"), children: children(raw) };
    case "item.replanned": {
      const withItem = optionalId(raw, "with");
      const rev = raw.rev === undefined ? undefined : positiveInt(raw, "rev");
      return {
        item: id(raw, "item"),
        reason: oneOf(raw, "reason", BOARD_REPLAN_REASONS),
        action: oneOf(raw, "action", ["split", "rescope", "merge"] as const),
        children: children(raw),
        ...(withItem !== undefined ? { with: withItem } : {}),
        ...(rev !== undefined ? { rev } : {}),
      };
    }
    case "item.escalated":
      return { item: id(raw, "item"), reason: oneOf(raw, "reason", ["replan-failed"] as const), replanOf: id(raw, "replanOf") };
    case "candidate.gated": {
      if (!Array.isArray(raw.prefix) || raw.prefix.length === 0 || raw.prefix.length > L.maxSpeculate) {
        fail("BAD_PAYLOAD", `prefix must be an array of 1 to ${L.maxSpeculate} pushes {agent, items, commit}`);
      }
      const prefix = raw.prefix.map((entry): BoardCandidatePush => {
        if (!isRecord(entry) || Object.keys(entry).some((k) => !["agent", "items", "commit"].includes(k))) {
          fail("BAD_PAYLOAD", "each prefix push is {agent, items, commit}");
        }
        const items = idList(entry, "items", { max: L.maxIntentEntries });
        if (items.length === 0) {
          fail("BAD_PAYLOAD", "a prefix push carries at least one item");
        }
        return { agent: id(entry, "agent"), items, commit: id(entry, "commit") };
      });
      const index = positiveInt(raw, "index", L.maxSpeculate);
      const of = positiveInt(raw, "of", L.maxSpeculate);
      if (index > of || prefix.length !== index) {
        fail("BAD_PAYLOAD", "candidate index (at most of) is the length of its prefix");
      }
      const base = optionalId(raw, "base");
      const rev = raw.rev === undefined ? undefined : positiveInt(raw, "rev");
      const blamed = idList(raw, "blamed", { optional: true, max: L.maxIntentEntries });
      return {
        round: positiveInt(raw, "round"),
        index,
        of,
        prefix,
        commit: id(raw, "commit"),
        ...(base !== undefined ? { base } : {}),
        verdict: oneOf(raw, "verdict", ["pass", "fail"] as const),
        outcome: oneOf(raw, "outcome", ["landed", "passed", "blamed", "retest"] as const),
        ...(rev !== undefined ? { rev } : {}),
        ...(blamed.length > 0 ? { blamed } : {}),
        ...(raw.progress !== undefined ? { progress: revProgress(raw.progress) } : {}),
      };
    }
    case "integration.started": {
      const pushes = raw.pushes;
      if (!Array.isArray(pushes) || pushes.length === 0 || pushes.length > L.maxRevisionPushes) {
        fail("BAD_PAYLOAD", `pushes must be an array of 1 to ${L.maxRevisionPushes} push seqs`);
      }
      const seqs: number[] = [];
      pushes.forEach((value, index) => {
        const seq = positiveInt({ [`pushes[${index}]`]: value }, `pushes[${index}]`);
        if (!seqs.includes(seq)) {
          seqs.push(seq);
        }
      });
      const agents = idList(raw, "agents", { max: L.maxRevisionPushes });
      const items = idList(raw, "items", { max: L.maxRevisionPushes });
      if (agents.length === 0 || items.length === 0) {
        fail("BAD_PAYLOAD", "an integration round names at least one agent and one item");
      }
      const kind = oneOf(raw, "kind", ["integrate", "leave-one-out", "speculative"] as const);
      const candidates = raw.candidates === undefined ? undefined : positiveInt(raw, "candidates", L.maxSpeculate);
      return { kind, pushes: seqs, agents, items, ...(candidates !== undefined ? { candidates } : {}) };
    }
    case "run.waiting": {
      const contracts = idList(raw, "contracts", { max: L.maxShortList });
      const contests = idList(raw, "contests", { max: L.maxShortList });
      if (contracts.length + contests.length === 0) {
        fail("BAD_PAYLOAD", "a run waits on at least one human decision (contracts or contests)");
      }
      const waitedMs = raw.waitedMs === undefined ? undefined : nonNegativeInt(raw, "waitedMs");
      return { contracts, contests, ...(waitedMs !== undefined ? { waitedMs } : {}) };
    }
    case "integration.phase": {
      const detail = raw.detail === undefined ? undefined : text(raw, "detail", L.maxIntegrationDetail);
      const elapsedMs = raw.elapsedMs === undefined ? undefined : nonNegativeInt(raw, "elapsedMs");
      return {
        started: positiveInt(raw, "started"),
        phase: oneOf(raw, "phase", ["fetch", "merge", "install", "gate", "candidate", "ended"] as const),
        ...(detail !== undefined ? { detail } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      };
    }
    case "push.excluded":
      return { item: id(raw, "item"), agent: id(raw, "agent"), commit: id(raw, "commit"), reason: text(raw, "reason", L.maxRationale) };
    case "push.regressed": {
      const seams = pathList(raw, "seams", { optional: true, concrete: true, max: L.maxShortList });
      return {
        item: id(raw, "item"),
        agent: id(raw, "agent"),
        commit: id(raw, "commit"),
        rev: positiveInt(raw, "rev"),
        ratchet: positiveInt(raw, "ratchet"),
        from: progressScoreField(raw, "from"),
        to: progressScoreField(raw, "to"),
        candidate: id(raw, "candidate"),
        evidence: textList(raw, "evidence", L.maxRegressionEvidence, L.maxRegressionEvidenceLine),
        ...(seams.length > 0 ? { seams } : {}),
      };
    }
    case "trunk.moved": {
      const expected = optionalId(raw, "expected");
      const actual = optionalId(raw, "actual");
      return { rev: positiveInt(raw, "rev"), commit: id(raw, "commit"), ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) };
    }
    case "run.capped": {
      const kind = oneOf(raw, "kind", ["model-calls", "spend", "wall-clock", "item-calls"] as const);
      const amount = (field: string): number => {
        const value = raw[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          fail("BAD_PAYLOAD", `${field} must be a non-negative number`);
        }
        return value;
      };
      const item = optionalId(raw, "item");
      if ((kind === "item-calls") !== (item !== undefined)) {
        fail("BAD_PAYLOAD", "an item-calls cap names its item (and only it does)");
      }
      return { kind, limit: amount("limit"), used: amount("used"), ...(item !== undefined ? { item } : {}) };
    }
    case "revision.promoted": {
      const branch = raw.branch;
      if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..")) {
        fail("BAD_PAYLOAD", "branch must be a git branch name (letters, digits, . _ / -; at most 200 chars)");
      }
      return { rev: positiveInt(raw, "rev"), gatedCommit: id(raw, "gatedCommit"), commit: id(raw, "commit"), branch };
    }
    case "token.refreshed": {
      const kind = oneOf(raw, "kind", ["repo-write", "help-fork"] as const);
      const request = optionalId(raw, "request");
      if ((kind === "help-fork") !== (request !== undefined)) {
        fail("BAD_PAYLOAD", "a help-fork refresh names its help request (and only it does)");
      }
      return { agent: id(raw, "agent"), kind, ...(request !== undefined ? { request } : {}) };
    }
    case "clash.predicted": {
      const head = (value: unknown, field: string): BoardClashHead => {
        if (!isRecord(value) || Object.keys(value).some((k) => !["agent", "item", "sha"].includes(k))) {
          fail("BAD_PAYLOAD", `${field} is {agent, item, sha}`);
        }
        return { agent: id(value, "agent"), item: id(value, "item"), sha: id(value, "sha") };
      };
      const status = oneOf(raw, "status", ["conflict", "unknown", "unavailable"] as const);
      const paths = pathList(raw, "paths", { concrete: true, optional: true, max: 64 });
      if (status === "conflict" && (paths.length === 0 || raw.scope === undefined)) {
        fail("BAD_PAYLOAD", "a conflict names its conflicting paths and their scope");
      }
      if (status !== "conflict" && (paths.length > 0 || raw.scope !== undefined)) {
        fail("BAD_PAYLOAD", "only a conflict names paths and a scope");
      }
      if (status !== "conflict" && raw.reason === undefined) {
        fail("BAD_PAYLOAD", `an ${status} prediction says why (reason)`);
      }
      return {
        a: head(raw.a, "a"),
        b: head(raw.b, "b"),
        status,
        ...(paths.length > 0 ? { paths } : {}),
        ...(raw.scope !== undefined ? { scope: oneOf(raw, "scope", ["shared", "local"] as const) } : {}),
        ...(raw.reason !== undefined ? { reason: text(raw, "reason", 300) } : {}),
      };
    }
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
    case "help.requested": {
      const scope = pathList(raw, "scope", { optional: true, max: L.maxIntentEntries });
      if (raw.scope !== undefined && scope.length === 0) {
        fail("BAD_PAYLOAD", "scope, when present, must name at least one path inside the requester's write intent");
      }
      return { request: id(raw, "request"), item: id(raw, "item"), need: id(raw, "need"), ...(scope.length > 0 ? { scope } : {}) };
    }
    case "help.offered": {
      const forkOf = optionalId(raw, "forkOf");
      const forkCommit = optionalId(raw, "forkCommit");
      const fork = optionalId(raw, "fork");
      if (forkOf === undefined && (forkCommit !== undefined || fork !== undefined)) {
        fail("BAD_PAYLOAD", "forkCommit and fork describe a fork: name the forked requester in forkOf");
      }
      let baseMismatch: { expected: string; realized: string } | undefined;
      if (raw.baseMismatch !== undefined) {
        const m = raw.baseMismatch;
        if (!isRecord(m) || Object.keys(m).some((k) => k !== "expected" && k !== "realized") || forkOf === undefined) {
          fail("BAD_PAYLOAD", "baseMismatch is {expected, realized}, on a fork offer (forkOf)");
        }
        baseMismatch = { expected: id(m, "expected"), realized: id(m, "realized") };
        if (baseMismatch.expected === baseMismatch.realized) {
          fail("BAD_PAYLOAD", "a base mismatch names two different heads");
        }
      }
      return {
        request: id(raw, "request"),
        ...(forkOf !== undefined ? { forkOf } : {}),
        ...(forkCommit !== undefined ? { forkCommit } : {}),
        ...(fork !== undefined ? { fork } : {}),
        ...(baseMismatch !== undefined ? { baseMismatch } : {}),
      };
    }
    case "item.struggling": {
      const lastFailure = raw.lastFailure === undefined ? undefined : text(raw, "lastFailure", 300);
      return {
        item: id(raw, "item"),
        turnsSpent: nonNegativeInt(raw, "turnsSpent"),
        failedEdits: nonNegativeInt(raw, "failedEdits"),
        reason: oneOf(raw, "reason", ["failed-edits", "turn-budget", "failing-revision"] as const),
        ...(lastFailure !== undefined ? { lastFailure } : {}),
      };
    }
    case "help.volunteered":
      return { item: id(raw, "item") };
    case "help.declined":
      return { item: id(raw, "item"), volunteer: id(raw, "volunteer") };
    case "help.closed": {
      const detail = raw.detail === undefined ? undefined : text(raw, "detail", 300);
      return { request: id(raw, "request"), reason: oneOf(raw, "reason", ["declined", "pull-failed"] as const), ...(detail !== undefined ? { detail } : {}) };
    }
    case "help.delivered": {
      const paths = pathList(raw, "paths", { concrete: true });
      if (paths.length === 0) {
        fail("BAD_PAYLOAD", "a delivery names the files it changed");
      }
      return { request: id(raw, "request"), commit: id(raw, "commit"), paths };
    }
    case "contract.proposed": {
      const [target] = pathList({ target: [raw.target] }, "target");
      const item = optionalId(raw, "item");
      const description = raw.description === undefined ? undefined : text(raw, "description", MAX_CONTRACT_DESCRIPTION);
      return {
        contract: id(raw, "contract"),
        target: target!,
        kind: oneOf(raw, "kind", ["add", "modify", "remove"] as const),
        ...(item !== undefined ? { item } : {}),
        ...(description !== undefined ? { description } : {}),
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
    case "seam.stalled":
      if (typeof raw.released !== "boolean") {
        fail("BAD_PAYLOAD", "released must be a boolean");
      }
      return { item: id(raw, "item"), released: raw.released };
    case "item.accepted":
    case "item.rejected":
      return { item: id(raw, "item") };
    case "push.announced": {
      let merges: { item: string; commit: string }[] | undefined;
      if (raw.merges !== undefined) {
        if (!Array.isArray(raw.merges) || raw.merges.length === 0 || raw.merges.length > L.maxChildren) {
          fail("BAD_PAYLOAD", `merges must be a non-empty array of at most ${L.maxChildren} {item, commit}`);
        }
        merges = raw.merges.map((entry) => {
          if (!isRecord(entry)) {
            fail("BAD_PAYLOAD", "each merge must be an object {item, commit}");
          }
          return { item: id(entry, "item"), commit: id(entry, "commit") };
        });
        if (new Set(merges.map((m) => m.item)).size !== merges.length) {
          fail("BAD_PAYLOAD", "merges names a child item twice");
        }
      }
      const pulled = idList(raw, "pulled", { optional: true });
      if (raw.pulled !== undefined && pulled.length === 0) {
        fail("BAD_PAYLOAD", "pulled, when present, must name at least one help request");
      }
      return {
        item: id(raw, "item"),
        commit: id(raw, "commit"),
        paths: pathList(raw, "paths", { concrete: true }),
        ...(merges !== undefined ? { merges } : {}),
        ...(pulled.length > 0 ? { pulled } : {}),
      };
    }
    case "integrated.rev": {
      const failing = raw.failing === undefined ? undefined : failingEvidence(raw.failing);
      return {
        n: positiveInt(raw, "n"),
        commit: id(raw, "commit"),
        gate: oneOf(raw, "gate", ["pass", "fail"] as const),
        merged: idList(raw, "merged", { max: L.maxRevisionPushes }),
        paths: pathList(raw, "paths", { max: L.maxPaths * L.maxIntentEntries }),
        contributors: idList(raw, "contributors", { max: L.maxAgents }),
        ...(failing !== undefined ? { failing } : {}),
        ...(ungatedFlag(raw) ? { gated: false as const } : {}),
        ...(raw.unverified !== undefined ? { unverified: unverifiedMerges(raw.unverified) } : {}),
        ...(raw.progress !== undefined ? { progress: revProgress(raw.progress) } : {}),
        ...(raw.base !== undefined ? { base: id(raw, "base") } : {}),
        ...(raw.applied !== undefined ? { applied: appliedUnits(raw.applied) } : {}),
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
      if (raw.closedBy !== undefined || raw.pushSeq !== undefined) {
        // An engine close: via integrated, citing the owner's latest push.
        if (via !== "integrated" || raw.closedBy !== "engine") {
          fail("BAD_PAYLOAD", "an engine close is {item, n, via: integrated, closedBy: engine, pushSeq}");
        }
        return { item: id(raw, "item"), n: positiveInt(raw, "n"), via, closedBy: "engine", pushSeq: positiveInt(raw, "pushSeq") };
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
  // The engine proposes the seam item an accepted seam contract becomes.
  "item.proposed": ["human", "agent", "engine"],
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
  "claim.lapsed": ["engine"],
  "claim.extended": ["lead", "human"],
  "claim.overlap": ["engine"],
  "item.split": ["agent"],
  "item.replanned": ["lead", "human"],
  "item.escalated": ["engine"],
  "clash.predicted": ["engine"],
  "trunk.moved": ["engine"],
  "push.excluded": ["engine"],
  "push.regressed": ["engine"],
  "token.refreshed": ["engine"],
  "revision.promoted": ["engine"],
  "run.capped": ["engine"],
  "candidate.gated": ["engine"],
  "integration.started": ["engine"],
  "integration.phase": ["engine"],
  "run.waiting": ["engine"],
  "item.discovered": ["agent"],
  "help.requested": ["agent"],
  "help.offered": ["agent"],
  "help.delivered": ["agent"],
  "help.closed": ["agent"],
  "item.struggling": ["agent"],
  "help.volunteered": ["agent"],
  "help.declined": ["agent"],
  "contract.proposed": ["agent"],
  "contract.escalated": ["engine"],
  "contract.accepted": ["lead", "human"],
  "contract.rejected": ["lead", "human"],
  "seam.stalled": ["engine"],
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

/**
 * Live claims held by agents other than `except`, excluding `skipItem`. A
 * SPLIT item whose sub-lead is still on the board stays a live claim of its
 * sub-lead (single writer over its whole write intent: what no child covers
 * stays the sub-lead's, and nobody else may write it), except for claims on
 * its own descendants (`forItem`), which divide it.
 */
function liveClaims(state: BoardState, except: string, skipItem?: string, forItem?: string): BoardItem[] {
  return Object.values(state.items)
    .filter(
      (i) =>
        (i.status === "claimed" || (i.status === "split" && i.subLead !== undefined && activeAgent(state, i.subLead))) &&
        i.owner !== undefined &&
        i.owner !== except &&
        i.intent &&
        i.id !== skipItem &&
        !(i.status === "split" && forItem !== undefined && isAncestor(state, i.id, forItem)),
    )
    .sort((a, b) => (a.grantedSeq ?? 0) - (b.grantedSeq ?? 0));
}

/** True when `ancestor` is a (transitive) parent of `item`. */
function isAncestor(state: BoardState, ancestor: string, item: string): boolean {
  let parent = state.items[item]?.parent;
  while (parent !== undefined) {
    if (parent === ancestor) {
      return true;
    }
    parent = state.items[parent]?.parent;
  }
  return false;
}

/** The write intents of the children a sub-lead push merges (what it may announce, and what integrates). */
export function mergedChildrenWrite(state: BoardState, merges: readonly { readonly item: string }[]): string[] {
  return [...new Set(merges.flatMap((m) => {
    const child = state.items[m.item];
    return (child?.intent?.write ?? child?.scopeHint ?? []).map(intentPath);
  }))];
}

/**
 * The targets of ACCEPTED contracts for `item` (all items when omitted): the
 * protected paths those contracts released for writing. Under arbitration
 * revision 7, for one item:
 *   - an item also INHERITS an ancestor's release (a split or re-planned
 *     item, or either item a merge replaces) only as its HEIR: at each step
 *     down from the ancestor, the first child in the split or re-plan's order
 *     whose scope hint covers the target; a sibling never inherits it (it asks
 *     by contract, and releaseHolder names the heir);
 *   - a release is SUPERSEDED by a later accepted contract on an overlapping
 *     target that is held by an item outside its lineage (accepted while it
 *     held nothing live), so one item writes a released file at a time;
 *     never while the item's push changing the target, announced before
 *     that acceptance, is still to be integrated.
 */
export function releasedTargets(state: BoardState, item?: string): string[] {
  const accepted = Object.values(state.contracts).filter(
    // A seam contract releases nothing to the item that asked: its SEAM ITEM carries the change.
    (c) => c.status === "accepted" && c.item !== undefined && c.seam === undefined,
  );
  if (item === undefined || !arbitrationV7(state) || state.items[item] === undefined) {
    return accepted.filter((c) => item === undefined || c.item === item).map((c) => c.target);
  }
  const own = accepted.filter((c) => c.item === item && !releaseSuperseded(state, c, item)).map((c) => c.target);
  const inherited = accepted
    .filter((c) => c.item !== item && inheritsRelease(state, item, c.item!, c.target, new Set()) && !releaseSuperseded(state, c, item))
    .map((c) => c.target);
  return inherited.length > 0 ? [...own, ...[...new Set(inherited)].filter((t) => !own.includes(t))] : own;
}

/**
 * Arbitration revision 7: the items `id` descends from directly: its parent
 * and every item a merge replaced into it (the neighbour whose children
 * include it). Pure.
 */
function lineageParents(state: BoardState, id: string): string[] {
  const item = state.items[id];
  if (item === undefined) {
    return [];
  }
  return [...new Set([...(item.parent !== undefined ? [item.parent] : []), ...(item.replaces ?? [])])].filter((p) => p !== id);
}

/** True when `ancestor` is a (transitive) lineage parent of `item` (parents and merge neighbours). */
function isLineageAncestor(state: BoardState, ancestor: string, item: string): boolean {
  const seen = new Set<string>();
  const queue = lineageParents(state, item);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next === ancestor) {
      return true;
    }
    if (!seen.has(next)) {
      seen.add(next);
      queue.push(...lineageParents(state, next));
    }
  }
  return false;
}

/** True when one item descends from the other (either way) through splits, re-plans, or merges. */
function lineageRelated(state: BoardState, a: string, b: string): boolean {
  return isLineageAncestor(state, a, b) || isLineageAncestor(state, b, a);
}

/** The HEIR of `parent`'s release of `target`: its first child (in the split or re-plan's order) whose scope hint covers the target. */
function releaseHeir(state: BoardState, parent: string, target: string): string | undefined {
  return state.items[parent]?.children.find((c) => (state.items[c]?.scopeHint ?? []).some((hint) => entryWithin(target, intentPath(hint))));
}

/** True when `item` inherits `ancestor`'s release of `target`: it is the heir at every step down from the ancestor. */
function inheritsRelease(state: BoardState, item: string, ancestor: string, target: string, seen: Set<string>): boolean {
  if (seen.has(item)) {
    return false;
  }
  seen.add(item);
  return lineageParents(state, item).some(
    (p) => releaseHeir(state, p, target) === item && (p === ancestor || inheritsRelease(state, p, ancestor, target, seen)),
  );
}

/**
 * The item that holds contract `c`'s release now: its own item, or, once
 * that item was split, re-planned, or merged, the heir at every step down
 * (undefined when a step has no heir: nobody inherits it). Pure.
 */
function releaseOwner(state: BoardState, c: BoardContract): string | undefined {
  let holder = c.item;
  const seen = new Set<string>();
  while (holder !== undefined && (state.items[holder]?.children.length ?? 0) > 0 && !seen.has(holder)) {
    seen.add(holder);
    holder = releaseHeir(state, holder, c.target);
  }
  return holder;
}

/**
 * True when `c`'s release (as held by `holder`) gave way to a later accepted
 * contract on an overlapping target held outside its lineage. Never while
 * `holder` has a push touching the target that was announced before that
 * acceptance and is not integrated yet (see pendingReleasedPush): the
 * integration still applies it with the target in the holder's scope.
 */
function releaseSuperseded(state: BoardState, c: BoardContract, holder: string): boolean {
  const pending = pendingReleasedPush(state, holder, c.target);
  return Object.values(state.contracts).some((later) => {
    if (later === c || later.status !== "accepted" || later.item === undefined || later.seam !== undefined || (later.decidedSeq ?? 0) <= (c.decidedSeq ?? 0)) {
      return false;
    }
    if (pending !== undefined && pending.seq < (later.decidedSeq ?? 0)) {
      return false;
    }
    const owner = releaseOwner(state, later);
    return owner !== undefined && owner !== holder && !lineageRelated(state, owner, holder) && entriesOverlap(later.target, c.target);
  });
}

/**
 * Arbitration revision 7: `item`'s latest push when it touches `target` and
 * an integration may still gate it: held by the agent that pushed it (a
 * claimed item's owner, or a split item's sub-lead), not integrated, not left
 * out (push.excluded), and not waiting as a regression (push.regressed).
 * Undefined otherwise. Pure.
 */
function pendingReleasedPush(state: BoardState, item: string, target: string): BoardItemPush | undefined {
  const it = state.items[item];
  const push = it?.lastPush;
  if (
    it === undefined ||
    push === undefined ||
    push.integratedIn !== undefined ||
    push.excluded !== undefined ||
    push.regressed !== undefined ||
    !(it.status === "claimed" || it.status === "split") ||
    (it.owner !== push.agent && it.subLead !== push.agent)
  ) {
    return undefined;
  }
  return push.paths.some((p) => entriesOverlap(p, target)) ? push : undefined;
}

/**
 * Arbitration revision 7: an accepted release of a target overlapping
 * `target`, held by an item outside `item`'s lineage (live or not: an
 * escalated holder too) whose pending push touches it (see
 * pendingReleasedPush), or undefined. Accepting `item`'s contract on the
 * target now would make a second writer while that push is still applied
 * with the target in its holder's scope. Pure.
 */
function pendingReleaseWriter(state: BoardState, item: string, target: string): { readonly contract: BoardContract; readonly holder: string; readonly commit: string } | undefined {
  for (const c of Object.values(state.contracts)) {
    if (c.status !== "accepted" || c.seam !== undefined || c.item === undefined || !entriesOverlap(c.target, target)) {
      continue;
    }
    const owner = releaseOwner(state, c);
    if (owner === undefined || owner === item || lineageRelated(state, owner, item) || releaseSuperseded(state, c, owner)) {
      continue;
    }
    const push = pendingReleasedPush(state, owner, c.target);
    if (push !== undefined && push.paths.some((p) => entriesOverlap(p, target))) {
      return { contract: c, holder: owner, commit: push.commit };
    }
  }
  return undefined;
}

/**
 * Arbitration revision 7: true while `item` can write what it holds: claimed
 * (or contested) by an active owner, not escalated, and its fix budget not
 * spent. An open item with no live owner, an escalated one, or one whose fix
 * budget ran out holds nothing. Pure.
 */
function holdsRelease(state: BoardState, item: BoardItem | undefined): boolean {
  return (
    item !== undefined &&
    (item.status === "claimed" || item.status === "contested") &&
    item.owner !== undefined &&
    activeAgent(state, item.owner) &&
    item.escalatedSeq === undefined &&
    item.fixExhausted !== true
  );
}

/**
 * The paths released to `item` by its accepted protected contracts that an
 * agent may write (releasedTargets without any part of the immutable
 * acceptance gate). Pure.
 */
export function releasedForAgent(state: BoardState, item: string): string[] {
  return [...new Set(releasedTargets(state, item))].filter((t) => !(state.immutable ?? []).some((p) => entriesOverlap(t, p)));
}

/**
 * The released paths of `item` its latest push has not changed since the
 * contract that released each was accepted (a push before the acceptance
 * never counts). Pure.
 */
export function releasedUnchanged(state: BoardState, item: BoardItem): string[] {
  const writable = releasedForAgent(state, item.id);
  const push = item.lastPush;
  return writable.filter((target) => {
    const decided = Object.values(state.contracts)
      .filter(
        (c) =>
          c.status === "accepted" &&
          c.item !== undefined &&
          (c.item === item.id || (arbitrationV7(state) ? isLineageAncestor(state, c.item, item.id) : isAncestor(state, c.item, item.id))) &&
          c.seam === undefined &&
          c.target === target,
      )
      .reduce((latest, c) => Math.max(latest, c.decidedSeq ?? 0), 0);
    return !(push !== undefined && push.seq > decided && push.paths.some((p) => entryWithin(p, intentPath(target))));
  });
}

/**
 * Arbitration revision 7: the accepted contract that released `target` to
 * another LIVE holder, or undefined. Its `item` is the item that holds the
 * release now (the contract's own item, or the heir that inherited it, see
 * releasedTargets): neither `item` nor an ancestor or descendant of it
 * (through splits, re-plans, and merges), and live (see holdsRelease: an
 * escalated item, one whose fix budget ran out, or an open one with no live
 * owner holds nothing). A release superseded by a later accepted contract is
 * not held. Pure.
 */
export function releaseHolder(state: BoardState, item: string, target: string): BoardContract | undefined {
  for (const c of Object.values(state.contracts)) {
    if (c.status !== "accepted" || c.seam !== undefined || c.item === undefined || !entriesOverlap(c.target, target)) {
      continue;
    }
    const owner = releaseOwner(state, c);
    if (owner === undefined || owner === item || lineageRelated(state, owner, item) || !holdsRelease(state, state.items[owner]) || releaseSuperseded(state, c, owner)) {
      continue;
    }
    return { ...c, item: owner };
  }
  return undefined;
}

/** The TARGET_RELEASED refusal naming the item that holds `target`'s release. */
function targetReleasedMessage(target: string, holder: BoardContract): string {
  return `${target} is already released to item ${holder.item} (contract ${holder.contract}, ${holder.target}): only that item changes it; ask its owner (a question naming ${holder.item}) instead of a second contract`;
}

/**
 * Arbitration revision 7: a PENDING contract another live item (outside
 * `item`'s lineage) proposed on a target overlapping `target`, or undefined:
 * one item asks for a protected file at a time. Pure.
 */
function pendingReleaseRival(state: BoardState, item: string, target: string): BoardContract | undefined {
  return Object.values(state.contracts).find(
    (c) =>
      c.status === "proposed" &&
      c.seam === undefined &&
      c.item !== undefined &&
      c.item !== item &&
      entriesOverlap(c.target, target) &&
      !lineageRelated(state, c.item, item) &&
      holdsRelease(state, state.items[c.item]),
  );
}

/** The item whose latest, not yet integrated push has this commit. */
function itemForPendingPush(state: BoardState, commit: string): BoardItem | undefined {
  return Object.values(state.items).find(
    (i) => i.lastPush !== undefined && i.lastPush.commit === commit && i.lastPush.integratedIn === undefined,
  );
}

/**
 * The children's pushes a sub-lead's latest push merged that are still each
 * child's latest, unintegrated push (a child that pushed again since is not
 * integrated by it).
 */
function subLeadMerges(state: BoardState, item: BoardItem): { readonly item: string; readonly commit: string }[] {
  return (item.lastPush?.merges ?? []).filter((m) => {
    const child = state.items[m.item];
    return child?.lastPush?.commit === m.commit && child.lastPush.integratedIn === undefined;
  });
}

/**
 * True while a help request's GRANT is live: it grants a sub-scope, the
 * requester still holds the item, the requester has not pulled the helper's
 * work yet, and either the helper delivered (the requester decides when to
 * pull) or the wait is still bounded (no helper within `helpWaitMessages` of
 * the request, or a granted helper that left or did not deliver within
 * `helpWaitMessages` of its offer, lapses it). A pure function of the board.
 */
export function helpGrantLive(state: BoardState, request: BoardHelpRequest): boolean {
  if (request.scope === undefined || request.pulledSeq !== undefined || request.closed !== undefined) {
    return false;
  }
  const item = state.items[request.item];
  if (!item || item.status !== "claimed" || item.owner !== request.by || !activeAgent(state, request.by)) {
    return false;
  }
  const now = boardClock(state);
  if (request.delivered !== undefined) {
    // Delivered work waits for the requester's pull, bounded too.
    return now - anchorClock(state, request.delivered.seq, request.delivered.tick) <= BOARD_LIMITS.helpWaitMessages;
  }
  if (request.grant !== undefined) {
    return activeAgent(state, request.grant.agent) && now - anchorClock(state, request.grant.seq, request.grant.tick) <= BOARD_LIMITS.helpWaitMessages;
  }
  return now - anchorClock(state, request.seq ?? 0, request.tick) <= BOARD_LIMITS.helpWaitMessages;
}

/**
 * May `agent` fork the requester's repo for help request `requestId`? The
 * check the fork routes run BEFORE forking anything (so a fork the board would
 * refuse to grant is never made): the request grants a scope, is live and not
 * yet granted, and the agent is another joined, non-lead agent. Returns the
 * requester whose repo is forked. Throws a BoardError otherwise.
 */
export function checkHelpFork(state: BoardState, requestId: string, agent: string): { readonly requester: string } {
  const request = state.help[requestId] ?? fail("UNKNOWN_REF", `unknown help request ${requestId}`);
  if (!activeAgent(state, agent)) {
    fail("UNKNOWN_AGENT", `${agent} is not a joined agent of this board`);
  }
  if (state.agents[agent]?.role === LEAD_ROLE) {
    fail("NOT_ALLOWED", `${agent} is the lead and does not edit`);
  }
  if (request.by === agent) {
    fail("NOT_ALLOWED", "an agent cannot fork for its own help request");
  }
  if (request.scope === undefined) {
    fail("NOT_ALLOWED", `help request ${requestId} grants no scope: there is nothing to fork for`);
  }
  if (request.to !== undefined && !request.to.includes(agent)) {
    fail("NOT_ALLOWED", `help request ${requestId} grants its scope to ${request.to.join(", ")} only`);
  }
  if (request.grant !== undefined) {
    fail("DUPLICATE", `help request ${requestId} is already granted to ${request.grant.agent}`);
  }
  if (!helpGrantLive(state, request)) {
    fail("INVALID_STATE", `help request ${requestId}'s grant has lapsed or closed`);
  }
  return { requester: request.by };
}

/** True when the latest failing revision implicates `item` and its output names `path`. */
function failingCheckNames(state: BoardState, item: string, path: string): boolean {
  const failure = state.lastFailure;
  return failure !== null && failure.items.includes(item) && failure.output.split(/[\s()'"`]+/).some((token) => {
    const clean = token.replace(/:\d+(:\d+)?$/, "").replace(/^\.\//, "");
    return clean === path || clean.endsWith(`/${path}`);
  });
}

/**
 * The CONTRACT CUE of an owner's failing item: protected paths (the original
 * tests, the gate's configuration) the failing output names, i.e. the failing
 * check is in the contract. If that check encodes the old behavior the goal
 * changes, the owner proposes a contract change for it (a human decides).
 */
export function contractCue(state: BoardState, item: string): string[] {
  const failure = state.lastFailure;
  if (failure === null || !failure.items.includes(item)) {
    return [];
  }
  // Never the acceptance gate: its failures ARE the goal.
  return state.protected.filter((p) => !hasWildcard(p) && !(state.immutable ?? []).includes(p) && failingCheckNames(state, item, p)).sort();
}

/** True when an item's scope or write intent covers a path. */
function itemCovers(item: BoardItem, path: string): boolean {
  return [...item.scopeHint, ...(item.intent?.write ?? [])].some((e) => entryWithin(path, intentPath(e)));
}

/**
 * SEAM FIRST: the seam-changing items `itemId` must wait for: seam items
 * that hold dependents (`seamItemHolding`: an accepted seam contract's item,
 * claimed, making progress) whose scope covers a shared seam; `itemId` depends on it when its own
 * scope covers a file importing that seam (and it does not change that seam
 * itself). The wait is bounded by PROGRESS: after `seamWaitMessages` board
 * messages since the seam item's grant or latest push, or once it is recorded
 * stalled (seam.stalled, when the board goes quiet), dependents proceed
 * anyway. Pure.
 */
export function seamWaits(state: BoardState, itemId: string): { readonly item: string; readonly seams: readonly string[] }[] {
  const item = state.items[itemId];
  // A seam item never waits on another seam item (a seam that imports a seam
  // would otherwise chain holds).
  if (!item || item.tool !== undefined || item.fromContract !== undefined || (state.seams ?? []).length === 0) {
    return [];
  }
  const out: { item: string; seams: string[] }[] = [];
  for (const other of Object.values(state.items)) {
    if (other.id === itemId || !seamItemHolding(state, other)) {
      continue;
    }
    const seams = (state.seams ?? [])
      .filter((seam) => itemCovers(other, seam.path) && !itemCovers(item, seam.path) && seam.importers.some((imp) => itemCovers(item, imp)))
      .map((seam) => seam.path);
    if (seams.length > 0) {
      out.push({ item: other.id, seams });
    }
  }
  return out.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

/**
 * THE predicate for "this seam item may hold dependents" (the hold, the
 * digest's waitsFor, seamHolds, and the stall check all use it): an item
 * carrying an ACCEPTED SEAM CONTRACT (`fromContract`; an item whose scope
 * merely covers a seam path never holds anyone), claimed by someone, whose
 * latest push has not been gated by a revision yet, not recorded stalled since its grant, and still
 * making PROGRESS (its grant or latest push within `seamWaitMessages`).
 */
export function seamItemHolding(state: BoardState, other: BoardItem): boolean {
  if (other.fromContract === undefined || other.tool !== undefined || (other.status !== "claimed" && other.status !== "contested")) {
    return false;
  }
  const activity = Math.max(other.grantedSeq ?? other.proposedSeq, other.lastPush?.seq ?? 0);
  const waited = arbitrationV2(state) ? boardClock(state) - (other.activityTick ?? 0) : state.lastSeq - activity;
  // Once its push was GATED (merged into a revision, pass or fail), dependents
  // merge with it in every later revision: holding them longer only stalls
  // them on failures that are not the seam's.
  return other.lastPush?.gatedIn === undefined && other.seamStalledSeq === undefined && waited <= BOARD_LIMITS.seamWaitMessages;
}

/**
 * Under arbitration revision 3: true when a held item WAITS ON OTHERS, not on
 * its holder: the holder's latest push was GATED in a revision (pass or fail),
 * it was not left out (push.excluded), and no fix is owed on it (no fix
 * request, no spent fix budget, not implicated by a failing revision since
 * that push). With a whole-goal gate that passes only when every item's fix
 * is in, such an item can do nothing until the others land. Always false
 * before revision 3. Pure.
 */
export function waitingOnOthers(state: BoardState, item: BoardItem): boolean {
  if (!arbitrationV3(state) || (item.status !== "claimed" && item.status !== "contested") || item.owner === undefined) {
    return false;
  }
  const push = item.lastPush;
  if (push === undefined || push.agent !== item.owner || push.gatedIn === undefined || push.excluded !== undefined || push.regressed !== undefined) {
    return false;
  }
  if (item.fixRequested !== undefined || item.fixExhausted === true) {
    return false;
  }
  // Implicated by a failing revision after this push: its fix request follows.
  return push.integratedIn !== undefined || item.implicatedSeq === undefined || item.implicatedSeq < push.seq;
}

/**
 * The items counting toward `agent`'s active-claim cap: the change items it
 * holds (or is contesting for) that are UNFINISHED, i.e. its latest push has
 * not passed an integrated revision (under arbitration revision 3: the holder
 * still owes work on it: no push yet, a push not yet gated, an excluded push,
 * or a fix owed; an item waiting on others does not count). The hoarding
 * protection holds either way: an agent claims again only once its current
 * item's push has been through a gate. Seam items, tool items, and split
 * items (a sub-lead's) are exempt. Pure.
 */
export function activeClaims(state: BoardState, agent: string): string[] {
  return Object.values(state.items)
    .filter((i) => {
      if (i.fromContract !== undefined || i.tool !== undefined) {
        return false;
      }
      if (i.status === "contested" && i.claimant?.agent === agent) {
        return true;
      }
      if ((i.status !== "claimed" && i.status !== "contested") || i.owner !== agent) {
        return false;
      }
      const passed = i.lastPush !== undefined && i.lastPush.agent === agent && i.lastPush.integratedIn !== undefined && i.fixRequested === undefined;
      return !passed && !waitingOnOthers(state, i);
    })
    .map((i) => i.id)
    .sort();
}

/** The claim cap `agent` is at (it may not claim another change item), or undefined. Pure. */
export function claimCapReached(state: BoardState, agent: string): { readonly cap: number; readonly holding: readonly string[] } | undefined {
  const cap = state.rules.maxActiveClaims;
  if (cap === undefined) {
    return undefined;
  }
  const holding = activeClaims(state, agent);
  return holding.length >= cap ? { cap, holding } : undefined;
}

/**
 * The live claims of OTHER agents whose item's planner-declared scope overlaps
 * `itemId`'s scope (tool items aside), with the overlapping entries (bounded).
 * Advisory input: write intents that overlap contest instead. Pure.
 */
export function scopeOverlaps(state: BoardState, itemId: string, agent: string): { readonly item: string; readonly agent: string; readonly files: readonly string[] }[] {
  const item = state.items[itemId];
  if (!item || item.tool !== undefined || item.scopeHint.length === 0) {
    return [];
  }
  return Object.values(state.items)
    .filter((o) => o.id !== itemId && o.status === "claimed" && o.owner !== undefined && o.owner !== agent && o.tool === undefined && !isAncestor(state, o.id, itemId) && !isAncestor(state, itemId, o.id))
    .flatMap((o) => {
      const files = overlappingEntries(item.scopeHint, o.scopeHint).slice(0, 16);
      return files.length > 0 ? [{ item: o.id, agent: o.owner!, files }] : [];
    })
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

/** True when the board runs under claim leases or claim deadlines (rules recorded in goal.posted). */
export function leasesOn(state: BoardState): boolean {
  return state.rules.claimLeaseMessages !== undefined || state.rules.claimDeadlineMessages !== undefined;
}

/** True under arbitration revision 2 or later (rules.arbitration, recorded in goal.posted). Pure. */
export function arbitrationV2(state: BoardState): boolean {
  return (state.rules.arbitration ?? 1) >= 2;
}

/** True under arbitration revision 3 or later (waiting on others; see BoardRules.arbitration). Pure. */
export function arbitrationV3(state: BoardState): boolean {
  return (state.rules.arbitration ?? 1) >= 3;
}

/** True under arbitration revision 4 or later (a stalled lapse nobody else can take; see BoardRules.arbitration). Pure. */
export function arbitrationV4(state: BoardState): boolean {
  return (state.rules.arbitration ?? 1) >= 4;
}

/** True under arbitration revision 5 or later (the pre-pass progress ratchet; see BoardRules.arbitration). Pure. */
export function arbitrationV5(state: Pick<BoardState, "rules">): boolean {
  return (state.rules.arbitration ?? 1) >= 5;
}

/** True under arbitration revision 6 or later (settled seam items, addressed questions; see BoardRules.arbitration). Pure. */
export function arbitrationV6(state: Pick<BoardState, "rules">): boolean {
  return (state.rules.arbitration ?? 1) >= 6;
}

/** True under arbitration revision 7 or later (one writer per released test; see BoardRules.arbitration). Pure. */
export function arbitrationV7(state: Pick<BoardState, "rules">): boolean {
  return (state.rules.arbitration ?? 1) >= 7;
}

/**
 * True when `failure` is the failing revision `item`'s open fix request is
 * about: the revision that asked, or, under arbitration revision 7, a later
 * failing revision implicating the same unanswered push (it asked nothing
 * new; its output is the freshest evidence). Pure.
 */
function fixOwedFor(state: BoardState, item: BoardItem, failure: NonNullable<BoardState["lastFailure"]>): boolean {
  if (item.fixRequested === undefined) {
    return false;
  }
  return item.fixRequested === failure.n || (arbitrationV7(state) && failure.items.includes(item.id));
}

/**
 * The board's clock now: participant (non-engine) messages so far under
 * arbitration revision 2, else the board seq. Every clock (lease, deadline,
 * lapse cooldown, contest idle, seam wait, help wait) is measured on it. Pure.
 */
export function boardClock(state: BoardState): number {
  return arbitrationV2(state) ? (state.ticks ?? 0) : state.lastSeq;
}

/** An anchor's clock value: its tick under revision 2, else its seq. */
function anchorClock(state: BoardState, seq: number, tick: number | undefined): number {
  return arbitrationV2(state) ? (tick ?? 0) : seq;
}

/** The tick to stamp on an anchor the message being applied sets (revision 2 only). */
function tickStamp(state: BoardState): { tick?: number } {
  return arbitrationV2(state) ? { tick: state.ticks ?? 0 } : {};
}

/**
 * Why the engine may NOT close `item` on its owner's behalf (an engine close
 * records item.completed with `closedBy: engine`), or undefined when it may:
 * a held change item whose owner's LATEST push was merged by a passing
 * revision while the board's latest revision is a passing one, with no fix
 * request, regression, exclusion, unverified merge, pending contract, open
 * contest, or taken help grant outstanding. Only an owner who did not propose
 * done is closed this way (a done proposal completes on the pass itself). Pure.
 */
export function engineCloseRefusal(state: BoardState, item: BoardItem): string | undefined {
  if (!isChangeItem(item)) {
    return "it is not an accepted change item";
  }
  if (item.status !== "claimed" || item.owner === undefined) {
    return `it is ${item.status}, not held by an owner`;
  }
  if (item.doneProposed) {
    return "its owner proposed done";
  }
  const push = item.lastPush;
  if (push === undefined || push.agent !== item.owner) {
    return "its owner never pushed for it";
  }
  if (push.integratedIn === undefined || !state.passingRevs.includes(push.integratedIn)) {
    return "no passing revision merged its latest push";
  }
  if (state.integrated == null || state.lastRevN !== state.integrated.n) {
    return `the board's latest revision (${state.lastRevN}) did not pass`;
  }
  if (item.fixRequested !== undefined) {
    return `a fix is outstanding (requested by rev ${item.fixRequested})`;
  }
  if (push.regressed !== undefined || push.excluded !== undefined || push.unverifiedIn !== undefined) {
    return "its latest push was regressed, excluded, or unverified";
  }
  if (Object.values(state.contracts).some((c) => c.status === "proposed" && c.item === item.id)) {
    return "a contract for it waits for a decision";
  }
  if (pendingContestOn(state, item.id) !== undefined) {
    return "a contest on it is open";
  }
  if (takenHelpGrants(state, item.id).length > 0) {
    return "a helper holds a grant on it";
  }
  return undefined;
}

/** An item the engine may close on its owner's behalf, with what backs the close. */
export interface BoardEngineClose {
  readonly item: string;
  readonly owner: string;
  /** The passing revision that merged the owner's latest push. */
  readonly n: number;
  /** The seq of the owner's latest push.announced. */
  readonly pushSeq: number;
  readonly commit: string;
}

/** Every item the engine may close now (see engineCloseRefusal), in proposal order. Pure. */
export function engineClosableItems(state: BoardState): BoardEngineClose[] {
  return Object.values(state.items)
    .filter((i) => engineCloseRefusal(state, i) === undefined)
    .sort((a, b) => a.proposedSeq - b.proposedSeq)
    .map((i) => ({ item: i.id, owner: i.owner!, n: i.lastPush!.integratedIn!, pushSeq: i.lastPush!.seq, commit: i.lastPush!.commit }));
}

/**
 * Why a held claim cannot lapse right now (its lease is SUSPENDED), or
 * undefined. A claim never lapses while the holder waits on someone else: its
 * push waits for the gate (a lapse would drop a push integration is about to
 * gate), its tool build waits for its own gate, its push already passed (only
 * the done proposal is left), a contract for the item waits for a decision,
 * or a helper holds a taken grant on it. Pure.
 */
export function leaseSuspension(state: BoardState, item: BoardItem): string | undefined {
  const push = item.lastPush;
  if (push !== undefined && push.agent === item.owner && push.gatedIn === undefined && push.excluded === undefined) {
    return "its push waits for the gate";
  }
  if (item.toolBuild !== undefined && item.toolBuild.gated !== true) {
    return "its tool build waits for its own gate";
  }
  if (push !== undefined && push.agent === item.owner && push.integratedIn !== undefined && item.fixRequested === undefined) {
    return "its push passed";
  }
  if (Object.values(state.contracts).some((c) => c.status === "proposed" && c.item === item.id)) {
    return "a contract for it waits for a decision";
  }
  if (takenHelpGrants(state, item.id).length > 0) {
    return "a helper holds a grant on it";
  }
  if (pendingContestOn(state, item.id) !== undefined) {
    // A contest settles its own way (turns, idle escalation, a human): a lapse never decides it.
    return "a contest on it is open";
  }
  return undefined;
}

/** A lapse a held claim is due for. */
export interface BoardLeaseLapse {
  readonly reason: "no-progress" | "deadline";
  readonly lastProgressSeq: number;
  readonly deadlineSeq?: number;
}

/**
 * The lapse a held claim is due for at board seq `now`, or undefined: its firm
 * deadline is reached, or (lease rule) no progress for `claimLeaseMessages`
 * messages and it is not waiting on a seam change (nor, under arbitration
 * revision 3, waiting on others: see waitingOnOthers). Never while suspended
 * (see leaseSuspension). Measured in board messages, so the same log always
 * derives the same lapses. Pure.
 */
export function leaseLapse(state: BoardState, itemId: string, now: number = state.lastSeq): BoardLeaseLapse | undefined {
  const item = state.items[itemId];
  const lease = item?.lease;
  if (!item || !lease || item.status !== "claimed" || item.owner === undefined || !activeAgent(state, item.owner)) {
    return undefined;
  }
  if (leaseSuspension(state, item) !== undefined) {
    return undefined;
  }
  // Revision 2 measures on participant messages: a look-ahead past the
  // board's last seq counts as that many more of them (at most).
  const clock = arbitrationV2(state) ? boardClock(state) + Math.max(0, now - state.lastSeq) : now;
  const deadlineAt = arbitrationV2(state) ? lease.deadlineTick : lease.deadlineSeq;
  if (lease.deadlineSeq !== undefined && deadlineAt !== undefined && clock >= deadlineAt) {
    return { reason: "deadline", lastProgressSeq: lease.progressSeq, deadlineSeq: lease.deadlineSeq };
  }
  const limit = state.rules.claimLeaseMessages;
  // Revision 3: an item waiting on others has nothing for its holder to do
  // (its push was gated and no fix is owed): no-progress never lapses it.
  if (
    limit !== undefined &&
    clock - anchorClock(state, lease.progressSeq, lease.progressTick) >= limit &&
    seamWaits(state, item.id).length === 0 &&
    !waitingOnOthers(state, item)
  ) {
    return { reason: "no-progress", lastProgressSeq: lease.progressSeq };
  }
  return undefined;
}

/** Board messages after a lapse before its holder may claim the item again (one lease, else a quarter deadline). */
function lapseCooldown(state: BoardState): number {
  return state.rules.claimLeaseMessages ?? Math.ceil((state.rules.claimDeadlineMessages ?? 0) / 4);
}

/**
 * Under arbitration revision 4: true when `agent`'s claim on `item` lapsed as
 * STALLED and no other active worker could take the item (each other active,
 * non-lead agent not barred from it is at its claim cap, or there is none), so
 * the lapse cooldown, which exists to let another agent take it first, does
 * not apply. Always false before revision 4. Pure.
 */
export function stalledLapseUntakeable(state: BoardState, item: BoardItem, agent: string): boolean {
  if (!arbitrationV4(state) || item.lastLapse?.reason !== "stalled" || item.lastLapse.agent !== agent) {
    return false;
  }
  return Object.values(state.agents)
    .filter((a) => a.id !== agent && a.leftSeq === undefined && a.role !== LEAD_ROLE && !(item.exhaustedBy ?? []).includes(a.id))
    .every((a) => claimCapReached(state, a.id) !== undefined);
}

/** A fresh lease for a claim granted (or handed off) at `seq`, under the board's lease rules. */
function newLease(state: BoardState, seq: number): BoardItem["lease"] {
  const deadline = state.rules.claimDeadlineMessages;
  const tick = arbitrationV2(state) ? (state.ticks ?? 0) : undefined;
  return {
    progressSeq: seq,
    ...(deadline !== undefined ? { deadlineSeq: seq + deadline } : {}),
    extensions: 0,
    ...(tick !== undefined ? { progressTick: tick, ...(deadline !== undefined ? { deadlineTick: tick + deadline } : {}) } : {}),
  };
}

/**
 * Revision 2: push a held claim's deadline out by `seqs` board messages and
 * `ticks` participant messages (time it was not charged for), and to at least
 * one lease window from now when `window` is set (a fix request).
 */
function creditDeadline(state: BoardState, item: BoardItem, credit: { seqs: number; ticks: number } | undefined, window?: boolean): void {
  const lease = item.lease;
  if (!arbitrationV2(state) || lease?.deadlineSeq === undefined || lease.deadlineTick === undefined) {
    return;
  }
  if (credit !== undefined) {
    lease.deadlineSeq += Math.max(0, credit.seqs);
    lease.deadlineTick += Math.max(0, credit.ticks);
  }
  if (window) {
    const span = lapseCooldown(state);
    lease.deadlineSeq = Math.max(lease.deadlineSeq, state.lastSeq + span);
    lease.deadlineTick = Math.max(lease.deadlineTick, (state.ticks ?? 0) + span);
  }
}

/** Revision 2: a different agent now holds the item, so it starts with a fresh fix budget. */
function grantBudget(state: BoardState, item: BoardItem, agent: string): void {
  if (!arbitrationV2(state)) {
    return;
  }
  if (item.budgetHolder !== undefined && item.budgetHolder !== agent) {
    item.fixAttempts = 0;
    delete item.toolFailures;
    delete item.fixExhausted;
  }
  item.budgetHolder = agent;
}

/** The holder's (or, `by` undefined, the engine's or a granted helper's) progress on a held item renews its lease. */
function renewLease(state: BoardState, itemId: string | undefined, seq: number, by?: string): void {
  const item = itemId !== undefined ? state.items[itemId] : undefined;
  if (item?.lease !== undefined && item.status === "claimed" && (by === undefined || by === item.owner)) {
    item.lease.progressSeq = seq;
    if (arbitrationV2(state)) {
      item.lease.progressTick = state.ticks ?? 0;
    }
  }
}

/**
 * Why an item that is not moving is waiting, derived from recorded board state
 * only (never invented): every kind names the state that holds it.
 */
export type BoardWaitReason =
  /** It (or its claim) waits for a seam item's change (SEAM_FIRST, bounded). */
  | { readonly kind: "waiting-on-seam"; readonly item: string; readonly seams: readonly string[] }
  /** Open, and every joined worker that may take it is at its claim cap. */
  | { readonly kind: "held-by-claim-cap"; readonly agents: number }
  /** Open because its holder's claim lapsed (no progress, deadline, or stalled on a quiet board). */
  | { readonly kind: "lease-lapsed"; readonly agent: string; readonly reason: "no-progress" | "deadline" | "stalled"; readonly lastProgressSeq: number; readonly seq: number }
  /** A human decides first: a protected contract for it, or an escalated contest on it. */
  | { readonly kind: "waiting-for-human"; readonly contract?: string; readonly contest?: string }
  /** The lead decides first: a seam contract for it, or (a worker's proposal) the item itself. */
  | { readonly kind: "waiting-for-lead"; readonly contract?: string }
  /** Another item holds it: a contest's owner item, a split item's unfinished child, a sub-lead's parent. */
  | { readonly kind: "blocked-by"; readonly item: string }
  /** Its holder's push waits for the sub-lead `agent` of `item` (its parent): to merge it (pull), or (`merged`) for the gate on the merge. */
  | { readonly kind: "waiting-for-sub-lead"; readonly item: string; readonly agent: string; readonly merged: boolean }
  /** Its holder's latest push waits for an integrated revision to gate it (the revision has no number yet). */
  | { readonly kind: "waiting-for-gate"; readonly commit: string }
  /** Its holder's latest push was left out of integration (push.excluded): the holder pushes again. */
  | { readonly kind: "push-excluded"; readonly commit: string; readonly reason: string }
  /** Revision 5: its holder's latest push made revision `rev` worse (push.regressed: the stack scores better without it): the holder pushes a fix. */
  | { readonly kind: "push-regressed"; readonly commit: string; readonly rev: number }
  /** Revision 3: its holder's push was gated in revision `rev` and no fix is owed: it waits for the other items (see waitingOnOthers). */
  | { readonly kind: "waiting-on-others"; readonly commit: string; readonly rev: number }
  /** Its fix budget was spent (by these agents): fresh eyes or a re-plan. */
  | { readonly kind: "fix-budget-exhausted"; readonly by: readonly string[] }
  /** Open and nothing holds it: any agent may claim it. */
  | { readonly kind: "unclaimed" };

/**
 * The reason an item is not moving, or undefined when it is (its holder acts
 * next) or it is finished. Derived from recorded state only. Pure.
 */
export function itemWaitReason(state: BoardState, itemId: string): BoardWaitReason | undefined {
  const item = state.items[itemId];
  if (!item || item.status === "done" || item.status === "rejected") {
    return undefined;
  }
  if (item.status === "proposed") {
    return { kind: "waiting-for-lead" };
  }
  if (item.status === "contested") {
    const contest = item.claimant !== undefined ? state.contests[item.claimant.contest] : undefined;
    if (contest?.status === "escalated") {
      return { kind: "waiting-for-human", contest: contest.id };
    }
    return contest !== undefined ? { kind: "blocked-by", item: contest.ownerItem } : undefined;
  }
  if (item.status === "split") {
    // A child's push waiting for this item's sub-lead to merge it: the
    // sub-lead acts next (never "blocked by" that child, which waits on it).
    if (item.children.some((c) => state.items[c] !== undefined && awaitsSubLeadMerge(state, state.items[c]!))) {
      return undefined;
    }
    const open = item.children.filter((c) => state.items[c]?.status !== "done");
    if (open.length > 0) {
      return { kind: "blocked-by", item: open[0]! };
    }
    return item.lastPush !== undefined && item.lastPush.gatedIn === undefined ? { kind: "waiting-for-gate", commit: item.lastPush.commit } : undefined;
  }
  const seams = seamWaits(state, item.id);
  if (item.status === "open") {
    if (seams.length > 0) {
      return { kind: "waiting-on-seam", item: seams[0]!.item, seams: [...seams[0]!.seams] };
    }
    if (item.lastLapse !== undefined) {
      const l = item.lastLapse;
      return { kind: "lease-lapsed", agent: l.agent, reason: l.reason, lastProgressSeq: l.lastProgressSeq, seq: l.seq };
    }
    if ((item.exhaustedBy ?? []).length > 0) {
      return { kind: "fix-budget-exhausted", by: [...item.exhaustedBy!] };
    }
    const cap = state.rules.maxActiveClaims;
    if (cap !== undefined && item.fromContract === undefined && item.tool === undefined) {
      const takers = Object.values(state.agents).filter((a) => a.leftSeq === undefined && a.role !== LEAD_ROLE && !(item.exhaustedBy ?? []).includes(a.id));
      if (takers.length > 0 && takers.every((a) => claimCapReached(state, a.id) !== undefined)) {
        return { kind: "held-by-claim-cap", agents: takers.length };
      }
    }
    return { kind: "unclaimed" };
  }
  // Claimed.
  const pending = Object.values(state.contracts).find((c) => c.status === "proposed" && c.item === item.id);
  if (pending !== undefined) {
    return pending.guarded ? { kind: "waiting-for-human", contract: pending.contract } : { kind: "waiting-for-lead", contract: pending.contract };
  }
  if (seams.length > 0) {
    return { kind: "waiting-on-seam", item: seams[0]!.item, seams: [...seams[0]!.seams] };
  }
  const push = item.lastPush;
  if (push !== undefined && push.agent === item.owner && push.gatedIn === undefined && push.excluded !== undefined) {
    return { kind: "push-excluded", commit: push.commit, reason: push.excluded.reason };
  }
  if (push !== undefined && push.agent === item.owner && push.integratedIn === undefined && push.regressed !== undefined && !item.fixExhausted) {
    return { kind: "push-regressed", commit: push.commit, rev: push.regressed.rev };
  }
  if (push !== undefined && push.agent === item.owner && push.gatedIn === undefined) {
    if (routedToSubLead(state, item)) {
      const parent = state.items[item.parent!]!;
      return { kind: "waiting-for-sub-lead", item: parent.id, agent: parent.subLead!, merged: !awaitsSubLeadMerge(state, item) && push.unverifiedIn === undefined };
    }
    return { kind: "waiting-for-gate", commit: push.commit };
  }
  if (item.fixExhausted) {
    return { kind: "fix-budget-exhausted", by: item.owner !== undefined ? [item.owner] : [] };
  }
  if (push !== undefined && push.integratedIn === undefined && waitingOnOthers(state, item)) {
    return { kind: "waiting-on-others", commit: push.commit, rev: push.gatedIn! };
  }
  return undefined;
}

/** One short line for a wait reason (digests, the console's cards). */
export function describeWaitReason(reason: BoardWaitReason): string {
  switch (reason.kind) {
    case "waiting-on-seam":
      return `waits on the seam change ${reason.item} (${reason.seams.join(", ")})`;
    case "held-by-claim-cap":
      return `open, but all ${reason.agents} agent(s) are at their claim cap`;
    case "lease-lapsed":
      return `${reason.agent}'s claim lapsed (${reason.reason === "deadline" ? "deadline" : reason.reason === "stalled" ? "stalled on a quiet board" : `no progress since seq ${reason.lastProgressSeq}`}): open to take`;
    case "waiting-for-human":
      return reason.contract !== undefined ? `waits for a human decision on contract ${reason.contract}` : `waits for a human to settle contest ${reason.contest ?? "?"}`;
    case "waiting-for-lead":
      return reason.contract !== undefined ? `waits for the lead's decision on contract ${reason.contract}` : "proposed: waits for the lead's decision";
    case "blocked-by":
      return `blocked by ${reason.item}`;
    case "waiting-for-sub-lead":
      return reason.merged
        ? `its push is in sub-lead ${reason.agent}'s push for ${reason.item}, which waits for the gate`
        : `its push waits for sub-lead ${reason.agent} to merge it into ${reason.item} (pull)`;
    case "waiting-for-gate":
      return `push ${reason.commit.slice(0, 10)} waits for the gate`;
    case "push-excluded":
      return `push ${reason.commit.slice(0, 10)} was left out of integration (${reason.reason.slice(0, 160)}): its holder pushes again`;
    case "push-regressed":
      return `push ${reason.commit.slice(0, 10)} made revision ${reason.rev} worse (the stack scores better without it): it is not stacked until its holder pushes a fix`;
    case "waiting-on-others":
      return `push ${reason.commit.slice(0, 10)} was gated in revision ${reason.rev} and owes no fix: it waits on the other items`;
    case "fix-budget-exhausted":
      return `fix budget spent${reason.by.length > 0 ? ` by ${reason.by.join(", ")}` : ""}: fresh eyes or a re-plan`;
    case "unclaimed":
      return "unclaimed: open to take";
  }
}

/** Why an item is re-planned (see replanEligible). */
export const BOARD_REPLAN_REASONS = ["fix-budget-exhausted", "stalled", "item-cap"] as const;
export type BoardReplanReason = (typeof BOARD_REPLAN_REASONS)[number];

/**
 * Why the lead may RE-PLAN an item now (`item.replanned`), or undefined: a
 * change item (not a tool or seam item, not itself a re-plan's child) that is
 * open and whose fix budget was spent by some agent, or that was released for
 * not moving `stallReleasesBeforeReplan` times; or one, open or still held,
 * whose per-item model-call cap was reached (a recorded `run.capped` of kind
 * item-calls: no agent can make another call on it, so only a re-plan into
 * new items moves it). Once re-planned it is split (its children carry it),
 * so it is re-planned at most once. The reasons are checked in that order, so
 * a recorded log keeps the reason it had. Pure.
 */
export function replanEligible(state: BoardState, itemId: string): BoardReplanReason | undefined {
  const item = state.items[itemId];
  if (!item || item.tool !== undefined || item.fromContract !== undefined || item.replanOf !== undefined) {
    return undefined;
  }
  if (item.status === "open") {
    if ((item.exhaustedBy ?? []).length > 0) {
      return "fix-budget-exhausted";
    }
    if ((item.stallReleases ?? 0) >= BOARD_LIMITS.stallReleasesBeforeReplan) {
      return "stalled";
    }
  }
  const capped = (state.capped ?? []).some((c) => c.kind === "item-calls" && c.item === item.id);
  return capped && (item.status === "open" || item.status === "claimed") ? "item-cap" : undefined;
}

/** True when a re-plan's child failed again (fix budget spent, or stalled twice) and is not escalated yet. */
function replanFailed(item: BoardItem): boolean {
  return (
    item.replanOf !== undefined &&
    item.escalatedSeq === undefined &&
    ((item.exhaustedBy ?? []).length > 0 || (item.stallReleases ?? 0) >= BOARD_LIMITS.stallReleasesBeforeReplan)
  );
}

/** A stalled seam item is released (open again) when its owner has pushed nothing for it. */
function seamReleasable(item: BoardItem): boolean {
  return item.lastPush === undefined || item.lastPush.agent !== item.owner;
}

/**
 * The seam items holding dependents right now (each with the items waiting
 * on it): what the driver records stalled when the board goes quiet, so
 * SEAM_FIRST holds never end a run quiescent. Pure.
 */
export function seamHolds(state: BoardState): { readonly item: string; readonly dependents: readonly string[] }[] {
  const holds = new Map<string, Set<string>>();
  for (const item of Object.values(state.items)) {
    if (item.status === "done" || item.status === "rejected") {
      continue;
    }
    for (const wait of seamWaits(state, item.id)) {
      holds.set(wait.item, (holds.get(wait.item) ?? new Set()).add(item.id));
    }
  }
  return [...holds].map(([item, dependents]) => ({ item, dependents: [...dependents].sort() })).sort((a, b) => (a.item < b.item ? -1 : 1));
}

/**
 * Mechanical facts the lead weighs on a seam contract (advisory inputs, never
 * a decision): whether the latest failing output (or, under arbitration
 * revision 5, the regression evidence of the item's latest push) names the seam (its path, a
 * path ending in it such as `../contracts/auth.ts`, or a quoted name it
 * exports), and the earlier live seam change it duplicates (an identical
 * description, or the same quoted NEW identifier, one no seam exports yet;
 * pending, or accepted and unfinished). Pure.
 */
export function seamContractFacts(state: BoardState, contractId: string): { readonly namedInFailure: boolean; readonly duplicateOf?: string } {
  const contract = state.contracts[contractId];
  if (contract?.seam === undefined) {
    return { namedInFailure: false };
  }
  // Arbitration revision 5: the item's latest push made its stack worse
  // (push.regressed): the failures its removal removes are failing output too.
  const regression = contract.item !== undefined ? state.items[contract.item]?.lastPush?.regressed : undefined;
  const output = [state.lastFailure?.output ?? "", ...(regression?.evidence ?? [])].join("\n");
  const segments = contract.seam.split("/");
  const pathNamed = segments.some((_, k) => {
    const suffix = segments.slice(k).join("/");
    return k === 0 ? output.includes(suffix) : output.includes(`/${suffix}`);
  });
  const symbols = (state.seams ?? []).find((seam) => seam.path === contract.seam)?.symbols ?? [];
  const quoted = (text: string) => new Set([...text.matchAll(/['"`]([A-Za-z_$][\w$]*)['"`]/g)].map((m) => m[1]!));
  const named = quoted(output);
  const namedInFailure = pathNamed || symbols.some((sym) => named.has(sym));
  const normal = (text: string | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // A NEW name both would add (not one a seam already exports, like the type they extend).
  const existing = new Set((state.seams ?? []).flatMap((seam) => seam.symbols ?? []));
  const mine = new Set([...quoted(contract.description ?? "")].filter((id) => !existing.has(id)));
  const duplicate = Object.values(state.contracts).find(
    (other) =>
      other.contract !== contract.contract &&
      other.seam !== undefined &&
      (other.status === "proposed" || (other.status === "accepted" && state.items[seamItemId(other.contract)]?.status !== "done")) &&
      (other.proposedSeq ?? 0) < (contract.proposedSeq ?? 0) &&
      (normal(other.description) === normal(contract.description) || [...quoted(other.description ?? "")].some((id) => mine.has(id))),
  );
  return { namedInFailure, ...(duplicate ? { duplicateOf: duplicate.contract } : {}) };
}

/** The shared seam a contract target names (`path` or `path#symbol`), if any. */
function seamTarget(state: BoardState, target: string): string | undefined {
  const path = intentPath(target);
  return (state.seams ?? []).find((seam) => seam.path === path)?.path;
}

/**
 * The live item whose scope covers a seam (its owner may change it), if any.
 * Under arbitration revision 6 a SETTLED seam item does not own it: an
 * accepted seam contract's item whose latest push was gated with no fix owed
 * (it waits on the other items) has done its change, so a follow-up change to
 * the seam is a seam contract the lead decides (asking that holder would be
 * a dead route: nothing owed on its item wakes it).
 */
function seamOwner(state: BoardState, seam: string): string | undefined {
  return Object.values(state.items).find(
    (i) => i.status !== "done" && i.status !== "rejected" && i.tool === undefined && itemCovers(i, seam) && !seamItemSettled(state, i),
  )?.id;
}

/** Revision 6: a seam contract's item that waits on others (its push gated, no fix owed) no longer owns its seam. Pure. */
function seamItemSettled(state: BoardState, item: BoardItem): boolean {
  return arbitrationV6(state) && item.fromContract !== undefined && waitingOnOthers(state, item);
}

/** The type-mismatch lines of a failing output (trimmed, bounded): what a seam contract was proposed for. */
function typeMismatchLines(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(?:\.\/)?([^\s()]+)\(\d+,\d+\): error (TS\d+): /.exec(line);
    if (m && TYPE_MISMATCH_CODES.has(m[2]!) && !out.includes(line.trim().slice(0, 300))) {
      out.push(line.trim().slice(0, 300));
      if (out.length >= 8) {
        break;
      }
    }
  }
  return out;
}

/** TypeScript diagnostics that mean a type or contract MISMATCH (a field, member, or signature the code expects but the type lacks). */
const TYPE_MISMATCH_CODES = new Set(["TS2339", "TS2551", "TS2322", "TS2345", "TS2353", "TS2741", "TS2554", "TS2305", "TS2724", "TS2559", "TS2739", "TS2740"]);

/**
 * The SEAM CONTRACT CUE of an owner's failing item: the latest failing revision
 * implicates the item and its output carries type/contract mismatches
 * (`path(line,col): error TS2339: ...`) located in a shared seam, or in a file
 * of the item that imports a shared seam, where that seam is FROZEN (no live
 * item's scope covers it). Instead of using undeclared fields or casts, the
 * owner proposes a seam contract with the exact change; the lead decides it.
 * A seam already asked about for this item (a pending or accepted contract,
 * or one rejected since the item was last implicated; under arbitration
 * revision 6 an accepted one whose seam item settled, see seamOwner, asks
 * nothing once a later failing revision implicates the item) is not cued again; no
 * seam is cued while the item has a seam contract waiting for the lead; and
 * (arbitration revision 6) no seam is cued again after the lead rejected a
 * seam contract for the item proposed for these identical failing errors.
 * Pure.
 */
export function seamContractCue(state: BoardState, itemId: string): { readonly seams: readonly string[]; readonly errors: readonly string[] } | undefined {
  const failure = state.lastFailure;
  const item = state.items[itemId];
  if (failure === null || item === undefined || !failure.items.includes(itemId) || (state.seams ?? []).length === 0) {
    return undefined;
  }
  const mine = Object.values(state.contracts).filter((c) => c.seam !== undefined && c.item === itemId);
  if (mine.some((c) => c.status === "proposed")) {
    return undefined;
  }
  const { seams, errors } = frozenSeamMismatches(state, item, failure.output.split(/\r?\n/));
  const current = typeMismatchLines(failure.output);
  if (
    current.length > 0 &&
    mine.some((c) => c.status === "rejected" && c.failingErrors !== undefined && current.every((line) => c.failingErrors!.includes(line)))
  ) {
    return undefined;
  }
  // Asked: pending; accepted (under revision 6, unless its seam item settled
  // and a later failing revision implicated the item again); or rejected
  // since the item was last implicated.
  const settledSince = (c: (typeof mine)[number]) => {
    const seamItem = state.items[seamItemId(c.contract)];
    return seamItem !== undefined && seamItemSettled(state, seamItem) && (c.decidedSeq ?? 0) < (item.implicatedSeq ?? 0);
  };
  const asked = (seam: string) =>
    mine.some(
      (c) =>
        c.seam === seam &&
        (c.status === "proposed" || (c.status === "accepted" && !settledSince(c)) || (c.status === "rejected" && (c.decidedSeq ?? 0) >= (item.implicatedSeq ?? 0))),
    );
  const open = [...seams].filter((seam) => !asked(seam)).sort();
  return open.length > 0 ? { seams: open, errors } : undefined;
}

/**
 * The FROZEN shared seams the type/contract mismatches among `lines` point at
 * (`path(line,col): error TS2339: ...` located in a seam, or in a file of the
 * item that imports one, named by a type the seam exports), and the first
 * few of those error lines. A seam is matched by a symbol the error NAMES:
 * an error in an importing file that names no symbol of any seam it imports
 * (a local annotation error such as `Type 'Record<string, unknown>' is
 * missing ...`) points at no seam. Only a seam whose exports are unknown (no
 * recorded symbols) falls back to being matched by the import alone. Pure.
 */
function frozenSeamMismatches(state: BoardState, item: BoardItem, lines: readonly string[]): { readonly seams: Set<string>; readonly errors: string[] } {
  const seams = new Set<string>();
  const errors: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:\.\/)?([^\s()]+)\(\d+,\d+\): error (TS\d+): /.exec(line);
    if (!m || !TYPE_MISMATCH_CODES.has(m[2]!)) {
      continue;
    }
    const file = m[1]!;
    const imported = (state.seams ?? []).filter((seam) => seam.path === file || (itemCovers(item, file) && seam.importers.includes(file)));
    // A type the error names (`on type 'Ctx'`) that a seam exports points at THAT seam.
    const named = new Set([...line.matchAll(/['"`]([A-Za-z_$][\w$]*)(?:<[^'"`]*>)?['"`]/g)].map((n) => n[1]!));
    const byName = imported.filter((seam) => seam.path === file || (seam.symbols ?? []).some((sym) => named.has(sym)));
    const hit = byName.length > 0 ? byName : imported.filter((seam) => seam.symbols === undefined);
    const frozen = hit.filter((seam) => seamOwner(state, seam.path) === undefined);
    if (frozen.length === 0) {
      continue;
    }
    for (const seam of frozen) {
      seams.add(seam.path);
    }
    if (errors.length < 4) {
      errors.push(line.trim().slice(0, 300));
    }
  }
  return { seams, errors };
}

/** True when an item changes a shared seam (it goes first). */
export function isSeamItem(state: BoardState, itemId: string): boolean {
  const item = state.items[itemId];
  return item !== undefined && (state.seams ?? []).some((seam) => itemCovers(item, seam.path));
}

/** The live help grants on an item (see helpGrantLive). */
export function liveHelpGrants(state: BoardState, item: string): BoardHelpRequest[] {
  return Object.values(state.help).filter((h) => h.item === item && helpGrantLive(state, h));
}

/**
 * The live grants on an item that a helper has TAKEN (its fork offer is on
 * the board): only these freeze the scope for the requester. A grant nobody
 * has taken yet never blocks the requester's own work.
 */
export function takenHelpGrants(state: BoardState, item: string): BoardHelpRequest[] {
  return liveHelpGrants(state, item).filter((h) => h.grant !== undefined);
}

/**
 * True when an item's pushes go to its parent's SUB-LEAD rather than straight
 * to integration: the parent is split and its sub-lead is still on the board.
 * When the sub-lead has left, its children integrate directly; so does a
 * child the sub-lead itself pushed (or holds, before any push): its work is
 * already in the sub-lead's own repo, and nobody else would ever merge it.
 */
export function routedToSubLead(state: BoardState, item: Pick<BoardItem, "parent" | "owner" | "lastPush">): boolean {
  if (item.parent === undefined) {
    return false;
  }
  const parent = state.items[item.parent];
  if (parent === undefined || parent.status !== "split" || parent.subLead === undefined || !activeAgent(state, parent.subLead)) {
    return false;
  }
  return (item.lastPush?.agent ?? item.owner) !== parent.subLead;
}

/**
 * True when a child's latest push waits for its sub-lead to merge it (routed
 * to the sub-lead, not integrated, not in the sub-lead's latest push, and not
 * recorded unverified at this commit). Pure.
 */
export function awaitsSubLeadMerge(state: BoardState, item: BoardItem): boolean {
  const push = item.lastPush;
  if (push === undefined || push.integratedIn !== undefined || push.unverifiedIn !== undefined || !routedToSubLead(state, item)) {
    return false;
  }
  const parent = state.items[item.parent!]!;
  return !(parent.lastPush?.merges ?? []).some((m) => m.item === item.id && m.commit === push.commit);
}

/**
 * A split item completes when every child is done and, when its sub-lead
 * announced a push for it, that push passed in an integrated revision (a
 * sub-lead that left never blocks it).
 */
function splitReady(state: BoardState, item: BoardItem): boolean {
  if (item.status !== "split" || !item.children.every((c) => state.items[c]?.status === "done")) {
    return false;
  }
  return item.lastPush === undefined || item.lastPush.integratedIn !== undefined || item.subLead === undefined || !activeAgent(state, item.subLead);
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
      if (draft.type === "item.proposed") {
        const fromContract = draft.payload.fromContract;
        if (draft.from === BOARD_ENGINE) {
          // The engine proposes only the seam item of an accepted seam contract.
          const contract = fromContract === undefined ? undefined : state.contracts[fromContract];
          if (contract === undefined || contract.seam === undefined || contract.status !== "accepted" || draft.payload.item !== seamItemId(contract.contract)) {
            fail("NOT_ALLOWED", "the engine proposes an item only for an accepted seam contract");
          }
        } else if (fromContract !== undefined) {
          fail("NOT_ALLOWED", "only the engine proposes an item from a seam contract (the lead accepts the contract)");
        }
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
      // A lapsed holder does not take the item straight back: another agent
      // gets it first, or the lease period passes (counted in board messages).
      const sinceLapse = item.lastLapse !== undefined ? boardClock(state) - anchorClock(state, item.lastLapse.seq, item.lastLapse.tick) : 0;
      if (item.lastLapse?.agent === draft.from && sinceLapse < lapseCooldown(state) && !stalledLapseUntakeable(state, item, draft.from)) {
        fail(
          "NOT_ALLOWED",
          arbitrationV2(state)
            ? `${draft.from}'s claim on ${item.id} lapsed at seq ${item.lastLapse.seq}: another agent takes it first (or claim it again after ${lapseCooldown(state) - sinceLapse} more participant message(s))`
            : `${draft.from}'s claim on ${item.id} lapsed at seq ${item.lastLapse.seq}: another agent takes it first (or claim it again after seq ${item.lastLapse.seq + lapseCooldown(state)})`,
        );
      }
      // No hoarding: an agent at its active-claim cap finishes (or hands off)
      // first. Seam and tool items are exempt (a held item may need them).
      if (item.fromContract === undefined && item.tool === undefined) {
        const capped = claimCapReached(state, draft.from);
        if (capped) {
          fail(
            "CLAIM_CAP",
            `${draft.from} holds ${capped.holding.length} unfinished item(s) (${capped.holding.join(", ")}; cap ${capped.cap}): finish one (${arbitrationV3(state) ? "push it and let the gate take it with no fix asked" : "push it and let it pass an integrated revision"}) or hand it off before claiming ${item.id}`,
          );
        }
      }
      // A change to a shared seam goes first: an item covering the seam's
      // importers waits (bounded) until the seam item's push is integrated.
      const waits = seamWaits(state, item.id);
      if (waits.length > 0) {
        fail(
          "SEAM_FIRST",
          `item ${item.id} edits files that import a shared seam item ${waits.map((w) => `${w.item} changes (${w.seams.join(", ")})`).join("; ")}; ` +
            "it waits for that change's integrated revision (bounded), then rebase and claim it",
        );
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
        const gate = locked.filter((p) => (state.immutable ?? []).includes(p));
        if (gate.length > 0) {
          fail(
            "PROTECTED",
            `write intent ${entries.join(", ")} overlaps the immutable acceptance gate (${gate.slice(0, 8).join(", ")}${gate.length > 8 ? ", ..." : ""}): it is never changed; narrow your write intent to the code under test (new test files outside the gate are fine)`,
          );
        }
        fail(
          "PROTECTED",
          `write intent ${entries.join(", ")} overlaps protected path(s) ${locked.slice(0, 8).join(", ")}${locked.length > 8 ? ", ..." : ""}: ` +
            "changing an existing test or the gate's configuration is a contract change; post contract.proposed " +
            "{target, kind, item} and claim again once the lead or a human accepts it",
        );
      }
      // Two holders never share a shared seam: a claim WRITING a seam another
      // holder's item scope covers is refused, pointing at the seam route.
      if (state.rules.claimOverlap === true) {
        for (const seam of state.seams ?? []) {
          if (!write.some((w) => entryWithin(seam.path, intentPath(w)))) {
            continue;
          }
          const other = Object.values(state.items).find(
            (o) => o.id !== item.id && o.status === "claimed" && o.owner !== undefined && o.owner !== draft.from && o.tool === undefined && o.scopeHint.some((h) => entryWithin(seam.path, h)),
          );
          if (other) {
            fail(
              "SEAM_OVERLAP",
              `${item.id} and ${other.id} (held by ${other.owner}) both touch the shared seam ${seam.path}: leave it out of your write intent and ask ${other.owner} (a question naming ${other.id}), or, once no item's scope covers it, propose a seam contract {target: ${seam.path}, kind: modify, item: ${item.id}, description} the lead decides`,
            );
          }
        }
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
      const clash = liveClaims(state, draft.payload.agent, undefined, item.id).find(
        (holder) => overlappingEntries(draft.payload.intent.write, holder.intent!.write).length > 0,
      );
      if (clash) {
        fail("INTENT_OVERLAP", `a grant of ${item.id} would overlap ${clash.owner}'s claim on ${clash.id}`);
      }
      return;
    }
    case "claim.contested": {
      const item = requireItem(state, draft.payload.item);
      const ownerItem = requireItem(state, draft.payload.ownerItem);
      if (!((ownerItem.status === "claimed" || ownerItem.status === "split") && ownerItem.owner === draft.payload.owner)) {
        fail("NOT_OWNER", `${draft.payload.owner} does not hold the claim on item ${ownerItem.id}`);
      }
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
    case "claim.ceded": {
      const contest = requireContestParty(state, draft.payload.contest, draft.from);
      if (draft.from === contest.owner && state.items[contest.ownerItem]?.status === "split") {
        fail("NOT_ALLOWED", `${contest.ownerItem} is split: its sub-lead keeps its scope (the claimant narrows, cedes, or claims one of its children)`);
      }
      return;
    }
    case "claim.narrowed": {
      const contest = requireContestParty(state, draft.payload.contest, draft.from);
      if (draft.from === contest.owner && state.items[contest.ownerItem]?.status === "split") {
        fail("NOT_ALLOWED", `${contest.ownerItem} is split: its children divide its scope, its sub-lead does not narrow it`);
      }
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
      if (draft.payload.how === "human-decided" && draft.payload.winner === contest.claimant && state.items[contest.ownerItem]?.status === "split") {
        fail("NOT_ALLOWED", `${contest.ownerItem} is split: its scope stays its sub-lead's (claim one of its children instead)`);
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
    case "item.replanned": {
      const p = draft.payload;
      const item = requireItem(state, p.item);
      if (item.replanOf !== undefined) {
        fail("NOT_ALLOWED", `item ${item.id} is already a re-plan of ${item.replanOf}: a second failure escalates to a human, it is not re-planned again`);
      }
      const eligible = replanEligible(state, item.id);
      if (eligible === undefined) {
        fail(
          "INVALID_STATE",
          `item ${item.id} is ${item.status}: only an open item whose fix budget was spent, or that was released for not moving ${BOARD_LIMITS.stallReleasesBeforeReplan} times, ` +
            "or an open or held item that reached its per-item call cap, is re-planned",
        );
      }
      if (p.reason !== eligible) {
        fail("LOG_MISMATCH", `item ${item.id} is re-planned for ${eligible}, not ${p.reason}`);
      }
      if (p.action === "split" ? p.children.length < 2 : p.children.length !== 1) {
        fail("BAD_PAYLOAD", p.action === "split" ? "a re-plan split names at least two children" : `a re-plan ${p.action} names exactly one replacement`);
      }
      if ((p.action === "merge") !== (p.with !== undefined)) {
        fail("BAD_PAYLOAD", p.action === "merge" ? "a merge names the neighbour it merges with (with)" : "only a merge names a neighbour (with)");
      }
      if (p.with !== undefined) {
        const other = requireItem(state, p.with);
        if (other.id === item.id || other.status !== "open" || !isChangeItem(other) || other.fromContract !== undefined || other.replanOf !== undefined) {
          fail("INVALID_STATE", `item ${other.id} is not an open change item to merge with (it is ${other.status})`);
        }
      }
      if (p.rev !== undefined && p.rev > state.lastRevN) {
        fail("UNKNOWN_REF", `revision ${p.rev} has not been recorded`);
      }
      if (itemCount + p.children.length > BOARD_LIMITS.maxItems) {
        fail("LIMIT", `a board holds at most ${BOARD_LIMITS.maxItems} items`);
      }
      for (const child of p.children) {
        if (state.items[child.item]) {
          fail("DUPLICATE", `item ${child.item} already exists`);
        }
        if (child.scopeHint.length === 0) {
          fail("BAD_PAYLOAD", `child ${child.item} declares no scope hint, so it could never be claimed`);
        }
      }
      return;
    }
    case "candidate.gated": {
      const p = draft.payload;
      if ((state.rules.speculate ?? 1) < 2) {
        fail("INVALID_STATE", "this board does not gate speculatively (rules.speculate is 1): no candidate is recorded");
      }
      if (p.of > (state.rules.speculate ?? 1)) {
        fail("LIMIT", `a round gates at most ${state.rules.speculate} candidate(s) (rules.speculate)`);
      }
      const last = state.lastCandidate;
      if (last !== undefined && (p.round < last.round || (p.round === last.round && p.index <= last.index))) {
        fail("DUPLICATE", `candidate ${p.index} of round ${p.round} is not after the last recorded one (${last.index} of round ${last.round})`);
      }
      for (const push of p.prefix) {
        for (const item of push.items) {
          requireItem(state, item);
        }
      }
      for (const item of p.blamed ?? []) {
        requireItem(state, item);
      }
      if (p.outcome !== "retest" && (p.outcome === "blamed") !== (p.verdict === "fail")) {
        fail("LOG_MISMATCH", `a ${p.outcome} candidate ${p.outcome === "blamed" ? "failed" : "passed"} its gate`);
      }
      if ((p.outcome === "landed" || p.outcome === "blamed") !== (p.rev !== undefined)) {
        fail("BAD_PAYLOAD", "exactly a landed or a blamed candidate names the revision it backs (rev)");
      }
      if ((p.outcome === "blamed") !== (p.blamed !== undefined)) {
        fail("BAD_PAYLOAD", "exactly a blamed candidate names the items it blames");
      }
      if (p.outcome === "landed" && (state.integrated?.n !== p.rev || state.integrated?.commit !== p.commit)) {
        // Gate equals deploy: the landed candidate IS the latest passing revision.
        fail("LOG_MISMATCH", `the landed candidate ${p.commit.slice(0, 12)} is not the latest passing revision ${p.rev}'s commit`);
      }
      if (p.outcome === "blamed" && (p.rev! > state.lastRevN || state.passingRevs.includes(p.rev!))) {
        fail("LOG_MISMATCH", `revision ${p.rev} is not a recorded failing revision`);
      }
      return;
    }
    case "run.waiting": {
      if (!arbitrationV2(state)) {
        fail("NOT_ALLOWED", "a run's wait on a human is recorded only under arbitration revision 2 or later (whose clocks ignore engine records)");
      }
      for (const id of draft.payload.contracts) {
        const c = state.contracts[id];
        if (c === undefined || !c.guarded || c.status !== "proposed") {
          fail("INVALID_STATE", `contract ${id} is not a protected contract awaiting a human`);
        }
      }
      for (const id of draft.payload.contests) {
        if (state.contests[id]?.status !== "escalated") {
          fail("INVALID_STATE", `contest ${id} is not escalated to a human`);
        }
      }
      return;
    }
    case "integration.started":
    case "integration.phase": {
      // Progress only, never arbitration state: recorded only where the
      // board's clocks count participant messages (revision 2), so an
      // engine record never moves a lease, a deadline, or a wait.
      if (!arbitrationV2(state)) {
        fail("NOT_ALLOWED", "integration progress is recorded only under arbitration revision 2 or later (whose clocks ignore engine records)");
      }
      if (draft.type === "integration.phase") {
        if (draft.payload.started > state.lastSeq) {
          fail("UNKNOWN_REF", `integration round ${draft.payload.started} names no recorded message`);
        }
        return;
      }
      const p = draft.payload;
      for (const seq of p.pushes) {
        if (seq > state.lastSeq) {
          fail("UNKNOWN_REF", `push seq ${seq} names no recorded message`);
        }
      }
      for (const item of p.items) {
        requireItem(state, item);
      }
      for (const agent of p.agents) {
        if (state.agents[agent] === undefined) {
          fail("UNKNOWN_AGENT", `${agent} never joined this board`);
        }
      }
      return;
    }
    case "run.capped": {
      const p = draft.payload;
      if (p.item !== undefined) {
        requireItem(state, p.item);
      }
      if ((state.capped ?? []).some((c) => c.kind === p.kind && c.item === p.item)) {
        fail("DUPLICATE", `the ${p.kind} cap${p.item !== undefined ? ` of ${p.item}` : ""} is already recorded`);
      }
      return;
    }
    case "revision.promoted": {
      const refused = promotionRefusal(state, draft.payload.rev, draft.payload.gatedCommit);
      if (refused !== undefined) {
        fail(refused.code, refused.reason);
      }
      return;
    }
    case "token.refreshed": {
      const p = draft.payload;
      if (!activeAgent(state, p.agent)) {
        fail("UNKNOWN_AGENT", `${p.agent} is not a joined agent of this board`);
      }
      if (p.request !== undefined && state.help[p.request]?.grant?.agent !== p.agent) {
        fail("NOT_ALLOWED", `${p.agent} holds no granted help fork for ${p.request}`);
      }
      return;
    }
    case "push.excluded": {
      const p = draft.payload;
      const item = requireItem(state, p.item);
      const push = item.lastPush;
      if (push === undefined || push.commit !== p.commit || push.agent !== p.agent || item.owner !== p.agent || push.gatedIn !== undefined || push.integratedIn !== undefined) {
        fail("INVALID_STATE", `${p.commit.slice(0, 12)} is not ${p.agent}'s pending, ungated push for ${item.id}`);
      }
      if (push.excluded !== undefined) {
        fail("DUPLICATE", `${p.agent}'s push ${p.commit.slice(0, 12)} for ${item.id} is already recorded excluded`);
      }
      return;
    }
    case "push.regressed": {
      const p = draft.payload;
      if (!arbitrationV5(state)) {
        fail("NOT_ALLOWED", "a push regression is recorded only under arbitration revision 5 (the pre-pass progress ratchet)");
      }
      if (state.integrated !== null) {
        fail("INVALID_STATE", `a revision already passed (revision ${state.integrated.n}): the pre-pass ratchet is over`);
      }
      const item = requireItem(state, p.item);
      const push = item.lastPush;
      if (push === undefined || push.commit !== p.commit || push.agent !== p.agent || push.integratedIn !== undefined || push.gatedIn === undefined) {
        fail("INVALID_STATE", `${p.commit.slice(0, 12)} is not ${p.agent}'s latest, gated, unintegrated push for ${item.id}`);
      }
      if (p.rev < push.gatedIn || p.rev > state.lastRevN) {
        fail("UNKNOWN_REF", `revision ${p.rev} is not a recorded revision since ${item.id}'s push was first gated (revision ${push.gatedIn})`);
      }
      if (p.ratchet >= p.rev) {
        fail("BAD_PAYLOAD", `the ratchet (revision ${p.ratchet}) must precede the regressing revision ${p.rev}`);
      }
      if (compareProgressScore(p.to, p.from) >= 0) {
        fail("BAD_PAYLOAD", `a regression is a stack that scores worse with the push than without it (${describeProgressScore(p.to)} is not worse than ${describeProgressScore(p.from)})`);
      }
      if (push.regressed !== undefined) {
        fail("DUPLICATE", `${p.agent}'s push ${p.commit.slice(0, 12)} for ${item.id} is already recorded regressed`);
      }
      return;
    }
    case "trunk.moved": {
      const p = draft.payload;
      if (state.integrated?.n !== p.rev || state.integrated.commit !== p.commit) {
        fail("INVALID_STATE", `revision ${p.rev} (${p.commit.slice(0, 12)}) is not the board's latest passing revision`);
      }
      if ((state.trunkMoved ?? []).includes(p.rev)) {
        fail("DUPLICATE", `the trunk move after revision ${p.rev} is already recorded`);
      }
      return;
    }
    case "clash.predicted": {
      const p = draft.payload;
      for (const side of [p.a, p.b]) {
        const item = requireItem(state, side.item);
        if (item.lastPush?.commit !== side.sha || item.lastPush.agent !== side.agent || item.lastPush.gatedIn !== undefined) {
          fail("INVALID_STATE", `${side.sha} is not ${side.agent}'s pending push for ${side.item}`);
        }
      }
      if (p.a.agent === p.b.agent) {
        fail("BAD_PAYLOAD", "a clash is between two agents' pushes");
      }
      if ((state.clashes ?? []).some((c) => c.key === clashKey(p.a.sha, p.b.sha))) {
        fail("DUPLICATE", `the pair ${p.a.sha.slice(0, 10)} and ${p.b.sha.slice(0, 10)} was already predicted`);
      }
      if (p.status === "conflict") {
        const seams = new Set((state.seams ?? []).map((seam) => seam.path));
        const shared = (p.paths ?? []).some((path) => seams.has(path));
        if ((p.scope === "shared") !== shared) {
          fail("LOG_MISMATCH", `a conflict ${shared ? "on" : "off"} a shared seam is scoped ${shared ? "shared" : "local"}`);
        }
      }
      return;
    }
    case "item.escalated": {
      const item = requireItem(state, draft.payload.item);
      if (!replanFailed(item) || item.replanOf !== draft.payload.replanOf) {
        fail("INVALID_STATE", `item ${item.id} is not a re-planned item that failed again`);
      }
      return;
    }
    case "claim.lapsed": {
      // Arbitration derives no-progress and deadline lapses (replay re-derives
      // them); the operator records a stalled one on a quiet board.
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "claimed" || item.owner !== draft.payload.agent || item.lease === undefined) {
        fail("INVALID_STATE", `item ${item.id} has no leased claim of ${draft.payload.agent} to lapse`);
      }
      if (draft.payload.lastProgressSeq !== item.lease.progressSeq || (draft.payload.reason === "deadline" && draft.payload.deadlineSeq !== item.lease.deadlineSeq)) {
        fail("LOG_MISMATCH", `claim.lapsed on ${item.id} does not match its lease`);
      }
      if (draft.payload.reason === "stalled") {
        const suspended = leaseSuspension(state, item);
        if (suspended !== undefined) {
          fail("INVALID_STATE", `the claim on ${item.id} cannot lapse now: ${suspended}`);
        }
        if (seamWaits(state, item.id).length > 0) {
          fail("INVALID_STATE", `item ${item.id} waits on a seam change: its holder is not the one stalling it`);
        }
        if (waitingOnOthers(state, item)) {
          fail("INVALID_STATE", `item ${item.id} waits on the other items (its push was gated, no fix owed): its holder is not the one stalling it`);
        }
      }
      return;
    }
    case "claim.overlap": {
      const p = draft.payload;
      const item = requireItem(state, p.item);
      if (item.status !== "claimed" || item.owner !== p.agent || !scopeOverlaps(state, p.item, p.agent).some((o) => o.item === p.with && o.agent === p.withAgent)) {
        fail("LOG_MISMATCH", `claim.overlap does not match the claims on ${p.item} and ${p.with}`);
      }
      return;
    }
    case "claim.extended": {
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "claimed" || item.lease?.deadlineSeq === undefined) {
        fail("INVALID_STATE", `item ${item.id} has no held claim with a deadline to extend`);
      }
      if (item.lease.extensions >= BOARD_LIMITS.maxClaimExtensions) {
        fail("LIMIT", `the claim on ${item.id} was already extended ${item.lease.extensions} times: it lapses at its deadline`);
      }
      return;
    }
    case "item.split": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      if (item.tool) {
        fail("NOT_ALLOWED", `item ${item.id} builds a tool: a tool is built whole by its builder, never split`);
      }
      if (state.integrator === "cloud") {
        fail(
          "NOT_SUPPORTED",
          "this run integrates on Cloudflare, which cannot verify a sub-lead's merge of its children's pushes yet: splits are not supported; ask for help with a scope instead",
        );
      }
      if (item.lastPush !== undefined && item.lastPush.integratedIn === undefined) {
        // Its sub-lead would otherwise ship that push alongside the children's work.
        fail("INVALID_STATE", `item ${item.id} has an unintegrated push (${item.lastPush.commit}): split it before pushing, or after that push is integrated`);
      }
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
        // The owner becomes the children's sub-lead and announces their work
        // upward under its own write intent: every child must lie inside it.
        const write = item.intent?.write ?? [];
        const beyond = child.scopeHint.filter((entry) => !write.some((w) => entryWithin(entry, intentPath(w))));
        if (beyond.length > 0) {
          fail(
            "OUTSIDE_INTENT",
            `child ${child.item}'s scope hint ${beyond.join(", ")} is outside your write intent on ${item.id} (${write.join(", ")}): as the sub-lead you announce the children's work under it`,
          );
        }
      }
      return;
    }
    case "help.requested": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      if (state.help[draft.payload.request]) {
        fail("DUPLICATE", `help request ${draft.payload.request} already exists`);
      }
      const scope = draft.payload.scope;
      if (scope !== undefined) {
        // A grant is a sub-scope of what the requester itself may write, never more.
        const write = item.intent?.write ?? [];
        const outside = scope.filter((entry) => !write.some((w) => entryWithin(entry, intentPath(w))));
        if (outside.length > 0) {
          fail("OUTSIDE_INTENT", `the granted scope ${outside.join(", ")} is outside your write intent on ${item.id} (${write.join(", ")})`);
        }
        const clash = liveHelpGrants(state, item.id).find((h) => overlappingEntries(scope, h.scope ?? []).length > 0);
        if (clash) {
          fail("INTENT_OVERLAP", `the granted scope overlaps help request ${clash.request}'s live grant (${(clash.scope ?? []).join(", ")})`);
        }
      }
      return;
    }
    case "help.offered": {
      const request = state.help[draft.payload.request] ?? fail("UNKNOWN_REF", `unknown help request ${draft.payload.request}`);
      if (request.by === draft.from) {
        fail("NOT_ALLOWED", "an agent cannot offer help on its own request");
      }
      if (request.offers.includes(draft.from)) {
        fail("DUPLICATE", `${draft.from} already offered help on ${request.request}`);
      }
      if (draft.payload.forkOf !== undefined) {
        // A fork offer takes the request's grant: the helper starts from the
        // requester's in-progress repo and alone writes the granted scope.
        if (request.scope === undefined) {
          fail("NOT_ALLOWED", `help request ${request.request} grants no scope: there is nothing to fork for`);
        }
        if (draft.payload.forkOf !== request.by) {
          fail("UNKNOWN_REF", `forkOf must name the requester ${request.by}, whose repo the helper forks`);
        }
        if (request.to !== undefined && !request.to.includes(draft.from)) {
          fail("NOT_ALLOWED", `help request ${request.request} grants its scope to ${request.to.join(", ")} only`);
        }
        if (request.grant !== undefined) {
          fail("DUPLICATE", `help request ${request.request} is already granted to ${request.grant.agent}`);
        }
        if (!helpGrantLive(state, request)) {
          fail("INVALID_STATE", `help request ${request.request}'s grant has lapsed or closed`);
        }
        const head = state.agents[request.by]?.lastPush;
        if (draft.payload.baseMismatch !== undefined) {
          // Recorded, but it takes no grant: the fork did not start where the requester is.
          return;
        }
        if (draft.payload.forkCommit !== head) {
          fail(
            "INVALID_STATE",
            head === undefined
              ? `${request.by} has announced no push: a fork of its repo carries no forkCommit`
              : `forkCommit must be ${request.by}'s latest announced push (${head}), the state the fork starts from`,
          );
        }
      }
      return;
    }
    case "item.struggling": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      const previous = item.struggling?.owner === draft.from ? item.struggling : undefined;
      if ((previous?.reports ?? 0) >= BOARD_LIMITS.maxStruggleReports) {
        fail("LIMIT", `${draft.from} already reported ${item.id} struggling ${BOARD_LIMITS.maxStruggleReports} times`);
      }
      if (
        previous &&
        previous.turnsSpent === draft.payload.turnsSpent &&
        previous.failedEdits === draft.payload.failedEdits &&
        previous.reason === draft.payload.reason
      ) {
        fail("DUPLICATE", `nothing changed since the last struggling report on ${item.id}`);
      }
      return;
    }
    case "help.volunteered": {
      const item = requireItem(state, draft.payload.item);
      if (item.status !== "claimed" || item.owner === undefined) {
        fail("ITEM_NOT_OPEN", `item ${item.id} has no owner to help`);
      }
      if (item.owner === draft.from) {
        fail("NOT_ALLOWED", "an owner does not volunteer on its own item");
      }
      if (draft.to?.length !== 1 || draft.to[0] !== item.owner) {
        fail("BAD_PAYLOAD", `a volunteer's offer is addressed to the item's owner (to: [${item.owner}])`);
      }
      const known = state.volunteers?.[`${item.id}:${draft.from}`];
      if (known && known.owner === item.owner && known.answered === undefined) {
        fail("DUPLICATE", `${draft.from}'s offer on ${item.id} is still waiting for ${item.owner}'s answer`);
      }
      if (known && known.owner === item.owner && known.count >= BOARD_LIMITS.maxVolunteers) {
        fail("LIMIT", `${draft.from} already volunteered ${known.count} times on ${item.id}`);
      }
      return;
    }
    case "help.declined": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      const known = state.volunteers?.[`${item.id}:${draft.payload.volunteer}`];
      if (!known || known.owner !== draft.from || known.answered !== undefined) {
        fail("UNKNOWN_REF", `${draft.payload.volunteer} has no offer on ${item.id} waiting for your answer`);
      }
      return;
    }
    case "help.closed": {
      const request = state.help[draft.payload.request] ?? fail("UNKNOWN_REF", `unknown help request ${draft.payload.request}`);
      if (request.by !== draft.from) {
        fail("NOT_ALLOWED", `only ${request.by}, who asked, closes help request ${request.request}`);
      }
      if (request.scope === undefined || request.pulledSeq !== undefined || request.closed !== undefined) {
        fail("INVALID_STATE", `help request ${request.request} grants nothing open to close`);
      }
      return;
    }
    case "help.delivered": {
      const request = state.help[draft.payload.request] ?? fail("UNKNOWN_REF", `unknown help request ${draft.payload.request}`);
      if (request.grant?.agent !== draft.from) {
        fail("NOT_ALLOWED", `${draft.from} does not hold help request ${request.request}'s grant`);
      }
      if (request.pulledSeq !== undefined) {
        fail("INVALID_STATE", `help request ${request.request} was already pulled`);
      }
      // A late delivery never revives a lapsed or closed grant.
      if (!helpGrantLive(state, request)) {
        fail("INVALID_STATE", `help request ${request.request}'s grant has lapsed or closed: the scope is the requester's again`);
      }
      const outside = draft.payload.paths.filter((p) => !(request.scope ?? []).some((g) => entryWithin(p, intentPath(g))));
      if (outside.length > 0) {
        fail("OUTSIDE_INTENT", `delivered paths outside the granted scope (${(request.scope ?? []).join(", ")}): ${outside.join(", ")}`);
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
      // The acceptance gate itself is never changed, by anyone: no contract route.
      const immutableHit = (state.immutable ?? []).filter((p) => entriesOverlap(draft.payload.target, p));
      if (immutableHit.length > 0) {
        fail(
          "IMMUTABLE",
          `${draft.payload.target} is part of the immutable acceptance gate (${immutableHit.slice(0, 4).join(", ")}): it is never changed, not even with a human's approval; its failures are the goal, so change the code under test`,
        );
      }
      const seam = seamTarget(state, draft.payload.target);
      if (seam !== undefined && !state.protected.some((p) => entriesOverlap(draft.payload.target, p))) {
        // A SEAM contract: a change to a shared seam no item owns, asked by the
        // owner of an item that needs it; the lead decides.
        if (draft.payload.item === undefined || draft.payload.description === undefined) {
          fail("BAD_PAYLOAD", `a contract on the shared seam ${seam} names the item that needs it and describes the exact change (description)`);
        }
        const item = requireItem(state, draft.payload.item);
        if (!((item.status === "claimed" || item.status === "split") && item.owner === draft.from)) {
          fail("NOT_OWNER", `${draft.from} does not hold the claim on item ${item.id}: a seam contract comes from the owner of the item that needs it`);
        }
        const owner = seamOwner(state, seam);
        if (owner !== undefined) {
          fail(
            "NOT_ALLOWED",
            owner === item.id
              ? `the seam ${seam} is in item ${item.id}'s own scope: change it there`
              : `the seam ${seam} is in item ${owner}'s scope: ask its owner (a question or help request) instead of a contract`,
          );
        }
        const pending = Object.values(state.contracts).find((c) => c.seam === seam && c.status === "proposed");
        if (pending) {
          fail("DUPLICATE", `contract ${pending.contract} on the seam ${seam} is already waiting for the lead's decision`);
        }
        const waiting = Object.values(state.contracts).filter((c) => c.seam !== undefined && c.status === "proposed");
        if (waiting.filter((c) => c.proposedBy === draft.from).length >= BOARD_LIMITS.maxPendingSeamContractsPerAgent) {
          fail("LIMIT", `${draft.from} already has a seam contract waiting for the lead; wait for its decision before proposing another`);
        }
        if (waiting.length >= BOARD_LIMITS.maxPendingSeamContracts) {
          fail("LIMIT", `${waiting.length} seam contracts are already waiting for the lead's decision`);
        }
        // One seam change per failing cause: an accepted seam change this agent
        // asked for the same failing revision, still unfinished, comes first.
        const sameCause = Object.values(state.contracts).find(
          (c) =>
            c.seam !== undefined &&
            c.status === "accepted" &&
            c.proposedBy === draft.from &&
            c.failingRev !== undefined &&
            c.failingRev === state.lastFailure?.n &&
            state.items[seamItemId(c.contract)]?.status !== "done",
        );
        if (sameCause) {
          fail(
            "DUPLICATE",
            `${draft.from}'s seam change ${seamItemId(sameCause.contract)} (contract ${sameCause.contract}) for failing revision ${sameCause.failingRev} is not finished: one seam change per failing cause; it lands first`,
          );
        }
        if (seamItemId(draft.payload.contract).length > 128) {
          fail("BAD_PAYLOAD", "a seam contract's id must leave room for its seam item's id (at most 123 characters)");
        }
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
        // Inside the item's scope, or the failing check the latest failing
        // revision implicating the item names (a protected test that pins the
        // behavior the goal changes): still a human's decision.
        if (!item.scopeHint.some((hint) => entryWithin(target, hint)) && !failingCheckNames(state, item.id, target)) {
          fail(
            "OUTSIDE_SCOPE",
            `${target} is outside item ${item.id}'s scope hint (${item.scopeHint.join(", ")}) and is not the failing check of a revision implicating it`,
          );
        }
        // Revision 7: one writer per released protected file, whatever the
        // contract's kind (each releases the path for writing). Another live
        // item (not this one's ancestor or descendant) already holds it, or
        // already asked for it and waits for the decision.
        if (arbitrationV7(state)) {
          const holder = releaseHolder(state, item.id, target);
          if (holder) {
            fail("TARGET_RELEASED", targetReleasedMessage(target, holder));
          }
          const rival = pendingReleaseRival(state, item.id, target);
          if (rival) {
            fail(
              "TARGET_RELEASED",
              `${target} is already asked for by item ${rival.item} (contract ${rival.contract}, ${rival.target}, waiting for a decision): only one item changes it; ask its owner (a question naming ${rival.item}) instead of a second contract`,
            );
          }
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
      // Revision 7: accepting it must not make a second writer of a protected
      // file another live item holds now (it may have been released since the
      // proposal: two contracts raced while both were pending).
      if (draft.type === "contract.accepted" && arbitrationV7(state) && contract.guarded && contract.item !== undefined) {
        const holder = releaseHolder(state, contract.item, contract.target);
        if (holder) {
          fail("TARGET_RELEASED", targetReleasedMessage(contract.target, holder));
        }
        // Nor while an earlier holder (even one that holds nothing live now,
        // such as an escalated one) has a push touching it that is still to
        // be integrated: that push is applied with the target in its scope.
        const writer = pendingReleaseWriter(state, contract.item, contract.target);
        if (writer) {
          fail(
            "TARGET_RELEASED",
            `${contract.target} is released to item ${writer.holder} (contract ${writer.contract.contract}, ${writer.contract.target}), whose push ${writer.commit} changing it is not integrated yet: decide this contract once that push is integrated or left out`,
          );
        }
      }
      return;
    }
    case "seam.stalled": {
      const item = requireItem(state, draft.payload.item);
      // The same predicate as the hold: only an item that holds dependents now can stall.
      if (!seamHolds(state).some((h) => h.item === item.id)) {
        fail("INVALID_STATE", `item ${item.id} holds no dependent: nothing is stalled on it`);
      }
      if (draft.payload.released !== seamReleasable(item)) {
        fail("LOG_MISMATCH", `seam.stalled on ${item.id} must record released=${seamReleasable(item)}`);
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
      // The owner of a claimed item, or the SUB-LEAD of a split one.
      const item = requireItem(state, draft.payload.item);
      if (!((item.status === "claimed" || item.status === "split") && item.owner === draft.from)) {
        fail("NOT_OWNER", `${draft.from} does not hold the claim on item ${item.id} (it is ${item.status})`);
      }
      const merges = draft.payload.merges ?? [];
      if (item.status === "split") {
        // A sub-lead announces only its merge of the children's pushes.
        if (merges.length === 0) {
          fail("NOT_ALLOWED", `item ${item.id} is split: as its sub-lead announce the merge of its children's pushes (merges)`);
        }
        for (const merge of merges) {
          const child = state.items[merge.item];
          if (!child || child.parent !== item.id) {
            fail("UNKNOWN_REF", `${merge.item} is not a child of ${item.id}`);
          }
          if (child.lastPush?.commit !== merge.commit || child.lastPush.integratedIn !== undefined) {
            fail("INVALID_STATE", `${merge.commit} is not ${merge.item}'s latest unintegrated push`);
          }
          // Never re-merge what a revision could not verify: the child pushes again first.
          if (child.lastPush.unverifiedIn !== undefined) {
            fail(
              "INVALID_STATE",
              `${merge.item}'s push ${merge.commit} was recorded unverified in revision ${child.lastPush.unverifiedIn}: it is not merged again until ${merge.item} pushes again`,
            );
          }
          if ((child.lastPush.mergedTimes ?? 0) >= BOARD_LIMITS.maxChildMerges) {
            fail("LIMIT", `${merge.item}'s push ${merge.commit} was already merged ${child.lastPush.mergedTimes} times`);
          }
        }
        if (draft.payload.paths.length === 0) {
          fail("NOT_ALLOWED", "a sub-lead push merges children's changes: an empty push merges nothing");
        }
        // A sub-lead ships ONLY its children's work: every path inside the
        // write intents of the children it merges.
        const childWrite = mergedChildrenWrite(state, merges);
        const beyond = draft.payload.paths.filter((p) => !childWrite.some((w) => entryWithin(p, w)));
        if (beyond.length > 0) {
          fail("OUTSIDE_INTENT", `a sub-lead push carries only its merged children's work; ${beyond.join(", ")} is outside their write intents`);
        }
      } else if (merges.length > 0) {
        fail("NOT_ALLOWED", `item ${item.id} is not split: only a sub-lead merges children's pushes`);
      }
      const pulled = draft.payload.pulled ?? [];
      for (const requestId of pulled) {
        const request = state.help[requestId];
        if (!request || request.by !== draft.from || request.item !== item.id) {
          fail("UNKNOWN_REF", `${requestId} is not your help request on ${item.id}`);
        }
        if (request.delivered === undefined || request.pulledSeq !== undefined) {
          fail("INVALID_STATE", `help request ${requestId} has no delivered, unpulled work`);
        }
      }
      // Single writer inside an item: a TAKEN grant's scope is the helper's
      // until the requester pulls its delivered work (an untaken one blocks nothing).
      for (const grant of takenHelpGrants(state, item.id)) {
        if (pulled.includes(grant.request)) {
          continue;
        }
        const clash = draft.payload.paths.filter((p) => (grant.scope ?? []).some((g) => entryWithin(p, intentPath(g))));
        if (clash.length > 0) {
          fail(
            "INTENT_OVERLAP",
            `${clash.join(", ")} ${clash.length === 1 ? "is" : "are"} granted to ${grant.grant?.agent ?? "a helper"} under help request ${grant.request}: pull its delivered work, or wait for the grant to lapse`,
          );
        }
      }
      if (item.tool) {
        fail("NOT_ALLOWED", `item ${item.id} builds a tool: announce its build with tool.built (a tool is gated by its own gate, never integrated)`);
      }
      // A path a human released for this item by an accepted contract counts
      // as inside its write intent (it may lie outside the scope: the failing check).
      const write = [...(item.intent?.write ?? []), ...releasedTargets(state, item.id)];
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
        ...(draft.payload.unverified !== undefined ? { unverified: draft.payload.unverified } : {}),
        ...(draft.payload.progress !== undefined ? { progress: draft.payload.progress } : {}),
        ...(draft.payload.base !== undefined ? { base: draft.payload.base } : {}),
        ...(draft.payload.applied !== undefined ? { applied: draft.payload.applied } : {}),
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
      const clash = liveClaims(state, draft.payload.to, item.id, item.id).find(
        (holder) => overlappingEntries(item.intent?.write ?? [], holder.intent!.write).length > 0,
      );
      if (clash) {
        fail(
          "INTENT_OVERLAP",
          `handing ${item.id} to ${draft.payload.to} would overlap ${clash.owner}'s claim on ${clash.id}`,
        );
      }
      if (item.fromContract === undefined && item.tool === undefined && claimCapReached(state, draft.payload.to)) {
        fail("CLAIM_CAP", `${draft.payload.to} is at its active-claim cap: hand ${item.id} to an agent with room, or ask for help`);
      }
      return;
    }
    case "done.proposed": {
      const item = requireOwner(state, draft.payload.item, draft.from);
      // Work granted to a helper is part of the item: it is not done while
      // that grant is live (pull the delivered work, or let it lapse).
      const live = takenHelpGrants(state, item.id);
      if (live.length > 0) {
        fail(
          "INVALID_STATE",
          `help request ${live.map((h) => h.request).join(", ")} on ${item.id} is outstanding: pull the helper's delivered work before proposing done`,
        );
      }
      return;
    }
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
      if (draft.payload.closedBy === "engine") {
        const refused = engineCloseRefusal(state, item);
        if (refused !== undefined) {
          fail("INVALID_STATE", `item ${item.id} cannot be closed by the engine: ${refused}`);
        }
        if (item.lastPush!.integratedIn !== draft.payload.n || item.lastPush!.seq !== draft.payload.pushSeq) {
          fail(
            "INVALID_STATE",
            `item ${item.id}'s latest push is seq ${item.lastPush!.seq}, merged by passing rev ${item.lastPush!.integratedIn}: an engine close cites exactly those`,
          );
        }
      } else if (draft.payload.via === "integrated") {
        if (item.status !== "claimed" || !item.doneProposed) {
          fail("INVALID_STATE", `item ${item.id} has no done proposal from its owner`);
        }
        if (item.lastPush?.integratedIn !== draft.payload.n) {
          fail("INVALID_STATE", `the owner's latest push for ${item.id} was not merged by passing rev ${draft.payload.n}`);
        }
      } else if (!splitReady(state, item)) {
        fail("INVALID_STATE", `item ${item.id} still has unfinished children, or its sub-lead's push has not passed`);
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
        if (!contract.guarded && contract.seam === undefined) {
          fail("INVALID_STATE", `contract ${p.contract} is neither a protected contract a human decides nor a seam contract the lead decides`);
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
  if (arbitrationV2(state) && from !== BOARD_ENGINE) {
    state.ticks = (state.ticks ?? 0) + 1;
  }
  switch (message.type) {
    case "goal.posted":
      state.goal = { objective: message.payload.objective, seq: message.seq };
      state.rules = { ...message.payload.rules };
      state.protected = [...(message.payload.protected ?? [])];
      state.protectedKeys = [...(message.payload.protectedKeys ?? [])];
      state.testInventory = message.payload.testInventory ?? null;
      if (message.payload.integrator !== undefined) {
        state.integrator = message.payload.integrator;
      }
      if (message.payload.immutable !== undefined) {
        state.immutable = [...message.payload.immutable];
      }
      if (message.payload.baseline !== undefined) {
        state.baseline = message.payload.baseline;
      }
      if (message.payload.gateCommand !== undefined) {
        state.gateCommand = [...message.payload.gateCommand];
      }
      if (message.payload.seams !== undefined) {
        state.seams = message.payload.seams.map((seam) => ({
          path: seam.path,
          importers: [...seam.importers],
          ...(seam.symbols !== undefined ? { symbols: [...seam.symbols] } : {}),
        }));
      }
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
        ...(message.payload.fromContract !== undefined ? { fromContract: message.payload.fromContract } : {}),
        ...(arbitrationV2(state) ? { activityTick: state.ticks ?? 0 } : {}),
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
      delete item.seamStalledSeq;
      delete item.struggling;
      delete item.claimant;
      delete item.lastLapse;
      if (leasesOn(state)) {
        item.lease = newLease(state, message.seq);
      }
      if (arbitrationV2(state)) {
        item.activityTick = state.ticks ?? 0;
      }
      grantBudget(state, item, message.payload.agent);
      break;
    }
    case "claim.lapsed": {
      const item = state.items[message.payload.item]!;
      item.lastLapse = { seq: message.seq, agent: message.payload.agent, reason: message.payload.reason, lastProgressSeq: message.payload.lastProgressSeq, ...tickStamp(state) };
      item.stallReleases = (item.stallReleases ?? 0) + 1;
      if (message.payload.commit !== undefined) {
        // The next owner may start from the holder's latest push.
        item.reopenedFrom = { agent: message.payload.agent, commit: message.payload.commit };
      }
      releaseClaim(item);
      break;
    }
    case "claim.extended": {
      const lease = state.items[message.payload.item]!.lease!;
      lease.deadlineSeq = message.seq + (state.rules.claimDeadlineMessages ?? 0);
      if (arbitrationV2(state)) {
        lease.deadlineTick = (state.ticks ?? 0) + (state.rules.claimDeadlineMessages ?? 0);
      }
      lease.extensions += 1;
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
        ...(arbitrationV2(state) ? { lastActionTick: state.ticks ?? 0 } : {}),
      };
      break;
    }
    case "claim.kept": {
      const contest = state.contests[message.payload.contest]!;
      contest.turns += 1;
      contest.lastActionSeq = message.seq;
      if (arbitrationV2(state)) {
        contest.lastActionTick = state.ticks ?? 0;
      }
      renewLease(state, contest.ownerItem, message.seq, from);
      break;
    }
    case "claim.narrowed": {
      const contest = state.contests[message.payload.contest]!;
      contest.turns += 1;
      contest.lastActionSeq = message.seq;
      if (arbitrationV2(state)) {
        contest.lastActionTick = state.ticks ?? 0;
      }
      renewLease(state, contest.ownerItem, message.seq, from);
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
      if (arbitrationV2(state)) {
        contest.lastActionTick = state.ticks ?? 0;
      }
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
      // The owner stays as the SUB-LEAD and keeps its write intent: it is what
      // its one upward push for the children is checked against. A split item
      // is no live claim (its children's claims are), so it blocks no claim.
      parent.subLead = from;
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
    case "item.replanned": {
      const p = message.payload;
      const item = state.items[p.item]!;
      const into = p.action === "merge" ? p.children[0]!.item : undefined;
      item.status = "split";
      item.replanned = { seq: message.seq, by: from, action: p.action, reason: p.reason, ...(into !== undefined ? { into } : {}) };
      for (const child of p.children) {
        item.children.push(child.item);
        state.items[child.item] = {
          id: child.item,
          objective: child.objective,
          acceptance: child.acceptance,
          scopeHint: child.scopeHint,
          status: "open",
          proposedBy: from,
          proposedSeq: message.seq,
          parent: item.id,
          children: [],
          doneProposed: false,
          replanOf: item.id,
          ...(p.with !== undefined ? { replaces: [item.id, p.with] } : {}),
        };
      }
      if (p.with !== undefined) {
        // The neighbour is carried by the same replacement and completes with it.
        const other = state.items[p.with]!;
        other.status = "split";
        other.children.push(into!);
        other.replanned = { seq: message.seq, by: from, action: "merge", reason: p.reason, into: into! };
      }
      break;
    }
    case "item.escalated":
      state.items[message.payload.item]!.escalatedSeq = message.seq;
      break;
    case "trunk.moved":
      (state.trunkMoved ??= []).push(message.payload.rev);
      break;
    case "push.excluded": {
      const push = state.items[message.payload.item]!.lastPush!;
      push.excluded = { seq: message.seq, reason: message.payload.reason };
      // The holder must act now: its lease runs again from here.
      renewLease(state, message.payload.item, message.seq);
      break;
    }
    case "push.regressed": {
      const push = state.items[message.payload.item]!.lastPush!;
      const p = message.payload;
      push.regressed = {
        seq: message.seq,
        rev: p.rev,
        ratchet: p.ratchet,
        from: { ...p.from },
        to: { ...p.to },
        evidence: [...p.evidence],
        ...(p.seams !== undefined ? { seams: [...p.seams] } : {}),
      };
      // The holder must act now (a fix): its lease runs again from here.
      renewLease(state, message.payload.item, message.seq);
      break;
    }
    case "token.refreshed":
      state.tokenRefreshes = (state.tokenRefreshes ?? 0) + 1;
      break;
    case "revision.promoted":
      state.promoted = { ...message.payload, seq: message.seq };
      break;
    case "run.capped":
      (state.capped ??= []).push({ ...message.payload, seq: message.seq });
      break;
    case "candidate.gated":
      state.lastCandidate = { round: message.payload.round, index: message.payload.index, seq: message.seq };
      break;
    case "integration.started":
    case "integration.phase":
    case "run.waiting":
      // Progress only: nothing but the seq moves (no arbitration state, no verdict).
      break;
    case "clash.predicted": {
      const p = message.payload;
      (state.clashes ??= []).push({
        key: clashKey(p.a.sha, p.b.sha),
        seq: message.seq,
        a: { ...p.a },
        b: { ...p.b },
        status: p.status,
        ...(p.paths !== undefined ? { paths: [...p.paths] } : {}),
        ...(p.scope !== undefined ? { scope: p.scope } : {}),
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      });
      break;
    }
    case "help.requested":
      state.help[message.payload.request] = {
        request: message.payload.request,
        item: message.payload.item,
        need: message.payload.need,
        by: from,
        offers: [],
        seq: message.seq,
        ...tickStamp(state),
        ...(message.payload.scope !== undefined ? { scope: [...message.payload.scope] } : {}),
        ...(message.payload.scope !== undefined && message.to !== undefined && message.to.length > 0 ? { to: [...message.to] } : {}),
        // Revision 6: a plain question remembers whom it asks (their digest lists it until they reply).
        ...(message.payload.scope === undefined && message.to !== undefined && message.to.length > 0 && arbitrationV6(state) ? { askedOf: [...message.to] } : {}),
      };
      renewLease(state, message.payload.item, message.seq, from);
      // A grant addressed to a volunteer answers its offer.
      if (message.payload.scope !== undefined) {
        for (const agent of message.to ?? []) {
          const v = state.volunteers?.[`${message.payload.item}:${agent}`];
          if (v && v.owner === from && v.answered === undefined) {
            v.answered = { how: "accepted", seq: message.seq, request: message.payload.request };
          }
        }
      }
      break;
    case "item.struggling": {
      const item = state.items[message.payload.item]!;
      const previous = item.struggling?.owner === from ? item.struggling.reports : 0;
      item.struggling = {
        owner: from,
        seq: message.seq,
        turnsSpent: message.payload.turnsSpent,
        failedEdits: message.payload.failedEdits,
        reason: message.payload.reason,
        ...(message.payload.lastFailure !== undefined ? { lastFailure: message.payload.lastFailure } : {}),
        reports: previous + 1,
      };
      renewLease(state, item.id, message.seq, from);
      break;
    }
    case "help.volunteered": {
      const item = state.items[message.payload.item]!;
      const volunteers = (state.volunteers ??= {});
      const key = `${item.id}:${from}`;
      const known = volunteers[key];
      volunteers[key] = { item: item.id, agent: from, owner: item.owner!, seq: message.seq, count: known && known.owner === item.owner ? known.count + 1 : 1 };
      break;
    }
    case "help.declined":
      state.volunteers![`${message.payload.item}:${message.payload.volunteer}`]!.answered = { how: "declined", seq: message.seq };
      renewLease(state, message.payload.item, message.seq, from);
      break;
    case "help.offered": {
      const request = state.help[message.payload.request]!;
      request.offers.push(from);
      const p = message.payload;
      if (p.forkOf !== undefined && p.baseMismatch !== undefined) {
        (request.forkMismatches ??= []).push({ agent: from, seq: message.seq, expected: p.baseMismatch.expected, realized: p.baseMismatch.realized });
      } else if (p.forkOf !== undefined) {
        request.grant = {
          agent: from,
          seq: message.seq,
          ...tickStamp(state),
          forkOf: p.forkOf,
          ...(p.forkCommit !== undefined ? { forkCommit: p.forkCommit } : {}),
          ...(p.fork !== undefined ? { fork: p.fork } : {}),
        };
      }
      break;
    }
    case "help.delivered":
      state.help[message.payload.request]!.delivered = { commit: message.payload.commit, paths: [...message.payload.paths], seq: message.seq, ...tickStamp(state) };
      // A granted helper's delivery is progress on the item.
      renewLease(state, state.help[message.payload.request]!.item, message.seq);
      break;
    case "help.closed":
      state.help[message.payload.request]!.closed = {
        seq: message.seq,
        reason: message.payload.reason,
        ...(message.payload.detail !== undefined ? { detail: message.payload.detail } : {}),
      };
      renewLease(state, state.help[message.payload.request]!.item, message.seq, from);
      break;
    case "contract.proposed":
      state.contracts[message.payload.contract] = {
        contract: message.payload.contract,
        target: message.payload.target,
        kind: message.payload.kind,
        ...(message.payload.item !== undefined ? { item: message.payload.item } : {}),
        ...(state.protected.some((p) => entriesOverlap(message.payload.target, p))
          ? { guarded: true }
          : ((): { seam?: string } => {
              const seam = seamTarget(state, message.payload.target);
              return seam !== undefined ? { seam } : {};
            })()),
        ...(message.payload.description !== undefined ? { description: message.payload.description } : {}),
        ...(seamTarget(state, message.payload.target) !== undefined && !state.protected.some((p) => entriesOverlap(message.payload.target, p)) && state.lastFailure !== null
          ? {
              failingRev: state.lastFailure.n,
              ...((): { failingErrors?: string[] } => {
                // Revision 6: the failing errors it was proposed for (a rejection then stands for those errors).
                const lines = arbitrationV6(state) ? typeMismatchLines(state.lastFailure!.output) : [];
                return lines.length > 0 ? { failingErrors: lines } : {};
              })(),
            }
          : {}),
        proposedBy: from,
        proposedSeq: message.seq,
        status: "proposed",
      };
      renewLease(state, message.payload.item, message.seq, from);
      break;
    case "contract.escalated":
      // The decision is a human's: the escalation record carries it.
      break;
    case "contract.accepted":
    case "contract.rejected": {
      const contract = state.contracts[message.payload.contract]!;
      contract.status = message.type === "contract.accepted" ? "accepted" : "rejected";
      contract.decidedBy = from;
      contract.decidedSeq = message.seq;
      if (message.type === "contract.rejected" && contract.guarded && contract.item !== undefined && state.items[contract.item]) {
        state.items[contract.item]!.contractRejectedSeq = message.seq;
      }
      // The wait for the decision is over: the holder's lease runs from here.
      renewLease(state, contract.item, message.seq);
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
        ...(message.payload.merges !== undefined ? { merges: message.payload.merges.map((m) => ({ ...m })) } : {}),
        ...tickStamp(state),
      };
      if (arbitrationV2(state)) {
        item.activityTick = state.ticks ?? 0;
      }
      // The owner answered any outstanding fix request with this push.
      delete item.fixRequested;
      renewLease(state, item.id, message.seq, from);
      if (state.agents[from]) {
        state.agents[from]!.lastPush = message.payload.commit;
      }
      for (const merge of message.payload.merges ?? []) {
        const childPush = state.items[merge.item]?.lastPush;
        if (childPush && childPush.commit === merge.commit) {
          childPush.mergedTimes = (childPush.mergedTimes ?? 0) + 1;
        }
      }
      for (const request of message.payload.pulled ?? []) {
        state.help[request]!.pulledSeq = message.seq;
      }
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
          // A sub-lead's push carries its children's merged pushes.
          for (const merge of subLeadMerges(state, item)) {
            if (!(message.payload.unverified ?? []).some((u) => u.item === merge.item)) {
              mergedByItem[merge.item] = merge.commit;
            }
          }
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
      for (const [id, commit] of Object.entries(mergedByItem)) {
        const push = state.items[id]?.lastPush;
        if (push && push.commit === commit && push.gatedIn === undefined) {
          push.gatedIn = message.payload.n;
          // Revision 2: the time the push waited for the gate is not charged to the deadline.
          if (push.agent === state.items[id]!.owner) {
            creditDeadline(state, state.items[id]!, { seqs: message.seq - push.seq, ticks: (state.ticks ?? 0) - (push.tick ?? state.ticks ?? 0) });
          }
          // Its push was gated: progress on the item.
          renewLease(state, id, message.seq);
        }
      }
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
            // Children first: their pushes are integrated through the sub-lead's,
            // except those the integrator could not verify in the gated tree.
            const unverified = (message.payload.unverified ?? []).map((u) => u.item);
            for (const merge of subLeadMerges(state, item)) {
              if (!unverified.includes(merge.item)) {
                state.items[merge.item]!.lastPush!.integratedIn = message.payload.n;
              }
            }
            if (unverified.length > 0) {
              item.lastPush.unverified = unverified;
              for (const child of unverified) {
                state.items[child]!.lastPush!.unverifiedIn = message.payload.n;
              }
            }
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
      renewLease(state, message.payload.item, message.seq, from);
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
      grantBudget(state, item, message.payload.to);
      // The new owner proposes done for itself (and has not struggled yet).
      item.doneProposed = false;
      delete item.struggling;
      if (item.lease !== undefined) {
        // A new holder: a fresh lease and deadline.
        item.lease = newLease(state, message.seq);
      }
      break;
    }
    case "done.proposed":
      state.items[message.payload.item]!.doneProposed = true;
      renewLease(state, message.payload.item, message.seq, from);
      break;
    case "item.completed": {
      const item = state.items[message.payload.item]!;
      item.status = "done";
      item.completed =
        message.payload.via === "tool"
          ? { via: "tool", version: message.payload.version! }
          : message.payload.closedBy === "engine"
            ? { n: message.payload.n!, via: message.payload.via, closedBy: "engine", pushSeq: message.payload.pushSeq!, seq: message.seq }
            : { n: message.payload.n!, via: message.payload.via };
      delete item.intent;
      delete item.fixRequested;
      delete item.struggling;
      delete item.lease;
      break;
    }
    case "fix.requested": {
      const item = state.items[message.payload.item]!;
      item.fixAttempts = message.payload.attempt;
      item.fixRequested = message.payload.n;
      item.failedRev = message.payload.n;
      // Revision 2: the holder gets at least one lease window to answer before its deadline.
      creditDeadline(state, item, undefined, true);
      break;
    }
    case "fix.exhausted": {
      const item = state.items[message.payload.item]!;
      item.fixExhausted = true;
      item.failedRev = message.payload.n;
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
      renewLease(state, item.id, message.seq, from);
      const proposal = Object.values(state.tools.proposed).find((t) => t.capability === message.payload.capability);
      if (proposal) {
        proposal.builds += 1;
      }
      break;
    }
    case "tool.gated": {
      const item = state.items[toolItemId(message.payload.capability)]!;
      item.toolBuild = { ...item.toolBuild!, gated: true, passed: message.payload.passed };
      renewLease(state, item.id, message.seq);
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
    case "seam.stalled": {
      const item = state.items[message.payload.item]!;
      if (message.payload.released) {
        releaseClaim(item);
        item.stallReleases = (item.stallReleases ?? 0) + 1;
      }
      item.seamStalledSeq = message.seq;
      break;
    }
    case "decision.recorded":
      // A contract's advisory triage, shown to whoever decides it.
      if (message.payload.juncture === "contract-triage" && message.payload.contract !== undefined && state.contracts[message.payload.contract]) {
        state.contracts[message.payload.contract]!.triage = contractTriageRecommendation(message.payload);
      }
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
  delete item.struggling;
  delete item.lease;
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
  for (const holder of liveClaims(state, agent, undefined, item)) {
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

  // Overlap advice (rule-gated): a grant whose item's declared scope overlaps
  // another holder's item scope is recorded for both, never refused.
  const noteOverlaps = (draft: BoardDraft): void => {
    if (rules.claimOverlap !== true || draft.type !== "claim.granted") {
      return;
    }
    for (const other of scopeOverlaps(work, draft.payload.item, draft.payload.agent)) {
      if (!activeAgent(work, other.agent)) {
        continue;
      }
      emit({
        from: BOARD_ENGINE,
        type: "claim.overlap",
        payload: { item: draft.payload.item, agent: draft.payload.agent, with: other.item, withAgent: other.agent, files: [...other.files] },
        to: [draft.payload.agent, other.agent],
      });
    }
  };
  const grantOrContest = (draft: BoardDraft): void => {
    emit(draft);
    noteOverlaps(draft);
  };

  const redecide = (contest: BoardContest): void => {
    const item = work.items[contest.item];
    if (!item || item.claimant === undefined || item.claimant.contest !== contest.id) {
      return;
    }
    grantOrContest(decideClaim(work, item.id, item.claimant.agent, item.claimant.intent, nextContestId()));
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

  // A split item completes when its children are done and its sub-lead's
  // push (if it announced one) passed; it cites that push's revision.
  const completeSplitUpward = (parentId: string | undefined, n: number): void => {
    while (parentId !== undefined) {
      const parent: BoardItem | undefined = work.items[parentId];
      if (!parent || !splitReady(work, parent)) {
        break;
      }
      const cited = parent.lastPush?.integratedIn ?? n;
      emit({ from: BOARD_ENGINE, type: "item.completed", payload: { item: parent.id, n: cited, via: "children" } });
      // Its scope stops being a live claim: contests waiting on it resolve.
      resolveWaitersOn(parent.id);
      parentId = parent.parent;
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
    completeSplitUpward(item.parent, n);
    // A merge's replacement carries its neighbour too.
    for (const replaced of item.replaces ?? []) {
      if (replaced !== item.parent) {
        completeSplitUpward(replaced, n);
      }
    }
  };

  // A re-planned item that failed again goes to a human (never a second re-plan).
  const escalateIfReplanFailed = (itemId: string): void => {
    const item = work.items[itemId];
    if (item !== undefined && replanFailed(item)) {
      emit({ from: BOARD_ENGINE, type: "item.escalated", payload: { item: item.id, reason: "replan-failed", replanOf: item.replanOf! } });
    }
  };

  switch (incoming.type) {
    case "item.claimed":
      grantOrContest(decideClaim(work, incoming.payload.item, incoming.from, incoming.payload.intent, nextContestId()));
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
    case "claim.lapsed":
      // A recorded (stalled) lapse released the claim: contests waiting on it resolve.
      resolveWaitersOn(incoming.payload.item);
      escalateIfReplanFailed(incoming.payload.item);
      break;
    case "seam.stalled":
      escalateIfReplanFailed(incoming.payload.item);
      break;
    case "item.split":
      // Nothing to release: the split item stays a live claim of its sub-lead
      // (a split is refused while a contest is open on it).
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
    case "contract.accepted": {
      // An accepted SEAM contract becomes a seam item: open at once, it goes
      // first (seam-first), and the items importing the seam rebase onto it.
      const contract = work.contracts[incoming.payload.contract];
      if (contract?.seam !== undefined && !work.items[seamItemId(contract.contract)]) {
        emit({
          from: BOARD_ENGINE,
          type: "item.proposed",
          payload: {
            item: seamItemId(contract.contract),
            objective: `Change the shared seam ${contract.seam} (${contract.kind}): ${contract.description ?? ""}`.slice(0, BOARD_LIMITS.maxObjective).trim(),
            acceptance: [
              `${contract.seam} provides the change described; every file importing it still compiles`,
              ...(contract.item !== undefined ? [`item ${contract.item} can use it without undeclared fields or casts`] : []),
            ],
            scopeHint: [contract.seam],
            fromContract: contract.contract,
          },
        });
        // The PROPOSER holds the context: it is granted the seam item at once
        // (when it is still on the board and no other live claim overlaps).
        const proposer = contract.proposedBy;
        const intent = { read: [], write: [contract.seam] };
        const clash = liveClaims(work, proposer, undefined, seamItemId(contract.contract)).some(
          (holder) => overlappingEntries(intent.write, holder.intent!.write).length > 0,
        );
        if (activeAgent(work, proposer) && work.agents[proposer]?.role !== LEAD_ROLE && !clash) {
          emit({ from: BOARD_ENGINE, type: "claim.granted", payload: { item: seamItemId(contract.contract), agent: proposer, intent } });
        }
      }
      break;
    }
    case "done.proposed":
      completeIfReady(incoming.payload.item);
      break;
    case "item.completed": {
      // Only a RECORDED completion arrives here (an engine close): its scope
      // stops being a live claim, and a split parent it finishes completes.
      const item = work.items[incoming.payload.item];
      if (incoming.payload.closedBy === "engine" && item !== undefined) {
        const n = incoming.payload.n!;
        resolveWaitersOn(item.id);
        completeSplitUpward(item.parent, n);
        for (const replaced of item.replaces ?? []) {
          if (replaced !== item.parent) {
            completeSplitUpward(replaced, n);
          }
        }
      }
      break;
    }
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
        // A sub-lead's push that passed completes its split item once every
        // child is done (children that completed earlier waited for it).
        for (const item of Object.values(work.items)) {
          if (item.status === "split" && item.lastPush?.integratedIn === incoming.payload.n) {
            completeSplitUpward(item.id, incoming.payload.n);
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
          // Revision 7: a fix request its owner has not answered yet (no push
          // since) is charged once. Implicating the same push again is
          // evidence only: no second request, and never an exhausted budget
          // for an owner that did not get a turn.
          if (arbitrationV7(work) && item.fixRequested !== undefined) {
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
            escalateIfReplanFailed(item.id);
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
    const idle = arbitrationV2(work) ? boardClock(work) - (contest.lastActionTick ?? 0) : incoming.seq - contest.lastActionSeq;
    if (contest.status === "open" && idle >= rules.contestIdleMessages) {
      escalate(contest, "idle");
    }
  }
  // Claim leases: a held claim with no progress for the lease (or at its firm
  // deadline) lapses and the item is open again. Count-based, so deterministic.
  if (leasesOn(work)) {
    for (const item of Object.values(work.items)) {
      const lapse = leaseLapse(work, item.id, incoming.seq);
      if (lapse === undefined) {
        continue;
      }
      const owner = item.owner!;
      const commit = item.lastPush?.agent === owner ? item.lastPush.commit : undefined;
      emit({
        from: BOARD_ENGINE,
        type: "claim.lapsed",
        payload: {
          item: item.id,
          agent: owner,
          reason: lapse.reason,
          lastProgressSeq: lapse.lastProgressSeq,
          ...(lapse.deadlineSeq !== undefined ? { deadlineSeq: lapse.deadlineSeq } : {}),
          ...(commit !== undefined ? { commit } : {}),
        },
        to: [owner],
      });
      resolveWaitersOn(item.id);
      escalateIfReplanFailed(item.id);
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

/**
 * rebase.needed for every active agent whose live intent meets the change, or
 * imports a shared seam the change touched (dependents of a seam change rebase
 * onto it).
 */
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
    const paths = rev.paths.filter(
      (p) =>
        entries.some((e) => entriesOverlap(p, e)) ||
        (state.seams ?? []).some((seam) => seam.path === p && seam.importers.some((imp) => entries.some((e) => entriesOverlap(imp, e)))),
    );
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
  /** Sub-lead merges the integrator could not verify in the gated tree (see integrated.rev). */
  readonly unverified?: readonly { readonly item: string; readonly reason: string }[];
  /** Advisory progress parsed from the gate's output. */
  readonly progress?: BoardRevProgress;
  /** The commit the revision was built on (must be the board's integrated head). */
  readonly base?: string;
  /** What each merged agent's unit applied (and yielded): a record (see integrated.rev). */
  readonly applied?: readonly BoardAppliedUnit[];
}

/** The commit the next integrated revision must be built on: the latest passing revision's, else the goal's baseline. */
export function integratedHead(state: BoardState): string | undefined {
  return state.integrated?.commit ?? state.baseline;
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
    if (routedToSubLead(state, item)) {
      // A split item's child integrates only through its sub-lead's push.
      fail("UNKNOWN_REF", `commit ${commit} is ${item.id}'s push, which integrates through its sub-lead ${state.items[item.parent!]!.subLead}'s push`);
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
    // A sub-lead's push integrates its children's merged pushes: those items
    // are merged too (a failing revision may implicate them), and their
    // authors are contributors.
    for (const merge of subLeadMerges(state, item)) {
      if ((input.unverified ?? []).some((u) => u.item === merge.item)) {
        continue; // not in the gated tree as pushed: not integrated by this revision
      }
      if (!mergedItems.includes(merge.item)) {
        mergedItems.push(merge.item);
      }
      const author = state.items[merge.item]!.lastPush!.agent;
      if (!contributors.includes(author)) {
        contributors.push(author);
      }
    }
  }
  if (input.gated === false && input.gate !== "pass") {
    fail("BAD_PAYLOAD", "only a revision that no gate failed can be ungated");
  }
  // A revision built on anything but the current integrated head is stale: it
  // never becomes current (the integrator rebuilds on the head).
  const head = integratedHead(state);
  if (input.base !== undefined && head !== undefined && input.base !== head) {
    fail(
      "STALE_BASE",
      `the revision was built on ${input.base.slice(0, 12)}, but the board's integrated head is ${head.slice(0, 12)}${state.integrated ? ` (revision ${state.integrated.n})` : " (the baseline)"}: a stale integration is not recorded`,
    );
  }
  for (const u of input.unverified ?? []) {
    const named = input.merged.some((commit) => {
      const item = itemForPendingPush(state, commit);
      return item !== undefined && subLeadMerges(state, item).some((m) => m.item === u.item);
    });
    if (!named) {
      fail("UNKNOWN_REF", `unverified names ${u.item}, which no merged sub-lead push merges`);
    }
  }
  // The applied record names only agents whose pushes this revision merged.
  const strangerUnits = (input.applied ?? []).filter((u) => !contributors.includes(u.agent)).map((u) => u.agent);
  if (strangerUnits.length > 0) {
    fail("UNKNOWN_REF", `applied names agent(s) ${strangerUnits.join(", ")} with no push in this revision`);
  }
  if (input.failing !== undefined) {
    if (input.gate !== "fail") {
      fail("BAD_PAYLOAD", "only a failing revision carries failing evidence");
    }
    const strangers = input.failing.items.filter((item) => !mergedItems.includes(item));
    if (strangers.length > 0) {
      fail("UNKNOWN_REF", `implicated item(s) ${strangers.join(", ")} had no push in this revision`);
    }
    const misnamed = (input.failing.outstanding ?? []).filter((item) => state.items[item] === undefined || mergedItems.includes(item));
    if (misnamed.length > 0) {
      fail("UNKNOWN_REF", `outstanding item(s) ${misnamed.join(", ")} are unknown or in this revision`);
    }
  }
  return {
    n: state.lastRevN + 1,
    commit: input.commit,
    gate: input.gate,
    merged: [...input.merged],
    paths,
    contributors,
    ...(input.failing !== undefined
      ? {
          failing: {
            output: input.failing.output,
            items: [...input.failing.items],
            ...(input.failing.outstanding !== undefined ? { outstanding: [...input.failing.outstanding] } : {}),
          },
        }
      : {}),
    ...(input.gated === false ? { gated: false as const } : {}),
    ...(input.unverified !== undefined ? { unverified: input.unverified.map((u) => ({ ...u })) } : {}),
    ...(input.progress !== undefined ? { progress: JSON.parse(JSON.stringify(input.progress)) as BoardRevProgress } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(input.applied !== undefined ? { applied: input.applied.map((u) => ({ agent: u.agent, paths: [...u.paths], ...(u.yielded ? { yielded: [...u.yielded] } : {}) })) } : {}),
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
const RECORDED_ENGINE_TYPES: ReadonlySet<BoardMessageType> = new Set([
  "integrated.rev",
  "decision.recorded",
  "tool.gated",
  "tool.used",
  "seam.stalled",
  // Only a `stalled` lapse is recorded; no-progress and deadline lapses are derived.
  "claim.lapsed",
  "clash.predicted",
  "trunk.moved",
  "token.refreshed",
  "revision.promoted",
  "run.capped",
  "candidate.gated",
  "integration.started",
  "integration.phase",
  "run.waiting",
  "push.excluded",
  "push.regressed",
  // Only an engine close (closedBy: engine) is recorded; every other completion is derived.
  "item.completed",
]);

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
    if (
      incoming.from === BOARD_ENGINE &&
      (!RECORDED_ENGINE_TYPES.has(incoming.type) ||
        (incoming.type === "claim.lapsed" && incoming.payload.reason !== "stalled") ||
        (incoming.type === "item.completed" && incoming.payload.closedBy !== "engine"))
    ) {
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
    if (!["commit", "gate", "merged", "failing", "gated", "unverified", "progress", "base", "applied"].includes(key)) {
      fail("BAD_PAYLOAD", `an integration result has an unknown field ${JSON.stringify(key)}`);
    }
  }
  const failing = input.failing === undefined ? undefined : failingEvidence(input.failing);
  const parsed: IntegratedRevInput = {
    commit: id(input, "commit"),
    gate: oneOf(input, "gate", ["pass", "fail"] as const),
    merged: idList(input, "merged", { max: BOARD_LIMITS.maxRevisionPushes }),
    ...(failing !== undefined ? { failing } : {}),
    ...(ungatedFlag(input) ? { gated: false as const } : {}),
    ...(input.unverified !== undefined ? { unverified: unverifiedMerges(input.unverified) } : {}),
    ...(input.progress !== undefined ? { progress: revProgress(input.progress) } : {}),
    ...(input.base !== undefined ? { base: id(input, "base") } : {}),
    ...(input.applied !== undefined ? { applied: appliedUnits(input.applied) } : {}),
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
 * Record a seam item STALLED (operator-recorded engine message): it held
 * dependents and the board went quiet. It holds no one from now on; with no
 * push of its owner's it is released for an idle agent (the engine derives
 * `released`). Refused unless it is a claimed seam item holding someone.
 */
export function appendSeamStalled(state: BoardState, input: unknown, at: string): BoardAppendResult {
  if (state.goal === null) {
    fail("NO_GOAL", "the board has no goal yet");
  }
  if (!isRecord(input) || Object.keys(input).some((k) => k !== "item")) {
    fail("BAD_PAYLOAD", "a seam.stalled record is {item}");
  }
  const item = requireItem(state, id(input, "item"));
  if (!seamHolds(state).some((h) => h.item === item.id)) {
    fail("INVALID_STATE", `item ${item.id} holds no dependent: nothing is stalled on it`);
  }
  return appendChecked(state, { from: BOARD_ENGINE, type: "seam.stalled", payload: { item: item.id, released: seamReleasable(item) } }, at);
}

/**
 * Why the board would refuse `revision.promoted {rev, gatedCommit}` on
 * `state`, or undefined when it would accept it. Pure: a run checks it BEFORE
 * promoting (and redeploying), so a tree the board will not back as its
 * latest passing revision is never shipped (gate-equals-deploy); the rule
 * applies the same check when the record is appended.
 */
export function promotionRefusal(
  state: BoardState,
  rev: number,
  gatedCommit: string,
): { readonly code: "DUPLICATE" | "INVALID_STATE" | "LOG_MISMATCH"; readonly reason: string } | undefined {
  if (state.promoted !== undefined) {
    return { code: "DUPLICATE", reason: `revision ${state.promoted.rev} was already recorded promoted` };
  }
  if (state.integrated?.n !== rev || state.lastRevN !== rev) {
    return { code: "INVALID_STATE", reason: `revision ${rev} is not the board's latest revision, passing: only that one is promoted` };
  }
  if (state.integrated.commit !== gatedCommit) {
    return {
      code: "LOG_MISMATCH",
      reason: `the promoted gated commit ${gatedCommit.slice(0, 12)} is not revision ${rev}'s ${state.integrated.commit.slice(0, 12)}: gate-equals-deploy`,
    };
  }
  return undefined;
}

/**
 * The HUMAN decisions the board waits on: protected contracts escalated to a
 * human (still proposed) and contests escalated to a human (unresolved),
 * each sorted by id. A quiet board with any of these is waiting on a person,
 * not stuck. Pure.
 */
export function pendingHumanDecisions(state: BoardState): { readonly contracts: string[]; readonly contests: string[] } {
  return {
    contracts: Object.values(state.contracts)
      .filter((c) => c.guarded === true && c.status === "proposed")
      .map((c) => c.contract)
      .sort(),
    contests: Object.values(state.contests)
      .filter((c) => c.status === "escalated")
      .map((c) => c.id)
      .sort(),
  };
}

/** The engine messages the operator records through the engine-record route (`appendEngineRecord`). */
export const ENGINE_RECORD_TYPES = [
  "claim.lapsed",
  "clash.predicted",
  "trunk.moved",
  "token.refreshed",
  "revision.promoted",
  "run.capped",
  "candidate.gated",
  "integration.started",
  "integration.phase",
  "run.waiting",
  "push.excluded",
  "push.regressed",
  "item.completed",
] as const;
export type EngineRecordType = (typeof ENGINE_RECORD_TYPES)[number];

/**
 * Append an engine message the OPERATOR recorded (the engine-record route,
 * `POST /changes/:id/board/record {type, payload}`): facts only the operator
 * side observes, each validated against the board before it is appended.
 *   - claim.lapsed {item}: the board went quiet while the holder of a leased,
 *     unsuspended claim made no progress; the engine derives the holder, the
 *     last progress, and the push to start from, and records it `stalled`.
 *   - clash.predicted {a, b, status, paths?, scope?, reason?}: a clash
 *     prediction for two agents' pending pushes (advisory), addressed to both.
 *   - trunk.moved {rev, commit, expected?, actual?}: the integration branch
 *     could not be advanced to the latest passing revision (another writer).
 *   - token.refreshed {agent, kind, request?}: an agent's repo token was
 *     replaced before it expired (never the token).
 *   - revision.promoted {rev, gatedCommit, commit, branch}: the run promoted
 *     the latest passing revision (its gated commit must be the revision's).
 *   - run.capped {kind, limit, used, item?}: the run reached a cost or time cap.
 *   - candidate.gated {round, index, of, prefix, commit, base?, verdict,
 *     outcome, rev?, blamed?, progress?}: one candidate of a speculative
 *     integration round; a landed one must be the latest passing revision.
 *   - integration.started {kind, pushes, agents, items, candidates?} and
 *     integration.phase {started, phase, detail?, elapsedMs?}: integration
 *     progress (a round began, a coarse phase changed). Progress only: no
 *     board state changes and nothing is decided (arbitration revision 2+).
 *   - run.waiting {contracts, contests, waitedMs?}: the quiet board waits on
 *     these human decisions (progress only, arbitration revision 2+).
 *   - push.excluded {item, agent, commit, reason}: the integrator left the
 *     holder's pending push out of the integrated tree (it failed
 *     verification); addressed to the holder, it is not re-gated until the
 *     holder pushes again.
 *   - push.regressed {item, agent, commit, rev, ratchet, from, to, candidate,
 *     evidence, seams?}: under arbitration revision 5, before the first pass,
 *     the holder's push made its stack worse (the same stack without it,
 *     a gated tree, scored strictly better); addressed to the holder, it is
 *     not stacked again until the holder pushes again.
 *   - item.completed {item, n, pushSeq}: at the end of the agent phase, the
 *     engine closes an item whose owner did not propose done, backed by the
 *     owner's latest push (`pushSeq`) that the passing revision `n` merged
 *     (see engineCloseRefusal); recorded `closedBy: engine` and addressed to
 *     the owner.
 * Refused (nothing appended) when the record does not match the board.
 */
export function appendEngineRecord(state: BoardState, input: unknown, at: string): BoardAppendResult {
  if (state.goal === null) {
    fail("NO_GOAL", "the board has no goal yet");
  }
  if (!isRecord(input) || Object.keys(input).some((k) => k !== "type" && k !== "payload")) {
    fail("BAD_PAYLOAD", "an engine record is {type, payload}");
  }
  const type = input.type;
  if (typeof type !== "string" || !(ENGINE_RECORD_TYPES as readonly string[]).includes(type)) {
    fail("BAD_PAYLOAD", `an engine record's type is one of ${ENGINE_RECORD_TYPES.join(", ")}`);
  }
  const raw = isRecord(input.payload) ? input.payload : fail("BAD_PAYLOAD", "an engine record's payload must be an object");
  switch (type as EngineRecordType) {
    case "claim.lapsed": {
      if (Object.keys(raw).some((k) => k !== "item")) {
        fail("BAD_PAYLOAD", "a stalled claim record is {item}");
      }
      const item = requireItem(state, id(raw, "item"));
      if (!leasesOn(state) || item.lease === undefined || item.status !== "claimed" || item.owner === undefined) {
        fail("INVALID_STATE", `item ${item.id} has no leased claim to record stalled`);
      }
      const owner = item.owner;
      const commit = item.lastPush?.agent === owner ? item.lastPush.commit : undefined;
      return appendChecked(
        state,
        {
          from: BOARD_ENGINE,
          type: "claim.lapsed",
          payload: { item: item.id, agent: owner, reason: "stalled", lastProgressSeq: item.lease.progressSeq, ...(commit !== undefined ? { commit } : {}) },
          ...(activeAgent(state, owner) ? { to: [owner] } : {}),
        },
        at,
      );
    }
    case "item.completed": {
      if (Object.keys(raw).some((k) => !["item", "n", "pushSeq"].includes(k))) {
        fail("BAD_PAYLOAD", "an engine close record is {item, n, pushSeq}");
      }
      const payload = parsePayload("item.completed", { ...raw, via: "integrated", closedBy: "engine" }) as BoardPayloads["item.completed"];
      const owner = state.items[payload.item]?.owner;
      return appendChecked(
        state,
        { from: BOARD_ENGINE, type: "item.completed", payload, ...(owner !== undefined && activeAgent(state, owner) ? { to: [owner] } : {}) },
        at,
      );
    }
    case "candidate.gated": {
      if (Object.keys(raw).some((k) => !["round", "index", "of", "prefix", "commit", "base", "verdict", "outcome", "rev", "blamed", "progress"].includes(k))) {
        fail("BAD_PAYLOAD", "a candidate.gated record is {round, index, of, prefix, commit, base?, verdict, outcome, rev?, blamed?, progress?}");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "candidate.gated", payload: parsePayload("candidate.gated", raw) as BoardPayloads["candidate.gated"] }, at);
    }
    case "integration.started": {
      if (Object.keys(raw).some((k) => !["kind", "pushes", "agents", "items", "candidates"].includes(k))) {
        fail("BAD_PAYLOAD", "an integration.started record is {kind, pushes, agents, items, candidates?}");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "integration.started", payload: parsePayload("integration.started", raw) as BoardPayloads["integration.started"] }, at);
    }
    case "run.waiting": {
      if (Object.keys(raw).some((k) => !["contracts", "contests", "waitedMs"].includes(k))) {
        fail("BAD_PAYLOAD", "a run.waiting record is {contracts, contests, waitedMs?}");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "run.waiting", payload: parsePayload("run.waiting", raw) as BoardPayloads["run.waiting"] }, at);
    }
    case "integration.phase": {
      if (Object.keys(raw).some((k) => !["started", "phase", "detail", "elapsedMs"].includes(k))) {
        fail("BAD_PAYLOAD", "an integration.phase record is {started, phase, detail?, elapsedMs?}");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "integration.phase", payload: parsePayload("integration.phase", raw) as BoardPayloads["integration.phase"] }, at);
    }
    case "run.capped": {
      if (Object.keys(raw).some((k) => !["kind", "limit", "used", "item"].includes(k))) {
        fail("BAD_PAYLOAD", "a run.capped record is {kind, limit, used, item?}");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "run.capped", payload: parsePayload("run.capped", raw) as BoardPayloads["run.capped"] }, at);
    }
    case "revision.promoted": {
      if (Object.keys(raw).some((k) => !["rev", "gatedCommit", "commit", "branch"].includes(k))) {
        fail("BAD_PAYLOAD", "a revision.promoted record is {rev, gatedCommit, commit, branch}");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "revision.promoted", payload: parsePayload("revision.promoted", raw) as BoardPayloads["revision.promoted"] }, at);
    }
    case "token.refreshed": {
      if (Object.keys(raw).some((k) => !["agent", "kind", "request"].includes(k))) {
        fail("BAD_PAYLOAD", "a token.refreshed record is {agent, kind, request?} (never a token)");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "token.refreshed", payload: parsePayload("token.refreshed", raw) as BoardPayloads["token.refreshed"] }, at);
    }
    case "push.excluded": {
      if (Object.keys(raw).some((k) => !["item", "agent", "commit", "reason"].includes(k))) {
        fail("BAD_PAYLOAD", "a push.excluded record is {item, agent, commit, reason}");
      }
      const payload = parsePayload("push.excluded", raw) as BoardPayloads["push.excluded"];
      return appendChecked(
        state,
        { from: BOARD_ENGINE, type: "push.excluded", payload, ...(activeAgent(state, payload.agent) ? { to: [payload.agent] } : {}) },
        at,
      );
    }
    case "push.regressed": {
      if (Object.keys(raw).some((k) => !["item", "agent", "commit", "rev", "ratchet", "from", "to", "candidate", "evidence", "seams"].includes(k))) {
        fail("BAD_PAYLOAD", "a push.regressed record is {item, agent, commit, rev, ratchet, from, to, candidate, evidence, seams?}");
      }
      const payload = parsePayload("push.regressed", raw) as BoardPayloads["push.regressed"];
      return appendChecked(
        state,
        { from: BOARD_ENGINE, type: "push.regressed", payload, ...(activeAgent(state, payload.agent) ? { to: [payload.agent] } : {}) },
        at,
      );
    }
    case "trunk.moved": {
      if (Object.keys(raw).some((k) => !["rev", "commit", "expected", "actual"].includes(k))) {
        fail("BAD_PAYLOAD", "a trunk.moved record is {rev, commit, expected?, actual?}");
      }
      return appendChecked(state, { from: BOARD_ENGINE, type: "trunk.moved", payload: parsePayload("trunk.moved", raw) as BoardPayloads["trunk.moved"] }, at);
    }
    case "clash.predicted": {
      const payload = parsePayload("clash.predicted", raw) as BoardPayloads["clash.predicted"];
      const to = [payload.a.agent, payload.b.agent].filter((a) => activeAgent(state, a));
      return appendChecked(state, { from: BOARD_ENGINE, type: "clash.predicted", payload, ...(to.length > 0 ? { to } : {}) }, at);
    }
  }
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

/**
 * The seams a regressing push edits, split into FROZEN blueprint seams (no
 * item owns them: a seam contract is the route) and the other shared files
 * (an owned seam, a contracts file, the store). Pure.
 */
function regressionSeams(state: BoardState, seams: readonly string[]): { readonly frozen: string[]; readonly shared: string[] } {
  const frozen = seams.filter((seam) => seamTarget(state, seam) !== undefined && seamOwner(state, seam) === undefined);
  return { frozen, shared: seams.filter((seam) => !frozen.includes(seam)) };
}

/**
 * Arbitration revision 5: the seam contract cue of a held item whose latest
 * push made its stack worse (push.regressed) by editing a FROZEN shared seam (the
 * board accepts a seam contract for it), unless that seam was already asked
 * about for the item. Pure.
 */
function regressionSeamCue(
  state: BoardState,
  item: BoardItem,
  regression: NonNullable<BoardItemPush["regressed"]> | undefined,
): { readonly seams: readonly string[]; readonly errors: readonly string[] } | undefined {
  if (regression === undefined) {
    return undefined;
  }
  // The frozen seams the push edits, and those its new type errors point at (as the failing-revision cue reads them).
  const named = frozenSeamMismatches(state, item, regression.evidence);
  const asked = (seam: string) => Object.values(state.contracts).some((c) => c.seam === seam && c.item === item.id && c.status !== "rejected");
  const open = [...new Set([...regressionSeams(state, regression.seams ?? []).frozen, ...named.seams])].filter((seam) => !asked(seam)).sort();
  return open.length > 0 ? { seams: open, errors: named.errors.length > 0 ? named.errors : regression.evidence.slice(0, 4) } : undefined;
}

/**
 * The regression a push.regressed records, quoted for its holder (`to` is the
 * stack with the push, `from` the same stack without it):
 * `removing your push removes 22 type errors: src/billing/payments.ts(25,12): ...`. Pure.
 */
export function regressionQuote(r: Pick<BoardPayloads["push.regressed"], "from" | "to" | "evidence">): string {
  const removed = r.to.typeErrors - (r.from.runs ? 0 : r.from.typeErrors);
  const what =
    !r.to.runs && r.to.typeErrors > 0 && removed > 0
      ? `removing your push removes ${removed} type error${removed === 1 ? "" : "s"}${r.from.runs ? ` (the acceptance suite runs again: ${describeProgressScore(r.from)})` : ""}`
      : !r.to.runs && r.from.runs
        ? `without your push the acceptance suite runs (${describeProgressScore(r.from)})`
        : `removing your push takes the stack from ${describeProgressScore(r.to)} to ${describeProgressScore(r.from)}`;
  return r.evidence.length > 0 ? `${what}: ${r.evidence.slice(0, 3).join(" | ")}` : what;
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
    /**
     * An unanswered fix request: revision `n` FAILED the gate and implicates
     * this item. It is not done and not waiting for integration: the owner
     * edits it (a done proposal does not complete it). `instruction` says so.
     */
    readonly fix?: { readonly n: number; readonly attempt: number; readonly instruction: string };
    /** The integrator left this claim's latest push out (push.excluded): fix and push again. */
    readonly excluded?: { readonly commit: string; readonly reason: string; readonly instruction: string };
    /**
     * Arbitration revision 5: this claim's latest push made its stack WORSE
     * (push.regressed: `to` with it, `from` without it): `evidence` quotes the
     * failure lines its removal removes; with `seams` the push edited a shared
     * seam (propose a seam contract instead). Not stacked again until you push again.
     */
    readonly regressed?: {
      readonly commit: string;
      readonly rev: number;
      readonly from: string;
      readonly to: string;
      readonly evidence: readonly string[];
      readonly seams?: readonly string[];
      readonly instruction: string;
    };
    /** Seam-changing items this held item waits for before editing (bounded), then it rebases. */
    readonly waitsFor?: readonly string[];
    /** The failing check is in a protected path (the contract): propose a contract change if it pins old behavior. */
    readonly contractCue?: { readonly paths: readonly string[]; readonly hint: string };
    /**
     * Protected paths a human RELEASED to this item by an accepted contract
     * (never the immutable acceptance gate): writable for this item as if in
     * its write intent, and integrated with its push.
     */
    readonly released?: readonly string[];
    /** Released paths the item's latest push has not changed since the acceptance: edit them with the code fix. */
    readonly contractReleased?: { readonly paths: readonly string[]; readonly hint: string };
    /** The failing type error involves a frozen shared seam: propose a seam contract with the exact change (the lead decides). */
    readonly seamCue?: { readonly seams: readonly string[]; readonly errors: readonly string[]; readonly hint: string };
    /** The item's fix budget is spent. */
    readonly fixExhausted?: boolean;
    /**
     * Tools whose inputs cover this claim's write intent that it must NOT wait
     * for (rejected, failed their own gate, or not published within
     * `toolWaitMessages`): edit by hand instead.
     */
    readonly toolUnavailable?: readonly { readonly capability: string; readonly reason: string }[];
    /**
     * The claim's LEASE (lease rules only): it lapses at `lapsesAt` (a board
     * seq) unless you make progress on the item first (push, a message naming
     * it), and at its firm `deadlineSeq` unless the lead extends it.
     * `suspended` says why it cannot lapse right now.
     */
    readonly lease?: { readonly lastProgressSeq: number; readonly lapsesAt?: number; readonly deadlineSeq?: number; readonly suspended?: string; readonly hint: string };
    /** Why this held item is not moving (derived from the board), when it is not. */
    readonly wait?: BoardDigestWait;
    /**
     * Other holders whose item scope overlaps this item's (overlap rule only):
     * coordinate in a thread before editing the shared files; never a refusal.
     */
    readonly overlaps?: readonly { readonly item: string; readonly agent: string; readonly files: readonly string[]; readonly hint: string }[];
    /**
     * Predicted clashes of this item's pending push with another agent's
     * (recorded, advisory): a shared-seam conflict goes through the seam
     * contract; a local one is rebased by the item claimed later.
     */
    readonly clashes?: readonly { readonly item: string; readonly agent: string; readonly status: "conflict" | "unknown" | "unavailable"; readonly paths: readonly string[]; readonly scope?: "shared" | "local"; readonly hint: string }[];
  }[];
  readonly pending: readonly { readonly item: string; readonly contest: string }[];
  readonly contests: readonly BoardContest[];
  readonly openItems: readonly {
    readonly item: string;
    readonly objective: string;
    readonly acceptance: readonly string[];
    readonly scopeHint: readonly string[];
    readonly parent?: string;
    /** It changes a shared seam: take it first. */
    readonly seam?: boolean;
    /** Seam-changing items it waits for (claims are refused until their push is integrated, bounded). */
    readonly waitsFor?: readonly string[];
    /** Why it is waiting (derived from the board): unclaimed, its claim lapsed, the claim cap, ... */
    readonly wait?: BoardDigestWait;
    /** Items other agents hold whose scope overlaps this one's (overlap rule only): prefer an item without any. */
    readonly overlapsClaimed?: readonly string[];
  }[];
  readonly integrated: { readonly n: number; readonly commit: string } | null;
  /** This agent is at its active-claim cap: it finishes or hands off before claiming another item. */
  readonly claimCap?: { readonly cap: number; readonly holding: readonly string[]; readonly hint: string };
  /**
   * Seam items (accepted seam contracts) that are OPEN: nobody holds them. Any
   * agent may claim one (exempt from the claim cap); `blocks` lists this
   * agent's items whose files import that seam.
   */
  readonly openSeams?: readonly { readonly item: string; readonly seam: string; readonly blocks: readonly string[]; readonly hint: string }[];
  /**
   * LEAD only: held claims near their firm deadline (the last quarter), with
   * whether the holder is making progress. The lead extends a claim that is
   * progressing (claim.extended, with the reason) or lets it lapse.
   */
  readonly deadlines?: readonly {
    readonly item: string;
    readonly owner: string;
    readonly deadlineSeq: number;
    readonly remaining: number;
    readonly lastProgressSeq: number;
    readonly extensions: number;
    readonly progressing: boolean;
  }[];
  /**
   * LEAD only: items to RE-PLAN (their fix budget was spent, or they were
   * released for not moving twice): one bounded re-plan each (split,
   * re-scope, or merge with an open neighbour), from the failure attribution
   * of revision `rev` (the latest that asked for a fix on it).
   */
  readonly replan?: readonly {
    readonly item: string;
    readonly reason: BoardReplanReason;
    readonly rev?: number;
    readonly objective: string;
    readonly scopeHint: readonly string[];
    readonly exhaustedBy: readonly string[];
    readonly stallReleases: number;
    readonly neighbours: readonly { readonly item: string; readonly objective: string; readonly scopeHint: readonly string[] }[];
  }[];
  /** The latest revision this agent was told to rebase onto, if any. */
  readonly rebaseTo: number | null;
  /** The latest failing revision's evidence, when it asks this agent for a fix. */
  readonly failure: ({ readonly n: number } & BoardFailingEvidence) | null;
  /** Paths no agent may write (posted with the goal). */
  readonly protected: readonly string[];
  /** The immutable acceptance gate within `protected`: never contract-changeable. */
  readonly immutable?: readonly string[];
  /** Gate-defining keys inside editable files (posted with the goal). */
  readonly protectedKeys: readonly string[];
  /** Protected paths accepted contracts released for this agent's items. */
  readonly released: readonly string[];
  /**
   * The split items this agent is the SUB-LEAD of: each child's state and
   * latest push, and which of those pushes its own latest push merged. A
   * child's push integrates only through the sub-lead's next push (`pull`).
   */
  readonly subLead?: readonly {
    readonly item: string;
    readonly objective: string;
    readonly write: readonly string[];
    readonly children: readonly {
      readonly item: string;
      readonly status: BoardItemStatus;
      readonly owner?: string;
      readonly lastPush?: { readonly commit: string; readonly agent: string; readonly integratedIn?: number };
      /** The child's latest push is in the sub-lead's latest push. */
      readonly merged: boolean;
      /** A revision recorded this push unverified: it is not merged again until the child pushes again. */
      readonly unverified?: boolean;
    }[];
    readonly lastPush?: { readonly commit: string; readonly integratedIn?: number };
  }[];
  /**
   * Help with granted sub-scopes: this agent's own requests (`mine`), the
   * grants it holds as a helper (`granted`), and live requests nobody has
   * taken yet that it could offer to fork for (`wanted`).
   */
  readonly help?: {
    readonly mine: readonly BoardDigestHelp[];
    readonly granted: readonly BoardDigestHelp[];
    readonly wanted: readonly BoardDigestHelp[];
  };
  /**
   * STRUGGLING cue: this agent's claims that are going badly (its runtime
   * reported it, or a failing revision asks it for a fix), with the agents
   * that are idle right now (no claim, nothing pending) who could help.
   */
  readonly struggling?: readonly BoardDigestStruggle[];
  readonly idleAgents?: readonly string[];
  /**
   * IDLE cue: when this agent holds nothing and no item is open, the owners
   * whose items are going badly (it may volunteer: help.volunteered).
   */
  readonly busyOwners?: readonly (BoardDigestStruggle & { readonly agent: string; readonly scope: readonly string[] })[];
  /** Volunteers waiting for this agent's answer on its items. */
  readonly volunteers?: readonly { readonly agent: string; readonly item: string; readonly seq: number }[];
  /**
   * Arbitration revision 6: plain questions addressed to this agent that it
   * has not replied to yet (the asker still holds the item it asked about).
   */
  readonly questions?: readonly { readonly request: string; readonly item: string; readonly by: string; readonly need: string; readonly seq: number; readonly hint: string }[];
  /** Messages after `after` addressed to this agent or touching its work. */
  readonly messages: readonly BoardMessage[];
}

/** A wait reason as a digest shows it: the typed reason and one short line. */
export interface BoardDigestWait {
  readonly reason: BoardWaitReason;
  readonly line: string;
}

/** Recorded clash predictions still about `itemId`'s pending push (both commits still pending). Pure. */
export function liveClashes(state: BoardState, itemId: string): BoardClash[] {
  const pending = (side: BoardClashHead) => {
    const push = state.items[side.item]?.lastPush;
    return push !== undefined && push.commit === side.sha && push.gatedIn === undefined;
  };
  return (state.clashes ?? []).filter((c) => (c.a.item === itemId || c.b.item === itemId) && pending(c.a) && pending(c.b));
}

/** The digest's view of an item's wait reason, or nothing when it is moving. */
function digestWait(state: BoardState, itemId: string): { wait?: BoardDigestWait } {
  const reason = itemWaitReason(state, itemId);
  return reason !== undefined ? { wait: { reason, line: describeWaitReason(reason) } } : {};
}

/** An item going badly, as the cues show it. */
export interface BoardDigestStruggle {
  readonly item: string;
  readonly turnsSpent: number;
  readonly failedEdits: number;
  readonly reason: "failed-edits" | "turn-budget" | "failing-revision";
  readonly lastFailure?: string;
}

/** One help request with a granted sub-scope, as a digest shows it. */
export interface BoardDigestHelp {
  readonly request: string;
  readonly item: string;
  readonly by: string;
  readonly need: string;
  readonly scope: readonly string[];
  readonly live: boolean;
  readonly grantee?: string;
  readonly forkCommit?: string;
  readonly fork?: string;
  readonly delivered?: { readonly commit: string; readonly paths: readonly string[] };
  readonly pulled: boolean;
  /** The requester closed it without pulling. */
  readonly closed?: "declined" | "pull-failed";
  /** Fork offers whose fork did not start at the requester's push (they took no grant). */
  readonly forkMismatches?: readonly { readonly agent: string; readonly expected: string; readonly realized: string }[];
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
  // A cue that an owner is struggling (idle agents may volunteer).
  "item.struggling",
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
  // A sub-lead follows its children (their pushes are its to merge).
  for (const item of Object.values(state.items)) {
    if (item.status === "split" && item.subLead === agent) {
      for (const child of item.children) {
        mine.add(child);
      }
    }
  }
  const myRequests = new Set(Object.values(state.help).filter((h) => h.by === agent || h.grant?.agent === agent).map((h) => h.request));
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
    if ((m.type === "help.offered" || m.type === "help.delivered" || m.type === "help.closed") && myRequests.has(m.payload.request)) {
      return true;
    }
    // A request that grants a sub-scope is open work for any agent.
    if (m.type === "help.requested" && m.payload.scope !== undefined) {
      return true;
    }
    return m.type === "review.result" && myReviews.has(m.payload.review);
  };
  const held = Object.values(state.items).filter((i) => i.status === "claimed" && i.owner === agent && i.intent);
  // Arbitration revision 5: the recorded regression of each held item's latest push.
  const regressions = new Map<string, NonNullable<BoardItemPush["regressed"]> & { readonly commit: string }>();
  for (const i of held) {
    const r = i.lastPush?.regressed;
    if (r !== undefined && i.lastPush!.agent === agent && i.lastPush!.integratedIn === undefined) {
      regressions.set(i.id, { ...r, commit: i.lastPush!.commit });
    }
  }
  const failure = state.lastFailure;
  const askedToFix = failure !== null && held.some((i) => fixOwedFor(state, i, failure));
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
      ...(i.lastPush?.excluded !== undefined && i.lastPush.agent === agent && i.lastPush.gatedIn === undefined
        ? {
            excluded: {
              commit: i.lastPush.commit,
              reason: i.lastPush.excluded.reason,
              instruction:
                `your push ${i.lastPush.commit.slice(0, 10)} for this item was LEFT OUT of integration (${i.lastPush.excluded.reason}): no gate ran on it and it is not re-gated as it is. ` +
                "Fix the cause (stay inside the write intent) and push again; you are not waiting for integration",
            },
          }
        : {}),
      ...((): Pick<BoardDigest["claims"][number], "regressed"> => {
        const r = regressions.get(i.id);
        if (r === undefined) {
          return {};
        }
        const { frozen, shared } = regressionSeams(state, r.seams ?? []);
        const seamHint =
          frozen.length > 0
            ? ` It edits the shared seam ${frozen.join(", ")}, which no item owns: do not change a seam other items import; send message kind contract {target: ${frozen[0]}, change: modify, itemId: ${i.id}, description: the exact change you need} (the lead decides).`
            : shared.length > 0
              ? ` It edits the shared file ${shared.join(", ")} that other items import: keep it backward compatible (add what you need; never rename or remove what others use), or propose the change as a seam contract instead of editing it.`
              : "";
        return {
          regressed: {
            commit: r.commit,
            rev: r.rev,
            from: describeProgressScore(r.from),
            to: describeProgressScore(r.to),
            evidence: [...r.evidence],
            ...(r.seams !== undefined ? { seams: [...r.seams] } : {}),
            instruction:
              `your push ${r.commit.slice(0, 10)} made revision ${r.rev} WORSE: with it the stack scores ${describeProgressScore(r.to)}, without it ${describeProgressScore(r.from)} ` +
              `(the best revision so far is ${r.ratchet})${r.evidence.length > 0 ? `; failures your push brings: ${r.evidence.slice(0, 3).join(" | ")}` : ""}. ` +
              `Fix exactly that (stay inside the write intent; use only APIs that exist) and push again; it is not stacked until you do.${seamHint}`,
          },
        };
      })(),
      ...(i.fixRequested !== undefined
        ? {
            fix: {
              n: i.fixRequested,
              attempt: i.fixAttempts ?? 1,
              instruction: regressions.has(i.id)
                ? `revision ${i.fixRequested} FAILED the gate and the stack scores better without your push (fix attempt ${i.fixAttempts ?? 1} of ${state.rules.maxFixAttempts}): ${regressionQuote(regressions.get(i.id)!)}. ` +
                  "Edit it now to remove the regression (claims.regressed has the evidence). Your done proposal does not complete it, and you are not waiting for integration"
                : `revision ${i.fixRequested} FAILED the gate and implicates this item (fix attempt ${i.fixAttempts ?? 1} of ${state.rules.maxFixAttempts}): ` +
                  "edit it now to make the gate pass (digest.failure has the output). Your done proposal does not complete it, and you are not waiting for integration",
            },
          }
        : {}),
      ...((): { waitsFor?: string[] } => {
        const waits = seamWaits(state, i.id).map((w) => w.item);
        return waits.length > 0 ? { waitsFor: waits } : {};
      })(),
      ...((): { contractCue?: { paths: string[]; hint: string } } => {
        // Revision 7: never cue a contract the board refuses (released to another live item).
        const paths =
          i.fixRequested !== undefined
            ? contractCue(state, i.id).filter((p) => !releasedTargets(state, i.id).includes(p) && !(arbitrationV7(state) && (releaseHolder(state, i.id, p) !== undefined || pendingReleaseRival(state, i.id, p) !== undefined)))
            : [];
        return paths.length > 0
          ? {
              contractCue: {
                paths,
                hint: `the failing check is in the protected test ${paths.join(", ")}; if it encodes the old behavior the goal changes, send message kind contract {target: ${paths[0]}, change: modify, itemId: ${i.id}} (a human decides)`,
              },
            }
          : {};
      })(),
      ...((): { released?: string[]; contractReleased?: { paths: string[]; hint: string } } => {
        const released = releasedForAgent(state, i.id);
        if (released.length === 0) {
          return {};
        }
        const pending = releasedUnchanged(state, i);
        return {
          released,
          ...(pending.length > 0
            ? {
                contractReleased: {
                  paths: pending,
                  hint:
                    `a human accepted changing ${pending.join(", ")} for ${i.id}: it is writable for this item now; edit it in the same edit as the code fix so they integrate together, ` +
                    "changing only the assertions that encode the behavior the goal changes",
                },
              }
            : {}),
        };
      })(),
      ...((): { seamCue?: { seams: string[]; errors: string[]; hint: string } } => {
        const cue = i.fixRequested !== undefined ? (seamContractCue(state, i.id) ?? regressionSeamCue(state, i, regressions.get(i.id))) : undefined;
        return cue
          ? {
              seamCue: {
                seams: [...cue.seams],
                errors: [...cue.errors],
                hint:
                  `the failing type error involves the shared seam ${cue.seams.join(", ")}, which no item owns: do not use undeclared fields or casts; ` +
                  `send message kind contract {target: ${cue.seams[0]}, change: modify, itemId: ${i.id}, description: the exact change you need} (the lead decides; accepted, it becomes a seam item that goes first, then you rebase onto it)`,
              },
            }
          : {};
      })(),
      ...(i.fixExhausted ? { fixExhausted: true } : {}),
      ...((): { toolUnavailable?: { capability: string; reason: string }[] } => {
        const unavailable = i.tool ? [] : unavailableToolsFor(state, i.intent!.write);
        return unavailable.length > 0 ? { toolUnavailable: unavailable } : {};
      })(),
      ...((): Pick<BoardDigest["claims"][number], "lease"> => {
        const lease = i.lease;
        if (lease === undefined) {
          return {};
        }
        // Revision 3: an item waiting on others never lapses for no progress.
        const waiting = waitingOnOthers(state, i);
        const limit = waiting ? undefined : state.rules.claimLeaseMessages;
        const suspended = leaseSuspension(state, i);
        // Revision 2 counts participant messages only: the earliest board seq it could lapse at.
        const lapsesAt =
          limit === undefined
            ? undefined
            : arbitrationV2(state)
              ? state.lastSeq + Math.max(0, limit - (boardClock(state) - (lease.progressTick ?? 0)))
              : lease.progressSeq + limit;
        return {
          lease: {
            lastProgressSeq: lease.progressSeq,
            ...(lapsesAt !== undefined ? { lapsesAt } : {}),
            ...(lease.deadlineSeq !== undefined ? { deadlineSeq: lease.deadlineSeq } : {}),
            ...(suspended !== undefined ? { suspended } : {}),
            hint:
              suspended !== undefined
                ? `your claim cannot lapse now (${suspended})`
                : waiting
                  ? `${i.id} waits on the other items (its push was gated and no fix is owed): it does not lapse for no progress${lease.deadlineTick !== undefined ? `, only at its deadline (${Math.max(0, lease.deadlineTick - boardClock(state))} more participant message(s)) unless the lead extends it` : ""}`
                  : arbitrationV2(state)
                    ? `your claim lapses${lapsesAt !== undefined ? ` after ${lapsesAt - state.lastSeq} more participant message(s) unless you make progress on ${i.id} first (edit and push, or a message naming it)` : ""}${lease.deadlineTick !== undefined ? `${lapsesAt !== undefined ? ", and" : ""} at its deadline (${Math.max(0, lease.deadlineTick - boardClock(state))} more participant message(s)) unless the lead extends it` : ""}; then the item is open for another agent`
                    : `your claim lapses${lapsesAt !== undefined ? ` at board seq ${lapsesAt} unless you make progress on ${i.id} first (edit and push, or a message naming it)` : ""}${lease.deadlineSeq !== undefined ? `${lapsesAt !== undefined ? ", and" : ""} at its deadline seq ${lease.deadlineSeq} unless the lead extends it` : ""}; then the item is open for another agent`,
          },
        };
      })(),
      ...digestWait(state, i.id),
      ...((): Pick<BoardDigest["claims"][number], "overlaps"> => {
        const overlaps = state.rules.claimOverlap === true ? scopeOverlaps(state, i.id, agent) : [];
        return overlaps.length > 0
          ? {
              overlaps: overlaps.map((o) => ({
                ...o,
                files: [...o.files],
                hint: `${o.agent} holds ${o.item}, whose scope overlaps yours on ${o.files.join(", ")}: coordinate with it in a thread (a question naming ${i.id}) before editing those files; the item claimed later rebases on the other's push`,
              })),
            }
          : {};
      })(),
      ...((): Pick<BoardDigest["claims"][number], "clashes"> => {
        const clashes = liveClashes(state, i.id);
        return clashes.length > 0
          ? {
              clashes: clashes.map((c) => {
                const mine = c.a.item === i.id ? c.a : c.b;
                const other = c.a.item === i.id ? c.b : c.a;
                const laterIsMine = (i.grantedSeq ?? 0) > (state.items[other.item]?.grantedSeq ?? 0);
                const hint =
                  c.status !== "conflict"
                    ? `a clash prediction with ${other.agent}'s push for ${other.item} could not be decided (${c.reason ?? c.status}): the gate decides; watch the next revision`
                    : c.scope === "shared"
                      ? `your push ${mine.sha.slice(0, 10)} conflicts with ${other.agent}'s ${other.item} on the shared seam ${(c.paths ?? []).join(", ")}: propose or consult the seam contract (message kind contract on the seam path) instead of both editing it`
                      : laterIsMine
                        ? `your push conflicts with ${other.agent}'s ${other.item} on ${(c.paths ?? []).join(", ")}: you claimed later, so rebase onto its push (or coordinate in a thread)`
                        : `your push conflicts with ${other.agent}'s ${other.item} on ${(c.paths ?? []).join(", ")}: it claimed later and rebases onto yours; coordinate in a thread if needed`;
                return { item: other.item, agent: other.agent, status: c.status, paths: [...(c.paths ?? [])], ...(c.scope !== undefined ? { scope: c.scope } : {}), hint };
              }),
            }
          : {};
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
        ...(isSeamItem(state, i.id) ? { seam: true } : {}),
        ...((): { waitsFor?: string[] } => {
          const waits = seamWaits(state, i.id).map((w) => w.item);
          return waits.length > 0 ? { waitsFor: waits } : {};
        })(),
        ...digestWait(state, i.id),
        ...((): { overlapsClaimed?: string[] } => {
          const overlaps = state.rules.claimOverlap === true ? scopeOverlaps(state, i.id, agent).map((o) => o.item) : [];
          return overlaps.length > 0 ? { overlapsClaimed: overlaps } : {};
        })(),
      })),
    integrated: state.integrated ? { n: state.integrated.n, commit: state.integrated.commit } : null,
    ...((): Pick<BoardDigest, "claimCap"> => {
      const capped = claimCapReached(state, agent);
      return capped
        ? {
            claimCap: {
              cap: capped.cap,
              holding: [...capped.holding],
              hint: arbitrationV3(state)
                ? `you hold ${capped.holding.length} unfinished item(s) (${capped.holding.join(", ")}; cap ${capped.cap}): push one and let the gate take it (once its push is gated with no fix asked, it no longer counts), or hand it off, before claiming another; idle agents take the open items`
                : `you hold ${capped.holding.length} unfinished item(s) (${capped.holding.join(", ")}; cap ${capped.cap}): finish one (edit, push, let it pass) or hand it off before claiming another; idle agents take the open items`,
            },
          }
        : {};
    })(),
    ...((): Pick<BoardDigest, "openSeams"> => {
      const open = Object.values(state.items).filter((i) => i.status === "open" && i.fromContract !== undefined);
      if (open.length === 0) {
        return {};
      }
      const mine = Object.values(state.items).filter((i) => (i.status === "claimed" || i.status === "contested") && i.owner === agent);
      return {
        openSeams: open.map((i) => {
          const seam = i.scopeHint[0] ?? "";
          const importers = (state.seams ?? []).find((x) => x.path === seam)?.importers ?? [];
          const blocks = mine.filter((m) => importers.some((imp) => itemCovers(m, imp))).map((m) => m.id);
          return {
            item: i.id,
            seam,
            blocks,
            hint: `${i.id} (a change to the shared seam ${seam}) is OPEN: nobody holds it, so nothing is waiting on anyone else. Claim it yourself (seam items are exempt from the claim cap)${blocks.length > 0 ? `; your ${blocks.join(", ")} need(s) it` : ""}`,
          };
        }),
      };
    })(),
    ...((): Pick<BoardDigest, "deadlines"> => {
      const window = state.rules.claimDeadlineMessages;
      if (record?.role !== LEAD_ROLE || window === undefined) {
        return {};
      }
      const pace = state.rules.claimLeaseMessages ?? Math.ceil(window / 4);
      const near = Object.values(state.items).flatMap((i) => {
        const lease = i.lease;
        if (i.status !== "claimed" || i.owner === undefined || lease?.deadlineSeq === undefined) {
          return [];
        }
        const remaining = arbitrationV2(state) ? (lease.deadlineTick ?? 0) - boardClock(state) : lease.deadlineSeq - state.lastSeq;
        return remaining <= Math.ceil(window / 4)
          ? [{ item: i.id, owner: i.owner, deadlineSeq: lease.deadlineSeq, remaining, lastProgressSeq: lease.progressSeq, extensions: lease.extensions, progressing: boardClock(state) - anchorClock(state, lease.progressSeq, lease.progressTick) < Math.ceil(pace / 2) }]
          : [];
      });
      return near.length > 0 ? { deadlines: near } : {};
    })(),
    ...((): Pick<BoardDigest, "replan"> => {
      if (record?.role !== LEAD_ROLE) {
        return {};
      }
      const due = Object.values(state.items).flatMap((i) => {
        const reason = replanEligible(state, i.id);
        if (reason === undefined) {
          return [];
        }
        const neighbours = Object.values(state.items)
          .filter((o) => o.id !== i.id && o.status === "open" && isChangeItem(o) && o.fromContract === undefined && o.replanOf === undefined)
          .slice(0, 8)
          .map((o) => ({ item: o.id, objective: o.objective, scopeHint: [...o.scopeHint] }));
        return [
          {
            item: i.id,
            reason,
            ...(i.failedRev !== undefined ? { rev: i.failedRev } : {}),
            objective: i.objective,
            scopeHint: [...i.scopeHint],
            exhaustedBy: [...(i.exhaustedBy ?? [])],
            stallReleases: i.stallReleases ?? 0,
            neighbours,
          },
        ];
      });
      return due.length > 0 ? { replan: due } : {};
    })(),
    rebaseTo: record?.rebaseTo ?? null,
    failure: askedToFix ? failure : null,
    protected: state.protected,
    ...((state.immutable ?? []).length > 0 ? { immutable: state.immutable } : {}),
    protectedKeys: state.protectedKeys,
    released: [...new Set(held.flatMap((i) => releasedTargets(state, i.id)))],
    ...((): Pick<BoardDigest, "subLead"> => {
      const led = Object.values(state.items).filter((i) => i.status === "split" && i.subLead === agent && i.owner === agent);
      if (led.length === 0) {
        return {};
      }
      return {
        subLead: led.map((i) => {
          const merged = new Set(
            (i.lastPush?.merges ?? []).filter((m) => !(i.lastPush?.unverified ?? []).includes(m.item)).map((m) => `${m.item}@${m.commit}`),
          );
          return {
            item: i.id,
            objective: i.objective,
            write: [...(i.intent?.write ?? [])],
            children: i.children.map((id) => {
              const child = state.items[id]!;
              return {
                item: id,
                status: child.status,
                ...(child.owner !== undefined ? { owner: child.owner } : {}),
                ...(child.lastPush
                  ? {
                      lastPush: {
                        commit: child.lastPush.commit,
                        agent: child.lastPush.agent,
                        ...(child.lastPush.integratedIn !== undefined ? { integratedIn: child.lastPush.integratedIn } : {}),
                      },
                    }
                  : {}),
                merged: child.lastPush !== undefined && merged.has(`${id}@${child.lastPush.commit}`),
                // Recorded unverified at this commit: not merged again until the child pushes again.
                ...(child.lastPush?.unverifiedIn !== undefined ? { unverified: true } : {}),
              };
            }),
            ...(i.lastPush
              ? { lastPush: { commit: i.lastPush.commit, ...(i.lastPush.integratedIn !== undefined ? { integratedIn: i.lastPush.integratedIn } : {}) } }
              : {}),
          };
        }),
      };
    })(),
    ...((): Pick<BoardDigest, "struggling" | "idleAgents" | "busyOwners" | "volunteers"> => {
      const struggleOf = (i: BoardItem): BoardDigestStruggle | undefined => {
        // A report goes stale once its owner pushed after it (that is progress).
        const report =
          i.struggling?.owner === i.owner && !(i.lastPush && i.lastPush.agent === i.owner && i.lastPush.seq > i.struggling!.seq) ? i.struggling : undefined;
        const fixing = i.fixRequested !== undefined;
        if (!report && !fixing) {
          return undefined;
        }
        const failureLine =
          report?.lastFailure ??
          (fixing && state.lastFailure !== null && fixOwedFor(state, i, state.lastFailure)
            ? // Skip command echoes (npm's "> pkg@1.0.0 gate", "$ cmd") and npm noise.
              (state.lastFailure!.output.split("\n").find((l) => l.trim() !== "" && !/^\s*[>$] /.test(l) && !/^\s*npm (error|ERR!)/.test(l)) ?? "").slice(0, 200)
            : undefined);
        return {
          item: i.id,
          turnsSpent: report?.turnsSpent ?? 0,
          failedEdits: report?.failedEdits ?? 0,
          reason: report?.reason ?? "failing-revision",
          ...(failureLine ? { lastFailure: failureLine } : {}),
        };
      };
      const holds = (a: string) =>
        Object.values(state.items).some((i) => ((i.status === "claimed" || i.status === "split") && i.owner === a) || i.claimant?.agent === a) ||
        Object.values(state.help).some((h) => h.grant?.agent === a && helpGrantLive(state, h));
      const out: Pick<BoardDigest, "struggling" | "idleAgents" | "busyOwners" | "volunteers"> = {};
      const mineStruggling = held.flatMap((i) => {
        const s = struggleOf(i);
        return s ? [s] : [];
      });
      if (mineStruggling.length > 0) {
        Object.assign(out, {
          struggling: mineStruggling,
          idleAgents: Object.values(state.agents)
            .filter((a) => a.leftSeq === undefined && a.role !== LEAD_ROLE && a.id !== agent && !holds(a.id))
            .map((a) => a.id)
            .sort(),
        });
      }
      const open = Object.values(state.items).some((i) => i.status === "open");
      if (record?.role !== LEAD_ROLE && !holds(agent) && !open) {
        const busy = Object.values(state.items).flatMap((i) => {
          if (i.status !== "claimed" || i.owner === undefined || i.owner === agent || !activeAgent(state, i.owner) || i.tool) {
            return [];
          }
          const s = struggleOf(i);
          return s ? [{ ...s, agent: i.owner, scope: [...(i.intent?.write ?? [])] }] : [];
        });
        if (busy.length > 0) {
          Object.assign(out, { busyOwners: busy });
        }
      }
      const waiting = Object.values(state.volunteers ?? {}).filter(
        (v) => v.owner === agent && v.answered === undefined && state.items[v.item]?.status === "claimed" && state.items[v.item]?.owner === agent,
      );
      if (waiting.length > 0) {
        Object.assign(out, { volunteers: waiting.map((v) => ({ agent: v.agent, item: v.item, seq: v.seq })) });
      }
      return out;
    })(),
    ...((): Pick<BoardDigest, "help"> => {
      const view = (h: BoardHelpRequest): BoardDigestHelp => ({
        request: h.request,
        item: h.item,
        by: h.by,
        need: h.need,
        scope: [...(h.scope ?? [])],
        live: helpGrantLive(state, h),
        ...(h.grant !== undefined ? { grantee: h.grant.agent } : {}),
        ...(h.grant?.forkCommit !== undefined ? { forkCommit: h.grant.forkCommit } : {}),
        ...(h.grant?.fork !== undefined ? { fork: h.grant.fork } : {}),
        ...(h.delivered !== undefined ? { delivered: { commit: h.delivered.commit, paths: h.delivered.paths } } : {}),
        pulled: h.pulledSeq !== undefined,
        ...(h.closed !== undefined ? { closed: h.closed.reason } : {}),
        ...(h.forkMismatches !== undefined ? { forkMismatches: h.forkMismatches.map((f) => ({ agent: f.agent, expected: f.expected, realized: f.realized })) } : {}),
      });
      const granting = Object.values(state.help).filter((h) => h.scope !== undefined);
      const mineHelp = granting.filter((h) => h.by === agent && h.pulledSeq === undefined && h.closed === undefined).map(view);
      const granted = granting.filter((h) => h.grant?.agent === agent && h.pulledSeq === undefined && h.closed === undefined).map(view);
      const wanted = granting
        .filter((h) => h.by !== agent && h.grant === undefined && helpGrantLive(state, h) && !h.offers.includes(agent) && (h.to === undefined || h.to.includes(agent)))
        .map(view);
      return mineHelp.length + granted.length + wanted.length > 0 ? { help: { mine: mineHelp, granted, wanted } } : {};
    })(),
    ...((): Pick<BoardDigest, "questions"> => {
      // Revision 6: questions asked of this agent and not answered yet (only recorded under it).
      const asked = Object.values(state.help).filter(
        (h) =>
          h.scope === undefined &&
          (h.askedOf ?? []).includes(agent) &&
          h.by !== agent &&
          !h.offers.includes(agent) &&
          h.closed === undefined &&
          activeAgent(state, h.by) &&
          state.items[h.item]?.owner === h.by &&
          (state.items[h.item]?.status === "claimed" || state.items[h.item]?.status === "split"),
      );
      return asked.length > 0
        ? {
            questions: asked.slice(0, 8).map((h) => ({
              request: h.request,
              item: h.item,
              by: h.by,
              need: h.need,
              seq: h.seq ?? 0,
              hint: `${h.by} asked you about ${h.item} (${h.need}): answer it with message kind reply {requestId: ${h.request}} and what you know (or that you cannot help); it is waiting on your reply`,
            })),
          }
        : {};
    })(),
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
  /** the protected contract it decides (a contract.escalated), or */
  readonly boardContract?: string;
  /** the re-planned item that failed again (an item.escalated). */
  readonly boardItem?: string;
}

/** Escalation requests for every claim.escalated among `messages`. */
export function boardEscalationRequests(messages: readonly BoardMessage[]): BoardEscalationRequest[] {
  const out: BoardEscalationRequest[] = [];
  for (const message of messages) {
    if (message.type === "item.escalated") {
      const p = message.payload;
      out.push({
        kind: "decision",
        question:
          `Board item ${p.item} failed again after the lead re-planned ${p.replanOf} (its fix budget was spent, or it stopped moving twice). ` +
          "It stays open for another agent; the engine will not re-plan it again. Acknowledge, or take it over by hand.",
        options: ["acknowledge"],
        boardItem: p.item,
      });
      continue;
    }
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
  /** A re-planned item that failed again (closed when the item completes). */
  readonly boardItem?: string;
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
  const completed = new Set(appended.flatMap((m) => (m.type === "item.completed" ? [m.payload.item] : [])));
  // The latest advisory triage per contract among the appended messages.
  const triage = new Map<string, string>();
  for (const message of appended) {
    if (message.type === "decision.recorded" && message.payload.juncture === "contract-triage" && message.payload.contract !== undefined) {
      triage.set(message.payload.contract, contractTriageRecommendation(message.payload));
    }
  }
  const out = list.map((e): E => {
    const decision =
      e.boardContest !== undefined
        ? settled.get(e.boardContest)
        : e.boardContract !== undefined
          ? decided.get(e.boardContract)
          : e.boardItem !== undefined && completed.has(e.boardItem)
            ? "completed"
            : undefined;
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
          (request.boardContract !== undefined && e.boardContract === request.boardContract) ||
          (request.boardItem !== undefined && e.boardItem === request.boardItem)),
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
      ...(request.boardItem !== undefined ? { boardItem: request.boardItem } : {}),
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

/**
 * How many distinct sub-changes an objective names (a simple, documented
 * heuristic for the split cue): its clauses split on ";", ",", " and ",
 * " then ", counting those of at least two words. "Add input validation and
 * require auth on every resource" names 2.
 */
export function objectiveSubChanges(objective: string): number {
  const head = objective.split(/\s+\(/)[0] ?? objective;
  return head
    .split(/;|,|\band\b|\bthen\b/i)
    .map((part) => part.trim().split(/\s+/).filter((w) => w.length > 0))
    .filter((words) => words.length >= 2).length;
}

/** The split cue: an item is worth splitting when its write intent spans at least 3 files or its objective names at least 2 sub-changes. */
export function splitCue(files: number, objective: string): { readonly splittable: boolean; readonly files: number; readonly subChanges: number } {
  const subChanges = objectiveSubChanges(objective);
  return { splittable: files >= 3 || subChanges >= 2, files, subChanges };
}

/**
 * Files a failing revision points at that NO item covers (no accepted item's
 * scope or write intent, in any status, and no undecided proposal): work the
 * plan missed. Protected paths, tool directories, and shared seams (they change
 * only through a seam contract) are never proposed. Pure.
 */
export function uncoveredFailureFiles(state: BoardState, failingFiles: readonly string[]): string[] {
  const covers = (entries: readonly string[], file: string) => entries.some((e) => entryWithin(file, intentPath(e)));
  const seams = new Set((state.seams ?? []).map((seam) => seam.path));
  return failingFiles
    .filter((file) => !file.startsWith(`${TOOLS_DIR}/`))
    // A shared seam changes only through a seam contract, never as uncovered work.
    .filter((file) => !seams.has(file))
    .filter((file) => !state.protected.some((p) => p === file || entryWithin(file, p)))
    .filter(
      (file) =>
        !Object.values(state.items).some(
          (i) => i.status !== "rejected" && i.tool === undefined && (covers(i.scopeHint, file) || covers(i.intent?.write ?? [], file)),
        ),
    )
    .sort();
}

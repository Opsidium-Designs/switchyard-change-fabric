/**
 * run-board: a Change driven by agents that FORM around a goal on the board,
 * integrated continuously.
 *
 * This is a separate run mode next to run-live; it shares that run's planner,
 * executor, gate, integrator, attribution, promotion, and redeploy, and changes
 * only how work is distributed. Instead of the engine assigning WorkUnits, the
 * lead proposes open items and workers claim them:
 *
 *   1. create the Change (the planning-first placeholder), derive the PROTECTED
 *      set from the project (the files that define the gate), and post the goal
 *      with it as the human, so it is visible on the board;
 *   2. the lead joins; its first turn is the planner, whose units become
 *      `item.proposed` messages (scoped away from protected paths);
 *   3. workers join under the min/max dial (another joins while open items
 *      outnumber the workers in flight, up to max), each with its own repo, and
 *      take turns: claim, contest, narrow, ask, edit, push, propose done;
 *   4. CONTINUOUS INTEGRATION: whenever announced pushes are pending, the
 *      integrator builds the next integrated revision from the latest passing
 *      revision plus every pending push (each pinned to its announced commit),
 *      runs the gate on it (with the gate's own files from the baseline), and
 *      records it on the board. Revisions are serialized; pushes that land while
 *      one runs are coalesced into the next. A failing revision carries its
 *      bounded, credential-free output and the items attribution implicated; the
 *      board asks those owners for a fix (addressed to them), they rebase onto
 *      the latest passing revision, edit with the failing output (on the next
 *      model of the escalation ladder per attempt), and push again, which
 *      triggers the next revision;
 *   5. the agent phase ends when every item is completed (the board derives
 *      completion from a passing revision), or a budget, quiescence, or the
 *      timeout ends it; the authoritative verdict is the LAST revision's gate,
 *      and only that revision, when it passed, is promoted (and redeployed in
 *      place): the promoted tree is the gated tree.
 *
 * Two schedules: `lockstep` steps every agent in a fixed order each round and
 * integrates between rounds, so the board log is identical run to run (offline
 * demo, tests); `concurrent` runs each agent's own loop (live runs).
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOARD_LIMITS,
  boardAttributionTally,
  pendingPushItems,
  pendingPushKey,
  planBoardIntegration,
  narrowToSplitChildren,
  helpGrantLive,
  routedToSubLead,
  entriesOverlap,
  contractTriageRecommendation,
  withContractTriage,
  entryWithin,
  formatAttributionTally,
  intentPath,
  type BoardDecisionJuncture,
  type BoardDigest,
  type BoardItem,
  combineAttribution,
  isAcceptedItem,
  isChangeItem,
  toolUnavailableReason,
  isSeamItem,
  seamHolds,
  deriveCohesionBlueprint,
  type BoardMessage,
  type BoardRules,
  type BoardState,
  type BoardRevProgress,
  describeProgress,
  progressHeadline,
  type Change,
  type ConcurrencyDial,
} from "@switchyard-change/change-core";
import type { AgentTurnTransport, AskJev, ExecutorProvider } from "@switchyard-change/model-adapters";
import { jevErrorReason, ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import { runGit } from "@switchyard-change/artifact-workspace/git-transport";
import { authenticatedRemote, type GitIdentity } from "@switchyard-change/local-runner";
import type { PromotionResult } from "@switchyard-change/git-promotion";
import {
  advanceIntegrationBranch,
  ChangeVerification,
  ChildProcessCommandRunner,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  formatDependencyInstall,
  gateFailureLine,
  InstallingCommandRunner,
  LockfileDependencyInstaller,
  type DependencyInstaller,
  type DependencyInstallOutcome,
  inventoryAfterContracts,
  recordBaselineInventory,
  GATED_REF_PREFIX,
  matchesGlob,
  labelGateProgress,
  readTestProgress,
  type CommandRunner as VerificationCommandRunner,
  type CompletedWorkUnit,
  type EvidenceSummary,
} from "@switchyard-change/verification";

import { scanRepoSnapshot } from "./scan-repo.ts";
import { BoardAgent, RunTurnBudget, type AgentStop, type AgentTurnRecord, type BoardSeedItem } from "./board-agent.ts";
import {
  CloudBoardIntegrator,
  configureCloudIntegration,
  createCloudIntegrationWorkspace,
  gateSupportFilesFor,
  integrationRepoToken,
  type BoardIntegratorLike,
  type CloudIntegrationWorkspace,
} from "./cloud-board-integrator.ts";
import { BoardOperatorClient, type JoinedWorkspace } from "./board-client.ts";
import { executorToolAuthor, ToolBench, type ToolAuthor, type ToolGateRecord } from "./board-tools.ts";
import { readTargetExcerpt, triageContract } from "./contract-triage.ts";
import { deriveProtectedPaths, type ProtectedPaths } from "./protected-paths.ts";
import type { TestInventory } from "@switchyard-change/verification";
import { redactSecrets } from "./redact.ts";
import {
  attributeImplicatedUnits,
  createIntegrationWorkspace,
  createPlanningChange,
  failPlanningChange,
  materializeSiblingGateDeps,
  promoteVerifiedIntegration,
  redeployIfPreviouslyDeployed,
  type DeployApp,
  type FullLiveEvent,
  type GatedUnitInput,
} from "./run-live.ts";
import { withWorkerAuth } from "./worker-auth.ts";


/** An advisory typed decision and its outcome, as recorded on the board. */
export interface BoardDecisionRecord {
  readonly juncture: BoardDecisionJuncture;
  readonly question: string;
  readonly answer?: string;
  readonly confidence?: number;
  readonly accepted: boolean;
  readonly error?: string;
  /** Attribution: the failing revision it is about (set once the revision is recorded). */
  readonly rev?: number;
  /** Attribution: the items the string-parse attributed (empty when it attributed nothing). */
  readonly parsed?: readonly string[];
  /** Contract triage: the protected contract it is about. */
  readonly contract?: string;
}

/**
 * How recording a decision went: appended, refused by the board (a definite
 * answer: nothing was appended), or a transport failure (unknown: it may or may
 * not have been appended).
 */
export type BoardDecisionRecordOutcome = "recorded" | "refused" | "failed";

/** Records an advisory decision on the board. */
export type RecordBoardDecision = (decision: BoardDecisionRecord) => Promise<BoardDecisionRecordOutcome | void>;

/** What the lead's planner produced. */
export interface BoardSeed {
  readonly items: readonly BoardSeedItem[];
  /** The planner's plan-review decision (or its failure), when a decision model reviewed the plan. */
  readonly review?: { readonly question: string; readonly noul: string; readonly confidence: number; readonly accepted: boolean; readonly error?: string };
  /** Reviews of earlier plans of the pass that were not chosen (each recorded too, before the final one). */
  readonly priorReviews?: readonly { readonly question: string; readonly noul: string; readonly confidence: number; readonly accepted: boolean; readonly error?: string; readonly model: string; readonly units: readonly string[] }[];
  /** How the plan was made ("planner", "heuristic-fallback", or "heuristic"). */
  readonly source: string;
  readonly model?: string;
}

/** Budgets and limits for a board run. */
export interface BoardRunBudgets {
  /** Turns one agent may spend on one item (default 8). */
  readonly maxTurnsPerItem?: number;
  /**
   * Turns across every agent in the run. Default: scaled with the plan,
   * min(800, max(200, 25 per planned item)); an explicit value wins.
   */
  readonly maxRunTurns?: number;
  /** Lockstep rounds before the run stops (default 200). */
  readonly maxRounds?: number;
  /** Wall-clock limit for the agent phase, in ms (default 30 minutes). */
  readonly timeoutMs?: number;
  /** Fix requests a failing revision may send for one item (the board rule; default 2). */
  readonly maxFixAttemptsPerItem?: number;
  /**
   * Concurrent schedule: how long every agent may sit idle with no new board
   * message and no integration pending before the agent phase ends as
   * quiescent, in ms (default 2 minutes).
   */
  readonly quiescenceMs?: number;
  /**
   * Concurrent schedule: how long an owner whose unpushed item a codemod being
   * built covers is held back (no turns) so the builder moves first, in ms
   * (default 90 s). Bounded: after it, the owner works on, and edits by hand.
   */
  readonly toolHoldMs?: number;
}

/** A progress event of a board run. */
export type BoardRunEvent =
  | { readonly kind: "change-created"; readonly changeId: string }
  | { readonly kind: "goal-posted"; readonly protected: readonly string[]; readonly immutable?: readonly string[]; readonly testInventory: string }
  /** The effective budgets for this run, after scaling with the plan size (explicit flags win). */
  | { readonly kind: "budgets"; readonly items: number; readonly maxFixAttempts: number; readonly fixAttemptsScaled: boolean; readonly dialMax: number; readonly dialScaled: boolean; readonly maxRunTurns: number; readonly runTurnsScaled: boolean }
  | { readonly kind: "contract-decision"; readonly contract: string; readonly decision: string; readonly path?: string }
  | { readonly kind: "contract-awaiting-human"; readonly contract: string; readonly escalationId: string; readonly path?: string; readonly recommendation?: string }
  /** The advisory triage of a protected contract, recorded before the human is asked. */
  | { readonly kind: "contract-triage"; readonly contract: string; readonly recommendation: string }
  | { readonly kind: "seeded"; readonly source: string; readonly model?: string; readonly items: number }
  | { readonly kind: "agent-joined"; readonly agent: string; readonly role: string; readonly workspace?: string; readonly backend?: string }
  | { readonly kind: "turn"; readonly record: AgentTurnRecord }
  | { readonly kind: "agents-done"; readonly reason: BoardStopReason; readonly detail?: string }
  | { readonly kind: "agent-stopped"; readonly agent: string; readonly stop: AgentStop }
  | { readonly kind: "integrated"; readonly revision: BoardRevision }
  | { readonly kind: "integration-not-recorded"; readonly reason: string }
  | { readonly kind: "nothing-to-integrate" }
  /** The operator ran a tool's own gate on a build and recorded it (published only on a pass). */
  | { readonly kind: "tool-gated"; readonly gate: ToolGateRecord }
  /** The board went quiet while a seam item held dependents: recorded stalled (released when its owner had pushed nothing). */
  | { readonly kind: "seam-stalled"; readonly item: string; readonly released: boolean; readonly dependents: readonly string[] }
  /** The operator forked a requester's repo for the helper of a help request. */
  | { readonly kind: "help-forked"; readonly request: string; readonly helper: string; readonly forkOf: string; readonly workspace: string }
  | FullLiveEvent;

/** Why the agent phase ended. */
export type BoardStopReason =
  | "all-items-done"
  | "fix-budget"
  | "run-budget"
  | "quiescent"
  | "max-rounds"
  | "timeout"
  | "all-agents-stopped";

/** An integration recorded as a board revision. */
export interface BoardRevision {
  readonly n: number;
  readonly gate: "pass" | "fail";
  /** False when no gate ran on this revision: its "pass" checked nothing. */
  readonly gated: boolean;
  /** The dependency install that preceded this revision's gate, when a gate ran. */
  readonly install?: DependencyInstallOutcome;
  /** The commit of the exact tree the gate ran on. */
  readonly commit: string;
  /** The announced push commits this revision merged (each contained in the gated tree). */
  readonly merged: readonly string[];
  /** Items whose latest push this revision merged. */
  readonly integratedItems: readonly string[];
  /** Items with a pending push this revision did not merge. */
  readonly excludedItems: readonly string[];
  /** Agents left out, and why (credential-free). */
  readonly excludedAgents: readonly { readonly agent: string; readonly reason: string }[];
  /** Items the board completed from this revision. */
  readonly completedItems: readonly string[];
  /** A failing revision's implicated items and how attribution chose them. */
  readonly implicated?: { readonly items: readonly string[]; readonly source: "parse" | "jev" | "all" };
  /** A failing revision's reason: its first line(s), bounded (the full evidence is on the board). */
  readonly failure?: string;
  /** Set when accepted contract changes relaxed the test inventory for this revision. */
  readonly inventoryNote?: string;
  /** ADVISORY: how many of the gate's checks passed on this revision (never a verdict). */
  readonly progress?: BoardRevProgress;
  /** Items whose fix request the board sent (or whose fix budget it recorded as spent). */
  readonly fixRequested?: readonly string[];
  readonly fixExhausted?: readonly string[];
}

/** A contract decision the board escalated to the human. */
export interface BoardContractDecisionRequest {
  readonly escalationId: string;
  readonly contract: string;
  readonly path?: string;
  /** The escalation's question (with the advisory triage line when there is one). */
  readonly question: string;
  /**
   * The ADVISORY triage: "accept (confidence 0.86)" or "no recommendation
   * (reason)". Absent when no decision model is configured. The human decides.
   */
  readonly recommendation?: string;
}

/** Options for a board run. */
export interface RunBoardOptions {
  readonly goal: string;
  readonly projectDir: string;
  readonly changeId: string;
  /** The Worker base URL (or the local control's stand-in base). */
  readonly workerUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly dial: ConcurrencyDial;
  /**
   * Scale the dial's max with the plan size (min(items, 6), at least the dial's
   * min) instead of using `dial.maxConcurrency` as given: set when the operator
   * did not pass an explicit max.
   */
  readonly scaleDial?: boolean;
  /**
   * The project's declared gate command, used to derive the contract (the
   * immutable acceptance gate) when the run's gate is something else (the
   * offline fixture). Takes precedence over `appGateCommand` for the contract.
   */
  readonly contractGateCommand?: readonly string[];
  readonly transport: AgentTurnTransport<BoardDigest, BoardMessage>;
  /** The lead's first turn: the planner's decomposition. */
  readonly seed: (goal: string) => Promise<BoardSeed>;
  /** The executor each worker's edit runs (default: the scoped deterministic noop). */
  readonly executor?: ExecutorProvider;
  /** The ordered escalation models a fix attempt climbs (attempt k uses entry k - 1). */
  readonly escalationModels?: readonly string[];
  readonly schedule?: "lockstep" | "concurrent";
  readonly budgets?: BoardRunBudgets;
  /**
   * The explicit, short write-token lifetime each worker's join asks for
   * (default 1800 s). Agents' tokens are not refreshed, so the run refuses an
   * agent-phase timeout longer than this; the integrator never uses them (it
   * reads with fresh operator read tokens).
   */
  readonly workspaceTtlSeconds?: number;
  /** The lifetime of the read tokens the integrator asks for per revision (default 600 s). */
  readonly readTokenTtlSeconds?: number;
  readonly rules?: Partial<BoardRules>;
  readonly workRoot?: string;
  readonly identity?: GitIdentity;
  /** The per-app gate run on the integrated tree, as argv. */
  readonly appGateCommand?: readonly string[];
  /** The project declares a gate: without a command the verdict is cannot-pass. */
  readonly requireAppGate?: boolean;
  readonly verifyCommandRunner?: VerificationCommandRunner;
  /**
   * Installs a gated tree's dependencies before the gate runs there (default:
   * from its lockfile, with install scripts off, `installTimeoutMs`, and a
   * package cache under the work root). `NO_DEPENDENCY_INSTALL` opts out (a
   * fixture gate that needs no dependencies).
   */
  readonly dependencyInstaller?: DependencyInstaller;
  /** The limit on one dependency install, in ms (default 5 minutes). */
  readonly installTimeoutMs?: number;
  /**
   * A label for the gate when it is not the project's own (the offline
   * fixture gate replacing a declared gate), shown in the summary.
   */
  readonly gateLabel?: string;
  /**
   * The HUMAN's answer to a contract change on the original tests or the
   * gate's configuration (an escalation the board raised). Without it the
   * decision waits durably for the console or the escalation resolve route.
   */
  readonly resolveContract?: (request: BoardContractDecisionRequest) => Promise<"accept" | "reject">;
  /**
   * Optional typed-decision caller (advisory): failure attribution (a confident
   * choice narrows), and the triage of a protected contract shown to the human
   * before the human decides it.
   */
  readonly jev?: AskJev;
  readonly jevThreshold?: number;
  readonly deployAppDir?: string;
  readonly deployAppName?: string;
  readonly deployApp?: DeployApp;
  readonly appAlreadyDeployed?: (input: { readonly appName: string }) => Promise<string | undefined>;
  /** Leave the agents' repos in place at the end. */
  readonly skipCleanup?: boolean;
  /** Concurrent schedule: how often the driver checks the board (default 500 ms). */
  readonly pollMs?: number;
  /**
   * Who integrates: "local" (default) runs the integrator in this process;
   * "cloud" leaves it to the Worker's integration Workflow (the gate runs in a
   * Cloudflare Container): this process provisions the integration repo as an
   * Artifact repo, configures the Workflow, follows the revisions it records,
   * and promotes as usual. Needs a Worker with the Artifacts binding and the
   * gate container.
   */
  readonly integrator?: "local" | "cloud";
  /** Cloud integrator: the gate's limit inside the container, in ms (default 10 minutes). */
  readonly cloudGateTimeoutMs?: number;
  /** Cloud integrator: how long to wait for the Workflow to settle at the end, in ms (default 30 minutes). */
  readonly cloudSettleTimeoutMs?: number;
  /**
   * Who writes an agent-built tool's files (default: the run's executor). The
   * offline run uses the deterministic template author; every tool still has
   * to pass its own gate before it is published.
   */
  readonly toolAuthor?: ToolAuthor;
  /** A label for the tool author in the summary (for example the offline template). */
  readonly toolAuthorLabel?: string;
  /** Isolation limits for agent-built tools (their tests and runs). */
  readonly toolTimeoutMs?: number;
  /** The project's own syntax or type check, run on a codemod's output in the codemod's gate (when declared). */
  readonly toolSyntaxCommand?: readonly string[];
  readonly onEvent?: (event: BoardRunEvent) => void;
}

/** The outcome of a board run. */
export interface RunBoardResult {
  readonly changeId: string;
  readonly stopReason: BoardStopReason;
  /** Why the agent phase ended, in words (quiescence states how long the board was quiet). */
  readonly stopDetail?: string;
  /** The whole board log and its reduced state, read back from the board. */
  readonly log: readonly BoardMessage[];
  readonly state: BoardState;
  readonly turns: readonly AgentTurnRecord[];
  readonly agents: readonly { readonly id: string; readonly role: string; readonly workspace?: string; readonly stop?: AgentStop }[];
  readonly seed: BoardSeed;
  /** The protected set posted with the goal. */
  readonly protected: readonly string[];
  /** The immutable acceptance gate within it (never contract-changeable). */
  readonly immutable?: readonly string[];
  /** The gate-defining keys posted with the goal (restored by the integrator). */
  readonly protectedKeys: readonly string[];
  /** Every integrated revision recorded on the board, in order. */
  readonly revisions: readonly BoardRevision[];
  /** The LAST revision: its gate is the run's verdict. */
  readonly revision?: BoardRevision;
  /** Integrations that recorded no revision, and why (credential-free). */
  readonly integrationFailures: readonly string[];
  /**
   * The last revision's gate: "verified" when a gate ran and passed,
   * "unverified" when the last revision passed but NO gate ran (no gate
   * configured: nothing was checked; the tree is still promoted, labeled
   * unverified), else "failed".
   */
  readonly verdict: "verified" | "unverified" | "failed";
  /** Set when the last revision passed but pushes were left ungated: why the verdict is failed. */
  readonly partial?: string;
  /**
   * Items not completed when the run ended (no done proposal, no push, or a
   * push no passing revision merged). A verified verdict with any of these is a
   * PARTIAL result: the gate passed, but the Change is not complete.
   */
  readonly incompleteItems: readonly string[];
  /**
   * Why each incomplete item did not complete, stated from board state (for
   * example "item X: its push passed in rev N but its owner did not propose
   * done"). The engine never completes an item on an owner's behalf.
   */
  readonly incompleteReasons?: readonly string[];
  /** Workers' proposals the lead rejected (with its rationale) or never decided: not counted. */
  readonly proposals?: ReturnType<typeof proposalOutcomes>;
  /** The test inventory the baseline gate run recorded, as a readable line (with its dependency install). */
  readonly testInventory: string;
  /** Set when the gate is not the project's own (the offline fixture gate): what ran instead. */
  readonly gateLabel?: string;
  /** The last revision's evidence. */
  readonly evidence?: EvidenceSummary;
  readonly promotion?: PromotionResult;
  readonly sourceRepoDir?: string;
  readonly deployment?: { readonly url: string; readonly app: string };
  readonly workRoot: string;
  /** The run's whole scratch directory when it is wider than `workRoot` (the offline run's control repos too). */
  readonly scratchRoot?: string;
  readonly cleanedUp: readonly string[];
  /** The effective budgets (scaled with the plan unless explicit). */
  readonly budgets?: { readonly items: number; readonly maxFixAttempts: number; readonly fixAttemptsScaled: boolean; readonly dialMax: number; readonly dialScaled: boolean; readonly maxRunTurns: number; readonly runTurnsScaled: boolean };
  /** The model each pushed app edit used (the strongest for complex items). */
  readonly editModels?: readonly { readonly agent: string; readonly item: string; readonly commit: string; readonly model: string; readonly why?: string }[];
  /** Every tool gate the run's bench ran and recorded, in order. */
  readonly toolGates?: readonly ToolGateRecord[];
  /** The tool author's label (when the run set one). */
  readonly toolAuthorLabel?: string;
}

/** The repo of one agent the integrator reads (no credential: it reads with fresh operator tokens). */
export interface BoardAgentRepo {
  readonly gitUrl: string;
  readonly defaultBranch: string;
}

/** Inputs to one integration of the board's announced pushes. */
export interface IntegrateBoardOptions {
  readonly operator: BoardOperatorClient;
  readonly change: Pick<Change, "id" | "objective">;
  readonly agentRepos: ReadonlyMap<string, BoardAgentRepo>;
  /**
   * The clone remote for an agent's repo, with a FRESH operator read credential
   * (the Worker issues it at integration time). Never an agent's write token.
   */
  readonly readRemote: (agent: string) => Promise<string>;
  readonly integration: Awaited<ReturnType<typeof createIntegrationWorkspace>>;
  readonly worktreeRoot: string;
  readonly identity: GitIdentity;
  readonly appGateCommand?: readonly string[];
  readonly requireAppGate?: boolean;
  readonly verifyCommandRunner?: VerificationCommandRunner;
  /**
   * The gate's contract (see protected-paths.ts): restored from the baseline
   * before the gate runs, except paths an accepted contract released (read from
   * board state); a change to an unreleased protected path fails the revision.
   */
  readonly contract?: Pick<ProtectedPaths, "restore" | "jsonKeys">;
  /**
   * Agents whose pushes this attempt leaves out (they kept being superseded
   * while the gate ran): integration runs without their units, so the
   * recorded tree never contains content `merged` does not list. Their newer
   * pushes stay pending for a later revision.
   */
  readonly holdBack?: readonly string[];
  /** The baseline gate run's test inventory (see IntegrateOptions.testInventory). */
  readonly testInventory?: TestInventory;
  readonly jev?: AskJev;
  readonly jevThreshold?: number;
  /** Strip credentials from any text that leaves the integrator (default: redactSecrets). */
  readonly scrub?: (text: string) => string;
  /** Record an advisory typed decision's outcome (attribution) on the board. */
  readonly recordDecision?: RecordBoardDecision;
}

/** The result of one integration attempt. */
export interface IntegrateBoardResult {
  /** The revision recorded on the board (absent when nothing was recorded). */
  readonly revision?: BoardRevision;
  readonly evidence?: EvidenceSummary;
  readonly requiresIntegrationGate: boolean;
  /**
   * Why no revision was recorded: nothing the gate actually ran on could be
   * recorded honestly (every pending push was excluded, the integrator refused,
   * or the pushes changed while the gate ran: `stale`).
   */
  readonly failure?: string;
  /** The pushes it integrated were superseded while the gate ran: run again. */
  readonly stale?: boolean;
  /** The pending-push set this attempt read (see pendingPushKey). */
  readonly key?: string;
  /** The failure may pass on retry (an unreachable repo or board), not a deterministic refusal. */
  readonly transient?: boolean;
  /** With `stale`: the agents whose pushes were superseded while the gate ran. */
  readonly supersededAgents?: readonly string[];
}

/** A stable key for the set of pending pushes (what one integration would merge). */
export { pendingPushKey };

export { gateFailureLine };

/**
 * A failing revision's reason for summaries: when the gate exited non-zero,
 * its own failing line leads (the integrator's summary follows); otherwise the
 * integrator's summary (for example an inventory shortfall) is the reason.
 */
function revisionFailure(check: { readonly summary: string; readonly outputs: readonly { readonly text: string }[] }): string {
  const key = /exited 0 but/.test(check.summary) ? undefined : gateFailureLine(check.outputs.map((o) => o.text).join("\n"));
  return firstLines(key !== undefined ? `${key}\n${check.summary}` : check.summary, 300);
}

/**
 * The first full line(s) of a reason, at most `max` characters, cut at a word
 * boundary when it must be cut (never mid-word).
 */
export function firstLines(text: string, max: number): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  let out = "";
  for (const line of lines) {
    const next = out === "" ? line : `${out} ${line}`;
    if (next.length > max) {
      if (out === "") {
        const cut = line.slice(0, max - 3);
        const space = cut.lastIndexOf(" ");
        return `${space > max / 2 ? cut.slice(0, space) : cut}...`;
      }
      break;
    }
    out = next;
  }
  return out;
}

/** The first `max` characters of text (a bounded excerpt, cut on a line when possible). */
function head(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - 40);
  const line = cut.lastIndexOf("\n");
  return `${line > max / 2 ? cut.slice(0, line) : cut}\n... (output truncated)`;
}

/**
 * Decide which items a failing revision implicates: the existing run-live
 * attribution (parse the failing output for the files and names it reports and
 * map them to the items' write intents), then a CONFIDENT typed-decision choice
 * when one is configured (advisory narrowing, never a verdict), else every item
 * the revision merged.
 */
export async function attributeRevisionFailure(input: {
  readonly items: readonly { readonly id: string; readonly objective: string; readonly paths: readonly string[] }[];
  readonly output: string;
  readonly changeId: string;
  readonly jev?: AskJev;
  readonly jevThreshold?: number;
  /** Record the typed decision's outcome (accepted, low-confidence, or an error): never silent. */
  readonly onDecision?: (decision: BoardDecisionRecord) => Promise<unknown>;
}): Promise<{ readonly items: readonly string[]; readonly source: "parse" | "jev" | "all"; readonly pick?: string }> {
  const units: GatedUnitInput[] = input.items.map((i) => ({
    unitId: i.id,
    objective: i.objective,
    paths: i.paths,
    authRemote: "",
    gateCommand: [],
    requiredExports: [],
  }));
  const parsed = attributeImplicatedUnits(units, input.output);
  const parsedItems = parsed.attributed ? inOrder(parsed.units.map((u) => u.unitId), input.items) : [];
  let pick: string | undefined;
  if (input.jev && units.length > 1) {
    const ids = units.map((u) => u.unitId);
    const question = "Which item does this failure implicate?";
    try {
      const answers = await input.jev(
        [`Change: ${input.changeId}`, `Items in the failing revision: ${ids.join(", ")}`, "Failing gate evidence:", input.output.slice(0, 2000)].join("\n"),
        {
          attribution: {
            type: "choice",
            instructions: question,
            criteria: ids,
            descriptions: Object.fromEntries(input.items.map((i) => [i.id, i.objective.slice(0, 200)])),
          },
        },
      );
      const answer = answers["attribution"];
      const confident =
        answer !== undefined &&
        answer.type === "choice" &&
        typeof answer.choice === "string" &&
        ids.includes(answer.choice) &&
        answer.confidence >= (input.jevThreshold ?? 0.75);
      await input.onDecision?.({
        juncture: "attribution",
        question,
        ...(answer?.choice !== undefined ? { answer: answer.choice } : {}),
        ...(answer !== undefined ? { confidence: answer.confidence } : {}),
        accepted: confident,
        ...(answer === undefined ? { error: "the decision reply carried no attribution answer" } : {}),
        // What the parse said on its own, so its outcome can be scored too.
        parsed: parsedItems,
      });
      if (confident) {
        pick = answer!.choice!;
      }
    } catch (error) {
      // Advisory only: a decision-transport error leaves the parse result, and
      // is RECORDED (never silent).
      await input.onDecision?.({ juncture: "attribution", question, accepted: false, error: jevErrorReason(error) });
    }
  }
  // The same combination (and label) as the integration Workflow on Cloudflare:
  // an unattributed parse narrows to the pick alone.
  const combined = combineAttribution({
    merged: input.items.map((i) => i.id),
    parsed: parsedItems,
    attributed: parsed.attributed,
    picks: pick !== undefined ? [pick] : [],
  });
  return { items: combined.items, source: combined.source, ...(pick !== undefined ? { pick } : {}) };
}

/** One path's tree entry (mode and blob) in a commit, for the paths a glob set covers. */
async function treeEntries(dir: string, rev: string, globs: readonly string[]): Promise<Map<string, string>> {
  const { stdout } = await runGit(["-C", dir, "ls-tree", "-r", "--full-tree", rev]);
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    const [mode, , blob] = line.slice(0, tab).split(" ");
    if (globs.some((g) => matchesGlob(path, g))) {
      out.set(path, `${mode} ${blob}`);
    }
  }
  return out;
}

/**
 * For every sub-lead push a revision merges: each child its `merges` names
 * (still that child's latest, unintegrated push) is verified, never taken on
 * the sub-lead's word: the child's tree at its pushed commit, restricted to
 * the child's write intent, must equal the sub-lead's pinned commit's tree for
 * those paths (a file the child deleted must be gone, a released contract path
 * must carry the child's version). A child that does not match, or cannot be
 * read, is returned with the reason, so the board does not integrate it.
 */
export async function verifySubLeadMerges(input: {
  readonly units: readonly { readonly agent: string; readonly commit: string; readonly items: readonly BoardItem[] }[];
  readonly state: BoardState;
  readonly readRemote: (agent: string) => Promise<string>;
  readonly workRoot: string;
  readonly scrub?: (text: string) => string;
}): Promise<{ item: string; reason: string }[]> {
  const scrub = input.scrub ?? redactSecrets;
  const out: { item: string; reason: string }[] = [];
  for (const unit of input.units) {
    for (const item of unit.items) {
      if (item.status !== "split") continue;
      for (const merge of item.lastPush?.merges ?? []) {
        const child = input.state.items[merge.item];
        if (!child?.lastPush || child.lastPush.commit !== merge.commit || child.lastPush.integratedIn !== undefined) continue;
        const globs = [...new Set((child.intent?.write ?? child.scopeHint).map(intentPath))];
        await mkdir(input.workRoot, { recursive: true });
        const dir = await mkdtemp(join(input.workRoot, "verify-merge-"));
        try {
          await runGit(["init", "-q", dir]);
          await runGit(["-C", dir, "fetch", "-q", await input.readRemote(child.lastPush.agent), merge.commit]);
          const theirs = await treeEntries(dir, merge.commit, globs);
          await runGit(["-C", dir, "fetch", "-q", await input.readRemote(unit.agent), unit.commit]);
          const ours = await treeEntries(dir, unit.commit, globs);
          const differ = [...new Set([...theirs.keys(), ...ours.keys()])].filter((p) => theirs.get(p) !== ours.get(p)).sort();
          if (differ.length > 0) {
            out.push({
              item: merge.item,
              reason: `the sub-lead's commit does not carry ${merge.item}'s push ${merge.commit.slice(0, 10)} for ${differ.slice(0, 5).join(", ")}${differ.length > 5 ? ", ..." : ""}`.slice(0, 300),
            });
          }
        } catch (error) {
          out.push({ item: merge.item, reason: scrub(`could not verify ${merge.item}'s push: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300) });
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  }
  return out;
}

/** Keep `chosen` in the items' order. */
function inOrder(chosen: readonly string[], items: readonly { readonly id: string }[]): string[] {
  return items.map((i) => i.id).filter((id) => chosen.includes(id));
}

/**
 * Integrate every announced, not yet integrated push on the board as ONE
 * integrated revision: a function of board state, so a per-push driver (or a
 * future queue-triggered workflow) can call it.
 *
 * The input is synthesized from the board, never from the agents' say-so: one
 * unit per agent with pending pushes on items it still holds,
 *   - PINNED to the agent's latest pending announced commit (the clone checks
 *     out exactly that commit), with every other merged commit of the agent
 *     required to be in that commit's history;
 *   - diffed against the agent's last commit a passing revision already merged
 *     (so earlier, already integrated work is not re-applied);
 *   - scoped to the WRITE INTENTS of the items it integrates (announced paths
 *     never widen scope), with the files of items it handed off yielded (never
 *     applied from it, never failing it);
 *   - read with a fresh operator read token.
 * The existing verifier and integrator compose the verified units onto the
 * latest passing revision, restore the gate's own files from the baseline, and
 * run the gate; the revision (the gated commit, the gate, the merged commits,
 * and for a fail the bounded, credential-free output and implicated items) is
 * recorded through the integration revision route. When nothing the gate ran on
 * can be recorded honestly, no revision is recorded and the reason is returned.
 */
export async function integrateBoardRevision(options: IntegrateBoardOptions): Promise<IntegrateBoardResult> {
  const scrub = options.scrub ?? redactSecrets;
  const requiresIntegrationGate = Boolean(options.appGateCommand && options.appGateCommand.length > 0) || options.requireAppGate === true;
  const board = await options.operator.log();
  const state = board.state;
  // What the next revision merges, synthesized from the board (shared with the
  // integration Workflow on Cloudflare).
  const plan = planBoardIntegration(board.messages, state);
  const key = plan.key;
  const pending = [...plan.pending];
  if (pending.length === 0) {
    return { requiresIntegrationGate, key, failure: "nothing is pending" };
  }

  const excludedAgents: { agent: string; reason: string }[] = [];
  const units: { id: string; objective: string; dependsOn: string[]; paths: string[] }[] = [];
  const completed: CompletedWorkUnit[] = [];
  const itemsByAgent = new Map<string, BoardItem[]>();
  for (const unit of plan.units) {
    const agent = unit.agent;
    const mine = [...unit.items];
    itemsByAgent.set(agent, mine);
    const repo = options.agentRepos.get(agent);
    if (!repo) {
      excludedAgents.push({ agent, reason: "no repo is known for this agent" });
      continue;
    }
    if (options.holdBack?.includes(agent)) {
      excludedAgents.push({ agent, reason: "held back: its pushes kept being superseded while the gate ran; they stay pending" });
      continue;
    }
    let remote: string;
    try {
      remote = await options.readRemote(agent);
    } catch (error) {
      excludedAgents.push({ agent, reason: scrub(`could not read its repo: ${error instanceof Error ? error.message : String(error)}`) });
      continue;
    }
    units.push({ id: agent, objective: `the announced pushes of ${agent} (items ${mine.map((i) => i.id).join(", ")})`, dependsOn: [], paths: [...unit.scope] });
    completed.push({
      unitId: agent,
      gitUrl: remote,
      baselineRef: unit.baselineRef,
      commit: unit.commit,
      includes: [...unit.includes],
      ...(unit.yieldedScope ? { yieldedScope: [...unit.yieldedScope] } : {}),
      // Contract paths a HUMAN released for these items, for this unit only.
      ...(unit.releasedPaths ? { releasedPaths: [...unit.releasedPaths] } : {}),
    });
  }
  if (completed.length === 0) {
    return {
      requiresIntegrationGate,
      key,
      transient: true,
      failure: `no pending push could be read: ${excludedAgents.map((e) => `${e.agent}: ${e.reason}`).join("; ")}`,
    };
  }

  const change: Change = { id: options.change.id, objective: options.change.objective, baseline: "HEAD", budgetUsd: 0, assurance: "standard", work: units };
  // The baseline test inventory, adjusted for contract changes a human accepted
  // (a changed or removed test may rename or drop tests), read from board state.
  const acceptedTargets = [...new Set(Object.values(state.contracts).filter((c) => c.status === "accepted" && c.guarded).map((c) => c.target))].sort();
  const adjusted = options.testInventory ? inventoryAfterContracts(options.testInventory, acceptedTargets) : {};
  const inventoryNow = adjusted.inventory;
  const verification = new ChangeVerification(
    options.integration.workspaces,
    options.verifyCommandRunner ? { commandRunner: options.verifyCommandRunner } : {},
  );
  // The install outcome of the last command this integration runs (the gate on the integrated tree).
  const installing = options.verifyCommandRunner instanceof InstallingCommandRunner ? options.verifyCommandRunner : undefined;
  installing?.takeLastInstall();
  let evidence: EvidenceSummary;
  try {
    evidence = await verification.verifyAndIntegrate({
      change,
      completed,
      integrationRef: options.integration.integrationRef,
      integrationToken: options.integration.integrationToken,
      ...(requiresIntegrationGate
        ? {
            ...(options.appGateCommand && options.appGateCommand.length > 0 ? { integrationGateCommand: options.appGateCommand } : {}),
            requiresIntegrationGate,
          }
        : {}),
      ...(options.contract
        ? {
            protectedPaths: options.contract.restore,
            protectedJsonKeys: options.contract.jsonKeys,
            onProtectedChange: "fail" as const,
          }
        : {}),
      ...(inventoryNow ? { testInventory: inventoryNow } : {}),
      // Build on the last RECORDED passing revision, and advance the branch
      // only after the board recorded this one (below).
      ...(state.integrated ? { integrationBaseCommit: state.integrated.commit } : {}),
      deferIntegrationPush: true,
      workRoot: options.worktreeRoot,
      identity: options.identity,
    });
  } catch (error) {
    // The integrator refused (for example a fix was expected but nothing
    // changed). No gate ran on any recordable tree, so no revision is posted.
    return { requiresIntegrationGate, key, failure: scrub(`the integrator refused: ${error instanceof Error ? error.message : String(error)}`) };
  }
  for (const u of evidence.units) {
    if (u.verdict !== "verified") {
      const failed = u.checks.filter((c) => !c.passed && !c.skipped).map((c) => `${c.kind}: ${c.summary}`);
      excludedAgents.push({ agent: u.unitId, reason: scrub(`failed verification (${failed.join("; ") || "verdict failed"})`) });
    }
  }
  const mergedAgents = evidence.units.filter((u) => u.verdict === "verified").map((u) => u.unitId);
  const commit = evidence.integration.commit;
  if (mergedAgents.length === 0 || commit === undefined) {
    return {
      requiresIntegrationGate,
      key,
      evidence,
      failure:
        mergedAgents.length === 0
          ? `every pending push was excluded: ${excludedAgents.map((e) => `${e.agent}: ${e.reason}`).join("; ")}`
          : "the integrator reported no commit for the gated tree",
    };
  }
  const mergedItems = mergedAgents.flatMap((a) => itemsByAgent.get(a) ?? []);

  // The pushes must still be the items' latest: a push that landed while the
  // gate ran supersedes what was gated, so nothing is recorded and the caller
  // runs again (the new revision includes the newer push, or, after a bounded
  // number of such runs, leaves the superseded agents' units out entirely).
  const now = new Set(pendingPushItems((await options.operator.page(0, 1)).state).map((i) => i.lastPush!.commit));
  const superseded = mergedItems.filter((i) => !now.has(i.lastPush!.commit));
  if (superseded.length > 0) {
    return {
      requiresIntegrationGate,
      key,
      evidence,
      stale: true,
      supersededAgents: [...new Set(superseded.map((i) => i.lastPush!.agent))].sort(),
      failure: "a merged push was superseded while the gate ran",
    };
  }
  const merged = mergedItems.map((i) => i.lastPush!.commit);

  const gate: "pass" | "fail" = evidence.integration.verdict === "verified" ? "pass" : "fail";
  const install = evidence.integration.finalCheck.skipped ? undefined : installing?.takeLastInstall();
  const attributionDecisions: BoardDecisionRecord[] = [];
  // Record the buffered attribution decisions: linked to revision `n` when it
  // was recorded (the board then resolves each at the next passing revision),
  // otherwise, or if the board REFUSES the link, recorded unlinked so the call
  // stays visible. A transport failure is not a refusal (the linked copy may
  // have been appended): the linked recording is retried, bounded, and an
  // unlinked second copy is never posted, so no decision is counted twice.
  const flushDecisions = async (n: number | undefined): Promise<void> => {
    const record = options.recordDecision;
    if (!record) {
      attributionDecisions.length = 0;
      return;
    }
    // Was a linked attribution of revision `rev` already appended (a lost response)?
    const alreadyLinked = async (rev: number): Promise<boolean | undefined> => {
      try {
        const page = await options.operator.log();
        return page.messages.some((m) => m.type === "decision.recorded" && m.payload.juncture === "attribution" && m.payload.rev === rev);
      } catch {
        return undefined;
      }
    };
    for (const decision of attributionDecisions.splice(0)) {
      const { parsed, ...unlinked } = decision;
      if (n === undefined || decision.error !== undefined) {
        // One attempt only: an unlinked copy cannot be matched on the board, so it is never retried.
        await record(unlinked);
        continue;
      }
      let outcome: BoardDecisionRecordOutcome | void = await record({ ...unlinked, rev: n, parsed: parsed ?? [] });
      for (let attempt = 1; attempt < 3 && outcome === "failed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        const found = await alreadyLinked(n);
        if (found !== false) {
          // Appended already, or the board is unreadable: never risk a second copy.
          outcome = found === true ? "recorded" : "failed";
          break;
        }
        outcome = await record({ ...unlinked, rev: n, parsed: parsed ?? [] });
      }
      if (outcome === "refused") {
        // A definite refusal appended nothing: record it unlinked so it stays visible.
        await record(unlinked);
      }
    }
  };
  let failing: { output: string; items: string[] } | undefined;
  let implicated: BoardRevision["implicated"];
  if (gate === "fail") {
    const check = evidence.integration.finalCheck;
    // Lead with the gate's own failing line (a SyntaxError, a failing test),
    // then its output, then the integrator's summary.
    const key = gateFailureLine(check.outputs.map((o) => o.text).join("\n"));
    const raw = scrub([...(key !== undefined ? [key] : []), ...check.outputs.map((o) => o.text), check.summary].join("\n"));
    // A failure that names only files of already COMPLETED items is a
    // regression this revision's pushes caused (the tree passed before them),
    // so their owners are asked to fix it; the evidence says which completed
    // items regressed.
    const regressed = Object.values(state.items).filter(
      (i) => i.status === "done" && i.lastPush !== undefined && i.lastPush.paths.some((p) => raw.includes(p)),
    );
    const attribution = await attributeRevisionFailure({
      items: mergedItems.map((i) => ({ id: i.id, objective: i.objective, paths: (i.intent?.write ?? []).map(intentPath) })),
      output: raw,
      changeId: options.change.id,
      ...(options.jev ? { jev: options.jev } : {}),
      ...(options.jevThreshold !== undefined ? { jevThreshold: options.jevThreshold } : {}),
      // Buffered: an attribution is recorded once its revision is (linked to it).
      ...(options.recordDecision ? { onDecision: async (decision: BoardDecisionRecord) => void attributionDecisions.push(decision) } : {}),
    });
    // A split item's failure is its children's work: ask their owners.
    const narrowed = narrowToSplitChildren(state, attribution.items, raw);
    implicated = { ...attribution, items: narrowed };
    const note =
      regressed.length > 0
        ? `regressed completed item(s): ${regressed.map((i) => i.id).join(", ")} (their files fail after this revision's pushes)\n`
        : "";
    failing = { output: head(`${note}${raw}`, BOARD_LIMITS.maxFailingOutput), items: [...narrowed] };
  }
  // No final check ran (no gate configured): the revision passed without being checked.
  const gated = !(gate === "pass" && evidence.integration.finalCheck.skipped);
  // Before a sub-lead's push marks its children integrated: each merged
  // child's pushed in-intent tree must be exactly the sub-lead commit's tree
  // for those paths (deletions and released contract paths included).
  const unverified = await verifySubLeadMerges({
    units: plan.units.filter((u) => mergedAgents.includes(u.agent)),
    state,
    readRemote: options.readRemote,
    workRoot: options.worktreeRoot,
    scrub,
  });
  // ADVISORY progress: how many of the gate's checks passed (never a verdict).
  // Read from the gate's full output (the check's own progress), else the bounded
  // captured output; each suite is labeled against the immutable acceptance gate.
  const finalCheck = evidence.integration.finalCheck;
  const progress = gated
    ? labelGateProgress(finalCheck.progress ?? readTestProgress(finalCheck.outputs.map((o) => o.text).join("\n")), state.immutable ?? [])
    : undefined;
  const recorded = await options.operator.recordRevision({
    commit,
    gate,
    merged,
    ...(progress ? { progress } : {}),
    ...(failing ? { failing } : {}),
    ...(gated ? {} : { gated: false as const }),
    ...(unverified.length > 0 ? { unverified } : {}),
  });
  if (!recorded.ok) {
    await flushDecisions(undefined);
    if (recorded.code === "UNKNOWN_REF") {
      return { requiresIntegrationGate, key, evidence, stale: true, failure: scrub(`the board refused the revision: ${recorded.error}`) };
    }
    return { requiresIntegrationGate, key, evidence, failure: scrub(`the board refused the revision (${recorded.code}): ${recorded.error}`) };
  }
  if (gate === "pass") {
    // Only now, with the revision recorded, does the integration branch move.
    try {
      await advanceIntegrationBranch(options.integration.integrationRef, options.integration.integrationToken, commit, options.worktreeRoot);
    } catch (error) {
      excludedAgents.push({
        agent: "(integration)",
        reason: scrub(`recorded, but the integration branch could not be advanced: ${error instanceof Error ? error.message : String(error)}`),
      });
    }
  }
  const rev = recorded.appended.find((m) => m.type === "integrated.rev");
  const n = rev && rev.type === "integrated.rev" ? rev.payload.n : state.lastRevN + 1;
  await flushDecisions(rev ? n : undefined);
  const revision: BoardRevision = {
    n,
    gate,
    gated,
    ...(install ? { install } : {}),
    commit,
    merged,
    // A sub-lead's push integrates the children's pushes it merged.
    integratedItems: mergedItems.flatMap((i) => [
      i.id,
      ...(i.status === "split" ? (i.lastPush?.merges ?? []).filter((m) => state.items[m.item]?.lastPush?.commit === m.commit).map((m) => m.item) : []),
    ]),
    excludedItems: pending.filter((i) => !mergedItems.includes(i)).map((i) => i.id),
    excludedAgents,
    completedItems: recorded.appended.flatMap((m) => (m.type === "item.completed" ? [m.payload.item] : [])),
    ...(progress ? { progress } : {}),
    ...(implicated ? { implicated } : {}),
    ...(gate === "fail" ? { failure: scrub(revisionFailure(evidence.integration.finalCheck)) } : {}),
    ...(adjusted.relaxed !== undefined ? { inventoryNote: adjusted.relaxed } : {}),
    ...(gate === "fail"
      ? {
          fixRequested: recorded.appended.flatMap((m) => (m.type === "fix.requested" ? [m.payload.item] : [])),
          fixExhausted: recorded.appended.flatMap((m) => (m.type === "fix.exhausted" ? [m.payload.item] : [])),
        }
      : {}),
  };
  return { revision, evidence, requiresIntegrationGate, key };
}

/**
 * The continuous integrator: integrates pending pushes one revision at a time,
 * coalescing pushes that land while a revision runs into the next one.
 * `kick()` is what an observer of `push.announced` calls (the driver today; a
 * queue-triggered workflow later).
 */
export class ContinuousBoardIntegrator {
  readonly revisions: BoardRevision[] = [];
  readonly failures: string[] = [];
  /** The evidence of the last recorded revision (its gate is the run's verdict). */
  lastEvidence: EvidenceSummary | undefined;
  lastRequiresGate = false;
  private running: Promise<void> | undefined;
  private requested = false;
  /** Pending-push sets already integrated, or deterministically refused (not retried until something changes). */
  private readonly attempted = new Set<string>();
  /** Transient-failure retries per pending-push set. */
  private readonly retries = new Map<string, number>();
  /** Consecutive superseded-while-gating results. */
  private staleRuns = 0;
  /** Agents left out of the next attempts because their pushes kept being superseded. */
  private holdBack = new Set<string>();

  constructor(
    private readonly options: IntegrateBoardOptions & {
      readonly onRevision?: (revision: BoardRevision) => void;
      readonly onFailure?: (reason: string) => void;
      /** Called after every attempt (for example to revoke the read tokens it used). */
      readonly onSettled?: () => Promise<void>;
      /** Retries of a transient failure per pending-push set (default 3). */
      readonly maxRetries?: number;
      /** Backoff before the first retry, doubled each time (default 250 ms). */
      readonly retryBackoffMs?: number;
      /** Superseded re-runs before the superseded agents are held back (default 3). */
      readonly maxStaleRuns?: number;
    },
  ) {}

  /** True while a revision is being built. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Is there a pending-push set this integrator has not tried yet? */
  wants(state: BoardState): boolean {
    const key = pendingPushKey(state);
    return key !== "" && !this.attempted.has(key);
  }

  /** Start a revision now, or (when one is running) coalesce into the next. */
  kick(): void {
    // Set the request first: a running loop always re-checks it after its
    // current attempt, so a kick can never be lost between the loop's last
    // check and its exit (both happen with no await in between).
    this.requested = true;
    this.running ??= this.loop();
  }

  /** Wait until no revision is running and none is requested. */
  async idle(): Promise<void> {
    while (this.running) {
      await this.running;
    }
  }

  private async loop(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        await this.once();
      }
    } finally {
      this.running = undefined;
    }
  }

  private async once(): Promise<void> {
    const state = (await this.options.operator.page(0, 1)).state;
    const key = pendingPushKey(state);
    if (key === "" || this.attempted.has(key)) {
      return;
    }
    let result: IntegrateBoardResult;
    try {
      result = await integrateBoardRevision({ ...this.options, ...(this.holdBack.size > 0 ? { holdBack: [...this.holdBack] } : {}) });
    } catch (error) {
      // A thrown attempt (the board or a repo unreachable) is transient.
      result = {
        requiresIntegrationGate: false,
        key,
        transient: true,
        failure: (this.options.scrub ?? redactSecrets)(`integration failed: ${error instanceof Error ? error.message : String(error)}`),
      };
    } finally {
      await this.options.onSettled?.().catch(() => undefined);
    }
    // Mark the set the attempt actually read (it may have moved since `key`).
    const tried = result.key ?? key;
    this.staleRuns = result.stale ? this.staleRuns + 1 : 0;
    if (result.stale && this.staleRuns >= (this.options.maxStaleRuns ?? 3)) {
      // Bounded re-gating: leave the agents whose pushes keep moving out of the
      // next attempt (never record a tree with content `merged` omits).
      for (const agent of result.supersededAgents ?? []) {
        this.holdBack.add(agent);
      }
    }
    if (result.revision) {
      this.holdBack.clear();
    }
    if (result.transient && !result.revision) {
      const used = this.retries.get(tried) ?? 0;
      if (used < (this.options.maxRetries ?? 3)) {
        this.retries.set(tried, used + 1);
        await new Promise((resolve) => setTimeout(resolve, (this.options.retryBackoffMs ?? 250) * 2 ** used));
        this.requested = true;
        return;
      }
    }
    if (result.revision) {
      // One revision per pending-push set: the same set is never gated twice
      // (the next revision needs a new push).
      this.attempted.add(tried);
      this.revisions.push(result.revision);
      this.lastEvidence = result.evidence;
      this.lastRequiresGate = result.requiresIntegrationGate;
      this.options.onRevision?.(result.revision);
      return;
    }
    if (result.stale) {
      // The pushes moved while the gate ran: integrate the newer set next.
      this.requested = true;
      return;
    }
    this.attempted.add(tried);
    if (result.failure !== undefined && result.failure !== "nothing is pending") {
      this.failures.push(result.failure);
      this.options.onFailure?.(result.failure);
    }
  }
}

/**
 * Items still owed work: ACCEPTED items (a worker's proposal counts only once
 * the lead accepted it) that are neither split (its children carry it) nor done.
 */
function outstanding(state: BoardState): BoardItem[] {
  // A split item counts too: it completes only when its children are done and
  // its sub-lead's push passed.
  return Object.values(state.items).filter((i) => isChangeItem(i) && i.status !== "done");
}

/**
 * Why each outstanding item is not completed, stated from board state alone.
 * The engine never completes an item on an owner's behalf: an item whose push
 * passed but whose owner never proposed done stays incomplete, and this says so.
 */
export function incompleteItemReasons(state: BoardState): string[] {
  return outstanding(state).map((i) => {
    const push = i.lastPush;
    if (i.status === "split") {
      const open = i.children.filter((c) => state.items[c]?.status !== "done");
      return open.length > 0
        ? `item ${i.id}: split; child item(s) ${open.join(", ")} not completed (sub-lead ${i.subLead ?? i.owner ?? "?"})`
        : `item ${i.id}: split; its sub-lead ${i.subLead ?? "?"}'s push for it has not passed`;
    }
    if (i.status === "claimed" && i.owner !== undefined) {
      if (push !== undefined && push.integratedIn === undefined && routedToSubLead(state, i)) {
        const parent = state.items[i.parent!]!;
        const merged = (parent.lastPush?.merges ?? []).some((m) => m.item === i.id && m.commit === push.commit);
        return merged
          ? `item ${i.id}: its push is in its sub-lead ${parent.subLead}'s push for ${parent.id}, which has not passed (owner ${i.owner})`
          : `item ${i.id}: its push awaits its sub-lead ${parent.subLead}'s merge into ${parent.id} (owner ${i.owner})`;
      }
      if (push?.integratedIn !== undefined && !i.doneProposed) {
        return `item ${i.id}: its push passed in rev ${push.integratedIn} but its owner did not propose done (owner ${i.owner})`;
      }
      if (i.doneProposed && push !== undefined && push.integratedIn === undefined) {
        return `item ${i.id}: its owner proposed done, but no passing revision merged its latest push (owner ${i.owner})`;
      }
      if (push === undefined || push.agent !== i.owner) {
        return `item ${i.id}: its owner never pushed for it (owner ${i.owner})`;
      }
      return `item ${i.id}: not completed (owner ${i.owner})`;
    }
    if (i.status === "contested") {
      return `item ${i.id}: its claim was still contested`;
    }
    return i.fixExhausted
      ? `item ${i.id}: reopened after its fix budget was spent; nobody completed it`
      : `item ${i.id}: nobody claimed it`;
  });
}

/** Workers' proposals the lead rejected or never decided (neither counts toward completion). */
export function proposalOutcomes(
  state: BoardState,
  log: readonly BoardMessage[],
): { readonly rejected: readonly { readonly item: string; readonly by: string; readonly rationale?: string }[]; readonly undecided: readonly string[] } {
  const rejected = Object.values(state.items)
    .filter((i) => i.status === "rejected")
    .map((i) => {
      const message = log.find((m) => m.type === "item.rejected" && m.payload.item === i.id);
      return { item: i.id, by: i.triage?.by ?? "?", ...(message?.rationale !== undefined ? { rationale: message.rationale } : {}) };
    });
  const undecided = Object.values(state.items)
    .filter((i) => i.status === "proposed")
    .map((i) => i.id);
  return { rejected, undecided };
}

/** Drive a board run end to end. */
export async function runBoard(options: RunBoardOptions): Promise<RunBoardResult> {
  const emit = options.onEvent ?? (() => {});
  const rawFetch = options.fetchFn ?? fetch;
  const base = options.workerUrl.replace(/\/$/, "");
  const changeId = options.changeId;
  const budgets = {
    maxTurnsPerItem: options.budgets?.maxTurnsPerItem ?? 8,
    maxRunTurns: options.budgets?.maxRunTurns ?? 200, // replaced by the plan-scaled value once planned
    maxRounds: options.budgets?.maxRounds ?? 200,
    timeoutMs: options.budgets?.timeoutMs ?? 30 * 60 * 1000,
    maxFixAttemptsPerItem: options.budgets?.maxFixAttemptsPerItem ?? 3,
    quiescenceMs: options.budgets?.quiescenceMs ?? 2 * 60 * 1000,
    toolHoldMs: options.budgets?.toolHoldMs ?? 90 * 1000,
  };
  const ttl = options.workspaceTtlSeconds ?? 1800;
  if (budgets.timeoutMs > ttl * 1000) {
    // Agents push with their own short write tokens, which are not refreshed:
    // an agent phase longer than their lifetime would fail pushes mid-run.
    throw new Error(
      `the agent-phase timeout (${Math.round(budgets.timeoutMs / 1000)} s) exceeds the agents' write-token lifetime ` +
        `(${ttl} s); raise --token-ttl or lower --timeout-ms`,
    );
  }
  const readTtl = options.readTokenTtlSeconds ?? 600;
  const executor = options.executor ?? new ScopedNoopExecutor();
  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), "scf-board-")));
  await mkdir(workRoot, { recursive: true });
  const worktreeRoot = join(workRoot, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  // An app's gate may import a shared harness beside the app directory.
  await materializeSiblingGateDeps(options.projectDir, worktreeRoot);
  const identity: GitIdentity = options.identity ?? { name: "Switchyard Integrator", email: "integrator@switchyard.local" };
  const operator = new BoardOperatorClient(rawFetch, base, changeId);
  const objective = options.goal.trim().slice(0, 2000);

  // Every credential the run handles, so any text that leaves it is scrubbed.
  const secrets = new Set<string>();
  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      if (secret.length >= 6) {
        out = out.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
      }
    }
    return redactSecrets(out);
  };

  // Every gate run installs the gated tree's dependencies first (a clone has
  // none); an install failure fails that gate honestly.
  const gateRunner: VerificationCommandRunner | undefined =
    options.appGateCommand && options.appGateCommand.length > 0
      ? new InstallingCommandRunner(
          options.verifyCommandRunner ?? new ChildProcessCommandRunner(),
          options.dependencyInstaller ??
            new LockfileDependencyInstaller({
              cacheDir: join(workRoot, "package-cache"),
              ...(options.installTimeoutMs !== undefined ? { timeoutMs: options.installTimeoutMs } : {}),
            }),
        )
      : options.verifyCommandRunner;

  // 1. The planning-first Change, then the goal (with the contract and the
  //    baseline gate's test inventory), posted by the human.
  // The contract (and its immutable acceptance gate) comes from the project's
  // DECLARED gate, even when an offline fixture stands in for running it.
  const guarded = await deriveProtectedPaths(options.projectDir, options.contractGateCommand ?? options.appGateCommand);
  const cloud = options.integrator === "cloud";
  // The integration workspace: seeded from the project baseline; only gated,
  // passing, RECORDED revisions ever advance its branch. With the cloud
  // integrator it is an Artifact repo the integration Workflow can reach.
  const cloudWorkspace: CloudIntegrationWorkspace | undefined = cloud
    ? await createCloudIntegrationWorkspace({ fetchFn: rawFetch, base, changeId, projectDir: options.projectDir, workRoot, ttlSeconds: Math.min(3600, ttl), identity })
    : undefined;
  const integration = cloudWorkspace
    ? { integrationRef: cloudWorkspace.integrationRef, integrationToken: cloudWorkspace.integrationToken }
    : await createIntegrationWorkspace(workRoot, options.projectDir, changeId, identity);
  // Run the gate once on the baseline and record which tests it executed, so a
  // later run that exits early (tests never run) cannot pass.
  const inventory =
    options.appGateCommand && options.appGateCommand.length > 0
      ? await recordBaselineInventory({
          integrationRef: integration.integrationRef,
          integrationToken: integration.integrationToken,
          gateCommand: options.appGateCommand,
          ...(gateRunner ? { commandRunner: gateRunner } : {}),
          workRoot: worktreeRoot,
        }).catch(() => undefined)
      : undefined;
  const baselineInstall = gateRunner instanceof InstallingCommandRunner ? gateRunner.takeLastInstall() : undefined;
  const inventoryLabel =
    (!options.appGateCommand
      ? "no gate"
      : inventory
        ? `${inventory.count} test(s) (${inventory.format})`
        : "test inventory unavailable: the gate's output does not show which tests ran; revisions fall back to its exit code") +
    (baselineInstall ? `; dependency install: ${formatDependencyInstall(baselineInstall)}` : "");
  const created = await createPlanningChange({
    workerUrl: base,
    header: { id: changeId, objective, baseline: "HEAD", budgetUsd: 0, assurance: "standard" },
    fetchFn: rawFetch,
  });
  if (!created) {
    throw new Error(`could not create Change ${changeId} on ${base}`);
  }
  emit({ kind: "change-created", changeId });
  if (cloudWorkspace) {
    // Integration on Cloudflare: the Workflow integrates every announced push
    // with this configuration (the gate, the contract, the baseline inventory).
    await configureCloudIntegration({
      fetchFn: rawFetch,
      base,
      changeId,
      workspace: cloudWorkspace,
      ...(options.appGateCommand && options.appGateCommand.length > 0 ? { gateCommand: options.appGateCommand } : {}),
      requireGate: options.requireAppGate === true,
      protectedPaths: guarded.restore,
      protectedJsonKeys: guarded.jsonKeys,
      ...(inventory ? { testInventory: inventory } : {}),
      gateSupportFiles: await gateSupportFilesFor(options.projectDir),
      timeouts: { installMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS, gateMs: options.cloudGateTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS },
      identity,
      // With a decision model, the Workflow holds each failing revision for
      // this run's advisory attribution (the parse alone otherwise).
      attribution: options.jev ? "driver" : "engine",
    });
  }
  // Plan BEFORE the goal is posted: the fix budget the goal records, and the
  // dial, scale with the plan size (explicit values always win).
  let planned: BoardSeed;
  try {
    planned = await options.seed(objective);
  } catch (error) {
    await failPlanningChange({
      workerUrl: base,
      changeId,
      reason: scrub(`planning failed: ${error instanceof Error ? error.message : String(error)}`),
      fetchFn: rawFetch,
    }).catch(() => false);
    if (cloudWorkspace) {
      await withWorkerAuth(rawFetch)(`${base}/workspaces/${encodeURIComponent(cloudWorkspace.workspaceName)}`, { method: "DELETE" }).catch(() => undefined);
    }
    throw error;
  }
  const seams = await sharedSeams(options.projectDir);
  const effective = scaledBudgets({
    items: planned.items.length,
    explicitFixAttempts: options.rules?.maxFixAttempts ?? options.budgets?.maxFixAttemptsPerItem,
    ...(options.budgets?.maxRunTurns !== undefined ? { explicitRunTurns: options.budgets.maxRunTurns } : {}),
    dial: options.dial,
    scaleDial: options.scaleDial === true,
  });
  budgets.maxRunTurns = effective.maxRunTurns;
  const dial: ConcurrencyDial = { minConcurrency: options.dial.minConcurrency, maxConcurrency: effective.dialMax };
  emit({ kind: "budgets", items: planned.items.length, ...effective });
  const goal = await operator.postAsHuman({
    type: "goal.posted",
    payload: {
      objective,
      rules: { ...(options.rules ?? {}), maxFixAttempts: effective.maxFixAttempts },
      protected: guarded.paths,
      // The immutable acceptance gate: never contract-changeable.
      ...(guarded.immutable.length > 0 ? { immutable: guarded.immutable } : {}),
      // The shared seams (from the cohesion blueprint) and their importers: seam changes go first.
      ...(seams.length > 0 ? { seams } : {}),
      // Recorded with the goal: the board refuses splits under the cloud integrator.
      ...(cloud ? { integrator: "cloud" } : {}),
      ...(guarded.keyLabels.length > 0 ? { protectedKeys: guarded.keyLabels } : {}),
      ...(options.appGateCommand && options.appGateCommand.length > 0
        ? {
            testInventory: inventory
              ? // Count and format only: the names stay with the integrator, so
                // code under test cannot read from the board what to print.
                { status: "recorded", format: inventory.format, count: inventory.count }
              : { status: "unavailable" },
          }
        : {}),
    },
  });
  if (!goal.ok) {
    throw new Error(`the board refused the goal (${goal.code}): ${goal.error}`);
  }
  emit({ kind: "goal-posted", protected: guarded.paths, immutable: guarded.immutable, testInventory: inventoryLabel });

  const turns: AgentTurnRecord[] = [];
  const runBudget = new RunTurnBudget(budgets.maxRunTurns);
  let seed: BoardSeed | undefined;
  const joinAgent = operator.join.bind(operator);
  const workers: BoardAgent[] = [];
  const agentRepos = new Map<string, BoardAgentRepo>();
  // Every advisory typed decision (and every failed call) is recorded on the
  // board as decision.recorded: visible, never affecting arbitration or verdict.
  const recordDecision = async (decision: BoardDecisionRecord): Promise<BoardDecisionRecordOutcome> => {
    const outcome = await operator
      .recordDecision({
        ...decision,
        question: decision.question.slice(0, 500),
        ...(decision.answer !== undefined ? { answer: decision.answer.slice(0, 200) } : {}),
        ...(decision.error !== undefined ? { error: scrub(decision.error).slice(0, 300) } : {}),
      })
      .catch(() => undefined);
    // A 4xx is the board's definite refusal; anything else (5xx, the network) is unknown.
    return outcome?.ok === true ? "recorded" : outcome !== undefined && outcome.status >= 400 && outcome.status < 500 ? "refused" : "failed";
  };

  // Read tokens the integrator was issued, revoked as soon as it is done with them.
  const issuedReadTokens: { agent: string; tokenId: string; help?: string }[] = [];
  const revokeReadTokens = async (): Promise<void> => {
    for (const issued of issuedReadTokens.splice(0)) {
      await operator.revokeReadToken(issued.agent, issued.tokenId, issued.help).catch(() => undefined);
    }
  };
  // Help forks the run made: help request -> the fork (for reads and cleanup).
  const helpForks = new Map<string, { readonly workspaceName: string; readonly gitUrl: string; readonly helper: string }>();
  const readRemote = async (agent: string, help?: string): Promise<string> => {
    const repo = help !== undefined ? helpForks.get(help) : agentRepos.get(agent);
    if (!repo) {
      throw new Error(help !== undefined ? `no fork is known for help request ${help}` : `no repo is known for ${agent}`);
    }
    // A transient refusal (5xx, the network) is retried a bounded number of times.
    let issued: Awaited<ReturnType<BoardOperatorClient["readToken"]>> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        issued = await operator.readToken(agent, readTtl, help !== undefined ? { help } : {});
      } catch (error) {
        issued = { ok: false, code: "NETWORK", error: error instanceof Error ? error.message : String(error), status: 0 };
      }
      if (issued.ok || (issued.status >= 400 && issued.status < 500)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
    if (!issued || !issued.ok) {
      throw new Error(`no read token for ${agent} (${issued?.code ?? "?"}): ${issued?.error ?? "unknown"}`);
    }
    secrets.add(issued.token);
    issuedReadTokens.push({ agent, tokenId: issued.tokenId, ...(help !== undefined ? { help } : {}) });
    return authenticatedRemote(repo.gitUrl, issued.token);
  };

  secrets.add(integration.integrationToken);
  const revisionDirs = new Map<string, Promise<string | undefined>>();
  // A passing revision's tree, materialized once for any agent that rebases.
  const fetchRevision = (n: number, commit: string): Promise<string | undefined> => {
    let found = revisionDirs.get(commit);
    if (!found) {
      found = (async () => {
        const dir = join(workRoot, "revisions", `rev-${n}`);
        try {
          await rm(dir, { recursive: true, force: true });
          // The integration remote is private: authenticate the clone and the
          // gated-ref fetch. runGit sends the token as a scoped header, so the
          // checkout's origin stays tokenless.
          const remote = authenticatedRemote(integration.integrationRef.gitUrl, integration.integrationToken);
          await runGit(["clone", "-q", remote, dir]);
          await runGit(["-C", dir, "fetch", "-q", remote, `+${GATED_REF_PREFIX}*:${GATED_REF_PREFIX}*`]).catch(() => undefined);
          await runGit(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit]);
          return dir;
        } catch {
          return undefined;
        }
      })();
      revisionDirs.set(commit, found);
    }
    return found;
  };
  // Another agent's announced push, read with an operator read token (handoffs).
  const pushDirs = new Map<string, Promise<string | undefined>>();
  const fetchPush = (agent: string, commit: string): Promise<string | undefined> => {
    const key = `${agent}@${commit}`;
    let found = pushDirs.get(key);
    if (!found) {
      found = (async () => {
        const dir = join(workRoot, "pushes", `${agent.replace(/[^A-Za-z0-9._-]+/g, "-")}-${commit.slice(0, 12)}`);
        try {
          await rm(dir, { recursive: true, force: true });
          const remote = await readRemote(agent);
          // runGit sends the read token as a header: the checkout's origin is
          // the tokenless URL, so the token is never left in its config.
          await runGit(["clone", "-q", remote, dir]);
          await runGit(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit]);
          return dir;
        } catch {
          return undefined;
        } finally {
          await revokeReadTokens();
        }
      })();
      pushDirs.set(key, found);
    }
    return found;
  };
  // A helper's fork, materialized at its delivered commit for the requester's pull.
  const fetchFork = (request: string, helper: string, commit: string): Promise<string | undefined> => {
    const key = `help:${request}@${commit}`;
    let found = pushDirs.get(key);
    if (!found) {
      found = (async () => {
        const dir = join(workRoot, "pushes", `help-${request.replace(/[^A-Za-z0-9._-]+/g, "-")}-${commit.slice(0, 12)}`);
        try {
          await rm(dir, { recursive: true, force: true });
          await runGit(["clone", "-q", await readRemote(helper, request), dir]);
          await runGit(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit]);
          return dir;
        } catch {
          return undefined;
        } finally {
          await revokeReadTokens();
        }
      })();
      pushDirs.set(key, found);
    }
    return found;
  };
  // The operator forks the requester's repo for a helper (the board checks the
  // grant first); the fork's short write token goes to the helper only.
  const forkForHelp = async (agent: string, request: string) => {
    const forked = await operator.helpFork(request, agent, Math.min(3600, Math.max(60, ttl)));
    if (forked.ok) {
      secrets.add(forked.token);
      helpForks.set(request, { workspaceName: forked.workspaceName, gitUrl: forked.gitUrl, helper: agent });
      emit({ kind: "help-forked", request, helper: agent, forkOf: forked.forkOf, workspace: forked.workspaceName });
    }
    return forked;
  };
  const runningAgents = () => workers.filter((w) => !w.stopped).map((w) => w.id);
  // Agent-built tools: the tools repo (provisioned on the first build), each
  // tool's own gate on the ORIGINAL code, pinned runs, engine-recorded uses.
  // With the cloud integrator the tool gates still run here, in the driver.
  const toolBench = new ToolBench({
    operator,
    workRoot,
    projectDir: options.projectDir,
    scrub,
    secrets,
    tokenTtlSeconds: Math.min(3600, Math.max(60, ttl)),
    ...(options.toolTimeoutMs !== undefined ? { limits: { timeoutMs: options.toolTimeoutMs, testTimeoutMs: Math.max(options.toolTimeoutMs, 60_000) } } : {}),
    ...(options.toolSyntaxCommand ? { syntaxCommand: options.toolSyntaxCommand } : {}),
    onGate: (gate) => emit({ kind: "tool-gated", gate }),
  });
  const toolAuthor = options.toolAuthor ?? executorToolAuthor(executor);
  const makeAgent = (id: string, role: "worker" | "lead") =>
    new BoardAgent({
      id,
      role,
      goal: objective,
      changeId,
      baseUrl: base,
      fetchFn: rawFetch,
      join: joinAgent,
      transport: options.transport,
      executor,
      projectDir: options.projectDir,
      workRoot,
      ...(options.identity ? { identity: options.identity } : {}),
      workspaceTtlSeconds: ttl,
      maxTurnsPerItem: budgets.maxTurnsPerItem,
      runBudget,
      fetchRevision,
      fetchPush,
      fetchFork,
      forkForHelp,
      runningAgents,
      tools: toolBench,
      toolAuthor,
      ...(options.escalationModels ? { escalationModels: options.escalationModels } : {}),
      ...(role === "lead"
        ? {
            seed: async () => {
              // Planned before the goal was posted (the budgets scale with it).
              seed = planned;
              emit({ kind: "seeded", source: seed.source, ...(seed.model ? { model: seed.model } : {}), items: seed.items.length });
              for (const prior of seed.priorReviews ?? []) {
                await recordDecision({
                  juncture: "plan-review",
                  question: `${prior.question} (an earlier plan by ${prior.model}: ${prior.units.join(", ")}; not chosen)`,
                  ...(prior.error === undefined ? { answer: prior.noul, confidence: prior.confidence } : {}),
                  accepted: prior.accepted,
                  ...(prior.error !== undefined ? { error: prior.error } : {}),
                });
              }
              if (seed.review) {
                await recordDecision({
                  juncture: "plan-review",
                  question: seed.review.question,
                  ...(seed.review.error === undefined ? { answer: seed.review.noul, confidence: seed.review.confidence } : {}),
                  accepted: seed.review.accepted,
                  ...(seed.review.error !== undefined ? { error: seed.review.error } : {}),
                });
              }
              return seed.items;
            },
          }
        : {}),
      onTurn: (record) => {
        turns.push(record);
        emit({ kind: "turn", record });
      },
    });

  const integrator: BoardIntegratorLike = cloud
    ? new CloudBoardIntegrator({
        fetchFn: rawFetch,
        base,
        changeId,
        requiresGate: Boolean(options.appGateCommand && options.appGateCommand.length > 0) || options.requireAppGate === true,
        readState: async () => (await operator.page(0, 1)).state,
        scrub,
        ...(options.pollMs !== undefined ? { pollMs: Math.max(options.pollMs, 250) } : {}),
        ...(options.cloudSettleTimeoutMs !== undefined ? { settleTimeoutMs: options.cloudSettleTimeoutMs } : {}),
        onRevision: (revision) => emit({ kind: "integrated", revision }),
        onFailure: (reason) => emit({ kind: "integration-not-recorded", reason }),
        ...(options.jev
          ? {
              attribute: async (request) => {
                const decisions: BoardDecisionRecord[] = [];
                const result = await attributeRevisionFailure({
                  items: request.items,
                  output: request.output,
                  changeId,
                  jev: options.jev!,
                  ...(options.jevThreshold !== undefined ? { jevThreshold: options.jevThreshold } : {}),
                  onDecision: async (decision) => void decisions.push(decision),
                });
                return { items: result.items, source: result.source, ...(result.pick !== undefined ? { pick: result.pick } : {}), decisions };
              },
              recordDecision,
            }
          : {}),
      })
    : new ContinuousBoardIntegrator({
    operator,
    change: { id: changeId, objective },
    agentRepos,
    readRemote,
    integration: integration as Awaited<ReturnType<typeof createIntegrationWorkspace>>,
    worktreeRoot,
    identity,
    ...(options.appGateCommand ? { appGateCommand: options.appGateCommand } : {}),
    ...(options.requireAppGate ? { requireAppGate: true } : {}),
    ...(gateRunner ? { verifyCommandRunner: gateRunner } : {}),
    contract: guarded,
    ...(inventory ? { testInventory: inventory } : {}),
    onSettled: revokeReadTokens,
    ...(options.jev ? { jev: options.jev } : {}),
    ...(options.jevThreshold !== undefined ? { jevThreshold: options.jevThreshold } : {}),
    scrub,
    recordDecision,
    onRevision: (revision) => emit({ kind: "integrated", revision }),
    onFailure: (reason) => emit({ kind: "integration-not-recorded", reason }),
  });

  // Contract changes on the original tests wait for a HUMAN: hand each pending
  // one to the resolver once (a durable wait for the console otherwise).
  const asked = new Set<string>();
  const authed = withWorkerAuth(rawFetch);
  // Before a human is asked, an ADVISORY triage of the contract (when a
  // decision model is configured), recorded on the board linked to the
  // contract; the escalation then shows its recommendation. It never decides.
  const triageContractFor = async (contractId: string): Promise<string | undefined> => {
    if (!options.jev) {
      return undefined;
    }
    const page = await operator.log().catch(() => undefined);
    const contract = page?.state.contracts[contractId];
    if (!page || !contract) {
      return undefined;
    }
    const proposal = page.messages.find((m) => m.type === "contract.proposed" && m.payload.contract === contractId);
    const item = contract.item !== undefined ? page.state.items[contract.item] : undefined;
    const failure = page.state.lastFailure;
    const decision = await triageContract({
      ask: options.jev,
      ...(options.jevThreshold !== undefined ? { threshold: options.jevThreshold } : {}),
      scrub,
      input: {
        changeId,
        contract: contractId,
        kind: contract.kind,
        target: contract.target,
        goal: objective,
        ...(contract.item !== undefined ? { item: contract.item } : {}),
        ...(item ? { itemObjective: item.objective } : {}),
        proposer: contract.proposedBy,
        ...(proposal?.rationale !== undefined ? { rationale: proposal.rationale } : {}),
        ...(failure && contract.item !== undefined && failure.items.includes(contract.item) ? { failingEvidence: failure.output } : {}),
        ...(await readTargetExcerpt(options.projectDir, contract.target.split("#")[0]!).then((excerpt) => (excerpt !== undefined ? { targetExcerpt: excerpt } : {}))),
        ...(contract.seam !== undefined
          ? {
              seam: true,
              ...(contract.description !== undefined ? { proposedChange: contract.description } : {}),
              ...(failure ? { failingEvidence: failure.output } : {}),
              otherSeamChanges:
                Object.values(page.state.contracts)
                  .filter((c) => c.seam !== undefined && c.contract !== contractId && c.status !== "rejected")
                  .map((c) => `${c.contract} (${c.status}) on ${c.seam}: ${c.description ?? ""}`)
                  .join("\n") || "none",
            }
          : {}),
      },
    });
    await recordDecision(decision);
    const recommendation = contractTriageRecommendation({ ...decision, ...(decision.error !== undefined ? { error: scrub(decision.error).slice(0, 300) } : {}) });
    emit({ kind: "contract-triage", contract: contractId, recommendation });
    return recommendation;
  };
  // Seam contracts the LEAD decides get the same ADVISORY triage first (when a
  // decision model is configured): recorded on the board, shown in the lead's
  // turn (pendingContracts[].triage). It never decides.
  const seamTriaged = new Set<string>();
  const triageSeamContracts = async (): Promise<void> => {
    if (!options.jev) {
      return;
    }
    const state = (await operator.page(0, 1)).state;
    for (const c of Object.values(state.contracts)) {
      if (c.seam !== undefined && c.status === "proposed" && c.triage === undefined && !seamTriaged.has(c.contract)) {
        seamTriaged.add(c.contract);
        await triageContractFor(c.contract);
      }
    }
  };
  const settleContracts = async (): Promise<boolean> => {
    await triageSeamContracts();
    let decided = false;
    const res = await authed(`${base}/changes/${encodeURIComponent(changeId)}/escalations`).catch(() => undefined);
    const body = res && res.status < 400 ? ((await res.json()) as { escalations?: { id: string; status: string; boardContract?: string; path?: string; question: string }[] }) : {};
    for (const e of body.escalations ?? []) {
      if (e.status !== "pending" || e.boardContract === undefined || asked.has(e.id)) {
        continue;
      }
      asked.add(e.id);
      const recommendation = await triageContractFor(e.boardContract);
      const question = recommendation !== undefined ? withContractTriage(e.question, recommendation) : e.question;
      if (!options.resolveContract) {
        emit({ kind: "contract-awaiting-human", contract: e.boardContract, escalationId: e.id, ...(e.path ? { path: e.path } : {}), ...(recommendation !== undefined ? { recommendation } : {}) });
        continue;
      }
      // The human decides; the recommendation is shown, never applied.
      const decision = await options.resolveContract({
        escalationId: e.id,
        contract: e.boardContract,
        ...(e.path ? { path: e.path } : {}),
        question,
        ...(recommendation !== undefined ? { recommendation } : {}),
      });
      const posted = await authed(`${base}/changes/${encodeURIComponent(changeId)}/escalations/${encodeURIComponent(e.id)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (posted.status < 400) {
        decided = true;
        emit({ kind: "contract-decision", contract: e.boardContract, decision, ...(e.path ? { path: e.path } : {}) });
      }
    }
    return decided;
  };

  // SEAM_FIRST holds never end a run quiescent: when the board goes quiet
  // while a seam item holds dependents, the operator records it stalled (the
  // engine ends the hold, and releases the item when its owner pushed nothing).
  const releaseStalledSeams = async (): Promise<boolean> => {
    const holds = seamHolds((await operator.page(0, 1)).state);
    let released = false;
    for (const hold of holds) {
      const recorded = await operator.recordSeamStalled(hold.item);
      if (recorded.ok) {
        released = true;
        const m = recorded.appended.find((a) => a.type === "seam.stalled");
        emit({ kind: "seam-stalled", item: hold.item, released: m?.type === "seam.stalled" ? m.payload.released : false, dependents: hold.dependents });
      }
    }
    return released;
  };

  const lead = makeAgent("lead", "lead");
  const controller = new AbortController();
  const loops: Promise<void>[] = [];
  let stopReason: BoardStopReason | undefined;
  let stopDetail: string | undefined;
  const cleanedUp: string[] = [];
  let failure: unknown;
  let planningMarked = false;

  const cleanupRepos = async (): Promise<void> => {
    if (options.skipCleanup) {
      return;
    }
    const authed = withWorkerAuth(rawFetch);
    if (cloudWorkspace && !cleanedUp.includes(cloudWorkspace.workspaceName)) {
      // The integration repo of the cloud integrator (its tokens go with it).
      try {
        const res = await authed(`${base}/workspaces/${encodeURIComponent(cloudWorkspace.workspaceName)}`, { method: "DELETE" });
        if (res.status < 400) {
          cleanedUp.push(cloudWorkspace.workspaceName);
        }
      } catch {
        // Best-effort.
      }
    }
    await toolBench.revokeTokens();
    // Help forks are archived with the agents' repos (their tokens go with them).
    for (const name of [toolBench.workspaceName, ...workers.map((w) => w.joinedWorkspace?.workspaceName), ...[...helpForks.values()].map((f) => f.workspaceName)]) {
      if (!name || cleanedUp.includes(name)) {
        continue;
      }
      try {
        const res = await authed(`${base}/workspaces/${encodeURIComponent(name)}`, { method: "DELETE" });
        if (res.status < 400) {
          cleanedUp.push(name);
        }
      } catch {
        // Best-effort.
      }
    }
    emit({ kind: "cleaned-up", archived: cleanedUp });
  };

  try {
    // 2. The lead joins; its first step is the planner.
    await lead.join("the lead seeds the goal's open items and arbitrates contracts");
    emit({ kind: "agent-joined", agent: lead.id, role: "lead" });
    try {
      await lead.step();
    } catch (error) {
      planningMarked = true;
      await failPlanningChange({
        workerUrl: base,
        changeId,
        reason: scrub(`planning failed: ${error instanceof Error ? error.message : String(error)}`),
        fetchFn: rawFetch,
      });
      throw error;
    }

    // 3. Recruit under the dial and let the agents work; integrate as pushes land.
    const recruit = async (state: BoardState): Promise<number> => {
      let joined = 0;
      const inFlight = () => workers.filter((w) => !w.stopped).length;
      // Open items, plus help requests that grant a scope nobody has taken yet
      // (a helper recruited for one forks the requester's repo).
      const helpWanted = Object.values(state.help).filter((h) => h.scope !== undefined && h.grant === undefined && helpGrantLive(state, h)).length;
      const open = Object.values(state.items).filter((i) => i.status === "open").length + helpWanted;
      while (workers.length < dial.maxConcurrency && (inFlight() < dial.minConcurrency || open > inFlight())) {
        const worker = makeAgent(`agent-${workers.length + 1}`, "worker");
        await worker.join(open > 0 ? `${open} open item(s) outnumber the ${inFlight()} agent(s) in flight` : "the dial's minimum");
        workers.push(worker);
        joined += 1;
        if (worker.joinedWorkspace) {
          secrets.add(worker.joinedWorkspace.token);
          agentRepos.set(worker.id, { gitUrl: worker.joinedWorkspace.gitUrl, defaultBranch: worker.joinedWorkspace.defaultBranch });
        }
        emit({
          kind: "agent-joined",
          agent: worker.id,
          role: "worker",
          ...(worker.joinedWorkspace ? { workspace: worker.joinedWorkspace.workspaceName, backend: worker.joinedWorkspace.backend } : {}),
        });
      }
      return joined;
    };
    const reported = new Set<string>();
    const reportStops = () => {
      for (const agent of [lead, ...workers]) {
        if (agent.stopped && !reported.has(agent.id) && agent.stopped.reason !== "stopped") {
          reported.add(agent.id);
          emit({ kind: "agent-stopped", agent: agent.id, stop: agent.stopped });
        }
      }
    };
    const started = Date.now();
    const check = (state: BoardState): BoardStopReason | undefined => {
      const owed = outstanding(state);
      // A worker's proposal awaiting the lead keeps the phase open (the lead
      // decides it next); once decided, only accepted items count.
      const awaitingLead = Object.values(state.items).some((i) => i.status === "proposed");
      if (Object.values(state.items).some(isChangeItem) && owed.length === 0 && !awaitingLead) {
        return "all-items-done";
      }
      // Every outstanding item was spent by every agent still running: nobody
      // can take it again (reopening only hands it to fresh eyes).
      const running = workers.filter((w) => !w.stopped).map((w) => w.id);
      if (
        owed.length > 0 &&
        owed.every((i) => i.status === "open" && (i.exhaustedBy?.length ?? 0) > 0 && running.every((w) => i.exhaustedBy!.includes(w))) &&
        !integrator.wants(state)
      ) {
        return "fix-budget";
      }
      if (runBudget.exhausted) {
        return "run-budget";
      }
      if (Date.now() - started > budgets.timeoutMs) {
        return "timeout";
      }
      if (workers.length > 0 && workers.every((w) => w.stopped)) {
        return "all-agents-stopped";
      }
      return undefined;
    };

    if ((options.schedule ?? "lockstep") === "lockstep") {
      for (let round = 1; round <= budgets.maxRounds && stopReason === undefined; round += 1) {
        const state = (await operator.page(0, 1)).state;
        stopReason = check(state);
        if (stopReason) {
          break;
        }
        const joined = await recruit(state);
        let acted = false;
        for (const agent of [lead, ...lockstepOrder(workers, (await operator.page(0, 1)).state)]) {
          if ((await agent.step()) === "acted") {
            acted = true;
          }
        }
        reportStops();
        // Integrate between rounds: every push announced this round is
        // coalesced into the next revision, deterministically.
        const before = integrator.revisions.length;
        if (integrator.wants((await operator.page(0, 1)).state)) {
          integrator.kick();
          await integrator.idle();
        }
        const integrated = integrator.revisions.length > before;
        const decided = await settleContracts();
        if (!acted && joined === 0 && !integrated && !decided && !(await releaseStalledSeams())) {
          stopReason = check((await operator.page(0, 1)).state) ?? "quiescent";
          stopDetail = "no agent had anything to do and no integration was pending";
        }
      }
      stopReason ??= check((await operator.page(0, 1)).state) ?? "max-rounds";
    } else {
      loops.push(lead.run({ signal: controller.signal }));
      let latestState: BoardState | undefined;
      const heldSince = new Map<string, number>();
      const pollMs = options.pollMs ?? 500;
      let lastSeq = -1;
      let quietSince = Date.now();
      while (stopReason === undefined) {
        const state = (await operator.page(0, 1)).state;
        stopReason = check(state);
        if (stopReason) {
          break;
        }
        latestState = state;
        const before = workers.length;
        await recruit(state);
        for (const worker of workers.slice(before)) {
          // Tool builders first: an owner whose unpushed work a codemod being
          // built covers waits (bounded by toolHoldMs from when it was first held).
          const hold = async () => {
            // Judged on the board as it is NOW, not the driver's last poll: a
            // poll that lags (a loaded machine) must not let an owner that just
            // claimed a covered item past the hold. Read only while a codemod
            // is still unpublished (otherwise nothing can hold).
            const building =
              latestState !== undefined &&
              Object.values(latestState.tools.proposed).some(
                (t) => t.kind === "codemod" && !latestState!.tools.published.some((p) => p.capability === t.capability),
              );
            if (!building || !toolHold((await operator.page(0, 1)).state, worker.id)) {
              return false;
            }
            const since = heldSince.get(worker.id) ?? Date.now();
            heldSince.set(worker.id, since);
            return Date.now() - since < budgets.toolHoldMs;
          };
          loops.push(worker.run({ signal: controller.signal, hold }));
        }
        reportStops();
        if (integrator.wants(state)) {
          integrator.kick();
        }
        await settleContracts();
        // Quiescence: every agent idle, nothing integrating or pending, and no
        // board message for the bounded period.
        const anyBusy = [lead, ...workers].some((a) => a.busy) || integrator.busy || integrator.wants(state);
        if (state.lastSeq !== lastSeq || anyBusy) {
          lastSeq = state.lastSeq;
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= budgets.quiescenceMs / 2 && seamHolds(state).length > 0 && (await releaseStalledSeams())) {
          // A quiet board with seam holds: the holds end before quiescence could.
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= budgets.quiescenceMs) {
          stopReason = "quiescent";
          stopDetail = `every agent was idle (none taking a turn), nothing was integrating or pending, and no board message arrived for ${Math.round(budgets.quiescenceMs / 1000)} s`;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Whatever ended the agent phase (a stop condition or a throw), every agent
    // loop is aborted and awaited before anything else happens.
    controller.abort();
    await Promise.allSettled(loops);
    for (const agent of [lead, ...workers]) {
      agent.halt();
    }
    if (failure !== undefined) {
      // A throw (a refused join, an unreachable board) marks the Change failed
      // and cleans up every repo the run created before the error propagates.
      await integrator.idle().catch(() => undefined);
      if (!planningMarked) {
        await failPlanningChange({
          workerUrl: base,
          changeId,
          reason: scrub(`the board run failed: ${failure instanceof Error ? failure.message : String(failure)}`),
          fetchFn: rawFetch,
        }).catch(() => false);
      }
      await cleanupRepos();
      await toolBench.dispose();
    }
  }
  emit({ kind: "agents-done", reason: stopReason!, ...(stopDetail ? { detail: stopDetail } : {}) });

  let promotion: PromotionResult | undefined;
  let sourceRepoDir: string | undefined;
  let deployment: { url: string; app: string } | undefined;
  let verdict: "verified" | "failed" = "failed";
  let partial: string | undefined;
  let incompleteItems: string[] = [];
  let incompleteReasons: string[] = [];
  let evidence: EvidenceSummary | undefined;
  try {
    // 4. The last integration: anything still pending is integrated once more,
    // so the final verdict is the gate of the revision that includes it.
    await integrator.idle();
    if (integrator.wants((await operator.page(0, 1)).state)) {
      integrator.kick();
      await integrator.idle();
    }
    if (integrator.revisions.length === 0) {
      emit({ kind: "nothing-to-integrate" });
    }

    // 5. The authoritative verdict is the LAST revision's gate; only that
    // revision, when it passed, is promoted (its commit is the gated tree).
    const last = integrator.revisions.at(-1);
    evidence = last ? integrator.lastEvidence : undefined;
    verdict = last && last.gate === "pass" && evidence?.integration.verdict === "verified" ? "verified" : "failed";
    const finalState = (await operator.page(0, 1)).state;
    // A passing last revision that left announced pushes ungated (excluded,
    // refused, unreadable) is a PARTIAL result: never reported or promoted as
    // verified.
    incompleteItems = outstanding(finalState).map((i) => i.id);
    incompleteReasons = incompleteItemReasons(finalState);
    const ungated = pendingPushItems(finalState);
    if (verdict === "verified" && ungated.length > 0) {
      verdict = "failed";
      partial = `the last revision passed, but ${ungated.length} announced push(es) were never gated (items ${ungated.map((i) => i.id).join(", ")}): a partial result is not verified`;
      emit({ kind: "promotion-skipped", reason: partial });
    }
    const integratedItems = verdict === "verified" ? Object.values(finalState.items).filter((i) => i.lastPush?.integratedIn !== undefined).map((i) => i.id) : [];
    const excludedItems = Object.values(finalState.items)
      .filter((i) => isChangeItem(i) && !integratedItems.includes(i.id))
      .map((i) => i.id);
    // A pass no gate checked is recorded as such (the control plane keeps the
    // flag; the run reports it as unverified).
    const ungatedPass = verdict === "verified" && last !== undefined && !last.gated;
    const recorded = await withWorkerAuth(rawFetch)(`${base}/changes/${encodeURIComponent(changeId)}/integration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict, integratedUnits: integratedItems, excludedUnits: excludedItems, ...(ungatedPass ? { gated: false } : {}) }),
    }).catch((error: unknown) => error);
    if (!(recorded instanceof Response) || recorded.status >= 400) {
      // Never promote a verdict the control plane did not record.
      const why = recorded instanceof Response ? `HTTP ${recorded.status}` : scrub(String(recorded));
      throw new Error(`the integration verdict could not be recorded (${why}); not promoting`);
    }
    emit({ kind: "integration-verdict", verdict, integratedUnits: integratedItems, ...(ungatedPass ? { gated: false as const } : {}) });

    // An ADVISORY fix-confidence decision on the final passing revision:
    // recorded only, it never gates promotion or the deploy.
    if (verdict === "verified" && last && options.jev) {
      const question = "Is this fix acceptable?";
      try {
        const answers = await options.jev(
          [`Change: ${changeId}`, `Objective: ${objective}`, `Mechanical gate verdict (authoritative): ${verdict}`, `Integrated items: ${incompleteItems.length === 0 ? "all" : `all but ${incompleteItems.join(", ")}`}`].join("\n"),
          { "fix-confidence": { type: "noul", instructions: question } },
        );
        const answer = answers["fix-confidence"];
        await recordDecision({
          juncture: "fix-confidence",
          question,
          ...(answer?.noul !== undefined ? { answer: answer.noul, confidence: answer.confidence } : {}),
          accepted: answer?.type === "noul" && answer.noul === "yes" && answer.confidence >= (options.jevThreshold ?? 0.75),
          ...(answer?.noul === undefined ? { error: "the decision reply carried no fix-confidence answer" } : {}),
        });
      } catch (error) {
        await recordDecision({ juncture: "fix-confidence", question, accepted: false, error: jevErrorReason(error) });
      }
    }

    if (last && evidence && partial === undefined) {
      // The promote step reads the verdict from the last revision's evidence
      // (the same gate result the board recorded) and refuses anything else.
      // The cloud integrator's repo is an Artifact repo: promotion reads it with
      // a fresh short-lived token (sent as a header, never stored).
      const promotionToken = cloudWorkspace
        ? await integrationRepoToken({ fetchFn: rawFetch, base, changeId, scope: "read", ttlSeconds: 600 })
        : undefined;
      if (promotionToken) {
        secrets.add(promotionToken.token);
      }
      const promoted = await promoteVerifiedIntegration({
        change: { id: changeId, objective },
        evidence,
        integrationRef: promotionToken
          ? { ...integration.integrationRef, gitUrl: authenticatedRemote(integration.integrationRef.gitUrl, promotionToken.token) }
          : integration.integrationRef,
        projectDir: options.projectDir,
        workRoot,
        worktreeRoot,
        identity,
        requiresIntegrationGate: integrator.lastRequiresGate,
        emit,
      }).finally(() => promotionToken?.revoke());
      promotion = promoted.promotion;
      sourceRepoDir = promoted.sourceRepoDir;
      deployment = await redeployIfPreviouslyDeployed({
        evidence,
        promotion,
        sourceRepoDir,
        projectDir: options.projectDir,
        workRoot,
        ...(options.deployAppDir ? { deployAppDir: options.deployAppDir } : {}),
        ...(options.deployAppName ? { deployAppName: options.deployAppName } : {}),
        ...(options.deployApp ? { deployApp: options.deployApp } : {}),
        ...(options.appAlreadyDeployed ? { appAlreadyDeployed: options.appAlreadyDeployed } : {}),
        recordDeployment: async (d) => {
          await withWorkerAuth(rawFetch)(`${base}/changes/${encodeURIComponent(changeId)}/deployment`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(d),
          }).catch(() => undefined);
        },
        emit,
      });
    } else {
      emit({ kind: "promotion-skipped", reason: "nothing was integrated: not promoting (no delivery branch was created)" });
    }

    // Agents that hold nothing leave the board (the log records the end of the formation).
    for (const agent of [...workers, lead]) {
      await agent.leave("the run is over").catch(() => undefined);
    }
  } finally {
    await cleanupRepos();
    // The bench's private root (tool checkouts, the baseline copy, scratch) is not part of any work root.
    await toolBench.dispose();
  }

  const final = await operator.log();
  const last = integrator.revisions.at(-1);
  return {
    changeId,
    stopReason: stopReason!,
    ...(stopDetail !== undefined ? { stopDetail } : {}),
    log: final.messages,
    state: final.state,
    turns,
    agents: [lead, ...workers].map((a) => ({
      id: a.id,
      role: a.role,
      ...(a.joinedWorkspace ? { workspace: a.joinedWorkspace.workspaceName } : {}),
      ...(a.stopped && a.stopped.reason !== "stopped" ? { stop: a.stopped } : {}),
    })),
    seed: seed ?? { items: [], source: "none" },
    protected: guarded.paths,
    immutable: guarded.immutable,
    protectedKeys: guarded.keyLabels,
    revisions: [...integrator.revisions],
    ...(last ? { revision: last } : {}),
    integrationFailures: [...integrator.failures],
    verdict: verdict === "verified" && last !== undefined && !last.gated ? "unverified" : verdict,
    ...(partial !== undefined ? { partial } : {}),
    incompleteItems,
    incompleteReasons,
    proposals: proposalOutcomes(final.state, final.messages),
    testInventory: inventoryLabel,
    ...(options.gateLabel !== undefined ? { gateLabel: options.gateLabel } : {}),
    ...(evidence ? { evidence } : {}),
    ...(promotion ? { promotion } : {}),
    ...(sourceRepoDir ? { sourceRepoDir } : {}),
    ...(deployment ? { deployment } : {}),
    workRoot,
    cleanedUp,
    toolGates: [...toolBench.gates],
    editModels: workers.flatMap((w) => w.editModels.map((e) => ({ agent: w.id, ...e }))),
    budgets: { items: planned.items.length, ...effective },
    ...(options.toolAuthorLabel !== undefined ? { toolAuthorLabel: options.toolAuthorLabel } : {}),
  };
}

/**
 * Concurrent schedule priority for tool builders: true when `agent` should
 * not take a turn yet because everything it has to do is editing items it has
 * not pushed that a codemod still being built covers (the tool item claimed by
 * another agent, nothing published, not unavailable). Pure: a function of the
 * board. The driver holds such an owner for a bounded time only.
 */
export function toolHold(state: BoardState, agent: string): boolean {
  const building = Object.values(state.tools.proposed).filter((t) => {
    const item = state.items[t.item];
    return (
      t.kind === "codemod" &&
      item?.status === "claimed" &&
      item.owner !== undefined &&
      item.owner !== agent &&
      !state.tools.published.some((p) => p.capability === t.capability) &&
      toolUnavailableReason(state, t.capability) === undefined
    );
  });
  if (building.length === 0) {
    return false;
  }
  if (Object.values(state.contests).some((c) => c.status !== "resolved" && (c.owner === agent || c.claimant === agent))) {
    return false;
  }
  const held = Object.values(state.items).filter((i) => i.status === "claimed" && i.owner === agent && i.intent);
  const waiting = held.filter((i) => !i.doneProposed || i.fixRequested !== undefined);
  return (
    waiting.length > 0 &&
    waiting.every(
      (i) =>
        i.tool === undefined &&
        i.fixRequested === undefined &&
        (i.lastPush === undefined || i.lastPush.agent !== agent) &&
        building.some((t) => i.intent!.write.some((w) => t.inputs.some((input) => entriesOverlap(intentPath(w), input)))),
    )
  );
}

/**
 * The shared seams of a modular project (the cohesion blueprint's frozen
 * contracts) and the source files that import each, bounded, for the board's
 * seam-first sequencing. Empty for a project that is not clearly modular.
 */
export async function sharedSeams(projectDir: string): Promise<{ path: string; importers: string[]; symbols?: string[] }[]> {
  const snapshot = await scanRepoSnapshot(projectDir).catch(() => undefined);
  const blueprint = snapshot ? deriveCohesionBlueprint(snapshot) : undefined;
  if (!snapshot || !blueprint) {
    return [];
  }
  return Promise.all(
    blueprint.contracts.slice(0, 64).map(async (c) => {
      const symbols = exportedNames(await readFile(join(projectDir, c.path), "utf8").catch(() => ""));
      return {
        path: c.path,
        importers: snapshot.sourceFiles.filter((f) => f.importsFiles.includes(c.path) && f.path !== c.path).map((f) => f.path).sort().slice(0, 256),
        ...(symbols.length > 0 ? { symbols } : {}),
      };
    }),
  );
}

/** The names a module exports (declarations and `export { a, b as c }`), bounded: a type error naming one points at it. */
export function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|type|class|enum|const|let|var|function\*?|namespace)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]!);
  }
  for (const m of source.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = /(?:^|\sas\s+)([A-Za-z_$][\w$]*)\s*$/.exec(part.trim().replace(/^type\s+/, ""))?.[1];
      if (name) names.add(name);
    }
  }
  return [...names].filter((n) => n.length <= 80).slice(0, 64);
}

/**
 * Budgets that scale with the plan (bounded): fix attempts per item are
 * 3 + floor(items / 5), at most 6; the dial's max, when scaled, is
 * min(items, 6) and at least the dial's min. An explicit value always wins.
 */
export function scaledBudgets(input: {
  readonly items: number;
  readonly explicitFixAttempts?: number;
  readonly explicitRunTurns?: number;
  readonly dial: ConcurrencyDial;
  readonly scaleDial: boolean;
}): {
  readonly maxFixAttempts: number;
  readonly fixAttemptsScaled: boolean;
  readonly dialMax: number;
  readonly dialScaled: boolean;
  readonly maxRunTurns: number;
  readonly runTurnsScaled: boolean;
} {
  const fix = input.explicitFixAttempts ?? Math.min(6, 3 + Math.floor(input.items / 5));
  const dialMax = input.scaleDial ? Math.max(input.dial.minConcurrency, Math.min(Math.max(1, input.items), 6)) : input.dial.maxConcurrency;
  const runTurns = input.explicitRunTurns ?? Math.min(MAX_SCALED_RUN_TURNS, Math.max(200, RUN_TURNS_PER_ITEM * input.items));
  return {
    maxFixAttempts: fix,
    fixAttemptsScaled: input.explicitFixAttempts === undefined,
    dialMax,
    dialScaled: input.scaleDial,
    maxRunTurns: runTurns,
    runTurnsScaled: input.explicitRunTurns === undefined,
  };
}

/** Run-wide turns per planned item when the turn budget scales with the plan. */
export const RUN_TURNS_PER_ITEM = 25;
/** The most turns a plan-scaled run budget grants (an explicit --max-turns may go higher). */
export const MAX_SCALED_RUN_TURNS = 800;

/**
 * The lockstep order of the workers in a round: agents building a tool that is
 * not published yet go FIRST (schedule priority), so a tool the lead seeded is
 * published before the owners of the items it covers edit by hand; the rest
 * keep their join order. Deterministic: a function of the board and the join
 * order. Tools stay accelerators: nobody waits, the order only changes who
 * moves first within a round.
 */
export function lockstepOrder<A extends { readonly id: string }>(workers: readonly A[], state: BoardState): A[] {
  const building = new Set(
    Object.values(state.items)
      .filter(
        (i) =>
          i.status === "claimed" &&
          i.owner !== undefined &&
          // A tool still being built, or a shared seam change not yet integrated: these go first.
          ((i.tool !== undefined && !state.tools.published.some((t) => t.capability === i.tool!.capability)) ||
            (i.tool === undefined && isSeamItem(state, i.id) && i.lastPush?.integratedIn === undefined)),
      )
      .map((i) => i.owner!),
  );
  return [...workers.filter((w) => building.has(w.id)), ...workers.filter((w) => !building.has(w.id))];
}

/**
 * The lead's seed from a decomposed Change: each planned unit becomes one open
 * item (its objective, its paths as the scope hint), proposed, never assigned.
 * The plan's source says whether a model planned it.
 */
export function boardSeedFromChange(change: Change): BoardSeed {
  const items = change.work.map((unit) => ({
    item: unit.id.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "item",
    objective: unit.objective.slice(0, 500),
    acceptance: [
      "the change gate passes on an integrated revision that merges this item's push",
      ...(unit.dependsOn.length > 0 ? [`consistent with items ${unit.dependsOn.join(", ")}`] : []),
    ],
    scopeHint: [...unit.paths],
  }));
  const review = change.plan?.jevReview;
  const priorReviews = change.plan?.priorReviews ?? [];
  return {
    items,
    ...(priorReviews.length > 0
      ? {
          priorReviews: priorReviews.map((r) => ({
            question: r.question,
            noul: r.noul,
            confidence: r.confidence,
            accepted: r.accepted,
            ...(r.error !== undefined ? { error: r.error } : {}),
            model: r.model,
            units: [...r.units],
          })),
        }
      : {}),
    source: change.plan?.source ?? "heuristic",
    ...(change.plan?.model ? { model: change.plan.model } : {}),
    ...(review
      ? {
          review: {
            question: review.question,
            noul: review.noul,
            confidence: review.confidence,
            accepted: review.accepted,
            ...(review.error !== undefined ? { error: review.error } : {}),
          },
        }
      : {}),
  };
}

/** Workspace identity in a JoinedWorkspace, minus the token (for display). */
export function describeWorkspace(w: JoinedWorkspace): string {
  return `${w.workspaceName} (${w.backend}${w.fallback ? ", local fallback" : ""})`;
}

function payloadSummary(m: BoardMessage): string {
  const p = m.payload as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
  switch (m.type) {
    case "goal.posted":
      return `"${String(p.objective).slice(0, 90)}"`;
    case "agent.joined":
      return p.role ? `role ${String(p.role)}` : "";
    case "agent.left":
      return "";
    case "item.proposed": {
      const from = p.fromTool as { capability: string; version: string } | undefined;
      return `${String(p.item)}: ${String(p.objective).slice(0, 70)} [scope ${list(p.scopeHint)}]${from ? ` (from ${from.capability}@${from.version} findings)` : ""}${p.fromContract ? ` (seam item of accepted contract ${String(p.fromContract)})` : ""}`;
    }
    case "tool.proposed":
      return `${String(p.kind)} ${String(p.capability)} -> item tool-${String(p.capability)}${(p.inputs as string[]).length > 0 ? ` [inputs ${list(p.inputs)}]` : ""}`;
    case "tool.built":
      return `${String(p.capability)} commit ${String(p.commit).slice(0, 10)} paths ${list(p.paths)}`;
    case "tool.gated": {
      const checks = p.checks as { check: string; passed: boolean; detail: string }[];
      const failed = checks.filter((c) => !c.passed);
      return (
        `${String(p.capability)} commit ${String(p.commit).slice(0, 10)} tool gate ${p.passed ? "PASSED" : "FAILED"} ` +
        `(${checks.map((c) => `${c.check} ${c.passed ? "ok" : "FAIL"}`).join(", ")})` +
        (failed.length > 0 ? `: ${failed[0]!.detail.slice(0, 120)}` : "")
      );
    }
    case "tool.published":
      return `${String(p.capability)}@${String(p.version)} (${String(p.kind)}) commit ${String(p.commit).slice(0, 10)} in ${String(p.repo)}, verified${p.joinsGate === false ? "; joinsGate: false (a check does not join the gate in this slice)" : ""}`;
    case "tool.used": {
      const findings = (p.findings as { path: string }[] | undefined) ?? [];
      const changed = p.changedFiles as string[];
      return (
        `${String(p.capability)}@${String(p.version)} by ${String(p.by)}${p.item ? ` for ${String(p.item)}` : " (sweep)"}` +
        (changed.length > 0 ? `: changed ${changed.join(", ")} (push ${String(p.commit).slice(0, 10)})` : "") +
        (findings.length > 0 ? `: ${findings.length} finding(s) in ${[...new Set(findings.map((f) => f.path))].join(", ")}` : changed.length === 0 ? ": nothing found or changed" : "")
      );
    }
    case "item.claimed":
      return `${String(p.item)} write ${list((p.intent as { write: string[] }).write)}`;
    case "claim.granted":
      return `${String(p.item)} -> ${String(p.agent)} (write ${list((p.intent as { write: string[] }).write)})`;
    case "claim.contested":
      return `${String(p.contest)}: ${String(p.claimant)} (${String(p.item)}) vs owner ${String(p.owner)} (${String(p.ownerItem)}) on ${list(p.overlap)}`;
    case "claim.narrowed":
      return `${String(p.contest)} to ${list(p.write)}`;
    case "claim.kept":
    case "claim.ceded":
      return String(p.contest);
    case "claim.resolved":
      return `${String(p.contest)} ${String(p.how)}${p.winner ? ` (winner ${String(p.winner)})` : ""}`;
    case "claim.escalated":
      return `${String(p.contest)} after ${String(p.turns)} turn(s) (${String(p.reason)})`;
    case "help.requested":
      return `${String(p.request)} on ${String(p.item)} (need ${String(p.need)})${Array.isArray(p.scope) ? `, grants ${list(p.scope)} to the helper who forks` : ""}`;
    case "help.offered":
      return p.forkOf !== undefined
        ? `${String(p.request)}: forked ${String(p.forkOf)}'s repo at ${p.forkCommit !== undefined ? String(p.forkCommit).slice(0, 10) : "its empty state"}${p.fork !== undefined ? ` (fork ${String(p.fork)})` : ""}; takes the grant`
        : String(p.request);
    case "help.delivered":
      return `${String(p.request)}: commit ${String(p.commit).slice(0, 10)} in the fork, paths ${list(p.paths)}`;
    case "help.closed":
      return `${String(p.request)} closed (${String(p.reason)})${p.detail !== undefined ? `: ${String(p.detail).slice(0, 100)}` : ""}`;
    case "item.struggling":
      return `${String(p.item)}: ${String(p.reason)} (${String(p.turnsSpent)} turn(s), ${String(p.failedEdits)} failed edit(s))${p.lastFailure !== undefined ? `: ${String(p.lastFailure).slice(0, 80)}` : ""}`;
    case "help.volunteered":
      return `offers help on ${String(p.item)}`;
    case "help.declined":
      return `${String(p.volunteer)}'s offer on ${String(p.item)}`;
    case "item.split": {
      const children = p.children as { item: string; scopeHint: string[] }[];
      return `${String(p.item)} into ${children.map((c) => `${c.item} [${c.scopeHint.join(", ")}]`).join(", ")}; ${m.from} is its sub-lead`;
    }
    case "push.announced": {
      const merges = p.merges as { item: string; commit: string }[] | undefined;
      const pulled = p.pulled as string[] | undefined;
      return (
        `${String(p.item)} commit ${String(p.commit).slice(0, 10)} paths ${list(p.paths) || "(none)"}` +
        (merges ? ` (sub-lead merge of ${merges.map((x) => `${x.item}@${x.commit.slice(0, 10)}`).join(", ")})` : "") +
        (pulled ? ` (pulled help ${pulled.join(", ")})` : "")
      );
    }
    case "done.proposed":
      return String(p.item);
    case "decision.resolved":
      return `#${String(p.decisionSeq)} picked ${String(p.answer)} for revision ${String(p.rev)}: ${String(p.outcome)} at revision ${String(p.passed)} (changed: ${list(p.fixed)}; parse ${String(p.parseOutcome)}) (advisory)`;
    case "decision.recorded":
      return `${p.contract ? `contract ${String(p.contract)} ` : ""}${String(p.juncture)}${typeof p.rev === "number" ? ` of revision ${p.rev}` : ""}: ${p.error ? `error: ${String(p.error).slice(0, 120)}` : `${String(p.answer ?? "no answer")}${typeof p.confidence === "number" ? ` (confidence ${p.confidence.toFixed(2)})` : ""}, ${p.accepted ? "accepted" : "not accepted"}`} (advisory)`;
    case "integrated.rev": {
      const failing = p.failing as { output: string; items: string[] } | undefined;
      // The most telling line of the failing output: a failing test line when
      // there is one, else the first line.
      const lines = failing ? failing.output.split("\n").map((l) => l.trim()).filter((l) => l !== "") : [];
      const firstLine = firstLines(
        gateFailureLine(failing?.output ?? "") ?? lines.find((l) => /^not ok\b|\bFAIL|\u2716/.test(l)) ?? lines.find((l) => !/^[>$] /.test(l)) ?? lines[0] ?? "",
        300,
      );
      return (
        `rev ${String(p.n)} ${p.gated === false ? "no gate: nothing checked" : `gate ${String(p.gate)}`} commit ${String(p.commit).slice(0, 10)} merged ${(p.merged as string[]).length} push(es) from ${list(p.contributors)}` +
        (failing ? `; implicated ${failing.items.join(", ") || "none"}: "${firstLine}"` : "")
      );
    }
    case "contract.proposed":
      return `${String(p.contract)}: ${String(p.kind)} ${String(p.target)}${p.item ? ` for item ${String(p.item)}` : ""}${p.description ? `: ${String(p.description).slice(0, 160)}` : ""}`;
    case "contract.escalated":
      return `${String(p.contract)}: ${String(p.kind)} ${String(p.target)} for item ${String(p.item)} waits for a human decision`;
    case "seam.stalled":
      return `${String(p.item)} held dependents and made no progress while the board was quiet: its hold ends${p.released ? "; released for another agent (no push of its owner's)" : ""}`;
    case "contract.accepted":
    case "contract.rejected":
      return String(p.contract);
    case "item.accepted":
    case "item.rejected":
      return String(p.item);
    case "fix.requested":
      return `${String(p.item)} (rev ${String(p.n)}, attempt ${String(p.attempt)})`;
    case "fix.exhausted":
      return `${String(p.item)} (rev ${String(p.n)}, after ${String(p.attempts)} attempt(s))`;
    case "item.reopened":
      return `${String(p.item)} for another agent (was ${String(p.previousOwner)}${p.commit ? `, starting from ${String(p.commit).slice(0, 10)}` : ""})`;
    case "rebase.needed":
      return `${String(p.agent)} onto rev ${String(p.n)}`;
    case "item.completed":
      return p.via === "tool" ? `${String(p.item)} via its own tool gate (published v${String(p.version)})` : `${String(p.item)} via rev ${String(p.n)}`;
    case "handoff":
      return `${String(p.item)} -> ${String(p.to)}`;
    default:
      return JSON.stringify(p).slice(0, 100);
  }
}

/** A readable transcript of a board log, one line per message. */
export function formatBoardTranscript(log: readonly BoardMessage[]): string {
  const width = Math.max(2, String(log.at(-1)?.seq ?? 0).length);
  return log
    .map((m) => {
      const to = m.to && m.to.length > 0 ? ` -> ${m.to.join(", ")}` : "";
      const reply = m.inReplyTo !== undefined ? ` (re #${m.inReplyTo})` : "";
      const why = m.rationale ? `  -- ${m.rationale.slice(0, 120)}` : "";
      return `#${String(m.seq).padStart(width)} ${m.from.padEnd(8)} ${m.type.padEnd(16)} ${payloadSummary(m)}${to}${reply}${why}`;
    })
    .join("\n");
}

/**
 * The process exit code for a board run: 0 only for a VERIFIED verdict (a
 * gate ran and passed) with every item completed, and, when `requirePromotion`,
 * the result promoted. An unverified (no gate), failed, or partial result is 1.
 */
export function boardRunExitCode(
  result: Pick<RunBoardResult, "verdict" | "incompleteItems" | "promotion">,
  options: { readonly requirePromotion?: boolean } = {},
): 0 | 1 {
  if (result.verdict !== "verified" || result.incompleteItems.length > 0) {
    return 1;
  }
  return options.requirePromotion && result.promotion?.committed !== true ? 1 : 0;
}

/**
 * The tool registry of a run, from the board: each tool, its builder, its own
 * gate's evidence, its versions, and who used it (all from recorded messages).
 */
export function formatToolRegistry(result: Pick<RunBoardResult, "state" | "log" | "toolAuthorLabel">): string[] {
  const proposals = Object.values(result.state.tools.proposed);
  if (proposals.length === 0) {
    return [];
  }
  const allGates = result.log.filter((m) => m.type === "tool.gated");
  const passedGates = allGates.filter((m) => m.type === "tool.gated" && m.payload.passed).length;
  const builds = result.log.filter((m) => m.type === "tool.built").length;
  const uses = result.log.filter((m) => m.type === "tool.used").length;
  const lines = [
    `  tools: ${proposals.length} proposed, ${builds} built, ${allGates.length} gated (${passedGates} passed, ${allGates.length - passedGates} failed), ` +
      `${result.state.tools.published.length} version(s) published, ${uses} use(s)${result.toolAuthorLabel ? ` (author: ${result.toolAuthorLabel})` : ""}`,
  ];
  for (const proposal of proposals) {
    const item = result.state.items[proposal.item];
    const versions = result.state.tools.published.filter((t) => t.capability === proposal.capability);
    const gates = result.log.filter((m): m is Extract<BoardMessage, { type: "tool.gated" }> => m.type === "tool.gated" && m.payload.capability === proposal.capability);
    const uses = result.log.filter((m): m is Extract<BoardMessage, { type: "tool.used" }> => m.type === "tool.used" && m.payload.capability === proposal.capability);
    const users = [...new Set(uses.map((m) => m.payload.by))];
    const status =
      versions.length > 0
        ? `published ${versions.map((v) => `v${v.version} (commit ${v.commit.slice(0, 10)})`).join(", ")} by ${versions.at(-1)!.publishedBy}`
        : item?.status === "rejected"
          ? "rejected by the lead"
          : item?.status === "proposed"
            ? "awaiting the lead"
            : gates.length > 0
              ? `NOT published: its own gate failed ${gates.length} time(s)`
              : `not built (item ${item?.status ?? "?"})`;
    lines.push(`    ${proposal.kind} ${proposal.capability}: proposed by ${proposal.proposedBy}; ${status}`);
    const reopened = item?.exhaustedBy?.length ?? 0;
    lines.push(
      `      builds ${proposal.builds}, gates ${gates.filter((g) => g.payload.passed).length} passed / ${gates.filter((g) => !g.payload.passed).length} failed` +
        (reopened > 0 ? `, reopened for another builder ${reopened} time(s) (spent by ${item!.exhaustedBy!.join(", ")})` : "") +
        (item?.status === "claimed" && versions.length === 0 ? `, held by ${item.owner}` : ""),
    );
    const unavailable = toolUnavailableReason(result.state, proposal.capability);
    if (unavailable !== undefined) {
      lines.push(`      unavailable to the items it covers (they edit by hand): ${unavailable}`);
    }
    const last = gates.at(-1);
    if (last) {
      lines.push(`      tool gate (seq ${last.seq}): ${last.payload.checks.map((c) => `${c.check} ${c.passed ? "ok" : "FAIL"}: ${c.detail}`).join("; ").slice(0, 600)}`);
    }
    if (versions.some((v) => v.joinsGate === false)) {
      lines.push("      joinsGate: false (a check tool does not join the Change's gate in this slice)");
    }
    if (uses.length > 0) {
      lines.push(`      used ${uses.length} time(s) by ${users.join(", ")} (seqs ${uses.map((m) => m.seq).join(", ")})`);
    }
  }
  const generated = Object.values(result.state.items).filter((i) => i.fromTool !== undefined);
  for (const item of generated) {
    lines.push(`    work from ${item.fromTool!.capability}@${item.fromTool!.version} findings: ${item.id} [${item.scopeHint.join(", ")}] (${item.status === "done" ? "completed" : item.status})`);
  }
  return lines;
}

/** A readable summary of a board run. */
/** How early a codemod was used: items it changed before any hand edit of them, and covered items edited by hand first. */
export interface CodemodTiming {
  readonly capability: string;
  /** Items whose FIRST push was the codemod's (no hand edit before it). */
  readonly early: readonly string[];
  /** Items the codemod's inputs cover whose first push was a hand edit. */
  readonly handFirst: readonly string[];
}

/**
 * Codemod timing, from the log alone: for each codemod, the items whose first
 * push came from a recorded use of it (`tool.used` with the push's commit)
 * before any hand-edited push of the item, and the covered items edited by
 * hand first. A sub-lead merge or a pulled help push is neither.
 */
export function codemodTiming(log: readonly BoardMessage[], state: BoardState): CodemodTiming[] {
  const toolCommits = new Map<string, string>();
  for (const m of log) {
    if (m.type === "tool.used" && m.payload.commit !== undefined) {
      toolCommits.set(m.payload.commit, m.payload.capability);
    }
  }
  const firstPush = new Map<string, { readonly kind: "tool" | "hand" | "other"; readonly capability?: string }>();
  for (const m of log) {
    if (m.type !== "push.announced" || firstPush.has(m.payload.item)) {
      continue;
    }
    const capability = toolCommits.get(m.payload.commit);
    firstPush.set(
      m.payload.item,
      capability !== undefined ? { kind: "tool", capability } : m.payload.merges !== undefined || m.payload.pulled !== undefined ? { kind: "other" } : { kind: "hand" },
    );
  }
  return Object.values(state.tools.proposed)
    .filter((t) => t.kind === "codemod")
    .map((t) => {
      const covered = Object.values(state.items).filter(
        (i) => isChangeItem(i) && i.scopeHint.some((h) => t.inputs.some((input) => entriesOverlap(h, input))),
      );
      return {
        capability: t.capability,
        early: [...firstPush].filter(([, f]) => f.kind === "tool" && f.capability === t.capability).map(([item]) => item),
        handFirst: covered.filter((i) => firstPush.get(i.id)?.kind === "hand").map((i) => i.id),
      };
    });
}

/** Formation lines from the log: each split (sub-lead, children, merges) and each fork-based help. */
export function formatFormation(log: readonly BoardMessage[], state: BoardState): string[] {
  const lines: string[] = [];
  const grantedTo = new Map<string, string>();
  for (const m of log) {
    if (m.type === "claim.granted" && !grantedTo.has(m.payload.item)) {
      grantedTo.set(m.payload.item, m.payload.agent);
    }
  }
  for (const m of log) {
    if (m.type === "item.split") {
      const parent = state.items[m.payload.item];
      const merges = log.filter((x) => x.type === "push.announced" && x.payload.item === m.payload.item && x.payload.merges !== undefined).map((x) => x.seq);
      lines.push(
        `    split ${m.payload.item} (seq ${m.seq}): ${m.from} is its sub-lead; children ${m.payload.children
          .map((c) => `${c.item} ${grantedTo.has(c.item) ? `claimed by ${grantedTo.get(c.item)}` : "unclaimed"}`)
          .join(", ")}; sub-lead push(es) merging them: ${merges.length > 0 ? `seq ${merges.join(", ")}` : "none"}; ${
          parent?.status === "done" ? `done via rev ${parent.completed?.n ?? "?"}` : `not done (${parent?.status ?? "?"})`
        }`,
      );
    }
    if (m.type === "help.requested" && m.payload.scope !== undefined) {
      const offered = log.find((x) => x.type === "help.offered" && x.payload.request === m.payload.request && x.payload.forkOf !== undefined);
      const delivered = log.filter((x) => x.type === "help.delivered" && x.payload.request === m.payload.request).at(-1);
      const pulled = log.find((x) => x.type === "push.announced" && (x.payload.pulled ?? []).includes(m.payload.request));
      lines.push(
        `    help ${m.payload.request} on ${m.payload.item} (seq ${m.seq}, grants ${m.payload.scope.join(", ")}): ` +
          (offered && offered.type === "help.offered"
            ? `${offered.from} forked ${m.from}'s repo at ${offered.payload.forkCommit?.slice(0, 10) ?? "its empty state"} (seq ${offered.seq}${offered.payload.fork ? `, fork ${offered.payload.fork}` : ""})`
            : "nobody took it") +
          (delivered && delivered.type === "help.delivered" ? `; delivered ${delivered.payload.commit.slice(0, 10)} (seq ${delivered.seq})` : "") +
          (pulled ? `; ${m.from} pulled it (seq ${pulled.seq})` : ""),
      );
    }
  }
  for (const m of log) {
    if (m.type === "help.volunteered") {
      const grant = log.find((x) => x.type === "help.requested" && x.seq > m.seq && x.payload.item === m.payload.item && x.payload.scope !== undefined && (x.to ?? []).includes(m.from));
      const declined = log.find((x) => x.type === "help.declined" && x.seq > m.seq && x.payload.item === m.payload.item && x.payload.volunteer === m.from);
      const report = [...log].reverse().find((x) => x.type === "item.struggling" && x.seq < m.seq && x.payload.item === m.payload.item);
      lines.push(
        `    volunteer ${m.from} on ${m.payload.item} (seq ${m.seq}${report && report.type === "item.struggling" ? `, after ${report.from}'s struggling report at seq ${report.seq}: ${report.payload.reason}` : ""}): ` +
          (grant && grant.type === "help.requested" ? `granted ${grant.payload.scope!.join(", ")} (help ${grant.payload.request}, seq ${grant.seq})` : declined ? `declined (seq ${declined.seq})` : "unanswered"),
      );
    }
  }
  return lines.length > 0 ? ["  formation:", ...lines] : [];
}

export function formatBoardRunSummary(result: RunBoardResult): string {
  // Only accepted items count: a worker's proposal the lead rejected (or never
  // decided) is not part of the Change.
  const items = Object.values(result.state.items).filter(isChangeItem);
  const done = items.filter((i) => i.status === "done").length;
  const waits = result.turns.filter((t) => t.action.type === "wait").length;
  const invalid = result.turns.filter((t) => t.invalid !== undefined).length;
  const rejected = result.turns.filter((t) => t.outcome === "rejected" || t.outcome === "local").filter((t) => t.code !== undefined);
  const lines = [
    `Board run for ${result.changeId}`,
    `  planner: ${result.seed.source}${result.seed.model ? ` (${result.seed.model})` : ""}, ${result.seed.items.length} item(s) proposed`,
    `  agents: ${result.agents.map((a) => `${a.id}${a.role === "lead" ? " (lead)" : ""}${a.stop ? ` [stopped: ${a.stop.detail}]` : ""}`).join(", ")}`,
    `  turns: ${result.turns.length} (${waits} wait(s), ${invalid} invalid model output(s), ${rejected.length} refused action(s))`,
    `  agent phase ended: ${result.stopReason}${result.stopDetail ? ` (${result.stopDetail})` : ""}`,
    ...(result.budgets
      ? [
          `  budgets: ${result.budgets.maxFixAttempts} fix attempt(s) per item (${result.budgets.fixAttemptsScaled ? `scaled with ${result.budgets.items} planned item(s)` : "explicit"}), dial max ${result.budgets.dialMax} (${result.budgets.dialScaled ? `scaled with ${result.budgets.items} planned item(s)` : "explicit"}), ${result.budgets.maxRunTurns} run turn(s) (${result.budgets.runTurnsScaled ? `scaled with ${result.budgets.items} planned item(s)` : "explicit"})`,
        ]
      : []),
    ...(result.gateLabel !== undefined ? [`  gate: ${result.gateLabel}`] : []),
    `  baseline gate inventory: ${result.testInventory}`,
    `  immutable acceptance gate (never changed by any agent, no contract route): ${(result.immutable ?? []).join(", ") || "none"}`,
    `  contract-changeable developer tests and configs (changing one needs a human-accepted contract): ${result.protected.filter((p) => !(result.immutable ?? []).includes(p)).join(", ") || "none"}`,
    ...(result.protectedKeys.length > 0 ? [`  contract keys (restored before every gate run): ${result.protectedKeys.join(", ")}`] : []),
  ];
  for (const r of rejected) {
    lines.push(`    refused: ${r.agent} turn ${r.turn} ${r.action.type}: ${r.code} ${r.error ?? ""}`.trimEnd());
  }
  if (result.revisions.length > 0) {
    let previous: { passed: number; acceptance: boolean } | undefined;
    for (let rev of result.revisions) {
      lines.push(
        `  integrated revision ${rev.n}: ${rev.gated ? `gate ${rev.gate}` : "no gate: nothing checked"}, commit ${rev.commit.slice(0, 12)}, merged ${rev.merged.length} push(es) (items ${rev.integratedItems.join(", ") || "none"})`,
      );
      // From the board (both integrators record it there), else the local record.
      const recordedProgress = result.log.find((m) => m.type === "integrated.rev" && m.payload.n === rev.n);
      const progressOf = recordedProgress?.type === "integrated.rev" ? (recordedProgress.payload.progress ?? rev.progress) : rev.progress;
      if (progressOf) {
        rev = { ...rev, progress: progressOf };
      }
      if (rev.progress) {
        const headline = progressHeadline(rev.progress);
        const delta =
          headline === undefined || previous === undefined || previous.acceptance !== headline.acceptance
            ? ""
            : ` (${headline.passed - previous.passed >= 0 ? "+" : ""}${headline.passed - previous.passed})`;
        lines.push(`    rev ${rev.n}: ${describeProgress(rev.progress)}${delta} (advisory; the gate decides)`);
        previous = headline ?? previous;
      }
      if (rev.install) {
        lines.push(`    dependency install: ${formatDependencyInstall(rev.install)}`);
      }
      if (rev.failure) {
        lines.push(`    failure: ${rev.failure}`);
      }
      if (rev.inventoryNote) {
        lines.push(`    test inventory: ${rev.inventoryNote}`);
      }
      if (rev.implicated) {
        lines.push(`    implicated (${rev.implicated.source}): ${rev.implicated.items.join(", ") || "none"}`);
      }
      if (rev.fixRequested && rev.fixRequested.length > 0) {
        lines.push(`    fix requested: ${rev.fixRequested.join(", ")}`);
      }
      if (rev.fixExhausted && rev.fixExhausted.length > 0) {
        lines.push(`    fix budget spent (reopened for another agent): ${rev.fixExhausted.join(", ")}`);
      }
      for (const ex of rev.excludedAgents) {
        lines.push(`    excluded ${ex.agent}: ${ex.reason}`);
      }
    }
  } else {
    lines.push("  integrated revision: none (nothing was pushed)");
  }
  for (const reason of result.integrationFailures) {
    lines.push(`  integration not recorded: ${reason}`);
  }
  const decisions = result.state.decisions;
  if (decisions && decisions.calls > 0) {
    lines.push(`  jev: ${decisions.calls} call(s), ${decisions.accepted} accepted, ${decisions.errors} error(s)`);
    // Advisory accuracy, decided by what changed before the next passing gate.
    lines.push(`  ${formatAttributionTally(boardAttributionTally(result.state))}`);
  }
  lines.push(...formatToolRegistry(result));
  for (const timing of codemodTiming(result.log, result.state)) {
    lines.push(
      `  tool timing: codemod ${timing.capability} changed ${timing.early.length} item(s) before any hand edit of them (${timing.early.join(", ") || "none"}); covered items edited by hand first: ${timing.handFirst.join(", ") || "none"}`,
    );
  }
  lines.push(...formatFormation(result.log, result.state));
  if ((result.editModels ?? []).length > 0) {
    const counts = new Map<string, number>();
    for (const e of result.editModels ?? []) counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
    const strongest = (result.editModels ?? []).filter((e) => e.why !== undefined && e.model !== "base");
    lines.push(
      `  edit models: ${[...counts].map(([m, n]) => `${m} x${n}`).join(", ")}` +
        (strongest.length > 0 ? `; strongest for complex items: ${[...new Set(strongest.map((e) => `${e.item} (${e.why})`))].join(", ")}` : ""),
    );
  }
  const forks = result.cleanedUp.filter((name) => name.includes("--help-"));
  if (result.cleanedUp.length > 0) {
    lines.push(`  repos archived at cleanup: ${result.cleanedUp.length}${forks.length > 0 ? ` (help fork(s): ${forks.join(", ")})` : ""}`);
  }
  const proposals = result.proposals ?? proposalOutcomes(result.state, result.log);
  const notCounted = [
    ...(proposals.rejected.length > 0 ? [`${proposals.rejected.length} worker proposal(s) rejected`] : []),
    ...(proposals.undecided.length > 0 ? [`${proposals.undecided.length} undecided`] : []),
  ];
  lines.push(`  items completed: ${done} of ${items.length}${notCounted.length > 0 ? ` (${notCounted.join(", ")}: not counted)` : ""}`);
  for (const r of proposals.rejected) {
    lines.push(`    proposal rejected: ${r.item} by ${r.by}${r.rationale ? `: ${r.rationale.slice(0, 200)}` : ""}`);
  }
  for (const id of proposals.undecided) {
    lines.push(`    proposal undecided (the lead never accepted or rejected it): ${id}`);
  }
  for (const reason of result.incompleteReasons ?? []) {
    lines.push(`    not completed: ${reason}`);
  }
  const incomplete =
    result.verdict !== "failed" && result.incompleteItems.length > 0
      ? ` (partial: ${result.incompleteItems.length} item(s) not completed: ${result.incompleteItems.join(", ")}; the Change is not complete)`
      : "";
  lines.push(
    result.verdict === "unverified"
      ? `  verdict: unverified (no gate configured: nothing checked)${incomplete}${result.revision ? ` (the last revision, ${result.revision.n})` : ""}`
      : `  verdict: ${result.verdict}${incomplete}${result.revision ? ` (the gate of the last revision, ${result.revision.n})` : ""}`,
  );
  if (result.partial) {
    lines.push(`    partial: ${result.partial}`);
  }
  if (result.promotion) {
    lines.push(
      result.promotion.committed
        ? `  ${result.verdict === "unverified" ? "promoted unverified (no gate)" : "promoted"}: branch ${result.promotion.branch} commit ${result.promotion.commit.slice(0, 12)}${result.sourceRepoDir ? `\n  repo: ${result.sourceRepoDir}` : ""}`
        : `  not promoted: ${result.promotion.refusedReason ?? "nothing to commit"}`,
    );
  } else {
    lines.push("  not promoted: nothing was integrated");
  }
  if (result.deployment) {
    lines.push(`  redeployed: ${result.deployment.url}`);
  }
  return lines.join("\n");
}

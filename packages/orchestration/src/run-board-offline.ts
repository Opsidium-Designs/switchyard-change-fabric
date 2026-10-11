/**
 * run-board-offline: the board run with no network and no credentials.
 *
 * It drives the same `runBoard` against the in-process local control (the
 * offline stand-in that serves the same board routes as the Worker), with the
 * deterministic generic policy as the turn transport, the deterministic
 * scoped executor, the honest local workspace fallback for every agent's repo,
 * and the heuristic decomposition as the lead's planner (the offline stub, never
 * a live substitute). With a fixed clock, lockstep scheduling, and fixed Git
 * commit dates, two runs of the same goal on the same project produce
 * byte-identical board logs.
 *
 * The demo can run the generic offline gate FIXTURE (`FirstAttemptFailingGate`)
 * so the run shows the fix loop: it fails the first integrated revision, naming
 * one file that revision changed, and passes once that file has been edited
 * again. It knows nothing about any app or goal, and it is labelled as a
 * fixture wherever it is used. Offline ONLY, it may replace a project's
 * declared gate (`replacesDeclaredGate`): the noop executor can never satisfy
 * a real gate, so the demo then shows coordination, not a real fix, and says
 * so. A live run always uses the project's declared gate. The fixture needs
 * no dependencies, so no dependency install runs for it.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { BoardDigest, BoardMessage, ConcurrencyDial } from "@switchyard-change/change-core";
import type { AgentTurnTransport, ExecutorProvider } from "@switchyard-change/model-adapters";
import { NO_DEPENDENCY_INSTALL, type CommandOutcome, type CommandRunner as VerificationCommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "./board-policy.ts";
import { templateToolAuthor, type ToolAuthor } from "./board-tools.ts";
import { decomposeGoal } from "./decompose-goal.ts";
import { LocalChangeControl } from "./local-control.ts";
import {
  boardSeedFromChange,
  runBoard,
  type BoardRunBudgets,
  type BoardRunEvent,
  type BoardSeed,
  type RunBoardOptions,
  type RunBoardResult,
} from "./run-board.ts";

/** The fixed instant offline board stamps and Git commit dates start from. */
export const OFFLINE_BOARD_EPOCH = "2026-01-01T00:00:00.000Z";

/** The label shown wherever the offline fixture gate replaces a project's declared gate. */
export function offlineFixtureGateLabel(declared: readonly string[]): string {
  return `offline fixture gate replaces the project's declared gate (${declared.join(" ")}); this demo shows coordination, not a real fix`;
}

/** How the offline run labels its tool author. */
export const OFFLINE_TOOL_AUTHOR_LABEL =
  "the deterministic offline template author (the noop executor cannot write a tool; each tool still passes its own gate)";

/** The argv the offline gate fixture is wired as (it is never executed as a process). */
export const OFFLINE_GATE_FIXTURE_COMMAND: readonly string[] = ["node", "--offline-gate-fixture"];

const git = promisify(execFile);

/**
 * A generic, deterministic stand-in for a project's gate, for offline demos and
 * tests of the fix loop. Its FIRST run fails, naming the first file (sorted)
 * the integrated commit changed relative to its parent; every later run passes
 * once that file's content differs from what the first run saw (the implicated
 * owner pushed a fix), and fails again while it does not. It reads only the
 * integrated tree it is run in, so it works the same on any project.
 */
export class FirstAttemptFailingGate implements VerificationCommandRunner {
  /** Every outcome, in order (what the gate saw on each run). */
  readonly runs: { readonly passed: boolean; readonly file?: string }[] = [];
  private target: { readonly file: string; readonly content: string | undefined } | undefined;

  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    if (this.target === undefined) {
      const { stdout } = await git("git", ["-C", cwd, "diff", "--name-only", "HEAD~1", "HEAD"]).catch(() => ({ stdout: "" }));
      const file = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .sort()[0];
      if (file === undefined) {
        this.runs.push({ passed: true });
        return { code: 0, stdout: "ok 1 - offline gate fixture\n# nothing changed\n", stderr: "" };
      }
      this.target = { file, content: await readFile(`${cwd}/${file}`, "utf8").catch(() => undefined) };
      return this.fail(file, "the first integrated revision always fails");
    }
    const now = await readFile(`${cwd}/${this.target.file}`, "utf8").catch(() => undefined);
    if (now === this.target.content) {
      return this.fail(this.target.file, "the file the first run failed on has not been fixed yet");
    }
    this.runs.push({ passed: true, file: this.target.file });
    return { code: 0, stdout: `ok 1 - offline gate fixture\n# ${this.target.file} was fixed\n`, stderr: "" };
  }

  private fail(file: string, why: string): CommandOutcome {
    this.runs.push({ passed: false, file });
    return {
      code: 1,
      stdout: `not ok 1 - offline gate fixture\n# FAILED on ${file}: ${why}\n`,
      stderr: `AssertionError: ${file} does not satisfy the offline gate fixture yet\n`,
    };
  }
}

/** Options for an offline board run. */
export interface RunBoardOfflineOptions {
  readonly goal: string;
  readonly projectDir: string;
  readonly changeId?: string;
  readonly dial?: ConcurrencyDial;
  /** Scale the dial's max with the plan size (no explicit --max). */
  readonly scaleDial?: boolean;
  readonly budgets?: BoardRunBudgets;
  /** Cost and time caps (see RunBoardOptions.caps), and their clock. */
  readonly caps?: RunBoardOptions["caps"];
  readonly capsClock?: () => number;
  /** Defaults to the generic policy. */
  readonly transport?: AgentTurnTransport<BoardDigest, BoardMessage>;
  /** Defaults to the heuristic decomposition of the goal. */
  readonly seed?: (goal: string) => Promise<BoardSeed>;
  /** Defaults to the scoped deterministic executor. */
  readonly executor?: ExecutorProvider;
  readonly appGateCommand?: readonly string[];
  readonly requireAppGate?: boolean;
  readonly verifyCommandRunner?: VerificationCommandRunner;
  /**
   * Use the generic offline gate fixture as the gate (for a project that has
   * none): the first revision fails and the fix loop runs. Ignored when an
   * explicit gate command is given.
   */
  readonly fixtureGate?: boolean;
  /**
   * The project's declared gate command the fixture REPLACES (offline only),
   * for the label: "offline fixture gate replaces the project's declared gate
   * (...); this demo shows coordination, not a real fix".
   */
  readonly replacesDeclaredGate?: readonly string[];
  /** Installs a gated tree's dependencies (see RunBoardOptions.dependencyInstaller); the fixture gate never installs. */
  readonly dependencyInstaller?: RunBoardOptions["dependencyInstaller"];
  readonly escalationModels?: readonly string[];
  /** A typed-decision caller (advisory; see RunBoardOptions.jev). Offline runs pass a fake. */
  readonly jev?: RunBoardOptions["jev"];
  readonly jevThreshold?: number;
  /** The decision model's id for the meter (see RunBoardOptions.jevModel). */
  readonly jevModel?: string;
  /** The human's decision on contract changes to the original tests (see RunBoardOptions.resolveContract). */
  readonly resolveContract?: RunBoardOptions["resolveContract"];
  readonly workRoot?: string;
  /**
   * Who writes agent-built tools (default: the deterministic offline template
   * author; the noop executor cannot write a tool). Tools still pass their own gate.
   */
  readonly toolAuthor?: ToolAuthor;
  /** The limit on one tool run (and its tests), in ms (see RunBoardOptions.toolTimeoutMs). */
  readonly toolTimeoutMs?: number;
  /**
   * Speculative batch gating (see RunBoardOptions.speculate; default 3). The
   * offline run gates its candidates one after another, in order, so the log
   * stays byte-identical run to run.
   */
  readonly speculate?: number;
  /** Goal rules to post (see RunBoardOptions.rules); `{ arbitration: 1 }` pins the pre-revision arbitration. */
  readonly rules?: RunBoardOptions["rules"];
  /** Pin Git author and committer dates for the run so commit ids repeat (default true). */
  readonly fixedGitDates?: boolean;
  readonly onEvent?: (event: BoardRunEvent) => void;
  /** An operator stop (SIGINT/SIGTERM in the CLI): see RunBoardOptions.signal. */
  readonly signal?: AbortSignal;
  /** After an interrupt: the wait for the agents and the in-flight integration, in ms. */
  readonly interruptGraceMs?: number;
}

/** Run a board offline and deterministically. */
export async function runBoardOffline(options: RunBoardOfflineOptions): Promise<RunBoardResult> {
  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), "scf-board-offline-")));
  const epoch = Date.parse(OFFLINE_BOARD_EPOCH);
  let tick = 0;
  // One second per board append: a readable, repeatable timeline.
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "repos") }), {
    now: () => new Date(epoch + 1000 * tick++),
  });
  const pinDates = options.fixedGitDates ?? true;
  const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
  if (pinDates) {
    process.env.GIT_AUTHOR_DATE = OFFLINE_BOARD_EPOCH;
    process.env.GIT_COMMITTER_DATE = OFFLINE_BOARD_EPOCH;
  }
  try {
    const result = await runBoard({
      goal: options.goal,
      projectDir: options.projectDir,
      changeId: options.changeId ?? "change-board-offline",
      workerUrl: "http://local-control",
      fetchFn: control.fetch as unknown as typeof fetch,
      dial: options.dial ?? { minConcurrency: 1, maxConcurrency: 3 },
      ...(options.scaleDial ? { scaleDial: true } : {}),
      transport: options.transport ?? createGenericBoardPolicy(),
      seed:
        options.seed ??
        (async (goal) => boardSeedFromChange((await decomposeGoal({ goal, projectDir: options.projectDir })).change)),
      ...(options.executor ? { executor: options.executor } : {}),
      schedule: "lockstep",
      ...(options.speculate !== undefined ? { speculate: options.speculate } : {}),
      // Candidates in order, one at a time: a deterministic log.
      candidateConcurrency: 1,
      ...(options.budgets ? { budgets: options.budgets } : {}),
      ...(options.rules ? { rules: options.rules } : {}),
      ...(options.caps ? { caps: options.caps } : {}),
      ...(options.capsClock ? { capsClock: options.capsClock } : {}),
      workRoot: join(workRoot, "run"),
      ...(options.appGateCommand
        ? { appGateCommand: options.appGateCommand }
        : options.fixtureGate
          ? { appGateCommand: OFFLINE_GATE_FIXTURE_COMMAND }
          : {}),
      ...(options.requireAppGate ? { requireAppGate: true } : {}),
      // The fixture replaces RUNNING the declared gate, never the contract it defines.
      ...(options.fixtureGate && options.replacesDeclaredGate ? { contractGateCommand: options.replacesDeclaredGate } : {}),
      ...(options.verifyCommandRunner
        ? { verifyCommandRunner: options.verifyCommandRunner }
        : options.fixtureGate && !options.appGateCommand
          ? { verifyCommandRunner: new FirstAttemptFailingGate() }
          : {}),
      ...(options.dependencyInstaller ? { dependencyInstaller: options.dependencyInstaller } : {}),
      ...(options.fixtureGate && !options.appGateCommand
        ? {
            // The fixture reads only the integrated tree: it needs no dependencies.
            dependencyInstaller: NO_DEPENDENCY_INSTALL,
            gateLabel: options.replacesDeclaredGate
              ? `${offlineFixtureGateLabel(options.replacesDeclaredGate)}`
              : "the generic offline gate FIXTURE (the project has no gate of its own); this demo shows coordination, not a real fix",
          }
        : {}),
      ...(options.escalationModels ? { escalationModels: options.escalationModels } : {}),
      ...(options.resolveContract ? { resolveContract: options.resolveContract } : {}),
      ...(options.jev ? { jev: options.jev } : {}),
      ...(options.jevThreshold !== undefined ? { jevThreshold: options.jevThreshold } : {}),
      ...(options.jevModel !== undefined ? { jevModel: options.jevModel } : {}),
      toolAuthor: options.toolAuthor ?? templateToolAuthor,
      ...(options.toolTimeoutMs !== undefined ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
      ...(options.toolAuthor === undefined ? { toolAuthorLabel: OFFLINE_TOOL_AUTHOR_LABEL } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.interruptGraceMs !== undefined ? { interruptGraceMs: options.interruptGraceMs } : {}),
    });
    // The whole scratch directory: the offline control's repos and the run's work root.
    return { ...result, scratchRoot: workRoot };
  } finally {
    if (pinDates) {
      for (const [key, value] of [
        ["GIT_AUTHOR_DATE", saved.author],
        ["GIT_COMMITTER_DATE", saved.committer],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }
}

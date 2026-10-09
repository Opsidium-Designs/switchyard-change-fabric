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
 * For a project without a gate of its own, the demo can run the generic
 * offline gate FIXTURE (`FirstAttemptFailingGate`) so the run shows the fix
 * loop: it fails the first integrated revision, naming one file that revision
 * changed, and passes once that file has been edited again. It knows nothing
 * about any app or goal, and it is labelled as a fixture wherever it is used.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { BoardDigest, BoardMessage, ConcurrencyDial } from "@switchyard-change/change-core";
import type { AgentTurnTransport, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner as VerificationCommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "./board-policy.ts";
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
  readonly budgets?: BoardRunBudgets;
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
  readonly escalationModels?: readonly string[];
  /** A typed-decision caller (advisory; see RunBoardOptions.jev). Offline runs pass a fake. */
  readonly jev?: RunBoardOptions["jev"];
  readonly jevThreshold?: number;
  /** The human's decision on contract changes to the original tests (see RunBoardOptions.resolveContract). */
  readonly resolveContract?: RunBoardOptions["resolveContract"];
  readonly workRoot?: string;
  /** Pin Git author and committer dates for the run so commit ids repeat (default true). */
  readonly fixedGitDates?: boolean;
  readonly onEvent?: (event: BoardRunEvent) => void;
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
    return await runBoard({
      goal: options.goal,
      projectDir: options.projectDir,
      changeId: options.changeId ?? "change-board-offline",
      workerUrl: "http://local-control",
      fetchFn: control.fetch as unknown as typeof fetch,
      dial: options.dial ?? { minConcurrency: 1, maxConcurrency: 3 },
      transport: options.transport ?? createGenericBoardPolicy(),
      seed:
        options.seed ??
        (async (goal) => boardSeedFromChange((await decomposeGoal({ goal, projectDir: options.projectDir })).change)),
      ...(options.executor ? { executor: options.executor } : {}),
      schedule: "lockstep",
      ...(options.budgets ? { budgets: options.budgets } : {}),
      workRoot: join(workRoot, "run"),
      ...(options.appGateCommand
        ? { appGateCommand: options.appGateCommand }
        : options.fixtureGate
          ? { appGateCommand: OFFLINE_GATE_FIXTURE_COMMAND }
          : {}),
      ...(options.requireAppGate ? { requireAppGate: true } : {}),
      ...(options.verifyCommandRunner
        ? { verifyCommandRunner: options.verifyCommandRunner }
        : options.fixtureGate && !options.appGateCommand
          ? { verifyCommandRunner: new FirstAttemptFailingGate() }
          : {}),
      ...(options.escalationModels ? { escalationModels: options.escalationModels } : {}),
      ...(options.resolveContract ? { resolveContract: options.resolveContract } : {}),
      ...(options.jev ? { jev: options.jev } : {}),
      ...(options.jevThreshold !== undefined ? { jevThreshold: options.jevThreshold } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
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

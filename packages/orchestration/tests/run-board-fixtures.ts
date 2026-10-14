/**
 * Shared fixtures for the board-run end-to-end tests (run-board.e2e.test.ts and
 * its themed siblings): a small project whose planned scopes nest, a fake
 * planner seed, fixed and scripted gates, a model-stamping executor, the
 * offline runner with the human's default contract answer (reject), and a
 * local control for direct runBoard calls. No network: every turn, edit, and
 * gate is deterministic.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { BoardMessage } from "@switchyard-change/change-core";
import type { ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import type { BoardSeed, RunBoardOptions } from "../src/run-board.ts";

export const git = promisify(execFile);
export const GOAL = "Make every module report its status";

/** A small project whose planned scopes nest (one item's scope contains others). */
export async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-board-project-"));
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p","scripts":{}}\n',
    "src/index.ts": "export * from './core/a';\n",
    "src/core/a.ts": "export const a = 1;\n",
    "src/core/b.ts": "export const b = 2;\n",
    "src/api/handler.ts": "export const handler = () => 1;\n",
    "tests/core.test.ts": "// tests\n",
  })) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

/** A fake planner: four units whose scopes nest, like a real decomposition can. */
export const seed = async (): Promise<BoardSeed> => ({
  source: "planner",
  model: "fake-planner",
  items: [
    { item: "core", objective: "report status from core", acceptance: ["gate passes"], scopeHint: ["src/core/**"] },
    { item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
    { item: "wiring", objective: "wire the status report", acceptance: ["gate passes"], scopeHint: ["src/**"] },
    { item: "tests", objective: "test the status report", acceptance: ["gate passes"], scopeHint: ["tests/**"] },
  ],
});

/** A gate runner with a fixed exit code that records where it ran. */
export class FixedGate implements CommandRunner {
  readonly ran: string[] = [];
  constructor(private readonly code: number) {}
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    this.ran.push(cwd);
    return { code: this.code, stdout: this.code === 0 ? "ok" : "", stderr: this.code === 0 ? "" : "gate failed" };
  }
}

/** A gate that passes the baseline run and the first revision, and fails every later one. */
export class PassOnceGate implements CommandRunner {
  private runs = 0;
  async run(): Promise<CommandOutcome> {
    this.runs += 1;
    return this.runs <= 2 ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "regressed" };
  }
}

/** An executor that writes the attempt's model into every in-scope file and records its contexts. */
export class ModelStampingExecutor implements ExecutorProvider {
  readonly name = "model-stamping";
  readonly contexts: ExecutorContext[] = [];
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    this.contexts.push(context);
    const written: string[] = [];
    for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
      await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
      await writeFile(join(context.worktreeDir, path), `// ${context.workUnitId} on ${context.model ?? "base"} (${this.contexts.length})\n`);
      written.push(path);
    }
    return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `edit ${context.workUnitId}` };
  }
}

/** A gate that fails, naming src/api/handler.ts, until that file was written on model "m2". */
export class NeedsSecondEscalationGate implements CommandRunner {
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const handler = await readFile(join(cwd, "src/api/handler.ts"), "utf8");
    return handler.includes(" on m2 ")
      ? { code: 0, stdout: "ok 1 - handler\n", stderr: "" }
      : { code: 1, stdout: "not ok 1 - handler\n# src/api/handler.ts does not report status yet\n", stderr: "" };
  }
}

export const types = (log: readonly BoardMessage[]) => log.map((m) => m.type);

/** The human's answer to contract changes on the original tests in these runs: reject (the default). */
export const reject = async () => "reject" as const;
export const offline = (options: Parameters<typeof runBoardOffline>[0]) => runBoardOffline({ resolveContract: reject, ...options });
export const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T): Extract<BoardMessage, { type: T }>[] =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

export async function treeOf(dir: string, ref: string): Promise<string> {
  return (await git("git", ["-C", dir, "rev-parse", `${ref}^{tree}`])).stdout.trim();
}

/** A local control plus the options every direct runBoard call shares. */
export async function direct(id: string): Promise<{ control: LocalChangeControl; root: string; base: Omit<RunBoardOptions, "projectDir"> }> {
  const root = await mkdtemp(join(tmpdir(), `scf-${id}-`));
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
  return {
    control,
    root,
    base: {
      goal: GOAL,
      changeId: id,
      workerUrl: "http://local-control",
      fetchFn: control.fetch as unknown as typeof fetch,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      transport: createGenericBoardPolicy(),
      seed,
      resolveContract: reject,
      workRoot: join(root, "work"),
    },
  };
}

/**
 * The board run end to end on the offline local control: the lead seeds items
 * from a (fake) planner, workers join under the dial and claim them, an
 * overlapping claim is contested and resolved by narrowing, a worker asks a
 * `to`-addressed question and gets a reply, every worker pushes from its own
 * repo, and the CONTINUOUS integrator records a revision per round of pushes.
 * A failing revision asks the implicated owner for a fix, the owner fixes on
 * the next escalation model, and only the last revision, when it passes, is
 * promoted (its tree is the promoted tree). Budgets, quiescence, a throw in the
 * agent phase, a token lifetime shorter than the phase, and an unrecorded
 * verdict all end the run honestly. No network: the generic policy (or a
 * scripted transport) takes every turn and deterministic executors edit.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type {
  AskJev,
  AgentTurnTransport,
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { FirstAttemptFailingGate, runBoardOffline } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, formatBoardTranscript, runBoard, type BoardRunEvent, type BoardSeed, type RunBoardOptions } from "../src/run-board.ts";

const git = promisify(execFile);
const GOAL = "Make every module report its status";

/** A small project whose planned scopes nest (one item's scope contains others). */
async function project(): Promise<string> {
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
const seed = async (): Promise<BoardSeed> => ({
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
class FixedGate implements CommandRunner {
  readonly ran: string[] = [];
  constructor(private readonly code: number) {}
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    this.ran.push(cwd);
    return { code: this.code, stdout: this.code === 0 ? "ok" : "", stderr: this.code === 0 ? "" : "gate failed" };
  }
}

/** A gate that passes the baseline run and the first revision, and fails every later one. */
class PassOnceGate implements CommandRunner {
  private runs = 0;
  async run(): Promise<CommandOutcome> {
    this.runs += 1;
    return this.runs <= 2 ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "regressed" };
  }
}

/** An executor that writes the attempt's model into every in-scope file and records its contexts. */
class ModelStampingExecutor implements ExecutorProvider {
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
class NeedsSecondEscalationGate implements CommandRunner {
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const handler = await readFile(join(cwd, "src/api/handler.ts"), "utf8");
    return handler.includes(" on m2 ")
      ? { code: 0, stdout: "ok 1 - handler\n", stderr: "" }
      : { code: 1, stdout: "not ok 1 - handler\n# src/api/handler.ts does not report status yet\n", stderr: "" };
  }
}

const types = (log: readonly BoardMessage[]) => log.map((m) => m.type);

/** The human's answer to contract changes on the original tests in these runs: reject (the default). */
const reject = async () => "reject" as const;
const offline = (options: Parameters<typeof runBoardOffline>[0]) => runBoardOffline({ resolveContract: reject, ...options });
const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

async function treeOf(dir: string, ref: string): Promise<string> {
  return (await git("git", ["-C", dir, "rev-parse", `${ref}^{tree}`])).stdout.trim();
}

/** A local control plus the options every direct runBoard call shares. */
async function direct(id: string): Promise<{ control: LocalChangeControl; root: string; base: Omit<RunBoardOptions, "projectDir"> }> {
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

describe("runBoard (offline, lockstep, continuous integration)", () => {
  it("forms around the goal, integrates per round of pushes, completes every item, and promotes the last revision", async () => {
    const projectDir = await project();
    const events: BoardRunEvent[] = [];
    const result = await offline({ goal: GOAL, projectDir, seed, onEvent: (e) => events.push(e) });
    const log = result.log;

    // The goal carries the protected set derived from the project.
    // The goal carries the contract: the existing test, the runner configs, and the manifest's gate keys.
    expect(of(log, "goal.posted")[0]!.payload.protected).toEqual(expect.arrayContaining(["tests/core.test.ts", ".npmrc"]));
    expect(result.protected).not.toContain("package.json");
    expect(of(log, "goal.posted")[0]!.payload.protectedKeys).toEqual(expect.arrayContaining(["package.json type", "package.json packageManager", "package.json jest"]));
    // Changing the existing test is a contract change a HUMAN decides: escalated,
    // rejected here, so the tests item adds a NEW test file instead.
    expect(of(log, "contract.proposed")[0]!.payload).toMatchObject({ target: "tests/core.test.ts", item: "tests" });
    expect(of(log, "contract.escalated")[0]!.payload).toMatchObject({ target: "tests/core.test.ts", item: "tests" });
    expect(of(log, "contract.rejected").every((m) => m.from === "human")).toBe(true);
    expect(of(log, "claim.granted").find((m) => m.payload.item === "tests")!.payload.intent.write).toEqual(["tests/tests.test.ts"]);
    expect(formatBoardRunSummary(result)).toContain(`repo: ${result.sourceRepoDir}`);

    // The lead proposes (never assigns); workers join under the dial.
    expect(of(log, "item.proposed").every((m) => m.from === "lead")).toBe(true);
    expect(of(log, "agent.joined").map((m) => m.from)).toEqual(["lead", "agent-1", "agent-2", "agent-3"]);
    expect(result.seed).toMatchObject({ source: "planner", model: "fake-planner" });

    // Claims, one contest resolved by narrowing, and the claimant re-granted.
    expect(of(log, "claim.contested")[0]!.payload).toMatchObject({ claimant: "agent-3", owner: "agent-1", item: "wiring", overlap: ["src/**"] });
    expect(of(log, "claim.narrowed")[0]).toMatchObject({ from: "agent-3", payload: { write: ["src/index.ts"] } });
    expect(of(log, "claim.resolved")[0]).toMatchObject({ payload: { how: "narrowed" } });

    // A to-addressed question and its reply.
    const question = of(log, "help.requested")[0]!;
    expect(question).toMatchObject({ from: "agent-3", to: ["agent-1"], payload: { item: "wiring", need: "shared-boundary" } });
    expect(of(log, "help.offered")[0]).toMatchObject({ from: "agent-1", to: ["agent-3"], inReplyTo: question.seq });

    // Revisions are recorded AS pushes land (more than one), each by the engine,
    // and every push is merged by exactly one passing revision.
    const pushes = of(log, "push.announced");
    const revs = of(log, "integrated.rev");
    expect(revs.length).toBeGreaterThan(1);
    expect(revs.every((r) => r.from === "engine" && r.payload.gate === "pass")).toBe(true);
    expect(revs.flatMap((r) => r.payload.merged).sort()).toEqual(pushes.map((p) => p.payload.commit).sort());
    // The first revision lands before the last push is announced: integration is per push, not at the end.
    expect(revs[0]!.seq).toBeLessThan(pushes.at(-1)!.seq);
    expect(result.revisions.map((r) => r.n)).toEqual(revs.map((r) => r.payload.n));

    expect(of(log, "item.completed").map((m) => m.payload.item).sort()).toEqual(["api", "core", "tests", "wiring"]);
    expect(result.stopReason).toBe("all-items-done");

    // The verdict is the last revision's gate, and the promoted tree IS its tree.
    expect(result.verdict).toBe("verified");
    expect(result.evidence!.integration.commit).toBe(result.revision!.commit);
    expect(result.promotion).toMatchObject({ committed: true, branch: "switchyard/change-board-offline" });
    expect(await treeOf(result.sourceRepoDir!, result.promotion!.commit)).toBe(
      await treeOf(join(result.workRoot, "integration-artifacts", "change-board-offline--integration.git"), result.revision!.commit),
    );
    expect(events.some((e) => e.kind === "integration-verdict" && e.verdict === "verified")).toBe(true);

    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("is deterministic: two runs produce identical board logs", async () => {
    const projectDir = await project();
    const first = await offline({ goal: GOAL, projectDir, seed, fixtureGate: true });
    const second = await offline({ goal: GOAL, projectDir, seed, fixtureGate: true });
    expect(second.log).toEqual(first.log);
    expect(second.turns).toEqual(first.turns);
    expect(formatBoardTranscript(second.log)).toBe(formatBoardTranscript(first.log));
  });

  it("runs the fix loop: a failing revision asks the implicated owner, who fixes it and the next revision passes", async () => {
    const projectDir = await project();
    const gate = new FirstAttemptFailingGate();
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate });
    const log = result.log;
    const [first, ...rest] = of(log, "integrated.rev");
    // Rev 1 fails with bounded evidence; parse attribution names the item whose file failed.
    expect(first!.payload.gate).toBe("fail");
    const failedFile = gate.runs.find((r) => r.file !== undefined)!.file!;
    expect(first!.payload.failing!.output).toContain(failedFile);
    const owner = Object.values(result.state.items).find((i) => (i.intent?.write ?? i.scopeHint).some((w) => failedFile.startsWith(w.replace("/**", ""))));
    expect(result.revisions[0]!.implicated).toEqual({ items: first!.payload.failing!.items, source: "parse" });
    expect(first!.payload.failing!.items).toHaveLength(1);
    // The engine addresses the fix request to that item's owner only.
    const fix = of(log, "fix.requested");
    expect(fix).toHaveLength(1);
    expect(fix[0]).toMatchObject({ from: "engine", inReplyTo: first!.seq, payload: { item: first!.payload.failing!.items[0], n: 1, attempt: 1 } });
    expect(fix[0]!.to).toHaveLength(1);
    // The owner pushes again (answering the request), and a later revision passes.
    const answer = of(log, "push.announced").find((p) => p.seq > fix[0]!.seq && p.payload.item === fix[0]!.payload.item)!;
    expect(answer.from).toBe(fix[0]!.to![0]);
    expect(rest.some((r) => r.payload.gate === "pass" && r.payload.merged.includes(answer.payload.commit))).toBe(true);
    expect(owner).toBeDefined();
    // Only the LAST revision is promoted, and it passed.
    expect(result.revision!.gate).toBe("pass");
    expect(result.verdict).toBe("verified");
    expect(result.promotion).toMatchObject({ committed: true });
    expect(Object.values(result.state.items).every((i) => i.status === "done")).toBe(true);
    expect(formatBoardTranscript(log)).toMatch(/fix\.requested\s+\S+ \(rev 1, attempt 1\)/);
    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("escalates the executor model one step per fix attempt on an item", async () => {
    const projectDir = await project();
    const executor = new ModelStampingExecutor();
    const result = await offline({
      goal: GOAL,
      projectDir,
      seed,
      executor,
      escalationModels: ["m1", "m2"],
      appGateCommand: ["gate"],
      verifyCommandRunner: new NeedsSecondEscalationGate(),
    });
    const apiModels = executor.contexts.filter((c) => c.workUnitId === "api").map((c) => c.model ?? "base");
    expect(apiModels).toEqual(["base", "m1", "m2"]);
    expect(of(result.log, "fix.requested").filter((m) => m.payload.item === "api").map((m) => m.payload.attempt)).toEqual([1, 2]);
    // The fix edit's objective carries the failing output.
    expect(executor.contexts.find((c) => c.model === "m1")!.objective).toMatch(/FAILED on revision \d+ .*attempt 1/);
    expect(executor.contexts.find((c) => c.model === "m1")!.objective).toContain("src/api/handler.ts does not report status yet");
    expect(result.revision!.gate).toBe("pass");
    expect(result.verdict).toBe("verified");
  });

  it("a gate that always fails: budgets are spent, items reopen for fresh eyes, the last revision decides, nothing is promoted", async () => {
    const projectDir = await project();
    const gate = new FixedGate(1);
    const result = await offline({
      goal: GOAL,
      projectDir,
      seed,
      appGateCommand: ["gate"],
      verifyCommandRunner: gate,
      budgets: { maxFixAttemptsPerItem: 1, maxRunTurns: 400, maxRounds: 400 },
    });
    expect(gate.ran.length).toBeGreaterThan(0);
    expect(result.revisions.every((r) => r.gate === "fail")).toBe(true);
    expect(types(result.log)).not.toContain("item.completed");
    // Each spent budget reopens the item for an agent that has not spent it yet.
    const reopened = of(result.log, "item.reopened");
    expect(reopened.length).toBeGreaterThan(0);
    for (const m of reopened) {
      const later = of(result.log, "claim.granted").filter((g) => g.seq > m.seq && g.payload.item === m.payload.item);
      expect(later.every((g) => g.payload.agent !== m.payload.previousOwner)).toBe(true);
    }
    // The phase ends when every outstanding item was spent by every running agent (or the run budget).
    expect(["fix-budget", "run-budget", "quiescent"]).toContain(result.stopReason);
    // The same pending set is never gated twice.
    const keys = result.revisions.map((r) => [...r.merged].sort().join(","));
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.verdict).toBe("failed");
    expect(result.promotion).toMatchObject({ committed: false });
    expect(result.promotion!.refusedReason).toMatch(/not "verified": not promoting/);
  });

  it("a reopened item goes to another agent, which starts from the previous owner's last push and can finish it", async () => {
    const projectDir = await project();
    const edits = new Map<string, number>();
    const seen: (string | undefined)[] = [];
    const executor: ExecutorProvider = {
      name: "counting",
      async execute(context: ExecutorContext): Promise<ExecutionResult> {
        const k = (edits.get(context.workUnitId) ?? 0) + 1;
        edits.set(context.workUnitId, k);
        const written: string[] = [];
        for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
          if (context.workUnitId === "api") {
            seen.push(await readFile(join(context.worktreeDir, path), "utf8").catch(() => undefined));
          }
          await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
          await writeFile(join(context.worktreeDir, path), `// ${context.workUnitId} edit #${k}\n`);
          written.push(path);
        }
        return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `edit ${k}` };
      },
    };
    // Fails until the api handler carries a third edit (the first owner gets two).
    const gate: CommandRunner = {
      async run(_argv, cwd) {
        const handler = await readFile(join(cwd, "src/api/handler.ts"), "utf8");
        const k = Number(/edit #(\d+)/.exec(handler)?.[1] ?? 0);
        return k >= 3 || k === 0 ? { code: 0, stdout: "ok 1 - handler\n", stderr: "" } : { code: 1, stdout: "not ok 1 - handler\n# src/api/handler.ts is wrong\n", stderr: "" };
      },
    };
    const result = await offline({ goal: GOAL, projectDir, seed, executor, appGateCommand: ["gate"], verifyCommandRunner: gate, budgets: { maxFixAttemptsPerItem: 1 } });
    const reopened = of(result.log, "item.reopened").find((m) => m.payload.item === "api")!;
    expect(reopened).toBeDefined();
    const regrant = of(result.log, "claim.granted").find((g) => g.seq > reopened.seq && g.payload.item === "api")!;
    expect(regrant.payload.agent).not.toBe(reopened.payload.previousOwner);
    // The new owner's edit started from the previous owner's last pushed version.
    expect(seen.at(-1)).toBe("// api edit #2\n");
    expect(result.state.items.api!.status).toBe("done");
    expect(result.verdict).toBe("verified");
    expect(formatBoardTranscript(result.log)).toMatch(/item\.reopened\s+api for another agent \(was agent-\d, starting from/);
  });

  it("records every typed decision on the board (plan review, attribution errors, fix confidence) and counts them in the summary", async () => {
    const projectDir = await project();
    // Attribution calls fail (an API drift); fix-confidence answers. Neither changes the verdict.
    const jev: AskJev = async (_state, questions) => {
      if ("attribution" in questions) {
        throw new Error("AI Gateway decision call failed for typesafe/jev (HTTP 400): Invalid value at questions.attribution.criteria: expected record, received array");
      }
      return { "fix-confidence": { type: "noul", noul: "yes", confidence: 0.9 } };
    };
    let first = true;
    // The first two revisions fail (so attribution is asked over more than one item), then everything passes.
    const gate: CommandRunner = {
      async run() {
        if (first) {
          first = false;
          return { code: 0, stdout: "", stderr: "" }; // the baseline run
        }
        gateRuns += 1;
        return gateRuns <= 2 ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" };
      },
    };
    let gateRuns = 0;
    const reviewed = async (): Promise<BoardSeed> => ({
      ...(await seed()),
      review: { question: "Does this plan cover the goal?", noul: "unsure", confidence: 0, accepted: false, error: "HTTP 500: upstream unavailable" },
    });
    const result = await offline({ goal: GOAL, projectDir, seed: reviewed, appGateCommand: ["gate"], verifyCommandRunner: gate, jev });
    const decisions = of(result.log, "decision.recorded");
    expect(decisions[0]!.payload).toMatchObject({ juncture: "plan-review", accepted: false, error: "HTTP 500: upstream unavailable" });
    const attribution = decisions.filter((d) => d.payload.juncture === "attribution");
    expect(attribution.length).toBeGreaterThan(0);
    expect(attribution[0]!.payload.error).toMatch(/\(HTTP 400\): Invalid value at questions\.attribution\.criteria/);
    expect(decisions.at(-1)!.payload).toMatchObject({ juncture: "fix-confidence", answer: "yes", accepted: true });
    expect(result.verdict).toBe("verified"); // advisory only
    expect(formatBoardRunSummary(result)).toMatch(new RegExp(`jev: ${decisions.length} call\\(s\\), 1 accepted, ${decisions.length - 1} error\\(s\\)`));
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("only a passing LAST revision is promoted: an earlier pass does not ship a later failure", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: new PassOnceGate() });
    expect(result.revisions[0]!.gate).toBe("pass");
    expect(result.revision!.gate).toBe("fail");
    expect(result.verdict).toBe("failed");
    expect(result.promotion?.committed ?? false).toBe(false);
  });

  it("a passing gate on the integrated tree promotes it", async () => {
    const projectDir = await project();
    const gate = new FixedGate(0);
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate });
    expect(result.revision).toMatchObject({ gate: "pass" });
    expect(result.verdict).toBe("verified");
    expect(result.promotion).toMatchObject({ committed: true });
  });

  it("a declared gate that is not wired cannot pass", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, requireAppGate: true });
    expect(result.revisions.length).toBeGreaterThan(0);
    expect(result.revisions.every((r) => r.gate === "fail")).toBe(true);
    expect(result.verdict).toBe("failed");
    expect(result.promotion).toMatchObject({ committed: false });
  });

  it("a contract on the original tests is decided only by a human: accepted, the change ships; never by the lead", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    let leadTried = false;
    // A lead that tries to accept every contract, protected or not.
    const eagerLead: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const pending = input.board.pendingContracts[0];
      if (input.role === "lead" && pending) {
        leadTried = true;
        return { action: { type: "decide_contract", contractId: pending.contract, decision: "accept", rationale: "accept everything" } };
      }
      return policy(input);
    };
    const accepted = await runBoardOffline({ goal: GOAL, projectDir, seed, transport: eagerLead, resolveContract: async () => "accept" });
    void leadTried; // the board refuses a lead decision on a protected contract (see the board tests)
    expect(of(accepted.log, "contract.accepted").every((m) => m.from === "human")).toBe(true);
    const grant = of(accepted.log, "claim.granted").find((m) => m.payload.item === "tests")!;
    expect(grant.payload.intent.write).toEqual(["tests/**"]);
    expect(accepted.verdict).toBe("verified");
    const { stdout } = await git("git", ["-C", accepted.sourceRepoDir!, "show", `${accepted.promotion!.commit}:tests/core.test.ts`]);
    expect(stdout).not.toBe("// tests\n"); // the released change shipped

    // Rejected: the existing test is untouched in the promoted tree.
    const rejected = await offline({ goal: GOAL, projectDir, seed });
    const kept = await git("git", ["-C", rejected.sourceRepoDir!, "show", `${rejected.promotion!.commit}:tests/core.test.ts`]);
    expect(kept.stdout).toBe("// tests\n");
  });

  it("without a human resolver the contract waits durably, and the run reports the item as not completed", async () => {
    const projectDir = await project();
    const events: BoardRunEvent[] = [];
    const result = await runBoardOffline({ goal: GOAL, projectDir, seed, onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.kind === "contract-awaiting-human")).toBe(true);
    expect(result.incompleteItems).toEqual(["tests"]);
    expect(result.verdict).toBe("verified");
    expect(formatBoardRunSummary(result)).toMatch(/verified \(partial: 1 item\(s\) not completed: tests; the Change is not complete\)/);
  });

  it("records the baseline gate's test inventory with the goal, and fails a revision whose run skipped baseline tests", async () => {
    const projectDir = await project();
    let runs = 0;
    // The baseline executes two tests; every later run reports only one (an early exit).
    const exiting: CommandRunner = {
      async run() {
        runs += 1;
        return runs === 1 ? { code: 1, stdout: "not ok 1 - a\nok 2 - b\n", stderr: "" } : { code: 0, stdout: "ok 1 - b\n", stderr: "" };
      },
    };
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: exiting });
    // Count and format only on the board: names stay with the integrator.
    expect(of(result.log, "goal.posted")[0]!.payload.testInventory).toEqual({ status: "recorded", format: "tap", count: 2 });
    expect(result.revisions.every((r) => r.gate === "fail")).toBe(true);
    expect(of(result.log, "integrated.rev")[0]!.payload.failing!.output).toMatch(/test inventory: 1 of the 2 baseline test\(s\) did not execute/);
    // Counts only: the missing test's name is never published.
    expect(of(result.log, "integrated.rev")[0]!.payload.failing!.output).not.toMatch(/\ba\b.*did not execute: a/);
    expect(result.verdict).toBe("failed");
    // A gate whose output shows no tests is recorded as such (exit code only).
    const blind = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: new FixedGate(0) });
    expect(of(blind.log, "goal.posted")[0]!.payload.testInventory).toEqual({ status: "unavailable" });
    expect(blind.testInventory).toMatch(/test inventory unavailable/);
  });

  it("relaxes the inventory visibly once a human accepts a change to an existing test the format cannot attribute", async () => {
    const projectDir = await project();
    let runs = 0;
    const exiting: CommandRunner = {
      async run() {
        runs += 1;
        return runs === 1 ? { code: 1, stdout: "not ok 1 - a\nok 2 - b\n", stderr: "" } : { code: 0, stdout: "ok 1 - b\n", stderr: "" };
      },
    };
    const result = await runBoardOffline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: exiting, resolveContract: async () => "accept" });
    const relaxed = result.revisions.filter((r) => r.inventoryNote !== undefined);
    expect(relaxed.length).toBeGreaterThan(0);
    expect(relaxed[0]!.inventoryNote).toMatch(/accepted contract change\(s\) to tests\/core\.test\.ts: the tap inventory cannot be adjusted per file/);
    expect(result.revisions.filter((r) => r.inventoryNote === undefined).every((r) => r.gate === "fail")).toBe(true);
    expect(formatBoardRunSummary(result)).toMatch(/test inventory: accepted contract change/);
  });

  it("re-cues an owner that ignores the done cue (bounded), so the item does not stall", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    // Waits through the first two cues after its push, then proposes done.
    const stubborn: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const recent = input.capsule.decisions;
      const lastEdit = recent.map((h) => h.action.type).lastIndexOf("edit");
      const waitsSince = lastEdit === -1 ? 0 : recent.slice(lastEdit + 1).filter((h) => h.action.type === "wait").length;
      if (input.role === "worker" && lastEdit !== -1 && recent[lastEdit]!.outcome === "posted" && waitsSince < 3) {
        return { action: { type: "wait", reason: "not yet" } };
      }
      return policy(input);
    };
    const result = await offline({ goal: GOAL, projectDir, seed, transport: stubborn });
    expect(result.incompleteItems).toEqual([]);
  });

  it("wakes an owner whose push passed so it proposes done", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    // A worker that waits right after pushing (a live model often does), and acts only when woken.
    const lazy: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const last = input.capsule.decisions.at(-1);
      if (input.role === "worker" && last?.action.type === "edit" && last.outcome === "posted") {
        return { action: { type: "wait", reason: "pushed; waiting" } };
      }
      return policy(input);
    };
    const result = await offline({ goal: GOAL, projectDir, seed, transport: lazy });
    expect(result.stopReason).toBe("all-items-done");
    expect(result.incompleteItems).toEqual([]);
  });

  it("never reports a partial result as verified: a push that was never gated fails the verdict", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-partial");
    const inner = control.fetch as unknown as typeof fetch;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/board/read-token") && String(init?.body).includes('"agent-2"')
        ? new Response(JSON.stringify({ code: "NOT_ALLOWED", error: "refused" }), { status: 403 })
        : inner(input, init)) as typeof fetch;
    const result = await runBoard({ ...base, projectDir, fetchFn, budgets: { maxRounds: 12 } });
    expect(result.revisions.some((r) => r.gate === "pass")).toBe(true);
    expect(result.verdict).toBe("failed");
    expect(result.partial).toMatch(/never gated/);
    expect(result.promotion).toBeUndefined();
  });

  it("retries a transient read-token failure and revokes every read token once integration is done with it", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-tokens");
    const inner = control.fetch as unknown as typeof fetch;
    let flaky = 2;
    let issued = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/board/read-token")) {
        if (flaky > 0) {
          flaky -= 1;
          return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        }
        issued += 1;
      }
      return inner(input, init);
    }) as typeof fetch;
    const result = await runBoard({ ...base, projectDir, fetchFn });
    expect(result.verdict).toBe("verified");
    expect(issued).toBeGreaterThan(0);
    expect(control.revokedReadTokens).toHaveLength(issued);
  });

  it("records spent turn budgets on the board and integrates nothing it did not get", async () => {
    const projectDir = await project();
    const result = await offline({
      goal: GOAL,
      projectDir,
      seed,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      budgets: { maxTurnsPerItem: 1 },
    });
    const help = of(result.log, "help.requested");
    expect(help).toHaveLength(1);
    expect(help[0]).toMatchObject({ from: "agent-1", payload: { item: "core", need: "turn-budget" } });
    expect(result.agents.find((a) => a.id === "agent-1")!.stop).toMatchObject({ reason: "item-budget" });
    expect(result.stopReason).toBe("all-agents-stopped");
    expect(types(result.log)).not.toContain("push.announced");
    expect(result.revision).toBeUndefined();
    expect(result.verdict).toBe("failed");
    expect(result.promotion).toBeUndefined();
  });

  it("stops at the run-wide budget", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, budgets: { maxRunTurns: 4 } });
    expect(result.stopReason).toBe("run-budget");
    expect(result.turns.filter((t) => t.outcome !== "seeded").length).toBeLessThanOrEqual(4);
  });

  it("marks the planning Change failed and throws when the planner fails", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-fail");
    await expect(
      runBoard({
        ...base,
        projectDir,
        seed: async () => {
          throw new Error("no live planner");
        },
      }),
    ).rejects.toThrow(/no live planner/);
    expect(control.state("change-board-fail").status).toBe("planning-failed");
  });

  it("a throw in the agent phase aborts the agents, marks the Change failed, and archives every repo", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-throw");
    const deleted: string[] = [];
    const inner = control.fetch as unknown as typeof fetch;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/board/join") && String(init?.body ?? "").includes('"agent-2"')) {
        throw new Error("the join route is unreachable");
      }
      if ((init?.method ?? "GET") === "DELETE" && url.includes("/workspaces/")) {
        deleted.push(decodeURIComponent(url.split("/workspaces/")[1]!));
      }
      return inner(input, init);
    }) as typeof fetch;
    await expect(runBoard({ ...base, projectDir, fetchFn })).rejects.toThrow(/unreachable/);
    expect(control.state("change-board-throw").status).toBe("planning-failed");
    expect(deleted).toEqual(["change-board-throw--board-agent-1"]);
  });

  it("refuses an agent phase longer than the agents' write-token lifetime", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-ttl");
    await expect(
      runBoard({ ...base, projectDir, workspaceTtlSeconds: 60, budgets: { timeoutMs: 120_000 } }),
    ).rejects.toThrow(/exceeds the agents' write-token lifetime/);
    expect(() => control.state("change-board-ttl")).toThrow();
  });

  it("never promotes when the verdict could not be recorded", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-verdict");
    const inner = control.fetch as unknown as typeof fetch;
    const events: BoardRunEvent[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/integration") && init?.method === "POST"
        ? new Response(JSON.stringify({ error: "down" }), { status: 503 })
        : inner(input, init)) as typeof fetch;
    await expect(runBoard({ ...base, projectDir, fetchFn, onEvent: (e) => events.push(e) })).rejects.toThrow(
      /verdict could not be recorded \(HTTP 503\); not promoting/,
    );
    expect(events.some((e) => e.kind === "promoting")).toBe(false);
  });

  it("integrates with fresh operator read tokens", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-read");
    const inner = control.fetch as unknown as typeof fetch;
    const readTokens: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/board/read-token")) {
        readTokens.push(JSON.parse(String(init?.body)).agent as string);
      }
      return inner(input, init);
    }) as typeof fetch;
    const result = await runBoard({ ...base, projectDir, fetchFn });
    expect(result.verdict).toBe("verified");
    expect(new Set(readTokens)).toEqual(new Set(["agent-1", "agent-2", "agent-3"]));
  });
});

describe("runBoard (concurrent schedule)", () => {
  it("runs every agent's own loop to completion", async () => {
    const projectDir = await project();
    const { base } = await direct("change-board-concurrent");
    const result = await runBoard({ ...base, projectDir, schedule: "concurrent", pollMs: 20, budgets: { timeoutMs: 60_000 } });
    expect(result.stopReason).toBe("all-items-done");
    expect(result.verdict).toBe("verified");
    expect(Object.values(result.state.items).every((i) => i.status === "done")).toBe(true);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("ends a quiet board as quiescent (with a recorded reason), not at the timeout", async () => {
    const projectDir = await project();
    const { base } = await direct("change-board-quiet");
    const idle: AgentTurnTransport<BoardDigest, BoardMessage> = async () => ({ action: { type: "wait", reason: "nothing for me" } });
    const events: BoardRunEvent[] = [];
    const started = Date.now();
    const result = await runBoard({
      ...base,
      projectDir,
      transport: idle,
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 300 },
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("quiescent");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(events.find((e) => e.kind === "agents-done")).toMatchObject({ reason: "quiescent", detail: expect.stringMatching(/idle/) });
  });
});

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
import { activeClaims, foldBoard, pendingPushItems, reduceBoard, seamHolds, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type {
  AskJev,
  AgentTurnTransport,
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner, DependencyInstaller } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { FirstAttemptFailingGate, runBoardOffline } from "../src/run-board-offline.ts";
import { boardRunExitCode, formatBoardRunSummary, formatBoardTranscript, runBoard, type BoardRunEvent, type BoardSeed, type RunBoardOptions } from "../src/run-board.ts";

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
    // Claims in plan order (no overlap preference), so the nested scopes contest.
    const result = await offline({ goal: GOAL, projectDir, seed, transport: createGenericBoardPolicy({ preferNonOverlapping: false }), onEvent: (e) => events.push(e) });
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
    // The promotion is recorded on the board (backed), and the proof bundle proves the shipped tree is the gated one.
    const promotedMsg = of(log, "revision.promoted")[0]!;
    expect(promotedMsg.payload).toMatchObject({ rev: result.revision!.n, gatedCommit: result.revision!.commit, commit: result.promotion!.commit, branch: result.promotion!.branch });
    // No gate is declared here: the promoted tree is the gated tree, but nothing was checked, so it is NOT proven (honestly).
    expect(result.verdict).toBe("unverified");
    expect(result.proof).toMatchObject({ status: "not-proven", revision: { n: result.revision!.n, gated: false }, promotion: { matchesGated: true } });
    expect(result.proof!.reasons).toEqual([`no gate ran on the last revision (${result.revision!.n}): its pass checked nothing`]);

    // The lead proposes (never assigns); workers join under the dial.
    expect(of(log, "item.proposed").every((m) => m.from === "lead")).toBe(true);
    expect(of(log, "agent.joined").map((m) => m.from)).toEqual(["lead", "agent-1", "agent-2", "agent-3"]);
    expect(result.seed).toMatchObject({ source: "planner", model: "fake-planner" });

    // Claims, one contest resolved by narrowing, and the claimant re-granted.
    expect(of(log, "claim.contested")[0]!.payload).toMatchObject({ claimant: "agent-3", owner: "agent-1", item: "wiring", overlap: ["src/**"] });
    expect(of(log, "claim.narrowed")[0]).toMatchObject({ from: "agent-3", payload: { write: ["src/index.ts"] } });
    // Once granted, wiring's planned scope (src/**) still overlaps core's: recorded for both, advisory.
    expect(of(log, "claim.overlap").find((m) => m.payload.item === "wiring" && m.payload.with === "core")).toMatchObject({ to: ["agent-3", "agent-1"] });
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

    // The project has no gate: every revision says so, and the verdict is
    // UNVERIFIED (nothing was checked), never "verified". The tree is still
    // promoted, labeled unverified; the CLI exits non-zero.
    expect(revs.every((r) => r.payload.gated === false)).toBe(true);
    expect(result.revisions.every((r) => !r.gated)).toBe(true);
    expect(result.verdict).toBe("unverified");
    const summary = formatBoardRunSummary(result);
    expect(summary).toMatch(/integrated revision 1: no gate: nothing checked/);
    expect(summary).toContain("verdict: unverified (no gate configured: nothing checked)");
    expect(summary).toContain("promoted unverified (no gate): branch switchyard/change-board-offline");
    expect(summary).not.toMatch(/verdict: verified/);
    expect(formatBoardTranscript(log)).toMatch(/integrated\.rev\s+rev 1 no gate: nothing checked/);
    expect(boardRunExitCode(result)).toBe(1);
    expect(events.find((e) => e.kind === "integration-verdict")).toMatchObject({ verdict: "verified", gated: false });
    expect(result.evidence!.integration.commit).toBe(result.revision!.commit);
    expect(result.promotion).toMatchObject({ committed: true, branch: "switchyard/change-board-offline" });
    expect(await treeOf(result.sourceRepoDir!, result.promotion!.commit)).toBe(
      await treeOf(join(result.workRoot, "integration-artifacts", "change-board-offline--integration.git"), result.revision!.commit),
    );

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
    // (Revision 3 also lists the unmerged items whose scope covers the failing file: advisory.)
    expect(result.revisions[0]!.implicated).toMatchObject({ items: first!.payload.failing!.items, source: "parse" });
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
    // The phase ends when every outstanding item was spent by every running
    // agent, judged on the leaf items: the re-planned parents (split, carried
    // by their children) never keep the fix-budget stop from firing.
    expect(of(result.log, "item.replanned").length).toBeGreaterThan(0);
    expect(result.stopReason).toBe("fix-budget");
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
    expect(accepted.verdict).toBe("unverified"); // no gate in this project
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
    expect(result.verdict).toBe("unverified"); // no gate in this project
    expect(formatBoardRunSummary(result)).toMatch(/unverified \(no gate configured: nothing checked\) \(partial: 1 item\(s\) not completed: tests; the Change is not complete\)/);
    expect(boardRunExitCode(result)).toBe(1);
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

  it("an owner that never proposes done is cued at most MAX_DONE_CUES times (the last explicitly); the summary says why the item is partial, and nothing completes it on its behalf", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    const cuesSeen: string[] = [];
    // The api owner never proposes done; everyone else follows the policy.
    const silent: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const action = (await policy(input)).action;
      if (input.role === "worker" && action.type === "propose_done" && action.itemId === "api") {
        cuesSeen.push(...input.capsule.evidence.filter((e) => /propose.?done/i.test(e) && !cuesSeen.includes(e)));
        return { action: { type: "wait", reason: "not proposing" } };
      }
      return { action };
    };
    const result = await offline({ goal: GOAL, projectDir, seed, transport: silent });
    expect(result.incompleteItems).toEqual(["api"]);
    // Never auto-completed: no done.proposed for api exists, and it is not completed.
    expect(of(result.log, "done.proposed").some((m) => m.payload.item === "api")).toBe(false);
    expect(result.state.items.api?.status).toBe("claimed");
    const n = result.state.items.api!.lastPush!.integratedIn!;
    expect(result.incompleteReasons).toEqual([`item api: its push passed in rev ${n} but its owner did not propose done (owner ${result.state.items.api!.owner})`]);
    const summary = formatBoardRunSummary(result);
    expect(summary).toContain(`not completed: item api: its push passed in rev ${n} but its owner did not propose done`);
    expect(summary).toMatch(/partial: 1 item\(s\) not completed: api/);
    expect(cuesSeen.some((e) => e.startsWith("FINAL CUE:"))).toBe(true);
    expect(boardRunExitCode(result)).toBe(1);
  });

  it("a worker's late proposal waits for the lead: a duplicate is rejected (not counted), new work is accepted and completed", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    const proposals = [
      // Duplicates the planner's api item (same scope): finished work.
      { objective: "Add input validation for the api resource", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
      // New work no item covers.
      { objective: "Write the status report notes", acceptance: ["notes exist"], scopeHint: ["docs/status.md"] },
    ];
    let next = 0;
    const proposer: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const action = (await policy(input)).action;
      // Late: once its own push passed, before proposing its item done.
      if (input.role === "worker" && input.agent === "agent-2" && action.type === "propose_done" && next < proposals.length) {
        const p = proposals[next++]!;
        return { action: { type: "propose_item", ...p, rationale: "found more work" } };
      }
      return { action };
    };
    const result = await offline({ goal: GOAL, projectDir, seed, transport: proposer });
    const proposed = of(result.log, "item.proposed").filter((m) => m.from === "agent-2");
    expect(proposed).toHaveLength(2);
    const [dup, fresh] = proposed.map((m) => m.payload.item);
    const rejected = of(result.log, "item.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ from: "lead", payload: { item: dup } });
    expect(rejected[0]!.rationale).toMatch(/duplicates item api/);
    expect(of(result.log, "item.accepted")).toEqual([expect.objectContaining({ from: "lead", payload: { item: fresh } })]);
    // No claim on the proposal before the lead accepted it.
    const accepted = of(result.log, "item.accepted")[0]!.seq;
    expect(of(result.log, "claim.granted").filter((m) => m.payload.item === fresh).every((m) => m.seq > accepted)).toBe(true);
    expect(of(result.log, "claim.granted").some((m) => m.payload.item === dup)).toBe(false);
    // The accepted proposal is completed; the rejected one does not make the run partial.
    expect(result.state.items[fresh!]?.status).toBe("done");
    expect(result.state.items[dup!]?.status).toBe("rejected");
    expect(result.stopReason).toBe("all-items-done");
    expect(result.incompleteItems).toEqual([]);
    expect(result.proposals).toMatchObject({ undecided: [], rejected: [{ item: dup, by: "lead" }] });
    const summary = formatBoardRunSummary(result);
    expect(summary).toContain("items completed: 5 of 5 (1 worker proposal(s) rejected: not counted)");
    expect(summary).toContain(`proposal rejected: ${dup} by lead: ${dup} duplicates item api`);
    expect(summary).not.toMatch(/partial/);
    expect(reduceBoard(result.log)).toEqual(result.state);
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
    expect(result.verdict).toBe("unverified"); // no gate in this project
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

  it("with token refresh off, refuses an agent phase longer than the agents' write-token lifetime", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-ttl");
    await expect(
      runBoard({ ...base, projectDir, workspaceTtlSeconds: 60, refreshTokens: false, budgets: { timeoutMs: 120_000 } }),
    ).rejects.toThrow(/exceeds the agents' write-token lifetime \(60 s\) and token refresh is off/);
    expect(() => control.state("change-board-ttl")).toThrow();
  });

  it("with token refresh on (the default), a phase may outlast the token lifetime: each token is refreshed before it expires, swapped in, recorded (never the token), and the old one revoked", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-refresh");
    // A fake clock running far ahead: every agent token is past its refresh margin at each tick.
    let fake = Date.now();
    const events: BoardRunEvent[] = [];
    const result = await runBoard({
      ...base,
      projectDir,
      changeId: "change-board-refresh",
      workspaceTtlSeconds: 60,
      budgets: { timeoutMs: 120_000 },
      tokenClock: () => (fake += 10 * 60_000),
      onEvent: (e) => events.push(e),
    });
    const refreshed = result.log.filter((m) => m.type === "token.refreshed");
    expect(refreshed.length).toBeGreaterThan(0);
    expect(refreshed.every((m) => m.from === "engine" && (m.payload as { kind: string }).kind === "repo-write")).toBe(true);
    // The tokens themselves never reach the board.
    const issued = control.revokedReadTokens;
    expect(issued.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "token-refreshed")).toBe(true);
    expect(result.verdict).not.toBe("failed");
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(result.log)).toEqual(result.state);
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
    expect(result.verdict).toBe("unverified"); // no gate in this project
    expect(new Set(readTokens)).toEqual(new Set(["agent-1", "agent-2", "agent-3"]));
  });
});

describe("runBoard (concurrent schedule)", () => {
  it("runs every agent's own loop to completion", async () => {
    const projectDir = await project();
    const { base } = await direct("change-board-concurrent");
    const result = await runBoard({ ...base, projectDir, schedule: "concurrent", pollMs: 20, budgets: { timeoutMs: 60_000 } });
    expect(result.stopReason).toBe("all-items-done");
    expect(result.verdict).toBe("unverified"); // no gate in this project
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

describe("held work on a quiet board (concurrent schedule)", () => {
  const oneItem = async (): Promise<BoardSeed> => ({
    source: "planner",
    model: "fake-planner",
    items: [{ item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] }],
  });
  /** The generic policy, except agent-1 answers its first `waits` edits of an item with a wait. */
  const waitsFirst = (waits: number) => {
    const policy = createGenericBoardPolicy();
    const waited = new Map<string, number>();
    const inputs: { agent: string; evidence: readonly string[] }[] = [];
    const transport: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      inputs.push({ agent: input.agent, evidence: [...input.capsule.evidence] });
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string };
      if (input.agent === "agent-1" && action.type === "edit" && action.itemId !== undefined && (waited.get(action.itemId) ?? 0) < waits) {
        waited.set(action.itemId, (waited.get(action.itemId) ?? 0) + 1);
        return { action: { type: "wait", reason: "reading the files first" } };
      }
      return outcome;
    };
    return { transport, inputs };
  };

  it("a holder that waits once after claiming is re-cued at once and edits: no stalled lapse", async () => {
    const projectDir = await project();
    const { base } = await direct("change-held-wait");
    const { transport, inputs } = waitsFirst(1);
    const result = await runBoard({
      ...base,
      projectDir,
      seed: oneItem,
      transport,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 600 },
    });
    expect(inputs.some((i) => i.agent === "agent-1" && i.evidence.some((e) => /^HELD WORK: I hold api with no push: edit it now/.test(e)))).toBe(true);
    expect(of(result.log, "claim.lapsed")).toEqual([]);
    expect(of(result.log, "push.announced").filter((m) => m.payload.item === "api")).not.toHaveLength(0);
    expect(result.stopReason).toBe("all-items-done");
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a holder that waits past its re-cues is nudged by the driver before any lapse, and then edits", async () => {
    const projectDir = await project();
    const { base } = await direct("change-held-nudge");
    // Three waits: two are re-cued at once, the third leaves it idle until the board is quiet.
    const { transport, inputs } = waitsFirst(3);
    const events: BoardRunEvent[] = [];
    const result = await runBoard({
      ...base,
      projectDir,
      seed: oneItem,
      transport,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 600 },
      onEvent: (e) => events.push(e),
    });
    expect(events).toContainEqual({ kind: "held-work-nudged", item: "api", agent: "agent-1" });
    expect(inputs.some((i) => i.evidence.some((e) => /^HELD WORK: the board went quiet and I hold api/.test(e)))).toBe(true);
    expect(of(result.log, "claim.lapsed")).toEqual([]);
    expect(result.stopReason).toBe("all-items-done");
  });

  it("an edit blocked in the executor past half the quiet period never lapses its claim", async () => {
    const projectDir = await project();
    const { base } = await direct("change-held-slow");
    const stamping = new ModelStampingExecutor();
    let calls = 0;
    const slow: ExecutorProvider = {
      name: "slow",
      async execute(context) {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
        return stamping.execute(context);
      },
    };
    const result = await runBoard({
      ...base,
      projectDir,
      seed: oneItem,
      executor: slow,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 600 },
    });
    expect(calls).toBeGreaterThan(0);
    expect(of(result.log, "claim.lapsed")).toEqual([]);
    expect(result.stopReason).toBe("all-items-done");
  });
});

describe("boardRunExitCode (what the CLI exits with)", () => {
  const promoted = { committed: true } as RunBoardResultPromotion;
  type RunBoardResultPromotion = NonNullable<Parameters<typeof boardRunExitCode>[0]["promotion"]>;
  it("is 0 only for a gated, verified, complete (and, when required, promoted) result", () => {
    expect(boardRunExitCode({ verdict: "verified", incompleteItems: [], promotion: promoted })).toBe(0);
    expect(boardRunExitCode({ verdict: "verified", incompleteItems: [] }, { requirePromotion: true })).toBe(1);
    expect(boardRunExitCode({ verdict: "verified", incompleteItems: [], promotion: promoted }, { requirePromotion: true })).toBe(0);
  });

  it("is non-zero for a partial result (verified, items not completed), an unverified (no gate) one, and a failed one", () => {
    expect(boardRunExitCode({ verdict: "verified", incompleteItems: ["a", "b"], promotion: promoted })).toBe(1);
    expect(boardRunExitCode({ verdict: "verified", incompleteItems: ["a", "b"], promotion: promoted }, { requirePromotion: true })).toBe(1);
    expect(boardRunExitCode({ verdict: "unverified", incompleteItems: [], promotion: promoted })).toBe(1);
    expect(boardRunExitCode({ verdict: "failed", incompleteItems: [] })).toBe(1);
  });

  it("a gated run (the fixture gate) stays verified and exits 0", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, fixtureGate: true });
    expect(result.revisions.every((r) => r.gated)).toBe(true);
    expect(of(result.log, "integrated.rev").every((r) => r.payload.gated === undefined)).toBe(true);
    expect(result.verdict).toBe("verified");
    expect(boardRunExitCode(result)).toBe(0);
    expect(formatBoardRunSummary(result)).toMatch(/\n {2}promoted: branch /);
  });
});

describe("dependency install before the gate (offline, fake installer)", () => {
  async function lockedProject(): Promise<string> {
    const dir = await project();
    await writeFile(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
    return dir;
  }

  it("installs in every gated tree (never the source project) before the gate, and reports it per revision and for the baseline", async () => {
    const projectDir = await lockedProject();
    const dirs: string[] = [];
    const dependencyInstaller: DependencyInstaller = {
      async install(dir) {
        dirs.push(dir);
        return { status: "installed", tool: "npm", detail: "npm ci --ignore-scripts", durationMs: 1200 };
      },
    };
    const gate = new FixedGate(0);
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate, dependencyInstaller });
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).not.toContain(projectDir);
    // Every gate run happened in a tree that was installed first.
    expect(gate.ran.every((cwd) => dirs.includes(cwd))).toBe(true);
    expect(result.revisions.every((r) => r.install?.status === "installed")).toBe(true);
    expect(result.testInventory).toContain("dependency install: installed (npm ci --ignore-scripts, 1.2 s)");
    expect(formatBoardRunSummary(result)).toMatch(/integrated revision 1: gate pass[^\n]*\n {4}dependency install: installed \(npm ci --ignore-scripts, 1\.2 s\)/);
    expect(result.verdict).toBe("verified");
  });

  it("a failed install fails the revision honestly: the gate never runs and the reason leads", async () => {
    const projectDir = await lockedProject();
    const dependencyInstaller: DependencyInstaller = {
      async install() {
        return { status: "failed", tool: "npm", detail: "npm ci: npm error code ERESOLVE", durationMs: 50 };
      },
    };
    const gate = new FixedGate(0);
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate, dependencyInstaller, budgets: { maxFixAttemptsPerItem: 1 } });
    expect(gate.ran).toEqual([]);
    expect(result.revisions.length).toBeGreaterThan(0);
    expect(result.revisions.every((r) => r.gate === "fail" && r.install?.status === "failed")).toBe(true);
    expect(result.revisions[0]!.failure).toMatch(/^dependency install failed: npm ci: npm error code ERESOLVE/);
    expect(of(result.log, "integrated.rev")[0]!.payload.failing!.output).toMatch(/^dependency install failed:/);
    expect(result.testInventory).toContain("dependency install: failed: npm ci: npm error code ERESOLVE");
    expect(result.verdict).toBe("failed");
    expect(boardRunExitCode(result)).toBe(1);
  });

  it("offline, the fixture gate may replace a declared gate: labeled, no install, and it shows coordination only", async () => {
    const projectDir = await lockedProject();
    let installs = 0;
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir,
      seed,
      resolveContract: reject,
      fixtureGate: true,
      replacesDeclaredGate: ["npm", "run", "gate"],
      dependencyInstaller: {
        async install() {
          installs += 1;
          return { status: "installed", detail: "x", durationMs: 0 };
        },
      },
    });
    expect(installs).toBe(0); // the fixture installs nothing, whatever the caller passed
    expect(result.gateLabel).toBe("offline fixture gate replaces the project's declared gate (npm run gate); this demo shows coordination, not a real fix");
    expect(formatBoardRunSummary(result)).toContain(`  gate: ${result.gateLabel}`);
    expect(result.revisions.every((r) => r.install?.status === "skipped" && /disabled for this gate/.test(r.install.detail))).toBe(true);
    expect(result.verdict).toBe("verified");
  });
});

describe("lockstep schedule priority", () => {
  it("steps agents building an unpublished tool first, then the rest in join order", async () => {
    const { lockstepOrder } = await import("../src/run-board.ts");
    const { emptyBoard } = await import("@switchyard-change/change-core");
    const state = emptyBoard();
    state.items["tool-cm"] = { id: "tool-cm", objective: "o", acceptance: [], scopeHint: ["tools/cm/**"], status: "claimed", owner: "agent-3", proposedBy: "lead", proposedSeq: 1, children: [], doneProposed: false, tool: { capability: "cm", kind: "codemod" } };
    const workers = [{ id: "agent-1" }, { id: "agent-2" }, { id: "agent-3" }];
    expect(lockstepOrder(workers, state).map((w) => w.id)).toEqual(["agent-3", "agent-1", "agent-2"]);
    state.tools.published.push({ tool: "t", capability: "cm", version: "1", repo: "r", commit: "c", kind: "codemod", usage: "u", publishedBy: "agent-3", seq: 2, gateSeq: 2, uses: 0 });
    expect(lockstepOrder(workers, state).map((w) => w.id)).toEqual(["agent-1", "agent-2", "agent-3"]);
  });
});

describe("formation hardening in the driver", () => {
  async function repo(files: Record<string, string>): Promise<{ dir: string; commit: string }> {
    const dir = await mkdtemp(join(tmpdir(), "scf-verify-"));
    await git("git", ["init", "-q", dir]);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    await git("git", ["-C", dir, "add", "-A"]);
    await git("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c"]);
    return { dir, commit: (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim() };
  }

  it("verifies each merged child's in-intent tree against the sub-lead's commit (content and deletions)", async () => {
    const { verifySubLeadMerges } = await import("../src/run-board.ts");
    const { emptyBoard } = await import("@switchyard-change/change-core");
    const child = await repo({ "src/x.ts": "x2\n" });
    const goodLead = await repo({ "src/x.ts": "x2\n", "src/y.ts": "other child\n" });
    const staleLead = await repo({ "src/x.ts": "x1\n", "src/x-old.ts": "deleted by the child\n" });
    const state = emptyBoard();
    state.items.one = { id: "one", objective: "o", acceptance: [], scopeHint: ["src/**"], status: "split", owner: "lead-a", subLead: "lead-a", proposedBy: "lead", proposedSeq: 1, children: ["one-x"], doneProposed: false, intent: { read: [], write: ["src/**"] }, lastPush: { seq: 5, commit: "pa", agent: "lead-a", paths: ["src/x.ts"], merges: [{ item: "one-x", commit: child.commit }] } };
    state.items["one-x"] = { id: "one-x", objective: "o", acceptance: [], scopeHint: ["src/x.ts", "src/x-old.ts"], status: "claimed", owner: "kid", parent: "one", proposedBy: "lead-a", proposedSeq: 2, children: [], doneProposed: true, intent: { read: [], write: ["src/x.ts", "src/x-old.ts"] }, lastPush: { seq: 4, commit: child.commit, agent: "kid", paths: ["src/x.ts"] } };
    const run = async (lead: { dir: string; commit: string }) =>
      verifySubLeadMerges({
        units: [{ agent: "lead-a", commit: lead.commit, items: [state.items.one!] }],
        state,
        readRemote: async (agent) => (agent === "kid" ? child.dir : lead.dir),
        workRoot: await mkdtemp(join(tmpdir(), "scf-verify-work-")),
      });
    expect(await run(goodLead)).toEqual([]);
    const stale = await run(staleLead);
    expect(stale).toEqual([{ item: "one-x", reason: expect.stringMatching(/does not carry one-x's push .* for src\/x-old\.ts, src\/x\.ts/) }]);
  });

  it("holds an owner (concurrent schedule) only while a codemod being built covers all its unpushed work", async () => {
    const { toolHold } = await import("../src/run-board.ts");
    const { emptyBoard } = await import("@switchyard-change/change-core");
    const state = emptyBoard();
    state.agents = { b: { id: "b", joinedSeq: 1 }, o: { id: "o", joinedSeq: 2 } };
    state.tools.proposed.t = { tool: "t", capability: "cm", kind: "codemod", inputs: ["src/**"], outputs: [], proposedBy: "lead", seq: 1, item: "tool-cm", builds: 0, failedGates: 0 };
    state.items["tool-cm"] = { id: "tool-cm", objective: "o", acceptance: [], scopeHint: ["tools/cm/**"], status: "claimed", owner: "b", proposedBy: "lead", proposedSeq: 1, children: [], doneProposed: false, tool: { capability: "cm", kind: "codemod" }, intent: { read: [], write: ["tools/cm/**"] } };
    state.items.i = { id: "i", objective: "o", acceptance: [], scopeHint: ["src/a.ts"], status: "claimed", owner: "o", proposedBy: "lead", proposedSeq: 2, children: [], doneProposed: false, intent: { read: [], write: ["src/a.ts"] } };
    state.lastSeq = 5;
    expect(toolHold(state, "o")).toBe(true);
    expect(toolHold(state, "b")).toBe(false); // the builder itself is never held
    state.items.i.lastPush = { seq: 6, commit: "c", agent: "o", paths: ["src/a.ts"] };
    expect(toolHold(state, "o")).toBe(false); // already pushed: nothing to wait for
    delete state.items.i.lastPush;
    state.tools.proposed.t.failedGates = 1;
    expect(toolHold(state, "o")).toBe(false); // unavailable: never wait
  });
});

describe("help that nobody takes never stalls the requester (live regression board-live-s2)", () => {
  it("an owner grants its only file, nobody helps, and the item still completes with no blocked pushes", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    let granted = false;
    const transport: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const api = input.digest.claims.find((c) => c.item === "api");
      // The owner of "api" grants its ONLY file right after its first push (as the live model did).
      if (!granted && api?.lastPush?.agent === input.agent && !api.doneProposed) {
        granted = true;
        return { action: { type: "message", kind: "help", payload: { itemId: "api", need: "fix", scope: ["src/api/handler.ts"] }, rationale: "please take my only file" } };
      }
      const outcome = await policy(input);
      // Nobody ever takes a grant.
      if (outcome.action.type === "message" && outcome.action.kind === "reply" && (input.digest.help?.wanted ?? []).some((h) => h.request === (outcome.action as { payload: { requestId?: string } }).payload.requestId)) {
        return { action: { type: "wait", reason: "not helping" } };
      }
      return outcome;
    };
    const gate = new FirstAttemptFailingGate();
    const result = await offline({ goal: GOAL, projectDir, seed, transport, appGateCommand: ["gate"], verifyCommandRunner: gate });
    expect(granted).toBe(true);
    expect(of(result.log, "help.requested").some((m) => m.payload.item === "api" && m.payload.scope !== undefined)).toBe(true);
    expect(of(result.log, "help.offered").filter((m) => m.payload.forkOf !== undefined)).toEqual([]);
    // The untaken grant never blocked the owner's own pushes or its done proposal.
    expect(result.turns.filter((t) => t.code === "INTENT_OVERLAP")).toEqual([]);
    expect(result.state.items.api).toMatchObject({ status: "done" });
    expect(result.incompleteItems).toEqual([]);
    expect(result.verdict).toBe("verified");
    expect(result.revisions.length).toBeLessThanOrEqual(6);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

describe("failures the plan missed become work (lead, bounded, recorded with the evidence)", () => {
  it("a failing revision pointing at a file no item covers makes the lead propose an item for it, which completes", async () => {
    const projectDir = await project();
    await mkdir(join(projectDir, "src/extra"), { recursive: true });
    await writeFile(join(projectDir, "src/extra/x.ts"), "export const x = 0;\n");
    const baseline = "export const x = 0;\n";
    // The gate fails at src/extra/x.ts (behind npm's echo) until that file changes.
    const gate: CommandRunner = {
      async run(_argv, cwd) {
        const now = await readFile(join(cwd, "src/extra/x.ts"), "utf8").catch(() => baseline);
        return now === baseline
          ? { code: 1, stdout: "> p@0.0.0 gate\n> node --test\n", stderr: `AssertionError: x is still wrong\n    at ${cwd}/src/extra/x.ts:1:14\n` }
          : { code: 0, stdout: "ok 1 - x\n", stderr: "" };
      },
    };
    const narrow = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: [{ item: "core", objective: "report status from core", acceptance: ["gate passes"], scopeHint: ["src/core/**"] }],
    });
    const result = await offline({ goal: GOAL, projectDir, seed: narrow, appGateCommand: ["gate"], verifyCommandRunner: gate });
    const proposed = of(result.log, "item.proposed").filter((m) => m.from === "lead" && m.payload.item.includes("uncovered"));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.payload.scopeHint).toEqual(["src/extra/x.ts"]);
    expect(proposed[0]!.rationale).toMatch(/revision 1 failed \(AssertionError: x is still wrong\) in files no item covers: src\/extra\/x\.ts/);
    expect(result.state.items[proposed[0]!.payload.item]).toMatchObject({ status: "done" });
    expect(result.verdict).toBe("verified");
    // Struggling reports carry the gate's failing line, never npm's echo.
    for (const r of of(result.log, "item.struggling")) {
      expect(r.payload.lastFailure ?? "").not.toMatch(/^>/);
    }
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

describe("acceptance progress per revision (advisory)", () => {
  it("records how many gate checks passed on each revision, shows the change, and never decides the verdict", async () => {
    const projectDir = await project();
    let runs = 0;
    // The baseline run, then a failing revision (2 of 3 passing), then a passing one.
    const gate: CommandRunner = {
      async run() {
        runs += 1;
        return runs <= 2
          ? { code: 1, stdout: "      Tests  1 failed | 2 passed (3)\n", stderr: "AssertionError: one check still fails\n" }
          : { code: 0, stdout: "      Tests  3 passed (3)\n", stderr: "" };
      },
    };
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate });
    const revs = of(result.log, "integrated.rev");
    expect(revs[0]!.payload.progress).toEqual({ passed: 2, failed: 1, total: 3 });
    expect(revs.at(-1)!.payload.progress).toEqual({ passed: 3, failed: 0, total: 3 });
    const summary = formatBoardRunSummary(result);
    // No suite named its files: the counts are not labeled as the acceptance suite's.
    expect(summary).toMatch(/rev 1: 2\/3 checks passing \(advisory; the gate decides\)/);
    expect(summary).toMatch(/rev 2: 3\/3 checks passing \(\+1\)/);
    const { buildBoardGraph } = await import("../src/board-graph.ts");
    const graph = buildBoardGraph(result.log);
    expect(graph.ticker.rev?.progress).toMatchObject({ passed: 3, total: 3 });
    expect(graph.nodes.find((n) => n.id === "rev:2")!.detail).toMatchObject({ progress: { passed: 3, total: 3, delta: 1 } });
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

describe("acceptance progress per suite (advisory)", () => {
  it("labels the acceptance suite from the immutable gate, never counts the developer suite as acceptance, and says when a typecheck stopped the gate first", async () => {
    const projectDir = await project();
    await mkdir(join(projectDir, "gate"), { recursive: true });
    await writeFile(join(projectDir, "gate/acceptance.test.ts"), "// the acceptance suite\n");
    const developer = " RUN  v2\n ✓ tests/core.test.ts (9 tests) 5ms\n Test Files  1 passed (1)\n      Tests  9 passed (9)\n";
    const acceptance = (passed: number, failed: number) =>
      ` RUN  v2\n ${failed > 0 ? "❯" : "✓"} gate/acceptance.test.ts (${passed + failed} tests${failed > 0 ? ` | ${failed} failed` : ""})\n Test Files  1 ${failed > 0 ? "failed" : "passed"} (1)\n      Tests  ${failed > 0 ? `${failed} failed | ` : ""}${passed} passed (${passed + failed})\n`;
    let runs = 0;
    // The baseline (developer 9/9, acceptance 1/4), a revision whose typecheck
    // fails (no suite runs), then a passing one.
    const gate: CommandRunner = {
      async run() {
        runs += 1;
        if (runs === 1) {
          return { code: 1, stdout: `> tsc --noEmit && vitest run && vitest run --config gate/vitest.config.ts\n${developer}${acceptance(1, 3)}`, stderr: "" };
        }
        if (runs === 2) {
          return { code: 2, stdout: "> tsc --noEmit\nsrc/core/a.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'.\n", stderr: "" };
        }
        return { code: 0, stdout: `${developer}${acceptance(4, 0)}`, stderr: "" };
      },
    };
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["vitest", "run", "gate"], verifyCommandRunner: gate });
    expect(result.state.immutable).toContain("gate/acceptance.test.ts");
    const revs = of(result.log, "integrated.rev");
    expect(revs[0]!.payload.progress).toEqual({ passed: 0, failed: 0, total: 0, acceptanceNotRun: "typecheck failed (1 error)" });
    expect(revs.at(-1)!.payload.progress).toEqual({
      passed: 13,
      failed: 0,
      total: 13,
      suites: [
        { passed: 9, failed: 0, total: 9, suite: "developer" },
        { passed: 4, failed: 0, total: 4, suite: "acceptance" },
      ],
      acceptance: { passed: 4, failed: 0, total: 4 },
    });
    const summary = formatBoardRunSummary(result);
    expect(summary).toMatch(/rev 1: acceptance suite did not run: typecheck failed \(1 error\) \(advisory; the gate decides\)/);
    expect(summary).toMatch(new RegExp(`rev ${revs.at(-1)!.payload.n}: acceptance 4/4 passing; developer 9/9`));
    expect(summary).not.toMatch(/9\/9 acceptance/);
    const { buildBoardGraph } = await import("../src/board-graph.ts");
    const graph = buildBoardGraph(result.log);
    expect(graph.ticker.rev?.progress).toMatchObject({ label: "acceptance 4/4 passing; developer 9/9", passed: 4, total: 4, acceptance: true });
    expect(graph.nodes.find((n) => n.id === "rev:1")!.detail).toMatchObject({ progress: { label: "acceptance suite did not run: typecheck failed (1 error)" } });
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

describe("a stronger executor for complex items", () => {
  it("a large item starts one rung below the strongest configured model, a small one on the base model, and every edit records its model", async () => {
    const projectDir = await project();
    const executor = new ModelStampingExecutor();
    const twoItems = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: [
        { item: "big", objective: "report status across core and the entry", acceptance: ["gate passes"], scopeHint: ["src/core/**", "src/index.ts"] },
        { item: "small", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/handler.ts"] },
      ],
    });
    const result = await offline({ goal: GOAL, projectDir, seed: twoItems, executor, escalationModels: ["m1", "m2"] });
    expect(executor.contexts.find((c) => c.workUnitId === "big")!.model).toBe("m1");
    expect(executor.contexts.find((c) => c.workUnitId === "small")!.model).toBeUndefined();
    expect(result.editModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item: "big", model: "m1", why: "it spans 3 files" }),
        expect.objectContaining({ item: "small", model: "base" }),
      ]),
    );
    expect(of(result.log, "push.announced").find((m) => m.payload.item === "big")!.rationale).toMatch(/model: m1, stronger: it spans 3 files/);
    expect(formatBoardRunSummary(result)).toMatch(/edit models: .*stronger for complex items: big \(it spans 3 files\)/);
  });
});

describe("no claim hoarding (the active-claim cap)", () => {
  it("a greedy agent never holds more unfinished items than the cap; other agents get the open items; the run completes", async () => {
    const projectDir = await project();
    const sixItems = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: Array.from({ length: 6 }, (_, i) => ({ item: `i${i}`, objective: `do part ${i}`, acceptance: ["gate passes"], scopeHint: [`src/part${i}.ts`] })),
    });
    // agent-1 tries to claim every open item before doing anything else.
    const policy = createGenericBoardPolicy();
    const greedy: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      if (input.agent === "agent-1") {
        const tried = new Set(input.capsule.decisions.filter((h) => h.action.type === "claim").map((h) => (h.action as { itemId: string }).itemId));
        const open = input.digest.openItems.find((i) => !tried.has(i.item));
        if (open) {
          return { action: { type: "claim", itemId: open.item, intent: { read: [], write: [...open.scopeHint] }, rationale: "taking everything" } };
        }
      }
      return policy(input);
    };
    const result = await offline({ goal: GOAL, projectDir, seed: sixItems, transport: greedy, fixtureGate: true });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.rules.maxActiveClaims).toBe(1);
    // At every grant, the grantee holds at most the cap of unfinished change items.
    for (const grant of of(log, "claim.granted")) {
      const state = foldBoard(log, grant.seq);
      expect({ seq: grant.seq, held: activeClaims(state, grant.payload.agent).length <= 1 }).toEqual({ seq: grant.seq, held: true });
    }
    expect(result.turns.some((t) => t.agent === "agent-1" && t.code === "CLAIM_CAP")).toBe(true);
    const owners = new Set(of(log, "claim.granted").filter((m) => /^i\d$/.test(m.payload.item)).map((m) => m.payload.agent));
    expect(owners.size).toBeGreaterThan(1);
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(log)).toEqual(result.state);
  });
});

describe("budgets that scale with the plan (explicit values win)", () => {
  it("scales fix attempts and the dial's max with the planned items, bounded", async () => {
    const { scaledBudgets } = await import("../src/run-board.ts");
    const dial = { minConcurrency: 1, maxConcurrency: 3 };
    expect(scaledBudgets({ items: 10, dial, scaleDial: true })).toEqual({
      maxFixAttempts: 5,
      fixAttemptsScaled: true,
      dialMax: 6,
      dialScaled: true,
      maxRunTurns: 250,
      runTurnsScaled: true,
      maxActiveClaims: 1,
      activeClaimsScaled: true,
      // The lease: max(150, 40 per agent of the dial's max); the deadline 8 leases.
      claimLeaseMessages: 240,
      leaseScaled: true,
      claimDeadlineMessages: 1920,
      deadlineScaled: true,
    });
    expect(scaledBudgets({ items: 2, dial, scaleDial: true })).toMatchObject({ claimLeaseMessages: 150, claimDeadlineMessages: 1200 });
    expect(scaledBudgets({ items: 2, explicitLease: 30, dial, scaleDial: true })).toMatchObject({ claimLeaseMessages: 30, leaseScaled: false, claimDeadlineMessages: 240 });
    // The run-wide turn budget weighs scope size: max(200, 25 per item + 10 per scope file), at most 800.
    expect(scaledBudgets({ items: 2, dial, scaleDial: true })).toMatchObject({ maxFixAttempts: 3, dialMax: 2, maxRunTurns: 200 });
    expect(scaledBudgets({ items: 7, scopeFiles: 12, dial, scaleDial: false })).toMatchObject({ maxRunTurns: 295 }); // sf7: 7 large items
    expect(scaledBudgets({ items: 15, dial, scaleDial: true })).toMatchObject({ maxRunTurns: 375 });
    expect(scaledBudgets({ items: 40, scopeFiles: 60, dial, scaleDial: true })).toMatchObject({ maxFixAttempts: 6, dialMax: 6, maxRunTurns: 800 });
    // The claim cap: 1, or 2 when items are at least three times the dial's max.
    expect(scaledBudgets({ items: 9, dial, scaleDial: false })).toMatchObject({ maxActiveClaims: 2 });
    expect(scaledBudgets({ items: 8, dial, scaleDial: false })).toMatchObject({ maxActiveClaims: 1 });
    expect(
      scaledBudgets({ items: 10, explicitFixAttempts: 2, explicitRunTurns: 1000, explicitActiveClaims: 3, explicitLease: 90, explicitDeadline: 500, dial, scaleDial: false }),
    ).toEqual({
      maxFixAttempts: 2,
      fixAttemptsScaled: false,
      dialMax: 3,
      dialScaled: false,
      maxRunTurns: 1000,
      runTurnsScaled: false,
      maxActiveClaims: 3,
      activeClaimsScaled: false,
      claimLeaseMessages: 90,
      leaseScaled: false,
      claimDeadlineMessages: 500,
      deadlineScaled: false,
    });
  });

  it("says so when a plan is empty or the scaled turn budget is capped below what the plan asks", async () => {
    const { scaledBudgets, formatBudgetsLine } = await import("../src/run-board.ts");
    const dial = { minConcurrency: 1, maxConcurrency: 3 };
    const empty = scaledBudgets({ items: 0, dial, scaleDial: false });
    expect(empty.warnings).toEqual([expect.stringMatching(/the plan has no items: .*never ends all-items-done/)]);
    const huge = scaledBudgets({ items: 900, dial, scaleDial: false });
    expect(huge.maxRunTurns).toBe(800);
    expect(huge.warnings).toEqual([expect.stringMatching(/capped at 800 \(the plan's size asks for 22500, and it has more items \(900\) than turns\): pass an explicit run-turn budget/)]);
    expect(formatBudgetsLine({ ...huge, items: 900 })).toContain("; warning: the plan-scaled run-turn budget is capped at 800");
    // An explicit budget silences it; a plan that fits has none.
    expect(scaledBudgets({ items: 900, explicitRunTurns: 30000, dial, scaleDial: false }).warnings).toBeUndefined();
    expect(scaledBudgets({ items: 10, dial, scaleDial: false }).warnings).toBeUndefined();
  });

  it("an explicit goal-rule claim cap is respected, never overwritten by the scaled one", async () => {
    const result = await offline({ goal: GOAL, projectDir: await project(), seed, rules: { maxActiveClaims: 3 } });
    expect(of(result.log, "goal.posted")[0]!.payload.rules).toMatchObject({ maxActiveClaims: 3 });
    expect(formatBoardRunSummary(result)).toMatch(/claim cap 3 unfinished item\(s\) per agent \(explicit\)/);
  });

  it("a run posts the scaled fix budget with its goal, recruits under the scaled dial, and prints the effective values", async () => {
    const projectDir = await project();
    const tenItems = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: Array.from({ length: 10 }, (_, i) => ({ item: `i${i}`, objective: `do part ${i}`, acceptance: ["gate passes"], scopeHint: [`src/part${i}.ts`] })),
    });
    const result = await offline({ goal: GOAL, projectDir, seed: tenItems, scaleDial: true });
    expect(of(result.log, "goal.posted")[0]!.payload.rules).toMatchObject({ maxFixAttempts: 5, maxActiveClaims: 1, claimLeaseMessages: 240, claimDeadlineMessages: 1920 });
    expect(of(result.log, "agent.joined").filter((m) => m.from !== "lead").length).toBeLessThanOrEqual(6);
    expect(of(result.log, "agent.joined").filter((m) => m.from !== "lead").length).toBeGreaterThan(3);
    expect(formatBoardRunSummary(result)).toMatch(
      /budgets: 5 fix attempt\(s\) per item \(scaled with 10 planned item\(s\)\), dial max 6 \(scaled with 10 planned item\(s\)\), 350 run turn\(s\) \(scaled with 10 planned item\(s\) and 10 scope file\(s\)\), claim cap 1 unfinished item\(s\) per agent \(scaled\), claim lease 240 board message\(s\) without progress \(scaled with dial max 6\), claim deadline 1920 message\(s\)/,
    );
  });
});

/** The storefront failure, in small: an item's code uses `ctx.user` on the shared Ctx type that no item owns. */
class CtxUserExecutor implements ExecutorProvider {
  readonly name = "ctx-user";
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const written: string[] = [];
    for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
      const body =
        path === "src/shared/ctx.ts"
          ? "export interface Ctx {\n  store: string;\n  user?: string;\n}\n"
          : path === "src/res/a.ts"
            ? 'import type { Ctx } from "../shared/ctx.ts";\nexport const a = (ctx: Ctx) => ctx.user ?? "anonymous";\n'
            : `import type { Ctx } from "../shared/ctx.ts";\nexport const ${path.slice(-4, -3)} = (ctx: Ctx) => ctx.store.toUpperCase();\n`;
      await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
      await writeFile(join(context.worktreeDir, path), body);
      written.push(path);
    }
    return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `edit ${context.workUnitId}` };
  }
}

/** A typecheck-then-test gate over that project: a TS2339 while Ctx lacks `user`, a failing test until a.ts reads it. */
class CtxTypecheckGate implements CommandRunner {
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const a = await readFile(join(cwd, "src/res/a.ts"), "utf8");
    const ctx = await readFile(join(cwd, "src/shared/ctx.ts"), "utf8");
    if (a.includes("ctx.user") && !ctx.includes("user?")) {
      return { code: 2, stdout: "> tsc --noEmit\nsrc/res/a.ts(2,41): error TS2339: Property 'user' does not exist on type 'Ctx'.\n", stderr: "" };
    }
    return a.includes("ctx.user") ? { code: 0, stdout: "ok 1 - a greets the user\n", stderr: "" } : { code: 1, stdout: "not ok 1 - a greets the user\n# src/res/a.ts\n", stderr: "" };
  }
}

/** Writes a guard into every in-scope resource file it edits (never the shared contract). */
class GuardExecutor implements ExecutorProvider {
  readonly name = "guard";
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const written: string[] = [];
    for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
      const name = path.split("/").pop()!.replace(/\.js$/, "");
      await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
      await writeFile(
        join(context.worktreeDir, path),
        `import { requireAuth } from "../contracts/auth.js";\nexport const ${name} = (req) => requireAuth(req) ?? { status: 200 }; // guarded\n`,
      );
      written.push(path);
    }
    return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `guard ${context.workUnitId}` };
  }
}

/**
 * The service-api regression (reg2): until every resource is guarded the gate
 * fails with node's spec output whose assertion names the RESOURCE while a
 * stack frame (the callee) names the shared contract src/contracts/auth.js.
 */
class ResourceGuardGate implements CommandRunner {
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const unguarded: string[] = [];
    for (const name of ["users", "orders", "products"]) {
      if (!(await readFile(join(cwd, `src/resources/${name}.js`), "utf8")).includes("// guarded")) unguarded.push(name);
    }
    if (unguarded.length === 0) {
      return { code: 0, stdout: "✔ users: guarded\n✔ orders: guarded\n✔ products: guarded\nℹ pass 3\nℹ fail 0\n", stderr: "" };
    }
    const name = unguarded[0]!;
    return {
      code: 1,
      stdout: [
        `✖ ${name}: unauthenticated request is rejected (401/403) (3ms)`,
        `  AssertionError [ERR_ASSERTION]: ${name} must reject an unauthenticated request via requireAuth, got 201`,
        `      at requireAuth (${cwd}/src/contracts/auth.js:4:9)`,
        `      at handle (${cwd}/src/resources/${name}.js:2:30)`,
        `      at TestContext.<anonymous> (${cwd}/test/api.test.js:9:5)`,
        `ℹ pass ${3 - unguarded.length}`,
        `ℹ fail ${unguarded.length}`,
      ].join("\n"),
      stderr: "",
    };
  }
}

describe("seam first (shared seams from the cohesion blueprint)", () => {
  it("reg2: a failure whose stack frame names a shared contract never becomes a seam-scoped uncovered item, and the run completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scf-reg2-"));
    const files: Record<string, string> = {
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/contracts/auth.js": "export const requireAuth = (req) => (req && req.token ? null : { status: 401 });\n",
      "test/api.test.js": "// the acceptance tests\n",
    };
    for (const name of ["users", "orders", "products"]) {
      files[`src/resources/${name}.js`] = `import { requireAuth } from "../contracts/auth.js";\nexport const ${name} = () => ({ status: 201 });\n`;
    }
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    // The planner covers the resources only: the shared contract belongs to no item.
    const resources = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: ["users", "orders", "products"].map((n) => ({ item: `unit-${n}`, objective: `require auth in ${n}`, acceptance: ["gate passes"], scopeHint: [`src/resources/${n}.js`] })),
    });
    const result = await offline({
      goal: GOAL,
      projectDir: dir,
      seed: resources,
      executor: new GuardExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new ResourceGuardGate(),
    });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.seams?.map((seam) => seam.path)).toContain("src/contracts/auth.js");
    // No item (uncovered or otherwise) is scoped to the shared contract, and nobody pushed it.
    expect(of(log, "item.proposed").filter((m) => m.payload.scopeHint.some((h) => h.includes("contracts/auth.js")))).toEqual([]);
    expect(of(log, "push.announced").filter((m) => m.payload.paths.includes("src/contracts/auth.js"))).toEqual([]);
    // Nothing was held SEAM_FIRST.
    expect(result.turns.filter((t) => t.code === "SEAM_FIRST")).toEqual([]);
    expect(result.incompleteItems).toEqual([]);
    expect(result.verdict).toBe("verified");
    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("derives the storefront's seams and their importers", async () => {
    const { sharedSeams } = await import("../src/run-board.ts");
    const { fileURLToPath } = await import("node:url");
    const seams = await sharedSeams(fileURLToPath(new URL("../../../examples/apps/storefront", import.meta.url)));
    const money = seams.find((s) => s.path === "src/contracts/money.ts")!;
    expect(money.importers).toEqual(expect.arrayContaining(["src/orders/cart.ts", "src/billing/tax.ts", "src/catalog/products.ts"]));
    expect(seams.map((s) => s.path)).toEqual(expect.arrayContaining(["src/contracts/auth.ts", "src/contracts/http.ts", "src/store.ts"]));
  });

  it("the seam change is integrated before any item importing it is edited, and the importers rebase onto it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scf-seam-project-"));
    const files: Record<string, string> = {
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/shared/util.ts": "export const unit = 1;\n",
    };
    for (const name of ["a", "b", "c"]) {
      files[`src/res/${name}.ts`] = `import { unit } from "../shared/util.ts";\nexport const ${name} = unit;\n`;
    }
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    const seamSeed = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: [
        ...["a", "b", "c"].map((n) => ({ item: `res-${n}`, objective: `use the new unit in ${n}`, acceptance: ["gate passes"], scopeHint: [`src/res/${n}.ts`] })),
        { item: "util", objective: "change the shared unit", acceptance: ["gate passes"], scopeHint: ["src/shared/util.ts"] },
      ],
    });
    const result = await offline({ goal: GOAL, projectDir: dir, seed: seamSeed });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.seams).toEqual([{ path: "src/shared/util.ts", importers: ["src/res/a.ts", "src/res/b.ts", "src/res/c.ts"], symbols: ["unit"] }]);
    const utilPush = of(log, "push.announced").find((m) => m.payload.item === "util")!;
    const utilRev = of(log, "integrated.rev").find((r) => r.payload.merged.includes(utilPush.payload.commit))!;
    const dependentPushes = of(log, "push.announced").filter((m) => m.payload.item.startsWith("res-"));
    expect(dependentPushes.length).toBe(3);
    expect(dependentPushes.every((m) => m.seq > utilRev.seq)).toBe(true);
    expect(result.verdict).not.toBe("failed");
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("SEAM_FIRST holds plus a seam item nobody works on never end a run quiescent: it is recorded stalled, released, and taken by another agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scf-seam-stall-"));
    const files: Record<string, string> = {
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/shared/ctx.ts": "export interface Ctx {\n  store: string;\n}\n",
    };
    for (const name of ["a", "b", "c"]) {
      files[`src/res/${name}.ts`] = `import type { Ctx } from "../shared/ctx.ts";\nexport const ${name} = (ctx: Ctx) => ctx.store;\n`;
    }
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    const ctxSeed = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: ["a", "b", "c"].map((n) => ({ item: `res-${n}`, objective: `greet the user in ${n}`, acceptance: ["gate passes"], scopeHint: [`src/res/${n}.ts`] })),
    });
    // The proposer of a seam contract is granted its seam item, but never
    // works on it (it only waits): its dependents are held, the board goes quiet.
    const policy = createGenericBoardPolicy();
    const absentOwner: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string };
      return action.itemId?.startsWith(`seam-${input.agent}-`) ? { action: { type: "wait", reason: "not now" } } : outcome;
    };
    const events: BoardRunEvent[] = [];
    const result = await offline({
      goal: GOAL,
      projectDir: dir,
      seed: ctxSeed,
      executor: new CtxUserExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new CtxTypecheckGate(),
      transport: absentOwner,
      // A spare agent: someone idle can take a released seam item.
      dial: { minConcurrency: 1, maxConcurrency: 4 },
      onEvent: (e) => events.push(e),
    });
    const log = result.log;
    const accepted = of(log, "contract.accepted")[0]!;
    const seamItem = `seam-${accepted.payload.contract}`;
    // Granted to the proposer at once, by the engine.
    const grant = of(log, "claim.granted").find((m) => m.payload.item === seamItem)!;
    expect(grant.from).toBe("engine");
    expect(log.find((m) => m.type === "contract.proposed" && m.payload.contract === accepted.payload.contract)!.from).toBe(grant.payload.agent);
    // Quiet with a hold: recorded stalled and released (no push of the owner's), never quiescent with it.
    const stalled = of(log, "seam.stalled").find((m) => m.payload.item === seamItem)!;
    expect(stalled.payload.released).toBe(true);
    expect(events.find((e) => e.kind === "seam-stalled")).toMatchObject({ item: seamItem, released: true });
    // Another agent took it, its change landed in a passing revision, and the run completed.
    const regrant = of(log, "claim.granted").find((m) => m.payload.item === seamItem && m.seq > stalled.seq)!;
    expect(regrant.payload.agent).not.toBe(grant.payload.agent);
    const seamPush = of(log, "push.announced").find((m) => m.payload.item === seamItem)!;
    expect(seamPush.from).toBe(regrant.payload.agent);
    expect(result.state.items[seamItem]!.status).toBe("done");
    expect(result.incompleteItems).toEqual([]);
    expect(result.verdict).not.toBe("failed");
    expect(formatBoardTranscript(log)).toMatch(/seam\.stalled\s+seam-.* released for another agent/);
    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("an OPEN seam item with no free agent: a busy agent claims it itself (seam items are exempt from the claim cap and offered to agents with room), and the run completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scf-seam-open-"));
    const files: Record<string, string> = {
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/shared/ctx.ts": "export interface Ctx {\n  store: string;\n}\n",
    };
    for (const name of ["a", "b", "c"]) {
      files[`src/res/${name}.ts`] = `import type { Ctx } from "../shared/ctx.ts";\nexport const ${name} = (ctx: Ctx) => ctx.store;\n`;
    }
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    const ctxSeed = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: ["a", "b", "c"].map((n) => ({ item: `res-${n}`, objective: `greet the user in ${n}`, acceptance: ["gate passes"], scopeHint: [`src/res/${n}.ts`] })),
    });
    const policy = createGenericBoardPolicy();
    const absentOwner: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string };
      return action.itemId?.startsWith(`seam-${input.agent}-`) ? { action: { type: "wait", reason: "not now" } } : outcome;
    };
    const result = await offline({
      goal: GOAL,
      projectDir: dir,
      seed: ctxSeed,
      executor: new CtxUserExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new CtxTypecheckGate(),
      transport: absentOwner,
    });
    const log = result.log;
    const stalled = of(log, "seam.stalled")[0]!;
    expect(stalled.payload.released).toBe(true);
    const regrant = of(log, "claim.granted").find((m) => m.payload.item === stalled.payload.item && m.seq > stalled.seq)!;
    // Nobody was free: the claimant was holding another item when it took the open seam item.
    const before = foldBoard(log, regrant.seq - 1);
    expect(Object.values(before.items).some((i) => i.status === "claimed" && i.owner === regrant.payload.agent)).toBe(true);
    expect(result.state.items[stalled.payload.item]!.status).toBe("done");
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("concurrent schedule: a quiet board with a SEAM_FIRST hold records the seam item stalled before quiescence could end the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scf-seam-stall-live-"));
    const files: Record<string, string> = {
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/shared/ctx.ts": "export interface Ctx {\n  store: string;\n}\n",
    };
    for (const name of ["a", "b", "c"]) {
      files[`src/res/${name}.ts`] = `import type { Ctx } from "../shared/ctx.ts";\nexport const ${name} = (ctx: Ctx) => ctx.store;\n`;
    }
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    const ctxSeed = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: ["a", "b", "c"].map((n) => ({ item: `res-${n}`, objective: `greet the user in ${n}`, acceptance: ["gate passes"], scopeHint: [`src/res/${n}.ts`] })),
    });
    const policy = createGenericBoardPolicy();
    const absentOwner: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string };
      return action.itemId?.startsWith(`seam-${input.agent}-`) ? { action: { type: "wait", reason: "not now" } } : outcome;
    };
    const { base } = await direct("change-seam-stall-live");
    const result = await runBoard({
      ...base,
      projectDir: dir,
      seed: ctxSeed,
      transport: absentOwner,
      executor: new CtxUserExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new CtxTypecheckGate(),
      dial: { minConcurrency: 1, maxConcurrency: 4 },
      schedule: "concurrent",
      pollMs: 20,
      // Longer than an idle agent's longest poll backoff (4 s), so an agent sees the released item.
      budgets: { quiescenceMs: 10_000, timeoutMs: 100_000 },
    });
    const stalled = of(result.log, "seam.stalled");
    expect(stalled.length).toBeGreaterThanOrEqual(1);
    expect(stalled[0]!.payload.released).toBe(true);
    // Whatever the schedule did next (timing decides who is free to take the
    // released item; the lockstep test above pins completion), the run never
    // ended with a SEAM_FIRST hold in effect.
    expect(seamHolds(result.state)).toEqual([]);
    expect(reduceBoard(result.log)).toEqual(result.state);
  }, 120_000);

  it("a seam contract gets an ADVISORY triage before the lead decides: recorded on the board, kept on the contract, shown in the lead's turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scf-seam-triage-"));
    const files: Record<string, string> = {
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/shared/ctx.ts": "export interface Ctx {\n  store: string;\n}\n",
    };
    for (const name of ["a", "b", "c"]) {
      files[`src/res/${name}.ts`] = `import type { Ctx } from "../shared/ctx.ts";\nexport const ${name} = (ctx: Ctx) => ctx.store;\n`;
    }
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    const ctxSeed = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: ["a", "b", "c"].map((n) => ({ item: `res-${n}`, objective: `greet the user in ${n}`, acceptance: ["gate passes"], scopeHint: [`src/res/${n}.ts`] })),
    });
    const asked: string[] = [];
    const jev: AskJev = async (state, questions) => {
      if ("triage" in questions) {
        asked.push(String((questions.triage as { instructions: string }).instructions));
        expect(state).toContain("shared seam");
        return { triage: { type: "choice", choice: "accept", confidence: 0.92 } };
      }
      throw new Error("not asked in this test");
    };
    const policy = createGenericBoardPolicy();
    const leadSaw: { contract: string; triage?: string; namedInFailure?: boolean }[] = [];
    const recording: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      if (input.role === "lead") leadSaw.push(...input.board.pendingContracts.filter((c) => c.seam !== undefined));
      return policy(input);
    };
    const result = await offline({
      goal: GOAL,
      projectDir: dir,
      seed: ctxSeed,
      executor: new CtxUserExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new CtxTypecheckGate(),
      transport: recording,
      jev,
    });
    const proposal = of(result.log, "contract.proposed").find((m) => m.payload.target === "src/shared/ctx.ts")!;
    const triage = of(result.log, "decision.recorded").find((m) => m.payload.juncture === "contract-triage" && m.payload.contract === proposal.payload.contract)!;
    expect(triage.payload).toMatchObject({ answer: "accept", confidence: 0.92, accepted: true });
    expect(triage.payload.question).toMatch(/shared seam/);
    expect(asked[0]).toMatch(/shared seam/);
    expect(result.state.contracts[proposal.payload.contract]!.triage).toBe("accept (confidence 0.92)");
    // Recorded before the lead decided, and shown to it with the mechanical facts.
    const decided = of(result.log, "contract.accepted").find((m) => m.payload.contract === proposal.payload.contract)!;
    expect(triage.seq).toBeLessThan(decided.seq);
    expect(leadSaw.find((c) => c.contract === proposal.payload.contract)).toMatchObject({ triage: "accept (confidence 0.92)", namedInFailure: true });
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a type error on a frozen shared seam becomes a seam contract the LEAD decides, then a seam item that lands first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scf-seam-contract-"));
    const files: Record<string, string> = {
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/shared/ctx.ts": "export interface Ctx {\n  store: string;\n}\n",
    };
    for (const name of ["a", "b", "c"]) {
      files[`src/res/${name}.ts`] = `import type { Ctx } from "../shared/ctx.ts";\nexport const ${name} = (ctx: Ctx) => ctx.store;\n`;
    }
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    // No item owns the seam: it is frozen.
    const ctxSeed = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: ["a", "b", "c"].map((n) => ({ item: `res-${n}`, objective: `greet the user in ${n}`, acceptance: ["gate passes"], scopeHint: [`src/res/${n}.ts`] })),
    });
    const result = await offline({
      goal: GOAL,
      projectDir: dir,
      seed: ctxSeed,
      executor: new CtxUserExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new CtxTypecheckGate(),
    });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.seams).toEqual([{ path: "src/shared/ctx.ts", importers: ["src/res/a.ts", "src/res/b.ts", "src/res/c.ts"], symbols: ["Ctx"] }]);
    // The failing revision's TS2339 is attributed to the item whose file it names.
    const failing = of(log, "integrated.rev").find((r) => r.payload.gate === "fail" && (r.payload.failing?.output ?? "").includes("TS2339"))!;
    expect(failing.payload.failing!.items).toEqual(["res-a"]);
    // The owner proposed a seam contract with the needed change, not an undeclared field.
    const proposal = of(log, "contract.proposed").find((m) => m.payload.target === "src/shared/ctx.ts")!;
    expect(proposal.payload).toMatchObject({ item: "res-a", kind: "modify" });
    expect(proposal.payload.description).toMatch(/Property 'user' does not exist on type 'Ctx'/);
    expect(proposal.seq).toBeGreaterThan(failing.seq);
    // The LEAD decided it (no human escalation), and the engine scheduled the seam item.
    expect(of(log, "contract.escalated")).toEqual([]);
    const decision = of(log, "contract.accepted").find((m) => m.payload.contract === proposal.payload.contract)!;
    expect(decision.from).toBe("lead");
    const seamItem = of(log, "item.proposed").find((m) => m.payload.fromContract === proposal.payload.contract)!;
    expect(seamItem.from).toBe("engine");
    expect(seamItem.payload.scopeHint).toEqual(["src/shared/ctx.ts"]);
    // The seam change landed in a passing revision, with res-a's fix, and both completed.
    const seamPush = of(log, "push.announced").find((m) => m.payload.item === seamItem.payload.item)!;
    const seamRev = of(log, "integrated.rev").find((r) => r.payload.merged.includes(seamPush.payload.commit))!;
    expect(seamRev.payload.gate).toBe("pass");
    expect(result.state.items[seamItem.payload.item]!.status).toBe("done");
    expect(result.state.items["res-a"]!.status).toBe("done");
    expect(result.incompleteItems).toEqual([]);
    expect(result.verdict).not.toBe("failed");
    expect(reduceBoard(log)).toEqual(result.state);
  });
});

describe("leases and stated wait reasons on a quiet board", () => {
  it("a holder that sits on its claim is recorded stalled, the item is offered, and another agent finishes it", async () => {
    const projectDir = await project();
    const twoItems = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: [
        { item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
        { item: "tests", objective: "test the status report", acceptance: ["gate passes"], scopeHint: ["tests/**"] },
      ],
    });
    const policy = createGenericBoardPolicy();
    // agent-1 claims api and then never edits it: it only waits.
    const sitter: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string };
      return input.agent === "agent-1" && action.type === "edit" && action.itemId === "api" ? { action: { type: "wait", reason: "later" } } : outcome;
    };
    const events: BoardRunEvent[] = [];
    const result = await offline({ goal: GOAL, projectDir, seed: twoItems, transport: sitter, dial: { minConcurrency: 2, maxConcurrency: 2 }, onEvent: (e) => events.push(e) });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.rules).toMatchObject({ claimLeaseMessages: 150, claimDeadlineMessages: 1200 });
    // The goal records the integration baseline; the first revision names it as its base.
    const baseline = of(log, "goal.posted")[0]!.payload.baseline!;
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);
    expect(of(log, "integrated.rev")[0]!.payload.base).toBe(baseline);
    const first = of(log, "claim.granted").find((m) => m.payload.item === "api")!;
    expect(first.payload.agent).toBe("agent-1");
    // The quiet board advanced no message count: the operator recorded the claim stalled.
    const lapsed = of(log, "claim.lapsed").find((m) => m.payload.item === "api")!;
    expect(lapsed.payload).toMatchObject({ agent: "agent-1", reason: "stalled" });
    expect(events).toContainEqual({ kind: "claim-stalled", item: "api", agent: "agent-1" });
    // Another agent took it (the lapsed holder goes after it), and it completed.
    const regrant = of(log, "claim.granted").find((m) => m.payload.item === "api" && m.seq > lapsed.seq)!;
    expect(regrant.payload.agent).toBe("agent-2");
    expect(result.state.items.api!.status).toBe("done");
    expect(result.incompleteItems).toEqual([]);
    expect(formatBoardTranscript(log)).toMatch(/claim\.lapsed\s+api \(held by agent-1\)/);
    expect(reduceBoard(log)).toEqual(result.state);
  });
});

describe("re-plan instead of giving up", () => {
  /** A gate that fails, naming src/core/b.ts, until that file changed. */
  class NeedsCoreBGate implements CommandRunner {
    async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
      const b = await readFile(join(cwd, "src/core/b.ts"), "utf8");
      return b === "export const b = 2;\n"
        ? { code: 1, stdout: "not ok 1 - core reports status\n# src/core/b.ts does not report status yet\n", stderr: "" }
        : { code: 0, stdout: "ok 1 - core reports status\n", stderr: "" };
    }
  }

  /** An executor that only ever edits the FIRST concrete file of an item (so a two-file item never fixes its second file). */
  class FirstFileExecutor implements ExecutorProvider {
    readonly name = "first-file";
    private edits = 0;
    async execute(context: ExecutorContext): Promise<ExecutionResult> {
      this.edits += 1;
      const first = [...context.paths].filter((p) => !/[*?]/.test(p)).sort()[0]!;
      await mkdir(dirname(join(context.worktreeDir, first)), { recursive: true });
      await writeFile(join(context.worktreeDir, first), `// ${context.workUnitId} reports status (edit ${this.edits})\n`);
      return { status: "changed", changedPaths: [first], logs: [], cost: { usd: 0 }, commitMessage: `edit ${context.workUnitId}` };
    }
  }

  it("an item that spends its fix budget gets ONE lead re-plan from the failure attribution (split by the failing file), and the children carry it to a pass", async () => {
    const projectDir = await project();
    const coreOnly = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: [{ item: "core", objective: "report status from core", acceptance: ["gate passes"], scopeHint: ["src/core/**"] }],
    });
    const result = await offline({
      goal: GOAL,
      projectDir,
      seed: coreOnly,
      executor: new FirstFileExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new NeedsCoreBGate(),
      budgets: { maxFixAttemptsPerItem: 1 },
      dial: { minConcurrency: 2, maxConcurrency: 2 },
    });
    const log = result.log;
    const exhausted = of(log, "fix.exhausted").find((m) => m.payload.item === "core")!;
    const replanned = of(log, "item.replanned")[0]!;
    expect(replanned.seq).toBeGreaterThan(exhausted.seq);
    expect(replanned.from).toBe("lead");
    expect(replanned.payload).toMatchObject({
      item: "core",
      reason: "fix-budget-exhausted",
      action: "split",
      rev: exhausted.payload.n,
      children: [
        { item: "core.r1", scopeHint: ["src/core/b.ts"] },
        { item: "core.r2", scopeHint: ["src/core/a.ts"] },
      ],
    });
    expect(of(log, "item.replanned")).toHaveLength(1);
    // The children carried it: they passed, and the re-planned item completed with them.
    expect(result.state.items["core.r1"]!.status).toBe("done");
    expect(result.state.items.core!.status).toBe("done");
    expect(of(log, "item.escalated")).toEqual([]);
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toEqual([]);
    expect(formatBoardTranscript(log)).toMatch(/item\.replanned\s+core \(fix-budget-exhausted\) split into core\.r1 \[src\/core\/b\.ts\]/);
    // Gated, promoted, and the promoted tree is the gated one: proven, with the re-plan on record.
    expect(result.proof).toMatchObject({ status: "proven", promotion: { matchesGated: true }, replans: [expect.objectContaining({ item: "core", action: "split" })] });
    expect(reduceBoard(log)).toEqual(result.state);
  });
});

describe("cost and time caps (demo safety)", () => {
  it("a model-call cap stops new turns, is recorded once, the in-flight work is integrated, and the verdict stays the gate's", async () => {
    const projectDir = await project();
    const events: BoardRunEvent[] = [];
    const result = await offline({ goal: GOAL, projectDir, seed, caps: { maxCalls: 12 }, onEvent: (e) => events.push(e) });
    expect(result.stopReason).toBe("capped");
    expect(result.stopDetail).toMatch(/the model-calls cap was reached \(\d+ of 12\): no new turns/);
    const capped = result.log.filter((m) => m.type === "run.capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]!.payload).toMatchObject({ kind: "model-calls", limit: 12 });
    expect(events.some((e) => e.kind === "capped")).toBe(true);
    // Nothing announced was left ungated: the last integration ran after the cap.
    expect(pendingPushItems(result.state)).toEqual([]);
    expect(result.usage).toMatchObject({ capped: [expect.objectContaining({ kind: "model-calls" })] });
    expect(formatBoardRunSummary(result)).toMatch(/caps: 12 model call\(s\)/);
    expect(formatBoardRunSummary(result)).toMatch(/usage: \d+ model call\(s\)/);
    expect(result.proof!.caps).toEqual([expect.objectContaining({ kind: "model-calls", limit: 12 })]);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a wall-clock cap (on an injected clock) ends the agent phase as capped", async () => {
    const projectDir = await project();
    let now = 0;
    const result = await offline({ goal: GOAL, projectDir, seed, caps: { maxWallMs: 1000 }, capsClock: () => (now += 200) });
    expect(result.stopReason).toBe("capped");
    expect(result.log.find((m) => m.type === "run.capped")!.payload).toMatchObject({ kind: "wall-clock", limit: 1000 });
  });

  it("an item at its call cap gets no more turns (ITEM_CAP), recorded once for that item", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, caps: { maxCallsPerItem: 1 } });
    expect(result.turns.some((t) => t.code === "ITEM_CAP")).toBe(true);
    const itemCaps = result.log.filter((m) => m.type === "run.capped" && (m.payload as { kind: string }).kind === "item-calls");
    expect(itemCaps.length).toBeGreaterThan(0);
    expect(new Set(itemCaps.map((m) => (m.payload as { item: string }).item)).size).toBe(itemCaps.length);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

describe("runBoard never promotes or redeploys a candidate the board did not record", () => {
  /** An executor that stamps every in-scope file with the item and a run-wide attempt number. */
  class AttemptStamp implements ExecutorProvider {
    readonly name = "attempt-stamp";
    private n = 0;
    async execute(context: ExecutorContext): Promise<ExecutionResult> {
      this.n += 1;
      const written: string[] = [];
      for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
        await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
        await writeFile(join(context.worktreeDir, path), `// ${context.workUnitId} attempt ${this.n}\n`);
        written.push(path);
      }
      return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `edit ${context.workUnitId}` };
    }
  }
  /** Fails while src/z.ts holds z's FIRST pushed content; passes everything else. */
  class FirstZFails implements CommandRunner {
    private firstZ: string | undefined;
    async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
      const z = await readFile(join(cwd, "src/z.ts"), "utf8").catch(() => "");
      if (z.includes("attempt") && this.firstZ === undefined) {
        this.firstZ = z;
      }
      return z.includes("attempt") && z === this.firstZ
        ? { code: 1, stdout: "not ok 1 - z\n# src/z.ts:1:1 AssertionError\n", stderr: "" }
        : { code: 0, stdout: "ok 1 - all\n", stderr: "" };
    }
  }

  it("a speculative round whose landed pass is refused after its blamed failure was recorded: verdict failed, no promotion, no redeploy", async () => {
    const root = await mkdtemp(join(tmpdir(), "scf-refused-landing-"));
    const projectDir = join(root, "p");
    for (const [rel, body] of Object.entries({ "package.json": '{"name":"p","scripts":{}}\n', "src/w.ts": "w\n", "src/x.ts": "x\n", "src/y.ts": "y\n", "src/z.ts": "z\n" })) {
      await mkdir(dirname(join(projectDir, rel)), { recursive: true });
      await writeFile(join(projectDir, rel), body);
    }
    const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
    const inner = control.fetch as unknown as typeof fetch;
    // After the first accepted FAILING revision, the board refuses every
    // passing revision (a refusal that is not a stale base: nothing rebuilds).
    let failRecorded = false;
    const refusedPasses: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/integration/revision") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { gate: string; commit: string };
        if (body.gate === "pass" && failRecorded) {
          refusedPasses.push(body.commit);
          return new Response(JSON.stringify({ code: "INVALID_STATE", error: "refused for the test" }), { status: 409, headers: { "content-type": "application/json" } });
        }
        const res = await inner(url as never, init);
        if (body.gate === "fail" && res.status === 201) {
          failRecorded = true;
        }
        return res;
      }
      return inner(url as never, init);
    }) as unknown as typeof fetch;
    const deploys: string[] = [];
    const events: BoardRunEvent[] = [];
    const result = await runBoard({
      goal: GOAL,
      changeId: "refused-landing",
      workerUrl: "http://local-control",
      fetchFn,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      transport: createGenericBoardPolicy(),
      seed: async () => ({
        source: "planner",
        model: "fake-planner",
        items: ["w", "x", "y", "z"].map((item) => ({ item, objective: `do ${item}`, acceptance: ["gate passes"], scopeHint: [`src/${item}.ts`] })),
      }),
      resolveContract: reject,
      workRoot: join(root, "work"),
      projectDir,
      executor: new AttemptStamp(),
      schedule: "lockstep",
      speculate: 3,
      candidateConcurrency: 1,
      appGateCommand: ["gate"],
      verifyCommandRunner: new FirstZFails(),
      budgets: { maxFixAttemptsPerItem: 1, maxRunTurns: 200, maxRounds: 200 },
      deployAppDir: projectDir,
      deployAppName: "refused-landing-app",
      deployApp: async ({ appName }) => {
        deploys.push(appName);
        return { url: `https://${appName}.example.workers.dev` };
      },
      appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
      onEvent: (e) => events.push(e),
    });

    // The branch was reached: a round recorded its blamed failure, then the
    // board refused its landed pass.
    expect(refusedPasses.length).toBeGreaterThan(0);
    expect(result.revisions.map((r) => r.gate)).toEqual(["pass", "fail"]);
    expect(result.integrationFailures.some((f) => /the board refused the revision \(INVALID_STATE\)/.test(f))).toBe(true);
    // The last RECORDED revision is the blamed failure: the verdict says so.
    expect(result.revision!.gate).toBe("fail");
    expect(result.verdict).toBe("failed");
    expect(result.evidence!.integration.commit).toBe(result.revision!.commit);
    expect(refusedPasses).not.toContain(result.evidence!.integration.commit);
    // Nothing promoted, nothing recorded promoted, nothing redeployed.
    expect(result.promotion).toMatchObject({ committed: false });
    expect(result.promotion!.refusedReason).toMatch(/not "verified": not promoting/);
    expect(of(result.log, "revision.promoted")).toEqual([]);
    expect(deploys).toEqual([]);
    expect(result.deployment).toBeUndefined();
    expect(events.some((e) => e.kind === "promoting")).toBe(false);
    expect(result.proof?.status).not.toBe("proven");
    expect(boardRunExitCode(result)).toBe(1);
  }, 120_000);
});

describe("runBoard meters the planner pass's plan-review decisions", () => {
  it("each plan review the seed carries (the chosen plan's and every earlier one's) counts as a model call", async () => {
    const plain = await offline({ goal: GOAL, projectDir: await project(), seed });
    const review = { question: "Does this plan cover the goal?", noul: "yes", confidence: 0.9, accepted: true };
    const reviewed = await offline({
      goal: GOAL,
      projectDir: await project(),
      seed: async () => ({ ...(await seed()), review, priorReviews: [{ ...review, accepted: false, confidence: 0.4, model: "m0", units: ["core"] }] }),
    });
    expect(of(reviewed.log, "decision.recorded").filter((m) => m.payload.juncture === "plan-review")).toHaveLength(2);
    expect(reviewed.usage!.calls - plain.usage!.calls).toBe(2);
  }, 120_000);
});

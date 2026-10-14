/**
 * The board run's fix loop, offline: a failing revision asks the implicated owner
 * for a fix, the executor model escalates one step per attempt (a complex item
 * starts stronger), a spent fix budget reopens the item for another agent or
 * gets one lead re-plan, failures the plan missed become work, typed decisions
 * are recorded advisory, and an earlier pass never ships a later failure. No
 * network: the generic policy (or a scripted transport) takes every turn and
 * deterministic executors edit.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AskJev, AgentTurnTransport, ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { FirstAttemptFailingGate } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, formatBoardTranscript, type BoardSeed } from "../src/run-board.ts";
import { GOAL, ModelStampingExecutor, NeedsSecondEscalationGate, PassOnceGate, of, offline, project, seed } from "./run-board-fixtures.ts";

describe("runBoard (offline, lockstep, continuous integration)", () => {
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
    // After the first pass every revision fails, so one fix attempt per item is enough to show it.
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: new PassOnceGate(), budgets: { maxFixAttemptsPerItem: 1 } });
    expect(result.revisions[0]!.gate).toBe("pass");
    expect(result.revision!.gate).toBe("fail");
    expect(result.verdict).toBe("failed");
    expect(result.promotion?.committed ?? false).toBe(false);
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

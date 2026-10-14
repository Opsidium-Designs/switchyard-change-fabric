/**
 * The board run's contracts and proposals, offline: a contract on the original
 * tests is decided only by a human (and waits durably without one), a worker's
 * late proposal waits for the lead, and a developer test a human released
 * reaches the agent. No network: the generic policy (or a scripted transport)
 * takes every turn and deterministic executors edit.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport, ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { boardRunExitCode, formatBoardRunSummary, type BoardRunEvent, type BoardSeed } from "../src/run-board.ts";
import { GOAL, git, of, offline, project, reject, seed } from "./run-board-fixtures.ts";

describe("runBoard (offline, lockstep, continuous integration)", () => {
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
    const started = Date.now();
    // Nobody decides: a quiet board waiting on a human does not end quiescent; it waits to the time limit.
    const result = await runBoardOffline({ goal: GOAL, projectDir, seed, onEvent: (e) => events.push(e), budgets: { timeoutMs: 6000, humanWaitRecordMs: 2000 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
    expect(events.some((e) => e.kind === "contract-awaiting-human")).toBe(true);
    expect(result.stopReason).toBe("timeout");
    expect(result.stopDetail).toMatch(/wall-clock limit \(6 s.*the run was waiting on 1 human decision\(s\) nobody made \(contract [^)]+\): decide them in the console/);
    // The wait is on the board (bounded: at most one record per interval), never a verdict.
    const waiting = of(result.log, "run.waiting");
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.length).toBeLessThanOrEqual(4);
    expect(waiting[0]!.payload.contracts).toHaveLength(1);
    expect(waiting.every((m) => m.from === "engine" && m.to === undefined && !("waitedMs" in m.payload))).toBe(true);
    expect(events.some((e) => e.kind === "waiting-on-human")).toBe(true);
    expect(reduceBoard(result.log)).toEqual(reduceBoard(result.log));
    expect(result.incompleteItems).toEqual(["tests"]);
    expect(result.verdict).toBe("unverified"); // no gate in this project
    expect(formatBoardRunSummary(result)).toMatch(/unverified \(no gate configured: nothing checked\) \(partial: 1 item\(s\) not completed: tests; the Change is not complete\)/);
    expect(boardRunExitCode(result)).toBe(1);
  });

  it("a human who decides after the old quiet window: the run waits for the decision instead of ending quiescent, then continues and completes", async () => {
    const projectDir = await project();
    let fetchFn: typeof fetch | undefined;
    let resolvedAt: number | undefined;
    let waitingAt: number | undefined;
    const events: BoardRunEvent[] = [];
    const escalations = new Set<string>();
    // Above the idle agents' longest poll (4 s), as the default 120 s window is: a decided contract wakes its owner in time.
    const quietMs = 5000;
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir,
      seed,
      schedule: "concurrent",
      pollMs: 50,
      budgets: { quiescenceMs: quietMs, timeoutMs: 90_000, humanWaitRecordMs: 1000 },
      onControl: (f) => {
        fetchFn = f;
      },
      onEvent: (e) => {
        events.push(e);
        if (e.kind === "contract-awaiting-human") {
          escalations.add(e.escalationId);
        }
        // The board went quiet for the whole quiet window with the decision pending: the old
        // code ended the run quiescent right here. The human clicks a whole window later.
        if (e.kind === "waiting-on-human" && waitingAt === undefined) {
          waitingAt = Date.now();
          setTimeout(() => {
            resolvedAt = Date.now();
            for (const id of escalations) {
              void fetchFn!(`http://local-control/changes/change-board-offline/escalations/${encodeURIComponent(id)}/resolve`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ decision: "accept" }),
              });
            }
          }, quietMs);
        }
      },
    });
    expect(waitingAt).toBeDefined();
    expect(resolvedAt).toBeDefined();
    expect(resolvedAt! - waitingAt!).toBeGreaterThanOrEqual(quietMs);
    expect(result.stopReason).toBe("all-items-done");
    expect(result.incompleteItems).toEqual([]);
    expect(of(result.log, "contract.accepted").map((m) => m.from)).toEqual(["human"]);
    // While it waited, the board said so; after the decision, nothing more is recorded waiting.
    const waiting = of(result.log, "run.waiting");
    expect(waiting.length).toBeGreaterThan(0);
    const accepted = of(result.log, "contract.accepted")[0]!.seq;
    expect(waiting.every((m) => m.seq < accepted)).toBe(true);
    expect(events.filter((e) => e.kind === "waiting-on-human").length).toBe(waiting.length);
    expect(reduceBoard(result.log)).toBeDefined();
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
});

describe("a developer test a human released reaches the agent (live regression sf19)", () => {
  /**
   * A project whose developer test pins the OLD rate outside the item's scope
   * (tests/tax.test.ts) while the immutable acceptance gate asks for the new
   * one. The gate runs the developer suite, then the acceptance suite.
   */
  async function taxProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "scf-board-sf19-"));
    for (const [rel, body] of Object.entries({
      "package.json": '{"name":"p","scripts":{}}\n',
      "src/tax.ts": "export const RATE = 7;\n",
      "tests/tax.test.ts": "expect(RATE).toBe(7);\n",
      "gate/acceptance.test.ts": "expect(RATE).toBe(8);\n",
    })) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    return dir;
  }
  const taxSeed = async (): Promise<BoardSeed> => ({
    source: "planner",
    model: "fake-planner",
    items: [{ item: "billing-tax-correctness", objective: "the tax rate is 8", acceptance: ["gate passes"], scopeHint: ["src/tax.ts"] }],
  });
  const valueIn = async (file: string): Promise<number> => Number(/(\d+)/.exec(await readFile(file, "utf8"))?.[1] ?? NaN);
  /** Developer suite (the test's pinned value equals the code), then acceptance (the code is 8). */
  const taxGate: CommandRunner = {
    async run(_argv, cwd) {
      const rate = await valueIn(join(cwd, "src/tax.ts"));
      const pinned = await valueIn(join(cwd, "tests/tax.test.ts"));
      const developer = rate === pinned ? " ✓ tests/tax.test.ts (1 test)\n" : ` FAIL tests/tax.test.ts > rate\nAssertionError: expected ${rate} to be ${pinned}\n at tests/tax.test.ts:1:14\n`;
      const acceptance = rate === 8 ? " ✓ gate/acceptance.test.ts (1 test)\n" : ` FAIL gate/acceptance.test.ts > rate\nAssertionError: expected ${rate} to be 8\n at gate/acceptance.test.ts:1:14\n`;
      return { code: rate === pinned && rate === 8 ? 0 : 1, stdout: `${developer}${acceptance}`, stderr: "" };
    },
  };
  /** Writes the new rate, and the released test's new expectation when the test is in its paths. */
  class TaxExecutor implements ExecutorProvider {
    readonly name = "tax";
    readonly contexts: ExecutorContext[] = [];
    async execute(context: ExecutorContext): Promise<ExecutionResult> {
      this.contexts.push(context);
      const files: Record<string, string> = {
        "src/tax.ts": "export const RATE = 8;\n",
        ...(context.paths.includes("tests/tax.test.ts") ? { "tests/tax.test.ts": "expect(RATE).toBe(8);\n" } : {}),
      };
      for (const [rel, body] of Object.entries(files)) {
        await mkdir(dirname(join(context.worktreeDir, rel)), { recursive: true });
        await writeFile(join(context.worktreeDir, rel), body);
      }
      return { status: "changed", changedPaths: Object.keys(files), logs: [], cost: { usd: 0 }, commitMessage: "rate 8" };
    }
  }
  const options = async (executor: TaxExecutor) => ({
    goal: "Charge the new tax rate",
    projectDir: await taxProject(),
    seed: taxSeed,
    executor,
    appGateCommand: ["vitest", "run", "gate"],
    verifyCommandRunner: taxGate,
  });

  it("accepted: the push carrying the released test integrates with the code fix, the promoted tree has both, verified, and nothing is recorded regressed", async () => {
    const executor = new TaxExecutor();
    const result = await runBoardOffline({ ...(await options(executor)), resolveContract: async () => "accept" });
    expect(result.state.protected).toContain("tests/tax.test.ts");
    expect(result.state.immutable).toContain("gate/acceptance.test.ts");
    expect(of(result.log, "contract.accepted").map((m) => m.from)).toEqual(["human"]);
    expect(executor.contexts.some((c) => c.paths.includes("tests/tax.test.ts") && /A human accepted changing tests\/tax\.test\.ts/.test(c.objective))).toBe(true);
    const both = of(result.log, "push.announced").filter((m) => m.payload.paths.includes("tests/tax.test.ts"));
    // The released test lands with the code fix: the item's last push (the code
    // fix already in its repo) is the one the passing revision integrated.
    expect(both).toHaveLength(1);
    expect(of(result.log, "push.announced").at(-1)).toBe(both[0]);
    const passed = of(result.log, "integrated.rev").at(-1)!;
    expect(passed.payload.gate).toBe("pass");
    expect(passed.payload.merged).toContain(both[0]!.payload.commit);
    expect(of(result.log, "push.regressed")).toEqual([]);
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toEqual([]);
    for (const [rel, body] of [["src/tax.ts", "export const RATE = 8;\n"], ["tests/tax.test.ts", "expect(RATE).toBe(8);\n"], ["gate/acceptance.test.ts", "expect(RATE).toBe(8);\n"]] as const) {
      const { stdout } = await git("git", ["-C", result.sourceRepoDir!, "show", `${result.promotion!.commit}:${rel}`]);
      expect(stdout).toBe(body);
    }
    expect(reduceBoard(result.log)).toEqual(result.state);
  }, 120_000);

  it("rejected: the developer test is untouched and the run is not verified", async () => {
    const executor = new TaxExecutor();
    const result = await runBoardOffline({ ...(await options(executor)), resolveContract: reject });
    expect(of(result.log, "contract.rejected").length).toBeGreaterThan(0);
    expect(executor.contexts.every((c) => !c.paths.includes("tests/tax.test.ts"))).toBe(true);
    expect(of(result.log, "push.announced").every((m) => !m.payload.paths.includes("tests/tax.test.ts"))).toBe(true);
    expect(result.verdict).not.toBe("verified");
    expect(result.promotion?.committed).not.toBe(true);
  }, 120_000);
});

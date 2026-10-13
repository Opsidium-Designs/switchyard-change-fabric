/**
 * A board run at scale on the offline local control, concurrent schedule:
 *   - 35 items under a dial of 30 with an in-flight limit of 4: workers that
 *     stop are replaced (new, unique ids) while open work remains, every item
 *     completes, and the model calls in flight (turns and edits together)
 *     never exceed the limit;
 *   - a smoke at a dial of 100 with 100 trivial items that completes within
 *     the board's message cap.
 * No network: a scripted wrapper around the generic policy takes every turn
 * and a fast fake executor edits; no gate is declared (the verdict is
 * unverified, nothing checked), so the runs measure coordination only.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { BOARD_LIMITS, reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport, ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { formatBoardRunSummary, maxWorkerJoins, MAX_SCALED_DEADLINE_MESSAGES, runBoard, scaledBudgets, wantsAnotherWorker, type BoardSeed } from "../src/run-board.ts";

/** Counts model calls in flight across every caller (turns and edits share it). */
class InflightProbe {
  now = 0;
  peak = 0;
  calls = 0;
  async around<T>(fn: () => Promise<T>, holdMs: number): Promise<T> {
    this.now += 1;
    this.calls += 1;
    this.peak = Math.max(this.peak, this.now);
    try {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      return await fn();
    } finally {
      this.now -= 1;
    }
  }
}

/** A fast executor that writes each in-scope file once (a fake model call). */
class FastExecutor implements ExecutorProvider {
  readonly name = "fast-fake";
  constructor(private readonly probe: InflightProbe) {}
  execute(context: ExecutorContext): Promise<ExecutionResult> {
    return this.probe.around(async () => {
      const written: string[] = [];
      for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
        await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
        await writeFile(join(context.worktreeDir, path), `// ${context.workUnitId} done\n`);
        written.push(path);
      }
      return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `edit ${context.workUnitId}` };
    }, 1);
  }
}

async function project(files: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-board-scale-"));
  await writeFile(join(dir, "package.json"), '{"name":"p","scripts":{}}\n');
  await mkdir(join(dir, "src"), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    await writeFile(join(dir, "src", `part${i}.ts`), `export const part${i} = ${i};\n`);
  }
  return dir;
}

// Ids with no shared prefix and objectives of their own words only: the plan
// shows no repeated mechanical change, so no codemod is seeded (and no owner is
// held for one).
const itemsSeed = (n: number) => async (): Promise<BoardSeed> => ({
  source: "planner",
  model: "fake-planner",
  items: Array.from({ length: n }, (_, i) => ({ item: `p${i}`, objective: `p${i} ok`, acceptance: ["gate passes"], scopeHint: [`src/part${i}.ts`] })),
});

/**
 * The generic policy, with each worker reading the open items starting at its
 * own offset (agent-k at k): a scripted spread, so a wide pool does not spend
 * its turns all claiming the first open item at once.
 */
function spreadPolicy(): AgentTurnTransport<BoardDigest, BoardMessage> {
  const policy = createGenericBoardPolicy();
  return (input) => {
    const k = Number(input.agent.replace(/^agent-/, "")) || 0;
    const open = input.digest.openItems;
    const at = open.length > 0 ? k % open.length : 0;
    return policy({ ...input, digest: { ...input.digest, openItems: [...open.slice(at), ...open.slice(0, at)] } });
  };
}

async function control(id: string): Promise<{ root: string; fetchFn: typeof fetch }> {
  const root = await mkdtemp(join(tmpdir(), `scf-${id}-`));
  const local = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
  return { root, fetchFn: local.fetch as unknown as typeof fetch };
}

describe("the worker pool at scale", () => {
  it("replaces stopped workers only while open work outnumbers the active ones, within the join bound", () => {
    const dial = { minConcurrency: 1, maxConcurrency: 30 };
    const joinCap = maxWorkerJoins(30);
    expect(joinCap).toBe(60);
    expect(maxWorkerJoins(128)).toBe(BOARD_LIMITS.maxAgents - 1);
    // The first pool fills while open items outnumber the workers.
    expect(wantsAnotherWorker({ joined: 10, active: 10, open: 35, dial, joinCap })).toBe(true);
    // Full: no more, however much is open.
    expect(wantsAnotherWorker({ joined: 30, active: 30, open: 35, dial, joinCap })).toBe(false);
    // Ten stopped and 25 items open: a replacement joins.
    expect(wantsAnotherWorker({ joined: 30, active: 20, open: 25, dial, joinCap })).toBe(true);
    // Stopped workers but nothing open: never a replacement (not even for the dial's min).
    expect(wantsAnotherWorker({ joined: 30, active: 0, open: 0, dial, joinCap })).toBe(false);
    expect(wantsAnotherWorker({ joined: 30, active: 0, open: 0, dial: { minConcurrency: 2, maxConcurrency: 30 }, joinCap })).toBe(false);
    // The join bound holds whatever is open.
    expect(wantsAnotherWorker({ joined: 60, active: 0, open: 35, dial, joinCap })).toBe(false);
    // The dial's min still fills the first pool with nothing open, as before.
    expect(wantsAnotherWorker({ joined: 0, active: 0, open: 0, dial: { minConcurrency: 2, maxConcurrency: 3 }, joinCap: 6 })).toBe(true);
  });

  it("keeps a wide dial's claim deadline within the board's message cap", () => {
    const wide = scaledBudgets({ items: 100, dial: { minConcurrency: 1, maxConcurrency: 100 }, scaleDial: false });
    expect(wide.claimLeaseMessages).toBe(4000);
    expect(wide.claimDeadlineMessages).toBe(MAX_SCALED_DEADLINE_MESSAGES);
    expect(wide.claimDeadlineMessages).toBeLessThan(BOARD_LIMITS.maxMessages - BOARD_LIMITS.batchReserve);
    // A small dial keeps its 8 leases.
    expect(scaledBudgets({ items: 10, dial: { minConcurrency: 1, maxConcurrency: 6 }, scaleDial: false }).claimDeadlineMessages).toBe(1920);
    // The capped run-turn warning names the exact --max-turns the plan asks for.
    const big = scaledBudgets({ items: 35, scopeFiles: 35, dial: { minConcurrency: 1, maxConcurrency: 30 }, scaleDial: false });
    expect(big.maxRunTurns).toBe(800);
    expect(big.warnings).toEqual([expect.stringContaining("(--max-turns 1225)")]);
  });

  it("35 items, dial 30, 4 calls in flight: stopped workers are replaced, ids stay unique, every item completes", async () => {
    const started = Date.now();
    const projectDir = await project(35);
    const { root, fetchFn } = await control("board-scale-30");
    const probe = new InflightProbe();
    const policy = spreadPolicy();
    // Workers agent-1..agent-20 fail their very first turn (before claiming
    // anything): they stop, so the pool must replace them to finish.
    const crashed = new Set(Array.from({ length: 20 }, (_, i) => `agent-${i + 1}`));
    const seen = new Set<string>();
    const transport: AgentTurnTransport<BoardDigest, BoardMessage> = (input) =>
      probe.around(async () => {
        const first = !seen.has(input.agent);
        seen.add(input.agent);
        if (first && crashed.has(input.agent)) {
          throw new Error("simulated crash on the first turn");
        }
        return policy(input);
      }, 2);
    const result = await runBoard({
      goal: "update every part",
      projectDir,
      changeId: "change-board-scale-30",
      workerUrl: "http://local-control",
      fetchFn,
      dial: { minConcurrency: 1, maxConcurrency: 30 },
      maxInflight: 4,
      transport,
      executor: new FastExecutor(probe),
      seed: itemsSeed(35),
      resolveContract: async () => "reject",
      schedule: "concurrent",
      speculate: 1,
      pollMs: 20,
      budgets: { timeoutMs: 80_000, quiescenceMs: 10_000, maxRunTurns: 3000 },
      workRoot: join(root, "work"),
    });
    const elapsed = Date.now() - started;
    expect(result.stopReason).toBe("all-items-done");
    expect(Object.values(result.state.items).every((i) => i.status === "done")).toBe(true);
    expect(result.incompleteItems).toEqual([]);
    // The in-flight bound held for every model call (turns and edits).
    expect(probe.peak).toBeLessThanOrEqual(4);
    expect(result.inflight).toMatchObject({ max: 4 });
    expect(result.inflight!.peak).toBeLessThanOrEqual(4);
    expect(result.inflight!.queuedCalls).toBeGreaterThan(0);
    expect(result.budgets).toMatchObject({ maxInflight: 4, inflightExplicit: true, dialMax: 30 });
    // Replacements joined with new ids; never a reused one.
    const workers = result.agents.filter((a) => a.role !== "lead").map((a) => a.id);
    expect(new Set(workers).size).toBe(workers.length);
    expect(workers.length).toBeGreaterThan(30);
    expect(workers.length).toBeLessThanOrEqual(maxWorkerJoins(30));
    expect(workers).toContain("agent-31");
    const joined = result.log.filter((m) => m.type === "agent.joined").map((m) => m.from);
    expect(new Set(joined).size).toBe(joined.length);
    // The recorded log folds to the state the run read back.
    expect(reduceBoard(result.log)).toEqual(result.state);
    expect(formatBoardRunSummary(result)).toMatch(/model calls in flight: at most 4 at once, peak [1-4]; \d+ of \d+ call\(s\) queued for a slot/);
    // Timing, for the record.
    console.log(`scale-30: ${elapsed} ms, ${workers.length} worker joins, ${result.log.length} board messages, ${probe.calls} model calls, peak ${probe.peak}`);
    // About 16 s on an idle machine, near 30 s beside the rest of the suite: a wider limit than the 60 s default.
  }, 90_000);

  it("smoke: 100 items under a dial of 100 complete within the board's message cap", async () => {
    const started = Date.now();
    const projectDir = await project(100);
    const { root, fetchFn } = await control("board-scale-100");
    const probe = new InflightProbe();
    const policy = spreadPolicy();
    const transport: AgentTurnTransport<BoardDigest, BoardMessage> = (input) => probe.around(() => policy(input), 0);
    const result = await runBoard({
      goal: "update every part",
      projectDir,
      changeId: "change-board-scale-100",
      workerUrl: "http://local-control",
      fetchFn,
      dial: { minConcurrency: 1, maxConcurrency: 100 },
      transport,
      executor: new FastExecutor(probe),
      seed: itemsSeed(100),
      resolveContract: async () => "reject",
      schedule: "concurrent",
      speculate: 1,
      pollMs: 20,
      budgets: { timeoutMs: 140_000, quiescenceMs: 10_000, maxRunTurns: 5000 },
      workRoot: join(root, "work"),
    });
    const elapsed = Date.now() - started;
    expect(result.stopReason).toBe("all-items-done");
    expect(result.incompleteItems).toEqual([]);
    expect(result.log.length).toBeLessThan(BOARD_LIMITS.maxMessages - BOARD_LIMITS.batchReserve);
    // The default in-flight limit: min(dial max, 8).
    expect(result.budgets).toMatchObject({ maxInflight: 8, inflightExplicit: false, dialMax: 100, claimDeadlineMessages: MAX_SCALED_DEADLINE_MESSAGES });
    expect(probe.peak).toBeLessThanOrEqual(8);
    console.log(`scale-100: ${elapsed} ms, ${result.agents.length - 1} worker joins, ${result.log.length} board messages, ${probe.calls} model calls, peak ${probe.peak}`);
    // About 40 s on an idle machine (100 repos, 100 pushes fetched and merged into one revision,
    // and the pairwise clash prediction over them): a wider limit than the suite's 60 s default.
  }, 150_000);
});

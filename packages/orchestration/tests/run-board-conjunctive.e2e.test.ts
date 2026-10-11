/**
 * The board on a CONJUNCTIVE gate (offline, deterministic): one whole-goal
 * acceptance suite that passes only when every item's fix is in the same
 * revision, as the service-api gate does. Six items, a dial of three, and the
 * scaled claim cap of one: every agent's first push is correct, yet the first
 * revisions fail on the items nobody has pushed yet.
 *
 * Under arbitration revision 3:
 *   - an item whose holder's push was gated and not implicated is WAITING ON
 *     OTHERS: it no longer counts against the claim cap, so the holder takes
 *     the next open item and all six items are held and pushed;
 *   - a failure that maps only to items NOT in the revision implicates no
 *     merged item ("outstanding"): no fix request, no fix budget, no reopen;
 *   - a waiting-on-others claim never lapses for no progress.
 * The run reaches a passing revision that merges all six fixes.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { activeClaims, foldBoard, reduceBoard, waitingOnOthers, type BoardMessage } from "@switchyard-change/change-core";
import type { ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { runBoardOffline } from "../src/run-board-offline.ts";
import type { BoardSeed } from "../src/run-board.ts";

const GOAL = "Make every part carry the fix";
const PARTS = 6;

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-board-conjunctive-"));
  const files: Record<string, string> = { "package.json": '{"name":"p","scripts":{}}\n' };
  for (let i = 0; i < PARTS; i += 1) {
    files[`src/part${i}.ts`] = `export const part${i} = "broken";\n`;
  }
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

const sixItems = async (): Promise<BoardSeed> => ({
  source: "planner",
  model: "fake-planner",
  items: Array.from({ length: PARTS }, (_, i) => ({ item: `i${i}`, objective: `fix part${i}`, acceptance: ["gate passes"], scopeHint: [`src/part${i}.ts`] })),
});

/** Fixes correctly on the first push: writes the fix into every in-scope file. */
class FixingExecutor implements ExecutorProvider {
  readonly name = "fixing";
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const written: string[] = [];
    for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
      await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
      const name = (path.split("/").pop() ?? path).replace(/\.ts$/, "");
      await writeFile(join(context.worktreeDir, path), `export const ${name} = "FIXED";\n`);
      written.push(path);
    }
    return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `fix ${context.workUnitId}` };
  }
}

/**
 * One acceptance suite over every part (node:test spec shape): it passes only
 * when all six part files carry the fix in the same tree. The baseline fails.
 */
class ConjunctiveGate implements CommandRunner {
  readonly runs: { readonly fixed: number }[] = [];
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const lines: string[] = [];
    let fixed = 0;
    for (let i = 0; i < PARTS; i += 1) {
      const body = await readFile(join(cwd, `src/part${i}.ts`), "utf8").catch(() => "");
      const ok = body.includes("FIXED");
      fixed += ok ? 1 : 0;
      lines.push(`${ok ? "✔" : "✖"} part${i}: carries the fix (1.0ms)`);
    }
    this.runs.push({ fixed });
    const summary = [`ℹ tests ${PARTS}`, `ℹ pass ${fixed}`, `ℹ fail ${PARTS - fixed}`];
    return fixed === PARTS
      ? { code: 0, stdout: [...lines, ...summary, ""].join("\n"), stderr: "" }
      : { code: 1, stdout: [...lines, ...summary, ""].join("\n"), stderr: "" };
  }
}

const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) => log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

async function conjunctiveRun(speculate: number) {
  const gate = new ConjunctiveGate();
  const result = await runBoardOffline({
    goal: GOAL,
    projectDir: await project(),
    seed: sixItems,
    executor: new FixingExecutor(),
    dial: { minConcurrency: 1, maxConcurrency: 3 },
    appGateCommand: ["gate"],
    verifyCommandRunner: gate,
    resolveContract: async () => "reject",
    speculate,
  });
  return { result, gate };
}

function expectAllSixLanded(result: Awaited<ReturnType<typeof runBoardOffline>>): void {
  const log = result.log;
  const goal = of(log, "goal.posted")[0]!.payload;
  expect(goal.rules.maxActiveClaims).toBe(1);
  expect(goal.rules.arbitration).toBe(3);
  const parts = Array.from({ length: PARTS }, (_, i) => `i${i}`);
  // A passing revision merges all six fixes (its gated tree carries every part's fix).
  const pass = of(log, "integrated.rev").find((m) => m.payload.gate === "pass");
  expect(pass).toBeDefined();
  expect(result.verdict).toBe("verified");
  expect(result.incompleteItems).toEqual([]);
  for (const id of parts) {
    expect(result.state.items[id]!.status).toBe("done");
  }
  // Every agent fixed correctly on its first push: nobody was asked to fix,
  // no budget was spent, no item reopened or lapsed.
  expect(of(log, "fix.requested")).toEqual([]);
  expect(of(log, "fix.exhausted")).toEqual([]);
  expect(of(log, "item.reopened")).toEqual([]);
  expect(of(log, "claim.lapsed")).toEqual([]);
  // Each failing revision implicated nobody: its failures were the outstanding items'.
  for (const rev of of(log, "integrated.rev").filter((m) => m.payload.gate === "fail")) {
    expect(rev.payload.failing?.items).toEqual([]);
    expect((rev.payload.failing?.outstanding ?? []).length).toBeGreaterThan(0);
  }
  // The cap still holds at every grant, and an agent whose item waits on the
  // others took another one (more than three items held by three agents).
  let tookAnother = false;
  for (const grant of of(log, "claim.granted").filter((m) => parts.includes(m.payload.item))) {
    const before = foldBoard(log, grant.seq - 1);
    const after = foldBoard(log, grant.seq);
    expect({ seq: grant.seq, held: activeClaims(after, grant.payload.agent).length <= 1 }).toEqual({ seq: grant.seq, held: true });
    const alreadyHeld = Object.values(before.items).filter((i) => parts.includes(i.id) && i.status === "claimed" && i.owner === grant.payload.agent);
    if (alreadyHeld.length > 0) {
      tookAnother = true;
      expect(alreadyHeld.every((i) => waitingOnOthers(before, i))).toBe(true);
    }
  }
  expect(tookAnother).toBe(true);
  expect(reduceBoard(log)).toEqual(result.state);
}

describe("a conjunctive gate with a claim cap of one (arbitration revision 3)", () => {
  it("K = 1: waiting-on-others items free the cap, outstanding failures blame nobody, and one revision lands all six fixes", async () => {
    const { result, gate } = await conjunctiveRun(1);
    expectAllSixLanded(result);
    expect(gate.runs.at(-1)!.fixed).toBe(PARTS);
    const revisions = result.revisions.filter((r) => r.gate === "fail");
    expect(revisions.length).toBeGreaterThan(0);
    for (const rev of revisions) {
      expect(rev.implicated).toMatchObject({ items: [], source: "outstanding" });
    }
  }, 180_000);

  it("K = 3: speculation configured: the pre-pass rounds integrate as one revision and the same run lands all six fixes", async () => {
    const { result } = await conjunctiveRun(3);
    expectAllSixLanded(result);
    expect(result.speculation?.speculate).toBe(3);
    // Before the first pass the head is the failing baseline: every pending
    // push integrates as one revision, no speculative candidate is gated.
    const firstPass = of(result.log, "integrated.rev").find((m) => m.payload.gate === "pass")!;
    expect(of(result.log, "candidate.gated").filter((m) => m.seq < firstPass.seq)).toEqual([]);
    expect(result.proof?.status).toBe("proven");
  }, 180_000);
});

/**
 * The pre-pass progress ratchet end to end (offline, deterministic): a
 * CONJUNCTIVE whole-goal gate (`tsc && the acceptance suite`, passing only
 * when all six parts carry the fix in one tree), a dial of three, the scaled
 * claim cap of one, and ONE SABOTEUR: the agent that takes part 4 first
 * pushes code that does not typecheck (an invented `ctx.auth`), then fixes
 * it when asked.
 *
 * Under arbitration revision 5 the bad push does not take the tree backwards:
 * the stack that carries it scores worse than the best revision so far, so
 * the stack is checked leave-one-out: only without the bad push does it score
 * better, so that push alone is recorded push.regressed (the parse attributes
 * the failure to its item, so the fix request goes to its holder), and the
 * other agents' pushes are stacked without it in the next revision. Once the saboteur's fix is in, the run verifies: the last
 * revision is the gated tree, and it is exactly what was promoted (PROVEN).
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { reduceBoard, type BoardMessage } from "@switchyard-change/change-core";
import type { ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { formatProofSummary } from "../src/proof-bundle.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, type BoardSeed } from "../src/run-board.ts";

const PARTS = 6;
const SABOTAGED = "i4";
const ACCEPTANCE = "gate/acceptance.test.mjs";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-board-ratchet-"));
  const files: Record<string, string> = {
    "package.json": '{"name":"p","scripts":{}}\n',
    [ACCEPTANCE]: "// the immutable acceptance suite (the fake gate stands in for it)\n",
  };
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

/** Fixes every part correctly, except the saboteur's first edit of part 4: it uses an API that does not exist. */
class SaboteurExecutor implements ExecutorProvider {
  readonly name = "saboteur";
  readonly edits = new Map<string, number>();
  /** Every edit's objective, per item, in order. */
  readonly objectives = new Map<string, string[]>();
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    this.objectives.set(context.workUnitId, [...(this.objectives.get(context.workUnitId) ?? []), context.objective]);
    const attempt = (this.edits.get(context.workUnitId) ?? 0) + 1;
    this.edits.set(context.workUnitId, attempt);
    const written: string[] = [];
    for (const path of context.paths.filter((p) => !/[*?]/.test(p))) {
      await mkdir(dirname(join(context.worktreeDir, path)), { recursive: true });
      const name = (path.split("/").pop() ?? path).replace(/\.ts$/, "");
      const sabotage = context.workUnitId === SABOTAGED && attempt === 1;
      await writeFile(join(context.worktreeDir, path), sabotage ? `export const ${name} = ctx.auth.user; // BROKEN\n` : `export const ${name} = "FIXED";\n`);
      written.push(path);
    }
    return { status: "changed", changedPaths: written, logs: [], cost: { usd: 0 }, commitMessage: `fix ${context.workUnitId}` };
  }
}

/** `tsc && the acceptance suite`: a BROKEN part fails the typecheck (nothing runs); else one case per part, passing only with all six. */
class ConjunctiveTypedGate implements CommandRunner {
  readonly runs: string[] = [];
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const errors: string[] = [];
    const lines: string[] = [`▶ ${ACCEPTANCE}`];
    let fixed = 0;
    for (let i = 0; i < PARTS; i += 1) {
      const body = await readFile(join(cwd, `src/part${i}.ts`), "utf8").catch(() => "");
      if (body.includes("BROKEN")) {
        errors.push(`src/part${i}.ts(1,${20 + i}): error TS2304: Cannot find name 'ctx'.`, `src/part${i}.ts(1,${24 + i}): error TS2339: Property 'auth' does not exist on type 'Ctx'.`);
      }
      const ok = body.includes("FIXED");
      fixed += ok ? 1 : 0;
      lines.push(`${ok ? "✔" : "✖"} part${i}: carries the fix (1.0ms)`);
    }
    if (errors.length > 0) {
      this.runs.push(`tsc ${errors.length}`);
      return { code: 2, stdout: `${errors.join("\n")}\n`, stderr: "" };
    }
    this.runs.push(`acceptance ${fixed}`);
    const out = [...lines, `ℹ tests ${PARTS}`, `ℹ pass ${fixed}`, `ℹ fail ${PARTS - fixed}`, ""].join("\n");
    return { code: fixed === PARTS ? 0 : 1, stdout: out, stderr: "" };
  }
}

const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) => log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

describe("a conjunctive typed gate with one saboteur (arbitration revision 5: the pre-pass ratchet)", () => {
  it("the saboteur's push is the only regressor leave-one-out finds, the others are stacked without it, and after its fix the run verifies with landed = gated = promoted", async () => {
    const gate = new ConjunctiveTypedGate();
    const executor = new SaboteurExecutor();
    const result = await runBoardOffline({
      goal: "Make every part carry the fix",
      projectDir: await project(),
      seed: sixItems,
      executor,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      appGateCommand: ["node", "--test", ACCEPTANCE],
      verifyCommandRunner: gate,
      resolveContract: async () => "reject",
    });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.rules.arbitration).toBe(5);
    expect(of(log, "goal.posted")[0]!.payload.immutable).toContain(ACCEPTANCE);

    // Removing the saboteur's bad push makes the stack better: recorded with typed evidence, addressed to its holder.
    const regressions = of(log, "push.regressed");
    expect(regressions).toHaveLength(1);
    const r = regressions[0]!;
    expect(r.payload.item).toBe(SABOTAGED);
    expect(r.to).toEqual([r.payload.agent]);
    expect(r.payload.to).toMatchObject({ runs: false, typeErrors: 2 });
    expect(r.payload.from.runs).toBe(true);
    expect(r.payload.evidence.some((l) => /src\/part4\.ts\(1,\d+\): error TS2304: Cannot find name 'ctx'\./.test(l))).toBe(true);
    // The whole stack's revision, attributed as usual (its errors are in part 4), asked only the saboteur's item for the fix.
    const regressingRev = of(log, "integrated.rev").find((m) => m.payload.n === r.payload.rev)!;
    expect(regressingRev.payload.gate).toBe("fail");
    expect(regressingRev.payload.failing?.items).toEqual([SABOTAGED]);
    const fixes = of(log, "fix.requested");
    expect(fixes.map((m) => [m.payload.item, m.payload.n])).toEqual([[SABOTAGED, r.payload.rev]]);
    expect(of(log, "fix.exhausted")).toEqual([]);
    expect(of(log, "item.reopened")).toEqual([]);
    // The next revision stacked the others without the bad push (the saboteur's agent's other pushes
    // included, which the leave-one-out tree without that agent left out): at least as good as that tree.
    const next = of(log, "integrated.rev").find((m) => m.payload.n === r.payload.rev + 1)!;
    expect(next.payload.merged).not.toContain(r.payload.commit);
    expect(next.payload.progress?.acceptance?.passed).toBeGreaterThanOrEqual(r.payload.from.acceptance);
    expect(next.payload.failing?.items).toEqual([]);
    // Before the first pass the head never moved: every revision until it was built on the baseline.
    const firstPass = of(log, "integrated.rev").find((m) => m.payload.gate === "pass")!;
    const baseline = of(log, "goal.posted")[0]!.payload.baseline;
    for (const rev of of(log, "integrated.rev").filter((m) => m.seq <= firstPass.seq)) {
      expect(rev.payload.base).toBe(baseline);
    }
    // The saboteur fixed it when asked (its second edit), and the run verified.
    expect(executor.edits.get(SABOTAGED)).toBe(2);
    // Its fix edit carried the regression: the quote and the failures that go away without its push.
    const fixObjective = executor.objectives.get(SABOTAGED)![1]!;
    expect(fixObjective).toMatch(/Instruction: Fix the regression my push [0-9a-f]{10} introduced on revision \d+/);
    expect(fixObjective).toMatch(/made revision \d+ WORSE \(with it: 2 type errors; without it: acceptance \d\/6\)/);
    expect(fixObjective).toMatch(/src\/part4\.ts\(1,\d+\): error TS2304: Cannot find name 'ctx'\./);
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toEqual([]);
    expect(gate.runs.at(-1)).toBe(`acceptance ${PARTS}`);
    // Gate equals deploy: the last revision passed, and its gated commit is what was promoted.
    const last = of(log, "integrated.rev").at(-1)!;
    expect(last.payload.gate).toBe("pass");
    const promoted = of(log, "revision.promoted").at(-1)!;
    expect(promoted.payload.rev).toBe(last.payload.n);
    expect(promoted.payload.gatedCommit).toBe(last.payload.commit);
    expect(result.promotion?.committed).toBe(true);
    const proof = result.proof!;
    expect(proof.status).toBe("proven");
    expect(proof.revision!.commit).toBe(proof.promotion!.gatedCommit);
    // The proof records the ratchet's history and the regression (never as a verdict).
    const history = proof.ratchet!.history;
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.map((h) => h.n)).toContain(next.payload.n);
    expect(history.at(-1)!.line).toBe(`acceptance ${PARTS - 1}/${PARTS}`);
    expect(history.every((h) => h.n < firstPass.payload.n)).toBe(true);
    expect(proof.ratchet?.regressions.map((x) => [x.item, x.to])).toEqual([[SABOTAGED, "2 type errors"]]);
    expect(formatProofSummary(proof).some((l) => /^ {2}pre-pass ratchet \(best so far before the first pass; a record, not a verdict\): rev \d+ acceptance \d\/6 -> .*rev \d+ acceptance 5\/6; regressions: i4 /.test(l))).toBe(true);
    const summary = formatBoardRunSummary(result);
    expect(summary).toMatch(/pre-pass ratchet \(best so far before the first pass; it never moves the head, promotes, or decides a verdict\)/);
    expect(summary).toMatch(/leave-one-out: without i4 \(\S+\) regressed acceptance \d\/6/);
    expect(summary).not.toMatch(/implicated \(ratchet\)/);
    expect(reduceBoard(log)).toEqual(result.state);
  }, 240_000);

  it("the same run under arbitration revision 4 (before the ratchet): the bad push sinks the whole stack and nothing leaves it out", async () => {
    const gate = new ConjunctiveTypedGate();
    const result = await runBoardOffline({
      goal: "Make every part carry the fix",
      projectDir: await project(),
      seed: sixItems,
      executor: new SaboteurExecutor(),
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      appGateCommand: ["node", "--test", ACCEPTANCE],
      verifyCommandRunner: gate,
      resolveContract: async () => "reject",
      rules: { arbitration: 4 },
    });
    const log = result.log;
    expect(of(log, "push.regressed")).toEqual([]);
    expect(result.ratchet).toBeUndefined();
    expect(result.proof?.ratchet).toBeUndefined();
    // The revision carrying the bad push merged every pending push: the typecheck stopped the gate for all of them.
    const sunk = of(log, "integrated.rev").find((m) => m.payload.progress?.acceptanceNotRun !== undefined)!;
    expect(sunk.payload.progress?.acceptanceNotRun).toBe("typecheck failed (2 errors)");
    expect(sunk.payload.merged.length).toBeGreaterThan(1);
  }, 240_000);
});

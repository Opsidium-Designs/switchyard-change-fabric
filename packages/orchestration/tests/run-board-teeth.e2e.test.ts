/**
 * Test teeth on a board run (offline, local control, fake runners): a human
 * accepts a contract that releases an existing developer test, the agents
 * change it with the code, and the final passing revision's changed test is
 * run alone on the baseline (new test swapped in) and on the revision. The
 * record is ADVISORY: in every case (teeth, no teeth, could not check) the
 * verdict, the promotion, and the proof status are exactly the same.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandOutcome, CommandRunner, DependencyInstaller } from "@switchyard-change/verification";

import { formatProofSummary } from "../src/proof-bundle.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import type { BoardSeed, RunBoardResult } from "../src/run-board.ts";

const GOAL = "Make every module report its status";
const TEST = "tests/core.test.ts";
const BASELINE_A = "export const a = 1;\n";

/** A small vitest project (no lockfile; the fake installer installs nothing). */
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-teeth-project-"));
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p","scripts":{"gate":"vitest run"},"devDependencies":{"vitest":"2.1.8"}}\n',
    "src/core/a.ts": BASELINE_A,
    "src/api/handler.ts": "export const handler = () => 1;\n",
    [TEST]: "// tests\n",
  })) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

const seed = async (): Promise<BoardSeed> => ({
  source: "planner",
  model: "fake-planner",
  items: [
    { item: "core", objective: "report status from core", acceptance: ["gate passes"], scopeHint: ["src/core/**"] },
    { item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
    { item: "tests", objective: "test the status report", acceptance: ["gate passes"], scopeHint: ["tests/**"] },
  ],
});

const installer: DependencyInstaller = {
  async install() {
    return { status: "skipped", detail: "offline test: nothing to install", durationMs: 0 };
  },
};

/**
 * The gate always passes; the single-file vitest run is decided by `file`
 * (given whether the tree it runs in has the fixed code). Records each file run.
 */
class Runner implements CommandRunner {
  readonly fileRuns: { cwd: string; fixed: boolean }[] = [];
  constructor(private readonly file: (fixed: boolean) => CommandOutcome | Promise<CommandOutcome>) {}
  async run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    if (argv[0] !== "npx") {
      return { code: 0, stdout: "ok", stderr: "" };
    }
    const fixed = (await readFile(join(cwd, "src/core/a.ts"), "utf8")) !== BASELINE_A;
    this.fileRuns.push({ cwd, fixed });
    return this.file(fixed);
  }
}

async function run(runner: Runner): Promise<RunBoardResult> {
  return runBoardOffline({
    goal: GOAL,
    projectDir: await project(),
    seed,
    appGateCommand: ["gate"],
    verifyCommandRunner: runner,
    dependencyInstaller: installer,
    resolveContract: async () => "accept",
  });
}

/** What must never depend on the teeth check. */
function outcome(result: RunBoardResult) {
  return {
    verdict: result.verdict,
    gate: result.revision?.gate,
    committed: result.promotion?.committed,
    proof: result.proof?.status,
    reasons: result.proof?.reasons,
    incomplete: result.incompleteItems,
  };
}

describe("test teeth on a board run (advisory)", () => {
  it("records teeth, no teeth, and could-not-check, and the verdict, promotion, and proof are the same in every case", async () => {
    const teeth = new Runner((fixed) => (fixed ? { code: 0, stdout: "1 passed", stderr: "" } : { code: 1, stdout: "1 failed", stderr: "" }));
    const toothless = new Runner(() => ({ code: 0, stdout: "1 passed", stderr: "" }));
    const timedOut = new Runner((fixed) => (fixed ? { code: 0, stdout: "1 passed", stderr: "" } : { code: null, stdout: "", stderr: "command timed out after 600000 ms and was stopped" }));
    const crashing = new Runner(() => Promise.reject(new Error("runner crashed")));

    const withTeeth = await run(teeth);
    const rev = withTeeth.revision!.n;
    expect(withTeeth.proof?.teeth).toEqual([{ path: TEST, rev, status: "teeth", baseline: "fail", revision: "pass", command: ["npx", "--no", "vitest", "run", TEST] }]);
    // Once on the revision (fixed), once on the baseline (not fixed).
    expect(teeth.fileRuns.map((r) => r.fixed)).toEqual([true, false]);
    expect(formatProofSummary(withTeeth.proof!)).toContain(`  test teeth: ${TEST} fails on baseline (good), passes on rev ${rev} (advisory, not a verdict)`);

    const noTeeth = await run(toothless);
    expect(noTeeth.proof?.teeth).toEqual([{ path: TEST, rev: noTeeth.revision!.n, status: "no-teeth", baseline: "pass", revision: "pass", command: ["npx", "--no", "vitest", "run", TEST] }]);

    const timeout = await run(timedOut);
    expect(timeout.proof?.teeth).toMatchObject([{ path: TEST, status: "could-not-check", baseline: "not-run", revision: "pass", reason: "baseline: command timed out after 600000 ms and was stopped" }]);

    const crash = await run(crashing);
    expect(crash.proof?.teeth).toMatchObject([{ path: TEST, status: "could-not-check", revision: "not-run", reason: `rev ${crash.revision!.n}: runner crashed` }]);

    // Advisory: the verdict, the promotion, and the proof never move.
    const expected = { verdict: "verified", gate: "pass", committed: true, proof: "proven", reasons: [], incomplete: [] };
    for (const result of [withTeeth, noTeeth, timeout, crash]) {
      expect(outcome(result)).toEqual(expected);
    }
  });

  it("checks nothing when no contract released a test (rejected contract)", async () => {
    const runner = new Runner(() => ({ code: 1, stdout: "", stderr: "" }));
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir: await project(),
      seed,
      appGateCommand: ["gate"],
      verifyCommandRunner: runner,
      dependencyInstaller: installer,
      resolveContract: async () => "reject",
    });
    expect(result.proof?.teeth).toBeUndefined();
    expect(runner.fileRuns).toEqual([]);
  });
});

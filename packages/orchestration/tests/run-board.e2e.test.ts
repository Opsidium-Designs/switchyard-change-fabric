/**
 * The board run end to end on the offline local control: the core run and its
 * honest outcome. The lead seeds items from a (fake) planner, workers join under
 * the dial and claim them, an overlapping claim is contested and resolved by
 * narrowing, a worker asks a `to`-addressed question and gets a reply, every
 * worker pushes from its own repo, and the CONTINUOUS integrator records a
 * revision per round of pushes. Only a passing last revision is promoted (its
 * tree is the promoted tree), with a receipt; the baseline test inventory guards
 * the gate; a partial or unrecorded result is never verified, promoted, or
 * redeployed; and the CLI's exit code follows the verdict. The fix loop, budgets,
 * the gate, contracts, the run lifecycle, and seams live in the themed
 * run-board-*.e2e.test.ts files beside this one. No network: the generic policy
 * (or a scripted transport) takes every turn and deterministic executors edit.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { reduceBoard } from "@switchyard-change/change-core";
import type { ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { parsePromotionReceipt } from "../src/promotion-receipt.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { boardRunExitCode, formatBoardRunSummary, formatBoardTranscript, runBoard, type BoardRunEvent } from "../src/run-board.ts";
import { FixedGate, GOAL, direct, git, of, offline, project, reject, seed, treeOf } from "./run-board-fixtures.ts";

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
    // The receipt: a git note on the promoted commit under refs/notes/switchyard,
    // holding the recorded facts; the branch head is still the promoted commit.
    expect(result.receipt).toEqual({ ref: "refs/notes/switchyard", commit: result.promotion!.commit, written: true });
    expect(events.find((e) => e.kind === "receipt")).toMatchObject({ receipt: { written: true } });
    expect(result.proof!.receipt).toEqual(result.receipt);
    expect(summary).toContain(`receipt: git note on ${result.promotion!.commit.slice(0, 12)} under refs/notes/switchyard`);
    const note = (await git("git", ["-C", result.sourceRepoDir!, "notes", "--ref=switchyard", "show", result.promotion!.commit])).stdout;
    expect(note).toContain(`Switchyard receipt: change change-board-offline, revision ${result.revision!.n}`);
    expect(note).toContain(`Gated commit: ${result.revision!.commit} (revision ${result.revision!.n})`);
    expect(note).toContain("no gate ran (unverified: nothing was checked)");
    expect(note).toContain("Promoted to: switchyard/change-board-offline (the gated tree)");
    const facts = parsePromotionReceipt(note)!;
    expect(facts).toMatchObject({
      changeId: "change-board-offline",
      revision: { n: result.revision!.n, gatedCommit: result.revision!.commit },
      promoted: { commit: result.promotion!.commit, branch: "switchyard/change-board-offline", matchesGated: true },
      gate: { gated: false },
      pushesMerged: of(log, "push.announced").length,
    });
    expect(facts.integrated.map((i) => i.item).sort()).toEqual(result.proof!.contributions.items.filter((i) => i.pushes > 0).map((i) => i.item).sort());
    expect(Number.isNaN(Date.parse(facts.at))).toBe(false);
    expect((await git("git", ["-C", result.sourceRepoDir!, "rev-parse", `refs/heads/${result.promotion!.branch}`])).stdout.trim()).toBe(result.promotion!.commit);

    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("a passing gate on the integrated tree promotes it", async () => {
    const projectDir = await project();
    const gate = new FixedGate(0);
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate });
    expect(result.revision).toMatchObject({ gate: "pass" });
    expect(result.verdict).toBe("verified");
    expect(result.promotion).toMatchObject({ committed: true });
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
    // The gate can never pass here, so bound the fix budget to end the run quickly.
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: exiting, budgets: { maxFixAttemptsPerItem: 1 } });
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
    expect(result.promotion?.committed).not.toBe(true);
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

  it("a promotion the board refused to record is never redeployed (deploy-skipped) and is not proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "scf-unrecorded-promotion-"));
    const projectDir = join(root, "p");
    for (const [rel, body] of Object.entries({ "package.json": '{"name":"p","scripts":{}}\n', "src/w.ts": "w\n", "src/x.ts": "x\n" })) {
      await mkdir(dirname(join(projectDir, rel)), { recursive: true });
      await writeFile(join(projectDir, rel), body);
    }
    const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
    const inner = control.fetch as unknown as typeof fetch;
    // The board refuses the engine's revision.promoted record (and nothing else).
    let refusedPromotion = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/board/record") && init?.method === "POST" && (JSON.parse(String(init.body)) as { type: string }).type === "revision.promoted") {
        refusedPromotion += 1;
        return new Response(JSON.stringify({ code: "INVALID_STATE", error: "refused for the test" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return inner(url as never, init);
    }) as unknown as typeof fetch;
    const passing: CommandRunner = { run: async () => ({ code: 0, stdout: "ok 1 - all\n", stderr: "" }) };
    const deploys: string[] = [];
    const events: BoardRunEvent[] = [];
    const result = await runBoard({
      goal: GOAL,
      changeId: "unrecorded-promotion",
      workerUrl: "http://local-control",
      fetchFn,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      transport: createGenericBoardPolicy(),
      seed: async () => ({
        source: "planner",
        model: "fake-planner",
        items: ["w", "x"].map((item) => ({ item, objective: `do ${item}`, acceptance: ["gate passes"], scopeHint: [`src/${item}.ts`] })),
      }),
      resolveContract: reject,
      workRoot: join(root, "work"),
      projectDir,
      executor: new AttemptStamp(),
      schedule: "lockstep",
      appGateCommand: ["gate"],
      verifyCommandRunner: passing,
      budgets: { maxRunTurns: 200, maxRounds: 200 },
      deployAppDir: projectDir,
      deployAppName: "unrecorded-app",
      deployApp: async ({ appName }) => {
        deploys.push(appName);
        return { url: `https://${appName}.example.workers.dev` };
      },
      appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
      onEvent: (e) => events.push(e),
    });

    expect(result.verdict).toBe("verified");
    expect(result.promotion).toMatchObject({ committed: true });
    expect(refusedPromotion).toBe(1);
    expect(of(result.log, "revision.promoted")).toEqual([]);
    expect(events.some((e) => e.kind === "promotion-unrecorded")).toBe(true);
    expect(deploys).toEqual([]);
    expect(result.deployment).toBeUndefined();
    expect(events.find((e) => e.kind === "deploy-skipped")).toMatchObject({ reason: expect.stringMatching(/not recorded on the board/) });
    expect(result.proof?.status).toBe("not-proven");
    expect(result.proof!.reasons.join("\n")).toMatch(/promotion reported by the run but not recorded on the board/);
    // No recorded facts, no receipt: reported, and the promoted branch stands.
    expect(result.receipt).toMatchObject({ ref: "refs/notes/switchyard", commit: result.promotion!.commit, written: false, reason: expect.stringMatching(/not recorded on the board/) });
    expect(result.proof!.receipt).toEqual(result.receipt);
    expect(formatBoardRunSummary(result)).toMatch(/receipt: NOT written \(the promotion was not recorded on the board[^\n]*\); the promotion stands/);
    await expect(git("git", ["-C", result.sourceRepoDir!, "rev-parse", "--verify", "-q", "refs/notes/switchyard"])).rejects.toThrow();
    expect((await git("git", ["-C", result.sourceRepoDir!, "rev-parse", `refs/heads/${result.promotion!.branch}`])).stdout.trim()).toBe(result.promotion!.commit);
  }, 120_000);
});

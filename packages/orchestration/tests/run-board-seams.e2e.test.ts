/**
 * The board run's shared seams (from the cohesion blueprint), offline and on
 * the concurrent schedule: a seam change lands before its importers are
 * edited, a type error on a frozen seam becomes a seam contract the lead
 * decides (with an advisory triage), and a seam item nobody works on, or a
 * seam contract the lead never decides, never stalls a run silently. No
 * network: the generic policy (or a scripted transport) takes every turn and
 * deterministic executors edit.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { foldBoard, reduceBoard, seamHolds, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AskJev, AgentTurnTransport, ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { formatBoardRunSummary, formatBoardTranscript, runBoard, type BoardRunEvent, type BoardSeed } from "../src/run-board.ts";
import { GOAL, direct, of, offline } from "./run-board-fixtures.ts";

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

  /** The Ctx project (a frozen shared seam three resources import) for the lead-contract tests. */
  async function ctxProject(prefix: string): Promise<{ dir: string; ctxSeed: () => Promise<BoardSeed> }> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
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
    return { dir, ctxSeed };
  }

  it("concurrent schedule: a lead that never decides a pending seam contract is re-cued, then nudged on the quiet board, and the quiet ending names the contract and the item it blocks (nothing decides it)", async () => {
    const { dir, ctxSeed } = await ctxProject("scf-lead-never-decides-");
    const policy = createGenericBoardPolicy();
    const leadInputs: string[][] = [];
    const absentLead: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      if (input.role === "lead") {
        leadInputs.push([...input.capsule.evidence]);
        return { action: { type: "wait", reason: "nothing to decide" } };
      }
      return policy(input);
    };
    const events: BoardRunEvent[] = [];
    const { base } = await direct("change-lead-never-decides");
    const result = await runBoard({
      ...base,
      projectDir: dir,
      seed: ctxSeed,
      transport: absentLead,
      executor: new CtxUserExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new CtxTypecheckGate(),
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { quiescenceMs: 600, timeoutMs: 100_000 },
      onEvent: (e) => events.push(e),
    });
    const proposal = of(result.log, "contract.proposed").find((m) => m.payload.target === "src/shared/ctx.ts")!;
    expect(proposal).toBeDefined();
    const contract = proposal.payload.contract;
    const nudges = events.filter((e): e is Extract<BoardRunEvent, { kind: "lead-contracts-nudged" }> => e.kind === "lead-contracts-nudged");
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(nudges[0]).toEqual({ kind: "lead-contracts-nudged", contracts: [contract], items: [proposal.payload.item] });
    expect(leadInputs.some((evidence) => evidence.some((e) => /^PENDING CONTRACT\(S\) TO DECIDE: /.test(e)))).toBe(true);
    // Nothing decided it, and the quiet ending says so.
    expect(result.state.contracts[contract]!.status).toBe("proposed");
    expect(of(result.log, "contract.accepted").concat(of(result.log, "contract.rejected") as never[])).toEqual([]);
    expect(result.stopReason).toBe("quiescent");
    expect(result.stopDetail).toMatch(new RegExp(`the lead never decided seam contract ${contract} \\(src/shared/ctx\\.ts\\) blocking ${proposal.payload.item} after ${nudges.length} nudge\\(s\\)`));
    expect(result.stopDetail).toMatch(/never decided seam contract .* blocking/);
    expect(formatBoardRunSummary(result)).toMatch(/undecided: the lead never decided seam contract .* blocking res-a/);
    expect(result.verdict).not.toBe("verified");
    expect(reduceBoard(result.log)).toEqual(result.state);
  }, 120_000);

  it("concurrent schedule: a lead that decides the pending seam contract on the driver's nudge keeps the run going to completion", async () => {
    const { dir, ctxSeed } = await ctxProject("scf-lead-decides-on-nudge-");
    const policy = createGenericBoardPolicy();
    const events: BoardRunEvent[] = [];
    let decidedAfterNudge = false;
    const lateLead: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      if (input.role === "lead" && input.board.pendingContracts.length > 0) {
        if (!events.some((e) => e.kind === "lead-contracts-nudged")) {
          return { action: { type: "wait", reason: "not yet" } };
        }
        decidedAfterNudge = true;
      }
      return policy(input);
    };
    const { base } = await direct("change-lead-decides-on-nudge");
    const result = await runBoard({
      ...base,
      projectDir: dir,
      seed: ctxSeed,
      transport: lateLead,
      executor: new CtxUserExecutor(),
      appGateCommand: ["gate"],
      verifyCommandRunner: new CtxTypecheckGate(),
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { quiescenceMs: 600, timeoutMs: 100_000 },
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.kind === "lead-contracts-nudged")).toBe(true);
    expect(decidedAfterNudge).toBe(true);
    const proposal = of(result.log, "contract.proposed").find((m) => m.payload.target === "src/shared/ctx.ts")!;
    const accepted = of(result.log, "contract.accepted").find((m) => m.payload.contract === proposal.payload.contract)!;
    expect(accepted.from).toBe("lead");
    // The run continued past the decision: the seam item landed in a passing revision.
    expect(result.state.items[`seam-${proposal.payload.contract}`]!.status).toBe("done");
    expect(of(result.log, "integrated.rev").at(-1)!.payload.gate).toBe("pass");
    expect(result.stopReason).toBe("all-items-done");
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

/**
 * The PRE-PASS PROGRESS RATCHET (arbitration revision 5) over real local Git
 * and the offline local control (no network; a fake gate that computes a
 * score from the tree): before the first pass, a stack that scores worse than
 * the best failing revision so far is checked LEAVE-ONE-OUT (the stack
 * without each new push, and without a seam push together with the pushes
 * that import its seam, each a real gated tree). Only a push whose removal
 * makes the stack strictly better is recorded push.regressed and left out
 * until its holder pushes again; pushes that only work together are never
 * blamed and keep being stacked. The head never moves before a pass, and the
 * verdict is the gate's.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { boardDigest, integrablePushItems, itemWaitReason, prePassRatchet, reduceBoard, type BoardMessage } from "@switchyard-change/change-core";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { BoardAgentClient, BoardOperatorClient } from "../src/board-client.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { leaveOneOutPlan, regressionEvidence, seamConsumers, seamsEdited, type LeaveOneOutPush } from "../src/ratchet-integration.ts";
import { ContinuousBoardIntegrator, type BoardAgentRepo } from "../src/run-board.ts";
import { createIntegrationWorkspace } from "../src/run-live.ts";

const git = promisify(execFile);
const ID = "change-ratchet";
const BASE = "http://local-control";
const IDENTITY = { name: "Test Integrator", email: "integrator@test.local" };
const ACCEPTANCE = "gate/acceptance.test.mjs";
const FILES: Readonly<Record<string, string>> = { x: "src/x/a.ts", y: "src/y/b.ts", z: "src/z/c.ts" };
const CASES = 3;

/**
 * The fake whole-goal gate (tsc && the acceptance suite): a tree whose files
 * carry `ERR n` fails the typecheck with n type errors in that file, and a
 * file line `NEEDS w` is a type error unless the shared seam
 * src/contracts/auth.ts declares `readonly w` (the acceptance suite does not
 * run); otherwise each file's `PASS k` passes k of its 3 acceptance cases,
 * and the gate passes only with all 9.
 */
class ScoreGate implements CommandRunner {
  readonly ran: string[] = [];
  /** The item files of every tree the gate ran on, in order. */
  readonly trees: Record<string, string>[] = [];
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const errors: string[] = [];
    const lines: string[] = [`▶ ${ACCEPTANCE}`];
    let passed = 0;
    const tree: Record<string, string> = {};
    this.trees.push(tree);
    const seam = await readFile(join(cwd, "src/contracts/auth.ts"), "utf8").catch(() => "");
    for (const [item, rel] of Object.entries(FILES)) {
      const body = await readFile(join(cwd, rel), "utf8").catch(() => "");
      tree[item] = body;
      const err = Number(/ERR (\d+)/.exec(body)?.[1] ?? 0);
      for (let k = 0; k < err; k += 1) {
        errors.push(`${rel}(${k + 1},12): error TS2339: Property 'auth' does not exist on type 'Ctx'.`);
      }
      for (const [, word] of body.matchAll(/NEEDS (\w+)/g)) {
        if (!seam.includes(`readonly ${word}`)) {
          errors.push(`${rel}(40,5): error TS2339: Property '${word}' does not exist on type 'Ctx'.`);
        }
      }
      const ok = Math.min(CASES, Number(/PASS (\d+)/.exec(body)?.[1] ?? 0));
      const name = rel.split("/").pop()!.replace(/\.ts$/, "");
      for (let k = 0; k < CASES; k += 1) {
        lines.push(`${k < ok ? "✔" : "✖"} ${name}: case ${k + 1} (1.0ms)`);
      }
      passed += ok;
    }
    if (errors.length > 0) {
      this.ran.push(`tsc ${errors.length}`);
      return { code: 2, stdout: `${errors.join("\n")}\n`, stderr: "" };
    }
    this.ran.push(`acceptance ${passed}`);
    const total = CASES * Object.keys(FILES).length;
    const out = [...lines, `ℹ tests ${total}`, `ℹ pass ${passed}`, `ℹ fail ${total - passed}`, ""].join("\n");
    return { code: passed === total ? 0 : 1, stdout: out, stderr: "" };
  }
}

/** The blueprint seam the coupled cases post: x and z import the shared auth context. */
const AUTH_SEAM = [{ path: "src/contracts/auth.ts", importers: [FILES.x!, FILES.z!], symbols: ["Ctx"] }];

async function setup(rules: Record<string, number> = { arbitration: 5, maxFixAttempts: 3 }, seams?: typeof AUTH_SEAM) {
  const root = await mkdtemp(join(tmpdir(), "scf-ratchet-"));
  const projectDir = join(root, "project");
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p"}\n',
    [FILES.x!]: "export const a = 0;\n",
    [FILES.y!]: "export const b = 0;\n",
    [FILES.z!]: "export const c = 0;\n",
    "src/contracts/auth.ts": "export interface Ctx { readonly user: string }\n",
    [ACCEPTANCE]: "// the immutable acceptance suite (the fake gate stands in for it)\n",
  })) {
    await mkdir(dirname(join(projectDir, rel)), { recursive: true });
    await writeFile(join(projectDir, rel), body);
  }
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
  const fetchFn = control.fetch as unknown as typeof fetch;
  const operator = new BoardOperatorClient(fetchFn, BASE, ID);
  expect((await fetchFn(`${BASE}/changes/planning`, { method: "POST", body: JSON.stringify({ id: ID, objective: "o" }) })).status).toBe(201);
  const integration = await createIntegrationWorkspace(join(root, "work"), projectDir, ID, IDENTITY);
  const remote = (await git("git", ["ls-remote", integration.integrationRef.gitUrl, `refs/heads/${integration.integrationRef.defaultBranch}`])).stdout.split(/\s+/)[0]!;
  const human = async (draft: unknown) => expect((await operator.postAsHuman(draft)).ok).toBe(true);
  await human({
    type: "goal.posted",
    payload: { objective: "o", protected: ["package.json", ACCEPTANCE], immutable: [ACCEPTANCE], baseline: remote, rules: { speculate: 3, ...rules }, ...(seams ? { seams } : {}) },
  });
  for (const item of ["x", "y", "z"]) {
    await human({ type: "item.proposed", payload: { item, objective: `do ${item}`, scopeHint: [`src/${item}/**`, ...(item === "y" ? ["src/contracts/auth.ts"] : [])] } });
  }
  const agents = new Map<string, { client: BoardAgentClient; repo: BoardAgentRepo; dir: string }>();
  for (const id of ["a1", "a2", "a3"]) {
    const joined = await operator.join(id, { workspaceTtlSeconds: 600 });
    if (!joined.ok || !joined.workspace) {
      throw new Error(`join failed for ${id}`);
    }
    const dir = join(root, "agents", id);
    await git("git", ["clone", "-q", joined.workspace.gitUrl, dir]);
    agents.set(id, { client: new BoardAgentClient(fetchFn, BASE, ID, id, joined.token), repo: { gitUrl: joined.workspace.gitUrl, defaultBranch: joined.workspace.defaultBranch }, dir });
  }
  const agent = (id: string) => agents.get(id)!;
  const post = async (id: string, draft: unknown) => {
    const outcome = await agent(id).client.post(draft);
    if (!outcome.ok) {
      throw new Error(`${id} refused: ${outcome.code} ${outcome.error}`);
    }
    return outcome.appended;
  };
  for (const [id, item] of [["a1", "x"], ["a2", "y"], ["a3", "z"]] as const) {
    await post(id, { type: "item.claimed", payload: { item, intent: { read: [], write: [`src/${item}/**`, ...(item === "y" ? ["src/contracts/auth.ts"] : [])] } } });
  }
  /** Commit files in the agent's repo, push, and announce the push for the item. */
  const push = async (id: string, item: string, files: Readonly<Record<string, string>>): Promise<string> => {
    const { dir, repo } = agent(id);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    await git("git", ["-C", dir, "add", "-A"]);
    await git("git", ["-C", dir, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "-q", "-m", "work"]);
    await git("git", ["-C", dir, "push", "-q", repo.gitUrl, `HEAD:refs/heads/${repo.defaultBranch}`]);
    const sha = (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    await post(id, { type: "push.announced", payload: { item, commit: sha, paths: Object.keys(files) } });
    return sha;
  };
  const worktreeRoot = join(root, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const gate = new ScoreGate();
  const integrator = (extra: Partial<ConstructorParameters<typeof ContinuousBoardIntegrator>[0]> = {}) =>
    new ContinuousBoardIntegrator({
      operator,
      change: { id: ID, objective: "o" },
      agentRepos: new Map([...agents.entries()].map(([id, a]) => [id, a.repo])),
      readRemote: async (id) => agent(id).repo.gitUrl,
      integration,
      worktreeRoot,
      identity: IDENTITY,
      contract: { restore: [], jsonKeys: [] },
      appGateCommand: ["gate"],
      predictClashes: false,
      speculate: 3,
      candidateConcurrency: 1,
      verifyCommandRunner: gate,
      ...extra,
    });
  const run = async (extra: Partial<ConstructorParameters<typeof ContinuousBoardIntegrator>[0]> = {}) => {
    const i = integrator(extra);
    i.kick();
    await i.idle();
    return i;
  };
  const log = async (): Promise<readonly BoardMessage[]> => (await operator.log()).messages;
  const state = async () => (await operator.log()).state;
  const branchHead = async (): Promise<string> =>
    (await git("git", ["ls-remote", integration.integrationRef.gitUrl, `refs/heads/${integration.integrationRef.defaultBranch}`])).stdout.split(/\s+/)[0]!;
  /** A file's content at a commit of the integration repo (gated candidate refs included). */
  const fileAt = async (commit: string, rel: string): Promise<string | undefined> => {
    const dir = await mkdtemp(join(root, "check-"));
    await git("git", ["init", "-q", dir]);
    await git("git", ["-C", dir, "fetch", "-q", integration.integrationRef.gitUrl, commit]).catch(() => undefined);
    return (await git("git", ["-C", dir, "show", `${commit}:${rel}`]).catch(() => ({ stdout: undefined }))).stdout;
  };
  /** Rev 1 (the first ratchet): every item's first push passes one case each (acceptance 3/9). */
  const firstRatchet = async (bodies: Partial<Record<"x" | "y" | "z", string>> = {}, acceptance = 3) => {
    const pushes = {
      x: await push("a1", "x", { [FILES.x!]: bodies.x ?? "PASS 1\n" }),
      y: await push("a2", "y", { [FILES.y!]: bodies.y ?? "PASS 1\n" }),
      z: await push("a3", "z", { [FILES.z!]: bodies.z ?? "PASS 1\n" }),
    };
    const first = await run();
    expect(first.revisions.map((r) => [r.gate, r.progress?.acceptance?.passed])).toEqual([["fail", acceptance]]);
    expect(prePassRatchet(await log())).toMatchObject({ n: 1, score: { runs: true, acceptance, acceptanceTotal: 9 } });
    return pushes;
  };
  /** p1 (x) improves, p2 (y) adds 22 type errors and edits the shared seam, p3 (z) improves. */
  const threePushes = async () => ({
    p1: await push("a1", "x", { [FILES.x!]: "PASS 2\n" }),
    p2: await push("a2", "y", { [FILES.y!]: "PASS 1\nERR 22\n", "src/contracts/auth.ts": "export interface Ctx { readonly auth: string }\n" }),
    p3: await push("a3", "z", { [FILES.z!]: "PASS 2\n" }),
  });
  return { root, operator, push, run, log, state, branchHead, fileAt, remote, gate, firstRatchet, threePushes, projectDir };
}

const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) => log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

describe("the pre-pass progress ratchet (arbitration revision 5)", () => {
  it("p1 improves, p2 regresses, p3 improves: removing p2 alone makes the stack better, so p2 is push.regressed and left out; the stack without it is the next revision", async () => {
    const env = await setup();
    const first = await env.firstRatchet();
    const { p1, p2, p3 } = await env.threePushes();
    env.gate.ran.length = 0;
    env.gate.trees.length = 0;
    const integrator = await env.run();
    // The whole stack (22 type errors), then the stack without each new push: p2 first (the parse
    // attributes the failure to y), then push order. The stack without p2 IS the next revision's
    // tree, so it is recorded as gated (no second gate of the same tree).
    expect(env.gate.ran).toEqual(["tsc 22", "acceptance 4", "tsc 22", "tsc 22"]);
    expect(env.gate.trees).toEqual([
      { x: "PASS 2\n", y: "PASS 1\nERR 22\n", z: "PASS 2\n" },
      { x: "PASS 2\n", y: "export const b = 0;\n", z: "PASS 2\n" },
      { x: "export const a = 0;\n", y: "PASS 1\nERR 22\n", z: "PASS 2\n" },
      { x: "PASS 2\n", y: "PASS 1\nERR 22\n", z: "export const c = 0;\n" },
    ]);
    const log = await env.log();
    const revs = of(log, "integrated.rev");
    expect(revs.map((r) => [r.payload.n, r.payload.gate, [...r.payload.merged].sort()])).toEqual([
      [1, "fail", [first.x, first.y, first.z].sort()],
      [2, "fail", [p1, p2, p3].sort()],
      [3, "fail", [p1, p3].sort()],
    ]);
    // Rev 2 (the whole stack) is attributed as any failing revision (the errors are in y's file);
    // its output leads with the leave-one-out finding.
    expect(revs[1]!.payload.failing?.items).toEqual(["y"]);
    expect(revs[1]!.payload.failing?.output).toMatch(/^pre-pass ratchet: this stack scores 22 type errors, worse than the best revision so far \(revision 1: acceptance 3\/9\); the same stack without:\n {2}y \(a2\): acceptance 4\/9: strictly better/);
    expect(revs[1]!.payload.failing?.output).toMatch(/\n {2}x \(a1\): 22 type errors: no better: kept/);
    expect(revs[1]!.payload.progress?.acceptanceNotRun).toBe("typecheck failed (22 errors)");
    const fixes = of(log, "fix.requested").filter((m) => m.payload.n === 2);
    expect(fixes.map((m) => [m.payload.item, m.to])).toEqual([["y", ["a2"]]]);
    // The regression, addressed to its holder: with it 22 type errors, without it acceptance 4/9.
    const [regressed] = of(log, "push.regressed");
    expect(regressed).toMatchObject({
      from: "engine",
      to: ["a2"],
      payload: {
        item: "y",
        agent: "a2",
        commit: p2,
        rev: 2,
        ratchet: 1,
        from: { runs: true, acceptance: 4, acceptanceTotal: 9 },
        to: { runs: false, typeErrors: 22 },
        seams: ["src/contracts/auth.ts"],
      },
    });
    expect(regressed!.payload.evidence[0]).toBe("src/y/b.ts(1,12): error TS2339: Property 'auth' does not exist on type 'Ctx'.");
    expect(regressed!.payload.evidence.length).toBeLessThanOrEqual(5);
    // The candidate is the gated tree without p2, recorded as rev 3.
    expect(regressed!.payload.candidate).toBe(revs[2]!.payload.commit);
    // Rev 3 is the new ratchet; the head is still the baseline.
    expect(revs[2]!.payload.progress?.acceptance?.passed).toBe(4);
    expect(revs.every((r) => r.payload.base === env.remote)).toBe(true);
    expect(await env.branchHead()).toBe(env.remote);
    expect(prePassRatchet(log)).toMatchObject({ n: 3, score: { acceptance: 4 } });
    // The round's record: removing p2 is strictly better (regressed), removing p1 or p3 is not (kept).
    expect(integrator.isolations).toHaveLength(1);
    expect(integrator.isolations[0]!.map((i) => [i.kind, i.items.join(","), i.outcome])).toEqual([
      ["push", "y", "regressed"],
      ["push", "x", "kept"],
      ["push", "z", "kept"],
    ]);
    expect(integrator.revisions.find((r) => r.n === 2)?.implicated?.source).not.toBe("ratchet");
    // p2 waits for its holder: not stacked, wait reason push-regressed, the digest quotes the regression.
    const state = await env.state();
    expect(integrablePushItems(state).map((i) => i.id).sort()).toEqual(["x", "z"]);
    expect(itemWaitReason(state, "y")).toEqual({ kind: "push-regressed", commit: p2, rev: 2 });
    expect(integrator.wants(state)).toBe(false);
    const claimY = boardDigest(state, log, "a2", 0).claims.find((c) => c.item === "y")!;
    expect(claimY.fix?.instruction).toMatch(
      /removing your push removes 22 type errors \(the acceptance suite runs again: acceptance 4\/9\): src\/y\/b\.ts\(1,12\): error TS2339: Property 'auth' does not exist on type 'Ctx'\./,
    );
    expect(claimY.regressed?.instruction).toMatch(/made revision 2 WORSE: with it the stack scores 22 type errors, without it acceptance 4\/9/);
    expect(claimY.regressed?.instruction).toMatch(/edits the shared file src\/contracts\/auth\.ts that other items import: keep it backward compatible/);
    expect(reduceBoard(log)).toEqual(state);
  }, 120_000);

  it("coupled seam + consumer (each alone would regress the best revision, together they improve it): neither is blamed, the saboteur is, and the next revision stacks both", async () => {
    const env = await setup({ arbitration: 5, maxFixAttempts: 3 }, AUTH_SEAM);
    // Rev 1: x uses the context's `user` (the seam declares it): acceptance 3/9.
    await env.firstRatchet({ x: "PASS 1\nNEEDS user\n" });
    // p1: x moves to the renamed field `auth` (needs the seam change); p2: y renames `user` to `auth`
    // in the shared seam (breaks the old x); p3: z's saboteur push adds 4 type errors of its own.
    const p1 = await env.push("a1", "x", { [FILES.x!]: "PASS 2\nNEEDS auth\n" });
    const p2 = await env.push("a2", "y", { [FILES.y!]: "PASS 2\n", "src/contracts/auth.ts": "export interface Ctx { readonly auth: string }\n" });
    const p3 = await env.push("a3", "z", { [FILES.z!]: "PASS 1\nERR 4\n" });
    env.gate.ran.length = 0;
    env.gate.trees.length = 0;
    const integrator = await env.run();
    // The whole stack, then without p3 (the parse attributes z; z back at the baseline), without p1
    // (x back at the baseline: z's 4 errors stay), without p2 (x needs `auth`: 5 errors).
    expect(env.gate.ran).toEqual(["tsc 4", "acceptance 4", "tsc 4", "tsc 5"]);
    const log = await env.log();
    const revs = of(log, "integrated.rev");
    expect(revs.map((r) => [r.payload.n, [...r.payload.merged].sort()])).toEqual([
      [1, expect.any(Array)],
      [2, [p1, p2, p3].sort()],
      [3, [p1, p2].sort()],
    ]);
    // Only the saboteur is a regressor; the coupled pair is kept (removing either is no better).
    expect(integrator.isolations[0]!.map((i) => [i.kind, i.items.join(","), i.outcome, i.score?.runs ? i.score.acceptance : i.score?.typeErrors])).toEqual([
      ["push", "z", "regressed", 4],
      ["push", "x", "kept", 4],
      ["push", "y", "kept", 5],
      ["group", "x,y,z", "skipped", undefined],
    ]);
    expect(integrator.isolations[0]![3]!.skipped).toMatch(/beyond this round's 3 leave-one-out candidate/);
    const regressed = of(log, "push.regressed");
    expect(regressed.map((m) => [m.payload.item, m.payload.commit])).toEqual([["z", p3]]);
    expect(regressed[0]!.payload).toMatchObject({ from: { runs: true, acceptance: 4 }, to: { runs: false, typeErrors: 4 } });
    // The next revision stacks the coupled pair: it improves on the best revision (acceptance 4/9 over 3/9).
    expect(revs[2]!.payload.progress?.acceptance?.passed).toBe(4);
    expect(prePassRatchet(log)).toMatchObject({ n: 3, score: { acceptance: 4 } });
    const state = await env.state();
    expect(integrablePushItems(state).map((i) => i.id).sort()).toEqual(["x", "y"]);
    expect(itemWaitReason(state, "x")).not.toMatchObject({ kind: "push-regressed" });
    expect(itemWaitReason(state, "y")).not.toMatchObject({ kind: "push-regressed" });
    // The saboteur's holder is told what its removal removes.
    const claimZ = boardDigest(state, log, "a3", 0).claims.find((c) => c.item === "z")!;
    expect(claimZ.regressed?.instruction).toMatch(/with it the stack scores 4 type errors, without it acceptance 4\/9/);
    expect(reduceBoard(log)).toEqual(state);
  }, 120_000);

  it("coupled pushes still worse than the best revision together: nobody is blamed, the whole stack is recorded and both stay stacked", async () => {
    const env = await setup({ arbitration: 5, maxFixAttempts: 3 }, AUTH_SEAM);
    // Rev 1: x passes all three cases using the context's `user`: acceptance 5/9.
    await env.firstRatchet({ x: "PASS 3\nNEEDS user\n" }, 5);
    // The seam rename and the consumer that needs it, which for now passes only one case.
    const p1 = await env.push("a1", "x", { [FILES.x!]: "PASS 1\nNEEDS auth\n" });
    const p2 = await env.push("a2", "y", { [FILES.y!]: "PASS 1\n", "src/contracts/auth.ts": "export interface Ctx { readonly auth: string }\n" });
    env.gate.ran.length = 0;
    const integrator = await env.run();
    // Whole (acceptance 3, worse than 5), without p1 (x at the baseline: 2), without p2 (x needs `auth`:
    // 1 type error), without the seam group (1): removing anything is worse, so nothing is blamed.
    expect(env.gate.ran).toEqual(["acceptance 3", "acceptance 2", "tsc 1", "acceptance 1"]);
    expect(integrator.isolations[0]!.map((i) => [i.kind, i.items.join(","), i.outcome])).toEqual([
      ["push", "x", "kept"],
      ["push", "y", "kept"],
      ["group", "x,y", "kept"],
    ]);
    const log = await env.log();
    expect(of(log, "push.regressed")).toEqual([]);
    const revs = of(log, "integrated.rev");
    expect(revs).toHaveLength(2);
    expect([...revs[1]!.payload.merged]).toEqual(expect.arrayContaining([p1, p2]));
    expect(revs[1]!.payload.failing?.output).toMatch(/no better: kept \(pushes that work together are never blamed\)/);
    // The best revision so far stays rev 1 (shown, never a gate on what is stacked): both pushes stay stacked.
    expect(prePassRatchet(log)).toMatchObject({ n: 1 });
    expect(integrablePushItems(await env.state()).map((i) => i.id).sort()).toEqual(["x", "y", "z"]);
  }, 120_000);

  it("a seam group identifies a broken seam change: removing the seam push or its consumer alone is no better, removing both is; only the seam push is blamed", async () => {
    const env = await setup({ arbitration: 5, maxFixAttempts: 3 }, AUTH_SEAM);
    // Rev 1: z uses the context's `user`.
    await env.firstRatchet({ z: "PASS 1\nNEEDS user\n" });
    // p1: x starts using a new field `auth`; p2: y's seam push renames `user` to `auth` (breaking z, which nobody updated).
    const p1 = await env.push("a1", "x", { [FILES.x!]: "PASS 2\nNEEDS auth\n" });
    const p2 = await env.push("a2", "y", { [FILES.y!]: "PASS 1\n", "src/contracts/auth.ts": "export interface Ctx { readonly auth: string }\n" });
    env.gate.ran.length = 0;
    env.gate.trees.length = 0;
    const integrator = await env.run();
    // Whole (z breaks: 1 error), without p1 (z still breaks: 1), without p2 (x needs `auth`: 1),
    // without the group {p1, p2} (x and y at the baseline, z works again: acceptance 1/9), then the stack without p2.
    expect(env.gate.ran).toEqual(["tsc 1", "tsc 1", "tsc 1", "acceptance 1", "tsc 1"]);
    expect(integrator.isolations[0]!.map((i) => [i.kind, i.agent, i.agents.join(","), i.outcome])).toEqual([
      ["push", "a1", "a1", "kept"],
      ["push", "a2", "a2", "kept"],
      ["group", "a2", "a1,a2", "regressed"],
    ]);
    const log = await env.log();
    const regressed = of(log, "push.regressed");
    // The seam push is blamed; its consumer is not.
    expect(regressed.map((m) => [m.payload.item, m.payload.commit, m.payload.seams])).toEqual([["y", p2, ["src/contracts/auth.ts"]]]);
    expect(regressed[0]!.payload).toMatchObject({ from: { runs: true, acceptance: 1 }, to: { runs: false, typeErrors: 1 } });
    expect(regressed[0]!.payload.evidence).toEqual(["src/z/c.ts(40,5): error TS2339: Property 'user' does not exist on type 'Ctx'."]);
    const revs = of(log, "integrated.rev");
    expect(revs.map((r) => [r.payload.n, [...r.payload.merged].length])).toEqual([
      [1, 3],
      [2, 3],
      [3, 2],
    ]);
    expect(revs[2]!.payload.merged).not.toContain(p2);
    expect(revs[2]!.payload.merged).toContain(p1);
    const state = await env.state();
    expect(itemWaitReason(state, "y")).toEqual({ kind: "push-regressed", commit: p2, rev: 2 });
    expect(integrablePushItems(state).map((i) => i.id).sort()).toEqual(["x", "z"]);
    expect(reduceBoard(log)).toEqual(state);
  }, 120_000);

  it("once p2's holder pushes a fix and every item is right, the next revision passes: the gated commit is the branch head", async () => {
    const env = await setup();
    await env.firstRatchet();
    await env.threePushes();
    await env.run();
    const fixed = await env.push("a2", "y", { [FILES.y!]: "PASS 3\n", "src/contracts/auth.ts": "export interface Ctx { readonly user: string }\n" });
    expect(itemWaitReason(await env.state(), "y")).toEqual({ kind: "waiting-for-gate", commit: fixed });
    await env.push("a1", "x", { [FILES.x!]: "PASS 3\n" });
    await env.push("a3", "z", { [FILES.z!]: "PASS 3\n" });
    const integrator = await env.run();
    expect(integrator.revisions.map((r) => r.gate)).toEqual(["pass"]);
    const pass = integrator.revisions[0]!;
    expect([...pass.integratedItems].sort()).toEqual(["x", "y", "z"]);
    expect(await env.branchHead()).toBe(pass.commit);
    expect(prePassRatchet(await env.log())).toBeUndefined();
    expect(await env.fileAt(pass.commit, FILES.y!)).toBe("PASS 3\n");
  }, 120_000);

  it("arbitration revision 4 is unchanged: the same pushes integrate as one revision, nothing is left out or recorded regressed", async () => {
    const env = await setup({ arbitration: 4, maxFixAttempts: 3 });
    await env.push("a1", "x", { [FILES.x!]: "PASS 1\n" });
    await env.push("a2", "y", { [FILES.y!]: "PASS 1\n" });
    await env.push("a3", "z", { [FILES.z!]: "PASS 1\n" });
    await env.run();
    const { p1, p2, p3 } = await env.threePushes();
    env.gate.ran.length = 0;
    const integrator = await env.run();
    expect(env.gate.ran).toEqual(["tsc 22"]);
    const log = await env.log();
    expect(of(log, "integrated.rev").at(-1)!.payload.merged.slice().sort()).toEqual([p1, p2, p3].sort());
    expect(of(log, "push.regressed")).toEqual([]);
    expect(integrator.isolations).toEqual([]);
    expect(prePassRatchet(log)).toBeUndefined();
  }, 120_000);

  it("a cap stops leave-one-out candidates: the stack is recorded as before, nothing is blamed by the ratchet", async () => {
    const env = await setup();
    await env.firstRatchet();
    await env.threePushes();
    env.gate.ran.length = 0;
    const integrator = await env.run({ stopCandidates: () => "model-calls cap reached (100 of 100)" });
    expect(env.gate.ran).toEqual(["tsc 22"]);
    const log = await env.log();
    expect(of(log, "push.regressed")).toEqual([]);
    expect(of(log, "integrated.rev")).toHaveLength(2);
    expect(integrator.isolations[0]!.every((i) => i.outcome === "skipped" && /model-calls cap/.test(i.skipped ?? ""))).toBe(true);
    expect(integrator.revisions[0]!.implicated?.source).not.toBe("ratchet");
  }, 120_000);

  // Under leave-one-out the push the failure's parse attributes is tried first, so with K = 1 the
  // one candidate is the stack without p2 (before, K = 1 isolated p1 first and found nothing).
  it("K bounds the leave-one-out round: with K = 1 only the attributed push is tried; it is the regressor, the rest are stacked as usual", async () => {
    const env = await setup({ arbitration: 5, maxFixAttempts: 3 });
    await env.firstRatchet();
    const { p2 } = await env.threePushes();
    env.gate.ran.length = 0;
    const integrator = await env.run({ speculate: 1 });
    expect(env.gate.ran).toEqual(["tsc 22", "acceptance 4"]);
    expect(of(await env.log(), "push.regressed").map((m) => m.payload.commit)).toEqual([p2]);
    expect(integrator.isolations[0]!.map((i) => [i.items.join(","), i.outcome])).toEqual([
      ["y", "regressed"],
      ["x", "skipped"],
      ["z", "skipped"],
    ]);
    expect(integrator.isolations[0]![1]!.skipped).toMatch(/beyond this round's 1 leave-one-out candidate/);
  }, 120_000);
});

describe("ratchet evidence helpers", () => {
  it("quotes only the failure lines the reference did not have, bounded", () => {
    const reference = "src/a.ts(1,1): error TS2339: old\n✖ a: case 1";
    const candidate = ["src/a.ts(1,1): error TS2339: old", "src/b.ts(2,3): error TS2304: Cannot find name 'authenticate'.", "noise", "✖ b: case 2", "✖ a: case 1"].join("\n");
    expect(regressionEvidence(candidate, reference)).toEqual(["src/b.ts(2,3): error TS2304: Cannot find name 'authenticate'.", "✖ b: case 2"]);
    expect(regressionEvidence(Array.from({ length: 20 }, (_, k) => `src/c.ts(${k},1): error TS1: x`).join("\n"), "")).toHaveLength(5);
    expect(regressionEvidence("Error: boom", "")).toEqual(["Error: boom"]);
  });

  /**
   * The shape of the live storefront run's revision 4 (board-live-sf12): a seam push to src/store.ts
   * (agent-1, with its orders-history push), and pushes to billing/refunds.ts and catalog/products.ts
   * (agent-2) and billing/invoices.ts (agent-3), all importers of the store. The parse attributed the
   * failure to refunds, products, history and the seam item.
   */
  const SF12_STATE = {
    seams: [
      { path: "src/store.ts", importers: ["src/billing/invoices.ts", "src/billing/refunds.ts", "src/catalog/products.ts", "src/orders/history.ts", "src/index.ts"], symbols: ["Store", "Ctx", "Payment"] },
    ],
    items: {},
  } as unknown as Parameters<typeof seamConsumers>[0];
  const item = (id: string, write: string[]) => ({ id, intent: { read: [], write }, scopeHint: write }) as unknown as LeaveOneOutPush["items"][number];
  const sf12: LeaveOneOutPush[] = [
    { agent: "agent-1", items: [item("orders-history", ["src/orders/history.ts"]), item("seam-agent-1-contract-1", ["src/store.ts"])], paths: ["src/orders/history.ts", "src/store.ts"], seq: 48, attributed: true },
    { agent: "agent-2", items: [item("billing-refunds", ["src/billing/refunds.ts"]), item("catalog-products", ["src/catalog/products.ts"])], paths: ["src/billing/refunds.ts", "src/catalog/products.ts"], seq: 43, attributed: true },
    { agent: "agent-3", items: [item("billing-invoices", ["src/billing/invoices.ts"])], paths: ["src/billing/invoices.ts"], seq: 67, attributed: false },
  ];

  it("plans leave-one-out deterministically: attributed pushes first, then push order; a seam group after its members", () => {
    const consumers = (p: LeaveOneOutPush) => seamConsumers(SF12_STATE, p, sf12, "");
    expect(consumers(sf12[0]!)).toEqual(["agent-2", "agent-3"]);
    expect(consumers(sf12[1]!)).toEqual([]);
    expect(leaveOneOutPlan(sf12, consumers)).toEqual([
      { kind: "push", agent: "agent-2", agents: ["agent-2"] },
      { kind: "push", agent: "agent-1", agents: ["agent-1"] },
      { kind: "push", agent: "agent-3", agents: ["agent-3"] },
      { kind: "group", agent: "agent-1", agents: ["agent-1", "agent-2", "agent-3"] },
    ]);
    // Order does not depend on the input order.
    expect(leaveOneOutPlan([...sf12].reverse(), consumers)).toEqual(leaveOneOutPlan(sf12, consumers));
  });

  it("finds a seam's consumers by blueprint importers, a seam wait, or a failure in their files naming the seam", () => {
    const noBlueprint = { seams: [], items: {} } as unknown as Parameters<typeof seamConsumers>[0];
    const seamPush: LeaveOneOutPush = { agent: "a2", items: [item("y", ["src/contracts/auth.ts"])], paths: ["src/contracts/auth.ts"], seq: 1, attributed: false };
    const x: LeaveOneOutPush = { agent: "a1", items: [item("x", ["src/x/**"])], paths: ["src/x/a.ts"], seq: 2, attributed: false };
    const z: LeaveOneOutPush = { agent: "a3", items: [item("z", ["src/z/**"])], paths: ["src/z/c.ts"], seq: 3, attributed: false };
    // A shared seam file with no blueprint: only the failure names it.
    expect(seamConsumers(noBlueprint, seamPush, [x, z], "")).toEqual([]);
    expect(seamConsumers(noBlueprint, seamPush, [x, z], `src/x/a.ts(3,10): error TS2305: Module '"../contracts/auth.ts"' has no exported member 'isAuthenticated'.`)).toEqual(["a1"]);
    // A blueprint seam's exported name in a failure located in a consumer's file.
    const blueprint = { seams: [{ path: "src/contracts/auth.ts", importers: [], symbols: ["Ctx"] }], items: {} } as unknown as Parameters<typeof seamConsumers>[0];
    expect(seamConsumers(blueprint, seamPush, [x, z], "src/z/c.ts(40,5): error TS2339: Property 'user' does not exist on type 'Ctx'.")).toEqual(["a3"]);
    // A push that edits no seam has no consumers.
    expect(seamConsumers(blueprint, x, [seamPush, z], "")).toEqual([]);
  });

  it("names the shared seams a push edits", () => {
    const state = { seams: [{ path: "src/types.ts", importers: [] }] } as unknown as Parameters<typeof seamsEdited>[0];
    expect(seamsEdited(state, ["src/billing/a.ts", "src/contracts/auth.ts", "src/store.ts", "src/types.ts"])).toEqual(["src/contracts/auth.ts", "src/store.ts", "src/types.ts"]);
  });
});

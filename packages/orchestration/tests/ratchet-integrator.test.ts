/**
 * The PRE-PASS PROGRESS RATCHET (arbitration revision 5) over real local Git
 * and the offline local control (no network; a fake gate that computes a
 * score from the tree): before the first pass, a stack that scores worse than
 * the best failing revision so far is isolated (the ratchet's set plus each
 * new push alone, each a real gated tree), a push that alone regresses it is
 * recorded push.regressed with a fix request quoting the regression and left
 * out of the stack until its holder pushes again, and the stack without it is
 * recorded as the next revision. The head never moves before a pass, and the
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
import { regressionEvidence, seamsEdited } from "../src/ratchet-integration.ts";
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
 * carry `ERR n` fails the typecheck with n type errors in that file (the
 * acceptance suite does not run); otherwise each file's `PASS k` passes k of
 * its 3 acceptance cases, and the gate passes only with all 9.
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
    for (const [item, rel] of Object.entries(FILES)) {
      const body = await readFile(join(cwd, rel), "utf8").catch(() => "");
      tree[item] = body;
      const err = Number(/ERR (\d+)/.exec(body)?.[1] ?? 0);
      for (let k = 0; k < err; k += 1) {
        errors.push(`${rel}(${k + 1},12): error TS2339: Property 'auth' does not exist on type 'Ctx'.`);
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

async function setup(rules: Record<string, number> = { arbitration: 5, maxFixAttempts: 3 }) {
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
    payload: { objective: "o", protected: ["package.json", ACCEPTANCE], immutable: [ACCEPTANCE], baseline: remote, rules: { speculate: 3, ...rules } },
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
  const firstRatchet = async () => {
    const pushes = {
      x: await push("a1", "x", { [FILES.x!]: "PASS 1\n" }),
      y: await push("a2", "y", { [FILES.y!]: "PASS 1\n" }),
      z: await push("a3", "z", { [FILES.z!]: "PASS 1\n" }),
    };
    const first = await run();
    expect(first.revisions.map((r) => [r.gate, r.progress?.acceptance?.passed])).toEqual([["fail", 3]]);
    expect(prePassRatchet(await log())).toMatchObject({ n: 1, score: { runs: true, acceptance: 3, acceptanceTotal: 9 } });
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
  it("p1 improves, p2 regresses, p3 improves: the next revision carries p1 + p3, p2 is push.regressed with a fix request quoting it and left out until it pushes again", async () => {
    const env = await setup();
    const first = await env.firstRatchet();
    const { p1, p2, p3 } = await env.threePushes();
    env.gate.ran.length = 0;
    env.gate.trees.length = 0;
    const integrator = await env.run();
    // The whole stack (22 type errors), then the ratchet's set plus each new push alone (in push order), then the stack without p2.
    expect(env.gate.ran).toEqual(["tsc 22", "acceptance 4", "tsc 22", "acceptance 4", "acceptance 4"]);
    const log = await env.log();
    const revs = of(log, "integrated.rev");
    expect(revs.map((r) => [r.payload.n, r.payload.gate, [...r.payload.merged].sort()])).toEqual([
      [1, "fail", [first.x, first.y, first.z].sort()],
      [2, "fail", [p1, p2, p3].sort()],
      [3, "fail", [p1, p3].sort()],
    ]);
    // Rev 2 (the whole stack) asks ONLY p2's item for the fix; its output leads with the ratchet's finding.
    expect(revs[1]!.payload.failing?.items).toEqual(["y"]);
    expect(revs[1]!.payload.failing?.output).toMatch(/^pre-pass ratchet: this stack scores 22 type errors, worse than the best revision so far \(revision 1: acceptance 3\/9\)/);
    expect(revs[1]!.payload.progress?.acceptanceNotRun).toBe("typecheck failed (22 errors)");
    const fixes = of(log, "fix.requested").filter((m) => m.payload.n === 2);
    expect(fixes.map((m) => [m.payload.item, m.to])).toEqual([["y", ["a2"]]]);
    // The regression, addressed to its holder, with typed evidence and the seam it edits.
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
        from: { runs: true, acceptance: 3, acceptanceTotal: 9 },
        to: { runs: false, typeErrors: 22 },
        seams: ["src/contracts/auth.ts"],
      },
    });
    expect(regressed!.payload.evidence[0]).toBe("src/y/b.ts(1,12): error TS2339: Property 'auth' does not exist on type 'Ctx'.");
    expect(regressed!.payload.evidence.length).toBeLessThanOrEqual(5);
    // Each isolation tree is a real gated tree: the ratchet's set (each item at its first push) plus one new push alone.
    expect(env.gate.trees).toEqual([
      { x: "PASS 2\n", y: "PASS 1\nERR 22\n", z: "PASS 2\n" },
      { x: "PASS 2\n", y: "PASS 1\n", z: "PASS 1\n" },
      { x: "PASS 1\n", y: "PASS 1\nERR 22\n", z: "PASS 1\n" },
      { x: "PASS 1\n", y: "PASS 1\n", z: "PASS 2\n" },
      // Rev 3: p1 and p3, y at the baseline.
      { x: "PASS 2\n", y: "export const b = 0;\n", z: "PASS 2\n" },
    ]);
    const candidate = regressed!.payload.candidate;
    expect(revs.map((r) => r.payload.commit)).not.toContain(candidate);
    // Rev 3 is the new ratchet; the head is still the baseline.
    expect(revs[2]!.payload.progress?.acceptance?.passed).toBe(4);
    expect(revs.every((r) => r.payload.base === env.remote)).toBe(true);
    expect(await env.branchHead()).toBe(env.remote);
    expect(prePassRatchet(log)).toMatchObject({ n: 3, score: { acceptance: 4 } });
    // The round's record: p2 regressed, p1 and p3 kept.
    expect(integrator.isolations).toHaveLength(1);
    expect(integrator.isolations[0]!.map((i) => [i.items.join(","), i.outcome])).toEqual([
      ["x", "kept"],
      ["y", "regressed"],
      ["z", "kept"],
    ]);
    expect(integrator.revisions.find((r) => r.n === 2)?.implicated).toEqual({ items: ["y"], source: "ratchet" });
    // p2 waits for its holder: not stacked, wait reason push-regressed, the digest quotes the regression.
    const state = await env.state();
    expect(integrablePushItems(state).map((i) => i.id).sort()).toEqual(["x", "z"]);
    expect(itemWaitReason(state, "y")).toEqual({ kind: "push-regressed", commit: p2, rev: 2 });
    expect(integrator.wants(state)).toBe(false);
    const claimY = boardDigest(state, log, "a2", 0).claims.find((c) => c.item === "y")!;
    expect(claimY.fix?.instruction).toMatch(/your push adds 22 type errors: src\/y\/b\.ts\(1,12\): error TS2339: Property 'auth' does not exist on type 'Ctx'\./);
    expect(claimY.regressed?.instruction).toMatch(/edits the shared file src\/contracts\/auth\.ts that other items import: keep it backward compatible/);
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

  it("arbitration revision 4 is unchanged: the same pushes integrate as one revision, nothing is isolated or recorded regressed", async () => {
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

  it("a cap stops isolation candidates: the stack is recorded as before, nothing is blamed by the ratchet", async () => {
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

  it("K bounds the isolation round: with K = 1 only the first new push is isolated (it is kept), so the stack is recorded as before", async () => {
    const env = await setup({ arbitration: 5, maxFixAttempts: 3 });
    await env.firstRatchet();
    await env.threePushes();
    env.gate.ran.length = 0;
    const integrator = await env.run({ speculate: 1 });
    expect(env.gate.ran).toEqual(["tsc 22", "acceptance 4"]);
    expect(of(await env.log(), "push.regressed")).toEqual([]);
    expect(integrator.isolations[0]!.map((i) => i.outcome)).toEqual(["kept", "skipped", "skipped"]);
    expect(integrator.isolations[0]![1]!.skipped).toMatch(/beyond this round's 1 isolation candidate/);
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

  it("names the shared seams a push edits", () => {
    const state = { seams: [{ path: "src/types.ts", importers: [] }] } as unknown as Parameters<typeof seamsEdited>[0];
    expect(seamsEdited(state, ["src/billing/a.ts", "src/contracts/auth.ts", "src/store.ts", "src/types.ts"])).toEqual(["src/contracts/auth.ts", "src/store.ts", "src/types.ts"]);
  });
});

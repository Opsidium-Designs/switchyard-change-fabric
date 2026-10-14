/**
 * Speculative batch gating over real local Git and the offline local control
 * (no network; fake gates): the integrator stacks the pending pushes in push
 * order, gates prefix candidates (head + p1, head + p1 + p2, ...), lands the
 * longest passing prefix as ONE revision whose commit is exactly the gated
 * candidate's, blames only the push whose candidate failed after a passing
 * one (its fix budget alone is charged), re-tests the pushes behind a failure
 * on the new head instead of blaming them, stops new candidates at a cap, and
 * rebuilds (never lands) when the board refuses a stale base. Speculation
 * needs a head that passed the gate: until a revision passed, every pending
 * push integrates as one revision, as without it.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { integrablePushItems, itemWaitReason, leaseSuspension, type BoardMessage } from "@switchyard-change/change-core";
import { readDependencySnapshotFromDir, runnerResolutionContract, type CommandOutcome, type CommandRunner } from "@switchyard-change/verification";

import { BoardAgentClient, BoardOperatorClient } from "../src/board-client.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { assertBoardBacked, boardRevNodeId, buildBoardGraph, openIntegrationRound } from "../src/board-graph.ts";
import { ContinuousBoardIntegrator, promotionBlocked, runBoard, type BoardAgentRepo } from "../src/run-board.ts";
import { createIntegrationWorkspace } from "../src/run-live.ts";

const git = promisify(execFile);
const ID = "change-speculate";
const BASE = "http://local-control";
const IDENTITY = { name: "Test Integrator", email: "integrator@test.local" };

/** Optional fixture extras: more project files, and extra write scope per item. */
interface SetupOptions {
  readonly files?: Readonly<Record<string, string>>;
  /** Extra goal rules (for example an arbitration revision). */
  readonly rules?: Readonly<Record<string, number>>;
  readonly extraWrite?: Readonly<Record<string, readonly string[]>>;
}

async function setup(setupOptions: SetupOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "scf-speculate-"));
  const projectDir = join(root, "project");
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p"}\n',
    "src/x/a.ts": "export const a = 0;\n",
    "src/y/b.ts": "export const b = 0;\n",
    "src/z/c.ts": "export const c = 0;\n",
    "src/w/d.ts": "export const d = 0;\n",
    ...setupOptions.files,
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
  await human({ type: "goal.posted", payload: { objective: "o", protected: ["package.json"], baseline: remote, rules: { speculate: 3, ...setupOptions.rules } } });
  for (const item of ["w", "x", "y", "z"]) {
    await human({ type: "item.proposed", payload: { item, objective: `do ${item}`, scopeHint: [`src/${item}/**`, ...(setupOptions.extraWrite?.[item] ?? [])] } });
  }
  const agents = new Map<string, { client: BoardAgentClient; repo: BoardAgentRepo; dir: string }>();
  for (const id of ["a0", "a1", "a2", "a3"]) {
    const joined = await operator.join(id, { workspaceTtlSeconds: 600 });
    if (!joined.ok || !joined.workspace) {
      throw new Error(`join failed for ${id}`);
    }
    const dir = join(root, "agents", id);
    await git("git", ["clone", "-q", joined.workspace.gitUrl, dir]);
    agents.set(id, {
      client: new BoardAgentClient(fetchFn, BASE, ID, id, joined.token),
      repo: { gitUrl: joined.workspace.gitUrl, defaultBranch: joined.workspace.defaultBranch },
      dir,
    });
  }
  const worktreeRoot = join(root, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const agent = (id: string) => agents.get(id)!;
  const post = async (id: string, draft: unknown) => {
    const outcome = await agent(id).client.post(draft);
    if (!outcome.ok) {
      throw new Error(`${id} refused: ${outcome.code} ${outcome.error}`);
    }
    return outcome.appended;
  };
  for (const [id, item] of [["a0", "w"], ["a1", "x"], ["a2", "y"], ["a3", "z"]] as const) {
    await post(id, { type: "item.claimed", payload: { item, intent: { read: [], write: [`src/${item}/**`, ...(setupOptions.extraWrite?.[item] ?? [])] } } });
  }
  /** Commit one file in the agent's repo, push it, and announce it for the item. */
  const push = async (id: string, item: string, rel: string, body: string): Promise<string> => {
    const { dir, repo } = agent(id);
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
    await git("git", ["-C", dir, "add", "-A"]);
    await git("git", ["-C", dir, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "-q", "-m", "work"]);
    await git("git", ["-C", dir, "push", "-q", repo.gitUrl, `HEAD:refs/heads/${repo.defaultBranch}`]);
    const sha = (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    await post(id, { type: "push.announced", payload: { item, commit: sha, paths: [rel] } });
    return sha;
  };
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
      ...extra,
    });
  const log = async (): Promise<readonly BoardMessage[]> => (await operator.log()).messages;
  const branchHead = async (): Promise<string> =>
    (await git("git", ["ls-remote", integration.integrationRef.gitUrl, `refs/heads/${integration.integrationRef.defaultBranch}`])).stdout.split(/\s+/)[0]!;
  /** A file's content at a commit of the integration repo (gated candidate refs included). */
  const fileAt = async (commit: string, rel: string): Promise<string | undefined> => {
    const dir = await mkdtemp(join(root, "check-"));
    await git("git", ["init", "-q", dir]);
    await git("git", ["-C", dir, "fetch", "-q", integration.integrationRef.gitUrl, commit]).catch(() => undefined);
    return (await git("git", ["-C", dir, "show", `${commit}:${rel}`]).catch(() => ({ stdout: undefined }))).stdout;
  };
  /**
   * Land a first passing revision (w's push) so the head has passed the gate:
   * returns its commit, the head the speculative rounds build on.
   */
  const warm = async (): Promise<string> => {
    await push("a0", "w", "src/w/d.ts", "export const d = 1;\n");
    const first = integrator({ verifyCommandRunner: new MarkerGate() });
    first.kick();
    await first.idle();
    expect(first.rounds).toEqual([]);
    expect(first.revisions.map((r) => r.gate)).toEqual(["pass"]);
    return first.revisions[0]!.commit;
  };
  /** The revisions recorded after the warm-up one. */
  const revisions = async () => of(await log(), "integrated.rev").slice(1);
  /** Leave a file outside every write intent in the agent's checkout: its next push commits it too. */
  const stray = async (id: string, rel: string, body: string): Promise<void> => {
    const { dir } = agent(id);
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  };
  /** Remove that file in the agent's checkout (its next push deletes it). */
  const unstray = async (id: string, rel: string): Promise<void> => {
    await git("git", ["-C", agent(id).dir, "rm", "-q", rel]);
  };
  return { root, control, operator, push, integrator, log, branchHead, fileAt, remote, warm, revisions, projectDir, stray, unstray };
}

/** A gate that fails while any file of the tree carries "BAD", naming that file (like a failing test's location). */
class MarkerGate implements CommandRunner {
  readonly ran: string[] = [];
  async run(_argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    const bad: string[] = [];
    for (const rel of ["src/x/a.ts", "src/y/b.ts", "src/z/c.ts"]) {
      if ((await readFile(join(cwd, rel), "utf8").catch(() => "")).includes("BAD")) {
        bad.push(rel);
      }
    }
    this.ran.push(bad.join(",") || "ok");
    return bad.length === 0
      ? { code: 0, stdout: "ok 1 - status\n", stderr: "" }
      : { code: 1, stdout: `not ok 1 - status\n# ${bad.map((f) => `${f}:1:1 AssertionError`).join("\n# ")}\n`, stderr: "" };
  }
}

const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

describe("speculative batch gating", () => {
  it("until a revision passed, every pending push integrates as one revision (no candidate)", async () => {
    const env = await setup();
    const p1 = await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    const p2 = await env.push("a2", "y", "src/y/b.ts", "export const b = 'BAD';\n");
    const integrator = env.integrator({ verifyCommandRunner: new MarkerGate() });
    integrator.kick();
    await integrator.idle();
    expect(integrator.rounds).toEqual([]);
    const log = await env.log();
    expect(of(log, "integrated.rev").map((r) => [r.payload.gate, [...r.payload.merged].sort(), r.payload.failing?.items ?? null])).toEqual([["fail", [p1, p2].sort(), ["y"]]]);
    expect(of(log, "candidate.gated")).toEqual([]);
  });

  it("p2 bad: C1 lands alone, p2 alone is blamed, p3 is re-tested on the new head and lands", async () => {
    const env = await setup();
    const head = await env.warm();
    const p1 = await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    const p2 = await env.push("a2", "y", "src/y/b.ts", "export const b = 'BAD';\n");
    const p3 = await env.push("a3", "z", "src/z/c.ts", "export const c = 1;\n");
    const gate = new MarkerGate();
    const integrator = env.integrator({ verifyCommandRunner: gate, candidateConcurrency: 3 });
    integrator.kick();
    await integrator.idle();

    // Round 1: C1 = head+p1 passes, C2 = +p2 and C3 = +p3 fail (all three gated, in parallel).
    expect(integrator.rounds[0]!.map((c) => [c.index, c.gate, c.outcome])).toEqual([
      [1, "pass", "landed"],
      [2, "fail", "blamed"],
      [3, "fail", "retest"],
    ]);
    const log = await env.log();
    const revs = await env.revisions();
    // The blamed candidate is recorded first as a failing revision on the head
    // (implicating y only), then the landed prefix as the passing revision.
    expect(revs.map((r) => [r.payload.n, r.payload.gate, [...r.payload.merged]])).toEqual([
      [2, "fail", [p1, p2]],
      [3, "pass", [p1]],
      [4, "pass", [p3]],
    ]);
    expect(revs[0]!.payload.failing!.items).toEqual(["y"]);
    expect(revs[0]!.payload.base).toBe(head);
    expect(revs[1]!.payload.base).toBe(head);
    // p3 was re-tested on the NEW head, alone, and landed.
    expect(revs[2]!.payload.base).toBe(revs[1]!.payload.commit);
    expect(integrator.rounds[1]!.map((c) => [c.index, c.gate, c.outcome, c.prefix.map((p) => p.items.join("+"))])).toEqual([[1, "pass", "landed", ["z"]]]);
    // The fix loop and its budget touch y alone.
    expect(of(log, "fix.requested").map((m) => m.payload.item)).toEqual(["y"]);
    const state = (await env.operator.page(0, 1)).state;
    expect(state.items.x!.fixAttempts).toBeUndefined();
    expect(state.items.z!.fixAttempts).toBeUndefined();
    expect(state.items.y!.fixAttempts).toBe(1);
    expect(state.items.y!.lastPush!.integratedIn).toBeUndefined();

    // Every gated candidate is recorded, backing the revision it became.
    const candidates = of(log, "candidate.gated");
    expect(candidates.map((m) => [m.payload.round, m.payload.index, m.payload.verdict, m.payload.outcome, m.payload.rev ?? null, m.payload.blamed ?? null])).toEqual([
      [1, 1, "pass", "landed", 3, null],
      [1, 2, "fail", "blamed", 2, ["y"]],
      [1, 3, "fail", "retest", null, null],
      [2, 1, "pass", "landed", 4, null],
    ]);
    // Gate equals deploy: the landed revision's commit IS the gated candidate's,
    // the blamed failure's IS its candidate's, and the branch is the last landed one.
    expect(candidates[0]!.payload.commit).toBe(revs[1]!.payload.commit);
    expect(candidates[1]!.payload.commit).toBe(revs[0]!.payload.commit);
    expect(candidates[3]!.payload.commit).toBe(revs[2]!.payload.commit);
    expect(await env.branchHead()).toBe(revs[2]!.payload.commit);
    expect(await env.fileAt(revs[1]!.payload.commit, "src/y/b.ts")).toBe("export const b = 0;\n");
    expect(await env.fileAt(revs[2]!.payload.commit, "src/x/a.ts")).toBe("export const a = 1;\n");
    expect(await env.fileAt(revs[2]!.payload.commit, "src/z/c.ts")).toBe("export const c = 1;\n");
    expect(await env.fileAt(revs[2]!.payload.commit, "src/y/b.ts")).toBe("export const b = 0;\n");
    // The run's last revision passed (its evidence is the landed candidate's).
    expect(integrator.revisions.at(-1)!.gate).toBe("pass");
    expect(integrator.lastEvidence!.integration.commit).toBe(revs[2]!.payload.commit);
    // Nothing more to gate until y's owner pushes a fix.
    expect(integrator.wants(state)).toBe(false);

    // The graph shows the round's candidates on the revisions they back
    // (records in the detail, never nodes), every node and edge backed.
    const graph = buildBoardGraph(log);
    assertBoardBacked(graph, log);
    expect(graph.edges.every((e) => ["dependency", "spawn", "trigger", "consumed-tool"].includes(e.kind))).toBe(true);
    expect(graph.nodes.some((n) => n.id.startsWith("candidate"))).toBe(false);
    const landedNode = graph.nodes.find((n) => n.id === boardRevNodeId(3))!;
    const detail = landedNode.detail.kind === "rev" ? landedNode.detail : undefined;
    expect(detail?.candidates?.map((c) => [c.index, c.verdict, c.outcome, c.prefix])).toEqual([
      [1, "pass", "landed", "x"],
      [2, "fail", "blamed", "x then y"],
      [3, "fail", "retest", "x then y then z"],
    ]);
    for (const c of detail!.candidates!) {
      expect(log.find((m) => m.seq === c.seq)?.type).toBe("candidate.gated");
    }
    const blamedNode = graph.nodes.find((n) => n.id === boardRevNodeId(2))!;
    expect(blamedNode.detail.kind === "rev" && blamedNode.detail.candidates?.length).toBe(3);
  });

  it("p1 bad: p1 is blamed alone, p2 and p3 are not blamed and land together on a re-test", async () => {
    const env = await setup();
    await env.warm();
    const p1 = await env.push("a1", "x", "src/x/a.ts", "export const a = 'BAD';\n");
    const p2 = await env.push("a2", "y", "src/y/b.ts", "export const b = 1;\n");
    const p3 = await env.push("a3", "z", "src/z/c.ts", "export const c = 1;\n");
    const integrator = env.integrator({ verifyCommandRunner: new MarkerGate(), candidateConcurrency: 3 });
    integrator.kick();
    await integrator.idle();

    expect(integrator.rounds[0]!.map((c) => [c.index, c.gate, c.outcome])).toEqual([
      [1, "fail", "blamed"],
      [2, "fail", "retest"],
      [3, "fail", "retest"],
    ]);
    const log = await env.log();
    const revs = await env.revisions();
    expect(revs.map((r) => [r.payload.gate, [...r.payload.merged]])).toEqual([
      ["fail", [p1]],
      ["pass", [p2, p3]],
    ]);
    expect(revs[0]!.payload.failing!.items).toEqual(["x"]);
    expect(of(log, "fix.requested").map((m) => m.payload.item)).toEqual(["x"]);
    // The re-test round stacked p2 then p3 on the (unchanged) head: C2 landed.
    expect(integrator.rounds[1]!.map((c) => [c.index, c.gate, c.outcome])).toEqual([
      [1, "pass", "passed"],
      [2, "pass", "landed"],
    ]);
    const state = (await env.operator.page(0, 1)).state;
    expect(state.items.y!.fixAttempts).toBeUndefined();
    expect(state.items.z!.fixAttempts).toBeUndefined();
    expect(of(log, "candidate.gated").find((m) => m.payload.outcome === "landed")!.payload.commit).toBe(revs[1]!.payload.commit);

    // The owner's fix lands on top: the blamed push no longer holds anything back.
    const fixed = await env.push("a1", "x", "src/x/a.ts", "export const a = 2;\n");
    integrator.kick();
    await integrator.idle();
    const after = await env.revisions();
    expect(after.at(-1)!.payload.gate).toBe("pass");
    expect(after.at(-1)!.payload.merged).toEqual([fixed]);
    expect(after.at(-1)!.payload.base).toBe(revs[1]!.payload.commit);
  });

  it("a reached cap stops new candidates: each round gates its first candidate only", async () => {
    const env = await setup();
    await env.warm();
    const p1 = await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    const p2 = await env.push("a2", "y", "src/y/b.ts", "export const b = 1;\n");
    const p3 = await env.push("a3", "z", "src/z/c.ts", "export const c = 1;\n");
    const gate = new MarkerGate();
    const integrator = env.integrator({ verifyCommandRunner: gate, candidateConcurrency: 1, stopCandidates: () => "the run reached its model-calls cap (10 of 10)" });
    integrator.kick();
    await integrator.idle();

    // Three rounds, one gate run each (C1), the speculative ones never built.
    expect(gate.ran).toEqual(["ok", "ok", "ok"]);
    expect(integrator.rounds.map((r) => r.map((c) => c.outcome ?? c.skipped))).toEqual([
      ["landed", "not built: the run reached its model-calls cap (10 of 10)", "not built: the run reached its model-calls cap (10 of 10)"],
      ["landed", "not built: the run reached its model-calls cap (10 of 10)"],
      ["landed"],
    ]);
    const revs = await env.revisions();
    expect(revs.map((r) => [...r.payload.merged])).toEqual([[p1], [p2], [p3]]);
    // Candidates not built are never recorded.
    expect(of(await env.log(), "candidate.gated")).toHaveLength(3);
  });

  it("a stale base refused by the board is a rebuild on the head, never a wrong landing", async () => {
    const env = await setup();
    await env.warm();
    const p1 = await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    const p2 = await env.push("a2", "y", "src/y/b.ts", "export const b = 1;\n");
    let refusals = 0;
    // The head "moved" while the first round's candidates gated: the board
    // refuses the first revision with STALE_BASE (nothing appended).
    const operator = new Proxy(env.operator, {
      get(target, prop, receiver) {
        if (prop === "recordRevision") {
          return async (input: Parameters<BoardOperatorClient["recordRevision"]>[0]) => {
            if (refusals === 0) {
              refusals += 1;
              return { ok: false, status: 409, code: "STALE_BASE", error: "the revision was built on a stale head" };
            }
            return target.recordRevision(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const gate = new MarkerGate();
    const integrator = env.integrator({ operator, verifyCommandRunner: gate, candidateConcurrency: 1 });
    integrator.kick();
    await integrator.idle();

    expect(refusals).toBe(1);
    // Rebuilt and gated again (2 candidates per round, twice), then landed once.
    expect(gate.ran).toEqual(["ok", "ok", "ok", "ok"]);
    const log = await env.log();
    const revs = await env.revisions();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.payload.merged).toEqual([p1, p2]);
    // Only the rebuilt round's candidates are recorded, and the landed one is the revision.
    const candidates = of(log, "candidate.gated");
    expect(candidates.map((m) => [m.payload.round, m.payload.index, m.payload.outcome])).toEqual([
      [1, 1, "passed"],
      [1, 2, "landed"],
    ]);
    expect(candidates[1]!.payload.commit).toBe(revs[0]!.payload.commit);
    expect(await env.branchHead()).toBe(revs[0]!.payload.commit);
  });

  it("a landed pass the board refuses after the blamed failure was recorded: the round's evidence is the failure's, and nothing may be promoted", async () => {
    const env = await setup();
    await env.warm();
    await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    await env.push("a2", "y", "src/y/b.ts", "export const b = 'BAD';\n");
    // The board accepts the blamed failure, then refuses every passing
    // revision (not a stale base: the round does not rebuild).
    const refusedPasses: string[] = [];
    const operator = new Proxy(env.operator, {
      get(target, prop, receiver) {
        if (prop === "recordRevision") {
          return async (input: Parameters<BoardOperatorClient["recordRevision"]>[0]) => {
            if (input.gate === "pass") {
              refusedPasses.push(input.commit);
              return { ok: false, status: 409, code: "INVALID_STATE", error: "refused for the test" };
            }
            return target.recordRevision(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const integrator = env.integrator({ operator, verifyCommandRunner: new MarkerGate(), candidateConcurrency: 1 });
    integrator.kick();
    await integrator.idle();

    expect(refusedPasses.length).toBeGreaterThan(0);
    const revs = await env.revisions();
    expect(revs.map((r) => r.payload.gate)).toEqual(["fail"]);
    const last = integrator.revisions.at(-1)!;
    expect(last.gate).toBe("fail");
    expect(last.commit).toBe(revs[0]!.payload.commit);
    // The evidence is the RECORDED failure's, never the refused candidate's.
    expect(integrator.lastEvidence!.integration.commit).toBe(last.commit);
    expect(integrator.lastEvidence!.integration.verdict).not.toBe("verified");
    expect(refusedPasses).not.toContain(integrator.lastEvidence!.integration.commit);
    const state = (await env.operator.page(0, 1)).state;
    expect(promotionBlocked({ verdict: "failed", last, evidence: integrator.lastEvidence!, state })).toMatch(/not "verified": not promoting/);
    expect(of(await env.log(), "revision.promoted")).toEqual([]);
  });

  for (const speculate of [3, 1]) {
    it(`a push that fails verification is recorded excluded to its holder, leaves the plan, and is re-gated only after a new push (speculate ${speculate})`, async () => {
      const env = await setup();
      if (speculate > 1) {
        await env.warm();
      }
      // a1's push for x also commits a file outside its write intent: the verifier excludes it.
      await env.stray("a1", "src/q/stray.ts", "export const q = 1;\n");
      const p1 = await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
      const p2 = await env.push("a2", "y", "src/y/b.ts", "export const b = 1;\n");
      const p3 = await env.push("a3", "z", "src/z/c.ts", "export const c = 1;\n");
      const integrator = env.integrator({ verifyCommandRunner: new MarkerGate(), candidateConcurrency: 1, speculate });
      integrator.kick();
      await integrator.idle();

      const log = await env.log();
      const excluded = of(log, "push.excluded");
      expect(excluded.map((m) => [m.payload.item, m.payload.agent, m.payload.commit, m.to])).toEqual([["x", "a1", p1, ["a1"]]]);
      expect(excluded[0]!.payload.reason).toMatch(/failed verification/);
      // The others land (speculation rebuilt its stack without p1); p1 was never merged.
      const revs = await env.revisions();
      const landed = (speculate > 1 ? revs : of(log, "integrated.rev")).filter((r) => r.payload.gate === "pass").flatMap((r) => [...r.payload.merged]);
      expect(landed.sort()).toEqual([p2, p3].sort());
      expect(of(log, "integrated.rev").some((r) => r.payload.merged.includes(p1))).toBe(false);
      let state = (await env.operator.page(0, 1)).state;
      expect(state.items.x!.lastPush!.excluded).toBeDefined();
      expect(itemWaitReason(state, "x")).toMatchObject({ kind: "push-excluded", commit: p1 });
      // The claim no longer waits for the gate (a lease would run again).
      expect(leaseSuspension(state, state.items.x!)).toBeUndefined();
      expect(integrablePushItems(state).map((i) => i.id)).toEqual([]);
      // Nothing is re-gated until the holder pushes again.
      expect(integrator.wants(state)).toBe(false);
      const gatedBefore = of(log, "integrated.rev").length;
      integrator.kick();
      await integrator.idle();
      expect(of(await env.log(), "integrated.rev")).toHaveLength(gatedBefore);

      // The holder's next push (the stray file removed) is gated and lands.
      await env.unstray("a1", "src/q/stray.ts");
      const fixed = await env.push("a1", "x", "src/x/a.ts", "export const a = 2;\n");
      state = (await env.operator.page(0, 1)).state;
      expect(state.items.x!.lastPush!.excluded).toBeUndefined();
      expect(itemWaitReason(state, "x")).toMatchObject({ kind: "waiting-for-gate", commit: fixed });
      integrator.kick();
      await integrator.idle();
      const last = of(await env.log(), "integrated.rev").at(-1)!;
      expect([last.payload.gate, [...last.payload.merged]]).toEqual(["pass", [fixed]]);
      expect(of(await env.log(), "push.excluded")).toHaveLength(1);
    });
  }

  it("speculation with the cloud integrator is refused at startup, before anything is provisioned", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    await expect(
      runBoard({
        goal: "g",
        projectDir: tmpdir(),
        changeId: "change-cloud-speculate",
        workerUrl: "http://worker.invalid",
        fetchFn,
        dial: { minConcurrency: 1, maxConcurrency: 1 },
        transport: async () => ({ action: { type: "wait", reason: "test" } }),
        seed: async () => ({ source: "planner", items: [] }),
        integrator: "cloud",
        speculate: 2,
      }),
    ).rejects.toThrow(/needs the local integrator: the cloud integration Workflow gates one revision at a time/);
    expect(calls).toBe(0);
  });

  it("the board refuses a landed candidate that is not the latest passing revision", async () => {
    const env = await setup();
    await env.warm();
    await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    const refused = await env.operator.recordEngine("candidate.gated", {
      round: 1,
      index: 1,
      of: 1,
      prefix: [{ agent: "a1", items: ["x"], commit: "a".repeat(40) }],
      commit: "b".repeat(40),
      verdict: "pass",
      outcome: "landed",
      rev: 1,
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.code).toBe("LOG_MISMATCH");
  });

  it("a candidate that swaps the gate's runner (a nested lockfile shadow) is refused as a protected violation and never lands", async () => {
    const packages = {
      "": { name: "p", devDependencies: { vitest: "2.1.8" } },
      "node_modules/vitest": { version: "2.1.8", resolved: "https://registry.npmjs.org/vitest/-/vitest-2.1.8.tgz", integrity: "sha512-v", dev: true, dependencies: { vite: "^5.0.0" }, bin: { vitest: "vitest.mjs" } },
      "node_modules/vite": { version: "5.4.0", resolved: "https://registry.npmjs.org/vite/-/vite-5.4.0.tgz", integrity: "sha512-vite", dev: true },
    };
    const lock = (p: Record<string, unknown>) => JSON.stringify({ name: "p", lockfileVersion: 3, requires: true, packages: p }, null, 2) + "\n";
    const env = await setup({
      files: { "package.json": JSON.stringify({ name: "p", scripts: { gate: "vitest run" }, devDependencies: { vitest: "2.1.8" } }) + "\n", "package-lock.json": lock(packages) },
      extraWrite: { x: ["package-lock.json"] },
    });
    const contract = runnerResolutionContract(await readDependencySnapshotFromDir(env.projectDir), ["vitest"]);
    expect(contract.jsonKeys.length).toBeGreaterThan(0);
    await env.warm();
    const p1 = await env.push(
      "a1",
      "x",
      "package-lock.json",
      lock({ ...packages, "node_modules/vitest/node_modules/vite": { version: "0.0.1", resolved: "https://example.invalid/vite.tgz", integrity: "sha512-x" } }),
    );
    const p2 = await env.push("a2", "y", "src/y/b.ts", "export const b = 1;\n");
    const gate = new MarkerGate();
    const integrator = env.integrator({ verifyCommandRunner: gate, candidateConcurrency: 2, contract: { restore: [], jsonKeys: contract.jsonKeys } });
    integrator.kick();
    await integrator.idle();

    // The gate itself passes every tree: only the runner-resolution check refuses C1 and C2.
    expect(integrator.rounds[0]!.map((c) => [c.index, c.gate, c.outcome])).toEqual([
      [1, "fail", "blamed"],
      [2, "fail", "retest"],
    ]);
    const revs = await env.revisions();
    expect(revs.map((r) => [r.payload.gate, [...r.payload.merged]])).toEqual([
      ["fail", [p1]],
      ["pass", [p2]],
    ]);
    const landed = revs[1]!.payload.commit;
    expect(await env.branchHead()).toBe(landed);
    expect(await env.fileAt(landed, "package-lock.json")).toBe(lock(packages));
    expect(integrator.revisions[0]!.failure).toMatch(/protected path\(s\).*node_modules\/vitest\/node_modules\/vite/);
  });
});

describe("speculative rounds record their progress on the board (integration.started, integration.phase)", () => {
  const roundsOf = (log: readonly BoardMessage[]) =>
    log.flatMap((m) => (m.type === "integration.started" ? [{ start: m, phases: log.filter((p) => p.type === "integration.phase" && p.payload.started === m.seq) }] : []));

  it("one candidate at a time: the round names its pushes, then each candidate as it starts, then closes with its revisions", async () => {
    const env = await setup({ rules: { arbitration: 7 } });
    await env.warm();
    await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    await env.push("a2", "y", "src/y/b.ts", "export const b = 'BAD';\n");
    await env.push("a3", "z", "src/z/c.ts", "export const c = 1;\n");
    const before = (await env.log()).length;
    const integrator = env.integrator({ verifyCommandRunner: new MarkerGate(), candidateConcurrency: 1 });
    integrator.kick();
    await integrator.idle();
    const log = await env.log();
    const fresh = log.slice(before);
    const rounds = roundsOf(fresh);
    expect(rounds.length).toBeGreaterThan(0);
    const [first] = rounds;
    expect(first!.start).toMatchObject({ from: "engine", type: "integration.started", payload: { kind: "speculative", agents: ["a1", "a2", "a3"], items: ["x", "y", "z"], candidates: 3 } });
    expect(first!.start.to).toBeUndefined();
    const pushSeqs = fresh.length > 0 ? log.filter((m) => m.type === "push.announced").slice(-3).map((m) => m.seq) : [];
    expect(first!.start.type === "integration.started" && first!.start.payload.pushes).toEqual(pushSeqs);
    // C2 failed after C1 passed, so C3 is never built: two candidate phases, in order, then the revisions.
    const details = first!.phases.map((p) => (p.type === "integration.phase" ? [p.payload.phase, p.payload.detail] : []));
    expect(details).toEqual([
      ["candidate", "candidate 1 of 3: the head plus a1"],
      ["candidate", "candidate 2 of 3: the head plus a1, a2"],
    ]);
    const firstRev = fresh.find((m) => m.type === "integrated.rev")!;
    expect(first!.phases.every((p) => p.seq < firstRev.seq)).toBe(true);
    for (const r of rounds) expect(r.phases.length).toBeLessThanOrEqual(12);
    // Every round closed: nothing is shown in progress once the integrator is idle.
    expect(openIntegrationRound(log)).toBeNull();
    // While the first round was open, the console's round was it, at its latest phase.
    const open = openIntegrationRound(log, firstRev.seq - 1);
    expect(open).toMatchObject({ seq: first!.start.seq, kind: "speculative", items: ["x", "y", "z"], line: "candidate 2 of 3: the head plus a1, a2" });
    for (let k = before; k <= log.length; k += 1) assertBoardBacked(buildBoardGraph(log, k), log);
  });

  it("all candidates at once: one candidate phase names them together", async () => {
    const env = await setup({ rules: { arbitration: 7 } });
    await env.warm();
    await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    await env.push("a2", "y", "src/y/b.ts", "export const b = 1;\n");
    const before = (await env.log()).length;
    const integrator = env.integrator({ verifyCommandRunner: new MarkerGate(), candidateConcurrency: 3 });
    integrator.kick();
    await integrator.idle();
    const [round] = roundsOf((await env.log()).slice(before));
    expect(round!.phases.map((p) => (p.type === "integration.phase" ? p.payload.detail : ""))).toEqual([
      "2 prefix candidates at once on the passing head (the head plus the first 1 to 2 pushes: a1, a2)",
    ]);
  });

  it("a board under arbitration revision 1 records no progress (its clocks count engine records)", async () => {
    const env = await setup();
    await env.warm();
    await env.push("a1", "x", "src/x/a.ts", "export const a = 1;\n");
    const integrator = env.integrator({ verifyCommandRunner: new MarkerGate(), candidateConcurrency: 1 });
    integrator.kick();
    await integrator.idle();
    expect((await env.log()).filter((m) => m.type === "integration.started" || m.type === "integration.phase")).toEqual([]);
  });
});

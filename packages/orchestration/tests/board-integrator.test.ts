/**
 * The continuous board integrator over real local Git and the offline local
 * control (no network): revisions are serialized and pushes that land while one
 * runs are coalesced into the next; every unit is pinned to its announced
 * commit; a handed-off item's files are yielded by the old owner (never
 * poisoning its other work); an integration that gates nothing recordable posts
 * no revision; reasons that leave the integrator carry no credential; and
 * failure attribution narrows by parse, then by a confident typed decision.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { BoardMessage } from "@switchyard-change/change-core";
import type { AskJev } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { BoardAgentClient, BoardOperatorClient } from "../src/board-client.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { attributeRevisionFailure, ContinuousBoardIntegrator, type BoardAgentRepo } from "../src/run-board.ts";
import { createIntegrationWorkspace } from "../src/run-live.ts";

const git = promisify(execFile);
const ID = "change-integrator";
const BASE = "http://local-control";
const IDENTITY = { name: "Test Integrator", email: "integrator@test.local" };

interface Agent {
  readonly id: string;
  readonly client: BoardAgentClient;
  readonly repo: BoardAgentRepo;
  readonly dir: string;
}

async function setup(options: { readonly agents?: readonly string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scf-integrator-"));
  const projectDir = join(root, "project");
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p"}\n',
    "src/x/a.ts": "export const a = 0;\n",
    "src/y/b.ts": "export const b = 0;\n",
    "src/z/c.ts": "export const c = 0;\n",
  })) {
    await mkdir(dirname(join(projectDir, rel)), { recursive: true });
    await writeFile(join(projectDir, rel), body);
  }
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
  const fetchFn = control.fetch as unknown as typeof fetch;
  const operator = new BoardOperatorClient(fetchFn, BASE, ID);
  expect((await fetchFn(`${BASE}/changes/planning`, { method: "POST", body: JSON.stringify({ id: ID, objective: "o" }) })).status).toBe(201);
  const human = async (draft: unknown) => expect((await operator.postAsHuman(draft)).ok).toBe(true);
  await human({ type: "goal.posted", payload: { objective: "o", protected: ["package.json"] } });
  for (const item of ["x", "y", "z"]) {
    await human({ type: "item.proposed", payload: { item, objective: `do ${item}`, scopeHint: [`src/${item}/**`] } });
  }
  const agents = new Map<string, Agent>();
  for (const id of options.agents ?? ["a1", "a2", "a3"]) {
    const joined = await operator.join(id, { workspaceTtlSeconds: 600 });
    if (!joined.ok || !joined.workspace) {
      throw new Error(`join failed for ${id}`);
    }
    const dir = join(root, "agents", id);
    await git("git", ["clone", "-q", joined.workspace.gitUrl, dir]);
    agents.set(id, {
      id,
      client: new BoardAgentClient(fetchFn, BASE, ID, id, joined.token),
      repo: { gitUrl: joined.workspace.gitUrl, defaultBranch: joined.workspace.defaultBranch },
      dir,
    });
  }
  const integration = await createIntegrationWorkspace(join(root, "work"), projectDir, ID, IDENTITY);
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
  /** Commit files in the agent's repo and push; returns the commit. */
  const commit = async (id: string, files: Record<string, string>, pushIt = true): Promise<string> => {
    const { dir, repo } = agent(id);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    await git("git", ["-C", dir, "add", "-A"]);
    await git("git", ["-C", dir, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "-q", "-m", "work"]);
    if (pushIt) {
      await git("git", ["-C", dir, "push", "-q", repo.gitUrl, `HEAD:refs/heads/${repo.defaultBranch}`]);
    }
    return (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  };
  const announce = async (id: string, item: string, sha: string, paths: string[]) =>
    post(id, { type: "push.announced", payload: { item, commit: sha, paths } });
  const integrator = (extra: Partial<ConstructorParameters<typeof ContinuousBoardIntegrator>[0]> = {}) =>
    new ContinuousBoardIntegrator({
      operator,
      change: { id: ID, objective: "o" },
      agentRepos: new Map([...agents.values()].map((a) => [a.id, a.repo])),
      readRemote: async (id) => agent(id).repo.gitUrl,
      integration,
      worktreeRoot,
      identity: IDENTITY,
      contract: { restore: [], jsonKeys: [] },
      ...extra,
    });
  /** A file's content in the integration workspace at `commit`. */
  const fileAt = async (commitSha: string, rel: string): Promise<string | undefined> => {
    const dir = await mkdtemp(join(root, "check-"));
    await git("git", ["clone", "-q", integration.integrationRef.gitUrl, dir]);
    try {
      return (await git("git", ["-C", dir, "show", `${commitSha}:${rel}`])).stdout;
    } catch {
      return undefined;
    }
  };
  const log = async (): Promise<readonly BoardMessage[]> => (await operator.log()).messages;
  /** The integration branch head. */
  const branchHead = async (): Promise<string> => {
    const dir = await mkdtemp(join(root, "head-"));
    await git("git", ["clone", "-q", integration.integrationRef.gitUrl, dir]);
    return (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  };
  return { root, control, operator, agent, post, commit, announce, integrator, fileAt, log, branchHead };
}

/** A gate that blocks each run until released, recording how many ran at once. */
class HeldGate implements CommandRunner {
  active = 0;
  maxActive = 0;
  readonly waiting: (() => void)[] = [];
  async run(): Promise<CommandOutcome> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active -= 1;
    return { code: 0, stdout: "ok", stderr: "" };
  }
  async release(): Promise<void> {
    await until(() => this.waiting.length > 0);
    this.waiting.shift()!();
  }
}

async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ContinuousBoardIntegrator", () => {
  it("serializes revisions and coalesces pushes that land while one runs into the next", async () => {
    const env = await setup();
    for (const [id, item] of [["a1", "x"], ["a2", "y"], ["a3", "z"]] as const) {
      await env.post(id, { type: "item.claimed", payload: { item, intent: { read: [], write: [`src/${item}/**`] } } });
    }
    const gate = new HeldGate();
    const integrator = env.integrator({ appGateCommand: ["gate"], verifyCommandRunner: gate });

    const p1 = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", p1, ["src/x/a.ts"]);
    integrator.kick();
    await until(() => gate.waiting.length === 1); // revision 1 is gating p1

    const p2 = await env.commit("a2", { "src/y/b.ts": "export const b = 1;\n" });
    await env.announce("a2", "y", p2, ["src/y/b.ts"]);
    integrator.kick();
    const p3 = await env.commit("a3", { "src/z/c.ts": "export const c = 1;\n" });
    await env.announce("a3", "z", p3, ["src/z/c.ts"]);
    integrator.kick();

    await gate.release(); // revision 1 finishes; the coalesced revision 2 starts
    await gate.release();
    await integrator.idle();

    expect(gate.maxActive).toBe(1);
    expect(integrator.revisions.map((r) => [...r.merged].sort())).toEqual([[p1], [p2, p3].sort()]);
    expect(integrator.revisions.every((r) => r.gate === "pass")).toBe(true);
    const revs = (await env.log()).filter((m) => m.type === "integrated.rev");
    expect(revs).toHaveLength(2);
    // Revision 2 is built on revision 1: it carries all three changes.
    expect(await env.fileAt(integrator.revisions[1]!.commit, "src/x/a.ts")).toBe("export const a = 1;\n");
    expect(await env.fileAt(integrator.revisions[1]!.commit, "src/z/c.ts")).toBe("export const c = 1;\n");
  });

  it("pins each unit to its announced commit: an unannounced later push never reaches the revision", async () => {
    const env = await setup({ agents: ["a1"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    const announced = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", announced, ["src/x/a.ts"]);
    await env.commit("a1", { "src/x/a.ts": "export const a = 666;\n", "src/x/sneaky.ts": "x\n" });
    const integrator = env.integrator();
    integrator.kick();
    await integrator.idle();
    const [revision] = integrator.revisions;
    expect(revision).toMatchObject({ gate: "pass", merged: [announced] });
    expect(await env.fileAt(revision!.commit, "src/x/a.ts")).toBe("export const a = 1;\n");
    expect(await env.fileAt(revision!.commit, "src/x/sneaky.ts")).toBeUndefined();
  });

  it("a handed-off item's files are yielded by the old owner, whose other item still integrates", async () => {
    const env = await setup({ agents: ["a1", "a2"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    await env.post("a1", { type: "item.claimed", payload: { item: "y", intent: { read: [], write: ["src/y/**"] } } });
    const cx = await env.commit("a1", { "src/x/a.ts": "export const a = 'stale';\n" });
    await env.announce("a1", "x", cx, ["src/x/a.ts"]);
    const cy = await env.commit("a1", { "src/y/b.ts": "export const b = 1;\n" });
    await env.announce("a1", "y", cy, ["src/y/b.ts"]);
    await env.post("a1", { type: "handoff", payload: { item: "x", to: "a2", capsule: { repo: "a1", commit: cx } } });

    const integrator = env.integrator();
    integrator.kick();
    await integrator.idle();
    expect(integrator.revisions[0]).toMatchObject({ gate: "pass", merged: [cy], integratedItems: ["y"], excludedAgents: [] });
    expect(await env.fileAt(integrator.revisions[0]!.commit, "src/x/a.ts")).toBe("export const a = 0;\n");

    // The new owner's push of the item integrates next.
    const cx2 = await env.commit("a2", { "src/x/a.ts": "export const a = 2;\n" });
    await env.announce("a2", "x", cx2, ["src/x/a.ts"]);
    integrator.kick();
    await integrator.idle();
    expect(integrator.revisions[1]).toMatchObject({ gate: "pass", merged: [cx2] });
    expect(await env.fileAt(integrator.revisions[1]!.commit, "src/x/a.ts")).toBe("export const a = 2;\n");
  });

  it("posts NO revision when the integrator refuses (nothing gated is recordable), and does not retry the same set", async () => {
    const env = await setup({ agents: ["a1"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    // A "fix" identical to the baseline: applying it changes nothing.
    const same = await env.commit("a1", { "src/x/a.ts": "export const a = 0;\n" });
    await env.announce("a1", "x", same, ["src/x/a.ts"]);
    const integrator = env.integrator({ appGateCommand: ["gate"], requireAppGate: true, verifyCommandRunner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } });
    integrator.kick();
    await integrator.idle();
    integrator.kick();
    await integrator.idle();
    expect(integrator.revisions).toEqual([]);
    expect(integrator.failures).toHaveLength(1);
    expect(integrator.failures[0]).toMatch(/integrator refused: integration refused/);
    expect((await env.log()).some((m) => m.type === "integrated.rev")).toBe(false);
  });

  it("strips credentials from every reason that leaves the integrator", async () => {
    const env = await setup({ agents: ["a1", "a2"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    await env.post("a2", { type: "item.claimed", payload: { item: "y", intent: { read: [], write: ["src/y/**"] } } });
    const c1 = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", c1, ["src/x/a.ts"]);
    const c2 = await env.commit("a2", { "src/y/b.ts": "export const b = 1;\n" });
    await env.announce("a2", "y", c2, ["src/y/b.ts"]);
    const secret = "art_v1_TOPSECRETvalue";
    const integrator = env.integrator({
      readRemote: async (id) => {
        if (id === "a1") {
          throw new Error(`fatal: could not read https://token:${secret}@artifacts.example/repo (token ${secret})`);
        }
        return env.agent(id).repo.gitUrl;
      },
    });
    integrator.kick();
    await integrator.idle();
    const [revision] = integrator.revisions;
    expect(revision!.merged).toEqual([c2]);
    const reason = revision!.excludedAgents.find((e) => e.agent === "a1")!.reason;
    expect(reason).not.toContain(secret);
    expect(reason).toMatch(/https:\/\/\*\*\*@artifacts\.example/);
  });

  it("a failing revision carries bounded, credential-free evidence and implicates by parse", async () => {
    const env = await setup({ agents: ["a1", "a2"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    await env.post("a2", { type: "item.claimed", payload: { item: "y", intent: { read: [], write: ["src/y/**"] } } });
    const c1 = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", c1, ["src/x/a.ts"]);
    const c2 = await env.commit("a2", { "src/y/b.ts": "export const b = 1;\n" });
    await env.announce("a2", "y", c2, ["src/y/b.ts"]);
    const noisy = `not ok 1 - src/y/b.ts broke\nhttps://token:abc123secret@host/x\n${"x".repeat(20_000)}`;
    const integrator = env.integrator({
      appGateCommand: ["gate"],
      verifyCommandRunner: { run: async () => ({ code: 1, stdout: noisy, stderr: "" }) },
    });
    integrator.kick();
    await integrator.idle();
    const rev = (await env.log()).find((m) => m.type === "integrated.rev")!;
    expect(rev.type === "integrated.rev" && rev.payload.gate).toBe("fail");
    if (rev.type !== "integrated.rev") {
      return;
    }
    expect(rev.payload.failing!.items).toEqual(["y"]);
    expect(rev.payload.failing!.output.length).toBeLessThanOrEqual(8192);
    expect(rev.payload.failing!.output).not.toContain("abc123secret");
    const fix = (await env.log()).filter((m) => m.type === "fix.requested");
    expect(fix.map((m) => m.to)).toEqual([["a2"]]);
  });
});

describe("ContinuousBoardIntegrator: recorded base, transient retries, bounded staleness", () => {
  it("a pass discarded as stale never advances the branch; the next revision builds on the last RECORDED pass", async () => {
    const env = await setup({ agents: ["a1"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    const baseline = await env.branchHead();
    const gate = new HeldGate();
    const integrator = env.integrator({ appGateCommand: ["gate"], verifyCommandRunner: gate, maxStaleRuns: 5 });
    const p1 = await env.commit("a1", { "src/x/a.ts": "export const a = 'first';\n", "src/x/only-in-first.ts": "x\n" });
    await env.announce("a1", "x", p1, ["src/x/a.ts", "src/x/only-in-first.ts"]);
    integrator.kick();
    await until(() => gate.waiting.length === 1);
    // A newer push supersedes p1 while its (passing) gate runs.
    await git("git", ["-C", env.agent("a1").dir, "rm", "-q", "src/x/only-in-first.ts"]);
    const p2 = await env.commit("a1", { "src/x/a.ts": "export const a = 'second';\n" });
    await env.announce("a1", "x", p2, ["src/x/a.ts", "src/x/only-in-first.ts"]);
    await gate.release(); // p1's pass is discarded (stale)
    await until(() => gate.waiting.length === 1);
    expect(await env.branchHead()).toBe(baseline); // nothing unrecorded reached the branch
    await gate.release();
    await integrator.idle();
    expect(integrator.revisions.map((r) => r.merged)).toEqual([[p2]]);
    const commit = integrator.revisions[0]!.commit;
    expect(await env.branchHead()).toBe(commit); // advanced only after recording
    expect(await env.fileAt(commit, "src/x/only-in-first.ts")).toBeUndefined();
    expect(await env.fileAt(commit, "src/x/a.ts")).toBe("export const a = 'second';\n");
  });

  it("after a bounded number of stale re-runs it holds the superseded agent back and integrates the rest without it", async () => {
    const env = await setup({ agents: ["a1", "a2"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    await env.post("a2", { type: "item.claimed", payload: { item: "y", intent: { read: [], write: ["src/y/**"] } } });
    const gate = new HeldGate();
    const integrator = env.integrator({ appGateCommand: ["gate"], verifyCommandRunner: gate, maxStaleRuns: 1 });
    const y = await env.commit("a2", { "src/y/b.ts": "export const b = 1;\n" });
    await env.announce("a2", "y", y, ["src/y/b.ts"]);
    let x = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", x, ["src/x/a.ts"]);
    integrator.kick();
    for (let round = 2; round <= 3; round += 1) {
      await until(() => gate.waiting.length === 1);
      x = await env.commit("a1", { "src/x/a.ts": `export const a = ${round};\n` });
      await env.announce("a1", "x", x, ["src/x/a.ts"]);
      await gate.release();
    }
    await until(() => integrator.revisions.length === 1);
    expect(integrator.revisions[0]!.merged).toEqual([y]);
    expect(integrator.revisions[0]!.excludedAgents.find((e) => e.agent === "a1")!.reason).toMatch(/superseded while the gate ran/);
    integrator.kick(); // the driver observes the still-pending newer push
    await gate.release();
    await integrator.idle();
    expect(integrator.revisions[1]!.merged).toEqual([x]);
  });

  it("retries a transient read failure with backoff, and only then gives up on that push set", async () => {
    const env = await setup({ agents: ["a1"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    const c = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", c, ["src/x/a.ts"]);
    let calls = 0;
    const flaky = env.integrator({
      retryBackoffMs: 1,
      readRemote: async (id) => {
        calls += 1;
        if (calls <= 2) {
          throw new Error("503 service unavailable");
        }
        return env.agent(id).repo.gitUrl;
      },
    });
    flaky.kick();
    await flaky.idle();
    expect(calls).toBe(3);
    expect(flaky.revisions.map((r) => r.merged)).toEqual([[c]]);
    expect(flaky.failures).toEqual([]);

    const env2 = await setup({ agents: ["a1"] });
    await env2.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    const c2 = await env2.commit("a1", { "src/x/a.ts": "export const a = 2;\n" });
    await env2.announce("a1", "x", c2, ["src/x/a.ts"]);
    let tries = 0;
    const down = env2.integrator({ retryBackoffMs: 1, maxRetries: 2, readRemote: async () => {
      tries += 1;
      throw new Error("network down");
    } });
    down.kick();
    await down.idle();
    expect(tries).toBe(3); // the first attempt plus 2 retries
    expect(down.failures).toHaveLength(1);
    expect(down.wants((await env2.operator.page(0, 1)).state)).toBe(false);
  });

  it("names completed items a revision's pushes regressed in the failing evidence", async () => {
    const env = await setup({ agents: ["a1", "a2"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    const cx = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", cx, ["src/x/a.ts"]);
    let fail = false;
    const integrator = env.integrator({
      appGateCommand: ["gate"],
      verifyCommandRunner: { run: async () => (fail ? { code: 1, stdout: "not ok 1 - src/x/a.ts broke\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }) },
    });
    integrator.kick();
    await integrator.idle();
    await env.post("a1", { type: "done.proposed", payload: { item: "x" } });
    expect((await env.operator.page(0, 1)).state.items.x!.status).toBe("done");
    await env.post("a2", { type: "item.claimed", payload: { item: "y", intent: { read: [], write: ["src/y/**"] } } });
    const cy = await env.commit("a2", { "src/y/b.ts": "export const b = 1;\n" });
    await env.announce("a2", "y", cy, ["src/y/b.ts"]);
    fail = true;
    integrator.kick();
    await integrator.idle();
    const rev = (await env.log()).filter((m) => m.type === "integrated.rev").at(-1)!;
    if (rev.type !== "integrated.rev") {
      throw new Error("no revision");
    }
    expect(rev.payload.failing!.output).toMatch(/^regressed completed item\(s\): x/);
    expect(rev.payload.failing!.items).toEqual(["y"]); // the pushes that broke it own the fix
  });
});

describe("a failing revision's reason", () => {
  it("leads with the gate's own failing line; the inventory shortfall is secondary when the gate exited non-zero", async () => {
    const { readFileSync } = await import("node:fs");
    const stdout = readFileSync(new URL("./fixtures/gate-syntax-error.stdout.txt", import.meta.url), "utf8");
    const stderr = readFileSync(new URL("./fixtures/gate-syntax-error.stderr.txt", import.meta.url), "utf8");
    const env = await setup({ agents: ["a1"] });
    await env.post("a1", { type: "item.claimed", payload: { item: "x", intent: { read: [], write: ["src/x/**"] } } });
    const c = await env.commit("a1", { "src/x/a.ts": "export const a = 1;\n" });
    await env.announce("a1", "x", c, ["src/x/a.ts"]);
    const integrator = env.integrator({
      appGateCommand: ["gate"],
      verifyCommandRunner: { run: async () => ({ code: 1, stdout, stderr }) },
      testInventory: { format: "node-spec", count: 20, names: ["users: a valid request still succeeds"] },
    });
    integrator.kick();
    await integrator.idle();
    const [revision] = integrator.revisions;
    expect(revision!.failure).toMatch(/^SyntaxError: Identifier 'authResponse' has already been declared integration app-gate failed over the promoted tree \(exit 1\); also, test inventory:/);
    const rev = (await env.log()).find((m) => m.type === "integrated.rev")!;
    if (rev.type !== "integrated.rev") {
      throw new Error("no revision");
    }
    expect(rev.payload.failing!.output.split("\n")[0]).toBe("SyntaxError: Identifier 'authResponse' has already been declared");
    expect(rev.payload.failing!.output).not.toContain("users: a valid request still succeeds");
  });
});

describe("attributeRevisionFailure", () => {
  const items = [
    { id: "a", objective: "do a", paths: ["src/a/**"] },
    { id: "b", objective: "do b", paths: ["src/b/**"] },
  ];
  const jev = (choice: string, confidence: number): AskJev => async () => ({ attribution: { type: "choice", choice, confidence } });

  it("narrows by the failing output's files, else falls back to every item", async () => {
    expect(await attributeRevisionFailure({ items, output: "FAIL src/b/x.ts", changeId: "c" })).toEqual({ items: ["b"], source: "parse" });
    expect(await attributeRevisionFailure({ items, output: "boom", changeId: "c" })).toEqual({ items: ["a", "b"], source: "all" });
  });

  it("a confident typed decision narrows an unattributable failure; a low-confidence one changes nothing", async () => {
    expect(await attributeRevisionFailure({ items, output: "boom", changeId: "c", jev: jev("b", 0.9) })).toEqual({ items: ["b"], source: "jev" });
    expect(await attributeRevisionFailure({ items, output: "boom", changeId: "c", jev: jev("b", 0.2) })).toEqual({ items: ["a", "b"], source: "all" });
    expect(await attributeRevisionFailure({ items, output: "FAIL src/a/x.ts", changeId: "c", jev: jev("b", 0.9) })).toEqual({
      items: ["a", "b"],
      source: "jev",
    });
  });
});

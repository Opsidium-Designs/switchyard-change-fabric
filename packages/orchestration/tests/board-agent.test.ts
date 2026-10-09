/**
 * The board agent runtime on the offline local control (no network): event
 * scheduling (a turn only when something relevant arrived), rejection feedback
 * into the next turn, budgets recorded on the board, the lead's planner seed
 * and contract arbitration, the edit path inside the write intent, and the
 * rebase onto an integrated revision before the next edit. Turns come from a
 * scripted transport so every decision is fixed.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { BoardDigest, BoardMessage } from "@switchyard-change/change-core";
import type {
  AgentAction,
  AgentTurnInput,
  AgentTurnOutcome,
  AgentTurnTransport,
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";

import { BoardAgent, RunTurnBudget, type AgentTurnRecord, type BoardAgentOptions } from "../src/board-agent.ts";
import { BoardOperatorClient, type BoardPage } from "../src/board-client.ts";
import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";

const run = promisify(execFile);
const ID = "change-runtime";
const BASE = "http://local-control";

type Input = AgentTurnInput<BoardDigest, BoardMessage>;

/** A transport that plays scripted actions in order (then waits) and records every input. */
function scripted(actions: readonly (AgentAction | AgentTurnOutcome)[]): AgentTurnTransport<BoardDigest, BoardMessage> & {
  readonly inputs: Input[];
} {
  const queue = [...actions];
  const inputs: Input[] = [];
  const transport = (async (input: Input): Promise<AgentTurnOutcome> => {
    inputs.push(input);
    const next = queue.shift();
    if (next === undefined) {
      return { action: { type: "wait", reason: "script done" } };
    }
    return "action" in next ? next : { action: next };
  }) as AgentTurnTransport<BoardDigest, BoardMessage> & { inputs: Input[] };
  transport.inputs = inputs;
  return transport;
}

/** An executor that writes fixed files and records what it was given. */
class RecordingExecutor implements ExecutorProvider {
  readonly name = "recording";
  readonly contexts: ExecutorContext[] = [];
  readonly seen: Record<string, string | undefined>[] = [];
  constructor(private readonly writes: (ctx: ExecutorContext) => Record<string, string>) {}
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    this.contexts.push(context);
    const seen: Record<string, string | undefined> = {};
    for (const p of context.paths) {
      seen[p] = await readFile(join(context.baselineDir ?? context.worktreeDir, p), "utf8").catch(() => undefined);
    }
    this.seen.push(seen);
    const files = this.writes(context);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(context.worktreeDir, rel)), { recursive: true });
      await writeFile(join(context.worktreeDir, rel), body);
    }
    return { status: "changed", changedPaths: Object.keys(files), logs: [], cost: { usd: 0 }, commitMessage: "edit" };
  }
}

interface Env {
  readonly control: LocalChangeControl;
  readonly operator: BoardOperatorClient;
  readonly root: string;
  readonly projectDir: string;
  readonly turns: AgentTurnRecord[];
  agent(id: string, overrides: Partial<BoardAgentOptions> & Pick<BoardAgentOptions, "transport">): BoardAgent;
  log(): Promise<BoardPage>;
  human(draft: unknown): Promise<void>;
  rawPost(token: string, draft: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

async function setup(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "scf-board-agent-"));
  const projectDir = join(root, "project");
  for (const [rel, body] of Object.entries({
    "src/a/x.ts": "export const x = 1;\n",
    "src/b/y.ts": "export const y = 2;\n",
    "src/shared.ts": "export const shared = 0;\n",
  })) {
    await mkdir(dirname(join(projectDir, rel)), { recursive: true });
    await writeFile(join(projectDir, rel), body);
  }
  let tick = 0;
  const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }), {
    now: () => new Date(Date.UTC(2026, 0, 1) + 1000 * tick++),
  });
  const fetchFn = control.fetch as unknown as typeof fetch;
  const operator = new BoardOperatorClient(fetchFn, BASE, ID);
  const created = await fetchFn(`${BASE}/changes/planning`, {
    method: "POST",
    body: JSON.stringify({ id: ID, objective: "runtime", baseline: "HEAD" }),
  });
  expect(created.status).toBe(201);
  const turns: AgentTurnRecord[] = [];
  const human = async (draft: unknown) => {
    const outcome = await operator.postAsHuman(draft);
    expect(outcome.ok).toBe(true);
  };
  await human({ type: "goal.posted", payload: { objective: "runtime" } });
  await human({ type: "item.proposed", payload: { item: "i1", objective: "do a", scopeHint: ["src/a/**"] } });
  await human({ type: "item.proposed", payload: { item: "i2", objective: "do b", scopeHint: ["src/b/**"] } });
  return {
    control,
    operator,
    root,
    projectDir,
    turns,
    agent(id, overrides) {
      return new BoardAgent({
        id,
        role: "worker",
        goal: "runtime",
        changeId: ID,
        baseUrl: BASE,
        fetchFn,
        join: operator.join.bind(operator),
        projectDir,
        workRoot: join(root, "work"),
        workspaceTtlSeconds: 600,
        maxTurnsPerItem: 8,
        runBudget: new RunTurnBudget(100),
        onTurn: (r) => turns.push(r),
        ...overrides,
      });
    },
    log: () => operator.log(),
    human,
    async rawPost(token, draft) {
      const res = await fetchFn(`${BASE}/changes/${ID}/board`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-board-agent-token": token },
        body: JSON.stringify(draft),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
}

describe("BoardAgent scheduling", () => {
  it("takes a turn only when something relevant arrived, and idles otherwise", async () => {
    const env = await setup();
    const transport = scripted([
      { type: "wait", reason: "looking" },
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "wait", reason: "holding i1" },
      { type: "wait", reason: "answered" },
    ]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    expect(w1.joinedWorkspace).toMatchObject({ workspaceName: `${ID}--board-w1`, backend: "local-filesystem" });

    expect(await w1.step()).toBe("acted"); // first look after joining
    expect(await w1.step()).toBe("idle"); // nothing new, same open items
    await env.human({ type: "item.proposed", payload: { item: "i3", objective: "do c", scopeHint: ["docs/**"] } });
    expect(await w1.step()).toBe("acted"); // new open work while free -> claims i1
    expect(await w1.step()).toBe("acted"); // its accepted claim keeps the initiative -> waits
    expect(await w1.step()).toBe("idle");

    // A message addressed to it wakes it; a context-only broadcast does not.
    const w2 = await env.operator.join("w2", { role: "worker" });
    expect(w2.ok).toBe(true);
    const token = w2.ok ? w2.token : "";
    expect((await env.rawPost(token, { type: "item.claimed", payload: { item: "i2", intent: { write: ["src/b/**"] } } })).status).toBe(201);
    expect(await w1.step()).toBe("idle"); // another agent's grant is not w1's business
    expect(
      (
        await env.rawPost(token, {
          type: "contract.proposed",
          payload: { contract: "k1", target: "src/shared.ts", kind: "modify" },
        })
      ).status,
    ).toBe(201);
    expect(await w1.step()).toBe("idle"); // contracts are the lead's to arbitrate
    expect(
      (
        await env.rawPost(token, {
          type: "help.requested",
          payload: { request: "q1", item: "i2", need: "question" },
          to: ["w1"],
        })
      ).status,
    ).toBe(201);
    expect(await w1.step()).toBe("acted");
    const last = transport.inputs.at(-1)!;
    expect(last.messages.some((m) => m.type === "help.requested" && m.to?.includes("w1"))).toBe(true);
    expect(last.allowed).not.toContain("decide_contract");
  });

  it("feeds a board rejection back into the next turn", async () => {
    const env = await setup();
    const transport = scripted([
      { type: "claim", itemId: "missing", intent: { read: [], write: ["src/a/**"] } },
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
    ]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    expect(await w1.step()).toBe("acted");
    expect(env.turns.at(-1)).toMatchObject({ outcome: "rejected", code: "UNKNOWN_REF" });
    expect(await w1.step()).toBe("acted"); // the refusal itself earns a follow-up turn
    const input = transport.inputs[1]!;
    expect(input.lastRejection).toMatchObject({ code: "UNKNOWN_REF", action: "claim" });
    expect(input.lastRejection!.error).toMatch(/unknown item missing/);
    expect(input.capsule.decisions.at(-1)).toMatchObject({ outcome: "rejected", code: "UNKNOWN_REF" });
    expect(env.turns.at(-1)).toMatchObject({ outcome: "posted" });
  });

  it("records an invalid model output as a wait and posts nothing", async () => {
    const env = await setup();
    const transport = scripted([{ action: { type: "wait", reason: "invalid model output: bad" }, invalid: "invalid model output: bad" }]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    const before = (await env.log()).lastSeq;
    expect(await w1.step()).toBe("acted");
    expect(env.turns.at(-1)).toMatchObject({ outcome: "local", invalid: "invalid model output: bad" });
    expect((await env.log()).lastSeq).toBe(before);
  });

  it("refuses an action outside the role's allowed set locally", async () => {
    const env = await setup();
    const transport = scripted([{ type: "decide_contract", contractId: "k1", decision: "accept" }]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    await w1.step();
    expect(env.turns.at(-1)).toMatchObject({ outcome: "local", code: "NOT_ALLOWED" });
  });
});

describe("BoardAgent budgets", () => {
  it("records a spent per-item budget on the board and stops", async () => {
    const env = await setup();
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
    ]);
    const w1 = env.agent("w1", { transport, maxTurnsPerItem: 1 });
    await w1.join();
    await w1.step(); // claim (1 turn on i1)
    await w1.step(); // edit would be a 2nd turn on i1: over budget
    expect(w1.stopped).toMatchObject({ reason: "item-budget" });
    expect(await w1.step()).toBe("stopped");
    const help = (await env.log()).messages.find((m) => m.type === "help.requested");
    expect(help).toMatchObject({ from: "w1", payload: { item: "i1", need: "turn-budget" } });
    expect(help!.rationale).toMatch(/spent more than 1 turns on item i1/);
  });

  it("hands the item to another worker when one can take it", async () => {
    const env = await setup();
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "go" },
      ]),
      maxTurnsPerItem: 1,
    });
    const w2 = env.agent("w2", { transport: scripted([]) });
    await w1.join();
    await w2.join();
    await w1.step();
    await w1.step();
    const handoff = (await env.log()).messages.find((m) => m.type === "handoff");
    expect(handoff).toMatchObject({ from: "w1", payload: { item: "i1", to: "w2" } });
    expect((await env.log()).state.items.i1!.owner).toBe("w2");
  });

  it("an agent holding nothing leaves when the run budget is spent", async () => {
    const env = await setup();
    const w1 = env.agent("w1", { transport: scripted([{ type: "wait", reason: "first" }]), runBudget: new RunTurnBudget(1) });
    await w1.join();
    await w1.step();
    await env.human({ type: "item.proposed", payload: { item: "i9", objective: "more", scopeHint: ["x/**"] } });
    await w1.step();
    expect(w1.stopped).toMatchObject({ reason: "run-budget" });
    const left = (await env.log()).messages.at(-1)!;
    expect(left).toMatchObject({ from: "w1", type: "agent.left" });
    expect(left.rationale).toMatch(/turn budget \(1\) is spent/);
  });
});

describe("the lead", () => {
  it("seeds items from the planner on its first turn, then arbitrates contracts", async () => {
    const env = await setup();
    const policy = createGenericBoardPolicy();
    const calls: Input[] = [];
    const lead = env.agent("lead", {
      role: "lead",
      transport: async (input) => {
        calls.push(input);
        return policy(input);
      },
      seed: async () => [
        { item: "p1", objective: "planned one", acceptance: ["gate passes"], scopeHint: ["src/a/x.ts"] },
        { item: "p2", objective: "planned two", acceptance: [], scopeHint: ["src/b/**"] },
      ],
    });
    await lead.join();
    expect(lead.joinedWorkspace).toBeUndefined(); // the lead does not edit, so no repo
    expect(await lead.step()).toBe("acted");
    const proposed = (await env.log()).messages.filter((m) => m.type === "item.proposed" && m.from === "lead");
    expect(proposed.map((m) => m.payload)).toEqual([
      { item: "p1", objective: "planned one", acceptance: ["gate passes"], scopeHint: ["src/a/x.ts"] },
      { item: "p2", objective: "planned two", acceptance: [], scopeHint: ["src/b/**"] },
    ]);
    expect(calls).toHaveLength(0); // the seed is the planner, not a turn-model call
    expect(await lead.step()).toBe("idle");

    const w = await env.operator.join("w9", {});
    const token = w.ok ? w.token : "";
    await env.rawPost(token, { type: "contract.proposed", payload: { contract: "k1", target: "src/shared.ts", kind: "modify" } });
    expect(await lead.step()).toBe("acted");
    expect(calls[0]!.allowed).toEqual(["decide_contract", "decide_item", "propose_item", "message", "wait"]);
    expect(calls[0]!.board.pendingContracts).toEqual([{ contract: "k1", target: "src/shared.ts", kind: "modify", proposedBy: "w9" }]);
    expect((await env.log()).messages.find((m) => m.type === "contract.accepted")).toMatchObject({ from: "lead", payload: { contract: "k1" } });
  });

  it("propagates a planner failure (no silent substitute)", async () => {
    const env = await setup();
    const lead = env.agent("lead", {
      role: "lead",
      transport: scripted([]),
      seed: async () => {
        throw new Error("planner unavailable");
      },
    });
    await lead.join();
    await expect(lead.step()).rejects.toThrow(/planner unavailable/);
  });
});

describe("BoardAgent edits", () => {
  it("edits inside the write intent, commits, pushes to its own repo, and announces the push", async () => {
    const env = await setup();
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 2;\n" }));
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "bump x" },
        { type: "propose_done", itemId: "i1" },
      ]),
      executor,
    });
    await w1.join();
    await w1.step();
    await w1.step();
    expect(executor.contexts[0]!.paths).toEqual(["src/a/x.ts"]); // the glob resolved to concrete files
    expect(executor.contexts[0]!.objective).toMatch(/do a\nInstruction: bump x/);
    expect(executor.seen[0]).toEqual({ "src/a/x.ts": "export const x = 1;\n" });
    const pushed = (await env.log()).messages.find((m) => m.type === "push.announced")!;
    expect(pushed).toMatchObject({ from: "w1", payload: { item: "i1", paths: ["src/a/x.ts"] } });
    const commit = (pushed.payload as { commit: string }).commit;
    const { stdout } = await run("git", ["ls-remote", w1.joinedWorkspace!.gitUrl, "refs/heads/main"]);
    expect(stdout.split(/\s+/)[0]).toBe(commit);
    expect(await w1.step()).toBe("acted"); // its own edit finished -> follow-up turn
    expect((await env.log()).messages.find((m) => m.type === "done.proposed")).toMatchObject({ payload: { item: "i1", commit } });
  });

  it("discards an edit that strays outside the write intent and feeds the refusal back", async () => {
    const env = await setup();
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "ok\n", "src/b/y.ts": "stray\n" }));
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
    ]);
    const w1 = env.agent("w1", { transport, executor });
    await w1.join();
    await w1.step();
    await w1.step();
    expect(env.turns.at(-1)).toMatchObject({ outcome: "local", code: "OUTSIDE_INTENT" });
    expect(env.turns.at(-1)!.error).toMatch(/src\/b\/y.ts/);
    expect((await env.log()).messages.some((m) => m.type === "push.announced")).toBe(false);
    const { stdout } = await run("git", ["ls-remote", w1.joinedWorkspace!.gitUrl]);
    expect(stdout.trim()).toBe(""); // nothing was pushed
    await w1.step();
    expect(transport.inputs.at(-1)!.lastRejection).toMatchObject({ code: "OUTSIDE_INTENT", action: "edit" });
  });

  it("records an unreachable repo as a refusal instead of crashing the run", async () => {
    const env = await setup();
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
    ]);
    const w1 = env.agent("w1", { transport, executor: new RecordingExecutor(() => ({ "src/a/x.ts": "2\n" })) });
    await w1.join();
    await rm(fileURLToPath(w1.joinedWorkspace!.gitUrl), { recursive: true, force: true });
    await w1.step();
    expect(await w1.step()).toBe("acted");
    expect(env.turns.at(-1)).toMatchObject({ outcome: "local", code: "CLONE_FAILED" });
    expect(w1.stopped).toBeUndefined();
  });

  it("fetches the integrated revision before its next edit after a rebase.needed", async () => {
    const env = await setup();
    // A revision tree where another agent's change to the shared file landed.
    const revDir = join(env.root, "rev-1");
    await mkdir(join(revDir, "src/a"), { recursive: true });
    await writeFile(join(revDir, "src/a/x.ts"), "export const x = 1; // integrated\n");
    await writeFile(join(revDir, "src/shared.ts"), "export const shared = 1;\n");
    const fetched: [number, string][] = [];
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 3;\n" }));
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: ["src/shared.ts"], write: ["src/a/**"] } },
        { type: "wait", reason: "until the shared file settles" },
        { type: "edit", itemId: "i1", instruction: "use the new shared value" },
      ]),
      executor,
      fetchRevision: async (n, commit) => {
        fetched.push([n, commit]);
        return revDir;
      },
    });
    await w1.join();
    await w1.step();
    await w1.step();

    // w2 owns the shared file, pushes, and the integrator records a passing revision.
    const w2 = await env.operator.join("w2", {});
    const token = w2.ok ? w2.token : "";
    await env.human({ type: "item.proposed", payload: { item: "s", objective: "shared", scopeHint: ["src/shared.ts"] } });
    expect((await env.rawPost(token, { type: "item.claimed", payload: { item: "s", intent: { write: ["src/shared.ts"] } } })).status).toBe(201);
    expect((await env.rawPost(token, { type: "push.announced", payload: { item: "s", commit: "c0ffee", paths: ["src/shared.ts"] } })).status).toBe(201);
    const rev = await env.operator.recordRevision({ commit: "feedbeef", gate: "pass", merged: ["c0ffee"] });
    expect(rev.ok && rev.appended.some((m) => m.type === "rebase.needed" && m.payload.agent === "w1")).toBe(true);

    expect(await w1.step()).toBe("acted"); // rebase.needed names w1 -> edit
    expect(fetched).toEqual([[1, "feedbeef"]]);
    expect(executor.seen[0]).toEqual({ "src/a/x.ts": "export const x = 1; // integrated\n" });
    expect((await env.log()).messages.some((m) => m.type === "push.announced" && m.from === "w1")).toBe(true);
  });
});

describe("day-2 review regressions", () => {
  it("pages the digest by the last seq the page covered, never by a state that ran ahead", async () => {
    const env = await setup();
    const fetchFn = env.control.fetch as unknown as typeof fetch;
    let skewed = false;
    // The first digest read reports a board state ahead of the page it served,
    // as a non-transactional read can.
    const skewing = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetchFn(input, init);
      if (!skewed && String(input).includes("/board?for=w1")) {
        skewed = true;
        const body = (await res.json()) as { digest: { lastSeq: number } };
        body.digest.lastSeq += 5;
        return new Response(JSON.stringify(body), { status: res.status });
      }
      return res;
    }) as typeof fetch;
    const transport = scripted([{ type: "wait", reason: "nothing yet" }]);
    const w1 = env.agent("w1", { transport, fetchFn: skewing });
    await w1.join();
    await w1.step();
    // A message addressed to w1 lands right after the page it read.
    const w2 = await env.operator.join("w2", {});
    const token = w2.ok ? w2.token : "";
    await env.rawPost(token, { type: "item.claimed", payload: { item: "i2", intent: { write: ["src/b/**"] } } });
    expect((await env.rawPost(token, { type: "help.requested", payload: { request: "q1", item: "i2", need: "question" }, to: ["w1"] })).status).toBe(201);
    expect(await w1.step()).toBe("acted");
    expect(transport.inputs.at(-1)!.messages.some((m) => m.type === "help.requested" && m.to?.includes("w1"))).toBe(true);
  });

  it("hands off only to an agent that is still running; otherwise asks for help", async () => {
    const env = await setup();
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "go" },
      ]),
      maxTurnsPerItem: 1,
      runningAgents: () => ["w1"], // w2 joined but has stopped
    });
    const w2 = env.agent("w2", { transport: scripted([]) });
    await w1.join();
    await w2.join();
    await w1.step();
    await w1.step();
    const log = (await env.log()).messages;
    expect(log.some((m) => m.type === "handoff")).toBe(false);
    expect(log.find((m) => m.type === "help.requested")).toMatchObject({ from: "w1", payload: { item: "i1", need: "turn-budget" } });
  });

  it("a new owner starts from the previous owner's latest pushed version of the item's files", async () => {
    const env = await setup();
    const first = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 'from w1';\n" }));
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "start" },
        { type: "edit", itemId: "i1", instruction: "again" }, // over the budget: hands off
      ]),
      executor: first,
      maxTurnsPerItem: 2,
    });
    const second = new RecordingExecutor(() => ({ "src/a/y.ts": "export const y = 'from w2';\n" }));
    const fetchedFrom: string[] = [];
    const w2 = env.agent("w2", {
      transport: scripted([{ type: "edit", itemId: "i1", instruction: "continue" }]),
      executor: second,
      runningAgents: () => ["w1", "w2"],
      fetchPush: async (agent, commit) => {
        fetchedFrom.push(`${agent}@${commit}`);
        const dir = join(env.root, "fetched", commit);
        await run("git", ["clone", "-q", w1.joinedWorkspace!.gitUrl, dir]);
        await run("git", ["-C", dir, "checkout", "-q", "--detach", commit]);
        return dir;
      },
    });
    await w1.join();
    await w2.join();
    await w1.step(); // claim
    await w1.step(); // edit + push
    await w1.step(); // budget spent: handoff to w2 with its push
    const handoff = (await env.log()).messages.find((m) => m.type === "handoff")!;
    expect(handoff).toMatchObject({ from: "w1", payload: { item: "i1", to: "w2" } });
    const commit = (handoff.payload as { capsule: { commit: string } }).capsule.commit;
    expect(await w2.step()).toBe("acted");
    expect(fetchedFrom).toEqual([`w1@${commit}`]);
    // w2's executor saw w1's version, and w2's push carries it plus its own edit.
    expect(second.seen[0]!["src/a/x.ts"]).toBe("export const x = 'from w1';\n");
    const pushed = (await env.log()).messages.filter((m) => m.type === "push.announced" && m.from === "w2");
    expect(pushed).toHaveLength(1);
    expect((pushed[0]!.payload as { paths: string[] }).paths).toEqual(["src/a/x.ts", "src/a/y.ts"]);
  });

  it("a fix edit rebases, carries the failing output, and runs on the next escalation model", async () => {
    const env = await setup();
    const executor = new RecordingExecutor((ctx) => ({ "src/a/x.ts": `export const x = '${ctx.model ?? "base"}';\n` }));
    const fetched: number[] = [];
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "first" },
        { type: "edit", itemId: "i1", instruction: "fix it" },
      ]),
      executor,
      escalationModels: ["stronger", "strongest"],
      fetchRevision: async (n) => {
        fetched.push(n);
        return undefined;
      },
    });
    await w1.join();
    await w1.step();
    await w1.step();
    const push = (await env.log()).messages.find((m) => m.type === "push.announced")!;
    const rev = await env.operator.recordRevision({
      commit: "badc0de",
      gate: "fail",
      merged: [(push.payload as { commit: string }).commit],
      failing: { output: "not ok 1 - src/a/x.ts is wrong", items: ["i1"] },
    });
    expect(rev.ok && rev.appended.map((m) => m.type)).toEqual(["integrated.rev", "fix.requested"]);
    expect(await w1.step()).toBe("acted");
    expect(executor.contexts.map((c) => c.model)).toEqual([undefined, "stronger"]);
    expect(executor.contexts[1]!.objective).toMatch(/FAILED on revision 1 and implicated this item \(fix attempt 1\)/);
    expect(executor.contexts[1]!.objective).toContain("not ok 1 - src/a/x.ts is wrong");
    const state = (await env.log()).state;
    expect(state.items.i1!.fixRequested).toBeUndefined(); // the push answered the request
  });

  it("never pushes a symlink or a dependency-tree file", async () => {
    const env = await setup();
    const executor: ExecutorProvider = {
      name: "unsafe",
      async execute(ctx: ExecutorContext): Promise<ExecutionResult> {
        await mkdir(join(ctx.worktreeDir, "src/a"), { recursive: true });
        await symlink("/etc/passwd", join(ctx.worktreeDir, "src/a/link.ts"));
        return { status: "changed", changedPaths: ["src/a/link.ts"], logs: [], cost: { usd: 0 }, commitMessage: "x" };
      },
    };
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "go" },
      ]),
      executor,
    });
    await w1.join();
    await w1.step();
    await w1.step();
    expect(env.turns.at(-1)).toMatchObject({ action: { type: "edit" }, code: "UNSAFE_PATH" });
    expect((await env.log()).messages.some((m) => m.type === "push.announced")).toBe(false);
  });
});


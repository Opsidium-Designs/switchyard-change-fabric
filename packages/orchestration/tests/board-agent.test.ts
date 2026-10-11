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
import { ModelBudgetError } from "@switchyard-change/model-adapters";

import {
  BoardAgent,
  heldWorkCue,
  MAX_CONTRACT_CUES,
  MAX_EXHAUSTED_ITEMS,
  MAX_MERGE_CUES,
  MAX_QUESTION_CUES,
  RunTurnBudget,
  type AgentTurnRecord,
  type BoardAgentOptions,
} from "../src/board-agent.ts";
import { RunMeter, type RunCapReached } from "../src/run-meter.ts";
import { BoardOperatorClient, type BoardPage } from "../src/board-client.ts";
import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import type { PrePushCheckInput } from "@switchyard-change/verification";

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

async function setup(
  options: {
    readonly seams?: readonly { path: string; importers: string[] }[];
    readonly rules?: Record<string, unknown>;
    readonly files?: Readonly<Record<string, string>>;
    readonly protected?: readonly string[];
  } = {},
): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "scf-board-agent-"));
  const projectDir = join(root, "project");
  for (const [rel, body] of Object.entries({
    "src/a/x.ts": "export const x = 1;\n",
    "src/b/y.ts": "export const y = 2;\n",
    "src/shared.ts": "export const shared = 0;\n",
    ...options.files,
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
  await human({
    type: "goal.posted",
    payload: {
      objective: "runtime",
      ...(options.seams ? { seams: options.seams } : {}),
      ...(options.rules ? { rules: options.rules } : {}),
      ...(options.protected ? { protected: options.protected } : {}),
    },
  });
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

    expect(await w1.step()).toBe("acted"); // first look after joining -> waits while free
    expect(await w1.step()).toBe("acted"); // waited while open items exist: nudged to claim -> claims i1
    expect(transport.inputs.at(-1)!.capsule.evidence.at(-1)).toMatch(/claim one now.*never wait for a tool/);
    expect(await w1.step()).toBe("acted"); // its accepted claim keeps the initiative -> waits
    // Waiting while holding i1 with no push and nothing to wait for: re-cued at once, bounded.
    expect(await w1.step()).toBe("acted");
    expect(transport.inputs.at(-1)!.capsule.evidence.at(-1)).toMatch(/^HELD WORK: I hold i1 with no push: edit it now \(or hand it off\)/);
    expect(await w1.step()).toBe("acted");
    expect(await w1.step()).toBe("idle"); // the held-work cues are spent: holding work, nothing new

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

  it("an invalid reply while holding work it owes is re-cued at once with the reason, bounded", async () => {
    const env = await setup();
    const invalid = "invalid model output: instruction must be a string";
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { action: { type: "wait", reason: invalid }, invalid },
      { action: { type: "wait", reason: invalid }, invalid },
      { action: { type: "wait", reason: invalid }, invalid },
    ]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    const results: string[] = [];
    for (let i = 0; i < 5; i += 1) results.push(await w1.step());
    expect(results).toEqual(["acted", "acted", "acted", "acted", "idle"]);
    const cued = transport.inputs.filter((i) => i.capsule.evidence.some((e) => e.startsWith("HELD WORK: I hold i1 with no push")));
    expect(cued).toHaveLength(2);
    expect(cued[0]!.capsule.evidence.at(-1)).toBe(`HELD WORK: I hold i1 with no push: edit it now (or hand it off); nothing else will wake me for it. My last reply was invalid: ${invalid}`);
    // The cues are spent: no turn is pending (a quiet board may judge it now).
    expect(w1.turnPending).toBe(false);
  });

  it("a sub-lead whose child another agent pushed is cued to pull (once per set), and the driver may re-cue it, bounded", async () => {
    const env = await setup();
    const lead = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      {
        type: "split",
        itemId: "i1",
        children: [
          { objective: "x", acceptance: ["x works"], scopeHint: ["src/a/x.ts"] },
          { objective: "y", acceptance: ["y works"], scopeHint: ["src/a/y.ts"] },
        ],
      },
    ]);
    const w1 = env.agent("w1", { transport: lead });
    const w2 = env.agent("w2", {
      transport: scripted([
        { type: "claim", itemId: "i1.1", intent: { read: [], write: ["src/a/x.ts"] } },
        { type: "edit", itemId: "i1.1", instruction: "do x" },
      ]),
      executor: new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 2;\n" })),
    });
    await w1.join();
    await w2.join();
    await w1.step(); // claim
    await w1.step(); // split: w1 is the sub-lead of i1
    expect((await env.log()).state.items.i1).toMatchObject({ status: "split", subLead: "w1" });
    await w2.step(); // claim i1.1
    await w2.step(); // edit + push
    const push = (await env.log()).messages.find((m) => m.type === "push.announced" && m.from === "w2")!;
    const commit = (push.payload as { commit: string }).commit;
    const merge = new RegExp(`^SUB-LEAD MERGE DUE: pull \\{itemId: i1\\} merges i1\\.1@${commit.slice(0, 10)} \\(pushed by w2\\)`);
    while ((await w1.step()) === "acted" && !lead.inputs.at(-1)!.capsule.evidence.some((e) => merge.test(e))) {
      // earlier follow-ups (the split) settle first
    }
    expect(lead.inputs.at(-1)!.capsule.evidence.some((e) => merge.test(e))).toBe(true);
    const cues = () => lead.inputs.at(-1)!.capsule.evidence.filter((e) => merge.test(e)).length;
    expect(cues()).toBe(1);
    // It waited (the script is done): other cues settle, and the same set is not cued again by itself...
    for (let i = 0; i < 5 && (await w1.step()) === "acted"; i += 1) {
      // bounded
    }
    expect(await w1.step()).toBe("idle");
    expect(cues()).toBe(1);
    // ...but the driver may re-cue it, up to MAX_MERGE_CUES deliveries in all.
    while (w1.nudgeSubLeadMerge()) {
      expect(await w1.step()).toBe("acted");
    }
    expect(cues()).toBe(MAX_MERGE_CUES);
    expect(w1.nudgeSubLeadMerge()).toBe(false);
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
  it("a spent per-item budget releases THAT item on the board; the worker stays in the pool and takes another open item, never the released one", async () => {
    const env = await setup();
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
      { type: "claim", itemId: "i2", intent: { read: [], write: ["src/b/**"] } },
      { type: "edit", itemId: "i1", instruction: "once more" },
    ]);
    const w1 = env.agent("w1", { transport, maxTurnsPerItem: 1 });
    await w1.join();
    await w1.step(); // claim (1 turn on i1)
    await w1.step(); // edit would be a 2nd turn on i1: over budget, i1 is released
    expect(w1.stopped).toBeUndefined();
    const help = (await env.log()).messages.find((m) => m.type === "help.requested");
    expect(help).toMatchObject({ from: "w1", payload: { item: "i1", need: "turn-budget" } });
    expect(help!.rationale).toMatch(/^releasing it: spent more than 1 turns on item i1/);
    // Its next turn: the released item is not offered or shown as its claim; it claims i2.
    expect(await w1.step()).toBe("acted");
    const seen = transport.inputs.at(-1)!.digest;
    expect(seen.claims.map((c) => c.item)).toEqual([]);
    expect(seen.openItems.map((i) => i.item)).toEqual(["i2"]);
    expect(transport.inputs.at(-1)!.capsule.evidence.join("\n")).toMatch(/released item i1 .*never act on it again/);
    expect((await env.log()).state.items.i2).toMatchObject({ status: "claimed", owner: "w1" });
    // Acting on the released item again is refused locally: nothing about i1 is posted.
    const before = (await env.log()).messages.length;
    await w1.step();
    expect(env.turns.at(-1)).toMatchObject({ action: { type: "edit", itemId: "i1" }, outcome: "local", code: "ITEM_BUDGET" });
    expect((await env.log()).messages.slice(before).filter((m) => (m.payload as { item?: string }).item === "i1")).toEqual([]);
    expect(w1.stopped).toBeUndefined();
  });

  it("never re-claims an item it exhausted: the claim is refused locally and never posted", async () => {
    const env = await setup();
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
    ]);
    const w1 = env.agent("w1", { transport, maxTurnsPerItem: 1 });
    const w2 = env.agent("w2", { transport: scripted([]) });
    await w1.join();
    await w2.join();
    await w1.step();
    await w1.step(); // over budget: i1 handed to w2
    expect((await env.log()).state.items.i1!.owner).toBe("w2");
    // The claim is refused locally, before it reaches the board.
    await w1.step();
    expect(env.turns.filter((t) => t.agent === "w1").at(-1)).toMatchObject({ action: { type: "claim", itemId: "i1" }, outcome: "local", code: "ITEM_BUDGET" });
    expect((await env.log()).messages.filter((m) => m.type === "item.claimed" && m.from === "w1")).toHaveLength(1);
  });

  it(`stops after exhausting ${MAX_EXHAUSTED_ITEMS} distinct items, releasing only what it has not released yet`, async () => {
    const env = await setup();
    await env.human({ type: "item.proposed", payload: { item: "i3", objective: "do c", scopeHint: ["src/c/**"] } });
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
      { type: "claim", itemId: "i2", intent: { read: [], write: ["src/b/**"] } },
      { type: "edit", itemId: "i2", instruction: "go" },
      { type: "claim", itemId: "i3", intent: { read: [], write: ["src/c/**"] } },
      { type: "edit", itemId: "i3", instruction: "go" },
    ]);
    const w1 = env.agent("w1", { transport, maxTurnsPerItem: 1 });
    await w1.join();
    for (let i = 0; i < 6 && !w1.stopped; i += 1) {
      await w1.step();
    }
    expect(MAX_EXHAUSTED_ITEMS).toBe(3);
    expect(w1.stopped).toMatchObject({ reason: "item-budget", detail: expect.stringMatching(/exhausted 3 item\(s\) \(i1, i2, i3\), at most 3/) });
    expect(await w1.step()).toBe("stopped");
    const help = (await env.log()).messages.filter((m) => m.type === "help.requested");
    expect(help.map((m) => (m.payload as { item: string }).item)).toEqual(["i1", "i2", "i3"]);
    expect(help.at(-1)!.rationale).toMatch(/^stopping: /);
  });

  it("holding only items it exhausted, with nothing else to do: no model call", async () => {
    const env = await setup();
    let calls = 0;
    const script = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
    ]);
    const w1 = env.agent("w1", {
      transport: async (input) => {
        calls += 1;
        return script(input);
      },
      maxTurnsPerItem: 1,
      runningAgents: () => ["w1"], // w2 is not running: nobody can take i1
    });
    const w2 = await env.operator.join("w2", { role: "worker" });
    expect(w2.ok).toBe(true);
    expect((await env.rawPost(w2.ok ? w2.token : "", { type: "item.claimed", payload: { item: "i2", intent: { write: ["src/b/**"] } } })).status).toBe(201);
    await w1.join();
    await w1.step();
    await w1.step(); // over budget: no running agent can take it, so help is asked; w1 still holds i1
    expect((await env.log()).state.items.i1!.owner).toBe("w1");
    const before = calls;
    await w1.step();
    expect(calls).toBe(before);
    expect(env.turns.at(-1)).toMatchObject({ outcome: "local", code: "ITEM_BUDGET" });
    expect(w1.stopped).toBeUndefined();
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

  it("an item at its call cap: no model call while every held item is capped; the agent whose call reached the cap releases it (item-budget), the next holder only skips", async () => {
    const env = await setup();
    const meter = new RunMeter({ maxCallsPerItem: 1 });
    const caps: RunCapReached[] = [];
    let w1Calls = 0;
    const w1Script = scripted([{ type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } }]);
    const w1 = env.agent("w1", {
      transport: async (input) => {
        w1Calls += 1;
        return w1Script(input);
      },
      meter,
      onItemCap: (cap) => caps.push(cap),
    });
    let w2Calls = 0;
    const w2Script = scripted([{ type: "claim", itemId: "i2", intent: { read: [], write: ["src/b/**"] } }]);
    const w2 = env.agent("w2", {
      transport: async (input) => {
        w2Calls += 1;
        return w2Script(input);
      },
      meter,
    });
    await w1.join();
    await w2.join();
    await w2.step(); // w2 claims i2 (1 call on i2: at its cap)
    await w1.step(); // w1 claims i1 (1 call on i1: at its cap, reached by w1)
    expect(w1Calls).toBe(1);
    // Nothing else to act on (no open item): the next turn makes NO model call and releases i1.
    await w1.step();
    expect(w1Calls).toBe(1);
    expect(env.turns.some((t) => t.code === "ITEM_CAP" && t.action.type === "wait")).toBe(true);
    expect(caps).toEqual(expect.arrayContaining([{ kind: "item-calls", limit: 1, used: 1, item: "i1" }]));
    // Released, and w1 stays in the pool (it exhausted one item).
    expect(w1.stopped).toBeUndefined();
    const handoff = (await env.log()).messages.find((m) => m.type === "handoff");
    expect(handoff).toMatchObject({ from: "w1", payload: { item: "i1", to: "w2" } });
    expect(handoff!.rationale).toMatch(/item i1 reached its call cap \(1 of 1\)/);
    // w2 holds i1 now (capped under w1) and i2 (whose cap its own claim reached): no call, and it releases i2.
    const before = w2Calls;
    await w2.step();
    expect(w2Calls).toBe(before);
    expect(w2.stopped).toBeUndefined();
    expect((await env.log()).messages.filter((m) => m.type === "handoff").at(-1)).toMatchObject({
      from: "w2",
      payload: { item: "i2", to: "w1" },
      rationale: expect.stringMatching(/item i2 reached its call cap/),
    });
    expect(meter.itemCalls("i1")).toBe(1);
  });

  it("an item that reached its cap under another agent is only skipped: no model call, never released again by this agent", async () => {
    const env = await setup();
    const meter = new RunMeter({ maxCallsPerItem: 1 });
    const caps: RunCapReached[] = [];
    let calls = 0;
    const script = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "claim", itemId: "i2", intent: { read: [], write: ["src/b/**"] } },
    ]);
    const w1 = env.agent("w1", {
      transport: async (input) => {
        calls += 1;
        return script(input);
      },
      meter,
      onItemCap: (cap) => caps.push(cap),
    });
    await w1.join();
    // Calls an earlier agent made on i2 (it reached i2's cap there).
    meter.noteItem("i2");
    await w1.step(); // claims i1: 1 call, i1 at its cap (reached by w1)
    await w1.step(); // claims i2: refused locally past the cap (ITEM_CAP after the call)
    expect(calls).toBe(2);
    expect(env.turns.at(-1)).toMatchObject({ code: "ITEM_CAP", action: { type: "claim", itemId: "i2" } });
    expect(w1.stopped).toBeUndefined();
    expect(caps).toEqual([{ kind: "item-calls", limit: 1, used: 2, item: "i2" }]);
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
    expect(calls[0]!.allowed).toEqual(["decide_contract", "decide_item", "extend_claim", "replan_item", "propose_item", "message", "wait"]);
    expect(calls[0]!.board.pendingContracts).toEqual([{ contract: "k1", target: "src/shared.ts", kind: "modify", proposedBy: "w9" }]);
    expect((await env.log()).messages.find((m) => m.type === "contract.accepted")).toMatchObject({ from: "lead", payload: { contract: "k1" } });
  });

  it("a lead that answers a pending contract with a wait is re-cued at once, with the contract named, and decides it", async () => {
    const env = await setup({ seams: [{ path: "src/shared.ts", importers: ["src/a/x.ts", "src/b/y.ts"] }] });
    const transport = scripted([
      { type: "wait", reason: "nothing to decide" },
      { type: "decide_contract", contractId: "k1", decision: "reject", rationale: "not what the error needs" },
    ]);
    const lead = env.agent("lead", { role: "lead", transport, seed: async () => [] });
    await lead.join();
    await lead.step(); // seeds nothing
    const w = await env.operator.join("w9", {});
    const token = w.ok ? w.token : "";
    await env.rawPost(token, { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/a/**"] } } });
    await env.rawPost(token, { type: "contract.proposed", payload: { contract: "k1", target: "src/shared.ts", kind: "modify", item: "i1", description: "add a shared field" } });
    expect(await lead.step()).toBe("acted"); // the fresh proposal wakes it: it waits
    expect(lead.turnPending).toBe(true); // re-cued at once
    expect(await lead.step()).toBe("acted");
    expect(transport.inputs[1]!.capsule.evidence.at(-1)).toMatch(
      /^PENDING CONTRACT\(S\) TO DECIDE: k1 \(modify src\/shared\.ts, for i1\): decide_contract now; waiting leaves that item blocked \(its claim cannot lapse, its holder cannot propose another\)/,
    );
    expect((await env.log()).messages.find((m) => m.type === "contract.rejected")).toMatchObject({ from: "lead", payload: { contract: "k1" } });
    expect(await lead.step()).toBe("acted"); // its decision keeps the initiative: one follow-up turn (it waits)
    expect(transport.inputs[2]!.capsule.evidence.filter((e) => /^PENDING CONTRACT/.test(e))).toHaveLength(1); // nothing pending: no new cue
    expect(await lead.step()).toBe("idle");
  });

  it("a lead that always waits takes exactly 1 + MAX_CONTRACT_CUES turns on its own; the driver's nudges are bounded per contract set and never decide", async () => {
    const env = await setup({ seams: [{ path: "src/shared.ts", importers: ["src/a/x.ts", "src/b/y.ts"] }] });
    const transport = scripted([]);
    const lead = env.agent("lead", { role: "lead", transport, seed: async () => [] });
    await lead.join();
    await lead.step();
    const w = await env.operator.join("w9", {});
    const token = w.ok ? w.token : "";
    await env.rawPost(token, { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/a/**"] } } });
    await env.rawPost(token, { type: "contract.proposed", payload: { contract: "k1", target: "src/shared.ts", kind: "modify", item: "i1", description: "add a shared field" } });
    let steps = 0;
    while ((await lead.step()) === "acted" && steps < 10) steps += 1;
    expect(transport.inputs).toHaveLength(1 + MAX_CONTRACT_CUES);
    expect(transport.inputs.slice(1).every((i) => /^PENDING CONTRACT/.test(i.capsule.evidence.at(-1) ?? ""))).toBe(true);
    // The driver's nudges: one turn each, bounded per set of contracts.
    for (let n = 0; n < MAX_CONTRACT_CUES; n += 1) {
      expect(lead.nudgeContracts(["k1"])).toBe(true);
      expect(lead.turnPending).toBe(true);
      expect(await lead.step()).toBe("acted");
      expect(transport.inputs.at(-1)!.capsule.evidence.at(-1)).toMatch(/^PENDING CONTRACT\(S\) TO DECIDE: k1 /);
      expect(await lead.step()).toBe("idle");
    }
    expect(lead.nudgeContracts(["k1"])).toBe(false);
    // Nothing decided it: it is still the lead's.
    expect((await env.log()).state.contracts.k1).toMatchObject({ status: "proposed" });
    // A worker is never nudged to decide a contract.
    expect(env.agent("w1", { transport: scripted([]) }).nudgeContracts(["k1"])).toBe(false);
  });

  it("a failing revision that points only at a shared seam no item covers cues the lead (bounded) to give it an owner, with the failing line; it is not a refused action", async () => {
    const env = await setup({ seams: [{ path: "src/shared.ts", importers: ["src/a/x.ts", "src/b/y.ts"] }] });
    const transport = scripted([]);
    const lead = env.agent("lead", { role: "lead", transport, seed: async () => [] });
    await lead.join();
    await lead.step(); // seeds nothing
    const w = await env.operator.join("w9", {});
    const token = w.ok ? w.token : "";
    await env.rawPost(token, { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/a/**"] } } });
    await env.rawPost(token, { type: "push.announced", payload: { item: "i1", commit: "c0ffee00", paths: ["src/a/x.ts"] } });
    const rev = await env.operator.recordRevision({
      commit: "badc0de",
      gate: "fail",
      merged: ["c0ffee00"],
      failing: { output: "AssertionError: expected 1072 to be 1073\n    at src/shared.ts:3:9", items: [] },
    });
    expect(rev.ok).toBe(true);
    expect(await lead.step()).toBe("acted");
    expect(transport.inputs.at(-1)!.capsule.evidence.at(-1)).toMatch(
      /^SEAM FAILURE NOBODY OWNS: revision 1 failed \(AssertionError: expected 1072 to be 1073\) and points only at the shared seam\(s\) src\/shared\.ts, which no item covers.*propose_item \{scopeHint: \[src\/shared\.ts\]/,
    );
    const seamOnly = env.turns.filter((t) => t.agent === "lead" && t.action.type === "wait" && /points only at the shared seam/.test((t.action as { reason: string }).reason));
    expect(seamOnly).toHaveLength(1);
    expect(seamOnly[0]!.code).toBeUndefined(); // a cue, never counted as a refused action
    // Nothing was proposed on the lead's behalf.
    expect((await env.log()).messages.some((m) => m.type === "item.proposed" && m.from === "lead")).toBe(false);
  });

  it("decide_contract takes the contract id or the seam item id derived from it; an already decided one is refused locally with what carries it", async () => {
    const env = await setup({ seams: [{ path: "src/shared.ts", importers: ["src/a/x.ts", "src/b/y.ts"] }] });
    const transport = scripted([
      { type: "decide_contract", contractId: "seam-k1", decision: "accept", rationale: "the item id of a pending contract" },
      { type: "decide_contract", contractId: "seam-k1", decision: "accept", rationale: "again" },
      { type: "decide_contract", contractId: "nope", decision: "reject", rationale: "unknown" },
    ]);
    const lead = env.agent("lead", { role: "lead", transport, seed: async () => [] });
    await lead.join();
    await lead.step(); // seeds nothing
    const w = await env.operator.join("w9", {});
    const token = w.ok ? w.token : "";
    await env.rawPost(token, { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/a/**"] } } });
    const proposed = await env.rawPost(token, {
      type: "contract.proposed",
      payload: { contract: "k1", target: "src/shared.ts", kind: "modify", item: "i1", description: "add a shared field" },
    });
    expect(proposed.status).toBe(201);
    for (let i = 0; i < 4; i += 1) await lead.step();
    const log = await env.log();
    // The seam item id of the pending contract decided the contract itself; the engine granted the seam item to the proposer.
    expect(log.messages.find((m) => m.type === "contract.accepted")).toMatchObject({ from: "lead", payload: { contract: "k1" } });
    expect(log.state.items["seam-k1"]).toMatchObject({ status: "claimed", owner: "w9" });
    const refusals = env.turns.filter((t) => t.agent === "lead" && t.outcome === "local" && t.action.type === "decide_contract");
    expect(refusals.map((t) => t.code)).toEqual(["INVALID_STATE", "UNKNOWN_REF"]);
    expect(refusals[0]!.error).toMatch(/already accepted \(its seam item seam-k1 carries it out\): nothing to decide/);
    expect(refusals[1]!.error).toMatch(/no contract nope; pending contracts: none \(use pendingContracts\[\]\.contract exactly\)/);
  });

  it("an OPEN seam item wakes a free worker once per set, says it may claim it, and the driver may nudge it once more (bounded)", async () => {
    const env = await setup({ seams: [{ path: "src/shared.ts", importers: ["src/a/x.ts", "src/b/y.ts"] }] });
    const lead = await env.operator.join("lead", { role: "lead" });
    const w9 = await env.operator.join("w9", {});
    const leadToken = lead.ok ? lead.token : "";
    const token = w9.ok ? w9.token : "";
    await env.rawPost(token, { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/a/**"] } } });
    await env.rawPost(token, { type: "contract.proposed", payload: { contract: "k1", target: "src/shared.ts", kind: "modify", item: "i1", description: "add a shared field" } });
    await env.rawPost(leadToken, { type: "contract.accepted", payload: { contract: "k1" } });
    expect((await env.operator.recordSeamStalled("seam-k1")).ok).toBe(true);
    const transport = scripted(Array.from({ length: 6 }, () => ({ type: "wait" as const, reason: "looking" })));
    const w1 = env.agent("w1", { transport });
    await w1.join();
    const results: string[] = [];
    for (let i = 0; i < 3; i += 1) results.push(await w1.step());
    const cues = () => transport.inputs.at(-1)!.capsule.evidence.filter((e) => /^OPEN SEAM ITEM: seam-k1 .*is OPEN: nobody holds it/.test(e)).length;
    expect(cues()).toBe(1);
    expect((transport.inputs[0]!.digest as BoardDigest).openSeams).toEqual([expect.objectContaining({ item: "seam-k1", seam: "src/shared.ts" })]);
    // The driver's nudge gives one more turn, at most MAX_OPEN_SEAM_CUES times per set.
    expect(w1.nudgeOpenSeams(["seam-k1"])).toBe(true);
    expect(await w1.step()).toBe("acted");
    expect(cues()).toBe(2);
    expect(w1.nudgeOpenSeams(["seam-k1"])).toBe(true);
    expect(w1.nudgeOpenSeams(["seam-k1"])).toBe(false);
    expect(results[0]).toBe("acted");
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

  it("refuses an edit the pre-push check rejects: nothing is pushed, the worktree is discarded, and the errors feed the next turn", async () => {
    const env = await setup();
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x: string = 1;\n" }));
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
    ]);
    const asked: PrePushCheckInput[] = [];
    const preEditCheck = async (input: PrePushCheckInput) => {
      asked.push(input);
      expect(await readFile(join(input.agentDir, "src/a/x.ts"), "utf8")).toBe("export const x: string = 1;\n");
      return { ok: false as const, errors: ["src/a/x.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'."] };
    };
    const w1 = env.agent("w1", { transport, executor, preEditCheck });
    await w1.join();
    await w1.step();
    await w1.step();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ baselineDir: env.projectDir, changed: ["src/a/x.ts"], fallbackNodeModulesDir: env.projectDir });
    expect(env.turns.at(-1)).toMatchObject({ outcome: "local", code: "EXECUTOR_FAILED" });
    expect(env.turns.at(-1)!.error).toMatch(/the edit does not typecheck: src\/a\/x\.ts\(1,14\): error TS2322.*nothing was pushed/);
    expect((await env.log()).messages.some((m) => m.type === "push.announced")).toBe(false);
    const { stdout } = await run("git", ["ls-remote", w1.joinedWorkspace!.gitUrl]);
    expect(stdout.trim()).toBe(""); // nothing was pushed
    const { stdout: status } = await run("git", ["-C", join(env.root, "work", "agents", "w1"), "status", "--porcelain"]);
    expect(status.trim()).toBe(""); // the refused edit was discarded
    await w1.step();
    expect(transport.inputs.at(-1)!.lastRejection).toMatchObject({ code: "EXECUTOR_FAILED", action: "edit" });
    expect(transport.inputs.at(-1)!.lastRejection!.error).toMatch(/TS2322/);
  });

  it("pushes an edit the pre-push check passes or skips, noting each skip reason once", async () => {
    const env = await setup();
    const executor = new RecordingExecutor((ctx) => ({ "src/a/x.ts": `export const x = ${ctx.objective.length};\n` }));
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "first" },
      { type: "edit", itemId: "i1", instruction: "second edit" },
      { type: "edit", itemId: "i1", instruction: "and a third edit" },
    ]);
    const answers = [{ ok: true as const, skipped: "the project has no tsconfig.json" }, { ok: true as const, skipped: "the project has no tsconfig.json" }, { ok: true as const }];
    const w1 = env.agent("w1", { transport, executor, preEditCheck: async () => answers.shift()! });
    await w1.join();
    for (let i = 0; i < 5; i++) {
      await w1.step();
    }
    expect((await env.log()).messages.filter((m) => m.type === "push.announced")).toHaveLength(3);
    expect(answers).toHaveLength(0);
    const notes = transport.inputs.at(-1)!.capsule.evidence.filter((e) => e.startsWith("pre-push typecheck skipped"));
    expect(notes).toEqual(["pre-push typecheck skipped: the project has no tsconfig.json"]);
  });

  it("never pushes what another process wrote into its worktree: stray changes are discarded (and logged) before an edit, and only listed in-intent paths are staged", async () => {
    const env = await setup();
    const executor = new RecordingExecutor((ctx) => ({ "src/a/x.ts": `edit ${ctx.objective.length}\n` }));
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "first" },
      { type: "edit", itemId: "i1", instruction: "second, after something wrote into my worktree" },
    ]);
    const w1 = env.agent("w1", { transport, executor });
    await w1.join();
    await w1.step(); // claim
    await w1.step(); // first edit, pushed
    // Another process (say, a tool run by another agent) writes into w1's worktree:
    // one file inside w1's write intent, one outside, and a change to a tracked file.
    const worktree = join(env.root, "work", "agents", "w1");
    await mkdir(join(worktree, "src/a"), { recursive: true });
    await writeFile(join(worktree, "src/a/injected.ts"), "export const injected = true;\n");
    await mkdir(join(worktree, "src/b"), { recursive: true });
    await writeFile(join(worktree, "src/b/evil.ts"), "evil\n");
    await w1.step(); // second edit
    const pushes = (await env.log()).messages.filter((m) => m.type === "push.announced");
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect((push.payload as { readonly paths: readonly string[] }).paths).toEqual(["src/a/x.ts"]);
    }
    const second = (pushes[1]!.payload as { commit: string }).commit;
    const { stdout } = await run("git", ["-C", worktree, "ls-tree", "-r", "--name-only", second]);
    expect(stdout.split("\n").filter((l) => l !== "")).toEqual(["src/a/x.ts"]);
    expect(env.turns.filter((t) => t.action.type === "edit").map((t) => t.outcome)).toEqual(["posted", "posted"]);
    // The discard is logged in the agent's evidence (its next turn input).
    await w1.step();
    expect(transport.inputs.at(-1)!.capsule.evidence.join("\n")).toMatch(/discarded 2 uncommitted change\(s\) found in my worktree before editing i1 \(nobody announced them; never pushed\): src\/a\/injected\.ts, src\/b\/evil\.ts/);
  });

  it("a free agent that keeps waiting while open items exist is nudged to claim a bounded number of times, then left idle", async () => {
    const env = await setup();
    const transport = scripted(Array.from({ length: 10 }, () => ({ type: "wait" as const, reason: "waiting for the tools" })));
    const w1 = env.agent("w1", { transport });
    await w1.join();
    const results: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      results.push(await w1.step());
    }
    // The first look, then MAX_CLAIM_NUDGES (3) nudged turns, then idle.
    expect(results).toEqual(["acted", "acted", "acted", "acted", "idle", "idle", "idle", "idle"]);
    expect(transport.inputs.filter((i) => i.capsule.evidence.some((e) => /claim one now/.test(e)))).toHaveLength(3);
  });

  it("an edit on a tool item goes to the build flow (never the agent's own repo); use_tool and propose_done on it are refused", async () => {
    const env = await setup();
    await env.human({ type: "item.proposed", payload: { item: "i9", objective: "x", scopeHint: ["docs/**"] } });
    const transport = scripted([
      { type: "propose_tool", capability: "scan-x", kind: "scanner", why: "find every place", inputs: [], outputs: ["findings"] },
      { type: "wait", reason: "the lead decides" },
    ]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    await w1.step();
    await env.human({ type: "item.accepted", payload: { item: "tool-scan-x" } });
    const next = scripted([
      { type: "claim", itemId: "tool-scan-x", intent: { read: [], write: ["tools/scan-x/**"] } },
      { type: "edit", itemId: "tool-scan-x", instruction: "write the scanner" },
      { type: "use_tool", capability: "scan-x", version: "1", args: [], itemId: "tool-scan-x" },
      { type: "propose_done", itemId: "tool-scan-x" },
    ]);
    const w2 = env.agent("w2", { transport: next });
    await w2.join();
    for (let i = 0; i < 4; i += 1) {
      await w2.step();
    }
    const records = env.turns.filter((t) => t.agent === "w2");
    // No tool bench in this runtime: the edit was routed to build_tool, which says so; nothing reached w2's own repo.
    expect(records.find((t) => t.action.type === "edit")).toMatchObject({ outcome: "local", code: "NOT_ALLOWED", error: expect.stringMatching(/tools cannot be built/) });
    expect(records.find((t) => t.action.type === "use_tool")).toMatchObject({ outcome: "local", code: "TOOL_ITEM" });
    expect(records.find((t) => t.action.type === "propose_done")).toMatchObject({ outcome: "local", code: "TOOL_ITEM" });
    expect((await env.log()).messages.some((m) => m.type === "push.announced" || m.type === "done.proposed")).toBe(false);
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

describe("a developer test a human released to an item", () => {
  const FILES = { "src/a/x.test.ts": "expect(x).toBe(1);\n", "src/b/y.test.ts": "expect(y).toBe(2);\n" };
  const PROTECTED = ["src/a/x.test.ts", "src/b/y.test.ts"];
  const contractId = async (env: Env, target: string): Promise<string> => {
    const proposed = (await env.log()).messages.find((m) => m.type === "contract.proposed" && m.payload.target === target);
    expect(proposed).toBeDefined();
    return (proposed!.payload as { contract: string }).contract;
  };

  it("is in the holder's edit scope: the executor may write it with the code fix, and one push carries both", async () => {
    const env = await setup({ files: FILES, protected: PROTECTED });
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 3;\n", "src/a/x.test.ts": "expect(x).toBe(3);\n" }));
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/x.ts"] } },
      { type: "message", kind: "contract", payload: { target: "src/a/x.test.ts", change: "modify", itemId: "i1" }, rationale: "the test pins the old value" },
      { type: "edit", itemId: "i1", instruction: "x is 3 now" },
    ]);
    const w1 = env.agent("w1", { transport, executor });
    await w1.join();
    await w1.step();
    await w1.step();
    await env.human({ type: "contract.accepted", payload: { contract: await contractId(env, "src/a/x.test.ts") } });
    await w1.step();
    // The turn saw the release and its cue.
    const claim = transport.inputs.at(-1)!.digest.claims[0]!;
    expect(claim.released).toEqual(["src/a/x.test.ts"]);
    expect(claim.contractReleased?.paths).toEqual(["src/a/x.test.ts"]);
    expect(transport.inputs.at(-1)!.repo.excerpts.map((e) => e.path)).toContain("src/a/x.test.ts");
    expect(executor.contexts[0]!.paths).toEqual(["src/a/x.ts", "src/a/x.test.ts"]);
    expect(executor.contexts[0]!.objective).toMatch(/A human accepted changing src\/a\/x\.test\.ts for this item/);
    // Writable, so never also a read-only reference.
    expect((executor.contexts[0]!.frozenContractFiles ?? []).map((f) => f.path)).not.toContain("src/a/x.test.ts");
    expect(env.turns.some((t) => t.code === "OUTSIDE_INTENT")).toBe(false);
    const pushed = (await env.log()).messages.find((m) => m.type === "push.announced")!;
    expect(pushed).toMatchObject({ from: "w1", payload: { item: "i1", paths: ["src/a/x.test.ts", "src/a/x.ts"] } });
  });

  it("released to ANOTHER item, it stays outside this agent's scope and a write to it is refused", async () => {
    const env = await setup({ files: FILES, protected: PROTECTED });
    const w2 = env.agent("w2", {
      transport: scripted([
        { type: "claim", itemId: "i2", intent: { read: [], write: ["src/b/y.ts"] } },
        { type: "message", kind: "contract", payload: { target: "src/b/y.test.ts", change: "modify", itemId: "i2" }, rationale: "pins the old value" },
      ]),
    });
    await w2.join();
    await w2.step();
    await w2.step();
    await env.human({ type: "contract.accepted", payload: { contract: await contractId(env, "src/b/y.test.ts") } });
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 3;\n", "src/b/y.test.ts": "stray\n" }));
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/x.ts"] } },
        { type: "edit", itemId: "i1", instruction: "x is 3 now" },
      ]),
      executor,
    });
    await w1.join();
    await w1.step();
    await w1.step();
    expect(executor.contexts[0]!.paths).toEqual(["src/a/x.ts"]);
    expect(executor.contexts[0]!.objective).not.toMatch(/A human accepted changing/);
    expect(env.turns.at(-1)).toMatchObject({ agent: "w1", outcome: "local", code: "OUTSIDE_INTENT" });
    expect(env.turns.at(-1)!.error).toMatch(/src\/b\/y\.test\.ts/);
    expect((await env.log()).messages.some((m) => m.type === "push.announced" && m.from === "w1")).toBe(false);
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

  it("an edit is shown READ-ONLY references: seams first, then the modules its files import (bounded), and a fix adds the file exporting the type the failure names", async () => {
    const big = `export const big = 1;\n${"// padding line for a large seam file\n".repeat(600)}`;
    const invoices = [
      'import { getOrder } from "../store.ts";',
      'import { tax } from "./tax.ts";',
      'import { a } from "../lib/a.ts";',
      'import { b } from "../lib/b.js";',
      'import { c } from "../lib/c";',
      'import { d } from "../lib/d.ts";',
      'import { big } from "../lib/e.ts";',
      "export function invoiceTotal(id: string): number {",
      "  return getOrder(id).total + tax + a + b + c + d + big;",
      "}",
      "",
    ].join("\n");
    const env = await setup({
      seams: [{ path: "src/lib/e.ts", importers: ["src/billing/invoices.ts"] }],
      files: {
        "src/billing/invoices.ts": invoices,
        "src/billing/tax.ts": 'import { a } from "../lib/a.ts";\nexport const tax = a;\n',
        "src/store.ts": 'import type { Order } from "./models/order.ts";\nexport type { Order } from "./models/order.ts";\nexport function getOrder(id: string): Order {\n  return { id, total: 1 };\n}\n',
        "src/models/order.ts": "export interface Order {\n  readonly id: string;\n  readonly total: number;\n}\n",
        "src/lib/a.ts": "export const a = 1;\n",
        "src/lib/b.ts": "export const b = 1;\n",
        "src/lib/c.ts": "export const c = 1;\n",
        "src/lib/d.ts": "export const d = 1;\n",
        "src/lib/e.ts": big,
      },
    });
    await env.human({ type: "item.proposed", payload: { item: "i3", objective: "bill orders", scopeHint: ["src/billing/**"] } });
    const executor = new RecordingExecutor((ctx) => ({ "src/billing/invoices.ts": `${invoices}// ${ctx.objective.length}\n` }));
    const transport = scripted([
      { type: "claim", itemId: "i3", intent: { read: [], write: ["src/billing/**"] } },
      { type: "edit", itemId: "i3", instruction: "add totals" },
      { type: "edit", itemId: "i3", instruction: "fix it" },
    ]);
    const w1 = env.agent("w1", { transport, executor, fetchRevision: async () => undefined });
    await w1.join();
    await w1.step();
    await w1.step();
    const first = executor.contexts[0]!;
    expect(first.paths).toEqual(["src/billing/invoices.ts", "src/billing/tax.ts"]);
    const refPaths = (ctx: ExecutorContext) => (ctx.frozenContractFiles ?? []).map((f) => f.path);
    // The seam first, then the imports in source order; bounded at 5; the writable tax.ts is never a reference.
    expect(refPaths(first)).toEqual(["src/lib/e.ts", "src/store.ts", "src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"]);
    expect(first.frozenContracts).toEqual(refPaths(first));
    expect(first.boardReferences).toBe(true);
    expect(first.frozenContractFiles!.find((f) => f.path === "src/store.ts")!.contents).toContain("export function getOrder");
    // A large seam is truncated with a marker, never skipped.
    const seam = first.frozenContractFiles!.find((f) => f.path === "src/lib/e.ts")!.contents;
    expect(seam.length).toBeLessThan(12 * 1024 + 200);
    expect(seam).toMatch(/\.\.\. \(read-only reference truncated at 12288 characters of \d+\)$/);
    // The turn that chose the edit saw the imported seam and store as read-only excerpts.
    const excerpts = transport.inputs[1]!.repo.excerpts;
    expect(excerpts.map((e) => e.path)).toEqual(["src/billing/invoices.ts", "src/billing/tax.ts", "src/lib/e.ts", "src/store.ts"]);
    expect(excerpts.find((e) => e.path === "src/store.ts")!.contents).toMatch(/^\(READ-ONLY REFERENCE/);

    const push = (await env.log()).messages.find((m) => m.type === "push.announced")!;
    const rev = await env.operator.recordRevision({
      commit: "badc0de",
      gate: "fail",
      merged: [(push.payload as { commit: string }).commit],
      failing: { output: "src/billing/invoices.ts(9,22): error TS2339: Property 'totalAmount' does not exist on type 'Order'.", items: ["i3"] },
    });
    expect(rev.ok && rev.appended.map((m) => m.type)).toEqual(["integrated.rev", "fix.requested"]);
    expect(await w1.step()).toBe("acted");
    const fix = executor.contexts[1]!;
    expect(fix.objective).toContain("does not exist on type 'Order'");
    // The module DECLARING Order (two imports deep) comes first; the bound still holds.
    expect(refPaths(fix)).toEqual(["src/models/order.ts", "src/lib/e.ts", "src/store.ts", "src/lib/a.ts", "src/lib/b.ts"]);
    expect(fix.frozenContractFiles![0]!.contents).toContain("export interface Order");
    expect(refPaths(fix)).not.toContain("src/billing/invoices.ts");
  });

  it("an edit whose files import nothing outside the write scope gets no reference fields (the executor prompt is unchanged)", async () => {
    const env = await setup();
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 2;\n" }));
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "bump x" },
      ]),
      executor,
    });
    await w1.join();
    await w1.step();
    await w1.step();
    expect(executor.contexts[0]!.frozenContractFiles).toBeUndefined();
    expect(executor.contexts[0]!.frozenContracts).toBeUndefined();
    expect(executor.contexts[0]!.boardReferences).toBeUndefined();
  });

  it("a large item starts one rung below the top; a model whose budget is spent retries the same edit once a rung down, never charged to the item", async () => {
    const env = await setup();
    for (const rel of ["src/a/p.ts", "src/a/q.ts"]) await writeFile(join(env.projectDir, rel), `export const ${rel.slice(6, 7)} = 0;\n`);
    // gpt-4.1 spends its budget on every call; the base model edits.
    let edits = 0;
    const executor = new RecordingExecutor((ctx): Record<string, string> => {
      if (ctx.model === "gpt-4.1") {
        throw new ModelBudgetError("gpt-4.1", "length", 8192, "AI Gateway returned no usable edit for WorkUnit i1");
      }
      edits += 1;
      return { "src/a/x.ts": `export const x = '${ctx.model ?? "base"}-${edits}';\n` };
    });
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "first" },
        { type: "edit", itemId: "i1", instruction: "second" },
        { type: "edit", itemId: "i1", instruction: "third" },
      ]),
      executor,
      escalationModels: ["gpt-4.1", "gpt-5"],
    });
    await w1.join();
    for (let i = 0; i < 4; i += 1) await w1.step();
    // Never the top rung for a large item's first edits: the middle rung, then the base model.
    expect(executor.contexts.map((c) => c.model)).toEqual(["gpt-4.1", undefined, "gpt-4.1", undefined, "gpt-4.1", undefined]);
    const log = await env.log();
    expect(log.messages.filter((m) => m.type === "push.announced" && m.from === "w1")).toHaveLength(3);
    // Three spent budgets on one item are model failures, not failed edits: no struggling report.
    expect(log.messages.filter((m) => m.type === "item.struggling")).toHaveLength(0);
    expect(env.turns.filter((t) => t.code === "EXECUTOR_FAILED")).toHaveLength(0);
    expect(w1.editModels).toHaveLength(3);
    expect(w1.editModels[0]).toMatchObject({ item: "i1", model: "base", budgetFallbackFrom: "gpt-4.1 (finish_reason: length)" });
    expect(log.messages.find((m) => m.type === "push.announced")!.rationale).toMatch(/model: base, after gpt-4\.1 \(finish_reason: length\) spent its budget/);
  });

  it("the top rung runs a second fix attempt; a spent budget there falls back to the next model down for the same edit", async () => {
    const env = await setup();
    let calls = 0;
    const executor = new RecordingExecutor((ctx): Record<string, string> => {
      calls += 1;
      if (ctx.model === "gpt-5") {
        throw new ModelBudgetError("gpt-5", "length", 32768, "AI Gateway returned no usable edit for WorkUnit i1");
      }
      return { "src/a/x.ts": `export const x = '${ctx.model ?? "base"}-${calls}';\n` };
    });
    const w1 = env.agent("w1", {
      transport: scripted([
        { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
        { type: "edit", itemId: "i1", instruction: "first" },
        { type: "edit", itemId: "i1", instruction: "fix one" },
        { type: "edit", itemId: "i1", instruction: "fix two" },
      ]),
      executor,
      escalationModels: ["gpt-4.1", "gpt-5"],
      fetchRevision: async () => undefined,
    });
    await w1.join();
    await w1.step();
    await w1.step();
    const fail = async () => {
      const pushes = (await env.log()).messages.filter((m) => m.type === "push.announced");
      const rev = await env.operator.recordRevision({
        commit: `bad${pushes.length}`,
        gate: "fail",
        merged: [(pushes.at(-1)!.payload as { commit: string }).commit],
        failing: { output: "not ok 1 - src/a/x.ts is wrong", items: ["i1"] },
      });
      expect(rev.ok).toBe(true);
    };
    await fail();
    for (let i = 0; i < 3 && executor.contexts.length < 2; i += 1) await w1.step();
    await fail();
    for (let i = 0; i < 3 && executor.contexts.length < 4; i += 1) await w1.step();
    expect(executor.contexts.map((c) => c.model)).toEqual([undefined, "gpt-4.1", "gpt-5", "gpt-4.1"]);
    const log = await env.log();
    const fixPushes = log.messages.filter((m) => m.type === "push.announced" && m.from === "w1");
    expect(fixPushes).toHaveLength(3);
    expect(w1.editModels.at(-1)).toMatchObject({ model: "gpt-4.1", why: "its first fix already failed", budgetFallbackFrom: "gpt-5 (finish_reason: length)" });
    // Any struggling report is for the failing revision, never for failed edits.
    for (const m of log.messages.filter((x) => x.type === "item.struggling")) {
      expect(m.payload).toMatchObject({ reason: "failing-revision", failedEdits: 0 });
    }
  });

  it("a fix request answered with a wait (or an invalid reply) after proposing done is re-cued at once, bounded, with the fix stated plainly", async () => {
    const env = await setup();
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 1;\n" }));
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "first" },
      { type: "propose_done", itemId: "i1" },
      ...Array.from({ length: 6 }, () => ({ type: "wait" as const, reason: "waiting for the integration of my proposed done" })),
    ]);
    const w1 = env.agent("w1", { transport, executor, fetchRevision: async () => undefined });
    await w1.join();
    for (let i = 0; i < 3; i += 1) await w1.step();
    const push = (await env.log()).messages.find((m) => m.type === "push.announced")!;
    const rev = await env.operator.recordRevision({
      commit: "badc0de",
      gate: "fail",
      merged: [(push.payload as { commit: string }).commit],
      failing: { output: "src/a/x.ts(1,14): error TS2339: Property 'user' does not exist on type 'Ctx'.", items: ["i1"] },
    });
    expect(rev.ok && rev.appended.map((m) => m.type)).toEqual(["integrated.rev", "fix.requested"]);
    const results: string[] = [];
    for (let i = 0; i < 5; i += 1) results.push(await w1.step());
    // The fix request wakes it; each wait is re-cued at once (MAX_FIX_CUES = 2), then it idles.
    expect(results).toEqual(["acted", "acted", "acted", "idle", "idle"]);
    const digestFix = (transport.inputs.at(-1)!.digest as BoardDigest).claims.find((c) => c.item === "i1")!.fix!;
    expect(digestFix.instruction).toMatch(/FAILED the gate and implicates this item.*done proposal does not complete it/);
    const cued = transport.inputs.filter((i) => i.capsule.evidence.some((e) => /^FIX REQUIRED: revision 1 failed the gate and implicates my item i1/.test(e)));
    expect(cued).toHaveLength(2);
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


describe("waiting on others (arbitration revision 3)", () => {
  /** w1 claims i1 and pushes for it under a claim cap of 1; the engine gates the push in a FAILING revision. */
  async function gatedFailing(implicated: readonly string[], then: readonly AgentAction[]) {
    const env = await setup({ rules: { maxActiveClaims: 1, arbitration: 3 } });
    const executor = new RecordingExecutor(() => ({ "src/a/x.ts": "export const x = 'w1';\n" }));
    const transport = scripted([
      { type: "claim", itemId: "i1", intent: { read: [], write: ["src/a/**"] } },
      { type: "edit", itemId: "i1", instruction: "go" },
      { type: "wait", reason: "my push waits for the gate" },
      ...then,
    ]);
    const w1 = env.agent("w1", { transport, executor, fetchRevision: async () => undefined });
    await w1.join();
    const before: string[] = [];
    for (let i = 0; i < 4; i += 1) before.push(await w1.step());
    expect(before).toEqual(["acted", "acted", "acted", "idle"]); // holds i1 with its push waiting for the gate
    const push = (await env.log()).messages.find((m) => m.type === "push.announced" && m.from === "w1")!;
    const rev = await env.operator.recordRevision({
      commit: "badc0de",
      gate: "fail",
      merged: [(push.payload as { commit: string }).commit],
      failing: { output: "not ok 1 - src/b/y.ts is wrong", items: [...implicated], ...(implicated.length === 0 ? { outstanding: ["i2"] } : {}) },
    });
    expect(rev.ok).toBe(true);
    return { env, w1, transport };
  }

  it("a holder whose gated push is not implicated by a failing revision is free: it is nudged to claim and its claim is granted", async () => {
    const { env, w1, transport } = await gatedFailing([], [{ type: "claim", itemId: "i2", intent: { read: [], write: ["src/b/**"] } }]);
    expect(env.turns.at(-1)).toMatchObject({ action: { type: "wait" } }); // its last turn was a wait
    expect(await w1.step()).toBe("acted");
    const input = transport.inputs.at(-1)!;
    const digest = input.digest as BoardDigest;
    expect(digest.claimCap).toBeUndefined();
    expect(digest.claims.find((c) => c.item === "i1")!.wait?.reason.kind).toBe("waiting-on-others");
    expect(input.capsule.evidence.at(-1)).toMatch(/waiting on others.*claim one now/);
    expect(env.turns.at(-1)).toMatchObject({ action: { type: "claim", itemId: "i2" }, outcome: "posted" });
    const state = (await env.log()).state;
    expect(state.items.i2).toMatchObject({ status: "claimed", owner: "w1" });
  });

  it("a holder implicated by the failing revision owes a fix: it is not free, gets no claim nudge, and a claim is refused at the cap", async () => {
    const { env, w1, transport } = await gatedFailing(["i1"], [{ type: "claim", itemId: "i2", intent: { read: [], write: ["src/b/**"] } }]);
    expect(await w1.step()).toBe("acted"); // the fix request wakes it
    const input = transport.inputs.at(-1)!;
    const digest = input.digest as BoardDigest;
    expect(digest.claimCap).toBeDefined();
    expect(digest.claims.find((c) => c.item === "i1")!.fix).toBeDefined();
    expect(digest.claims.find((c) => c.item === "i1")!.wait?.reason.kind).not.toBe("waiting-on-others");
    expect(input.capsule.evidence.some((e) => /claim one now/.test(e))).toBe(false);
    expect(env.turns.at(-1)).toMatchObject({ action: { type: "claim", itemId: "i2" }, outcome: "rejected", code: "CLAIM_CAP" });
    expect((await env.log()).state.items.i2!.status).toBe("open");
  });
});

describe("help forks that did not start where the requester is", () => {
  it("a fork response with a base mismatch is recorded on help.offered (no grant taken), never silently used", async () => {
    const env = await setup();
    const requester = await env.operator.join("w2", { role: "worker", workspaceTtlSeconds: 600 });
    expect(requester.ok).toBe(true);
    const token = requester.ok ? requester.token : "";
    const gitUrl = requester.ok && requester.workspace ? requester.workspace.gitUrl : "";
    expect((await env.rawPost(token, { type: "item.claimed", payload: { item: "i2", intent: { write: ["src/b/**"] } } })).status).toBe(201);
    expect((await env.rawPost(token, { type: "help.requested", payload: { request: "h1", item: "i2", need: "hands", scope: ["src/b/y.ts"] } })).status).toBe(201);
    const transport = scripted([{ type: "message", kind: "reply", payload: { requestId: "h1" }, rationale: "taking it" }]);
    const helper = env.agent("w1", {
      transport,
      // The operator's fork read back a head that is not the requester's state.
      forkForHelp: async () => ({
        ok: true,
        forkOf: "w2",
        workspaceId: "f1",
        workspaceName: `${ID}--help-h1`,
        gitUrl,
        defaultBranch: "main",
        backend: "local-filesystem",
        fallback: false,
        tokenId: "t1",
        token: "fork-token-123456",
        tokenExpiresAt: "2026-01-01T01:00:00.000Z",
        baseMismatch: { expected: "aaaaaaa", realized: "bbbbbbb" },
      }),
    });
    await helper.join();
    expect(await helper.step()).toBe("acted");
    const offer = (await env.log()).messages.find((m) => m.type === "help.offered")!;
    expect(offer).toMatchObject({ from: "w1", payload: { request: "h1", forkOf: "w2", baseMismatch: { expected: "aaaaaaa", realized: "bbbbbbb" } } });
    expect(offer.rationale).toMatch(/started at bbbbbbb, not at its push aaaaaaa/);
    const state = (await env.log()).state;
    expect(state.help.h1!.grant).toBeUndefined();
    expect(state.help.h1!.forkMismatches).toEqual([expect.objectContaining({ agent: "w1", expected: "aaaaaaa", realized: "bbbbbbb" })]);
  });
});

describe("held-work and question cues", () => {
  it("the driver's held-work cue names what the holder must act on: a regressed push, a left-out push, a fix request, or no push", () => {
    const base = { objective: "o", intent: { read: [], write: ["src/a/**"] }, doneProposed: false };
    const digest = {
      claims: [
        { ...base, item: "reg", regressed: { commit: "abcdef1234567890", rev: 4, from: "x", to: "y", evidence: [], instruction: "" } },
        { ...base, item: "out", excluded: { commit: "1234567890abcdef", reason: "merge conflict on src/a/x.ts", instruction: "" } },
        { ...base, item: "fix", fix: { n: 7, attempt: 1, instruction: "" } },
        { ...base, item: "idle" },
      ],
    } as unknown as BoardDigest;
    const cue = heldWorkCue(digest, ["reg", "out", "fix", "idle"]);
    expect(cue).toMatch(/^HELD WORK: the board went quiet and I hold idle with no push: edit it now/);
    expect(cue).toMatch(/my push abcdef1234 for reg made revision 4 worse \(claims\.regressed has the evidence\): push a fix now or hand it off/);
    expect(cue).toMatch(/my push 1234567890 for out was left out of integration \(merge conflict on src\/a\/x\.ts\): push a fix now or hand it off/);
    expect(cue).toMatch(/revision 7 failed and implicates fix: push a fix now \(claims\.fix\) or hand it off/);
    expect(heldWorkCue(digest, ["reg"])).toMatch(/^HELD WORK: the board went quiet and my push abcdef1234 for reg made revision 4 worse/);
    expect(heldWorkCue(digest, ["reg"])).not.toMatch(/with no push/);
  });

  it("offer_help is not offered to an agent with no other agent's busy item (it could only name itself)", async () => {
    const env = await setup();
    const transport = scripted([{ type: "offer_help", itemId: "i1", toAgent: "w1", why: "me" }]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    expect(await w1.step()).toBe("acted");
    expect(transport.inputs[0]!.allowed).not.toContain("offer_help");
  });

  it("revision 6: a question addressed to an agent wakes it a bounded number of times until it replies", async () => {
    const env = await setup({ rules: { arbitration: 6 } });
    const transport = scripted([]);
    const w1 = env.agent("w1", { transport });
    await w1.join();
    await w1.step(); // first look after joining
    const steps = transport.inputs.length;
    const w2 = await env.operator.join("w2", { role: "worker" });
    const token = w2.ok ? w2.token : "";
    expect((await env.rawPost(token, { type: "item.claimed", payload: { item: "i2", intent: { write: ["src/b/**"] } } })).status).toBe(201);
    expect(
      (await env.rawPost(token, { type: "help.requested", payload: { request: "q1", item: "i2", need: "where-is-shared-typed" }, to: ["w1"] })).status,
    ).toBe(201);
    let acted = 0;
    while ((await w1.step()) === "acted" && acted < 20) acted += 1;
    expect(acted).toBeLessThan(20);
    expect(transport.inputs.length).toBeGreaterThan(steps);
    expect((transport.inputs.at(-1)!.digest as BoardDigest).questions?.map((q) => q.request)).toEqual(["q1"]);
    // Bounded: one cue per turn it woke for, MAX_QUESTION_CUES in all; then an unanswered question no longer wakes it.
    const cues = transport.inputs.at(-1)!.capsule.evidence.filter((e) =>
      /^QUESTION FOR ME: w2 asked you about i2 \(where-is-shared-typed\): answer it with message kind reply \{requestId: q1\}/.test(e),
    );
    expect(cues).toHaveLength(MAX_QUESTION_CUES);
    expect(await w1.step()).toBe("idle");
  });
});

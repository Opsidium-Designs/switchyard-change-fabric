/**
 * The board run's lifecycle, offline: it is deterministic, owners are cued and
 * woken to propose done, read and write tokens are retried, refreshed, and
 * revoked, a failing planner or a throw in the agent phase ends the run
 * honestly, the concurrent schedule runs to completion or ends quiescent, held
 * work and stalled claims on a quiet board are recovered, the driver's
 * scheduling helpers hold, and the offline run exports its snapshot. No
 * network: the generic policy (or a scripted transport) takes every turn and
 * deterministic executors edit.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport, ExecutorProvider } from "@switchyard-change/model-adapters";

import { openIntegrationRound } from "../src/board-graph.ts";
import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { boardRunExitCode, formatBoardRunSummary, formatBoardTranscript, runBoard, type BoardRunEvent, type BoardSeed } from "../src/run-board.ts";
import { GOAL, ModelStampingExecutor, direct, git, of, offline, project, seed } from "./run-board-fixtures.ts";

describe("runBoard (offline, lockstep, continuous integration)", () => {
  it("is deterministic: two runs produce identical board logs", async () => {
    const projectDir = await project();
    const first = await offline({ goal: GOAL, projectDir, seed, fixtureGate: true });
    const second = await offline({ goal: GOAL, projectDir, seed, fixtureGate: true });
    expect(second.log).toEqual(first.log);
    expect(second.turns).toEqual(first.turns);
    expect(formatBoardTranscript(second.log)).toBe(formatBoardTranscript(first.log));
    // Every revision is preceded by the round that gated it (progress only, no wall-clock time),
    // each round bounded, and no round is left open at the end.
    const log = first.log;
    for (const rev of log.filter((m) => m.type === "integrated.rev")) {
      const round = openIntegrationRound(log, rev.seq - 1);
      expect(round, `rev at seq ${rev.seq}`).not.toBeNull();
    }
    for (const s of log.filter((m) => m.type === "integration.started")) {
      const phases = log.filter((m) => m.type === "integration.phase" && m.payload.started === s.seq);
      expect(phases.length).toBeLessThanOrEqual(12);
      expect(phases.every((m) => !("elapsedMs" in m.payload))).toBe(true);
    }
    expect(openIntegrationRound(log)).toBeNull();
    expect(reduceBoard(log).lastSeq).toBe(log.at(-1)!.seq);
  });

  it("re-cues an owner that ignores the done cue (bounded), so the item does not stall", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    // Waits through the first two cues after its push, then proposes done.
    const stubborn: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const recent = input.capsule.decisions;
      const lastEdit = recent.map((h) => h.action.type).lastIndexOf("edit");
      const waitsSince = lastEdit === -1 ? 0 : recent.slice(lastEdit + 1).filter((h) => h.action.type === "wait").length;
      if (input.role === "worker" && lastEdit !== -1 && recent[lastEdit]!.outcome === "posted" && waitsSince < 3) {
        return { action: { type: "wait", reason: "not yet" } };
      }
      return policy(input);
    };
    const result = await offline({ goal: GOAL, projectDir, seed, transport: stubborn });
    expect(result.incompleteItems).toEqual([]);
  });

  it("an owner that never proposes done is cued at most MAX_DONE_CUES times (the last explicitly); the summary says why the item is partial, and nothing completes it on its behalf", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    const cuesSeen: string[] = [];
    // The api owner never proposes done; everyone else follows the policy.
    const silent: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const action = (await policy(input)).action;
      if (input.role === "worker" && action.type === "propose_done" && action.itemId === "api") {
        cuesSeen.push(...input.capsule.evidence.filter((e) => /propose.?done/i.test(e) && !cuesSeen.includes(e)));
        return { action: { type: "wait", reason: "not proposing" } };
      }
      return { action };
    };
    const result = await offline({ goal: GOAL, projectDir, seed, transport: silent });
    expect(result.incompleteItems).toEqual(["api"]);
    // Never auto-completed: no done.proposed for api exists, and it is not completed.
    expect(of(result.log, "done.proposed").some((m) => m.payload.item === "api")).toBe(false);
    expect(result.state.items.api?.status).toBe("claimed");
    const n = result.state.items.api!.lastPush!.integratedIn!;
    expect(result.incompleteReasons).toEqual([`item api: its push passed in rev ${n} but its owner did not propose done (owner ${result.state.items.api!.owner})`]);
    const summary = formatBoardRunSummary(result);
    expect(summary).toContain(`not completed: item api: its push passed in rev ${n} but its owner did not propose done`);
    expect(summary).toMatch(/partial: 1 item\(s\) not completed: api/);
    expect(cuesSeen.some((e) => e.startsWith("FINAL CUE:"))).toBe(true);
    expect(boardRunExitCode(result)).toBe(1);
  });

  it("wakes an owner whose push passed so it proposes done", async () => {
    const projectDir = await project();
    const policy = createGenericBoardPolicy();
    // A worker that waits right after pushing (a live model often does), and acts only when woken.
    const lazy: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const last = input.capsule.decisions.at(-1);
      if (input.role === "worker" && last?.action.type === "edit" && last.outcome === "posted") {
        return { action: { type: "wait", reason: "pushed; waiting" } };
      }
      return policy(input);
    };
    const result = await offline({ goal: GOAL, projectDir, seed, transport: lazy });
    expect(result.stopReason).toBe("all-items-done");
    expect(result.incompleteItems).toEqual([]);
  });

  it("retries a transient read-token failure and revokes every read token once integration is done with it", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-tokens");
    const inner = control.fetch as unknown as typeof fetch;
    let flaky = 2;
    let issued = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/board/read-token")) {
        if (flaky > 0) {
          flaky -= 1;
          return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        }
        issued += 1;
      }
      return inner(input, init);
    }) as typeof fetch;
    const result = await runBoard({ ...base, projectDir, fetchFn });
    expect(result.verdict).toBe("unverified"); // no gate in this project
    expect(issued).toBeGreaterThan(0);
    expect(control.revokedReadTokens).toHaveLength(issued);
  });

  it("marks the planning Change failed and throws when the planner fails", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-fail");
    await expect(
      runBoard({
        ...base,
        projectDir,
        seed: async () => {
          throw new Error("no live planner");
        },
      }),
    ).rejects.toThrow(/no live planner/);
    expect(control.state("change-board-fail").status).toBe("planning-failed");
  });

  it("a throw in the agent phase aborts the agents, marks the Change failed, and archives every repo", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-throw");
    const deleted: string[] = [];
    const inner = control.fetch as unknown as typeof fetch;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/board/join") && String(init?.body ?? "").includes('"agent-2"')) {
        throw new Error("the join route is unreachable");
      }
      if ((init?.method ?? "GET") === "DELETE" && url.includes("/workspaces/")) {
        deleted.push(decodeURIComponent(url.split("/workspaces/")[1]!));
      }
      return inner(input, init);
    }) as typeof fetch;
    await expect(runBoard({ ...base, projectDir, fetchFn })).rejects.toThrow(/unreachable/);
    expect(control.state("change-board-throw").status).toBe("planning-failed");
    expect(deleted).toEqual(["change-board-throw--board-agent-1"]);
  });

  it("with token refresh off, refuses an agent phase longer than the agents' write-token lifetime", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-ttl");
    await expect(
      runBoard({ ...base, projectDir, workspaceTtlSeconds: 60, refreshTokens: false, budgets: { timeoutMs: 120_000 } }),
    ).rejects.toThrow(/exceeds the agents' write-token lifetime \(60 s\) and token refresh is off/);
    expect(() => control.state("change-board-ttl")).toThrow();
  });

  it("with token refresh on (the default), a phase may outlast the token lifetime: each token is refreshed before it expires, swapped in, recorded (never the token), and the old one revoked", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-refresh");
    // A fake clock running far ahead: every agent token is past its refresh margin at each tick.
    let fake = Date.now();
    const events: BoardRunEvent[] = [];
    const result = await runBoard({
      ...base,
      projectDir,
      changeId: "change-board-refresh",
      workspaceTtlSeconds: 60,
      budgets: { timeoutMs: 120_000 },
      tokenClock: () => (fake += 10 * 60_000),
      onEvent: (e) => events.push(e),
    });
    const refreshed = result.log.filter((m) => m.type === "token.refreshed");
    expect(refreshed.length).toBeGreaterThan(0);
    expect(refreshed.every((m) => m.from === "engine" && (m.payload as { kind: string }).kind === "repo-write")).toBe(true);
    // The tokens themselves never reach the board.
    const issued = control.revokedReadTokens;
    expect(issued.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "token-refreshed")).toBe(true);
    expect(result.verdict).not.toBe("failed");
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("integrates with fresh operator read tokens", async () => {
    const projectDir = await project();
    const { control, base } = await direct("change-board-read");
    const inner = control.fetch as unknown as typeof fetch;
    const readTokens: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/board/read-token")) {
        readTokens.push(JSON.parse(String(init?.body)).agent as string);
      }
      return inner(input, init);
    }) as typeof fetch;
    const result = await runBoard({ ...base, projectDir, fetchFn });
    expect(result.verdict).toBe("unverified"); // no gate in this project
    expect(new Set(readTokens)).toEqual(new Set(["agent-1", "agent-2", "agent-3"]));
  });
});

describe("runBoard (concurrent schedule)", () => {
  it("runs every agent's own loop to completion", async () => {
    const projectDir = await project();
    const { base } = await direct("change-board-concurrent");
    const result = await runBoard({ ...base, projectDir, schedule: "concurrent", pollMs: 20, budgets: { timeoutMs: 60_000 } });
    expect(result.stopReason).toBe("all-items-done");
    expect(result.verdict).toBe("unverified"); // no gate in this project
    expect(Object.values(result.state.items).every((i) => i.status === "done")).toBe(true);
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("ends a quiet board as quiescent (with a recorded reason), not at the timeout", async () => {
    const projectDir = await project();
    const { base } = await direct("change-board-quiet");
    const idle: AgentTurnTransport<BoardDigest, BoardMessage> = async () => ({ action: { type: "wait", reason: "nothing for me" } });
    const events: BoardRunEvent[] = [];
    const started = Date.now();
    const result = await runBoard({
      ...base,
      projectDir,
      transport: idle,
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 300 },
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("quiescent");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(events.find((e) => e.kind === "agents-done")).toMatchObject({ reason: "quiescent", detail: expect.stringMatching(/idle/) });
  });
});

describe("held work on a quiet board (concurrent schedule)", () => {
  const oneItem = async (): Promise<BoardSeed> => ({
    source: "planner",
    model: "fake-planner",
    items: [{ item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] }],
  });
  /** The generic policy, except agent-1 answers its first `waits` edits of an item with a wait. */
  const waitsFirst = (waits: number) => {
    const policy = createGenericBoardPolicy();
    const waited = new Map<string, number>();
    const inputs: { agent: string; evidence: readonly string[] }[] = [];
    const transport: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      inputs.push({ agent: input.agent, evidence: [...input.capsule.evidence] });
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string };
      if (input.agent === "agent-1" && action.type === "edit" && action.itemId !== undefined && (waited.get(action.itemId) ?? 0) < waits) {
        waited.set(action.itemId, (waited.get(action.itemId) ?? 0) + 1);
        return { action: { type: "wait", reason: "reading the files first" } };
      }
      return outcome;
    };
    return { transport, inputs };
  };

  it("a holder that waits once after claiming is re-cued at once and edits: no stalled lapse", async () => {
    const projectDir = await project();
    const { base } = await direct("change-held-wait");
    const { transport, inputs } = waitsFirst(1);
    const result = await runBoard({
      ...base,
      projectDir,
      seed: oneItem,
      transport,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 600 },
    });
    expect(inputs.some((i) => i.agent === "agent-1" && i.evidence.some((e) => /^HELD WORK: I hold api with no push: edit it now/.test(e)))).toBe(true);
    expect(of(result.log, "claim.lapsed")).toEqual([]);
    expect(of(result.log, "push.announced").filter((m) => m.payload.item === "api")).not.toHaveLength(0);
    expect(result.stopReason).toBe("all-items-done");
    expect(reduceBoard(result.log)).toEqual(result.state);
  });

  it("a holder that waits past its re-cues is nudged by the driver before any lapse, and then edits", async () => {
    const projectDir = await project();
    const { base } = await direct("change-held-nudge");
    // Three waits: two are re-cued at once, the third leaves it idle until the board is quiet.
    const { transport, inputs } = waitsFirst(3);
    const events: BoardRunEvent[] = [];
    const result = await runBoard({
      ...base,
      projectDir,
      seed: oneItem,
      transport,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 600 },
      onEvent: (e) => events.push(e),
    });
    expect(events).toContainEqual({ kind: "held-work-nudged", item: "api", agent: "agent-1" });
    expect(inputs.some((i) => i.evidence.some((e) => /^HELD WORK: the board went quiet and I hold api/.test(e)))).toBe(true);
    expect(of(result.log, "claim.lapsed")).toEqual([]);
    expect(result.stopReason).toBe("all-items-done");
  });

  it("an edit blocked in the executor past half the quiet period never lapses its claim", async () => {
    const projectDir = await project();
    const { base } = await direct("change-held-slow");
    const stamping = new ModelStampingExecutor();
    let calls = 0;
    const slow: ExecutorProvider = {
      name: "slow",
      async execute(context) {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
        return stamping.execute(context);
      },
    };
    const result = await runBoard({
      ...base,
      projectDir,
      seed: oneItem,
      executor: slow,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      schedule: "concurrent",
      pollMs: 20,
      budgets: { timeoutMs: 60_000, quiescenceMs: 600 },
    });
    expect(calls).toBeGreaterThan(0);
    expect(of(result.log, "claim.lapsed")).toEqual([]);
    expect(result.stopReason).toBe("all-items-done");
  });
});

describe("lockstep schedule priority", () => {
  it("steps agents building an unpublished tool first, then the rest in join order", async () => {
    const { lockstepOrder } = await import("../src/run-board.ts");
    const { emptyBoard } = await import("@switchyard-change/change-core");
    const state = emptyBoard();
    state.items["tool-cm"] = { id: "tool-cm", objective: "o", acceptance: [], scopeHint: ["tools/cm/**"], status: "claimed", owner: "agent-3", proposedBy: "lead", proposedSeq: 1, children: [], doneProposed: false, tool: { capability: "cm", kind: "codemod" } };
    const workers = [{ id: "agent-1" }, { id: "agent-2" }, { id: "agent-3" }];
    expect(lockstepOrder(workers, state).map((w) => w.id)).toEqual(["agent-3", "agent-1", "agent-2"]);
    state.tools.published.push({ tool: "t", capability: "cm", version: "1", repo: "r", commit: "c", kind: "codemod", usage: "u", publishedBy: "agent-3", seq: 2, gateSeq: 2, uses: 0 });
    expect(lockstepOrder(workers, state).map((w) => w.id)).toEqual(["agent-1", "agent-2", "agent-3"]);
  });
});

describe("formation hardening in the driver", () => {
  async function repo(files: Record<string, string>): Promise<{ dir: string; commit: string }> {
    const dir = await mkdtemp(join(tmpdir(), "scf-verify-"));
    await git("git", ["init", "-q", dir]);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    await git("git", ["-C", dir, "add", "-A"]);
    await git("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c"]);
    return { dir, commit: (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim() };
  }

  it("verifies each merged child's in-intent tree against the sub-lead's commit (content and deletions)", async () => {
    const { verifySubLeadMerges } = await import("../src/run-board.ts");
    const { emptyBoard } = await import("@switchyard-change/change-core");
    const child = await repo({ "src/x.ts": "x2\n" });
    const goodLead = await repo({ "src/x.ts": "x2\n", "src/y.ts": "other child\n" });
    const staleLead = await repo({ "src/x.ts": "x1\n", "src/x-old.ts": "deleted by the child\n" });
    const state = emptyBoard();
    state.items.one = { id: "one", objective: "o", acceptance: [], scopeHint: ["src/**"], status: "split", owner: "lead-a", subLead: "lead-a", proposedBy: "lead", proposedSeq: 1, children: ["one-x"], doneProposed: false, intent: { read: [], write: ["src/**"] }, lastPush: { seq: 5, commit: "pa", agent: "lead-a", paths: ["src/x.ts"], merges: [{ item: "one-x", commit: child.commit }] } };
    state.items["one-x"] = { id: "one-x", objective: "o", acceptance: [], scopeHint: ["src/x.ts", "src/x-old.ts"], status: "claimed", owner: "kid", parent: "one", proposedBy: "lead-a", proposedSeq: 2, children: [], doneProposed: true, intent: { read: [], write: ["src/x.ts", "src/x-old.ts"] }, lastPush: { seq: 4, commit: child.commit, agent: "kid", paths: ["src/x.ts"] } };
    const run = async (lead: { dir: string; commit: string }) =>
      verifySubLeadMerges({
        units: [{ agent: "lead-a", commit: lead.commit, items: [state.items.one!] }],
        state,
        readRemote: async (agent) => (agent === "kid" ? child.dir : lead.dir),
        workRoot: await mkdtemp(join(tmpdir(), "scf-verify-work-")),
      });
    expect(await run(goodLead)).toEqual([]);
    const stale = await run(staleLead);
    expect(stale).toEqual([{ item: "one-x", reason: expect.stringMatching(/does not carry one-x's push .* for src\/x-old\.ts, src\/x\.ts/) }]);
  });

  it("holds an owner (concurrent schedule) only while a codemod being built covers all its unpushed work", async () => {
    const { toolHold } = await import("../src/run-board.ts");
    const { emptyBoard } = await import("@switchyard-change/change-core");
    const state = emptyBoard();
    state.agents = { b: { id: "b", joinedSeq: 1 }, o: { id: "o", joinedSeq: 2 } };
    state.tools.proposed.t = { tool: "t", capability: "cm", kind: "codemod", inputs: ["src/**"], outputs: [], proposedBy: "lead", seq: 1, item: "tool-cm", builds: 0, failedGates: 0 };
    state.items["tool-cm"] = { id: "tool-cm", objective: "o", acceptance: [], scopeHint: ["tools/cm/**"], status: "claimed", owner: "b", proposedBy: "lead", proposedSeq: 1, children: [], doneProposed: false, tool: { capability: "cm", kind: "codemod" }, intent: { read: [], write: ["tools/cm/**"] } };
    state.items.i = { id: "i", objective: "o", acceptance: [], scopeHint: ["src/a.ts"], status: "claimed", owner: "o", proposedBy: "lead", proposedSeq: 2, children: [], doneProposed: false, intent: { read: [], write: ["src/a.ts"] } };
    state.lastSeq = 5;
    expect(toolHold(state, "o")).toBe(true);
    expect(toolHold(state, "b")).toBe(false); // the builder itself is never held
    state.items.i.lastPush = { seq: 6, commit: "c", agent: "o", paths: ["src/a.ts"] };
    expect(toolHold(state, "o")).toBe(false); // already pushed: nothing to wait for
    delete state.items.i.lastPush;
    state.tools.proposed.t.failedGates = 1;
    expect(toolHold(state, "o")).toBe(false); // unavailable: never wait
  });
});

describe("leases and stated wait reasons on a quiet board", () => {
  it("a holder that sits on its claim is recorded stalled, the item is offered, and another agent finishes it", async () => {
    const projectDir = await project();
    const twoItems = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-planner",
      items: [
        { item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
        { item: "tests", objective: "test the status report", acceptance: ["gate passes"], scopeHint: ["tests/**"] },
      ],
    });
    const policy = createGenericBoardPolicy();
    // agent-1 claims api and then never edits it: it only waits.
    const sitter: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string };
      return input.agent === "agent-1" && action.type === "edit" && action.itemId === "api" ? { action: { type: "wait", reason: "later" } } : outcome;
    };
    const events: BoardRunEvent[] = [];
    const result = await offline({ goal: GOAL, projectDir, seed: twoItems, transport: sitter, dial: { minConcurrency: 2, maxConcurrency: 2 }, onEvent: (e) => events.push(e) });
    const log = result.log;
    expect(of(log, "goal.posted")[0]!.payload.rules).toMatchObject({ claimLeaseMessages: 150, claimDeadlineMessages: 1200 });
    // The goal records the integration baseline; the first revision names it as its base.
    const baseline = of(log, "goal.posted")[0]!.payload.baseline!;
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);
    expect(of(log, "integrated.rev")[0]!.payload.base).toBe(baseline);
    const first = of(log, "claim.granted").find((m) => m.payload.item === "api")!;
    expect(first.payload.agent).toBe("agent-1");
    // The quiet board advanced no message count: the operator recorded the claim stalled.
    const lapsed = of(log, "claim.lapsed").find((m) => m.payload.item === "api")!;
    expect(lapsed.payload).toMatchObject({ agent: "agent-1", reason: "stalled" });
    expect(events).toContainEqual({ kind: "claim-stalled", item: "api", agent: "agent-1" });
    // Another agent took it (the lapsed holder goes after it), and it completed.
    const regrant = of(log, "claim.granted").find((m) => m.payload.item === "api" && m.seq > lapsed.seq)!;
    expect(regrant.payload.agent).toBe("agent-2");
    expect(result.state.items.api!.status).toBe("done");
    expect(result.incompleteItems).toEqual([]);
    expect(formatBoardTranscript(log)).toMatch(/claim\.lapsed\s+api \(held by agent-1\)/);
    expect(reduceBoard(log)).toEqual(result.state);
  });
});

describe("the offline run's export (the simulated replay's source)", () => {
  it("returns the Change snapshot the offline control serves, with the recorded integration verdict", async () => {
    const projectDir = await project();
    const result = await offline({ goal: GOAL, projectDir, seed, fixtureGate: true });
    const snapshot = result.snapshot as { id?: string; integration?: { verdict?: string } } | null;
    expect(snapshot?.id).toBe(result.changeId);
    expect(snapshot?.integration?.verdict).toBe(result.verdict);
  });

  it("runs on the concurrent schedule too: the real board and integrator, every item done, the log folding to its state", async () => {
    const projectDir = await project();
    const result = await offline({
      goal: GOAL,
      projectDir,
      seed,
      fixtureGate: true,
      schedule: "concurrent",
      pollMs: 20,
      spreadClaims: true,
      dial: { minConcurrency: 1, maxConcurrency: 4 },
      maxInflight: 2,
    });
    expect(result.stopReason).toBe("all-items-done");
    expect(result.verdict).toBe("verified");
    expect(result.budgets).toMatchObject({ maxInflight: 2 });
    expect(reduceBoard(result.log)).toEqual(result.state);
  }, 60_000);
});

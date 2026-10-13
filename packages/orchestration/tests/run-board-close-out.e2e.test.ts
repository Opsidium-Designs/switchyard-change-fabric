/**
 * Close-out on a board run (offline, local control, a fake gate that always
 * passes): when the agent phase ends (quiescence, the timeout) after a passing
 * revision while owners whose latest push it merged have not proposed done,
 * those owners get one bounded close-out cue first. Any item still not closed
 * is closed by the ENGINE after the last gated pass, recorded as item.completed
 * closedBy engine and backed by the owner's push.announced seq; the verdict is
 * then verified and the run exits 0. An item no passing revision merged a push
 * of stays not completed, and the verdict stays partial (exit 1).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport } from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { assertBoardBacked, boardItemNodeId, buildBoardGraph } from "../src/board-graph.ts";
import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { boardRunExitCode, formatBoardRunSummary, runBoard, type BoardRunEvent, type BoardSeed } from "../src/run-board.ts";

const GOAL = "Make every module report its status";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-close-out-project-"));
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p","scripts":{}}\n',
    "src/core/a.ts": "export const a = 1;\n",
    "src/api/handler.ts": "export const handler = () => 1;\n",
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
  ],
});

/** The gate: always passes (every revision is gated and green). */
const passingGate: CommandRunner = {
  async run(): Promise<CommandOutcome> {
    return { code: 0, stdout: "ok 1 - status\n", stderr: "" };
  },
};

const CLOSE_OUT = /^CLOSE-OUT \(the agent phase is ending\): a passing revision merged my latest push for api \(rev \d+\)/;

/**
 * The generic policy, except the owner of `item` never proposes done for it
 * (it waits) unless `obeyCloseOut` and its evidence carries the close-out cue.
 * Records every close-out cue seen.
 */
function withholdsDone(item: string, obeyCloseOut: boolean) {
  const policy = createGenericBoardPolicy();
  const closeOutCues: string[] = [];
  const transport: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
    const cue = input.capsule.evidence.find((e) => e.startsWith("CLOSE-OUT"));
    if (cue !== undefined) {
      closeOutCues.push(cue);
    }
    const outcome = await policy(input);
    const action = outcome.action as { type: string; itemId?: string };
    if (input.role === "worker" && action.type === "propose_done" && action.itemId === item && !(obeyCloseOut && cue !== undefined)) {
      return { action: { type: "wait", reason: "not proposing done yet" } };
    }
    return outcome;
  };
  return { transport, closeOutCues };
}

const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

describe("close-out after a passing revision (offline, lockstep, gated)", () => {
  it("an owner that never proposes done gets a close-out cue; the engine then closes its item on its recorded push: verified, exit 0", async () => {
    const projectDir = await project();
    const { transport, closeOutCues } = withholdsDone("api", false);
    const events: BoardRunEvent[] = [];
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir,
      seed,
      transport,
      appGateCommand: ["gate"],
      verifyCommandRunner: passingGate,
      resolveContract: async () => "reject",
      onEvent: (e) => events.push(e),
    });
    const log = result.log;
    const api = result.state.items.api!;
    const owner = api.owner!;
    // The close-out cue went to the owner (once), and it still did not propose done.
    expect(events.find((e) => e.kind === "close-out-cued")).toMatchObject({ agents: [owner], items: ["api"] });
    expect(closeOutCues.some((c) => CLOSE_OUT.test(c))).toBe(true);
    expect(events.find((e) => e.kind === "close-out-ended")).toMatchObject({ proposed: [], pending: ["api"] });
    expect(of(log, "done.proposed").some((m) => m.payload.item === "api")).toBe(false);
    // The engine closed it, citing the owner's latest push.announced and the passing revision that merged it.
    const lastPush = of(log, "push.announced").filter((m) => m.payload.item === "api").at(-1)!;
    expect(lastPush.from).toBe(owner);
    const closed = of(log, "item.completed").find((m) => m.payload.item === "api")!;
    expect(closed).toMatchObject({ from: "engine", to: [owner], payload: { via: "integrated", closedBy: "engine", pushSeq: lastPush.seq } });
    const n = closed.payload.n!;
    expect(of(log, "integrated.rev").find((m) => m.payload.n === n)).toMatchObject({ payload: { gate: "pass", merged: expect.arrayContaining([lastPush.payload.commit]) } });
    expect(events.find((e) => e.kind === "engine-closed")).toMatchObject({ closes: [{ item: "api", owner, n, pushSeq: lastPush.seq, seq: closed.seq }] });
    expect(api).toMatchObject({ status: "done", completed: { n, closedBy: "engine", pushSeq: lastPush.seq, seq: closed.seq } });
    // Core was completed by its owner the usual way (no engine close).
    expect(result.state.items.core!.completed).toEqual({ n: expect.any(Number), via: "integrated" });
    // Verified and complete: exit 0, and the summary says who closed what.
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toEqual([]);
    expect(boardRunExitCode(result)).toBe(0);
    const summary = formatBoardRunSummary(result);
    expect(summary).toContain(`closed by the engine (push passed in rev ${n}, owner did not propose done): api (owner ${owner}, push #${lastPush.seq})`);
    expect(summary).not.toMatch(/partial/);
    // Replay accepts the recorded close; the graph's api node is backed by it.
    expect(reduceBoard(log)).toEqual(result.state);
    const graph = buildBoardGraph(log);
    expect(() => assertBoardBacked(graph, log)).not.toThrow();
    const node = graph.nodes.find((x) => x.id === boardItemNodeId("api"))!;
    expect(node.seqs).toEqual(expect.arrayContaining([lastPush.seq, closed.seq]));
    expect(node.tooltip).toMatch(new RegExp(`closed by the engine \\(its push #${lastPush.seq} passed in rev ${n}; the owner did not propose done\\)`));
  });

  it("an owner that answers the close-out cue proposes done itself: no engine close, every item done", async () => {
    const projectDir = await project();
    const { transport, closeOutCues } = withholdsDone("api", true);
    const events: BoardRunEvent[] = [];
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir,
      seed,
      transport,
      appGateCommand: ["gate"],
      verifyCommandRunner: passingGate,
      resolveContract: async () => "reject",
      onEvent: (e) => events.push(e),
    });
    expect(closeOutCues.some((c) => CLOSE_OUT.test(c))).toBe(true);
    expect(events.find((e) => e.kind === "close-out-ended")).toMatchObject({ proposed: ["api"], pending: [] });
    expect(events.some((e) => e.kind === "engine-closed")).toBe(false);
    expect(of(result.log, "done.proposed").some((m) => m.payload.item === "api")).toBe(true);
    expect(result.state.items.api!.completed).toEqual({ n: expect.any(Number), via: "integrated" });
    expect(result.stopReason).toBe("all-items-done");
    expect(events.find((e) => e.kind === "agents-done")).toMatchObject({ detail: expect.stringMatching(/close-out after the passing revision: cued the owner\(s\) of 1 item\(s\), 1 proposed done/) });
    expect(result.verdict).toBe("verified");
    expect(boardRunExitCode(result)).toBe(0);
  });

  it("an item no passing revision merged a push of stays not completed: the engine closes only the backed item, and the verdict stays partial (exit 1)", async () => {
    const projectDir = await project();
    const { transport: base } = withholdsDone("api", false);
    // Nobody ever takes core (claims and edits of it become waits): it never gets a push.
    const transport: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const outcome = await base(input);
      const action = outcome.action as { type: string; itemId?: string };
      if (input.role === "worker" && (action.type === "claim" || action.type === "edit") && action.itemId === "core") {
        return { action: { type: "wait", reason: "not taking core" } };
      }
      return outcome;
    };
    // api first, so the workers (claiming in plan order) take it before they reach core.
    const apiFirst = async (): Promise<BoardSeed> => ({ ...(await seed()), items: [...(await seed()).items].reverse() });
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir,
      seed: apiFirst,
      transport,
      appGateCommand: ["gate"],
      verifyCommandRunner: passingGate,
      resolveContract: async () => "reject",
    });
    const log = result.log;
    expect(of(log, "push.announced").some((m) => m.payload.item === "core")).toBe(false);
    expect(of(log, "item.completed").some((m) => m.payload.item === "core")).toBe(false);
    expect(result.state.items.core!.status).not.toBe("done");
    // The backed item is closed by the engine; the unbacked one is not.
    expect(of(log, "item.completed").find((m) => m.payload.item === "api")).toMatchObject({ payload: { closedBy: "engine" } });
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toContain("core");
    expect(result.incompleteItems).not.toContain("api");
    expect(boardRunExitCode(result)).toBe(1);
    expect(formatBoardRunSummary(result)).toMatch(/partial: \d+ item\(s\) not completed: .*core/);
    expect(reduceBoard(log)).toEqual(result.state);
  });
});

describe("close-out at the agent-phase timeout (concurrent schedule)", () => {
  it("a timeout right after a pass cues the owner who has not proposed done, holds the others, and the owner closes its item", async () => {
    const projectDir = await project();
    const root = await mkdtemp(join(tmpdir(), "scf-close-out-timeout-"));
    const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
    const { transport, closeOutCues } = withholdsDone("api", true);
    const events: BoardRunEvent[] = [];
    const result = await runBoard({
      goal: GOAL,
      changeId: "change-close-out-timeout",
      workerUrl: "http://local-control",
      fetchFn: control.fetch as unknown as typeof fetch,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      transport,
      seed,
      resolveContract: async () => "reject",
      workRoot: join(root, "work"),
      projectDir,
      appGateCommand: ["gate"],
      verifyCommandRunner: passingGate,
      schedule: "concurrent",
      pollMs: 20,
      // The timeout, not quiescence, ends the phase: the close-out window then runs.
      budgets: { timeoutMs: 12_000, quiescenceMs: 120_000, closeOutMs: 20_000 },
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.kind === "close-out-cued")).toMatchObject({ reason: "timeout", items: ["api"], agents: [result.state.items.api!.owner] });
    expect(closeOutCues.some((c) => CLOSE_OUT.test(c))).toBe(true);
    expect(events.find((e) => e.kind === "close-out-ended")).toMatchObject({ proposed: ["api"], pending: [] });
    expect(result.state.items.api!.completed).toEqual({ n: expect.any(Number), via: "integrated" });
    expect(events.some((e) => e.kind === "engine-closed")).toBe(false);
    expect(result.verdict).toBe("verified");
    expect(boardRunExitCode(result)).toBe(0);
    expect(reduceBoard(result.log)).toEqual(result.state);
  }, 60_000);
});

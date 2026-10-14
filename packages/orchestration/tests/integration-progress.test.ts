/**
 * Integration progress (integration.started / integration.phase): the
 * recorder is bounded, de-duplicated, ends an open round that recorded
 * nothing, and records nothing once abandoned; the board graph reads the open
 * round from the log alone and names it in the wait line of the pushes it
 * gates. Offline, no git.
 */
import { describe, expect, it } from "vitest";

import {
  appendBoardMessage,
  appendEngineRecord,
  appendIntegratedRev,
  emptyBoard,
  type BoardMessage,
  type BoardState,
} from "@switchyard-change/change-core";

import { assertBoardBacked, boardThread, buildBoardGraph, integrationPhaseLine, openIntegrationRound } from "../src/board-graph.ts";
import { createIntegrationProgress, MAX_INTEGRATION_PHASES, phaseDetail } from "../src/integration-progress.ts";

const AT = "2026-01-01T00:00:00.000Z";

/** A tiny board log built with the board's own append functions. */
class Log {
  state: BoardState = emptyBoard();
  readonly messages: BoardMessage[] = [];
  private take(result: { appended: readonly BoardMessage[]; state: BoardState }): BoardMessage[] {
    this.state = result.state;
    this.messages.push(...result.appended);
    return [...result.appended];
  }
  human(type: string, payload: unknown): BoardMessage[] {
    return this.take(appendBoardMessage(this.state, { kind: "human" }, { type, payload }, AT));
  }
  join(agent: string, role?: string): BoardMessage[] {
    return this.take(appendBoardMessage(this.state, { kind: "join", agent }, { type: "agent.joined", payload: role ? { role } : {} }, AT));
  }
  agent(agent: string, type: string, payload: unknown): BoardMessage[] {
    return this.take(appendBoardMessage(this.state, { kind: "agent", agent }, { type, payload }, AT));
  }
  engine(type: string, payload: Record<string, unknown>): BoardMessage[] {
    return this.take(appendEngineRecord(this.state, { type, payload }, AT));
  }
  rev(input: Record<string, unknown>): BoardMessage[] {
    return this.take(appendIntegratedRev(this.state, input, AT));
  }
}

/** A board with two pushes pending: one, two (agents a, b). */
function pending(): { log: Log; p1: number; p2: number } {
  const log = new Log();
  log.human("goal.posted", { objective: "o", rules: { arbitration: 7 } });
  log.join("lead", "lead");
  log.join("a");
  log.join("b");
  for (const item of ["one", "two", "three"]) {
    log.agent("lead", "item.proposed", { item, objective: `do ${item}`, acceptance: ["works"], scopeHint: [`src/${item}/**`] });
  }
  log.agent("a", "item.claimed", { item: "one", intent: { read: [], write: ["src/one/**"] } });
  log.agent("b", "item.claimed", { item: "two", intent: { read: [], write: ["src/two/**"] } });
  const p1 = log.agent("a", "push.announced", { item: "one", commit: "c1", paths: ["src/one/x.ts"] })[0]!.seq;
  const p2 = log.agent("b", "push.announced", { item: "two", commit: "c2", paths: ["src/two/y.ts"] })[0]!.seq;
  return { log, p1, p2 };
}

/** An operator stand-in that appends engine records to the log. */
function operator(log: Log) {
  const calls: { type: string; payload: Record<string, unknown> }[] = [];
  return {
    calls,
    async recordEngine(type: string, payload: Record<string, unknown>) {
      calls.push({ type, payload });
      try {
        return { ok: true as const, appended: log.engine(type, payload) };
      } catch (error) {
        return { ok: false as const, status: 409, code: "REFUSED", error: String(error) };
      }
    },
  };
}

const units = (log: Log) => [
  { agent: "a", items: [log.state.items.one!] },
  { agent: "b", items: [log.state.items.two!] },
];

describe("the integration progress recorder", () => {
  it("records the round, then each phase change once, bounded per round, with the elapsed time", async () => {
    const { log, p1, p2 } = pending();
    const op = operator(log);
    let t = 1000;
    const progress = createIntegrationProgress(op, { enabled: true, now: () => t });
    await progress.start({ kind: "integrate", units: units(log) });
    expect(op.calls[0]).toEqual({ type: "integration.started", payload: { kind: "integrate", pushes: [p1, p2], agents: ["a", "b"], items: ["one", "two"] } });
    const started = log.messages.at(-1)!.seq;
    progress.phase("fetch");
    progress.phase("fetch"); // a repeat is dropped
    t = 4000;
    progress.phase("gate", "npm run gate");
    for (let i = 0; i < 40; i += 1) progress.phase("candidate", `candidate ${i}`);
    await progress.flush();
    const phases = log.messages.filter((m) => m.type === "integration.phase");
    expect(phases).toHaveLength(MAX_INTEGRATION_PHASES);
    expect(phases[0]!.payload).toEqual({ started, phase: "fetch", elapsedMs: 0 });
    expect(phases[1]!.payload).toEqual({ started, phase: "gate", detail: "npm run gate", elapsedMs: 3000 });
    // A round that recorded its revision ends with it: no `ended` record.
    progress.closed();
    await progress.end("unused");
    expect(log.messages.filter((m) => m.type === "integration.phase" && m.payload.phase === "ended")).toEqual([]);
  });

  it("ends an open round that recorded nothing (why, bounded), so nothing stays in progress", async () => {
    const { log } = pending();
    const progress = createIntegrationProgress(operator(log), { enabled: true, now: null });
    await progress.start({ kind: "integrate", units: units(log) });
    progress.phase("merge");
    expect(openIntegrationRound(log.messages)).not.toBeNull();
    await progress.end(`the integrator refused: ${"x".repeat(400)}`);
    const ended = log.messages.at(-1)!;
    expect(ended.type === "integration.phase" && ended.payload.phase).toBe("ended");
    expect(ended.type === "integration.phase" && ended.payload.detail!.length).toBeLessThanOrEqual(160);
    // No clock: no elapsed time (a deterministic log).
    expect(ended.payload).not.toHaveProperty("elapsedMs");
    expect(openIntegrationRound(log.messages)).toBeNull();
  });

  it("records nothing when disabled or abandoned, and ignores a refused record", async () => {
    const { log } = pending();
    const op = operator(log);
    const off = createIntegrationProgress(op, { enabled: false });
    await off.start({ kind: "integrate", units: units(log) });
    off.phase("gate");
    await off.end("x");
    let abandoned = false;
    const on = createIntegrationProgress(op, { enabled: true, abandoned: () => abandoned });
    await on.start({ kind: "integrate", units: units(log) });
    abandoned = true;
    on.phase("gate");
    await on.end("x");
    expect(log.messages.filter((m) => m.type === "integration.phase")).toEqual([]);
    expect(log.messages.filter((m) => m.type === "integration.started")).toHaveLength(1);
    // A board that refuses the records (arbitration revision 1): no round, no phases, no throw.
    const v1 = new Log();
    v1.human("goal.posted", { objective: "o" });
    v1.join("a");
    v1.agent("a", "item.proposed", { item: "one", objective: "o", acceptance: ["x"], scopeHint: ["src/**"] });
    const refused = createIntegrationProgress(operator(v1), { enabled: true });
    await refused.start({ kind: "integrate", units: [{ agent: "a", items: [{ ...v1.state.items.one!, lastPush: { seq: 1 } } as never] }] });
    refused.phase("gate");
    await refused.end("x");
    expect(v1.messages.some((m) => m.type.startsWith("integration."))).toBe(false);
    expect(phaseDetail("a\n  b")).toBe("a b");
  });
});

describe("the open integration round, read from the log", () => {
  it("is open from integration.started until its revision, with its latest phase; the pushes it gates wait for that revision's gate", () => {
    const { log, p1, p2 } = pending();
    expect(openIntegrationRound(log.messages)).toBeNull();
    const started = log.engine("integration.started", { kind: "leave-one-out", pushes: [p1, p2], agents: ["a", "b"], items: ["one", "two"] })[0]!.seq;
    let round = openIntegrationRound(log.messages);
    expect(round).toMatchObject({ seq: started, n: 1, kind: "leave-one-out", items: ["one", "two"], line: "starting" });
    log.engine("integration.phase", { started, phase: "gate", detail: "npm run gate" });
    round = openIntegrationRound(log.messages);
    expect(round!.line).toBe("running the gate: npm run gate");
    log.engine("integration.phase", { started, phase: "candidate", detail: "leave-one-out candidate 2 of 4: the stack without b's push" });
    expect(openIntegrationRound(log.messages)!.line).toBe("leave-one-out candidate 2 of 4: the stack without b's push");

    const graph = buildBoardGraph(log.messages);
    assertBoardBacked(graph, log.messages);
    const wait = (item: string) => {
      const node = graph.nodes.find((n) => n.id === `item:${item}`)!;
      return node.detail.kind === "item" ? node.detail.wait : undefined;
    };
    expect(wait("one")).toEqual({ kind: "waiting-for-gate", line: "waiting for revision 1's gate (leave-one-out candidate 2 of 4: the stack without b's push)" });
    // The round's thread: the started record and its phases; an item's thread includes the round.
    expect(boardThread(log.messages, Infinity, { kind: "seq", seq: started }).map((m) => m.type)).toEqual(["integration.started", "integration.phase", "integration.phase"]);
    expect(boardThread(log.messages, Infinity, { kind: "item", id: "two" }).some((m) => m.seq === started)).toBe(true);

    // The revision closes it; the scrubber back before it shows it open again.
    log.rev({ commit: "r1", gate: "fail", merged: ["c1", "c2"] });
    expect(openIntegrationRound(log.messages)).toBeNull();
    expect(openIntegrationRound(log.messages, started)).not.toBeNull();
    expect(integrationPhaseLine(undefined)).toBe("starting");
  });

  it("a log with no progress records is unchanged: no round, the same wait lines", () => {
    const { log } = pending();
    const graph = buildBoardGraph(log.messages);
    const node = graph.nodes.find((n) => n.id === "item:one")!;
    expect(node.detail.kind === "item" && node.detail.wait?.line).not.toMatch(/revision 1's gate/);
    expect(openIntegrationRound(log.messages)).toBeNull();
  });
});

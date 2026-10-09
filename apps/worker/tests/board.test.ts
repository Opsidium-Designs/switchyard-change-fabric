/**
 * The Change board on the real Worker handler + ChangeState DO (offline):
 *   - identity comes from the route: agents join (bearer) and get a board
 *     token, then post as themselves with it; the human has its own route; an
 *     integrated revision only comes from the integration route; engine
 *     messages are never accepted from anyone;
 *   - each append (messages, state, tokens, escalations) is one transaction;
 *   - a scripted scenario yields exactly the pure model's log;
 *   - reads page with after/limit, agents get a token-authenticated digest,
 *     the stored board re-verifies, and the board resets on re-create.
 * The clock is frozen so the Worker's `at` stamps equal the reference log's.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contestResponder,
  endpointPoster,
  pureBoardEndpoint,
  reduceBoard,
  runBoardScript,
  type BoardDigest,
  type BoardEndpoint,
  type BoardMessage,
  type BoardState,
  type ContestAnswer,
} from "@switchyard-change/change-core";

import { ChangeState } from "../src/change-state.ts";
import { createHarness, MemoryStorage, specYaml, type Harness } from "./harness.ts";

const ID = "change-board";
const AT = "2026-01-01T00:00:00.000Z";
const TOKEN_HEADER = "x-board-agent-token";

interface Scenario {
  readonly responders: readonly { id: string; answer: ContestAnswer }[];
  readonly steps: readonly unknown[];
}
const scenarios = JSON.parse(
  readFileSync(new URL("../../../packages/change-core/tests/fixtures/board-scenarios.json", import.meta.url), "utf8"),
) as Record<string, Scenario>;

interface BoardBody {
  readonly lastSeq: number;
  readonly messages: BoardMessage[];
  readonly hasMore: boolean;
  readonly state: BoardState;
}

type Reply = { appended?: BoardMessage[]; token?: string; code?: string; error?: string };

/** The Worker's board routes as a BoardEndpoint (what a real client does). */
function httpEndpoint(h: Harness, bearer: Record<string, string> = {}): BoardEndpoint {
  const outcome = (res: { status: number; body: Reply }) =>
    res.status === 201
      ? { ok: true as const, appended: res.body.appended ?? [] }
      : { ok: false as const, code: res.body.code ?? "?", error: res.body.error ?? `status ${res.status}` };
  return {
    async join(agent, body) {
      const res = await h.json<Reply>("POST", `/changes/${ID}/board/join`, { agent, ...body }, bearer);
      return res.status === 201
        ? { ok: true, appended: res.body.appended ?? [], token: res.body.token ?? "" }
        : { ok: false, code: res.body.code ?? "?", error: res.body.error ?? "" };
    },
    async postAsAgent(token, draft) {
      return outcome(await h.json<Reply>("POST", `/changes/${ID}/board`, draft, { [TOKEN_HEADER]: token }));
    },
    async postAsHuman(draft) {
      return outcome(await h.json<Reply>("POST", `/changes/${ID}/board/human`, draft, bearer));
    },
    async integrate(input) {
      return outcome(await h.json<Reply>("POST", `/changes/${ID}/integration/revision`, input, bearer));
    },
  };
}

function runOn(endpoint: BoardEndpoint, name: string, steps?: readonly unknown[]) {
  const scenario = scenarios[name]!;
  return runBoardScript(
    { steps: steps ?? scenario.steps, agents: scenario.responders.map((r) => contestResponder(r.id, r.answer)) },
    endpointPoster(endpoint),
  );
}

async function created(options: { apiToken?: string } = {}): Promise<Harness> {
  const h = createHarness(options);
  const headers: Record<string, string> = options.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {};
  expect((await h.json("POST", "/changes", specYaml(ID), headers)).status).toBe(201);
  return h;
}

/** A board with a goal and agent `a` joined; returns a's token. */
async function withAgent(h: Harness, bearer: Record<string, string> = {}): Promise<string> {
  const endpoint = httpEndpoint(h, bearer);
  expect((await endpoint.postAsHuman({ type: "goal.posted", payload: { objective: "o" } })).ok).toBe(true);
  const joined = await endpoint.join("a", {});
  expect(joined.ok).toBe(true);
  return joined.ok ? joined.token : "";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AT));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Worker board routes", () => {
  it.each(["formation", "escalation"])("the %s scenario yields the pure model's exact log", async (name) => {
    const reference = await runOn(pureBoardEndpoint(() => AT), name);
    const h = await created();
    const worker = await runOn(httpEndpoint(h), name);
    expect(worker.log).toEqual(reference.log);
    expect(worker.rejected.map((r) => [r.code, r.error])).toEqual(reference.rejected.map((r) => [r.code, r.error]));

    const board = await h.json<BoardBody>("GET", `/changes/${ID}/board`);
    expect(board.status).toBe(200);
    expect(board.body.messages).toEqual(reference.log);
    expect(board.body.hasMore).toBe(false);
    expect(board.body.state).toEqual(reduceBoard(reference.log));
    const verified = await h.json<{ ok: boolean; lastSeq: number }>("GET", `/changes/${ID}/board/verify`);
    expect(verified.body).toEqual({ ok: true, lastSeq: reference.log.length });
  });

  it("pages the log with after and limit, and summarizes the board in the snapshot", async () => {
    const h = await created();
    const { log } = await runOn(httpEndpoint(h), "formation");
    const page = await h.json<BoardBody>("GET", `/changes/${ID}/board?after=5&limit=3`);
    expect(page.body.messages.map((m) => m.seq)).toEqual([6, 7, 8]);
    expect(page.body.hasMore).toBe(true);
    const tail = await h.json<BoardBody>("GET", `/changes/${ID}/board?after=${log.length - 2}`);
    expect(tail.body.messages.map((m) => m.seq)).toEqual([log.length - 1, log.length]);
    expect(tail.body.hasMore).toBe(false);
    for (const bad of ["after=-1", "after=abc", "limit=0", "limit=5000"]) {
      const res = await h.json<{ code: string }>("GET", `/changes/${ID}/board?${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BAD_PAYLOAD");
    }
    const snapshot = await h.json<{ board: unknown }>("GET", `/changes/${ID}`);
    expect(snapshot.body.board).toEqual({
      messages: log.length,
      agents: 4,
      items: { open: 0, claimed: 1, contested: 0, split: 0, done: 4 },
      contests: { open: 0, escalated: 0, resolved: 2 },
      toolsPublished: 1,
      integratedRev: 3,
    });
  });

  it("refuses spoofed identities with coded errors and appends nothing", async () => {
    const h = await created();
    const token = await withAgent(h);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      h.json<{ code: string; error: string }>("POST", `/changes/${ID}${path}`, body, headers);
    const agent = { [TOKEN_HEADER]: token };
    const before = (await h.json<BoardBody>("GET", `/changes/${ID}/board`)).body.lastSeq;

    // No token, a wrong token, or a body claiming another sender.
    expect((await post("/board", { type: "agent.left" })).status).toBe(401);
    expect((await post("/board", { type: "agent.left" }, { [TOKEN_HEADER]: "sbt_forged" })).body.code).toBe("AUTH");
    const spoof = await post("/board", { from: "engine", type: "item.completed", payload: { item: "x", n: 1, via: "integrated" } }, agent);
    expect([spoof.status, spoof.body.code]).toEqual([401, "AUTH"]);
    expect((await post("/board", { from: "human", type: "item.proposed", payload: { item: "x", objective: "o" } }, agent)).body.code).toBe("AUTH");
    // Engine and human message types are refused from an agent.
    expect((await post("/board", { type: "item.completed", payload: { item: "x", n: 1, via: "integrated" } }, agent)).body.code).toBe("NOT_ALLOWED");
    expect((await post("/board", { type: "integrated.rev", payload: { n: 1, commit: "c", gate: "pass", merged: [], paths: [], contributors: [] } }, agent)).body.code).toBe("NOT_ALLOWED");
    expect((await post("/board", { type: "agent.joined" }, agent)).body.code).toBe("NOT_ALLOWED");
    // The human route cannot act as an agent or the engine; the join route only joins.
    expect((await post("/board/human", { type: "item.claimed", payload: { item: "x", intent: { write: ["a"] } } })).body.code).toBe("NOT_ALLOWED");
    expect((await post("/board/human", { type: "rebase.needed", payload: { agent: "a", n: 1, paths: ["a"] } })).body.code).toBe("NOT_ALLOWED");
    expect((await post("/board/join", { agent: "engine" })).body.code).toBe("AUTH");
    expect((await post("/board/join", { agent: "a" })).body.code).toBe("DUPLICATE");
    // An integration revision must name announced pushes.
    expect((await post("/integration/revision", { commit: "r1", gate: "pass", merged: ["nothing"] })).body.code).toBe("UNKNOWN_REF");

    expect((await h.json<BoardBody>("GET", `/changes/${ID}/board`)).body.lastSeq).toBe(before);
    expect((await h.json<{ ok: boolean }>("GET", `/changes/${ID}/board/verify`)).body.ok).toBe(true);
  });

  it("returns machine-readable rejection codes and 404 for an unknown Change", async () => {
    const h = await created();
    const early = await h.json<{ code: string; error: string }>("POST", `/changes/${ID}/board/join`, { agent: "a" });
    expect([early.status, early.body.code]).toEqual([400, "NO_GOAL"]);
    const token = await withAgent(h);
    const claim = await h.json<{ code: string }>(
      "POST",
      `/changes/${ID}/board`,
      { type: "item.claimed", payload: { item: "missing", intent: { write: ["src/x.ts"] } } },
      { [TOKEN_HEADER]: token },
    );
    expect([claim.status, claim.body.code]).toEqual([400, "UNKNOWN_REF"]);
    expect((await h.json("POST", `/changes/${ID}/board/human`, "{not json")).status).toBe(400);
    expect((await h.json("POST", "/changes/nope/board/human", { type: "goal.posted", payload: { objective: "o" } })).status).toBe(404);
    expect((await h.json("GET", "/changes/nope/board")).status).toBe(404);
  });

  it("refuses an oversized body with 413", async () => {
    const h = await created();
    const token = await withAgent(h);
    const huge = { type: "item.proposed", payload: { item: "x", objective: "o" }, rationale: "r".repeat(70000) };
    const res = await h.json<{ code: string }>("POST", `/changes/${ID}/board`, huge, { [TOKEN_HEADER]: token });
    expect([res.status, res.body.code]).toEqual([413, "LIMIT"]);
  });

  it("agents post with their board token alone; joining, the human, and integration need the bearer", async () => {
    const bearer = { authorization: "Bearer s3cret" };
    const h = await created({ apiToken: "s3cret" });
    const goal = { type: "goal.posted", payload: { objective: "o" } };
    expect((await h.json("POST", `/changes/${ID}/board/human`, goal)).status).toBe(401);
    expect((await h.json("POST", `/changes/${ID}/board/human`, goal, bearer)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/join`, { agent: "a" })).status).toBe(401);
    expect((await h.json("POST", `/changes/${ID}/integration/revision`, { commit: "c", gate: "pass", merged: [] })).status).toBe(401);
    const joined = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "a" }, bearer);
    expect(joined.status).toBe(201);
    expect(joined.body.token).toMatch(/^sbt_[0-9a-f]{64}$/);
    // No bearer needed for the agent's own post; its token is the credential.
    const proposed = await h.json("POST", `/changes/${ID}/board`, { type: "item.proposed", payload: { item: "x", objective: "o" } }, {
      [TOKEN_HEADER]: joined.body.token,
    });
    expect(proposed.status).toBe(201);
    expect((await h.json<BoardBody>("GET", `/changes/${ID}/board`)).body.lastSeq).toBe(3);
  });

  it("stores only token hashes, revokes a token on agent.left, and resets tokens on re-create", async () => {
    const h = await created();
    const token = await withAgent(h);
    const board = await h.json<BoardBody>("GET", `/changes/${ID}/board`);
    expect(JSON.stringify(board.body)).not.toContain(token);
    const agent = { [TOKEN_HEADER]: token };
    expect((await h.json("POST", `/changes/${ID}/board`, { type: "agent.left" }, agent)).status).toBe(201);
    expect((await h.json<{ code: string }>("POST", `/changes/${ID}/board`, { type: "agent.left" }, agent)).body.code).toBe("AUTH");

    const h2 = await created();
    const token2 = await withAgent(h2);
    expect((await h2.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    const reset = await h2.json<BoardBody>("GET", `/changes/${ID}/board`);
    expect(reset.body).toMatchObject({ lastSeq: 0, messages: [] });
    expect(reset.body.state.goal).toBeNull();
    expect((await h2.json<{ code: string }>("POST", `/changes/${ID}/board`, { type: "agent.left" }, { [TOKEN_HEADER]: token2 })).status).toBe(401);
    const goal = await h2.json<{ appended: BoardMessage[] }>("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "again" } });
    expect(goal.body.appended.map((m) => m.seq)).toEqual([1]);
  });

  it("serves an agent its digest only with its own token", async () => {
    const h = await created();
    const { log } = await runOn(httpEndpoint(h), "escalation", scenarios.escalation!.steps.slice(0, 4));
    expect(log).toHaveLength(4);
    const joined = await httpEndpoint(h).join("watcher", {});
    const token = joined.ok ? joined.token : "";
    await h.json("POST", `/changes/${ID}/board/human`, { type: "item.proposed", payload: { item: "z", objective: "o" } });
    const digest = await h.json<{ ok: boolean; digest: BoardDigest }>("GET", `/changes/${ID}/board?for=watcher&after=0`, undefined, {
      [TOKEN_HEADER]: token,
    });
    expect(digest.status).toBe(200);
    expect(digest.body.digest).toMatchObject({ agent: "watcher", active: true, claims: [], pending: [] });
    expect(digest.body.digest.openItems.map((i) => i.item)).toEqual(["z"]);
    expect(digest.body.digest.messages.map((m) => m.type)).toEqual(["goal.posted", "item.proposed"]);
    expect((await h.json("GET", `/changes/${ID}/board?for=agent-a`, undefined, { [TOKEN_HEADER]: token })).status).toBe(401);
    expect((await h.json("GET", `/changes/${ID}/board?for=watcher`)).status).toBe(401);
  });
});

describe("Worker board atomicity", () => {
  /** Storage whose multi-key put fails part way through, once armed. */
  class FailingStorage extends MemoryStorage {
    armed = false;
    override async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
      if (this.armed && typeof keyOrEntries === "object" && "escalations" in keyOrEntries) {
        const { escalations: _skip, ...rest } = keyOrEntries;
        await super.put(rest);
        throw new Error("storage failed mid-write");
      }
      return super.put(keyOrEntries, value);
    }
  }

  it("a failed append writes nothing: messages, state, seq, and tokens roll back together", async () => {
    const storage = new FailingStorage();
    const object = new ChangeState({ storage } as never, {} as never);
    await object.createFromSpec(specYaml(ID));
    storage.armed = true;
    await expect(object.postBoardAsHuman({ type: "goal.posted", payload: { objective: "o" } })).rejects.toThrow(/mid-write/);
    storage.armed = false;
    expect(await object.getBoard()).toMatchObject({ lastSeq: 0, messages: [] });
    expect((await storage.list({ prefix: "board:" })).size).toBe(0);
    expect((await object.verifyStoredBoard()).ok).toBe(true);
    const ok = await object.postBoardAsHuman({ type: "goal.posted", payload: { objective: "o" } });
    expect(ok.ok && ok.appended.map((m) => m.seq)).toEqual([1]);
  });
});

describe("Worker board contest escalation", () => {
  /** Run the escalation scenario up to (not including) the human decision. */
  async function escalated(): Promise<{ h: Harness; escalationId: string; contest: string }> {
    const h = await created();
    const result = await runOn(httpEndpoint(h), "escalation", scenarios.escalation!.steps.slice(0, -1));
    expect(result.log.find((m) => m.type === "claim.escalated")).toBeDefined();
    const list = await h.json<{ escalations: { id: string; kind: string; status: string; boardContest?: string; options: string[] }[] }>(
      "GET",
      `/changes/${ID}/escalations`,
    );
    expect(list.body.escalations).toHaveLength(1);
    const [escalation] = list.body.escalations;
    expect(escalation).toMatchObject({ kind: "decision", status: "pending", boardContest: "contest-10", options: ["agent-a", "agent-b"] });
    return { h, escalationId: escalation!.id, contest: "contest-10" };
  }

  it("a human decision posted on the board closes the linked escalation", async () => {
    const { h } = await escalated();
    const { from: _from, ...decision } = scenarios.escalation!.steps.at(-1) as Record<string, unknown>;
    expect((await h.json("POST", `/changes/${ID}/board/human`, decision)).status).toBe(201);
    const list = await h.json<{ escalations: { status: string; decision?: string }[] }>("GET", `/changes/${ID}/escalations`);
    expect(list.body.escalations[0]).toMatchObject({ status: "resolved", decision: "agent-b" });
  });

  it("resolving the escalation posts the decision to the board atomically; an invalid decision changes nothing", async () => {
    const { h, escalationId, contest } = await escalated();
    const path = `/changes/${ID}/escalations/${encodeURIComponent(escalationId)}/resolve`;
    const bad = await h.json<{ error: string }>("POST", path, { decision: "agent-c" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/must be agent-a or agent-b/);
    const before = await h.json<BoardBody>("GET", `/changes/${ID}/board`);
    expect(before.body.state.contests[contest]?.status).toBe("escalated");
    const pending = await h.json<{ escalations: { status: string }[] }>("GET", `/changes/${ID}/escalations`);
    expect(pending.body.escalations[0]?.status).toBe("pending");

    expect((await h.json("POST", path, { decision: "agent-b" })).status).toBe(200);
    const after = await h.json<BoardBody>("GET", `/changes/${ID}/board?after=${before.body.lastSeq}`);
    expect(after.body.messages.map((m) => `${m.from}:${m.type}`)).toEqual(["human:claim.resolved", "engine:claim.granted"]);
    const list = await h.json<{ escalations: { status: string; decision?: string }[] }>("GET", `/changes/${ID}/escalations`);
    expect(list.body.escalations[0]).toMatchObject({ status: "resolved", decision: "agent-b" });
  });
});

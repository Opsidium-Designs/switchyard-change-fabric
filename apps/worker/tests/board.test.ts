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
      items: { proposed: 0, rejected: 1, open: 0, claimed: 1, contested: 0, split: 0, done: 4 },
      contests: { open: 0, escalated: 0, resolved: 2 },
      toolsPublished: 0,
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

  it("provisions the joining agent's own workspace with the explicit short TTL", async () => {
    const h = await created();
    const endpoint = httpEndpoint(h);
    expect((await endpoint.postAsHuman({ type: "goal.posted", payload: { objective: "o" } })).ok).toBe(true);
    const join = (body: Record<string, unknown>) =>
      h.json<{ token?: string; code?: string; workspace?: Record<string, unknown> }>("POST", `/changes/${ID}/board/join`, body);

    const joined = await join({ agent: "w1", workspace: { ttlSeconds: 900 } });
    expect(joined.status).toBe(201);
    expect(joined.body.token).toMatch(/^sbt_/);
    expect(joined.body.workspace).toMatchObject({
      workspaceName: `${ID}--board-w1`,
      gitUrl: `memory://test/${ID}--board-w1`,
      token: expect.stringMatching(/^secret-tok-/),
    });
    expect(h.provisioner.issued.at(-1)).toEqual({ workspaceName: `${ID}--board-w1`, tokenId: "tok-1", ttlSeconds: 900 });

    // A missing or out-of-bounds TTL is refused before anything is provisioned.
    for (const workspace of [{}, { ttlSeconds: 30 }, { ttlSeconds: 86400 }, { ttlSeconds: 90, extra: true }, "yes"]) {
      const res = await join({ agent: "w2", workspace });
      expect([res.status, res.body.code]).toEqual([400, "BAD_PAYLOAD"]);
    }
    expect(h.provisioner.issued).toHaveLength(1);

    // A join the board would refuse is refused BEFORE anything is provisioned.
    const again = await join({ agent: "w1", workspace: { ttlSeconds: 900 } });
    expect([again.status, again.body.code]).toEqual([400, "DUPLICATE"]);
    expect(h.provisioner.issued).toHaveLength(1);
    expect(h.provisioner.revoked).toEqual([]);
    expect(h.provisioner.archived).toEqual([]);
    // A plain join (no workspace) is unchanged.
    const plain = await join({ agent: "w3" });
    expect(plain.status).toBe(201);
    expect(plain.body.workspace).toBeUndefined();
  });

  it("a join that fails after provisioning revokes the token AND archives the repo", async () => {
    const h = await created();
    expect((await httpEndpoint(h).postAsHuman({ type: "goal.posted", payload: { objective: "o" } })).ok).toBe(true);
    const join = (body: Record<string, unknown>) => h.json<{ code?: string }>("POST", `/changes/${ID}/board/join`, body);
    const original = ChangeState.prototype.joinBoard;
    ChangeState.prototype.joinBoard = async function () {
      throw new Error("storage unavailable");
    };
    try {
      const failed = await join({ agent: "w1", workspace: { ttlSeconds: 900 } });
      expect([failed.status, failed.body.code]).toEqual([500, "INVALID_STATE"]);
    } finally {
      ChangeState.prototype.joinBoard = original;
    }
    expect(h.provisioner.revoked).toEqual([{ workspaceName: `${ID}--board-w1`, tokenId: "tok-1" }]);
    expect(h.provisioner.archived).toEqual([`${ID}--board-w1`]);
    // A refused join after provisioning (a race the precheck cannot see) undoes both too.
    ChangeState.prototype.joinBoard = async function () {
      return { ok: false, code: "DUPLICATE", error: "raced" };
    };
    try {
      expect((await join({ agent: "w2", workspace: { ttlSeconds: 900 } })).status).toBe(400);
    } finally {
      ChangeState.prototype.joinBoard = original;
    }
    expect(h.provisioner.archived).toEqual([`${ID}--board-w1`, `${ID}--board-w2`]);
  });

  it("issues the operator a short-lived read token for a joined agent's repo (bearer only)", async () => {
    const h = createHarness({ apiToken: "op-secret" });
    const auth = { authorization: "Bearer op-secret" };
    expect((await h.request("POST", "/changes", specYaml(ID), auth)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "o" } }, auth)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/join`, { agent: "w1", workspace: { ttlSeconds: 900 } }, auth)).status).toBe(201);
    const path = `/changes/${ID}/board/read-token`;
    expect((await h.json("POST", path, { agent: "w1" })).status).toBe(401);
    const issued = await h.json<{ workspaceName: string; token: string }>("POST", path, { agent: "w1", ttlSeconds: 300 }, auth);
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ workspaceName: `${ID}--board-w1`, token: "read-secret-1" });
    expect(h.provisioner.readTokens).toEqual([{ workspaceName: `${ID}--board-w1`, ttlSeconds: 300 }]);
    expect((await h.json<{ code: string }>("POST", path, { agent: "nobody" }, auth)).body.code).toBe("UNKNOWN_AGENT");
    expect((await h.json<{ code: string }>("POST", path, { agent: "w1", ttlSeconds: 5 }, auth)).body.code).toBe("BAD_PAYLOAD");
    // The lead and an agent that joined without a workspace have no repo to read.
    expect((await h.json("POST", `/changes/${ID}/board/join`, { agent: "lead", role: "lead" }, auth)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/join`, { agent: "plain" }, auth)).status).toBe(201);
    for (const agent of ["lead", "plain"]) {
      const refused = await h.json<{ code: string }>("POST", path, { agent }, auth);
      expect([refused.status, refused.body.code]).toEqual([400, "NOT_ALLOWED"]);
    }
    expect(h.provisioner.readTokens).toHaveLength(1);
    // The operator revokes a read token it is done with.
    const revoke = `/changes/${ID}/board/read-token/revoke`;
    expect((await h.json("POST", revoke, { agent: "w1", tokenId: "read-1" })).status).toBe(401);
    expect((await h.json("POST", revoke, { agent: "w1", tokenId: "read-1" }, auth)).status).toBe(200);
    expect(h.provisioner.revoked).toContainEqual({ workspaceName: `${ID}--board-w1`, tokenId: "read-1" });
  });

  it("forks the requester's repo for a helper only after the board allows it (bearer only), and reads the fork for the pull", async () => {
    const h = createHarness({ apiToken: "op-secret" });
    const auth = { authorization: "Bearer op-secret" };
    expect((await h.request("POST", "/changes", specYaml(ID), auth)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "o" } }, auth)).status).toBe(201);
    const tokens: Record<string, string> = {};
    for (const agent of ["w1", "w2"]) {
      tokens[agent] = (await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent, workspace: { ttlSeconds: 900 } }, auth)).body.token;
    }
    expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "item.proposed", payload: { item: "i1", objective: "o", scopeHint: ["src/**"] } }, auth)).status).toBe(201);
    const as = (agent: string, draft: unknown) => h.json<{ code?: string }>("POST", `/changes/${ID}/board`, draft, { [TOKEN_HEADER]: tokens[agent]! });
    expect((await as("w1", { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/**"] } } })).status).toBe(201);
    expect((await as("w1", { type: "help.requested", payload: { request: "h1", item: "i1", need: "parallel-edit", scope: ["src/b.ts"] } })).status).toBe(201);
    const path = `/changes/${ID}/board/help-fork`;
    expect((await h.json("POST", path, { request: "h1", agent: "w2" })).status).toBe(401);
    expect((await h.json<{ code: string }>("POST", path, { request: "h1", agent: "w1" }, auth)).body.code).toBe("NOT_ALLOWED");
    expect((await h.json<{ code: string }>("POST", path, { request: "h1", agent: "w2", ttlSeconds: 5 }, auth)).body.code).toBe("BAD_PAYLOAD");
    expect(h.provisioner.forks).toEqual([]);
    const forked = await h.json<{ workspaceName: string; forkOf: string; token: string }>("POST", path, { request: "h1", agent: "w2", ttlSeconds: 300 }, auth);
    expect(forked.status).toBe(201);
    expect(forked.body).toMatchObject({ workspaceName: `${ID}--help-h1`, forkOf: "w1" });
    expect(h.provisioner.forks).toEqual([{ source: `${ID}--board-w1`, target: `${ID}--help-h1`, ttlSeconds: 300 }]);
    const read = `/changes/${ID}/board/read-token`;
    expect((await h.json<{ code: string }>("POST", read, { agent: "w2", help: "h1" }, auth)).body.code).toBe("NOT_ALLOWED");
    expect((await as("w2", { type: "help.offered", payload: { request: "h1", forkOf: "w1", fork: `${ID}--help-h1` }, to: ["w1"] })).status).toBe(201);
    const issued = await h.json<{ workspaceName: string }>("POST", read, { agent: "w2", help: "h1", ttlSeconds: 120 }, auth);
    expect(issued.body.workspaceName).toBe(`${ID}--help-h1`);
    // Once granted, a second fork is refused before anything is forked.
    expect((await h.json<{ code: string }>("POST", path, { request: "h1", agent: "w2" }, auth)).body.code).toBe("DUPLICATE");
    expect(h.provisioner.forks).toHaveLength(1);
  });

  it("escalates a contract on the original tests to a human and posts the decision on the board", async () => {
    const h = await created();
    const endpoint = httpEndpoint(h);
    expect((await endpoint.postAsHuman({ type: "goal.posted", payload: { objective: "o", protected: ["tests/a.test.ts"] } })).ok).toBe(true);
    expect((await endpoint.postAsHuman({ type: "item.proposed", payload: { item: "t", objective: "o", scopeHint: ["tests/**"] } })).ok).toBe(true);
    const joined = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "a" });
    const post = (draft: unknown) => h.json<{ appended?: BoardMessage[] }>("POST", `/changes/${ID}/board`, draft, { [TOKEN_HEADER]: joined.body.token });
    const proposed = await post({ type: "contract.proposed", payload: { contract: "k1", target: "tests/a.test.ts", kind: "modify", item: "t" } });
    expect(proposed.body.appended!.map((m) => m.type)).toEqual(["contract.proposed", "contract.escalated"]);
    const listed = await h.json<{ escalations: { id: string; status: string; boardContract?: string; options: string[] }[] }>("GET", `/changes/${ID}/escalations`);
    const escalation = listed.body.escalations.find((e) => e.boardContract === "k1")!;
    expect(escalation).toMatchObject({ status: "pending", options: ["accept", "reject"] });
    // An advisory triage decorates the pending escalation; it never resolves it.
    const triage = { juncture: "contract-triage", question: "needed?", contract: "k1", answer: "reject", confidence: 0.8, accepted: true };
    expect((await h.json("POST", `/changes/${ID}/board/decision`, triage)).status).toBe(201);
    const advised = await h.json<{ escalations: { id: string; status: string; question: string; recommendation?: string; options: string[] }[] }>("GET", `/changes/${ID}/escalations`);
    expect(advised.body.escalations.find((e) => e.id === escalation.id)).toMatchObject({
      status: "pending",
      options: ["accept", "reject"],
      recommendation: "reject (confidence 0.80)",
      question: expect.stringMatching(/Accept or reject\?\nAdvisory triage \(a typed decision; the human decides\): reject \(confidence 0\.80\)$/),
    });
    expect((await h.json("POST", `/changes/${ID}/escalations/${escalation.id}/resolve`, { decision: "maybe" })).status).toBe(400);
    // The human decides against the recommendation; that is what the board applies.
    expect((await h.json("POST", `/changes/${ID}/escalations/${escalation.id}/resolve`, { decision: "accept" })).status).toBe(200);
    const board = await h.json<BoardBody>("GET", `/changes/${ID}/board?after=0&limit=100`);
    expect(board.body.messages.at(-1)).toMatchObject({ from: "human", type: "contract.accepted", payload: { contract: "k1" } });
    expect(board.body.state.contracts.k1).toMatchObject({ status: "accepted", guarded: true });
  });

  it("records an advisory decision (with a failed call's reason) only through the bearer decision route", async () => {
    const h = createHarness({ apiToken: "op-secret" });
    const auth = { authorization: "Bearer op-secret" };
    expect((await h.request("POST", "/changes", specYaml(ID), auth)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "o" } }, auth)).status).toBe(201);
    const decision = { juncture: "attribution", question: "which item?", accepted: false, error: "AI Gateway decision call failed (HTTP 400): expected record, received array" };
    expect((await h.json("POST", `/changes/${ID}/board/decision`, decision)).status).toBe(401);
    const recorded = await h.json<{ appended: BoardMessage[] }>("POST", `/changes/${ID}/board/decision`, decision, auth);
    expect(recorded.status).toBe(201);
    expect(recorded.body.appended[0]).toMatchObject({ from: "engine", type: "decision.recorded", payload: decision });
    const board = await h.json<BoardBody>("GET", `/changes/${ID}/board?after=0&limit=10`);
    expect(board.body.state.decisions).toEqual({ calls: 1, accepted: 0, errors: 1 });
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

describe("Worker tool routes (agents build tools for each other)", () => {
  it("only the operator records a tool's gate and its uses; agents cannot; a pass publishes, the registry pins versions", async () => {
    const h = await created({ apiToken: "op-secret-123" });
    const bearer = { authorization: "Bearer op-secret-123" };
    const token = await withAgent(h, bearer);
    const agent = { [TOKEN_HEADER]: token };
    const lead = await httpEndpoint(h, bearer).join("lead", { role: "lead" });
    const leadToken = lead.ok ? lead.token : "";
    const post = (path: string, body: unknown, headers: Record<string, string>) => h.json<Reply & { workspaceName?: string; gitUrl?: string; token?: string }>("POST", `/changes/${ID}${path}`, body, headers);

    expect((await post("/board", { type: "tool.proposed", payload: { tool: "t1", capability: "scan-x", kind: "scanner" }, rationale: "find every place" }, agent)).status).toBe(201);
    expect((await post("/board", { type: "item.accepted", payload: { item: "tool-scan-x" } }, { [TOKEN_HEADER]: leadToken })).status).toBe(201);
    expect((await post("/board", { type: "item.claimed", payload: { item: "tool-scan-x", intent: { write: ["tools/scan-x/**"] } } }, agent)).status).toBe(201);
    expect((await post("/board", { type: "tool.built", payload: { capability: "scan-x", commit: "b1", paths: ["tools/scan-x/run.mjs"] } }, agent)).status).toBe(201);

    const gate = { capability: "scan-x", commit: "b1", passed: true, checks: [{ check: "finds", passed: true, detail: "found 2 place(s)" }], repo: `${ID}--tools`, usage: "node tools/scan-x/run.mjs" };
    // An agent can never claim its tool passed: not through its own route...
    const forged = await post("/board", { type: "tool.gated", payload: gate }, agent);
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe("NOT_ALLOWED");
    // ...and the operator routes need the bearer it does not hold.
    expect((await post("/tools/gate", gate, agent)).status).toBe(401);
    expect((await post("/tools/used", { capability: "scan-x", version: "1", by: "a" }, agent)).status).toBe(401);

    const gated = await post("/tools/gate", gate, bearer);
    expect(gated.status).toBe(201);
    expect(gated.body.appended!.map((m) => m.type)).toEqual(["tool.gated", "tool.published", "item.completed"]);
    expect((await post("/tools/used", { capability: "scan-x", version: "2", by: "a" }, bearer)).body.code).toBe("UNKNOWN_REF");
    const used = await post("/tools/used", { capability: "scan-x", version: "1", by: "a", findings: [{ path: "src/a.ts", line: 1, message: "m" }] }, bearer);
    expect(used.status).toBe(201);
    expect(used.body.appended![0]).toMatchObject({ from: "engine", type: "tool.used", payload: { by: "a" } });
    const board = await h.json<BoardBody>("GET", `/changes/${ID}/board`);
    expect(board.body.state.tools.published.map((t) => `${t.capability}@${t.version}:${t.uses}`)).toEqual(["scan-x@1:1"]);
    expect((await h.json<{ ok: boolean }>("GET", `/changes/${ID}/board/verify`)).body.ok).toBe(true);
  });

  it("provisions the Change's tools repo once (a repeat returns the same repo with a fresh token) and issues scoped tokens", async () => {
    const h = await created();
    expect((await h.json<{ code?: string }>("POST", `/changes/${ID}/tools/token`, { scope: "read", ttlSeconds: 600 })).body.code).toBe("INVALID_STATE");
    const first = await h.json<{ workspaceName: string; gitUrl: string; token: string; tokenId: string }>("POST", `/changes/${ID}/tools/workspace`, { ttlSeconds: 600 });
    expect(first.status).toBe(201);
    expect(first.body.workspaceName).toBe(`${ID}--tools`);
    const again = await h.json<{ workspaceName: string; gitUrl: string; token: string }>("POST", `/changes/${ID}/tools/workspace`, { ttlSeconds: 600 });
    expect(again.status).toBe(201);
    expect(again.body.workspaceName).toBe(first.body.workspaceName);
    expect(again.body.gitUrl).toBe(first.body.gitUrl);
    const read = await h.json<{ workspaceName: string; token: string }>("POST", `/changes/${ID}/tools/token`, { scope: "read", ttlSeconds: 600 });
    expect(read.status).toBe(201);
    expect(read.body.workspaceName).toBe(first.body.workspaceName);
    expect((await h.json("POST", `/changes/${ID}/tools/workspace`, { ttlSeconds: 5 })).status).toBe(400);
    expect((await h.json("POST", `/changes/${ID}/tools/token/revoke`, { tokenId: first.body.tokenId })).status).toBe(200);
  });
});

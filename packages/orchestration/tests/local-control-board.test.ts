/**
 * The offline Worker stand-in (LocalChangeControl) serves the same Change board
 * routes with the same identity model and semantics as the Worker, through the
 * shared pure board model: agents join and post with a board token, the human
 * and the integrator have their own routes. Each scripted scenario must yield
 * exactly the pure model's log; the Worker's own test pins the Worker to that
 * same reference log, so the two substrates produce identical logs for the same
 * script. The clock is frozen so `at` stamps match too. No network.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import {
  contestResponder,
  endpointPoster,
  pureBoardEndpoint,
  reduceBoard,
  runBoardScript,
  type BoardDigest,
  type BoardEndpoint,
  type BoardMessage,
  type ContestAnswer,
} from "@switchyard-change/change-core";

import { BOARD_TOKEN_HEADER, LocalChangeControl, type BoardView } from "../src/local-control.ts";

const ID = "change-board";
const AT = "2026-01-01T00:00:00.000Z";
const SPEC = [
  `id: ${ID}`,
  "objective: coordinate on a board",
  "baseline: HEAD",
  "budget_usd: 1",
  "assurance: standard",
  "work:",
  "  - id: only",
  "    objective: placeholder unit",
  "    paths: [src/only.ts]",
  "",
].join("\n");

interface Scenario {
  readonly responders: readonly { id: string; answer: ContestAnswer }[];
  readonly steps: readonly unknown[];
}
const scenarios = JSON.parse(
  readFileSync(new URL("../../change-core/tests/fixtures/board-scenarios.json", import.meta.url), "utf8"),
) as Record<string, Scenario>;

function control(): LocalChangeControl {
  const c = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(tmpdir(), "scf-lc-board-unused") }));
  c.createChange(SPEC);
  return c;
}

async function call<T>(
  c: LocalChangeControl,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await c.fetch(`http://local-control${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

type Reply = { appended?: BoardMessage[]; token?: string; code?: string; error?: string };

/** The local control's board routes as a BoardEndpoint. */
function localEndpoint(c: LocalChangeControl): BoardEndpoint {
  const outcome = (res: { status: number; body: Reply }) =>
    res.status === 201
      ? { ok: true as const, appended: res.body.appended ?? [] }
      : { ok: false as const, code: res.body.code ?? "?", error: res.body.error ?? `status ${res.status}` };
  return {
    async join(agent, body) {
      const res = await call<Reply>(c, "POST", `/changes/${ID}/board/join`, { agent, ...body });
      return res.status === 201
        ? { ok: true, appended: res.body.appended ?? [], token: res.body.token ?? "" }
        : { ok: false, code: res.body.code ?? "?", error: res.body.error ?? "" };
    },
    async postAsAgent(token, draft) {
      return outcome(await call<Reply>(c, "POST", `/changes/${ID}/board`, draft, { [BOARD_TOKEN_HEADER]: token }));
    },
    async postAsHuman(draft) {
      return outcome(await call<Reply>(c, "POST", `/changes/${ID}/board/human`, draft));
    },
    async integrate(input) {
      return outcome(await call<Reply>(c, "POST", `/changes/${ID}/integration/revision`, input));
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AT));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LocalChangeControl board routes (parity with the Worker)", () => {
  it.each(["formation", "escalation"])("the %s scenario yields the pure model's exact log", async (name) => {
    const reference = await runOn(pureBoardEndpoint(() => AT), name);
    const c = control();
    const local = await runOn(localEndpoint(c), name);
    expect(local.log).toEqual(reference.log);
    expect(local.rejected.map((r) => [r.code, r.error])).toEqual(reference.rejected.map((r) => [r.code, r.error]));
    const board = await call<BoardView>(c, "GET", `/changes/${ID}/board`);
    expect(board.body.messages).toEqual(reference.log);
    expect(board.body.state).toEqual(reduceBoard(reference.log));
    expect((await call<{ ok: boolean }>(c, "GET", `/changes/${ID}/board/verify`)).body.ok).toBe(true);
  });

  it("pages, validates input with codes, refuses spoofing and oversize bodies, and summarizes in the snapshot", async () => {
    const c = control();
    const { log } = await runOn(localEndpoint(c), "formation");
    const page = await call<BoardView>(c, "GET", `/changes/${ID}/board?after=5&limit=3`);
    expect(page.body.messages.map((m) => m.seq)).toEqual([6, 7, 8]);
    expect(page.body.hasMore).toBe(true);
    expect((await call(c, "GET", `/changes/${ID}/board?after=x`)).status).toBe(400);
    expect((await call(c, "POST", `/changes/${ID}/board/human`, "{oops")).status).toBe(400);
    expect((await call(c, "GET", "/changes/nope/board")).status).toBe(404);
    expect((await call<{ code: string }>(c, "POST", `/changes/${ID}/board`, { type: "agent.left" })).body.code).toBe("AUTH");
    const joined = c.joinBoard(ID, "late");
    const token = joined.ok ? joined.token! : "";
    const spoof = await call<{ code: string }>(c, "POST", `/changes/${ID}/board`, { from: "engine", type: "agent.left" }, { [BOARD_TOKEN_HEADER]: token });
    expect([spoof.status, spoof.body.code]).toEqual([401, "AUTH"]);
    const huge = await call<{ code: string }>(c, "POST", `/changes/${ID}/board`, { type: "agent.left", rationale: "r".repeat(70000) }, {
      [BOARD_TOKEN_HEADER]: token,
    });
    expect([huge.status, huge.body.code]).toEqual([413, "LIMIT"]);
    expect(c.state(ID).board).toMatchObject({ messages: log.length + 1, toolsPublished: 0, integratedRev: 3 });
  });

  it("serves an agent its digest only with its own token; agent.left revokes the token", async () => {
    const c = control();
    await runOn(localEndpoint(c), "formation");
    const joined = c.joinBoard(ID, "watcher");
    const token = joined.ok ? joined.token! : "";
    const digest = await call<{ digest: BoardDigest }>(c, "GET", `/changes/${ID}/board?for=watcher&after=0`, undefined, {
      [BOARD_TOKEN_HEADER]: token,
    });
    expect(digest.status).toBe(200);
    expect(digest.body.digest).toMatchObject({ agent: "watcher", active: true, integrated: { n: 3 } });
    expect((await call(c, "GET", `/changes/${ID}/board?for=agent-a`, undefined, { [BOARD_TOKEN_HEADER]: token })).status).toBe(401);
    expect(c.postBoardAsAgent(ID, token, { type: "agent.left" }).ok).toBe(true);
    expect(c.postBoardAsAgent(ID, token, { type: "agent.left" })).toMatchObject({ ok: false, code: "AUTH" });
  });

  it("re-creating the Change resets the board and its tokens", async () => {
    const c = control();
    await runOn(localEndpoint(c), "escalation");
    c.createChange(SPEC);
    expect(c.board(ID)).toMatchObject({ lastSeq: 0, messages: [] });
    expect(c.state(ID).board.messages).toBe(0);
  });

  it("an escalated contest raises a linked escalation that resolves onto the board atomically", async () => {
    const c = control();
    const steps = scenarios.escalation!.steps;
    await runOn(localEndpoint(c), "escalation", steps.slice(0, -1));
    const [escalation] = c.escalations(ID);
    expect(escalation).toMatchObject({ kind: "decision", status: "pending", boardContest: "contest-10" });
    const before = c.board(ID).lastSeq;
    expect(() => c.resolveEscalation(ID, escalation!.id, "nobody")).toThrow(/must be agent-a or agent-b/);
    expect(c.escalations(ID)[0]?.status).toBe("pending");
    expect(c.board(ID).lastSeq).toBe(before);
    c.resolveEscalation(ID, escalation!.id, "agent-b");
    expect(c.board(ID).messages.slice(-2).map((m) => `${m.from}:${m.type}`)).toEqual(["human:claim.resolved", "engine:claim.granted"]);
    expect(c.escalations(ID)[0]).toMatchObject({ status: "resolved", decision: "agent-b" });

    // The other route: a decision posted on the board closes the escalation.
    const other = control();
    await runOn(localEndpoint(other), "escalation");
    expect(other.escalations(ID)[0]).toMatchObject({ status: "resolved", decision: "agent-b" });
  });

  it("a join can provision the agent's own local repo with an explicit short TTL (mirrors the Worker)", async () => {
    const c = control();
    expect((await call(c, "POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "o" } })).status).toBe(201);
    const joined = await call<{ token?: string; workspace?: Record<string, unknown>; code?: string }>(
      c,
      "POST",
      `/changes/${ID}/board/join`,
      { agent: "w1", workspace: { ttlSeconds: 600 } },
    );
    expect(joined.status).toBe(201);
    expect(joined.body.token).toMatch(/^sbt_/);
    expect(joined.body.workspace).toMatchObject({
      workspaceName: `${ID}--board-w1`,
      backend: "local-filesystem",
      fallback: true,
      gitUrl: expect.stringMatching(/^file:\/\//),
      token: expect.stringMatching(/^local-fallback-write-/),
    });
    // The write token lives exactly the requested TTL.
    const expires = Date.parse(String(joined.body.workspace!.tokenExpiresAt));
    expect(expires - Date.parse(AT)).toBe(600_000);
    for (const workspace of [{ ttlSeconds: 5 }, { ttlSeconds: 7200 }, {}]) {
      const bad = await call<{ code: string }>(c, "POST", `/changes/${ID}/board/join`, { agent: "w2", workspace });
      expect([bad.status, bad.body.code]).toEqual([400, "BAD_PAYLOAD"]);
    }
    const dup = await call<{ code: string }>(c, "POST", `/changes/${ID}/board/join`, { agent: "w1", workspace: { ttlSeconds: 600 } });
    expect([dup.status, dup.body.code]).toEqual([400, "DUPLICATE"]);

    // The operator's read token for a joined agent's repo (mirrors the Worker).
    const read = await call<{ workspaceName: string; token: string }>(c, "POST", `/changes/${ID}/board/read-token`, { agent: "w1", ttlSeconds: 120 });
    expect(read.status).toBe(201);
    expect(read.body).toMatchObject({ workspaceName: `${ID}--board-w1`, token: expect.stringMatching(/^local-fallback-read-/) });
    expect((await call<{ code: string }>(c, "POST", `/changes/${ID}/board/read-token`, { agent: "ghost" })).body.code).toBe("UNKNOWN_AGENT");
    expect((await call(c, "POST", `/changes/${ID}/board/join`, { agent: "lead", role: "lead" })).status).toBe(201);
    expect((await call<{ code: string }>(c, "POST", `/changes/${ID}/board/read-token`, { agent: "lead" })).body.code).toBe("NOT_ALLOWED");
    const tokenId = (read.body as unknown as { tokenId: string }).tokenId;
    expect((await call(c, "POST", `/changes/${ID}/board/read-token/revoke`, { agent: "w1", tokenId })).status).toBe(200);
    expect(c.revokedReadTokens).toEqual([tokenId]);
  });

  it("forks the requester's repo for a helper only once the board allows it, reads the fork for the pull, and archives it (mirrors the Worker)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const c = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: mkdtempSync(join(tmpdir(), "scf-lc-fork-")) }));
    c.createChange(SPEC);
    expect((await call(c, "POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "o" } })).status).toBe(201);
    const tokens: Record<string, string> = {};
    for (const agent of ["w1", "w2"]) {
      tokens[agent] = (await call<{ token: string }>(c, "POST", `/changes/${ID}/board/join`, { agent, workspace: { ttlSeconds: 600 } })).body.token;
    }
    expect((await call(c, "POST", `/changes/${ID}/board/join`, { agent: "lead", role: "lead" })).status).toBe(201);
    expect((await call(c, "POST", `/changes/${ID}/board/human`, { type: "item.proposed", payload: { item: "i1", objective: "o", scopeHint: ["src/**"] } })).status).toBe(201);
    const as = (agent: string, draft: unknown) => call<{ code?: string }>(c, "POST", `/changes/${ID}/board`, draft, { [BOARD_TOKEN_HEADER]: tokens[agent]! });
    expect((await as("w1", { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/**"] } } })).status).toBe(201);
    expect((await as("w1", { type: "help.requested", payload: { request: "h1", item: "i1", need: "parallel-edit", scope: ["src/b.ts"] } })).status).toBe(201);

    const fork = (agent: string, request = "h1") => call<{ code?: string; workspaceName?: string; forkOf?: string; token?: string; tokenExpiresAt?: string }>(c, "POST", `/changes/${ID}/board/help-fork`, { request, agent, ttlSeconds: 300 });
    expect((await fork("w1")).body.code).toBe("NOT_ALLOWED"); // its own request
    expect((await fork("lead")).body.code).toBe("NOT_ALLOWED");
    expect((await fork("w2", "nope")).body.code).toBe("UNKNOWN_REF");
    const made = await fork("w2");
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ workspaceName: `${ID}--help-h1`, forkOf: "w1", token: expect.stringMatching(/^local-fallback-write-/) });
    expect(Date.parse(made.body.tokenExpiresAt!) - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await fork("w2")).body.code).toBe("DUPLICATE");
    // The fork is read for the pull only once the board recorded the grant.
    const read = () => call<{ code?: string; workspaceName?: string }>(c, "POST", `/changes/${ID}/board/read-token`, { agent: "w2", help: "h1", ttlSeconds: 120 });
    expect((await read()).body.code).toBe("NOT_ALLOWED");
    expect((await as("w2", { type: "help.offered", payload: { request: "h1", forkOf: "w1", fork: `${ID}--help-h1` }, to: ["w1"] })).status).toBe(201);
    expect((await read()).body).toMatchObject({ workspaceName: `${ID}--help-h1` });
    // A WRITE token for the fork needs the helper still joined; a read does not.
    const write = () => call<{ code?: string; workspaceName?: string }>(c, "POST", `/changes/${ID}/board/agent-token`, { agent: "w2", help: "h1", ttlSeconds: 120 });
    expect((await write()).status).toBe(201);
    expect((await as("w2", { type: "agent.left" })).status).toBe(201);
    expect((await write()).body.code).toBe("UNKNOWN_AGENT");
    expect((await read()).body).toMatchObject({ workspaceName: `${ID}--help-h1` });
    // Archived at cleanup, once.
    expect((await call(c, "DELETE", `/workspaces/${ID}--help-h1`)).status).toBe(200);
    expect((await call(c, "DELETE", `/workspaces/${ID}--help-h1`)).status).toBe(404);
  });

  it("serves the planning-first create and stamps board messages with an injected clock", async () => {
    let tick = 0;
    const c = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(tmpdir(), "scf-lc-board-unused") }), {
      now: () => new Date(Date.UTC(2030, 0, 1) + 1000 * tick++),
    });
    const created = await call<{ id: string; status: string }>(c, "POST", "/changes/planning", { id: "p1", objective: "plan first" });
    expect([created.status, created.body]).toEqual([201, { id: "p1", status: "planning" }]);
    expect(c.state("p1").status).toBe("planning");
    expect((await call(c, "POST", "/changes/planning", { objective: "no id" })).status).toBe(400);
    c.postBoardAsHuman("p1", { type: "goal.posted", payload: { objective: "o" } });
    c.joinBoard("p1", "a");
    expect(c.board("p1").messages.map((m) => m.at)).toEqual(["2030-01-01T00:00:00.000Z", "2030-01-01T00:00:01.000Z"]);
  });
});

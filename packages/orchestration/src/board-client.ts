/**
 * board-client: the board routes as typed calls over a fetch.
 *
 * The same client drives the live Worker and the offline local control (whose
 * `fetch` serves the same routes), so a board run takes one code path on both.
 * Identity follows the board's model:
 *   - the OPERATOR side (the driver) holds the Worker bearer: it joins agents,
 *     posts as the human, and records integration revisions;
 *   - an AGENT holds only its own board token: its posts and digest reads carry
 *     `x-board-agent-token` and never the bearer, so an agent can never act as
 *     the human or the integrator.
 */

import type {
  BoardDigest,
  BoardMessage,
  BoardState,
} from "@switchyard-change/change-core";

import { withWorkerAuth } from "./worker-auth.ts";

/** The header an agent presents its board token in. */
export const BOARD_AGENT_TOKEN_HEADER = "x-board-agent-token";

/** A board refusal with its machine-readable code. */
export interface BoardRejection {
  readonly ok: false;
  readonly code: string;
  readonly error: string;
  readonly status: number;
}

/** An accepted append: the message plus the engine messages it triggered. */
export interface BoardAccepted {
  readonly ok: true;
  readonly appended: readonly BoardMessage[];
}

export type BoardPostOutcome = BoardAccepted | BoardRejection;

/** The agent workspace a join provisioned (the token is returned once). */
export interface JoinedWorkspace {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId: string;
  readonly token: string;
  readonly tokenExpiresAt: string;
}

/** A successful join. */
export interface BoardJoined {
  readonly ok: true;
  readonly appended: readonly BoardMessage[];
  readonly token: string;
  readonly workspace?: JoinedWorkspace;
}

/** One page of the board log with the reduced state. */
export interface BoardPage {
  readonly lastSeq: number;
  readonly messages: readonly BoardMessage[];
  readonly hasMore: boolean;
  readonly state: BoardState;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { error: text.slice(0, 300) };
  }
}

function rejection(res: Response, body: Record<string, unknown>): BoardRejection {
  return {
    ok: false,
    code: typeof body.code === "string" ? body.code : res.status === 401 ? "AUTH" : "HTTP",
    error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
    status: res.status,
  };
}

/** Read the public board (log page and reduced state). */
export async function readBoardPage(
  fetchFn: typeof fetch,
  base: string,
  changeId: string,
  after = 0,
  limit = 500,
): Promise<BoardPage> {
  const res = await fetchFn(`${base}/changes/${encodeURIComponent(changeId)}/board?after=${after}&limit=${limit}`);
  const body = await readJson(res);
  if (res.status >= 400) {
    const r = rejection(res, body);
    throw new Error(`board read failed (${r.code}): ${r.error}`);
  }
  return body as unknown as BoardPage;
}

/** Read the whole board log, page by page. */
export async function readBoardLog(fetchFn: typeof fetch, base: string, changeId: string): Promise<BoardPage> {
  const messages: BoardMessage[] = [];
  let page = await readBoardPage(fetchFn, base, changeId, 0, 1000);
  messages.push(...page.messages);
  while (page.hasMore) {
    page = await readBoardPage(fetchFn, base, changeId, messages.at(-1)?.seq ?? 0, 1000);
    messages.push(...page.messages);
  }
  return { ...page, messages };
}

/** The operator side of a board: joins, human posts, integration revisions. */
export class BoardOperatorClient {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;

  constructor(
    fetchFn: typeof fetch,
    baseUrl: string,
    readonly changeId: string,
  ) {
    // The operator carries the Worker bearer (when one is configured).
    this.fetchFn = withWorkerAuth(fetchFn);
    this.base = baseUrl.replace(/\/$/, "");
  }

  private path(suffix: string): string {
    return `${this.base}/changes/${encodeURIComponent(this.changeId)}${suffix}`;
  }

  private async post(suffix: string, body: unknown): Promise<{ res: Response; body: Record<string, unknown> }> {
    const res = await this.fetchFn(this.path(suffix), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, body: await readJson(res) };
  }

  /** Join an agent; with `workspaceTtlSeconds` the join also provisions its repo. */
  async join(
    agent: string,
    options: { readonly role?: string; readonly rationale?: string; readonly workspaceTtlSeconds?: number } = {},
  ): Promise<BoardJoined | BoardRejection> {
    const { res, body } = await this.post("/board/join", {
      agent,
      ...(options.role !== undefined ? { role: options.role } : {}),
      ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
      ...(options.workspaceTtlSeconds !== undefined ? { workspace: { ttlSeconds: options.workspaceTtlSeconds } } : {}),
    });
    if (res.status !== 201 || typeof body.token !== "string") {
      return rejection(res, body);
    }
    return {
      ok: true,
      appended: (body.appended as BoardMessage[] | undefined) ?? [],
      token: body.token,
      ...(body.workspace ? { workspace: body.workspace as JoinedWorkspace } : {}),
    };
  }

  /** Post as the human. */
  async postAsHuman(draft: unknown): Promise<BoardPostOutcome> {
    const { res, body } = await this.post("/board/human", draft);
    return res.status === 201 ? { ok: true, appended: (body.appended as BoardMessage[] | undefined) ?? [] } : rejection(res, body);
  }

  /** Record an integration result: the board appends the next integrated.rev. */
  async recordRevision(input: {
    readonly commit: string;
    readonly gate: "pass" | "fail";
    readonly merged: readonly string[];
    /** A failing revision's bounded, credential-free output and implicated items. */
    readonly failing?: { readonly output: string; readonly items: readonly string[] };
  }): Promise<BoardPostOutcome> {
    const { res, body } = await this.post("/integration/revision", input);
    return res.status === 201 ? { ok: true, appended: (body.appended as BoardMessage[] | undefined) ?? [] } : rejection(res, body);
  }

  /** Record an advisory typed decision and its outcome (the engine appends decision.recorded). */
  async recordDecision(input: {
    readonly juncture: "plan-review" | "attribution" | "fix-confidence";
    readonly question: string;
    readonly answer?: string;
    readonly confidence?: number;
    readonly accepted: boolean;
    readonly error?: string;
  }): Promise<BoardPostOutcome> {
    const { res, body } = await this.post("/board/decision", input);
    return res.status === 201 ? { ok: true, appended: (body.appended as BoardMessage[] | undefined) ?? [] } : rejection(res, body);
  }

  /**
   * A fresh, short-lived READ token for a joined agent's repo, issued by the
   * Worker to the operator (the integrator reads agents' repos with these at
   * integration time, never with an agent's own write token).
   */
  async readToken(
    agent: string,
    ttlSeconds = 600,
  ): Promise<{ readonly ok: true; readonly token: string; readonly tokenId: string; readonly tokenExpiresAt: string } | BoardRejection> {
    const { res, body } = await this.post("/board/read-token", { agent, ttlSeconds });
    if (res.status !== 201 || typeof body.token !== "string") {
      return rejection(res, body);
    }
    return {
      ok: true,
      token: body.token,
      tokenId: typeof body.tokenId === "string" ? body.tokenId : "",
      tokenExpiresAt: typeof body.tokenExpiresAt === "string" ? body.tokenExpiresAt : "",
    };
  }

  /** Revoke a read token the operator no longer needs. */
  async revokeReadToken(agent: string, tokenId: string): Promise<boolean> {
    const { res } = await this.post("/board/read-token/revoke", { agent, tokenId });
    return res.status < 400;
  }

  /** The public board view. */
  page(after = 0, limit = 500): Promise<BoardPage> {
    return readBoardPage(this.fetchFn, this.base, this.changeId, after, limit);
  }

  /** The whole board log and the reduced state. */
  log(): Promise<BoardPage> {
    return readBoardLog(this.fetchFn, this.base, this.changeId);
  }
}

/** One agent's side of a board: its own token only, never the bearer. */
export class BoardAgentClient {
  private readonly base: string;

  constructor(
    private readonly fetchFn: typeof fetch,
    baseUrl: string,
    readonly changeId: string,
    readonly agent: string,
    private readonly token: string,
  ) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  private path(suffix: string): string {
    return `${this.base}/changes/${encodeURIComponent(this.changeId)}${suffix}`;
  }

  /** Post a message as this agent. */
  async post(draft: unknown): Promise<BoardPostOutcome> {
    const res = await this.fetchFn(this.path("/board"), {
      method: "POST",
      headers: { "content-type": "application/json", [BOARD_AGENT_TOKEN_HEADER]: this.token },
      body: JSON.stringify(draft),
    });
    const body = await readJson(res);
    return res.status === 201 ? { ok: true, appended: (body.appended as BoardMessage[] | undefined) ?? [] } : rejection(res, body);
  }

  /** This agent's digest of messages after `after`. */
  async digest(after: number): Promise<{ readonly digest: BoardDigest; readonly hasMore: boolean }> {
    const res = await this.fetchFn(
      this.path(`/board?for=${encodeURIComponent(this.agent)}&after=${after}&limit=1000`),
      { headers: { [BOARD_AGENT_TOKEN_HEADER]: this.token } },
    );
    const body = await readJson(res);
    if (res.status >= 400) {
      const r = rejection(res, body);
      throw new Error(`digest read failed for ${this.agent} (${r.code}): ${r.error}`);
    }
    return { digest: body.digest as BoardDigest, hasMore: body.hasMore === true };
  }

  /** The public board state (who holds which intent), for turn context. */
  async state(): Promise<BoardState> {
    const page = await readBoardPage(this.fetchFn, this.base, this.changeId, 0, 1);
    return page.state;
  }
}

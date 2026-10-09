/**
 * Scripted board participants: a tiny deterministic driver that posts board
 * messages in a fixed order, with optional scripted agents that react to what
 * the board appends. It drives formation scenarios (claims, contests,
 * escalation, integration) without any model, so tests are offline and the
 * message order is reproducible.
 *
 * Scripts follow the same identity model as real participants: a script step
 * names its sender, and the driver routes it through a `BoardEndpoint` the way
 * a real client would. `agent.joined` goes through the join route and yields a
 * per-agent token; every later agent step presents that token; `human` steps
 * use the human route; an `engine` `integrated.rev` step is an integration
 * result recorded through the integration route. The same script therefore
 * runs against the pure model, the Worker, or the offline local control, and
 * the resulting logs can be compared directly.
 *
 * Ordering rule: after each successful post, every appended message is offered
 * to each scripted agent in agent-id order; their replies are posted before the
 * next scripted step, first-in first-out.
 */

import {
  appendBoardMessage,
  appendIntegratedRev,
  applyBoardMessage,
  BOARD_ENGINE,
  BOARD_HUMAN,
  BoardError,
  emptyBoard,
  type BoardAppendResult,
  type BoardErrorCode,
  type BoardMessage,
  type BoardState,
} from "./board.ts";

/** The outcome of one post. */
export type BoardPostResult =
  | { readonly ok: true; readonly appended: readonly BoardMessage[] }
  | { readonly ok: false; readonly code: string; readonly error: string };

/** The outcome of a join: the appended messages and the agent's board token. */
export type BoardJoinResult =
  | { readonly ok: true; readonly appended: readonly BoardMessage[]; readonly token: string }
  | { readonly ok: false; readonly code: string; readonly error: string };

type MaybePromise<T> = T | Promise<T>;

/** The participant routes of one board (pure, HTTP, or in-process). */
export interface BoardEndpoint {
  join(agent: string, body: { readonly role?: string; readonly rationale?: string }): MaybePromise<BoardJoinResult>;
  postAsAgent(token: string, draft: unknown): MaybePromise<BoardPostResult>;
  postAsHuman(draft: unknown): MaybePromise<BoardPostResult>;
  integrate(input: unknown): MaybePromise<BoardPostResult>;
}

/** Posts one scripted step (routed by its sender). */
export type BoardPoster = (draft: unknown) => Promise<BoardPostResult> | BoardPostResult;

/** A scripted participant: a pure reaction to each appended message. */
export interface ScriptedAgent {
  readonly id: string;
  react(message: BoardMessage, board: BoardState): readonly unknown[];
}

export interface BoardScript {
  /** Steps posted in order, each `{from, type, payload, ...}`. */
  readonly steps: readonly unknown[];
  readonly agents?: readonly ScriptedAgent[];
  /** Safety bound on total posts (default 500). */
  readonly maxPosts?: number;
}

export interface BoardScriptRun {
  /** Every message the board appended, in seq order. */
  readonly log: readonly BoardMessage[];
  /** Posts the board refused, with the code and reason. */
  readonly rejected: readonly { readonly draft: unknown; readonly code: string; readonly error: string }[];
  /** The driver's own reduction of the log. */
  readonly board: BoardState;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * A poster that routes script steps through an endpoint like a real client:
 * joins get a token (kept per agent), agent steps present it (the `from` field
 * is removed, so identity comes only from the token), human steps use the
 * human route, and engine integrated.rev steps go through the integration
 * route. An agent step before that agent joined has no token and is refused.
 */
export function endpointPoster(endpoint: BoardEndpoint): BoardPoster {
  const tokens = new Map<string, string>();
  return async (draft) => {
    const step = record(draft);
    const from = step.from;
    const { from: _from, ...body } = step;
    if (from === BOARD_HUMAN) {
      return endpoint.postAsHuman(body);
    }
    if (from === BOARD_ENGINE) {
      if (step.type !== "integrated.rev") {
        return { ok: false, code: "NOT_ALLOWED", error: "engine messages are never posted by a participant" };
      }
      return endpoint.integrate(step.payload);
    }
    if (typeof from !== "string") {
      return { ok: false, code: "BAD_PAYLOAD", error: "a script step must name its sender" };
    }
    if (step.type === "agent.joined") {
      const payload = record(step.payload);
      const joined = await endpoint.join(from, {
        ...(typeof payload.role === "string" ? { role: payload.role } : {}),
        ...(typeof step.rationale === "string" ? { rationale: step.rationale } : {}),
      });
      if (joined.ok) {
        tokens.set(from, joined.token);
        return { ok: true, appended: joined.appended };
      }
      return joined;
    }
    const token = tokens.get(from);
    if (token === undefined) {
      return { ok: false, code: "AUTH", error: `no board token for ${from} (join first)` };
    }
    return endpoint.postAsAgent(token, body);
  };
}

/** Run a script against a board through `post`. */
export async function runBoardScript(script: BoardScript, post: BoardPoster): Promise<BoardScriptRun> {
  const agents = [...(script.agents ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const maxPosts = script.maxPosts ?? 500;
  const steps = [...script.steps];
  const reactions: unknown[] = [];
  const log: BoardMessage[] = [];
  const rejected: { draft: unknown; code: string; error: string }[] = [];
  let board = emptyBoard();
  let posts = 0;
  while (reactions.length > 0 || steps.length > 0) {
    if (posts >= maxPosts) {
      throw new BoardError("LIMIT", `board script exceeded ${maxPosts} posts`);
    }
    const draft = reactions.length > 0 ? reactions.shift() : steps.shift();
    posts += 1;
    const result = await post(draft);
    if (!result.ok) {
      rejected.push({ draft, code: result.code, error: result.error });
      continue;
    }
    for (const message of result.appended) {
      log.push(message);
      board = applyBoardMessage(board, message);
    }
    for (const message of result.appended) {
      for (const agent of agents) {
        reactions.push(...agent.react(message, board));
      }
    }
  }
  return { log, rejected, board };
}

/**
 * The pure model behind a `BoardEndpoint`, with an injected clock: the
 * reference board the Worker and the offline control are compared against.
 * Tokens are deterministic stand-ins (`pure:<agent>`); the real substrates
 * issue random tokens and store only their hashes.
 */
export function pureBoardEndpoint(at: () => string): BoardEndpoint & {
  readonly log: () => readonly BoardMessage[];
  readonly state: () => BoardState;
} {
  let state = emptyBoard();
  const log: BoardMessage[] = [];
  const tokens = new Map<string, string>();
  const run = (fn: () => BoardAppendResult): BoardPostResult => {
    try {
      const result = fn();
      state = result.state;
      log.push(...result.appended);
      return { ok: true, appended: result.appended };
    } catch (error) {
      if (error instanceof BoardError) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
  };
  return {
    join(agent, body) {
      const result = run(() =>
        appendBoardMessage(
          state,
          { kind: "join", agent },
          {
            type: "agent.joined",
            payload: body.role !== undefined ? { role: body.role } : {},
            ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
          },
          at(),
        ),
      );
      if (!result.ok) {
        return result;
      }
      const token = `pure:${agent}`;
      tokens.set(token, agent);
      return { ok: true, appended: result.appended, token };
    },
    postAsAgent(token, draft) {
      const agent = tokens.get(token);
      if (agent === undefined) {
        return { ok: false, code: "AUTH" satisfies BoardErrorCode, error: "unknown board token" };
      }
      const result = run(() => appendBoardMessage(state, { kind: "agent", agent }, draft, at()));
      if (result.ok && result.appended[0]?.type === "agent.left") {
        tokens.delete(token);
      }
      return result;
    },
    postAsHuman(draft) {
      return run(() => appendBoardMessage(state, { kind: "human" }, draft, at()));
    },
    integrate(input) {
      return run(() => appendIntegratedRev(state, input, at()));
    },
    log: () => log,
    state: () => state,
  };
}

/** How a scripted agent answers a contest it is party to. */
export type ContestAnswer = "cede" | "keep" | { readonly narrow: readonly string[] };

/**
 * A scripted agent that answers contests: as the owner when a contest is
 * opened against it, and as either party whenever the other party keeps.
 */
export function contestResponder(agentId: string, answer: ContestAnswer): ScriptedAgent {
  const reply = (contest: string): unknown => {
    if (answer === "cede") {
      return { from: agentId, type: "claim.ceded", payload: { contest } };
    }
    if (answer === "keep") {
      return { from: agentId, type: "claim.kept", payload: { contest } };
    }
    return { from: agentId, type: "claim.narrowed", payload: { contest, write: [...answer.narrow] } };
  };
  return {
    id: agentId,
    react(message, board) {
      if (message.type === "claim.contested" && message.payload.owner === agentId) {
        return [reply(message.payload.contest)];
      }
      if (message.type === "claim.kept" && message.from !== agentId) {
        const contest = board.contests[message.payload.contest];
        if (contest && contest.status === "open" && (contest.owner === agentId || contest.claimant === agentId)) {
          return [reply(contest.id)];
        }
      }
      return [];
    },
  };
}

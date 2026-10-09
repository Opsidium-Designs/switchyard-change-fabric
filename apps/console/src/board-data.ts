/**
 * Board data plumbing for the mission-control view: the console keeps the
 * FULL board log client-side and pulls only what is new with
 * `GET /changes/:id/board?after=<lastSeq>` (paging while `hasMore`), so replay
 * at any seq is the same fold over the same log. The board GET is open (no
 * token); a human decision goes through the existing escalation resolve route
 * via `postToWorker` (the launcher's auth proxy when present).
 *
 * Pure apart from the injected fetch, so it is tested offline.
 */

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { postToWorker } from "./worker-post";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The page size asked for (the Worker caps a page at 1000). */
export const BOARD_PAGE_LIMIT = 1000;

/** The most pages one pull follows, so a huge backlog never blocks a poll forever. */
export const BOARD_MAX_PAGES = 25;

/**
 * Append the messages that continue `prev` (seq last+1, last+2, ...). A
 * message already held is skipped; a gap stops the merge (the next pull asks
 * again from the last contiguous seq), so the client log is always exactly a
 * prefix of the board's. Returns `prev` itself when nothing was added.
 */
export function mergeBoardLog(prev: readonly BoardMessage[], incoming: readonly BoardMessage[]): readonly BoardMessage[] {
  let last = prev.length === 0 ? 0 : prev[prev.length - 1]!.seq;
  const added: BoardMessage[] = [];
  for (const message of [...incoming].sort((a, b) => a.seq - b.seq)) {
    if (message.seq <= last) {
      continue;
    }
    if (message.seq !== last + 1) {
      break;
    }
    added.push(message);
    last = message.seq;
  }
  return added.length === 0 ? prev : [...prev, ...added];
}

export interface BoardPull {
  readonly log: readonly BoardMessage[];
  /** "missing": the Change (or its board) does not exist yet; "error": the pull failed. */
  readonly status: "ok" | "missing" | "error";
  readonly error?: string;
}

/**
 * Pull everything after the client's last seq, page by page. When the board
 * reports a lastSeq below the client's (the Change was re-created and its
 * board reset), the client log is dropped and pulled again from the start.
 */
export async function pullBoard(
  fetchFn: FetchFn,
  workerBase: string,
  changeId: string,
  log: readonly BoardMessage[],
): Promise<BoardPull> {
  let current = log;
  for (let page = 0; page < BOARD_MAX_PAGES; page += 1) {
    const after = current.length === 0 ? 0 : current[current.length - 1]!.seq;
    let res: Response;
    try {
      res = await fetchFn(
        `${workerBase}/changes/${encodeURIComponent(changeId)}/board?after=${after}&limit=${BOARD_PAGE_LIMIT}`,
      );
    } catch {
      return { log: current, status: "error", error: `cannot reach the Worker at ${workerBase}` };
    }
    if (res.status === 404) {
      return { log: current, status: "missing" };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { log: current, status: "error", error: body.error ?? `board request failed (${res.status})` };
    }
    const body = (await res.json()) as { lastSeq?: number; messages?: BoardMessage[]; hasMore?: boolean };
    if (typeof body.lastSeq === "number" && body.lastSeq < after) {
      current = [];
      continue;
    }
    const next = mergeBoardLog(current, body.messages ?? []);
    const progressed = next !== current;
    current = next;
    if (body.hasMore !== true || !progressed) {
      break;
    }
  }
  return { log: current, status: "ok" };
}

/** Answer a pending escalation through the existing resolve route (proxied when possible). */
export function resolveEscalation(
  fetchFn: FetchFn,
  workerBase: string,
  changeId: string,
  escalationId: string,
  decision: string,
): Promise<Response> {
  return postToWorker(
    fetchFn,
    workerBase,
    `/changes/${encodeURIComponent(changeId)}/escalations/${encodeURIComponent(escalationId)}/resolve`,
    { decision },
  );
}

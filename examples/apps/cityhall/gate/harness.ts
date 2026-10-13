// The acceptance gate's helpers: deterministic, offline, no network.
//
// The domain suites drive the city ONLY through its public HTTP surface: they
// build a fresh instance with createCityHall() (the src/index.ts export), send
// real Requests to its fetch handler, and assert on the real Responses. Only
// gate/contracts.test.ts reaches into src/contracts/, because the shared
// contracts are themselves part of what the goal asks for.

import { createCityHall } from "../src/index.ts";

/** The demo bearer tokens the API accepts (documented in the app README). */
export const ANA = "resident-ana";
export const BEN = "resident-ben";
export const CLERK = "clerk-token";
export const ADMIN = "admin-token";

export type App = ReturnType<typeof createCityHall>;

/** A fresh city over the seed data. */
export function freshApp(): App {
  return createCityHall();
}

export interface Reply {
  status: number;
  body: any;
}

/** Send one request; `token` adds the bearer token. The body is JSON. */
export async function call(app: App, method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await app.fetch(
    new Request(`http://cityhall.local${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: keep the text */
  }
  return { status: response.status, body };
}

/** A request as the holder of `token`. */
export function as(token: string, app: App, method: string, path: string, body?: unknown): Promise<Reply> {
  return call(app, method, path, { token, ...(body !== undefined ? { body } : {}) });
}

/** Create something and insist it worked; returns the created body. */
export async function create(token: string, app: App, path: string, body: unknown): Promise<any> {
  const reply = await as(token, app, "POST", path, body);
  if (reply.status !== 201) {
    throw new Error(`POST ${path} returned ${reply.status}: ${JSON.stringify(reply.body)}`);
  }
  return reply.body;
}

/** The out-of-range and malformed pages every list endpoint must refuse with 400. */
export const BAD_PAGES = ["limit=0", "limit=101", "limit=abc", "limit=2.5", "offset=-1", "offset=x"];

/**
 * Assert the shared pagination rule on one list endpoint: the defaults are
 * limit 20 and offset 0, and every BAD_PAGES query is a 400.
 */
export async function expectPaginationBounds(path: string, token?: string): Promise<void> {
  const app = freshApp();
  const ok = await call(app, "GET", path, token !== undefined ? { token } : {});
  if (ok.status !== 200 || ok.body.limit !== 20 || ok.body.offset !== 0 || !Array.isArray(ok.body.items)) {
    throw new Error(`GET ${path} should list with limit 20 and offset 0, got ${ok.status} ${JSON.stringify(ok.body)}`);
  }
  const sep = path.includes("?") ? "&" : "?";
  for (const query of BAD_PAGES) {
    const bad = await call(app, "GET", `${path}${sep}${query}`, token !== undefined ? { token } : {});
    if (bad.status !== 400) {
      throw new Error(`GET ${path}${sep}${query} should be 400, got ${bad.status}`);
    }
  }
}

/** A business-rule rejection: the request is refused as invalid or conflicting. */
export const REJECTED = [400, 409, 422];

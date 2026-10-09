// The acceptance gate's helpers: deterministic, offline, no network.
//
// The gate drives the storefront ONLY through its public HTTP surface: it builds
// a fresh instance with createStorefront() (the src/index.ts export), sends real
// Requests to its fetch handler, and asserts on the real Responses. It does not
// import any domain module or contract, so any implementation that honors the
// HTTP behavior passes.

import { createStorefront } from "../src/index.ts";

/** The demo bearer token the API accepts (documented in the app README). */
export const TOKEN = "demo-token";

export type App = ReturnType<typeof createStorefront>;

/** A fresh storefront over the seeded catalog. */
export function freshApp(): App {
  return createStorefront();
}

export interface Reply {
  status: number;
  body: any;
}

/** Send one request; `auth` adds the bearer token. The body is JSON. */
export async function call(app: App, method: string, path: string, options: { body?: unknown; auth?: boolean; token?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.auth || options.token !== undefined) {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  }
  const response = await app.fetch(
    new Request(`http://storefront.local${path}`, {
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

/** An authenticated request. */
export function authed(app: App, method: string, path: string, body?: unknown): Promise<Reply> {
  return call(app, method, path, { auth: true, ...(body !== undefined ? { body } : {}) });
}

/** Put products in the cart (authenticated) and check out to a region; returns the order. */
export async function buy(app: App, lines: readonly (readonly [string, number])[], region: string): Promise<any> {
  for (const [productId, qty] of lines) {
    const added = await authed(app, "POST", "/cart/items", { productId, qty });
    if (added.status !== 201) {
      throw new Error(`adding ${productId} x${qty} to the cart returned ${added.status}`);
    }
  }
  const order = await authed(app, "POST", "/checkout", { region });
  if (order.status !== 201) {
    throw new Error(`checkout returned ${order.status}`);
  }
  return order.body;
}

/** A business-rule rejection: the request is refused as invalid or conflicting. */
export const REJECTED = [400, 409, 422];

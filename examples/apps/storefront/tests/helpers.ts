// Small request helpers for the developer suite.

import { createStorefront } from "../src/index.ts";
import { DEMO_TOKEN } from "../src/contracts/auth.ts";

export type App = ReturnType<typeof createStorefront>;

export function freshApp(): App {
  return createStorefront();
}

/** Send a request as the signed-in demo customer and parse the JSON reply. */
export async function send(app: App, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${DEMO_TOKEN}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`http://storefront.local${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  );
  return { status: response.status, body: await response.json() };
}

// Small request helpers for the developer suite.

import { createCityHall } from "../src/index.ts";
import { DEMO_TOKENS } from "../src/contracts/auth.ts";

export type App = ReturnType<typeof createCityHall>;

export function freshApp(): App {
  return createCityHall();
}

/** Send a request with a demo token (the resident Ana by default) and parse the JSON reply. */
export async function send(app: App, method: string, path: string, body?: unknown, token: string = DEMO_TOKENS.resident): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`http://cityhall.local${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  );
  return { status: response.status, body: await response.json() };
}

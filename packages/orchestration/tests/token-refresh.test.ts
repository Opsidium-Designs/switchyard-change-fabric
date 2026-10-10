/**
 * The token refresher: fully offline, a fake clock and a fake provider.
 * A token is refreshed only inside its margin before expiry, the fresh one is
 * swapped in, the refresh is recorded without the token, the old token is
 * revoked one tick later (a grace period), and a failure is reported, never
 * thrown.
 */
import { describe, expect, it } from "vitest";

import { TokenRefresher, type RefreshableToken } from "../src/token-refresh.ts";

function fakeOperator(options: { readonly fail?: boolean } = {}) {
  const calls = { minted: [] as { agent: string; ttl: number; help?: string }[], revoked: [] as { agent: string; tokenId: string; help?: string }[], recorded: [] as { type: string; payload: Record<string, unknown> }[] };
  let n = 0;
  return {
    calls,
    operator: {
      agentToken: async (agent: string, ttl: number, opts: { help?: string } = {}) => {
        calls.minted.push({ agent, ttl, ...(opts.help !== undefined ? { help: opts.help } : {}) });
        if (options.fail) {
          return { ok: false as const, code: "INVALID_STATE", error: "provider down", status: 502 };
        }
        n += 1;
        return { ok: true as const, workspaceName: `ws-${agent}`, tokenId: `fresh-${n}`, token: `fresh-secret-${n}`, tokenExpiresAt: new Date(Date.UTC(2026, 0, 1, 2)).toISOString() };
      },
      revokeReadToken: async (agent: string, tokenId: string, help?: string) => {
        calls.revoked.push({ agent, tokenId, ...(help !== undefined ? { help } : {}) });
        return true;
      },
      recordEngine: async (type: string, payload: Record<string, unknown>) => {
        calls.recorded.push({ type, payload });
        return { ok: true as const, appended: [] };
      },
    },
  };
}

function token(agent: string, expiresAt: string, kind: "repo-write" | "help-fork" = "repo-write", request?: string) {
  const state = { token: `old-secret-${agent}`, tokenId: `old-${agent}`, expiresAt };
  const t: RefreshableToken = {
    agent,
    kind,
    ...(request !== undefined ? { request } : {}),
    get tokenId() {
      return state.tokenId;
    },
    get expiresAt() {
      return state.expiresAt;
    },
    swap: (fresh) => {
      state.token = fresh.token;
      state.tokenId = fresh.tokenId;
      state.expiresAt = fresh.tokenExpiresAt;
    },
  };
  return { t, state };
}

describe("TokenRefresher (fake clock, fake provider)", () => {
  const expiry = "2026-01-01T01:00:00.000Z";
  const at = (iso: string) => () => Date.parse(iso);

  it("refreshes only inside the margin, swaps the fresh token in, records it without the token, and revokes the old one a tick later", async () => {
    const { operator, calls } = fakeOperator();
    const secrets = new Set<string>();
    let now = at("2026-01-01T00:30:00.000Z");
    const refresher = new TokenRefresher({ operator, ttlSeconds: 3600, marginMs: 5 * 60_000, now: () => now(), secrets });
    const a = token("agent-1", expiry);
    const fork = token("agent-2", expiry, "help-fork", "h1");
    // Far from expiry: nothing happens.
    expect(await refresher.tick([a.t, fork.t])).toBe(0);
    expect(calls.minted).toEqual([]);
    // Inside the margin: both refreshed for the same agent and repo.
    now = at("2026-01-01T00:56:00.000Z");
    expect(await refresher.tick([a.t, fork.t])).toBe(2);
    expect(calls.minted).toEqual([{ agent: "agent-1", ttl: 3600 }, { agent: "agent-2", ttl: 3600, help: "h1" }]);
    expect(a.state).toMatchObject({ token: "fresh-secret-1", tokenId: "fresh-1" });
    expect(fork.state).toMatchObject({ token: "fresh-secret-2", tokenId: "fresh-2" });
    expect([...secrets]).toEqual(["fresh-secret-1", "fresh-secret-2"]);
    expect(calls.recorded).toEqual([
      { type: "token.refreshed", payload: { agent: "agent-1", kind: "repo-write" } },
      { type: "token.refreshed", payload: { agent: "agent-2", kind: "help-fork", request: "h1" } },
    ]);
    expect(JSON.stringify(calls.recorded)).not.toContain("secret");
    // The old tokens are revoked on the NEXT tick (a git call in flight keeps working).
    expect(calls.revoked).toEqual([]);
    expect(await refresher.tick([a.t, fork.t])).toBe(0);
    expect(calls.revoked).toEqual([{ agent: "agent-1", tokenId: "old-agent-1" }, { agent: "agent-2", tokenId: "old-agent-2", help: "h1" }]);
    expect(refresher.refreshed).toBe(2);
  });

  it("a failed refresh is reported, never thrown, and the old token stays in use", async () => {
    const { operator, calls } = fakeOperator({ fail: true });
    const failures: string[] = [];
    const refresher = new TokenRefresher({ operator, ttlSeconds: 900, now: at("2026-01-01T00:59:00.000Z"), onFailure: (r) => failures.push(r) });
    const a = token("agent-1", expiry);
    expect(await refresher.tick([a.t])).toBe(0);
    expect(a.state.token).toBe("old-secret-agent-1");
    expect(failures).toEqual([expect.stringMatching(/could not refresh agent-1's repo-write token \(INVALID_STATE\): provider down/)]);
    expect(calls.recorded).toEqual([]);
  });

  it("the default margin is max(60 s, a fifth of the lifetime)", () => {
    const { operator } = fakeOperator();
    expect(new TokenRefresher({ operator, ttlSeconds: 3600 }).marginMs).toBe(720_000);
    expect(new TokenRefresher({ operator, ttlSeconds: 60 }).marginMs).toBe(60_000);
  });
});

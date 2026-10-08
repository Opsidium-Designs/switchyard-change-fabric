/**
 * The dev launcher's /api/worker mutation proxy (offline, fetch faked): it only
 * forwards plain /changes/... paths, adds the Worker bearer ONLY when a token is
 * configured, relays the Worker's status and body as is, and answers 502 when
 * the Worker is unreachable. The token is never echoed back in the response.
 */
import { describe, expect, it } from "vitest";

import { WORKER_PROXY_MARKER as LAUNCHER_MARKER, isAllowedProxyPath, proxyWorkerPost } from "../launcher";
import { WORKER_PROXY_MARKER } from "../src/worker-post";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeWorker(status = 200, body = '{"ok":true}') {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body ?? ""),
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

describe("the launcher Worker proxy", () => {
  it("shares the response marker with the console", () => {
    expect(LAUNCHER_MARKER).toBe(WORKER_PROXY_MARKER);
  });

  it("allows only plain /changes/... paths", () => {
    expect(isAllowedProxyPath("/changes/c-1/escalations/e%201/resolve")).toBe(true);
    expect(isAllowedProxyPath("/changes/c/dial")).toBe(true);
    for (const bad of [
      "",
      "/",
      "/workspaces/x",
      "/events/repo-pushed",
      "/changes/../workspaces/x",
      "/changes/%2e%2e/workspaces/x",
      "/changes/a/..%2F..%2Fworkspaces",
      "/changes//x",
      "/changes/x?redirect=http://evil",
      "/changes/x#frag",
      "/changes/x\\y",
      "http://evil/changes/x",
      "//evil/changes/x",
    ]) {
      expect(isAllowedProxyPath(bad), bad).toBe(false);
    }
  });

  it("rejects a disallowed path without contacting the Worker", async () => {
    const { seen, fetchFn } = fakeWorker();
    const res = await proxyWorkerPost({ path: "/workspaces/x", body: "", workerUrl: "http://w", token: "t", fetchFn });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("adds the bearer only when a token is configured, and never echoes it", async () => {
    const withToken = fakeWorker(201, '{"escalation":{}}');
    const res = await proxyWorkerPost({
      path: "/changes/c/escalations/e/resolve",
      body: '{"decision":"ok"}',
      contentType: "application/json",
      workerUrl: "http://w/",
      token: "  secret-token-value  ",
      fetchFn: withToken.fetchFn,
    });
    expect(withToken.seen).toHaveLength(1);
    expect(withToken.seen[0]!.url).toBe("http://w/changes/c/escalations/e/resolve");
    expect(withToken.seen[0]!.headers.authorization).toBe("Bearer secret-token-value");
    expect(withToken.seen[0]!.body).toBe('{"decision":"ok"}');
    expect(res.status).toBe(201);
    expect(res.body).not.toContain("secret-token-value");

    const without = fakeWorker();
    await proxyWorkerPost({ path: "/changes/c/dial", body: "{}", workerUrl: "http://w", fetchFn: without.fetchFn });
    expect(without.seen[0]!.headers.authorization).toBeUndefined();
    const blank = fakeWorker();
    await proxyWorkerPost({ path: "/changes/c/dial", body: "{}", workerUrl: "http://w", token: "  ", fetchFn: blank.fetchFn });
    expect(blank.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("relays the Worker's status and body as is (including errors)", async () => {
    const { fetchFn } = fakeWorker(401, '{"error":"unauthorized"}');
    const res = await proxyWorkerPost({ path: "/changes/c/dial", body: "{}", workerUrl: "http://w", fetchFn });
    expect(res.status).toBe(401);
    expect(res.body).toBe('{"error":"unauthorized"}');
    expect(res.contentType).toBe("application/json");
  });

  it("answers 502 when the Worker is unreachable", async () => {
    const fetchFn = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await proxyWorkerPost({ path: "/changes/c/dial", body: "{}", workerUrl: "http://w", token: "t", fetchFn });
    expect(res.status).toBe(502);
    expect(res.body).not.toContain("ECONNREFUSED");
  });
});

/**
 * Fail-closed bearer auth on the Worker control plane (offline):
 *   - unset: every mutating route is refused unless the explicit local-dev
 *     opt-in SWITCHYARD_ALLOW_UNAUTHENTICATED=1 is set (reads stay open);
 *   - set: every mutating route (and so every route that returns a plaintext
 *     Artifact token) requires `authorization: Bearer <token>`, while the
 *     read-only snapshot GETs stay open;
 *   - the CORS preflight is answered without auth and allows the
 *     authorization header.
 */
import { describe, expect, it } from "vitest";

import { createHarness, specYaml } from "./harness.ts";

const ID = "change-auth";
const TOKEN = "test-api-token-value";
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe("Worker bearer auth", () => {
  it("is fail-closed when SWITCHYARD_API_TOKEN is unset: a mutation is refused without the explicit opt-in", async () => {
    const h = createHarness({ allowUnauthenticated: false });
    const refused = await h.json<{ error: string }>("POST", "/changes", specYaml(ID));
    expect(refused.status).toBe(401);
    expect(refused.body.error).toMatch(/no SWITCHYARD_API_TOKEN set.*SWITCHYARD_ALLOW_UNAUTHENTICATED=1/);
    expect((await h.request("POST", `/changes/${ID}/work/a/lease`)).status).toBe(401);
    expect((await h.request("DELETE", `/workspaces/${ID}--a`)).status).toBe(401);
    expect(h.provisioner.issued).toEqual([]);
    // Reads stay open.
    expect((await h.request("GET", "/")).status).toBe(200);
    expect((await h.request("GET", `/changes/${ID}`)).status).toBe(404);
  });

  it("allows mutations with no token only under SWITCHYARD_ALLOW_UNAUTHENTICATED=1 (the local-dev opt-in)", async () => {
    const h = createHarness({ allowUnauthenticated: true });
    expect(h.env.SWITCHYARD_ALLOW_UNAUTHENTICATED).toBe("1");
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    const lease = await h.json<{ token: string }>("POST", `/changes/${ID}/work/a/lease`);
    expect(lease.status).toBe(201);
    expect(lease.body.token).toMatch(/^secret-/);
  });

  it("treats a blank token as unset: refused without the opt-in, allowed with it", async () => {
    expect((await createHarness({ apiToken: "   " }).json("POST", "/changes", specYaml(ID))).status).toBe(401);
    expect((await createHarness({ apiToken: "   ", allowUnauthenticated: true }).json("POST", "/changes", specYaml(ID))).status).toBe(201);
  });

  it("a set token always applies, even with the opt-in", async () => {
    const h = createHarness({ apiToken: TOKEN, allowUnauthenticated: true });
    expect((await h.request("POST", "/changes", specYaml(ID))).status).toBe(401);
    expect((await h.request("POST", "/changes", specYaml(ID), AUTH)).status).toBe(201);
  });

  it("rejects every mutating route without a valid bearer, and never leaks a lease token", async () => {
    const h = createHarness({ apiToken: TOKEN });
    expect((await h.json("POST", "/changes", specYaml(ID), AUTH)).status).toBe(201);

    const mutating: [string, string, unknown?][] = [
      ["POST", "/changes", specYaml(ID)],
      ["POST", "/changes/planning", { id: ID, objective: "o", baseline: "HEAD" }],
      ["POST", `/changes/${ID}/plan`, specYaml(ID)],
      ["POST", `/changes/${ID}/work/a/lease`],
      ["POST", `/changes/${ID}/work/a/round/2/lease`],
      ["POST", `/changes/${ID}/recruit`],
      ["POST", `/changes/${ID}/work/a/fail`, { reason: "x" }],
      ["POST", `/changes/${ID}/work/a/complete`],
      ["POST", `/changes/${ID}/planning-failed`, { reason: "x" }],
      ["POST", `/changes/${ID}/integration`, { verdict: "verified", integratedUnits: [], excludedUnits: [] }],
      ["POST", `/changes/${ID}/dial`, { min: 1, max: 2 }],
      ["POST", `/changes/${ID}/escalations/x/resolve`, { decision: "ok" }],
      ["POST", "/events/repo-pushed", { changeId: ID, workspace: `${ID}--a` }],
      ["DELETE", `/workspaces/${ID}--a`],
    ];
    for (const [method, path, body] of mutating) {
      const missing = await h.request(method, path, body);
      expect(missing.status, `${method} ${path} without auth`).toBe(401);
      expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer/);
      const wrong = await h.request(method, path, body, { authorization: "Bearer not-the-token" });
      expect(wrong.status, `${method} ${path} with a wrong token`).toBe(401);
      const text = await wrong.text();
      expect(text).not.toMatch(/secret-/);
    }
    // No token was ever provisioned for an unauthenticated caller.
    expect(h.provisioner.issued).toEqual([]);
  });

  it("allows a mutating route with the correct bearer", async () => {
    const h = createHarness({ apiToken: TOKEN });
    expect((await h.json("POST", "/changes", specYaml(ID), AUTH)).status).toBe(201);
    const lease = await h.json<{ token: string }>("POST", `/changes/${ID}/work/a/lease`, undefined, AUTH);
    expect(lease.status).toBe(201);
    expect(lease.body.token).toMatch(/^secret-/);
    // The scheme is case-insensitive per RFC 7235.
    const lower = await h.json("POST", `/changes/${ID}/dial`, { min: 1, max: 2 }, { authorization: `bearer ${TOKEN}` });
    expect(lower.status).toBe(200);
  });

  it("keeps the read-only snapshot GETs open (they carry no plaintext token)", async () => {
    const h = createHarness({ apiToken: TOKEN });
    await h.json("POST", "/changes", specYaml(ID), AUTH);
    await h.json("POST", `/changes/${ID}/work/a/lease`, undefined, AUTH);
    expect((await h.request("GET", "/")).status).toBe(200);
    const state = await h.request("GET", `/changes/${ID}`);
    expect(state.status).toBe(200);
    expect(await state.text()).not.toMatch(/secret-/);
    expect((await h.request("GET", `/changes/${ID}/escalations`)).status).toBe(200);
  });

  it("answers the CORS preflight without auth and allows the authorization header", async () => {
    const h = createHarness({ apiToken: TOKEN });
    const res = await h.request("OPTIONS", `/changes/${ID}/escalations/x/resolve`, undefined, {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    });
    expect(res.status).toBe(204);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("authorization");
    expect(allowed).toContain("content-type");
    // A 401 also carries the CORS headers so the browser can read the error.
    const denied = await h.request("POST", "/changes", specYaml(ID));
    expect(denied.headers.get("access-control-allow-origin")).toBe("*");
  });
});

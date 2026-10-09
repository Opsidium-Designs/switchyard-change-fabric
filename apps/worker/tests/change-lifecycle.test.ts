/**
 * Change lifecycle on the real Worker handler + ChangeState DO (offline):
 *   - the authoritative integration verdict route, stored and exposed on the
 *     snapshot, and reset on re-create;
 *   - re-creating a Change id resets EVERY per-run key (including the ladder's
 *     verify/retry attempts) and revokes the leases the prior run still held;
 *   - a plan can only be attached while the Change is planning.
 */
import { describe, expect, it } from "vitest";

import { createHarness, specYaml } from "./harness.ts";

const ID = "change-life";

async function seedPriorRun(h: ReturnType<typeof createHarness>) {
  expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
  // A live kickoff lease (unit a) and a running round-2 agent (unit a, round 2).
  expect((await h.json("POST", `/changes/${ID}/work/a/lease`)).status).toBe(201);
  expect((await h.json("POST", `/changes/${ID}/work/a/round/2/lease`)).status).toBe(201);
  await h.json("POST", `/changes/${ID}/verify-attempt`, { round: 1, outcome: "fail", model: "base" });
  await h.json("POST", `/changes/${ID}/retry-attempt`, {
    round: 2,
    fromModel: "base",
    toModel: "strong",
    implicatedUnits: ["a"],
  });
  await h.json("POST", `/changes/${ID}/integration`, {
    verdict: "failed",
    integratedUnits: [],
    excludedUnits: ["a", "b"],
  });
}

describe("POST /changes/:id/integration", () => {
  it("stores the authoritative verdict and exposes it on the snapshot (null before)", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    const before = await h.json<{ integration: unknown }>("GET", `/changes/${ID}`);
    expect(before.body.integration).toBeNull();

    const posted = await h.json<{ integration: { verdict: string } }>(
      "POST",
      `/changes/${ID}/integration`,
      { verdict: "verified", integratedUnits: ["a", "b"], excludedUnits: [] },
    );
    expect(posted.status).toBe(201);
    expect(posted.body.integration.verdict).toBe("verified");

    const after = await h.json<{ integration: { verdict: string; integratedUnits: string[]; excludedUnits: string[] } }>(
      "GET",
      `/changes/${ID}`,
    );
    expect(after.body.integration).toMatchObject({
      verdict: "verified",
      integratedUnits: ["a", "b"],
      excludedUnits: [],
    });
  });

  it("records a pass no gate checked as gated: false (only on a verified verdict)", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    const body = { verdict: "verified", integratedUnits: ["a"], excludedUnits: [], gated: false };
    expect((await h.json("POST", `/changes/${ID}/integration`, { ...body, gated: true })).status).toBe(400);
    expect((await h.json("POST", `/changes/${ID}/integration`, { ...body, verdict: "failed" })).status).toBe(400);
    expect((await h.json("POST", `/changes/${ID}/integration`, body)).status).toBe(201);
    const after = await h.json<{ integration: { verdict: string; gated?: boolean } }>("GET", `/changes/${ID}`);
    expect(after.body.integration).toMatchObject({ verdict: "verified", gated: false });
  });

  it("rejects a malformed verdict or unit list, and an unknown Change", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    expect(
      (await h.json("POST", `/changes/${ID}/integration`, { verdict: "pass", integratedUnits: [], excludedUnits: [] }))
        .status,
    ).toBe(400);
    expect(
      (await h.json("POST", `/changes/${ID}/integration`, { verdict: "failed", integratedUnits: "a", excludedUnits: [] }))
        .status,
    ).toBe(400);
    expect(
      (await h.json("POST", `/changes/${ID}/integration`, { verdict: "failed", integratedUnits: [1], excludedUnits: [] }))
        .status,
    ).toBe(400);
    expect(
      (await h.json("POST", "/changes/nope/integration", { verdict: "failed", integratedUnits: [], excludedUnits: [] }))
        .status,
    ).toBe(404);
  });
});

describe("re-creating a Change id starts a fresh run", () => {
  it("POST /changes resets verify/retry attempts, integration, and every other per-run key", async () => {
    const h = createHarness();
    await seedPriorRun(h);
    const prior = await h.json<Record<string, unknown[]>>("GET", `/changes/${ID}`);
    expect(prior.body.verifyAttempts).toHaveLength(1);
    expect(prior.body.retryAttempts).toHaveLength(1);
    expect(prior.body.roundAgents).toHaveLength(1);

    const recreated = await h.json("POST", "/changes", specYaml(ID));
    expect(recreated.status).toBe(201);
    const state = await h.json<Record<string, unknown>>("GET", `/changes/${ID}`);
    expect(state.body.verifyAttempts).toEqual([]);
    expect(state.body.retryAttempts).toEqual([]);
    expect(state.body.rePlans).toBe(0);
    expect(state.body.roundAgents).toEqual([]);
    expect(state.body.integration).toBeNull();
    expect(state.body.jevDecisions).toEqual([]);
    expect(state.body.recruitments).toEqual([]);
    expect(state.body.completed).toEqual([]);
    expect(state.body.failed).toEqual([]);
    expect((state.body.work as { leased: boolean }[]).every((u) => !u.leased)).toBe(true);
  });

  it("revokes every outstanding kickoff and round-N lease the prior run held", async () => {
    const h = createHarness();
    await seedPriorRun(h);
    const issued = [...h.provisioner.issued];
    expect(issued).toHaveLength(2);
    expect(h.provisioner.revoked).toEqual([]);

    const recreated = await h.json<{ supersededLeases: { tokenId: string }[]; revokeFailures: unknown[] }>(
      "POST",
      "/changes",
      specYaml(ID),
    );
    expect(recreated.status).toBe(201);
    expect(h.provisioner.revoked.map((r) => r.tokenId).sort()).toEqual(issued.map((i) => i.tokenId).sort());
    expect(recreated.body.supersededLeases.map((l) => l.tokenId).sort()).toEqual(
      issued.map((i) => i.tokenId).sort(),
    );
    expect(recreated.body.revokeFailures).toEqual([]);
  });

  it("POST /changes/planning on a prior run (watch-mode / --id re-run) resets and revokes too", async () => {
    const h = createHarness();
    await seedPriorRun(h);
    const res = await h.json<{ status: string }>("POST", "/changes/planning", {
      id: ID,
      objective: "again",
      baseline: "HEAD",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("planning");
    expect(h.provisioner.revoked).toHaveLength(2);
    const state = await h.json<Record<string, unknown>>("GET", `/changes/${ID}`);
    expect(state.body.verifyAttempts).toEqual([]);
    expect(state.body.retryAttempts).toEqual([]);
    expect(state.body.integration).toBeNull();

    // The legitimate re-run then attaches its plan to the fresh placeholder.
    const attached = await h.json<{ status: string }>("POST", `/changes/${ID}/plan`, specYaml(ID));
    expect(attached.status).toBe(200);
    expect(attached.body.status).toBe("running");
  });

  it("a fresh create (no prior run) supersedes nothing and keeps the plain body", async () => {
    const h = createHarness();
    const res = await h.json<Record<string, unknown>>("POST", "/changes", specYaml(ID));
    expect(res.status).toBe(201);
    expect(res.body.supersededLeases).toBeUndefined();
    expect(h.provisioner.revoked).toEqual([]);
  });
});

describe("POST /changes/:id/plan is only allowed while planning", () => {
  it("rejects an attach to a running Change with 409 and leaves its run intact", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    await h.json("POST", `/changes/${ID}/work/a/lease`);
    await h.json("POST", `/changes/${ID}/verify-attempt`, { round: 1, outcome: "fail", model: "base" });

    const res = await h.json<{ error: string }>("POST", `/changes/${ID}/plan`, specYaml(ID));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/planning/);

    // Nothing was wiped: the lease and the ladder history survive, and no token
    // was revoked behind the live run's back.
    const state = await h.json<{ work: { id: string; leased: boolean }[]; verifyAttempts: unknown[] }>(
      "GET",
      `/changes/${ID}`,
    );
    expect(state.body.work.find((u) => u.id === "a")?.leased).toBe(true);
    expect(state.body.verifyAttempts).toHaveLength(1);
    expect(h.provisioner.revoked).toEqual([]);
  });

  it("attaches to a planning placeholder and flips it to running", async () => {
    const h = createHarness();
    await h.json("POST", "/changes/planning", { id: ID, objective: "o", baseline: "HEAD" });
    const res = await h.json<{ status: string; work: unknown[] }>("POST", `/changes/${ID}/plan`, specYaml(ID));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.work).toHaveLength(2);
    // A second attach (the Change is now running) is a conflict, not a wipe.
    expect((await h.json("POST", `/changes/${ID}/plan`, specYaml(ID))).status).toBe(409);
  });
});

describe("POST /changes/:id/planning-failed", () => {
  it("moves a planning placeholder to planning-failed with the recorded reason", async () => {
    const h = createHarness();
    await h.json("POST", "/changes/planning", { id: ID, objective: "o", baseline: "HEAD" });
    const res = await h.json<{ status: string; planningFailure: { reason: string } }>(
      "POST",
      `/changes/${ID}/planning-failed`,
      { reason: "planner threw" },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("planning-failed");
    expect(res.body.planningFailure.reason).toBe("planner threw");
    const state = await h.json<{ status: string; planningFailure: { reason: string } }>("GET", `/changes/${ID}`);
    expect(state.body.status).toBe("planning-failed");
    expect(state.body.planningFailure.reason).toBe("planner threw");
    // A failed placeholder can no longer have a plan attached.
    expect((await h.json("POST", `/changes/${ID}/plan`, specYaml(ID))).status).toBe(409);
  });

  it("redacts a credential-looking reason", async () => {
    const h = createHarness();
    await h.json("POST", "/changes/planning", { id: ID, objective: "o", baseline: "HEAD" });
    const res = await h.json<{ planningFailure: { reason: string } }>("POST", `/changes/${ID}/planning-failed`, {
      reason: "gateway said Bearer abcdef123456 was rejected",
    });
    expect(res.body.planningFailure.reason).not.toContain("abcdef123456");
  });

  it("rejects a running Change with 409 and a missing Change with 404", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    expect((await h.json("POST", `/changes/${ID}/planning-failed`, { reason: "x" })).status).toBe(409);
    const state = await h.json<{ status: string; planningFailure: unknown }>("GET", `/changes/${ID}`);
    expect(state.body.status).toBe("running");
    expect(state.body.planningFailure).toBeNull();
    expect((await h.json("POST", "/changes/nope/planning-failed", { reason: "x" })).status).toBe(404);
  });

  it("is cleared by a fresh re-create of the id", async () => {
    const h = createHarness();
    await h.json("POST", "/changes/planning", { id: ID, objective: "o", baseline: "HEAD" });
    await h.json("POST", `/changes/${ID}/planning-failed`, { reason: "planner threw" });
    const res = await h.json<{ status: string; planningFailure: unknown }>("POST", "/changes/planning", {
      id: ID,
      objective: "o",
      baseline: "HEAD",
    });
    expect(res.body.status).toBe("planning");
    expect(res.body.planningFailure).toBeNull();
  });
});

describe("a repo-pushed event keeps the pushing unit's token valid", () => {
  it("completes the unit without revoking: verify-and-integrate still clones with it", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    const lease = await h.json<{ tokenId: string; workspaceName: string }>("POST", `/changes/${ID}/work/a/lease`);
    const pushed = await h.json<{ completedUnit: string }>("POST", "/events/repo-pushed", {
      changeId: ID,
      workspace: lease.body.workspaceName,
    });
    expect(pushed.status).toBe(200);
    expect(pushed.body.completedUnit).toBe("a");
    expect(h.provisioner.revoked).toEqual([]);
  });
});

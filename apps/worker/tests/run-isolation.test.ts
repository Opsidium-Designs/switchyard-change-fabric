/**
 * A re-created Change is a fresh run, and nothing of the prior run's
 * credentials or caches leaks into it (offline, the real handler and
 * ChangeState over in-memory storage):
 *   - the join-provisioned repo write tokens are recorded by id (never the
 *     plaintext) and revoked on re-create, like a lease;
 *   - which agents joined with a repo is reset: a prior run's agent passes no
 *     read-token, agent-token, or help-fork check;
 *   - the Change's GateRunner outcome cache is cleared;
 *   - a write token for a help fork needs the helper still joined (a read
 *     token does not);
 *   - a repo-pushed event naming a bounded (hashed) repo name, a board repo,
 *     or a round repo reaches its Change.
 */

import { describe, expect, it } from "vitest";

import { boundedRepoName } from "@switchyard-change/change-core/repo-name";

import { changeIdFromWorkspace, workspaceNameFor } from "../src/index.ts";
import { createHarness, specYaml, type Harness } from "./harness.ts";

const ID = "change-iso";
const TOKEN_HEADER = "x-board-agent-token";

/** A GATE_RUNNER binding that records clearCache calls per Change. */
function recordingRunners() {
  const cleared: string[] = [];
  return {
    cleared,
    binding: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        async clearCache() {
          cleared.push(id);
          return { cleared: 0 };
        },
      }),
    },
  };
}

async function goalAndJoin(h: Harness, agents: readonly string[]): Promise<Record<string, string>> {
  expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "o" } })).status).toBe(201);
  const tokens: Record<string, string> = {};
  for (const agent of agents) {
    const joined = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent, workspace: { ttlSeconds: 900 } });
    expect(joined.status).toBe(201);
    tokens[agent] = joined.body.token;
  }
  return tokens;
}

describe("a re-created Change starts clean", () => {
  it("revokes the join-provisioned repo tokens and clears the gate runner's cache", async () => {
    const runners = recordingRunners();
    const h = createHarness({ env: { GATE_RUNNER: runners.binding } });
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    expect(runners.cleared).toEqual([ID]);
    await goalAndJoin(h, ["w1", "w2"]);
    const joinTokens = h.provisioner.issued.filter((i) => i.workspaceName.includes("--board-"));
    expect(joinTokens).toHaveLength(2);
    // Stored by id only: no plaintext anywhere in the Change's storage view.
    expect(JSON.stringify(await h.state(ID).getState())).not.toContain("secret-");

    const again = await h.json<{ supersededLeases: { unitId: string; workspaceName: string; tokenId: string }[]; revokeFailures: unknown[] }>("POST", "/changes", specYaml(ID));
    expect(again.status).toBe(201);
    expect(again.body.supersededLeases).toEqual(
      expect.arrayContaining(joinTokens.map((t) => ({ unitId: expect.stringMatching(/^board:/), workspaceName: t.workspaceName, tokenId: t.tokenId }))),
    );
    expect(again.body.revokeFailures).toEqual([]);
    for (const t of joinTokens) {
      expect(h.provisioner.revoked).toContainEqual({ workspaceName: t.workspaceName, tokenId: t.tokenId });
    }
    expect(runners.cleared).toEqual([ID, ID]);
    // A third create revokes nothing more: the second run joined no one.
    const third = await h.json<{ supersededLeases?: unknown[] }>("POST", "/changes", specYaml(ID));
    expect(third.body.supersededLeases).toBeUndefined();
  });

  it("a prior run's agent passes no read-token, agent-token, or help-fork check after re-create", async () => {
    const h = createHarness();
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    await goalAndJoin(h, ["w1"]);
    expect((await h.json("POST", `/changes/${ID}/board/read-token`, { agent: "w1" })).status).toBe(201);

    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    // The new run: w1 joins WITHOUT a workspace (same id, no repo of its own).
    expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "o" } })).status).toBe(201);
    const w1 = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "w1" });
    expect(w1.status).toBe(201);
    const w2 = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "w2" });
    for (const route of ["read-token", "agent-token"]) {
      const refused = await h.json<{ code: string; error: string }>("POST", `/changes/${ID}/board/${route}`, { agent: "w1" });
      expect(refused.status, route).toBe(400);
      expect(refused.body).toMatchObject({ code: "NOT_ALLOWED" });
      expect(refused.body.error).toMatch(/joined without a workspace/);
    }
    // A help fork of w1's (prior run's) repo is refused before anything is forked.
    expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "item.proposed", payload: { item: "i1", objective: "o", scopeHint: ["src/**"] } })).status).toBe(201);
    const as = (token: string, draft: unknown) => h.json("POST", `/changes/${ID}/board`, draft, { [TOKEN_HEADER]: token });
    expect((await as(w1.body.token, { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/**"] } } })).status).toBe(201);
    expect((await as(w1.body.token, { type: "help.requested", payload: { request: "h1", item: "i1", need: "parallel-edit", scope: ["src/b.ts"] } })).status).toBe(201);
    const fork = await h.json<{ code: string; error: string }>("POST", `/changes/${ID}/board/help-fork`, { request: "h1", agent: "w2" });
    expect(fork.body.code).toBe("NOT_ALLOWED");
    expect(fork.body.error).toMatch(/no repo to fork/);
    expect(h.provisioner.forks).toEqual([]);
    expect(w2.status).toBe(201);
  });
});

describe("help fork tokens", () => {
  it("a write token for a help fork needs the helper still joined; a read token does not", async () => {
    const h = createHarness();
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    const tokens = await goalAndJoin(h, ["w1", "w2"]);
    expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "item.proposed", payload: { item: "i1", objective: "o", scopeHint: ["src/**"] } })).status).toBe(201);
    const as = (agent: string, draft: unknown) => h.json<{ code?: string; error?: string }>("POST", `/changes/${ID}/board`, draft, { [TOKEN_HEADER]: tokens[agent]! });
    expect((await as("w1", { type: "item.claimed", payload: { item: "i1", intent: { read: [], write: ["src/**"] } } })).status).toBe(201);
    expect((await as("w1", { type: "help.requested", payload: { request: "h1", item: "i1", need: "parallel-edit", scope: ["src/b.ts"] } })).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/help-fork`, { request: "h1", agent: "w2", ttlSeconds: 300 })).status).toBe(201);
    expect((await as("w2", { type: "help.offered", payload: { request: "h1", forkOf: "w1", fork: `${ID}--help-h1` }, to: ["w1"] })).status).toBe(201);
    // While joined: both scopes.
    expect((await h.json("POST", `/changes/${ID}/board/agent-token`, { agent: "w2", help: "h1" })).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/board/read-token`, { agent: "w2", help: "h1" })).status).toBe(201);
    // The helper leaves: reads stay allowed (the requester pulls), writes are refused.
    const left = await as("w2", { type: "agent.left" });
    expect(left.status, JSON.stringify(left.body)).toBe(201);
    const writes = h.provisioner.writeTokens.length;
    const refused = await h.json<{ code: string }>("POST", `/changes/${ID}/board/agent-token`, { agent: "w2", help: "h1" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("UNKNOWN_AGENT");
    expect(h.provisioner.writeTokens).toHaveLength(writes);
    expect((await h.json("POST", `/changes/${ID}/board/read-token`, { agent: "w2", help: "h1" })).status).toBe(201);
  });
});

describe("repo-pushed events reach their Change", () => {
  it("parses board, help, tools, integration, unit, and round repo names back to the Change", () => {
    expect(changeIdFromWorkspace("chg-1--board-agent-1")).toBe("chg-1");
    expect(changeIdFromWorkspace("chg-1--board-a--b")).toBe("chg-1");
    expect(changeIdFromWorkspace("chg-1--help-h1")).toBe("chg-1");
    expect(changeIdFromWorkspace("chg-1--tools")).toBe("chg-1");
    expect(changeIdFromWorkspace("chg-1--integration")).toBe("chg-1");
    expect(changeIdFromWorkspace("chg-1--unit-a")).toBe("chg-1");
    expect(changeIdFromWorkspace("chg-1--unit-a--r2")).toBe("chg-1");
    expect(changeIdFromWorkspace("nothing")).toBe("");
    // A bounded, hashed name no longer carries the id: never guessed.
    const long = workspaceNameFor("a-very-long-change-identifier-for-routing", "a-long-unit-id-that-overflows", 3);
    expect(long).toHaveLength(63);
    expect(changeIdFromWorkspace(long)).toBe("");
  });

  it("a push to a round repo and to a bounded (hashed) repo name completes the right unit", async () => {
    const id = "a-very-long-change-identifier-for-routing";
    const spec = specYaml(id).replace("  - id: a\n", "  - id: a-long-unit-id-that-overflows\n").replace("depends_on: [a]", "depends_on: [a-long-unit-id-that-overflows]");
    const h = createHarness();
    expect((await h.json("POST", "/changes", spec)).status).toBe(201);
    const lease = await h.json<{ workspaceName: string }>("POST", `/changes/${id}/work/a-long-unit-id-that-overflows/lease`);
    expect(lease.status).toBe(201);
    expect(lease.body.workspaceName).toBe(boundedRepoName(`${id}--a-long-unit-id-that-overflows`));
    expect(lease.body.workspaceName).toHaveLength(63);
    // The real event carries only the repo name (no changeId).
    const pushed = await h.json<{ completedUnit: string | null }>("POST", "/events/repo-pushed", { workspace: lease.body.workspaceName });
    expect(pushed.status).toBe(200);
    expect(pushed.body.completedUnit).toBe("a-long-unit-id-that-overflows");

    // A round repo (`--r<round>`) parses back too.
    const short = createHarness();
    expect((await short.json("POST", "/changes", specYaml("chg-r"))).status).toBe(201);
    expect(changeIdFromWorkspace(workspaceNameFor("chg-r", "a", 2))).toBe("chg-r");
  });
});

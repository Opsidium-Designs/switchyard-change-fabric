/**
 * Integration on Cloudflare, the control-plane side, offline: the real Worker
 * handler and ChangeState over in-memory storage, a fake Workflow binding, a
 * fake GateRunner (no container), and the real integration loop over a fake
 * step runner.
 *   - an announced push starts the Change's integration Workflow; a push while
 *     it runs is coalesced (it looks again before finishing);
 *   - the loop plans the job from the board (pinned commits, tokenless URLs),
 *     mints short-lived tokens Worker-side, runs the job, revokes the tokens,
 *     records the revision through the board's integration path, and advances
 *     the integration branch after a pass;
 *   - every step is idempotent by the job key (a replayed record step returns
 *     the stored record and never appends a second revision);
 *   - a failing revision implicates every merged item and asks for a fix; a
 *     push that landed while the gate ran makes the result stale (nothing
 *     recorded); a job that cannot run is transient (tried again later);
 *   - the open view never shows the test inventory's names.
 */

import { describe, expect, it } from "vitest";

import type { BoardMessage, BoardState } from "@switchyard-change/change-core";
import type { IntegrateJobResult } from "@switchyard-change/verification/integrate-job";

import { decideCloudRevision } from "../src/cloud-integration.ts";
import type { GateRunOutcome, GateRunRequest } from "../src/gate-runner.ts";
import { runIntegrationLoop, workerIntegrationPorts, type IntegrationSteps } from "../src/integration-workflow.ts";
import type { ProvisionedWorkspace } from "../src/workspace-provisioner.ts";
import { createHarness, RecordingProvisioner, specYaml, type Harness } from "./harness.ts";

const ID = "change-cloud";
const HOST = "acct.artifacts.test";
const TOKEN_HEADER = "x-board-agent-token";
const PIN_1 = "1".repeat(40);
const PIN_2 = "2".repeat(40);
const GATED = "9".repeat(40);

/** A provisioner whose repos have https URLs (like Artifacts) and that can issue write tokens. */
class HttpsProvisioner extends RecordingProvisioner {
  readonly writeTokens: { workspaceName: string; ttlSeconds: number }[] = [];
  override async provision(workspaceName: string, options: { ttlSeconds?: number } = {}): Promise<ProvisionedWorkspace> {
    const provisioned = await super.provision(workspaceName, options);
    return { ...provisioned, gitUrl: `https://${HOST}/git/ns/${workspaceName}.git` };
  }
  async issueWriteToken(workspaceName: string, ttlSeconds: number): Promise<{ tokenId: string; token: string; tokenExpiresAt: string }> {
    this.writeTokens.push({ workspaceName, ttlSeconds });
    return { tokenId: `write-${this.writeTokens.length}`, token: `write-secret-${this.writeTokens.length}`, tokenExpiresAt: "2099-01-01T00:00:00.000Z" };
  }
}

/** A fake Workflow binding: records instances; status is settable. */
function fakeWorkflow() {
  const created: { id: string; params: { changeId: string; instanceId: string } }[] = [];
  const statuses = new Map<string, string>();
  return {
    created,
    statuses,
    binding: {
      async create(options: { id: string; params: { changeId: string; instanceId: string } }) {
        created.push(options);
        return { id: options.id };
      },
      async get(id: string) {
        if (!created.some((c) => c.id === id)) {
          throw new Error("no such instance");
        }
        return { status: async () => ({ status: statuses.get(id) ?? "running" }) };
      },
    },
  };
}

/** A fake GateRunner: answers runJob with a scripted outcome and records the requests. */
function fakeRunner(answer: (request: GateRunRequest) => Promise<GateRunOutcome> | GateRunOutcome) {
  const requests: GateRunRequest[] = [];
  return {
    requests,
    binding: {
      idFromName: (name: string) => name,
      get: () => ({
        async runJob(request: GateRunRequest) {
          requests.push(structuredClone(request));
          return answer(request);
        },
      }),
    },
  };
}

/** Steps that run each named step once (results cached by name), with bounded retries. */
function fakeSteps(onWait?: (type: string) => Promise<void>): IntegrationSteps & { readonly names: string[]; readonly cache: Map<string, unknown>; readonly waits: string[] } {
  const cache = new Map<string, unknown>();
  const names: string[] = [];
  const waits: string[] = [];
  return {
    names,
    cache,
    waits,
    async waitForEvent(_name: string, type: string): Promise<unknown> {
      waits.push(type);
      if (!onWait) {
        throw new Error("timed out waiting for the event");
      }
      await onWait(type);
      return { type };
    },
    async do<T>(name: string, config: { readonly retries?: { readonly limit: number } }, run: () => Promise<T>): Promise<T> {
      if (cache.has(name)) {
        return cache.get(name) as T;
      }
      names.push(name);
      let error: unknown;
      for (let attempt = 0; attempt <= (config.retries?.limit ?? 0); attempt += 1) {
        try {
          const value = await run();
          cache.set(name, value);
          return value;
        } catch (e) {
          error = e;
        }
      }
      throw error;
    },
  };
}

function passResult(commit = GATED): IntegrateJobResult {
  return {
    version: 1,
    kind: "integrate",
    outcome: "gated",
    verdict: "verified",
    gate: "pass",
    gated: true,
    commit,
    evidence: {
      changeId: ID,
      units: [{ unitId: "agent-1", verdict: "verified", checks: [] }],
      integration: { verdict: "verified", integratedUnits: ["agent-1"], excludedUnits: [], commit, finalCheck: { kind: "app-gate", passed: true, skipped: false, summary: "integration app-gate passed over the promoted tree (exit 0)", outputs: [] } },
    },
    install: { status: "installed", tool: "npm", detail: "npm ci --ignore-scripts --no-audit --no-fund --prefer-offline", durationMs: 1200 },
    inventory: { format: "node-spec", count: 3 },
    phases: [],
    durationMs: 5000,
  };
}

function failResult(line = "AssertionError [ERR_ASSERTION]: a must be 2", agents = ["agent-1"]): IntegrateJobResult {
  const base = passResult();
  return {
    ...base,
    verdict: "failed",
    gate: "fail",
    failureLine: line,
    evidence: {
      ...base.evidence!,
      units: agents.map((unitId) => ({ unitId, verdict: "verified" as const, checks: [] })),
      integration: {
        ...base.evidence!.integration,
        verdict: "failed",
        integratedUnits: [],
        finalCheck: { kind: "app-gate", passed: false, skipped: false, summary: "integration app-gate failed over the promoted tree (exit 1)", outputs: [{ stream: "stderr", text: `✖ failing\n${line}` }] },
      },
    },
  };
}

const PHASES = [
  { phase: "fetch", egress: "artifacts-only", at: "t0" },
  { phase: "deps", egress: "registry-only", at: "t1" },
  { phase: "gate", egress: "deny-all", at: "t2" },
  { phase: "push", egress: "artifacts-only", at: "t3" },
  { phase: "closed", egress: "deny-all", at: "t4" },
] as const;

interface Setup {
  readonly h: Harness;
  readonly provisioner: HttpsProvisioner;
  readonly workflow: ReturnType<typeof fakeWorkflow>;
  readonly agentToken: string;
  push(commit: string): Promise<{ status: number }>;
  board(): Promise<{ messages: BoardMessage[]; state: BoardState }>;
}

/** The configuration a run posts (before the goal). */
function config(extra: Record<string, unknown> = {}) {
  return {
    integration: { workspaceName: `${ID}--integration`, gitUrl: `https://${HOST}/git/ns/${ID}--integration.git`, defaultBranch: "main" },
    gateCommand: ["npm", "run", "gate"],
    requireGate: true,
    protectedPaths: ["test/**"],
    protectedJsonKeys: [{ file: "package.json", keys: [["scripts", "gate"]] }],
    testInventory: { format: "node-spec", count: 3, names: ["secret test name one", "two", "three"] },
    timeouts: { installMs: 60_000, gateMs: 120_000 },
    ...extra,
  };
}

/**
 * A Change with integration on Cloudflare configured, then a goal, a lead's
 * item, and agent-1 (with a repo) holding it (and agent-2 holding fix-b with `second`).
 */
async function setup(runner: ReturnType<typeof fakeRunner>, options: { readonly attribution?: "engine" | "driver"; readonly second?: boolean } = {}): Promise<Setup & { push2(commit: string): Promise<{ status: number }> }> {
  const provisioner = new HttpsProvisioner();
  const workflow = fakeWorkflow();
  const h = createHarness({ provisioner, env: { INTEGRATION_WORKFLOW: workflow.binding, GATE_RUNNER: runner.binding } });
  expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
  // The configuration is part of the goal-time record: set before the goal.
  const configured = await h.json("POST", `/changes/${ID}/integration/cloud`, config(options.attribution ? { attribution: options.attribution } : {}));
  expect(configured.status).toBe(201);
  expect((await h.json("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "make a equal 2" } })).status).toBe(201);
  const lead = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "lead", role: "lead" });
  expect(
    (await h.json("POST", `/changes/${ID}/board`, { type: "item.proposed", payload: { item: "fix-a", objective: "fix a", scopeHint: ["src/a.js"] } }, { [TOKEN_HEADER]: lead.body.token })).status,
  ).toBe(201);
  const agent = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "agent-1", workspace: { ttlSeconds: 600 } });
  expect(agent.status).toBe(201);
  expect(
    (await h.json("POST", `/changes/${ID}/board`, { type: "item.claimed", payload: { item: "fix-a", intent: { read: [], write: ["src/a.js"] } } }, { [TOKEN_HEADER]: agent.body.token })).status,
  ).toBe(201);
  let second = "";
  if (options.second) {
    expect(
      (await h.json("POST", `/changes/${ID}/board`, { type: "item.proposed", payload: { item: "fix-b", objective: "fix b", scopeHint: ["src/b.js"] } }, { [TOKEN_HEADER]: lead.body.token })).status,
    ).toBe(201);
    const agent2 = await h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "agent-2", workspace: { ttlSeconds: 600 } });
    second = agent2.body.token;
    expect(
      (await h.json("POST", `/changes/${ID}/board`, { type: "item.claimed", payload: { item: "fix-b", intent: { read: [], write: ["src/b.js"] } } }, { [TOKEN_HEADER]: second })).status,
    ).toBe(201);
  }
  return {
    push2: (commit) => h.json("POST", `/changes/${ID}/board`, { type: "push.announced", payload: { item: "fix-b", commit, paths: ["src/b.js"] } }, { [TOKEN_HEADER]: second }),
    h,
    provisioner,
    workflow,
    agentToken: agent.body.token,
    push: (commit) => h.json("POST", `/changes/${ID}/board`, { type: "push.announced", payload: { item: "fix-a", commit, paths: ["src/a.js"] } }, { [TOKEN_HEADER]: agent.body.token }),
    async board() {
      const page = await h.json<{ messages: BoardMessage[]; state: BoardState }>("GET", `/changes/${ID}/board?limit=500`);
      return page.body;
    },
  };
}

describe("integration on Cloudflare", () => {
  it("starts on an announced push, coalesces the next, gates, records, and advances", async () => {
    const runner = fakeRunner((request) => ({
      key: request.key,
      result: request.job.kind === "advance" ? { version: 1, kind: "advance", advanced: true, commit: request.job.commit, phases: [], durationMs: 1 } : passResult(),
      phases: [...PHASES],
    }));
    const s = await setup(runner);
    expect((await s.push(PIN_1)).status).toBe(201);
    expect(s.workflow.created).toHaveLength(1);
    const instanceId = s.workflow.created[0]!.id;
    expect(s.workflow.created[0]!.params).toEqual({ changeId: ID, instanceId });
    // A second push while the Workflow is active is coalesced, not a second Workflow.
    expect((await s.push(PIN_2)).status).toBe(201);
    expect(s.workflow.created).toHaveLength(1);
    expect((await s.h.json<{ kicked: boolean }>("GET", `/changes/${ID}/integration/cloud`)).body.kicked).toBe(true);

    const steps = fakeSteps();
    const result = await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), steps, instanceId);
    expect(result.stop).toBe("idle");
    expect(result.recorded).toEqual([{ key: expect.stringMatching(/^ij-/), n: 1, gate: "pass", recorded: true }]);

    // The job: pinned to the latest push, the earlier one required in its history, tokenless.
    const integrate = runner.requests.find((r) => r.job.kind === "integrate")!;
    expect(integrate.job.kind === "integrate" && integrate.job.units).toEqual([
      {
        agent: "agent-1",
        repoUrl: `https://${HOST}/git/ns/${ID}--board-agent-1.git`,
        commit: PIN_2,
        baselineRef: "HEAD",
        includes: [],
        scope: ["src/a.js"],
        items: ["fix-a"],
        parts: [{ item: "fix-a", commit: PIN_2, baselineRef: "HEAD", scope: ["src/a.js"] }],
      },
    ]);
    expect(JSON.stringify(integrate.job)).not.toMatch(/read-secret|write-secret/);
    // Tokens were minted Worker-side for exactly the job's repos, and revoked.
    expect(integrate.repos).toEqual({
      [`/git/ns/${ID}--board-agent-1.git`]: expect.stringMatching(/^read-secret-/),
      [`/git/ns/${ID}--integration.git`]: expect.stringMatching(/^write-secret-/),
    });
    expect(integrate.artifactsHost).toBe(HOST);
    expect(integrate.deadlineMs).toBe(60_000 + 120_000 + 5 * 60 * 1000);
    const minted = [...s.provisioner.readTokens.map((_, i) => `read-${i + 1}`), ...s.provisioner.writeTokens.map((_, i) => `write-${i + 1}`)];
    expect(s.provisioner.revoked.map((r) => r.tokenId).sort()).toEqual(minted.sort());

    // Recorded through the board's integration path; the branch advanced after.
    const board = await s.board();
    const revs = board.messages.filter((m) => m.type === "integrated.rev");
    expect(revs).toHaveLength(1);
    expect(revs[0]!.type === "integrated.rev" && revs[0]!.payload).toMatchObject({ n: 1, commit: GATED, gate: "pass", merged: [PIN_2], contributors: ["agent-1"] });
    expect(board.state.integrated?.commit).toBe(GATED);
    const advance = runner.requests.find((r) => r.job.kind === "advance")!;
    expect(advance.job).toMatchObject({ kind: "advance", commit: GATED });
    expect(Object.keys(advance.repos)).toEqual([`/git/ns/${ID}--integration.git`]);

    // The open view: the attempt with its phases and install; never the inventory's names.
    const view = await s.h.json<{ revisions: { recorded: boolean; n: number; advanced: boolean; phases: unknown[]; install: { status: string } }[]; active?: unknown }>(
      "GET",
      `/changes/${ID}/integration/cloud`,
    );
    expect(view.body.revisions).toHaveLength(1);
    expect(view.body.revisions[0]).toMatchObject({ recorded: true, n: 1, advanced: true, install: { status: "installed" } });
    expect(view.body.revisions[0]!.phases).toHaveLength(5);
    expect(view.body.active).toBeUndefined();
    expect(JSON.stringify(view.body)).not.toContain("secret test name");
    expect(JSON.stringify(view.body)).not.toMatch(/read-secret|write-secret/);

    // Replaying the record step (a lost response) returns the stored record: one revision.
    const plan = (await s.h.state(ID).getCloudIntegration()).revisions[0]!;
    const replay = await workerIntegrationPorts(s.h.env, ID).record({
      plan: { key: plan.key, pendingKey: plan.pendingKey, job: integrate.job as never, agents: [], items: [{ item: "fix-a", agent: "agent-1", commit: PIN_2 }], excludedAgents: [] },
      outcome: { key: plan.key, result: passResult(), phases: [] },
    });
    expect(replay.n).toBe(1);
    expect((await s.board()).messages.filter((m) => m.type === "integrated.rev")).toHaveLength(1);
  });

  it("records a failing revision that implicates every merged item and asks for a fix", async () => {
    const runner = fakeRunner((request) => ({ key: request.key, result: failResult(), phases: [...PHASES] }));
    const s = await setup(runner);
    await s.push(PIN_1);
    const result = await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    expect(result.recorded[0]).toMatchObject({ recorded: true, gate: "fail", n: 1 });
    const board = await s.board();
    const rev = board.messages.find((m) => m.type === "integrated.rev");
    expect(rev?.type === "integrated.rev" && rev.payload.failing?.items).toEqual(["fix-a"]);
    expect(rev?.type === "integrated.rev" && rev.payload.failing?.output).toContain("AssertionError [ERR_ASSERTION]: a must be 2");
    expect(board.messages.some((m) => m.type === "fix.requested")).toBe(true);
    // No advance after a failing revision.
    expect(runner.requests.some((r) => r.job.kind === "advance")).toBe(false);
    const view = (await s.h.state(ID).getCloudIntegration()).revisions[0]!;
    expect(view).toMatchObject({ implicated: { items: ["fix-a"], source: "parse" }, parsed: ["fix-a"], failure: "AssertionError [ERR_ASSERTION]: a must be 2" });
  });

  it("records nothing when a merged push was superseded while the gate ran", async () => {
    let s: Setup | undefined;
    const runner = fakeRunner(async (request) => {
      if (request.job.kind === "integrate" && request.job.units[0]!.commit === PIN_1) {
        await s!.push(PIN_2); // lands while the gate runs
      }
      return { key: request.key, result: request.job.kind === "advance" ? { version: 1, kind: "advance", advanced: true, commit: request.job.commit, phases: [], durationMs: 1 } : passResult(), phases: [] };
    });
    s = await setup(runner);
    await s.push(PIN_1);
    const result = await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    // The first attempt is stale; the loop integrates the newer push next.
    expect(result.recorded.map((r) => [r.recorded, r.reason ?? r.gate])).toEqual([
      [false, "a merged push was superseded while the gate ran"],
      [true, "pass"],
    ]);
    const revs = (await s.board()).messages.filter((m) => m.type === "integrated.rev");
    expect(revs).toHaveLength(1);
    expect(revs[0]!.type === "integrated.rev" && revs[0]!.payload.merged).toEqual([PIN_2]);
  });

  it("treats a job that cannot run as transient: nothing recorded, tried again on the next request", async () => {
    let fail = true;
    const runner = fakeRunner((request) =>
      fail
        ? { key: request.key, error: "the gate container failed: no container", phases: [] }
        : { key: request.key, result: request.job.kind === "advance" ? { version: 1, kind: "advance", advanced: true, commit: request.job.commit, phases: [], durationMs: 1 } : passResult(), phases: [] },
    );
    const s = await setup(runner);
    await s.push(PIN_1);
    const first = await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    expect(first.stop).toBe("failed");
    expect(first.recorded[0]).toMatchObject({ recorded: false });
    expect(runner.requests.filter((r) => r.job.kind === "integrate")).toHaveLength(3); // the step's retries
    const view = await s.h.state(ID).getCloudIntegration();
    expect(view.revisions[0]).toMatchObject({ transient: true, recorded: false });
    expect(view.active).toBeUndefined();
    expect((await s.board()).messages.some((m) => m.type === "integrated.rev")).toBe(false);
    // A kick starts a fresh Workflow, which integrates the same pushes now.
    fail = false;
    const kicked = await s.h.json<{ started: boolean; instanceId: string }>("POST", `/changes/${ID}/integration/cloud/kick`);
    expect(kicked.body.started).toBe(true);
    const second = await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), kicked.body.instanceId);
    expect(second.recorded[0]).toMatchObject({ recorded: true, gate: "pass" });
  });

  it("retries a job whose egress phases did not hold, and never records it as a verdict", async () => {
    const runner = fakeRunner((request) => ({
      key: request.key,
      result: { version: 1, kind: "integrate", outcome: "refused", transient: true, error: "the gate egress phase could not be entered: no ack", phases: [], durationMs: 1 },
      phases: [],
    }));
    const s = await setup(runner);
    await s.push(PIN_1);
    const result = await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    expect(result.stop).toBe("failed");
    expect(runner.requests.filter((r) => r.job.kind === "integrate")).toHaveLength(3);
    const view = await s.h.state(ID).getCloudIntegration();
    expect(view.revisions[0]).toMatchObject({ recorded: false, transient: true });
    expect(view.revisions[0]!.reason).toMatch(/egress phase could not be entered/);
    // Not "attempted": the next plan offers the same pushes again.
    expect((await s.h.state(ID).planCloudIntegration()).kind).toBe("job");
  });

  it("attributes a failing revision by parsing its output: only the implicated owner is asked to fix", async () => {
    const runner = fakeRunner((request) => ({ key: request.key, result: failResult("AssertionError [ERR_ASSERTION]: b must be 3", ["agent-1", "agent-2"]), phases: [] }));
    const s = await setup(runner, { second: true });
    await s.push(PIN_1);
    await s.push2(PIN_2);
    const steps = fakeSteps();
    await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), steps, s.workflow.created[0]!.id);
    expect(steps.waits).toEqual([]); // the engine attributes alone: nothing to wait for
    const board = await s.board();
    const rev = board.messages.find((m) => m.type === "integrated.rev");
    expect(rev?.type === "integrated.rev" && rev.payload.failing?.items).toEqual(["fix-b"]);
    expect(board.messages.filter((m) => m.type === "fix.requested").map((m) => m.type === "fix.requested" && m.payload.item)).toEqual(["fix-b"]);
    expect((await s.h.state(ID).getCloudIntegration()).revisions[0]).toMatchObject({ implicated: { items: ["fix-b"], source: "parse" } });
  });

  it("holds a failing revision for the run's advisory attribution, validates it, and narrows with it", async () => {
    const runner = fakeRunner((request) => ({ key: request.key, result: failResult("Error: something broke somewhere", ["agent-1", "agent-2"]), phases: [] }));
    const s = await setup(runner, { second: true, attribution: "driver" });
    await s.push(PIN_1);
    await s.push2(PIN_2);
    const steps = fakeSteps(async (type) => {
      const view = await s.h.json<{ pendingAttribution?: { key: string; items: { id: string }[]; output: string; parsed: string[] } }>("GET", `/changes/${ID}/integration/cloud`);
      const pending = view.body.pendingAttribution!;
      expect(type).toBe(`attribution-${pending.key}`);
      expect(pending.items.map((i) => i.id)).toEqual(["fix-a", "fix-b"]);
      expect(pending.parsed).toEqual([]);
      expect(pending.output).toContain("something broke");
      // Only items the revision merged are accepted.
      expect((await s.h.json("POST", `/changes/${ID}/integration/cloud/attribution`, { key: pending.key, items: ["fix-z"] })).status).toBe(400);
      expect((await s.h.json("POST", `/changes/${ID}/integration/cloud/attribution`, { key: "ij-other", items: ["fix-a"] })).status).toBe(409);
      expect((await s.h.json("POST", `/changes/${ID}/integration/cloud/attribution`, { key: pending.key, items: ["fix-a"] })).status).toBe(201);
      expect((await s.h.json("POST", `/changes/${ID}/integration/cloud/attribution`, { key: pending.key, items: ["fix-b"] })).status).toBe(409);
    });
    await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), steps, s.workflow.created[0]!.id);
    expect(steps.waits).toHaveLength(1);
    const rev = (await s.board()).messages.find((m) => m.type === "integrated.rev");
    expect(rev?.type === "integrated.rev" && rev.payload.failing?.items).toEqual(["fix-a"]);
    expect((await s.h.state(ID).getCloudIntegration()).revisions[0]).toMatchObject({ implicated: { items: ["fix-a"], source: "jev" }, parsed: [] });
  });

  it("records with the parse alone when the run does not answer in time", async () => {
    const runner = fakeRunner((request) => ({ key: request.key, result: failResult("Error: something broke somewhere", ["agent-1", "agent-2"]), phases: [] }));
    const s = await setup(runner, { second: true, attribution: "driver" });
    await s.push(PIN_1);
    await s.push2(PIN_2);
    const steps = fakeSteps(); // the wait times out
    await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), steps, s.workflow.created[0]!.id);
    expect(steps.waits).toHaveLength(1);
    const rev = (await s.board()).messages.find((m) => m.type === "integrated.rev");
    expect(rev?.type === "integrated.rev" && rev.payload.failing?.items).toEqual(["fix-a", "fix-b"]);
  });

  it("fixes the configuration at goal time: it is refused after the goal, and set only once", async () => {
    const runner = fakeRunner((request) => ({ key: request.key, result: passResult(), phases: [] }));
    const s = await setup(runner);
    // A gate of `true` after the goal would green anything: refused.
    const changed = await s.h.json<{ code: string; error: string }>("POST", `/changes/${ID}/integration/cloud`, config({ gateCommand: ["true"] }));
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatch(/fixed/);
    expect((await s.h.state(ID).getCloudIntegration()).config).toMatchObject({ gateCommand: ["npm", "run", "gate"] });
    // Before any goal, still only once.
    const h = createHarness({ provisioner: new HttpsProvisioner() });
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/integration/cloud`, config())).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/integration/cloud`, config({ gateCommand: ["true"] }))).status).toBe(409);
    // Nothing is planned before the goal.
    expect(await h.state(ID).planCloudIntegration()).toMatchObject({ kind: "idle", reason: "the board has no goal yet" });
  });

  it("replaces an active Workflow that ended without finishing", async () => {
    const runner = fakeRunner((request) => ({ key: request.key, result: passResult(), phases: [] }));
    const s = await setup(runner);
    await s.push(PIN_1);
    const first = s.workflow.created[0]!.id;
    s.workflow.statuses.set(first, "errored");
    await s.push(PIN_2);
    expect(s.workflow.created).toHaveLength(2);
    expect(s.workflow.created[1]!.id).not.toBe(first);
  });

  it("keeps the active Workflow when its status cannot be read (never a second Workflow)", async () => {
    const runner = fakeRunner((request) => ({ key: request.key, result: passResult(), phases: [] }));
    const s = await setup(runner);
    await s.push(PIN_1);
    expect(s.workflow.created).toHaveLength(1);
    const first = s.workflow.created[0]!.id;
    // The instance exists, but reading its status fails (a transient error).
    const realGet = s.workflow.binding.get;
    s.workflow.binding.get = async (id: string) => {
      await realGet(id);
      return {
        status: async () => {
          throw new Error("the Workflows API timed out");
        },
      };
    };
    await s.push(PIN_2);
    expect(s.workflow.created).toHaveLength(1);
    const kicked = await s.h.json<{ started: boolean; coalesced: boolean; instanceId: string }>("POST", `/changes/${ID}/integration/cloud/kick`);
    expect(kicked.body).toMatchObject({ started: false, coalesced: true, instanceId: first });
    expect(s.workflow.created).toHaveLength(1);
    // A positively unknown instance (not found) is replaced.
    s.workflow.binding.get = async () => {
      throw new Error("instance.not_found");
    };
    await s.push("3".repeat(40));
    expect(s.workflow.created).toHaveLength(2);
  });

  it("never advances the integration branch to an UNGATED pass", async () => {
    const runner = fakeRunner((request) => ({
      key: request.key,
      result:
        request.job.kind === "advance"
          ? { version: 1, kind: "advance", advanced: true, commit: request.job.commit, phases: [], durationMs: 1 }
          : { ...passResult(), gated: false },
      phases: [],
    }));
    const s = await setup(runner);
    await s.push(PIN_1);
    const result = await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    expect(result.recorded[0]).toMatchObject({ recorded: true, gate: "pass" });
    const rev = (await s.board()).messages.find((m) => m.type === "integrated.rev");
    expect(rev?.type === "integrated.rev" && rev.payload.gated).toBe(false);
    expect(runner.requests.some((r) => r.job.kind === "advance")).toBe(false);
    expect((await s.h.state(ID).getCloudIntegration()).revisions[0]).toMatchObject({ gated: false });
    expect((await s.h.state(ID).getCloudIntegration()).revisions[0]!.advanced).toBeUndefined();
  });

  it("keys the advance by the repo, the base, the commit, and the revision", async () => {
    const runner = fakeRunner((request) => ({
      key: request.key,
      result: request.job.kind === "advance" ? { version: 1, kind: "advance", advanced: true, commit: request.job.commit, phases: [], durationMs: 1 } : passResult(),
      phases: [],
    }));
    const s = await setup(runner);
    await s.push(PIN_1);
    await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    const advance = runner.requests.find((r) => r.job.kind === "advance")!;
    expect(advance.key).toMatch(/^aj-[0-9a-f]{32}$/);
    expect(advance.key).not.toBe(`advance-${GATED}`);
  });

  it("a re-created Change (or a different gate) never replays a prior run's stored outcome", async () => {
    // A runner that caches finished outcomes by key, like the real GateRunner.
    const cache = new Map<string, GateRunOutcome>();
    const runner = fakeRunner((request) => {
      const hit = cache.get(request.key);
      if (hit) {
        return { ...hit, cached: true };
      }
      const outcome: GateRunOutcome = {
        key: request.key,
        result: request.job.kind === "advance" ? { version: 1, kind: "advance", advanced: true, commit: request.job.commit, phases: [], durationMs: 1 } : passResult(),
        phases: [],
      };
      cache.set(request.key, outcome);
      return outcome;
    });
    const s = await setup(runner);
    await s.push(PIN_1);
    await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    const firstKey = runner.requests.find((r) => r.job.kind === "integrate")!.key;

    // The same Change id re-created, configured with ANOTHER gate, and the same pin pushed again.
    expect((await s.h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    expect((await s.h.json("POST", `/changes/${ID}/integration/cloud`, config({ gateCommand: ["npm", "run", "other-gate"] }))).status).toBe(201);
    expect((await s.h.json("POST", `/changes/${ID}/board/human`, { type: "goal.posted", payload: { objective: "make a equal 2" } })).status).toBe(201);
    const lead = await s.h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "lead", role: "lead" });
    await s.h.json("POST", `/changes/${ID}/board`, { type: "item.proposed", payload: { item: "fix-a", objective: "fix a", scopeHint: ["src/a.js"] } }, { [TOKEN_HEADER]: lead.body.token });
    const agent = await s.h.json<{ token: string }>("POST", `/changes/${ID}/board/join`, { agent: "agent-1", workspace: { ttlSeconds: 600 } });
    await s.h.json("POST", `/changes/${ID}/board`, { type: "item.claimed", payload: { item: "fix-a", intent: { read: [], write: ["src/a.js"] } } }, { [TOKEN_HEADER]: agent.body.token });
    await s.h.json("POST", `/changes/${ID}/board`, { type: "push.announced", payload: { item: "fix-a", commit: PIN_1, paths: ["src/a.js"] } }, { [TOKEN_HEADER]: agent.body.token });
    const planned = await s.h.state(ID).planCloudIntegration();
    expect(planned.kind).toBe("job");
    const secondKey = planned.kind === "job" ? planned.plan.key : "";
    expect(secondKey).not.toBe(firstKey);
    expect(cache.has(secondKey)).toBe(false);
  });

  it("records each revision with the base it was built on, so the board refuses a stale one (STALE_BASE)", async () => {
    const runner = fakeRunner((request) => ({
      key: request.key,
      result: request.job.kind === "advance" ? { version: 1, kind: "advance", advanced: true, commit: request.job.commit, phases: [], durationMs: 1 } : passResult(),
      phases: [],
    }));
    const s = await setup(runner);
    await s.push(PIN_1);
    const planned = await s.h.state(ID).planCloudIntegration();
    expect(planned.kind).toBe("job");
    if (planned.kind !== "job") {
      return;
    }
    const state = (await s.board()).state;
    // Built on the integrated head (the job's base commit): that base is recorded.
    const onBase = { ...planned.plan, job: { ...planned.plan.job, baseCommit: "b".repeat(40) } };
    const decided = decideCloudRevision(onBase, passResult(), state);
    expect(decided.kind === "record" && decided.input.base).toBe("b".repeat(40));
    const failing = decideCloudRevision(onBase, failResult(), state);
    expect(failing.kind === "record" && failing.input.base).toBe("b".repeat(40));
    // Built on the branch head before any pass: the goal's baseline.
    expect(decideCloudRevision(planned.plan, passResult(), { ...state, baseline: "a".repeat(40) })).toMatchObject({ kind: "record", input: { base: "a".repeat(40) } });
    // The cloud job carries the same per-item path selection as the local integrator,
    // and the revision records what each merged unit applied (only merged agents).
    expect(planned.plan.job.units[0]!.parts).toEqual([{ item: "fix-a", commit: PIN_1, baselineRef: "HEAD", scope: ["src/a.js"] }]);
    const withApplied = passResult();
    const appliedResult: IntegrateJobResult = {
      ...withApplied,
      evidence: {
        ...withApplied.evidence!,
        integration: {
          ...withApplied.evidence!.integration,
          appliedUnits: [
            { unitId: "agent-1", applied: ["src/a.js"], yielded: ["src/b.js"] },
            { unitId: "agent-9", applied: ["src/x.js"], yielded: [] },
          ],
        },
      },
    };
    expect(decideCloudRevision(onBase, appliedResult, state)).toMatchObject({ kind: "record", input: { applied: [{ agent: "agent-1", paths: ["src/a.js"], yielded: ["src/b.js"] }] } });
    // Revision 1 passes; then a job built on anything but its commit is stale.
    await runIntegrationLoop(workerIntegrationPorts(s.h.env, ID), fakeSteps(), s.workflow.created[0]!.id);
    expect((await s.board()).state.integrated?.commit).toBe(GATED);
    await s.push(PIN_2);
    const next = await s.h.state(ID).planCloudIntegration();
    expect(next.kind === "job" && next.plan.job.baseCommit).toBe(GATED);
    if (next.kind !== "job") {
      return;
    }
    const stale = { ...next.plan, job: { ...next.plan.job, baseCommit: "b".repeat(40) } };
    const record = await s.h.state(ID).recordCloudRevision({ plan: stale, result: passResult("8".repeat(40)), phases: [] });
    expect(record.recorded).toBe(false);
    expect(record.reason).toMatch(/STALE_BASE/);
    expect((await s.board()).messages.filter((m) => m.type === "integrated.rev")).toHaveLength(1);
  });

  it("refuses a configuration whose job could outlive its one-hour Artifact tokens", async () => {
    const h = createHarness({ provisioner: new HttpsProvisioner() });
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    const tooLong = await h.json<{ error: string }>("POST", `/changes/${ID}/integration/cloud`, config({ timeouts: { installMs: 30 * 60_000, gateMs: 60 * 60_000 } }));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatch(/tokens live at most 60 min.*keep installMs \+ gateMs at or under 53 min/);
    // 53 minutes of install + gate (58 with the overhead) fits under the token lifetime minus its margin.
    expect((await h.json("POST", `/changes/${ID}/integration/cloud`, config({ timeouts: { installMs: 23 * 60_000, gateMs: 30 * 60_000 } }))).status).toBe(201);
  });

  it("does nothing on a push when integration on Cloudflare is not configured", async () => {
    const provisioner = new HttpsProvisioner();
    const workflow = fakeWorkflow();
    const h = createHarness({ provisioner, env: { INTEGRATION_WORKFLOW: workflow.binding } });
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/integration/cloud/kick`)).body).toEqual({
      started: false,
      reason: "integration on Cloudflare is not configured for this Change",
    });
    expect(workflow.created).toHaveLength(0);
  });

  it("validates the configuration with the job schema (tokenless https only)", async () => {
    const h = createHarness({ provisioner: new HttpsProvisioner() });
    expect((await h.json("POST", "/changes", specYaml(ID))).status).toBe(201);
    const bad = await h.json<{ error: string }>("POST", `/changes/${ID}/integration/cloud`, {
      integration: { workspaceName: "x", gitUrl: `https://t:secret@${HOST}/git/ns/x.git`, defaultBranch: "main" },
      requireGate: false,
      protectedPaths: [],
      protectedJsonKeys: [],
      timeouts: { installMs: 60_000, gateMs: 60_000 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/must not carry credentials/);
    const local = await h.json<{ error: string }>("POST", `/changes/${ID}/integration/cloud`, {
      integration: { workspaceName: "x", gitUrl: "file:///tmp/x.git", defaultBranch: "main" },
      requireGate: false,
      protectedPaths: [],
      protectedJsonKeys: [],
      timeouts: { installMs: 60_000, gateMs: 60_000 },
    });
    expect(local.status).toBe(400);
  });

  it("issues and revokes integration repo tokens through the bearer routes", async () => {
    const provisioner = new HttpsProvisioner();
    const h = createHarness({ provisioner, apiToken: "op-token" });
    const auth = { authorization: "Bearer op-token" };
    expect((await h.json("POST", "/changes", specYaml(ID), auth)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/integration/cloud/workspace`, { ttlSeconds: 600 })).status).toBe(401);
    const ws = await h.json<{ workspaceName: string; gitUrl: string; token: string }>("POST", `/changes/${ID}/integration/cloud/workspace`, { ttlSeconds: 600 }, auth);
    expect(ws.status).toBe(201);
    expect(ws.body.workspaceName).toBe(`${ID}--integration`);
    const token = await h.json<{ tokenId: string; workspaceName: string }>("POST", `/changes/${ID}/integration/cloud/token`, { scope: "read", ttlSeconds: 300 }, auth);
    expect(token.status).toBe(201);
    expect(token.body.workspaceName).toBe(`${ID}--integration`);
    expect((await h.json("POST", `/changes/${ID}/integration/cloud/token/revoke`, { tokenId: token.body.tokenId }, auth)).status).toBe(200);
    expect(provisioner.revoked.at(-1)).toEqual({ workspaceName: `${ID}--integration`, tokenId: token.body.tokenId });
    expect((await h.json("POST", `/changes/${ID}/integration/cloud/token`, { scope: "admin" }, auth)).status).toBe(400);
  });
});

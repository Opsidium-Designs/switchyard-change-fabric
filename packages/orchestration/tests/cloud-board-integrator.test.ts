/**
 * The driver's side of integration on Cloudflare (offline, a fake Worker):
 *   - the revisions the integration Workflow recorded become the run's
 *     revisions (with their evidence for promotion), in board order;
 *   - a refused attempt is reported as a failure and settles its pending
 *     set; a stale or transient one does not;
 *   - idle() waits while the Workflow is active, re-asks (bounded) when it
 *     ended with pushes pending, and gives up honestly;
 *   - gateSupportFilesFor reads only the app's sibling .mjs files.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardState } from "@switchyard-change/change-core";

import { CloudBoardIntegrator, gateSupportFilesFor } from "../src/cloud-board-integrator.ts";

const BASE = "http://worker.test";
const ID = "change-cloud";

function pendingState(commit: string): BoardState {
  const state = emptyBoard();
  state.items["fix-a"] = {
    id: "fix-a",
    objective: "fix a",
    acceptance: [],
    scopeHint: [],
    status: "claimed",
    proposedBy: "lead",
    proposedSeq: 1,
    children: [],
    owner: "agent-1",
    doneProposed: false,
    lastPush: { seq: 5, commit, agent: "agent-1", paths: ["src/a.js"] },
  };
  return state;
}

/** A fake Worker serving the integration view and counting kicks. */
function fakeWorker(views: (() => unknown)[]) {
  let reads = 0;
  const kicks: number[] = [];
  const answers: unknown[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/changes/${ID}/integration/cloud` && (init?.method ?? "GET") === "GET") {
      const view = views[Math.min(reads, views.length - 1)]!();
      reads += 1;
      return new Response(JSON.stringify(view), { status: 200 });
    }
    if (url === `${BASE}/changes/${ID}/integration/cloud/attribution`) {
      answers.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ accepted: true }), { status: 201 });
    }
    if (url === `${BASE}/changes/${ID}/integration/cloud/kick`) {
      kicks.push(reads);
      return new Response(JSON.stringify({ started: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, kicks, answers, reads: () => reads };
}

const EVIDENCE = {
  changeId: ID,
  units: [],
  integration: { verdict: "verified", integratedUnits: ["agent-1"], excludedUnits: [], commit: "9".repeat(40), finalCheck: { kind: "app-gate", passed: true, skipped: false, summary: "ok", outputs: [] } },
};

const RECORDED = {
  key: "ij-1",
  pendingKey: "1".repeat(40),
  at: "t1",
  recorded: true,
  n: 1,
  gate: "pass",
  gated: true,
  commit: "9".repeat(40),
  merged: ["1".repeat(40)],
  integratedItems: ["fix-a"],
  excludedItems: [],
  excludedAgents: [],
  completedItems: [],
  install: { status: "installed", tool: "npm", detail: "npm ci", durationMs: 900 },
  phases: [{ phase: "fetch", egress: "artifacts-only", at: "t0" }],
  evidence: EVIDENCE,
  advanced: true,
};

describe("CloudBoardIntegrator", () => {
  it("follows the revisions the Workflow records, with their evidence", async () => {
    let state = pendingState("1".repeat(40));
    const worker = fakeWorker([
      () => ({ configured: true, kicked: false, active: { instanceId: "i1", startedAt: "t" }, revisions: [] }),
      () => {
        state = { ...emptyBoard() };
        return { configured: true, kicked: false, revisions: [RECORDED] };
      },
    ]);
    const seen: number[] = [];
    const integrator = new CloudBoardIntegrator({
      fetchFn: worker.fetchFn,
      base: BASE,
      changeId: ID,
      requiresGate: true,
      readState: async () => state,
      pollMs: 1,
      onRevision: (r) => seen.push(r.n),
    });
    expect(integrator.wants(state)).toBe(true);
    await integrator.idle();
    expect(seen).toEqual([1]);
    expect(integrator.revisions[0]).toMatchObject({ n: 1, gate: "pass", gated: true, commit: "9".repeat(40), integratedItems: ["fix-a"], install: { status: "installed" } });
    expect(integrator.lastEvidence).toEqual(EVIDENCE);
    expect(integrator.lastRequiresGate).toBe(true);
    expect(integrator.phasesByRevision.get(1)).toHaveLength(1);
    expect(integrator.busy).toBe(false);
    expect(integrator.failures).toEqual([]);
  });

  it("reports a refused attempt (settling its pending set) but not a stale one", async () => {
    const state = pendingState("1".repeat(40));
    const worker = fakeWorker([
      () => ({
        configured: true,
        kicked: false,
        revisions: [
          { key: "ij-a", pendingKey: "0".repeat(40), at: "t0", recorded: false, stale: true, reason: "a merged push was superseded while the gate ran", excludedAgents: [] },
          { key: "ij-b", pendingKey: "1".repeat(40), at: "t1", recorded: false, reason: "every pending push was excluded: agent-1: failed verification (path-scope: ...)", excludedAgents: [] },
        ],
      }),
    ]);
    const integrator = new CloudBoardIntegrator({ fetchFn: worker.fetchFn, base: BASE, changeId: ID, requiresGate: true, readState: async () => state, pollMs: 1 });
    await integrator.idle();
    expect(integrator.failures).toEqual(["integration not recorded: every pending push was excluded: agent-1: failed verification (path-scope: ...)"]);
    expect(integrator.wants(state)).toBe(false);
    expect(worker.kicks).toEqual([]);
  });

  it("re-asks a bounded number of times when the Workflow ended with pushes pending, then says so", async () => {
    const state = pendingState("1".repeat(40));
    const worker = fakeWorker([() => ({ configured: true, kicked: false, revisions: [] })]);
    const integrator = new CloudBoardIntegrator({ fetchFn: worker.fetchFn, base: BASE, changeId: ID, requiresGate: false, readState: async () => state, pollMs: 1, maxKicks: 2 });
    await integrator.idle();
    expect(worker.kicks).toHaveLength(2);
    expect(integrator.failures).toEqual(["the integration Workflow did not integrate the pending pushes after 2 request(s)"]);
  });
});

describe("CloudBoardIntegrator advisory attribution", () => {
  it("answers a held failing revision with the typed-decision choice and records the decision linked to its revision", async () => {
    let state = pendingState("1".repeat(40));
    const request = { key: "ij-f", items: [{ id: "fix-a", objective: "a", paths: ["src/a.js"] }, { id: "fix-b", objective: "b", paths: ["src/b.js"] }], output: "Error: broke", parsed: [] };
    const failing = { ...RECORDED, key: "ij-f", gate: "fail", n: 1, implicated: { items: ["fix-b"], source: "jev" }, parsed: [] };
    const worker = fakeWorker([
      () => ({ configured: true, kicked: false, active: { instanceId: "i1", startedAt: "t" }, pendingAttribution: request, revisions: [] }),
      () => {
        state = emptyBoard();
        return { configured: true, kicked: false, revisions: [failing] };
      },
    ]);
    const recorded: unknown[] = [];
    const integrator = new CloudBoardIntegrator({
      fetchFn: worker.fetchFn,
      base: BASE,
      changeId: ID,
      requiresGate: true,
      readState: async () => state,
      pollMs: 1,
      attribute: async (r) => {
        expect(r.key).toBe("ij-f");
        return { items: ["fix-b"], source: "jev", decisions: [{ juncture: "attribution", question: "Which item?", answer: "fix-b", confidence: 0.9, accepted: true, parsed: [] }] };
      },
      recordDecision: async (d) => {
        recorded.push(d);
        return "recorded";
      },
    });
    await integrator.idle();
    expect(worker.answers).toEqual([{ key: "ij-f", items: ["fix-b"] }]);
    expect(recorded).toEqual([{ juncture: "attribution", question: "Which item?", answer: "fix-b", confidence: 0.9, accepted: true, rev: 1, parsed: [] }]);
    expect(integrator.revisions[0]?.implicated).toEqual({ items: ["fix-b"], source: "jev" });
  });

  it("sends no choice when the typed decision was not confident (the parse stands)", async () => {
    const request = { key: "ij-g", items: [{ id: "fix-a", objective: "a", paths: [] }, { id: "fix-b", objective: "b", paths: [] }], output: "x", parsed: [] };
    const worker = fakeWorker([() => ({ configured: true, kicked: false, pendingAttribution: request, revisions: [] })]);
    const integrator = new CloudBoardIntegrator({
      fetchFn: worker.fetchFn,
      base: BASE,
      changeId: ID,
      requiresGate: true,
      readState: async () => emptyBoard(),
      attribute: async () => ({ items: ["fix-a", "fix-b"], source: "all", decisions: [] }),
    });
    await integrator.poll();
    await integrator.poll();
    expect(worker.answers).toEqual([{ key: "ij-g", items: [] }]);
  });
});

describe("gateSupportFilesFor", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scf-support-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the app's sibling .mjs files only", async () => {
    await mkdir(join(root, "apps", "svc", "gate"), { recursive: true });
    await writeFile(join(root, "apps", "gate-harness.mjs"), "export const x = 1;\n");
    await writeFile(join(root, "apps", "notes.txt"), "no\n");
    await writeFile(join(root, "apps", "svc", "gate", "gate.test.mjs"), "inside the app\n");
    expect(await gateSupportFilesFor(join(root, "apps", "svc"))).toEqual([{ name: "gate-harness.mjs", content: "export const x = 1;\n" }]);
  });
});

/**
 * M5: the full end-to-end run, the human escalation beat, verification,
 * integration, and local-Git promotion, proven deterministically and offline.
 *
 * runFullLive drives the live Worker over HTTP. These tests point it at an
 * in-process fake Worker fetch backed by the real `LocalChangeControl` (the same
 * change-core scheduling and escalation logic the Durable Object uses) and a
 * local-filesystem workspace provider, so the whole chain runs under `make
 * check` with no Cloudflare account and no inference. The executor is the
 * deterministic scoped-noop, so edits are reproducible.
 *
 * They assert the M5 claims:
 *   (a) the engine raises a human escalation on the seeded contested shared path
 *       and WAITS on a durable pending record until a human decision resolves it
 *       (the escalation beat), and the graph's `escalated` flag lights while
 *       pending and clears when resolved;
 *   (b) the full chain runs end to end: recruit -> event-driven waves ->
 *       escalation -> verify -> integrate -> promote to a real local-Git commit
 *       -> cleanup of the per-unit workspaces;
 *   (c) ground truth stays mechanical: the verification verdict comes from the
 *       deterministic verifier, not the executor.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";

import { LocalChangeControl, workspaceNameFor } from "../src/local-control.ts";
import { buildWorkGraphModel, type ChangeStateSnapshot } from "../src/graph-model.ts";
import { runFullLive } from "../src/run-live.ts";

/**
 * A seeded Change with a shared contested path: `api` and `tests` both declare
 * `src/audit/events.ts`, which is the genuine evidence-unsettled fork the
 * escalation beat raises (which agent owns the single write lease is a human
 * call). `model` is independent so the graph has more than the collision.
 */
const SPEC = `
id: change-m5
objective: Add audit logging with a shared events module
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: model
    objective: persist audit events
    paths: [src/model/**]
  - id: api
    objective: add read endpoints and the shared events module
    paths: [src/api/**, src/audit/events.ts]
  - id: tests
    objective: add tests touching the shared events module
    paths: [tests/audit/**, src/audit/events.ts]
`;

/**
 * An in-process fake Worker fetch backed by LocalChangeControl, covering the
 * endpoints runFullLive touches. It is a faithful stand-in: it reuses the real
 * change-core scheduling, recruitment policy, and escalation logic, and
 * provisions real local bare Git repos (file://), so runners do real clone/
 * commit/push with zero Cloudflare setup.
 */
function fakeWorker(control: LocalChangeControl, workspaces: LocalFilesystemWorkspaceProvider) {
  const tokens = new Map<string, string>(); // workspaceName -> plaintext token

  const provisionAndRecord = async (
    changeId: string,
    unitIds: readonly string[],
  ): Promise<unknown[]> => {
    const recruited: unknown[] = [];
    for (const unitId of unitIds) {
      // Reuse the control's lease endpoint, which provisions a real local repo.
      const res = await control.fetch(
        `http://w/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/lease`,
        { method: "POST" },
      );
      if (res.status !== 201) {
        continue;
      }
      const lease = (await res.json()) as Record<string, unknown>;
      tokens.set(String(lease.workspaceName), String(lease.token));
      recruited.push({
        unitId: lease.unitId,
        objective: lease.objective,
        paths: lease.paths,
        baselineRef: lease.baselineRef,
        workspaceName: lease.workspaceName,
        gitUrl: lease.gitUrl,
        defaultBranch: lease.defaultBranch,
        backend: lease.backend,
        fallback: lease.fallback,
        token: lease.token,
      });
    }
    return recruited;
  };

  const fetchFn = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "http://w");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = () => (typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : {});

    if (method === "POST" && url.pathname === "/changes") {
      control.createChange(String(init?.body ?? ""));
      return json({ ok: true }, 201);
    }
    const dial = url.pathname.match(/^\/changes\/([^/]+)\/dial$/);
    if (method === "POST" && dial) {
      const b = body() as { minConcurrency?: number; maxConcurrency?: number };
      const set = control.configureDial(dec(dial[1]), {
        minConcurrency: b.minConcurrency ?? 1,
        maxConcurrency: b.maxConcurrency ?? 3,
      });
      return json({ dial: set });
    }
    const recruit = url.pathname.match(/^\/changes\/([^/]+)\/recruit$/);
    if (method === "POST" && recruit) {
      const changeId = dec(recruit[1]);
      const plan = control.planRecruitment(changeId);
      const recruited = await provisionAndRecord(changeId, plan.recruit);
      control.recordRecruitment(changeId, {
        trigger: "kickoff",
        recruited: plan.recruit,
        ceiling: plan.ceiling,
        inFlightAfter: plan.inFlight + recruited.length,
      });
      return json({ recruited }, 201);
    }
    if (method === "POST" && url.pathname === "/events/repo-pushed") {
      const b = body() as { changeId?: string; workspace?: string };
      const changeId = b.changeId ?? "";
      const outcome = control.recordRepoPushed(changeId, b.workspace ?? "");
      const recruited = await provisionAndRecord(changeId, outcome.recruited);
      control.recordRecruitment(changeId, {
        trigger: "repo-pushed",
        pushedWorkspace: b.workspace,
        completedUnit: outcome.completedUnit ?? undefined,
        recruited: outcome.recruited,
        ceiling: outcome.event.ceiling,
        inFlightAfter: outcome.event.inFlightAfter,
      });
      return json({ recruited });
    }
    const escalate = url.pathname.match(/^\/changes\/([^/]+)\/escalations$/);
    if (method === "POST" && escalate) {
      const b = body() as Record<string, unknown>;
      const escalation = control.raiseEscalation(dec(escalate[1]), {
        kind: b.kind as "lease-owner",
        path: b.path as string | undefined,
        question: String(b.question),
        options: b.options as string[] | undefined,
      });
      return json({ escalation }, 201);
    }
    const resolve = url.pathname.match(/^\/changes\/([^/]+)\/escalations\/([^/]+)\/resolve$/);
    if (method === "POST" && resolve) {
      const b = body() as { decision?: string };
      const escalation = control.resolveEscalation(dec(resolve[1]), dec(resolve[2]), String(b.decision));
      return json({ escalation });
    }
    const state = url.pathname.match(/^\/changes\/([^/]+)$/);
    if (method === "GET" && state) {
      return json(control.state(dec(state[1])));
    }
    const archive = url.pathname.match(/^\/workspaces\/([^/]+)$/);
    if (method === "DELETE" && archive) {
      const name = dec(archive[1]);
      await workspaces
        .archive({ id: "", name, gitUrl: "", defaultBranch: "main", backend: "local-filesystem", fallback: true })
        .catch(() => {});
      return json({ archived: name });
    }
    return json({ error: `not found: ${method} ${url.pathname}` }, 404);
  }) as unknown as typeof fetch;

  return { fetchFn };
}

function json(bodyValue: unknown, status = 200): Response {
  return new Response(JSON.stringify(bodyValue), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function dec(seg: string | undefined): string {
  return decodeURIComponent(seg ?? "");
}

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scf-m5-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("M5: the full end-to-end run with the human escalation beat", () => {
  it("recruits, raises and waits on an escalation, verifies, integrates, promotes, and cleans up", async () => {
    const artifactsRoot = join(workRoot, "artifacts");
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: artifactsRoot });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(SPEC);

    // A small real project directory to use as the promotion baseline.
    const projectDir = join(workRoot, "project");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(join(projectDir, "src", "index.ts"), "export const seeded = true;\n", "utf8");

    const resolverCalls: string[] = [];

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "run"),
      fetchFn,
      resolveEscalation: async (escalation) => {
        resolverCalls.push(escalation.id);
        // The human chooses the owner among the contenders (the first option).
        return escalation.options[0] ?? "api";
      },
    });

    // (b) the full chain ran: every unit completed.
    expect([...result.completed].sort()).toEqual(["api", "model", "tests"]);
    // Distinct real (local-fallback) repos, one per unit.
    expect(result.workspaces.length).toBe(3);
    expect(new Set(result.workspaces).size).toBe(3);

    // (a) the escalation beat: an escalation was raised on the contested path,
    // the engine waited on a durable pending record, and a human decision
    // resolved it before the run proceeded.
    expect(result.escalation.raised).not.toBeNull();
    expect(result.escalation.raised?.kind).toBe("lease-owner");
    expect(result.escalation.raised?.path).toBe("src/audit/events.ts");
    expect(result.escalation.waited).toBe(true);
    expect(result.escalation.resolved?.status).toBe("resolved");
    expect(result.escalation.resolved?.decision).toBe("api");
    expect(resolverCalls.length).toBe(1);

    // (c) mechanical ground truth: the verification verdict comes from the
    // deterministic verifier over the real repos.
    expect(result.evidence.integration.verdict).toBe("verified");
    expect([...result.evidence.integration.integratedUnits].sort()).toEqual([
      "api",
      "model",
      "tests",
    ]);

    // promotion produced a real local-Git branch and commit.
    expect(result.promotion.committed).toBe(true);
    expect(result.promotion.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.promotion.branch).toBe("switchyard/change-m5");

    // cleanup archived every per-unit workspace the run created.
    expect([...result.cleanedUp].sort()).toEqual([...result.workspaces].sort());
  });

  it("the escalation lights the graph's escalated flag while pending and clears it on resolve", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "a2") });
    const control = new LocalChangeControl(workspaces);
    control.createChange(SPEC);

    // Raise a unit-scoped escalation: the graph lights that unit's node.
    const raised = control.raiseEscalation("change-m5", {
      kind: "lease-owner",
      unitId: "api",
      path: "src/audit/events.ts",
      question: "who owns the shared events module?",
      options: ["api", "tests"],
    });
    const pendingModel = buildWorkGraphModel(control.state("change-m5") as ChangeStateSnapshot);
    const apiNode = pendingModel.nodes.find((n) => n.label === "api");
    expect(apiNode?.escalated).toBe(true);
    // No other node is escalated.
    expect(pendingModel.nodes.filter((n) => n.escalated).length).toBe(1);

    // Resolve it: the flag clears.
    control.resolveEscalation("change-m5", raised.id, "api");
    const resolvedModel = buildWorkGraphModel(control.state("change-m5") as ChangeStateSnapshot);
    expect(resolvedModel.nodes.some((n) => n.escalated)).toBe(false);
  });

  it("blocks on an EXTERNAL (browser) decision and only advances once it lands", async () => {
    const artifactsRoot = join(workRoot, "ext-artifacts");
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: artifactsRoot });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "ext-project");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(join(projectDir, "src", "index.ts"), "export const seeded = true;\n", "utf8");

    // Simulate the browser: once the run has recorded a pending escalation, an
    // external actor (not the run driver) resolves it, exactly as the console's
    // POST to the Worker's resolve route does. The run must block until then.
    let resolvedExternally = false;
    const browser = setInterval(() => {
      const pending = control
        .escalations("change-m5")
        .find((e) => e.status === "pending");
      if (pending) {
        control.resolveEscalation("change-m5", pending.id, "tests");
        resolvedExternally = true;
        clearInterval(browser);
      }
    }, 10);

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "ext-run"),
      fetchFn,
      // No resolver: the beat must NOT resolve it itself. It waits for the
      // external (browser) decision and proceeds with that.
      awaitExternalResolution: true,
      externalResolutionPollMs: 10,
      externalResolutionTimeoutMs: 10_000,
    });
    clearInterval(browser);

    // The run blocked on the real pending record and advanced only after the
    // external decision resolved it; it used that human decision, not an auto
    // default (the self-resolve default owner here would be "api").
    expect(resolvedExternally).toBe(true);
    expect(result.escalation.raised).not.toBeNull();
    expect(result.escalation.waited).toBe(true);
    expect(result.escalation.resolved?.status).toBe("resolved");
    expect(result.escalation.resolved?.decision).toBe("tests");

    // The full chain still completed after the human answered.
    expect([...result.completed].sort()).toEqual(["api", "model", "tests"]);
    expect(result.promotion.committed).toBe(true);
  });

  it("raising the same fork twice is idempotent (a re-driven engine does not pile up)", () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "a3") });
    const control = new LocalChangeControl(workspaces);
    control.createChange(SPEC);
    const first = control.raiseEscalation("change-m5", {
      kind: "lease-owner",
      path: "src/audit/events.ts",
      question: "owner?",
      options: ["api", "tests"],
    });
    const second = control.raiseEscalation("change-m5", {
      kind: "lease-owner",
      path: "src/audit/events.ts",
      question: "owner?",
      options: ["api", "tests"],
    });
    expect(second.id).toBe(first.id);
    expect(control.escalations("change-m5").length).toBe(1);
  });
});

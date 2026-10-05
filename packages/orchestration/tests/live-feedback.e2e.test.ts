/**
 * Rich, honest per-node feedback.
 *
 * These tests pin the two tiers of per-node feedback, both proven offline and
 * deterministically under `make check` (no Cloudflare account, no real model,
 * no network): the transport is a FAKE non-streaming transport, the control
 * surface is the real `LocalChangeControl` (the same change-core logic the
 * Durable Object uses), and the executor is the real `WorkersAiExecutor` wired
 * to the fake transport.
 *
 *   1. MODEL TRANSCRIPT: after a run, each unit's state carries the REAL prompt
 *      summary, the model's proposed edit (changed paths + diff), the proposed
 *      commit message, the model id, and token usage, and the graph projection
 *      carries that detail onto the node, so the console's static transcript
 *      reads real state (not synthesized). The transcript is posted when the
 *      unit is done; there is no live token stream.
 *   2. PER-NODE ACTIVITY LOG: the unit's activity log is the ordered REAL run
 *      steps the runner reported (leased, cloning, model-call, applied-edit,
 *      commit, push, pushed, verified), built from recorded steps, never in the
 *      UI; the graph node carries them unchanged.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import {
  WorkersAiExecutor,
  type WorkersAiInvoke,
} from "@switchyard-change/model-adapters";

import { LocalChangeControl } from "../src/local-control.ts";
import { buildWorkGraphModel, unitNodeId, type ChangeStateSnapshot } from "../src/graph-model.ts";
import { runFullLive } from "../src/run-live.ts";

/** A tiny single-unit Change so the run is fast and the assertions are focused. */
const SPEC = `
id: change-m82
objective: Add a validated add function
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: add
    objective: add input types to add()
    paths: [src/add.ts]
`;

/**
 * A deterministic FAKE Workers AI non-streaming transport. It ignores the
 * network and returns a fixed JSON edit document with usage, as a real
 * non-streaming call would. No network, no model.
 */
function fakeInvoke(reply: string): WorkersAiInvoke {
  return async () => {
    return { text: reply, usage: { inputTokens: 42, outputTokens: 13 } };
  };
}

/**
 * An in-process fake Worker fetch backed by LocalChangeControl, covering the
 * endpoints runFullLive touches INCLUDING the M8.2 per-node feedback routes
 * (step, detail, stream). It reuses the control's own fetch for those so the
 * recorded steps/detail/stream are real state, exactly as the live Worker's DO
 * records them.
 */
function fakeWorker(control: LocalChangeControl, workspaces: LocalFilesystemWorkspaceProvider) {
  const provisionAndRecord = async (changeId: string, unitIds: readonly string[]) => {
    const recruited: unknown[] = [];
    for (const unitId of unitIds) {
      const res = await control.fetch(
        `http://w/changes/${encodeURIComponent(changeId)}/work/${encodeURIComponent(unitId)}/lease`,
        { method: "POST" },
      );
      if (res.status !== 201) {
        continue;
      }
      const lease = (await res.json()) as Record<string, unknown>;
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
    const body = () =>
      typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : {};

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
    // The per-node feedback routes: step and detail. These are the real
    // recording paths the control surface mirrors from the Worker's DO.
    const unitRoute = url.pathname.match(/^\/changes\/[^/]+\/work\/[^/]+\/(step|detail)$/);
    if (method === "POST" && unitRoute) {
      return control.fetch(input, init);
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
  workRoot = await mkdtemp(join(tmpdir(), "scf-m82-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("rich per-node feedback, all backed by real state", () => {
  it("records a real activity log and a real model transcript for a run", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "project");
    await mkdir(join(projectDir, "src"), { recursive: true });
    // Seed the in-scope file so the executor reads real current contents and the
    // diff reflects a real change against the baseline.
    await writeFile(join(projectDir, "src", "add.ts"), "export const add = (a, b) => a + b;\n", "utf8");

    // The model's reply: a real JSON edit document, returned non-streaming by
    // the fake transport.
    const edit = JSON.stringify({
      commitMessage: "type the add inputs",
      edits: [{ path: "src/add.ts", contents: "export const add = (a: number, b: number) => a + b;\n" }],
    });
    const executor = new WorkersAiExecutor({
      invoke: fakeInvoke(edit),
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
    });

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 1 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "run"),
      executor,
      fetchFn,
    });

    expect(result.completed).toEqual(["add"]);

    // Read the live state exactly as the console would, and project it.
    const snapshot = control.state("change-m82") as ChangeStateSnapshot;
    const unit = snapshot.work.find((u) => u.id === "add");
    expect(unit).toBeDefined();

    // (2) PER-NODE ACTIVITY LOG: built from REAL recorded steps, in order. The
    // steps are the actual run actions the runner reported, not UI lines.
    const phases = (unit!.activity ?? []).map((s) => s.phase);
    expect(phases).toContain("leased");
    expect(phases).toContain("cloning");
    expect(phases).toContain("model-call");
    expect(phases).toContain("applied-edit");
    expect(phases).toContain("push");
    expect(phases).toContain("verified");
    // The leased step comes before the model-call step (ordered real steps).
    expect(phases.indexOf("leased")).toBeLessThan(phases.indexOf("model-call"));
    // No streaming step is ever recorded: the model is called non-streaming.
    expect(phases).not.toContain("stream");

    // (1) MODEL TRANSCRIPT: the real prompt summary, the proposed edit (changed
    // paths + a real diff), the proposed commit message, the model id, and token
    // usage, read straight from recorded state. These ARE the static transcript
    // the console renders when the unit is done.
    const detail = unit!.detail;
    expect(detail).toBeDefined();
    expect(detail!.model).toBe("@cf/qwen/qwen2.5-coder-32b-instruct");
    expect(detail!.promptSummary).toContain("add input types to add()");
    expect(detail!.editedPaths).toEqual(["src/add.ts"]);
    expect(detail!.diff).toContain("a: number, b: number");
    expect(detail!.inputTokens).toBe(42);
    expect(detail!.outputTokens).toBe(13);
    expect(detail!.commitMessage).toBe("type the add inputs");

    // The graph projection carries the activity and detail onto the node, so the
    // console's transcript is a projection of real state (no-unbacked rule
    // intact: the node still passes the backing guard). The transcript fields
    // the console renders (prompt summary + edit/diff + commit message) are all
    // present on the projected node.
    const model = buildWorkGraphModel(snapshot);
    const node = model.nodes.find((n) => n.id === unitNodeId("add"));
    expect(node?.detail?.promptSummary).toBe(detail!.promptSummary);
    expect(node?.detail?.diff).toBe(detail!.diff);
    expect(node?.detail?.editedPaths).toEqual(detail!.editedPaths);
    expect(node?.detail?.commitMessage).toBe(detail!.commitMessage);
    expect((node?.activity ?? []).length).toBe((unit!.activity ?? []).length);
  });

  it("an activity log entry is only ever a real recorded step (nothing synthesized)", () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "a2") });
    const control = new LocalChangeControl(workspaces);
    control.createChange(SPEC);

    // With no steps recorded, the projected node has no activity: the UI cannot
    // invent one, because the model only carries what the state recorded.
    const empty = buildWorkGraphModel(control.state("change-m82") as ChangeStateSnapshot);
    const emptyNode = empty.nodes.find((n) => n.id === unitNodeId("add"));
    expect(emptyNode?.activity).toBeUndefined();

    // Record exactly one real step; the node then carries exactly that one.
    control.recordStep("change-m82", "add", "cloning", "cloning the repo");
    const after = buildWorkGraphModel(control.state("change-m82") as ChangeStateSnapshot);
    const node = after.nodes.find((n) => n.id === unitNodeId("add"));
    expect((node?.activity ?? []).map((s) => s.phase)).toEqual(["cloning"]);
    expect(node?.activity?.[0]?.message).toBe("cloning the repo");
  });
});

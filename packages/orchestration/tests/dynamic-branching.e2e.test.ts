/**
 * Dynamic branching: fixing one thing REVEALS more work, so the live WorkGraph
 * GROWS mid-run. This proves the mechanism deterministically and offline:
 *
 *   - the executor DISCOVERS follow-up units from a real repo fact (sibling
 *     files carrying a planted marker), not a scripted animation;
 *   - the runner reports them to the control plane, which APPENDS them to the
 *     live Change as real, scoped, backed WorkUnits rooted under the discovering
 *     parent;
 *   - the next recruitment wave recruits the appended units, so the graph has
 *     more nodes at the end than it was created with;
 *   - every node in the grown graph still passes the no-unbacked-node guard, and
 *     the discovered units are verified and integrated like declared ones.
 *
 * It runs against the in-process fake Worker backed by the real
 * LocalChangeControl (the same change-core append/schedule logic the Durable
 * Object uses) plus a local-filesystem workspace provider and a deterministic
 * executor, so there is no Cloudflare account and no inference: the growth is
 * reproducible under `make check`.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { DiscoveringExecutor, ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";

import { LocalChangeControl } from "../src/local-control.ts";
import { assertBacked, buildWorkGraphModel, type ChangeStateSnapshot } from "../src/graph-model.ts";
import { runFullLive } from "../src/run-live.ts";

/**
 * A Change with ONE declared unit that fixes a bug in one file. The project the
 * run clones carries the same planted marker in sibling files, so fixing the
 * first file reveals the identical work elsewhere: the discovery wrapper reports
 * those siblings as follow-up units and the graph grows.
 */
const SPEC = `
id: change-branch
objective: Fix the shared bug and anything it reveals
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: fix-primary
    objective: fix the primary occurrence
    paths: [src/primary.ts]
`;

/**
 * An in-process fake Worker backed by LocalChangeControl, covering the endpoints
 * runFullLive touches INCLUDING the discovered-units route. It provisions real
 * local bare Git repos so runners do real clone/commit/push offline.
 */
function fakeWorker(control: LocalChangeControl) {
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
      control.configureDial(dec(dial[1]), {
        minConcurrency: b.minConcurrency ?? 1,
        maxConcurrency: b.maxConcurrency ?? 3,
      });
      return json({ ok: true });
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
    // The discovered-units route: append follow-up units, exactly as the Worker
    // route does, then the next repo-pushed event recruits them.
    const discovered = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/discovered$/);
    if (method === "POST" && discovered) {
      const b = body() as { units?: unknown[] };
      const added = control.addWorkUnits(
        dec(discovered[1]),
        dec(discovered[2]),
        (b.units ?? []) as Parameters<typeof control.addWorkUnits>[2],
      );
      return json({ added }, 201);
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
    const state = url.pathname.match(/^\/changes\/([^/]+)$/);
    if (method === "GET" && state) {
      return json(control.state(dec(state[1])));
    }
    const archive = url.pathname.match(/^\/workspaces\/([^/]+)$/);
    if (method === "DELETE" && archive) {
      return json({ archived: dec(archive[1]) });
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
  workRoot = await mkdtemp(join(tmpdir(), "scf-branch-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("M8.3 dynamic branching: fixing one thing reveals more work, so the graph grows", () => {
  it("discovers sibling work from a real repo fact, appends it, and recruits it in a later wave", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control);
    const change = parseChangeSpec(SPEC);

    // The project the run clones: the primary file plus TWO sibling files that
    // carry the planted marker. Fixing the primary reveals the siblings.
    const projectDir = join(workRoot, "project");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(join(projectDir, "src", "primary.ts"), "export const bug = 1; // FABRIC-FOLLOWUP\n", "utf8");
    await writeFile(join(projectDir, "src", "sibling-a.ts"), "export const a = 1; // FABRIC-FOLLOWUP\n", "utf8");
    await writeFile(join(projectDir, "src", "sibling-b.ts"), "export const b = 1; // FABRIC-FOLLOWUP\n", "utf8");
    await writeFile(join(projectDir, "src", "clean.ts"), "export const clean = true;\n", "utf8");

    const executor = new DiscoveringExecutor(new ScopedNoopExecutor(), {
      marker: "FABRIC-FOLLOWUP",
      scanDir: "src",
      projectDir,
    });

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 4 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "run"),
      fetchFn,
      executor,
    });

    // The Change was created with ONE unit; the graph grew to include the two
    // discovered siblings (not clean.ts, which carries no marker).
    const snapshot = control.state("change-branch") as ChangeStateSnapshot;
    const ids = snapshot.work.map((u) => u.id).sort();
    expect(ids).toContain("fix-primary");
    expect(ids).toContain("fix-primary+sibling-a");
    expect(ids).toContain("fix-primary+sibling-b");
    expect(ids.length).toBe(3);
    // No marker in clean.ts, so no unit was discovered for it.
    expect(ids.some((id) => id.includes("clean"))).toBe(false);

    // Each discovered unit is rooted under the parent (its node and edge are
    // backed), scoped to a single real file, and depends on the parent.
    const siblingA = snapshot.work.find((u) => u.id === "fix-primary+sibling-a");
    expect(siblingA?.dependsOn).toEqual(["fix-primary"]);
    expect(siblingA?.paths).toEqual(["src/sibling-a.ts"]);

    // The discovered units got recruited and completed (the graph grew AND the
    // new nodes did real work).
    expect([...result.completed].sort()).toEqual([
      "fix-primary",
      "fix-primary+sibling-a",
      "fix-primary+sibling-b",
    ]);

    // Every node in the grown graph passes the no-unbacked-node guard.
    const model = buildWorkGraphModel(snapshot);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
    // The discovered units are real agent nodes (they ran, so they have a repo).
    const discoveredNodes = model.nodes.filter((n) => n.id.includes("+"));
    expect(discoveredNodes.length).toBe(2);
    for (const node of discoveredNodes) {
      expect(node.kind).toBe("agent");
    }

    // Mechanical ground truth still integrated every unit, including discovered.
    expect([...result.evidence.integration.integratedUnits].sort()).toEqual([
      "fix-primary",
      "fix-primary+sibling-a",
      "fix-primary+sibling-b",
    ]);
    expect(result.promotion.committed).toBe(true);
  });

  it("discovery is bounded: a discovered unit does not itself discover a third generation", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "a2") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "p2");
    await mkdir(join(projectDir, "src"), { recursive: true });
    // Primary + one sibling, both marked. The sibling is a discovered unit; it
    // must not spawn a third generation off the remaining marked file.
    await writeFile(join(projectDir, "src", "primary.ts"), "export const bug = 1; // FABRIC-FOLLOWUP\n", "utf8");
    await writeFile(join(projectDir, "src", "sibling-a.ts"), "export const a = 1; // FABRIC-FOLLOWUP\n", "utf8");

    const executor = new DiscoveringExecutor(new ScopedNoopExecutor(), { marker: "FABRIC-FOLLOWUP", projectDir });

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 4 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "run2"),
      fetchFn,
      executor,
    });

    const snapshot = control.state("change-branch") as ChangeStateSnapshot;
    const ids = snapshot.work.map((u) => u.id).sort();
    // One primary + one discovered sibling, and the ripple stops there: the
    // discovered unit (id with "+") did not discover primary.ts again.
    expect(ids).toEqual(["fix-primary", "fix-primary+sibling-a"]);
    expect([...result.completed].sort()).toEqual(["fix-primary", "fix-primary+sibling-a"]);
  });
});

/**
 * The offline Worker stand-in (LocalChangeControl) mirrors the Worker's
 * authoritative-verdict routes, so an offline run's graph follows the same
 * rules as a live one:
 *   - POST /changes/:id/integration records the final integration verdict and
 *     the snapshot exposes it (null until then), so the goal follows it;
 *   - POST /changes/:id/planning-failed moves a planning placeholder to
 *     "planning-failed" with the reason, and the goal goes red, backed;
 *   - attachPlan only attaches to a Change that is still planning.
 * No network: the provider is the local-filesystem fallback in a temp dir.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";

import { assertBacked, buildWorkGraphModel } from "../src/graph-model.ts";
import { LocalChangeControl } from "../src/local-control.ts";

const SPEC = [
  "id: change-lc",
  "objective: fix it",
  "baseline: HEAD",
  "budget_usd: 1",
  "assurance: standard",
  "work:",
  "  - id: fix",
  "    objective: fix the bug",
  "    paths: [src/fix.js]",
  "",
].join("\n");

function control(): LocalChangeControl {
  return new LocalChangeControl(
    new LocalFilesystemWorkspaceProvider({ rootDir: join(tmpdir(), "scf-lc-verdict-unused") }),
  );
}

async function post(c: LocalChangeControl, path: string, body: unknown): Promise<Response> {
  return c.fetch(`http://local-control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("LocalChangeControl records the authoritative integration verdict", () => {
  it("exposes integration null until recorded, then the goal follows the verdict over a ladder pass", async () => {
    const c = control();
    c.createChange(SPEC);
    expect(c.state("change-lc").integration).toBeNull();
    // A passing ladder round alone never greens the goal.
    await post(c, "/changes/change-lc/verify-attempt", { round: 1, outcome: "pass", model: "m" });
    expect(buildWorkGraphModel(c.state("change-lc")).nodes.find((n) => n.kind === "goal")?.verified).toBe(false);

    const res = await post(c, "/changes/change-lc/integration", {
      verdict: "failed",
      integratedUnits: [],
      excludedUnits: ["fix"],
    });
    expect(res.status).toBe(201);
    const snapshot = c.state("change-lc");
    expect(snapshot.integration).toMatchObject({ verdict: "failed", excludedUnits: ["fix"] });
    const goal = buildWorkGraphModel(snapshot).nodes.find((n) => n.kind === "goal")!;
    expect(goal.status).toBe("failed");
    expect(() => assertBacked(goal, snapshot)).not.toThrow();
  });

  it("rejects a malformed verdict", async () => {
    const c = control();
    c.createChange(SPEC);
    const res = await post(c, "/changes/change-lc/integration", { verdict: "pass", integratedUnits: [], excludedUnits: [] });
    expect(res.status).toBe(400);
    expect(c.state("change-lc").integration).toBeNull();
  });
});

describe("LocalChangeControl planning-failed and the attach guard", () => {
  const header = { id: "change-lc", objective: "o", baseline: "HEAD", budgetUsd: 0, assurance: "standard" as const };

  it("moves a planning placeholder to planning-failed and reds the goal", async () => {
    const c = control();
    c.createPlanning(header);
    const res = await post(c, "/changes/change-lc/planning-failed", { reason: "planner threw" });
    expect(res.status).toBe(200);
    const snapshot = c.state("change-lc");
    expect(snapshot.status).toBe("planning-failed");
    expect(snapshot.planningFailure?.reason).toBe("planner threw");
    const goal = buildWorkGraphModel(snapshot).nodes.find((n) => n.kind === "goal")!;
    expect(goal.status).toBe("failed");
    expect(() => assertBacked(goal, snapshot)).not.toThrow();
    // A failed placeholder cannot have a plan attached.
    expect(() => c.attachPlan(SPEC)).toThrow(/planning/);
  });

  it("refuses planning-failed on a running Change (409) and an unknown one (404)", async () => {
    const c = control();
    c.createChange(SPEC);
    expect((await post(c, "/changes/change-lc/planning-failed", { reason: "x" })).status).toBe(409);
    expect(c.state("change-lc").status).toBe("running");
    expect((await post(c, "/changes/nope/planning-failed", { reason: "x" })).status).toBe(404);
  });

  it("only attaches a plan while planning", () => {
    const c = control();
    c.createPlanning(header);
    c.attachPlan(SPEC);
    expect(c.state("change-lc").status).toBe("running");
    expect(() => c.attachPlan(SPEC)).toThrow(/planning/);
  });
});

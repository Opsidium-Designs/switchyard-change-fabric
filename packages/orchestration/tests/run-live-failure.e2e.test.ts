/**
 * The failure-tolerance path of the full live run, proven deterministically and
 * offline.
 *
 * A hosted model can return a transient internal error or hang. When an agent's
 * executor ultimately fails (after the bounded retries) or times out, the fabric
 * must NOT freeze: the unit is reported FAILED, the scheduler treats it as
 * terminal-for-that-unit and advances the wave (the other runnable units still
 * get recruited), and the run completes with that unit failed rather than
 * hanging forever. A failed unit becomes a distinct `failed` node in the graph
 * model (not stuck-green, not perpetually-running).
 *
 * These tests drive `runFullLive` against an in-process fake Worker backed by
 * the real `LocalChangeControl` (the same change-core scheduling the Durable
 * Object uses) and a local-filesystem workspace provider, with a deterministic
 * executor that fails for a chosen unit and succeeds for the rest. No network,
 * no Cloudflare account, no real inference, so the whole path runs under `make
 * check`.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";

import { LocalChangeControl } from "../src/local-control.ts";
import { buildWorkGraphModel, type ChangeStateSnapshot } from "../src/graph-model.ts";
import { runFullLive } from "../src/run-live.ts";

/**
 * Three INDEPENDENT units (no dependencies, no shared paths), so all three are
 * runnable at once and the dial is the only bound. One of them (`beta`) will be
 * driven by an always-failing executor; the other two must still complete, which
 * is exactly "the wave advanced despite a failure". No contested path, so the
 * escalation beat does not fire and the failure is the whole story.
 */
const SPEC = `
id: change-fail
objective: Three independent units, one of which fails
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: alpha
    objective: edit alpha
    paths: [src/alpha.ts]
  - id: beta
    objective: edit beta (this agent's executor always errors)
    paths: [src/beta.ts]
  - id: gamma
    objective: edit gamma
    paths: [src/gamma.ts]
`;

/**
 * An executor that writes a trivial edit for every unit EXCEPT the chosen one,
 * for which it always throws (as a flaky hosted model would after exhausting its
 * bounded retries). Deterministic and offline: no network, no inference.
 */
class FailingForUnitExecutor implements ExecutorProvider {
  readonly name = "failing-for-unit";
  constructor(private readonly failUnitId: string) {}
  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    if (context.workUnitId === this.failUnitId) {
      throw new Error("internal error: the model call failed after bounded retries");
    }
    const file = `src/${context.workUnitId}.ts`;
    const { writeFile: wf, mkdir: md } = await import("node:fs/promises");
    const { dirname, join: pjoin } = await import("node:path");
    const abs = pjoin(context.worktreeDir, file);
    await md(dirname(abs), { recursive: true });
    await wf(abs, `export const ${context.workUnitId} = true;\n`, "utf8");
    return {
      status: "changed",
      changedPaths: [file],
      logs: [`wrote ${file}`],
      cost: { usd: 0 },
      commitMessage: `edit ${context.workUnitId}`,
    };
  }
}

/**
 * An in-process fake Worker fetch backed by LocalChangeControl, covering the
 * endpoints runFullLive touches INCLUDING the new fail route. The fail route
 * mirrors the live Worker: it fails the unit (releasing its lease), then
 * recruits the next wave the freed dial slot allows and returns it, so the run
 * advances instead of freezing.
 */
function fakeWorker(control: LocalChangeControl, workspaces: LocalFilesystemWorkspaceProvider) {
  const provisionAndRecord = async (
    changeId: string,
    unitIds: readonly string[],
  ): Promise<unknown[]> => {
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
    // The fail route: fail the unit, then recruit the next wave the freed slot
    // allows (if any) and return it. This is what makes the wave advance past a
    // failed unit instead of freezing.
    const fail = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/fail$/);
    if (method === "POST" && fail) {
      const changeId = dec(fail[1]);
      const unitId = dec(fail[2]);
      const b = body() as { reason?: string };
      control.failUnit(changeId, unitId, b.reason);
      const plan = control.planRecruitment(changeId);
      const recruited = await provisionAndRecord(changeId, plan.recruit);
      control.recordRecruitment(changeId, {
        trigger: "repo-pushed",
        recruited: plan.recruit,
        ceiling: plan.ceiling,
        inFlightAfter: plan.inFlight + recruited.length,
      });
      return json({ recruited });
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
  workRoot = await mkdtemp(join(tmpdir(), "scf-fail-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function seedProject(dir: string): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "index.ts"), "export const seeded = true;\n", "utf8");
}

describe("live run failure tolerance: a failed unit advances the wave, never freezes", () => {
  it("marks the unit failed after the executor errors and still completes the other units", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "project");
    await seedProject(projectDir);

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "run"),
      fetchFn,
      executor: new FailingForUnitExecutor("beta"),
    });

    // The failing unit is reported failed, with a reason, and is NOT completed.
    expect(result.failedUnits.map((f) => f.unitId)).toEqual(["beta"]);
    expect(result.failedUnits[0]?.reason).toMatch(/internal error|failed/i);
    expect(result.completed).not.toContain("beta");

    // The wave ADVANCED: the other two independent units still completed. The
    // run finished with one unit failed rather than hanging on the dead unit.
    expect([...result.completed].sort()).toEqual(["alpha", "gamma"]);

    // The graph model marks the failed node distinctly (not greened, not stuck
    // running), from the real Change state the run left behind.
    const snapshot = control.state("change-fail") as ChangeStateSnapshot;
    const model = buildWorkGraphModel(snapshot);
    const betaNode = model.nodes.find((n) => n.label === "beta");
    expect(betaNode?.status).toBe("failed");
    expect(betaNode?.verified).toBe(false);
    // A surviving unit is integrated/verified in the same projection.
    const alphaNode = model.nodes.find((n) => n.label === "alpha");
    expect(alphaNode?.verified).toBe(true);
    // The goal does not falsely green while a unit is failed.
    const goalNode = model.nodes.find((n) => n.kind === "goal");
    expect(goalNode?.verified).toBe(false);
  });

  it("completes the run even when EVERY unit's agent fails (no freeze, all failed)", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "all") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "all-project");
    await seedProject(projectDir);

    // An executor that always throws for every unit (a totally flaky model).
    const alwaysFail: ExecutorProvider = {
      name: "always-fail",
      execute: async () => {
        throw new Error("internal error");
      },
    };

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "all-run"),
      fetchFn,
      executor: alwaysFail,
    });

    // Every unit failed; none completed; the run still returned (did not hang).
    expect([...result.failedUnits.map((f) => f.unitId)].sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(result.completed).toEqual([]);

    const model = buildWorkGraphModel(control.state("change-fail") as ChangeStateSnapshot);
    expect(model.nodes.filter((n) => n.status === "failed").map((n) => n.label).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("a timeout is treated as a terminal failure for the unit (the wave still advances)", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "to") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "to-project");
    await seedProject(projectDir);

    // An executor that simulates a timed-out model call for `beta` by throwing a
    // timeout-shaped error (the runner's bounded retry would have surfaced this
    // after the call was aborted). The other units succeed.
    const timeoutForBeta: ExecutorProvider = {
      name: "timeout-for-beta",
      execute: async (context: ExecutorContext) => {
        if (context.workUnitId === "beta") {
          throw new Error("Workers AI call for @cf/model timed out after 75000ms");
        }
        const { writeFile: wf, mkdir: md } = await import("node:fs/promises");
        const { dirname, join: pjoin } = await import("node:path");
        const abs = pjoin(context.worktreeDir, `src/${context.workUnitId}.ts`);
        await md(dirname(abs), { recursive: true });
        await wf(abs, `export const ${context.workUnitId} = true;\n`, "utf8");
        return {
          status: "changed",
          changedPaths: [`src/${context.workUnitId}.ts`],
          logs: [],
          cost: { usd: 0 },
          commitMessage: `edit ${context.workUnitId}`,
        };
      },
    };

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, "to-run"),
      fetchFn,
      executor: timeoutForBeta,
    });

    expect(result.failedUnits.map((f) => f.unitId)).toEqual(["beta"]);
    expect(result.failedUnits[0]?.reason).toMatch(/timed out/i);
    expect([...result.completed].sort()).toEqual(["alpha", "gamma"]);
  });
});

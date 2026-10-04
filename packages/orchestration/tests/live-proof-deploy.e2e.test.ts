/**
 * Redeploy-in-place proof (M8.4): deploy is a MANUAL human step taken BEFORE a
 * fix, and the run NEVER deploys fresh. On a verified fix, when a prior manual
 * deployment already exists for the app, the run REDEPLOYS the fixed code to the
 * app's STABLE worker name, updating that existing deployment in place at the
 * same URL. When no manual deploy happened, the run deploys NOTHING, yet it still
 * promotes to Git and completes normally (the console simply shows no live URL).
 * A run whose fix FAILS verification does NOT redeploy either.
 *
 * The redeployer and the already-deployed lookup are injected (deterministic
 * fakes here), and the Worker is the in-process LocalChangeControl, so this runs
 * under `make check` with no Cloudflare account and no network.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";

import { LocalChangeControl } from "../src/local-control.ts";
import { runFullLive, type DeployApp } from "../src/run-live.ts";

const SPEC = `
id: change-deploy
objective: Fix the app and deploy it
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: fix
    objective: fix the app
    paths: [src/index.js]
`;

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
      control.configureDial(dec(dial[1]), { minConcurrency: 1, maxConcurrency: 3 });
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
    if (method === "POST" && url.pathname === "/events/repo-pushed") {
      const b = body() as { changeId?: string; workspace?: string };
      const outcome = control.recordRepoPushed(b.changeId ?? "", b.workspace ?? "");
      const recruited = await provisionAndRecord(b.changeId ?? "", outcome.recruited);
      control.recordRecruitment(b.changeId ?? "", {
        trigger: "repo-pushed",
        pushedWorkspace: b.workspace,
        completedUnit: outcome.completedUnit ?? undefined,
        recruited: outcome.recruited,
        ceiling: outcome.event.ceiling,
        inFlightAfter: outcome.event.inFlightAfter,
      });
      return json({ recruited });
    }
    const deployment = url.pathname.match(/^\/changes\/([^/]+)\/deployment$/);
    if (method === "POST" && deployment) {
      const b = body() as { url?: string; app?: string };
      const recorded = control.recordDeployment(dec(deployment[1]), {
        url: String(b.url ?? ""),
        app: String(b.app ?? ""),
      });
      return json({ deployment: recorded }, 201);
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
  workRoot = await mkdtemp(join(tmpdir(), "scf-deploy-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("M8.4 redeploy-in-place proof: the run only refreshes an existing manual deployment", () => {
  it("REDEPLOYS to the stable name when the app was already deployed, and records the URL", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "project", "src");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "index.js"), "export default {};\n", "utf8");

    const redeployed: string[] = [];
    const deployApp: DeployApp = async ({ appName }) => {
      redeployed.push(appName);
      // The redeploy returns the SAME stable URL the manual deploy used.
      return { url: `https://${appName}.example.workers.dev` };
    };
    // The app WAS manually deployed before the run: the lookup resolves its URL.
    const appAlreadyDeployed = async ({ appName }: { appName: string }) =>
      `https://${appName}.example.workers.dev`;

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir: join(workRoot, "project"),
      workRoot: join(workRoot, "run"),
      fetchFn,
      executor: new ScopedNoopExecutor(),
      deployAppDir: join(workRoot, "project"),
      deployAppName: "switchyard-change-fabric-demo-app",
      deployApp,
      appAlreadyDeployed,
    });

    // The verified run redeployed the fixed code to the SAME stable name and
    // recorded the URL on state (so the console surfaces the clickable link).
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(redeployed).toEqual(["switchyard-change-fabric-demo-app"]);
    expect(result.deployment?.url).toBe(
      "https://switchyard-change-fabric-demo-app.example.workers.dev",
    );
    expect(result.deployment?.app).toBe("switchyard-change-fabric-demo-app");
    const snapshot = control.state("change-deploy") as { deployment?: { url: string } };
    expect(snapshot.deployment?.url).toBe(
      "https://switchyard-change-fabric-demo-app.example.workers.dev",
    );
    // The run still promoted the fix to Git.
    expect(result.promotion.committed).toBe(true);
  });

  it("does NOT deploy when nothing was pre-deployed, but still promotes to Git", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "a3") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "p3", "src");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "index.js"), "export default {};\n", "utf8");

    const redeployed: string[] = [];
    const deployApp: DeployApp = async ({ appName }) => {
      redeployed.push(appName);
      return { url: `https://${appName}.example.workers.dev` };
    };
    // No manual deploy happened: the lookup resolves undefined, so the run must
    // NOT deploy at all.
    const appAlreadyDeployed = async () => undefined;

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir: join(workRoot, "p3"),
      workRoot: join(workRoot, "run3"),
      fetchFn,
      executor: new ScopedNoopExecutor(),
      deployAppDir: join(workRoot, "p3"),
      deployAppName: "switchyard-change-fabric-demo-app",
      deployApp,
      appAlreadyDeployed,
    });

    // The run verified and promoted, but deployed nothing because no manual
    // deploy preceded it. The console simply shows no live URL.
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(result.promotion.committed).toBe(true);
    expect(redeployed).toEqual([]);
    expect(result.deployment).toBeUndefined();
    const snapshot = control.state("change-deploy") as { deployment?: unknown };
    expect(snapshot.deployment).toBeUndefined();
  });

  it("does NOT redeploy when the fix fails verification (even if pre-deployed)", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "a2") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "p2", "src");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "index.js"), "export default {};\n", "utf8");

    const redeployed: string[] = [];
    const deployApp: DeployApp = async ({ appName }) => {
      redeployed.push(appName);
      return { url: `https://${appName}.example.workers.dev` };
    };
    // The app WAS pre-deployed, but the fix fails, so the run must NOT redeploy a
    // broken app over the working one.
    const appAlreadyDeployed = async ({ appName }: { appName: string }) =>
      `https://${appName}.example.workers.dev`;

    // Force an unverified run: an executor that always FAILS, so nothing is
    // integrated and the integration verdict is not "verified".
    const failing = {
      name: "always-fails",
      async execute() {
        throw new Error("the model could not produce a usable fix");
      },
    };

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir: join(workRoot, "p2"),
      workRoot: join(workRoot, "run2"),
      fetchFn,
      executor: failing,
      deployAppDir: join(workRoot, "p2"),
      deployAppName: "switchyard-change-fabric-demo-app",
      deployApp,
      appAlreadyDeployed,
    });

    // The fix did not land, so nothing was redeployed and no URL was recorded,
    // even though the app was pre-deployed.
    expect(result.evidence.integration.integratedUnits.length).toBe(0);
    expect(redeployed).toEqual([]);
    expect(result.deployment).toBeUndefined();
    const snapshot = control.state("change-deploy") as { deployment?: unknown };
    expect(snapshot.deployment).toBeUndefined();
  });
});

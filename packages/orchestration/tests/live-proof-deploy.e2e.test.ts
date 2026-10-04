/**
 * Live-URL proof: at the end of a VERIFIED real-app run, the fabric deploys the
 * fixed app to a live workers.dev URL as end-of-run proof and records that URL
 * on the Change state so the console surfaces a clickable link, then tears the
 * app down on cleanup. A run whose fix FAILS verification does NOT deploy; it
 * shows the failure honestly instead of a fake-green URL.
 *
 * The deployer and teardown are injected (a deterministic fake here), and the
 * Worker is the in-process LocalChangeControl, so this runs under `make check`
 * with no Cloudflare account and no network: the deploy step is faked exactly as
 * the Workers AI executor is faked elsewhere.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";

import { LocalChangeControl } from "../src/local-control.ts";
import { runFullLive, type DeployApp, type TeardownApp } from "../src/run-live.ts";

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

describe("M8.3 live-URL proof: deploy the fixed app and surface a clickable URL", () => {
  it("deploys after a verified run, records the URL on state, and tears it down", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "project", "src");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "index.js"), "export default {};\n", "utf8");

    const deployed: string[] = [];
    const tornDown: string[] = [];
    const deployApp: DeployApp = async ({ appName }) => {
      deployed.push(appName);
      return { url: `https://${appName}.example.workers.dev` };
    };
    const teardownApp: TeardownApp = async ({ appName }) => {
      tornDown.push(appName);
    };

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
      deployAppName: "demo-app",
      deployApp,
      teardownApp,
    });

    // The verified run deployed the app and recorded the URL in the result and
    // on the Change state (so the console surfaces a clickable link).
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(deployed).toEqual(["demo-app"]);
    expect(result.deployment?.url).toBe("https://demo-app.example.workers.dev");
    expect(result.deployment?.app).toBe("demo-app");
    const snapshot = control.state("change-deploy") as { deployment?: { url: string } };
    expect(snapshot.deployment?.url).toBe("https://demo-app.example.workers.dev");

    // Cleanup (non-watch) tore the deployed app down so nothing leaks.
    expect(tornDown).toEqual(["demo-app"]);
  });

  it("does NOT deploy when the fix fails verification (no fake-green URL)", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "a2") });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control);
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, "p2", "src");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "index.js"), "export default {};\n", "utf8");

    const deployed: string[] = [];
    // A deployer that would record a URL if ever called; it must NOT be called
    // because the fix fails verification (the executor writes out of scope).
    const deployApp: DeployApp = async ({ appName }) => {
      deployed.push(appName);
      return { url: `https://${appName}.example.workers.dev` };
    };

    // Force an unverified run: an executor that always FAILS (throws past its
    // bounded retries), so the only unit fails, nothing is integrated, and the
    // integration verdict is not "verified". A failed fix must NOT deploy.
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
      deployAppName: "demo-app",
      deployApp,
    });

    // The fix did not land (no unit integrated), so the app was NOT deployed and
    // no URL is recorded, even though an empty integration verifies vacuously.
    expect(result.evidence.integration.integratedUnits.length).toBe(0);
    expect(deployed).toEqual([]);
    expect(result.deployment).toBeUndefined();
    const snapshot = control.state("change-deploy") as { deployment?: unknown };
    expect(snapshot.deployment).toBeUndefined();
  });
});

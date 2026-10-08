/**
 * Regression tests for the run-live honesty fixes, offline over the in-process
 * LocalChangeControl and local Git (no network, no inference):
 *
 *   - gate-equals-deploy: a redeploy ships a checkout of the PROMOTED commit (the
 *     fix), never the original app directory (the unfixed baseline), with the
 *     app directory mapped by its position inside the promoted project;
 *   - the authoritative integration verdict is POSTed to the Worker before any
 *     promotion or deployment;
 *   - a project that declares a gate but runs without one (--no-gate) is
 *     cannot-pass: verdict "failed", no promotion branch, no redeploy;
 *   - every Worker call carries the bearer token when SWITCHYARD_API_TOKEN is set;
 *   - a planning placeholder can be marked failed (best-effort).
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { ScopedNoopExecutor } from "@switchyard-change/model-adapters";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";

import { LocalChangeControl } from "../src/local-control.ts";
import {
  failPlanningChange,
  runFullLive,
  type DeployApp,
  type FullLiveEvent,
} from "../src/run-live.ts";
import { withWorkerAuth } from "../src/worker-auth.ts";

const run = promisify(execFile);
const BASELINE = "export default {};\n";

function specFor(path: string): string {
  return `
id: change-honesty
objective: Fix the app
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: fix
    objective: fix the app
    paths: [${path}]
`;
}

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

/** A fake Worker over LocalChangeControl that records every request it gets. */
function fakeWorker(control: LocalChangeControl) {
  const calls: Recorded[] = [];
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
      recruited.push({ ...lease });
    }
    return recruited;
  };

  const fetchFn = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "http://w");
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : "";
    const parsed = (() => {
      try {
        return raw === "" ? {} : JSON.parse(raw);
      } catch {
        return raw;
      }
    })();
    calls.push({
      method,
      path: url.pathname,
      body: parsed,
      authorization: new Headers(init?.headers).get("authorization"),
    });

    if (method === "POST" && url.pathname === "/changes") {
      control.createChange(raw);
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
      const b = parsed as { changeId?: string; workspace?: string };
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
    if (method === "POST" && /^\/changes\/[^/]+\/(integration|deployment)$/.test(url.pathname)) {
      return json({ ok: true }, 201);
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

  return { fetchFn, calls };
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

async function seedFile(dir: string, rel: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(abs, BASELINE, "utf8");
}

let workRoot: string;
let savedToken: string | undefined;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scf-honesty-"));
  savedToken = process.env.SWITCHYARD_API_TOKEN;
  delete process.env.SWITCHYARD_API_TOKEN;
});

afterEach(async () => {
  if (savedToken === undefined) {
    delete process.env.SWITCHYARD_API_TOKEN;
  } else {
    process.env.SWITCHYARD_API_TOKEN = savedToken;
  }
  await rm(workRoot, { recursive: true, force: true });
});

describe("run-live honesty regressions", () => {
  it("redeploys the PROMOTED tree (the fix), posts the verdict first, and sends the bearer token", async () => {
    process.env.SWITCHYARD_API_TOKEN = "test-api-token";
    const control = new LocalChangeControl(
      new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") }),
    );
    const { fetchFn, calls } = fakeWorker(control);
    // The app lives in a SUBDIRECTORY of the project, so the deploy dir must be
    // mapped into the promoted tree by its relative position.
    const spec = specFor("apps/web/src/index.js");
    const projectDir = join(workRoot, "project");
    await seedFile(projectDir, "apps/web/src/index.js");
    const appDir = join(projectDir, "apps", "web");

    const deployed: { appDir: string; content: string }[] = [];
    const deployApp: DeployApp = async ({ appDir: dir, appName }) => {
      deployed.push({ appDir: dir, content: await readFile(join(dir, "src", "index.js"), "utf8") });
      return { url: `https://${appName}.example.workers.dev` };
    };

    const result = await runFullLive({
      change: parseChangeSpec(spec),
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: spec,
      projectDir,
      workRoot: join(workRoot, "run"),
      fetchFn,
      executor: new ScopedNoopExecutor(),
      deployAppDir: appDir,
      deployAppName: "switchyard-change-fabric-web",
      deployApp,
      appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
    });

    expect(result.evidence.integration.verdict).toBe("verified");
    expect(result.promotion.committed).toBe(true);
    expect(deployed).toHaveLength(1);
    const [deploy] = deployed;
    // Deployed from a checkout of the promoted commit, never the source app dir.
    expect(resolve(deploy!.appDir)).not.toBe(resolve(appDir));
    expect(deploy!.appDir.endsWith(join("apps", "web"))).toBe(true);
    expect(deploy!.content).not.toBe(BASELINE);
    const { stdout: promoted } = await run("git", [
      "-C",
      result.sourceRepoDir,
      "show",
      `${result.promotion.commit}:apps/web/src/index.js`,
    ]);
    expect(deploy!.content).toBe(promoted);
    // The original app directory still holds the unfixed baseline (untouched).
    expect(await readFile(join(appDir, "src", "index.js"), "utf8")).toBe(BASELINE);

    // The authoritative verdict was POSTed, before the deployment record.
    const integrationIdx = calls.findIndex((c) => c.path.endsWith("/integration"));
    const deploymentIdx = calls.findIndex((c) => c.path.endsWith("/deployment"));
    expect(integrationIdx).toBeGreaterThan(-1);
    expect(deploymentIdx).toBeGreaterThan(integrationIdx);
    expect(calls[integrationIdx]!.body).toEqual({
      verdict: "verified",
      integratedUnits: ["fix"],
      excludedUnits: [],
    });

    // Every Worker call carried the bearer token.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.authorization === "Bearer test-api-token")).toBe(true);
  });

  it("a declared gate disabled by --no-gate is cannot-pass: failed verdict, no branch, no redeploy", async () => {
    const control = new LocalChangeControl(
      new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") }),
    );
    const { fetchFn, calls } = fakeWorker(control);
    const spec = specFor("src/index.js");
    const projectDir = join(workRoot, "project");
    await seedFile(projectDir, "src/index.js");

    const deployed: string[] = [];
    const events: FullLiveEvent[] = [];
    const result = await runFullLive({
      change: parseChangeSpec(spec),
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: spec,
      projectDir,
      workRoot: join(workRoot, "run"),
      fetchFn,
      executor: new ScopedNoopExecutor(),
      // The project declares a gate, but no gate command is wired (--no-gate).
      requireAppGate: true,
      deployAppDir: projectDir,
      deployAppName: "switchyard-change-fabric-app",
      deployApp: async ({ appName }) => {
        deployed.push(appName);
        return { url: `https://${appName}.example.workers.dev` };
      },
      appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
      onEvent: (e) => events.push(e),
    });

    expect(result.evidence.integration.verdict).toBe("failed");
    expect(result.evidence.integration.finalCheck.summary).toMatch(/cannot-pass/);
    // Promotion refused: no commit, an honest reason, and no delivery branch.
    expect(result.promotion.committed).toBe(false);
    expect(result.promotion.refusedReason).toMatch(/not "verified"/);
    const { stdout: branches } = await run("git", [
      "-C",
      result.sourceRepoDir,
      "branch",
      "--list",
      "switchyard/*",
    ]);
    expect(branches.trim()).toBe("");
    expect(events.some((e) => e.kind === "promoting")).toBe(false);
    expect(events.some((e) => e.kind === "promotion-skipped")).toBe(true);
    // Nothing redeployed, and the Worker was told the verdict was failed.
    expect(deployed).toEqual([]);
    expect(result.deployment).toBeUndefined();
    const integration = calls.find((c) => c.path.endsWith("/integration"));
    expect(integration?.body).toMatchObject({ verdict: "failed", integratedUnits: [] });
    // No token configured: no authorization header is sent.
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });

  it("does not deploy when the app directory lies outside the promoted project", async () => {
    const control = new LocalChangeControl(
      new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") }),
    );
    const { fetchFn } = fakeWorker(control);
    const spec = specFor("src/index.js");
    const projectDir = join(workRoot, "project");
    await seedFile(projectDir, "src/index.js");
    const outside = join(workRoot, "elsewhere");
    await seedFile(outside, "src/index.js");

    const deployed: string[] = [];
    const events: FullLiveEvent[] = [];
    const result = await runFullLive({
      change: parseChangeSpec(spec),
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: spec,
      projectDir,
      workRoot: join(workRoot, "run"),
      fetchFn,
      executor: new ScopedNoopExecutor(),
      deployAppDir: outside,
      deployAppName: "switchyard-change-fabric-app",
      deployApp: async ({ appName }) => {
        deployed.push(appName);
        return { url: `https://${appName}.example.workers.dev` };
      },
      appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
      onEvent: (e) => events.push(e),
    });

    expect(result.promotion.committed).toBe(true);
    expect(deployed).toEqual([]);
    const skipped = events.find((e) => e.kind === "deploy-skipped");
    expect(skipped && skipped.kind === "deploy-skipped" ? skipped.reason : "").toMatch(
      /outside the promoted project/,
    );
  });
});

describe("failPlanningChange", () => {
  it("posts the failure reason to the planning-failed route and tolerates a missing route", async () => {
    const seen: { path: string; body: unknown }[] = [];
    const ok = (async (input: string, init?: RequestInit) => {
      seen.push({ path: new URL(input).pathname, body: JSON.parse(String(init?.body)) });
      return json({ ok: true }, 200);
    }) as unknown as typeof fetch;
    expect(
      await failPlanningChange({ workerUrl: "http://w/", changeId: "c 1", reason: "planner threw", fetchFn: ok }),
    ).toBe(true);
    expect(seen).toEqual([{ path: "/changes/c%201/planning-failed", body: { reason: "planner threw" } }]);

    const missing = (async () => json({ error: "not found" }, 404)) as unknown as typeof fetch;
    expect(
      await failPlanningChange({ workerUrl: "http://w", changeId: "c", reason: "x", fetchFn: missing }),
    ).toBe(false);
  });
});

describe("withWorkerAuth", () => {
  it("returns the fetch unchanged when no token is set, and adds the bearer header when it is", async () => {
    const base = (async () => json({})) as unknown as typeof fetch;
    expect(withWorkerAuth(base, {})).toBe(base);
    expect(withWorkerAuth(base, { SWITCHYARD_API_TOKEN: "   " })).toBe(base);

    let seen: Headers | undefined;
    const capture = (async (_input: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return json({});
    }) as unknown as typeof fetch;
    const authed = withWorkerAuth(capture, { SWITCHYARD_API_TOKEN: "tok" });
    await authed("http://w/x", { method: "POST", headers: { "content-type": "text/plain" } });
    expect(seen?.get("authorization")).toBe("Bearer tok");
    expect(seen?.get("content-type")).toBe("text/plain");
  });
});

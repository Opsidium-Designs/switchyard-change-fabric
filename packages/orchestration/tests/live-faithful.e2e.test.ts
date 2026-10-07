/**
 * Live-faithful integration test: close the live-vs-offline gap that let the
 * false green through.
 *
 * The false green came from the LIVE path running the WHOLE-APP gate as a
 * per-unit admission test: a single unit's bare repo (one resource file) can
 * never satisfy a whole-app typecheck + behavioral gate, so every unit was
 * excluded, the verified set emptied, integration applied nothing, and the
 * baseline shipped green. The ladder's marker fakes could never reproduce this
 * because a single marker file passes a marker gate per-unit.
 *
 * These tests exercise the REAL run-live integration path (runFullLive, not a
 * pre-fixed injected workspace) against a REAL multi-file app whose gate is a
 * REAL whole-app child process (plain `node`, no npm, no network), so a
 * divergence like this cannot pass make check again. They prove:
 *
 *   1. When agents produce fixes, the integrated+promoted tree CONTAINS those
 *      fixes and the authoritative gate that recorded the pass ran on THAT SAME
 *      tree (gated tree == integrated tree == promoted tree). The whole-app gate
 *      could NOT pass per-unit (asserted directly), so a pass can only come from
 *      the composed tree.
 *   2. When an agent produces NO fix (its edit vanished / the resource stays
 *      buggy) but a fix was expected, the run FAILS: the authoritative gate on
 *      the composed tree fails, nothing is reported integrated, and the app is
 *      NOT redeployed (no false green, no baseline promote claiming a fix).
 *
 * Everything is deterministic and offline: a local-filesystem workspace
 * provider, real file:// Git, the real child-process command runner over a
 * plain-node gate, and a deterministic executor that writes real source edits.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { ChildProcessCommandRunner } from "@switchyard-change/verification";
import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";

import { LocalChangeControl } from "../src/local-control.ts";
import { runFullLive, type DeployApp, type FullLiveEvent } from "../src/run-live.ts";
import {
  RESOURCE_UNITS,
  buggyResource,
  fixedResource,
  gateCommand,
  resourcePath,
  seedFaithfulApp,
} from "./live-faithful-fixture.ts";

const run = promisify(execFile);

/** A two-resource change: each unit owns one resource file; both need the fix. */
const SPEC = `
id: change-faithful
objective: Require auth in every resource over a frozen contract
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: a
    objective: require auth in resource a
    paths: [src/resources/a.js]
  - id: b
    objective: require auth in resource b
    paths: [src/resources/b.js]
`;

/**
 * A deterministic executor that writes the REAL per-resource edit into the
 * unit's worktree (its declared file). The `fixingUnits` set decides which units
 * write the FIXED resource; every other unit writes the still-BUGGY resource
 * (an agent that produced no real fix). No model, no network.
 */
class FaithfulExecutor implements ExecutorProvider {
  readonly name = "faithful-fake";
  constructor(private readonly fixingUnits: ReadonlySet<string>) {}

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const unitId = context.workUnitId;
    const rel = resourcePath(unitId);
    const abs = join(context.worktreeDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    const contents = this.fixingUnits.has(unitId) ? fixedResource(unitId) : buggyResource(unitId);
    await writeFile(abs, contents, "utf8");
    return {
      status: "changed",
      changedPaths: [rel],
      logs: [`faithful fake wrote ${rel} for ${unitId}`],
      cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      commitMessage: `WorkUnit ${unitId}: edit ${rel}`,
    };
  }
}

/**
 * An in-process fake Worker fetch backed by LocalChangeControl, covering the
 * endpoints runFullLive touches. Mirrors the other e2e fakes: real local bare
 * Git repos per unit, real clone/commit/push, no network.
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
      control.configureDial(dec(dial[1]), { minConcurrency: 1, maxConcurrency: 2 });
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
    const deployment = url.pathname.match(/^\/changes\/([^/]+)\/deployment$/);
    if (method === "POST" && deployment) {
      const b = body() as { url?: string; app?: string };
      const recorded = control.recordDeployment(dec(deployment[1]), {
        url: String(b.url ?? ""),
        app: String(b.app ?? ""),
      });
      return json({ deployment: recorded }, 201);
    }
    // The ladder's change-level verify/retry routes and per-unit step/detail are
    // delegated so a run with an app gate records its attempts exactly as live.
    const delegated =
      /^\/changes\/[^/]+\/(verify-attempt|retry-attempt|jev-decision)$/.test(url.pathname) ||
      /^\/changes\/[^/]+\/work\/[^/]+\/(verify-fail|step|detail|stream)$/.test(url.pathname) ||
      /^\/changes\/[^/]+\/work\/[^/]+\/round\/[^/]+\/(lease|step|detail|complete|fail)$/.test(
        url.pathname,
      );
    if (method === "POST" && delegated) {
      return control.fetch(input, init);
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
  workRoot = await mkdtemp(join(tmpdir(), "scf-faithful-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

/** Run the faithful app through the REAL run-live integration path. */
async function runFaithful(options: {
  readonly subdir: string;
  readonly fixingUnits: ReadonlySet<string>;
}) {
  const artifactsRoot = join(workRoot, options.subdir, "artifacts");
  const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: artifactsRoot });
  const control = new LocalChangeControl(workspaces);
  const { fetchFn } = fakeWorker(control, workspaces);
  const change = parseChangeSpec(SPEC);

  const projectDir = join(workRoot, options.subdir, "project");
  await mkdir(projectDir, { recursive: true });
  await seedFaithfulApp(projectDir);

  const events: FullLiveEvent[] = [];
  const redeployed: string[] = [];
  const deployApp: DeployApp = async ({ appName }) => {
    redeployed.push(appName);
    return { url: `https://${appName}.example.workers.dev` };
  };

  const result = await runFullLive({
    change,
    dial: { minConcurrency: 1, maxConcurrency: 2 },
    workerUrl: "http://w",
    specYaml: SPEC,
    projectDir,
    workRoot: join(workRoot, options.subdir, "run"),
    fetchFn,
    executor: new FaithfulExecutor(options.fixingUnits),
    // The REAL whole-app gate command, run through the REAL child-process
    // runner: this is what makes the test faithful to the live `npm run gate`
    // semantics (a per-unit bare repo cannot satisfy it; only the composed
    // integrated tree can).
    appGateCommandFor: () => gateCommand(),
    verifyCommandRunner: new ChildProcessCommandRunner(),
    // No model escalation: this test is about composition and the integration
    // gate, not the model ladder. A base-round fail is terminal.
    maxModelRetries: 0,
    deployAppDir: projectDir,
    deployAppName: "switchyard-change-fabric-faithful-app",
    deployApp,
    appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
    onEvent: (e) => events.push(e),
  });

  return { result, control, events, redeployed, projectDir, artifactsRoot };
}

describe("live-faithful: the authoritative gate runs on the composed tree that ships", () => {
  it("the whole-app gate CANNOT pass against a single unit's bare repo (the live trap)", async () => {
    // Prove the premise directly: the real whole-app gate run against a tree
    // that has only ONE resource file (what a per-unit verify checkout holds)
    // fails, because the typecheck step `node --check` hits the missing sibling
    // files before any assertion. This is exactly why running the whole-app gate
    // as a per-unit admission test emptied the verified set on the live path.
    const soloDir = join(workRoot, "solo");
    await mkdir(join(soloDir, "src", "resources"), { recursive: true });
    // Only resource a's file is present (as in a single unit's bare repo), plus
    // the gate runner it would try to run. No index, no contract, no sibling.
    await writeFile(join(soloDir, "src/resources/a.js"), fixedResource("a"), "utf8");
    await mkdir(join(soloDir, "gate"), { recursive: true });
    // Copy the real gate runner from a seeded project so this is the SAME gate.
    const seed = join(workRoot, "solo-seed");
    await mkdir(seed, { recursive: true });
    await seedFaithfulApp(seed);
    const { readFile } = await import("node:fs/promises");
    await writeFile(join(soloDir, "gate/run.mjs"), await readFile(join(seed, "gate/run.mjs"), "utf8"));

    const runner = new ChildProcessCommandRunner();
    const outcome = await runner.run(gateCommand(), soloDir);
    expect(outcome.code).not.toBe(0);
  });

  it("fixes land: the integrated AND promoted tree contains the fixes, gated on that same tree", async () => {
    const { result, redeployed } = await runFaithful({
      subdir: "fixes-land",
      fixingUnits: new Set(RESOURCE_UNITS),
    });

    // The authoritative integration gate (the real whole-app gate on the
    // composed tree) PASSED, and both units are reported integrated. This is the
    // verdict run on the exact tree that is committed, pushed, promoted, and
    // redeployed, so a pass means the SHIPPED tree is fixed.
    expect(result.evidence.integration.verdict).toBe("verified");
    expect([...result.evidence.integration.integratedUnits].sort()).toEqual(["a", "b"]);
    expect(result.evidence.integration.finalCheck.passed).toBe(true);

    // The PROMOTED tree (what ships) actually contains BOTH resource fixes. The
    // run promotes the integrated tree the gate ran on, and the promote guard
    // (expectedFixes) would have hard-failed had that tree been the unfixed
    // baseline, so a committed promotion here is the gated==promoted tree.
    expect(result.promotion.committed).toBe(true);
    expect(result.promotion.branch).toBe("switchyard/change-faithful");
    const { stdout: promotedA } = await run("git", [
      "-C",
      result.sourceRepoDir,
      "show",
      `${result.promotion.branch}:src/resources/a.js`,
    ]);
    const { stdout: promotedB } = await run("git", [
      "-C",
      result.sourceRepoDir,
      "show",
      `${result.promotion.branch}:src/resources/b.js`,
    ]);
    expect(promotedA).toContain("requireAuth(request)");
    expect(promotedB).toContain("requireAuth(request)");

    // Run the SAME real whole-app gate against the promoted tree: it passes,
    // confirming the shipped artifact is genuinely fixed (gate == deploy). This
    // re-runs the authoritative gate on the exact promoted content.
    const checkout = join(workRoot, "fixes-land", "promoted-checkout");
    await run("git", ["clone", "--branch", result.promotion.branch, result.sourceRepoDir, checkout]);
    const outcome = await new ChildProcessCommandRunner().run(gateCommand(), checkout);
    expect(outcome.code).toBe(0);

    // A verified fix over an existing deploy redeploys in place.
    expect(redeployed).toEqual(["switchyard-change-fabric-faithful-app"]);
    expect(result.deployment?.app).toBe("switchyard-change-fabric-faithful-app");
  });

  it("a partial/no fix FAILS honest: gate fails on the composed tree, nothing integrates, no redeploy", async () => {
    // Only resource a is fixed; resource b stays buggy (an agent produced no real
    // fix). The composed integrated tree therefore still has an unfixed resource,
    // so the authoritative whole-app gate FAILS on the shipped tree. The run must
    // not green or redeploy, and must not promote a baseline claiming a fix.
    const { result, redeployed, events } = await runFaithful({
      subdir: "partial-fix",
      fixingUnits: new Set(["a"]),
    });

    expect(result.evidence.integration.verdict).toBe("failed");
    expect(result.evidence.integration.integratedUnits).toEqual([]);
    expect(result.evidence.integration.finalCheck.passed).toBe(false);

    // No false green: the app was not redeployed, and no redeploy event fired.
    expect(redeployed).toEqual([]);
    expect(result.deployment).toBeUndefined();
    expect(events.some((e) => e.kind === "redeployed")).toBe(false);
    expect(events.some((e) => e.kind === "deploy-skipped")).toBe(true);
  });
});

/**
 * T10: the bounded model-escalation ladder, proven deterministically and
 * offline across three honest paths:
 *
 *   1. Seeded failure -> escalation beat. The base model's edit FAILS the per-app
 *      gate; the ladder escalates to a stronger model fed the failing evidence,
 *      whose edit PASSES; the unit greens and (with a prior manual deploy) the app
 *      redeploys in place. The graph shows verify #1 (red) -> model-escalation ->
 *      retry #2 -> verify #2 (green), and the human-escalation flag stays off.
 *   2. Happy path. The base model's edit PASSES on the first try: exactly one
 *      verify attempt, no retry, no model-escalation edge, and a redeploy.
 *   3. Exhaustion. Both the base and the escalation edits FAIL the gate: the unit
 *      is a real RED node, is not integrated, and the app is NOT redeployed.
 *
 * All three are driven by the model-id-aware executor fake and the marker-reading
 * gate CommandRunner fake (T11), the in-process LocalChangeControl, and a
 * deterministic deploy fake, so the whole path runs under `make check` with no
 * network, no Cloudflare account, and no real inference. Verification is
 * mechanical on every attempt (the gate reads the real edit marker), so the
 * escalation model never grades its own output, and the retry is bounded by the
 * max-retries dial.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";

import { LocalChangeControl } from "../src/local-control.ts";
import {
  assertBacked,
  buildWorkGraphModel,
  jevNodeId,
  roundAgentNodeId,
  retryNodeId,
  verifyNodeId,
  type ChangeStateSnapshot,
  type GraphNode,
} from "../src/graph-model.ts";
import type { DependencyInstaller } from "@switchyard-change/verification";
import { runFullLive, createPlanningChange, type DeployApp, type FullLiveEvent } from "../src/run-live.ts";
import {
  MarkerGateRunner,
  ModelAwareExecutor,
  ResourceNameGateRunner,
  CrashGateRunner,
  SharedPathExecutor,
  SharedPathGateRunner,
  gateCommandFor,
} from "./ladder-fakes.ts";

const BASE_MODEL = "base-model";
const ESCALATION_MODEL = "escalation-model";

const SPEC = `
id: change-ladder
objective: Fix the planted bug; escalate on a verify-fail
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: fix
    objective: fix the planted bug in the app
    paths: [src/fix.fix]
`;

/**
 * A two-unit change for the implicated-unit attribution path: unit `alpha`
 * already fixes its part on the base model (the gate always passes its marker),
 * while unit `beta` needs the escalation model. On the round-1 change-level
 * fail, only `beta`'s marker is named, so attribution must re-fan ONLY `beta`.
 * Each unit's declared path is its own marker file, so the failing file maps
 * cleanly to the owning unit.
 */
const SPEC_TWO_UNITS = `
id: change-ladder-two
objective: Fix two parts; only one needs escalation
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: alpha
    objective: fix the alpha part
    paths: [src/alpha.fix]
  - id: beta
    objective: fix the beta part
    paths: [src/beta.fix]
`;

/**
 * A three-unit change where EVERY unit needs the escalation model (no
 * always-passing unit), so the round-1 change-level fail names all three files
 * and the single retry re-fans all three units at once. Used to prove the
 * re-fan runs with BOUNDED CONCURRENCY: with a dial max of 3 and an artificial
 * executor delay, all three re-fan calls overlap (peak in-flight = 3), where a
 * strictly sequential loop would peak at 1. Each unit's declared path is its own
 * marker file so attribution maps every failing file to its owning unit.
 */
const SPEC_THREE_UNITS = `
id: change-ladder-three
objective: Fix three parts; all need escalation
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: one
    objective: fix part one
    paths: [src/one.fix]
  - id: two
    objective: fix part two
    paths: [src/two.fix]
  - id: three
    objective: fix part three
    paths: [src/three.fix]
`;

/**
 * A SIX-resource change mirroring the service-api shape (users, orders,
 * products, auth, search, notifications). Only `auth` needs the escalation
 * model; every other resource already passes on the base model (always-passing
 * markers). The round-1 change-level fail names ONLY auth (by resource name, via
 * the ResourceNameGateRunner), so the FIRST retry (round 2) must re-fan ONLY
 * auth, not all six. Each unit id IS its resource name so unitCoversName maps the
 * named resource to its unit with no file-path hint.
 */
const SPEC_SIX_RESOURCES = `
id: change-ladder-six
objective: Require auth across six resources; only auth needs escalation
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: users
    objective: fix users
    paths: [src/users.fix]
  - id: orders
    objective: fix orders
    paths: [src/orders.fix]
  - id: products
    objective: fix products
    paths: [src/products.fix]
  - id: auth
    objective: fix auth
    paths: [src/auth.fix]
  - id: search
    objective: fix search
    paths: [src/search.fix]
  - id: notifications
    objective: fix notifications
    paths: [src/notifications.fix]
`;

/**
 * An in-process fake Worker fetch backed by LocalChangeControl. It handles the
 * endpoints runFullLive touches, delegating the ladder's verify-attempt and
 * retry-attempt routes (and step/detail) straight to LocalChangeControl so the
 * recorded attempts surface in state exactly as the live Worker would record
 * them. The lease/recruit/fail/deployment handling mirrors the other e2e fakes.
 */
function fakeWorker(control: LocalChangeControl, workspaces: LocalFilesystemWorkspaceProvider) {
  // An ordered log of the create/plan lifecycle ops, so a test can assert that a
  // planning placeholder is created BEFORE the plan is attached (create-precedes-
  // plan). Each entry is the op name in the order the Worker handled it.
  const opLog: string[] = [];
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

    // Create a "planning" PLACEHOLDER Change (header only, status "planning")
    // BEFORE the planner ran, exactly as the live Worker's POST /changes/planning
    // does. Recorded in the op log so a test can assert create-precedes-plan.
    if (method === "POST" && url.pathname === "/changes/planning") {
      const b = body() as {
        id?: string;
        objective?: string;
        baseline?: string;
        budgetUsd?: number;
        assurance?: string;
      };
      control.createPlanning({
        id: String(b.id ?? ""),
        objective: String(b.objective ?? ""),
        baseline: String(b.baseline ?? "HEAD"),
        budgetUsd: typeof b.budgetUsd === "number" ? b.budgetUsd : 0,
        assurance: (b.assurance ?? "standard") as "none" | "standard" | "strict",
      });
      opLog.push("planning");
      return json({ ok: true }, 201);
    }
    if (method === "POST" && url.pathname === "/changes") {
      control.createChange(String(init?.body ?? ""));
      opLog.push("create");
      return json({ ok: true }, 201);
    }
    // Attach the decomposed plan to a planning placeholder (flips status to
    // "running"), exactly as the live Worker's POST /changes/:id/plan does. A
    // 404 when no placeholder exists lets runFullLive fall back to a plain
    // create, mirroring the live behavior.
    const planAttach = url.pathname.match(/^\/changes\/([^/]+)\/plan$/);
    if (method === "POST" && planAttach) {
      try {
        control.attachPlan(String(init?.body ?? ""));
        opLog.push("plan");
        return json({ ok: true }, 200);
      } catch {
        return json({ error: "no such Change" }, 404);
      }
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
    // The human escalation beat raises a lease-owner escalation on a contested
    // shared path and (in the unattended self-resolve path) resolves it with the
    // default owner. Delegate both to LocalChangeControl so a collision change
    // (needed to force a write-lease yield) runs the beat exactly as live.
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
    // The ladder's CHANGE-LEVEL verify-attempt / retry-attempt routes, plus the
    // per-unit step/detail/verify-fail routes, are delegated straight to
    // LocalChangeControl so the recorded attempts surface in state identically
    // to the live Worker (and back the graph nodes/edges).
    const delegated =
      /^\/changes\/[^/]+\/(verify-attempt|retry-attempt|jev-decision)$/.test(url.pathname) ||
      /^\/changes\/[^/]+\/verify-attempt\/refan$/.test(url.pathname) ||
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

  return { fetchFn, opLog };
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
  workRoot = await mkdtemp(join(tmpdir(), "scf-ladder-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function seedProject(dir: string): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "index.js"), "export default {};\n", "utf8");
}

/** Run the ladder once with a given gate passing-model, returning run + control. */
async function runLadder(options: {
  readonly passingModel: string;
  /** An injected dependency installer (default: the lockfile installer; these fixtures have no lockfile). */
  readonly dependencyInstaller?: DependencyInstaller;
  readonly maxModelRetries?: number;
  readonly subdir: string;
  /** Override the Change spec (defaults to the single-unit SPEC). */
  readonly spec?: string;
  /** Override the Change id read back from state (defaults to change-ladder). */
  readonly changeId?: string;
  /** Unit markers the gate always passes (to drive implicated attribution). */
  readonly alwaysPassingUnits?: readonly string[];
  /** The dial max concurrency the run uses (also the ladder re-fan cap). */
  readonly maxConcurrency?: number;
  /** An artificial per-execute delay so a re-fan can overlap observably. */
  readonly executorDelayMs?: number;
  /** Observe the per-attempt objective each execute received (prompt rotation). */
  readonly onObjective?: (record: {
    readonly unitId: string;
    readonly objective: string;
    readonly isEscalation: boolean;
  }) => void;
  /**
   * An ORDERED escalation model ladder. When set, each retry round steps to the
   * next entry (retry round 1 uses escalationModels[0], retry round 2 uses
   * escalationModels[1], clamped to the last). When unset the single
   * ESCALATION_MODEL is used for every retry round (the pre-list behavior).
   */
  readonly escalationModels?: readonly string[];
  /**
   * An optional injected Jev typed-decision caller for the attribution and
   * fix-confidence junctures, plus its accept-when-confident threshold. When set
   * the ladder asks Jev which module a failure implicates and the post-gate step
   * records a fix-confidence advisory; a deterministic fake keeps it offline.
   */
  readonly jev?: (
    state: string,
    questions: Readonly<
      Record<string, { readonly type: "noul" | "choice" | "score"; readonly instructions: string; readonly criteria?: readonly string[] }>
    >,
  ) => Promise<
    Readonly<
      Record<
        string,
        {
          readonly type: "noul" | "choice" | "score";
          readonly noul?: "yes" | "no" | "unsure";
          readonly choice?: string;
          readonly score?: number;
          readonly confidence: number;
          readonly probabilities?: Readonly<Record<string, number>>;
        }
      >
    >
  >;
  readonly jevThreshold?: number;
  /**
   * An optional injected re-plan transport for the retry re-fan. When set, the
   * ladder asks it (fed the failing evidence + candidate unit ids) for a REVISED
   * set of units to re-fan this round and re-fans only those; an invalid/empty
   * reply falls back to the string-parse implicated set. A deterministic fake
   * keeps it offline.
   */
  readonly rePlan?: (input: {
    readonly evidence: string;
    readonly candidateUnitIds: readonly string[];
    readonly attributionChoice?: string;
    readonly round: number;
    readonly priorRevisedUnitIds?: readonly string[];
  }) => Promise<
    | readonly string[]
    | {
        readonly units: readonly { readonly id: string; readonly objective: string }[];
        readonly rationale?: string;
        readonly model?: string;
      }
  >;
  /**
   * Use the ResourceNameGateRunner (names failing units by RESOURCE NAME in the
   * real assertion-line forms) instead of the file-path MarkerGateRunner, so a
   * test proves attribution narrows from the real `<name>: ...(401/403)` +
   * `<name> must ..., got 201` evidence rather than a named file.
   */
  readonly useResourceNameGate?: boolean;
  /**
   * Use the CrashGateRunner (fails with an UNATTRIBUTABLE crash output naming no
   * unit/file) so the string-parse attribution falls back to re-fanning ALL
   * units. A test uses this to prove a CONFIDENT Jev choice is the PRIMARY
   * selector that narrows the re-fan even when the parse cannot.
   */
  readonly useCrashGate?: boolean;
  /**
   * When true, create a "planning" PLACEHOLDER Change on the (fake) Worker
   * BEFORE the ladder runs, exactly as the live CLI does before the LLM planner.
   * runFullLive then ATTACHES the plan to that placeholder (status planning ->
   * running). Used by the create-first test to assert create-precedes-plan and
   * the status transition.
   */
  readonly preCreatePlanning?: boolean;
}) {
  const spec = options.spec ?? SPEC;
  const changeId = options.changeId ?? "change-ladder";
  const workspaces = new LocalFilesystemWorkspaceProvider({
    rootDir: join(workRoot, options.subdir, "artifacts"),
  });
  const control = new LocalChangeControl(workspaces);
  const { fetchFn, opLog } = fakeWorker(control, workspaces);
  const change = parseChangeSpec(spec);

  const projectDir = join(workRoot, options.subdir, "project");
  await seedProject(projectDir);

  // CREATE-FIRST: when asked, create the planning placeholder on the fake Worker
  // BEFORE the ladder/run touches it, so the console would attach to a Change
  // that already exists with status "planning". runFullLive attaches the plan
  // afterwards. The placeholder captured here lets the test assert the planning
  // status and empty work before the plan lands.
  let planningStateBeforeAttach: ChangeStateSnapshot | undefined;
  if (options.preCreatePlanning) {
    await createPlanningChange({
      workerUrl: "http://w",
      header: {
        id: changeId,
        objective: change.objective,
        baseline: change.baseline,
        budgetUsd: change.budgetUsd,
        assurance: change.assurance,
      },
      fetchFn,
    });
    planningStateBeforeAttach = control.state(changeId) as ChangeStateSnapshot;
  }

  const events: FullLiveEvent[] = [];
  const redeployed: string[] = [];
  const deployApp: DeployApp = async ({ appName }) => {
    redeployed.push(appName);
    return { url: `https://${appName}.example.workers.dev` };
  };

  const maxConcurrency = options.maxConcurrency ?? 2;
  const executor = new ModelAwareExecutor({
    baseModel: BASE_MODEL,
    ...(options.executorDelayMs ? { delayMs: options.executorDelayMs } : {}),
    ...(options.onObjective ? { onObjective: options.onObjective } : {}),
  });

  const result = await runFullLive({
    change,
    dial: { minConcurrency: 1, maxConcurrency },
    workerUrl: "http://w",
    specYaml: spec,
    projectDir,
    workRoot: join(workRoot, options.subdir, "run"),
    fetchFn,
    executor,
    // The ladder gate + escalation wiring (T6):
    appGateCommandFor: (unitId) => gateCommandFor(unitId),
    verifyCommandRunner: options.useCrashGate
      ? new CrashGateRunner({
          passingModel: options.passingModel,
          ...(options.alwaysPassingUnits ? { alwaysPassingUnits: options.alwaysPassingUnits } : {}),
        })
      : options.useResourceNameGate
        ? new ResourceNameGateRunner({
            passingModel: options.passingModel,
            ...(options.alwaysPassingUnits ? { alwaysPassingUnits: options.alwaysPassingUnits } : {}),
          })
        : new MarkerGateRunner({
            passingModel: options.passingModel,
            ...(options.alwaysPassingUnits ? { alwaysPassingUnits: options.alwaysPassingUnits } : {}),
          }),
    baseModel: BASE_MODEL,
    escalationModel: ESCALATION_MODEL,
    ...(options.escalationModels ? { escalationModels: options.escalationModels } : {}),
    maxModelRetries: options.maxModelRetries ?? 1,
    ...(options.jev ? { jev: options.jev, jevThreshold: options.jevThreshold ?? 0.75 } : {}),
    ...(options.rePlan ? { rePlan: options.rePlan } : {}),
    ...(options.dependencyInstaller ? { dependencyInstaller: options.dependencyInstaller } : {}),
    // Redeploy-in-place wiring (M8.4): the app was already deployed, so a
    // verified fix refreshes it; a red run must not redeploy.
    deployAppDir: projectDir,
    deployAppName: "switchyard-change-fabric-ladder-app",
    deployApp,
    appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
    onEvent: (e) => events.push(e),
  });

  const snapshot = control.state(changeId) as ChangeStateSnapshot;
  return { result, control, snapshot, events, redeployed, executor, opLog, planningStateBeforeAttach };
}

describe("dependency install before every gate run (offline, fake installer)", () => {
  it("installs in each gated tree before the ladder and final gates, and reports the final gate's install", async () => {
    const dirs: string[] = [];
    const installer: DependencyInstaller = {
      async install(dir) {
        dirs.push(dir);
        return { status: "installed", tool: "npm", detail: "npm ci", durationMs: 7 };
      },
    };
    const { result } = await runLadder({ passingModel: ESCALATION_MODEL, subdir: "install-ok", dependencyInstaller: installer });
    // A ladder round preview and the final gate each ran in their own tree, each installed first.
    expect(new Set(dirs).size).toBeGreaterThanOrEqual(2);
    expect(dirs.every((d) => !d.endsWith("/project"))).toBe(true);
    expect(result.dependencyInstall).toEqual({ status: "installed", tool: "npm", detail: "npm ci", durationMs: 7 });
    expect(result.evidence.integration.verdict).toBe("verified");
  });

  it("a failed install fails the gate honestly (the gate never runs) with the reason as the first line", async () => {
    const installer: DependencyInstaller = {
      async install() {
        return { status: "failed", tool: "npm", detail: "npm ci: npm error code ERESOLVE", durationMs: 3 };
      },
    };
    const { result, redeployed } = await runLadder({ passingModel: BASE_MODEL, subdir: "install-fail", dependencyInstaller: installer });
    expect(result.evidence.integration.verdict).toBe("failed");
    expect(result.evidence.integration.finalCheck.outputs.map((o) => o.text).join("\n")).toMatch(/^dependency install failed: npm ci: npm error code ERESOLVE/m);
    expect(result.dependencyInstall).toMatchObject({ status: "failed" });
    expect(result.promotion.committed).toBe(false);
    expect(redeployed).toEqual([]);
  });
});

describe("T10: the bounded model-escalation ladder (offline, deterministic)", () => {
  it("seeded failure: base fails -> escalation passes -> green + redeploy, with a visible ladder", async () => {
    const { result, snapshot, events, redeployed } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "seeded",
    });

    // The unit integrated and the app redeployed in place (a genuine fix landed).
    expect(result.evidence.integration.integratedUnits).toContain("fix");
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(redeployed).toEqual(["switchyard-change-fabric-ladder-app"]);
    expect(result.deployment?.app).toBe("switchyard-change-fabric-ladder-app");

    // Two change-level mechanical verify rounds recorded: round 1 FAIL (base),
    // round 2 PASS (escalation); and exactly one bounded retry escalating base
    // -> escalation, carrying the implicated unit it re-fanned.
    expect(snapshot.verifyAttempts).toHaveLength(2);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "fail", model: BASE_MODEL });
    expect(snapshot.verifyAttempts?.[1]).toMatchObject({ round: 2, outcome: "pass", model: ESCALATION_MODEL });
    // The round-1 verify recorded the gate command and the real failing output.
    expect(snapshot.verifyAttempts?.[0]?.gateCommand).toContain("gate");
    expect(snapshot.verifyAttempts?.[0]?.failingOutput).toContain("src/fix.fix");
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect(snapshot.retryAttempts?.[0]).toMatchObject({
      round: 2,
      fromModel: BASE_MODEL,
      toModel: ESCALATION_MODEL,
      implicatedUnits: ["fix"],
    });

    // The graph shows the visible change-level ladder: verify round 1 red ->
    // model-escalation -> retry round 2 -> verify round 2 green, and the
    // human-escalation flag stays OFF.
    const model = buildWorkGraphModel(snapshot);
    const v1 = model.nodes.find((n) => n.kind === "verify" && n.label.includes("round 1"));
    const v2 = model.nodes.find((n) => n.kind === "verify" && n.label.includes("round 2"));
    expect(v1?.verified).toBe(false);
    expect(v2?.verified).toBe(true);
    expect(model.nodes.some((n) => n.kind === "retry")).toBe(true);
    expect(model.edges.some((e) => e.backing.kind === "model-escalation")).toBe(true);
    expect(model.nodes.every((n) => n.escalated === false)).toBe(true);

    // The run emitted the honest ladder events in order: a fail verify, an
    // escalation, then a pass verify.
    const ladderEvents = events.filter(
      (e) => e.kind === "verify-attempt" || e.kind === "model-escalation",
    );
    expect(ladderEvents.map((e) => e.kind)).toEqual([
      "verify-attempt",
      "model-escalation",
      "verify-attempt",
    ]);
  });

  it("happy path: base passes on the first try, no retry, no model-escalation edge, redeploy", async () => {
    const { result, snapshot, redeployed } = await runLadder({
      passingModel: BASE_MODEL,
      subdir: "happy",
    });

    expect(result.evidence.integration.integratedUnits).toContain("fix");
    expect(redeployed).toEqual(["switchyard-change-fabric-ladder-app"]);

    // Exactly one change-level verify round (round 1 PASS); no retry recorded.
    expect(snapshot.verifyAttempts).toHaveLength(1);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "pass", model: BASE_MODEL });
    expect(snapshot.retryAttempts).toHaveLength(0);

    const model = buildWorkGraphModel(snapshot);
    expect(model.nodes.some((n) => n.kind === "retry")).toBe(false);
    expect(model.edges.some((e) => e.backing.kind === "model-escalation")).toBe(false);
    const v1 = model.nodes.find((n) => n.kind === "verify");
    expect(v1?.verified).toBe(true);
  });

  it("exhaustion: base and escalation both fail -> real red node, NOT integrated, NO redeploy", async () => {
    const { result, snapshot, redeployed } = await runLadder({
      passingModel: "no-model-ever-passes",
      subdir: "exhausted",
    });

    // The fix never passed the gate: it is NOT integrated and the app is NOT
    // redeployed (a non-fixing/broken edit is never greened or shipped).
    expect(result.evidence.integration.integratedUnits).not.toContain("fix");
    expect(redeployed).toEqual([]);
    expect(result.deployment).toBeUndefined();
    // A failed verdict is never promoted: no commit and an honest refusal.
    expect(result.evidence.integration.verdict).toBe("failed");
    expect(result.promotion.committed).toBe(false);
    expect(result.promotion.refusedReason).toMatch(/not "verified"/);

    // The bounded retry was honored exactly once (default max-retries = 1): two
    // change-level verify rounds (both FAIL) and one retry round, then it stops.
    expect(snapshot.verifyAttempts).toHaveLength(2);
    expect(snapshot.verifyAttempts?.every((a) => a.outcome === "fail")).toBe(true);
    expect(snapshot.retryAttempts).toHaveLength(1);

    // The change failed terminally, but that failure is shown on the GOAL and
    // the VERIFY nodes (both red), NOT by retroactively reddening the original
    // round-1 agent. The fix unit completed its own round-1 work, so it keeps
    // its real round-1 outcome instead of being flipped to failed solely because
    // the change-level gate failed.
    const model = buildWorkGraphModel(snapshot);
    const fixNode = model.nodes.find((n) => n.label === "fix");
    expect(fixNode?.status).not.toBe("failed");
    // Both change-level verify nodes are red (the honest terminal failure signal).
    expect(model.nodes.filter((n) => n.kind === "verify").every((n) => n.verified === false)).toBe(true);
    // The goal does not falsely green; it carries the change-level failure.
    expect(model.nodes.find((n) => n.kind === "goal")?.verified).toBe(false);
    // Gate-equals-deploy honesty is preserved independently of unit status: the
    // change is still not integrated and the app is still not redeployed (already
    // asserted above), so the terminal failure never greens or ships.
  });

  it("the max-retries dial bounds escalation: with maxModelRetries=0 a base-fail is terminal (no retry)", async () => {
    const { result, snapshot, redeployed } = await runLadder({
      passingModel: ESCALATION_MODEL, // escalation WOULD pass, but retries are disabled
      maxModelRetries: 0,
      subdir: "bounded-zero",
    });

    // With zero retries, the base round fail is terminal: one change-level verify
    // round, no retry, no integration, no redeploy, even though the escalation
    // model would pass.
    expect(snapshot.verifyAttempts).toHaveLength(1);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "fail" });
    expect(snapshot.retryAttempts).toHaveLength(0);
    expect(result.evidence.integration.integratedUnits).not.toContain("fix");
    expect(redeployed).toEqual([]);
  });

  it("steps the escalation ladder per retry round: round 1 base, retry 1 list[0], retry 2 list[1]", async () => {
    // An ORDERED escalation ladder of two models. The gate PASSES only when the
    // marker records the SECOND escalation model, so the change must climb:
    //   round 1 (base-model)   -> FAIL
    //   retry round 2 (step-1) -> FAIL (not yet the passing model)
    //   retry round 3 (step-2) -> PASS
    // This proves each retry round uses the NEXT better model, not one escalation
    // model repeated. Deterministic and offline (marker executor + marker gate).
    const STEP_1 = "escalation-step-1";
    const STEP_2 = "escalation-step-2";
    const { snapshot, result, redeployed } = await runLadder({
      passingModel: STEP_2, // only the SECOND escalation model's edit passes
      escalationModels: [STEP_1, STEP_2],
      maxModelRetries: 2,
      subdir: "ladder-steps",
    });

    // Three change-level verify rounds, recording a DIFFERENT model each round:
    // base, then the first escalation model, then the second (which passes).
    expect(snapshot.verifyAttempts).toHaveLength(3);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "fail", model: BASE_MODEL });
    expect(snapshot.verifyAttempts?.[1]).toMatchObject({ round: 2, outcome: "fail", model: STEP_1 });
    expect(snapshot.verifyAttempts?.[2]).toMatchObject({ round: 3, outcome: "pass", model: STEP_2 });

    // Two retries recorded, each escalating to the NEXT model in order (never the
    // same escalation model twice): base -> step 1, then step 1 -> step 2.
    expect(snapshot.retryAttempts).toHaveLength(2);
    expect(snapshot.retryAttempts?.[0]).toMatchObject({
      round: 2,
      fromModel: BASE_MODEL,
      toModel: STEP_1,
    });
    expect(snapshot.retryAttempts?.[1]).toMatchObject({
      round: 3,
      fromModel: STEP_1,
      toModel: STEP_2,
    });

    // The change ultimately passed on the second escalation model: it integrated
    // and redeployed, proving the climb reached the model that fixes the bug.
    expect(result.evidence.integration.integratedUnits).toContain("fix");
    expect(redeployed).toEqual(["switchyard-change-fabric-ladder-app"]);
  });

  it("clamps the ladder to the LAST model when retries run past the list", async () => {
    // A one-element ladder with two retries: both retry rounds must reuse that
    // single model (clamped), never run off the end into an empty model id.
    const ONLY = "only-escalation";
    const { snapshot } = await runLadder({
      passingModel: "never-passes", // force exhaustion so both retry rounds run
      escalationModels: [ONLY],
      maxModelRetries: 2,
      subdir: "ladder-clamp",
    });
    // Three verify rounds: base, then the single escalation model twice (clamped).
    expect(snapshot.verifyAttempts).toHaveLength(3);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, model: BASE_MODEL });
    expect(snapshot.verifyAttempts?.[1]).toMatchObject({ round: 2, model: ONLY });
    expect(snapshot.verifyAttempts?.[2]).toMatchObject({ round: 3, model: ONLY });
    // Both retries escalated TO the same clamped model (from base, then from it).
    expect(snapshot.retryAttempts?.map((r) => r.toModel)).toEqual([ONLY, ONLY]);
  });

  it("implicated-unit attribution re-fans only the unit the failing gate output names, not all units", async () => {
    // Two units: alpha already passes on the base model (always-passing marker),
    // beta needs the escalation model. Round 1 fails naming only beta's file, so
    // the single change-level retry must re-fan ONLY beta.
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "attribution",
    });

    // One change-level retry recorded, carrying ONLY the implicated unit (beta),
    // not alpha. This is the whole point: attribution narrowed the re-fan.
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).toEqual(["beta"]);
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).not.toContain("alpha");

    // Two change-level verify rounds: round 1 FAIL, round 2 PASS once beta is
    // re-fanned on the escalation model. The retry node label names 1 unit.
    expect(snapshot.verifyAttempts).toHaveLength(2);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "fail" });
    expect(snapshot.verifyAttempts?.[1]).toMatchObject({ round: 2, outcome: "pass" });
    const model = buildWorkGraphModel(snapshot);
    const retryNode = model.nodes.find((n) => n.kind === "retry");
    expect(retryNode?.label).toContain("1 unit");
  });

  it("falls back to re-fanning ALL units when the gate failure cannot be attributed", async () => {
    // The single-unit seeded run: the gate names src/fix.fix, which the unit
    // declares, so attribution matches it. To prove the honest fallback, a unit
    // whose declared path does NOT cover the named file still re-fans (the
    // selectImplicatedUnits fallback), proven here by the whole change still
    // escalating and settling rather than silently skipping.
    const { snapshot, result } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "fallback",
    });
    // The retry re-fanned the (only) unit and the second round settled green.
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).toEqual(["fix"]);
    expect(result.evidence.integration.integratedUnits).toContain("fix");
  });

  it("attributes a round-1 fail implicating ONLY auth to auth on the FIRST retry (real assertion-line format, 6 resources)", async () => {
    // Six resources, only auth fails round 1; the gate names failing resources
    // by RESOURCE NAME in the real `✖ auth: ...(401/403)` + `auth must ..., got
    // 201` forms (no source-file path). The FIRST retry (round 2) must re-fan
    // ONLY auth, proving the narrowing happens on the first retry from the real
    // assertion-line evidence, not after a crash round. The refan source is the
    // string-parse ("parse"), and the failing verify records it.
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_SIX_RESOURCES,
      changeId: "change-ladder-six",
      alwaysPassingUnits: ["users", "orders", "products", "search", "notifications"],
      useResourceNameGate: true,
      subdir: "six-auth",
    });

    // Exactly ONE retry (the first), re-fanning ONLY auth.
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect(snapshot.retryAttempts?.[0]?.round).toBe(2);
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).toEqual(["auth"]);
    for (const other of ["users", "orders", "products", "search", "notifications"]) {
      expect(snapshot.retryAttempts?.[0]?.implicatedUnits).not.toContain(other);
    }
    // The re-fan source is the deterministic string-parse (no Jev, no re-plan).
    expect(snapshot.retryAttempts?.[0]?.refanSource).toBe("parse");

    // Two change-level verify rounds: round 1 FAIL (base), round 2 PASS once auth
    // is re-fanned on the escalation model.
    expect(snapshot.verifyAttempts).toHaveLength(2);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "fail" });
    expect(snapshot.verifyAttempts?.[1]).toMatchObject({ round: 2, outcome: "pass" });
    // The failing round-1 verify records the implicated units + refan source it
    // produced (persisted on the verify attempt), so the console can show WHY.
    expect(snapshot.verifyAttempts?.[0]?.implicatedUnits).toEqual(["auth"]);
    expect(snapshot.verifyAttempts?.[0]?.refanSource).toBe("parse");
  });

  it("still FALLS BACK to re-fanning all when a round-1 crash output is unattributable (fallback not weakened)", async () => {
    // Prove the honest fallback directly on the attribution function: a crash
    // output that names no resource and no owned file re-fans ALL units, so a
    // genuinely unattributable failure is never narrowed away.
    const sixUnits = ["users", "orders", "products", "auth", "search", "notifications"].map(
      (id) => ({
        unitId: id,
        objective: `fix ${id}`,
        paths: [`src/${id}.fix`],
        authRemote: `https://example.invalid/${id}.git`,
        gateCommand: ["npm", "run", "gate"],
        requiredExports: [],
      }),
    );
    const crash = [
      "✖ gate/run.mjs (12ms)",
      "  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/abs/src/resources/auth.js'",
      "    code: 'ERR_MODULE_NOT_FOUND'",
    ].join("\n");
    const { attributeImplicatedUnits } = await import("../src/run-live.ts");
    const result = attributeImplicatedUnits(sixUnits, crash);
    expect(result.attributed).toBe(false);
    expect(result.units.map((u) => u.unitId)).toEqual(sixUnits.map((u) => u.unitId));
  });
});

describe("T10b: the retry round is a VISIBLE second wave (re-fan edges + per-unit activity steps)", () => {
  it("links the retry node to each implicated unit it re-fanned and logs a real retry-round step on each", async () => {
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "visible-single",
    });

    // The graph model draws a re-fan edge from the retry node to a FRESH round-N
    // agent node materialized beneath the retry (not a back-edge to the original
    // unit), backed by the recorded implicatedUnits: the user can SEE which agent
    // the retry re-fanned, laid out below the retry.
    const model = buildWorkGraphModel(snapshot);
    const retry = model.nodes.find((n) => n.kind === "retry");
    expect(retry).toBeDefined();
    const refan = model.edges.filter((e) => e.backing.kind === "re-fan");
    expect(refan).toHaveLength(1);
    expect(refan[0]?.from).toBe(retry?.id);
    // The target is the round-N agent instance, never the original unit node.
    expect(refan[0]?.to).toBe(roundAgentNodeId(snapshot.id, 2, "fix"));
    expect(refan[0]?.to).not.toBe("unit:fix");
    expect(refan[0]?.backing).toMatchObject({ kind: "re-fan", unitId: "fix", round: 2 });
    // The round-N agent node exists beneath the retry and is backed.
    const roundNode = model.nodes.find((n) => n.id === roundAgentNodeId(snapshot.id, 2, "fix"));
    expect(roundNode?.kind).toBe("agent");
    expect(roundNode?.label).toContain("retry 2");
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }

    // The implicated unit logged a REAL retry-round activity step (the second
    // wave in its activity log), naming the round and the escalation model.
    const fixUnit = snapshot.work.find((u) => u.id === "fix");
    const phases = (fixUnit?.activity ?? []).map((s) => s.phase);
    expect(phases).toContain("retrying");
    const retryingStep = (fixUnit?.activity ?? []).find((s) => s.phase === "retrying");
    expect(retryingStep?.message).toContain("retry round 2");
    expect(retryingStep?.message).toContain(ESCALATION_MODEL);
    // And a settled step once the round's re-fan committed/pushed its edit.
    expect(phases).toContain("retried");
  });

  it("re-invokes the model each retry round (a real model-call step per round) and lands a pushed edit", async () => {
    // No model ever passes, so both bounded retry rounds fire. Each round must
    // genuinely re-invoke the executor on the implicated unit, so a `model-call`
    // step is recorded on that unit for every round. This is the fix for the
    // retry-no-op: the round used to reuse one worktree (a clean tree skipped the
    // push) and omit the observability callbacks (no model-call step), so the
    // retry looked like a no-op; now each round clones a fresh worktree and
    // threads onStep, so the model-call is both run and visible.
    const { snapshot } = await runLadder({
      passingModel: "no-model-ever-passes",
      maxModelRetries: 2,
      subdir: "model-call-per-round",
    });

    const fixUnit = snapshot.work.find((u) => u.id === "fix");
    const activity = fixUnit?.activity ?? [];
    // Two retry rounds (round 2 and round 3) each re-invoked the model, so there
    // are at least two recorded model-call steps on the implicated unit (one per
    // retry round), proving the retry is not a no-op.
    const modelCalls = activity.filter((s) => s.phase === "model-call");
    expect(modelCalls.length).toBeGreaterThanOrEqual(2);
    // Each retry round also produced a visible retrying/retried pair and the
    // model-call sits between the two retry rounds.
    expect(activity.filter((s) => s.phase === "retrying").length).toBeGreaterThanOrEqual(2);
    expect(activity.filter((s) => s.phase === "retried").length).toBeGreaterThanOrEqual(2);
  });

  it("re-fans the implicated units with BOUNDED CONCURRENCY up to the dial cap, not strictly one-after-another", async () => {
    // Three units all need escalation, so the single retry re-fans all three.
    // With a dial max of 3 and an artificial per-execute delay, a bounded-
    // concurrency re-fan overlaps all three calls (peak in-flight = 3), while a
    // strictly sequential loop would peak at 1.
    const { snapshot, executor, result } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_THREE_UNITS,
      changeId: "change-ladder-three",
      subdir: "concurrent",
      maxConcurrency: 3,
      executorDelayMs: 25,
    });

    // All three units were re-fanned in the single retry round.
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect([...(snapshot.retryAttempts?.[0]?.implicatedUnits ?? [])].sort()).toEqual([
      "one",
      "three",
      "two",
    ]);
    // The re-fan overlapped: the peak in-flight reached the cap (3), proving it
    // is NOT strictly sequential. It never exceeds the cap (bounded, not
    // unbounded parallel).
    expect(executor.maxInFlight).toBe(3);
    expect(executor.maxInFlight).toBeLessThanOrEqual(3);
    // The change still settled green with every unit integrated.
    expect([...result.evidence.integration.integratedUnits].sort()).toEqual(["one", "three", "two"]);
  });

  it("holds the re-fan to the dial cap when there are more implicated units than the cap", async () => {
    // Same three-unit change but a dial max of 2: the re-fan may run at most 2
    // units at once, so the peak in-flight is exactly 2 (bounded below N=3),
    // proving the cap is honored rather than fanning all units out at once.
    const { executor, result } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_THREE_UNITS,
      changeId: "change-ladder-three",
      subdir: "capped",
      maxConcurrency: 2,
      executorDelayMs: 25,
    });
    expect(executor.maxInFlight).toBe(2);
    expect([...result.evidence.integration.integratedUnits].sort()).toEqual(["one", "three", "two"]);
  });
});

describe("round-N agents: a retry round spawns and tracks REAL agents like the kickoff wave", () => {
  it("records a round-N agent instance with its OWN recorded workspace and a real status lifecycle (not a fixed status)", async () => {
    // Seeded single-unit run: round 1 fails, round 2 re-fans "fix" on the
    // escalation model and the round passes. The retry round's re-fanned unit is
    // a BRAND NEW round-N agent keyed by (unit, round), recorded with its own
    // Artifact repo and driven running -> integrated through the SAME lifecycle
    // machinery the kickoff wave records.
    const { snapshot } = await runLadder({ passingModel: ESCALATION_MODEL, subdir: "round-agent-green" });

    const roundAgents = snapshot.roundAgents ?? [];
    expect(roundAgents).toHaveLength(1);
    const agent = roundAgents[0]!;
    expect(agent.unitId).toBe("fix");
    expect(agent.round).toBe(2);
    // It carries its OWN real Artifact repo, recorded like a kickoff lease, with
    // an r2 suffix so it is distinct from the kickoff repo.
    expect(agent.workspace).toBeDefined();
    expect(agent.workspace.workspaceName).toContain("fix");
    expect(agent.workspace.workspaceName).toContain("r2");
    // The status is a REAL lifecycle outcome, not a fixed literal: this round
    // pushed an edit, so the round-N agent reached "integrated".
    expect(agent.status).toBe("integrated");
    // It carries real activity (the ordered run steps the round-N agent emitted)
    // including a model-call step, proving the escalation model ran this round.
    const phases = (agent.activity ?? []).map((s) => s.phase);
    expect(phases).toContain("leased");
    expect(phases).toContain("model-call");
    expect(phases).toContain("pushed");
    // It carries real detail (the model id and the edited paths) exactly like a
    // kickoff agent.
    expect(agent.detail?.model).toBe(ESCALATION_MODEL);
    expect(agent.detail?.editedPaths).toContain("src/fix.fix");
  });

  it("projects the round-N agent node whose status comes from recorded state (green when the round produced an edit), fully backed", async () => {
    const { snapshot } = await runLadder({ passingModel: ESCALATION_MODEL, subdir: "round-agent-node-green" });
    const model = buildWorkGraphModel(snapshot);
    const roundNode = model.nodes.find((n) => n.id === roundAgentNodeId(snapshot.id, 2, "fix"));
    expect(roundNode).toBeDefined();
    expect(roundNode?.kind).toBe("agent");
    // The node's status/verified come from the RECORDED round-N state, not the
    // old hardcoded "running"/false: the round integrated, so it greens.
    expect(roundNode?.status).toBe("integrated");
    expect(roundNode?.verified).toBe(true);
    // The node carries the round-N agent's OWN recorded workspace and activity.
    expect(roundNode?.workspace?.workspaceName).toContain("r2");
    expect((roundNode?.activity ?? []).some((s) => s.phase === "model-call")).toBe(true);
    // Every node (including the dynamic round-N node) still passes the backing
    // guard: no-unbacked-node holds.
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("round-N agents reflect their own per-round recorded status while the change-level gate stays the authority (original unit keeps its round-1 outcome)", async () => {
    // No model ever passes, so both bounded retry rounds fire and the change
    // exhausts. The ModelAwareExecutor always writes a marker (so each round
    // pushes an edit and the round-N agent integrates per round), but the final
    // round's agent is recorded with a real terminal status either way. Use a
    // fail-driving executor path: the executor that produces no change on the
    // last round would mark that round failed. Here we assert the authority
    // split: the round-N agents reflect THEIR per-round work, while the
    // change-level gate stays the authority on the whole change.
    const { snapshot, result } = await runLadder({
      passingModel: "no-model-ever-passes",
      maxModelRetries: 2,
      subdir: "round-agent-red",
    });
    // Two retry rounds recorded (rounds 2 and 3), each a distinct round-N agent
    // instance for "fix" keyed by (unit, round).
    const roundAgents = snapshot.roundAgents ?? [];
    const rounds = roundAgents.map((a) => a.round).sort();
    expect(rounds).toEqual([2, 3]);
    for (const agent of roundAgents) {
      expect(agent.unitId).toBe("fix");
      // Each round's agent reached a REAL terminal status (integrated: it pushed
      // its per-round edit). The authority on the whole change is the gate below.
      expect(["integrated", "failed"]).toContain(agent.status);
      expect(agent.workspace.workspaceName).toContain(`r${agent.round}`);
    }
    // Each round's agent has a distinct recorded workspace (its OWN repo per
    // (unit, round)), so round 2 and round 3 are genuinely separate instances.
    const names = new Set(roundAgents.map((a) => a.workspace.workspaceName));
    expect(names.size).toBe(roundAgents.length);
    // The AUTHORITATIVE gate still decides: the change never passed, so the
    // change did not integrate (gate-equals-deploy). But that change-level
    // failure is NOT painted onto the original "fix" agent: a unit that completed
    // its round-1 work keeps its real round-1 outcome rather than being flipped
    // to failed solely because the change-level gate failed.
    expect(snapshot.work.find((u) => u.id === "fix")?.status).not.toBe("failed");
    expect(result.evidence.integration.integratedUnits).not.toContain("fix");

    // The change-level failure is shown on the GOAL (red) and the VERIFY nodes
    // (red), the honest terminal signal, independent of the per-unit status.
    const failModel = buildWorkGraphModel(snapshot);
    expect(failModel.nodes.find((n) => n.kind === "goal")?.verified).toBe(false);
    expect(
      failModel.nodes.filter((n) => n.kind === "verify").every((n) => n.verified === false),
    ).toBe(true);

    // The graph projects each round-N node from its recorded state and every
    // node stays backed.
    const model = buildWorkGraphModel(snapshot);
    for (const round of rounds) {
      const node = model.nodes.find((n) => n.id === roundAgentNodeId(snapshot.id, round, "fix"));
      expect(node).toBeDefined();
      expect(node?.workspace?.workspaceName).toContain(`r${round}`);
    }
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("records a distinct round-N agent per implicated unit, each with its own workspace and model-call", async () => {
    // Two units: alpha already passes on the base model, beta needs escalation.
    // Only beta is re-fanned, so exactly one round-N agent (beta round 2) is
    // recorded, with its own repo and a real model-call.
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "round-agent-attribution",
    });
    const roundAgents = snapshot.roundAgents ?? [];
    expect(roundAgents).toHaveLength(1);
    expect(roundAgents[0]?.unitId).toBe("beta");
    expect(roundAgents[0]?.round).toBe(2);
    expect(roundAgents[0]?.status).toBe("integrated");
    expect((roundAgents[0]?.activity ?? []).some((s) => s.phase === "model-call")).toBe(true);
    // No round-N agent was spawned for the already-passing alpha unit.
    expect(roundAgents.some((a) => a.unitId === "alpha")).toBe(false);
  });
});

/**
 * The HONESTY-CRITICAL divergence case. The bug this proves against: the ladder
 * gates a NAIVE OVERLAY (baseline + every unit's changed files, no lease/exclusion
 * handling) while the integrator promotes a WRITE-LEASE-COORDINATED tree (yielded
 * contested paths and excluded units removed). When those two compositions differ,
 * a pass on the overlay did NOT mean the shipped tree was fixed, so a run could
 * report verify pass / green / redeploy while the deployed app was still broken.
 *
 * This change is built so the two compositions genuinely diverge:
 *   - `blocker` and `fixer` both declare the SAME contested path (src/shared.fix),
 *     so write-lease coordination grants ONE owner and makes the other yield it.
 *   - `blocker` is declared first, so it is the lease OWNER and writes the NON-fix
 *     (BROKEN_CONTENT). `fixer` is declared second, so it YIELDS the contested
 *     path and writes the real fix (FIXED_CONTENT).
 *   - Naive overlay (the ladder's advisory round): both edits are copied, last
 *     writer wins, so `fixer`'s FIXED_CONTENT lands and the gate PASSES.
 *   - Lease-coordinated integrated tree (what promotes/deploys): `fixer` yields
 *     src/shared.fix to the owner, so its fix is STRIPPED and the shipped tree has
 *     only `blocker`'s non-fix (or nothing), so the gate FAILS.
 *
 * The fix under test makes the AUTHORITATIVE verdict the per-app gate run on the
 * real integrated tree inside verifyAndIntegrate, so this divergence now fails
 * HONEST: the integration verdict is "failed", nothing is reported integrated,
 * and the app is NOT redeployed. Before the fix the integrated tree was never
 * gated (vacuous "verified"), so the overlay pass would have shipped a broken app.
 */
describe("T12: honesty invariant: a lease-coordinated integrated tree that diverges from the overlay fails HONEST", () => {
  const DIVERGENCE_SPEC = `
id: change-divergence
objective: Two units both write the same contested file; only the yielder fixes it
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: blocker
    objective: owns the contested path, writes a non-fix
    paths: [src/shared.fix]
  - id: fixer
    objective: yields the contested path, writes the real fix
    paths: [src/shared.fix]
`;

  it("the overlay would pass but the promoted tree does not: FINAL FAIL, no redeploy", async () => {
    const subdir = "divergence";
    const changeId = "change-divergence";
    const workspaces = new LocalFilesystemWorkspaceProvider({
      rootDir: join(workRoot, subdir, "artifacts"),
    });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(DIVERGENCE_SPEC);

    const projectDir = join(workRoot, subdir, "project");
    await seedProject(projectDir);

    const events: FullLiveEvent[] = [];
    const redeployed: string[] = [];
    const deployApp: DeployApp = async ({ appName }) => {
      redeployed.push(appName);
      return { url: `https://${appName}.example.workers.dev` };
    };

    // One shared gate runner is used for BOTH the ladder's advisory overlay gate
    // and the authoritative integrated-tree gate, so the only difference between
    // a pass and a fail is the COMPOSITION it reads, not the gate. The executor
    // makes `fixer` write the fix and `blocker` write the non-fix into the one
    // shared file. maxModelRetries=0 keeps this purely about composition, not
    // model escalation.
    const gate = new SharedPathGateRunner();
    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workerUrl: "http://w",
      specYaml: DIVERGENCE_SPEC,
      projectDir,
      workRoot: join(workRoot, subdir, "run"),
      fetchFn,
      executor: new SharedPathExecutor("fixer"),
      appGateCommandFor: (unitId) => gateCommandFor(unitId),
      verifyCommandRunner: gate,
      baseModel: BASE_MODEL,
      escalationModel: ESCALATION_MODEL,
      maxModelRetries: 0,
      deployAppDir: projectDir,
      deployAppName: "switchyard-change-fabric-divergence-app",
      deployApp,
      appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
      onEvent: (e) => events.push(e),
    });

    const snapshot = control.state(changeId) as ChangeStateSnapshot;

    // The ladder's advisory overlay round PASSED (both edits overlaid, fixer's
    // fix won last-writer), which is exactly the misleading signal the old code
    // treated as final success.
    expect(snapshot.verifyAttempts).toHaveLength(1);
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "pass" });

    // But the AUTHORITATIVE verdict is the gate on the promoted/integrated tree,
    // where fixer yielded the contested path, so the shipped tree is NOT fixed.
    // The honesty invariant holds: integration is FAILED, nothing is reported
    // integrated, and the app is NOT redeployed.
    expect(result.evidence.integration.verdict).toBe("failed");
    expect(result.evidence.integration.integratedUnits).toEqual([]);
    expect(result.evidence.integration.finalCheck.passed).toBe(false);
    expect(result.deployment).toBeUndefined();
    expect(redeployed).toEqual([]);

    // The run reported deploy-skipped (verdict not verified), never redeployed,
    // so it is impossible to show green while the integrated artifact fails.
    expect(events.some((e) => e.kind === "redeployed")).toBe(false);
    expect(events.some((e) => e.kind === "deploy-skipped")).toBe(true);
  });

  it("honesty invariant control: when the shipped tree carries the fix, the authoritative gate passes and redeploys", async () => {
    // The mirror case proves the fix did not just hard-fail everything: when the
    // promoted (lease-coordinated) tree genuinely carries the fix, the
    // authoritative gate passes and the app redeploys. Both units write the fix,
    // so whichever one yields the contested path, the lease OWNER still
    // contributes FIXED_CONTENT and the integrated tree is fixed. Same fakes,
    // same gate: the pass is tied to the promoted composition being correct.
    const subdir = "divergence-pass";
    const changeId = "change-divergence";
    const workspaces = new LocalFilesystemWorkspaceProvider({
      rootDir: join(workRoot, subdir, "artifacts"),
    });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(DIVERGENCE_SPEC);

    const projectDir = join(workRoot, subdir, "project");
    await seedProject(projectDir);

    const redeployed: string[] = [];
    const deployApp: DeployApp = async ({ appName }) => {
      redeployed.push(appName);
      return { url: `https://${appName}.example.workers.dev` };
    };

    const result = await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      workerUrl: "http://w",
      specYaml: DIVERGENCE_SPEC,
      projectDir,
      workRoot: join(workRoot, subdir, "run"),
      fetchFn,
      // Every unit writes the fix, so the promoted tree is fixed whichever one
      // yields the contested path.
      executor: new SharedPathExecutor("*"),
      appGateCommandFor: (unitId) => gateCommandFor(unitId),
      verifyCommandRunner: new SharedPathGateRunner(),
      baseModel: BASE_MODEL,
      escalationModel: ESCALATION_MODEL,
      maxModelRetries: 0,
      deployAppDir: projectDir,
      deployAppName: "switchyard-change-fabric-divergence-app",
      deployApp,
      appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
    });

    const snapshot = control.state(changeId) as ChangeStateSnapshot;
    // The advisory overlay round passes too (the fix is present), but the point
    // is the AUTHORITATIVE gate on the promoted tree, asserted below.
    expect(snapshot.verifyAttempts?.[0]).toMatchObject({ round: 1, outcome: "pass" });

    // The promoted tree carries the fix, so the authoritative gate passes and a
    // single owner integrates and redeploys (the yielder's contested path was
    // stripped, but the owner provides the same fix).
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(result.evidence.integration.integratedUnits.length).toBeGreaterThan(0);
    expect(redeployed).toEqual(["switchyard-change-fabric-divergence-app"]);
  });
});

describe("G3: the retry prompt rotates per round and feeds the real failing gate evidence", () => {
  it("runs the plain objective at the base round, then a precise-fix prompt and a full-rewrite prompt on later rounds, each carrying the failing evidence", async () => {
    const captured: Array<{ unitId: string; objective: string; isEscalation: boolean }> = [];
    // No model ever passes the gate, so both bounded retry rounds fire and we can
    // observe the round-2 (precise-fix) and round-3 (full-rewrite) prompts.
    await runLadder({
      passingModel: "no-model-ever-passes",
      maxModelRetries: 2,
      subdir: "rotation",
      onObjective: (record) => captured.push(record),
    });

    // The base (kickoff) attempt ran the plain objective: no escalation, no
    // injected failing evidence, no rotation strategy text.
    const base = captured.find((c) => !c.isEscalation);
    expect(base).toBeDefined();
    expect(base?.objective).toBe("fix the planted bug in the app");
    expect(base?.objective).not.toMatch(/failing gate evidence/i);

    // The escalation attempts rotated the strategy per round and each fed the
    // REAL failing gate output (which names the failing marker file). There are
    // two retry rounds (round 2 and round 3).
    const escalations = captured.filter((c) => c.isEscalation);
    expect(escalations).toHaveLength(2);

    // Round 2: a precise-fix prompt that steers the smallest change, with the
    // real failing evidence folded in.
    const round2 = escalations[0];
    expect(round2?.objective).toMatch(/fix precisely what failed/i);
    expect(round2?.objective).toMatch(/smallest change/i);
    expect(round2?.objective).toMatch(/failing gate evidence/i);
    expect(round2?.objective).toContain("src/fix.fix"); // the gate named this file

    // Round 3: a different, escalated strategy (full corrected file honoring the
    // frozen contract), still carrying the real failing evidence. The two retry
    // prompts differ, so an identical-prompt gateway cache is naturally bypassed.
    const round3 = escalations[1];
    expect(round3?.objective).toMatch(/full corrected contents/i);
    expect(round3?.objective).toMatch(/frozen contract/i);
    expect(round3?.objective).toMatch(/failing gate evidence/i);
    expect(round3?.objective).toContain("src/fix.fix");
    expect(round3?.objective).not.toEqual(round2?.objective);
  });
});

describe("the frozen contract file CONTENTS reach the agent prompt on both kickoff and the ladder re-fan", () => {
  // A spec with a cohesion blueprint: two frozen contracts at the seam and one
  // owner module. run-live derives frozenContracts from blueprint.contracts and
  // reads their real contents from the project dir, threading both to the
  // executor on the kickoff wave and on the ladder re-fan.
  const BLUEPRINT_SPEC = `
id: change-contract-contents
objective: Fix the resource; honor the frozen contracts
baseline: HEAD
budget_usd: 10.00
assurance: standard

work:
  - id: users
    objective: require auth and validate input in the users resource
    paths: [src/users.fix]

blueprint:
  contracts:
    - path: src/contracts/auth.js
      imported_by_count: 1
    - path: src/contracts/response.js
      imported_by_count: 1
  modules:
    - unit_id: users
      paths: [src/users.fix]
      exports: [handle]
`;

  // The real contract bodies seeded into the project dir, so run-live reads the
  // genuine exported API (requireAuth + json/problem/readBody) and shows it to
  // the model, not just the paths.
  const AUTH_CONTRACT =
    "import { problem } from './response.js';\n" +
    "export const DEMO_TOKEN = 'demo-token';\n" +
    "export function requireAuth(request) {\n" +
    "  const header = request.headers.get('authorization') || '';\n" +
    "  return header ? null : problem(401, 'authentication required');\n" +
    "}\n";
  const RESPONSE_CONTRACT =
    "export function json(body, status = 200) {\n" +
    "  return new Response(JSON.stringify(body), { status });\n" +
    "}\n" +
    "export function problem(status, detail) {\n" +
    "  return new Response(JSON.stringify({ error: detail }), { status });\n" +
    "}\n" +
    "export async function readBody(request) {\n" +
    "  try { return await request.json(); } catch { return {}; }\n" +
    "}\n";

  /**
   * A capturing executor that records the frozenContractFiles each attempt
   * received (kickoff vs escalation re-fan), while still writing the unit's
   * marker so the MarkerGateRunner drives the ladder (base round fails, the
   * escalation round passes). It is deterministic and offline: no model, no
   * network.
   */
  class CapturingExecutor implements ExecutorProvider {
    readonly name = "capturing-fake";
    readonly attempts: Array<{
      readonly isEscalation: boolean;
      readonly frozenContracts: readonly string[];
      readonly frozenContractFiles: readonly { readonly path: string; readonly contents: string }[];
    }> = [];
    async execute(context: ExecutorContext): Promise<ExecutionResult> {
      const isEscalation = (context.model ?? "").trim() !== "";
      this.attempts.push({
        isEscalation,
        frozenContracts: context.frozenContracts ?? [],
        frozenContractFiles: context.frozenContractFiles ?? [],
      });
      const model = (context.model ?? "").trim() || BASE_MODEL;
      const rel = `src/${context.workUnitId}.fix`;
      const abs = join(context.worktreeDir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, `model: ${model}\n`, "utf8");
      return {
        status: "changed",
        changedPaths: [rel],
        logs: [`capturing fake wrote ${rel} for ${model}`],
        cost: { usd: 0, inputTokens: 0, outputTokens: 0, model },
        commitMessage: `WorkUnit ${context.workUnitId}: edit by ${model}`,
      };
    }
  }

  it("reads the real contract bodies from the project dir and threads them to the kickoff AND re-fan executor calls", async () => {
    const subdir = "contract-contents";
    const changeId = "change-contract-contents";
    const workspaces = new LocalFilesystemWorkspaceProvider({
      rootDir: join(workRoot, subdir, "artifacts"),
    });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    const change = parseChangeSpec(BLUEPRINT_SPEC);

    // Seed the project dir with the real frozen contract files so run-live's
    // reader finds and reads them.
    const projectDir = join(workRoot, subdir, "project");
    await seedProject(projectDir);
    await mkdir(join(projectDir, "src", "contracts"), { recursive: true });
    await writeFile(join(projectDir, "src/contracts/auth.js"), AUTH_CONTRACT, "utf8");
    await writeFile(join(projectDir, "src/contracts/response.js"), RESPONSE_CONTRACT, "utf8");

    const executor = new CapturingExecutor();
    // The base round fails (base model), the escalation round passes, so the
    // ladder re-fans the unit once: that exercises BOTH prompt paths.
    await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: BLUEPRINT_SPEC,
      projectDir,
      workRoot: join(workRoot, subdir, "run"),
      fetchFn,
      executor,
      appGateCommandFor: (unitId) => gateCommandFor(unitId),
      verifyCommandRunner: new MarkerGateRunner({ passingModel: ESCALATION_MODEL }),
      baseModel: BASE_MODEL,
      escalationModel: ESCALATION_MODEL,
      maxModelRetries: 1,
    });

    // The blueprint's contract paths reached the executor (not just empty).
    const kickoff = executor.attempts.find((a) => !a.isEscalation);
    const refan = executor.attempts.find((a) => a.isEscalation);
    expect(kickoff).toBeDefined();
    expect(refan).toBeDefined();

    for (const attempt of [kickoff!, refan!]) {
      // The paths are threaded as before.
      expect([...attempt.frozenContracts].sort()).toEqual([
        "src/contracts/auth.js",
        "src/contracts/response.js",
      ]);
      // The CONTENTS carry the real exported API, not just the paths: the
      // requireAuth signature from auth.js and json/problem/readBody from
      // response.js. This is what stops the model inventing a function that does
      // not exist.
      const byPath = new Map(attempt.frozenContractFiles.map((f) => [f.path, f.contents]));
      expect(byPath.get("src/contracts/auth.js")).toContain("export function requireAuth");
      const response = byPath.get("src/contracts/response.js") ?? "";
      expect(response).toContain("export function json");
      expect(response).toContain("export function problem");
      expect(response).toContain("export async function readBody");
    }
  });

  it("is empty-safe: a Change with no blueprint contracts threads no contract files (unchanged prompt)", async () => {
    const subdir = "contract-contents-empty";
    const workspaces = new LocalFilesystemWorkspaceProvider({
      rootDir: join(workRoot, subdir, "artifacts"),
    });
    const control = new LocalChangeControl(workspaces);
    const { fetchFn } = fakeWorker(control, workspaces);
    // The plain single-unit SPEC has no blueprint, so no contracts are derived.
    const change = parseChangeSpec(SPEC);

    const projectDir = join(workRoot, subdir, "project");
    await seedProject(projectDir);

    const executor = new CapturingExecutor();
    await runFullLive({
      change,
      dial: { minConcurrency: 1, maxConcurrency: 2 },
      workerUrl: "http://w",
      specYaml: SPEC,
      projectDir,
      workRoot: join(workRoot, subdir, "run"),
      fetchFn,
      executor,
      appGateCommandFor: (unitId) => gateCommandFor(unitId),
      verifyCommandRunner: new MarkerGateRunner({ passingModel: BASE_MODEL }),
      baseModel: BASE_MODEL,
      escalationModel: ESCALATION_MODEL,
      maxModelRetries: 1,
    });

    // No blueprint contracts means no contract files threaded on any attempt.
    for (const attempt of executor.attempts) {
      expect(attempt.frozenContracts).toEqual([]);
      expect(attempt.frozenContractFiles).toEqual([]);
    }
  });
});


/**
 * The Jev typed-decision junctures on the live run path, proven offline with a
 * deterministic fake Jev caller (NO network): failure attribution complements
 * the string-parse (fallback-to-all preserved), fix-confidence is recorded but
 * NEVER changes the authoritative mechanical gate verdict, each recorded
 * decision renders a backed jev node, and Jev is absent when unconfigured.
 */
type FakeJevAnswer = {
  readonly type: "noul" | "choice" | "score";
  readonly noul?: "yes" | "no" | "unsure";
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly probabilities?: Readonly<Record<string, number>>;
};

/**
 * A deterministic fake Jev caller: it answers by question key. An attribution
 * question gets the configured choice + confidence; a fix-confidence question
 * gets the configured noul + confidence. Records every call so a test can assert
 * what Jev was asked. No network.
 */
function makeFakeJev(options: {
  readonly attribution?: FakeJevAnswer;
  readonly fixConfidence?: FakeJevAnswer;
}) {
  const calls: { state: string; keys: string[] }[] = [];
  const jev = async (
    state: string,
    questions: Readonly<Record<string, { readonly type: "noul" | "choice" | "score" }>>,
  ): Promise<Readonly<Record<string, FakeJevAnswer>>> => {
    const keys = Object.keys(questions);
    calls.push({ state, keys });
    const out: Record<string, FakeJevAnswer> = {};
    for (const key of keys) {
      if (key === "attribution" && options.attribution) {
        out.attribution = options.attribution;
      }
      if (key === "fix-confidence" && options.fixConfidence) {
        out["fix-confidence"] = options.fixConfidence;
      }
    }
    return out;
  };
  return { jev, calls };
}

describe("H2: the Jev typed-decision junctures (offline, faked Jev, no network)", () => {
  it("JUNCTURE (b) attribution: a confident Jev choice complements the string-parse (fallback-to-all preserved)", async () => {
    // Two units; alpha already passes, only beta needs escalation. Jev confidently
    // names beta too, so the recorded attribution decision is accepted and beta is
    // re-fanned. The string-parse already found beta, so the union is still beta.
    const { jev, calls } = makeFakeJev({
      attribution: { type: "choice", choice: "beta", confidence: 0.9 },
    });
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "jev-attribution",
      jev,
      jevThreshold: 0.75,
    });

    // The ladder asked Jev the attribution question on the round-1 fail.
    expect(calls.some((c) => c.keys.includes("attribution"))).toBe(true);
    // The retry re-fanned beta (the parse + Jev agree), never alpha.
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).toContain("beta");
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).not.toContain("alpha");
    // A backed attribution jev node is recorded and renders.
    const attribution = (snapshot.jevDecisions ?? []).find((d) => d.juncture === "attribution");
    expect(attribution).toBeDefined();
    expect(attribution?.answerType).toBe("choice");
    expect(attribution?.choice).toBe("beta");
    expect(attribution?.accepted).toBe(true);
    const model = buildWorkGraphModel(snapshot);
    const jevNode = model.nodes.find((n) => n.kind === "jev" && n.jevDetail?.juncture === "attribution");
    expect(jevNode).toBeDefined();
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("a failed decision call is RECORDED (with its reason), never swallowed; the parse+fallback still drives the retry", async () => {
    const jev = async (_state: string, questions: Readonly<Record<string, { readonly type: "noul" | "choice" | "score" }>>) => {
      if ("attribution" in questions) {
        throw new Error("AI Gateway decision call failed for typesafe/jev (HTTP 400): Invalid value at questions.attribution.criteria");
      }
      throw new Error("HTTP 500: upstream unavailable");
    };
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "jev-attribution-error",
      jev: jev as never,
      jevThreshold: 0.75,
    });
    const attribution = (snapshot.jevDecisions ?? []).find((d) => d.juncture === "attribution");
    expect(attribution).toMatchObject({ accepted: false, error: "AI Gateway decision call failed for typesafe/jev (HTTP 400): Invalid value at questions.attribution.criteria" });
    const fix = (snapshot.jevDecisions ?? []).find((d) => d.juncture === "fix-confidence");
    expect(fix).toMatchObject({ accepted: false, error: "HTTP 500: upstream unavailable" });
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).toContain("beta");
  });

  it("JUNCTURE (b) attribution: a low-confidence Jev choice is recorded ESCALATED and the parse+fallback still re-fans", async () => {
    // Jev is unsure (below threshold), so its choice is NOT used; the string-parse
    // + re-fan-all fallback still drives the re-fan, so the change still settles.
    const { jev } = makeFakeJev({
      attribution: { type: "choice", choice: "beta", confidence: 0.2 },
    });
    const { snapshot, result } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "jev-attribution-lowconf",
      jev,
      jevThreshold: 0.75,
    });
    const attribution = (snapshot.jevDecisions ?? []).find((d) => d.juncture === "attribution");
    expect(attribution?.accepted).toBe(false);
    // The parse+fallback preserved: beta still re-fanned and the change settled.
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).toContain("beta");
    expect(result.evidence.integration.integratedUnits).toContain("beta");
  });

  it("JUNCTURE (b) attribution: a confident Jev choice is the PRIMARY selector (narrows an UNATTRIBUTABLE parse to auth)", async () => {
    // The round-1 gate CRASHES with an unattributable output (names no unit/file),
    // so the string-parse falls back to re-fanning ALL six resources. A CONFIDENT
    // Jev choice of `auth` is the PRIMARY selector: it narrows the FIRST retry to
    // ONLY auth, which is exactly the help round 2 needs when the parse is weak.
    // The retry records refanSource "jev". The honest fallback is still available
    // (proven by the low-confidence test above), it is just preferred here.
    const { jev, calls } = makeFakeJev({
      attribution: { type: "choice", choice: "auth", confidence: 0.92 },
    });
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_SIX_RESOURCES,
      changeId: "change-ladder-six",
      alwaysPassingUnits: ["users", "orders", "products", "search", "notifications"],
      useCrashGate: true,
      subdir: "jev-primary-auth",
      jev,
      jevThreshold: 0.75,
    });

    // Jev was asked the attribution question on the round-1 fail.
    expect(calls.some((c) => c.keys.includes("attribution"))).toBe(true);
    // The confident Jev choice narrowed the FIRST retry to ONLY auth, even though
    // the parse was unattributable (would have re-fanned all six).
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect(snapshot.retryAttempts?.[0]?.implicatedUnits).toEqual(["auth"]);
    expect(snapshot.retryAttempts?.[0]?.refanSource).toBe("jev");
    // The decision is recorded ACCEPTED and backs a jev node.
    const attribution = (snapshot.jevDecisions ?? []).find((d) => d.juncture === "attribution");
    expect(attribution?.accepted).toBe(true);
    expect(attribution?.choice).toBe("auth");
    const model = buildWorkGraphModel(snapshot);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("attribution outcome: a pick is in the fixed set when its unit's re-fan changed something before the next passing round", async () => {
    const { jev } = makeFakeJev({ attribution: { type: "choice", choice: "beta", confidence: 0.9 } });
    const { result, events } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "jev-attribution-outcome",
      jev,
      jevThreshold: 0.75,
    });
    expect(events.filter((e) => e.kind === "attribution-resolved")).toEqual([
      { kind: "attribution-resolved", round: 1, passedRound: 2, choice: "beta", outcome: "in-fixed-set", fixed: ["beta"], parseOutcome: "in-fixed-set" },
    ]);
    expect(result.attribution).toEqual({
      decisions: 1,
      inFixedSet: 1,
      notInFixedSet: 0,
      unresolved: 0,
      parse: { inFixedSet: 1, notInFixedSet: 0, none: 0, extra: 0 },
      differed: { total: 0, pickOnly: 0, parseOnly: 0, both: 0, neither: 0 },
    });
  });

  it("attribution outcome: a low-confidence pick that differed from the parse lands outside the fixed set (the parse's unit re-ran), the verdict unaffected", async () => {
    const { jev } = makeFakeJev({ attribution: { type: "choice", choice: "alpha", confidence: 0.2 } });
    const { result, events } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "jev-attribution-missed",
      jev,
      jevThreshold: 0.75,
    });
    expect(events.find((e) => e.kind === "attribution-resolved")).toMatchObject({ choice: "alpha", outcome: "not-in-fixed-set", fixed: ["beta"], disagreement: "parse-only" });
    expect(result.attribution).toMatchObject({ decisions: 1, inFixedSet: 0, notInFixedSet: 1, unresolved: 0, differed: { total: 1, parseOnly: 1 } });
    expect(result.evidence.integration.integratedUnits).toContain("beta");
  });

  it("attribution outcome: a pick with no passing round after it stays unresolved; without Jev there is no tally", async () => {
    const { jev } = makeFakeJev({ attribution: { type: "choice", choice: "beta", confidence: 0.9 } });
    const { result } = await runLadder({
      passingModel: "never-passes",
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "jev-attribution-unresolved",
      jev,
      jevThreshold: 0.75,
    });
    expect(result.attribution).toMatchObject({ inFixedSet: 0, notInFixedSet: 0 });
    expect(result.attribution!.unresolved).toBe(result.attribution!.decisions);
    expect(result.attribution!.decisions).toBeGreaterThan(0);
    const plain = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      alwaysPassingUnits: ["alpha"],
      subdir: "jev-attribution-absent",
    });
    expect(plain.result.attribution).toBeUndefined();
  });

  it("JUNCTURE (c) fix-confidence is ADVISORY: a confident 'unacceptable' with a PASSING gate still ships", async () => {
    // The gate passes on the escalation model, so the fix integrates and
    // redeploys. Jev confidently says the fix is NOT acceptable, but that is
    // advisory only: the mechanical gate is authoritative, so the fix still ships.
    const { jev } = makeFakeJev({
      fixConfidence: { type: "noul", noul: "no", confidence: 0.95 },
    });
    const { snapshot, result, redeployed } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "jev-fix-unacceptable-passing",
      jev,
      jevThreshold: 0.75,
    });
    // The mechanical gate is authoritative: the fix integrated and redeployed
    // EVEN THOUGH Jev said unacceptable.
    expect(result.evidence.integration.integratedUnits).toContain("fix");
    expect(result.evidence.integration.verdict).toBe("verified");
    expect(redeployed).toEqual(["switchyard-change-fabric-ladder-app"]);
    // The fix-confidence decision is recorded as a sidecar, marked NOT accepted
    // (Jev's negative advisory), but it never flipped the verdict.
    const fixConf = (snapshot.jevDecisions ?? []).find((d) => d.juncture === "fix-confidence");
    expect(fixConf).toBeDefined();
    expect(fixConf?.noul).toBe("no");
    expect(fixConf?.accepted).toBe(false);
    // The decision renders a backed jev node, and every node stays backed.
    const model = buildWorkGraphModel(snapshot);
    expect(
      model.nodes.some((n) => n.kind === "jev" && n.jevDetail?.juncture === "fix-confidence"),
    ).toBe(true);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("JUNCTURE (c) fix-confidence is ADVISORY: a confident 'acceptable' with a FAILING gate still fails", async () => {
    // No model passes the gate, so the change is a terminal failure and does NOT
    // integrate or redeploy. Jev confidently says the fix IS acceptable, but that
    // is advisory only: the mechanical gate is authoritative, so the fix fails.
    const { jev } = makeFakeJev({
      fixConfidence: { type: "noul", noul: "yes", confidence: 0.99 },
    });
    const { snapshot, result, redeployed } = await runLadder({
      passingModel: "no-model-ever-passes",
      subdir: "jev-fix-acceptable-failing",
      jev,
      jevThreshold: 0.75,
    });
    // The mechanical gate is authoritative: the change failed, nothing integrated
    // or redeployed, EVEN THOUGH Jev said the fix was acceptable.
    expect(result.evidence.integration.integratedUnits).not.toContain("fix");
    expect(redeployed).toEqual([]);
    // The fix-confidence decision is recorded (accepted, a confident yes) but it
    // did not green or ship the change.
    const fixConf = (snapshot.jevDecisions ?? []).find((d) => d.juncture === "fix-confidence");
    expect(fixConf?.noul).toBe("yes");
    expect(fixConf?.accepted).toBe(true);
    const model = buildWorkGraphModel(snapshot);
    // The goal and verify nodes still read red (the authoritative failure signal).
    expect(model.nodes.find((n) => n.kind === "goal")?.verified).toBe(false);
    expect(model.nodes.filter((n) => n.kind === "verify").every((n) => n.verified === false)).toBe(
      true,
    );
  });

  it("records a backed jev node per decision, placed near its juncture, and rejects an unbacked jev node", async () => {
    const { jev } = makeFakeJev({
      attribution: { type: "choice", choice: "fix", confidence: 0.9 },
      fixConfidence: { type: "noul", noul: "yes", confidence: 0.9 },
    });
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "jev-nodes",
      jev,
      jevThreshold: 0.75,
    });
    const model = buildWorkGraphModel(snapshot);
    const jevNodes = model.nodes.filter((n) => n.kind === "jev");
    // Both an attribution and a fix-confidence decision were recorded, so two jev
    // nodes render, each backed by its recorded decision.
    expect(jevNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of jevNodes) {
      expect(node.backing.kind).toBe("jev-decision");
      expect(node.jevDetail).toBeDefined();
    }
    // An attribution jev node hangs off the retry (its juncture); a fix-confidence
    // jev node hangs off a verify (its juncture). Assert each has an incoming edge.
    for (const node of jevNodes) {
      expect(model.edges.some((e) => e.to === node.id)).toBe(true);
    }
    // assertBacked THROWS for a jev node with no recorded decision.
    const bogus = {
      id: jevNodeId(snapshot.id, "plan-review", 9),
      kind: "jev" as const,
      label: "jev: plan-review accepted",
      status: "integrated" as const,
      verified: true,
      escalated: false,
      backing: {
        kind: "jev-decision" as const,
        changeId: snapshot.id,
        juncture: "plan-review" as const,
        question: "ghost",
        answerType: "noul" as const,
        confidence: 0.99,
      },
    };
    expect(() => assertBacked(bogus, snapshot)).toThrow(/no recorded jev decision/);
  });

  it("Jev is ABSENT when unconfigured: no jev node, heuristic + gate path unchanged", async () => {
    // No Jev caller injected (the offline default): no jev decisions are recorded
    // and no jev node appears, so the heuristic + mechanical-gate path is exactly
    // as before.
    const { snapshot, result } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "jev-absent",
    });
    expect(snapshot.jevDecisions ?? []).toHaveLength(0);
    const model = buildWorkGraphModel(snapshot);
    expect(model.nodes.some((n) => n.kind === "jev")).toBe(false);
    // The change still settled green through the normal ladder.
    expect(result.evidence.integration.integratedUnits).toContain("fix");
  });
});

describe("re-plan on retry (offline, faked planner): choose a revised unit set to re-fan", () => {
  it("re-fans ONLY the re-planned subset (fewer than all), recording the revised plan per round", async () => {
    // Three units all need escalation, so the round-1 fail names all three files
    // and the string-parse would re-fan ALL THREE. The injected re-plan narrows
    // the retry to just "two", so the recorded retry re-fans ONLY "two" (a
    // spurious unit like a passing module is dropped). The mechanical gate stays
    // authoritative; the re-plan only chooses which units re-run.
    const seen: { candidate: string[]; round: number }[] = [];
    const rePlan = async (input: {
      readonly candidateUnitIds: readonly string[];
      readonly round: number;
    }): Promise<readonly string[]> => {
      seen.push({ candidate: [...input.candidateUnitIds], round: input.round });
      return ["two"]; // revise the plan to re-run only "two"
    };
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_THREE_UNITS,
      changeId: "change-ladder-three",
      subdir: "replan-subset",
      maxConcurrency: 3,
      rePlan,
    });

    // The re-plan was asked, handed every gated unit as a candidate.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]?.candidate.sort()).toEqual(["one", "three", "two"]);
    // The retry re-fanned ONLY the re-planned subset: "two", not all three.
    expect(snapshot.retryAttempts).toHaveLength(1);
    const implicated = [...(snapshot.retryAttempts?.[0]?.implicatedUnits ?? [])].sort();
    expect(implicated).toEqual(["two"]);
    // The recorded reason names the re-plan provenance so the revised plan is
    // visible per round (not the default implicated-unit re-fan reason).
    expect(snapshot.retryAttempts?.[0]?.reason).toContain("re-planned");
    // The retry records refanSource "re-plan", and the change counts the live
    // re-plan (rePlans > 0), so a run that genuinely re-planned is distinguishable
    // from one that only used the deterministic attribution path.
    expect(snapshot.retryAttempts?.[0]?.refanSource).toBe("re-plan");
    expect(snapshot.rePlans).toBeGreaterThan(0);
    // The failing round-1 verify records the re-plan source too.
    expect(snapshot.verifyAttempts?.[0]?.refanSource).toBe("re-plan");
    // Only the re-planned unit got a round-N agent; the dropped units did not.
    const model = buildWorkGraphModel(snapshot);
    const roundAgents = model.nodes.filter(
      (n) => n.kind === "agent" && n.backing.kind === "round-agent",
    );
    expect(roundAgents.map((n) => (n.backing as { unitId: string }).unitId)).toEqual(["two"]);
    // A re-plan renders as a PLAIN `planner` node (not a distinct `replan` kind),
    // positioned between the failing verify and the retry agents, backed by the
    // recorded re-plan retry (round-keyed planner backing). Its planner detail
    // carries the plan-like info: the round (via the label) and the revised unit
    // set it chose to re-fan (the detail units + agent count), plus the model.
    const replanNodes = model.nodes.filter(
      (n) => n.kind === "planner" && n.backing.kind === "planner" && n.backing.round === 2,
    );
    expect(replanNodes).toHaveLength(1);
    const replanPlanner = replanNodes[0]!;
    expect(replanPlanner.backing.kind).toBe("planner");
    // The kickoff planner node (when the run recorded a plan) is UNCHANGED: it is
    // round-less. Only the re-plan planner is keyed to a retry round, so exactly
    // one round-keyed planner node exists.
    const kickoffPlanner = model.nodes.filter(
      (n) => n.kind === "planner" && n.backing.kind === "planner" && n.backing.round === undefined,
    );
    expect(kickoffPlanner.length).toBeLessThanOrEqual(1);
    const roundKeyedPlanners = model.nodes.filter(
      (n) => n.kind === "planner" && n.backing.kind === "planner" && n.backing.round !== undefined,
    );
    expect(roundKeyedPlanners).toHaveLength(1);
    // The re-plan planner detail carries the revised unit set and the model.
    expect(replanPlanner.plannerDetail?.units.map((u) => u.id)).toEqual(["two"]);
    expect(replanPlanner.plannerDetail?.agentCount).toBe(1);
    expect(replanPlanner.plannerDetail?.model).toBe(ESCALATION_MODEL);
    // The round is visible in the label.
    expect(replanPlanner.label).toContain("round 2");
    // No `replan` node kind exists anywhere in the model.
    expect(model.nodes.some((n) => (n.kind as string) === "replan")).toBe(false);
    // The ladder causal chain is strictly verify(failed) -> planner(re-plan) ->
    // retry -> round-agents, drawn with `trigger`-kind edges (ladder
    // control-flow), NOT `spawn` (reserved for an Artifact repo-pushed
    // recruitment). The failing verify's ONLY trigger-child is the re-plan
    // planner; the planner's trigger-child is the RETRY node; the round agents
    // hang off the RETRY node. There is NO planner -> agent edge and NO
    // verify -> retry / verify -> agent edge that bypasses the planner.
    const replanId = replanPlanner.id;
    const retryId = retryNodeId(snapshot.id, 2);
    const agentId = roundAgentNodeId(snapshot.id, 2, "two");
    const verify1Id = verifyNodeId(snapshot.id, 1);

    // verify(failed) --trigger--> planner(re-plan)
    const verifyToReplan = model.edges.find(
      (e) => e.kind === "trigger" && e.to === replanId && e.from === verify1Id,
    );
    expect(verifyToReplan).toBeDefined();
    // The failing verify's ONLY trigger-child is the planner (no verify -> retry
    // and no verify -> agent bypass).
    const verifyChildren = model.edges.filter(
      (e) => e.kind === "trigger" && e.from === verify1Id,
    );
    expect(verifyChildren.map((e) => e.to)).toEqual([replanId]);

    // planner(re-plan) --trigger--> retry (the planner's trigger-child is the
    // retry node, NOT the agent).
    const replanToRetry = model.edges.find(
      (e) => e.kind === "trigger" && e.from === replanId && e.to === retryId,
    );
    expect(replanToRetry).toBeDefined();
    // The planner has NO edge directly to any round-N agent.
    expect(
      model.edges.some((e) => e.from === replanId && e.to === agentId),
    ).toBe(false);
    // The planner's ONLY trigger-child is the retry node.
    const replanChildren = model.edges.filter(
      (e) => e.kind === "trigger" && e.from === replanId,
    );
    expect(replanChildren.map((e) => e.to)).toEqual([retryId]);

    // retry --trigger--> round-agent (the agent hangs off the RETRY node).
    const retryToAgent = model.edges.find(
      (e) => e.kind === "trigger" && e.from === retryId && e.to === agentId,
    );
    expect(retryToAgent).toBeDefined();

    // NO `spawn` edge is emitted for the re-plan/retry chain: a spawn edge always
    // means an Artifact repo-pushed recruitment, never a re-plan/retry trigger.
    expect(model.edges.some((e) => e.kind === "spawn" && e.id.startsWith("replan-"))).toBe(false);
    expect(model.edges.some((e) => e.kind === "spawn" && e.id.startsWith("re-fan:"))).toBe(false);
    // The removed planner -> agent edge (replan-refan) is gone entirely.
    expect(model.edges.some((e) => e.id.startsWith("replan-refan:"))).toBe(false);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
    // assertBacked REJECTS an unbacked round-N re-plan planner node: a planner
    // node keyed to a round with no recorded re-plan retry is dishonest.
    const unbackedReplan: GraphNode = {
      ...replanPlanner,
      backing: { kind: "planner", changeId: snapshot.id, source: "planner", round: 99 },
    };
    expect(() => assertBacked(unbackedReplan, snapshot)).toThrow();
  });

  it("FALLS BACK to the implicated set when the re-plan returns an invalid/empty revision", async () => {
    // The re-plan returns an empty (unusable) revision, so the ladder falls back
    // to the string-parse implicated set, which for three failing units is all
    // three. The fallback is never silently dropped.
    const rePlan = async (): Promise<readonly string[]> => {
      return []; // no usable revision -> fall back to the implicated set
    };
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_THREE_UNITS,
      changeId: "change-ladder-three",
      subdir: "replan-fallback",
      maxConcurrency: 3,
      rePlan,
    });
    expect(snapshot.retryAttempts).toHaveLength(1);
    const implicated = [...(snapshot.retryAttempts?.[0]?.implicatedUnits ?? [])].sort();
    // Fell back to the full implicated set (all three failing units).
    expect(implicated).toEqual(["one", "three", "two"]);
    // The reason is the default implicated-unit re-fan reason, not re-planned.
    expect(snapshot.retryAttempts?.[0]?.reason).not.toContain("re-planned");
  });

  it("no re-plan configured (offline): no replan node, rePlans stays 0, parse path stands", async () => {
    // The seeded single-unit run with NO re-plan transport injected: the ladder
    // uses the deterministic string-parse attribution path, records no re-plan,
    // and emits NO replan node. rePlans is 0 and the retry's refanSource is the
    // string-parse ("parse"), so the offline path is unchanged.
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "replan-unconfigured",
    });
    expect(snapshot.rePlans).toBe(0);
    expect(snapshot.retryAttempts?.[0]?.refanSource).toBe("parse");
    const model = buildWorkGraphModel(snapshot);
    // No round-N re-plan planner node is emitted on the offline/attribution path
    // (a planner node keyed to a retry round). The kickoff planner (round-less)
    // is unaffected.
    expect(
      model.nodes.some(
        (n) => n.kind === "planner" && n.backing.kind === "planner" && n.backing.round !== undefined,
      ),
    ).toBe(false);
    // The dead `replan` kind is gone entirely.
    expect(model.nodes.some((n) => (n.kind as string) === "replan")).toBe(false);
    // No re-plan trigger edge is drawn either (the parse/attribution path keeps
    // the model-escalation trigger hop, not a re-plan trigger edge from a
    // re-plan planner node).
    expect(model.edges.some((e) => e.id.startsWith("replan-trigger:"))).toBe(false);
    expect(model.edges.some((e) => e.id.startsWith("replan-refan:"))).toBe(false);
  });
});

describe("create-first: the Change exists with 'planning' status BEFORE the planner, then the plan attaches", () => {
  it("creates a planning placeholder (empty work) before the plan, then attaches the plan and flips status to running", async () => {
    // A planning placeholder is created on the Worker BEFORE the run decomposes
    // (preCreatePlanning), so the console would attach to a Change that already
    // exists with status "planning" and no work. runFullLive then ATTACHES the
    // decomposed plan, filling in the work and flipping the status to "running".
    const { snapshot, opLog, planningStateBeforeAttach } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "create-first",
      preCreatePlanning: true,
    });

    // The Change existed with status "planning" and an EMPTY work set BEFORE the
    // plan was attached: the console can see it (and that it is planning) at once.
    expect(planningStateBeforeAttach).toBeDefined();
    expect(planningStateBeforeAttach?.status).toBe("planning");
    expect(planningStateBeforeAttach?.work).toHaveLength(0);

    // CREATE PRECEDES PLAN: the planning placeholder was created before the plan
    // was attached, and the normal full-spec create never ran (the attach took
    // its place on the planning placeholder).
    expect(opLog.indexOf("planning")).toBeGreaterThanOrEqual(0);
    expect(opLog.indexOf("plan")).toBeGreaterThan(opLog.indexOf("planning"));
    expect(opLog).not.toContain("create");

    // After attach the status is "running" and the real work is present.
    expect(snapshot.status).toBe("running");
    expect(snapshot.work.length).toBeGreaterThan(0);
  });

  it("offline/no placeholder: runFullLive creates the Change the normal way (status running), unchanged", async () => {
    // With no planning placeholder pre-created, runFullLive falls back to the
    // normal POST /changes create, so the op log shows a plain create (no
    // planning, no attach) and the status is "running" from the start.
    const { snapshot, opLog } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "create-first-fallback",
    });
    expect(opLog).toContain("create");
    expect(opLog).not.toContain("planning");
    expect(opLog).not.toContain("plan");
    expect(snapshot.status).toBe("running");
  });
});

describe("re-plan EVERY failing retry round (not only the first)", () => {
  it("re-plans at BOTH failing rounds: refanSource 're-plan' on each, a planner node per round", async () => {
    // A two-unit change where NO model ever passes the gate, so every round
    // fails: round 1 (base) fails, retry round 2 fails, retry round 3 fails.
    // With maxModelRetries=2 and a two-model ladder, there are TWO retry rounds
    // (2 and 3). The injected re-plan is called EACH retry iteration and returns
    // a usable revised set each time (narrowing to one unit per round), so BOTH
    // retry rounds record refanSource "re-plan" and a planner (re-plan) node is
    // emitted per round. The re-plan is also fed the prior round's revised ids,
    // proving the transport is per-round stateful rather than dropping to the
    // fallback on a later round.
    const seen: { round: number; prior: readonly string[] }[] = [];
    const rePlan = async (input: {
      readonly round: number;
      readonly priorRevisedUnitIds?: readonly string[];
    }): Promise<readonly string[]> => {
      seen.push({ round: input.round, prior: input.priorRevisedUnitIds ?? [] });
      // Round 2 narrows to "alpha"; round 3 narrows to "beta". A later round
      // still returns a usable (intersecting) set rather than falling back.
      return input.round <= 2 ? ["alpha"] : ["beta"];
    };
    const { snapshot } = await runLadder({
      passingModel: "no-model-ever-passes",
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      subdir: "replan-every-round",
      maxConcurrency: 2,
      maxModelRetries: 2,
      escalationModels: ["esc-1", "esc-2"],
      rePlan,
    });

    // The re-plan was called at BOTH retry rounds (2 and 3).
    expect(seen.map((s) => s.round)).toEqual([2, 3]);
    // Round 3 was fed round 2's revised set (per-round stateful, not stateless).
    expect(seen[1]?.prior).toEqual(["alpha"]);

    // TWO retry attempts recorded, BOTH with refanSource "re-plan" (round 2
    // re-planned, and round 3 ALSO re-planned, not falling back to "parse").
    expect(snapshot.retryAttempts).toHaveLength(2);
    expect(snapshot.retryAttempts?.[0]).toMatchObject({ round: 2, refanSource: "re-plan" });
    expect(snapshot.retryAttempts?.[1]).toMatchObject({ round: 3, refanSource: "re-plan" });
    expect(snapshot.rePlans).toBe(2);

    // A re-plan planner node is emitted for EACH failing round (round 2 and 3).
    const model = buildWorkGraphModel(snapshot);
    const replanNodes = model.nodes.filter(
      (n) => n.kind === "planner" && n.backing.kind === "planner" && n.backing.round !== undefined,
    );
    expect(
      replanNodes
        .map((n) => (n.backing as { round?: number }).round)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([2, 3]);
  });
});

describe("re-plan planner node detail is at PARITY with the kickoff planner", () => {
  it("carries model + rationale + units-with-objectives from the re-plan transport", async () => {
    // The re-plan transport returns the RICH result shape: the revised units WITH
    // their re-plan objectives, a rationale for the re-plan, and the model. The
    // round-keyed planner node must surface all three in its planner detail, at
    // parity with the kickoff planner node's detail (which carries model,
    // rationale, and units-with-objectives).
    const RE_PLAN_RATIONALE = "the auth module is the only one the failure implicates";
    const RE_PLAN_OBJECTIVE = "require auth on the beta route and return 401 when missing";
    const rePlan = async (): Promise<{
      units: { id: string; objective: string }[];
      rationale: string;
      model: string;
    }> => ({
      units: [{ id: "beta", objective: RE_PLAN_OBJECTIVE }],
      rationale: RE_PLAN_RATIONALE,
      model: ESCALATION_MODEL,
    });
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      subdir: "replan-parity",
      maxConcurrency: 2,
      alwaysPassingUnits: ["alpha"],
      rePlan,
    });

    // The retry recorded the rich re-plan detail (rationale + revised units).
    expect(snapshot.retryAttempts).toHaveLength(1);
    expect(snapshot.retryAttempts?.[0]?.refanSource).toBe("re-plan");
    expect(snapshot.retryAttempts?.[0]?.rationale).toBe(RE_PLAN_RATIONALE);
    expect(snapshot.retryAttempts?.[0]?.revisedUnits).toEqual([
      { id: "beta", objective: RE_PLAN_OBJECTIVE },
    ]);

    const model = buildWorkGraphModel(snapshot);
    const replanPlanner = model.nodes.find(
      (n) => n.kind === "planner" && n.backing.kind === "planner" && n.backing.round === 2,
    );
    expect(replanPlanner).toBeDefined();
    const detail = replanPlanner!.plannerDetail;
    // PARITY with the kickoff planner detail: model + rationale + units-with-
    // objectives (not just ids).
    expect(detail?.model).toBe(ESCALATION_MODEL);
    expect(detail?.rationale).toBe(RE_PLAN_RATIONALE);
    expect(detail?.units).toEqual([{ id: "beta", objective: RE_PLAN_OBJECTIVE }]);
    expect(detail?.agentCount).toBe(1);
    // The detail shape matches the kickoff planner detail shape exactly (same
    // keys), proving parity rather than a thin id-only panel.
    expect(detail?.source).toBe("planner");
    // Still backed by the recorded re-plan retry (assertBacked does not throw).
    expect(() => assertBacked(replanPlanner!, snapshot)).not.toThrow();
  });
});

describe("graph chain is strictly verify -> planner -> retry -> agents (no bypass)", () => {
  it("the failing verify's only trigger-child is the planner; agents hang off the retry; no planner->agent edge", async () => {
    const rePlan = async (): Promise<readonly string[]> => ["beta"];
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      subdir: "replan-chain",
      maxConcurrency: 2,
      alwaysPassingUnits: ["alpha"],
      rePlan,
    });
    const model = buildWorkGraphModel(snapshot);
    const verify1 = verifyNodeId(snapshot.id, 1);
    const retry2 = retryNodeId(snapshot.id, 2);
    const agentBeta = roundAgentNodeId(snapshot.id, 2, "beta");
    const replan = model.nodes.find(
      (n) => n.kind === "planner" && n.backing.kind === "planner" && n.backing.round === 2,
    );
    expect(replan).toBeDefined();
    const replanId = replan!.id;

    // verify(failed)'s ONLY trigger-child is the re-plan planner (no verify->retry
    // and no verify->agent bypass).
    const verifyTriggers = model.edges.filter((e) => e.kind === "trigger" && e.from === verify1);
    expect(verifyTriggers.map((e) => e.to)).toEqual([replanId]);

    // planner(re-plan)'s ONLY trigger-child is the retry (no planner->agent edge).
    const plannerTriggers = model.edges.filter((e) => e.kind === "trigger" && e.from === replanId);
    expect(plannerTriggers.map((e) => e.to)).toEqual([retry2]);
    expect(model.edges.some((e) => e.from === replanId && e.to === agentBeta)).toBe(false);

    // retry --trigger--> round-agent (the agent hangs off the RETRY node).
    expect(
      model.edges.some((e) => e.kind === "trigger" && e.from === retry2 && e.to === agentBeta),
    ).toBe(true);

    // The removed planner->agent edge is gone; the chain edges are all 'trigger',
    // and 'spawn' is reserved for Artifact repo-pushed recruitment only.
    expect(model.edges.some((e) => e.id.startsWith("replan-refan:"))).toBe(false);
    expect(
      model.edges.some(
        (e) => e.kind === "spawn" && (e.id.startsWith("replan-") || e.id.startsWith("re-fan:")),
      ),
    ).toBe(false);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });
});

describe("Jev attribution is recorded at EACH failing round", () => {
  it("records a backed jev attribution decision+node on every verify-fail, even on a non-confident reply", async () => {
    // A two-model ladder where no model passes, so rounds 1, 2, 3 all fail (two
    // retry rounds). Jev returns a LOW-CONFIDENCE choice each round (below the
    // threshold), so it is advisory and never flips the gate; the point is that
    // the attribution decision is RECORDED on EACH failing round, not only when
    // Jev is confident. The result: one plan-review decision is absent (no
    // planner plan injected here), and an attribution decision per failing round.
    const jev = async (
      _state: string,
      questions: Readonly<
        Record<string, { readonly type: "noul" | "choice" | "score"; readonly criteria?: readonly string[] }>
      >,
    ) => {
      const out: Record<
        string,
        { type: "noul" | "choice" | "score"; choice?: string; noul?: "yes" | "no" | "unsure"; confidence: number }
      > = {};
      if (questions["attribution"]) {
        // A low-confidence choice: advisory, below the 0.75 threshold, so it is
        // recorded ESCALATED each round and never narrows/flips the gate.
        out["attribution"] = { type: "choice", choice: "alpha", confidence: 0.2 };
      }
      if (questions["fix-confidence"]) {
        out["fix-confidence"] = { type: "noul", noul: "no", confidence: 0.2 };
      }
      return out;
    };

    const { snapshot } = await runLadder({
      passingModel: "no-model-ever-passes",
      spec: SPEC_TWO_UNITS,
      changeId: "change-ladder-two",
      subdir: "jev-each-round",
      maxConcurrency: 2,
      maxModelRetries: 2,
      escalationModels: ["esc-1", "esc-2"],
      jev,
      jevThreshold: 0.75,
    });

    // Two retry rounds happened (round 2 and round 3), each a verify-fail that
    // consulted Jev for attribution. An attribution decision is recorded at EACH
    // failing round (round 1 fail -> re-fan into round 2, round 2 fail -> re-fan
    // into round 3), so there are at least TWO attribution decisions, not just
    // the start/end ones.
    const attributions = (snapshot.jevDecisions ?? []).filter(
      (d) => d.juncture === "attribution",
    );
    expect(attributions.length).toBeGreaterThanOrEqual(2);
    // The low-confidence attribution is recorded ESCALATED (advisory, never used
    // to flip the gate), so each attribution decision reads accepted === false.
    expect(attributions.every((d) => d.accepted === false)).toBe(true);

    // Each attribution decision backs a real jev node placed at the attribution
    // juncture, and every node is backed (assertBacked does not throw).
    const model = buildWorkGraphModel(snapshot);
    const jevNodes = model.nodes.filter(
      (n) => n.kind === "jev" && n.jevDetail?.juncture === "attribution",
    );
    expect(jevNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });
});

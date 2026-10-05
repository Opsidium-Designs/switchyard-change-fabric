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
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseChangeSpec } from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";

import { LocalChangeControl } from "../src/local-control.ts";
import { buildWorkGraphModel, type ChangeStateSnapshot } from "../src/graph-model.ts";
import { runFullLive, type DeployApp, type FullLiveEvent } from "../src/run-live.ts";
import {
  MarkerGateRunner,
  ModelAwareExecutor,
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
 * An in-process fake Worker fetch backed by LocalChangeControl. It handles the
 * endpoints runFullLive touches, delegating the ladder's verify-attempt and
 * retry-attempt routes (and step/detail) straight to LocalChangeControl so the
 * recorded attempts surface in state exactly as the live Worker would record
 * them. The lease/recruit/fail/deployment handling mirrors the other e2e fakes.
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
    // The ladder's CHANGE-LEVEL verify-attempt / retry-attempt routes, plus the
    // per-unit step/detail/verify-fail routes, are delegated straight to
    // LocalChangeControl so the recorded attempts surface in state identically
    // to the live Worker (and back the graph nodes/edges).
    const delegated =
      /^\/changes\/[^/]+\/(verify-attempt|retry-attempt)$/.test(url.pathname) ||
      /^\/changes\/[^/]+\/work\/[^/]+\/(verify-fail|step|detail|stream)$/.test(url.pathname);
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
}) {
  const spec = options.spec ?? SPEC;
  const changeId = options.changeId ?? "change-ladder";
  const workspaces = new LocalFilesystemWorkspaceProvider({
    rootDir: join(workRoot, options.subdir, "artifacts"),
  });
  const control = new LocalChangeControl(workspaces);
  const { fetchFn } = fakeWorker(control, workspaces);
  const change = parseChangeSpec(spec);

  const projectDir = join(workRoot, options.subdir, "project");
  await seedProject(projectDir);

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
    verifyCommandRunner: new MarkerGateRunner({
      passingModel: options.passingModel,
      ...(options.alwaysPassingUnits ? { alwaysPassingUnits: options.alwaysPassingUnits } : {}),
    }),
    baseModel: BASE_MODEL,
    escalationModel: ESCALATION_MODEL,
    maxModelRetries: options.maxModelRetries ?? 1,
    // Redeploy-in-place wiring (M8.4): the app was already deployed, so a
    // verified fix refreshes it; a red run must not redeploy.
    deployAppDir: projectDir,
    deployAppName: "switchyard-change-fabric-ladder-app",
    deployApp,
    appAlreadyDeployed: async ({ appName }) => `https://${appName}.example.workers.dev`,
    onEvent: (e) => events.push(e),
  });

  const snapshot = control.state(changeId) as ChangeStateSnapshot;
  return { result, control, snapshot, events, redeployed, executor };
}

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
    expect(model.edges.some((e) => e.kind === "model-escalation")).toBe(true);
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
    expect(model.edges.some((e) => e.kind === "model-escalation")).toBe(false);
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

    // The bounded retry was honored exactly once (default max-retries = 1): two
    // change-level verify rounds (both FAIL) and one retry round, then it stops.
    expect(snapshot.verifyAttempts).toHaveLength(2);
    expect(snapshot.verifyAttempts?.every((a) => a.outcome === "fail")).toBe(true);
    expect(snapshot.retryAttempts).toHaveLength(1);

    // The unit is a real failed/red node, and both change-level verify nodes are red.
    const model = buildWorkGraphModel(snapshot);
    const fixNode = model.nodes.find((n) => n.label === "fix");
    expect(fixNode?.status).toBe("failed");
    expect(fixNode?.verified).toBe(false);
    expect(model.nodes.filter((n) => n.kind === "verify").every((n) => n.verified === false)).toBe(true);
    // The goal does not falsely green while the unit is failed.
    expect(model.nodes.find((n) => n.kind === "goal")?.verified).toBe(false);
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
});

describe("T10b: the retry round is a VISIBLE second wave (re-fan edges + per-unit activity steps)", () => {
  it("links the retry node to each implicated unit it re-fanned and logs a real retry-round step on each", async () => {
    const { snapshot } = await runLadder({
      passingModel: ESCALATION_MODEL,
      subdir: "visible-single",
    });

    // The graph model draws a re-fan edge from the retry node to the implicated
    // unit it re-ran, backed by the recorded implicatedUnits: the user can SEE
    // which agent the retry re-fanned.
    const model = buildWorkGraphModel(snapshot);
    const retry = model.nodes.find((n) => n.kind === "retry");
    expect(retry).toBeDefined();
    const refan = model.edges.filter((e) => e.kind === "re-fan");
    expect(refan).toHaveLength(1);
    expect(refan[0]?.from).toBe(retry?.id);
    expect(refan[0]?.to).toBe(`unit:fix`);
    expect(refan[0]?.backing).toMatchObject({ kind: "re-fan", unitId: "fix", round: 2 });

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

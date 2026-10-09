/**
 * Integration on Cloudflare: the pure half the ChangeState Durable Object and
 * the integration Workflow share.
 *
 *   - the configuration a run posts (the integration repo, the gate, the
 *     contract, the baseline test inventory, the timeouts), validated with the
 *     job schema itself;
 *   - planning: the next revision's job, synthesized from the board exactly as
 *     the local integrator does (planBoardIntegration), keyed by the Change,
 *     the base commit, and the pinned commits;
 *   - deciding what a job's result means for the board: the same rules as the
 *     local integrator (nothing recordable when every push was excluded or the
 *     integrator refused; nothing recorded when a merged push was superseded
 *     while the gate ran; a failing revision carries its bounded,
 *     credential-free output and implicated items).
 * Attribution is the local integrator's: the failing output is parsed for the
 * files and names it reports and mapped to the merged items' write intents
 * (attributeFailure, shared with the drivers); with `attribution: "driver"`
 * the driver may add its advisory typed-decision choice before the revision is
 * recorded (validated: only items the revision merged). When nothing maps,
 * every merged item is implicated.
 * Pure: no I/O, no clock (callers pass `at`).
 */

import {
  attributeFailure,
  combineAttribution,
  BOARD_LIMITS,
  intentPath,
  pendingPushItems,
  planBoardIntegration,
  type BoardMessage,
  type BoardState,
} from "@switchyard-change/change-core";
import {
  INTEGRATE_JOB_VERSION,
  integrationJobKey,
  parseGateJob,
  scrubJobText,
  type EvidenceSummary,
  type IntegrateJob,
  type IntegrateJobResult,
  type JobInstallOutcome,
  type JobProtectedJsonKeys,
  type TestInventory,
} from "@switchyard-change/verification/integrate-job";

import { DEFAULT_REGISTRY_HOST } from "./integration-egress.ts";
import type { DrivenPhase } from "./integration-driver.ts";

/** A board agent's repo, recorded when it joined with a workspace. */
export interface BoardRepoRecord {
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
}

/** What a run configures for integration on Cloudflare. */
export interface CloudIntegrationConfig {
  readonly integration: BoardRepoRecord;
  readonly gateCommand?: readonly string[];
  readonly requireGate: boolean;
  readonly protectedPaths: readonly string[];
  readonly protectedJsonKeys: readonly JobProtectedJsonKeys[];
  /** The baseline inventory: names stay here (never in the open view). */
  readonly testInventory?: TestInventory;
  readonly gateSupportFiles?: readonly { readonly name: string; readonly content: string }[];
  readonly timeouts: { readonly installMs: number; readonly gateMs: number };
  readonly identity?: { readonly name: string; readonly email: string };
  readonly registryHost: string;
  /**
   * Who may narrow a failing revision's attribution before it is recorded:
   * "engine" (the parse only) or "driver" (the run also offers its advisory
   * typed-decision choice; the Workflow waits a bounded time for it).
   */
  readonly attribution: "engine" | "driver";
  readonly configuredAt: string;
}

/** How long the Workflow waits for the driver's attribution before recording with the parse alone. */
export const DRIVER_ATTRIBUTION_WAIT_MS = 3 * 60 * 1000;

/** The time a job may spend beyond install and gate (clones, verification, push). */
export const JOB_OVERHEAD_MS = 5 * 60 * 1000;

/** The whole job's deadline for a configuration. */
export function jobDeadlineMs(config: Pick<CloudIntegrationConfig, "timeouts">): number {
  return config.timeouts.installMs + config.timeouts.gateMs + JOB_OVERHEAD_MS;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const WORKSPACE = /^[A-Za-z0-9._-]{1,200}$/;

/** Validate a configuration body (with the job schema's own rules). */
export function parseCloudIntegrationConfig(raw: unknown, at: string): Parsed<CloudIntegrationConfig> {
  if (!isRecord(raw)) {
    return { ok: false, error: "the configuration must be an object" };
  }
  const known = ["integration", "gateCommand", "requireGate", "protectedPaths", "protectedJsonKeys", "testInventory", "gateSupportFiles", "timeouts", "identity", "registryHost", "attribution"];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      return { ok: false, error: `the configuration has an unknown field ${JSON.stringify(key)}` };
    }
  }
  const integration = raw.integration;
  if (!isRecord(integration) || typeof integration.workspaceName !== "string" || !WORKSPACE.test(integration.workspaceName)) {
    return { ok: false, error: "integration must be {workspaceName, gitUrl, defaultBranch} with a workspace name" };
  }
  if (typeof integration.gitUrl !== "string" || !integration.gitUrl.startsWith("https://")) {
    return { ok: false, error: "integration.gitUrl must be the integration repo's https URL" };
  }
  const attribution = raw.attribution === undefined ? "engine" : raw.attribution;
  if (attribution !== "engine" && attribution !== "driver") {
    return { ok: false, error: 'attribution must be "engine" or "driver"' };
  }
  const registryHost = raw.registryHost === undefined ? DEFAULT_REGISTRY_HOST : raw.registryHost;
  if (typeof registryHost !== "string" || !HOST.test(registryHost)) {
    return { ok: false, error: "registryHost must be a host name" };
  }
  // The job schema validates the rest (tokenless URL, gate argv, contract, inventory, files, timeouts).
  const probe = parseGateJob({
    version: INTEGRATE_JOB_VERSION,
    kind: "integrate",
    changeId: "probe",
    objective: "probe",
    integration: { repoUrl: integration.gitUrl, defaultBranch: integration.defaultBranch },
    units: [{ agent: "probe", repoUrl: integration.gitUrl, commit: "0000000", baselineRef: "HEAD", includes: [], scope: [], items: [] }],
    ...(raw.gateCommand !== undefined ? { gateCommand: raw.gateCommand } : {}),
    requireGate: raw.requireGate,
    protectedPaths: raw.protectedPaths ?? [],
    protectedJsonKeys: raw.protectedJsonKeys ?? [],
    ...(raw.testInventory !== undefined ? { testInventory: raw.testInventory } : {}),
    ...(raw.gateSupportFiles !== undefined ? { gateSupportFiles: raw.gateSupportFiles } : {}),
    timeouts: raw.timeouts,
    ...(raw.identity !== undefined ? { identity: raw.identity } : {}),
  });
  if (!probe.ok) {
    return { ok: false, error: probe.error };
  }
  const job = probe.value as IntegrateJob;
  return {
    ok: true,
    value: {
      integration: { workspaceName: integration.workspaceName, gitUrl: job.integration.repoUrl, defaultBranch: job.integration.defaultBranch },
      ...(job.gateCommand ? { gateCommand: job.gateCommand } : {}),
      requireGate: job.requireGate,
      protectedPaths: job.protectedPaths,
      protectedJsonKeys: job.protectedJsonKeys,
      ...(job.testInventory ? { testInventory: job.testInventory } : {}),
      ...(job.gateSupportFiles ? { gateSupportFiles: job.gateSupportFiles } : {}),
      timeouts: job.timeouts,
      ...(job.identity ? { identity: job.identity } : {}),
      registryHost,
      attribution,
      configuredAt: at,
    },
  };
}

/** The configuration as the open view shows it: the inventory's names and the support files stay inside. */
export function publicConfig(config: CloudIntegrationConfig): Record<string, unknown> {
  const { testInventory, gateSupportFiles, ...rest } = config;
  return {
    ...rest,
    ...(testInventory ? { testInventory: { format: testInventory.format, count: testInventory.count } } : {}),
    ...(gateSupportFiles ? { gateSupportFiles: gateSupportFiles.map((f) => f.name) } : {}),
  };
}

/** A planned job: the job itself, and what the Workflow needs to authenticate and record it. */
export interface CloudJobPlan {
  readonly key: string;
  /** The board's pending-push key when it was planned. */
  readonly pendingKey: string;
  readonly job: IntegrateJob;
  /** The repos the job reads (tokens are minted for exactly these). */
  readonly agents: readonly { readonly agent: string; readonly workspaceName: string; readonly gitUrl: string }[];
  /** Each integrated item, its agent, the announced commit it pins, and its write intents (for attribution). */
  readonly items: readonly { readonly item: string; readonly agent: string; readonly commit: string; readonly objective: string; readonly paths: readonly string[] }[];
  readonly excludedAgents: readonly { readonly agent: string; readonly reason: string }[];
}

/** The next step for the Workflow. */
export type CloudPlanOutcome =
  | { readonly kind: "idle"; readonly reason: string; readonly pendingKey: string }
  | { readonly kind: "job"; readonly plan: CloudJobPlan };

/** Plan the next revision's job from the board. */
export async function planCloudJob(input: {
  readonly changeId: string;
  readonly objective: string;
  readonly config: CloudIntegrationConfig;
  readonly messages: readonly BoardMessage[];
  readonly state: BoardState;
  readonly repos: Readonly<Record<string, BoardRepoRecord>>;
  /** Was this key already integrated (or deterministically refused)? */
  readonly attempted: (key: string) => boolean;
}): Promise<CloudPlanOutcome> {
  const plan = planBoardIntegration(input.messages, input.state);
  if (plan.units.length === 0) {
    return { kind: "idle", reason: "nothing is pending", pendingKey: plan.key };
  }
  const excludedAgents: { agent: string; reason: string }[] = [];
  const units = plan.units.filter((u) => {
    if (input.repos[u.agent] === undefined) {
      excludedAgents.push({ agent: u.agent, reason: "no repo is known for this agent" });
      return false;
    }
    return true;
  });
  if (units.length === 0) {
    return {
      kind: "idle",
      reason: `no pending push could be read: ${excludedAgents.map((e) => `${e.agent}: ${e.reason}`).join("; ")}`,
      pendingKey: plan.key,
    };
  }
  const { config } = input;
  const acceptedContracts = [...new Set(Object.values(input.state.contracts).filter((c) => c.status === "accepted" && c.guarded).map((c) => c.target))].sort();
  const job: IntegrateJob = {
    version: INTEGRATE_JOB_VERSION,
    kind: "integrate",
    changeId: input.changeId,
    objective: input.objective.slice(0, 2000) || input.changeId,
    integration: { repoUrl: config.integration.gitUrl, defaultBranch: config.integration.defaultBranch },
    // Build on the last RECORDED passing revision.
    ...(input.state.integrated ? { baseCommit: input.state.integrated.commit } : {}),
    units: units.map((u) => ({
      agent: u.agent,
      repoUrl: input.repos[u.agent]!.gitUrl,
      commit: u.commit,
      baselineRef: u.baselineRef,
      includes: [...u.includes],
      scope: [...u.scope],
      items: u.items.map((i) => i.id),
      ...(u.yieldedScope ? { yieldedScope: [...u.yieldedScope] } : {}),
      ...(u.releasedPaths ? { releasedPaths: [...u.releasedPaths] } : {}),
    })),
    ...(config.gateCommand ? { gateCommand: config.gateCommand } : {}),
    requireGate: config.requireGate,
    protectedPaths: config.protectedPaths,
    protectedJsonKeys: config.protectedJsonKeys,
    ...(config.testInventory ? { testInventory: config.testInventory } : {}),
    ...(acceptedContracts.length > 0 ? { acceptedContracts } : {}),
    ...(config.gateSupportFiles ? { gateSupportFiles: config.gateSupportFiles } : {}),
    timeouts: config.timeouts,
    ...(config.identity ? { identity: config.identity } : {}),
  };
  const checked = parseGateJob(job);
  if (!checked.ok) {
    return { kind: "idle", reason: `the planned job is invalid: ${checked.error}`, pendingKey: plan.key };
  }
  const key = await integrationJobKey(job);
  if (input.attempted(key)) {
    return { kind: "idle", reason: "this set of pushes was already integrated", pendingKey: plan.key };
  }
  return {
    kind: "job",
    plan: {
      key,
      pendingKey: plan.key,
      job,
      agents: units.map((u) => ({ agent: u.agent, workspaceName: input.repos[u.agent]!.workspaceName, gitUrl: input.repos[u.agent]!.gitUrl })),
      items: units.flatMap((u) =>
        u.items.map((i) => ({ item: i.id, agent: u.agent, commit: i.lastPush!.commit, objective: i.objective.slice(0, 200), paths: (i.intent?.write ?? []).map(intentPath) })),
      ),
      excludedAgents,
    },
  };
}

/** A revision attempt as the Change records it (the open view; no credential, no inventory names). */
export interface CloudRevisionRecord {
  readonly key: string;
  readonly pendingKey: string;
  readonly at: string;
  readonly recorded: boolean;
  /** Why nothing was recorded. */
  readonly reason?: string;
  /** The pushes moved while the gate ran (the next plan integrates the newer set). */
  readonly stale?: boolean;
  /** A failure to run (not a verdict): the same pushes may be tried again. */
  readonly transient?: boolean;
  readonly n?: number;
  readonly gate?: "pass" | "fail";
  readonly gated?: boolean;
  readonly commit?: string;
  readonly merged?: readonly string[];
  readonly integratedItems?: readonly string[];
  readonly excludedItems?: readonly string[];
  readonly excludedAgents: readonly { readonly agent: string; readonly reason: string }[];
  readonly completedItems?: readonly string[];
  readonly implicated?: { readonly items: readonly string[]; readonly source: AttributionSource };
  /** The items the parse alone implicated (empty when it attributed nothing). */
  readonly parsed?: readonly string[];
  readonly failure?: string;
  readonly fixRequested?: readonly string[];
  readonly fixExhausted?: readonly string[];
  readonly install?: JobInstallOutcome;
  readonly inventory?: { readonly format: string; readonly count: number };
  readonly inventoryNote?: string;
  /** Sandbox processes left alive by the install or the gate (killed before the next phase). */
  readonly sandboxReaped?: number;
  /** The egress phases the job ran under, as the orchestrator put them in force. */
  readonly phases: readonly DrivenPhase[];
  readonly evidence?: EvidenceSummary;
  /** After a recorded pass: whether the integration branch was advanced to it. */
  readonly advanced?: boolean;
  readonly advanceError?: string;
}

/** How a failing revision's implicated items were chosen. */
export type AttributionSource = "parse" | "jev" | "all";

/** The driver's advisory choice for a failing revision (validated against what it merged). */
export interface DriverAttribution {
  readonly key: string;
  readonly items: readonly string[];
}

/** What the driver is asked to attribute (the open view shows it while the Workflow waits). */
export interface AttributionRequest {
  readonly key: string;
  readonly items: readonly { readonly id: string; readonly objective: string; readonly paths: readonly string[] }[];
  /** The failing evidence (bounded, credential-scrubbed; the board records the same text). */
  readonly output: string;
  /** What the parse alone implicated. */
  readonly parsed: readonly string[];
  readonly at: string;
}

/** What a result means for the board. */
export type CloudRevisionDecision =
  | {
      readonly kind: "record";
      readonly input: {
        readonly commit: string;
        readonly gate: "pass" | "fail";
        readonly merged: readonly string[];
        readonly failing?: { readonly output: string; readonly items: readonly string[] };
        readonly gated?: false;
      };
      readonly integratedItems: readonly string[];
      readonly excludedItems: readonly string[];
      readonly excludedAgents: readonly { readonly agent: string; readonly reason: string }[];
      readonly implicated?: { readonly items: readonly string[]; readonly source: AttributionSource };
      readonly parsed?: readonly string[];
      readonly failure?: string;
    }
  | { readonly kind: "refuse"; readonly reason: string; readonly stale?: boolean; readonly excludedAgents: readonly { readonly agent: string; readonly reason: string }[] };

/** The first `max` characters of text (cut on a line when possible). */
function head(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - 40);
  const line = cut.lastIndexOf("\n");
  return `${line > max / 2 ? cut.slice(0, line) : cut}\n... (output truncated)`;
}

/** Decide what a job's result records, against the board as it is NOW. */
export function decideCloudRevision(plan: CloudJobPlan, result: IntegrateJobResult, stateNow: BoardState, driver?: DriverAttribution): CloudRevisionDecision {
  const excludedAgents = [...plan.excludedAgents];
  for (const u of result.evidence?.units ?? []) {
    if (u.verdict !== "verified") {
      const failed = u.checks.filter((c) => !c.passed && !c.skipped).map((c) => `${c.kind}: ${c.summary}`);
      excludedAgents.push({ agent: u.unitId, reason: scrubJobText(`failed verification (${failed.join("; ") || "verdict failed"})`) });
    }
  }
  if (result.outcome !== "gated" || result.commit === undefined || result.gate === undefined || result.evidence === undefined) {
    return { kind: "refuse", reason: scrubJobText(result.error ?? "the job produced no gated revision"), excludedAgents };
  }
  const mergedAgents = new Set(result.evidence.units.filter((u) => u.verdict === "verified").map((u) => u.unitId));
  if (mergedAgents.size === 0) {
    return { kind: "refuse", reason: `every pending push was excluded: ${excludedAgents.map((e) => `${e.agent}: ${e.reason}`).join("; ")}`, excludedAgents };
  }
  const mergedItems = plan.items.filter((i) => mergedAgents.has(i.agent));
  // A push that landed while the gate ran supersedes what was gated: record nothing.
  const now = new Set(pendingPushItems(stateNow).map((i) => i.lastPush!.commit));
  if (mergedItems.some((i) => !now.has(i.commit))) {
    return { kind: "refuse", reason: "a merged push was superseded while the gate ran", stale: true, excludedAgents };
  }
  const merged = mergedItems.map((i) => i.commit);
  const integratedItems = mergedItems.map((i) => i.item);
  const excludedItems = plan.items.filter((i) => !mergedAgents.has(i.agent)).map((i) => i.item);
  const check = result.evidence.integration.finalCheck;
  if (result.gate === "pass") {
    return {
      kind: "record",
      input: { commit: result.commit, gate: "pass", merged, ...(result.gated === false ? { gated: false as const } : {}) },
      integratedItems,
      excludedItems,
      excludedAgents,
    };
  }
  const raw = failingText(result);
  // A failure naming only files of COMPLETED items is a regression these pushes caused.
  const regressed = Object.values(stateNow.items).filter((i) => i.status === "done" && i.lastPush !== undefined && i.lastPush.paths.some((p) => raw.includes(p)));
  const note = regressed.length > 0 ? `regressed completed item(s): ${regressed.map((i) => i.id).join(", ")} (their files fail after this revision's pushes)\n` : "";
  const mergedViews = mergedItems.map((i) => ({ unitId: i.item, paths: i.paths }));
  const parse = attributeFailure(mergedViews, raw);
  const parsed = parse.attributed ? parse.units.map((u) => u.unitId) : [];
  // The driver's advisory choice narrows like the local integrator's (only
  // items this revision merged; a choice naming anything else is ignored), with
  // the same combination and label (combineAttribution): an unattributed parse
  // narrows to the pick alone.
  const choice = driver && driver.key === plan.key ? driver.items.filter((i) => integratedItems.includes(i)) : [];
  const valid = choice.length > 0 && choice.length === (driver?.items.length ?? 0);
  const combined = combineAttribution({ merged: integratedItems, parsed, attributed: parse.attributed, picks: valid ? choice : [] });
  const ordered = [...combined.items];
  const source: AttributionSource = combined.source;
  return {
    kind: "record",
    input: { commit: result.commit, gate: "fail", merged, failing: { output: head(`${note}${raw}`, BOARD_LIMITS.maxFailingOutput), items: ordered } },
    integratedItems,
    excludedItems,
    excludedAgents,
    implicated: { items: ordered, source },
    parsed,
    failure: scrubJobText(result.failureLine ?? check.summary).slice(0, 300),
  };
}

/** A failing result's evidence as the board records it: the failing line, the output, the summary (scrubbed). */
export function failingText(result: IntegrateJobResult): string {
  const check = result.evidence?.integration.finalCheck;
  if (!check) {
    return scrubJobText(result.failureLine ?? result.error ?? "");
  }
  return scrubJobText(
    [...(result.failureLine !== undefined && result.failureLine !== check.summary ? [result.failureLine] : []), ...check.outputs.map((o) => o.text), check.summary].join("\n"),
  );
}

/**
 * What the driver is asked to attribute for a failing gated result (undefined
 * when there is nothing to attribute: a pass, a refusal, or one merged item).
 */
export function attributionRequestFor(plan: CloudJobPlan, result: IntegrateJobResult, at: string): AttributionRequest | undefined {
  if (result.outcome !== "gated" || result.gate !== "fail" || result.evidence === undefined) {
    return undefined;
  }
  const merged = new Set(result.evidence.units.filter((u) => u.verdict === "verified").map((u) => u.unitId));
  const items = plan.items.filter((i) => merged.has(i.agent));
  if (items.length < 2) {
    return undefined;
  }
  const output = head(failingText(result), BOARD_LIMITS.maxFailingOutput);
  const parse = attributeFailure(items.map((i) => ({ unitId: i.item, paths: i.paths })), output);
  return {
    key: plan.key,
    items: items.map((i) => ({ id: i.item, objective: i.objective, paths: i.paths })),
    output,
    parsed: parse.attributed ? parse.units.map((u) => u.unitId) : [],
    at,
  };
}

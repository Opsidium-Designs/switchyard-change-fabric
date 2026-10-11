/**
 * The integration JOB: the serialized input and result of one integrated
 * revision built outside the driver (in the gate container on Cloudflare), and
 * the line protocol between the container's CLI and the Durable Object that
 * owns the container.
 *
 * A job carries everything the integrator needs and nothing secret: every
 * repository URL is tokenless (the container never sees a credential; the
 * Durable Object's egress handler adds the Authorization header to requests
 * for the repositories the job names). The result carries the gated commit,
 * the verdict, the bounded evidence, the install outcome, and the egress
 * phases the job ran under.
 *
 * Protocol (one JSON value per line):
 *   stdin  line 1:      the job
 *   stdout "@@scf phase <phase>": the CLI asks for the next egress phase and
 *                       waits for stdin "ack <phase>" (the orchestrator moves
 *                       the egress policy first)
 *   stdout "@@scf result <json>": the result, last
 * Phases run strictly forward: fetch (the Artifacts host), deps (the package
 * registry only), gate (nothing), push (the Artifacts host, for the trusted
 * push of the gated commit to its candidate ref).
 *
 * Pure: no Node imports, so the Worker validates jobs and results with the
 * same code the container runs.
 */

import type { EvidenceSummary } from "./types.ts";
import type { TestInventory } from "./test-inventory.ts";

export type { EvidenceSummary } from "./types.ts";
export type { TestInventory } from "./test-inventory.ts";

/** The job format version. */
export const INTEGRATE_JOB_VERSION = 1;

/** The egress phases of a job, in the only order they may run. */
export const EGRESS_PHASES = ["fetch", "deps", "gate", "push"] as const;
export type EgressPhase = (typeof EGRESS_PHASES)[number];

/** Line prefixes of the CLI protocol. */
export const JOB_PROTOCOL = {
  phase: "@@scf phase ",
  result: "@@scf result ",
  ack: "ack ",
} as const;

/** One agent's pinned pushes, as a unit of the job. */
export interface IntegrateJobUnit {
  readonly agent: string;
  /** Tokenless clone URL of the agent's repo. */
  readonly repoUrl: string;
  /** The pinned commit (the agent's latest pending announced push). */
  readonly commit: string;
  /** The diff base: the agent's last passing-merged commit, or "HEAD". */
  readonly baselineRef: string;
  /** Other pending commits that must be in the pin's history. */
  readonly includes: readonly string[];
  /** The write intents of the unit's items. */
  readonly scope: readonly string[];
  /** The board items the unit integrates (for the evidence's objective). */
  readonly items: readonly string[];
  readonly yieldedScope?: readonly string[];
  readonly releasedPaths?: readonly string[];
  /** Per item, which files are applied from which commit (see the integrator's UnitPart). */
  readonly parts?: readonly IntegrateJobPart[];
}

/** One item's files of a job unit: applied from exactly `commit`, diffed from `baselineRef`. */
export interface IntegrateJobPart {
  readonly item: string;
  readonly commit: string;
  readonly baselineRef: string;
  readonly scope: readonly string[];
}

/** A protected JSON file's gate-defining keys. */
export interface JobProtectedJsonKeys {
  readonly file: string;
  readonly keys: readonly (readonly string[])[];
}

/** Integrate the board's pending pushes into one gated revision. */
export interface IntegrateJob {
  readonly version: typeof INTEGRATE_JOB_VERSION;
  readonly kind: "integrate";
  readonly changeId: string;
  readonly objective: string;
  /** The integration repo (tokenless) and its branch. */
  readonly integration: { readonly repoUrl: string; readonly defaultBranch: string };
  /** Build on this commit (the last RECORDED passing revision); absent = the branch head. */
  readonly baseCommit?: string;
  readonly units: readonly IntegrateJobUnit[];
  /** The per-app gate, as argv. */
  readonly gateCommand?: readonly string[];
  /** The project declares a gate: without a command the verdict is cannot-pass. */
  readonly requireGate: boolean;
  /** The gate's contract: restored from the baseline before the gate runs. */
  readonly protectedPaths: readonly string[];
  readonly protectedJsonKeys: readonly JobProtectedJsonKeys[];
  /** The baseline gate run's test inventory (names stay with the integrator). */
  readonly testInventory?: TestInventory;
  /**
   * Contract targets a human accepted (from board state): the inventory is
   * relaxed for them (a changed or removed test may rename or drop tests).
   */
  readonly acceptedContracts?: readonly string[];
  /**
   * Shared gate files that sit beside the app (an app's gate may import a
   * harness one directory above it): written into the job's work root, where
   * the gated checkout's parent directory resolves them.
   */
  readonly gateSupportFiles?: readonly { readonly name: string; readonly content: string }[];
  readonly timeouts: { readonly installMs: number; readonly gateMs: number };
  readonly identity?: { readonly name: string; readonly email: string };
}

/** Fast-forward the integration branch to a recorded passing revision. */
export interface AdvanceJob {
  readonly version: typeof INTEGRATE_JOB_VERSION;
  readonly kind: "advance";
  readonly integration: { readonly repoUrl: string; readonly defaultBranch: string };
  readonly commit: string;
  /**
   * The branch value the caller expects (a full commit id). When given, a
   * branch at any other value refuses the advance as "trunk-moved" without
   * pushing; omitted, the value read at the start of the job is leased.
   */
  readonly expectedBase?: string;
}

export type GateJob = IntegrateJob | AdvanceJob;

/** The dependency install that preceded the gate (DependencyInstallOutcome). */
export interface JobInstallOutcome {
  readonly status: "installed" | "skipped" | "unsupported" | "failed";
  readonly tool?: string;
  readonly detail: string;
  readonly durationMs: number;
}

/** One egress phase the job ran under, and when it began. */
export interface JobPhaseRecord {
  readonly phase: EgressPhase;
  readonly at: string;
  /** The egress policy the orchestrator put in force for it. */
  readonly egress?: string;
}

/** The result of an integrate job. */
export interface IntegrateJobResult {
  readonly version: typeof INTEGRATE_JOB_VERSION;
  readonly kind: "integrate";
  /** "gated": the integrator produced a verdict; "refused": nothing recordable. */
  readonly outcome: "gated" | "refused";
  readonly verdict?: "verified" | "failed";
  readonly gate?: "pass" | "fail";
  /** False when no gate ran (a pass that checked nothing). */
  readonly gated?: boolean;
  /** The commit of the exact tree the gate ran on. */
  readonly commit?: string;
  /** The gate's most telling failing line, when it failed. */
  readonly failureLine?: string;
  /** The bounded evidence (per-unit checks, the integration's final check). */
  readonly evidence?: EvidenceSummary;
  readonly install?: JobInstallOutcome;
  /** What the gate run executed (count and format only). */
  readonly inventory?: { readonly format: string; readonly count: number };
  /** Set when accepted contract changes relaxed the test inventory. */
  readonly inventoryNote?: string;
  /** Sandbox processes still alive after the install or the gate, killed before the next phase. */
  readonly sandboxReaped?: number;
  readonly phases: readonly JobPhaseRecord[];
  /** Why nothing is recordable (credential-free). */
  readonly error?: string;
  /**
   * The refusal is an infrastructure failure (an egress phase that could not
   * be entered, an unexpected error), not a property of the pushes: the same
   * job may be run again.
   */
  readonly transient?: boolean;
  readonly durationMs: number;
}

/** The result of an advance job. */
export interface AdvanceJobResult {
  readonly version: typeof INTEGRATE_JOB_VERSION;
  readonly kind: "advance";
  readonly advanced: boolean;
  readonly commit: string;
  readonly phases: readonly JobPhaseRecord[];
  readonly error?: string;
  /**
   * Set when the compare-and-swap push was refused (not a generic failure):
   * "trunk-moved" (another writer advanced the branch; `actual` is its value
   * when it could be read) or "not-descendant". Nothing was pushed.
   */
  readonly refused?: {
    readonly reason: "trunk-moved" | "not-descendant";
    readonly expected: string | null;
    readonly actual?: string | null;
  };
  readonly durationMs: number;
}

export type GateJobResult = IntegrateJobResult | AdvanceJobResult;

/** Bounds a job must stay within. */
export const JOB_LIMITS = {
  maxUnits: 64,
  maxList: 512,
  maxString: 4096,
  maxObjective: 2000,
  installMs: { min: 1000, max: 30 * 60 * 1000 },
  gateMs: { min: 1000, max: 60 * 60 * 1000 },
  maxSupportFiles: 16,
  maxSupportBytes: 512 * 1024,
} as const;

const COMMIT = /^[0-9a-f]{7,64}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUPPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mjs|cjs|js|json)$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

class JobError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new JobError(`${where} has an unknown field ${JSON.stringify(key)}`);
    }
  }
}

function str(value: unknown, where: string, max: number = JOB_LIMITS.maxString): string {
  if (typeof value !== "string" || value === "" || value.length > max) {
    throw new JobError(`${where} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function strList(value: unknown, where: string, check?: (s: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > JOB_LIMITS.maxList) {
    throw new JobError(`${where} must be a list of at most ${JOB_LIMITS.maxList} strings`);
  }
  return value.map((entry, i) => {
    const s = str(entry, `${where}[${i}]`);
    if (check && !check(s)) {
      throw new JobError(`${where}[${i}] is not valid: ${JSON.stringify(s.slice(0, 80))}`);
    }
    return s;
  });
}

function commit(value: unknown, where: string): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new JobError(`${where} must be a commit id`);
  }
  return value;
}

/** A full (unabbreviated) commit id: what a compare-and-swap compares against. */
function fullCommit(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value)) {
    throw new JobError(`${where} must be a full commit id`);
  }
  return value;
}

/**
 * A repository URL a job may name: https (or file:// for the offline path),
 * WITHOUT credentials. A token in a job would reach the container.
 */
export function tokenlessRepoUrl(value: unknown, where: string): string {
  const url = str(value, where);
  if (!/^(https:\/\/|file:\/\/)/.test(url)) {
    throw new JobError(`${where} must be an https:// (or file://) URL`);
  }
  if (/^[a-z]+:\/\/[^/]*@/i.test(url)) {
    throw new JobError(`${where} must not carry credentials: jobs are tokenless`);
  }
  return url;
}

function integration(value: unknown, where: string): IntegrateJob["integration"] {
  if (!isRecord(value)) {
    throw new JobError(`${where} must be an object {repoUrl, defaultBranch}`);
  }
  only(value, ["repoUrl", "defaultBranch"], where);
  const branch = str(value.defaultBranch, `${where}.defaultBranch`, 128);
  if (!BRANCH.test(branch) || branch.includes("..")) {
    throw new JobError(`${where}.defaultBranch is not a branch name`);
  }
  return { repoUrl: tokenlessRepoUrl(value.repoUrl, `${where}.repoUrl`), defaultBranch: branch };
}

function timeoutMs(value: unknown, where: string, bounds: { readonly min: number; readonly max: number }): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new JobError(`${where} must be an integer from ${bounds.min} to ${bounds.max}`);
  }
  return value;
}

function unit(value: unknown, i: number): IntegrateJobUnit {
  const where = `units[${i}]`;
  if (!isRecord(value)) {
    throw new JobError(`${where} must be an object`);
  }
  only(value, ["agent", "repoUrl", "commit", "baselineRef", "includes", "scope", "items", "yieldedScope", "releasedPaths", "parts"], where);
  const agent = str(value.agent, `${where}.agent`, 128);
  if (!AGENT.test(agent)) {
    throw new JobError(`${where}.agent is not an agent id`);
  }
  const baselineRef = value.baselineRef === "HEAD" ? "HEAD" : commit(value.baselineRef, `${where}.baselineRef`);
  return {
    agent,
    repoUrl: tokenlessRepoUrl(value.repoUrl, `${where}.repoUrl`),
    commit: commit(value.commit, `${where}.commit`),
    baselineRef,
    includes: strList(value.includes, `${where}.includes`, (s) => COMMIT.test(s)),
    scope: strList(value.scope, `${where}.scope`),
    items: strList(value.items, `${where}.items`),
    ...(value.yieldedScope !== undefined ? { yieldedScope: strList(value.yieldedScope, `${where}.yieldedScope`) } : {}),
    ...(value.releasedPaths !== undefined ? { releasedPaths: strList(value.releasedPaths, `${where}.releasedPaths`) } : {}),
    ...(value.parts !== undefined ? { parts: jobParts(value.parts, `${where}.parts`) } : {}),
  };
}

function jobParts(value: unknown, where: string): IntegrateJobPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new JobError(`${where} must be a non-empty array`);
  }
  return value.map((part, k) => {
    const at = `${where}[${k}]`;
    if (!isRecord(part)) {
      throw new JobError(`${at} must be an object {item, commit, baselineRef, scope}`);
    }
    only(part, ["item", "commit", "baselineRef", "scope"], at);
    return {
      item: str(part.item, `${at}.item`, 200),
      commit: commit(part.commit, `${at}.commit`),
      baselineRef: part.baselineRef === "HEAD" ? "HEAD" : commit(part.baselineRef, `${at}.baselineRef`),
      scope: strList(part.scope, `${at}.scope`),
    };
  });
}

function inventory(value: unknown): TestInventory {
  if (!isRecord(value)) {
    throw new JobError("testInventory must be an object {format, count, names}");
  }
  only(value, ["format", "count", "names"], "testInventory");
  const formats = ["node-spec", "tap", "go-json", "go-verbose", "pytest", "vitest", "jest"];
  if (typeof value.format !== "string" || !formats.includes(value.format)) {
    throw new JobError("testInventory.format is not a known reporter format");
  }
  if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 0) {
    throw new JobError("testInventory.count must be a non-negative integer");
  }
  return {
    format: value.format as TestInventory["format"],
    count: value.count,
    names: Array.isArray(value.names) && value.names.length === 0 ? [] : strList(value.names, "testInventory.names"),
  };
}

function parseIntegrate(value: Record<string, unknown>): IntegrateJob {
  only(
    value,
    [
      "version",
      "kind",
      "changeId",
      "objective",
      "integration",
      "baseCommit",
      "units",
      "gateCommand",
      "requireGate",
      "protectedPaths",
      "protectedJsonKeys",
      "testInventory",
      "acceptedContracts",
      "gateSupportFiles",
      "timeouts",
      "identity",
    ],
    "the job",
  );
  if (!Array.isArray(value.units) || value.units.length === 0 || value.units.length > JOB_LIMITS.maxUnits) {
    throw new JobError(`units must be a list of 1 to ${JOB_LIMITS.maxUnits} units`);
  }
  const units = value.units.map((u, i) => unit(u, i));
  if (new Set(units.map((u) => u.agent)).size !== units.length) {
    throw new JobError("units must name each agent once");
  }
  if (typeof value.requireGate !== "boolean") {
    throw new JobError("requireGate must be a boolean");
  }
  const gateCommand = value.gateCommand === undefined ? undefined : strList(value.gateCommand, "gateCommand");
  if (gateCommand !== undefined && gateCommand.length === 0) {
    throw new JobError("gateCommand must not be empty (omit it for no gate)");
  }
  if (!Array.isArray(value.protectedJsonKeys) || value.protectedJsonKeys.length > JOB_LIMITS.maxList) {
    throw new JobError("protectedJsonKeys must be a list");
  }
  const protectedJsonKeys = value.protectedJsonKeys.map((entry, i) => {
    if (!isRecord(entry)) {
      throw new JobError(`protectedJsonKeys[${i}] must be an object {file, keys}`);
    }
    only(entry, ["file", "keys"], `protectedJsonKeys[${i}]`);
    if (!Array.isArray(entry.keys) || entry.keys.length > JOB_LIMITS.maxList) {
      throw new JobError(`protectedJsonKeys[${i}].keys must be a list of key paths`);
    }
    return {
      file: str(entry.file, `protectedJsonKeys[${i}].file`),
      keys: entry.keys.map((k, j) => strList(k, `protectedJsonKeys[${i}].keys[${j}]`)),
    };
  });
  if (!isRecord(value.timeouts)) {
    throw new JobError("timeouts must be an object {installMs, gateMs}");
  }
  only(value.timeouts, ["installMs", "gateMs"], "timeouts");
  let supportBytes = 0;
  const gateSupportFiles =
    value.gateSupportFiles === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(value.gateSupportFiles) || value.gateSupportFiles.length > JOB_LIMITS.maxSupportFiles) {
            throw new JobError(`gateSupportFiles must be a list of at most ${JOB_LIMITS.maxSupportFiles} files`);
          }
          return value.gateSupportFiles.map((f, i) => {
            if (!isRecord(f)) {
              throw new JobError(`gateSupportFiles[${i}] must be an object {name, content}`);
            }
            only(f, ["name", "content"], `gateSupportFiles[${i}]`);
            const name = str(f.name, `gateSupportFiles[${i}].name`, 132);
            if (!SUPPORT_NAME.test(name)) {
              throw new JobError(`gateSupportFiles[${i}].name must be a plain file name (.mjs, .cjs, .js, .json)`);
            }
            if (typeof f.content !== "string") {
              throw new JobError(`gateSupportFiles[${i}].content must be a string`);
            }
            supportBytes += f.content.length;
            if (supportBytes > JOB_LIMITS.maxSupportBytes) {
              throw new JobError(`gateSupportFiles exceed ${JOB_LIMITS.maxSupportBytes} characters`);
            }
            return { name, content: f.content };
          });
        })();
  const identity =
    value.identity === undefined
      ? undefined
      : (() => {
          if (!isRecord(value.identity)) {
            throw new JobError("identity must be an object {name, email}");
          }
          only(value.identity, ["name", "email"], "identity");
          return { name: str(value.identity.name, "identity.name", 200), email: str(value.identity.email, "identity.email", 200) };
        })();
  const changeId = str(value.changeId, "changeId", 200);
  return {
    version: INTEGRATE_JOB_VERSION,
    kind: "integrate",
    changeId,
    objective: str(value.objective, "objective", JOB_LIMITS.maxObjective),
    integration: integration(value.integration, "integration"),
    ...(value.baseCommit !== undefined ? { baseCommit: commit(value.baseCommit, "baseCommit") } : {}),
    units,
    ...(gateCommand !== undefined ? { gateCommand } : {}),
    requireGate: value.requireGate,
    protectedPaths: strList(value.protectedPaths, "protectedPaths"),
    protectedJsonKeys,
    ...(value.testInventory !== undefined ? { testInventory: inventory(value.testInventory) } : {}),
    ...(value.acceptedContracts !== undefined ? { acceptedContracts: strList(value.acceptedContracts, "acceptedContracts") } : {}),
    ...(gateSupportFiles !== undefined ? { gateSupportFiles } : {}),
    timeouts: {
      installMs: timeoutMs(value.timeouts.installMs, "timeouts.installMs", JOB_LIMITS.installMs),
      gateMs: timeoutMs(value.timeouts.gateMs, "timeouts.gateMs", JOB_LIMITS.gateMs),
    },
    ...(identity !== undefined ? { identity } : {}),
  };
}

/** Validate a job (from the wire): tokenless URLs, pinned commits, bounded lists. */
export function parseGateJob(raw: unknown): Parsed<GateJob> {
  try {
    if (!isRecord(raw)) {
      throw new JobError("a job must be an object");
    }
    if (raw.version !== INTEGRATE_JOB_VERSION) {
      throw new JobError(`a job must have version ${INTEGRATE_JOB_VERSION}`);
    }
    if (raw.kind === "integrate") {
      return { ok: true, value: parseIntegrate(raw) };
    }
    if (raw.kind === "advance") {
      only(raw, ["version", "kind", "integration", "commit", "expectedBase"], "the job");
      return {
        ok: true,
        value: {
          version: INTEGRATE_JOB_VERSION,
          kind: "advance",
          integration: integration(raw.integration, "integration"),
          commit: commit(raw.commit, "commit"),
          ...(raw.expectedBase !== undefined ? { expectedBase: fullCommit(raw.expectedBase, "expectedBase") } : {}),
        },
      };
    }
    throw new JobError('a job kind must be "integrate" or "advance"');
  } catch (error) {
    if (error instanceof JobError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/** One line of the job for the CLI's stdin. */
export function serializeGateJob(job: GateJob): string {
  return JSON.stringify(job);
}

/** Validate a job result read from the CLI (the shape the recorder relies on). */
export function parseGateJobResult(raw: unknown): Parsed<GateJobResult> {
  if (!isRecord(raw) || raw.version !== INTEGRATE_JOB_VERSION) {
    return { ok: false, error: "a job result must be an object of the current version" };
  }
  if (!Array.isArray(raw.phases) || typeof raw.durationMs !== "number") {
    return { ok: false, error: "a job result must carry its phases and duration" };
  }
  if (raw.kind === "advance") {
    if (typeof raw.advanced !== "boolean" || typeof raw.commit !== "string") {
      return { ok: false, error: "an advance result must say whether it advanced which commit" };
    }
    return { ok: true, value: raw as unknown as AdvanceJobResult };
  }
  if (raw.kind !== "integrate" || (raw.outcome !== "gated" && raw.outcome !== "refused")) {
    return { ok: false, error: 'an integrate result must have outcome "gated" or "refused"' };
  }
  if (raw.outcome === "gated") {
    if (raw.gate !== "pass" && raw.gate !== "fail") {
      return { ok: false, error: "a gated result must carry its gate" };
    }
    if (typeof raw.commit !== "string" || !COMMIT.test(raw.commit)) {
      return { ok: false, error: "a gated result must carry the gated commit" };
    }
    if (!isRecord(raw.evidence)) {
      return { ok: false, error: "a gated result must carry its evidence" };
    }
  }
  return { ok: true, value: raw as unknown as IntegrateJobResult };
}

/** The line the CLI prints to ask for an egress phase. */
export function phaseLine(phase: EgressPhase): string {
  return `${JOB_PROTOCOL.phase}${phase}`;
}

/** The line the CLI prints with its result. */
export function resultLine(result: GateJobResult): string {
  return `${JOB_PROTOCOL.result}${JSON.stringify(result)}`;
}

/** The line the orchestrator writes to acknowledge a phase. */
export function ackLine(phase: EgressPhase): string {
  return `${JOB_PROTOCOL.ack}${phase}`;
}

/** Read one protocol line (any other line is undefined: only these lines mean anything). */
export function parseProtocolLine(
  line: string,
): { readonly kind: "phase"; readonly phase: EgressPhase } | { readonly kind: "result"; readonly value: unknown } | { readonly kind: "invalid"; readonly error: string } | undefined {
  if (line.startsWith(JOB_PROTOCOL.phase)) {
    const phase = line.slice(JOB_PROTOCOL.phase.length).trim();
    return (EGRESS_PHASES as readonly string[]).includes(phase)
      ? { kind: "phase", phase: phase as EgressPhase }
      : { kind: "invalid", error: `unknown phase ${JSON.stringify(phase.slice(0, 40))}` };
  }
  if (line.startsWith(JOB_PROTOCOL.result)) {
    try {
      return { kind: "result", value: JSON.parse(line.slice(JOB_PROTOCOL.result.length)) };
    } catch {
      return { kind: "invalid", error: "the result line is not JSON" };
    }
  }
  return undefined;
}

/**
 * Is moving from `current` to `next` allowed? Phases only move forward
 * (asking for the current phase again is a no-op).
 */
export function phaseTransitionAllowed(current: EgressPhase, next: EgressPhase): boolean {
  return EGRESS_PHASES.indexOf(next) >= EGRESS_PHASES.indexOf(current);
}

/** The fields of an integrate job its idempotency key covers. */
export type IntegrationJobKeyInput = Pick<
  IntegrateJob,
  | "changeId"
  | "baseCommit"
  | "units"
  | "integration"
  | "gateCommand"
  | "requireGate"
  | "protectedPaths"
  | "protectedJsonKeys"
  | "testInventory"
  | "acceptedContracts"
  | "gateSupportFiles"
  | "timeouts"
  | "identity"
>;

/** JSON with object keys sorted (a stable encoding of a value for hashing). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The idempotency material of an integrate job: the Change, the base commit,
 * every unit's pinned commit, and EVERY field that defines what the gate
 * checks (the integration repo and branch, the gate command and whether a gate
 * is required, the protected contract, the baseline test inventory, the
 * accepted contracts, the gate support files, the timeouts, and the commit
 * identity), plus an optional run nonce (the configuration's time, so a
 * re-created Change never replays a prior run's outcome). The same pending
 * pushes on the same base under the same gate are the same revision, however
 * often a retry asks for it; a different gate is a different job.
 */
export function integrationJobKeyMaterial(job: IntegrationJobKeyInput, nonce?: string): string {
  const pins = [...job.units].map((u) => `${u.agent}@${u.commit}`).sort();
  const gate = canonicalJson({
    integration: job.integration,
    gateCommand: job.gateCommand ?? null,
    requireGate: job.requireGate,
    protectedPaths: [...job.protectedPaths].sort(),
    protectedJsonKeys: job.protectedJsonKeys,
    testInventory: job.testInventory ?? null,
    acceptedContracts: [...(job.acceptedContracts ?? [])].sort(),
    gateSupportFiles: [...(job.gateSupportFiles ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    timeouts: job.timeouts,
    identity: job.identity ?? null,
  });
  return [`change:${job.changeId}`, `base:${job.baseCommit ?? "baseline"}`, ...pins, `gate:${gate}`, ...(nonce !== undefined ? [`run:${nonce}`] : [])].join("\n");
}

/** SHA-256 of text, hex, cut to 32 characters (Web Crypto: present in Node and in Workers). */
async function shortDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // Typed structurally: no DOM lib here.
  const { subtle } = (globalThis as unknown as { readonly crypto: { readonly subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto;
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** A short, stable id for the material ("ij-" prefixed). */
export async function integrationJobKey(job: IntegrationJobKeyInput, nonce?: string): Promise<string> {
  return `ij-${await shortDigest(integrationJobKeyMaterial(job, nonce))}`;
}

/**
 * The idempotency key of an advance job ("aj-" prefixed): the integration
 * repo and branch, the base the revision was built on (the value the branch is
 * expected to move from), the commit to advance to, and the revision's own key
 * (which carries the run nonce). The same commit under another repo, base, or
 * run is a different advance.
 */
export async function advanceJobKey(input: {
  readonly integration: { readonly repoUrl: string; readonly defaultBranch: string };
  readonly expectedBase?: string;
  readonly commit: string;
  readonly revisionKey?: string;
}): Promise<string> {
  const material = [
    `repo:${input.integration.repoUrl}`,
    `branch:${input.integration.defaultBranch}`,
    `base:${input.expectedBase ?? "branch-head"}`,
    `commit:${input.commit}`,
    `revision:${input.revisionKey ?? ""}`,
  ].join("\n");
  return `aj-${await shortDigest(material)}`;
}

/** Text with any URL userinfo and bearer value removed (defense in depth: jobs carry no credentials). */
export function scrubJobText(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
}

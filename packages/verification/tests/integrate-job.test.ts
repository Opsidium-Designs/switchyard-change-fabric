/**
 * The integration job (the unit of work the gate container runs), offline:
 *   - the job schema: tokenless URLs only, pinned commits, bounded lists;
 *     serialization round-trips through the parser;
 *   - the idempotency key: the Change, the base, and the pinned commits;
 *   - the line protocol and the forward-only phase order;
 *   - runIntegrateJob over real local Git: the egress phases run in order
 *     fetch -> deps -> gate -> push, the install runs under deps and the gate
 *     under gate, the gated commit lands on its candidate ref only, and a
 *     phase that cannot be entered makes the result unrecordable;
 *   - the CLI end to end over its stdin/stdout protocol.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ackLine,
  EGRESS_PHASES,
  integrationJobKey,
  integrationJobKeyMaterial,
  parseGateJob,
  parseGateJobResult,
  parseProtocolLine,
  phaseLine,
  phaseTransitionAllowed,
  resultLine,
  scrubJobText,
  serializeGateJob,
  type EgressPhase,
  type IntegrateJob,
  type IntegrateJobResult,
} from "../src/integrate-job.ts";
import { runIntegrateJob, type GateContainment } from "../src/integrate-run.ts";
import type { CommandOutcome, CommandRunner } from "../src/command.ts";
import type { DependencyInstaller, DependencyInstallOutcome } from "../src/dependency-install.ts";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@switchyard.local"];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function job(overrides: Partial<IntegrateJob> = {}): IntegrateJob {
  return {
    version: 1,
    kind: "integrate",
    changeId: "change-x",
    objective: "fix the thing",
    integration: { repoUrl: "https://acct.artifacts.cloudflare.net/git/ns/change-x--integration.git", defaultBranch: "main" },
    units: [
      {
        agent: "agent-1",
        repoUrl: "https://acct.artifacts.cloudflare.net/git/ns/change-x--board-agent-1.git",
        commit: SHA_A,
        baselineRef: "HEAD",
        includes: [],
        scope: ["src/a.js"],
        items: ["item-a"],
      },
    ],
    gateCommand: ["npm", "run", "gate"],
    requireGate: true,
    protectedPaths: ["test/**"],
    protectedJsonKeys: [{ file: "package.json", keys: [["scripts", "gate"]] }],
    timeouts: { installMs: 60_000, gateMs: 60_000 },
    ...overrides,
  };
}

describe("integration job schema", () => {
  it("round-trips a valid job through serialization and the parser", () => {
    const original = job({ baseCommit: SHA_B, testInventory: { format: "node-spec", count: 2, names: ["a", "b"] }, acceptedContracts: ["test/a.test.mjs"] });
    const parsed = parseGateJob(JSON.parse(serializeGateJob(original)));
    expect(parsed).toEqual({ ok: true, value: original });
  });

  it("refuses a URL that carries a credential (jobs are tokenless)", () => {
    const tokened = job({ integration: { repoUrl: "https://token:secret@acct.artifacts.cloudflare.net/git/ns/x.git", defaultBranch: "main" } });
    const parsed = parseGateJob(tokened);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/must not carry credentials/);
    const unitTokened = job();
    const units = [{ ...unitTokened.units[0]!, repoUrl: "https://x:y@host/git/ns/a.git" }];
    expect(parseGateJob({ ...unitTokened, units }).ok).toBe(false);
  });

  it("refuses unpinned commits, unknown fields, bad timeouts, and unsafe support file names", () => {
    expect(parseGateJob({ ...job(), units: [{ ...job().units[0]!, commit: "main" }] }).ok).toBe(false);
    expect(parseGateJob({ ...job(), extra: 1 }).ok).toBe(false);
    expect(parseGateJob({ ...job(), timeouts: { installMs: 5, gateMs: 60_000 } }).ok).toBe(false);
    expect(parseGateJob({ ...job(), gateSupportFiles: [{ name: "../escape.mjs", content: "" }] }).ok).toBe(false);
    expect(parseGateJob({ ...job(), gateSupportFiles: [{ name: "gate-harness.mjs", content: "export {}" }] }).ok).toBe(true);
    expect(parseGateJob({ ...job(), units: [] }).ok).toBe(false);
    expect(parseGateJob({ ...job(), version: 2 }).ok).toBe(false);
  });

  it("parses an advance job", () => {
    const advance = { version: 1, kind: "advance", integration: job().integration, commit: SHA_A };
    expect(parseGateJob(advance)).toEqual({ ok: true, value: advance });
    expect(parseGateJob({ ...advance, commit: "HEAD" }).ok).toBe(false);
  });

  it("checks a result's shape before anything records it", () => {
    expect(parseGateJobResult({ version: 1, kind: "integrate", outcome: "gated", gate: "pass", phases: [], durationMs: 1 }).ok).toBe(false);
    expect(parseGateJobResult({ version: 1, kind: "integrate", outcome: "refused", error: "x", phases: [], durationMs: 1 }).ok).toBe(true);
    expect(
      parseGateJobResult({ version: 1, kind: "integrate", outcome: "gated", gate: "fail", commit: SHA_A, evidence: {}, phases: [], durationMs: 1 }).ok,
    ).toBe(true);
  });
});

describe("integration job idempotency key", () => {
  it("is the Change, the base commit, and the pinned commits, independent of unit order", async () => {
    const one = job({
      units: [
        { ...job().units[0]!, agent: "agent-1", commit: SHA_A },
        { ...job().units[0]!, agent: "agent-2", commit: SHA_B },
      ],
    });
    const swapped = job({ units: [...one.units].reverse() });
    expect(integrationJobKeyMaterial(one)).toBe(integrationJobKeyMaterial(swapped));
    expect(await integrationJobKey(one)).toBe(await integrationJobKey(swapped));
    expect(await integrationJobKey(one)).toMatch(/^ij-[0-9a-f]{32}$/);
    // A different base or a different pin is a different revision.
    expect(await integrationJobKey({ ...one, baseCommit: SHA_A })).not.toBe(await integrationJobKey(one));
    expect(await integrationJobKey(job())).not.toBe(await integrationJobKey(one));
    // Things that do not change what is gated do not change the key.
    expect(await integrationJobKey({ ...one, units: one.units.map((u) => ({ ...u, scope: ["other/**"] })) })).toBe(await integrationJobKey(one));
  });
});

describe("integration job protocol", () => {
  it("reads phase and result lines and ignores everything else", () => {
    expect(parseProtocolLine(phaseLine("deps"))).toEqual({ kind: "phase", phase: "deps" });
    expect(parseProtocolLine("@@scf phase everything")).toEqual({ kind: "invalid", error: 'unknown phase "everything"' });
    expect(parseProtocolLine("npm notice something")).toBeUndefined();
    const result: IntegrateJobResult = { version: 1, kind: "integrate", outcome: "refused", error: "x", phases: [], durationMs: 0 };
    expect(parseProtocolLine(resultLine(result))).toEqual({ kind: "result", value: result });
    expect(ackLine("gate")).toBe("ack gate");
  });

  it("only moves forward through the phases", () => {
    expect(EGRESS_PHASES).toEqual(["fetch", "deps", "gate", "push"]);
    expect(phaseTransitionAllowed("fetch", "deps")).toBe(true);
    expect(phaseTransitionAllowed("gate", "gate")).toBe(true);
    expect(phaseTransitionAllowed("gate", "push")).toBe(true);
    expect(phaseTransitionAllowed("push", "gate")).toBe(false);
    expect(phaseTransitionAllowed("gate", "deps")).toBe(false);
  });

  it("scrubs credentials from text that leaves the container", () => {
    expect(scrubJobText("fatal: https://token:abc123@host/x.git")).toBe("fatal: https://***@host/x.git");
    expect(scrubJobText("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [redacted]");
  });
});

// ---------------------------------------------------------------------------
// runIntegrateJob over real local Git (file:// remotes, no network)
// ---------------------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-integrate-job-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function commitAll(dir: string, message: string): Promise<string> {
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, ...IDENTITY, "commit", "--no-verify", "-q", "-m", message]);
  return (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}

/** A bare integration repo seeded with a baseline, and an agent repo with one pinned fix. */
async function fixture(): Promise<{ integrationUrl: string; agentUrl: string; pin: string; integrationBare: string }> {
  const integrationBare = join(root, "integration.git");
  await run("git", ["init", "-q", "--bare", "--initial-branch=main", integrationBare]);
  const seed = join(root, "seed");
  await mkdir(join(seed, "src"), { recursive: true });
  await run("git", ["-C", seed, "init", "-q", "--initial-branch=main"]);
  await writeFile(join(seed, "src", "a.js"), "export const a = 1;\n");
  await writeFile(join(seed, "package.json"), '{"name":"fixture","scripts":{"gate":"node gate.js"}}\n');
  await commitAll(seed, "baseline");
  await run("git", ["-C", seed, "push", "-q", pathToFileURL(integrationBare).href, "HEAD:refs/heads/main"]);
  // A board agent's repo holds only the files it wrote (diffed against the empty tree).
  const agentBare = join(root, "agent.git");
  await run("git", ["init", "-q", "--bare", "--initial-branch=main", agentBare]);
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "src"), { recursive: true });
  await run("git", ["-C", agentDir, "init", "-q", "--initial-branch=main"]);
  await writeFile(join(agentDir, "src", "a.js"), "export const a = 2;\n");
  const pin = await commitAll(agentDir, "fix a");
  await run("git", ["-C", agentDir, "push", "-q", pathToFileURL(agentBare).href, "HEAD:refs/heads/main"]);
  return { integrationUrl: pathToFileURL(integrationBare).href, agentUrl: pathToFileURL(agentBare).href, pin, integrationBare };
}

/** A second fixture beside the first (its own repos). */
async function fixture2(): Promise<Awaited<ReturnType<typeof fixture>>> {
  const saved = root;
  root = await mkdtemp(join(saved, "second-"));
  try {
    return await fixture();
  } finally {
    root = saved;
  }
}

function localJob(f: { integrationUrl: string; agentUrl: string; pin: string }, gate: string[] | undefined): IntegrateJob {
  return job({
    integration: { repoUrl: f.integrationUrl, defaultBranch: "main" },
    units: [{ agent: "agent-1", repoUrl: f.agentUrl, commit: f.pin, baselineRef: "HEAD", includes: [], scope: ["src/a.js"], items: ["item-a"] }],
    ...(gate ? { gateCommand: gate } : { gateCommand: undefined, requireGate: false }),
    protectedPaths: [],
    protectedJsonKeys: [],
  });
}

/** Records which phase each install and gate ran in. */
function phaseRecorder() {
  let current: EgressPhase | "none" = "none";
  const order: EgressPhase[] = [];
  const seen: { what: string; phase: string }[] = [];
  const installer: DependencyInstaller = {
    async install(): Promise<DependencyInstallOutcome> {
      seen.push({ what: "install", phase: current });
      return { status: "installed", tool: "npm", detail: "npm ci --ignore-scripts", durationMs: 1 };
    },
  };
  const gate = (outcome: CommandOutcome): CommandRunner => ({
    async run() {
      seen.push({ what: "gate", phase: current });
      return outcome;
    },
  });
  return {
    order,
    seen,
    installer,
    gate,
    hooks: {
      async phase(phase: EgressPhase) {
        order.push(phase);
        current = phase;
      },
    },
  };
}

describe("runIntegrateJob", () => {
  it("runs the phases in order and pushes the gated commit to its candidate ref only", async () => {
    const f = await fixture();
    const rec = phaseRecorder();
    const result = await runIntegrateJob(localJob(f, ["npm", "run", "gate"]), {
      workRoot: join(root, "work"),
      hooks: rec.hooks,
      installer: rec.installer,
      commandRunner: () => rec.gate({ code: 0, stdout: "✔ a works (1ms)\nℹ tests 1\nℹ pass 1\n", stderr: "" }),
    });
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("gated");
    expect(result.gate).toBe("pass");
    expect(result.gated).toBe(true);
    expect(rec.order).toEqual(["fetch", "deps", "gate", "push"]);
    expect(result.phases.map((p) => p.phase)).toEqual(["fetch", "deps", "gate", "push"]);
    expect(rec.seen).toEqual([
      { what: "install", phase: "deps" },
      { what: "gate", phase: "gate" },
    ]);
    expect(result.install?.status).toBe("installed");
    expect(result.inventory).toEqual({ format: "node-spec", count: 1 });
    const refs = (await run("git", ["--git-dir", f.integrationBare, "for-each-ref", "--format=%(objectname) %(refname)"])).stdout;
    expect(refs).toContain(`${result.commit} refs/switchyard/gated/${result.commit}`);
    // The branch is NOT advanced (the recorder advances it after recording).
    const main = (await run("git", ["--git-dir", f.integrationBare, "rev-parse", "refs/heads/main"])).stdout.trim();
    expect(main).not.toBe(result.commit);
  });

  it("records a failing gate with its failing line and pushes nothing", async () => {
    const f = await fixture();
    const rec = phaseRecorder();
    const result = await runIntegrateJob(localJob(f, ["npm", "run", "gate"]), {
      workRoot: join(root, "work"),
      hooks: rec.hooks,
      installer: rec.installer,
      commandRunner: () => rec.gate({ code: 1, stdout: "", stderr: "AssertionError [ERR_ASSERTION]: a must be 3\n" }),
    });
    expect(result.outcome).toBe("gated");
    expect(result.gate).toBe("fail");
    expect(result.failureLine).toBe("AssertionError [ERR_ASSERTION]: a must be 3");
    const refs = (await run("git", ["--git-dir", f.integrationBare, "for-each-ref", "refs/switchyard"])).stdout;
    expect(refs.trim()).toBe("");
  });

  it("is unrecordable when an egress phase cannot be entered (never a gate verdict)", async () => {
    const f = await fixture();
    const rec = phaseRecorder();
    const result = await runIntegrateJob(localJob(f, ["npm", "run", "gate"]), {
      workRoot: join(root, "work"),
      hooks: {
        async phase(phase) {
          if (phase === "gate") {
            throw new Error("the orchestrator did not acknowledge");
          }
          await rec.hooks.phase(phase);
        },
      },
      installer: rec.installer,
      commandRunner: () => rec.gate({ code: 0, stdout: "", stderr: "" }),
    });
    expect(result.outcome).toBe("refused");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/the gate egress phase could not be entered/);
    expect(rec.seen.map((s) => s.what)).toEqual(["install"]);
  });

  it("refuses a pinned commit that is not in the agent's repo (the unit is excluded)", async () => {
    const f = await fixture();
    const rec = phaseRecorder();
    const result = await runIntegrateJob({ ...localJob(f, ["npm", "run", "gate"]), units: [{ ...localJob(f, undefined).units[0]!, commit: SHA_B }] }, {
      workRoot: join(root, "work"),
      hooks: rec.hooks,
      installer: rec.installer,
      commandRunner: () => rec.gate({ code: 0, stdout: "", stderr: "" }),
    });
    // Nothing an agent pushed is in the tree: nothing recordable.
    expect(result.outcome).toBe("refused");
    expect(result.error).toMatch(/every pending push was excluded: agent-1: failed verification \(clean-state: the pinned commit/);
    expect(result.evidence?.units[0]?.verdict).toBe("failed");
  });
});

describe("runIntegrateJob sandbox containment (fake containment, no real processes are signalled)", () => {
  const sandbox = () => ({ uid: process.getuid!(), gid: process.getgid!(), home: join(root, "image-home") });

  /** A containment whose answers are scripted, recording when it was asked. */
  function containment(script: { readonly reapFailsAt?: number; readonly aliveBeforePush?: boolean }, now: () => string) {
    const calls: string[] = [];
    let reaps = 0;
    const fake: GateContainment = {
      async scrub() {
        calls.push("scrub");
      },
      async reap() {
        reaps += 1;
        calls.push(`reap@${now()}`);
        if (script.reapFailsAt === reaps) {
          throw new Error("1 sandbox process(es) survived the reap");
        }
        return reaps === 2 ? 3 : 0;
      },
      async assertNone() {
        calls.push(`assertNone@${now()}`);
        // Asked while the gate phase is in force = asked before the push phase opens.
        if (script.aliveBeforePush && now() === "gate") {
          throw new Error("1 sandbox process(es) are alive before credentialed egress");
        }
      },
    };
    return { calls, fake };
  }

  /** Runs one sandboxed job with fakes; returns the result, the argv the runner saw, and the containment calls. */
  async function sandboxedJob(f: Awaited<ReturnType<typeof fixture>>, script: Parameters<typeof containment>[0], gate: CommandOutcome = { code: 0, stdout: "", stderr: "" }) {
    let phase = "none";
    const order: string[] = [];
    const c = containment(script, () => phase);
    const argvs: (readonly string[])[] = [];
    const result = await runIntegrateJob(localJob(f, ["npm", "run", "gate"]), {
      workRoot: join(root, "work"),
      sandbox: sandbox(),
      containment: c.fake,
      hooks: {
        async phase(p) {
          order.push(p);
          phase = p;
        },
      },
      installer: {
        async install() {
          return { status: "installed", tool: "npm", detail: "npm ci", durationMs: 1 };
        },
      },
      commandRunner: () => ({
        async run(argv) {
          argvs.push(argv);
          return gate;
        },
      }),
    });
    return { result, argvs, calls: c.calls, order };
  }

  it("refuses (transient, no verdict, no push) when a sandbox process survives the reap after the gate", async () => {
    const f = await fixture();
    const { result, calls, order } = await sandboxedJob(f, { reapFailsAt: 2 });
    expect(result.outcome).toBe("refused");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/sandbox containment failed: 1 sandbox process\(es\) survived the reap/);
    expect(order).toEqual(["fetch", "deps", "gate"]);
    expect(calls).toEqual(["scrub", "assertNone@none", "reap@deps", "reap@gate"]);
    const refs = (await run("git", ["--git-dir", f.integrationBare, "for-each-ref", "refs/switchyard"])).stdout;
    expect(refs.trim()).toBe("");
  });

  it("asserts no sandbox process before each credentialed phase, and refuses the push when one is alive", async () => {
    const f = await fixture();
    const ok = await sandboxedJob(f, {});
    expect(ok.result.outcome).toBe("gated");
    expect(ok.calls).toEqual(["scrub", "assertNone@none", "reap@deps", "reap@gate", "assertNone@gate"]);
    const alive = await sandboxedJob(await fixture2(), { aliveBeforePush: true });
    expect(alive.result.outcome).toBe("refused");
    expect(alive.result.transient).toBe(true);
    expect(alive.order).toEqual(["fetch", "deps", "gate"]);
  });

  it("gives the sandbox a HOME and temp dir of its own inside each job's root, capped in processes", async () => {
    const f = await fixture();
    const first = await sandboxedJob(f, {});
    const second = await sandboxedJob(f, {});
    const homeOf = (argv: readonly string[]) => argv.find((a) => a.startsWith("HOME="))!.slice(5);
    const tmpOf = (argv: readonly string[]) => argv.find((a) => a.startsWith("TMPDIR="))!.slice(7);
    const [a, b] = [first.argvs[0]!, second.argvs[0]!];
    expect(a.slice(0, 2)).toEqual(["setpriv", `--reuid=${process.getuid!()}`]);
    expect(a).toContain("--nproc=512:512");
    expect(homeOf(a)).toMatch(new RegExp(`^${join(root, "work")}/job-[^/]+/sandbox-home$`));
    expect(tmpOf(a)).toMatch(new RegExp(`^${join(root, "work")}/job-[^/]+/sandbox-tmp$`));
    expect(homeOf(a)).not.toBe(homeOf(b));
    expect(homeOf(a)).not.toBe(join(root, "image-home"));
  });
});

describe("integrate-cli", () => {
  it("speaks the protocol: job in, phase requests acknowledged, result out", async () => {
    const f = await fixture();
    const cli = fileURLToPath(new URL("../src/integrate-cli.ts", import.meta.url));
    const gateScript = join(root, "gate-ok.cjs");
    await writeFile(gateScript, "console.log('ok');\n");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", cli], {
      env: { ...process.env, SCF_WORK_ROOT: join(root, "cli-work"), SCF_SANDBOX_UID: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const requested: string[] = [];
    let result: unknown;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const parsed = parseProtocolLine(line);
        if (parsed?.kind === "phase") {
          requested.push(parsed.phase);
          child.stdin.write(`${ackLine(parsed.phase)}\n`);
        } else if (parsed?.kind === "result") {
          result = parsed.value;
        }
      }
    });
    child.stdin.write(`${serializeGateJob(localJob(f, [process.execPath, gateScript]))}\n`);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(requested).toEqual(["fetch", "deps", "gate", "push"]);
    const parsed = parseGateJobResult(result);
    expect(parsed.ok).toBe(true);
    expect((result as IntegrateJobResult).gate).toBe("pass");
    expect((result as IntegrateJobResult).install?.status).toBe("skipped");
  });

  it("answers an invalid job with a refused result", async () => {
    const cli = fileURLToPath(new URL("../src/integrate-cli.ts", import.meta.url));
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", cli], {
      env: { ...process.env, SCF_WORK_ROOT: join(root, "cli-work") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stdin.write(`${JSON.stringify({ ...job(), integration: { repoUrl: "https://t:s@h/x.git", defaultBranch: "main" } })}\n`);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(2);
    const parsed = parseProtocolLine(out.trim());
    expect(parsed?.kind).toBe("result");
    expect((parsed as { value: IntegrateJobResult }).value.error).toMatch(/must not carry credentials/);
  });
});

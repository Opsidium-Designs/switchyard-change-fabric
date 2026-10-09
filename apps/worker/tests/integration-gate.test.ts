/**
 * Integration on Cloudflare, the gate side (offline, no container, no network):
 *   - the egress policy per phase: the Artifacts host only for the job's repos
 *     (with that repo's token added), the registry only for GET/HEAD, nothing
 *     during the gate or outside a job;
 *   - the driver against a fake container: the policy is moved BEFORE each
 *     phase is acknowledged, phases only move forward, the egress is closed
 *     when the job ends however it ends, a deadline stops a hung job, and no
 *     token ever reaches the container (argv, env, or the job).
 */

import { describe, expect, it } from "vitest";

import { phaseLine, resultLine, type GateJob, type IntegrateJobResult } from "@switchyard-change/verification/integrate-job";

import { cliArgv, driveGateJob, type GateContainerPort, type GateProcess } from "../src/integration-driver.ts";
import { decideEgress, egressLabel, repoPathOf, type GateEgressProps } from "../src/integration-egress.ts";

const HOST = "acct.artifacts.cloudflare.net";
const INTEGRATION = `https://${HOST}/git/ns/change-x--integration.git`;
const AGENT = `https://${HOST}/git/ns/change-x--board-agent-1.git`;
const TOKENS = { [repoPathOf(INTEGRATION)]: "write-token-integration", [repoPathOf(AGENT)]: "read-token-agent" };

function props(phase: GateEgressProps["phase"]): GateEgressProps {
  return { phase, artifactsHost: HOST, registryHost: "registry.npmjs.org", repos: phase === "fetch" || phase === "push" ? TOKENS : {} };
}

describe("gate egress policy", () => {
  it("relays only the job's repos on the Artifacts host in fetch and push, with that repo's token", () => {
    for (const phase of ["fetch", "push"] as const) {
      const ok = decideEgress(props(phase), "POST", `${AGENT}/git-upload-pack`, new Headers({ authorization: "Bearer forged" }));
      expect(ok.allow).toBe(true);
      expect(ok.allow && ok.headers.get("authorization")).toBe("Bearer read-token-agent");
      const info = decideEgress(props(phase), "GET", `${INTEGRATION}/info/refs?service=git-receive-pack`, new Headers());
      expect(info.allow && info.headers.get("authorization")).toBe("Bearer write-token-integration");
      expect(decideEgress(props(phase), "GET", `https://${HOST}/git/ns/someone-else.git/info/refs`, new Headers()).allow).toBe(false);
      expect(decideEgress(props(phase), "GET", "https://registry.npmjs.org/left-pad", new Headers()).allow).toBe(false);
      expect(decideEgress(props(phase), "PUT", `${AGENT}/x`, new Headers()).allow).toBe(false);
    }
  });

  it("relays only GET/HEAD to the registry in deps, with no credential", () => {
    const ok = decideEgress(props("deps"), "GET", "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", new Headers({ authorization: "Bearer x", cookie: "a=b" }));
    expect(ok.allow).toBe(true);
    expect(ok.allow && ok.headers.has("authorization")).toBe(false);
    expect(ok.allow && ok.headers.has("cookie")).toBe(false);
    expect(decideEgress(props("deps"), "POST", "https://registry.npmjs.org/-/v1/login", new Headers()).allow).toBe(false);
    expect(decideEgress(props("deps"), "GET", `${AGENT}/info/refs`, new Headers()).allow).toBe(false);
  });

  it("relays nothing during the gate or outside a job", () => {
    for (const phase of ["gate", "closed"] as const) {
      expect(decideEgress(props(phase), "GET", `${INTEGRATION}/info/refs`, new Headers()).allow).toBe(false);
      expect(decideEgress(props(phase), "GET", "https://registry.npmjs.org/x", new Headers()).allow).toBe(false);
    }
    expect(decideEgress(props("fetch"), "GET", `https://u:p@${HOST}/git/ns/change-x--integration.git/info/refs`, new Headers()).allow).toBe(false);
    expect(egressLabel("gate")).toBe("deny-all");
    expect(egressLabel("deps")).toBe("registry-only");
    expect(egressLabel("push")).toBe("artifacts-only");
  });
});

const JOB: GateJob = {
  version: 1,
  kind: "integrate",
  changeId: "change-x",
  objective: "o",
  integration: { repoUrl: INTEGRATION, defaultBranch: "main" },
  units: [{ agent: "agent-1", repoUrl: AGENT, commit: "a".repeat(40), baselineRef: "HEAD", includes: [], scope: ["src/a.js"], items: ["i"] }],
  gateCommand: ["npm", "run", "gate"],
  requireGate: true,
  protectedPaths: [],
  protectedJsonKeys: [],
  timeouts: { installMs: 60_000, gateMs: 60_000 },
};

const RESULT: IntegrateJobResult = {
  version: 1,
  kind: "integrate",
  outcome: "gated",
  verdict: "verified",
  gate: "pass",
  gated: true,
  commit: "c".repeat(40),
  evidence: {
    changeId: "change-x",
    units: [],
    integration: { verdict: "verified", integratedUnits: ["agent-1"], excludedUnits: [], finalCheck: { kind: "app-gate", passed: true, skipped: false, summary: "ok", outputs: [] } },
  },
  phases: [],
  durationMs: 1,
};

/** A fake container whose CLI follows a script: each entry is printed once the previous line was acknowledged. */
class FakeContainer implements GateContainerPort {
  readonly log: string[] = [];
  readonly egress: GateEgressProps[] = [];
  readonly spawned: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  readonly stdin: string[] = [];
  running = false;
  killed = false;
  /** When the sandbox check reports a live sandbox process ("start" = before the job, "push" = before the push). */
  sandboxAliveAt: "start" | "push" | undefined;
  dirty = false;

  constructor(
    private readonly script: readonly string[],
    private readonly options: { readonly hang?: boolean; readonly startFails?: boolean } = {},
  ) {}

  async reset(): Promise<void> {
    this.log.push(this.running ? "destroyed" : "reset-none");
    this.running = false;
  }

  async assertClean(): Promise<void> {
    this.log.push("clean-check");
    if (this.dirty) {
      throw new Error("the gate container is not clean before the job (work_entries=1)");
    }
  }

  async assertNoSandboxProcesses(): Promise<void> {
    const at = this.egress.length === 0 ? "start" : "push";
    this.log.push(`sandbox-check@${at}`);
    if (this.sandboxAliveAt === at) {
      throw new Error("a sandbox process is alive (sandbox_processes=1)");
    }
  }

  async ensureRunning(): Promise<void> {
    if (this.options.startFails) {
      throw new Error("no container");
    }
    this.log.push(this.running ? "already-running" : "started");
    this.running = true;
  }

  async setEgress(p: GateEgressProps): Promise<void> {
    this.egress.push(p);
    this.log.push(`egress:${p.phase}`);
  }

  async spawn(argv: readonly string[], env: Readonly<Record<string, string>>): Promise<GateProcess> {
    this.spawned.push({ argv, env });
    const self = this;
    // Lines written to stdin, consumed in order by the scripted CLI.
    let received = 0;
    let consumed = 0;
    let wake: (() => void) | undefined;
    const waitInput = async (): Promise<void> => {
      while (received <= consumed) {
        await new Promise<void>((resolve) => (wake = resolve));
      }
      consumed += 1;
    };
    const lines = (async function* () {
      await waitInput(); // the job line
      for (const line of self.script) {
        self.log.push(`print:${line.slice(0, 20)}`);
        yield line;
        if (line.startsWith("@@scf phase")) {
          await waitInput(); // its acknowledgement
        }
      }
      if (self.options.hang) {
        await new Promise(() => undefined);
      }
    })();
    return {
      lines,
      async writeLine(line: string) {
        self.stdin.push(line);
        self.log.push(`stdin:${line.slice(0, 20)}`);
        received += 1;
        wake?.();
      },
      async closeInput() {},
      exitCode: Promise.resolve(0),
      kill() {
        self.killed = true;
      },
    };
  }
}

const drive = (port: GateContainerPort, deadlineMs = 60_000) =>
  driveGateJob(port, { job: JOB, artifactsHost: HOST, registryHost: "registry.npmjs.org", repos: TOKENS, deadlineMs, now: () => 0 });

describe("gate job driver", () => {
  it("moves the egress policy before acknowledging each phase, then closes it", async () => {
    const port = new FakeContainer([phaseLine("fetch"), phaseLine("deps"), phaseLine("gate"), phaseLine("push"), resultLine(RESULT)]);
    const outcome = await drive(port);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual(RESULT);
    expect(outcome.phases.map((p) => `${p.phase}:${p.egress}`)).toEqual([
      "fetch:artifacts-only",
      "deps:registry-only",
      "gate:deny-all",
      "push:artifacts-only",
      "closed:deny-all",
    ]);
    // Each acknowledgement is written only after its policy is in force.
    const order = port.log.filter((l) => /^(egress:|stdin:ack|started|destroyed|reset-none|clean-check|sandbox-check)/.test(l));
    expect(order).toEqual([
      "reset-none",
      "started",
      "clean-check",
      "sandbox-check@start",
      "egress:fetch",
      "stdin:ack fetch",
      "egress:deps",
      "stdin:ack deps",
      "egress:gate",
      "stdin:ack gate",
      "sandbox-check@push",
      "egress:push",
      "stdin:ack push",
      "egress:closed",
      "destroyed",
    ]);
    // Tokens are only in the fetch/push policies, never anywhere the container sees.
    expect(port.egress.find((p) => p.phase === "gate")?.repos).toEqual({});
    expect(port.egress.find((p) => p.phase === "deps")?.repos).toEqual({});
    const seen = JSON.stringify({ spawned: port.spawned, stdin: port.stdin });
    expect(seen).not.toContain("write-token-integration");
    expect(seen).not.toContain("read-token-agent");
    expect(port.spawned[0]!.argv.slice(0, 3)).toEqual(["timeout", "--kill-after=5", "60"]);
  });

  it("refuses a phase that moves backwards (and closes the egress)", async () => {
    const port = new FakeContainer([phaseLine("fetch"), phaseLine("gate"), phaseLine("deps"), resultLine(RESULT)]);
    const outcome = await drive(port);
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toMatch(/from gate back to deps: refused/);
    expect(port.egress.at(-1)?.phase).toBe("closed");
    expect(port.stdin).not.toContain("ack deps");
  });

  it("reports a malformed result and a job that ends without one", async () => {
    const malformed = await drive(new FakeContainer([phaseLine("fetch"), '@@scf result {"version":1,"kind":"integrate","outcome":"gated"}']));
    expect(malformed.error).toMatch(/malformed/);
    const silent = await drive(new FakeContainer([phaseLine("fetch")]));
    expect(silent.error).toMatch(/ended without a result/);
  });

  it("stops a job that passes its deadline and closes the egress", async () => {
    const port = new FakeContainer([phaseLine("fetch"), phaseLine("deps")], { hang: true });
    const started = Date.now();
    const outcome = await driveGateJob(port, { job: JOB, artifactsHost: HOST, registryHost: "registry.npmjs.org", repos: TOKENS, deadlineMs: -9_950 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome.error).toMatch(/did not finish/);
    expect(port.killed).toBe(true);
    expect(port.egress.at(-1)?.phase).toBe("closed");
  });

  it("reports a container that does not start", async () => {
    const outcome = await drive(new FakeContainer([], { startFails: true }));
    expect(outcome.error).toMatch(/the gate container failed: no container/);
  });

  it("never opens the push phase while a sandbox process is alive, and still discards the container", async () => {
    const port = new FakeContainer([phaseLine("fetch"), phaseLine("deps"), phaseLine("gate"), phaseLine("push"), resultLine(RESULT)]);
    port.sandboxAliveAt = "push";
    const outcome = await drive(port);
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toMatch(/containment failed before the push phase: a sandbox process is alive/);
    expect(port.egress.map((p) => p.phase)).toEqual(["fetch", "deps", "gate", "closed"]);
    expect(port.stdin).not.toContain("ack push");
    expect(port.log.at(-1)).toBe("destroyed");
  });

  it("refuses to start a job in a container that is not clean (no egress opens)", async () => {
    const port = new FakeContainer([phaseLine("fetch"), resultLine(RESULT)]);
    port.dirty = true;
    const outcome = await drive(port);
    expect(outcome.error).toMatch(/not clean before the job/);
    expect(port.egress.map((p) => p.phase)).toEqual(["closed"]);
    expect(port.spawned).toHaveLength(0);
  });

  it("discards the container after a job that hung past its deadline", async () => {
    const port = new FakeContainer([phaseLine("fetch"), phaseLine("deps"), phaseLine("gate")], { hang: true });
    const outcome = await driveGateJob(port, { job: JOB, artifactsHost: HOST, registryHost: "registry.npmjs.org", repos: TOKENS, deadlineMs: -9_950 });
    expect(outcome.error).toMatch(/did not finish/);
    expect(port.log.at(-1)).toBe("destroyed");
    expect(port.running).toBe(false);
    // The next job starts a fresh container, not the one the hung job ran in.
    const next = await drive(new FakeContainer([phaseLine("fetch"), resultLine(RESULT)]));
    expect(next.error).toBeUndefined();
  });

  it("bounds the CLI with timeout(1)", () => {
    expect(cliArgv(61_000).slice(0, 4)).toEqual(["timeout", "--kill-after=5", "61", "node"]);
  });
});

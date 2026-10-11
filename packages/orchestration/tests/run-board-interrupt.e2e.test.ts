/**
 * An interrupted board run (the CLI aborts its signal on SIGINT/SIGTERM) ends
 * honestly and still cleans up: the agent phase ends with stop reason
 * "interrupted", no new integration starts, an in-flight integration is
 * bounded by the grace period, the verdict is only what was gated (never
 * verified from an integration the run did not see settle), and every repo
 * the run created is archived. A real CLI process is interrupted too: the
 * first SIGINT runs the ending and cleanup (exit 130), a second exits at once.
 * Offline: the local control, the deterministic policy, and fake gates.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

import { runBoardOffline } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, type BoardRunEvent } from "../src/run-board.ts";

const git = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const GOAL_FILE = join(REPO_ROOT, "examples/goals/audit-logging.goal.txt");
const PROJECT = join(REPO_ROOT, "examples/demo-project");
const GOAL = "Add audit logging to every module";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-interrupt-"));
  made.push(dir);
  return dir;
}

/** Every repo the run created (the agents' and the tool bench's) is in cleanedUp. */
function archivedEveryAgentRepo(result: Awaited<ReturnType<typeof runBoardOffline>>): void {
  const repos = result.agents.flatMap((a) => (a.workspace !== undefined ? [a.workspace] : []));
  expect(repos.length).toBeGreaterThan(0);
  for (const repo of repos) {
    expect(result.cleanedUp).toContain(repo);
  }
}

describe("an interrupted board run", () => {
  it("stops after the revision in flight: stop reason interrupted, no new integration, verdict of what was gated, repos archived", async () => {
    const controller = new AbortController();
    const events: BoardRunEvent[] = [];
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir: PROJECT,
      fixtureGate: true,
      resolveContract: async () => "reject",
      workRoot: await scratch(),
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        // Interrupt as soon as the first revision is recorded (the fixture fails it).
        if (e.kind === "integrated") {
          controller.abort();
        }
      },
    });
    expect(result.stopReason).toBe("interrupted");
    expect(result.stopDetail).toMatch(/the operator interrupted the run: no new turns and no new integration/);
    // The first revision failed and nothing was integrated after the interrupt.
    expect(result.revisions.map((r) => r.gate)).toEqual(["fail"]);
    expect(result.verdict).toBe("failed");
    expect(result.promotion?.committed).toBe(false);
    archivedEveryAgentRepo(result);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("agents-done")).toBeLessThan(kinds.indexOf("cleaned-up"));
    expect(kinds).toContain("integration-verdict");
    expect(formatBoardRunSummary(result)).toMatch(/agent phase ended: interrupted/);
  }, 120_000);

  it("an integration still running when the grace period ends is never verified, even if it later passes", async () => {
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => {
      release = r;
    });
    // Passes every run; the first integrated revision's gate interrupts the run and outlasts the grace period.
    const slow: CommandRunner = {
      async run(_argv, cwd): Promise<CommandOutcome> {
        const { stdout } = await git("git", ["-C", cwd, "diff", "--name-only", "HEAD~1", "HEAD"]).catch(() => ({ stdout: "" }));
        if (stdout.trim() !== "" && !controller.signal.aborted) {
          controller.abort();
          await released;
        }
        return { code: 0, stdout: "ok 1 - gate\n", stderr: "" };
      },
    };
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir: PROJECT,
      appGateCommand: ["gate"],
      verifyCommandRunner: slow,
      resolveContract: async () => "reject",
      workRoot: await scratch(),
      signal: controller.signal,
      interruptGraceMs: 200,
    });
    release();
    expect(result.stopReason).toBe("interrupted");
    expect(result.verdict).toBe("failed");
    expect(result.partial).toMatch(/interrupted while an integration was still in flight \(not settled within 200 ms\)/);
    expect(result.promotion?.committed ?? false).toBe(false);
    archivedEveryAgentRepo(result);
  }, 120_000);
});

/**
 * Spawn the CLI offline; send SIGINT once its header is printed and, with
 * `signals` 2, again once it acknowledged the first (two signals sent at once
 * may reach the process as one).
 */
function interruptCli(signals: number, tmp: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, SCF_ENV_FILE: "/dev/null" };
  for (const key of ["EXECUTOR", "CLOUDFLARE_AI_GATEWAY_URL", "CLOUDFLARE_AI_GATEWAY_TOKEN", "SWITCHYARD_API_TOKEN"]) {
    delete env[key];
  }
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
      CLI,
      "run-board",
      "--offline",
      "--fixture-gate",
      "--decide-contracts",
      "reject",
      "--goal-file",
      GOAL_FILE,
      "--project",
      PROJECT,
    ],
    { cwd: REPO_ROOT, env },
  );
  let stdout = "";
  let stderr = "";
  let sent = 0;
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += String(chunk);
    // The CLI installs its signal handler before it prints the header.
    if (sent === 0 && stdout.includes("  dial: ")) {
      sent = 1;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
    if (sent === 1 && signals > 1 && stderr.includes("SIGINT: interrupting the run")) {
      sent = 2;
      child.kill("SIGINT");
    }
  });
  return new Promise((done) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

describe("run-board at the CLI", () => {
  it("the first SIGINT ends the run honestly and cleans up (exit 130)", async () => {
    const tmp = await scratch();
    const { code, stdout, stderr } = await interruptCli(1, tmp);
    expect(stderr).toContain("SIGINT: interrupting the run");
    expect(stdout).toMatch(/agent phase ended: interrupted/);
    expect(stdout).not.toMatch(/verdict: verified/);
    expect(code).toBe(130);
    const line = stdout.split("\n").find((l) => l.startsWith("work root removed: "));
    expect(line).toBeDefined();
    const root = /^work root removed: (\S+)/.exec(line!)![1]!;
    expect(
      await stat(root).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }, 130_000);

  it("a second SIGINT exits at once without the ending", async () => {
    const tmp = await scratch();
    const { code, stdout, stderr } = await interruptCli(2, tmp);
    expect(stderr).toContain("SIGINT again: exiting now without cleanup");
    expect(code).toBe(130);
    expect(stdout).not.toMatch(/agent phase ended/);
  }, 130_000);
});

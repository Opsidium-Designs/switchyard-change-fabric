/**
 * The --speculate flag at the real CLI entrypoint: speculative batch gating is
 * a local-integrator feature, so `run-board --integrator cloud --speculate K`
 * with K above 1 is refused clearly before anything touches the Worker (the
 * cloud integration Workflow gates one revision at a time), and an
 * out-of-range K is refused too. Spawns the actual CLI with the gateway env
 * stripped against an unreachable loopback port, so the test stays offline.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const PROJECT = resolve(REPO_ROOT, "examples/demo-project");
const DEAD_WORKER = "http://127.0.0.1:9";

function runCli(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_ENV_FILE: "/dev/null" };
  for (const key of ["EXECUTOR", "CLOUDFLARE_AI_GATEWAY_URL", "CLOUDFLARE_AI_GATEWAY_TOKEN", "SWITCHYARD_API_TOKEN"]) {
    delete env[key];
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", CLI, ...args],
      { cwd: REPO_ROOT, env, timeout: 60_000 },
      (error, _stdout, stderr) => resolvePromise({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stderr: String(stderr) }),
    );
  });
}

describe("run-board --speculate", () => {
  it("refuses speculation above 1 with the cloud integrator, before any Worker call", async () => {
    const { code, stderr } = await runCli(["run-board", "add audit logging", "--project", PROJECT, "--worker", DEAD_WORKER, "--integrator", "cloud", "--speculate", "2"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--speculate above 1 needs the local integrator: the cloud integration Workflow gates one revision at a time");
  });

  it("refuses a speculation outside 1 to 8", async () => {
    const { code, stderr } = await runCli(["run-board", "add audit logging", "--project", PROJECT, "--offline", "--speculate", "9"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--speculate must be an integer from 1 to 8");
  });
});

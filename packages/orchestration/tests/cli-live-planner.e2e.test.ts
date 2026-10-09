/**
 * The live-planner rule at the real CLI entrypoints. On a live goal-driven run
 * (run-live, recruit-live) the LLM is the planner, so with no live gateway
 * planner configured the command must FAIL before it touches the Worker, unless
 * the operator explicitly passes --allow-heuristic-planner (then a loud banner
 * prints). This spawns the actual CLI with the gateway env stripped; the refusal
 * happens before any network call, and the opt-in case points at an unreachable
 * loopback port, so the test stays offline.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const PROJECT = resolve(REPO_ROOT, "examples/calc-project");
// A loopback port nothing listens on: any Worker call fails fast, offline.
const DEAD_WORKER = "http://127.0.0.1:9";

/** Run the CLI with no executor/gateway env; resolve its exit code and output. */
function runCli(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  // No .env either: the CLI reads it into memory itself, so point it at an empty file.
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_ENV_FILE: "/dev/null" };
  for (const key of [
    "EXECUTOR",
    "CLOUDFLARE_AI_GATEWAY_URL",
    "CLOUDFLARE_AI_GATEWAY_TOKEN",
    "SWITCHYARD_API_TOKEN",
  ]) {
    delete env[key];
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", CLI, ...args],
      { cwd: REPO_ROOT, env, timeout: 60_000 },
      (error, _stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolvePromise({ code, stderr: String(stderr) });
      },
    );
  });
}

describe("live goal-driven commands refuse the silent heuristic planner", () => {
  for (const command of ["recruit-live", "run-live"]) {
    it(`${command} fails with a clear error when no LLM planner is available`, async () => {
      const { code, stderr } = await runCli([
        command,
        "add input validation",
        "--project",
        PROJECT,
        "--worker",
        DEAD_WORKER,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("a live run needs the LLM planner");
      expect(stderr).toContain("--allow-heuristic-planner");
    });
  }

  it("recruit-live proceeds past the planner check with --allow-heuristic-planner and prints a loud banner", async () => {
    const { stderr } = await runCli([
      "recruit-live",
      "add input validation",
      "--project",
      PROJECT,
      "--worker",
      DEAD_WORKER,
      "--allow-heuristic-planner",
    ]);
    expect(stderr).toContain("HEURISTIC PLANNER IN USE ON A LIVE RUN");
    expect(stderr).not.toContain("a live run needs the LLM planner");
  });
});

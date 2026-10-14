/**
 * Local CLI inference at the real CLI entrypoint, offline: `--inference` is
 * validated strictly and overrides SWITCHYARD_INFERENCE; env-check
 * in CLI mode does not ask for the AI Gateway URL or token; a live run-board in
 * CLI mode refuses to start (before anything is created) when the CLI is
 * missing or not logged in, and codex-cli does the same for the codex binary. A
 * fake CLI script stands in for `claude`; the Worker is an unreachable
 * loopback port, so nothing touches the network.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isCredentialKey } from "../src/credentials.ts";
import { makeFakeCli, type FakeCli } from "./fake-cli.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const PROJECT = resolve(REPO_ROOT, "examples/demo-project");
const DEAD_WORKER = "http://127.0.0.1:9";
const STRIPPED = [
  "EXECUTOR",
  "SWITCHYARD_INFERENCE",
  "CLAUDE_CLI_BIN",
  "CLI_JEV",
  "CLOUDFLARE_AI_GATEWAY_URL",
  "CLOUDFLARE_AI_GATEWAY_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CF_AIG_GATEWAY_ID",
  "SWITCHYARD_API_TOKEN",
];

let dir: string;
let fake: FakeCli;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scf-cli-inference-e2e-"));
  fake = await makeFakeCli();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(fake.dir, { recursive: true, force: true });
});

async function envFile(name: string, lines: readonly string[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

function runCli(args: readonly string[], envFilePath = "/dev/null"): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_ENV_FILE: envFilePath };
  for (const key of Object.keys(env)) {
    // No credential in the CLI's own environment (env-check fails on one).
    if (STRIPPED.includes(key) || isCredentialKey(key)) {
      delete env[key];
    }
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", CLI, ...args],
      { cwd: REPO_ROOT, env, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe("--inference and SWITCHYARD_INFERENCE at the CLI", () => {
  it("env-check in CLI mode passes without any AI Gateway variable and says they are not needed", async () => {
    const file = await envFile("cli.env", ["SWITCHYARD_INFERENCE=claude-cli"]);
    const { code, stdout } = await runCli(["env-check"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("inference: claude-cli");
    expect(stdout).toContain("no AI Gateway URL or token is needed");
  });

  it("the --inference flag overrides the environment", async () => {
    const file = await envFile("gw.env", ["SWITCHYARD_INFERENCE=gateway"]);
    const { code, stdout } = await runCli(["env-check", "--inference", "claude-cli"], file);
    expect(code).toBe(0);
    expect(stdout).toContain("inference: claude-cli");
  });

  it("refuses an unknown --inference value, a missing value, an inline value, and a command that calls no model", async () => {
    const bad = await runCli(["run-board", "goal", "--project", PROJECT, "--worker", DEAD_WORKER, "--inference", "claude"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--inference must be one of gateway, claude-cli, codex-cli");
    const missing = await runCli(["run-board", "goal", "--project", PROJECT, "--inference"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--inference needs a value");
    const inline = await runCli(["run-board", "goal", "--project", PROJECT, "--inference=claude-cli"]);
    expect(inline.code).toBe(1);
    expect(inline.stderr).toContain("--inference=<value> is not supported");
    const offline = await runCli(["recruit", "goal", "--project", PROJECT, "--inference", "claude-cli"]);
    expect(offline.code).toBe(1);
    expect(offline.stderr).toContain("--inference applies only to the commands that call a model");
  });

  it("a live run-board in CLI mode refuses to start when the CLI binary is missing", async () => {
    const file = await envFile("missing.env", [`CLAUDE_CLI_BIN=${join(dir, "no-such-claude")}`]);
    const { code, stderr, stdout } = await runCli(["run-board", "add validation", "--project", PROJECT, "--worker", DEAD_WORKER, "--inference", "claude-cli"], file);
    expect(code).toBe(1);
    expect(stderr).toContain("the local claude CLI is not ready");
    expect(stderr).toContain("was not found");
    expect(stdout).not.toContain("Board run for");
  });

  it("a live run-board in CLI mode refuses to start when the CLI is not logged in", async () => {
    await fake.set({ auth: { stdout: JSON.stringify({ loggedIn: false }) } });
    const file = await envFile("loggedout.env", ["SWITCHYARD_INFERENCE=claude-cli", `CLAUDE_CLI_BIN=${fake.bin}`]);
    const { code, stderr, stdout } = await runCli(["run-board", "add validation", "--project", PROJECT, "--worker", DEAD_WORKER], file);
    expect(code).toBe(1);
    expect(stderr).toContain("is not logged in");
    expect(stdout).not.toContain("Board run for");
  });

  it("a live run-board with codex-cli refuses to start when the codex binary is missing", async () => {
    const file = await envFile("missing-codex.env", [`CODEX_CLI_BIN=${join(dir, "no-such-codex")}`]);
    const { code, stderr, stdout } = await runCli(["run-board", "add validation", "--project", PROJECT, "--worker", DEAD_WORKER, "--inference", "codex-cli"], file);
    expect(code).toBe(1);
    expect(stderr).toContain("the local codex CLI is not ready");
    expect(stderr).toContain("was not found");
    expect(stdout).not.toContain("Board run for");
  });
});

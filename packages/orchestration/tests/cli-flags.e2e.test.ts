/**
 * Flag validation at the real CLI entrypoint: an inline `--flag=value` (which
 * the CLI would otherwise ignore without a word) and a known flag with no
 * value are refused clearly; the dial is integers 1 <= min <= max <= 16; the
 * numeric caps and prices are never coerced (NaN, a bad price, a duplicate);
 * `--token-ttl` is an integer from 60 to 3600 s; and `--max-spend-usd` is
 * refused unless every model the run calls has a `--price`. Spawns the actual
 * CLI against an unreachable loopback port with a fake gateway configuration
 * (every refusal happens before any network call), so the test stays offline.
 */

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const PROJECT = resolve(REPO_ROOT, "examples/demo-project");
const DEAD_WORKER = "http://127.0.0.1:9";
const STRIPPED = [
  "EXECUTOR",
  "CLOUDFLARE_AI_GATEWAY_URL",
  "CLOUDFLARE_AI_GATEWAY_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CF_AIG_GATEWAY_ID",
  "SWITCHYARD_API_TOKEN",
  "AI_GATEWAY_MODEL",
  "AI_GATEWAY_ESCALATION_MODEL",
  "AI_GATEWAY_ESCALATION_MODELS",
  "AI_GATEWAY_PLANNER_MODEL",
  "AI_GATEWAY_PLANNER_ESCALATION_MODELS",
  "AGENT_TURN_MODEL",
];

let liveEnvFile: string;

beforeAll(async () => {
  // A fake gateway configuration (no account id, so the decision model stays
  // off): enough for the live run-board path to select its models; the
  // refusals under test all happen before anything is called.
  const dir = await mkdtemp(join(tmpdir(), "scf-cli-flags-"));
  liveEnvFile = join(dir, "fake.env");
  await writeFile(
    liveEnvFile,
    [
      "EXECUTOR=ai-gateway",
      "CLOUDFLARE_AI_GATEWAY_URL=http://127.0.0.1:9/v1/account/gateway",
      "CLOUDFLARE_AI_GATEWAY_TOKEN=fake-test-token",
      "AI_GATEWAY_MODEL=base-m",
      "AI_GATEWAY_ESCALATION_MODELS=esc-m",
      "",
    ].join("\n"),
  );
});

function runCli(args: readonly string[], envFile = "/dev/null"): Promise<{ code: number; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_ENV_FILE: envFile };
  for (const key of STRIPPED) {
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

const offline = (...extra: string[]) => ["run-board", "add audit logging", "--project", PROJECT, "--offline", ...extra];
const live = (...extra: string[]) => ["run-board", "add audit logging", "--project", PROJECT, "--worker", DEAD_WORKER, ...extra];

describe("CLI flag validation", () => {
  it("refuses an inline --flag=value, a value given to a boolean flag, and a known flag with no value", async () => {
    const inline = await runCli(offline("--max=3"));
    expect(inline.code).toBe(1);
    expect(inline.stderr).toContain("--max=<value> is not supported: pass --max <value> as two arguments");
    const ttl = await runCli(offline("--token-ttl=900"));
    expect(ttl.code).toBe(1);
    expect(ttl.stderr).toContain("--token-ttl=<value> is not supported");
    const boolean = await runCli(["run-board", "add audit logging", "--project", PROJECT, "--offline=yes"]);
    expect(boolean.code).toBe(1);
    expect(boolean.stderr).toContain("--offline=<value> is not supported");
    const last = await runCli(offline("--min"));
    expect(last.code).toBe(1);
    expect(last.stderr).toContain("--min needs a value: pass --min <value>");
    const swallowed = await runCli(offline("--max-calls", "--lockstep"));
    expect(swallowed.code).toBe(1);
    expect(swallowed.stderr).toContain("--max-calls needs a value");
  });

  it("the dial is integers 1 <= min <= max <= 16", async () => {
    for (const [args, message] of [
      [["--min", "4", "--max", "2"], "--min (4) must not exceed --max (2)"],
      [["--max", "17"], "--max must be an integer from 1 to 16"],
      [["--min", "0"], "--min must be an integer from 1 to 16"],
      [["--min", "abc"], "--min must be an integer from 1 to 16"],
      [["--max", "2.5"], "--max must be an integer from 1 to 16"],
    ] as const) {
      const { code, stderr } = await runCli(offline(...args));
      expect(code).toBe(1);
      expect(stderr).toContain(message);
    }
  });

  it("numeric caps and prices are never coerced: NaN, a bad price, and a duplicate price are refused", async () => {
    const nan = await runCli(offline("--max-calls", "NaN"));
    expect(nan.code).toBe(1);
    expect(nan.stderr).toContain('--max-calls must be a positive integer (got "NaN")');
    const window = await runCli(offline("--rate-limit-window-ms", "0"));
    expect(window.code).toBe(1);
    expect(window.stderr).toContain('--rate-limit-window-ms must be a positive integer (got "0")');
    const spend = await runCli(offline("--max-spend-usd", "Infinity"));
    expect(spend.code).toBe(1);
    expect(spend.stderr).toContain("--max-spend-usd must be a positive number");
    const price = await runCli(offline("--price", "m=1/x"));
    expect(price.code).toBe(1);
    expect(price.stderr).toContain("--price m: the output price must be a finite, non-negative number");
    const twice = await runCli(offline("--price", "m=1/2", "--price", "m=1/2"));
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain("--price m is given more than once");
  });

  it("--token-ttl is an integer from 60 to 3600 seconds", async () => {
    for (const value of ["30", "3601", "abc", "90.5"]) {
      const { code, stderr } = await runCli(live("--token-ttl", value), liveEnvFile);
      expect(code).toBe(1);
      expect(stderr).toContain("--token-ttl must be an integer number of seconds from 60 to 3600");
    }
  });

  it("--max-spend-usd is refused unless every model the run calls has a price, naming the unpriced ones", async () => {
    const { code, stderr } = await runCli(live("--max-spend-usd", "5", "--price", "base-m=0.15/0.6"), liveEnvFile);
    expect(code).toBe(1);
    expect(stderr).toContain("--max-spend-usd needs a --price for every model this run calls; unpriced:");
    expect(stderr).toContain("esc-m");
    expect(stderr).not.toMatch(/unpriced:[^\n]*base-m/);
  });
});

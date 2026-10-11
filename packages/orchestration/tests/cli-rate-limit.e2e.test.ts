/**
 * --require-model-plan at the real CLI entrypoint: a live board run plans
 * BEFORE anything is created and refuses to start (exit 1, no Change, no
 * repos) when no model produced a plan. Here every planner call is answered
 * HTTP 429 by a fake gateway on a loopback port, so the refusal and the loud
 * fall-back banner both say every planner call was rate limited. The Worker
 * URL is an unreachable loopback port the CLI never gets to. Offline: the
 * fake gateway is a local HTTP server in this process.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  "AI_GATEWAY_AGENT_MODEL",
  "AI_GATEWAY_PLANNER_MODEL",
  "AI_GATEWAY_ESCALATION_MODEL",
  "AI_GATEWAY_ESCALATION_MODELS",
];

let server: Server;
let dir: string;
let envFile: string;
const seen: string[] = [];

beforeAll(async () => {
  // The fake gateway: every call is refused with the provider's rate limit.
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      seen.push(String((JSON.parse(body || "{}") as { model?: string }).model));
      res.writeHead(429, { "retry-after": "30", "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit reached" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  dir = await mkdtemp(join(tmpdir(), "scf-cli-rate-limit-"));
  envFile = join(dir, "fake.env");
  await writeFile(
    envFile,
    [
      "EXECUTOR=ai-gateway",
      `CLOUDFLARE_AI_GATEWAY_URL=http://127.0.0.1:${port}/v1/account/gateway`,
      "CLOUDFLARE_AI_GATEWAY_TOKEN=fake-test-token",
      "AI_GATEWAY_MODEL=gpt-4o",
      "AI_GATEWAY_ESCALATION_MODELS=gpt-4.1,gpt-5",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

function runCli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_ENV_FILE: envFile };
  for (const key of STRIPPED) {
    delete env[key];
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", CLI, ...args],
      { cwd: REPO_ROOT, env, timeout: 60_000 },
      (error, stdout, stderr) =>
        resolvePromise({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

const live = (...extra: string[]) => ["run-board", "add audit logging", "--project", PROJECT, "--worker", DEAD_WORKER, ...extra];

describe("--require-model-plan", () => {
  it("refuses to start when every planner call is rate limited, saying so in the banner and the error", async () => {
    const { code, stdout, stderr } = await runCli(live("--require-model-plan"));
    expect(code).toBe(1);
    expect(seen).toEqual(["gpt-4o", "gpt-4.1", "gpt-5"]);
    expect(stderr).toContain("PLANNER FELL BACK TO THE HEURISTIC DECOMPOSITION");
    expect(stderr).toContain("All planner calls were rate limited (HTTP 429) on gpt-4o, gpt-4.1, gpt-5");
    expect(stderr).toContain(
      "Error: --require-model-plan: the planner produced no plan (all planner calls were rate limited (HTTP 429): the provider's rate or quota limit), and a heuristic plan was refused",
    );
    expect(stderr).toContain("Nothing was created");
    expect(stderr).not.toContain("fake-test-token");
    // It stopped before the run header: no Change, no Worker call.
    expect(stdout).not.toContain("Board run for");
  });

  it("conflicts with --allow-heuristic-planner", async () => {
    const { code, stderr } = await runCli(live("--require-model-plan", "--allow-heuristic-planner"));
    expect(code).toBe(1);
    expect(stderr).toContain("--require-model-plan refuses a heuristic plan, --allow-heuristic-planner allows one");
  });
});

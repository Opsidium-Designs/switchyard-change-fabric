/**
 * The local CLI transport (Claude Code), offline: a fake CLI script records
 * how it was spawned and answers with canned JSON. Covers the hardened spawn
 * (tools off, no session, no settings, strict MCP, the schema, an allowlisted
 * env with no credential, an empty temp cwd removed after), the result
 * mapping (structured output, text, usage, truncation), the error
 * classification (usage/rate limit, not logged in, missing binary, garbled
 * output, timeout), and the executor, planner, agent turn, and tool filler
 * running over it.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_ACTION_TYPES,
  callCliJsonSchema,
  CLI_ENV_ALLOWLIST,
  cliDriverFor,
  CliAuthError,
  CliNotFoundError,
  cliStdinPrompt,
  createAgentTurnInvoke,
  createClaudeCliDriver,
  createCliInvoke,
  createCliJsonSchemaCaller,
  createPlannerInvoke,
  createToolRegionFiller,
  isModelBudgetError,
  isRateLimitError,
  parseCliResetMs,
  parseInferenceMode,
  PlannerResponseError,
  probeCli,
  RateLimitError,
  runCli,
  UnusableModelOutputError,
  WorkersAiExecutor,
  WorkersAiTimeoutError,
  type AgentTurnInput,
} from "../src/index.ts";
import { claudeResult, makeFakeCli, type FakeCli } from "./fake-cli.ts";

let fake: FakeCli;
let tmpRoot: string;

beforeEach(async () => {
  fake = await makeFakeCli();
  tmpRoot = await mkdtemp(join(tmpdir(), "scf-cli-root-"));
});

afterEach(async () => {
  await rm(fake.dir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
});

/** A source environment carrying credentials that must never reach the CLI. */
const SOURCE_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/home/someone",
  USER: "someone",
  LANG: "C.UTF-8",
  CLAUDE_CONFIG_DIR: "/home/someone/.claude",
  CLOUDFLARE_API_TOKEN: "cf-secret",
  CLOUDFLARE_ACCOUNT_ID: "acct-secret",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "gw-secret",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.example/v1/acct/gw",
  GITLAB_TOKEN: "gl-secret",
  SWITCHYARD_API_TOKEN: "sy-secret",
  ANTHROPIC_API_KEY: "sk-secret",
};

const SCHEMA = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

describe("runCli over the Claude driver (fake CLI)", () => {
  it("spawns with tools off, no session, no settings, strict MCP, the schema and model; an allowlisted env; an empty temp cwd removed after", async () => {
    await fake.set({ calls: [{ stdout: claudeResult({ result: '{"ok":true}', structured_output: { ok: true } }) }] });
    const driver = createClaudeCliDriver({ bin: fake.bin });
    const result = await runCli(
      driver,
      {
        model: "sonnet",
        messages: [
          { role: "system", content: "SYSTEM ONE" },
          { role: "system", content: "SYSTEM TWO" },
          { role: "user", content: "the user prompt" },
        ],
        schema: SCHEMA,
      },
      { sourceEnv: SOURCE_ENV, tmpRoot, timeoutMs: 20_000 },
    );
    expect(result.structured).toEqual({ ok: true });
    const [call] = await fake.calls();
    expect(call).toBeDefined();
    const argv = call!.argv;
    expect(argv[0]).toBe("-p");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("SYSTEM ONE\n\nSYSTEM TWO");
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!)).toEqual(SCHEMA);
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    // The prompt went to stdin, verbatim (one user message).
    expect(call!.stdin).toBe("the user prompt");
    // Only allowlisted names reach the CLI; no credential does.
    for (const key of Object.keys(call!.env)) {
      expect(CLI_ENV_ALLOWLIST).toContain(key);
    }
    expect(call!.env.CLAUDE_CONFIG_DIR).toBe("/home/someone/.claude");
    const serialized = JSON.stringify(call!.env);
    for (const secret of ["cf-secret", "acct-secret", "gw-secret", "gl-secret", "sy-secret", "sk-secret", "gateway.example"]) {
      expect(serialized).not.toContain(secret);
    }
    // The cwd was a fresh, empty dir under the temp root, and it is gone now.
    expect(call!.cwd.startsWith(tmpRoot)).toBe(true);
    expect(call!.cwdEntries).toEqual([]);
    expect(existsSync(call!.cwd)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("serializes a multi-turn history with role headers, in order", () => {
    expect(
      cliStdinPrompt([
        { role: "system", content: "s" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    ).toBe("=== USER ===\nfirst\n\n=== ASSISTANT ===\nreply\n\n=== USER ===\nsecond");
  });

  it("maps a 429 result to a RateLimitError carrying the reset delay", async () => {
    await fake.set({
      calls: [{ stdout: claudeResult({ subtype: "error_during_execution", is_error: true, api_error_status: 429, result: "API Error: 429 rate limited, try again in 20 seconds" }) }],
    });
    const error = await runCli(createClaudeCliDriver({ bin: fake.bin }), { model: "opus", messages: [{ role: "user", content: "x" }] }, { tmpRoot }).catch((e: unknown) => e);
    expect(isRateLimitError(error)).toBe(true);
    expect((error as RateLimitError).status).toBe(429);
    expect((error as RateLimitError).model).toBe("opus");
    expect((error as RateLimitError).retryAfterMs).toBe(20_000);
  });

  it("maps a subscription usage limit message (no status) to a RateLimitError with the parsed reset time", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const resetEpoch = Math.floor(now / 1000) + 3600;
    await fake.set({ calls: [{ stdout: claudeResult({ is_error: true, result: `Claude AI usage limit reached|${resetEpoch}` }) }] });
    const error = await runCli(createClaudeCliDriver({ bin: fake.bin, now: () => now }), { model: "sonnet", messages: [{ role: "user", content: "x" }] }, { tmpRoot }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(3_600_000);
  });

  it("parses reset times: epoch suffix, relative, and a clock time (the next one)", () => {
    const now = new Date(2026, 0, 1, 14, 0, 0).getTime();
    expect(parseCliResetMs("limit reached|" + String(Math.floor(now / 1000) + 60), now)).toBe(60_000);
    expect(parseCliResetMs("please try again in 5 minutes", now)).toBe(300_000);
    expect(parseCliResetMs("You've hit your limit, resets 3pm (America/Chicago)", now)).toBe(3_600_000);
    expect(parseCliResetMs("resets at 13:30", now)).toBe(23.5 * 3_600_000);
    expect(parseCliResetMs("usage limit reached", now)).toBeUndefined();
  });

  it("maps a not-logged-in result to a clear CliAuthError telling the operator to log in", async () => {
    await fake.set({ calls: [{ stdout: claudeResult({ is_error: true, result: "Not logged in · Please run /login" }) }] });
    const error = await runCli(createClaudeCliDriver({ bin: fake.bin }), { model: "sonnet", messages: [{ role: "user", content: "x" }] }, { tmpRoot }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliAuthError);
    expect((error as Error).message).toMatch(/run `claude`.*log in/);
  });

  it("maps a not-logged-in message on stderr with no JSON to a CliAuthError", async () => {
    await fake.set({ calls: [{ stderr: "Invalid API key · Please run /login\n", exit: 1 }] });
    await expect(runCli(createClaudeCliDriver({ bin: fake.bin }), { model: "sonnet", messages: [{ role: "user", content: "x" }] }, { tmpRoot })).rejects.toBeInstanceOf(CliAuthError);
  });

  it("reports a missing binary clearly (ENOENT) and still removes its temp cwd", async () => {
    const error = await runCli(createClaudeCliDriver({ bin: join(tmpRoot, "no-such-claude") }), { model: "sonnet", messages: [{ role: "user", content: "x" }] }, { tmpRoot }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliNotFoundError);
    expect((error as Error).message).toMatch(/was not found.*CLAUDE_CLI_BIN/);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("kills the CLI's whole process group on timeout", async () => {
    await fake.set({ calls: [{ hang: true }] });
    const started = Date.now();
    const error = await runCli(createClaudeCliDriver({ bin: fake.bin }), { model: "sonnet", messages: [{ role: "user", content: "x" }] }, { tmpRoot, timeoutMs: 1500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkersAiTimeoutError);
    expect(Date.now() - started).toBeLessThan(10_000);
    const [call] = await fake.calls();
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Give the kernel a moment to reap.
    for (let i = 0; i < 50 && (alive(call!.pid) || alive(call!.grandchild!)); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive(call!.pid)).toBe(false);
    expect(alive(call!.grandchild!)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("aborts on a signal", async () => {
    await fake.set({ calls: [{ hang: true }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const error = await runCli(createClaudeCliDriver({ bin: fake.bin }), { model: "sonnet", messages: [{ role: "user", content: "x" }] }, { tmpRoot, signal: controller.signal, timeoutMs: 20_000 }).catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
  });

  it("treats garbled or empty output as unusable model output", async () => {
    await fake.set({ calls: [{ stdout: "this is not json" }] });
    const driver = createClaudeCliDriver({ bin: fake.bin });
    await expect(runCli(driver, { model: "sonnet", messages: [{ role: "user", content: "x" }] }, { tmpRoot })).rejects.toBeInstanceOf(UnusableModelOutputError);
    // On a schema call the caller's own response error is thrown, like the gateway path.
    await expect(
      callCliJsonSchema(driver, { model: "sonnet", messages: [{ role: "user", content: "x" }], schemaName: "s", schema: SCHEMA, label: "plan", responseError: (m) => new PlannerResponseError(m) }, { tmpRoot }),
    ).rejects.toBeInstanceOf(PlannerResponseError);
  });

  it("returns structured_output, falling back to JSON reply text when there is none", async () => {
    const driver = createClaudeCliDriver({ bin: fake.bin });
    const request = { model: "sonnet", messages: [{ role: "user" as const, content: "x" }], schemaName: "s", schema: SCHEMA, label: "plan", responseError: (m: string) => new PlannerResponseError(m) };
    await fake.set({ calls: [{ stdout: claudeResult({ result: "ignored", structured_output: { ok: true } }) }, { stdout: claudeResult({ result: '```json\n{"ok":false}\n```' }) }, { stdout: claudeResult({ result: "prose only" }) }] });
    const first = await callCliJsonSchema(driver, request, { tmpRoot });
    expect(JSON.parse(first.content)).toEqual({ ok: true });
    expect(first.usage).toEqual({ inputTokens: 15, outputTokens: 5 });
    const second = await callCliJsonSchema(driver, request, { tmpRoot });
    expect(JSON.parse(second.content)).toEqual({ ok: false });
    await expect(callCliJsonSchema(driver, request, { tmpRoot })).rejects.toThrow(/no structured output/);
  });

  it("probes the version and the login state without reading the account", async () => {
    const driver = createClaudeCliDriver({ bin: fake.bin });
    await fake.set({});
    expect(await probeCli(driver, { tmpRoot })).toEqual({ ok: true, version: "2.1.295 (Claude Code)", loggedIn: true, authMethod: "claude.ai" });
    await fake.set({ auth: { stdout: JSON.stringify({ loggedIn: false }) } });
    const out = await probeCli(driver, { tmpRoot });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not logged in/);
    const missing = await probeCli(createClaudeCliDriver({ bin: join(tmpRoot, "nope") }), { tmpRoot });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/was not found/);
  });
});

describe("selection helpers", () => {
  it("parses the inference mode strictly; blank is the gateway", () => {
    expect(parseInferenceMode(undefined)).toBe("gateway");
    expect(parseInferenceMode(" Claude-CLI ")).toBe("claude-cli");
    expect(() => parseInferenceMode("claude")).toThrow(/must be one of gateway, claude-cli, codex-cli/);
  });

  it("refuses codex-cli clearly as not supported yet", () => {
    expect(() => cliDriverFor("codex-cli")).toThrow(/codex-cli is not supported yet/);
    expect(cliDriverFor("claude-cli", { claudeBin: "/x/claude" }).bin).toBe("/x/claude");
  });
});

describe("the existing seams over the CLI", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "scf-cli-wt-"));
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/add.ts"), "export const add = (a, b) => a + b;\n", "utf8");
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("the executor applies an anchored edit returned by the CLI, on the requested model", async () => {
    const edit = {
      commitMessage: "type add",
      edits: [{ path: "src/add.ts", search: "export const add = (a, b) => a + b;", replace: "export const add = (a: number, b: number) => a + b;" }],
    };
    await fake.set({ calls: [{ stdout: claudeResult({ result: JSON.stringify(edit) }) }] });
    const invoke = createCliInvoke(createClaudeCliDriver({ bin: fake.bin }), { tmpRoot });
    const executor = new WorkersAiExecutor({ model: "sonnet", invoke, providerLabel: "claude CLI" });
    const result = await executor.execute({ worktreeDir: worktree, workUnitId: "add", objective: "type add()", paths: ["src/add.ts"], baselineRef: "HEAD", model: "opus" });
    expect(result.status).toBe("changed");
    expect(await readFile(join(worktree, "src/add.ts"), "utf8")).toBe("export const add = (a: number, b: number) => a + b;\n");
    expect(result.cost.inputTokens).toBe(15);
    expect(result.cost.outputTokens).toBe(5);
    const [call] = await fake.calls();
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("opus");
    expect(call!.argv).not.toContain("--json-schema");
    expect(call!.stdin).toContain("export const add = (a, b) => a + b;");
  });

  it("a truncated CLI reply is a ModelBudgetError, never applied", async () => {
    await fake.set({ calls: [{ stdout: claudeResult({ result: '{"commitMessage":"x","edits":[', stop_reason: "max_tokens" }) }] });
    const invoke = createCliInvoke(createClaudeCliDriver({ bin: fake.bin }), { tmpRoot });
    const error = await new WorkersAiExecutor({ model: "sonnet", invoke, providerLabel: "claude CLI", maxRetries: 0 })
      .execute({ worktreeDir: worktree, workUnitId: "add", objective: "type add()", paths: ["src/add.ts"], baselineRef: "HEAD" })
      .catch((e: unknown) => e);
    expect(isModelBudgetError(error)).toBe(true);
    expect(await readFile(join(worktree, "src/add.ts"), "utf8")).toBe("export const add = (a, b) => a + b;\n");
  });

  it("the planner plans through the CLI JSON call", async () => {
    const plan = { units: [{ id: "u1", objective: "do it", paths: ["src/add.ts"], dependsOn: [] }], contracts: [], rationale: "one unit" };
    await fake.set({ calls: [{ stdout: claudeResult({ structured_output: plan }) }] });
    const invoke = createPlannerInvoke(createCliJsonSchemaCaller(createClaudeCliDriver({ bin: fake.bin }), { tmpRoot }));
    const out = await invoke({ model: "sonnet", messages: [{ role: "system", content: "plan" }, { role: "user", content: "goal" }] });
    expect(out.units.map((u) => u.id)).toEqual(["u1"]);
    expect(out.rationale).toBe("one unit");
    const [call] = await fake.calls();
    expect(JSON.parse(call!.argv[call!.argv.indexOf("--json-schema") + 1]!)).toHaveProperty("required", ["units", "contracts", "rationale"]);
  });

  const input: AgentTurnInput = {
    agent: "agent-1",
    role: "worker",
    goal: "do the thing",
    digest: { claims: [] },
    messages: [],
    capsule: { objective: "do the thing", constraints: [], decisions: [], evidence: [] },
    board: { liveClaims: [], pendingContracts: [] },
    repo: { files: ["src/add.ts"], excerpts: [] },
    allowed: AGENT_ACTION_TYPES,
  };

  it("an agent turn runs through the CLI JSON call; a usage limit is a rate-limited wait", async () => {
    await fake.set({
      calls: [
        { stdout: claudeResult({ structured_output: { type: "wait", reason: "nothing to claim" } }) },
        { stdout: claudeResult({ is_error: true, result: "5-hour limit reached ∙ resets in 2 hours" }) },
      ],
    });
    const turn = createAgentTurnInvoke({ model: "sonnet", call: createCliJsonSchemaCaller(createClaudeCliDriver({ bin: fake.bin }), { tmpRoot }) });
    const first = await turn(input);
    expect(first.action).toEqual({ type: "wait", reason: "nothing to claim" });
    expect(first.model).toBe("sonnet");
    expect(first.inputTokens).toBe(15);
    const second = await turn(input);
    expect(second.action.type).toBe("wait");
    expect(second.rateLimited).toEqual({ status: 429, model: "sonnet", retryAfterMs: 7_200_000 });
  });

  it("the tool filler tries the next model after a CLI transport failure", async () => {
    await fake.set({
      calls: [
        { stdout: claudeResult({ is_error: true, subtype: "error_during_execution", api_error_status: 529, result: "Overloaded" }) },
        { stdout: claudeResult({ structured_output: { fills: [{ file: "tool.js", name: "run", code: "function run(input) { return input; }" }] } }) },
      ],
    });
    const filler = createToolRegionFiller({ models: ["opus", "sonnet"], call: createCliJsonSchemaCaller(createClaudeCliDriver({ bin: fake.bin }), { tmpRoot }) });
    const out = await filler({
      capability: "c",
      kind: "codemod",
      contract: "contract",
      regions: [{ file: "tool.js", name: "run", guidance: "g", signature: "function run(input)", example: "" }],
      files: [],
      excerpts: [],
    });
    expect(out.model).toBe("sonnet");
    expect(out.attempts).toBe(2);
    const models = (await fake.calls()).map((c) => c.argv[c.argv.indexOf("--model") + 1]);
    expect(models).toEqual(["opus", "sonnet"]);
  });
});

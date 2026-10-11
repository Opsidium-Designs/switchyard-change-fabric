/**
 * Local CLI inference selection (SWITCHYARD_INFERENCE=claude-cli), offline: a
 * fake CLI script stands in for `claude`. Every model role (executor and its
 * escalation ladder, planner, agent turns, tool authoring) is selected over
 * the CLI, needs no AI Gateway credential, and never touches the gateway
 * (fetch is never called); Jev is off by default with an explicit opt-in;
 * the run header names the path; the meter counts subscription calls with
 * USD not applicable; the doctor checks the CLI instead of the gateway.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_ACTION_TYPES, type AgentTurnInput } from "@switchyard-change/model-adapters";

import {
  describeInference,
  selectAgentTurn,
  selectCliInference,
  selectExecutor,
  selectJev,
  selectPlanner,
  selectToolFiller,
  type ExecutorEnv,
} from "../src/executor-select.ts";
import { runDoctor } from "../src/doctor.ts";
import { RunMeter } from "../src/run-meter.ts";
import { claudeResult, makeFakeCli, type FakeCli } from "./fake-cli.ts";

let fake: FakeCli;

beforeEach(async () => {
  fake = await makeFakeCli();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(fake.dir, { recursive: true, force: true });
});

const GATEWAY = {
  EXECUTOR: "ai-gateway",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/gw",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway-token-value",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "api-token",
} as const;

describe("selection from SWITCHYARD_INFERENCE", () => {
  it("gateway stays the default: no CLI inference unless asked", () => {
    expect(selectCliInference({ ...GATEWAY })).toBeUndefined();
    expect(selectExecutor({ ...GATEWAY }).description).toMatch(/^ai-gateway/);
  });

  it("claude-cli selects every role over the local CLI with the documented defaults, needing no gateway credential", () => {
    const env: ExecutorEnv = { SWITCHYARD_INFERENCE: "claude-cli" };
    const executor = selectExecutor(env);
    expect(executor.live).toBe(true);
    expect(executor.baseModel).toBe("sonnet");
    expect(executor.escalationModels).toEqual(["opus"]);
    expect(executor.description).toBe("claude-cli (base sonnet, escalation opus)");
    const planner = selectPlanner(env);
    expect(planner.live).toBe(true);
    expect(planner.baseModel).toBe("sonnet");
    expect(planner.escalationModels).toEqual(["opus"]);
    const turn = selectAgentTurn(env);
    expect(turn.live).toBe(true);
    expect(turn.model).toBe("sonnet");
    const tools = selectToolFiller(env);
    expect(tools.live).toBe(true);
    expect(tools.models).toEqual(["opus", "sonnet"]);
    expect(selectJev(env).live).toBe(false);
  });

  it("reads the CLI_* model settings and the binary", () => {
    const env: ExecutorEnv = {
      SWITCHYARD_INFERENCE: "claude-cli",
      CLI_MODEL: "haiku",
      CLI_ESCALATION_MODELS: "sonnet, opus",
      CLI_PLANNER_MODEL: "opus",
      CLI_AGENT_MODEL: "haiku",
      CLI_TOOL_MODELS: "opus",
      CLAUDE_CLI_BIN: "/opt/claude",
      CLI_TIMEOUT_MS: "1000",
    };
    const cli = selectCliInference(env)!;
    expect(cli.driver.bin).toBe("/opt/claude");
    expect(cli.timeoutMs).toBe(1000);
    expect(selectExecutor(env).escalationModels).toEqual(["sonnet", "opus"]);
    expect(selectPlanner(env).baseModel).toBe("opus");
    expect(selectAgentTurn(env).model).toBe("haiku");
    expect(selectToolFiller(env).models).toEqual(["opus"]);
  });

  it("refuses an unknown mode, codex-cli (not supported yet), and a bad timeout clearly", () => {
    expect(() => selectExecutor({ SWITCHYARD_INFERENCE: "claude" })).toThrow(/SWITCHYARD_INFERENCE must be one of gateway, claude-cli, codex-cli/);
    expect(() => selectExecutor({ SWITCHYARD_INFERENCE: "codex-cli" })).toThrow(/codex-cli is not supported yet/);
    expect(() => selectExecutor({ SWITCHYARD_INFERENCE: "claude-cli", CLI_TIMEOUT_MS: "soon" })).toThrow(/CLI_TIMEOUT_MS must be a positive integer/);
    expect(() => selectExecutor({ SWITCHYARD_INFERENCE: "claude-cli", CLI_JEV: "maybe" })).toThrow(/CLI_JEV must be off or gateway/);
  });

  it("Jev is off in CLI mode by default; CLI_JEV=gateway keeps it on the gateway when its credentials are present", () => {
    expect(selectJev({ ...GATEWAY, SWITCHYARD_INFERENCE: "claude-cli" }).live).toBe(false);
    const optIn = selectJev({ ...GATEWAY, SWITCHYARD_INFERENCE: "claude-cli", CLI_JEV: "gateway" });
    expect(optIn.live).toBe(true);
    expect(optIn.description).toMatch(/ai-gateway jev/);
    // The opt-in without gateway credentials stays off (no unauthenticated call).
    expect(selectJev({ SWITCHYARD_INFERENCE: "claude-cli", CLI_JEV: "gateway" }).live).toBe(false);
  });

  it("the run header names the inference path", () => {
    expect(describeInference({ SWITCHYARD_INFERENCE: "claude-cli" })).toBe(
      "inference: local claude CLI on this machine's own login (executor sonnet -> opus; planner sonnet; agent turns sonnet; tools opus, sonnet); Jev off",
    );
    expect(describeInference({ EXECUTOR: "ai-gateway" })).toBe("inference: AI Gateway; Jev off");
  });
});

describe("CLI mode never constructs or calls a gateway transport", () => {
  it("every role runs on the fake CLI, with the gateway configured too, and fetch is never called", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("the gateway must not be called in CLI mode");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env: ExecutorEnv = { ...GATEWAY, SWITCHYARD_INFERENCE: "claude-cli", CLAUDE_CLI_BIN: fake.bin };

    const plan = { units: [{ id: "u1", objective: "o", paths: ["src/a.ts"], dependsOn: [] }], contracts: [], rationale: "r" };
    const edit = { commitMessage: "c", edits: [{ path: "src/a.ts", search: "export const a = 1;", replace: "export const a = 2;" }] };
    await fake.set({
      calls: [
        { stdout: claudeResult({ structured_output: plan }) },
        { stdout: claudeResult({ structured_output: { type: "wait", reason: "idle" } }) },
        { stdout: claudeResult({ structured_output: { fills: [{ file: "t.js", name: "run", code: "function run(x) { return x; }" }] } }) },
        { stdout: claudeResult({ result: JSON.stringify(edit) }) },
      ],
    });

    const planned = await selectPlanner(env).plan!({ model: "sonnet", messages: [{ role: "user", content: "goal" }] });
    expect(planned.units[0]!.id).toBe("u1");

    const input: AgentTurnInput = {
      agent: "agent-1",
      role: "worker",
      goal: "g",
      digest: {},
      messages: [],
      capsule: { objective: "g", constraints: [], decisions: [], evidence: [] },
      board: { liveClaims: [], pendingContracts: [] },
      repo: { files: [], excerpts: [] },
      allowed: AGENT_ACTION_TYPES,
    };
    const outcome = await selectAgentTurn(env).transport!(input as never);
    expect(outcome.action).toEqual({ type: "wait", reason: "idle" });

    const fills = await selectToolFiller(env).filler!({
      capability: "c",
      kind: "codemod",
      contract: "k",
      regions: [{ file: "t.js", name: "run", guidance: "g", signature: "function run(x)", example: "" }],
      files: [],
      excerpts: [],
    });
    expect(fills.model).toBe("opus");

    const worktree = await mkdtemp(join(tmpdir(), "scf-cli-sel-"));
    try {
      await mkdir(join(worktree, "src"), { recursive: true });
      await writeFile(join(worktree, "src/a.ts"), "export const a = 1;\n", "utf8");
      const result = await selectExecutor(env).executor.execute({ worktreeDir: worktree, workUnitId: "a", objective: "o", paths: ["src/a.ts"], baselineRef: "HEAD" });
      expect(result.status).toBe("changed");
      expect(await readFile(join(worktree, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const calls = await fake.calls();
    expect(calls.map((c) => c.argv[c.argv.indexOf("--model") + 1])).toEqual(["sonnet", "sonnet", "opus", "sonnet"]);
    // No gateway or Cloudflare credential reached any CLI call.
    for (const call of calls) {
      expect(JSON.stringify(call.env)).not.toMatch(/gateway-token-value|api-token|CLOUDFLARE/);
    }
  });
});

describe("the meter in CLI mode", () => {
  it("counts subscription calls and their tokens with USD not applicable, unless explicitly priced; the call cap still applies", () => {
    const meter = new RunMeter({ maxCalls: 3, subscriptionModels: ["sonnet", "opus"], prices: { opus: { inputPerMTok: 1, outputPerMTok: 1 } } });
    meter.count({ model: "sonnet", inputTokens: 100, outputTokens: 10 });
    meter.count({ model: "sonnet", inputTokens: 50, outputTokens: 5 });
    expect(meter.subscriptionCalls).toBe(2);
    expect(meter.subscriptionInputTokens).toBe(150);
    expect(meter.subscriptionOutputTokens).toBe(15);
    expect(meter.unpricedCalls).toBe(0);
    expect(meter.spendUsd).toBe(0);
    // An explicit --price still prices that model.
    meter.count({ model: "opus", inputTokens: 1_000_000, outputTokens: 0 });
    expect(meter.spendUsd).toBe(1);
    expect(meter.subscriptionCalls).toBe(2);
    expect(meter.reached()).toEqual({ kind: "model-calls", limit: 3, used: 3 });
    expect(meter.describe()).toMatch(/\+2 local CLI subscription call\(s\), USD not applicable/);
    // A model the CLI does not serve stays unpriced.
    meter.count({ model: "typesafe/jev" });
    expect(meter.unpricedCalls).toBe(1);
  });
});

describe("doctor in CLI mode", () => {
  const runner = (responses: Record<string, string>) => async (program: string, args: readonly string[]): Promise<string> => {
    const key = [program, ...args].join(" ");
    const value = responses[key];
    if (value === undefined) {
      throw new Error(`not found: ${key}`);
    }
    return value;
  };

  it("checks the CLI binary and login, not the AI Gateway credentials", async () => {
    const report = await runDoctor({
      env: { SWITCHYARD_INFERENCE: "claude-cli" },
      runCommand: runner({
        "git --version": "git version 2.40.0",
        "claude --version": "2.1.295 (Claude Code)",
        "claude auth status": JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com" }),
      }),
    });
    const cli = report.checks.find((c) => c.name === "Inference: local claude CLI");
    expect(cli?.status).toBe("ok");
    expect(cli?.detail).toMatch(/no AI Gateway URL or token is needed/);
    const login = report.checks.find((c) => c.name === "claude CLI login");
    expect(login?.status).toBe("ok");
    expect(login?.detail).toBe("logged in (claude.ai)");
    expect(JSON.stringify(report)).not.toContain("someone@example.com");
    expect(report.checks.some((c) => c.name === "Inference: AI Gateway")).toBe(false);
  });

  it("reports a missing binary and a missing login", async () => {
    const missing = await runDoctor({ env: { SWITCHYARD_INFERENCE: "claude-cli" }, runCommand: runner({ "git --version": "git version 2.40.0" }) });
    expect(missing.checks.find((c) => c.name === "Inference: local claude CLI")?.status).toBe("missing");
    const loggedOut = await runDoctor({
      env: { SWITCHYARD_INFERENCE: "claude-cli" },
      runCommand: runner({ "git --version": "git", "claude --version": "2.1.295", "claude auth status": JSON.stringify({ loggedIn: false }) }),
    });
    expect(loggedOut.checks.find((c) => c.name === "claude CLI login")?.detail).toMatch(/not logged in: run `claude`/);
  });

  it("in gateway mode reports the gateway configuration", async () => {
    const report = await runDoctor({ env: {}, runCommand: runner({ "git --version": "git" }) });
    expect(report.checks.find((c) => c.name === "Inference: AI Gateway")?.status).toBe("unknown");
  });
});

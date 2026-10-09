/**
 * G3: tests for executor selection from the environment, focused on the new
 * ai-gateway (BYOK) branch. These are pure and offline: selectExecutor takes an
 * injected env view, so no process.env mutation, no network, and no credential
 * is needed. The gateway transport is only constructed (never called), so no
 * fetch happens here.
 */

import { describe, expect, it } from "vitest";

import {
  ALLOW_HEURISTIC_PLANNER_FLAG,
  decideLivePlanner,
  plannerFallbackBanner,
  selectAgentTurn,
  selectExecutor,
  type ExecutorEnv,
} from "../src/executor-select.ts";

describe("selectExecutor ai-gateway branch", () => {
  it("selects a live ai-gateway executor with the env base/escalation models and retry budget", () => {
    const env: ExecutorEnv = {
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/gw",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway-token-value",
      AI_GATEWAY_MODEL: "gpt-4o-mini",
      AI_GATEWAY_ESCALATION_MODEL: "gpt-4o",
      AI_GATEWAY_MAX_MODEL_RETRIES: "3",
    };
    const selected = selectExecutor(env);
    expect(selected.live).toBe(true);
    expect(selected.executor.name).toBe("workers-ai"); // reuses the executor shape
    expect(selected.baseModel).toBe("gpt-4o-mini");
    expect(selected.escalationModel).toBe("gpt-4o");
    expect(selected.maxModelRetries).toBe(3);
    // The description names the models but never a token.
    expect(selected.description).toContain("ai-gateway");
    expect(selected.description).not.toContain("gateway-token-value");
  });

  it("defaults the base model, escalation model, and retry budget when the env omits them", () => {
    const selected = selectExecutor({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "t",
    });
    expect(selected.live).toBe(true);
    expect(selected.baseModel).toBe("gpt-4o-mini");
    expect(selected.escalationModel).toBe("gpt-4o");
    expect(selected.maxModelRetries).toBe(3);
  });

  it("falls back to the default retry budget when AI_GATEWAY_MAX_MODEL_RETRIES is not a valid number", () => {
    const selected = selectExecutor({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "t",
      AI_GATEWAY_MAX_MODEL_RETRIES: "not-a-number",
    });
    expect(selected.maxModelRetries).toBe(3);
  });

  it("fails clearly (never silently noop) when the gateway URL or token is missing", () => {
    expect(() =>
      selectExecutor({ EXECUTOR: "ai-gateway", CLOUDFLARE_AI_GATEWAY_TOKEN: "t" }),
    ).toThrow(/CLOUDFLARE_AI_GATEWAY_URL and CLOUDFLARE_AI_GATEWAY_TOKEN/);
    expect(() =>
      selectExecutor({
        EXECUTOR: "ai-gateway",
        CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      }),
    ).toThrow(/CLOUDFLARE_AI_GATEWAY_URL and CLOUDFLARE_AI_GATEWAY_TOKEN/);
  });

  it("parses an ordered AI_GATEWAY_ESCALATION_MODELS list (each retry round steps to the next model)", () => {
    const selected = selectExecutor({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway-token-value",
      AI_GATEWAY_MODEL: "gpt-4o",
      AI_GATEWAY_ESCALATION_MODELS: "gpt-4.1,gpt-5",
    });
    expect(selected.baseModel).toBe("gpt-4o");
    // The ordered ladder is parsed in order; escalationModel is the first entry
    // (kept for backward compatibility).
    expect(selected.escalationModels).toEqual(["gpt-4.1", "gpt-5"]);
    expect(selected.escalationModel).toBe("gpt-4.1");
    // The description shows the ladder order, never the token.
    expect(selected.description).toContain("gpt-4.1 -> gpt-5");
    expect(selected.description).not.toContain("gateway-token-value");
  });

  it("trims blank entries and tolerates surrounding whitespace in the ordered list", () => {
    const selected = selectExecutor({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "t",
      AI_GATEWAY_ESCALATION_MODELS: " gpt-4.1 , , gpt-5 ,",
    });
    expect(selected.escalationModels).toEqual(["gpt-4.1", "gpt-5"]);
  });

  it("falls back to the singular AI_GATEWAY_ESCALATION_MODEL as a one-element list (backward compatible)", () => {
    const selected = selectExecutor({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "t",
      AI_GATEWAY_ESCALATION_MODEL: "gpt-4o",
    });
    expect(selected.escalationModels).toEqual(["gpt-4o"]);
    expect(selected.escalationModel).toBe("gpt-4o");
  });

  it("defaults the escalation ladder when neither the list nor the single model is set", () => {
    const selected = selectExecutor({
      EXECUTOR: "ai-gateway",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gw/base",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "t",
    });
    expect(selected.escalationModels).toEqual(["gpt-4o"]);
  });

  it("keeps the deterministic noop path when EXECUTOR is unset (offline make check)", () => {
    const selected = selectExecutor({});
    expect(selected.live).toBe(false);
    expect(selected.executor.name).toBe("noop");
    expect(selected.baseModel).toBe("");
    expect(selected.escalationModel).toBe("");
    expect(selected.escalationModels).toEqual([]);
    expect(selected.maxModelRetries).toBeUndefined();
  });
});

describe("selectExecutor rejects unsupported EXECUTOR values", () => {
  it("throws on an executor this repo does not implement (no silent noop on a live run)", () => {
    expect(() => selectExecutor({ EXECUTOR: "codex" })).toThrow(/unsupported EXECUTOR="codex"/);
    expect(() => selectExecutor({ EXECUTOR: "workers_ai" })).toThrow(/supported values are/);
  });

  it("still selects the noop stub for an explicit EXECUTOR=noop", () => {
    const selected = selectExecutor({ EXECUTOR: "noop" });
    expect(selected.live).toBe(false);
    expect(selected.executor.name).toBe("noop");
  });
});

describe("decideLivePlanner", () => {
  it("uses the LLM planner when the gateway planner is live", () => {
    expect(
      decideLivePlanner({ planner: { live: true, description: "ai-gateway" }, allowHeuristic: false }),
    ).toEqual({ kind: "llm" });
  });

  it("REFUSES a live run with no LLM planner unless the operator opts in", () => {
    const refused = decideLivePlanner({
      planner: { live: false, description: "heuristic (gateway credentials absent)" },
      allowHeuristic: false,
    });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.error).toContain(ALLOW_HEURISTIC_PLANNER_FLAG);
      expect(refused.error).toContain("gateway credentials absent");
    }
  });

  it("allows the heuristic only with the explicit flag, and returns a loud banner", () => {
    const allowed = decideLivePlanner({
      planner: { live: false, description: "heuristic (deterministic, offline decomposition)" },
      allowHeuristic: true,
    });
    expect(allowed.kind).toBe("heuristic-allowed");
    if (allowed.kind === "heuristic-allowed") {
      expect(allowed.banner).toContain("HEURISTIC PLANNER IN USE ON A LIVE RUN");
      expect(allowed.banner).toContain(ALLOW_HEURISTIC_PLANNER_FLAG);
    }
  });

  it("the fallback banner names the recorded heuristic-fallback plan source", () => {
    const banner = plannerFallbackBanner([{ model: "gpt-4o-mini", reason: "invalid plan" }]);
    expect(banner).toContain('plan.source "heuristic-fallback"');
    expect(banner).toContain("gpt-4o-mini: invalid plan");
  });
});

describe("selectAgentTurn", () => {
  it("is live only for ai-gateway with gateway credentials, on the agent model when set", () => {
    expect(selectAgentTurn({}).live).toBe(false);
    expect(selectAgentTurn({ EXECUTOR: "ai-gateway" })).toMatchObject({ live: false, description: expect.stringMatching(/credentials absent/) });
    const env = { EXECUTOR: "ai-gateway", CLOUDFLARE_AI_GATEWAY_URL: "https://gw", CLOUDFLARE_AI_GATEWAY_TOKEN: "secret-token" };
    const base = selectAgentTurn(env);
    expect(base).toMatchObject({ live: true, model: "gpt-4o-mini" });
    expect(typeof base.transport).toBe("function");
    expect(selectAgentTurn({ ...env, AI_GATEWAY_MODEL: "m-base" }).model).toBe("m-base");
    expect(selectAgentTurn({ ...env, AI_GATEWAY_MODEL: "m-base", AI_GATEWAY_AGENT_MODEL: "m-agent" }).model).toBe("m-agent");
    expect(JSON.stringify(selectAgentTurn(env))).not.toContain("secret-token");
  });
});

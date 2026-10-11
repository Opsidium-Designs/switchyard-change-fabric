/**
 * Deterministic, offline tests for the schema-constrained plan transport. There
 * is no network here: the gateway plan transport is driven with an injected fake
 * `fetch`, exactly like the executor transport tests, so `make check` stays
 * offline and reproducible. The tests assert the plan request shape (the OpenAI
 * endpoint, the `cf-aig-authorization` header, the absence of a provider
 * `authorization` header, the `response_format` json_schema envelope, and the
 * strict schema), that a schema-conforming reply is parsed from
 * `choices[0].message.content` into a plan, that a malformed reply is rejected
 * without leaking the token, and that the plan parser enforces the plan shape.
 */

import { describe, expect, it } from "vitest";

import {
  createAiGatewayPlannerInvoke,
  DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS,
  plannerModelBudget,
  DEFAULT_AI_GATEWAY_PLANNER_MODEL,
  parsePlannerPlan,
  PLANNER_PLAN_JSON_SCHEMA,
  PLANNER_PLAN_SCHEMA_NAME,
  PlannerResponseError,
} from "../src/index.ts";

const planDoc = JSON.stringify({
  units: [
    { id: "users", objective: "validate users", paths: ["src/resources/users.js"], dependsOn: [] },
    {
      id: "orders",
      objective: "validate orders",
      paths: ["src/resources/orders.js"],
      dependsOn: ["users"],
    },
  ],
  contracts: ["src/contracts/auth.js"],
});

describe("createAiGatewayPlannerInvoke (BYOK json_schema, offline fake fetch)", () => {
  it("posts the OpenAI chat-completions shape with a strict json_schema response_format and the gateway auth header", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: planDoc } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const invoke = createAiGatewayPlannerInvoke({
      gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct/my-gateway",
      gatewayToken: "gateway-token-value",
      fetchFn: fakeFetch,
    });
    const plan = await invoke({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "plan it" }],
    });

    // The URL is the gateway base plus the OpenAI chat-completions path.
    expect(seenUrl).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/my-gateway/openai/chat/completions",
    );
    // BYOK: the gateway credential is cf-aig-authorization, with NO provider
    // authorization header (the gateway injects the stored key).
    expect(seenHeaders["cf-aig-authorization"]).toBe("Bearer gateway-token-value");
    expect(seenHeaders.authorization).toBeUndefined();
    expect(seenHeaders["content-type"]).toBe("application/json");

    // The body carries the model, the messages, a token ceiling, and the strict
    // json_schema response_format envelope naming the plan schema.
    const parsedBody = JSON.parse(seenBody);
    expect(parsedBody.model).toBe("gpt-4o-mini");
    expect(Array.isArray(parsedBody.messages)).toBe(true);
    expect(parsedBody.max_completion_tokens).toBeGreaterThanOrEqual(1024);
    expect(parsedBody.response_format.type).toBe("json_schema");
    expect(parsedBody.response_format.json_schema.name).toBe(PLANNER_PLAN_SCHEMA_NAME);
    expect(parsedBody.response_format.json_schema.strict).toBe(true);
    expect(parsedBody.response_format.json_schema.schema).toEqual(PLANNER_PLAN_JSON_SCHEMA);

    // The reply is parsed from choices[0].message.content into a plan object.
    expect(plan.units.map((u) => u.id)).toEqual(["users", "orders"]);
    expect(plan.units[1]?.dependsOn).toEqual(["users"]);
    expect(plan.contracts).toEqual(["src/contracts/auth.js"]);
  });

  it("tolerates a trailing slash on the gateway URL", async () => {
    let seenUrl = "";
    const fakeFetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: planDoc } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayPlannerInvoke({
      gatewayUrl: "https://gw/base/",
      gatewayToken: "t",
      fetchFn: fakeFetch,
    });
    await invoke({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(seenUrl).toBe("https://gw/base/openai/chat/completions");
  });

  it("throws without leaking the gateway token when the gateway returns an error", async () => {
    const fakeFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const invoke = createAiGatewayPlannerInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "gateway-token-value",
      fetchFn: fakeFetch,
    });
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/AI Gateway plan call failed/);
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.not.toThrow(/gateway-token-value/);
  });

  it("rejects a non-JSON plan reply with a clear planner error", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const invoke = createAiGatewayPlannerInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "t",
      fetchFn: fakeFetch,
    });
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(PlannerResponseError);
  });

  it("sends a reasoning planner model 16384+ tokens with reasoning_effort medium, and other models the default ceiling", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ choices: [{ message: { content: planDoc } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayPlannerInvoke({ gatewayUrl: "https://gw/base", gatewayToken: "t", fetchFn: fakeFetch });
    await invoke({ model: "gpt-5", messages: [{ role: "user", content: "x" }] });
    await invoke({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] });
    expect(bodies[0]).toMatchObject({ model: "gpt-5", reasoning_effort: "medium" });
    expect(bodies[0]!.max_completion_tokens).toBeGreaterThanOrEqual(16384);
    expect(bodies[1]).toMatchObject({ model: "gpt-4o", max_completion_tokens: DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS });
    expect(bodies[1]!.reasoning_effort).toBeUndefined();
    expect(plannerModelBudget("o3", { reasoningMaxTokens: 20000 })).toEqual({ maxTokens: 20000, reasoningEffort: "medium" });
  });

  it("names finish_reason and the ceiling when a plan reply is empty", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), { status: 200 })) as unknown as typeof fetch;
    const invoke = createAiGatewayPlannerInvoke({ gatewayUrl: "https://gw/base", gatewayToken: "t", fetchFn: fakeFetch });
    await expect(invoke({ model: "gpt-5", messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/finish_reason: length.*max_completion_tokens \(16384\)/);
  });

  it("exposes the documented planner defaults", () => {
    expect(DEFAULT_AI_GATEWAY_PLANNER_MODEL).toBe("gpt-4o-mini");
    expect(DEFAULT_AI_GATEWAY_PLANNER_MAX_TOKENS).toBeGreaterThanOrEqual(1024);
  });
});

describe("parsePlannerPlan (shape enforcement only, no repo validation)", () => {
  it("parses a schema-conforming plan", () => {
    const plan = parsePlannerPlan(planDoc);
    expect(plan.units).toHaveLength(2);
    expect(plan.contracts).toEqual(["src/contracts/auth.js"]);
  });

  it("rejects a plan whose units is not an array", () => {
    expect(() => parsePlannerPlan(JSON.stringify({ units: {}, contracts: [] }))).toThrow(
      PlannerResponseError,
    );
  });

  it("rejects a unit missing a required string field", () => {
    expect(() =>
      parsePlannerPlan(
        JSON.stringify({ units: [{ id: "x", objective: "o", paths: [], dependsOn: [] }], contracts: [] }),
      ),
    ).not.toThrow(); // empty paths is a shape-valid plan; reality validation lives in change-core
    expect(() =>
      parsePlannerPlan(
        JSON.stringify({ units: [{ id: "", objective: "o", paths: ["a"], dependsOn: [] }], contracts: [] }),
      ),
    ).toThrow(PlannerResponseError);
  });

  it("rejects a non-object plan", () => {
    expect(() => parsePlannerPlan("[]")).toThrow(PlannerResponseError);
    expect(() => parsePlannerPlan("nope")).toThrow(PlannerResponseError);
  });
});

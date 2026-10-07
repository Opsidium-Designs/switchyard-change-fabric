/**
 * Deterministic, offline tests for the Jev typed-decision transport. There is no
 * network here: the gateway decision transport is driven with an injected fake
 * `fetch`, exactly like the executor and planner transport tests, so `make
 * check` stays offline and reproducible. The tests assert the decision request
 * shape (the gateway run endpoint, the cf-aig-gateway-id routing header, the
 * cf-aig-authorization header, the absence of a provider authorization header,
 * and the typesafe/jev body), that a typed reply (noul, choice, score) is parsed
 * from the answers map, that a malformed reply is rejected without leaking the
 * token, and that the gateway slug derivation works.
 */

import { describe, expect, it } from "vitest";

import {
  createAiGatewayJevInvoke,
  DEFAULT_JEV_MODEL,
  gatewaySlugFromUrl,
  JevResponseError,
  parseJevAnswers,
} from "../src/index.ts";

describe("createAiGatewayJevInvoke (BYOK /ai/run + cf-aig-gateway-id, offline fake fetch)", () => {
  it("posts to the gateway run endpoint with the gateway routing + auth headers and the typesafe/jev body", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          answers: { "plan-review": { type: "noul", noul: "yes", confidence: 0.9 } },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const invoke = createAiGatewayJevInvoke({
      gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct/my-gateway",
      gatewayToken: "gateway-token-value",
      gatewayId: "my-gateway",
      fetchFn: fakeFetch,
    });
    const answers = await invoke({
      state: "Goal: fix the bug",
      questions: [{ key: "plan-review", type: "noul", question: "Does this plan cover the goal?" }],
    });

    // The URL is the gateway base plus the /ai/run run endpoint, NOT the OpenAI
    // chat-completions path.
    expect(seenUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct/my-gateway/ai/run");
    // The gateway routing header names the gateway id; the credential is
    // cf-aig-authorization with NO provider authorization header (BYOK).
    expect(seenHeaders["cf-aig-gateway-id"]).toBe("my-gateway");
    expect(seenHeaders["cf-aig-authorization"]).toBe("Bearer gateway-token-value");
    expect(seenHeaders.authorization).toBeUndefined();
    expect(seenHeaders["content-type"]).toBe("application/json");

    // The body carries the decision model and the state + questions input.
    const body = JSON.parse(seenBody);
    expect(body.model).toBe(DEFAULT_JEV_MODEL);
    expect(body.input.state).toContain("Goal: fix the bug");
    expect(body.input.questions[0]).toMatchObject({
      key: "plan-review",
      type: "noul",
      question: "Does this plan cover the goal?",
    });

    // The reply is parsed into a typed noul answer with its confidence.
    expect(answers["plan-review"]).toMatchObject({ type: "noul", noul: "yes", confidence: 0.9 });
  });

  it("tolerates a trailing slash on the gateway URL", async () => {
    let seenUrl = "";
    const fakeFetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      gatewayUrl: "https://gw/base/",
      gatewayToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    await invoke({ state: "x", questions: [] });
    expect(seenUrl).toBe("https://gw/base/ai/run");
  });

  it("parses a choice answer over option ids and a score answer", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          answers: {
            attribution: {
              type: "choice",
              choice: "users",
              confidence: 0.82,
              probabilities: { users: 0.82, orders: 0.18 },
            },
            quality: { type: "score", score: 7.5, confidence: 0.6 },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    const answers = await invoke({
      state: "s",
      questions: [
        { key: "attribution", type: "choice", question: "which?", options: ["users", "orders"] },
        { key: "quality", type: "score", question: "how good?" },
      ],
    });
    expect(answers.attribution).toMatchObject({ type: "choice", choice: "users", confidence: 0.82 });
    expect(answers.attribution?.probabilities).toEqual({ users: 0.82, orders: 0.18 });
    expect(answers.quality).toMatchObject({ type: "score", score: 7.5, confidence: 0.6 });
  });

  it("throws without leaking the gateway token when the gateway returns an error", async () => {
    const fakeFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "gateway-token-value",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    await expect(invoke({ state: "s", questions: [] })).rejects.toThrow(
      /AI Gateway decision call failed/,
    );
    await expect(invoke({ state: "s", questions: [] })).rejects.not.toThrow(/gateway-token-value/);
  });

  it("rejects a non-JSON decision reply with a clear jev error", async () => {
    const fakeFetch = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    await expect(invoke({ state: "s", questions: [] })).rejects.toBeInstanceOf(JevResponseError);
  });
});

describe("parseJevAnswers (shape enforcement only)", () => {
  it("accepts both the wrapped {answers:{...}} and the bare {<key>:{...}} shapes", () => {
    const wrapped = parseJevAnswers({ answers: { k: { type: "noul", noul: "no", confidence: 0.5 } } });
    expect(wrapped.k).toMatchObject({ type: "noul", noul: "no", confidence: 0.5 });
    const bare = parseJevAnswers({ k: { type: "noul", noul: "unsure", confidence: 0.3 } });
    expect(bare.k).toMatchObject({ type: "noul", noul: "unsure", confidence: 0.3 });
  });

  it("rejects a noul answer with a bad verdict", () => {
    expect(() => parseJevAnswers({ answers: { k: { type: "noul", noul: "maybe", confidence: 0.5 } } })).toThrow(
      JevResponseError,
    );
  });

  it("rejects a confidence outside [0, 1]", () => {
    expect(() => parseJevAnswers({ answers: { k: { type: "noul", noul: "yes", confidence: 1.5 } } })).toThrow(
      JevResponseError,
    );
  });

  it("rejects a non-object reply", () => {
    expect(() => parseJevAnswers("nope")).toThrow(JevResponseError);
    expect(() => parseJevAnswers([])).toThrow(JevResponseError);
  });
});

describe("gatewaySlugFromUrl", () => {
  it("derives the gateway slug from a Cloudflare AI Gateway URL", () => {
    expect(gatewaySlugFromUrl("https://gateway.ai.cloudflare.com/v1/acct/my-gateway")).toBe(
      "my-gateway",
    );
    expect(gatewaySlugFromUrl("https://gateway.ai.cloudflare.com/v1/acct/my-gateway/")).toBe(
      "my-gateway",
    );
  });

  it("falls back to the last path segment when no v1/account shape is present", () => {
    expect(gatewaySlugFromUrl("https://host/some/path/gw")).toBe("gw");
  });
});

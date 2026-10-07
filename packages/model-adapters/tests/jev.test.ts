/**
 * Deterministic, offline tests for the Jev typed-decision transport. There is no
 * network here: the gateway decision transport is driven with an injected fake
 * `fetch`, exactly like the executor and planner transport tests, so `make
 * check` stays offline and reproducible. The tests assert the decision request
 * shape (the NATIVE account run endpoint `/accounts/<id>/ai/run`, the
 * cf-aig-gateway-id routing header, the Authorization bearer account token, the
 * absence of a provider-key leak, and the typesafe/jev body), that a typed reply
 * (noul, choice, score) is parsed from the NESTED result.result.answers map, that
 * a malformed reply is rejected without leaking the token, and that the gateway
 * slug derivation works.
 */

import { describe, expect, it } from "vitest";

import {
  createAiGatewayJevInvoke,
  DEFAULT_JEV_MODEL,
  gatewaySlugFromUrl,
  JevResponseError,
  parseJevAnswers,
} from "../src/index.ts";

/** Nest an answers map in the native account run response shape. */
function runResponse(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ result: { state: "Completed", result: { answers } } }),
    { status: 200 },
  );
}

describe("createAiGatewayJevInvoke (native /ai/run + cf-aig-gateway-id, offline fake fetch)", () => {
  it("posts to the native account run endpoint with the Authorization + gateway routing headers and the typesafe/jev body", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      seenBody = String(init?.body ?? "");
      return runResponse({
        "plan-review": { type: "noul", noul: "yes", confidence: 0.9 },
      });
    }) as unknown as typeof fetch;

    const invoke = createAiGatewayJevInvoke({
      accountId: "acct-123",
      apiToken: "account-api-token-value",
      gatewayId: "my-gateway",
      apiBase: "https://api.cloudflare.com/client/v4",
      fetchFn: fakeFetch,
    });
    const answers = await invoke({
      state: "Goal: fix the bug",
      questions: {
        "plan-review": { type: "noul", instructions: "Does this plan cover the goal?" },
      },
    });

    // The URL is the NATIVE account run endpoint built from the account id, NOT
    // the gateway URL and NOT the OpenAI chat-completions path.
    expect(seenUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run");
    // The account API token authenticates the run endpoint; the gateway routing
    // header names the gateway id. There is no cf-aig-authorization header.
    expect(seenHeaders.Authorization).toBe("Bearer account-api-token-value");
    expect(seenHeaders["cf-aig-gateway-id"]).toBe("my-gateway");
    expect(seenHeaders["cf-aig-authorization"]).toBeUndefined();
    expect(seenHeaders["content-type"]).toBe("application/json");

    // The body carries the decision model and the state + questions input. The
    // questions ride as an OBJECT keyed by question name (not a positional
    // array), each carrying type + instructions (+ criteria for a choice).
    const body = JSON.parse(seenBody);
    expect(body.model).toBe(DEFAULT_JEV_MODEL);
    expect(body.input.state).toContain("Goal: fix the bug");
    expect(Array.isArray(body.input.questions)).toBe(false);
    expect(body.input.questions["plan-review"]).toEqual({
      type: "noul",
      instructions: "Does this plan cover the goal?",
    });

    // The reply is parsed from the NESTED result.result.answers into a typed noul
    // answer with its confidence, keyed by the same question name.
    expect(answers["plan-review"]).toMatchObject({ type: "noul", noul: "yes", confidence: 0.9 });
  });

  it("defaults the api base to the public Cloudflare API when none is supplied", async () => {
    let seenUrl = "";
    const fakeFetch = (async (url: string) => {
      seenUrl = url;
      return runResponse({});
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      accountId: "acct-xyz",
      apiToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    await invoke({ state: "x", questions: {} });
    expect(seenUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct-xyz/ai/run");
  });

  it("tolerates a trailing slash on the api base override", async () => {
    let seenUrl = "";
    const fakeFetch = (async (url: string) => {
      seenUrl = url;
      return runResponse({});
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      accountId: "acct",
      apiToken: "t",
      gatewayId: "g",
      apiBase: "https://test.local/base/",
      fetchFn: fakeFetch,
    });
    await invoke({ state: "x", questions: {} });
    expect(seenUrl).toBe("https://test.local/base/accounts/acct/ai/run");
  });

  it("parses a choice answer over option ids and a score answer from the nested result", async () => {
    let seenBody = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body ?? "");
      return runResponse({
        attribution: {
          type: "choice",
          choice: "users",
          confidence: 0.82,
          probabilities: { users: 0.82, orders: 0.18 },
        },
        quality: { type: "score", score: 7.5, confidence: 0.6 },
      });
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      accountId: "acct",
      apiToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    const answers = await invoke({
      state: "s",
      questions: {
        attribution: { type: "choice", instructions: "which?", criteria: ["users", "orders"] },
        quality: { type: "score", instructions: "how good?" },
      },
    });
    // The request body carries the questions object-keyed, with a choice
    // question's allowed options under `criteria`.
    const body = JSON.parse(seenBody);
    expect(body.input.questions.attribution).toEqual({
      type: "choice",
      instructions: "which?",
      criteria: ["users", "orders"],
    });
    expect(body.input.questions.quality).toEqual({ type: "score", instructions: "how good?" });
    // The answers come back object-keyed by the same question names.
    expect(answers.attribution).toMatchObject({ type: "choice", choice: "users", confidence: 0.82 });
    expect(answers.attribution?.probabilities).toEqual({ users: 0.82, orders: 0.18 });
    expect(answers.quality).toMatchObject({ type: "score", score: 7.5, confidence: 0.6 });
  });

  it("tolerates a flatter result.answers nesting (one level) as well", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ result: { answers: { k: { type: "noul", noul: "no", confidence: 0.4 } } } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      accountId: "acct",
      apiToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    const answers = await invoke({ state: "s", questions: {} });
    expect(answers.k).toMatchObject({ type: "noul", noul: "no", confidence: 0.4 });
  });

  it("throws without leaking the account token when the run endpoint returns an error", async () => {
    const fakeFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      accountId: "acct",
      apiToken: "account-api-token-value",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    await expect(invoke({ state: "s", questions: {} })).rejects.toThrow(
      /AI Gateway decision call failed/,
    );
    await expect(invoke({ state: "s", questions: {} })).rejects.not.toThrow(
      /account-api-token-value/,
    );
  });

  it("rejects a non-JSON decision reply with a clear jev error", async () => {
    const fakeFetch = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      accountId: "acct",
      apiToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    await expect(invoke({ state: "s", questions: {} })).rejects.toBeInstanceOf(JevResponseError);
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

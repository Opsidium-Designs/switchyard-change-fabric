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
  jevErrorReason,
  serializeJevQuestion,
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
        "plan-review": { type: "noul", noul: 0.9 },
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

    // The reply is parsed from the NESTED result.result.answers. The decision
    // model returns `noul` as a NUMBER (the probability toward yes); the parser
    // maps it to the yes/no verdict and uses the probability as the confidence.
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
          probabilities: { users: 0.82, orders: 0.18 },
        },
        quality: { type: "score", score: 7.5 },
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
    // question's allowed options under `criteria` as a RECORD option -> description
    // (the decision API rejects an array there).
    const body = JSON.parse(seenBody);
    expect(body.input.questions.attribution).toEqual({
      type: "choice",
      instructions: "which?",
      criteria: { users: "users", orders: "orders" },
    });
    expect(body.input.questions.quality).toEqual({ type: "score", instructions: "how good?" });
    // The answers come back object-keyed by the same question names.
    // A choice answer carries the chosen option; its confidence is derived from
    // the chosen option's probability when the model does not send one. A score
    // answer with no probabilities defaults its confidence to 1.
    expect(answers.attribution).toMatchObject({ type: "choice", choice: "users", confidence: 0.82 });
    expect(answers.attribution?.probabilities).toEqual({ users: 0.82, orders: 0.18 });
    expect(answers.quality).toMatchObject({ type: "score", score: 7.5, confidence: 1 });
  });

  it("tolerates a flatter result.answers nesting (one level) as well", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ result: { answers: { k: { type: "noul", noul: 0.4 } } } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({
      accountId: "acct",
      apiToken: "t",
      gatewayId: "g",
      fetchFn: fakeFetch,
    });
    const answers = await invoke({ state: "s", questions: {} });
    expect(answers.k).toMatchObject({ type: "noul", noul: "no", confidence: 0.6 });
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
    const wrapped = parseJevAnswers({ answers: { k: { type: "noul", noul: 0.2 } } });
    expect(wrapped.k).toMatchObject({ type: "noul", noul: "no", confidence: 0.8 });
    const bare = parseJevAnswers({ k: { type: "noul", noul: 0.7 } });
    expect(bare.k).toMatchObject({ type: "noul", noul: "yes", confidence: 0.7 });
  });

  it("rejects a noul answer whose noul is not a number", () => {
    expect(() => parseJevAnswers({ answers: { k: { type: "noul", noul: "maybe" } } })).toThrow(
      JevResponseError,
    );
  });

  it("rejects an explicit confidence outside [0, 1]", () => {
    expect(() => parseJevAnswers({ answers: { k: { type: "noul", noul: 0.9, confidence: 1.5 } } })).toThrow(
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

describe("the decision API's wire shapes (from live replies of the current model)", () => {
  it("serializes criteria per question type: choice as a record, score as an array, noul without", () => {
    expect(serializeJevQuestion({ type: "choice", instructions: "which?", criteria: ["unit-a", "unit-b"], descriptions: { "unit-a": "the users module" } })).toEqual({
      type: "choice",
      instructions: "which?",
      criteria: { "unit-a": "the users module", "unit-b": "unit-b" },
    });
    expect(serializeJevQuestion({ type: "score", instructions: "how good?", criteria: ["correctness", "scope"] })).toEqual({
      type: "score",
      instructions: "how good?",
      criteria: ["correctness", "scope"],
    });
    expect(serializeJevQuestion({ type: "noul", instructions: "ok?", criteria: ["x"] })).toEqual({ type: "noul", instructions: "ok?" });
  });

  it("parses the live reply shapes: choice with confidence, noul as a number, score with a legend (type optional)", () => {
    const answers = parseJevAnswers(
      {
        answers: {
          attribution: { type: "choice", choice: "unit-b", probabilities: { "unit-a": 0, "unit-b": 1 }, confidence: 1 },
          review: { type: "noul", noul: 0.92 },
          quality: { score: 1, legend: { "0": "poor", "1": "good" }, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.9 },
        },
      },
      { attribution: "choice", review: "noul", quality: "score" },
    );
    expect(answers.attribution).toEqual({ type: "choice", choice: "unit-b", confidence: 1, probabilities: { "unit-a": 0, "unit-b": 1 } });
    expect(answers.review).toMatchObject({ type: "noul", noul: "yes", confidence: 0.92 });
    expect(answers.quality).toEqual({ type: "score", score: 1, confidence: 0.9, probabilities: { "0": 0.1, "1": 0.9 }, legend: { "0": "poor", "1": "good" } });
  });

  it("an API error carries the body's message (first line), never headers or tokens", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Invalid value at questions.attribution.criteria: expected record, received array\nmore" }] }), { status: 400 })) as unknown as typeof fetch;
    const invoke = createAiGatewayJevInvoke({ accountId: "acct", apiToken: "SECRET-TOKEN", gatewayId: "g", fetchFn: fakeFetch });
    const failure = await invoke({ state: "s", questions: { a: { type: "choice", instructions: "x", criteria: ["a"] } } }).catch((e: unknown) => e);
    expect(jevErrorReason(failure)).toBe(
      `AI Gateway decision call failed for ${DEFAULT_JEV_MODEL} (HTTP 400): Invalid value at questions.attribution.criteria: expected record, received array`,
    );
    expect(jevErrorReason(new Error("Authorization: Bearer abc.def failed"))).toBe("Authorization: Bearer [redacted] failed");
  });
});


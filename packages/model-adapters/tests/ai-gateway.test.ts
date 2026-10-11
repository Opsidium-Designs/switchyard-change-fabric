/**
 * G3: deterministic, offline tests for the AI Gateway (BYOK) transport and the
 * contract-aware base prompt. There is no network here: the gateway transport
 * is driven with an injected fake `fetch` and the executor with an injected fake
 * `invoke`, exactly like the Workers AI tests, so `make check` stays offline and
 * reproducible. The tests assert the gateway request shape (the OpenAI endpoint,
 * the `cf-aig-authorization` header, the absence of a provider `authorization`
 * header, an explicit `max_tokens`, and the OpenAI body), that the reply is
 * parsed from `choices[0].message.content`, and that the base prompt lists the
 * frozen contract files as read-only.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAiGatewayRestInvoke,
  DEFAULT_EXECUTOR_MAX_TOKENS,
  DEFAULT_REASONING_EXECUTOR_MAX_TOKENS,
  isModelBudgetError,
  isReasoningModel,
  ModelBudgetError,
  UnusableModelOutputError,
  DEFAULT_AI_GATEWAY_ESCALATION_MODEL,
  DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES,
  DEFAULT_AI_GATEWAY_MODEL,
  WorkersAiExecutor,
  type WorkersAiInvoke,
} from "../src/index.ts";

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "scf-aig-"));
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

const editDoc = JSON.stringify({
  edits: [{ path: "src/x.ts", search: "export const x = 0;", replace: "export const x = 1;" }],
});

describe("createAiGatewayRestInvoke (BYOK, offline fake fetch)", () => {
  it("posts the OpenAI chat-completions shape with the gateway auth header and no provider authorization", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: editDoc } }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const invoke = createAiGatewayRestInvoke({
      gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct/my-gateway",
      gatewayToken: "gateway-token-value",
      fetchFn: fakeFetch,
    });
    const result = await invoke({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    // The URL is the gateway base plus the OpenAI chat-completions path (the
    // model goes in the body, not the path).
    expect(seenUrl).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/my-gateway/openai/chat/completions",
    );
    // The gateway credential is sent as cf-aig-authorization; there is NO
    // provider authorization header (BYOK: the gateway injects the stored key).
    expect(seenHeaders["cf-aig-authorization"]).toBe("Bearer gateway-token-value");
    expect(seenHeaders.authorization).toBeUndefined();
    expect(seenHeaders["content-type"]).toBe("application/json");
    // The body is the OpenAI shape with model, messages, and an explicit
    // max_completion_tokens generous enough for a full edit. It uses
    // max_completion_tokens (NOT the legacy max_tokens) so gpt-5 / o-series,
    // which reject max_tokens, work through the same transport.
    const parsedBody = JSON.parse(seenBody);
    expect(parsedBody.model).toBe("gpt-4o-mini");
    expect(Array.isArray(parsedBody.messages)).toBe(true);
    expect(parsedBody.max_completion_tokens).toBeGreaterThanOrEqual(2048);
    expect(parsedBody.max_tokens).toBeUndefined();
    // The reply is parsed from choices[0].message.content.
    expect(result.text).toBe(editDoc);
    expect(result.usage?.inputTokens).toBe(9);
    expect(result.usage?.outputTokens).toBe(4);
  });

  it("tolerates a trailing slash on the gateway URL", async () => {
    let seenUrl = "";
    const fakeFetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: editDoc } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayRestInvoke({
      gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct/my-gateway/",
      gatewayToken: "t",
      fetchFn: fakeFetch,
    });
    await invoke({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(seenUrl).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/my-gateway/openai/chat/completions",
    );
  });

  it("throws without leaking the gateway token when the gateway returns an error", async () => {
    const fakeFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const invoke = createAiGatewayRestInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "gateway-token-value",
      fetchFn: fakeFetch,
    });
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/AI Gateway call failed/);
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.not.toThrow(/gateway-token-value/);
  });

  it("exposes the documented default base, escalation, and retry constants", () => {
    expect(DEFAULT_AI_GATEWAY_MODEL).toBe("gpt-4o-mini");
    expect(DEFAULT_AI_GATEWAY_ESCALATION_MODEL).toBe("gpt-4o");
    expect(DEFAULT_AI_GATEWAY_MAX_MODEL_RETRIES).toBe(3);
  });
});

describe("per-model completion budget (reasoning models)", () => {
  const bodies: Record<string, unknown>[] = [];
  const replying = (reply: Record<string, unknown>) =>
    (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
  beforeEach(() => {
    bodies.length = 0;
  });

  it("sends a reasoning model a large ceiling and reasoning_effort low, and any other model 8192 with no effort", async () => {
    const invoke = createAiGatewayRestInvoke({ gatewayUrl: "https://gw/base", gatewayToken: "t", fetchFn: replying({ choices: [{ message: { content: editDoc }, finish_reason: "stop" }] }) });
    const five = await invoke({ model: "gpt-5", messages: [{ role: "user", content: "x" }] });
    await invoke({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] });
    await invoke({ model: "o3-mini", messages: [{ role: "user", content: "x" }] });
    expect(bodies[0]).toMatchObject({ model: "gpt-5", reasoning_effort: "low" });
    expect(bodies[0]!.max_completion_tokens).toBeGreaterThanOrEqual(32768);
    expect(bodies[1]).toMatchObject({ model: "gpt-4o", max_completion_tokens: 8192 });
    expect(bodies[1]!.reasoning_effort).toBeUndefined();
    expect(bodies[2]).toMatchObject({ reasoning_effort: "low", max_completion_tokens: DEFAULT_REASONING_EXECUTOR_MAX_TOKENS });
    // The ceiling and why the model stopped come back with the reply.
    expect(five).toMatchObject({ finishReason: "stop", maxTokens: DEFAULT_REASONING_EXECUTOR_MAX_TOKENS });
    expect(DEFAULT_EXECUTOR_MAX_TOKENS).toBe(8192);
    expect(["gpt-5", "gpt-5-mini", "o1", "o3-mini", "deepseek-r1"].every(isReasoningModel)).toBe(true);
    expect(["gpt-4o", "gpt-4.1", "gpt-4o-mini"].some(isReasoningModel)).toBe(false);
  });

  it("honors separate reasoning and non-reasoning ceiling overrides", async () => {
    const invoke = createAiGatewayRestInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "t",
      maxTokens: 12000,
      reasoningMaxTokens: 50000,
      fetchFn: replying({ choices: [{ message: { content: editDoc } }] }),
    });
    await invoke({ model: "gpt-5", messages: [{ role: "user", content: "x" }] });
    await invoke({ model: "gpt-4.1", messages: [{ role: "user", content: "x" }] });
    expect(bodies.map((b) => b.max_completion_tokens)).toEqual([50000, 12000]);
  });

  it("an empty reply or one cut off at the ceiling is a ModelBudgetError naming finish_reason and the ceiling", async () => {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/x.ts"), "export const x = 0;\n", "utf8");
    const run = async (reply: Record<string, unknown>) => {
      const invoke = createAiGatewayRestInvoke({ gatewayUrl: "https://gw/base", gatewayToken: "t", fetchFn: replying(reply) });
      return new WorkersAiExecutor({ model: "gpt-5", invoke, providerLabel: "AI Gateway" })
        .execute({ worktreeDir: worktree, workUnitId: "x", objective: "set x", paths: ["src/x.ts"], baselineRef: "HEAD" })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    };
    const empty = await run({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens: 32768 } });
    expect(empty).toBeInstanceOf(ModelBudgetError);
    expect(empty).toBeInstanceOf(UnusableModelOutputError);
    expect(isModelBudgetError(empty)).toBe(true);
    expect(String((empty as Error).message)).toMatch(/finish_reason: length/);
    expect(String((empty as Error).message)).toMatch(new RegExp(`max_completion_tokens ${DEFAULT_REASONING_EXECUTOR_MAX_TOKENS}`));
    expect(empty).toMatchObject({ model: "gpt-5", finishReason: "length", maxTokens: DEFAULT_REASONING_EXECUTOR_MAX_TOKENS });
    // A truncated reply is never applied, even if a prefix parses.
    const truncated = await run({ choices: [{ message: { content: editDoc }, finish_reason: "length" }] });
    expect(isModelBudgetError(truncated)).toBe(true);
    expect(await readFile(join(worktree, "src/x.ts"), "utf8")).toBe("export const x = 0;\n");
    // An empty reply that stopped for another reason is still a spent budget, named as such.
    const blank = await run({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
    expect(String((blank as Error).message)).toMatch(/finish_reason: stop/);
    // A reply with content that is simply not an edit stays a plain unusable output.
    const prose = await run({ choices: [{ message: { content: "I cannot help" }, finish_reason: "stop" }] });
    expect(prose).toBeInstanceOf(UnusableModelOutputError);
    expect(isModelBudgetError(prose)).toBe(false);
  });
});

describe("WorkersAiExecutor over the AI Gateway transport (offline fake fetch)", () => {
  it("applies the edit the gateway returns and runs the per-attempt model id", async () => {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/x.ts"), "export const x = 0;\n", "utf8");

    let seenModel = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seenModel = JSON.parse(String(init?.body ?? "{}")).model;
      return new Response(JSON.stringify({ choices: [{ message: { content: editDoc } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const invoke = createAiGatewayRestInvoke({
      gatewayUrl: "https://gw/base",
      gatewayToken: "t",
      fetchFn: fakeFetch,
    });
    const executor = new WorkersAiExecutor({ model: "gpt-4o-mini", invoke });

    const result = await executor.execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "set x to 1",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
    });

    expect(result.changedPaths).toEqual(["src/x.ts"]);
    expect(seenModel).toBe("gpt-4o-mini");
    const written = await readFile(join(worktree, "src/x.ts"), "utf8");
    expect(written).toBe("export const x = 1;\n");
  });
});

describe("contract-aware base prompt (frozen contracts listed read-only)", () => {
  beforeEach(async () => {
    // The editDoc anchors on src/x.ts, so seed it verbatim for the apply.
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/x.ts"), "export const x = 0;\n", "utf8");
  });

  it("lists the frozen contract paths as read-only in the prompt the model sees", async () => {
    let seenPrompt = "";
    const invoke: WorkersAiInvoke = async (request) => {
      seenPrompt = request.messages.map((m) => m.content).join("\n");
      return { text: editDoc };
    };
    await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add validation to the orders resource",
      paths: ["src/orders.ts"],
      baselineRef: "HEAD",
      frozenContracts: ["src/contracts/auth.ts", "src/contracts/schema.ts"],
    });
    // The system prompt instructs a minimal edit started from the current
    // contents, and honoring frozen contracts.
    expect(seenPrompt).toMatch(/MINIMAL change/i);
    expect(seenPrompt).toMatch(/START FROM THE CURRENT CONTENTS/i);
    expect(seenPrompt).toMatch(/frozen contract/i);
    expect(seenPrompt).toMatch(/do NOT regenerate the file from scratch/i);
    // The user prompt lists the actual frozen contract paths as read-only.
    expect(seenPrompt).toContain("src/contracts/auth.ts");
    expect(seenPrompt).toContain("src/contracts/schema.ts");
  });

  it("still works with no frozen contracts (optional; existing callers unchanged)", async () => {
    let seenPrompt = "";
    const invoke: WorkersAiInvoke = async (request) => {
      seenPrompt = request.messages.map((m) => m.content).join("\n");
      return { text: editDoc };
    };
    const result = await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
    });
    expect(result.changedPaths).toEqual(["src/x.ts"]);
    expect(seenPrompt).toMatch(/none declared for this change/i);
  });
});

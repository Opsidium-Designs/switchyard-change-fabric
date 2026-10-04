import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWorkersAiRestInvoke,
  DEFAULT_WORKERS_AI_MODEL,
  isTransientWorkersAiError,
  UnusableModelOutputError,
  WorkersAiExecutor,
  WorkersAiTimeoutError,
  type WorkersAiInvoke,
} from "../src/index.ts";

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "scf-wai-"));
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

describe("WorkersAiExecutor", () => {
  it("requires an injected transport (never embeds a credential)", () => {
    expect(
      () =>
        new WorkersAiExecutor({
          // @ts-expect-error intentionally missing invoke transport
          invoke: undefined,
        }),
    ).toThrow(/invoke` transport/i);
  });

  it("sends the in-scope file contents to the model and applies the returned edit", async () => {
    // Seed an in-scope file so the executor reads real current contents.
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/add.ts"), "export const add = (a, b) => a + b;\n", "utf8");

    let seenPrompt = "";
    let seenModel = "";
    const invoke: WorkersAiInvoke = async (request) => {
      seenModel = request.model;
      seenPrompt = request.messages.map((m) => m.content).join("\n");
      return {
        text: JSON.stringify({
          commitMessage: "validate add inputs",
          edits: [
            {
              path: "src/add.ts",
              contents: "export const add = (a: number, b: number) => a + b;\n",
            },
          ],
        }),
        usage: { inputTokens: 120, outputTokens: 40 },
      };
    };

    const executor = new WorkersAiExecutor({ invoke });
    expect(executor.name).toBe("workers-ai");

    const result = await executor.execute({
      worktreeDir: worktree,
      workUnitId: "add",
      objective: "add input types to add()",
      paths: ["src/add.ts"],
      baselineRef: "HEAD",
    });

    expect(seenModel).toBe(DEFAULT_WORKERS_AI_MODEL);
    // The real current contents were sent as context.
    expect(seenPrompt).toContain("export const add = (a, b) => a + b;");
    expect(seenPrompt).toContain("add input types to add()");

    expect(result.status).toBe("changed");
    expect(result.changedPaths).toEqual(["src/add.ts"]);
    expect(result.cost.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(result.cost.inputTokens).toBe(120);
    expect(result.commitMessage).toBe("validate add inputs");

    const written = await readFile(join(worktree, "src/add.ts"), "utf8");
    expect(written).toContain("a: number, b: number");
  });

  it("tolerates a markdown-fenced JSON reply", async () => {
    const invoke: WorkersAiInvoke = async () => ({
      text: "```json\n{\"edits\":[{\"path\":\"src/x.ts\",\"contents\":\"export const x = 1;\\n\"}]}\n```",
    });
    const result = await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
    });
    expect(result.changedPaths).toEqual(["src/x.ts"]);
    const written = await readFile(join(worktree, "src/x.ts"), "utf8");
    expect(written).toBe("export const x = 1;\n");
  });

  it("fails honestly when the model returns prose instead of JSON (no silent noop)", async () => {
    const invoke: WorkersAiInvoke = async () => ({ text: "I cannot help with that." });
    await expect(
      new WorkersAiExecutor({ invoke }).execute({
        worktreeDir: worktree,
        workUnitId: "x",
        objective: "add x",
        paths: ["src/x.ts"],
        baselineRef: "HEAD",
      }),
    ).rejects.toThrow(UnusableModelOutputError);
  });

  it("fails honestly when the model returns valid JSON with zero edits", async () => {
    const invoke: WorkersAiInvoke = async () => ({ text: JSON.stringify({ edits: [] }) });
    await expect(
      new WorkersAiExecutor({ invoke }).execute({
        worktreeDir: worktree,
        workUnitId: "x",
        objective: "add x",
        paths: ["src/x.ts"],
        baselineRef: "HEAD",
      }),
    ).rejects.toThrow(/no usable edit/i);
  });

  it("rejects an edit path that escapes the worktree", async () => {
    const invoke: WorkersAiInvoke = async () => ({
      text: JSON.stringify({ edits: [{ path: "../escape.ts", contents: "nope" }] }),
    });
    await expect(
      new WorkersAiExecutor({ invoke }).execute({
        worktreeDir: worktree,
        workUnitId: "x",
        objective: "x",
        paths: ["src/x.ts"],
        baselineRef: "HEAD",
      }),
    ).rejects.toThrow(/worktree-relative|escapes the worktree/);
  });

  it("falls back to the small model when the headline model call throws", async () => {
    const calls: string[] = [];
    const invoke: WorkersAiInvoke = async (request) => {
      calls.push(request.model);
      if (request.model === DEFAULT_WORKERS_AI_MODEL) {
        throw new Error("headline model unavailable");
      }
      return {
        text: JSON.stringify({ edits: [{ path: "src/x.ts", contents: "export const x = 2;\n" }] }),
      };
    };
    const result = await new WorkersAiExecutor({ invoke, fallbackModel: "@cf/small/model" }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
    });
    expect(calls).toEqual([DEFAULT_WORKERS_AI_MODEL, "@cf/small/model"]);
    expect(result.cost.model).toBe("@cf/small/model");
  });
});

describe("createWorkersAiRestInvoke", () => {
  it("posts to the account model run endpoint with a bearer token and parses the reply", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          result: { response: "{\"edits\":[]}", usage: { prompt_tokens: 5, completion_tokens: 3 } },
          success: true,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const invoke = createWorkersAiRestInvoke({
      accountId: "acct-123",
      apiToken: "secret-token-value",
      fetchFn: fakeFetch,
    });
    const result = await invoke({
      model: DEFAULT_WORKERS_AI_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(seenUrl).toContain("/accounts/acct-123/ai/run/@cf/qwen/qwen2.5-coder-32b-instruct");
    expect(seenAuth).toBe("Bearer secret-token-value");
    expect(seenBody).toContain("\"messages\"");
    expect(result.text).toBe('{"edits":[]}');
    expect(result.usage?.inputTokens).toBe(5);
    expect(result.usage?.outputTokens).toBe(3);
  });

  it("throws without leaking the token when the API returns an error", async () => {
    const fakeFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: fakeFetch,
    });
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/Workers AI call failed/);
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.not.toThrow(/secret-token-value/);
  });

  it("aborts and throws a distinct timeout error when a call hangs past the timeout", async () => {
    // A fetch that never resolves on its own, but honors the AbortSignal the
    // transport attaches, so the configured timeout is what ends it. This is the
    // hung-call failure mode: without the timeout the agent would wait forever.
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as { name: string }).name = "AbortError";
            reject(err);
          });
        }
      })) as unknown as typeof fetch;

    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: hangingFetch,
      timeoutMs: 20,
    });
    const started = Date.now();
    await expect(
      invoke({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(WorkersAiTimeoutError);
    // It did not hang: it returned promptly once the timeout aborted the call.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("WorkersAiExecutor bounded retry (tolerating transient model errors)", () => {
  const okReply = JSON.stringify({
    edits: [{ path: "src/x.ts", contents: "export const x = 1;\n" }],
  });

  it("retries a transient provider error a bounded number of times, then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const invoke: WorkersAiInvoke = async () => {
      calls += 1;
      // Fail transiently on the first attempt (both headline and fallback within
      // that attempt), then succeed on the retry.
      if (calls <= 2) {
        throw new Error("internal error: 5xx from the provider");
      }
      return { text: okReply };
    };
    const result = await new WorkersAiExecutor({
      invoke,
      maxRetries: 2,
      retryBackoffMs: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
    });
    expect(result.changedPaths).toEqual(["src/x.ts"]);
    // One backoff happened (one retry), with no real delay (injected sleep).
    expect(sleeps.length).toBe(1);
  });

  it("fails the unit after exhausting the bounded retries on a persistently erroring executor", async () => {
    let attempts = 0;
    const invoke: WorkersAiInvoke = async () => {
      attempts += 1;
      throw new Error("internal error");
    };
    await expect(
      new WorkersAiExecutor({
        invoke,
        // Disable the second model so each attempt is exactly one invoke call,
        // making the attempt count easy to assert.
        model: "m",
        fallbackModel: "m",
        maxRetries: 2,
        retryBackoffMs: 0,
      }).execute({
        worktreeDir: worktree,
        workUnitId: "x",
        objective: "add x",
        paths: ["src/x.ts"],
        baselineRef: "HEAD",
      }),
    ).rejects.toThrow(/internal error/);
    // 1 initial attempt + 2 bounded retries = 3 invoke calls, then it gives up.
    expect(attempts).toBe(3);
  });

  it("does not retry a non-transient failure (a bad model reply is an honest failure)", async () => {
    let attempts = 0;
    const invoke: WorkersAiInvoke = async () => {
      attempts += 1;
      return { text: "I cannot help with that." }; // not JSON: UnusableModelOutputError
    };
    await expect(
      new WorkersAiExecutor({ invoke, maxRetries: 3, retryBackoffMs: 0 }).execute({
        worktreeDir: worktree,
        workUnitId: "x",
        objective: "add x",
        paths: ["src/x.ts"],
        baselineRef: "HEAD",
      }),
    ).rejects.toThrow(UnusableModelOutputError);
    // A bad reply is not transient, so it is not retried: exactly one attempt
    // (headline model only, since the default fallback differs but a bad reply
    // is not a thrown provider error, so the fallback path is not taken).
    expect(attempts).toBe(1);
  });

  it("classifies transient vs hard errors", () => {
    expect(isTransientWorkersAiError(new WorkersAiTimeoutError("timed out"))).toBe(true);
    expect(isTransientWorkersAiError(new Error("Workers AI call failed (HTTP 500)"))).toBe(true);
    expect(isTransientWorkersAiError(new Error("internal error"))).toBe(true);
    expect(isTransientWorkersAiError(new UnusableModelOutputError("no edits"))).toBe(false);
    expect(isTransientWorkersAiError(new Error("HTTP 400 bad request"))).toBe(false);
  });
});

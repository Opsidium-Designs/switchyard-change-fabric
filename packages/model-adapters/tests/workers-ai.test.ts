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

describe("WorkersAiExecutor streaming and step callbacks (fake transport, deterministic/offline)", () => {
  const okReply = JSON.stringify({
    edits: [{ path: "src/x.ts", contents: "export const x = 1;\n" }],
  });

  /**
   * A deterministic FAKE streaming transport: it ignores the network and simply
   * relays a fixed sequence of token deltas through the streaming callbacks (as
   * a real Workers AI streaming call would), then returns the assembled reply.
   * This is what keeps the streaming path testable offline: no fetch, no SSE, no
   * real model, yet the executor's token/step relay is exercised exactly.
   */
  const fakeStreamingInvoke = (chunks: readonly string[]): WorkersAiInvoke => {
    return async (_request, callbacks) => {
      for (const chunk of chunks) {
        callbacks?.onToken?.(chunk);
      }
      return { text: chunks.join(""), usage: { inputTokens: 11, outputTokens: 7 } };
    };
  };

  it("relays streamed tokens through the context onToken callback deterministically", async () => {
    const chunks = ['{"edits":[{"path":"src/x.ts",', '"contents":"export ', 'const x = 1;\\n"}]}'];
    const streamed: string[] = [];
    const result = await new WorkersAiExecutor({ invoke: fakeStreamingInvoke(chunks) }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
      onToken: (chunk) => streamed.push(chunk),
    });
    // The tokens the console would render are exactly the real deltas the
    // transport streamed, in order, assembling the real model output.
    expect(streamed).toEqual(chunks);
    expect(streamed.join("")).toBe(chunks.join(""));
    // The assembled stream was still parsed into the real edit and applied.
    expect(result.changedPaths).toEqual(["src/x.ts"]);
    const written = await readFile(join(worktree, "src/x.ts"), "utf8");
    expect(written).toBe("export const x = 1;\n");
  });

  it("surfaces a prompt summary and concrete run steps through the context callbacks", async () => {
    let promptSummary = "";
    const steps: Array<{ phase: string; message: string }> = [];
    await new WorkersAiExecutor({ invoke: fakeStreamingInvoke([okReply]) }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add input validation",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
      onPromptSummary: (summary) => {
        promptSummary = summary;
      },
      onStep: (step) => steps.push(step),
    });
    // The prompt summary is the REAL prompt (objective + scope), readable and
    // carrying no file contents and no secret.
    expect(promptSummary).toContain("add input validation");
    expect(promptSummary).toContain("src/x.ts");
    // The executor emitted concrete run steps for the model call and the applied
    // edit, so the activity log is built from real steps rather than UI guesses.
    expect(steps.some((s) => s.phase === "model-call")).toBe(true);
    expect(steps.some((s) => s.phase === "applied-edit")).toBe(true);
    const applied = steps.find((s) => s.phase === "applied-edit");
    expect(applied?.message).toContain("src/x.ts");
  });

  it("a best-effort callback that throws never fails the run", async () => {
    const result = await new WorkersAiExecutor({ invoke: fakeStreamingInvoke([okReply]) }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
      onToken: () => {
        throw new Error("observer blew up");
      },
      onStep: () => {
        throw new Error("observer blew up");
      },
      onPromptSummary: () => {
        throw new Error("observer blew up");
      },
    });
    // The edit still applied despite every observability callback throwing.
    expect(result.changedPaths).toEqual(["src/x.ts"]);
  });
});

describe("createWorkersAiRestInvoke streaming", () => {
  it("parses a Workers AI SSE stream, relays each real delta, and assembles the full reply", async () => {
    // A fake fetch returning a Workers AI style SSE body: one event per delta,
    // each `data: {"response":"<delta>"}`, ending with `[DONE]`. This exercises
    // the real stream-parsing path with no network and no live model.
    const deltas = ['{"edits":[', '{"path":"src/x.ts",', '"contents":"ok"}]}'];
    const sse =
      deltas.map((d) => `data: ${JSON.stringify({ response: d })}\n\n`).join("") +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 9 } })}\n\n` +
      "data: [DONE]\n\n";
    const fakeFetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: fakeFetch,
    });
    const relayed: string[] = [];
    const result = await invoke(
      { model: DEFAULT_WORKERS_AI_MODEL, messages: [{ role: "user", content: "hi" }] },
      { onToken: (chunk) => relayed.push(chunk) },
    );
    // Each streamed delta was relayed in order; the assembled text is the full
    // real reply the executor then parses.
    expect(relayed).toEqual(deltas);
    expect(result.text).toBe(deltas.join(""));
    expect(result.usage?.inputTokens).toBe(3);
    expect(result.usage?.outputTokens).toBe(9);
  });

  it("does not stream (no stream flag) when no token callback is given", async () => {
    let sawStreamFlag = false;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      sawStreamFlag = String(init?.body ?? "").includes('"stream":true');
      return new Response(
        JSON.stringify({ result: { response: '{"edits":[]}' }, success: true }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: fakeFetch,
    });
    await invoke({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(sawStreamFlag).toBe(false);
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

    expect(seenUrl).toContain("/accounts/acct-123/ai/run/@cf/qwen/qwen3.8-27b");
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

describe("createWorkersAiRestInvoke response parsing (OpenAI shape and legacy shape, offline)", () => {
  // Build an offline fake fetch that returns a fixed JSON body with status 200,
  // so the parsing path is exercised with no network and no live model.
  const bodyFetch = (payload: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

  const editDoc = JSON.stringify({
    edits: [{ path: "src/x.ts", contents: "export const x = 1;\n" }],
  });

  it("reads the OpenAI-style choices[0].message.content and ignores the separate reasoning field", async () => {
    // The qwen3.8 shape: the real edit JSON is in message.content, with the
    // model's chain-of-thought in a separate `reasoning` field that must NOT be
    // read as the reply (it is not the edit document).
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: bodyFetch({
        result: {
          choices: [
            {
              message: {
                content: editDoc,
                reasoning: "First I will consider the types, then edit the file.",
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        },
        success: true,
      }),
    });
    const result = await invoke({
      model: DEFAULT_WORKERS_AI_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    // The parsed text is exactly the content, not the reasoning.
    expect(result.text).toBe(editDoc);
    expect(result.text).not.toContain("chain-of-thought");
    expect(result.text).not.toContain("consider the types");
    expect(result.usage?.inputTokens).toBe(12);
    expect(result.usage?.outputTokens).toBe(8);
  });

  it("still reads the legacy result.response shape for models that use it", async () => {
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: bodyFetch({ result: { response: editDoc }, success: true }),
    });
    const result = await invoke({
      model: DEFAULT_WORKERS_AI_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe(editDoc);
  });

  it("reads a top-level OpenAI shape (choices at the root, not nested under result)", async () => {
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: bodyFetch({ choices: [{ message: { content: editDoc } }], success: true }),
    });
    const result = await invoke({
      model: DEFAULT_WORKERS_AI_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe(editDoc);
  });

  it("assembles an OpenAI-style SSE stream (choices[].delta.content) and ignores reasoning deltas", async () => {
    // The qwen3.8 streaming shape: each event carries a `choices[0].delta.content`
    // token, with chain-of-thought in a separate `reasoning` delta that must not
    // be assembled into the edit text. Exercised offline with no live model.
    const deltas = ['{"edits":[', '{"path":"src/x.ts",', '"contents":"ok"}]}'];
    const sse =
      // A leading reasoning-only event that must be ignored.
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "thinking first" } }] })}\n\n` +
      deltas
        .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
        .join("") +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 6 } })}\n\n` +
      "data: [DONE]\n\n";
    const fakeFetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: fakeFetch,
    });
    const relayed: string[] = [];
    const result = await invoke(
      { model: DEFAULT_WORKERS_AI_MODEL, messages: [{ role: "user", content: "hi" }] },
      { onToken: (chunk) => relayed.push(chunk) },
    );
    // Only the content deltas were relayed and assembled; the reasoning delta
    // was dropped, so the assembled reply is the exact edit JSON.
    expect(relayed).toEqual(deltas);
    expect(result.text).toBe(deltas.join(""));
    expect(result.text).not.toContain("thinking first");
    expect(result.usage?.inputTokens).toBe(4);
    expect(result.usage?.outputTokens).toBe(6);
  });

  it("parses an OpenAI-shape reply into the exact edit JSON the executor would apply (no network)", async () => {
    // The REST transport (called directly, non-streaming) turns a qwen3.8-shape
    // reply into the edit JSON text, instead of a silently empty "" that would
    // trip UnusableModelOutputError downstream. The executor's own
    // apply-the-edit behavior is covered by the fake-transport tests above; here
    // we prove the parsed text is exactly the edit document, reasoning ignored.
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: bodyFetch({
        result: { choices: [{ message: { content: editDoc, reasoning: "ignored" } }] },
        success: true,
      }),
    });
    const parsed = await invoke({
      model: DEFAULT_WORKERS_AI_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.text).toBe(editDoc);
    expect(JSON.parse(parsed.text).edits[0].path).toBe("src/x.ts");
  });
});

describe("WorkersAiExecutor per-attempt model id (so a retry can escalate, offline)", () => {
  const okReply = JSON.stringify({
    edits: [{ path: "src/x.ts", contents: "export const x = 1;\n" }],
  });

  it("defaults to the configured base model when no per-attempt model is given", async () => {
    const seen: string[] = [];
    const invoke: WorkersAiInvoke = async (request) => {
      seen.push(request.model);
      return { text: okReply };
    };
    const result = await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
    });
    expect(seen).toEqual([DEFAULT_WORKERS_AI_MODEL]);
    expect(result.cost.model).toBe(DEFAULT_WORKERS_AI_MODEL);
  });

  it("threads a per-attempt model id into the call and records it in cost.model", async () => {
    // This is how the escalation ladder runs attempt 2 on a stronger model: it
    // passes the escalation model id as context.model for that attempt. The
    // executor runs that id and reports it back so the caller can show which
    // model produced the attempt.
    const escalationModel = "@cf/zai-org/glm-5.3";
    const seen: string[] = [];
    const invoke: WorkersAiInvoke = async (request) => {
      seen.push(request.model);
      return { text: okReply };
    };
    const result = await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
      model: escalationModel,
    });
    expect(seen).toEqual([escalationModel]);
    expect(result.cost.model).toBe(escalationModel);
  });
});

describe("createWorkersAiRestInvoke streaming deadline (a stalled stream must not hang)", () => {
  // Regression: a streaming SSE body that opens but never closes (the model
  // errored mid-stream) previously hung forever because the deadline timer was
  // cleared when the response HEADERS arrived, before the body was read. The
  // Worker then got cancelled by the runtime for "hanging". The fix keeps the
  // deadline live through the stream read. This test gives a body that emits one
  // delta then never ends, with a tiny timeout, and asserts a clean timeout.
  it("aborts a never-closing stream with a timeout error instead of hanging", async () => {
    // A ReadableStream that sends one SSE delta then stalls forever (never
    // enqueues again and never closes), simulating a server-side mid-stream
    // failure. No real network; deterministic and offline.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":"partial"}\n'));
        // Intentionally never close and never enqueue again.
      },
    });
    const fetchFn = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "token-not-logged",
      fetchFn,
      timeoutMs: 50,
    });

    await expect(
      invoke(
        { model: DEFAULT_WORKERS_AI_MODEL, messages: [{ role: "user", content: "hi" }] },
        { onToken: () => {} },
      ),
    ).rejects.toBeInstanceOf(WorkersAiTimeoutError);
  });
});

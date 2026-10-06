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

  it("includes the preserve-exports instruction with the module's real export names", async () => {
    await mkdir(join(worktree, "src", "resources"), { recursive: true });
    await writeFile(
      join(worktree, "src/resources/users.js"),
      "export async function handle(request, parts) { return request; }\n",
      "utf8",
    );

    let seenSystem = "";
    let seenUser = "";
    const invoke: WorkersAiInvoke = async (request) => {
      seenSystem = request.messages.find((m) => m.role === "system")?.content ?? "";
      seenUser = request.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        text: JSON.stringify({
          commitMessage: "fix users resource",
          edits: [
            {
              path: "src/resources/users.js",
              contents: "export async function handle(request, parts) { return request; }\n",
            },
          ],
        }),
      };
    };

    await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "add-src-resources-users",
      objective: "require auth and validate input in users",
      paths: ["src/resources/users.js"],
      baselineRef: "HEAD",
      requiredExports: ["handle"],
    });

    // The system prompt steers the model to start from the current contents and
    // make the minimal change, keeping its exported interface intact.
    expect(seenSystem).toMatch(/preserve the exported interface/i);
    expect(seenSystem).toMatch(/START FROM THE CURRENT CONTENTS/i);
    expect(seenSystem).toMatch(/MINIMAL change/i);
    // The system prompt now carries the frozen auth-guard contract guidance: a
    // guard returning a Response ONLY when it rejects (null-ish when it accepts)
    // must be short-circuited ONLY on a truthy Response, and a valid authorized
    // request MUST return a 2xx success rather than an error on the valid path.
    // The guidance is goal-agnostic: it is phrased about honoring the contract,
    // not about any service-api resource name.
    expect(seenSystem).toMatch(/returns a Response ONLY when it rejects/i);
    expect(seenSystem).toMatch(/MUST perform the real work and return a 2xx/i);
    expect(seenSystem).toMatch(/never return an error helper .* on the authorized, valid path/i);
    expect(seenSystem).toMatch(/exactly once and reuse/i);
    // Goal-agnostic: it never hardcodes a resource name like users/orders.
    expect(seenSystem).not.toMatch(/\busers\b/i);
    expect(seenSystem).not.toMatch(/\brequireAuth\b/);
    // The system prompt names the real export and the concrete `export function`
    // / `export { ... }` syntax the file MUST still contain, so the instruction
    // is forceful and concrete rather than advisory.
    expect(seenSystem).toContain("handle");
    expect(seenSystem).toMatch(/export function handle/);
    expect(seenSystem).toMatch(/export \{ handle \}/);
    // The user prompt lists the real export name the service-api resource keeps,
    // with the same concrete syntax.
    expect(seenUser).toMatch(/Required exports/);
    expect(seenUser).toContain("handle");
    expect(seenUser).toMatch(/export function handle/);
  });

  it("renders the frozen contract file CONTENTS as read-only reference and tells the model to call only exported names", async () => {
    await mkdir(join(worktree, "src", "resources"), { recursive: true });
    await writeFile(
      join(worktree, "src/resources/users.js"),
      "export async function handle(request, parts) { return request; }\n",
      "utf8",
    );

    let seenSystem = "";
    let seenUser = "";
    const invoke: WorkersAiInvoke = async (request) => {
      seenSystem = request.messages.find((m) => m.role === "system")?.content ?? "";
      seenUser = request.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        text: JSON.stringify({
          commitMessage: "require auth and validate",
          edits: [
            {
              path: "src/resources/users.js",
              contents: "export async function handle(request, parts) { return request; }\n",
            },
          ],
        }),
      };
    };

    await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "add-src-resources-users",
      objective: "require auth and validate input in users",
      paths: ["src/resources/users.js"],
      baselineRef: "HEAD",
      frozenContracts: ["src/contracts/auth.js", "src/contracts/response.js"],
      // The real contract bodies, exactly as run-live reads them from the repo.
      frozenContractFiles: [
        {
          path: "src/contracts/auth.js",
          contents:
            "import { problem } from './response.js';\nexport const DEMO_TOKEN = 'demo-token';\nexport function requireAuth(request) { return null; }\n",
        },
        {
          path: "src/contracts/response.js",
          contents:
            "export function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }\n" +
            "export function problem(status, detail) { return new Response(JSON.stringify({ error: detail }), { status }); }\n" +
            "export async function readBody(request) { return {}; }\n",
        },
      ],
    });

    // The system prompt now tells the model to call ONLY the real exports and
    // not invent helper names, backed by the real contents shown below.
    expect(seenSystem).toMatch(/Call ONLY functions these contracts actually export/i);
    expect(seenSystem).toMatch(/do not invent helper names/i);

    // The user prompt carries the real contract API, not just the paths: the
    // requireAuth signature from auth.js and the json/problem/readBody exports
    // from response.js. Before the fix only the paths were listed, so the model
    // could not know these names existed.
    expect(seenUser).toMatch(/Frozen contract files \(READ-ONLY REFERENCE/i);
    expect(seenUser).toContain("--- FROZEN CONTRACT: src/contracts/auth.js ---");
    expect(seenUser).toContain("export function requireAuth(request)");
    expect(seenUser).toContain("--- FROZEN CONTRACT: src/contracts/response.js ---");
    expect(seenUser).toContain("export function json");
    expect(seenUser).toContain("export function problem");
    expect(seenUser).toContain("export async function readBody");
    // The paths are still listed too (the existing instruction is kept).
    expect(seenUser).toContain("src/contracts/auth.js");
  });

  it("is empty-safe: with no frozen contract files the prompt carries no contents block", async () => {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/leaf2.ts"), "const internal = 1;\n", "utf8");

    let seenUser = "";
    const invoke: WorkersAiInvoke = async (request) => {
      seenUser = request.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        text: JSON.stringify({ edits: [{ path: "src/leaf2.ts", contents: "const internal = 2;\n" }] }),
      };
    };

    await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "leaf2",
      objective: "tweak leaf",
      paths: ["src/leaf2.ts"],
      baselineRef: "HEAD",
      // No frozenContractFiles: the read-only REFERENCE block must not appear.
    });

    expect(seenUser).not.toMatch(/READ-ONLY REFERENCE/i);
    expect(seenUser).not.toContain("--- FROZEN CONTRACT:");
  });

  it("omits the required-exports block when the module has no captured exports", async () => {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/leaf.ts"), "const internal = 1;\n", "utf8");

    let seenUser = "";
    const invoke: WorkersAiInvoke = async (request) => {
      seenUser = request.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        text: JSON.stringify({
          edits: [{ path: "src/leaf.ts", contents: "const internal = 2;\n" }],
        }),
      };
    };

    await new WorkersAiExecutor({ invoke }).execute({
      worktreeDir: worktree,
      workUnitId: "leaf",
      objective: "tweak leaf",
      paths: ["src/leaf.ts"],
      baselineRef: "HEAD",
    });

    // No captured exports means no required-exports block (existing callers
    // produce the exact same prompt they did before).
    expect(seenUser).not.toMatch(/Required exports/);
  });

  it("tolerates a markdown-fenced JSON reply", async () => {    const invoke: WorkersAiInvoke = async () => ({
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

  it("retries the SAME base model on a transient throw (never switches to a different model)", async () => {
    const calls: string[] = [];
    const invoke: WorkersAiInvoke = async (request) => {
      calls.push(request.model);
      if (calls.length === 1) {
        // The base model's first call throws transiently.
        throw new Error("internal error; reference=abc123");
      }
      // The retry must be the SAME base model, not a different one.
      return {
        text: JSON.stringify({ edits: [{ path: "src/x.ts", contents: "export const x = 2;\n" }] }),
      };
    };
    // A deprecated fallbackModel is set but must be ignored: no model swap.
    const result = await new WorkersAiExecutor({
      invoke,
      fallbackModel: "@cf/small/model",
      maxRetries: 2,
      retryBackoffMs: 0,
    }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
    });
    // Both the failing attempt and the retry used the SAME base model id; the
    // configured fallback model was never called.
    expect(calls).toEqual([DEFAULT_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL]);
    expect(calls).not.toContain("@cf/small/model");
    // The reported model stays the base model, never a different one.
    expect(result.cost.model).toBe(DEFAULT_WORKERS_AI_MODEL);
  });
});

describe("WorkersAiExecutor step and prompt callbacks (fake transport, deterministic/offline)", () => {
  const okReply = JSON.stringify({
    edits: [{ path: "src/x.ts", contents: "export const x = 1;\n" }],
  });

  /**
   * A deterministic FAKE non-streaming transport: it ignores the network and
   * simply returns a fixed reply (as a real non-streaming Workers AI call
   * would). This is what keeps the model-call path testable offline: no fetch,
   * no SSE, no real model, yet the executor's prompt/step relay is exercised.
   */
  const fakeInvoke = (reply: string): WorkersAiInvoke => {
    return async () => {
      return { text: reply, usage: { inputTokens: 11, outputTokens: 7 } };
    };
  };

  it("surfaces a prompt summary and concrete run steps through the context callbacks", async () => {
    let promptSummary = "";
    const steps: Array<{ phase: string; message: string }> = [];
    await new WorkersAiExecutor({ invoke: fakeInvoke(okReply) }).execute({
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
    const result = await new WorkersAiExecutor({ invoke: fakeInvoke(okReply) }).execute({
      worktreeDir: worktree,
      workUnitId: "x",
      objective: "add x",
      paths: ["src/x.ts"],
      baselineRef: "HEAD",
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

describe("createWorkersAiRestInvoke (always non-streaming)", () => {
  it("never sends a stream flag and parses the non-streaming reply", async () => {
    let sawStreamFlag = false;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      sawStreamFlag = String(init?.body ?? "").includes('"stream"');
      return new Response(
        JSON.stringify({
          result: { response: '{"edits":[{"path":"src/x.ts","contents":"ok"}]}' },
          success: true,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const invoke = createWorkersAiRestInvoke({
      accountId: "acct",
      apiToken: "secret-token-value",
      fetchFn: fakeFetch,
    });
    const result = await invoke({ model: "m", messages: [{ role: "user", content: "x" }] });
    // No stream flag is ever sent, even if a (now ignored) callbacks argument is
    // passed: the model is always called non-streaming.
    expect(sawStreamFlag).toBe(false);
    expect(result.text).toBe('{"edits":[{"path":"src/x.ts","contents":"ok"}]}');
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

    expect(seenUrl).toContain("/accounts/acct-123/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(seenAuth).toBe("Bearer secret-token-value");
    expect(seenBody).toContain("\"messages\"");
    // Regression: the request MUST send a generous max_tokens. Workers AI
    // otherwise caps output at a small default (around 256) that truncates a
    // full-file edit mid-string, so the reply fails to parse and the unit fails
    // with "no usable edit". Assert the body carries max_tokens.
    expect(seenBody).toContain("\"max_tokens\"");
    expect(JSON.parse(seenBody).max_tokens).toBeGreaterThanOrEqual(2048);
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
      // Each try is exactly one invoke of the SAME model. Fail transiently on the
      // first attempt, then succeed on the retry.
      if (calls <= 1) {
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
    expect(result.cost.model).toBe(DEFAULT_WORKERS_AI_MODEL);
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
        model: "m",
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
    // 1 initial attempt + 2 bounded retries = 3 invoke calls of the SAME model,
    // then it gives up. No model swap ever happens.
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
    // A bad reply is not transient, so it is not retried and the model is never
    // swapped: exactly one attempt of the base model.
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
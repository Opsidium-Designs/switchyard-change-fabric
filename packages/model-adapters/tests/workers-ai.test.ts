import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWorkersAiRestInvoke,
  DEFAULT_WORKERS_AI_MODEL,
  UnusableModelOutputError,
  WorkersAiExecutor,
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
});

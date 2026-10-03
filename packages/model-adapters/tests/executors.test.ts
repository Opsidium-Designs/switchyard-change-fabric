import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NoopExecutor, OpenAiCompatibleExecutor } from "../src/index.ts";

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "scf-exec-"));
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

describe("NoopExecutor", () => {
  it("writes a deterministic marker and reports zero cost", async () => {
    const executor = new NoopExecutor({ markerDir: "src/alpha" });
    const result = await executor.execute({
      worktreeDir: worktree,
      workUnitId: "alpha",
      objective: "do alpha",
      paths: ["src/alpha/**"],
      baselineRef: "HEAD",
    });

    expect(result.status).toBe("changed");
    expect(result.changedPaths).toEqual(["src/alpha/alpha.done"]);
    expect(result.cost.usd).toBe(0);

    const body = await readFile(join(worktree, "src/alpha/alpha.done"), "utf8");
    expect(body).toContain("work-unit: alpha");
    expect(body).toContain("executor: noop");
  });

  it("is byte-for-byte deterministic for the same inputs", async () => {
    const makeResult = async () => {
      const dir = await mkdtemp(join(tmpdir(), "scf-exec-det-"));
      await new NoopExecutor({ markerDir: "x", stamp: "2020-01-01T00:00:00.000Z" }).execute({
        worktreeDir: dir,
        workUnitId: "same",
        objective: "same objective",
        paths: ["x/**"],
        baselineRef: "HEAD",
      });
      const body = await readFile(join(dir, "x/same.done"), "utf8");
      await rm(dir, { recursive: true, force: true });
      return body;
    };
    expect(await makeResult()).toBe(await makeResult());
  });
});

describe("OpenAiCompatibleExecutor", () => {
  it("requires an injected transport (never embeds a credential)", () => {
    expect(
      () =>
        new OpenAiCompatibleExecutor({
          model: "provider/model",
          // @ts-expect-error intentionally missing chat transport
          chat: undefined,
        }),
    ).toThrow(/chat` transport/i);
  });

  it("applies proposed edits and computes cost from usage and pricing", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const executor = new OpenAiCompatibleExecutor({
      model: "provider/model",
      pricePer1kInputUsd: 0.001,
      pricePer1kOutputUsd: 0.002,
      writeFile: async (absPath, contents) => {
        writes.push({ path: absPath, contents });
      },
      chat: async () => ({
        edits: [{ path: "src/a.ts", contents: "export const a = 1;\n" }],
        usage: { inputTokens: 1000, outputTokens: 500 },
        commitMessage: "add a",
      }),
    });

    const result = await executor.execute({
      worktreeDir: worktree,
      workUnitId: "a",
      objective: "add a",
      paths: ["src/**"],
      baselineRef: "HEAD",
    });

    expect(result.status).toBe("changed");
    expect(result.changedPaths).toEqual(["src/a.ts"]);
    // 1000/1000 * 0.001 + 500/1000 * 0.002 = 0.001 + 0.001 = 0.002
    expect(result.cost.usd).toBe(0.002);
    expect(result.cost.model).toBe("provider/model");
    expect(writes).toHaveLength(1);
  });

  it("rejects edit paths that escape the worktree", async () => {
    const executor = new OpenAiCompatibleExecutor({
      model: "m",
      chat: async () => ({
        edits: [{ path: "../escape.ts", contents: "nope" }],
        usage: { inputTokens: 0, outputTokens: 0 },
        commitMessage: "escape",
      }),
    });
    await expect(
      executor.execute({
        worktreeDir: worktree,
        workUnitId: "a",
        objective: "x",
        paths: [],
        baselineRef: "HEAD",
      }),
    ).rejects.toThrow(/worktree-relative/);
  });
});

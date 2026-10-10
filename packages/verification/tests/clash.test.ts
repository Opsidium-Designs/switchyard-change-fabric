/**
 * Clash prediction over real local Git (no network, no checkout of the heads):
 * a disjoint pair, edits to one file that merge cleanly, a true conflict, the
 * shared/local scope of a conflict, a file/directory clash the disjoint
 * pre-filter must not call clean, the pair limit, and that the repo's own
 * object store is left untouched.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { predictClashes, type ClashHead } from "../src/clash.ts";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@switchyard.local"];

let root: string;
let repo: string;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-clash-test-"));
  repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await run("git", ["-C", repo, "init", "-q", "--initial-branch=main"]);
  await write({
    "src/shared/contract.ts": lines("export type A = 1;", 1, 12),
    "src/a/one.ts": lines("one", 1, 12),
    "src/b/two.ts": lines("two", 1, 12),
    "notes/item.md": "note\n",
  });
  base = await commitAll("base");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function lines(prefix: string, from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) {
    out.push(`${prefix} line ${i}`);
  }
  return `${out.join("\n")}\n`;
}

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
}

async function commitAll(message: string): Promise<string> {
  await run("git", ["-C", repo, "add", "-A"]);
  await run("git", ["-C", repo, ...IDENTITY, "commit", "-q", "--no-verify", "-m", message]);
  return (await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
}

/** Make an agent head on top of the base: apply `edit` and commit it on its own branch. */
async function head(agent: string, edit: () => Promise<void>): Promise<ClashHead> {
  await run("git", ["-C", repo, "checkout", "-q", "-B", `agent/${agent}`, base]);
  await edit();
  const sha = await commitAll(`work by ${agent}`);
  return { agent, item: `item-${agent}`, sha };
}

async function replaceLine(path: string, n: number, text: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const content = (await readFile(join(repo, path), "utf8")).split("\n");
  content[n - 1] = text;
  await writeFile(join(repo, path), content.join("\n"));
}

async function looseObjectCount(): Promise<number> {
  const dirs = await readdir(join(repo, ".git", "objects"));
  let count = 0;
  for (const d of dirs.filter((x) => /^[0-9a-f]{2}$/.test(x))) {
    count += (await readdir(join(repo, ".git", "objects", d))).length;
  }
  return count;
}

describe("predictClashes", () => {
  it("calls heads that touch disjoint files clean without merging them", async () => {
    const a = await head("a", () => replaceLine("src/a/one.ts", 2, "changed by a"));
    const b = await head("b", () => replaceLine("src/b/two.ts", 2, "changed by b"));
    const result = await predictClashes({ repoDir: repo, base, heads: [a, b] });
    expect(result.status).toBe("ok");
    expect(result.pairs).toEqual([{ a, b, outcome: { kind: "clean", reason: "disjoint" } }]);
  });

  it("calls non-overlapping edits to the same file a clean merge", async () => {
    const a = await head("a", () => replaceLine("src/a/one.ts", 1, "top edit by a"));
    const b = await head("b", () => replaceLine("src/a/one.ts", 12, "bottom edit by b"));
    const result = await predictClashes({ repoDir: repo, base, heads: [a, b] });
    expect(result.pairs[0]?.outcome).toEqual({ kind: "clean", reason: "merged" });
  });

  it("reports a true conflict with its paths, scoped local when no path is shared", async () => {
    const a = await head("a", () => replaceLine("src/a/one.ts", 5, "a's version"));
    const b = await head("b", () => replaceLine("src/a/one.ts", 5, "b's version"));
    const before = await looseObjectCount();
    const result = await predictClashes({ repoDir: repo, base, heads: [a, b], isSharedPath: (p) => p.startsWith("src/shared/") });
    expect(result.pairs[0]?.outcome).toEqual({ kind: "conflict", paths: ["src/a/one.ts"], scope: "local", sharedPaths: [] });
    // The merged trees went to a scratch store: the repo's objects are untouched.
    expect(await looseObjectCount()).toBe(before);
  });

  it("scopes a conflict on shared code as shared (a seam contract would settle it)", async () => {
    const a = await head("a", async () => {
      await replaceLine("src/shared/contract.ts", 3, "export type A = 2;");
      await replaceLine("src/a/one.ts", 3, "a");
    });
    const b = await head("b", async () => {
      await replaceLine("src/shared/contract.ts", 3, "export type A = 3;");
      await replaceLine("src/a/one.ts", 3, "b");
    });
    const result = await predictClashes({ repoDir: repo, base, heads: [a, b], isSharedPath: (p) => p.startsWith("src/shared/") });
    expect(result.pairs[0]?.outcome).toEqual({
      kind: "conflict",
      paths: ["src/a/one.ts", "src/shared/contract.ts"],
      scope: "shared",
      sharedPaths: ["src/shared/contract.ts"],
    });
  });

  it("never calls a file/directory clash disjoint", async () => {
    const a = await head("a", () => write({ "src/new": "a file\n" }));
    const b = await head("b", () => write({ "src/new/inner.ts": "a directory\n" }));
    const result = await predictClashes({ repoDir: repo, base, heads: [a, b] });
    expect(result.pairs[0]?.outcome.kind).toBe("conflict");
  });

  it("decides every pair up to the limit and reports the rest unknown, never clean", async () => {
    const a = await head("a", () => replaceLine("src/a/one.ts", 2, "a"));
    const b = await head("b", () => replaceLine("src/b/two.ts", 2, "b"));
    const c = await head("c", () => write({ "notes/item.md": "c\n" }));
    const bad: ClashHead = { agent: "d", item: "item-d", sha: "not-a-sha" };
    const result = await predictClashes({ repoDir: repo, base, heads: [a, b, c, bad], maxPairs: 4 });
    if (result.status !== "ok") {
      throw new Error("expected a prediction");
    }
    expect(result.pairs).toHaveLength(6);
    expect(result.skippedPairs).toBe(2);
    expect(result.pairs.slice(0, 3).map((p) => p.outcome)).toEqual([
      { kind: "clean", reason: "disjoint" },
      { kind: "clean", reason: "disjoint" },
      { kind: "unknown", reason: "invalid commit id for d: not-a-sha" },
    ]);
    for (const pair of result.pairs.slice(4)) {
      expect(pair.outcome).toEqual({ kind: "unknown", reason: "not checked: over the limit of 4 pairs" });
    }
  });

  it("is unavailable (never clean) on a git without merge-tree --write-tree", async () => {
    const a = await head("a", () => replaceLine("src/a/one.ts", 2, "a"));
    const b = await head("b", () => replaceLine("src/a/one.ts", 2, "b"));
    const bin = join(root, "old-git-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "git"), "#!/bin/sh\necho 'git version 2.30.1'\n", { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    try {
      const result = await predictClashes({ repoDir: repo, base, heads: [a, b] });
      expect(result.status).toBe("unavailable");
      expect(result.pairs).toEqual([]);
      expect(result.status === "unavailable" ? result.reason : "").toMatch(/needs 2\.38/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("reports a head whose objects are missing as unknown", async () => {
    const a = await head("a", () => replaceLine("src/a/one.ts", 2, "a"));
    const ghost: ClashHead = { agent: "ghost", item: "item-g", sha: "f".repeat(40) };
    const result = await predictClashes({ repoDir: repo, base, heads: [a, ghost] });
    const outcome = result.pairs[0]?.outcome;
    expect(outcome?.kind).toBe("unknown");
  });
});

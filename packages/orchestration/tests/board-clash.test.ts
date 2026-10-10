/**
 * Clash alerts from real code: the continuous integrator's prediction over
 * the agents' pending pushes, read from real git objects (merge-tree) and
 * recorded on the board through the engine-record route. Advisory only:
 * clean pairs are never recorded, undecided ones are recorded as such.
 * Offline: local repos and the pure board model.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  appendBoardMessage,
  appendEngineRecord,
  boardDigest,
  emptyBoard,
  reduceBoard,
  type BoardMessage,
  type BoardState,
} from "@switchyard-change/change-core";

import { recordPendingClashes } from "../src/board-clash.ts";

const exec = promisify(execFile);
const AT = "2026-01-01T00:00:00.000Z";

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();
}

/** A bare integration repo with a baseline, and an agent repo cloned from it with one commit writing `files`. */
async function repos(root: string, agents: Record<string, Record<string, string>>): Promise<{ integration: string; baseline: string; heads: Record<string, { dir: string; sha: string }> }> {
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await git(seed, "init", "-q", "-b", "main");
  for (const [rel, body] of Object.entries({ "src/common.ts": "export const common = 1;\n", "src/a/x.ts": "export const x = 1;\n", "src/b/y.ts": "export const y = 1;\n", "src/c/z.ts": "export const z = 1;\n" })) {
    await mkdir(dirname(join(seed, rel)), { recursive: true });
    await writeFile(join(seed, rel), body);
  }
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "baseline");
  const baseline = await git(seed, "rev-parse", "HEAD");
  const integration = join(root, "integration.git");
  await exec("git", ["clone", "-q", "--bare", seed, integration]);
  const heads: Record<string, { dir: string; sha: string }> = {};
  for (const [agent, files] of Object.entries(agents)) {
    const dir = join(root, `agent-${agent}`);
    await exec("git", ["clone", "-q", integration, dir]);
    for (const [rel, body] of Object.entries(files)) {
      await writeFile(join(dir, rel), body);
    }
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", `work of ${agent}`);
    heads[agent] = { dir, sha: await git(dir, "rev-parse", "HEAD") };
  }
  return { integration, baseline, heads };
}

/** The pure board as the operator sees it: a log, the state, and the engine-record route. */
class Board {
  state: BoardState = emptyBoard();
  readonly log: BoardMessage[] = [];
  post(origin: Parameters<typeof appendBoardMessage>[1], raw: unknown): void {
    const r = appendBoardMessage(this.state, origin, raw, AT);
    this.state = r.state;
    this.log.push(...r.appended);
  }
  readonly operator = {
    log: async () => ({ messages: [...this.log], state: this.state }),
    recordEngine: async (type: string, payload: Record<string, unknown>) => {
      try {
        const r = appendEngineRecord(this.state, { type, payload }, AT);
        this.state = r.state;
        this.log.push(...r.appended);
        return { ok: true as const, appended: r.appended };
      } catch (error) {
        return { ok: false as const, code: "REFUSED", error: String(error), status: 400 };
      }
    },
  };
}

function boardWithPushes(heads: Record<string, { sha: string }>, baseline?: string): Board {
  const board = new Board();
  board.post({ kind: "human" }, { type: "goal.posted", payload: { objective: "o", ...(baseline !== undefined ? { baseline } : {}) } });
  board.post({ kind: "join", agent: "lead" }, { type: "agent.joined", payload: { role: "lead" } });
  const scopes: Record<string, string[]> = { a: ["src/a/**", "src/common.ts"], b: ["src/b/**"], c: ["src/c/**"] };
  for (const agent of Object.keys(heads)) {
    board.post({ kind: "join", agent }, { type: "agent.joined", payload: {} });
    board.post({ kind: "agent", agent: "lead" }, { type: "item.proposed", payload: { item: `item-${agent}`, objective: agent, acceptance: [], scopeHint: scopes[agent] } });
  }
  for (const [agent, head] of Object.entries(heads)) {
    board.post({ kind: "agent", agent }, { type: "item.claimed", payload: { item: `item-${agent}`, intent: { read: [], write: scopes[agent] } } });
    board.post({ kind: "agent", agent }, { type: "push.announced", payload: { item: `item-${agent}`, commit: head.sha, paths: [scopes[agent]![0]!.replace("**", agent === "a" ? "x.ts" : agent === "b" ? "y.ts" : "z.ts")] } });
  }
  return board;
}

describe("clash alerts from real code (advisory)", () => {
  it("records a conflict on a file one side ships (once per pair), never a clean pair, and each agent's digest cues it", async () => {
    const root = await mkdtemp(join(tmpdir(), "scf-clash-"));
    // a ships src/common.ts; b's repo changed it too (a copy it does not ship); c is disjoint.
    const { integration, baseline, heads } = await repos(root, {
      a: { "src/common.ts": "export const common = 2;\n", "src/a/x.ts": "export const x = 2;\n" },
      b: { "src/common.ts": "export const common = 3;\n", "src/b/y.ts": "export const y = 2;\n" },
      c: { "src/c/z.ts": "export const z = 2;\n" },
    });
    const board = boardWithPushes(heads, baseline);
    const seen = new Set<string>();
    const input = {
      operator: board.operator,
      integrationRemote: integration,
      integrationBranch: "main",
      readRemote: async (agent: string) => heads[agent]!.dir,
      workRoot: join(root, "work"),
      seen,
    };
    const result = await recordPendingClashes(input);
    expect(result).toEqual({ pairs: 3, recorded: 1, conflicts: 1 });
    const clashes = board.log.filter((m) => m.type === "clash.predicted");
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.payload).toEqual({
      a: { agent: "a", item: "item-a", sha: heads.a!.sha },
      b: { agent: "b", item: "item-b", sha: heads.b!.sha },
      status: "conflict",
      paths: ["src/common.ts"],
      scope: "local",
    });
    expect(clashes[0]!.to).toEqual(["a", "b"]);
    expect(boardDigest(board.state, board.log, "b", 0).claims[0]!.clashes![0]).toMatchObject({ item: "item-a", status: "conflict", hint: expect.stringMatching(/you claimed later, so rebase onto its push/) });
    // Never predicted twice for the same pushes.
    expect(await recordPendingClashes(input)).toEqual({ pairs: 0, recorded: 0, conflicts: 0 });
    expect(reduceBoard(board.log)).toEqual(board.state);
  });

  it("a head that merely lacks what another revision integrated is stale, not a clash: nothing is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "scf-clash-stale-"));
    const { integration, baseline, heads } = await repos(root, { a: { "src/common.ts": "export const common = 2;\n" }, c: { "src/c/z.ts": "export const z = 2;\n" } });
    // Another revision integrated a change to src/common.ts after both agents started (c's repo never merges it back).
    const other = join(root, "other");
    await exec("git", ["clone", "-q", integration, other]);
    await writeFile(join(other, "src/common.ts"), "export const common = 9;\n");
    await git(other, "commit", "-q", "-am", "integrated by someone else");
    await git(other, "push", "-q", "origin", "HEAD:main");
    const board = boardWithPushes(heads, baseline);
    const result = await recordPendingClashes({
      operator: board.operator,
      integrationRemote: integration,
      integrationBranch: "main",
      readRemote: async (agent: string) => heads[agent]!.dir,
      workRoot: join(root, "work"),
      seen: new Set(),
    });
    expect(result).toEqual({ pairs: 1, recorded: 0, conflicts: 0 });
    expect(board.log.some((m) => m.type === "clash.predicted")).toBe(false);
  });

  it("a push that cannot be read is recorded unknown with the reason, never as clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "scf-clash-unread-"));
    const { integration, heads } = await repos(root, { a: { "src/a/x.ts": "export const x = 2;\n" }, b: { "src/b/y.ts": "export const y = 2;\n" } });
    const board = boardWithPushes(heads);
    const result = await recordPendingClashes({
      operator: board.operator,
      integrationRemote: integration,
      integrationBranch: "main",
      readRemote: async (agent: string) => (agent === "b" ? join(root, "missing-repo") : heads[agent]!.dir),
      workRoot: join(root, "work"),
      seen: new Set(),
    });
    expect(result.recorded).toBe(1);
    const clash = board.log.find((m) => m.type === "clash.predicted")!;
    expect(clash.payload).toMatchObject({ status: "unknown", reason: expect.stringMatching(/could not read b's push/) });
  });

  it("with one pending push there is nothing to predict", async () => {
    const root = await mkdtemp(join(tmpdir(), "scf-clash-one-"));
    const { integration, heads } = await repos(root, { a: { "src/a/x.ts": "export const x = 2;\n" } });
    const board = boardWithPushes(heads);
    expect(await recordPendingClashes({ operator: board.operator, integrationRemote: integration, integrationBranch: "main", readRemote: async () => heads.a!.dir, workRoot: join(root, "w"), seen: new Set() })).toEqual({
      pairs: 0,
      recorded: 0,
      conflicts: 0,
    });
  });
});

/**
 * End-to-end: two runners work two distinct workspaces concurrently.
 *
 * This exercises the full MC2 loop deterministically and offline:
 *   - a Change with two independent WorkUnits is created
 *   - two runners lease the two WorkUnits concurrently
 *   - each clones its OWN local-fallback workspace, runs the noop executor
 *     (zero inference), commits, and pushes back
 *   - the Worker records both completions, each with a cost event
 *
 * It asserts isolation (neither workspace sees the other's marker file) and that
 * both pushes landed (each bare repo has exactly one commit touching only its
 * own WorkUnit's path).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { NoopExecutor } from "@switchyard-change/model-adapters";

import { runWorkUnit } from "../src/runner.ts";
import { WorkerClient } from "../src/worker-client.ts";
import { InMemoryWorker } from "./in-memory-worker.ts";

const run = promisify(execFile);

const SPEC = `
id: change-two-units
objective: Two independent WorkUnits run concurrently
baseline: HEAD
budget_usd: 5.00
assurance: standard

work:
  - id: alpha
    objective: Alpha unit does its own work
    paths:
      - src/alpha/**
  - id: beta
    objective: Beta unit does its own work
    paths:
      - src/beta/**
`;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "scf-e2e-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("two runners work two distinct workspaces concurrently", () => {
  it("each clones its own workspace, pushes, and the Worker records both completions with cost", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(rootDir, "artifacts") });
    const worker = new InMemoryWorker(workspaces);
    worker.createChange(SPEC);

    const client = new WorkerClient("http://worker.local", worker.fetch);
    const changeId = "change-two-units";
    const workRoot = join(rootDir, "worktrees");
    await mkdtempRoot(workRoot);

    // Two runners, two distinct WorkUnits, launched concurrently. Each uses a
    // noop executor instance that writes a marker under its own WorkUnit path,
    // so a cross-contamination bug would show up as the wrong marker.
    const [alpha, beta] = await Promise.all([
      runWorkUnit({
        client,
        executor: new NoopExecutor({ markerDir: "src/alpha" }),
        changeId,
        unitId: "alpha",
        workRoot,
      }),
      runWorkUnit({
        client,
        executor: new NoopExecutor({ markerDir: "src/beta" }),
        changeId,
        unitId: "beta",
        workRoot,
      }),
    ]);

    // Both runs committed and pushed.
    expect(alpha.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(beta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(alpha.commit).not.toBe(beta.commit);

    // Both used the honest local fallback workspace, and they are distinct.
    expect(alpha.fallback).toBe(true);
    expect(beta.fallback).toBe(true);
    expect(alpha.workspaceName).not.toBe(beta.workspaceName);

    // The Worker recorded both completions.
    expect([...worker.completed(changeId)].sort()).toEqual(["alpha", "beta"]);

    // Two cost events, one per WorkUnit, with the noop executor and zero cost.
    const events = worker.costEvents(changeId);
    const alphaEvents = events.filter((e) => e.unitId === "alpha");
    const betaEvents = events.filter((e) => e.unitId === "beta");
    expect(alphaEvents.length).toBeGreaterThanOrEqual(1);
    expect(betaEvents.length).toBeGreaterThanOrEqual(1);
    expect(worker.spentUsd(changeId)).toBe(0);
    expect(events.some((e) => e.executor === "noop")).toBe(true);

    // Isolation: each bare repo contains exactly its own marker and not the other's.
    const alphaRepo = bareRepoPath(rootDir, changeId, "alpha");
    const betaRepo = bareRepoPath(rootDir, changeId, "beta");

    const alphaFiles = await listTree(alphaRepo);
    const betaFiles = await listTree(betaRepo);

    expect(alphaFiles).toContain("src/alpha/alpha.done");
    expect(alphaFiles).not.toContain("src/beta/beta.done");

    expect(betaFiles).toContain("src/beta/beta.done");
    expect(betaFiles).not.toContain("src/alpha/alpha.done");

    // Each push landed exactly one commit.
    expect(await commitCount(alphaRepo)).toBe(1);
    expect(await commitCount(betaRepo)).toBe(1);
  });

  it("keeps a dependent WorkUnit un-leasable until its dependency completes", async () => {
    const dependentSpec = `
id: change-dep
objective: Dependent ordering
baseline: HEAD
work:
  - id: base
    objective: base
    paths: [src/base/**]
  - id: top
    objective: top
    depends_on: [base]
    paths: [src/top/**]
`;
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(rootDir, "artifacts") });
    const worker = new InMemoryWorker(workspaces);
    worker.createChange(dependentSpec);
    const client = new WorkerClient("http://worker.local", worker.fetch);
    const changeId = "change-dep";
    const workRoot = join(rootDir, "worktrees");
    await mkdtempRoot(workRoot);

    // `top` cannot be leased yet: it waits on `base`.
    await expect(
      runWorkUnit({ client, executor: new NoopExecutor({ markerDir: "src/top" }), changeId, unitId: "top", workRoot }),
    ).rejects.toThrow(/not runnable/i);

    // Complete `base`; now `top` becomes runnable and runs.
    await runWorkUnit({ client, executor: new NoopExecutor({ markerDir: "src/base" }), changeId, unitId: "base", workRoot });
    const top = await runWorkUnit({
      client,
      executor: new NoopExecutor({ markerDir: "src/top" }),
      changeId,
      unitId: "top",
      workRoot,
    });

    expect(top.commit).toMatch(/^[0-9a-f]{40}$/);
    expect([...worker.completed(changeId)].sort()).toEqual(["base", "top"]);
  });
});

async function mkdtempRoot(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

function bareRepoPath(rootDir: string, changeId: string, unitId: string): string {
  const name = `${changeId}--${unitId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return join(rootDir, "artifacts", `${name}.git`);
}

/** List the file paths present at HEAD of a bare repo. */
async function listTree(bareRepo: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", bareRepo, "ls-tree", "-r", "--name-only", "HEAD"]);
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Count commits reachable from HEAD in a bare repo. */
async function commitCount(bareRepo: string): Promise<number> {
  const { stdout } = await run("git", ["-C", bareRepo, "rev-list", "--count", "HEAD"]);
  return Number(stdout.trim());
}

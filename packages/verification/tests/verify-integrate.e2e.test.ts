/**
 * End-to-end: multiple completed WorkUnit workspaces are verified, the verified
 * ones are integrated into a single combined workspace, the final suite runs
 * over that workspace, and the Change exposes one evidence summary.
 *
 * This is the MC3 exit criterion. It builds on the earlier runner flow: two
 * WorkUnits run with the deterministic noop executor against honest local
 * fallback workspaces (real Git clone/commit/push over file:// remotes), with no
 * model call anywhere. The flow then:
 *   - verifies each completed WorkUnit (clean-state, path-scope, test, lint),
 *   - integrates the verified WorkUnits into one integration workspace,
 *   - runs the final suite over the combined result,
 *   - returns an evidence summary listing each WorkUnit's checks and the
 *     integration result.
 *
 * A second case injects a scope violation into one WorkUnit and asserts that it
 * is marked failed and kept out of integration while the other still integrates.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseChangeSpec,
  runnableUnits,
  type Change,
} from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { ScopedToken, WorkspaceRef } from "@switchyard-change/artifact-workspace";
import { NoopExecutor } from "@switchyard-change/model-adapters";
import { runWorkUnit, WorkerClient, type FetchLike } from "@switchyard-change/local-runner";

import { ChangeVerification, type CompletedWorkUnit } from "../src/change-verification.ts";

const run = promisify(execFile);

const SPEC = `
id: change-mc3
objective: Two WorkUnits are verified and integrated into one result
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

/**
 * A minimal in-process Worker control surface for the runner flow. It reuses the
 * real change-core scheduling and the honest local fallback workspace provider,
 * and keeps the lease records so the test can read each completed WorkUnit's
 * workspace clone URL afterwards.
 */
class TestWorker {
  readonly completed = new Set<string>();
  readonly leases = new Map<string, { ref: WorkspaceRef; token: ScopedToken }>();
  readonly change: Change;

  constructor(
    specYaml: string,
    private readonly workspaces: LocalFilesystemWorkspaceProvider,
  ) {
    this.change = parseChangeSpec(specYaml);
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://worker.local");
    const method = (init?.method ?? "GET").toUpperCase();
    const lease = url.pathname.match(/^\/changes\/[^/]+\/work\/([^/]+)\/lease$/);
    if (method === "POST" && lease) {
      return this.handleLease(decodeURIComponent(lease[1] ?? ""));
    }
    const cost = url.pathname.match(/^\/changes\/[^/]+\/work\/([^/]+)\/cost$/);
    if (method === "POST" && cost) {
      return json({ ok: true }, 200);
    }
    const complete = url.pathname.match(/^\/changes\/[^/]+\/work\/([^/]+)\/complete$/);
    if (method === "POST" && complete) {
      this.completed.add(decodeURIComponent(complete[1] ?? ""));
      return json({ ok: true }, 200);
    }
    return json({ error: "not found" }, 404);
  };

  private async handleLease(unitId: string): Promise<Response> {
    const unit = this.change.work.find((u) => u.id === unitId);
    if (!unit) {
      return json({ error: `unknown WorkUnit: ${unitId}` }, 404);
    }
    if (!runnableUnits(this.change, this.completed).includes(unitId)) {
      return json({ error: `WorkUnit is not runnable: ${unitId}` }, 409);
    }
    const name = `${this.change.id}--${unitId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
    const ref = await this.workspaces.create(name, { defaultBranch: "main" });
    const token = await this.workspaces.issueWriteToken(ref);
    this.leases.set(unitId, { ref, token });
    return json(
      {
        unitId,
        objective: unit.objective,
        paths: unit.paths,
        baselineRef: this.change.baseline,
        workspaceId: ref.id,
        workspaceName: ref.name,
        gitUrl: ref.gitUrl,
        defaultBranch: ref.defaultBranch,
        backend: ref.backend,
        fallback: ref.fallback,
        tokenId: token.id,
        tokenExpiresAt: token.expiresAt,
        token: token.token,
      },
      201,
    );
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "scf-mc3-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("verify then integrate multiple WorkUnits into one result", () => {
  it("produces one integrated verified result with an evidence summary listing each unit's checks", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(rootDir, "artifacts") });
    const worker = new TestWorker(SPEC, workspaces);
    const client = new WorkerClient("http://worker.local", worker.fetch);
    const changeId = worker.change.id;
    const workRoot = join(rootDir, "worktrees");
    await mkdir(workRoot, { recursive: true });

    // Two runners run two WorkUnits with the deterministic noop executor.
    await Promise.all([
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

    expect([...worker.completed].sort()).toEqual(["alpha", "beta"]);

    // Build the completed-WorkUnit inputs from the lease records.
    const completed: CompletedWorkUnit[] = ["alpha", "beta"].map((unitId) => {
      const lease = worker.leases.get(unitId);
      if (!lease) {
        throw new Error(`missing lease for ${unitId}`);
      }
      return {
        unitId,
        gitUrl: lease.ref.gitUrl,
        baselineRef: "HEAD",
        expectedFiles: [`src/${unitId}/${unitId}.done`],
      };
    });

    // A fresh integration workspace, seeded empty (the baseline for this Change
    // is the empty tree, since the WorkUnits only add files).
    const integrationRef = await workspaces.create(`${changeId}--integration`, {
      defaultBranch: "main",
    });
    const integrationToken = await workspaces.issueWriteToken(integrationRef);
    await seedEmpty(integrationRef, join(rootDir, "seed"));

    // The final suite asserts both WorkUnits' markers landed in the combined
    // workspace. It is a deterministic Node script, not a model call.
    const finalTestCommand = [
      process.execPath,
      "-e",
      "const fs=require('node:fs');for(const p of ['src/alpha/alpha.done','src/beta/beta.done']){if(!fs.existsSync(p)){console.error('missing '+p);process.exit(1);}}console.log('integration ok');",
    ];

    const driver = new ChangeVerification(workspaces);
    const summary = await driver.verifyAndIntegrate({
      change: worker.change,
      completed,
      integrationRef,
      integrationToken: integrationToken.token,
      finalTestCommand,
      workRoot,
    });

    // One evidence summary listing each WorkUnit's checks.
    expect(summary.changeId).toBe(changeId);
    expect(summary.units.map((u) => u.unitId)).toEqual(["alpha", "beta"]);
    for (const unit of summary.units) {
      expect(unit.verdict).toBe("verified");
      expect(unit.checks.map((c) => c.kind)).toEqual([
        "clean-state",
        "path-scope",
        "test",
        "lint",
      ]);
    }

    // One integrated verified result over the combined workspace.
    expect(summary.integration.verdict).toBe("verified");
    expect([...summary.integration.integratedUnits].sort()).toEqual(["alpha", "beta"]);
    expect(summary.integration.excludedUnits).toEqual([]);
    expect(summary.integration.finalCheck.passed).toBe(true);
    expect(summary.integration.finalCheck.summary).toMatch(/final suite passed/);

    // The integration workspace actually holds both markers.
    const integrationRepo = join(rootDir, "artifacts", `${changeId}--integration.git`);
    const files = await listTree(integrationRepo);
    expect(files).toContain("src/alpha/alpha.done");
    expect(files).toContain("src/beta/beta.done");
  });

  it("marks a scope-violating WorkUnit failed and keeps it out of integration", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(rootDir, "artifacts") });
    const worker = new TestWorker(SPEC, workspaces);
    const client = new WorkerClient("http://worker.local", worker.fetch);
    const changeId = worker.change.id;
    const workRoot = join(rootDir, "worktrees");
    await mkdir(workRoot, { recursive: true });

    await Promise.all([
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

    // Push an out-of-scope file into beta's workspace to simulate a WorkUnit
    // that strayed outside its declared paths (beta declared only src/beta/**).
    const betaLease = worker.leases.get("beta");
    if (!betaLease) {
      throw new Error("missing beta lease");
    }
    await pushExtraFile(betaLease.ref, join(rootDir, "tamper"), "src/alpha/stolen.txt", "oops\n");

    const completed: CompletedWorkUnit[] = ["alpha", "beta"].map((unitId) => {
      const lease = worker.leases.get(unitId);
      if (!lease) {
        throw new Error(`missing lease for ${unitId}`);
      }
      return {
        unitId,
        gitUrl: lease.ref.gitUrl,
        baselineRef: "HEAD",
        expectedFiles: [`src/${unitId}/${unitId}.done`],
      };
    });

    const integrationRef = await workspaces.create(`${changeId}--integration`, { defaultBranch: "main" });
    const integrationToken = await workspaces.issueWriteToken(integrationRef);
    await seedEmpty(integrationRef, join(rootDir, "seed"));

    // Final suite: only alpha's marker should be present; beta is excluded.
    const finalTestCommand = [
      process.execPath,
      "-e",
      "const fs=require('node:fs');if(!fs.existsSync('src/alpha/alpha.done')){process.exit(1);}if(fs.existsSync('src/beta/beta.done')){console.error('beta leaked');process.exit(1);}console.log('ok');",
    ];

    const driver = new ChangeVerification(workspaces);
    const summary = await driver.verifyAndIntegrate({
      change: worker.change,
      completed,
      integrationRef,
      integrationToken: integrationToken.token,
      finalTestCommand,
      workRoot,
    });

    const beta = summary.units.find((u) => u.unitId === "beta");
    const alpha = summary.units.find((u) => u.unitId === "alpha");
    expect(alpha?.verdict).toBe("verified");
    expect(beta?.verdict).toBe("failed");
    expect(beta?.checks.find((c) => c.kind === "path-scope")?.passed).toBe(false);

    // beta is kept out of integration; alpha still integrates.
    expect(summary.integration.integratedUnits).toEqual(["alpha"]);
    expect(summary.integration.excludedUnits).toEqual(["beta"]);
    expect(summary.integration.verdict).toBe("verified");

    const integrationRepo = join(rootDir, "artifacts", `${changeId}--integration.git`);
    const files = await listTree(integrationRepo);
    expect(files).toContain("src/alpha/alpha.done");
    expect(files).not.toContain("src/beta/beta.done");
  });
});

/** Seed an empty initial commit so the integration workspace has a HEAD. */
async function seedEmpty(ref: WorkspaceRef, scratch: string): Promise<void> {
  await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(join(scratch, "seed-"));
  try {
    await run("git", ["clone", ref.gitUrl, work]);
    await writeFile(join(work, ".gitkeep"), "", "utf8");
    await run("git", ["-C", work, "add", "-A"]);
    await run("git", [
      "-C",
      work,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@switchyard.local",
      "commit",
      "--no-verify",
      "-m",
      "seed",
    ]);
    await run("git", ["-C", work, "push", ref.gitUrl, `HEAD:${ref.defaultBranch}`]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Clone a workspace, add an extra file, and push it back (to simulate drift). */
async function pushExtraFile(
  ref: WorkspaceRef,
  scratch: string,
  relPath: string,
  content: string,
): Promise<void> {
  await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(join(scratch, "tamper-"));
  try {
    await run("git", ["clone", ref.gitUrl, work]);
    const abs = join(work, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    await run("git", ["-C", work, "add", "-A"]);
    await run("git", [
      "-C",
      work,
      "-c",
      "user.name=Tamper",
      "-c",
      "user.email=tamper@switchyard.local",
      "commit",
      "--no-verify",
      "-m",
      "stray edit",
    ]);
    await run("git", ["-C", work, "push", ref.gitUrl, `HEAD:${ref.defaultBranch}`]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** List file paths present at HEAD of a bare repo. */
async function listTree(bareRepo: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", bareRepo, "ls-tree", "-r", "--name-only", "HEAD"]);
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

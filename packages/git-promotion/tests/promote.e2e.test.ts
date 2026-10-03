/**
 * End-to-end MC4: the fabric coordinates a declared path collision before
 * integration, promotes the integrated result into an ordinary local Git
 * repository, and then expires the per-WorkUnit workspaces.
 *
 * This builds on the earlier runner and verification flow. It uses the example
 * audit-logging Change shape, where two WorkUnits (`api` and `tests`) both
 * declare the same path (src/audit/events.ts). The WorkUnits run with the
 * deterministic noop executor against honest local-fallback workspaces (real
 * Git clone, commit, and push over file:// remotes), so there is no model call
 * and no randomness anywhere: the same run always produces the same result.
 *
 * The flow then asserts the three MC4 exit criteria:
 *   (a) the collision is detected and coordinated: a single write lease is
 *       granted to one WorkUnit, the other is recorded as a waiter, and the
 *       owner's version of the contested file is the one that integrates (no
 *       silent merge collision);
 *   (b) promotion creates a real branch and commit in a local source repository
 *       containing the integrated result;
 *   (c) cleanup removes the per-WorkUnit workspaces afterwards.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseChangeSpec,
  runnableUnits,
  type Change,
} from "@switchyard-change/change-core";
import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { ScopedToken, WorkspaceRef } from "@switchyard-change/artifact-workspace";
import type { ExecutionResult, ExecutorContext, ExecutorProvider } from "@switchyard-change/model-adapters";
import { runWorkUnit, WorkerClient, type FetchLike } from "@switchyard-change/local-runner";
import { ChangeVerification, type CompletedWorkUnit } from "@switchyard-change/verification";

import { LocalGitDeliveryProvider, defaultBranch } from "../src/local-git.ts";
import { cleanupWorkspaces, type ChangeWorkspaces } from "../src/cleanup.ts";

const run = promisify(execFile);

// The example audit-logging Change: three WorkUnits, one dependency
// (api -> model), and one declared path collision: `api` and `tests` both
// declare src/audit/events.ts.
const AUDIT_SPEC = `
id: change-audit-logging
objective: Add organization-level audit logging
baseline: HEAD
budget_usd: 5.00
assurance: standard

work:
  - id: model
    objective: Implement audit event persistence
    paths:
      - src/audit/**

  - id: api
    objective: Add API read endpoints
    depends_on:
      - model
    paths:
      - src/api/audit/**
      - src/audit/events.ts

  - id: tests
    objective: Add audit logging tests
    paths:
      - tests/audit/**
      - src/audit/events.ts
`;

/**
 * A deterministic executor that writes a WorkUnit's own files, including a
 * version of the contested events.ts stamped with the WorkUnit id. Two of these
 * running (api and tests) therefore both write src/audit/events.ts with
 * different content, which is exactly the collision the fabric must coordinate.
 */
class AuditExecutor implements ExecutorProvider {
  readonly name = "audit-noop";

  constructor(private readonly files: readonly { readonly path: string; readonly content: string }[]) {}

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const changed: string[] = [];
    for (const file of this.files) {
      const abs = join(context.worktreeDir, file.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content, "utf8");
      changed.push(file.path);
    }
    return {
      status: "changed",
      changedPaths: changed,
      logs: [`audit executor wrote ${changed.join(", ")} (zero inference)`],
      cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      commitMessage: `WorkUnit ${context.workUnitId}: deterministic audit change`,
    };
  }
}

/** The files each WorkUnit writes. `api` and `tests` both write events.ts. */
const UNIT_FILES: Record<string, readonly { readonly path: string; readonly content: string }[]> = {
  model: [{ path: "src/audit/store.ts", content: "export const store = 'audit-store';\n" }],
  api: [
    { path: "src/api/audit/read.ts", content: "export const read = () => 'audit-read';\n" },
    { path: "src/audit/events.ts", content: "export const owner = 'api';\n" },
  ],
  tests: [
    { path: "tests/audit/events.test.ts", content: "export const spec = 'audit-spec';\n" },
    { path: "src/audit/events.ts", content: "export const owner = 'tests';\n" },
  ],
};

/**
 * A minimal in-process Worker control surface for the runner flow. It reuses the
 * real change-core scheduling and the honest local fallback workspace provider,
 * and keeps the lease records so the test can read each completed WorkUnit's
 * workspace afterwards.
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
  rootDir = await mkdtemp(join(tmpdir(), "scf-mc4-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("MC4: coordinate collision, promote to local Git, clean up workspaces", () => {
  it("coordinates the audit-logging path collision, promotes the result, and expires workspaces", async () => {
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(rootDir, "artifacts") });
    const worker = new TestWorker(AUDIT_SPEC, workspaces);
    const client = new WorkerClient("http://worker.local", worker.fetch);
    const changeId = worker.change.id;
    const workRoot = join(rootDir, "worktrees");
    await mkdir(workRoot, { recursive: true });

    // Run all three WorkUnits with the deterministic audit executor. `model`
    // runs first (api depends on it); api and tests both write events.ts.
    await runWorkUnit({
      client,
      executor: new AuditExecutor(UNIT_FILES.model ?? []),
      changeId,
      unitId: "model",
      workRoot,
    });
    await Promise.all([
      runWorkUnit({
        client,
        executor: new AuditExecutor(UNIT_FILES.api ?? []),
        changeId,
        unitId: "api",
        workRoot,
      }),
      runWorkUnit({
        client,
        executor: new AuditExecutor(UNIT_FILES.tests ?? []),
        changeId,
        unitId: "tests",
        workRoot,
      }),
    ]);

    expect([...worker.completed].sort()).toEqual(["api", "model", "tests"]);

    // Build the completed-WorkUnit inputs from the lease records.
    const unitIds = ["model", "api", "tests"] as const;
    const completed: CompletedWorkUnit[] = unitIds.map((unitId) => {
      const lease = worker.leases.get(unitId);
      if (!lease) {
        throw new Error(`missing lease for ${unitId}`);
      }
      return { unitId, gitUrl: lease.ref.gitUrl, baselineRef: "HEAD" };
    });

    // A fresh integration workspace seeded empty (the baseline adds files only).
    const integrationRef = await workspaces.create(`${changeId}--integration`, {
      defaultBranch: "main",
    });
    const integrationToken = await workspaces.issueWriteToken(integrationRef);
    await seedEmpty(integrationRef, join(rootDir, "seed"));

    // Verify, coordinate the collision, and integrate.
    const driver = new ChangeVerification(workspaces);
    const summary = await driver.verifyAndIntegrate({
      change: worker.change,
      completed,
      integrationRef,
      integrationToken: integrationToken.token,
      workRoot,
    });

    // (a) The collision was detected and coordinated before integration.
    expect(summary.coordination).toBeDefined();
    expect(summary.coordination?.needsAttention).toBe(false);
    expect(summary.coordination?.decisions).toHaveLength(1);
    const decision = summary.coordination?.decisions[0];
    expect(decision?.path).toBe("src/audit/events.ts");
    expect(decision?.resolution).toBe("serialized");
    expect(decision?.owner).toBe("api"); // api is declared before tests
    expect(decision?.waiters).toEqual(["tests"]);

    // Every WorkUnit verified and integrated.
    expect(summary.units.map((u) => u.unitId)).toEqual(["model", "api", "tests"]);
    for (const unit of summary.units) {
      expect(unit.verdict).toBe("verified");
    }
    expect(summary.integration.verdict).toBe("verified");
    expect([...summary.integration.integratedUnits].sort()).toEqual(["api", "model", "tests"]);

    // The owner's version of the contested file is the one that landed: no
    // silent merge collision, the lease owner (api) wrote events.ts.
    const integrationRepo = join(rootDir, "artifacts", `${changeId}--integration.git`);
    const eventsContent = await showFile(integrationRepo, "src/audit/events.ts");
    expect(eventsContent).toBe("export const owner = 'api';\n");

    // (b) Promote the integrated result into an ordinary local Git repository.
    const sourceRepo = join(rootDir, "source");
    await initSourceRepo(sourceRepo);

    const delivery = new LocalGitDeliveryProvider({ workRoot });
    const promotion = await delivery.promote(
      {
        changeId,
        objective: worker.change.objective,
        integrationGitUrl: integrationRef.gitUrl,
        integrationBranch: integrationRef.defaultBranch,
      },
      { repoDir: sourceRepo, startPoint: "main" },
    );

    expect(promotion.committed).toBe(true);
    expect(promotion.branch).toBe(defaultBranch(changeId));
    expect(promotion.commit).not.toBe("");
    expect(promotion.deliveredPaths).toContain("src/audit/events.ts");

    // A real branch and commit now exist in the source repo on that branch.
    const branches = await run("git", ["-C", sourceRepo, "branch", "--list", promotion.branch]);
    expect(branches.stdout).toContain(promotion.branch);

    const headOnBranch = (
      await run("git", ["-C", sourceRepo, "rev-parse", promotion.branch])
    ).stdout.trim();
    expect(headOnBranch).toBe(promotion.commit);

    // The promoted branch holds the integrated result, including the owner's
    // version of the contested file.
    const promotedEvents = await readFile(join(sourceRepo, "src/audit/events.ts"), "utf8");
    expect(promotedEvents).toBe("export const owner = 'api';\n");
    const promotedFiles = await listTree(sourceRepo);
    expect(promotedFiles).toContain("src/api/audit/read.ts");
    expect(promotedFiles).toContain("tests/audit/events.test.ts");
    expect(promotedFiles).toContain("src/audit/store.ts");

    // (c) Clean up: expire the per-WorkUnit workspaces (and the integration one)
    // after promotion.
    const changeWorkspaces: ChangeWorkspaces = {
      unitWorkspaces: unitIds.map((id) => {
        const lease = worker.leases.get(id);
        if (!lease) {
          throw new Error(`missing lease for ${id}`);
        }
        return lease.ref;
      }),
      integrationWorkspace: integrationRef,
    };

    const cleanup = await cleanupWorkspaces(workspaces, changeWorkspaces);
    expect(cleanup.failed).toEqual([]);
    expect(cleanup.archived).toEqual(
      ["model", "api", "tests", "integration"].map((s) => `${changeId}--${s}`).sort(),
    );

    // The archived workspaces are gone: inspecting one now fails.
    const modelRef = worker.leases.get("model")?.ref;
    if (!modelRef) {
      throw new Error("missing model lease");
    }
    await expect(workspaces.inspect(modelRef)).rejects.toThrow();
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

/** Initialize an ordinary local source repo with one baseline commit on main. */
async function initSourceRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "--initial-branch=main"]);
  await writeFile(join(dir, "README.md"), "# source repo\n", "utf8");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", [
    "-C",
    dir,
    "-c",
    "user.name=Source",
    "-c",
    "user.email=source@switchyard.local",
    "commit",
    "--no-verify",
    "-m",
    "baseline",
  ]);
}

/** Show the content of a file at HEAD of a bare repo. */
async function showFile(bareRepo: string, relPath: string): Promise<string> {
  const { stdout } = await run("git", ["-C", bareRepo, "show", `HEAD:${relPath}`]);
  return stdout;
}

/** List file paths present at HEAD of a repo (bare or working). */
async function listTree(repo: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repo, "ls-tree", "-r", "--name-only", "HEAD"]);
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/**
 * End-to-end MC5: run the example audit-logging Change through the whole
 * pipeline deterministically and offline, exactly as `make demo` does.
 *
 * It drives runChange against the real example Change spec and the real example
 * demo-project (the Change target), with the default deterministic noop executor
 * and the honest local-filesystem fallback, so there is no Cloudflare account,
 * no model inference, and no randomness: the same run always produces the same
 * promoted result.
 *
 * It asserts the exit criteria for the demo:
 *   - every WorkUnit ran and verified, scheduled in dependency order;
 *   - the declared src/audit/events.ts collision was coordinated to a single
 *     owner (api), with tests recorded as a waiter (no silent merge);
 *   - the integrated result was promoted into an ordinary local Git repository
 *     as a real branch and commit;
 *   - the per-WorkUnit and integration workspaces were cleaned up;
 *   - the human-readable summary tells that story.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runChange, formatRunSummary, describeChange } from "../src/index.ts";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SPEC_PATH = join(REPO_ROOT, "examples", "changes", "audit-logging.change.yaml");
const PROJECT_DIR = join(REPO_ROOT, "examples", "demo-project");

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scf-mc5-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("MC5: the example Change runs end to end deterministically offline", () => {
  it("runs orchestration -> verification -> integration -> coordination -> promotion -> cleanup", async () => {
    const specYaml = await readFile(SPEC_PATH, "utf8");

    const result = await runChange({ specYaml, projectDir: PROJECT_DIR, workRoot });

    // Offline + deterministic: every workspace used the honest local fallback,
    // the noop executor ran, and nothing cost anything.
    expect(result.offline).toBe(true);
    expect(result.executor).toBe("noop");
    expect(result.spentUsd).toBe(0);
    expect(result.changeId).toBe("change-audit-logging");

    // Scheduling order: only `api` depends on `model`, so `model` and `tests`
    // are runnable at once; `api` runs once `model` is done.
    expect([...(result.waves[0] ?? [])].sort()).toEqual(["model", "tests"]);
    expect(result.waves[1]).toEqual(["api"]);
    expect(result.units.map((u) => u.unitId).sort()).toEqual(["api", "model", "tests"]);

    // Every WorkUnit verified and the integration verified.
    for (const unit of result.evidence.units) {
      expect(unit.verdict).toBe("verified");
    }
    expect(result.evidence.integration.verdict).toBe("verified");
    expect([...result.evidence.integration.integratedUnits].sort()).toEqual([
      "api",
      "model",
      "tests",
    ]);

    // The declared collision on src/audit/events.ts was coordinated to a single
    // owner (api, declared before tests); tests waited. No silent merge.
    expect(result.evidence.coordination).toBeDefined();
    expect(result.evidence.coordination?.needsAttention).toBe(false);
    const decision = result.evidence.coordination?.decisions.find(
      (d) => d.path === "src/audit/events.ts",
    );
    expect(decision?.resolution).toBe("serialized");
    expect(decision?.owner).toBe("api");
    expect(decision?.waiters).toEqual(["tests"]);

    // Promotion created a real branch and commit in the local source repo.
    expect(result.promotion.committed).toBe(true);
    expect(result.promotion.branch).toBe("switchyard/change-audit-logging");
    expect(result.promotion.commit).toMatch(/^[0-9a-f]{40}$/);

    const headOnBranch = (
      await run("git", ["-C", result.sourceRepoDir, "rev-parse", result.promotion.branch])
    ).stdout.trim();
    expect(headOnBranch).toBe(result.promotion.commit);

    // The promoted branch holds the integrated result: each WorkUnit's in-scope
    // marker plus the baseline project files, with the contested events.ts owned
    // by the lease owner (api).
    const promotedFiles = await listTree(result.sourceRepoDir, result.promotion.branch);
    expect(promotedFiles).toContain("src/audit/model.done");
    expect(promotedFiles).toContain("src/api/audit/api.done");
    expect(promotedFiles).toContain("tests/audit/tests.done");
    expect(promotedFiles).toContain("src/audit/events.ts");
    // The baseline demo-project files are still present (promotion builds on it).
    expect(promotedFiles).toContain("src/audit/store.ts");

    // The owner's version of the contested file is the one that landed: no
    // silent merge collision, the lease owner (api) wrote events.ts.
    const events = await showFileOnBranch(
      result.sourceRepoDir,
      result.promotion.branch,
      "src/audit/events.ts",
    );
    expect(events).toContain("owner: api");

    // Workspaces were cleaned up: unit workspaces + integration.
    expect(result.cleanup.failed).toEqual([]);
    expect(result.cleanup.archived).toEqual(
      ["model", "api", "tests", "integration"]
        .map((s) => `change-audit-logging--${s}`)
        .sort(),
    );

    // The human-readable summary tells the coordination story and ends in the
    // promoted commit.
    const summary = formatRunSummary(result);
    expect(summary).toContain("Change change-audit-logging");
    expect(summary).toContain("Conflict coordination:");
    expect(summary).toContain("src/audit/events.ts");
    expect(summary).toContain("write lease to api");
    // The example has no gate: the summary says nothing was checked, and the
    // promotion is labeled unverified rather than verified.
    expect(summary).toContain("Integration verdict: unverified (no gate configured: nothing checked)");
    expect(summary).toContain("Promoted to local Git (unverified: no gate):");
    expect(summary).toContain("switchyard/change-audit-logging");
  });

  it("is reproducible: two runs of the same Change promote the same tree", async () => {
    const specYaml = await readFile(SPEC_PATH, "utf8");

    const first = await runChange({ specYaml, projectDir: PROJECT_DIR, workRoot });
    const secondRoot = await mkdtemp(join(tmpdir(), "scf-mc5-b-"));
    try {
      const second = await runChange({ specYaml, projectDir: PROJECT_DIR, workRoot: secondRoot });

      // The delivered path sets match exactly, and the contested file resolves
      // to the same owner's content both times.
      expect([...first.promotion.deliveredPaths].sort()).toEqual(
        [...second.promotion.deliveredPaths].sort(),
      );
      const firstEvents = await showFileOnBranch(
        first.sourceRepoDir,
        first.promotion.branch,
        "src/audit/events.ts",
      );
      const secondEvents = await showFileOnBranch(
        second.sourceRepoDir,
        second.promotion.branch,
        "src/audit/events.ts",
      );
      expect(firstEvents).toBe(secondEvents);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("describeChange reports the schedule without running anything", async () => {
    const specYaml = await readFile(SPEC_PATH, "utf8");
    const { change, waves } = describeChange(specYaml);
    expect(change.id).toBe("change-audit-logging");
    expect([...(waves[0] ?? [])].sort()).toEqual(["model", "tests"]);
    expect(waves[1]).toEqual(["api"]);
  });
});

/** List file paths present at HEAD of a branch in a working repo. */
async function listTree(repoDir: string, branch: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", branch]);
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Show a file's content at a branch tip. */
async function showFileOnBranch(repoDir: string, branch: string, relPath: string): Promise<string> {
  const { stdout } = await run("git", ["-C", repoDir, "show", `${branch}:${relPath}`]);
  return stdout;
}

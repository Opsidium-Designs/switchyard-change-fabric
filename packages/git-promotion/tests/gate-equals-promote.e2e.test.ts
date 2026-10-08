/**
 * End-to-end: the tree the authoritative gate ran on is the exact tree
 * promotion commits (gated == promoted), and promotion never silently ships the
 * unfixed baseline.
 *
 * The integrator runs the authoritative gate on the INTEGRATED tree (baseline +
 * verified unit edits) and pushes it to the integration workspace. Promotion
 * then clones that integration workspace and lands it on a delivery branch whose
 * start point is the same baseline the integration was seeded from. These cases
 * prove the honesty invariant at the promote step:
 *
 *   (1) a verified MODIFICATION over a non-empty baseline is the content that
 *       lands on the delivery branch (the fix, not the baseline version);
 *   (2) the promoted tree is byte-identical to the integrated tree the gate ran
 *       on, DELETIONS included: a verified fix that removed a baseline file
 *       leaves that file absent from the promoted branch, so gated == promoted;
 *   (3) when the integration reported it landed fixes but the integrated tree is
 *       identical to the baseline (the gate passed on a baseline-identical tree,
 *       so a plain copy-overlay would silently ship the unfixed baseline),
 *       promotion refuses with a hard error instead of committing the baseline.
 *
 * Everything runs over ordinary local Git with file:// remotes: real clone,
 * commit, and push, no model call and no network, so the same run always
 * produces the same result.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalGitDeliveryProvider, defaultBranch } from "../src/local-git.ts";

const run = promisify(execFile);

let rootDir: string;
let workRoot: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "scf-gate-promote-"));
  workRoot = join(rootDir, "worktrees");
  await mkdir(workRoot, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("gate-equals-promote: the gated tree is the promoted tree", () => {
  it("promotes the verified modification over the baseline, not the baseline version", async () => {
    // A baseline the integration workspace and the source repo both start from:
    // broken.ts holds the baseline (unfixed) content.
    const baseline = {
      "README.md": "# app\n",
      "src/broken.ts": "export const value = 'BASELINE';\n",
    };
    // The integrated (gated) tree: the verified fix modified broken.ts.
    const integrated = {
      "README.md": "# app\n",
      "src/broken.ts": "export const value = 'FIXED';\n",
    };

    const integrationUrl = await makeIntegrationRepo("integration", baseline, integrated);
    const sourceRepo = await makeSourceRepo("source", baseline);

    const delivery = new LocalGitDeliveryProvider({ workRoot });
    const promotion = await delivery.promote(
      {
        changeId: "change-fix",
        integrationGitUrl: integrationUrl,
        integrationBranch: "main",
        expectedIntegratedUnits: 1,
      },
      { repoDir: sourceRepo, startPoint: "main" },
    );

    expect(promotion.committed).toBe(true);
    expect(promotion.branch).toBe(defaultBranch("change-fix"));

    // The promoted branch holds the fix, not the baseline value: the tree the
    // gate ran on is what landed.
    const promoted = await readFile(join(sourceRepo, "src/broken.ts"), "utf8");
    expect(promoted).toBe("export const value = 'FIXED';\n");

    // Gated tree == promoted tree: the delivery branch tree hash equals the
    // integrated tree hash the gate ran on.
    const gatedTree = await treeHash(integrationUrl, "main");
    const promotedTree = await treeHash(sourceRepo, promotion.branch);
    expect(promotedTree).toBe(gatedTree);
  });

  it("reconciles a deletion so the promoted tree matches the gated tree exactly", async () => {
    // The baseline tracks a file the verified fix DELETES. A copy-only overlay
    // would keep the baseline file on the delivery branch, diverging from the
    // gated tree; reconciliation must remove it.
    const baseline = {
      "README.md": "# app\n",
      "src/legacy.ts": "export const legacy = true;\n",
      "src/keep.ts": "export const keep = 1;\n",
    };
    const integrated = {
      "README.md": "# app\n",
      "src/keep.ts": "export const keep = 2;\n", // modified
      // src/legacy.ts deleted by the fix.
    };

    const integrationUrl = await makeIntegrationRepo("integration", baseline, integrated);
    const sourceRepo = await makeSourceRepo("source", baseline);

    const delivery = new LocalGitDeliveryProvider({ workRoot });
    const promotion = await delivery.promote(
      {
        changeId: "change-delete",
        integrationGitUrl: integrationUrl,
        integrationBranch: "main",
        expectedIntegratedUnits: 1,
      },
      { repoDir: sourceRepo, startPoint: "main" },
    );

    expect(promotion.committed).toBe(true);
    expect(promotion.removedPaths).toContain("src/legacy.ts");

    // The deleted file is gone from the promoted branch, the modified file holds
    // the fix.
    const promotedFiles = await listTree(sourceRepo, promotion.branch);
    expect(promotedFiles).not.toContain("src/legacy.ts");
    expect(promotedFiles).toContain("src/keep.ts");
    const keep = await readFile(join(sourceRepo, "src/keep.ts"), "utf8");
    expect(keep).toBe("export const keep = 2;\n");

    // Gated tree == promoted tree, deletion included.
    const gatedTree = await treeHash(integrationUrl, "main");
    const promotedTree = await treeHash(sourceRepo, promotion.branch);
    expect(promotedTree).toBe(gatedTree);
  });

  it("refuses to promote when a fix was expected but the integrated tree is the baseline", async () => {
    // The integration never advanced past the baseline seed (no edit landed), so
    // the integrated tree is byte-identical to the baseline. A gate that passed
    // on this tree passed on an unfixed tree; promoting it would silently ship
    // the baseline while claiming a fix landed. The guard must reject it.
    const baseline = {
      "README.md": "# app\n",
      "src/broken.ts": "export const value = 'BASELINE';\n",
    };
    // Integrated tree identical to baseline: nothing changed.
    const integrationUrl = await makeIntegrationRepo("integration", baseline, baseline);
    const sourceRepo = await makeSourceRepo("source", baseline);

    const delivery = new LocalGitDeliveryProvider({ workRoot });
    await expect(
      delivery.promote(
        {
          changeId: "change-vacuous",
          integrationGitUrl: integrationUrl,
          integrationBranch: "main",
          expectedIntegratedUnits: 1,
        },
        { repoDir: sourceRepo, startPoint: "main" },
      ),
    ).rejects.toThrow(/identical to the baseline/);

    // Nothing was committed: no delivery branch was shipped from the baseline.
    const branches = await run("git", [
      "-C",
      sourceRepo,
      "branch",
      "--list",
      defaultBranch("change-vacuous"),
    ]);
    expect(branches.stdout.trim()).toBe("");
  });

  it("refuses to promote a tree whose integration verdict is not verified (no branch created)", async () => {
    // The integrated tree DIFFERS from the baseline (an edit landed), but the
    // authoritative gate failed on it. A failed verdict must never get a
    // delivery branch, regardless of whether the tree changed.
    const baseline = { "src/broken.ts": "export const value = 'BASELINE';\n" };
    const integrated = { "src/broken.ts": "export const value = 'STILL BROKEN';\n" };
    const integrationUrl = await makeIntegrationRepo("integration", baseline, integrated);
    const sourceRepo = await makeSourceRepo("source", baseline);

    const delivery = new LocalGitDeliveryProvider({ workRoot });
    await expect(
      delivery.promote(
        {
          changeId: "change-failed",
          integrationGitUrl: integrationUrl,
          integrationBranch: "main",
          expectedIntegratedUnits: 1,
          verdict: "failed",
        },
        { repoDir: sourceRepo, startPoint: "main" },
      ),
    ).rejects.toThrow(/verdict is "failed"/);

    const branches = await run("git", [
      "-C",
      sourceRepo,
      "branch",
      "--list",
      defaultBranch("change-failed"),
    ]);
    expect(branches.stdout.trim()).toBe("");
  });

  it("allows an unchanged promotion when no fix was expected (additive no-op)", async () => {
    // expectedIntegratedUnits omitted (or zero): a change that landed no fix is a
    // legitimate no-op and must not trip the guard.
    const baseline = {
      "README.md": "# app\n",
      "src/same.ts": "export const same = 1;\n",
    };
    const integrationUrl = await makeIntegrationRepo("integration", baseline, baseline);
    const sourceRepo = await makeSourceRepo("source", baseline);

    const delivery = new LocalGitDeliveryProvider({ workRoot });
    const promotion = await delivery.promote(
      {
        changeId: "change-noop",
        integrationGitUrl: integrationUrl,
        integrationBranch: "main",
      },
      { repoDir: sourceRepo, startPoint: "main" },
    );

    // Nothing to commit, but no error: the branch exists at the baseline.
    expect(promotion.committed).toBe(false);
    const gatedTree = await treeHash(integrationUrl, "main");
    const promotedTree = await treeHash(sourceRepo, promotion.branch);
    expect(promotedTree).toBe(gatedTree);
  });
});

/**
 * Build a bare integration repo seeded from `baseline` and advanced to
 * `integrated` on main, mirroring what the integrator pushes: a baseline seed
 * commit then one combined-result commit (byte-identical to the baseline commit
 * when nothing changed). Returns a file:// clone URL.
 */
async function makeIntegrationRepo(
  name: string,
  baseline: Record<string, string>,
  integrated: Record<string, string>,
): Promise<string> {
  const bare = join(rootDir, `${name}.git`);
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  const work = await mkdtemp(join(workRoot, `${name}-seed-`));
  try {
    await run("git", ["clone", bare, work]);
    await writeTree(work, baseline);
    await commit(work, "seed baseline");
    // Advance to the integrated tree (the integrator's combined-result commit).
    // When integrated == baseline this is a no-op and leaves main at the seed,
    // exactly the vacuous case where no edit landed.
    await replaceTree(work, integrated);
    if ((await run("git", ["-C", work, "status", "--porcelain"])).stdout.trim() !== "") {
      await commit(work, "Integrate verified WorkUnits");
    }
    await run("git", ["-C", work, "push", bare, "HEAD:main"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return `file://${bare}`;
}

/** Build an ordinary local source repo with one baseline commit on main. */
async function makeSourceRepo(name: string, baseline: Record<string, string>): Promise<string> {
  const dir = join(rootDir, name);
  await mkdir(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "--initial-branch=main"]);
  await writeTree(dir, baseline);
  await commit(dir, "baseline");
  return dir;
}

/** Write every path in `files` into the worktree. */
async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

/**
 * Make the worktree's tracked set exactly `files`: write the given files and
 * remove any currently-tracked file not in the set (so a deletion in the fix is
 * reflected). Mirrors what an integrated tree with a deletion looks like.
 */
async function replaceTree(dir: string, files: Record<string, string>): Promise<void> {
  const tracked = (await run("git", ["-C", dir, "ls-files"])).stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const wanted = new Set(Object.keys(files));
  for (const rel of tracked) {
    if (!wanted.has(rel)) {
      await run("git", ["-C", dir, "rm", "-f", "--", rel]);
    }
  }
  await writeTree(dir, files);
}

/** Stage all and commit with a deterministic identity. */
async function commit(dir: string, message: string): Promise<void> {
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", [
    "-C",
    dir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@switchyard.local",
    "commit",
    "--no-verify",
    "-m",
    message,
  ]);
}

/** The tree object hash a ref points at (bare or working repo). */
async function treeHash(repoOrUrl: string, ref: string): Promise<string> {
  const dir = repoOrUrl.startsWith("file://") ? repoOrUrl.slice("file://".length) : repoOrUrl;
  return (await run("git", ["-C", dir, "rev-parse", `${ref}^{tree}`])).stdout.trim();
}

/** List file paths present at a ref of a repo (bare or working). */
async function listTree(repo: string, ref: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repo, "ls-tree", "-r", "--name-only", ref]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEditDiff } from "../src/run-live.ts";

/**
 * The agent "Diff" in the console must be a real diff of the edit against the
 * file's PRIOR content. The kickoff worktree is a clone of a freshly leased
 * empty repo, so diffing it against its own (empty) history showed every edited
 * file as `new file mode` against /dev/null. With the project baseline passed
 * in, an edited file reads as a modification and only a truly new file is new.
 */
describe("buildEditDiff against the project baseline", () => {
  let root: string;
  let baseline: string;
  let worktree: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "edit-diff-"));
    baseline = join(root, "baseline");
    worktree = join(root, "worktree");
    await mkdir(join(baseline, "src"), { recursive: true });
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(baseline, "src", "users.ts"), "export const a = 1;\nexport const b = 2;\n");
    // The worktree is an empty-history clone: init a repo with no commit.
    execFileSync("git", ["init", "-q", worktree]);
    await writeFile(join(worktree, "src", "users.ts"), "export const a = 1;\nexport const b = 3;\n");
    await writeFile(join(worktree, "src", "fresh.ts"), "export const c = 4;\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("diffs an edited file against its baseline content, not /dev/null", async () => {
    const diff = await buildEditDiff(worktree, ["src/users.ts"], baseline);
    expect(diff).toContain("diff --git a/src/users.ts b/src/users.ts");
    expect(diff).toContain("--- a/src/users.ts");
    expect(diff).toContain("+++ b/src/users.ts");
    expect(diff).toContain("-export const b = 2;");
    expect(diff).toContain("+export const b = 3;");
    // The unchanged line is context, not an addition.
    expect(diff).not.toContain("+export const a = 1;");
    expect(diff).not.toContain("new file mode");
    // No absolute temp path leaks into the headers.
    expect(diff).not.toContain(root.replace(/^\/+/, ""));
  });

  it("shows only a file genuinely absent from the baseline as new", async () => {
    const diff = await buildEditDiff(worktree, ["src/users.ts", "src/fresh.ts"], baseline);
    expect(diff).toContain("+export const c = 4;");
    const freshSection = diff.slice(diff.indexOf("src/fresh.ts"));
    expect(freshSection).toContain("new file mode");
    const usersSection = diff.slice(diff.indexOf("src/users.ts"), diff.indexOf("diff --git", diff.indexOf("src/users.ts") + 1));
    expect(usersSection).not.toContain("new file mode");
  });

  it("skips a path that escapes the roots and returns empty for no edits", async () => {
    expect(await buildEditDiff(worktree, [], baseline)).toBe("");
    expect(await buildEditDiff(worktree, ["../baseline/src/users.ts"], baseline)).toBe("");
  });

  it("without a baseline still diffs a commitless worktree against the empty tree", async () => {
    const diff = await buildEditDiff(worktree, ["src/users.ts"]);
    expect(diff).toContain("new file mode");
  });
});

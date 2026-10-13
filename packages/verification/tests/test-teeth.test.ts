/**
 * test-teeth: a contract-approved test change is run alone on the baseline
 * (with the new test swapped in) and on the revision. Offline: a tiny local
 * Git fixture and a fake runner that "passes" a test file only when the code
 * in the tree it runs in gives the answer the test expects.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandOutcome, CommandRunner, CommandRunOptions } from "../src/command.ts";
import { assessTestTeeth, checkReleasedTestTeeth, isTestFile, TEETH_RUNNER_UNKNOWN, testFileCommand } from "../src/test-teeth.ts";
import { makeCheckout, type FixtureFile } from "./helpers.ts";

const run = promisify(execFile);

const MANIFEST = JSON.stringify({ name: "fixture", type: "module", devDependencies: { vitest: "2.1.8" } });
const TEST = "tests/billing/tax.test.ts";

/** The baseline: tax rounds down (72 cents). */
const BASELINE: readonly FixtureFile[] = [
  { path: "package.json", content: MANIFEST },
  { path: "src/tax.ts", content: "export const tax = 72;\n" },
  { path: TEST, content: "expect(tax).toBe(72);\n" },
  { path: "tests/other.test.ts", content: "expect(1).toBe(1);\n" },
];

/**
 * A fake vitest: the file passes when the tree's tax value is the one the test
 * expects. Records where it ran (the tree, by its tax value).
 */
class FakeVitest implements CommandRunner {
  readonly calls: { argv: readonly string[]; cwd: string; tax: string; aborted: boolean }[] = [];
  constructor(private readonly override?: (cwd: string) => CommandOutcome | undefined) {}
  async run(argv: readonly string[], cwd: string, options?: CommandRunOptions): Promise<CommandOutcome> {
    const tax = (await readFile(join(cwd, "src/tax.ts"), "utf8")).match(/tax = (\d+)/)?.[1] ?? "";
    this.calls.push({ argv, cwd, tax, aborted: options?.signal?.aborted === true });
    const forced = this.override?.(cwd);
    if (forced !== undefined) {
      return forced;
    }
    const file = argv.at(-1)!;
    const expected = (await readFile(join(cwd, file), "utf8")).match(/toBe\((\d+)\)/)?.[1];
    return expected === tax ? { code: 0, stdout: "1 passed", stderr: "" } : { code: 1, stdout: `expected ${expected}, got ${tax}`, stderr: "" };
  }
}

async function head(dir: string, ref: string): Promise<string> {
  return (await run("git", ["-C", dir, "rev-parse", ref])).stdout.trim();
}

describe("test-teeth helpers", () => {
  it("runs vitest projects one file at a time and knows no other runner", () => {
    expect(testFileCommand(MANIFEST, TEST)).toEqual(["npx", "--no", "vitest", "run", TEST]);
    expect(testFileCommand(JSON.stringify({ devDependencies: { jest: "29" } }), TEST)).toBeUndefined();
    expect(testFileCommand("not json", TEST)).toBeUndefined();
    expect(testFileCommand(undefined, TEST)).toBeUndefined();
    expect(isTestFile(TEST)).toBe(true);
    expect(isTestFile("src/tax.ts")).toBe(false);
  });
});

describe("checkReleasedTestTeeth", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scf-teeth-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(changed: readonly FixtureFile[]): Promise<{ repo: string; baselineCommit: string; revisionCommit: string }> {
    const repo = join(root, "repo");
    await makeCheckout(repo, BASELINE, changed);
    return { repo, baselineCommit: await head(repo, "baseline"), revisionCommit: await head(repo, "HEAD") };
  }

  it("teeth found: the new test fails on baseline and passes on the revision", async () => {
    const { repo, baselineCommit, revisionCommit } = await fixture([
      { path: "src/tax.ts", content: "export const tax = 73;\n" },
      { path: TEST, content: "expect(tax).toBe(73);\n" },
    ]);
    const runner = new FakeVitest();
    const records = await checkReleasedTestTeeth({ remote: repo, baselineCommit, revisionCommit, rev: 6, released: [TEST], runner, workRoot: root });
    expect(records).toEqual([{ path: TEST, rev: 6, status: "teeth", baseline: "fail", revision: "pass", command: ["npx", "--no", "vitest", "run", TEST] }]);
    // Run once on the revision's tree, once on the baseline tree (new test swapped in).
    expect(runner.calls.map((c) => c.tax)).toEqual(["73", "72"]);
  });

  it("no teeth: the new test passes on the baseline too", async () => {
    const { repo, baselineCommit, revisionCommit } = await fixture([
      { path: "src/tax.ts", content: "export const tax = 73;\n" },
      // The changed test no longer pins the value the fix changes.
      { path: TEST, content: "expect(tax).toBeGreaterThan(0);\n" },
    ]);
    // A runner that passes on both trees (the test does not depend on the fix).
    const runner = new FakeVitest(() => ({ code: 0, stdout: "1 passed", stderr: "" }));
    const records = await checkReleasedTestTeeth({ remote: repo, baselineCommit, revisionCommit, rev: 6, released: ["tests/billing/**"], runner, workRoot: root });
    expect(records).toEqual([{ path: TEST, rev: 6, status: "no-teeth", baseline: "pass", revision: "pass", command: ["npx", "--no", "vitest", "run", TEST] }]);
  });

  it("ignores changed test files that are not released, and runs nothing when none is", async () => {
    const { repo, baselineCommit, revisionCommit } = await fixture([{ path: "tests/other.test.ts", content: "expect(2).toBe(2);\n" }]);
    const runner = new FakeVitest();
    expect(await checkReleasedTestTeeth({ remote: repo, baselineCommit, revisionCommit, rev: 2, released: [TEST], runner, workRoot: root })).toEqual([]);
    expect(await checkReleasedTestTeeth({ remote: repo, baselineCommit, revisionCommit, rev: 2, released: [], runner, workRoot: root })).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("could not check: an unknown runner, a timeout, a crash, an abort, an unreachable repo", async () => {
    const { repo, baselineCommit, revisionCommit } = await fixture([
      { path: "package.json", content: JSON.stringify({ devDependencies: { jest: "29" } }) },
      { path: "src/tax.ts", content: "export const tax = 73;\n" },
      { path: TEST, content: "expect(tax).toBe(73);\n" },
    ]);
    const unknown = await checkReleasedTestTeeth({ remote: repo, baselineCommit, revisionCommit, rev: 3, released: [TEST], runner: new FakeVitest(), workRoot: root });
    expect(unknown).toEqual([{ path: TEST, rev: 3, status: "could-not-check", baseline: "not-run", revision: "not-run", reason: TEETH_RUNNER_UNKNOWN }]);

    const unreachable = await checkReleasedTestTeeth({ remote: join(root, "missing"), baselineCommit, revisionCommit, rev: 3, released: [TEST], runner: new FakeVitest(), workRoot: root });
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]).toMatchObject({ path: TEST, status: "could-not-check", baseline: "not-run", revision: "not-run" });
    expect(unreachable[0]!.reason).toMatch(/^could not prepare the trees: /);
  });

  it("could not check (dir level): timeout on baseline, crash on the revision, failure on the revision, abort", async () => {
    const baselineDir = join(root, "b");
    const revisionDir = join(root, "r");
    await makeCheckout(baselineDir, BASELINE, [{ path: "README.md", content: "baseline\n" }]);
    await makeCheckout(revisionDir, BASELINE, [
      { path: "src/tax.ts", content: "export const tax = 73;\n" },
      { path: TEST, content: "expect(tax).toBe(73);\n" },
    ]);
    const base = { baselineDir, revisionDir, paths: [TEST], rev: 6 };

    const timeout = await assessTestTeeth({
      ...base,
      runner: new FakeVitest((cwd) => (cwd === baselineDir ? { code: null, stdout: "", stderr: "command timed out after 1000 ms and was stopped" } : undefined)),
    });
    expect(timeout).toEqual([
      { path: TEST, rev: 6, status: "could-not-check", baseline: "not-run", revision: "pass", command: ["npx", "--no", "vitest", "run", TEST], reason: "baseline: command timed out after 1000 ms and was stopped" },
    ]);
    // The baseline tree is put back after the swap.
    expect(await readFile(join(baselineDir, TEST), "utf8")).toBe("expect(tax).toBe(72);\n");

    const crash = await assessTestTeeth({
      ...base,
      runner: {
        run: () => Promise.reject(new Error("spawn npx ENOENT")),
      },
    });
    expect(crash[0]).toMatchObject({ status: "could-not-check", revision: "not-run", reason: "rev 6: spawn npx ENOENT" });

    const failsOnRevision = await assessTestTeeth({ ...base, runner: new FakeVitest(() => ({ code: 1, stdout: "", stderr: "boom" })) });
    expect(failsOnRevision[0]).toMatchObject({ status: "could-not-check", revision: "fail", reason: "the test fails on rev 6 when run alone" });

    const noFiles = await assessTestTeeth({ ...base, runner: new FakeVitest(() => ({ code: 1, stdout: "No test files found, exiting with code 1", stderr: "" })) });
    expect(noFiles[0]).toMatchObject({ status: "could-not-check", reason: "rev 6: the runner found no test file to run" });

    const controller = new AbortController();
    controller.abort();
    const runner = new FakeVitest();
    const aborted = await assessTestTeeth({ ...base, runner, signal: controller.signal });
    expect(aborted[0]).toMatchObject({ status: "could-not-check", reason: "the run was interrupted before the rev 6 run" });
    expect(runner.calls).toEqual([]);
  });
});

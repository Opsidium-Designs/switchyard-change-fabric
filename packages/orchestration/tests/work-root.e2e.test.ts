/**
 * A finished run leaves no scratch behind: the offline demos remove their work
 * root (unless --keep-work-root, which prints the kept path), a live run keeps
 * only its promoted repo, and only a run's own `scf-` scratch root is ever
 * touched. The CLI is spawned with a private TMPDIR so the check sees exactly
 * what one full offline run leaves.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { finishWorkRoot, isDisposableWorkRoot, pruneWorkRoot } from "../src/work-root.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(prefix = "scf-wr-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Run the CLI offline with its own TMPDIR; resolve its exit code and stdout. */
function runCli(args: readonly string[], tmp: string): Promise<{ code: number; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, SCF_ENV_FILE: "/dev/null" };
  for (const key of ["EXECUTOR", "CLOUDFLARE_AI_GATEWAY_URL", "CLOUDFLARE_AI_GATEWAY_TOKEN", "SWITCHYARD_API_TOKEN"]) {
    delete env[key];
  }
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", CLI, ...args],
      { cwd: REPO_ROOT, env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout) }),
    );
  });
}

const BOARD_ARGS = [
  "run-board",
  "--offline",
  "--fixture-gate",
  "--decide-contracts",
  "reject",
  "--goal-file",
  join(REPO_ROOT, "examples/goals/audit-logging.goal.txt"),
  "--project",
  join(REPO_ROOT, "examples/demo-project"),
];

describe("work roots", () => {
  it("a full offline board run (the demo) leaves no work root behind", async () => {
    const tmp = await scratch();
    const { code, stdout } = await runCli(BOARD_ARGS, tmp);
    expect(stdout).toContain("verdict: verified");
    expect(code).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith("work root removed: "));
    expect(line).toBeDefined();
    const root = /^work root removed: (\S+)/.exec(line!)![1]!;
    expect(root.startsWith(tmp)).toBe(true);
    expect(await exists(root)).toBe(false);
    // Nothing the run made is left in its temp directory.
    expect((await readdir(tmp)).filter((e) => e.startsWith("scf-"))).toEqual([]);
  }, 180_000);

  it("the offline Change demo (`run`) removes its work root too; --keep-work-root keeps it and prints where", async () => {
    const tmp = await scratch();
    const spec = join(REPO_ROOT, "examples/changes/audit-logging.change.yaml");
    const removed = await runCli(["run", spec], tmp);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toMatch(/^work root removed: /m);
    expect((await readdir(tmp)).filter((e) => e.startsWith("scf-"))).toEqual([]);

    const kept = await runCli(["run", spec, "--keep-work-root"], tmp);
    expect(kept.code).toBe(0);
    const root = /^work root kept: (\S+)$/m.exec(kept.stdout)?.[1];
    expect(root).toBeDefined();
    expect(await exists(join(root!, "source"))).toBe(true);
  }, 180_000);

  it("a live run keeps only its promoted repo: everything else in the work root is removed", async () => {
    const root = await scratch("scf-full-");
    for (const rel of ["source/.git/HEAD", "source/src/a.ts", "worktrees/u1/x.ts", "revisions/rev-1/y.ts", "package-cache/z", "integration-artifacts/i.git/HEAD"]) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), "x");
    }
    const line = await finishWorkRoot({ workRoot: root, keepAll: false, keep: [join(root, "source")] });
    expect(line).toContain(`kept ${join(root, "source")}`);
    expect((await readdir(root)).sort()).toEqual(["source"]);
    expect(await exists(join(root, "source/src/a.ts"))).toBe(true);
    // A nested kept path keeps its parents and drops their other children.
    await mkdir(join(root, "a/b/keep"), { recursive: true });
    await writeFile(join(root, "a/b/drop.txt"), "x");
    await pruneWorkRoot(root, [join(root, "source"), join(root, "a/b/keep")]);
    expect(await readdir(join(root, "a/b"))).toEqual(["keep"]);
  });

  it("never touches a path that is not a run's own scratch root", async () => {
    const other = await scratch("not-a-run-");
    await writeFile(join(other, "precious"), "x");
    expect(isDisposableWorkRoot(other)).toBe(false);
    expect(isDisposableWorkRoot("relative/scf-x")).toBe(false);
    expect(isDisposableWorkRoot("/")).toBe(false);
    expect(await pruneWorkRoot(other)).toEqual([]);
    expect(await finishWorkRoot({ workRoot: other, keepAll: false })).toMatch(/left in place/);
    expect(await exists(join(other, "precious"))).toBe(true);
    // A keep path outside the root is ignored (the root itself is removed).
    const root = await scratch("scf-run-");
    expect(await finishWorkRoot({ workRoot: root, keepAll: false, keep: [other] })).toMatch(/^work root removed: /);
    expect(await exists(root)).toBe(false);
    expect(await exists(other)).toBe(true);
  });
});

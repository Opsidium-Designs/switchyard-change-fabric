/**
 * The gate must be able to RUN inside a composed integration/promotion worktree.
 *
 * An app's per-app gate test lives at `<app>/gate/gate.test.mjs` and imports a
 * SHARED helper one directory above the app (`import ... from
 * "../../gate-harness.mjs"`). The worktrees the fabric composes to run the gate
 * (the per-unit verify clone, the integrator's integration checkout, and the
 * change-level ladder overlay) are seeded from the app project directory ALONE,
 * so that sibling helper lives OUTSIDE the copied tree.
 *
 * The regression this pins: if the composed worktree does not carry the shared
 * harness at the right place, `node --test gate/gate.test.mjs` fails with
 * ERR_MODULE_NOT_FOUND before any assertion runs, so EVERY run fails regardless
 * of what the model produced. The fix copies the app's sibling shared `.mjs`
 * files into the worktree parent, so `../../gate-harness.mjs` resolves and the
 * gate runs for real, failing only on genuine ASSERTIONS against the buggy
 * source, never on a missing module.
 *
 * This test is a faithful local reproduction of the composition
 * (buildIntegrationWorktree / cloneProjectForPromotion seed from the app dir
 * under a shared worktree root) run against the REAL service-api app fixture. It
 * runs the real gate through a child process; it is fully offline (no network,
 * no wrangler), since the gate imports the handler and asserts on the Response.
 */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVICE_API = join(REPO_ROOT, "examples", "apps", "service-api");
const APPS_DIR = dirname(SERVICE_API);

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scf-gate-harness-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

/**
 * Seed a composed worktree from the app project directory ALONE, exactly as the
 * fabric's cloneProjectForPromotion does (copy the app tree, skip build output).
 * The worktree is created UNDER `worktreeRoot`, so a gate at
 * `<worktree>/gate/gate.test.mjs` resolves `../../gate-harness.mjs` relative to
 * `worktreeRoot`.
 */
async function composeWorktree(worktreeRoot: string, label: string): Promise<string> {
  const worktreeDir = await mkdtemp(join(worktreeRoot, `scf-${label}-`));
  const skip = new Set(["node_modules", "dist", "build", ".git", "coverage", ".wrangler"]);
  await cp(SERVICE_API, worktreeDir, {
    recursive: true,
    filter: (src: string) => {
      const rel = resolve(src).slice(resolve(SERVICE_API).length).replace(/^[/\\]/, "");
      if (rel === "") {
        return true;
      }
      const top = rel.split(/[/\\]/)[0] ?? "";
      return !skip.has(top);
    },
  });
  return worktreeDir;
}

/**
 * Materialize the app's sibling shared `.mjs` files into the worktree parent,
 * mirroring the fix in runFullLive (materializeSiblingGateDeps). This is what
 * makes `../../gate-harness.mjs` resolve from inside the composed worktree.
 */
async function materializeSiblingHarness(parentDir: string): Promise<void> {
  const entries = await readdir(APPS_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
      .map((entry) => cp(join(APPS_DIR, entry.name), join(parentDir, entry.name))),
  );
}

/** Run the app's gate in a composed worktree and return the combined output. */
async function runGate(worktreeDir: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--test", "gate/gate.test.mjs"],
      { cwd: worktreeDir, maxBuffer: 8 * 1024 * 1024 },
    );
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      output: `${err.stdout ?? ""}\n${err.stderr ?? ""}`,
    };
  }
}

describe("the per-app gate resolves its shared harness inside a composed worktree", () => {
  it("WITHOUT the sibling harness the gate crashes with ERR_MODULE_NOT_FOUND (the bug)", async () => {
    // A composed worktree seeded from the app dir alone, with no harness copied
    // beside it: this is the buggy composition the fix repairs.
    const worktreeRoot = join(workRoot, "no-harness");
    await mkdir(worktreeRoot, { recursive: true });
    const worktreeDir = await composeWorktree(worktreeRoot, "integration");

    const { code, output } = await runGate(worktreeDir);

    // The gate could not even load: it failed resolving ../../gate-harness.mjs,
    // so every run would fail regardless of the model output.
    expect(code).not.toBe(0);
    expect(output).toContain("ERR_MODULE_NOT_FOUND");
    expect(output).toContain("gate-harness.mjs");
  });

  it("WITH the sibling harness materialized the gate RUNS and fails on ASSERTIONS, not a missing module", async () => {
    // The same composition, but now the fix materialized the app's sibling
    // shared .mjs files into the worktree parent, so ../../gate-harness.mjs
    // resolves from <worktreeRoot>/gate-harness.mjs.
    const worktreeRoot = join(workRoot, "with-harness");
    await mkdir(worktreeRoot, { recursive: true });
    const worktreeDir = await composeWorktree(worktreeRoot, "integration");
    await materializeSiblingHarness(worktreeRoot);

    const { code, output } = await runGate(worktreeDir);

    // The gate RAN against the buggy source: it must NOT be a module-resolution
    // crash. The import resolved; the harness was found.
    expect(output).not.toContain("ERR_MODULE_NOT_FOUND");

    // On the buggy source every resource skips auth and validation, so the
    // unauthenticated/invalid assertions FAIL: a real, mechanical gate failure
    // (the RIGHT reason), proving the gate executed its assertions rather than
    // dying on a missing import. node:test prints a failing-count summary and
    // real assertion errors.
    expect(code).not.toBe(0);
    expect(output).toMatch(/ℹ fail [1-9]\d*/);
    expect(output).toContain("ERR_ASSERTION");
    // The failing assertions name the planted gap (reject unauthenticated via
    // requireAuth / reject invalid input with 400), which only run once the
    // harness import resolved and the handler was invoked.
    expect(output).toMatch(/unauthenticated|requireAuth|invalid input|400/i);
  });

  it("works for ANY app that follows the shared ../../gate-harness.mjs layout (app-agnostic copy)", async () => {
    // The materialization copies whatever shared .mjs siblings the apps dir has,
    // not a service-api-specific file. Prove the copied set includes the shared
    // harness and that a second worktree under the SAME parent also resolves it
    // (one copy at the parent serves every worktree the fabric composes there,
    // which is how the per-unit verify, integrator, and ladder overlay all
    // resolve it from one placement).
    const worktreeRoot = join(workRoot, "shared-parent");
    await mkdir(worktreeRoot, { recursive: true });
    await materializeSiblingHarness(worktreeRoot);

    const first = await composeWorktree(worktreeRoot, "verify");
    const second = await composeWorktree(worktreeRoot, "ladder");

    const a = await runGate(first);
    const b = await runGate(second);
    for (const result of [a, b]) {
      expect(result.output).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.output).toMatch(/ℹ fail [1-9]\d*/);
      expect(result.output).toContain("ERR_ASSERTION");
    }
  });
});

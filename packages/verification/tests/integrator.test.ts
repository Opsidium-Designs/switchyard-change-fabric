/**
 * Integrator regressions over real local Git (no network):
 *
 *   - a verified unit that DELETES a baseline file integrates correctly: the
 *     deletion lands in the integrated tree (it used to throw ENOENT copying a
 *     path `git diff --name-only` reported but the unit no longer had);
 *   - a failed integration gate never pushes: the integration workspace stays at
 *     the baseline seed, so promotion can never clone a tree that failed.
 */

import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { WorkspaceRef } from "@switchyard-change/artifact-workspace";

import { advanceIntegrationBranch, Integrator, recordBaselineInventory, type VerifiedWorkspace } from "../src/integrator.ts";
import { readDependencySnapshotFromDir, runnerResolutionContract } from "../src/runner-resolution.ts";
import { FakeCommandRunner, installRecordingGit } from "./helpers.ts";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@switchyard.local"];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-integrator-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Commit everything in `dir` and return the new HEAD sha. */
async function commit(dir: string, message: string): Promise<string> {
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, ...IDENTITY, "commit", "--no-verify", "-m", message]);
  const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * Build a unit checkout whose baseline holds keep.txt + gone.txt, then a work
 * commit that modifies keep.txt and DELETES gone.txt. Returns the baseline sha.
 */
async function unitThatDeletes(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "--initial-branch=main"]);
  await writeFile(join(dir, "keep.txt"), "baseline\n", "utf8");
  await writeFile(join(dir, "gone.txt"), "to be deleted\n", "utf8");
  const baseline = await commit(dir, "baseline");
  await writeFile(join(dir, "keep.txt"), "fixed\n", "utf8");
  await rm(join(dir, "gone.txt"));
  await commit(dir, "work: modify keep, delete gone");
  return baseline;
}

/** Create an integration workspace seeded with the unit's baseline commit. */
async function seededIntegration(
  provider: LocalFilesystemWorkspaceProvider,
  unitDir: string,
  baseline: string,
): Promise<{ ref: WorkspaceRef; token: string }> {
  const ref = await provider.create("integration", { defaultBranch: "main" });
  const token = await provider.issueWriteToken(ref);
  await run("git", ["-C", unitDir, "push", ref.gitUrl, `${baseline}:refs/heads/main`]);
  return { ref, token: token.token };
}

async function trackedAt(gitUrl: string, dir: string): Promise<string[]> {
  await run("git", ["clone", gitUrl, dir]);
  const { stdout } = await run("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"]);
  return stdout.split("\n").filter((l) => l.trim() !== "").sort();
}

describe("Integrator", () => {
  it("carries a unit's file DELETION into the integrated tree instead of throwing ENOENT", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);

    const integrator = new Integrator(provider, { commandRunner: new FakeCommandRunner([]) });
    const result = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      workRoot: root,
    });

    expect(result.verdict).toBe("verified");
    expect(result.integratedUnits).toEqual(["u"]);
    const files = await trackedAt(ref.gitUrl, join(root, "check"));
    expect(files).toEqual(["keep.txt"]);
    // The result names the commit of the tree the gate ran on: the pushed head.
    const { stdout: head } = await run("git", ["-C", join(root, "check"), "rev-parse", "HEAD"]);
    expect(result.commit).toBe(head.trim());
    expect(result.commit).not.toBe(baseline);
  });

  it("does NOT push the integration commit when the authoritative gate fails", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);

    const runner = new FakeCommandRunner([
      { match: "gate", outcome: { code: 1, stdout: "", stderr: "gate failed" } },
    ]);
    const integrator = new Integrator(provider, { commandRunner: runner });
    const result = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["npm", "run", "gate"],
      requiresIntegrationGate: true,
      workRoot: root,
    });

    expect(result.verdict).toBe("failed");
    expect(result.integratedUnits).toEqual([]);
    // The rejected tree's commit is still reported (what the gate refused).
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit).not.toBe(baseline);
    // The failed tree never reached the integration workspace: it is still the
    // baseline seed, so nothing downstream can clone and ship it.
    const check = join(root, "check");
    await trackedAt(ref.gitUrl, check);
    const { stdout } = await run("git", ["-C", check, "rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(baseline);
  });

  it("applies exactly the pinned commit, not a later branch head", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const pinned = (await run("git", ["-C", unitDir, "rev-parse", "HEAD"])).stdout.trim();
    // An unannounced push after the pinned commit must never reach integration.
    await writeFile(join(unitDir, "keep.txt"), "unannounced\n", "utf8");
    await writeFile(join(unitDir, "extra.txt"), "unannounced\n", "utf8");
    await commit(unitDir, "unannounced");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);

    const integrator = new Integrator(provider, { commandRunner: new FakeCommandRunner([]) });
    const result = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline, commit: pinned }],
      excludedUnits: [],
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    const check = join(root, "check");
    expect(await trackedAt(ref.gitUrl, check)).toEqual(["keep.txt"]);
    const { stdout } = await run("git", ["-C", check, "show", "HEAD:keep.txt"]);
    expect(stdout).toBe("fixed\n");

    // A pinned commit the repo does not have is an error, never a silent fallback.
    await expect(
      integrator.integrate({
        integrationRef: ref,
        integrationToken: token,
        verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline, commit: "0".repeat(40) }],
        excludedUnits: [],
        workRoot: root,
      }),
    ).rejects.toThrow();
  });

  it("never applies paths a unit yields to another owner", async () => {
    const unitDir = join(root, "unit");
    await mkdir(unitDir, { recursive: true });
    await run("git", ["-C", unitDir, "init", "--initial-branch=main"]);
    await writeFile(join(unitDir, "base.txt"), "base\n", "utf8");
    const baseline = await commit(unitDir, "baseline");
    await mkdir(join(unitDir, "mine"), { recursive: true });
    await mkdir(join(unitDir, "handed"), { recursive: true });
    await writeFile(join(unitDir, "mine", "a.txt"), "mine\n", "utf8");
    await writeFile(join(unitDir, "handed", "b.txt"), "stale\n", "utf8");
    await commit(unitDir, "work");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const result = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline, yieldedScope: ["handed/**"] }],
      excludedUnits: [],
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    expect(await trackedAt(ref.gitUrl, join(root, "check"))).toEqual(["base.txt", "mine/a.txt"]);
  });

  it("restores protected (gate-defining) paths before the gate runs and fails the revision", async () => {
    const unitDir = join(root, "unit");
    await mkdir(join(unitDir, "gate"), { recursive: true });
    await run("git", ["-C", unitDir, "init", "--initial-branch=main"]);
    await writeFile(join(unitDir, "gate", "gate.test.mjs"), "assert(false)\n", "utf8");
    await writeFile(join(unitDir, "app.js"), "broken\n", "utf8");
    const baseline = await commit(unitDir, "baseline");
    // The unit "fixes" the app by rewriting the gate, and adds a gate helper.
    await writeFile(join(unitDir, "gate", "gate.test.mjs"), "assert(true)\n", "utf8");
    await writeFile(join(unitDir, "gate", "helper.mjs"), "export {}\n", "utf8");
    await writeFile(join(unitDir, "app.js"), "still broken\n", "utf8");
    await commit(unitDir, "tamper");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);

    // The gate passes only if it sees the tampered gate file.
    const seen: string[] = [];
    const runner = {
      async run(_argv: readonly string[], cwd: string) {
        const { readFile } = await import("node:fs/promises");
        const gate = await readFile(join(cwd, "gate", "gate.test.mjs"), "utf8");
        seen.push(gate);
        return { code: gate.includes("true") ? 0 : 1, stdout: "", stderr: gate.includes("true") ? "" : "gate failed" };
      },
    };
    const result = await new Integrator(provider, { commandRunner: runner }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["npm", "run", "gate"],
      requiresIntegrationGate: true,
      protectedPaths: ["gate/**", "package.json"],
      workRoot: root,
    });
    // The gate ran on the BASELINE gate file, never the rewritten one.
    expect(seen).toEqual(["assert(false)\n"]);
    expect(result.verdict).toBe("failed");
    expect(result.protectedViolations).toEqual(["gate/gate.test.mjs", "gate/helper.mjs"]);
    expect(result.finalCheck.summary).toMatch(/protected path\(s\) that define the gate/);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    const check = join(root, "check");
    await trackedAt(ref.gitUrl, check);
    const { stdout } = await run("git", ["-C", check, "rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(baseline); // a failed revision is never pushed
  });

  it("an applied file the tree's ignore rules match is removed before the gate and fails the revision (gate-equals-deploy); an install's node_modules does not", async () => {
    const unitDir = join(root, "unit");
    await mkdir(unitDir, { recursive: true });
    await run("git", ["-C", unitDir, "init", "--initial-branch=main"]);
    await writeFile(join(unitDir, ".gitignore"), "dist/\nnode_modules/\n", "utf8");
    await writeFile(join(unitDir, "app.js"), "broken\n", "utf8");
    const baseline = await commit(unitDir, "baseline");
    // The unit's repo commits an ignored build output (force-added) the gate would read.
    await writeFile(join(unitDir, "app.js"), "fixed\n", "utf8");
    await mkdir(join(unitDir, "dist"), { recursive: true });
    await writeFile(join(unitDir, "dist", "out.js"), "the gate passes on me\n", "utf8");
    await run("git", ["-C", unitDir, "add", "-f", "dist/out.js", "app.js"]);
    await run("git", ["-C", unitDir, ...IDENTITY, "commit", "--no-verify", "-m", "work with an ignored file"]);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);

    const { access } = await import("node:fs/promises");
    const seen: boolean[] = [];
    const runner = {
      async run(_argv: readonly string[], cwd: string) {
        // An install creates node_modules (ignored) BEFORE the gate: never a violation.
        await mkdir(join(cwd, "node_modules", "dep"), { recursive: true });
        await writeFile(join(cwd, "node_modules", "dep", "index.js"), "installed\n", "utf8");
        const present = await access(join(cwd, "dist", "out.js")).then(() => true, () => false);
        seen.push(present);
        return { code: present ? 0 : 1, stdout: "", stderr: present ? "" : "gate failed" };
      },
    };
    const result = await new Integrator(provider, { commandRunner: runner }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["npm", "run", "gate"],
      requiresIntegrationGate: true,
      workRoot: root,
    });
    // The gate never saw the ignored file; the revision fails with a clear reason.
    expect(seen).toEqual([false]);
    expect(result.verdict).toBe("failed");
    expect(result.protectedViolations).toEqual([expect.stringMatching(/^dist\/out\.js \(matched by the tree's ignore rules: the commit would omit it/)]);
    expect(result.finalCheck.summary).toMatch(/applied file\(s\) the tree's ignore rules match/);
    expect(result.finalCheck.summary).not.toMatch(/node_modules/);
    // A failed revision is never pushed: the workspace stays at the baseline.
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    const check = join(root, "check");
    await trackedAt(ref.gitUrl, check);
    const { stdout } = await run("git", ["-C", check, "rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(baseline);
  });

  it("without an ignored path the same unit integrates and passes (only applied paths are checked)", async () => {
    const unitDir = join(root, "unit");
    await mkdir(unitDir, { recursive: true });
    await run("git", ["-C", unitDir, "init", "--initial-branch=main"]);
    await writeFile(join(unitDir, ".gitignore"), "dist/\nnode_modules/\n", "utf8");
    await writeFile(join(unitDir, "app.js"), "broken\n", "utf8");
    const baseline = await commit(unitDir, "baseline");
    await writeFile(join(unitDir, "app.js"), "fixed\n", "utf8");
    await commit(unitDir, "work");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const runner = {
      async run(_argv: readonly string[], cwd: string) {
        await mkdir(join(cwd, "node_modules", "dep"), { recursive: true });
        await writeFile(join(cwd, "node_modules", "dep", "index.js"), "installed\n", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const result = await new Integrator(provider, { commandRunner: runner }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["npm", "run", "gate"],
      requiresIntegrationGate: true,
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    expect(result.protectedViolations).toBeUndefined();
  });

  it("a deferred integration never moves the branch; the caller advances it after recording", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const integrator = new Integrator(provider, { commandRunner: new FakeCommandRunner([]) });
    const result = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      deferBranchPush: true,
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    const head = async () => {
      const dir = await mkdtemp(join(root, "head-"));
      await run("git", ["clone", "-q", ref.gitUrl, dir]);
      return (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    };
    expect(await head()).toBe(baseline); // a pass the caller never recorded leaves the branch alone
    // A later integration based on the recorded base (still the baseline) never sees the unrecorded commit.
    const again = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [],
      excludedUnits: [],
      baseCommit: baseline,
      deferBranchPush: true,
      workRoot: root,
    });
    expect(again.commit).toBe(baseline);
    // Once recorded, the caller advances the branch to exactly the gated commit (based on the candidate ref).
    await advanceIntegrationBranch(ref, token, result.commit!, root);
    expect(await head()).toBe(result.commit);
    const built = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [],
      excludedUnits: [],
      baseCommit: result.commit!,
      workRoot: root,
    });
    expect(built.commit).toBe(result.commit);
  });

  it("keeps a failed gated commit on its candidate ref only when asked (never the branch), for an advisory preview", async () => {
    const refsAt = async (gitUrl: string) =>
      (await run("git", ["-C", fileURLToPath(gitUrl), "for-each-ref", "--format=%(refname) %(objectname)"])).stdout.trim().split("\n");
    for (const keep of [false, true]) {
      const unitDir = join(root, `unit-${keep}`);
      const baseline = await unitThatDeletes(unitDir);
      const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, `artifacts-${keep}`) });
      const { ref, token } = await seededIntegration(provider, unitDir, baseline);
      const integrator = new Integrator(provider, {
        commandRunner: new FakeCommandRunner([{ match: "gate", outcome: { code: 1, stdout: "", stderr: "gate failed" } }]),
      });
      const result = await integrator.integrate({
        integrationRef: ref,
        integrationToken: token,
        verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
        excludedUnits: [],
        integrationGateCommand: ["npm", "run", "gate"],
        requiresIntegrationGate: true,
        deferBranchPush: true,
        ...(keep ? { keepFailedGatedCommit: true } : {}),
        workRoot: root,
      });
      expect(result.verdict).toBe("failed");
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      const refs = await refsAt(ref.gitUrl);
      // The branch never moves on a failed gate, kept or not.
      expect(refs).toContain(`refs/heads/main ${baseline}`);
      expect(refs.includes(`refs/switchyard/gated/${result.commit} ${result.commit}`)).toBe(keep);
    }
  });

  it("restores protected JSON keys only, keeps released paths, and in restore mode keeps the gate's verdict", async () => {
    const unitDir = join(root, "unit");
    await mkdir(join(unitDir, "tests"), { recursive: true });
    await run("git", ["-C", unitDir, "init", "--initial-branch=main"]);
    await writeFile(join(unitDir, "package.json"), JSON.stringify({ name: "p", scripts: { gate: "node --test", other: "x" }, dependencies: {} }, null, 2) + "\n");
    await writeFile(join(unitDir, "tests", "a.test.mjs"), "original a\n");
    await writeFile(join(unitDir, "tests", "b.test.mjs"), "original b\n");
    const baseline = await commit(unitDir, "baseline");
    await writeFile(
      join(unitDir, "package.json"),
      JSON.stringify({ name: "p", scripts: { gate: "true", other: "y" }, dependencies: { left: "1.0.0" } }, null, 2) + "\n",
    );
    await writeFile(join(unitDir, "tests", "a.test.mjs"), "rewritten a\n");
    await writeFile(join(unitDir, "tests", "b.test.mjs"), "accepted change to b\n");
    await writeFile(join(unitDir, "tests", "new.test.mjs"), "a new test\n");
    await commit(unitDir, "work");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const result = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline, releasedPaths: ["tests/b.test.mjs"] }],
      excludedUnits: [],
      integrationGateCommand: ["npm", "run", "gate"],
      requiresIntegrationGate: true,
      protectedPaths: ["tests/a.test.mjs", "tests/b.test.mjs", "**/vitest.config.*"],
      protectedJsonKeys: [{ file: "package.json", keys: [["scripts", "gate"], ["packageManager"]] }],
      onProtectedChange: "restore",
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    expect(result.protectedViolations).toEqual(["tests/a.test.mjs", "package.json#scripts.gate"]);
    const check = join(root, "check");
    await trackedAt(ref.gitUrl, check);
    const pkg = JSON.parse((await run("git", ["-C", check, "show", "HEAD:package.json"])).stdout);
    expect(pkg).toEqual({ name: "p", scripts: { gate: "node --test", other: "y" }, dependencies: { left: "1.0.0" } });
    expect((await run("git", ["-C", check, "show", "HEAD:tests/a.test.mjs"])).stdout).toBe("original a\n");
    expect((await run("git", ["-C", check, "show", "HEAD:tests/b.test.mjs"])).stdout).toBe("accepted change to b\n");
    expect((await run("git", ["-C", check, "show", "HEAD:tests/new.test.mjs"])).stdout).toBe("a new test\n");
  });

  it("fails a gate run that exits 0 without executing the baseline's tests (early exit)", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const baselineRunner = new FakeCommandRunner([{ match: "gate", outcome: { code: 1, stdout: "not ok 1 - a\nok 2 - b\n", stderr: "" } }]);
    const inventory = await recordBaselineInventory({ integrationRef: ref, integrationToken: token, gateCommand: ["npm", "run", "gate"], commandRunner: baselineRunner, workRoot: root });
    expect(inventory).toEqual({ format: "tap", count: 2, names: ["a", "b"] });
    // The unit's code exits early: the runner reports success with test "a" never run.
    const early = new FakeCommandRunner([{ match: "gate", outcome: { code: 0, stdout: "ok 1 - b\n", stderr: "" } }]);
    const result = await new Integrator(provider, { commandRunner: early }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["npm", "run", "gate"],
      requiresIntegrationGate: true,
      testInventory: inventory!,
      workRoot: root,
    });
    expect(result.verdict).toBe("failed");
    expect(result.finalCheck.summary).toBe("integration app-gate exited 0 but did not run its tests: test inventory: 1 of the 2 baseline test(s) did not execute");
  });

  it("reads the gate's progress from its FULL output, so a later suite's summary past the bounded capture still counts", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const noise = Array.from({ length: 200 }, (_, i) => ` FAIL  gate/a.test.ts > case ${i}\nAssertionError: expected 1 to be 2`).join("\n");
    const stdout = ` ✓ tests/dev.test.ts (9 tests)\n      Tests  9 passed (9)\n ❯ gate/a.test.ts (210 tests | 200 failed)\n${noise}\n      Tests  200 failed | 10 passed (210)\n`;
    const runner = new FakeCommandRunner([{ match: "gate", outcome: { code: 1, stdout, stderr: "" } }]);
    const result = await new Integrator(provider, { commandRunner: runner }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["npm", "run", "gate"],
      requiresIntegrationGate: true,
      workRoot: root,
    });
    expect(result.finalCheck.outputs[0]!.text).toMatch(/\[truncated \d+ chars\]$/);
    expect(result.finalCheck.progress?.suites?.map((s) => [s.passed, s.total, s.files])).toEqual([
      [9, 9, ["tests/dev.test.ts"]],
      [10, 210, ["gate/a.test.ts"]],
    ]);
  });

  it("applies a released protected path only for the unit it was released for; never symlinks or dependency trees", async () => {
    const base = join(root, "base");
    await mkdir(join(base, "tests"), { recursive: true });
    await run("git", ["-C", base, "init", "--initial-branch=main"]);
    await writeFile(join(base, "tests", "a.test.mjs"), "original\n");
    await writeFile(join(base, "app.js"), "app\n");
    const baselineSha = await commit(base, "baseline");
    const unit = async (name: string, files: Record<string, string>, extra?: (dir: string) => Promise<void>) => {
      const dir = join(root, name);
      await run("git", ["clone", "-q", base, dir]);
      for (const [rel, body] of Object.entries(files)) {
        await mkdir(dirname(join(dir, rel)), { recursive: true });
        await writeFile(join(dir, rel), body);
      }
      await extra?.(dir);
      await commit(dir, name);
      return dir;
    };
    const owner = await unit("owner", { "tests/a.test.mjs": "changed by the released owner\n" });
    const other = await unit("other", { "app.js": "app 2\n", "node_modules/x/index.js": "evil\n" }, async (dir) => {
      await symlink("/etc/passwd", join(dir, "link.txt"));
    });
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, base, baselineSha);
    const integrate = (verified: VerifiedWorkspace[]) =>
      new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
        integrationRef: ref,
        integrationToken: token,
        verified,
        excludedUnits: [],
        protectedPaths: ["tests/a.test.mjs"],
        onProtectedChange: "restore",
        deferBranchPush: true,
        workRoot: root,
      });
    const released = await integrate([
      { unitId: "owner", gitUrl: pathToFileURL(owner).href, baselineRef: baselineSha, releasedPaths: ["tests/a.test.mjs"] },
      { unitId: "other", gitUrl: pathToFileURL(other).href, baselineRef: baselineSha },
    ]);
    expect(released.protectedViolations).toEqual([
      "link.txt (a symlink: never applied)",
      "node_modules/x/index.js (dependency or tool tree: never applied from a unit)",
    ]);
    // The same write from a unit it was NOT released for is refused.
    const notReleased = await integrate([{ unitId: "owner", gitUrl: pathToFileURL(owner).href, baselineRef: baselineSha }]);
    expect(notReleased.protectedViolations).toEqual(["tests/a.test.mjs"]);
  });

  it("never writes through a baseline symlink, and creates no directory outside the checkout", async () => {
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const base = join(root, "base-link");
    await mkdir(base, { recursive: true });
    await run("git", ["-C", base, "init", "--initial-branch=main"]);
    await writeFile(join(base, "app.js"), "app\n");
    await symlink(outside, join(base, "out"));
    const baselineSha = await commit(base, "baseline with a symlinked dir");
    const unitDir = join(root, "unit-link");
    await run("git", ["clone", "-q", base, unitDir]);
    await run("git", ["-C", unitDir, "rm", "-q", "out"]);
    await mkdir(join(unitDir, "out", "deep"), { recursive: true });
    await writeFile(join(unitDir, "out", "deep", "f.txt"), "escape\n");
    await commit(unitDir, "replace the link with a directory");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, base, baselineSha);
    const result = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baselineSha }],
      excludedUnits: [],
      onProtectedChange: "restore",
      workRoot: root,
    });
    expect(result.protectedViolations).toEqual(expect.arrayContaining(["out/deep/f.txt (resolves outside the integration checkout)"]));
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(outside)).toEqual([]); // nothing written or created outside
  });

  it("a hook or config the gate's code plants in the checkout never runs: the push comes from a trusted repo", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const marker = join(root, "hook-ran");
    const planting = {
      async run(_argv: readonly string[], cwd: string) {
        const hook = `#!/bin/sh\necho "$@" > ${marker}\nexit 0\n`;
        for (const name of ["pre-push", "post-checkout", "reference-transaction", "fsmonitor-watchman"]) {
          await writeFile(join(cwd, ".git", "hooks", name), hook, { mode: 0o755 });
        }
        await run("git", ["-C", cwd, "config", "core.hooksPath", join(cwd, ".git", "hooks")]);
        await run("git", ["-C", cwd, "config", "core.fsmonitor", join(cwd, ".git", "hooks", "fsmonitor-watchman")]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const result = await new Integrator(provider, { commandRunner: planting }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["gate"],
      requiresIntegrationGate: true,
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    const check = join(root, "check");
    await trackedAt(ref.gitUrl, check);
    expect((await run("git", ["-C", check, "rev-parse", "HEAD"])).stdout.trim()).toBe(result.commit);
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });

  it("a pushInsteadOf the gate plants in ~/.gitconfig or the trusted repo cannot redirect the credentialed push; no token in git's argv", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref } = await seededIntegration(provider, unitDir, baseline);
    const evil = join(root, "evil.git");
    await run("git", ["init", "-q", "--bare", evil]);
    // The integration remote is an https Artifacts URL with a token; the
    // recording wrapper maps it to the local bare repo (no network).
    const token = "S3CRET-integration-token";
    const httpsRef: WorkspaceRef = { ...ref, gitUrl: "https://artifacts.example/integration.git" };
    const fake = await installRecordingGit(root, { "https://artifacts.example/integration.git": ref.gitUrl });
    const savedHome = process.env.HOME;
    const home = join(root, "home");
    await mkdir(home);
    process.env.HOME = home;
    const redirect = `[url "${pathToFileURL(evil).href}"]\n\tpushInsteadOf = https://artifacts.example/\n`;
    let plantedTrusted = 0;
    const planting = {
      async run() {
        // Same-user code: plant a redirect in the user's git config and in
        // every trusted repo it can find by path.
        await writeFile(join(home, ".gitconfig"), redirect);
        for (const name of await readdir(tmpdir())) {
          if (name.startsWith("scf-trusted-")) {
            await appendFile(join(tmpdir(), name, "repo.git", "config"), redirect).then(() => (plantedTrusted += 1), () => undefined);
          }
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    try {
      const result = await new Integrator(provider, { commandRunner: planting }).integrate({
        integrationRef: httpsRef,
        integrationToken: token,
        verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
        excludedUnits: [],
        integrationGateCommand: ["gate"],
        requiresIntegrationGate: true,
        workRoot: root,
      });
      expect(plantedTrusted).toBeGreaterThan(0);
      expect(result.verdict).toBe("verified");
      const real = (await run("git", ["-C", fileURLToPath(ref.gitUrl), "rev-parse", "refs/heads/main"])).stdout.trim();
      expect(real).toBe(result.commit);
      expect((await run("git", ["-C", evil, "for-each-ref"])).stdout.trim()).toBe("");
      const calls = await fake.calls();
      expect(calls.some((c) => c.argv.includes(" push "))).toBe(true);
      for (const call of calls) {
        expect(call.argv).not.toContain(token);
      }
    } finally {
      fake.restore();
      process.env.HOME = savedHome;
    }
  });

  it("a commit the gate's code makes is never pushed or recorded; a changed tested tree fails the revision", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitThatDeletes(unitDir);
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    let gatedHead = "";
    const sneaky = {
      async run(_argv: readonly string[], cwd: string) {
        gatedHead = (await run("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
        await writeFile(join(cwd, "keep.txt"), "rewritten while the tests ran\n");
        await run("git", ["-C", cwd, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qam", "sneak"]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const result = await new Integrator(provider, { commandRunner: sneaky }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["gate"],
      requiresIntegrationGate: true,
      workRoot: root,
    });
    expect(result.commit).toBe(gatedHead); // the commit captured before the gate, not the sneaked one
    expect(result.verdict).toBe("failed");
    expect(result.finalCheck.summary).toMatch(/the gate run changed tracked files of the gated tree \(keep\.txt\)/);
    const check = join(root, "check");
    await trackedAt(ref.gitUrl, check);
    expect((await run("git", ["-C", check, "rev-parse", "HEAD"])).stdout.trim()).toBe(baseline); // nothing pushed
  });

  describe("the gate's runner resolution (real local git)", () => {
    const RUNNER_PACKAGES = {
      "": { name: "app", devDependencies: { vitest: "2.1.8", "left-pad": "1.3.0" } },
      "node_modules/vitest": {
        version: "2.1.8",
        resolved: "https://registry.npmjs.org/vitest/-/vitest-2.1.8.tgz",
        integrity: "sha512-vitest",
        dev: true,
        dependencies: { vite: "^5.0.0" },
        bin: { vitest: "vitest.mjs" },
      },
      "node_modules/vite": { version: "5.4.0", resolved: "https://registry.npmjs.org/vite/-/vite-5.4.0.tgz", integrity: "sha512-vite", dev: true },
      "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-leftpad", dev: true },
    };
    const lockText = (packages: Record<string, unknown>) => JSON.stringify({ name: "app", lockfileVersion: 3, requires: true, packages }, null, 2) + "\n";
    const manifestText = (devDependencies: Record<string, string>) =>
      JSON.stringify({ name: "app", scripts: { gate: "vitest run" }, devDependencies }, null, 2) + "\n";

    /** Integrate a unit whose work commit rewrites the lockfile (and optionally the manifest), under the claim-time contract for vitest. */
    async function integrateLockChange(packages: Record<string, unknown>, devDependencies?: Record<string, string>) {
      const unitDir = join(root, "unit");
      await mkdir(join(unitDir, "src"), { recursive: true });
      await run("git", ["-C", unitDir, "init", "--initial-branch=main"]);
      await writeFile(join(unitDir, "package.json"), manifestText({ vitest: "2.1.8", "left-pad": "1.3.0" }));
      await writeFile(join(unitDir, "package-lock.json"), lockText(RUNNER_PACKAGES));
      await writeFile(join(unitDir, "src", "app.js"), "export const x = 1;\n");
      const baseline = await commit(unitDir, "baseline");
      const contract = runnerResolutionContract(await readDependencySnapshotFromDir(unitDir), ["vitest"]);
      await writeFile(join(unitDir, "package-lock.json"), lockText(packages));
      if (devDependencies) {
        await writeFile(join(unitDir, "package.json"), manifestText(devDependencies));
      }
      await writeFile(join(unitDir, "src", "app.js"), "export const x = 2;\n");
      await commit(unitDir, "work");
      const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
      const { ref, token } = await seededIntegration(provider, unitDir, baseline);
      const result = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
        integrationRef: ref,
        integrationToken: token,
        verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
        excludedUnits: [],
        integrationGateCommand: ["npm", "run", "gate"],
        requiresIntegrationGate: true,
        protectedPaths: [],
        protectedJsonKeys: contract.jsonKeys,
        // Even in restore mode: a runner swap cannot be restored key by key.
        onProtectedChange: "restore",
        workRoot: root,
      });
      const branch = (await run("git", ["-C", fileURLToPath(ref.gitUrl), "rev-parse", "refs/heads/main"])).stdout.trim();
      return { result, baseline, branch };
    }

    it("refuses a nested lockfile entry that shadows a runner dependency, even in restore mode, and pushes nothing", async () => {
      const { result, baseline, branch } = await integrateLockChange({
        ...RUNNER_PACKAGES,
        "node_modules/vitest/node_modules/vite": { version: "0.0.1", resolved: "https://example.invalid/vite.tgz", integrity: "sha512-x" },
      });
      expect(result.verdict).toBe("failed");
      expect(result.integratedUnits).toEqual([]);
      expect(result.protectedViolations).toEqual([expect.stringMatching(/^package-lock\.json#packages\["node_modules\/vitest\/node_modules\/vite"\]: .*absent to version 0\.0\.1/)]);
      expect(result.finalCheck.summary).toMatch(/runner resolution cannot be restored key by key/);
      expect(branch).toBe(baseline);
    });

    it("refuses a new package that declares the vitest bin", async () => {
      const { result, baseline, branch } = await integrateLockChange(
        {
          ...RUNNER_PACKAGES,
          "": { name: "app", devDependencies: { vitest: "2.1.8", "left-pad": "1.3.0", innocent: "1.0.0" } },
          "node_modules/innocent": { version: "1.0.0", resolved: "https://example.invalid/innocent.tgz", integrity: "sha512-i", dev: true, bin: { vitest: "shim.js" } },
        },
        { vitest: "2.1.8", "left-pad": "1.3.0", innocent: "1.0.0" },
      );
      expect(result.verdict).toBe("failed");
      expect(result.protectedViolations).toEqual([expect.stringMatching(/node_modules\/innocent.*declares the gate's runner bin\(s\) vitest/)]);
      expect(branch).toBe(baseline);
    });

    it("lets an unrelated dependency bump through", async () => {
      const { result, branch } = await integrateLockChange(
        {
          ...RUNNER_PACKAGES,
          "": { name: "app", devDependencies: { vitest: "2.1.8", "left-pad": "1.3.1" } },
          "node_modules/left-pad": { version: "1.3.1", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.1.tgz", integrity: "sha512-leftpad2", dev: true },
        },
        { vitest: "2.1.8", "left-pad": "1.3.1" },
      );
      expect(result.verdict).toBe("verified");
      expect(result.protectedViolations).toBeUndefined();
      expect(branch).toBe(result.commit);
    });
  });
});

describe("Integrator: per-item path selection (one agent's repo, several items)", () => {
  /** A unit repo whose baseline holds a.txt, s.txt, z.txt and gone.txt. */
  async function unitRepo(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    await run("git", ["-C", dir, "init", "--initial-branch=main"]);
    for (const name of ["a.txt", "s.txt", "z.txt", "gone.txt"]) {
      await writeFile(join(dir, name), `${name} baseline\n`, "utf8");
    }
    return commit(dir, "baseline");
  }

  async function show(gitUrl: string, dir: string, commitSha: string, rel: string): Promise<string | undefined> {
    await run("git", ["clone", "-q", gitUrl, dir]);
    return run("git", ["-C", dir, "show", `${commitSha}:${rel}`]).then(
      (r) => r.stdout,
      () => undefined,
    );
  }

  it("applies each part's files from its own commit; files of no part are yielded and recorded", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitRepo(unitDir);
    // c1: item A's push (a.txt v1, deletes gone.txt).
    await writeFile(join(unitDir, "a.txt"), "a v1\n", "utf8");
    await rm(join(unitDir, "gone.txt"));
    const c1 = await commit(unitDir, "A");
    // c2: item S's push; the head also carries unannounced a.txt work and z.txt (another item's).
    await writeFile(join(unitDir, "a.txt"), "a v2 (unannounced)\n", "utf8");
    await writeFile(join(unitDir, "s.txt"), "s v1\n", "utf8");
    await writeFile(join(unitDir, "z.txt"), "z (another item's)\n", "utf8");
    const c2 = await commit(unitDir, "S");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);

    const integrator = new Integrator(provider, { commandRunner: new FakeCommandRunner([]) });
    const result = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [
        {
          unitId: "agent",
          gitUrl: pathToFileURL(unitDir).href,
          baselineRef: baseline,
          commit: c2,
          parts: [
            { item: "A", commit: c1, baselineRef: baseline, scope: ["a.txt", "gone.txt"] },
            { item: "S", commit: c2, baselineRef: baseline, scope: ["s.txt"] },
          ],
        },
      ],
      excludedUnits: [],
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    expect(result.appliedUnits).toEqual([{ unitId: "agent", applied: ["a.txt", "gone.txt", "s.txt"], yielded: ["z.txt"] }]);
    const check = join(root, "check");
    expect(await show(ref.gitUrl, check, result.commit!, "a.txt")).toBe("a v1\n");
    expect((await run("git", ["-C", check, "show", `${result.commit!}:s.txt`])).stdout).toBe("s v1\n");
    expect((await run("git", ["-C", check, "show", `${result.commit!}:z.txt`])).stdout).toBe("z.txt baseline\n");
    expect(await run("git", ["-C", check, "show", `${result.commit!}:gone.txt`]).then(() => "present", () => "deleted")).toBe("deleted");
  });

  it("parts at the same commit are applied once, together", async () => {
    const unitDir = join(root, "unit");
    const baseline = await unitRepo(unitDir);
    await writeFile(join(unitDir, "a.txt"), "a v1\n", "utf8");
    await writeFile(join(unitDir, "s.txt"), "s v1\n", "utf8");
    const c1 = await commit(unitDir, "A and S");
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
    const { ref, token } = await seededIntegration(provider, unitDir, baseline);
    const result = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [
        {
          unitId: "agent",
          gitUrl: pathToFileURL(unitDir).href,
          baselineRef: baseline,
          commit: c1,
          parts: [
            { item: "A", commit: c1, baselineRef: baseline, scope: ["a.txt"] },
            { item: "S", commit: c1, baselineRef: baseline, scope: ["s.txt"] },
          ],
        },
      ],
      excludedUnits: [],
      workRoot: root,
    });
    expect(result.appliedUnits).toEqual([{ unitId: "agent", applied: ["a.txt", "s.txt"], yielded: [] }]);
  });
});

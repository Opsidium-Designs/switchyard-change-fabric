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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { WorkspaceRef } from "@switchyard-change/artifact-workspace";

import { Integrator } from "../src/integrator.ts";
import { FakeCommandRunner } from "./helpers.ts";

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
    // The failed tree never reached the integration workspace: it is still the
    // baseline seed, so nothing downstream can clone and ship it.
    const check = join(root, "check");
    await trackedAt(ref.gitUrl, check);
    const { stdout } = await run("git", ["-C", check, "rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(baseline);
  });
});

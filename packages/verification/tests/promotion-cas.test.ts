/**
 * Compare-and-swap promotion over real local Git (no network):
 *
 *   - a normal integration moves the branch from exactly the trunk it built
 *     on to the gated commit, and says so (`promotion`);
 *   - another writer advancing the trunk between integrate and push makes the
 *     push a typed "trunk-moved" refusal, and the branch keeps the other
 *     writer's value (we never overwrite it);
 *   - advanceIntegrationBranch refuses the same way, before or without pushing.
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

import { advanceIntegrationBranch, Integrator, isPromotionRefused, PromotionRefusedError } from "../src/integrator.ts";
import type { CommandRunner } from "../src/command.ts";
import { INTEGRATE_JOB_VERSION } from "../src/integrate-job.ts";
import { runAdvanceJob } from "../src/integrate-run.ts";
import { FakeCommandRunner } from "./helpers.ts";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@switchyard.local"];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-promotion-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function commit(dir: string, message: string): Promise<string> {
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, ...IDENTITY, "commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
  return (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}

/** A unit repo (baseline, then a work commit) and an integration repo seeded at the baseline. */
async function fixture(): Promise<{ provider: LocalFilesystemWorkspaceProvider; ref: WorkspaceRef; token: string; unitDir: string; baseline: string }> {
  const unitDir = join(root, "unit");
  await mkdir(unitDir, { recursive: true });
  await run("git", ["-C", unitDir, "init", "-q", "--initial-branch=main"]);
  await writeFile(join(unitDir, "a.txt"), "baseline\n");
  const baseline = await commit(unitDir, "baseline");
  await writeFile(join(unitDir, "a.txt"), "fixed\n");
  await commit(unitDir, "work");
  const provider = new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "artifacts") });
  const ref = await provider.create("integration", { defaultBranch: "main" });
  const token = (await provider.issueWriteToken(ref)).token;
  await run("git", ["-C", unitDir, "push", "-q", ref.gitUrl, `${baseline}:refs/heads/main`]);
  return { provider, ref, token, unitDir, baseline };
}

/** Another writer: advance the remote's main by one commit (a fast-forward), returning the new head. */
async function advanceRemote(gitUrl: string, name: string): Promise<string> {
  const dir = await mkdtemp(join(root, `racer-${name}-`));
  await run("git", ["clone", "-q", gitUrl, dir]);
  await writeFile(join(dir, `${name}.txt`), `${name}\n`);
  const head = await commit(dir, `racer ${name}`);
  await run("git", ["-C", dir, "push", "-q", "origin", "HEAD:main"]);
  return head;
}

async function remoteMain(gitUrl: string): Promise<string> {
  const { stdout } = await run("git", ["ls-remote", gitUrl, "refs/heads/main"]);
  return stdout.trim().split(/\s+/)[0] ?? "";
}

describe("compare-and-swap promotion", () => {
  it("moves the branch from exactly the trunk it built on to the gated commit", async () => {
    const { provider, ref, token, unitDir, baseline } = await fixture();
    const result = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      integrationGateCommand: ["gate"],
      requiresIntegrationGate: true,
      workRoot: root,
    });
    expect(result.verdict).toBe("verified");
    expect(result.promotion).toEqual({ ref: "refs/heads/main", commit: result.commit, expectedOld: baseline });
    expect(await remoteMain(ref.gitUrl)).toBe(result.commit); // gated == pushed
  });

  it("a trunk advanced while the gate ran is a typed trunk-moved refusal, and the other writer's value stays", async () => {
    const { provider, ref, token, unitDir, baseline } = await fixture();
    let racer = "";
    const racingGate: CommandRunner = {
      async run() {
        racer = await advanceRemote(ref.gitUrl, "concurrent");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const failure = await new Integrator(provider, { commandRunner: racingGate })
      .integrate({
        integrationRef: ref,
        integrationToken: token,
        verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
        excludedUnits: [],
        integrationGateCommand: ["gate"],
        requiresIntegrationGate: true,
        workRoot: root,
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PromotionRefusedError);
    expect(isPromotionRefused(failure, "trunk-moved")).toBe(true);
    const refusal = failure as PromotionRefusedError;
    expect(refusal.expected).toBe(baseline);
    expect(refusal.actual).toBe(racer);
    expect(refusal.ref).toBe("refs/heads/main");
    expect(refusal.message).toMatch(/trunk-moved/);
    expect(await remoteMain(ref.gitUrl)).toBe(racer); // never overwritten by us
  });

  it("advanceIntegrationBranch leases the branch value and refuses a moved trunk", async () => {
    const { provider, ref, token, unitDir, baseline } = await fixture();
    const integrator = new Integrator(provider, { commandRunner: new FakeCommandRunner([]) });
    const deferred = await integrator.integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      deferBranchPush: true,
      workRoot: root,
    });
    expect(deferred.promotion).toBeUndefined(); // a candidate ref, not the branch
    expect(await remoteMain(ref.gitUrl)).toBe(baseline);

    // The caller names the trunk it built on; another writer moved it first.
    const racer = await advanceRemote(ref.gitUrl, "first");
    const moved = await advanceIntegrationBranch(ref, token, deferred.commit!, root, { expectedBase: baseline }).catch((e: unknown) => e);
    expect(isPromotionRefused(moved, "trunk-moved")).toBe(true);
    expect((moved as PromotionRefusedError).actual).toBe(racer);
    expect(await remoteMain(ref.gitUrl)).toBe(racer);

    // Without a named base, the read value is leased: the gated commit does
    // not descend from the racer's head, so it is never pushed sideways.
    const sideways = await advanceIntegrationBranch(ref, token, deferred.commit!, root).catch((e: unknown) => e);
    expect(isPromotionRefused(sideways, "not-descendant")).toBe(true);
    expect(await remoteMain(ref.gitUrl)).toBe(racer);
  });

  it("advanceIntegrationBranch fast-forwards from the expected base and is a no-op when already there", async () => {
    const { provider, ref, token, unitDir, baseline } = await fixture();
    const deferred = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      deferBranchPush: true,
      workRoot: root,
    });
    const pushed = await advanceIntegrationBranch(ref, token, deferred.commit!, root, { expectedBase: baseline });
    expect(pushed).toEqual({ ref: "refs/heads/main", commit: deferred.commit, expectedOld: baseline });
    expect(await remoteMain(ref.gitUrl)).toBe(deferred.commit);
    const again = await advanceIntegrationBranch(ref, token, deferred.commit!, root);
    expect(again.expectedOld).toBe(deferred.commit);
    expect(await remoteMain(ref.gitUrl)).toBe(deferred.commit);
  });

  it("an advance job reports a lost compare-and-swap as a named refusal, not a generic error", async () => {
    const { provider, ref, token, unitDir, baseline } = await fixture();
    const deferred = await new Integrator(provider, { commandRunner: new FakeCommandRunner([]) }).integrate({
      integrationRef: ref,
      integrationToken: token,
      verified: [{ unitId: "u", gitUrl: pathToFileURL(unitDir).href, baselineRef: baseline }],
      excludedUnits: [],
      deferBranchPush: true,
      workRoot: root,
    });
    const racer = await advanceRemote(ref.gitUrl, "job");
    const result = await runAdvanceJob(
      {
        version: INTEGRATE_JOB_VERSION,
        kind: "advance",
        integration: { repoUrl: ref.gitUrl, defaultBranch: "main" },
        commit: deferred.commit!,
        expectedBase: baseline,
      },
      { workRoot: join(root, "advance-work"), hooks: { phase: async () => {} } },
    );
    expect(result.advanced).toBe(false);
    expect(result.refused).toEqual({ reason: "trunk-moved", expected: baseline, actual: racer });
    expect(await remoteMain(ref.gitUrl)).toBe(racer);
  });
});

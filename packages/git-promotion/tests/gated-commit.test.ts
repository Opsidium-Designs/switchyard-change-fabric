/**
 * Promotion pinned to the GATED commit (gate-equals-deploy at the promote step):
 *   - the promoted tree is read from exactly the gated commit, never a later
 *     integration branch head;
 *   - a gated commit missing from the integration workspace refuses promotion;
 *   - a staged delivery tree that differs from the gated tree (here: a file the
 *     source repo's .gitignore would drop) refuses promotion and leaves no
 *     delivery commit.
 * Real local Git, no network.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalGitDeliveryProvider } from "../src/local-git.ts";

const run = promisify(execFile);
const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@switchyard.local"];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-gated-commit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function commit(dir: string, message: string, force: readonly string[] = []): Promise<string> {
  await run("git", ["-C", dir, "add", "-A"]);
  for (const path of force) {
    await run("git", ["-C", dir, "add", "-f", path]);
  }
  await run("git", ["-C", dir, ...ID, "commit", "--no-verify", "-q", "-m", message]);
  return (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}

/** A source repo and an integration repo that share a baseline commit. */
async function repos(): Promise<{ source: string; integration: string; baseline: string }> {
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await run("git", ["-C", source, "init", "-q", "--initial-branch=main"]);
  await writeFile(join(source, ".gitignore"), "*.log\n");
  await writeFile(join(source, "app.txt"), "broken\n");
  const baseline = await commit(source, "baseline");
  const integration = join(root, "integration");
  await run("git", ["clone", "-q", source, integration]);
  return { source, integration, baseline };
}

const promote = (source: string, integration: string, gatedCommit: string) =>
  new LocalGitDeliveryProvider({ workRoot: root }).promote(
    { changeId: "c", integrationGitUrl: integration, integrationBranch: "main", verdict: "verified", gatedCommit },
    { repoDir: source, startPoint: "main", identity: { name: "P", email: "p@x" } },
  );

describe("promotion of the gated commit", () => {
  it("promotes exactly the gated commit's tree, not a later integration head", async () => {
    const { source, integration } = await repos();
    await writeFile(join(integration, "app.txt"), "fixed\n");
    const gated = await commit(integration, "gated fix");
    await writeFile(join(integration, "app.txt"), "never gated\n");
    await commit(integration, "later, ungated");
    const result = await promote(source, integration, gated);
    expect(result.committed).toBe(true);
    const { stdout } = await run("git", ["-C", source, "show", `${result.commit}:app.txt`]);
    expect(stdout).toBe("fixed\n");
    const promotedTree = (await run("git", ["-C", source, "rev-parse", `${result.commit}^{tree}`])).stdout.trim();
    const gatedTree = (await run("git", ["-C", integration, "rev-parse", `${gated}^{tree}`])).stdout.trim();
    expect(promotedTree).toBe(gatedTree);
  });

  it("refuses a gated commit the integration workspace does not have", async () => {
    const { source, integration } = await repos();
    await expect(promote(source, integration, "f".repeat(40))).rejects.toThrow(/not in the integration workspace/);
  });

  it("refuses (and commits nothing) when the staged tree differs from the gated tree", async () => {
    const { source, integration, baseline } = await repos();
    await writeFile(join(integration, "app.txt"), "fixed\n");
    await writeFile(join(integration, "trace.log"), "tracked in the gated tree\n");
    const gated = await commit(integration, "gated fix with an ignored file", ["trace.log"]);
    await expect(promote(source, integration, gated)).rejects.toThrow(/differs from the gated tree/);
    const head = (await run("git", ["-C", source, "rev-parse", "switchyard/c"])).stdout.trim();
    expect(head).toBe(baseline);
  });
});

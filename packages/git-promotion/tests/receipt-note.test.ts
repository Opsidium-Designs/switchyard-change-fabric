/**
 * The promotion receipt note: after a promotion pinned to the gated commit, a
 * git note is attached to the promoted commit under refs/notes/switchyard.
 *   - the note is on the promoted commit, under its own ref, with the receipt;
 *   - the delivery branch head is still the promoted commit, whose tree is the
 *     gated commit's tree (writing a note changes neither);
 *   - a note that cannot be written leaves the promotion intact and is
 *     reported (`written: false` with the reason), never thrown or swallowed.
 * Real local Git, no network.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalGitDeliveryProvider } from "../src/local-git.ts";
import { RECEIPT_NOTES_REF, writePromotionNote } from "../src/notes.ts";

const run = promisify(execFile);
const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@switchyard.local"];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-receipt-note-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function out(dir: string, args: readonly string[]): Promise<string> {
  return (await run("git", ["-C", dir, ...args])).stdout.trim();
}

/** A source repo, an integration repo with a gated fix, and the promotion of that fix. */
async function promoted(): Promise<{ source: string; gated: string; commit: string; branch: string }> {
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await run("git", ["-C", source, "init", "-q", "--initial-branch=main"]);
  await writeFile(join(source, "app.txt"), "broken\n");
  await run("git", ["-C", source, "add", "-A"]);
  await run("git", ["-C", source, ...ID, "commit", "--no-verify", "-q", "-m", "baseline"]);
  const integration = join(root, "integration");
  await run("git", ["clone", "-q", source, integration]);
  await writeFile(join(integration, "app.txt"), "fixed\n");
  await run("git", ["-C", integration, "add", "-A"]);
  await run("git", ["-C", integration, ...ID, "commit", "--no-verify", "-q", "-m", "fix"]);
  const gated = await out(integration, ["rev-parse", "HEAD"]);
  const result = await new LocalGitDeliveryProvider({ workRoot: root }).promote(
    { changeId: "change-1", integrationGitUrl: integration, integrationBranch: "main", verdict: "verified", gatedCommit: gated, expectedIntegratedUnits: 1 },
    { repoDir: source, startPoint: "main", identity: { name: "P", email: "p@x" } },
  );
  expect(result.committed).toBe(true);
  return { source, gated: (await out(integration, ["rev-parse", `${gated}^{tree}`])), commit: result.commit, branch: result.branch };
}

const RECEIPT = "Switchyard receipt: change change-1, revision 2\n\nGated commit: abc (revision 2)\nPromoted to: switchyard/change-1\n";

describe("the promotion receipt note", () => {
  it("attaches the receipt to the promoted commit under refs/notes/switchyard, leaving the branch on the gated tree", async () => {
    const { source, gated, commit, branch } = await promoted();
    const headBefore = await out(source, ["symbolic-ref", "HEAD"]);

    const record = await writePromotionNote({ repoDir: source, commit, message: RECEIPT, identity: { name: "P", email: "p@x" }, workRoot: root });
    expect(record).toEqual({ ref: RECEIPT_NOTES_REF, commit, written: true });

    // The note is on the promoted commit, under the dedicated ref.
    expect(await out(source, ["notes", "--ref=switchyard", "show", commit])).toBe(RECEIPT.trim());
    expect(await out(source, ["log", "-1", "--notes=switchyard", "--format=%N", branch])).toContain("Switchyard receipt: change change-1, revision 2");
    expect(await out(source, ["rev-parse", "--verify", RECEIPT_NOTES_REF])).toMatch(/^[0-9a-f]{40}$/);
    // The default notes ref is untouched (the receipt lives on its own ref).
    await expect(out(source, ["rev-parse", "--verify", "-q", "refs/notes/commits"])).rejects.toThrow();

    // Gate-equals-deploy still holds: the branch head is the promoted commit,
    // whose tree is the gated tree, and HEAD and the worktree are unchanged.
    expect(await out(source, ["rev-parse", `refs/heads/${branch}`])).toBe(commit);
    expect(await out(source, ["rev-parse", `${commit}^{tree}`])).toBe(gated);
    expect(await out(source, ["symbolic-ref", "HEAD"])).toBe(headBefore);
    expect(await out(source, ["status", "--porcelain"])).toBe("");

    // Writing it again (a re-run on the same commit) replaces the note.
    const again = await writePromotionNote({ repoDir: source, commit, message: `${RECEIPT}Written: later\n`, workRoot: root });
    expect(again.written).toBe(true);
    expect(await out(source, ["notes", "--ref=switchyard", "show", commit])).toContain("Written: later");
  });

  it("a note that cannot be written leaves the promotion intact and is reported, not thrown", async () => {
    const { source, gated, commit, branch } = await promoted();
    // Another writer holds the notes ref's lock: git notes must fail.
    await mkdir(join(source, ".git", "refs", "notes"), { recursive: true });
    await writeFile(join(source, ".git", "refs", "notes", "switchyard.lock"), "");

    const record = await writePromotionNote({ repoDir: source, commit, message: RECEIPT, workRoot: root });
    expect(record.written).toBe(false);
    expect(record.ref).toBe(RECEIPT_NOTES_REF);
    expect(record.commit).toBe(commit);
    expect(record.reason).toMatch(/^git notes failed: /);

    // No note, and the promotion is exactly as it was.
    await expect(out(source, ["rev-parse", "--verify", "-q", RECEIPT_NOTES_REF])).rejects.toThrow();
    expect(await out(source, ["rev-parse", `refs/heads/${branch}`])).toBe(commit);
    expect(await out(source, ["rev-parse", `${commit}^{tree}`])).toBe(gated);
    expect(await out(source, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a malformed commit id or notes ref without running git", async () => {
    const { source, commit } = await promoted();
    expect(await writePromotionNote({ repoDir: source, commit: "--help", message: RECEIPT })).toMatchObject({ written: false, reason: expect.stringMatching(/not a commit id/) });
    expect(await writePromotionNote({ repoDir: source, commit, message: RECEIPT, ref: "refs/heads/main" })).toMatchObject({ written: false, reason: expect.stringMatching(/not a notes ref/) });
    // A commit that is not in the repository is reported too.
    const missing = await writePromotionNote({ repoDir: source, commit: "0".repeat(40), message: RECEIPT, workRoot: root });
    expect(missing).toMatchObject({ written: false, reason: expect.stringMatching(/^git notes failed: /) });
  });
});

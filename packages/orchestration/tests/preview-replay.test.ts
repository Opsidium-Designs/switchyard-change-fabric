/**
 * Backfilling revision previews for a recorded run (offline): the plan from a
 * replay's integrated.rev messages, commit checks and app location against a
 * temp bare integration repo (a failing revision's commit reachable only from
 * a gated ref included), the checkout of a commit's tree, and the backfilled
 * previews written into the replay snapshot with the exporter's serialisation.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  commitExists,
  locateAppInTree,
  parsePreviewReplay,
  previewReplayPlan,
  serializePreviewReplay,
  withBackfilledPreviews,
  wranglerConfigName,
  type PreviewReplayFile,
} from "../src/preview-replay.ts";
import { checkoutIntegratedCommit } from "../src/revision-preview.ts";

const git = promisify(execFile);
const WORKER = "switchyard-change-fabric-storefront";
const WRANGLER = `{\n  // the app's stable worker\n  "$schema": "https://unpkg.com/wrangler/config-schema.json",\n  "name": "${WORKER}", /* stable */\n  "main": "src/index.ts",\n}\n`;

async function sh(cwd: string, ...args: string[]): Promise<string> {
  return (await git("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();
}

/**
 * A bare integration repo like a board run's: the app at the root (as run-board
 * seeds it from an app project dir), r1 on a gated ref only (a failing
 * revision), r2 on main.
 */
async function integrationRepo(): Promise<{ bare: string; r1: string; r2: string }> {
  const root = await mkdtemp(join(tmpdir(), "scf-preview-replay-"));
  const work = join(root, "work");
  const bare = join(root, "board-live-sf21--integration.git");
  await mkdir(work, { recursive: true });
  await git("git", ["init", "-q", "--bare", "--initial-branch=main", bare]);
  await git("git", ["init", "-q", "--initial-branch=main", work]);
  const files: Record<string, string> = { "wrangler.jsonc": WRANGLER, "src/index.ts": "export default 1;\n", "gate/sub/wrangler.jsonc": '{"name":"other"}\n' };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(work, rel)), { recursive: true });
    await writeFile(join(work, rel), body);
  }
  await sh(work, "add", "-A");
  await sh(work, "commit", "-q", "-m", "baseline");
  await sh(work, "push", "-q", bare, "HEAD:main");
  await writeFile(join(work, "src/index.ts"), "export default 2; // r1 (failing)\n");
  await sh(work, "commit", "-q", "-am", "r1");
  const r1 = await sh(work, "rev-parse", "HEAD");
  await sh(work, "push", "-q", bare, `HEAD:refs/switchyard/gated/${r1}`);
  await writeFile(join(work, "src/index.ts"), "export default 3; // r2 (passing)\n");
  await sh(work, "commit", "-q", "-am", "r2");
  const r2 = await sh(work, "rev-parse", "HEAD");
  await sh(work, "push", "-q", bare, "HEAD:main");
  return { bare, r1, r2 };
}

function replay(r1: string, r2: string, snapshot: Record<string, unknown> | null = { id: "board-live-sf21", status: "verified" }): PreviewReplayFile {
  return {
    format: "switchyard-replay/v1",
    changeId: "board-live-sf21",
    messages: [
      { type: "goal.posted", payload: { objective: "x" } },
      { type: "integrated.rev", payload: { n: 2, commit: r2, gate: "pass" } },
      { type: "integrated.rev", payload: { n: 1, commit: r1, gate: "fail" } },
      { type: "integrated.rev", payload: { n: 3, commit: "not-a-sha", gate: "fail" } },
    ],
    snapshot,
  };
}

describe("preview-replay", () => {
  it("plans every recorded revision (fail and pass) in order, with its alias", () => {
    const plan = previewReplayPlan(replay("a".repeat(40), "b".repeat(40)), WORKER);
    expect(plan).toEqual([
      { n: 1, commit: "a".repeat(40), alias: "sf21-r1" },
      { n: 2, commit: "b".repeat(40), alias: "sf21-r2" },
    ]);
  });

  it("parses a replay file and refuses one without a change id or messages", () => {
    expect(parsePreviewReplay(serializePreviewReplay(replay("a".repeat(40), "b".repeat(40)))).changeId).toBe("board-live-sf21");
    expect(() => parsePreviewReplay("{")).toThrow(/not JSON/);
    expect(() => parsePreviewReplay('{"messages":[]}')).toThrow(/no changeId/);
    expect(() => parsePreviewReplay('{"changeId":"x","messages":[],"snapshot":[]}')).toThrow(/snapshot/);
  });

  it("checks commits against the integration repo, gated refs included", async () => {
    const { bare, r1, r2 } = await integrationRepo();
    expect(await commitExists(bare, r1)).toBe(true);
    expect(await commitExists(bare, r2)).toBe(true);
    expect(await commitExists(bare, "0".repeat(40))).toBe(false);
    expect(await commitExists(bare, "--help")).toBe(false);
  });

  it("locates the app by its wrangler name and checks a commit's tree out", async () => {
    const { bare, r1, r2 } = await integrationRepo();
    expect(await locateAppInTree(bare, r1, WORKER)).toBe("");
    await expect(locateAppInTree(bare, r1, "switchyard-change-fabric-service-api")).rejects.toThrow(/declares the Worker/);
    const target = join(await mkdtemp(join(tmpdir(), "scf-preview-tree-")), "tree");
    await checkoutIntegratedCommit({ remote: bare, commit: r1, targetDir: target });
    expect(await readFile(join(target, "src/index.ts"), "utf8")).toContain("r1 (failing)");
    expect((await readdir(target)).includes(".git")).toBe(false);
    const target2 = join(dirname(target), "tree2");
    await checkoutIntegratedCommit({ remote: bare, commit: r2, targetDir: target2 });
    expect(await readFile(join(target2, "src/index.ts"), "utf8")).toContain("r2 (passing)");
  });

  it("reads the worker name from wrangler.jsonc with comments and trailing commas", () => {
    expect(wranglerConfigName(WRANGLER)).toBe(WORKER);
    expect(wranglerConfigName('{"name": "a//b"}')).toBe("a//b");
    expect(wranglerConfigName("not json")).toBeUndefined();
  });

  it("writes backfilled previews into the snapshot (created when null), one per n, sorted, compact JSON", () => {
    const at = "2026-10-13T00:00:00.000Z";
    const base = replay("a".repeat(40), "b".repeat(40), { id: "board-live-sf21", previews: [{ n: 2, commit: "b".repeat(40), url: "https://old.example.workers.dev", alias: "sf21-r2", at }] });
    const next = withBackfilledPreviews(base, [
      { n: 2, commit: "b".repeat(40), url: `https://sf21-r2-${WORKER}.example.workers.dev`, alias: "sf21-r2", at },
      { n: 1, commit: "a".repeat(40), url: `https://sf21-r1-${WORKER}.example.workers.dev`, alias: "sf21-r1", at },
    ]);
    expect(next.messages).toBe(base.messages);
    expect(next.snapshot).toEqual({
      id: "board-live-sf21",
      previews: [
        { n: 1, commit: "a".repeat(40), url: `https://sf21-r1-${WORKER}.example.workers.dev`, alias: "sf21-r1", at, backfilled: true },
        { n: 2, commit: "b".repeat(40), url: `https://sf21-r2-${WORKER}.example.workers.dev`, alias: "sf21-r2", at, backfilled: true },
      ],
    });
    const fromNull = withBackfilledPreviews(replay("a".repeat(40), "b".repeat(40), null), []);
    expect(fromNull.snapshot).toEqual({ previews: [] });
    const text = serializePreviewReplay(next);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(2);
    expect(JSON.parse(text)).toEqual(next);
  });
});

/**
 * Revision previews on a board run (offline, local control, a fake uploader):
 * every integrated revision, failing and passing, gets exactly one preview
 * built from the app tree AT that revision's commit (read back from the
 * integration repo), recorded on the control; an uploader that throws for one
 * revision costs only that revision's preview (the run, its verdict, and its
 * promotion are unchanged: previews are advisory); and a run without the
 * option uploads nothing.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { FirstAttemptFailingGate, runBoardOffline } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, type BoardRunEvent, type BoardSeed, type RunBoardResult } from "../src/run-board.ts";
import type { PreviewUploader } from "../src/revision-preview.ts";

const git = promisify(execFile);
const GOAL = "Make every module report its status";
const WORKER = "switchyard-change-fabric-demo";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-previews-project-"));
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p","scripts":{}}\n',
    "wrangler.jsonc": `{ "name": "${WORKER}", "main": "src/index.ts" }\n`,
    "src/index.ts": "export * from './core/a';\n",
    "src/core/a.ts": "export const a = 1;\n",
    "src/api/handler.ts": "export const handler = () => 1;\n",
  })) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

const seed = async (): Promise<BoardSeed> => ({
  source: "planner",
  model: "fake-planner",
  items: [
    { item: "core", objective: "report status from core", acceptance: ["gate passes"], scopeHint: ["src/core/**"] },
    { item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
  ],
});

/** A fake uploader that snapshots every source file of the app dir it is given. */
function fakeUploader(failFor?: number): { upload: PreviewUploader; uploads: { alias: string; appName: string; files: Record<string, string> }[] } {
  const uploads: { alias: string; appName: string; files: Record<string, string> }[] = [];
  const upload: PreviewUploader = async ({ appDir, appName, alias }) => {
    const files: Record<string, string> = {};
    for (const rel of ["wrangler.jsonc", "src/index.ts", "src/core/a.ts", "src/api/handler.ts"]) {
      files[rel] = await readFile(join(appDir, rel), "utf8");
    }
    uploads.push({ alias, appName, files });
    if (failFor !== undefined && alias.endsWith(`-r${failFor}`)) {
      throw new Error("wrangler: the Worker does not exist yet");
    }
    return { url: `https://${alias}-${appName}.example.workers.dev` };
  };
  return { upload, uploads };
}

async function run(options: { previewRevision?: PreviewUploader; previewMode?: "every" | "passing"; gate: FirstAttemptFailingGate; events: BoardRunEvent[] }): Promise<RunBoardResult> {
  const projectDir = await project();
  return runBoardOffline({
    goal: GOAL,
    projectDir,
    changeId: "board-previews-pv7",
    seed,
    appGateCommand: ["gate"],
    verifyCommandRunner: options.gate,
    resolveContract: async () => "reject",
    budgets: { maxFixAttemptsPerItem: 1 },
    deployAppDir: projectDir,
    deployAppName: WORKER,
    ...(options.previewRevision ? { previewRevision: options.previewRevision } : {}),
    ...(options.previewMode ? { previewMode: options.previewMode } : {}),
    onEvent: (e) => options.events.push(e),
  });
}

/** The file's content at a commit of the run's integration repo. */
async function atCommit(result: RunBoardResult, commit: string, rel: string): Promise<string> {
  const root = join(result.workRoot, "integration-artifacts");
  const repo = (await readdir(root)).find((d) => d.endsWith(".git"))!;
  return (await git("git", ["-C", join(root, repo), "show", `${commit}:${rel}`])).stdout;
}

describe("revision previews on a board run (advisory)", () => {
  it("previews every revision, fail and pass, from the tree at its commit, and records each", async () => {
    const gate = new FirstAttemptFailingGate();
    const events: BoardRunEvent[] = [];
    const { upload, uploads } = fakeUploader();
    const result = await run({ previewRevision: upload, gate, events });

    expect(result.revisions.length).toBeGreaterThanOrEqual(2);
    expect(result.revisions[0]!.gate).toBe("fail");
    expect(result.revision!.gate).toBe("pass");
    expect(result.verdict).toBe("verified");

    // Exactly one preview per revision, with that revision's n and commit.
    expect(result.previews!.map((p) => [p.n, p.commit])).toEqual(result.revisions.map((r) => [r.n, r.commit]));
    expect(result.previews!.map((p) => p.alias)).toEqual(result.revisions.map((r) => `pv7-r${r.n}`));
    expect(result.previews!.every((p) => p.url === `https://${p.alias}-${WORKER}.example.workers.dev` && p.backfilled === undefined)).toBe(true);
    expect(uploads.map((u) => u.alias)).toEqual(result.revisions.map((r) => `pv7-r${r.n}`));
    expect(uploads.every((u) => u.appName === WORKER)).toBe(true);

    // The uploaded app dir is the tree AT each revision's commit: the file the
    // first revision failed on differs between the failing and the passing one.
    const failedFile = gate.runs.find((r) => r.file !== undefined)!.file!;
    const first = uploads[0]!.files[failedFile]!;
    const last = uploads.at(-1)!.files[failedFile]!;
    expect(first).not.toBe(last);
    for (const [i, rev] of result.revisions.entries()) {
      for (const [rel, content] of Object.entries(uploads[i]!.files)) {
        expect(content, `${rel} at rev ${rev.n}`).toBe(await atCommit(result, rev.commit, rel));
      }
    }

    // Recorded (no record failure), reported as events and in the summary.
    const previewed = events.filter((e) => e.kind === "revision-previewed");
    expect(previewed.map((e) => (e.kind === "revision-previewed" ? [e.n, e.unrecorded] : []))).toEqual(result.revisions.map((r) => [r.n, undefined]));
    const summary = formatBoardRunSummary(result);
    for (const p of result.previews!) {
      expect(summary).toContain(`  preview r${p.n}: ${p.url}`);
    }
    // Temp trees are removed.
    expect(await readdir(join(result.workRoot, "previews"))).toEqual([]);
  });

  it("an uploader that throws for one revision costs only that preview; the run is unchanged", async () => {
    const events: BoardRunEvent[] = [];
    const { upload, uploads } = fakeUploader(1);
    const result = await run({ previewRevision: upload, gate: new FirstAttemptFailingGate(), events });
    expect(result.verdict).toBe("verified");
    expect(result.promotion).toMatchObject({ committed: true });
    expect(uploads.length).toBe(result.revisions.length);
    expect(result.previews!.map((p) => p.n)).toEqual(result.revisions.filter((r) => r.n !== 1).map((r) => r.n));
    expect(events).toContainEqual({ kind: "revision-preview-skipped", n: 1, reason: "wrangler: the Worker does not exist yet" });
    expect(formatBoardRunSummary(result)).toContain("  no preview for revision(s) 1 (advisory; see the run's preview events)");
  });

  it("passing mode uploads only gated passing revisions, all under one fixed alias, from the passing tree", async () => {
    const events: BoardRunEvent[] = [];
    const { upload, uploads } = fakeUploader();
    const gate = new FirstAttemptFailingGate();
    const result = await run({ previewRevision: upload, previewMode: "passing", gate, events });
    expect(result.verdict).toBe("verified");
    const passing = result.revisions.filter((r) => r.gate === "pass" && r.gated);
    expect(passing.length).toBeGreaterThanOrEqual(1);
    expect(result.revisions.some((r) => r.gate === "fail")).toBe(true);
    // Failing revisions are never uploaded; every upload uses the one alias.
    expect(uploads.map((u) => u.alias)).toEqual(passing.map(() => "fixed-pv7"));
    expect(result.previewMode).toBe("passing");
    expect(result.previews!.map((p) => [p.n, p.commit, p.alias])).toEqual(passing.map((r) => [r.n, r.commit, "fixed-pv7"]));
    // The uploaded tree is the passing revision's own tree.
    const last = passing.at(-1)!;
    for (const [rel, content] of Object.entries(uploads.at(-1)!.files)) {
      expect(content, rel).toBe(await atCommit(result, last.commit, rel));
    }
    const summary = formatBoardRunSummary(result);
    expect(summary).toContain(`  fixed preview r${last.n}: https://fixed-pv7-${WORKER}.example.workers.dev`);
    expect(summary).not.toContain("no preview for revision");
  });

  it("uploads nothing without the option", async () => {
    const events: BoardRunEvent[] = [];
    const result = await run({ gate: new FirstAttemptFailingGate(), events });
    expect(result.verdict).toBe("verified");
    expect(result.previews).toBeUndefined();
    expect(events.some((e) => e.kind === "revision-previewed" || e.kind === "revision-preview-skipped")).toBe(false);
    expect(formatBoardRunSummary(result)).not.toContain("preview r");
  });
});

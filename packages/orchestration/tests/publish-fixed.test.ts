/**
 * publish-fixed (offline): the promoted commit of a VERIFIED live run is
 * uploaded as a preview version of the app's stable Worker under one alias,
 * fixed-<change tag>, from the commit's own tree. Refused, before any upload,
 * when the run is not verified by a gate that ran, when the commit is not the
 * promoted branch's tip, when a board run's recorded promotion names another
 * commit, or when the app is not deployed. A fake fetch stands in for the
 * Worker and a fake uploader for wrangler: no network.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runPublishFixed } from "../src/publish-fixed.ts";
import type { PreviewUploader } from "../src/revision-preview.ts";

const git = promisify(execFile);
const APP = "storefront";
const WORKER = "switchyard-change-fabric-storefront";
const CHANGE = "console-storefront-mg3x1abcde";

async function sh(cwd: string, ...args: string[]): Promise<string> {
  return (await git("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), body);
  }
}

/** A promoted repo: the original, then the fixed commit on the promoted branch. */
async function promotedRepo(): Promise<{ dir: string; broken: string; fixed: string; branch: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scf-publish-repo-"));
  await sh(dir, "init", "-q", "-b", "main");
  await writeFiles(dir, { "wrangler.jsonc": `{ "name": "${WORKER}", "main": "src/index.ts" }\n`, "src/index.ts": "export const ok = false;\n" });
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "original");
  const broken = await sh(dir, "rev-parse", "HEAD");
  await sh(dir, "checkout", "-q", "-b", "switchyard/fix");
  await writeFiles(dir, { "src/index.ts": "export const ok = true;\n" });
  await sh(dir, "commit", "-q", "-am", "fixed");
  const fixed = await sh(dir, "rev-parse", "HEAD");
  return { dir, broken, fixed, branch: "switchyard/fix" };
}

/** A fabric root with (or without) the app's deployment marker. */
async function fabricRoot(deployed: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scf-publish-root-"));
  if (deployed) {
    await writeFiles(root, { [`.deployments/${APP}.json`]: JSON.stringify({ app: APP, workerName: WORKER, url: `https://${WORKER}.example.workers.dev` }) });
  }
  return root;
}

/** A fake Worker: the snapshot, and the board (404 when none). */
function fakeWorker(snapshot: unknown, board?: unknown[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/board\?/.test(url)) {
      return board === undefined
        ? new Response(JSON.stringify({ error: "no board" }), { status: 404 })
        : new Response(JSON.stringify({ messages: board, hasMore: false, lastSeq: board.length }), { status: 200 });
    }
    return new Response(JSON.stringify(snapshot), { status: 200 });
  }) as typeof fetch;
}

function fakeUpload(): { upload: PreviewUploader; uploads: { alias: string; appName: string; index: string }[] } {
  const uploads: { alias: string; appName: string; index: string }[] = [];
  const upload: PreviewUploader = async ({ appDir, appName, alias }) => {
    uploads.push({ alias, appName, index: await readFile(join(appDir, "src/index.ts"), "utf8") });
    return { url: `https://${alias}-${appName}.example.workers.dev` };
  };
  return { upload, uploads };
}

const VERIFIED = { id: CHANGE, integration: { verdict: "verified", integratedUnits: [], excludedUnits: [] } };

async function publish(over: { snapshot?: unknown; board?: unknown[]; deployed?: boolean; commit?: (r: { fixed: string; broken: string }) => string; dryRun?: boolean }) {
  const repo = await promotedRepo();
  const { upload, uploads } = fakeUpload();
  const lines: string[] = [];
  const run = runPublishFixed({
    repoRoot: await fabricRoot(over.deployed ?? true),
    workerUrl: "http://127.0.0.1:8787",
    changeId: CHANGE,
    app: APP,
    repoDir: repo.dir,
    commit: over.commit ? over.commit(repo) : repo.fixed.slice(0, 10),
    branch: repo.branch,
    dryRun: over.dryRun ?? false,
    fetchFn: fakeWorker(over.snapshot ?? VERIFIED, over.board),
    upload,
    log: (line) => lines.push(line),
  });
  return { run, uploads, lines, repo };
}

describe("publish-fixed", () => {
  it("uploads a verified run-live run's promoted commit (the branch tip) under fixed-<tag>", async () => {
    const { run, uploads, lines, repo } = await publish({});
    const result = await run;
    expect(result.alias).toBe("fixed-mg3x1abcde");
    expect(result.commit).toBe(repo.fixed);
    expect(result.url).toBe(`https://fixed-mg3x1abcde-${WORKER}.example.workers.dev`);
    expect(uploads).toEqual([{ alias: "fixed-mg3x1abcde", appName: WORKER, index: "export const ok = true;\n" }]);
    expect(lines).toContain(`  fixed version: ${result.url}`);
  });

  it("a dry run checks everything and uploads nothing", async () => {
    const { run, uploads } = await publish({ dryRun: true });
    expect((await run).url).toBeUndefined();
    expect(uploads).toEqual([]);
  });

  it("refuses a run that is not verified, or verified with no gate", async () => {
    for (const snapshot of [
      { id: CHANGE, integration: null },
      { id: CHANGE, integration: { verdict: "failed", integratedUnits: [], excludedUnits: [] } },
      { id: CHANGE, integration: { verdict: "verified", gated: false, integratedUnits: [], excludedUnits: [] } },
    ]) {
      const { run, uploads } = await publish({ snapshot });
      await expect(run).rejects.toThrow(/not verified by a gate that ran/);
      expect(uploads).toEqual([]);
    }
  });

  it("refuses a commit that is not the promoted branch's tip", async () => {
    const { run, uploads } = await publish({ commit: (r) => r.broken });
    await expect(run).rejects.toThrow(/not the tip of the promoted branch/);
    expect(uploads).toEqual([]);
  });

  it("refuses when the app is not deployed (the version needs its Worker)", async () => {
    const { run, uploads } = await publish({ deployed: false });
    await expect(run).rejects.toThrow(/not deployed/);
    expect(uploads).toEqual([]);
  });

  it("a board run: the recorded promotion must name the commit and hold the gated tree", async () => {
    const repo = await promotedRepo();
    const board = (promoted: string) => [
      { seq: 1, type: "integrated.rev", from: "integrator", payload: { n: 2, gate: "pass", gated: true, commit: "a".repeat(40) } },
      { seq: 2, type: "revision.promoted", from: "integrator", payload: { rev: 2, commit: promoted } },
    ];
    const ok = fakeUpload();
    const result = await runPublishFixed({
      repoRoot: await fabricRoot(true),
      workerUrl: "http://w",
      changeId: CHANGE,
      app: APP,
      repoDir: repo.dir,
      commit: repo.fixed.slice(0, 12),
      branch: repo.branch,
      dryRun: false,
      fetchFn: fakeWorker(VERIFIED, board(repo.fixed)),
      upload: ok.upload,
      log: () => undefined,
    });
    expect(result.url).toBe(`https://fixed-mg3x1abcde-${WORKER}.example.workers.dev`);

    const refused = fakeUpload();
    await expect(
      runPublishFixed({
        repoRoot: await fabricRoot(true),
        workerUrl: "http://w",
        changeId: CHANGE,
        app: APP,
        repoDir: repo.dir,
        commit: repo.fixed.slice(0, 12),
        branch: repo.branch,
        dryRun: false,
        fetchFn: fakeWorker(VERIFIED, board("b".repeat(40))),
        upload: refused.upload,
        log: () => undefined,
      }),
    ).rejects.toThrow(/records the promotion of bbbbbbbbbbbb/);
    expect(refused.uploads).toEqual([]);
  });
});

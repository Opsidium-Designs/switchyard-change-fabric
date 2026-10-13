/**
 * Revision previews, the pure parts and the serial queue (offline):
 *   - the preview alias: the Change id's last meaningful part plus `-r<n>`,
 *     [a-z0-9-] only, fitting one 63-character hostname label with the worker;
 *   - the alias URL parsed from realistic `wrangler versions upload` output;
 *   - the queue: one upload at a time, failures reported and swallowed, a
 *     record failure reported without losing the preview, temp trees removed,
 *     and a bounded drain that drops what did not finish.
 */
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appPathInProject,
  createRevisionPreviewer,
  isWorkersDevUrl,
  parsePreviewAliasUrl,
  previewAlias,
  type RevisionPreview,
  type RevisionPreviewEvent,
} from "../src/revision-preview.ts";

const WORKER = "switchyard-change-fabric-storefront";

describe("previewAlias", () => {
  it("uses the last meaningful part of the Change id", () => {
    expect(previewAlias("board-live-sf21", 3, WORKER)).toBe("sf21-r3");
    expect(previewAlias("Board-Live-SF_21", 1, WORKER)).toBe("sf21-r1");
    expect(previewAlias("board-live-sf21-", 2, WORKER)).toBe("sf21-r2");
    expect(previewAlias("change-board-m3x9a", 12, WORKER)).toBe("m3x9a-r12");
  });

  it("starts with a letter and falls back to a stable hash when nothing is left", () => {
    expect(previewAlias("run-42", 1, WORKER)).toBe("c42-r1");
    const hashed = previewAlias("---", 1, WORKER);
    expect(hashed).toMatch(/^c[0-9a-z]{7}-r1$/);
    expect(previewAlias("---", 1, WORKER)).toBe(hashed);
    expect(previewAlias("___", 1, WORKER)).not.toBe(hashed);
  });

  it("truncates the tag so alias-worker fits a 63-character label (and the alias fits 40)", () => {
    const long = `board-${"x".repeat(80)}`;
    const alias = previewAlias(long, 7, WORKER);
    expect(`${alias}-${WORKER}`.length).toBeLessThanOrEqual(63);
    expect(alias.endsWith("-r7")).toBe(true);
    expect(alias).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(previewAlias(long, 7, "w").length).toBeLessThanOrEqual(40);
    expect(() => previewAlias("board-sf21", 1, "w".repeat(60))).toThrow(/too long/);
    expect(() => previewAlias("board-sf21", 0, WORKER)).toThrow(/positive integer/);
  });
});

describe("parsePreviewAliasUrl", () => {
  const output = [
    " ⛅️ wrangler 4.149.0",
    "───────────────────",
    "Total Upload: 12.34 KiB / gzip: 3.21 KiB",
    "Worker Startup Time: 4 ms",
    "Uploaded switchyard-change-fabric-storefront (2.10 sec)",
    "Worker Version ID: 0d9c1f2e-1111-2222-3333-444455556666",
    "Version Preview URL: https://0d9c1f2e-switchyard-change-fabric-storefront.example.workers.dev",
    "Version Preview Alias URL: https://sf21-r3-switchyard-change-fabric-storefront.example.workers.dev",
    "",
  ].join("\n");

  it("prefers the alias URL line", () => {
    expect(parsePreviewAliasUrl(output, "sf21-r3")).toBe("https://sf21-r3-switchyard-change-fabric-storefront.example.workers.dev");
  });

  it("falls back to any workers.dev URL whose host starts with the alias", () => {
    const plain = "Uploaded.\nPreview: https://sf21-r3-switchyard-change-fabric-storefront.example.workers.dev.\n";
    expect(parsePreviewAliasUrl(plain, "sf21-r3")).toBe("https://sf21-r3-switchyard-change-fabric-storefront.example.workers.dev");
  });

  it("finds nothing when no URL for the alias is printed", () => {
    expect(parsePreviewAliasUrl(output, "sf21-r4")).toBeUndefined();
    expect(parsePreviewAliasUrl("Version Preview Alias URL: https://sf21-r3-x.example.com", "sf21-r3")).toBeUndefined();
    expect(parsePreviewAliasUrl("", "sf21-r3")).toBeUndefined();
  });

  it("isWorkersDevUrl accepts only https workers.dev hosts", () => {
    expect(isWorkersDevUrl("https://a-b.example.workers.dev")).toBe(true);
    expect(isWorkersDevUrl("http://a-b.example.workers.dev")).toBe(false);
    expect(isWorkersDevUrl("https://workers.dev.example.com")).toBe(false);
    expect(isWorkersDevUrl("nope")).toBe(false);
  });
});

describe("appPathInProject", () => {
  it("is the app's position in the project, and refuses an app outside it", () => {
    expect(appPathInProject("/repo/examples/apps/storefront", "/repo/examples/apps/storefront")).toBe("");
    expect(appPathInProject("/repo", "/repo/examples/apps/storefront")).toBe(join("examples", "apps", "storefront"));
    expect(() => appPathInProject("/repo/examples/apps/storefront", "/repo/examples/apps/service-api")).toThrow(/outside the project/);
  });
});

describe("createRevisionPreviewer", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "scf-preview-"));
    const project = join(root, "project");
    await mkdir(join(project, "app"), { recursive: true });
    return { root, project, app: join(project, "app") };
  }

  /** Materialise a fake tree: app/rev.txt holds the commit. */
  const materialise = async (commit: string, target: string): Promise<void> => {
    await mkdir(join(target, "app"), { recursive: true });
    await writeFile(join(target, "app", "rev.txt"), commit);
  };

  it("uploads one at a time, records each, reports failures, and removes its temp trees", async () => {
    const { root, project, app } = await setup();
    const events: RevisionPreviewEvent[] = [];
    const recorded: RevisionPreview[] = [];
    let active = 0;
    let maxActive = 0;
    const seen: { alias: string; content: string }[] = [];
    const { readFile } = await import("node:fs/promises");
    const previewer = createRevisionPreviewer({
      changeId: "board-live-sf21",
      appName: WORKER,
      projectDir: project,
      deployAppDir: app,
      workRoot: root,
      materialise,
      upload: async ({ appDir, alias }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        seen.push({ alias, content: await readFile(join(appDir, "rev.txt"), "utf8") });
        if (alias === "sf21-r2") {
          throw new Error("wrangler: Worker not found");
        }
        return { url: `https://${alias}-${WORKER}.example.workers.dev` };
      },
      record: async (p) => {
        if (p.n === 3) {
          throw new Error("the Worker was unreachable");
        }
        recorded.push(p);
      },
      emit: (e) => events.push(e),
      now: () => new Date("2026-10-13T00:00:00.000Z"),
    });
    previewer.enqueue(1, "a".repeat(40));
    previewer.enqueue(2, "b".repeat(40));
    previewer.enqueue(3, "c".repeat(40));
    const previews = await previewer.drain(10_000);
    expect(maxActive).toBe(1);
    expect(seen).toEqual([
      { alias: "sf21-r1", content: "a".repeat(40) },
      { alias: "sf21-r2", content: "b".repeat(40) },
      { alias: "sf21-r3", content: "c".repeat(40) },
    ]);
    expect(previews.map((p) => p.n)).toEqual([1, 3]);
    expect(previews[0]).toEqual({ n: 1, commit: "a".repeat(40), alias: "sf21-r1", url: `https://sf21-r1-${WORKER}.example.workers.dev`, at: "2026-10-13T00:00:00.000Z" });
    expect(recorded.map((p) => p.n)).toEqual([1]);
    expect(events).toEqual([
      { kind: "revision-previewed", n: 1, url: `https://sf21-r1-${WORKER}.example.workers.dev`, alias: "sf21-r1", commit: "a".repeat(40) },
      { kind: "revision-preview-skipped", n: 2, reason: "wrangler: Worker not found" },
      { kind: "revision-previewed", n: 3, url: `https://sf21-r3-${WORKER}.example.workers.dev`, alias: "sf21-r3", commit: "c".repeat(40), unrecorded: "the Worker was unreachable" },
    ]);
    expect(await readdir(join(root, "previews"))).toEqual([]);
    // Closed after the drain: a late revision is reported, not uploaded.
    previewer.enqueue(4, "d".repeat(40));
    expect(events.at(-1)).toEqual({ kind: "revision-preview-skipped", n: 4, reason: "the run had already finished its previews" });
  });

  it("refuses a non-workers.dev URL and an app outside the project", async () => {
    const { root, project } = await setup();
    const events: RevisionPreviewEvent[] = [];
    const bad = createRevisionPreviewer({
      changeId: "c-x1",
      appName: WORKER,
      projectDir: project,
      deployAppDir: join(project, "app"),
      workRoot: root,
      materialise,
      upload: async () => ({ url: "https://example.com/" }),
      record: async () => undefined,
      emit: (e) => events.push(e),
    });
    bad.enqueue(1, "a".repeat(40));
    expect(await bad.drain(10_000)).toEqual([]);
    const outside = createRevisionPreviewer({
      changeId: "c-x1",
      appName: WORKER,
      projectDir: join(project, "app"),
      deployAppDir: project,
      workRoot: root,
      materialise,
      upload: async ({ alias }) => ({ url: `https://${alias}-${WORKER}.example.workers.dev` }),
      record: async () => undefined,
      emit: (e) => events.push(e),
    });
    outside.enqueue(1, "a".repeat(40));
    expect(await outside.drain(10_000)).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["revision-preview-skipped", "revision-preview-skipped"]);
    expect(events[0]).toMatchObject({ reason: expect.stringMatching(/not an https workers\.dev URL/) });
    expect(events[1]).toMatchObject({ reason: expect.stringMatching(/outside the project/) });
  });

  it("drains within its bound: what did not finish is reported and never recorded", async () => {
    const { root, project, app } = await setup();
    const events: RevisionPreviewEvent[] = [];
    const recorded: number[] = [];
    let release: () => void = () => undefined;
    const previewer = createRevisionPreviewer({
      changeId: "board-live-sf21",
      appName: WORKER,
      projectDir: project,
      deployAppDir: app,
      workRoot: root,
      materialise,
      upload: async ({ alias }) => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { url: `https://${alias}-${WORKER}.example.workers.dev` };
      },
      record: async (p) => void recorded.push(p.n),
      emit: (e) => events.push(e),
    });
    previewer.enqueue(1, "a".repeat(40));
    previewer.enqueue(2, "b".repeat(40));
    expect(await previewer.drain(20)).toEqual([]);
    expect(events).toEqual([
      { kind: "revision-preview-skipped", n: 1, reason: "the upload did not finish within 20 ms of the run's end" },
      { kind: "revision-preview-skipped", n: 2, reason: "the run ended before its upload started" },
    ]);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(recorded).toEqual([]);
    expect(previewer.previews).toEqual([]);
    expect(events).toHaveLength(2);
  });
});

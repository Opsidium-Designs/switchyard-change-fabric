/**
 * Revision previews: a link to the running app at a revision appears only when
 * the log's integrated.rev of that number names the same commit, only once the
 * cursor has reached that revision, and only for a well-formed https
 * workers.dev URL. The replay export keeps well-formed previews and still drops
 * the production deployment record.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { buildReplayFile } from "../scripts/replay-export.ts";
import { MissionControl } from "../src/mission-control.tsx";
import { backedPreviews, readPreviews, type RevisionPreview } from "../src/previews.ts";

const log = (JSON.parse(readFileSync(new URL("../public/replays/board-live-sf21.json", import.meta.url), "utf8")) as { messages: BoardMessage[] }).messages;
const revs = log.filter((m): m is Extract<BoardMessage, { type: "integrated.rev" }> => m.type === "integrated.rev");

function preview(n: number, commit: string, extra: Partial<RevisionPreview> = {}): RevisionPreview {
  return { n, commit, url: `https://sf21-r${n}-switchyard-change-fabric-storefront.example.workers.dev`, alias: `sf21-r${n}`, at: "2026-10-13T12:00:00.000Z", ...extra };
}

const good = revs.map((m) => preview(m.payload.n, m.payload.commit, { backfilled: true }));

function render(seq: number, previews: readonly RevisionPreview[], rev?: number): string {
  return renderToStaticMarkup(
    createElement(MissionControl, {
      log,
      escalations: [],
      busy: false,
      onResolve: () => undefined,
      recorded: true,
      initialSeq: seq,
      previews,
      ...(rev !== undefined ? { initialSelection: { kind: "node" as const, id: `rev:${rev}` }, initialTab: "node" as const } : {}),
    }),
  );
}

describe("revision previews", () => {
  it("reads only well-formed previews: https workers.dev, no credentials, a hex commit", () => {
    const c = revs[0]!.payload.commit;
    const read = readPreviews({
      previews: [
        preview(1, c),
        { ...preview(2, c), url: "http://sf21-r2-x.example.workers.dev" },
        { ...preview(3, c), url: "https://evil.example.com/sf21-r3" },
        { ...preview(4, c), url: "https://user:secret@sf21-r4-x.example.workers.dev" },
        { ...preview(5, c), commit: "not-a-commit" },
        { ...preview(6, c), n: 0 },
        "junk",
      ],
    });
    expect(read.map((p) => p.n)).toEqual([1]);
    expect(readPreviews(null)).toEqual([]);
    expect(readPreviews({ previews: "nope" })).toEqual([]);
  });

  it("keeps a preview only when its commit is the log's commit for that revision", () => {
    const wrongCommit = preview(2, revs[0]!.payload.commit);
    const unknownRev = preview(99, revs[0]!.payload.commit);
    const backed = backedPreviews(log, [...good.filter((p) => p.n !== 2), wrongCommit, unknownRev]);
    expect([...backed.keys()].sort()).toEqual([1, 3, 4, 5, 6]);
  });

  it("links the narrator, the STORY strip, and the revision detail to the running app, once the cursor reaches it", () => {
    const r2 = revs[1]!;
    const at = render(r2.seq, good);
    expect(at).toContain('aria-label="open the app at revision 2 (FAIL)"');
    expect(at).toContain(">open the app at r2 ↗<");
    expect(at).toContain('href="https://sf21-r2-switchyard-change-fabric-storefront.example.workers.dev"');
    expect(at).toContain('rel="noopener noreferrer"');
    // A later revision's link is not shown before the cursor reaches it.
    expect(at).not.toContain('aria-label="open the app at revision 6');
    expect(at).not.toContain("sf21-r6");

    const end = render(log.at(-1)!.seq, good, 6);
    expect(end).toContain('aria-label="open the app at revision 6 (PASS)"');
    expect(end).toContain("Running app");
    expect(end).toContain("uploaded after the run");
  });

  it("shows no link without previews, or when a preview's commit does not match", () => {
    const r2 = revs[1]!;
    expect(render(r2.seq, [])).not.toContain("mc-preview-link");
    expect(render(r2.seq, [preview(2, revs[0]!.payload.commit)])).not.toContain("mc-preview-link");
  });

  it("the replay export keeps well-formed previews and still drops the production deployment", () => {
    const file = buildReplayFile({
      changeId: "board-live-sf21",
      messages: log,
      snapshot: {
        id: "board-live-sf21",
        status: "verified",
        deployment: { url: "https://app.someone.workers.dev" },
        previews: [good[0], { ...good[1], url: "https://elsewhere.example.com/" }],
      },
    });
    expect(file.snapshot?.deployment).toBeUndefined();
    expect(file.snapshot?.previews).toEqual([good[0]]);
  });
});

/**
 * "Try the app" on the replay page (offline): the index's `apps` links are
 * validated like revision previews (https workers.dev, no credentials; a fixed
 * link must name its own run and a commit), the app's landing hash is added,
 * and the run header and picker card render the original and fixed links in
 * new tabs, only the original when there is no fixed one, and nothing when
 * the run has no links. Rendered with react-dom/server; no browser, no network.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunPicker, TryTheApp } from "../src/ReplayApp.tsx";
import { loadReplayIndex, readShowcaseApps, SHOWCASE_NOTE, showcaseHref, type ReplayIndexEntry } from "../src/replay-data.ts";

const BEFORE = { url: "https://before-switchyard-showcase-storefront.example.workers.dev", commit: "9e08df1db02a404395c0b16795f112d8762ed1f2" };
const AFTER = { url: "https://after-sf21-r6-switchyard-showcase-storefront.example.workers.dev", commit: "15d7d40565c8df381bfacecbf8a8333da0ab3dbb", run: "board-live-sf21", rev: 6 };

function entry(over: Partial<ReplayIndexEntry> = {}): ReplayIndexEntry {
  return { id: "board-live-sf21", title: "Storefront", app: "storefront", outcome: "verified", description: "d", messages: 1, ...over };
}

describe("readShowcaseApps", () => {
  it("keeps well-formed links", () => {
    expect(readShowcaseApps({ before: BEFORE, after: AFTER }, "board-live-sf21")).toEqual({ before: BEFORE, after: AFTER });
    expect(readShowcaseApps({ before: { url: BEFORE.url, commit: "original" } }, "board-live-sf7")).toEqual({ before: { url: BEFORE.url, commit: "original" } });
  });

  it("drops a link that is not a credential-free https workers.dev URL", () => {
    expect(readShowcaseApps({ before: { ...BEFORE, url: "http://before-x.example.workers.dev" } }, "x")).toBeUndefined();
    expect(readShowcaseApps({ before: { ...BEFORE, url: "https://user:pw@before-x.example.workers.dev" } }, "x")).toBeUndefined();
    expect(readShowcaseApps({ before: { ...BEFORE, url: "https://before-x.example.workers.dev.evil.com" } }, "x")).toBeUndefined();
    expect(readShowcaseApps({ before: { ...BEFORE, url: "javascript:alert(1)" } }, "x")).toBeUndefined();
    expect(readShowcaseApps({ before: BEFORE, after: { ...AFTER, url: "https://evil.example.com" } }, "board-live-sf21")).toEqual({ before: BEFORE });
  });

  it("drops a fixed link that names another run or no commit", () => {
    expect(readShowcaseApps({ before: BEFORE, after: AFTER }, "board-live-sf7")).toEqual({ before: BEFORE });
    expect(readShowcaseApps({ before: BEFORE, after: { ...AFTER, commit: "original" } }, "board-live-sf21")).toEqual({ before: BEFORE });
    const { rev: _rev, ...noRev } = AFTER;
    expect(readShowcaseApps({ after: { ...noRev, rev: -1 } }, "board-live-sf21")).toEqual({ after: noRev });
    expect(readShowcaseApps(null, "x")).toBeUndefined();
    expect(readShowcaseApps("https://x.workers.dev", "x")).toBeUndefined();
  });

  it("loadReplayIndex keeps only validated links", async () => {
    const body = {
      runs: [
        { ...entry(), apps: { before: BEFORE, after: AFTER } },
        { ...entry({ id: "board-live-sf7", outcome: "failed" }), apps: { before: BEFORE, after: AFTER } },
        { ...entry({ id: "board-live-sf8", outcome: "failed" }), apps: { before: { url: "http://nope", commit: "original" } } },
      ],
    };
    const runs = await loadReplayIndex(async () => new Response(JSON.stringify(body), { status: 200 }));
    expect(runs[0]!.apps).toEqual({ before: BEFORE, after: AFTER });
    expect(runs[1]!.apps).toEqual({ before: BEFORE });
    expect(runs[2]!.apps).toBeUndefined();
    expect("apps" in runs[2]!).toBe(false);
  });

  it("adds the app's landing hash", () => {
    expect(showcaseHref(BEFORE.url, "storefront")).toBe(`${BEFORE.url}#run-checks`);
    expect(showcaseHref(BEFORE.url, "service-api")).toBe(BEFORE.url);
  });
});

describe("TryTheApp", () => {
  it("shows both versions, each in a new tab, with the revision and what to try", () => {
    const html = renderToStaticMarkup(createElement(TryTheApp, { entry: entry({ apps: { before: BEFORE, after: AFTER } }) }));
    expect(html).toContain("Try the app");
    expect(html).toContain("Original (before the run) ↗");
    expect(html).toContain("Fixed by this run (revision 6) ↗");
    expect(html).toContain(`href="${BEFORE.url}#run-checks"`);
    expect(html).toContain(`href="${AFTER.url}#run-checks"`);
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(html).toContain("1 of 16");
    expect(html).toContain(SHOWCASE_NOTE);
    expect(html).toContain("commit 15d7d40565");
  });

  it("shows only the original when there is no fixed version", () => {
    const failed = renderToStaticMarkup(createElement(TryTheApp, { entry: entry({ id: "board-live-sf7", outcome: "failed", apps: { before: BEFORE } }) }));
    expect(failed).toContain("Original (before the run)");
    expect(failed).not.toContain("Fixed by this run");
    expect(failed).toContain("this run promoted nothing");
    const verified = renderToStaticMarkup(createElement(TryTheApp, { entry: entry({ id: "board-live-reg3", app: "service-api", apps: { before: BEFORE } }) }));
    expect(verified).toContain("No fixed version is published for this run.");
    expect(verified).toContain("6 of 18");
  });

  it("never shows a fixed link recorded for another run", () => {
    const html = renderToStaticMarkup(createElement(TryTheApp, { entry: entry({ id: "board-live-l3", apps: { before: BEFORE, after: AFTER } }) }));
    expect(html).not.toContain(AFTER.url);
  });

  it("renders nothing when the run has no links", () => {
    expect(renderToStaticMarkup(createElement(TryTheApp, { entry: entry() }))).toBe("");
    expect(renderToStaticMarkup(createElement(TryTheApp, { entry: entry({ apps: {} }) }))).toBe("");
  });

  it("puts small links on the picker card only where there are links", () => {
    const html = renderToStaticMarkup(
      createElement(RunPicker, { runs: [entry({ apps: { before: BEFORE, after: AFTER } }), entry({ id: "board-live-sf7", outcome: "failed" })], error: null, onOpen: () => undefined }),
    );
    expect(html.match(/class="replay-card-try"/g)).toHaveLength(1);
    expect(html).toContain("original ↗");
    expect(html).toContain("fixed (revision 6) ↗");
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
  });
});

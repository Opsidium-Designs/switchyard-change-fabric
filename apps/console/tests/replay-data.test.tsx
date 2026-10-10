/**
 * Offline tests for the static replay page: the published recorded runs fold
 * with the same board code the live console uses (and every node is backed),
 * hold no secrets or local paths, report their final verdict exactly as
 * recorded, and render mission control with everything live removed. The
 * "fetch" reads the files under public/replays; no network, no browser.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { assertBoardBacked, buildBoardGraph } from "@switchyard-change/orchestration/board-graph";

import { findLocalPaths, findSecrets } from "../scripts/replay-export.ts";
import { hullHeader, MissionControl, boardShortLabels, seedItemIds } from "../src/mission-control.tsx";
import { RECORDED_BANNER, ReplayApp, VerdictPanel } from "../src/ReplayApp.tsx";
import {
  finalVerdict,
  keyMoments,
  loadReplay,
  loadReplayIndex,
  parseReplayParams,
  replayPath,
  replaySearch,
  type ReplayRun,
} from "../src/replay-data.ts";

const PUBLIC = new URL("../public/", import.meta.url);

/** A fetch over the files in public/ (paths relative to the page, as the browser asks). */
async function fileFetch(path: string): Promise<Response> {
  try {
    return new Response(readFileSync(new URL(decodeURIComponent(path), PUBLIC), "utf8"), { status: 200 });
  } catch {
    return new Response("{}", { status: 404 });
  }
}

const replayFiles = readdirSync(new URL("replays/", PUBLIC)).filter((f) => f.endsWith(".json") && f !== "index.json");

async function load(id: string): Promise<ReplayRun> {
  return loadReplay(fileFetch, id);
}

describe("the published recorded runs", () => {
  it("are all listed in the index, and every index entry has a file", async () => {
    const index = await loadReplayIndex(fileFetch);
    expect(index.map((r) => `${r.id}.json`).sort()).toEqual([...replayFiles].sort());
    expect(index.map((r) => r.id)).toEqual(["board-live-reg3", "board-live-sf7", "board-live-sf8"]);
  });

  it("fold at every seq with the shared board code, every node backed", async () => {
    for (const file of replayFiles) {
      const run = await load(file.replace(/\.json$/, ""));
      for (let k = 0; k <= run.messages.length; k += 7) {
        assertBoardBacked(buildBoardGraph(run.messages, k), run.messages);
      }
      assertBoardBacked(buildBoardGraph(run.messages), run.messages);
    }
  });

  it("hold no token-like string and no local absolute path", () => {
    for (const file of [...replayFiles, "index.json"]) {
      const value: unknown = JSON.parse(readFileSync(new URL(`replays/${file}`, PUBLIC), "utf8"));
      expect(findSecrets(value)).toEqual([]);
      expect(findLocalPaths(value)).toEqual([]);
    }
  });

  it("report the final verdict exactly as recorded, matching the index outcome", async () => {
    const index = await loadReplayIndex(fileFetch);
    for (const entry of index) {
      const verdict = finalVerdict(await load(entry.id));
      expect(verdict.kind).toBe(entry.outcome);
    }
    expect(finalVerdict(await load("board-live-reg3")).detail).toBe(
      "The gate passed on revision 3 (acceptance 20/20); 6 item(s) integrated.",
    );
    expect(finalVerdict(await load("board-live-sf7")).detail).toBe(
      "No revision passed the gate; the last, revision 10, failed (acceptance 40/129). Nothing was promoted.",
    );
    expect(finalVerdict(await load("board-live-sf8")).detail).toContain("the best was revision 6 (acceptance 35/129)");
  });
});

describe("replay data", () => {
  it("addresses files relative to the page, so a subpath deploy works", () => {
    expect(replayPath("index.json")).toBe("replays/index.json");
    expect(replayPath("a b.json")).toBe("replays/a%20b.json");
  });

  it("refuses a file that is not a whole board log", async () => {
    const fake = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
    await expect(loadReplay(fake({ format: "other", messages: [] }), "x")).rejects.toThrow(/not a switchyard-replay/);
    await expect(loadReplay(fake({ format: "switchyard-replay/v1", messages: [] }), "x")).rejects.toThrow(/no board messages/);
    await expect(
      loadReplay(fake({ format: "switchyard-replay/v1", messages: [{ seq: 1 }, { seq: 3 }] }), "x"),
    ).rejects.toThrow(/not contiguous at seq 3/);
    await expect(loadReplay(async () => new Response("", { status: 404 }), "x")).rejects.toThrow(/could not load/);
  });

  it("parses and writes deep links (?run=&seq=&tab=)", () => {
    expect(parseReplayParams("?run=board-live-sf8&seq=110&tab=tools")).toEqual({ run: "board-live-sf8", seq: 110, tab: "tools" });
    expect(parseReplayParams("?run=&seq=-1&tab=evil")).toEqual({ run: null, seq: null, tab: null });
    expect(replaySearch("board-live-sf8", 110)).toBe("?run=board-live-sf8&seq=110");
    expect(replaySearch("board-live-sf8", null)).toBe("?run=board-live-sf8");
    expect(replaySearch(null, 5)).toBe("");
  });

  it("finds key moments that are all recorded messages", async () => {
    const run = await load("board-live-sf8");
    const moments = keyMoments(run.messages);
    const seqs = new Set(run.messages.map((m) => m.seq));
    expect(moments.every((m) => seqs.has(m.seq))).toBe(true);
    expect(moments.filter((m) => m.kind === "gate-fail")).toHaveLength(9);
    expect(moments.filter((m) => m.kind === "gate-pass")).toHaveLength(0);
    expect(moments.find((m) => m.seq === 88)).toEqual({ seq: 88, kind: "contract", label: "lead rejects agent-1-contract-1" });
    const reg3 = keyMoments((await load("board-live-reg3")).messages);
    expect(reg3.find((m) => m.kind === "gate-pass")).toEqual({ seq: 57, kind: "gate-pass", label: "revision 3: gate PASS, acceptance 20/20" });
  });

  it("never invents a verdict: no recorded integration reads 'no verdict recorded'", async () => {
    const run = await load("board-live-reg3");
    expect(finalVerdict({ ...run, snapshot: null }).kind).toBe("none");
    expect(finalVerdict({ ...run, snapshot: { integration: { verdict: "verified", gated: false } } }).kind).toBe("unverified");
  });
});

describe("the recorded view", () => {
  it("renders mission control read-only: no LIVE pill, the recorded seq, and no decision buttons", async () => {
    const run = await load("board-live-sf8");
    // seq 110: a contract change was waiting for a human at that moment.
    const markup = renderToStaticMarkup(
      createElement(MissionControl, { log: run.messages, escalations: [], busy: false, onResolve: () => undefined, recorded: true, initialSeq: 110 }),
    );
    expect(markup).toContain('class="mc is-recorded"');
    expect(markup).toContain("recorded run: seq 110/178");
    expect(markup).not.toContain("LIVE");
    expect(markup).not.toContain("go live");
    expect(markup).toContain("end: final verdict");
    expect(markup).toContain("Awaiting a human");
    expect(markup).toContain("options: accept / reject");
    expect(markup).not.toMatch(/<button[^>]*>accept<\/button>/);
    expect(markup).toContain("jump to a key moment");
  });

  it("the page shell shows the honesty banner and the verdict as recorded", async () => {
    const shell = renderToStaticMarkup(createElement(ReplayApp));
    expect(shell).toContain(RECORDED_BANNER);
    expect(shell).not.toMatch(/Launch|Deploy|Tear down|template/i);
    const verdict = renderToStaticMarkup(createElement(VerdictPanel, { verdict: finalVerdict(await load("board-live-sf7")) }));
    expect(verdict).toContain(">FAILED<");
    expect(verdict).toContain("Final verdict, as recorded at the end of the run.");
  });

  it("labels real planner ids legibly: tool items are not seeds, and a bare number keeps its id", async () => {
    const reg3 = buildBoardGraph((await load("board-live-reg3")).messages, 40);
    const labels = boardShortLabels(
      reg3.nodes.filter((n) => n.kind === "item").map((n) => n.label),
      { seeds: seedItemIds(reg3) },
    );
    expect(labels.get("unit-notifications-resource")).toBe("notifications");
    expect(labels.get("tool-scan-unit")).toBe("tool-scan-unit");
    expect(boardShortLabels(["unit-1", "unit-2"]).get("unit-1")).toBe("unit-1");
  });

  it("a zoomed-out hull keeps its title and drops the status badge rather than truncating both", () => {
    const tight = hullHeader({ title: "billing-tax", status: "claimed", width: 250, boost: 1.8 });
    expect(tight).toEqual({ title: "billing-tax", status: "", badge: { x: 236, w: 0 } });
    const roomy = hullHeader({ title: "billing-tax", status: "claimed", width: 250, boost: 1 });
    expect(roomy.title).toBe("billing-tax");
    expect(roomy.status).toBe("claimed");
  });
});

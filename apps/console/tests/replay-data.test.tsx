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
import { buildProofBundle } from "@switchyard-change/orchestration/proof-bundle";

import { hullHeader, MissionControl, ProofPanel, boardShortLabels, seedItemIds } from "../src/mission-control.tsx";
import { RECORDED_BANNER, ReplayApp, RunKindChip, RunPicker, VerdictPanel } from "../src/ReplayApp.tsx";
import {
  finalVerdict,
  keyMoments,
  loadReplay,
  loadReplayIndex,
  parseReplayParams,
  replayPath,
  replaySearch,
  SIMULATED_CHIP,
  SIMULATED_EXPLAIN,
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
    expect(index.map((r) => r.id)).toEqual(["board-live-ch1", "board-live-sf21", "board-live-l3", "board-live-reg3", "board-live-sf7", "board-live-sf8", "board-sim-100"]);
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
    expect(markup).toContain("seq 110/178");
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

describe("the proof panel (from the log alone, in replay too)", () => {
  it("each published run states honestly what it can prove: no recorded promotion means not proven", async () => {
    for (const file of replayFiles) {
      const run = await load(file.replace(/\.json$/, ""));
      const bundle = buildProofBundle(run.messages);
      // Recorded before promotions were written to the board: never claimed.
      if (!run.messages.some((m) => m.type === "revision.promoted")) {
        expect(bundle.status).toBe("not-proven");
        expect(bundle.reasons.join(" ")).toMatch(/no promotion|failed its gate|no integrated revision/);
      }
      const html = renderToStaticMarkup(createElement(ProofPanel, { bundle, onSelectSeq: () => undefined }));
      expect(html).toContain(bundle.status === "proven" ? "PROVEN" : "NOT PROVEN");
      expect(html).not.toMatch(/undefined|NaN/);
    }
  });
});

describe("a simulated run is labelled wherever a viewer sees it", () => {
  const live = { id: "board-live-x", title: "a live run", app: "storefront", outcome: "verified" as const, description: "real." };
  const sim = { id: "board-sim-x", title: "SIMULATED: 100 agents", app: "scale-project", outcome: "verified" as const, description: "scripted.", simulated: true };

  it("the picker marks the simulated card with the chip, and qualifies 'real runs'", () => {
    const html = renderToStaticMarkup(createElement(RunPicker, { runs: [live, sim], error: null, onOpen: () => undefined }));
    expect(html.match(/replay-sim-chip/g)).toHaveLength(1);
    expect(html).toContain(SIMULATED_CHIP);
    expect(html).toContain("replay-card is-verified is-simulated");
    expect(html).toContain("except the runs marked SIMULATED");
    // A list of live runs only reads as before.
    const liveOnly = renderToStaticMarkup(createElement(RunPicker, { runs: [live], error: null, onOpen: () => undefined }));
    expect(liveOnly).not.toContain("SIMULATED");
  });

  it("the run header shows the SIMULATED chip instead of the recorded-run chip, with what it means", () => {
    const simChip = renderToStaticMarkup(createElement(RunKindChip, { simulated: true }));
    expect(simChip).toContain(SIMULATED_CHIP);
    expect(simChip).toContain(`title="${SIMULATED_EXPLAIN.replace(/'/g, "&#x27;")}"`);
    expect(simChip).not.toContain(RECORDED_BANNER);
    const liveChip = renderToStaticMarkup(createElement(RunKindChip, { simulated: false }));
    expect(liveChip).toContain(RECORDED_BANNER);
    expect(liveChip).not.toContain("SIMULATED");
  });

  it("the verdict of a simulated run says it was the fixture gate and scripted agents", async () => {
    const verdict = finalVerdict(await load("board-live-reg3"));
    const simulated = renderToStaticMarkup(createElement(VerdictPanel, { verdict, simulated: true }));
    expect(simulated).toContain("SIMULATED run: the gate was the offline fixture check");
    expect(renderToStaticMarkup(createElement(VerdictPanel, { verdict }))).not.toContain("SIMULATED");
  });

  it("the loader carries the file's simulated flag (and only a literal true)", async () => {
    const { messages } = await load("board-live-reg3");
    const body = (simulated: unknown) => async () =>
      new Response(JSON.stringify({ format: "switchyard-replay/v1", changeId: "x", simulated, messages }), { status: 200 });
    expect((await loadReplay(body(true), "x")).simulated).toBe(true);
    expect((await loadReplay(body("yes"), "x")).simulated).toBeUndefined();
  });

  it("the published simulated run at scale: about 100 agents and 100 items on the real board, the fixture gate named", async () => {
    const run = await load("board-sim-100");
    expect(run.simulated).toBe(true);
    const joined = run.messages.filter((m) => m.type === "agent.joined" && m.from !== "lead").length;
    expect(joined).toBeGreaterThanOrEqual(90);
    expect(run.messages.filter((m) => m.type === "item.proposed").length).toBeGreaterThanOrEqual(100);
    // The board recorded which gate ran: the offline fixture, never the project's tests.
    expect(JSON.stringify(run.messages[0])).toContain("fixture");
  });

  it("every published simulated run says so in its file, its title, and its description", async () => {
    const index = await loadReplayIndex(fileFetch);
    for (const entry of index) {
      const file = JSON.parse(readFileSync(new URL(`replays/${entry.id}.json`, PUBLIC), "utf8")) as { simulated?: unknown };
      expect(file.simulated === true).toBe(entry.simulated === true);
      if (entry.simulated === true) {
        expect(entry.title).toMatch(/^SIMULATED: /);
        expect(entry.description).toContain("Simulated:");
      } else {
        expect(entry.id).toMatch(/^board-live-/);
      }
    }
  });
});

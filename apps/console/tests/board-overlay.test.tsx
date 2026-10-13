/**
 * Offline tests for mission control's overlays: the agent-communication
 * overlay (a pure function of the log at K, every arrow backed by one
 * recorded message), the gate timeline, the acceptance-over-revisions chart
 * data (a suite that did not run is a gap, never a zero), smarter hull titles,
 * the advisory Jev rows, a blamed speculative revision's landed part, the
 * theme helpers, the guard that keeps the replay controls when the graph
 * refuses to draw, and the replay loader's board validation.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildBoardGraph, BOARD_GRAPH_EDGE_KINDS, type BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { missionControlLog, speculativeLog } from "../../../packages/orchestration/tests/board-graph-fixture.ts";
import {
  COMM_MAX,
  COMM_WINDOW,
  commCurve,
  commOpacity,
  communicationArrows,
  drawingExtent,
  gateTimeline,
  jevRows,
  progressChart,
  revisionLinks,
  seriesStory,
  smartItemTitles,
  speculativeLanded,
} from "../src/board-overlay.ts";
import { BoardNodeDetail, ChapterStrip, hullHeader, MissionControl } from "../src/mission-control.tsx";
import { loadReplay } from "../src/replay-data.ts";
import { nextTheme, readStoredTheme, storeTheme, themeFromSearch, THEME_STORAGE_KEY } from "../src/theme.tsx";
import { boardLayout } from "@switchyard-change/orchestration/board-graph";

const PUBLIC = new URL("../public/", import.meta.url);

function recorded(id: string): BoardMessage[] {
  return (JSON.parse(readFileSync(new URL(`replays/${id}.json`, PUBLIC), "utf8")) as { messages: BoardMessage[] }).messages;
}

/** A hand-built message for the pure overlay functions (they read the log; they never validate it). */
function msg(seq: number, from: string, type: string, payload: Record<string, unknown>, extra: Partial<BoardMessage> = {}): BoardMessage {
  return { seq, at: "t", from, type, payload, ...extra } as unknown as BoardMessage;
}

const log = missionControlLog();
const lastSeq = log[log.length - 1]!.seq;

describe("the communication overlay", () => {
  it("draws who addressed whom from the recorded messages, each arrow backed by its seq", () => {
    const all = communicationArrows(log, lastSeq, { window: 0, max: 100 });
    const bySeq = new Map(log.map((m) => [m.seq, m]));
    for (const arrow of all) {
      const m = bySeq.get(arrow.seq)!;
      expect(m.type).toBe(arrow.type);
      expect(arrow.tooltip.endsWith(`(seq ${arrow.seq}, ${arrow.type})`)).toBe(true);
      expect(arrow.age).toBe(lastSeq - arrow.seq);
    }
    const pairs = all.map((a) => `${a.from} ${a.verb} ${a.to}`);
    expect(pairs).toContain("agent:ag-1 asks help agent:ag-3");
    expect(pairs).toContain("agent:ag-3 offers help agent:ag-1");
    expect(pairs).toContain("agent:ag-5 contests agent:ag-3");
    expect(pairs).toContain("agent:ag-3 keeps agent:ag-5");
    expect(pairs).toContain("agent:ag-5 keeps agent:ag-3");
    expect(pairs).toContain("agent:ag-6 proposes agent:lead");
    // The lead's acceptance of a worker's proposed tool item answers its proposer.
    expect(pairs).toContain("agent:lead accepts agent:ag-4");
  });

  it("shows only the last few seqs at K, newest first, capped, fading with age", () => {
    const help = log.find((m) => m.type === "help.requested")!.seq;
    expect(communicationArrows(log, help - 1)).toEqual([]);
    const now = communicationArrows(log, help);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ seq: help, verb: "asks help", age: 0 });
    expect(commOpacity(0)).toBe(1);
    expect(commOpacity(COMM_WINDOW / 2)).toBeCloseTo(0.5);
    expect(commOpacity(COMM_WINDOW * 3)).toBe(0.25);
    // Gone once the window has passed.
    expect(communicationArrows(log, help + COMM_WINDOW).some((a) => a.seq === help)).toBe(false);
    const later = communicationArrows(log, lastSeq, { window: 0 });
    expect(later.length).toBeLessThanOrEqual(COMM_MAX);
    expect(later.map((a) => a.seq)).toEqual([...later.map((a) => a.seq)].sort((a, b) => b - a));
    // Pure: the same log and K give the same arrows.
    expect(communicationArrows(log, lastSeq)).toEqual(communicationArrows(log, lastSeq));
  });

  it("covers handoffs, volunteers, decisions, escalations, overlaps, clashes, and re-plans; an unaddressed request is a mark", () => {
    const l = [
      msg(1, "human", "goal.posted", { objective: "o" }),
      msg(2, "lead", "agent.joined", { role: "lead" }),
      msg(3, "a1", "agent.joined", {}),
      msg(4, "a2", "agent.joined", {}),
      msg(5, "engine", "claim.granted", { item: "x", agent: "a1" }),
      msg(6, "a2", "help.volunteered", { item: "x" }),
      msg(7, "a1", "help.requested", { request: "r1", item: "x", need: "n", scope: ["src/x.ts"] }, { to: ["a2"] }),
      msg(8, "a1", "help.requested", { request: "r2", item: "x", need: "question" }),
      msg(9, "a1", "contract.proposed", { contract: "c1", target: "src/a.ts", kind: "modify" }),
      msg(10, "engine", "contract.escalated", { contract: "c1", item: "x", target: "src/a.ts", kind: "modify" }),
      msg(11, "human", "contract.accepted", { contract: "c1" }),
      msg(12, "lead", "contract.rejected", { contract: "c1" }),
      msg(13, "a1", "handoff", { item: "x", to: "a2", capsule: { repo: "r" } }),
      msg(14, "engine", "claim.overlap", { item: "y", agent: "a1", with: "x", withAgent: "a2", files: ["f"] }),
      msg(15, "engine", "clash.predicted", { a: { agent: "a1", item: "y", sha: "s" }, b: { agent: "a2", item: "x", sha: "t" }, status: "conflict" }),
      msg(16, "engine", "clash.predicted", { a: { agent: "a1", item: "y", sha: "s" }, b: { agent: "a2", item: "x", sha: "t" }, status: "unknown" }),
      msg(17, "lead", "item.replanned", { item: "x", reason: "stalled", action: "split", children: [] }),
      msg(18, "lead", "item.replanned", { item: "never-held", reason: "stalled", action: "split", children: [] }),
      msg(19, "a2", "help.declined", { item: "x", volunteer: "a1" }),
    ];
    const arrows = communicationArrows(l, 19, { window: 0, max: 100 });
    const lines = arrows.map((a) => `${a.seq} ${a.from} ${a.verb} ${a.to}`).reverse();
    expect(lines).toEqual([
      "6 agent:a2 volunteers agent:a1",
      "7 agent:a1 grants help agent:a2",
      "8 agent:a1 asks help null",
      "9 agent:a1 proposes agent:lead",
      "10 agent:a1 to a human human",
      "11 human accepts agent:a1",
      "12 agent:lead rejects agent:a1",
      "13 agent:a1 hands off agent:a2",
      "14 agent:a1 overlap agent:a2",
      "15 agent:a1 clash agent:a2",
      "17 agent:lead re-plans agent:a2",
      "18 agent:lead re-plans null",
      "19 agent:a2 declines agent:a1",
    ]);
  });

  it("finds the coordination in a recorded run (sf8 at seq 110: a contract proposal to the lead, escalated to a human)", () => {
    const sf8 = recorded("board-live-sf8");
    const arrows = communicationArrows(sf8, 110);
    expect(arrows.map((a) => `${a.seq} ${a.verb}`)).toEqual(expect.arrayContaining(["108 proposes", "109 to a human"]));
    expect(arrows.every((a) => a.seq > 110 - COMM_WINDOW && a.seq <= 110)).toBe(true);
  });

  it("curves between two points, short of both nodes, with a label point on the curve", () => {
    const c = commCurve({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(c.d.startsWith("M 20 0 Q 50 ")).toBe(true);
    expect(c.d.endsWith(" 80 0")).toBe(true);
    expect(c.mid.x).toBe(50);
    expect(c.mid.y).not.toBe(0);
  });

  it("renders as an overlay layer in mission control, apart from the graph edges (whose kinds never grow)", () => {
    const help = log.find((m) => m.type === "help.requested")!.seq;
    const html = renderToStaticMarkup(createElement(MissionControl, { log, escalations: [], busy: false, onResolve: () => {}, initialSeq: help + 1 }));
    expect(html).toContain('aria-label="Agent communication overlay"');
    expect(html).toMatch(/<g class="mc-talk-arrow[^"]*"[^>]*><path d="M [^"]+" marker-end="url\(#mc-talk-head\)"/);
    expect(html).toContain(">asks help</text>");
    expect(html).toContain("talk on");
    for (const [, kind] of html.matchAll(/class="mc-edge kind-([a-z-]+)/g)) {
      expect(BOARD_GRAPH_EDGE_KINDS).toContain(kind);
    }
    expect(html).toContain("agent talk (overlay from recorded messages, not a graph edge)");
  });
});

describe("the gate timeline", () => {
  it("is one marker per recorded revision: number, verdict, acceptance count, the landed one marked", () => {
    const reg3 = recorded("board-live-reg3");
    const markers = gateTimeline(buildBoardGraph(reg3), reg3);
    expect(markers.map((m) => [m.n, m.verdict, m.count, m.landed])).toEqual([
      [1, "fail", "10/20", false],
      [2, "fail", "16/20", false],
      [3, "pass", "20/20", true],
    ]);
    const bySeq = new Map(reg3.map((m) => [m.seq, m]));
    expect(markers.every((m) => bySeq.get(m.seq)?.type === "integrated.rev")).toBe(true);
    expect(markers[2]!.mergedItems.length).toBeGreaterThan(0);
  });

  it("reads -- where the acceptance suite did not run, with the stated reason", () => {
    const sf8 = recorded("board-live-sf8");
    const markers = gateTimeline(buildBoardGraph(sf8), sf8);
    const gap = markers.find((m) => m.acceptanceNotRun !== undefined)!;
    expect(gap.count).toBe("--");
    expect(gap.tooltip).toContain("acceptance did not run");
    expect(markers.some((m) => m.landed)).toBe(false);
  });

  it("links a revision only to its own merged items and fix requests", () => {
    const model = buildBoardGraph(log);
    const links = revisionLinks(model, 1);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((e) => e.from === "rev:1" || e.to === "rev:1")).toBe(true);
    expect(links.some((e) => e.kind === "trigger" && e.to === "item:orders")).toBe(true);
  });

  it("draws revisions on the timeline, and in the graph only when focused", () => {
    const html = renderToStaticMarkup(createElement(MissionControl, { log, escalations: [], busy: false, onResolve: () => {} }));
    expect(html).toContain('aria-label="Gate timeline"');
    expect(html).toContain('aria-label="revision 1: GATE FAIL"');
    expect(html).not.toContain('class="mc-node kind-rev');
    expect(html).not.toContain("mc-rev-focus");
    const focused = renderToStaticMarkup(
      createElement(MissionControl, { log, escalations: [], busy: false, onResolve: () => {}, initialSelection: { kind: "node", id: "rev:1" } }),
    );
    expect(focused).toContain('class="mc-rev-focus status-fail"');
    expect(focused).toContain('class="mc-node kind-rev status-fail"');
    expect(focused).toMatch(/mc-gate-marker is-fail is-focus/);
    expect(focused).toMatch(/class="mc-hull [^"]*is-rev-focus/);
  });

  it("shows an empty timeline honestly before any revision", () => {
    const html = renderToStaticMarkup(createElement(ChapterStrip, { chapters: [], k: 0, markers: [], focus: null, onHover: () => {}, onSelect: () => {}, onSeek: () => {} }));
    expect(html).toContain("no integrated revision yet");
  });
});

describe("acceptance over revisions", () => {
  it("tells the reg3 story 10/20 -> 16/20 -> 20/20, the passing revision landed", () => {
    const chart = progressChart(recorded("board-live-reg3"), Number.POSITIVE_INFINITY);
    expect(chart.landed).toBe(3);
    const acceptance = chart.series.find((s) => s.suite === "acceptance")!;
    expect(acceptance.points.map((p) => p.passed)).toEqual([10, 16, 20]);
    expect(acceptance.total).toBe(20);
    expect(seriesStory(acceptance)).toBe("10/20 -> 16/20 -> 20/20");
  });

  it("keeps a suite that did not run as a gap with its reason, never a zero", () => {
    const sf8 = progressChart(recorded("board-live-sf8"), Number.POSITIVE_INFINITY);
    const acceptance = sf8.series.find((s) => s.suite === "acceptance")!;
    const gaps = acceptance.points.filter((p) => p.gap !== undefined);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(g.passed).toBeUndefined();
      expect(g.gap).toMatch(/did not run|no acceptance count/);
    }
    expect(acceptance.points.some((p) => p.passed === 35)).toBe(true);
    expect(sf8.landed).toBeUndefined();
    expect(seriesStory(acceptance)).toMatch(/best r\d 35\/129/);
    // A developer series appears because revisions recorded developer suites.
    expect(sf8.series.map((s) => s.suite)).toEqual(["acceptance", "developer"]);
  });

  it("is folded at K and attaches speculative candidates at their round's revision", () => {
    const progress = (passed: number) => ({ passed, failed: 20 - passed, total: 20, acceptance: { passed, failed: 20 - passed, total: 20 } });
    const l = [
      msg(1, "engine", "integrated.rev", { n: 1, commit: "a", gate: "fail", merged: [], paths: [], contributors: [], progress: progress(10) }),
      msg(2, "engine", "candidate.gated", { round: 1, index: 1, of: 2, prefix: [], commit: "c1", verdict: "pass", outcome: "landed", rev: 2, progress: progress(20) }),
      msg(3, "engine", "candidate.gated", { round: 1, index: 2, of: 2, prefix: [], commit: "c2", verdict: "fail", outcome: "retest", progress: progress(18) }),
      msg(4, "engine", "integrated.rev", { n: 2, commit: "c1", gate: "pass", merged: [], paths: [], contributors: [], progress: progress(20) }),
    ];
    expect(progressChart(l, 1).series[0]!.points).toHaveLength(1);
    const chart = progressChart(l, 4);
    expect(chart.landed).toBe(2);
    expect(chart.series[0]!.candidates.map((c) => [c.seq, c.n, c.passed, c.outcome])).toEqual([
      [2, 2, 20, "landed"],
      [3, 2, 18, "retest"],
    ]);
    expect(progressChart([], 10)).toEqual({ series: [] });
  });

  it("renders the chart with a gap marker, the landed point ringed, every mark citing its seq", () => {
    const sf8 = recorded("board-live-sf8");
    const html = renderToStaticMarkup(createElement(MissionControl, { log: sf8, escalations: [], busy: false, onResolve: () => {}, recorded: true }));
    expect(html).toContain('aria-label="acceptance over revisions"');
    expect(html).toMatch(/<rect class="mc-chart-gap"[^>]*><title>rev \d+: acceptance did not run: [^<]+\(seq \d+, integrated\.rev\)<\/title>/);
    const reg3 = renderToStaticMarkup(createElement(MissionControl, { log: recorded("board-live-reg3"), escalations: [], busy: false, onResolve: () => {}, recorded: true }));
    expect(reg3).toMatch(/class="mc-chart-pt is-pass is-landed"/);
    expect(reg3).toContain("10/20 -&gt; 16/20 -&gt; 20/20");
  });
});

describe("hull titles", () => {
  it("names a seam item by its contract's recorded target and a tool item by its capability", () => {
    const sf8 = recorded("board-live-sf8");
    const ids = ["seam-agent-3-contract-1", "seam-agent-5-contract-1", "unit-billing-tax"];
    const titles = smartItemTitles(sf8, new Map(ids.map((id) => [id, id])));
    expect(titles.get("seam-agent-3-contract-1")).toBe("seam: money.ts");
    expect(titles.get("seam-agent-5-contract-1")).toBe("seam: store.ts");
    expect(titles.get("unit-billing-tax")).toBe("unit-billing-tax");
    const reg3 = smartItemTitles(recorded("board-live-reg3"), new Map([["tool-scan-unit", "tool-scan-unit"]]));
    expect(reg3.get("tool-scan-unit")).toBe("tool: scan-unit");
  });

  it("sets a slightly long title smaller instead of cutting it", () => {
    const header = hullHeader({ title: "billing-invoices", status: "claimed / fix 3", width: 250, boost: 1.72 });
    expect(header.title).toBe("billing-invoices");
    expect(header.scale).toBeLessThan(1);
  });
});

describe("advisory decisions (Jev)", () => {
  it("lists type, answer, confidence, and the resolved outcome, newest first", () => {
    const rows = jevRows(buildBoardGraph(log));
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => b - a));
    const attribution = rows.find((r) => r.juncture === "attribution")!;
    expect(attribution).toMatchObject({ recommendation: "orders", confidence: 0.82, confident: true, about: "rev 1" });
    expect(attribution.outcome).toBe("Jev picked orders; orders changed before the next pass");
    expect(rows.find((r) => r.juncture === "contract-triage")).toMatchObject({ recommendation: "accept", about: "k1" });
  });
});

describe("a blamed speculative revision", () => {
  it("shows the pushes that landed in the passing revision apart from the failure's contributors", () => {
    const spec = speculativeLog();
    const landed = speculativeLanded(spec, Number.POSITIVE_INFINITY, 2)!;
    expect(landed).toMatchObject({ rev: 3, items: ["one"], failingItems: ["two"] });
    expect(speculativeLanded(spec, Number.POSITIVE_INFINITY, 3)).toBeUndefined();
    const node = buildBoardGraph(spec).nodes.find((n) => n.id === "rev:2")!;
    const html = renderToStaticMarkup(createElement(BoardNodeDetail, { node, landed }));
    expect(html).toContain("<dt>Landed in rev 3</dt>");
    expect(html).toContain("<dt>Contributors to the failure</dt>");
    expect(html).toMatch(/already landed in rev 3/);
  });
});

describe("the drawing extent", () => {
  it("ends at the hulls, bench, and tools: no empty revision column", () => {
    const reg3 = recorded("board-live-reg3");
    const layout = boardLayout(reg3);
    const extent = drawingExtent(layout);
    expect(extent.width).toBeLessThan(layout.width);
    const hullRight = Math.max(...[...layout.items.values()].map((r) => r.x + r.w));
    expect(extent.width).toBeGreaterThanOrEqual(hullRight);
  });
});

describe("the honesty guard keeps the replay controls", () => {
  // A revision whose payload cannot be folded: the graph refuses to draw from it.
  const broken = log.map((m) => (m.type === "integrated.rev" && m.payload.n === 2 ? ({ ...m, payload: { ...m.payload, merged: null } } as unknown as BoardMessage) : m));
  const badSeq = broken.find((m) => m.type === "integrated.rev" && (m.payload as { n: number }).n === 2)!.seq;

  it("renders the refusal and the scrubber at a bad seq (replaying and at the live edge)", () => {
    for (const props of [{ initialSeq: badSeq }, {}]) {
      const html = renderToStaticMarkup(createElement(MissionControl, { log: broken, escalations: [], busy: false, onResolve: () => {}, ...props }));
      expect(html).toContain("Refusing to render the board graph at seq");
      expect(html).toContain('aria-label="Replay"');
      expect(html).toContain('aria-label="Replay seq"');
      expect(html).toContain("jump to a key moment");
    }
  });

  it("draws normally before the bad seq", () => {
    const html = renderToStaticMarkup(createElement(MissionControl, { log: broken, escalations: [], busy: false, onResolve: () => {}, initialSeq: badSeq - 1 }));
    expect(html).not.toContain("Refusing to render");
    expect(html).toContain('aria-label="Board graph"');
  });
});

describe("the replay loader validates the board", () => {
  const file = JSON.parse(readFileSync(new URL("replays/board-live-reg3.json", PUBLIC), "utf8")) as { messages: BoardMessage[] };
  const serve = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it("accepts a recorded run the board reducer accepts", async () => {
    const run = await loadReplay(serve(file), "board-live-reg3");
    expect(run.messages).toHaveLength(file.messages.length);
  });

  it("refuses a contiguous but corrupted log (an engine message arbitration never produced)", async () => {
    const corrupted = { ...file, messages: file.messages.map((m) => (m.seq === 2 ? { ...m, from: "engine" } : m)) };
    await expect(loadReplay(serve(corrupted), "board-live-reg3")).rejects.toThrow(/board-live-reg3 failed validation: the board reducer refused it/);
    const forged = {
      ...file,
      messages: file.messages.map((m) => (m.type === "claim.granted" ? { ...m, payload: { ...m.payload, agent: "agent-99" } } : m)),
    };
    await expect(loadReplay(serve(forged), "x")).rejects.toThrow(/failed validation/);
  });
});

describe("the theme", () => {
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };

  it("reads and stores the choice, surviving blocked storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(readStoredTheme(storage)).toBe("system");
    storeTheme(storage, "light");
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredTheme(storage)).toBe("light");
    storeTheme(storage, "system");
    expect(store.has(THEME_STORAGE_KEY)).toBe(false);
    store.set(THEME_STORAGE_KEY, "neon");
    expect(readStoredTheme(storage)).toBe("system");
    expect(readStoredTheme(throwing)).toBe("system");
    expect(() => storeTheme(throwing, "dark")).not.toThrow();
    expect(readStoredTheme(undefined)).toBe("system");
  });

  it("cycles system, light, dark, and honors ?theme= only for light or dark", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
    expect(themeFromSearch("?run=x&theme=light")).toBe("light");
    expect(themeFromSearch("?theme=dark")).toBe("dark");
    expect(themeFromSearch("?theme=evil")).toBeNull();
  });

  it("defines every palette color for both themes", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const root = css.slice(0, css.indexOf("}"));
    expect(root).toContain("color-scheme: light dark;");
    for (const v of ["--bg", "--panel", "--text", "--muted", "--accent", "--ok", "--bad", "--talk"]) {
      expect(root).toMatch(new RegExp(`${v}: light-dark\\(#[0-9a-f]{6}, #[0-9a-f]{6}\\);`));
    }
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain(':root[data-theme="dark"]');
  });
});

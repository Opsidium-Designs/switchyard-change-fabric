/**
 * Offline tests for the console at scale: synthetic board logs with a lead,
 * four sub-leads, 30 or 99 workers (100 agents, the board's cap), and 38 items
 * over eight domains. The logs are built through the pure board API, so the
 * real fold and buildBoardGraph read them and every node stays backed. The
 * large-board layout (lanes, compact hulls, the bench chip), the one-line
 * ticker, the short Board summary, and the render cost are checked here; a
 * small board keeps the orchestration layout unchanged.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  assertBoardBacked,
  boardLayout,
  boardNodePoint,
  buildBoardGraph,
  type BoardMessage,
} from "@switchyard-change/orchestration/board-graph";

import { formationLog, missionControlLog } from "../../../packages/orchestration/tests/board-graph-fixture.ts";
import {
  benchCounts,
  benchLine,
  boardLanes,
  compactHullTitle,
  COMPACT_MAX_AGENTS,
  domainPrefix,
  isLargeBoard,
  laneCaption,
  scaledBoardLayout,
  scaledNodePoint,
  scopeDirectory,
  shortList,
  subLeadTeams,
} from "../src/board-scale.ts";
import { BoardPane, MissionControl, Ticker, Thread } from "../src/mission-control.tsx";
import { loadReplay } from "../src/replay-data.ts";
import { largeBoardLog } from "./fixtures/large-board.ts";

// Built once: the 99-worker log is about a thousand board appends.
const log30 = largeBoardLog({ workers: 30 });
const log100 = largeBoardLog({ workers: 99 });
const last = (log: readonly BoardMessage[]) => log[log.length - 1]!.seq;
const seqsOf = (log: readonly BoardMessage[]) => [1, Math.round(last(log) * 0.25), Math.round(last(log) * 0.5), Math.round(last(log) * 0.75), last(log)];

function render(log: readonly BoardMessage[], props: Partial<Parameters<typeof MissionControl>[0]> = {}): string {
  return renderToStaticMarkup(createElement(MissionControl, { log, escalations: [], busy: false, onResolve: () => {}, recorded: true, ...props }));
}

describe("the synthetic large board logs", () => {
  it("are whole board logs the replay loader accepts (the board reducer re-derives every message)", async () => {
    for (const [id, log] of [["large-30", log30], ["large-100", log100]] as const) {
      const body = JSON.stringify({ format: "switchyard-replay/v1", changeId: id, messages: log, snapshot: null });
      const run = await loadReplay(async () => new Response(body, { status: 200 }), id);
      expect(run.messages).toHaveLength(log.length);
    }
  });

  it("hold a lead, four sub-leads, 30 or 99 workers, 38 items, contests, a contract, five revisions with rising acceptance, and a promotion", () => {
    for (const [log, workers] of [[log30, 30], [log100, 99]] as const) {
      const count = (type: string) => log.filter((m) => m.type === type).length;
      expect(count("agent.joined")).toBe(workers + 1);
      expect(log.filter((m) => m.type === "agent.joined" && m.payload.role === "lead")).toHaveLength(1);
      expect(count("item.split")).toBe(4);
      expect(count("claim.contested")).toBe(2);
      expect(count("claim.escalated")).toBe(1);
      expect(count("contract.escalated")).toBe(1);
      expect(count("fix.requested")).toBeGreaterThan(5);
      expect(count("revision.promoted")).toBe(1);
      const revs = log.flatMap((m) => (m.type === "integrated.rev" ? [m.payload] : []));
      expect(revs.map((r) => r.progress?.acceptance?.passed)).toEqual([40, 88, 121, 150, 160]);
      expect(revs.map((r) => r.gate)).toEqual(["fail", "fail", "fail", "fail", "pass"]);
      const model = buildBoardGraph(log);
      expect(model.nodes.filter((n) => n.kind === "item")).toHaveLength(38);
      expect(model.nodes.filter((n) => n.detail.kind === "item" && n.detail.item.startsWith("seam-"))).toHaveLength(2);
      expect(model.ticker.agents.joined).toBe(workers + 1);
    }
    // The big variant is a thousand-message board (the thread's worst case).
    expect(log100.length).toBeGreaterThan(1000);
  });

  it("fold at several seqs with every node and edge backed", () => {
    for (const log of [log30, log100]) {
      for (const k of seqsOf(log)) {
        const model = buildBoardGraph(log, k);
        assertBoardBacked(model, log);
        expect(model.k).toBe(k);
      }
    }
  });

  it("are deterministic", () => {
    expect(JSON.stringify(largeBoardLog({ workers: 30 }))).toBe(JSON.stringify(log30));
  });
});

describe("lane grouping", () => {
  it("reads a domain from the id prefix, else the scope directory", () => {
    expect(domainPrefix("parking-meter-rates")).toBe("parking");
    expect(domainPrefix("permits.fee-calc")).toBe("permits");
    expect(domainPrefix("unit-users-auth")).toBe("users");
    expect(domainPrefix("tax")).toBeUndefined();
    expect(scopeDirectory(["src/billing/tax.ts"])).toBe("billing");
    expect(scopeDirectory(["src/permits/**"])).toBe("permits");
    expect(scopeDirectory(["README.md"])).toBeUndefined();
  });

  it("groups by shared prefix, a split item by its own name, then by scope directory, then `other`", () => {
    const scope: Record<string, readonly string[]> = {
      tax: ["src/billing/tax.ts"],
      invoices: ["src/billing/invoices.ts"],
      search: ["src/catalog/search.ts"],
    };
    const lanes = boardLanes(
      ["permits", "parking-a", "parking-b", "tax", "invoices", "search", "lonely-one"],
      (id) => id === "permits",
      (id) => scope[id],
    );
    expect(Object.fromEntries(lanes)).toEqual({
      permits: "permits",
      "parking-a": "parking",
      "parking-b": "parking",
      tax: "billing",
      invoices: "billing",
      search: "other",
      "lonely-one": "other",
    });
  });

  it("titles a compact hull by what its lane or parent does not already say; a label from its origin is kept", () => {
    expect(compactHullTitle("permits.fee-calc", "permits.fee-calc", "permits")).toBe("fee-calc");
    expect(compactHullTitle("parking-meter-rates", "meter-rates", "parking")).toBe("meter-rates");
    expect(compactHullTitle("parking-meter-rates", "parking-meter-rates", "parking")).toBe("meter-rates");
    expect(compactHullTitle("seam-fees", "seam: fees.ts", "seam")).toBe("fees.ts");
    expect(compactHullTitle("tax", "tax", "billing")).toBe("tax");
    expect(compactHullTitle("x-y", "x-y", "other")).toBe("x-y");
  });
});

describe("the scaled layout", () => {
  it("keeps the orchestration layout for a small board (no regression at the size the runs so far had)", () => {
    const sf21 = JSON.parse(readFileSync(new URL("../public/replays/board-live-sf21.json", import.meta.url), "utf8")) as { messages: BoardMessage[] };
    for (const log of [missionControlLog(), formationLog(), sf21.messages]) {
      expect(isLargeBoard(log)).toBe(false);
      const scaled = scaledBoardLayout(log);
      expect(scaled.compact).toBe(false);
      expect(scaled.lanes).toEqual([]);
      const base = boardLayout(log);
      expect([...scaled.items]).toEqual([...base.items]);
      expect([...scaled.bench]).toEqual([...base.bench]);
      expect(scaled.width).toBe(base.width);
    }
  });

  it("groups a large board's items into lanes with no overlap, nests split children inside their parent, and stays landscape", () => {
    for (const log of [log30, log100]) {
      expect(isLargeBoard(log)).toBe(true);
      const layout = scaledBoardLayout(log);
      expect(layout.compact).toBe(true);
      expect(layout.lanes.map((l) => l.key).sort()).toEqual(["housing", "licensing", "parking", "parks", "permits", "records", "seam", "transit", "utilities"]);
      const model = buildBoardGraph(log);
      // Every item has a rect, inside its lane (a nested child inside its parent).
      for (const node of model.nodes) {
        if (node.detail.kind !== "item") continue;
        const rect = layout.items.get(node.detail.item)!;
        expect(rect).toBeDefined();
        if (rect.parent !== undefined) {
          const p = layout.items.get(rect.parent)!;
          expect(rect.x >= p.x && rect.y >= p.y && rect.x + rect.w <= p.x + p.w && rect.y + rect.h <= p.y + p.h).toBe(true);
        } else {
          const lane = layout.lanes.find((l) => l.items.includes(node.detail.kind === "item" ? node.detail.item : ""))!;
          expect(rect.x >= lane.x && rect.y >= lane.y && rect.x + rect.w <= lane.x + lane.w && rect.y + rect.h <= lane.y + lane.h).toBe(true);
        }
      }
      // Top-level hulls and lanes never overlap.
      const boxes = (list: readonly { x: number; y: number; w: number; h: number }[]) =>
        list.every((a, i) => list.every((b, j) => i === j || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
      expect(boxes([...layout.items.values()].filter((r) => r.parent === undefined))).toBe(true);
      expect(boxes(layout.lanes)).toBe(true);
      expect(layout.width / layout.height).toBeGreaterThan(1);
      // Every free worker's point is the bench chip's center (one chip, not a dot each).
      const chip = layout.benchChip!;
      expect(new Set([...layout.bench.values()].map((p) => `${p.x},${p.y}`))).toEqual(new Set([`${chip.x + chip.w / 2},${chip.y + chip.h / 2}`]));
    }
  });

  it("is computed from the full log, so nothing moves while scrubbing", () => {
    const layout = scaledBoardLayout(log100);
    expect(JSON.stringify([...scaledBoardLayout(log100).items])).toBe(JSON.stringify([...layout.items]));
    const early = buildBoardGraph(log100, Math.round(last(log100) * 0.3));
    const late = buildBoardGraph(log100);
    for (const node of early.nodes.filter((n) => n.kind === "item")) {
      const later = late.nodes.find((n) => n.id === node.id)!;
      expect(scaledNodePoint(layout, node, early)).toEqual(scaledNodePoint(layout, later, late));
    }
  });

  it("puts an agent in its compact hull's dot row, a sub-lead on its split hull's border, and a free agent on the chip", () => {
    const layout = scaledBoardLayout(log30);
    const model = buildBoardGraph(log30, Math.round(last(log30) * 0.5));
    for (const node of model.nodes) {
      if (node.detail.kind !== "agent" || node.kind === "lead") continue;
      const p = scaledNodePoint(layout, node, model)!;
      expect(p).toBeDefined();
      if (node.detail.hull === undefined) {
        expect(p).toEqual(boardNodePoint(layout, node));
        continue;
      }
      const hull = layout.items.get(node.detail.hull)!;
      if (node.detail.subLeadOf?.includes(node.detail.hull)) expect(p.x).toBe(hull.x);
      else expect(p.x > hull.x && p.x < hull.x + hull.w && p.y > hull.y && p.y < hull.y + hull.h).toBe(true);
    }
  });
});

describe("mission control at scale", () => {
  it("renders at several seqs of both logs with lanes, compact hulls, and the bench chip instead of a dot per free agent", () => {
    for (const log of [log30, log100]) {
      for (const k of seqsOf(log).slice(1)) {
        const html = render(log, { initialSeq: k });
        expect(html).toContain('aria-label="Board graph"');
        expect(html).not.toContain("Refusing to render");
        expect(html).toContain('class="mc-lane"');
        expect(html).toContain('class="mc-hulls is-compact"');
        const model = buildBoardGraph(log, k);
        const { idle, left } = benchCounts(model);
        if (idle.length + left.length > 0) expect(html).toContain(`aria-label="bench: ${idle.length} idle, ${left.length} left"`);
        // Agent dots drawn: at most COMPACT_MAX_AGENTS per item, never one per free agent.
        const dots = (html.match(/class="mc-node kind-agent/g) ?? []).length;
        const items = model.nodes.filter((n) => n.kind === "item").length;
        expect(dots).toBeLessThanOrEqual(items * COMPACT_MAX_AGENTS);
        expect(dots).toBeLessThan(model.nodes.filter((n) => n.kind === "agent").length - idle.length - left.length + 1);
      }
    }
  });

  it("draws the bench chip with its counts and never a hundred bench dots at the end of the run", () => {
    const html = render(log100);
    expect(html).toContain("bench: 99 left");
    expect(html).not.toMatch(/class="mc-node kind-agent[^"]*status-left/);
    expect(benchLine(64, 0)).toBe("bench: 64 idle");
    expect(benchLine(3, 2)).toBe("bench: 3 idle, 2 left");
  });

  it("captions each lane from the model at K (done of its work units; nothing before its items exist)", () => {
    const layout = scaledBoardLayout(log30);
    const permits = layout.lanes.find((l) => l.key === "permits")!;
    expect(laneCaption(permits, buildBoardGraph(log30, 2))).toBeUndefined();
    expect(laneCaption(permits, buildBoardGraph(log30))).toMatchObject({ title: "permits", detail: "4/4 done" });
    const mid = laneCaption(permits, buildBoardGraph(log30, Math.round(last(log30) * 0.5)))!;
    expect(mid.subLeads).toEqual(["agent-1"]);
  });

  it("keeps the ticker to one line: active/total agents and a compact per-sub-lead breakdown", () => {
    const model = buildBoardGraph(log100, 420);
    const teams = subLeadTeams(model);
    expect(teams.map((t) => t.agent)).toEqual(["agent-1", "agent-2", "agent-3", "agent-4"]);
    expect(teams.map((t) => t.active)).toEqual([5, 5, 5, 5]);
    const html = renderToStaticMarkup(createElement(Ticker, { ticker: model.ticker, live: false, k: 420, lastSeq: last(log100), recorded: true, teams }));
    expect(html).toContain("100/100 agents");
    expect(html).toContain("sub-leads: permits 5 · utilities 5 · records 5 · housing 5");
    expect(html).toContain('title="active agents per sub-lead: agent-1 leads permits (5 active)');
    // A small board shows no breakdown.
    const small = buildBoardGraph(missionControlLog());
    expect(subLeadTeams(small)).toEqual([]);
    const smallHtml = renderToStaticMarkup(createElement(Ticker, { ticker: small.ticker, live: true, k: small.k, lastSeq: small.k }));
    expect(smallHtml).not.toContain("sub-leads:");
  });

  it("keeps a long Board column a short summary (counts and a folded list), with compact cards", () => {
    const model = buildBoardGraph(log100, 600);
    const html = renderToStaticMarkup(
      createElement(BoardPane, { model, cards: [], selection: null, busy: false, onSelect: () => {}, onResolve: () => {}, log: log100 }),
    );
    expect(html).toMatch(/CLAIMED <span class="muted">37<\/span>/);
    expect(html).toContain("and 31 more");
    expect(html).toContain('class="mc-cards is-compact"');
    expect(shortList(["a", "b", "c"], 2)).toBe("a, b and 1 more");
  });

  it("renders the final seq of the 100-agent log well under a second, and a 1000-message thread fast", () => {
    // Warm once (module init, first JSX pass), then measure.
    render(log100);
    const t0 = performance.now();
    const html = render(log100);
    const mcMs = performance.now() - t0;
    expect(html).toContain("100 agents");
    const t1 = performance.now();
    renderToStaticMarkup(
      createElement(Thread, { messages: [...log100].reverse(), title: "all", selectedSeq: null, onSelectSeq: () => {}, onSelectAgent: () => {}, log: log100 }),
    );
    const threadMs = performance.now() - t1;
    // Measured locally at about 30 to 90 ms and 70 to 180 ms; the bounds are generous so a busy machine stays green.
    expect(mcMs).toBeLessThan(1000);
    expect(threadMs).toBeLessThan(2000);
  });
});

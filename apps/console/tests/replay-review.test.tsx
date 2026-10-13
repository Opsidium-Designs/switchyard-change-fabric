/**
 * Offline tests for the replay review fixes: the scrubber's thumb sits over
 * the pip of its seq, captions keep clear of every label on the graph, the
 * fix-asked state clears once it is answered or superseded, the thread reads
 * its direction, the Board's test charts explain themselves, and an
 * escalation card says why it was raised, all from recorded board messages.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildBoardGraph, type BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { COMM_KINDS, commKind, drawnLegend, fixAskState, outstandingFixLinks, revisionAnchor } from "../src/board-overlay.ts";

import { MissionControl, ReplayBar, scrubThumbCenter, scrubTickX, SCRUB_THUMB_PX } from "../src/mission-control.tsx";

const PUBLIC = new URL("../public/", import.meta.url);

function recorded(id: string): BoardMessage[] {
  return (JSON.parse(readFileSync(new URL(`replays/${id}.json`, PUBLIC), "utf8")) as { messages: BoardMessage[] }).messages;
}

const RUNS = ["board-live-sf21", "board-live-reg3", "board-live-sf8", "board-live-sf7", "board-live-l3"] as const;

describe("the scrubber", () => {
  const noop = () => {};

  it("puts the thumb's centre exactly over the pip of the current seq, first and last included", () => {
    for (const id of RUNS) {
      const log = recorded(id);
      const last = log[log.length - 1]!.seq;
      const html = renderToStaticMarkup(
        createElement(ReplayBar, { log, k: 1, live: false, playing: false, speed: 1, recorded: true, onSeek: noop, onLive: noop, onPlay: noop, onSpeed: noop }),
      );
      // The range runs 0..last, the tick row's viewBox runs 0..last, and every pip is drawn AT its seq.
      expect(html).toContain(`type="range" min="0" max="${last}"`);
      expect(html).toContain(`viewBox="0 0 ${last} 10"`);
      const xs = [...html.matchAll(/M(-?[\d.]+) 0v10/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
      expect(xs).toEqual(log.map((m) => m.seq));
      // The tick row is inset half a thumb on each side, the thumb is that wide.
      expect(html).toContain(`--mc-thumb:${SCRUB_THUMB_PX}px`);
      for (const width of [160, 433, 900]) {
        for (const m of log) {
          expect(scrubTickX(m.seq, 0, last, width)).toBeCloseTo(scrubThumbCenter(m.seq, 0, last, width), 9);
        }
      }
    }
  });

  it("matches a native range's thumb travel: half a thumb in at min, half a thumb in from the end at max", () => {
    expect(scrubThumbCenter(0, 0, 100, 414)).toBe(SCRUB_THUMB_PX / 2);
    expect(scrubThumbCenter(100, 0, 100, 414)).toBe(414 - SCRUB_THUMB_PX / 2);
    expect(scrubThumbCenter(50, 0, 100, 414)).toBe(207);
    expect(scrubThumbCenter(1, 0, 137, 600) - scrubThumbCenter(0, 0, 137, 600)).toBeCloseTo((600 - SCRUB_THUMB_PX) / 137, 9);
    // The old row (ticks at seq - 0.5, spanning the full width) sat half a pip plus up to half a thumb off the thumb.
    const width = 500;
    const last = 137;
    const oldTick = (seq: number) => ((seq - 0.5) / last) * width;
    expect(scrubThumbCenter(1, 0, last, width) - oldTick(1)).toBeGreaterThan(width / last);
    expect(Math.abs(scrubTickX(1, 0, last, width) - scrubThumbCenter(1, 0, last, width))).toBeLessThan(1e-9);
    // Clamped outside the range, and a one-message log never divides by zero.
    expect(scrubThumbCenter(-5, 0, 10, 200)).toBe(SCRUB_THUMB_PX / 2);
    expect(scrubThumbCenter(5, 0, 0, 200)).toBe(SCRUB_THUMB_PX / 2);
  });

  it("renders the same bar inside mission control", () => {
    const log = recorded("board-live-reg3");
    const html = renderToStaticMarkup(createElement(MissionControl, { log, escalations: [], busy: false, onResolve: noop, recorded: true, initialSeq: 40 }));
    expect(html).toMatch(/<input type="range" min="0" max="89"[^>]*value="40"/);
  });
});

describe("help asks and help offers", () => {
  it("are two talk kinds, by who is acting: the asker (or the owner answering) and the helper", () => {
    expect(commKind("help.requested")).toBe("help-ask");
    expect(commKind("help.declined")).toBe("help-ask");
    for (const t of ["help.volunteered", "help.offered", "help.delivered"]) expect(commKind(t)).toBe("help-offer");
    expect(COMM_KINDS).toContain("help-ask");
    expect(COMM_KINDS).toContain("help-offer");
    expect(COMM_KINDS).not.toContain("help");
  });

  it("have two colours in both themes, apart from every other talk colour", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const varOf = (name: string): string => css.match(new RegExp(`--${name}: ([^;]+);`))?.[1]!.trim() ?? "";
    const resolve = (v: string): string => {
      const ref = v.match(/^var\(--([a-z-]+)\)$/);
      return ref ? resolve(varOf(ref[1]!)) : v;
    };
    const themes = (kind: string): [string, string] => {
      const m = resolve(varOf(`talk-${kind}`)).match(/^light-dark\((#[0-9a-f]+), (#[0-9a-f]+)\)$/i);
      expect(m, kind).not.toBeNull();
      return [m![1]!.toLowerCase(), m![2]!.toLowerCase()];
    };
    for (const theme of [0, 1]) {
      const colours = COMM_KINDS.map((k) => themes(k)[theme]);
      expect(new Set(colours).size, `theme ${theme}: ${colours.join(", ")}`).toBe(COMM_KINDS.length);
    }
    expect(css).toContain(".talk-help-ask {");
    expect(css).toContain(".talk-help-offer {");
  });

  it("are listed apart in the legend, and each arrow has its head at the target and a dot at the sender", () => {
    const { present } = drawnLegend([], [{ kind: "help-ask" }, { kind: "help-offer" }]);
    expect(present.map((e) => `${e.key}: ${e.label}`)).toEqual(["talk-help-ask: help asked", "talk-help-offer: help offered"]);
    const sf21 = recorded("board-live-sf21");
    const html = renderToStaticMarkup(createElement(MissionControl, { log: sf21, escalations: [], busy: false, onResolve: () => {}, recorded: true, initialSeq: 98 }));
    expect(html).toMatch(/<g class="mc-talk-arrow talk-help-offer[^"]*"[^>]*><path d="[^"]+" marker-start="url\(#mc-talk-tail-help-offer\)" marker-end="url\(#mc-talk-head-help-offer\)"/);
    expect(html).toContain('<marker id="mc-talk-tail-help-ask"');
  });
});

describe("the failing revision on the graph (anchor node and its fix lines)", () => {
  type Anchor = ReturnType<typeof revisionAnchor>;
  const describeAnchor = (a: Anchor): string =>
    a === null ? "none" : a.mode === "passed" ? `rev ${a.rev.id.slice(4)} passed ${a.opacity}` : `rev ${a.rev.id.slice(4)} fix ${a.edges.map((e) => e.to.slice(5)).sort().join(",")}`;

  it("sf21: the lines leave as each owner pushes, the node leaves with the last one or at the next revision, and a pass shows briefly", () => {
    const sf21 = recorded("board-live-sf21");
    const at = (k: number) => describeAnchor(revisionAnchor(buildBoardGraph(sf21, k), sf21));
    expect(at(32)).toBe("none"); // rev 1 failed; nothing asked yet
    expect(at(33)).toBe("rev 1 fix tax");
    expect(at(41)).toBe("rev 1 fix tax");
    expect(at(42)).toBe("none"); // tax pushes its fix (seq 42)
    expect(at(44)).toBe("none"); // rev 2 lands
    expect(at(48)).toBe("rev 2 fix invoices,payments,refunds,tax");
    expect(at(58)).toBe("rev 2 fix invoices,payments,refunds,tax");
    expect(at(59)).toBe("rev 2 fix payments,refunds,tax"); // invoices pushes
    expect(at(62)).toBe("rev 2 fix payments,refunds,tax");
    expect(at(63)).toBe("rev 2 fix payments,refunds"); // tax pushes
    expect(at(64)).toBe("none"); // rev 3 lands: rev 2's requests are over (payments and refunds never pushed)
    expect(at(83)).toBe("rev 4 fix cart,categories,checkout,history,invoices,lead-item-1,products,search,tax");
    expect(at(93)).toBe("rev 4 fix cart,categories,checkout,history,invoices,lead-item-1,products,search,tax");
    expect(at(94)).toBe("rev 4 fix categories,checkout,history,invoices,lead-item-1,products,search,tax"); // cart pushes
    expect(at(99)).toBe("rev 4 fix categories,history,invoices,lead-item-1,search,tax");
    expect(at(100)).toBe("none"); // rev 5 lands
    expect(at(106)).toBe("rev 5 fix cart,checkout,products");
    expect(at(107)).toBe("rev 5 fix cart,products"); // checkout pushes
    expect(at(108)).toBe("rev 6 passed 1"); // rev 6 passes: no lines at once
    expect(at(110)).toBe("rev 6 passed 0.5");
    expect(at(111)).toBe("rev 6 passed 0.25");
    expect(at(112)).toBe("none");
    expect(at(137)).toBe("none");
  });

  it("reg3: the same rule", () => {
    const reg3 = recorded("board-live-reg3");
    const at = (k: number) => describeAnchor(revisionAnchor(buildBoardGraph(reg3, k), reg3));
    expect(at(26)).toBe("none");
    expect(at(27)).toBe("rev 1 fix unit-auth-resource");
    expect(at(35)).toBe("rev 1 fix unit-auth-resource");
    expect(at(36)).toBe("none"); // auth pushes
    expect(at(47)).toBe("none"); // rev 2 lands
    expect(at(51)).toBe("rev 2 fix unit-auth-resource,unit-notifications-resource,unit-orders-resource,unit-users-resource");
    expect(at(54)).toBe("rev 2 fix unit-auth-resource,unit-notifications-resource,unit-orders-resource,unit-users-resource");
    expect(at(55)).toBe("rev 2 fix unit-auth-resource,unit-orders-resource,unit-users-resource");
    expect(at(56)).toBe("rev 2 fix unit-auth-resource,unit-orders-resource");
    expect(at(57)).toBe("rev 3 passed 1"); // rev 3 passes
    expect(at(60)).toBe("rev 3 passed 0.25");
    expect(at(61)).toBe("none");
  });

  it("a pass ends every request at once, before the engine completes the items", () => {
    const sf21 = recorded("board-live-sf21");
    expect(outstandingFixLinks(buildBoardGraph(sf21, 108), sf21)).toBeNull();
  });

  it("card tags: the latest failing revision's open requests are current (red), older unanswered ones read as history, none after a pass", () => {
    const sf21 = recorded("board-live-sf21");
    const state = (k: number) =>
      [...fixAskState(buildBoardGraph(sf21, k), sf21).entries()].map(([item, s]) => `${item}:${s.n}:${s.state}`).sort();
    expect(state(63)).toEqual(["payments:2:open", "refunds:2:open"]);
    expect(state(64)).toEqual(["payments:2:superseded", "refunds:2:superseded"]);
    expect(state(75)).toEqual(["payments:2:superseded", "refunds:2:superseded", "tax:4:open"]);
    expect(state(108)).toEqual([]);
    const html = (k: number) => renderToStaticMarkup(createElement(MissionControl, { log: sf21, escalations: [], busy: false, onResolve: () => {}, recorded: true, initialSeq: k }));
    const at64 = html(64);
    expect(at64).not.toContain("fix asked (rev");
    expect(at64).toContain('class="mc-tag is-history"');
    expect(at64).not.toMatch(/aria-label="revision \d+ open fix requests"/);
    expect(at64).not.toMatch(/class="mc-hull-status"[^>]*>[^<]*\/ fix/);
    const at63 = html(63);
    expect(at63).toContain("fix asked (rev 2)");
    expect(at63).toContain('aria-label="revision 2 open fix requests"');
    const at108 = html(108);
    expect(at108).toContain('aria-label="revision 6 passed"');
    expect(at108).toContain(">PASS</text>");
    expect(at108).not.toContain("fix asked (rev");
    expect(at108).not.toContain('class="mc-tag is-history"');
  });

  it("a selected revision is drawn at the seq it was selected at", () => {
    const sf21 = recorded("board-live-sf21");
    const html = renderToStaticMarkup(
      createElement(MissionControl, { log: sf21, escalations: [], busy: false, onResolve: () => {}, recorded: true, initialSeq: 64, initialSelection: { kind: "node", id: "rev:2" } }),
    );
    expect(html).toContain('aria-label="revision 2 links"');
  });
});

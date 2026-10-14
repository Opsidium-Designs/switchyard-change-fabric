/**
 * The integration marker (integration.started / integration.phase): while a
 * round is open at the cursor, the graph draws a pulsing "integrating revision
 * N" marker with its phase and backed lines from the items it gates, the
 * legend lists them, and the narrator and the STORY strip say "Integrating
 * revision N (phase)"; the revision clears it. A log without progress records
 * renders as before. Offline.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { FixtureBoard, missionControlLog } from "../../../packages/orchestration/tests/board-graph-fixture.ts";
import { buildReplayFile } from "../scripts/replay-export.ts";
import { integratingLine, integrationMarkerLayout, integrationSummary, openIntegrationRound, waitingOnHumans } from "../src/integration-marker.tsx";
import { MissionControl } from "../src/mission-control.tsx";
import { narrateMessage } from "../src/narration.ts";

/** A board with two pushes in an open integration round at its gate, then the revision that closes it. */
function roundLog(): { log: BoardMessage[]; started: number; gate: number; rev: number } {
  const b = new FixtureBoard();
  b.human({ type: "goal.posted", payload: { objective: "guard the routes", rules: { arbitration: 7 } } });
  b.join("lead", "lead");
  b.join("ag-1", "worker");
  b.join("ag-2", "worker");
  for (const item of ["users", "orders", "search"]) {
    b.agent("lead", { type: "item.proposed", payload: { item, objective: `guard ${item}`, acceptance: ["400 on bad input"], scopeHint: [`src/${item}.js`] } });
  }
  b.agent("ag-1", { type: "item.claimed", payload: { item: "users", intent: { read: [], write: ["src/users.js"] } } });
  b.agent("ag-2", { type: "item.claimed", payload: { item: "orders", intent: { read: [], write: ["src/orders.js"] } } });
  const p1 = b.agent("ag-1", { type: "push.announced", payload: { item: "users", commit: "c1", paths: ["src/users.js"] } })[0]!.seq;
  const p2 = b.agent("ag-2", { type: "push.announced", payload: { item: "orders", commit: "c2", paths: ["src/orders.js"] } })[0]!.seq;
  const started = b.record("integration.started", { kind: "integrate", pushes: [p1, p2], agents: ["ag-1", "ag-2"], items: ["users", "orders"] })[0]!.seq;
  b.record("integration.phase", { started, phase: "fetch", elapsedMs: 0 });
  const gate = b.record("integration.phase", { started, phase: "gate", detail: "npm run gate", elapsedMs: 42000 })[0]!.seq;
  const rev = b.rev({ commit: "r1", gate: "fail", merged: ["c1", "c2"], failing: { output: "users: 400 expected", items: ["users"] } })[0]!.seq;
  return { log: b.log, started, gate, rev };
}

const render = (log: readonly BoardMessage[], initialSeq: number) =>
  renderToStaticMarkup(createElement(MissionControl, { log: [...log], escalations: [], busy: false, onResolve: () => {}, initialSeq }));

describe("the integration marker", () => {
  it("is shown while the round is open: marker, phase, backed lines, legend, narrator, and the story strip", () => {
    const { log, started, gate } = roundLog();
    const html = render(log, gate);
    expect(html).toContain('class="mc-integrating"');
    expect(html).toContain(`data-round="${started}"`);
    expect(html).toContain("integrating revision 1");
    expect(html).toContain("running the gate: npm run gate");
    // One dashed line per drawn item the round names, each backed by the round's record.
    expect(html).toContain('data-item="users"');
    expect(html).toContain('data-item="orders"');
    expect(html).not.toContain('data-item="search"');
    expect(html).toContain(`(seq ${started}, integration.started)`);
    // The legend lists the lines while they are drawn.
    const legend = html.slice(html.indexOf('aria-label="Board legend"'));
    expect(legend).toContain('data-legend="integrating"');
    expect(legend).toContain("pushes being integrated");
    // The narrator and the current chapter say what is happening instead of silence.
    expect(html).toMatch(/class="mc-seq-link mc-narr-integrating"[^>]*>Integrating revision 1 \(running the gate: npm run gate\)</);
    expect(html).toContain('<span class="mc-chapter-integrating">Integrating revision 1 (running the gate: npm run gate)</span>');
    // The pushes the round gates wait for its revision's gate.
    expect(html).toContain("waiting for revision 1&#x27;s gate (running the gate: npm run gate)");
  });

  it("is cleared by the revision that closes the round", () => {
    const { log, rev } = roundLog();
    const html = render(log, rev);
    expect(html).not.toContain('class="mc-integrating"');
    expect(html).not.toContain("mc-narr-integrating");
    expect(html).not.toContain("mc-chapter-integrating");
    expect(html.slice(html.indexOf('aria-label="Board legend"'))).toContain('data-legend-absent="integrating"');
    expect(openIntegrationRound(log, rev)).toBeNull();
  });

  it("an older log with no progress records renders exactly as before (no marker, no line, no narrator note)", () => {
    const log = missionControlLog();
    const html = render(log, log.at(-1)!.seq);
    expect(html).not.toContain("mc-integrating");
    expect(html).not.toContain("Integrating revision");
    expect(openIntegrationRound(log)).toBeNull();
  });

  it("keeps its label clear of what is already drawn, and draws lines only to drawn hulls", () => {
    const { log, gate } = roundLog();
    const anchor = { x: 900, y: 150 };
    const items = new Map([["users", { x: 100, y: 300, w: 200, h: 120 }]]);
    const bounds = { x: -16, y: -16, w: 1000, h: 800 };
    const free = integrationMarkerLayout({ log, k: gate, anchor, anchorTaken: false, items, occupied: [], bounds, boost: 1 })!;
    expect(free.at).toEqual(anchor);
    expect(free.lines.map((l) => l.item)).toEqual(["users"]);
    expect(free.label).not.toBeNull();
    // The first spot taken: the label moves; a revision drawn at the anchor moves the marker below it.
    const taken = integrationMarkerLayout({ log, k: gate, anchor, anchorTaken: true, items, occupied: [free.label!], bounds, boost: 1 })!;
    expect(taken.at.y).toBeGreaterThan(anchor.y);
    const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(taken.label === null || !overlap(taken.label, free.label!)).toBe(true);
    expect(integratingLine(free.round)).toBe("Integrating revision 1 (running the gate: npm run gate)");
  });
});

describe("a run waiting on a person", () => {
  it("the narrator says 'Waiting on you: N decision' while the decisions run.waiting names are pending, and stops once they are decided", () => {
    const b = new FixtureBoard();
    b.human({ type: "goal.posted", payload: { objective: "o", protected: ["gate/gate.test.mjs"], rules: { arbitration: 7 } } });
    b.join("lead", "lead");
    b.join("ag-1", "worker");
    b.human({ type: "item.proposed", payload: { item: "g", objective: "update the gate test", scopeHint: ["gate/**"] } });
    b.agent("ag-1", { type: "contract.proposed", payload: { contract: "k1", target: "gate/gate.test.mjs", kind: "modify", item: "g" } });
    const escalatedSeq = b.lastSeqOf("contract.escalated");
    const waitSeq = b.record("run.waiting", { contracts: ["k1"], contests: [], waitedMs: 180000 })[0]!.seq;
    const html = render(b.log, waitSeq);
    expect(html).toMatch(/class="mc-seq-link mc-narr-waiting"[^>]*>Waiting on you: 1 decision</);
    expect(waitingOnHumans(b.log, waitSeq)).toMatchObject({ seq: waitSeq, count: 1, names: ["contract k1"] });
    const said = narrateMessage(b.log.find((m) => m.seq === waitSeq)!, b.log, () => "");
    expect(said.text).toBe("The board is quiet, but the run is waiting on you: 1 decision (contract k1). It waits until its time limit, not stuck.");
    expect(said.causes).toEqual([escalatedSeq]);
    // Decided: the line is gone at once (the next record is not needed).
    const decided = b.human({ type: "contract.accepted", payload: { contract: "k1" } })[0]!.seq;
    expect(render(b.log, decided)).not.toContain("mc-narr-waiting");
    expect(waitingOnHumans(b.log, decided)).toBeNull();
    // Before the record, nothing is claimed.
    expect(waitingOnHumans(b.log, waitSeq - 1)).toBeNull();
  });
});

describe("integration progress in the THREAD and the export", () => {
  it("narrates both records, citing the pushes and the round", () => {
    const { log, started, gate } = roundLog();
    const fallback = () => "";
    const s = narrateMessage(log.find((m) => m.seq === started)!, log, fallback);
    expect(s.text).toBe("The integrator starts on revision 1 with 2 pushes from 2 agent(s). Nothing is decided until its gate runs.");
    expect(s.causes).toEqual([started - 2, started - 1]);
    const g = narrateMessage(log.find((m) => m.seq === gate)!, log, fallback);
    expect(g.text).toBe("The integrator runs the gate on the integrated tree (npm run gate) (42 s in).");
    expect(g.causes).toEqual([started]);
    expect(integrationSummary(log.find((m) => m.seq === gate)!)).toBe(`round seq ${started}: running the gate: npm run gate (42 s in)`);
    for (const m of log) expect(narrateMessage(m, log, fallback).text).not.toContain(String.fromCharCode(0x2014));
  });

  it("the replay export keeps the records as they are", () => {
    const { log } = roundLog();
    const file = buildReplayFile({ changeId: "board-progress", messages: log });
    expect(file.messages.filter((m) => m.type.startsWith("integration."))).toEqual(log.filter((m) => m.type.startsWith("integration.")));
  });
});

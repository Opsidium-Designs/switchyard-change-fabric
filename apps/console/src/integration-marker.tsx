/**
 * The integration marker: while an integration round is open at the cursor
 * (an integration.started that its revision, a speculative candidate, a
 * recorded regression, or its own `ended` phase has not closed yet), the
 * graph shows a pulsing neutral "integrating revision N" marker at the
 * revision anchor with the round's current phase, and dashed lines from the
 * items whose pushes the round gates. Everything drawn is backed by the
 * round's integration.started (and its latest integration.phase): an old log
 * with no progress records draws nothing here.
 */
import {
  integrationPhaseLine,
  openIntegrationRound,
  type BoardMessage,
  type OpenIntegrationRound,
} from "@switchyard-change/orchestration/board-graph";

import { commCurve, placeLabel, type LabelRect } from "./board-overlay";

export { openIntegrationRound, type OpenIntegrationRound };

/** "Integrating revision 7 (running the gate)": the narrator's and the story strip's line. */
export function integratingLine(round: OpenIntegrationRound): string {
  return `Integrating revision ${round.n} (${round.line})`;
}

/** The one-line summary of an integration progress record (the thread's rows). */
export function integrationSummary(message: BoardMessage): string | undefined {
  if (message.type === "integration.started") {
    const p = message.payload;
    return `${p.kind} round on ${p.pushes.length} push(es) of ${p.agents.length} agent(s)${p.candidates !== undefined ? `, up to ${p.candidates} candidate(s)` : ""} (progress only)`;
  }
  if (message.type === "run.waiting") {
    const p = message.payload;
    const named = [...p.contracts.map((c) => `contract ${c}`), ...p.contests.map((c) => `contest ${c}`)];
    return `waiting on ${named.length} human decision(s): ${named.join(", ")}${p.waitedMs !== undefined ? ` (quiet ${Math.round(p.waitedMs / 1000)} s)` : ""}`;
  }
  if (message.type === "integration.phase") {
    const p = message.payload;
    return `round seq ${p.started}: ${p.phase === "ended" ? `ended${p.detail !== undefined ? `: ${p.detail}` : ""}` : integrationPhaseLine(p)}${p.elapsedMs !== undefined ? ` (${Math.round(p.elapsedMs / 1000)} s in)` : ""}`;
  }
  return undefined;
}

/**
 * The run waiting on a person at K: the latest run.waiting at or before K,
 * keeping only the decisions it names that are still undecided at K (a
 * contract.accepted / contract.rejected, or a claim.resolved of the contest,
 * decides one). Null when none is left. Read from the log only.
 */
export function waitingOnHumans(log: readonly BoardMessage[], k: number): { readonly seq: number; readonly count: number; readonly line: string; readonly names: readonly string[] } | null {
  let latest: Extract<BoardMessage, { type: "run.waiting" }> | undefined;
  for (const m of log) {
    if (m.seq > k) break;
    if (m.type === "run.waiting") latest = m;
  }
  if (!latest) return null;
  const decidedContracts = new Set<string>();
  const decidedContests = new Set<string>();
  for (const m of log) {
    if (m.seq > k) break;
    if (m.seq <= latest.seq) continue;
    if (m.type === "contract.accepted" || m.type === "contract.rejected") decidedContracts.add(m.payload.contract);
    if (m.type === "claim.resolved") decidedContests.add(m.payload.contest);
  }
  const names = [
    ...latest.payload.contracts.filter((c) => !decidedContracts.has(c)).map((c) => `contract ${c}`),
    ...latest.payload.contests.filter((c) => !decidedContests.has(c)).map((c) => `contest ${c}`),
  ];
  if (names.length === 0) return null;
  return { seq: latest.seq, count: names.length, names, line: `Waiting on you: ${names.length} decision${names.length === 1 ? "" : "s"}` };
}

/** How far below the anchor the marker sits when a revision is already drawn there. */
export const INTEGRATION_BELOW_ANCHOR = 66;
const MARKER_R = 14;
/** The phase line is cut to this many characters on the graph (the tooltip has it whole). */
const PHASE_CHARS = 46;

/** The marker as drawn: where it is, its label (null when no free spot), and one line per drawn item. */
export interface IntegrationMarkerLayout {
  readonly round: OpenIntegrationRound;
  readonly at: { readonly x: number; readonly y: number };
  readonly title: string;
  readonly phase: string;
  readonly label: LabelRect | null;
  /** The baselines of the label's two lines (scaled with the text). */
  readonly textY: readonly [number, number];
  readonly lines: readonly { readonly item: string; readonly d: string }[];
  /** What other labels must keep clear of (the marker and its label). */
  readonly boxes: readonly LabelRect[];
  readonly tooltip: string;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Lay out the marker for the round open at K (null when none is open). It
 * sits at the revision anchor, or just below it when a revision is drawn
 * there; its two-line label takes the first spot clear of `occupied` (left of
 * the marker, then below, then above), else none. A line runs from the top of
 * each drawn hull whose item the round names. Pure.
 */
export function integrationMarkerLayout(input: {
  readonly log: readonly BoardMessage[];
  readonly k: number;
  readonly anchor: { readonly x: number; readonly y: number };
  /** True when a revision is already drawn at the anchor. */
  readonly anchorTaken: boolean;
  readonly items: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>;
  readonly occupied: readonly LabelRect[];
  readonly bounds: LabelRect;
  readonly boost: number;
}): IntegrationMarkerLayout | null {
  const round = openIntegrationRound(input.log, input.k);
  if (!round) return null;
  const at = { x: input.anchor.x, y: input.anchor.y + (input.anchorTaken ? INTEGRATION_BELOW_ANCHOR : 0) };
  const title = `integrating revision ${round.n}`;
  const phase = cut(round.line, PHASE_CHARS);
  const size = { w: Math.max(title.length, phase.length) * 7.2 * input.boost + 16, h: 2 * 15 * input.boost + 8 };
  const markerBox = { x: at.x - MARKER_R - 4, y: at.y - MARKER_R - 4, w: 2 * MARKER_R + 8, h: 2 * MARKER_R + 8 };
  const candidates = [
    { x: at.x - MARKER_R - 10 - size.w / 2, y: at.y },
    { x: at.x - size.w / 2 + MARKER_R, y: at.y + MARKER_R + 8 + size.h / 2 },
    { x: at.x - MARKER_R - 10 - size.w / 2, y: at.y + size.h },
    { x: at.x - size.w / 2 + MARKER_R, y: at.y - MARKER_R - 8 - size.h / 2 },
  ];
  const label = placeLabel(size, candidates, [...input.occupied, markerBox], { bounds: input.bounds, gap: 3 });
  const lines = round.items.flatMap((item) => {
    const rect = input.items.get(item);
    if (!rect) return [];
    return [{ item, d: commCurve({ x: rect.x + rect.w / 2, y: rect.y }, at, -0.12, MARKER_R + 4).d }];
  });
  const kind = round.kind === "integrate" ? "every pending push as one revision" : round.kind === "leave-one-out" ? "the pre-pass leave-one-out ratchet" : `speculative, up to ${round.candidates ?? "?"} candidate(s)`;
  const tooltip =
    `Integrating revision ${round.n} (${kind}): ${round.line}. ` +
    `${round.pushes.length} push(es) of ${round.agents.join(", ")} (items ${round.items.join(", ")}). ` +
    `Progress only: the gate on the integrated tree decides. (seq ${round.seq}, integration.started${round.phase ? `; seq ${round.phase.seq}, integration.phase` : ""})`;
  const textY: [number, number] = label ? [label.y + 4 + 12 * input.boost, label.y + 4 + 27 * input.boost] : [0, 0];
  return { round, at, title, phase, label, textY, lines, boxes: [markerBox, ...(label ? [label] : [])], tooltip };
}

/** The marker, its label, and its lines (each a click to the round's thread). */
export function IntegrationMarker({ layout, onSelectSeq }: { layout: IntegrationMarkerLayout; onSelectSeq: (seq: number) => void }) {
  const { at, label } = layout;
  const select = () => onSelectSeq(layout.round.phase?.seq ?? layout.round.seq);
  return (
    <g className="mc-integrating" aria-label={`integrating revision ${layout.round.n}: ${layout.round.line}`} data-round={layout.round.seq}>
      {layout.lines.map((line) => (
        <g key={line.item} className="mc-edge mc-integrating-line" data-item={line.item} onClick={select}>
          <path d={line.d} />
          <title>{`${line.item}'s push is in revision ${layout.round.n}'s integration round (seq ${layout.round.seq}, integration.started)`}</title>
        </g>
      ))}
      <g className="mc-integrating-mark" style={{ transform: `translate(${at.x}px, ${at.y}px)` }} onClick={select} role="button" tabIndex={0}>
        <circle className="mc-integrating-ring" r={MARKER_R} />
        <text className="mc-node-label is-center" textAnchor="middle" y={5}>
          {layout.round.n}
        </text>
        <title>{layout.tooltip}</title>
      </g>
      {label ? (
        <g className="mc-integrating-label" onClick={select}>
          <rect x={label.x} y={label.y} width={label.w} height={label.h} rx={6} />
          <text x={label.x + 8} y={layout.textY[0]}>
            {layout.title}
          </text>
          <text className="mc-integrating-phase" x={label.x + 8} y={layout.textY[1]}>
            {layout.phase}
          </text>
          <title>{layout.tooltip}</title>
        </g>
      ) : null}
    </g>
  );
}

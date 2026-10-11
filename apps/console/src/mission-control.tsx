import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  aggregateMessageEdges,
  boardCaptions,
  boardJumpTargets,
  boardLayout,
  boardMessageFamily,
  boardNodePoint,
  boardThread,
  buildBoardGraph,
  HULL_MAX_AGENTS,
  HULL_TITLE_H,
  ratchetLine,
  revVerdictLabel,
  type BoardGraphEdge,
  type BoardGraphModel,
  type BoardGraphNode,
  type BoardLayout,
  type BoardMessage,
  type BoardMessageFamily,
  type BoardPoint,
  type BoardSelection,
  type BoardTicker,
} from "@switchyard-change/orchestration/board-graph";
import type { EscalationSnapshot } from "@switchyard-change/orchestration/graph-model";
import { buildProofBundle, type ProofBundle } from "@switchyard-change/orchestration/proof-bundle";

import {
  COMM_WINDOW,
  commCurve,
  commOpacity,
  communicationArrows,
  gateTimeline,
  jevRows,
  progressChart,
  revisionLinks,
  seriesStory,
  smartItemTitles,
  speculativeLanded,
  drawingExtent,
  type CommArrow,
  type GateMarker,
  type JevRow,
  type LandedPart,
  type ProgressChart,
  type SuiteSeries,
} from "./board-overlay";
import { IDENTITY_VIEW, shouldZoomOnWheel, zoomAt, type ViewTransform } from "./graph-interactions";
import { keyMoments, MOMENT_GROUPS, type MomentKind } from "./replay-data";

/**
 * Mission control: the console view for a BOARD run (agents that form around
 * a goal). Everything on screen is a projection of the board log the console
 * holds: `buildBoardGraph(log, K)` for the graph, the board columns, the
 * ticker, and the threads, and `boardLayout(log)` (from the FULL log) for
 * positions, so the replay scrubber at seq K shows exactly what the board had
 * recorded at K, and nothing moves while scrubbing unless its state changed.
 *
 * Honesty touches: tooltips end with their backing message (seq and type);
 * gate verdicts appear only on revision hexagons and the ticker; typed
 * decisions are grey "advisory" chips and a resolved attribution reads where
 * the pick landed, never "correct"; done.proposed is a hollow check until a
 * passing revision fills it; a revision that ran no gate reads "no gate:
 * nothing checked".
 */

/** A recorded escalation as the Worker reports it for a board Change. */
export interface BoardEscalationRecord extends EscalationSnapshot {
  readonly boardContest?: string;
  readonly boardContract?: string;
  /** The advisory triage line for a protected contract (the human decides). */
  readonly recommendation?: string;
}

/** One pinned escalation card. `id` is present only when it can be answered now. */
export interface EscalationCardData {
  readonly key: string;
  readonly id?: string;
  readonly kind: "contest" | "contract" | "other";
  readonly question: string;
  readonly options: readonly string[];
  readonly recommendation?: string;
  readonly seq?: number;
  readonly type?: string;
  /** Why it cannot be answered from here (replay, or no record yet). */
  readonly note?: string;
  /** A recorded run: the options are shown as text, never as buttons. */
  readonly recorded?: boolean;
}

const TRIAGE_SPLIT = "\nAdvisory triage";

/**
 * The escalation cards to pin: while following live, every pending record the
 * Worker reports (answerable), plus any escalation the log shows that has no
 * record yet; while replaying, the escalations pending at K (read-only).
 */
export function escalationCards(
  model: BoardGraphModel,
  records: readonly BoardEscalationRecord[],
  live: boolean,
  recorded = false,
): EscalationCardData[] {
  const out: EscalationCardData[] = [];
  const matched = new Set<string>();
  if (live && !recorded) {
    for (const record of records) {
      if (record.status !== "pending") {
        continue;
      }
      const ref = record.boardContest ?? record.boardContract;
      const fromLog = model.escalations.find((e) => e.ref === ref);
      if (fromLog) {
        matched.add(fromLog.ref);
      }
      const recommendation = record.recommendation ?? fromLog?.recommendation;
      out.push({
        key: `rec:${record.id}`,
        id: record.id,
        kind: record.boardContract !== undefined ? "contract" : record.boardContest !== undefined ? "contest" : "other",
        question: record.question.split(TRIAGE_SPLIT)[0] ?? record.question,
        options: record.options && record.options.length > 0 ? record.options : ["proceed"],
        ...(recommendation !== undefined ? { recommendation } : {}),
        ...(fromLog ? { seq: fromLog.seq, type: fromLog.kind === "contest" ? "claim.escalated" : "contract.escalated" } : {}),
      });
    }
  }
  for (const e of model.escalations) {
    if (matched.has(e.ref)) {
      continue;
    }
    out.push({
      key: `log:${e.seq}`,
      kind: e.kind,
      question: e.question,
      options: e.options,
      ...(e.recommendation !== undefined ? { recommendation: e.recommendation } : {}),
      seq: e.seq,
      type: e.kind === "contest" ? "claim.escalated" : "contract.escalated",
      ...(recorded ? { recorded: true } : {}),
      note: recorded
        ? "recorded run: this was decided (or left waiting) during the live run, not here"
        : live
          ? "waiting for the escalation record"
          : "replaying: answer from the live view",
    });
  }
  return out;
}

/**
 * Tick and chip colors per message family (decisions are grey: advisory), as
 * theme variables (styles.css defines each for the light and the dark theme).
 * Use them as CSS (`style`), never as SVG presentation attributes.
 */
export const FAMILY_COLORS: Record<BoardMessageFamily, string> = {
  goal: "var(--fam-goal)",
  item: "var(--fam-item)",
  claim: "var(--fam-claim)",
  contest: "var(--fam-contest)",
  rev: "var(--fam-rev)",
  contract: "var(--fam-contract)",
  decision: "var(--fam-decision)",
  tool: "var(--fam-tool)",
  agent: "var(--fam-agent)",
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** A one-line summary of a message's payload (typed fields, not free text). */
export function payloadSummary(message: BoardMessage): string {
  switch (message.type) {
    case "goal.posted":
      return message.payload.objective;
    case "item.proposed":
    case "item.discovered":
      return `${message.payload.item}: ${message.payload.objective}`;
    case "item.claimed":
      return `${message.payload.item} write ${message.payload.intent.write.join(", ") || "none"}${
        message.payload.intent.read.length > 0 ? ` read ${message.payload.intent.read.join(", ")}` : ""
      }`;
    case "claim.granted":
      return `${message.payload.item} to ${message.payload.agent}`;
    case "claim.contested":
      return `${message.payload.contest}: ${message.payload.claimant} vs ${message.payload.owner} on ${message.payload.overlap.join(", ")}`;
    case "claim.escalated":
      return `${message.payload.contest} to a human after ${message.payload.turns} turn(s) (${message.payload.reason})`;
    case "claim.resolved":
      return `${message.payload.contest}: ${message.payload.how}${message.payload.winner ? `, ${message.payload.winner} keeps it` : ""}`;
    case "push.announced":
      return `${message.payload.item} ${message.payload.commit.slice(0, 7)} ${message.payload.paths.join(", ")}`;
    case "integrated.rev":
      return `rev ${message.payload.n} ${revVerdictLabel(message.payload)}${
        message.payload.failing ? `: ${clip(message.payload.failing.output.split("\n")[0] ?? "", 90)}` : ""
      }`;
    case "help.requested":
      return `${message.payload.request} on ${message.payload.item}: needs ${message.payload.need}`;
    case "help.offered":
      return `offers help on ${message.payload.request}`;
    case "claim.kept":
      return `keeps its claim in ${message.payload.contest}`;
    case "claim.ceded":
      return `cedes in ${message.payload.contest}`;
    case "claim.narrowed":
      return `narrows to ${message.payload.write.join(", ")} in ${message.payload.contest}`;
    case "agent.joined":
      return message.payload.role !== undefined ? `joined as ${message.payload.role}` : "joined";
    case "agent.left":
      return "left";
    case "tool.proposed":
      return `${message.payload.kind} ${message.payload.capability}${message.payload.inputs.length > 0 ? ` over ${message.payload.inputs.join(", ")}` : " over the whole repo"}`;
    case "tool.built":
      return `${message.payload.capability} build ${message.payload.commit.slice(0, 10)}`;
    case "tool.gated":
      return `${message.payload.capability}: its own gate ${message.payload.passed ? "passed" : `failed (${message.payload.checks.filter((c) => !c.passed).map((c) => c.check).join(", ")})`}`;
    case "contract.accepted":
    case "contract.rejected":
      return message.payload.contract;
    case "rebase.needed":
      return `${message.payload.agent} onto rev ${message.payload.n}`;
    case "fix.requested":
      return `${message.payload.item}: fix attempt ${message.payload.attempt} for rev ${message.payload.n}`;
    case "done.proposed":
      return `${message.payload.item} (a proposal: done only on a passing revision)`;
    case "item.completed":
      return message.payload.via === "tool" ? `${message.payload.item}: its tool was published (v${message.payload.version})` : `${message.payload.item} at rev ${message.payload.n}`;
    case "contract.proposed":
    case "contract.escalated":
      return `${message.payload.contract}: ${message.payload.kind} ${message.payload.target}`;
    case "decision.recorded":
      return message.payload.error !== undefined
        ? `${message.payload.juncture}: call failed (${clip(message.payload.error, 60)})`
        : `${message.payload.juncture}: ${message.payload.answer ?? "no answer"}${
            message.payload.confidence !== undefined ? ` ${message.payload.confidence.toFixed(2)}` : ""
          }`;
    case "decision.resolved":
      return message.payload.outcome === "in-fixed-set"
        ? `Jev picked ${message.payload.answer}; ${message.payload.answer} changed before the next pass`
        : `Jev picked ${message.payload.answer}; ${message.payload.answer} did not change before the next pass`;
    case "tool.published":
      return `${message.payload.capability} v${message.payload.version} (verified by its own gate)${message.payload.joinsGate === false ? "; does not join the gate" : ""}`;
    case "tool.used":
      return `${message.payload.by} ran ${message.payload.capability} v${message.payload.version}${
        message.payload.changedFiles.length > 0
          ? `: changed ${message.payload.changedFiles.length} file(s)`
          : (message.payload.findings ?? []).length > 0
            ? `: ${(message.payload.findings ?? []).length} finding(s)`
            : ""
      }`;
    case "item.accepted":
      return `${message.payload.item} accepted onto the board`;
    case "item.rejected":
      return `${message.payload.item} rejected`;
    case "item.split":
      return `${message.payload.item} split into ${message.payload.children.map((c) => c.item).join(", ")}`;
    case "item.struggling":
      return `${message.payload.item} is going badly (${message.payload.reason}, ${message.payload.turnsSpent} turn(s)${
        message.payload.failedEdits > 0 ? `, ${message.payload.failedEdits} failed edit(s)` : ""
      }): idle agents may volunteer`;
    case "item.reopened":
      return `${message.payload.item} reopened for a different agent (was ${message.payload.previousOwner}${
        message.payload.n !== undefined ? `, failing rev ${message.payload.n}` : ""
      })`;
    case "help.volunteered":
      return `volunteers to help on ${message.payload.item}`;
    case "help.declined":
      return `declines ${message.payload.volunteer}'s help on ${message.payload.item}`;
    case "help.delivered":
      return `delivers ${message.payload.request}: ${message.payload.commit.slice(0, 7)} ${message.payload.paths.join(", ")}`;
    case "help.closed":
      return `${message.payload.request} closed (${message.payload.reason})`;
    case "handoff":
      return `hands ${message.payload.item} to ${message.payload.to}${message.payload.capsule.commit ? ` from ${message.payload.capsule.commit.slice(0, 7)}` : ""}`;
    case "seam.stalled":
      return `seam ${message.payload.item} stalled${message.payload.released ? ": released for another agent" : ""}`;
    case "claim.lapsed":
      return `${message.payload.agent}'s claim on ${message.payload.item} lapsed (${message.payload.reason}): open again`;
    case "candidate.gated":
      return `round ${message.payload.round} C${message.payload.index}/${message.payload.of} ${message.payload.commit.slice(0, 7)} (${message.payload.prefix
        .map((x) => x.items.join("+"))
        .join(" then ")}): gate ${message.payload.verdict}, ${message.payload.outcome}${message.payload.rev !== undefined ? ` (rev ${message.payload.rev})` : ""}${
        message.payload.blamed !== undefined ? `; blamed ${message.payload.blamed.join(", ")}` : ""
      }`;
    case "push.regressed":
      return `${message.payload.item} ${message.payload.commit.slice(0, 7)} made rev ${message.payload.rev} worse (better without it): not stacked until ${message.payload.agent} pushes again`;
    case "revision.promoted":
      return `rev ${message.payload.rev} promoted to ${message.payload.branch} (${message.payload.commit.slice(0, 7)}, gated ${message.payload.gatedCommit.slice(0, 7)})`;
    case "trunk.moved":
      return `the integration branch moved after rev ${message.payload.rev}: not advanced`;
    case "token.refreshed":
      return `${message.payload.agent}'s ${message.payload.kind} token refreshed (never shown)`;
    case "run.capped":
      return `${message.payload.kind} cap reached${message.payload.item !== undefined ? ` for ${message.payload.item}` : ""}: ${message.payload.used} of ${message.payload.limit}`;
    case "clash.predicted":
      return message.payload.status === "conflict"
        ? `${message.payload.a.item} and ${message.payload.b.item} would conflict on ${(message.payload.paths ?? []).join(", ")} (${message.payload.scope}; advisory)`
        : `${message.payload.a.item} and ${message.payload.b.item}: clash ${message.payload.status} (${clip(message.payload.reason ?? "", 60)})`;
    case "claim.overlap":
      return `${message.payload.item} overlaps ${message.payload.withAgent}'s ${message.payload.with} on ${message.payload.files.join(", ")} (advisory)`;
    case "item.replanned":
      return `${message.payload.item} re-planned (${message.payload.action}${message.payload.with !== undefined ? ` with ${message.payload.with}` : ""}) into ${message.payload.children.map((c) => c.item).join(", ")}`;
    case "item.escalated":
      return `${message.payload.item} failed again after the re-plan of ${message.payload.replanOf}: a human decides`;
    case "claim.extended":
      return `${message.payload.item}: deadline extended (${clip(message.payload.reason, 80)})`;
    case "fix.exhausted":
      return `${message.payload.item}: fix budget spent (${message.payload.attempts} attempt(s), rev ${message.payload.n})`;
    case "review.requested":
      return `${message.payload.review} on ${message.payload.item}`;
    case "review.result":
      return `${message.payload.review}: ${message.payload.findings.length} finding(s)`;
    default:
      return clip(JSON.stringify((message as BoardMessage).payload), 110);
  }
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

export function Ticker({
  ticker,
  live,
  k,
  lastSeq,
  recorded = false,
}: {
  ticker: BoardTicker;
  live: boolean;
  k: number;
  lastSeq: number;
  recorded?: boolean;
}) {
  const rev = ticker.rev;
  const gateClass = !rev ? "" : !rev.gated ? "is-nogate" : rev.gate === "pass" ? "is-pass" : "is-fail";
  return (
    <div className="mc-ticker" aria-label="Ticker">
      {/* A recorded run shows its full goal in the run header above. */}
      {recorded ? null : <span className="mc-goal" title={ticker.goalSeq !== undefined ? `${ticker.goal ?? ""} (seq ${ticker.goalSeq}, goal.posted)` : undefined}>
        {ticker.goal ?? "no goal posted yet"}
      </span>}
      {rev ? (
        <span className={`mc-rev-chip ${gateClass}`} title={`(seq ${rev.seq}, integrated.rev)`}>
          rev {rev.n} [{rev.label}]
          {rev.progress ? (
            <span className="mc-progress" title="advisory: parsed from the gate's output; the gate alone decides">
              {" "}
              {rev.progress.label}
              {rev.progress.delta !== undefined ? ` (${rev.progress.delta >= 0 ? "+" : ""}${rev.progress.delta})` : ""}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="mc-rev-chip">no integrated revision yet</span>
      )}
      {ticker.rebasing.length > 0 ? <span className="mc-rebasing">rebasing: {ticker.rebasing.join(", ")}</span> : null}
      <span className="mc-agents">
        {ticker.agents.active}/{ticker.agents.joined} agents
      </span>
      <span className="mc-items">
        {ticker.items.open} open, {ticker.items.claimed} claimed, {ticker.items.contested} contested, {ticker.items.done} done{ticker.items.proposed > 0 ? `, ${ticker.items.proposed} awaiting the lead` : ""}
      </span>
      <span className="mc-jev advisory">{ticker.jev.label}</span>
      {recorded ? (
        <span className="mc-replaying">
          recorded run: seq {k}/{lastSeq}
          {k >= lastSeq ? " (end)" : ""}
        </span>
      ) : !live ? (
        <span className="mc-replaying">
          replay: seq {k}/{lastSeq}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gate timeline and progress
// ---------------------------------------------------------------------------

const GATE_WORD: Record<GateMarker["verdict"], string> = { pass: "PASS", fail: "FAIL", "no-gate": "NO GATE" };

/**
 * The gate timeline: one marker per integrated revision at K (number, verdict,
 * acceptance count), beside the acceptance-over-revisions charts. Hovering or
 * selecting a marker draws that revision's links in the graph.
 */
export function GateStrip({
  markers,
  chart,
  focus,
  onHover,
  onSelect,
}: {
  markers: readonly GateMarker[];
  chart: ProgressChart;
  focus: number | null;
  onHover: (n: number | null) => void;
  onSelect: (n: number) => void;
}) {
  return (
    <div className="mc-gate" aria-label="Gate timeline">
      <span className="mc-gate-title" title="Every integrated revision; the gate on the integrated tree decides">
        GATE
      </span>
      {markers.length === 0 ? (
        <span className="muted mc-gate-empty">no integrated revision yet</span>
      ) : (
        <ol className="mc-gate-row">
          {markers.map((m) => (
            <li key={m.n}>
              <button
                type="button"
                className={`mc-gate-marker is-${m.verdict}${m.landed ? " is-landed" : ""}${focus === m.n ? " is-focus" : ""}`}
                aria-label={`revision ${m.n}: ${m.verdictLabel}${m.count ? `, ${m.count}` : ""}`}
                title={m.tooltip}
                onMouseEnter={() => onHover(m.n)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(m.n)}
                onBlur={() => onHover(null)}
                onClick={() => onSelect(m.n)}
              >
                <span className="mc-gate-n">r{m.n}</span>
                <span className="mc-gate-verdict">{GATE_WORD[m.verdict]}</span>
                {m.count ? (
                  <span className={`mc-gate-count${m.acceptanceNotRun !== undefined ? " is-gap" : ""}`}>{m.count}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}
      {chart.series.map((series) => (
        <SuiteChart key={series.suite} series={series} landed={chart.landed} focus={focus} />
      ))}
    </div>
  );
}

const CHART_W = 196;
const CHART_H = 52;

/**
 * One suite's count over revisions: a step line through the recorded counts,
 * a dashed line at the largest recorded total, a hollow gap marker where the
 * suite did not run (never a zero), the landed revision ringed, and
 * speculative candidates as small diamonds. Every mark cites its seq.
 */
export function SuiteChart({ series, landed, focus = null }: { series: SuiteSeries; landed?: number | undefined; focus?: number | null }) {
  const pad = { l: 6, r: 8, t: 6, b: 8 };
  const n = series.points.length;
  const step = n > 1 ? (CHART_W - pad.l - pad.r) / (n - 1) : 0;
  const xOf = (i: number) => (n > 1 ? pad.l + i * step : CHART_W / 2);
  const indexOf = new Map(series.points.map((p, i) => [p.n, i]));
  const total = Math.max(1, series.total);
  const yOf = (v: number) => pad.t + (1 - v / total) * (CHART_H - pad.t - pad.b);
  // The step line breaks at every gap.
  let d = "";
  let open = false;
  series.points.forEach((p, i) => {
    if (p.passed === undefined) {
      open = false;
      return;
    }
    const x = xOf(i).toFixed(1);
    const y = yOf(p.passed).toFixed(1);
    d += open ? ` H ${x} V ${y}` : ` M ${x} ${y}`;
    open = true;
  });
  const story = seriesStory(series);
  return (
    <figure className={`mc-chart suite-${series.suite}`} aria-label={`${series.suite} over revisions`}>
      <figcaption>
        <span className="mc-chart-name">{series.suite}</span> <span className="mc-chart-story">{story}</span>
        <span className="mc-chart-note" title="Counts are advisory, parsed from the gate's output; the gate alone decides">
          {" "}advisory
        </span>
      </figcaption>
      <svg className="mc-chart-svg" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`${series.suite}: ${story}`}>
        <line className="mc-chart-total" x1={pad.l} x2={CHART_W - pad.r} y1={yOf(total)} y2={yOf(total)}>
          <title>{`all ${series.total} checks of the ${series.suite} suite (the most recorded)`}</title>
        </line>
        <line className="mc-chart-base" x1={pad.l} x2={CHART_W - pad.r} y1={yOf(0)} y2={yOf(0)} />
        {focus !== null && indexOf.has(focus) ? (
          <line className="mc-chart-focus" x1={xOf(indexOf.get(focus)!)} x2={xOf(indexOf.get(focus)!)} y1={pad.t - 4} y2={CHART_H - 2} />
        ) : null}
        {d ? <path className="mc-chart-line" d={d.trim()} /> : null}
        {series.candidates.map((c) => {
          const i = indexOf.get(c.n);
          if (i === undefined) return null;
          const x = xOf(i) + 5 + c.index * 2;
          const y = yOf(c.passed);
          return (
            <polygon key={c.seq} className={`mc-chart-cand is-${c.verdict}`} points={`${x},${y - 3.5} ${x + 3.5},${y} ${x},${y + 3.5} ${x - 3.5},${y}`}>
              <title>{`speculative candidate C${c.index} (round ${c.round}): ${c.passed}/${c.total}, gate ${c.verdict}, ${c.outcome} (seq ${c.seq}, candidate.gated)`}</title>
            </polygon>
          );
        })}
        {series.points.map((p, i) =>
          p.passed === undefined ? (
            <rect key={p.seq} className="mc-chart-gap" x={xOf(i) - 3.5} y={yOf(0) - 7} width={7} height={7}>
              <title>{`rev ${p.n}: ${p.gap ?? "no count"} (seq ${p.seq}, integrated.rev)`}</title>
            </rect>
          ) : (
            <circle
              key={p.seq}
              className={`mc-chart-pt is-${p.verdict}${p.n === landed ? " is-landed" : ""}`}
              cx={xOf(i)}
              cy={yOf(p.passed)}
              r={p.n === landed ? 4.5 : 3}
            >
              <title>{`rev ${p.n}: ${series.suite} ${p.passed}/${p.total}, gate ${GATE_WORD[p.verdict]}${p.n === landed ? " (the passing revision)" : ""} (seq ${p.seq}, integrated.rev)`}</title>
            </circle>
          ),
        )}
      </svg>
    </figure>
  );
}

/**
 * The advisory decisions (Jev), grouped in a collapsible panel: type, what it
 * answered, its confidence, and the mechanical outcome once resolved. Grey and
 * italic, never styled like a verdict: they never change one.
 */
export function JevPanel({ rows, selected, onSelect }: { rows: readonly JevRow[]; selected: string | null; onSelect: (node: string) => void }) {
  if (rows.length === 0) return null;
  const confident = rows.filter((r) => r.confident).length;
  return (
    <details className="mc-jev-panel">
      <summary>
        Advisory decisions (Jev){" "}
        <span className="muted">
          {rows.length} recorded, {confident} confident; advisory only, never a verdict
        </span>
      </summary>
      <ol className="mc-jev-list">
        {rows.map((r) => (
          <li key={r.node}>
            <button type="button" className={`mc-jev-row${selected === r.node ? " is-selected" : ""}${r.error ? " is-error" : ""}`} onClick={() => onSelect(r.node)}>
              <span className="mc-jev-type">{r.juncture}</span>
              <span className="mc-jev-answer">
                {r.error ? "call failed" : `answer: ${r.recommendation}`}
                {r.confidence !== undefined ? ` (${r.confidence.toFixed(2)}${r.confident ? "" : ", not confident"})` : ""}
              </span>
              {r.about !== undefined ? <span className="mc-jev-about">on {r.about}</span> : null}
              {r.outcome !== undefined ? <span className="mc-jev-outcome">{r.outcome}</span> : null}
              <span className="mc-jev-seq">seq {r.seq}</span>
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Board pane
// ---------------------------------------------------------------------------

export function EscalationCard({
  card,
  busy,
  onResolve,
  onSelectSeq,
}: {
  card: EscalationCardData;
  busy: boolean;
  onResolve: (id: string, decision: string) => void | Promise<void>;
  onSelectSeq?: (seq: number) => void;
}) {
  const id = card.id;
  return (
    <div className="mc-escalation" role="group" aria-label="Pending human decision">
      <p className="mc-escalation-head">
        <strong>{card.recorded ? "Awaiting a human" : "Awaiting you"}</strong>{" "}
        <span className="muted">{card.kind === "contract" ? "contract change" : card.kind === "contest" ? "contest" : "decision"}</span>
        {card.seq !== undefined ? (
          <button type="button" className="mc-seq-link" onClick={() => onSelectSeq?.(card.seq!)}>
            seq {card.seq}, {card.type}
          </button>
        ) : null}
      </p>
      <p className="mc-escalation-question">{card.question}</p>
      {card.recommendation !== undefined ? (
        <p className="mc-recommendation">
          <span className="advisory">Jev recommends {card.recommendation}</span>{" "}
          <span className="mc-chip-advisory">advisory: you decide</span>
        </p>
      ) : null}
      {card.recorded ? (
        <p className="muted mc-escalation-options-text">options: {card.options.join(" / ")}</p>
      ) : (
      <div className="mc-escalation-options">
        {card.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={busy || id === undefined}
            onClick={() => {
              if (id !== undefined) {
                void onResolve(id, option);
              }
            }}
          >
            {option}
          </button>
        ))}
      </div>
      )}
      {card.note ? <p className="muted mc-escalation-note">{card.note}</p> : null}
    </div>
  );
}

function ItemCard({
  node,
  label,
  selected,
  onSelect,
  onSelectAgent,
}: {
  node: BoardGraphNode;
  label: string;
  selected: boolean;
  onSelect: () => void;
  onSelectAgent: (agent: string) => void;
}) {
  if (node.detail.kind !== "item") {
    return null;
  }
  const d = node.detail;
  return (
    <li className={`mc-card status-${node.status}${selected ? " is-selected" : ""}`} title={node.tooltip}>
      <button type="button" className="mc-card-main" onClick={onSelect}>
        <span className="mc-card-title">
          <DoneMark completed={d.completed !== undefined} proposed={d.doneProposed} />
          {label}
        </span>
        <span className="mc-card-objective">{d.objective}</span>
      </button>
      <span className="mc-card-tags">
        {d.owner !== undefined ? (
          <button type="button" className="mc-agent-chip" onClick={() => onSelectAgent(d.owner!)}>
            {agentShortLabel(d.owner)}
          </button>
        ) : null}
        {d.claimant !== undefined ? (
          <button type="button" className="mc-agent-chip is-waiting" onClick={() => onSelectAgent(d.claimant!)}>
            {agentShortLabel(d.claimant)} waits
          </button>
        ) : null}
        {d.fixRequested !== undefined ? <span className="mc-tag is-fix">fix asked (rev {d.fixRequested})</span> : null}
        {d.fixExhausted ? <span className="mc-tag is-fix">fix budget spent</span> : null}
        {d.doneProposed && d.completed === undefined ? <span className="mc-tag">done proposed, unverified</span> : null}
        {d.status === "split" ? <span className="mc-tag">split</span> : null}
        {(d.clashes ?? []).map((c) => (
          <span key={c.seq} className={`mc-tag is-clash${c.scope === "shared" ? " is-shared" : ""}`} title={`clash prediction (advisory; the gate decides) (seq ${c.seq}, clash.predicted)`}>
            {c.status === "conflict" ? `clash with ${c.with}${c.scope === "shared" ? " (shared seam)" : ""}` : `clash with ${c.with}: ${c.status}`}
          </span>
        ))}
      </span>
      {d.wait !== undefined ? (
        <span className={`mc-card-wait is-${d.wait.kind}`} title="why it is waiting, derived from the board">
          {d.wait.line}
        </span>
      ) : null}
    </li>
  );
}

/** A filled check once a passing revision completed the item; a hollow one for a proposal only. */
function DoneMark({ completed, proposed }: { completed: boolean; proposed: boolean }) {
  if (completed) {
    return (
      <span className="mc-done is-filled" title="completed on a passing revision">
        {"✓"}
      </span>
    );
  }
  if (proposed) {
    return (
      <span className="mc-done is-hollow" title="done proposed: hollow until a passing revision merges it">
        {"✓"}
      </span>
    );
  }
  return null;
}

export function BoardPane({
  model,
  cards,
  selection,
  busy,
  onSelect,
  onResolve,
  log,
}: {
  model: BoardGraphModel;
  cards: readonly EscalationCardData[];
  selection: BoardSelection | null;
  busy: boolean;
  onSelect: (selection: BoardSelection) => void;
  onResolve: (id: string, decision: string) => void | Promise<void>;
  /** The board log: when given, seam and tool items read by their recorded origin. */
  log?: readonly BoardMessage[];
}) {
  const byItem = new Map(model.nodes.filter((n) => n.kind === "item").map((n) => [n.label, n]));
  const short = boardShortLabels([...byItem.keys()], { seeds: seedItemIds(model) });
  const labels = log ? smartItemTitles(boardPrefix(log, model.k), short) : short;
  const columns: [string, readonly string[]][] = [
    // Workers' proposals awaiting the lead: shown only while there are any.
    ...(model.columns.proposed.length > 0 ? ([["PROPOSED", model.columns.proposed]] as [string, readonly string[]][]) : []),
    ["CONTESTED", model.columns.contested],
    ["OPEN", model.columns.open],
    ["CLAIMED", model.columns.claimed],
    ["DONE", model.columns.done],
  ];
  // The pre-pass ratchet (arbitration revision 5): a count, never a verdict.
  const best = log ? ratchetLine(boardPrefix(log, model.k)) : undefined;
  return (
    <div className="mc-board" aria-label="Board">
      <h2>BOARD</h2>
      {best !== undefined ? (
        <p className="muted mc-ratchet" title="the best-scoring failing revision before the first pass: what new pushes are stacked on; it never moves the head or promotes">
          {best}
        </p>
      ) : null}
      {columns.map(([title, ids]) => (
        <section key={title} className={`mc-column col-${title.toLowerCase()}`}>
          <h3>
            {title} <span className="muted">{ids.length}</span>
          </h3>
          {title === "CONTESTED"
            ? cards.map((card) => (
                <EscalationCard
                  key={card.key}
                  card={card}
                  busy={busy}
                  onResolve={onResolve}
                  onSelectSeq={(seq) => onSelect({ kind: "seq", seq })}
                />
              ))
            : null}
          {ids.length === 0 && !(title === "CONTESTED" && cards.length > 0) ? <p className="muted mc-empty">none</p> : null}
          <ul className="mc-cards">
            {ids.map((id) => {
              const node = byItem.get(id);
              return node ? (
                <ItemCard
                  key={id}
                  node={node}
                  label={labels.get(id) ?? id}
                  selected={selection?.kind === "item" && selection.id === id}
                  onSelect={() => onSelect({ kind: "item", id })}
                  onSelectAgent={(agent) => onSelect({ kind: "agent", id: agent })}
                />
              ) : null;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export type MessageMode = "live" | "all" | "off";

function hexagon(r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

function pentagon(r: number): string {
  return Array.from({ length: 5 }, (_, i) => {
    const a = ((2 * Math.PI) / 5) * i - Math.PI / 2;
    return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

function triangle(r: number): string {
  return Array.from({ length: 3 }, (_, i) => {
    const a = ((2 * Math.PI) / 3) * i - Math.PI / 2;
    return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

function selectedNodeId(selection: BoardSelection | null, log: readonly BoardMessage[]): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case "item":
      return `item:${selection.id}`;
    case "agent":
      return `agent:${selection.id}`;
    case "node":
      return selection.id;
    case "seq": {
      const m = log.find((x) => x.seq === selection.seq);
      return m ? (m.from === "human" ? "human" : `agent:${m.from}`) : null;
    }
  }
}

/** Short planner prefixes dropped from item ids (`u-`, `unit-`, `item-`). */
const SHORT_ID_PREFIX = /^(?:unit|item|u)-(?=[A-Za-z0-9])/;

/**
 * Short display labels for item ids. Planner ids look like
 * `unit-users-auth-validate` or `u-users-validate-auth`: a short planner prefix
 * (`u-`, `unit-`, `item-`) is dropped, then the dash tokens every SEED item (the
 * planner's, `seeds`; default every id) shares at the start and the end, so
 * siblings read by what tells them apart. An id outside that shape (an
 * agent-proposed `agent-2-item-1`) never widens or blocks the commons and keeps
 * its own tokens. A label is never emptied, two ids never share a label, and a
 * long one is truncated; the full id stays in the tooltip and the detail pane.
 */
export function boardShortLabels(
  ids: readonly string[],
  options: { readonly max?: number; readonly seeds?: readonly string[] } = {},
): Map<string, string> {
  const max = options.max ?? 24;
  const strip = (id: string) => {
    const stripped = id.replace(SHORT_ID_PREFIX, "");
    return stripped === "" ? id : stripped;
  };
  const seeds = options.seeds ?? ids;
  const tokens = [...new Set(seeds.map(strip))].map((b) => b.split("-"));
  let common: { head: string[]; tail: string[] } = { head: [], tail: [] };
  if (tokens.length >= 2) {
    const shortest = Math.min(...tokens.map((t) => t.length));
    let prefix = 0;
    let suffix = 0;
    while (prefix < shortest - 1 && tokens.every((t) => t[prefix] === tokens[0]![prefix])) prefix += 1;
    while (
      suffix < shortest - prefix - 1 &&
      tokens.every((t) => t[t.length - 1 - suffix] === tokens[0]![tokens[0]!.length - 1 - suffix])
    )
      suffix += 1;
    common = { head: tokens[0]!.slice(0, prefix), tail: tokens[0]!.slice(tokens[0]!.length - suffix) };
  }
  const core = (id: string): string => {
    const base = strip(id);
    let t = base.split("-");
    const { head, tail } = common;
    if (head.length > 0 && t.length > head.length && head.every((h, i) => t[i] === h)) t = t.slice(head.length);
    if (tail.length > 0 && t.length > tail.length && tail.every((h, i) => t[t.length - tail.length + i] === h)) t = t.slice(0, t.length - tail.length);
    const label = t.join("-") || base;
    // A bare number (`unit-3` stripped to `3`) says nothing on its own: keep the id.
    return /^\d+$/.test(label) ? id : label;
  };
  const cores = ids.map(core);
  // Two ids reduced to one label keep their prefix-stripped ids instead, and
  // their full ids when even those collide.
  const tally = (labels: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const c of labels) counts.set(c, (counts.get(c) ?? 0) + 1);
    return counts;
  };
  const coreCounts = tally(cores);
  const stripped = ids.map((id, i) => ((coreCounts.get(cores[i]!) ?? 0) > 1 ? strip(id) : cores[i]!));
  const strippedCounts = tally(stripped);
  const out = new Map<string, string>();
  ids.forEach((id, i) => {
    const label = (strippedCounts.get(stripped[i]!) ?? 0) > 1 ? id : stripped[i]!;
    out.set(id, label.length > max ? `${label.slice(0, max - 3)}...` : label);
  });
  return out;
}

/**
 * The planner's seed items of a board model: items the lead (or a human)
 * proposed. Agent-proposed items are left out, so their ids never decide the
 * commons the short labels drop.
 */
export function seedItemIds(model: BoardGraphModel): string[] {
  const leads = new Set(["human", ...model.nodes.flatMap((n) => (n.detail.kind === "agent" && n.detail.role === "lead" ? [n.detail.agent] : []))]);
  // A tool's build item (`tool-<capability>`) is not a planner seed either, even when the lead files it.
  const toolItems = new Set(model.nodes.flatMap((n) => (n.detail.kind === "tool" ? [`tool-${n.detail.capability}`] : [])));
  return model.nodes.flatMap((n) => (n.detail.kind === "item" && leads.has(n.detail.proposedBy) && !toolItems.has(n.detail.item) ? [n.detail.item] : []));
}

/** The approximate advance of one character, as a fraction of the font size (monospace about 0.6). */
const CHAR_EM = 0.62;

/** Ellipsize `text` to fit `width` px at `fontPx` (an estimate by character advance; never empty). */
export function ellipsizeToWidth(text: string, width: number, fontPx: number): string {
  const fits = Math.max(1, Math.floor(width / (fontPx * CHAR_EM)));
  if (text.length <= fits) return text;
  return fits <= 3 ? text.slice(0, fits) : `${text.slice(0, fits - 3)}...`;
}

/** The base font sizes of a hull's title and its status badge (styles.css), before the zoom boost. */
export const HULL_TITLE_FONT = 15;
export const HULL_STATUS_FONT = 12;

/** The characters of a title that always fit (when it has them) before the status badge gets room. */
const HULL_TITLE_MIN_CHARS = 12;

/**
 * Lay out a hull's header: the title wins the space. The status is a badge at
 * the right of the bar, shown in full only when the title still keeps its first
 * 12 characters (all of a shorter one) beside it; otherwise the badge is hidden (the
 * hull's color, the board column, and the tooltip still carry the status), so
 * a zoomed-out graph reads `billing-tax`, not `bil... | cl...`. The title is
 * ellipsized to the width left of the badge, so the two never overlap.
 */
export function hullHeader(input: { readonly title: string; readonly status: string; readonly width: number; readonly boost?: number }): {
  readonly title: string;
  readonly status: string;
  readonly badge: { readonly x: number; readonly w: number };
  /** Below 1 when the title is set smaller to fit whole (never below HULL_TITLE_MIN_SCALE). */
  readonly scale?: number;
} {
  const boost = input.boost ?? 1;
  const pad = 14;
  const gap = 8;
  const inner = Math.max(0, input.width - pad * 2);
  const statusPx = HULL_STATUS_FONT * boost;
  const titleKeep = Math.ceil(Math.min(input.title.length, HULL_TITLE_MIN_CHARS) * HULL_TITLE_FONT * boost * CHAR_EM);
  const statusNeed = Math.ceil(input.status.length * statusPx * CHAR_EM + 14);
  const fits = input.status.length > 0 && inner - statusNeed - gap >= titleKeep;
  const badgeW = fits ? statusNeed : 0;
  const room = Math.max(0, inner - (fits ? badgeW + gap : 0));
  // A title a little too long is set smaller rather than cut (`billing-invoices`, not `billing-in...`).
  const need = input.title.length * HULL_TITLE_FONT * boost * CHAR_EM;
  // One unit of slack and a scale rounded down, so a title scaled to fit is never cut by a rounding step.
  const scale = need <= room || need === 0 ? 1 : Math.max(HULL_TITLE_MIN_SCALE, Math.floor((Math.max(0, room - 1) / need) * 1000) / 1000);
  return {
    title: ellipsizeToWidth(input.title, room, HULL_TITLE_FONT * boost * scale),
    status: fits ? input.status : "",
    badge: { x: input.width - pad - badgeW, w: badgeW },
    ...(scale < 1 ? { scale } : {}),
  };
}

/** The smallest a hull title is set (a fraction of its size) before it is ellipsized instead. */
export const HULL_TITLE_MIN_SCALE = 0.72;

/** A short agent label (live ids are `agent-N` and `lead`; anything long is truncated). */
export function agentShortLabel(id: string, max = 16): string {
  return id.length > max ? `${id.slice(0, max - 3)}...` : id;
}

export interface PlacedCaption {
  readonly seq: number;
  readonly text: string;
  /** Center x and the top of the caption box, in layout units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Place at most three captions above their senders: each starts just above its
 * node and moves up past any hull title bar or caption already placed (simple
 * vertical stacking), and stays inside the drawing horizontally.
 */
export function placeCaptions(
  captions: readonly { readonly seq: number; readonly node: string; readonly text: string }[],
  points: ReadonlyMap<string, BoardPoint>,
  layout: BoardLayout,
  scale = 1,
): PlacedCaption[] {
  const bars: Box[] = [...layout.items.values()].map((r) => ({ x: r.x, y: r.y, w: r.w, h: HULL_TITLE_H }));
  const placed: PlacedCaption[] = [];
  const h = 22 * scale;
  for (const caption of captions.slice(0, 3)) {
    const p = points.get(caption.node);
    if (!p) continue;
    const text = clip(caption.text, 44);
    const w = Math.max(60, text.length * 7 * scale + 18);
    const x = Math.min(Math.max(p.x, w / 2 + 4), layout.width - w / 2 - 4);
    let y = p.y - 26 * scale - h;
    for (let step = 0; step < 12; step += 1) {
      const box = { x: x - w / 2, y, w, h };
      const hit = [...bars, ...placed.map((c) => ({ x: c.x - c.w / 2, y: c.y, w: c.w, h: c.h }))].find((b) => overlaps(box, b));
      if (!hit) break;
      y = hit.y - h - 4;
    }
    placed.push({ seq: caption.seq, text, x, y: Math.max(2, y), w, h });
  }
  return placed;
}

export interface BoardGraphViewProps {
  readonly model: BoardGraphModel;
  readonly layout: BoardLayout;
  readonly selection: BoardSelection | null;
  readonly log: readonly BoardMessage[];
  readonly messageMode: MessageMode;
  /** Seqs that landed in the last few seconds (transient message edges). */
  readonly recentSeqs: ReadonlySet<number>;
  /** Captions to float over senders (newest first, at most three). */
  readonly captions: readonly { readonly seq: number; readonly node: string; readonly text: string }[];
  readonly onSelect: (selection: BoardSelection) => void;
  /** The communication overlay at K (annotations over the graph, never graph edges). */
  readonly arrows?: readonly CommArrow[];
  /** The revision whose links are drawn (hovered on the gate timeline, or selected). */
  readonly focusRev?: number | null;
}

/** Padding around the drawing inside the fitted viewBox. */
const FIT_PAD = 16;
/** Text never renders below its CSS size; it grows by at most this much when the drawing is scaled down. */
const MAX_TEXT_BOOST = 1.8;
/** Where a focused revision is drawn: above the hulls, at the right of the drawing. */
const REV_ANCHOR_Y = 122;

/** The text boost that keeps labels at their minimum on-screen size at a given drawing scale. */
export function textBoost(drawingScale: number): number {
  if (!Number.isFinite(drawingScale) || drawingScale <= 0) return 1;
  return Math.min(MAX_TEXT_BOOST, Math.max(1, 1 / drawingScale));
}

/**
 * The board graph. Revisions live on the gate timeline and advisory decisions
 * in their own panel, so the drawing holds the goal, the lead, the human, the
 * item hulls with their agents, the bench, and the tools; a revision is drawn
 * (with its merged-item and fix links) only while it is hovered on the
 * timeline or selected. Agent-to-agent communication is an overlay of short
 * curved arrows over the graph, derived from recorded messages, styled apart
 * from every graph edge.
 */
export function BoardGraphView({ model, layout, selection, log, messageMode, recentSeqs, captions, onSelect, arrows = [], focusRev = null }: BoardGraphViewProps) {
  const selected = selectedNodeId(selection, log);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const extent = drawingExtent(layout);
  const vbW = extent.width + 2 * FIT_PAD;
  const vbH = extent.height + 2 * FIT_PAD;

  // Track the pane size so labels keep a minimum on-screen size however the drawing is fitted.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = stage ? Math.min(stage.w / vbW, stage.h / vbH) : 1;
  const boost = textBoost(fit * view.k);

  // Pan/zoom (the same math as the run-live graph): alt + wheel zooms at the cursor, drag pans.
  const toSvg = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0, unit: 1 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x + FIT_PAD, y: p.y + FIT_PAD, unit: 1 / ctm.a };
  }, []);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!shouldZoomOnWheel(event)) return;
      event.preventDefault();
      const { x, y } = toSvg(event.clientX, event.clientY);
      setView((prev) => zoomAt(prev, x - FIT_PAD, y - FIT_PAD, event.deltaY));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toSvg]);
  const zoomBy = (factor: number) =>
    setView((prev) => zoomAt(prev, extent.width / 2, extent.height / 2, -Math.log(factor) / 0.0015));
  const choose = (next: BoardSelection) => {
    if (drag.current?.moved) return;
    onSelect(next);
  };

  // Collapse a hull past HULL_MAX_AGENTS unless it is selected or contested.
  const collapsed = new Set<string>();
  for (const node of model.nodes) {
    if (node.detail.kind === "item" && node.detail.agents.length > HULL_MAX_AGENTS && selected !== node.id && !node.detail.contested) {
      collapsed.add(node.detail.item);
    }
  }
  // The revision drawn now (only while focused), at its anchor above the hulls.
  const focusNode = focusRev !== null ? model.nodes.find((n) => n.id === `rev:${focusRev}`) : undefined;
  const revAnchor = { x: extent.width - 34, y: REV_ANCHOR_Y };
  const points = new Map<string, BoardPoint>();
  for (const node of model.nodes) {
    if (node.kind === "rev") {
      if (node === focusNode) points.set(node.id, revAnchor);
      continue;
    }
    if (node.kind === "jev") continue;
    const p = boardNodePoint(layout, node);
    if (!p) continue;
    if (node.detail.kind === "agent" && node.detail.hull !== undefined && collapsed.has(node.detail.hull)) {
      // A collapsed hull bundles its agents' edges at the hull center.
      const hull = layout.items.get(node.detail.hull)!;
      points.set(node.id, { x: hull.x + hull.w / 2, y: hull.y + hull.h / 2 });
    } else {
      points.set(node.id, p);
    }
  }
  const itemLabels = smartItemTitles(
    boardPrefix(log, model.k),
    boardShortLabels(
      model.nodes.filter((n) => n.kind === "item").map((n) => n.label),
      { seeds: seedItemIds(model) },
    ),
  );
  // Declared structure stays quiet: goal -> item edges show only for a selected
  // item; revision edges only for the focused revision (from the timeline).
  // This hides drawn lines; it never adds one.
  const onRevOrJev = (id: string) => id.startsWith("rev:") || id.startsWith("jev:");
  const persistent = model.edges.filter((e) => {
    if (e.kind === "message") return false;
    if (onRevOrJev(e.from) || onRevOrJev(e.to)) return false;
    if (e.kind !== "dependency") return true;
    const related = selected !== null && (e.from === selected || e.to === selected);
    if (e.from === "goal") return related;
    return true;
  });
  const revLinks = focusNode && focusNode.detail.kind === "rev" ? revisionLinks(model, focusNode.detail.n) : [];
  const messages = (
    messageMode === "off"
      ? []
      : messageMode === "all"
        ? aggregateMessageEdges(model.edges)
        : model.edges.filter((e) => e.kind === "message" && recentSeqs.has(e.seqs[e.seqs.length - 1]!))
  ).filter((e) => !onRevOrJev(e.from) && !onRevOrJev(e.to));
  const selectEdge = (edge: BoardGraphEdge) => choose({ kind: "seq", seq: edge.seqs[edge.seqs.length - 1]! });
  const placedCaptions = placeCaptions(captions, points, { ...layout, width: extent.width }, boost);
  const transformed = view.k !== 1 || view.tx !== 0 || view.ty !== 0;
  // Overlay marks on one sender stack upward, so two marks never sit on each other.
  const markSlots = new Map<string, number>();

  return (
    <div className="mc-graph-stage" ref={stageRef}>
      <div className="mc-zoom">
        <button type="button" onClick={() => zoomBy(1.25)} title="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(0.8)} title="Zoom out">
          -
        </button>
        <button type="button" onClick={() => setView(IDENTITY_VIEW)} disabled={!transformed} title="Fit the graph to the pane">
          Fit
        </button>
        <span className="muted">alt + scroll to zoom, drag to pan</span>
      </div>
      <svg
        ref={svgRef}
        className="mc-graph-svg"
        viewBox={`${-FIT_PAD} ${-FIT_PAD} ${vbW} ${vbH}`}
        role="img"
        aria-label="Board graph"
        preserveAspectRatio="xMidYMin meet"
        style={{ ["--mc-t" as string]: boost.toFixed(3) }}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty, moved: false };
        }}
        onMouseMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const dx = event.clientX - d.x;
          const dy = event.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          const { unit } = toSvg(event.clientX, event.clientY);
          setView((prev) => ({ ...prev, tx: d.tx + dx * unit, ty: d.ty + dy * unit }));
        }}
        onMouseUp={() => {
          // Let the click that ends a drag see `moved`, then clear it.
          setTimeout(() => {
            drag.current = null;
          }, 0);
        }}
        onMouseLeave={() => {
          drag.current = null;
        }}
      >
        <defs>
          <marker id="mc-talk-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="mc-talk-head" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.k})`}>
          {/* Item hulls. */}
          <g className="mc-hulls">
            {model.nodes
              .filter((n) => n.kind === "item")
              .map((node) => {
                if (node.detail.kind !== "item") return null;
                const d = node.detail;
                const rect = layout.items.get(d.item);
                if (!rect) return null;
                const isSel = selected === node.id;
                const statusText = `${node.status}${d.fixRequested !== undefined ? ` / fix ${d.fixAttempts}` : ""}`;
                const header = hullHeader({ title: itemLabels.get(d.item) ?? d.item, status: statusText, width: rect.w, boost });
                const inFocus = focusNode?.detail.kind === "rev" ? revLinks.some((e) => e.from === node.id || e.to === node.id) : false;
                return (
                  <g
                    key={node.id}
                    className={`mc-hull status-${node.status}${isSel ? " is-selected" : ""}${rect.parent !== undefined ? " is-nested" : ""}${inFocus ? " is-rev-focus" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`item ${d.item} (${node.status})`}
                    onClick={() => choose({ kind: "item", id: d.item })}
                  >
                    <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={16} />
                    <rect className="mc-hull-bar" x={rect.x} y={rect.y} width={rect.w} height={HULL_TITLE_H} rx={16} />
                    <text
                      className="mc-hull-title"
                      x={rect.x + 14}
                      y={rect.y + 22}
                      {...(header.scale !== undefined ? { style: { fontSize: `calc(15px * var(--mc-t, 1) * ${header.scale})` } } : {})}
                    >
                      {header.title}
                    </text>
                    {header.badge.w > 0 ? (
                      <>
                        <rect className="mc-hull-badge" x={rect.x + header.badge.x} y={rect.y + 7} width={header.badge.w} height={HULL_TITLE_H - 14} rx={9} />
                        <text className="mc-hull-status" x={rect.x + header.badge.x + header.badge.w / 2} y={rect.y + 21} textAnchor="middle">
                          {header.status}
                        </text>
                      </>
                    ) : null}
                    {d.completed !== undefined ? (
                      <circle className="mc-check is-filled" cx={rect.x + rect.w - 22} cy={rect.y + rect.h - 22} r={11} />
                    ) : d.doneProposed ? (
                      <circle className="mc-check is-hollow" cx={rect.x + rect.w - 22} cy={rect.y + rect.h - 22} r={11} />
                    ) : null}
                    {d.completed !== undefined || d.doneProposed ? (
                      <text className="mc-check-mark" x={rect.x + rect.w - 22} y={rect.y + rect.h - 17} textAnchor="middle">
                        {"✓"}
                      </text>
                    ) : null}
                    {d.struggling !== undefined ? (
                      <g className="mc-struggling">
                        <circle cx={rect.x + 18} cy={rect.y + rect.h - 20} r={10} />
                        <text x={rect.x + 18} y={rect.y + rect.h - 15} textAnchor="middle">
                          !
                        </text>
                        <title>{`struggling (${d.struggling.reason}, ${d.struggling.turnsSpent} turn(s)): idle agents may volunteer (seq ${d.struggling.seq}, item.struggling)`}</title>
                      </g>
                    ) : null}
                    {d.volunteers !== undefined && d.volunteers.length > 0 ? (
                      <text className="mc-volunteers" x={rect.x + 34} y={rect.y + rect.h - 15}>
                        {d.volunteers.map((v) => `${v.agent}${v.answer ? ` (${v.answer})` : " offered"}`).join(", ")}
                      </text>
                    ) : null}
                    {collapsed.has(d.item) ? (
                      <text className="mc-hull-count" x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + 12} textAnchor="middle">
                        {d.agents.length} agents
                      </text>
                    ) : null}
                    <title>{node.tooltip}</title>
                  </g>
                );
              })}
          </g>

          {/* Persistent edges: dependency, trigger, consumed-tool, contest. */}
          <g className="mc-edges">
            {persistent.map((edge) => {
              const a = points.get(edge.from);
              const b = points.get(edge.to);
              if (!a || !b) return null;
              const related = selected !== null && (edge.from === selected || edge.to === selected);
              return (
                <g
                  key={edge.id}
                  className={`mc-edge kind-${edge.kind}${edge.contest ? ` contest-${edge.contest}` : ""}${edge.label ? ` label-${edge.label}` : ""}${related ? " is-related" : ""}`}
                  onClick={() => selectEdge(edge)}
                >
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  {edge.label ? (
                    <text className="mc-edge-tag" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle">
                      {edge.label}
                    </text>
                  ) : null}
                  <title>{edge.tooltip}</title>
                </g>
              );
            })}
          </g>

          {/* The focused revision's own edges (merged items, fix asked), to the top of each hull. */}
          {focusNode && focusNode.detail.kind === "rev" ? (
            <g className={`mc-rev-focus status-${focusNode.status}`} aria-label={`revision ${focusNode.detail.n} links`}>
              {revLinks.map((edge) => {
                const item = (edge.from.startsWith("item:") ? edge.from : edge.to).slice("item:".length);
                const rect = layout.items.get(item);
                if (!rect) return null;
                const curve = commCurve(revAnchor, { x: rect.x + rect.w / 2, y: rect.y }, 0.12, 22);
                return (
                  <g key={edge.id} className={`mc-edge kind-${edge.kind} is-related`} onClick={() => selectEdge(edge)}>
                    <path d={curve.d} />
                    <title>{edge.tooltip}</title>
                  </g>
                );
              })}
              <g className={`mc-node kind-rev status-${focusNode.status}`} style={{ transform: `translate(${revAnchor.x}px, ${revAnchor.y}px)` }} onClick={() => choose({ kind: "node", id: focusNode.id })}>
                <polygon className="shape" points={hexagon(18)} />
                <text className="mc-node-label is-center" textAnchor="middle" y={5}>
                  {focusNode.detail.n}
                </text>
                <text className="mc-node-sub" textAnchor="end" x={-26} y={5}>
                  {focusNode.detail.verdictLabel}
                </text>
                <title>{focusNode.tooltip}</title>
              </g>
            </g>
          ) : null}

          {/* Message edges: transient (a dot travels and fades), all (aggregated), or off. */}
          <g className="mc-messages">
            {messages.map((edge) => {
              const a = points.get(edge.from);
              const b = points.get(edge.to);
              if (!a || !b) return null;
              return (
                <g
                  key={edge.id}
                  className={`mc-edge kind-message${messageMode === "live" ? " is-transient" : ""}`}
                  onClick={() => selectEdge(edge)}
                >
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  {messageMode === "live" ? (
                    <circle className="mc-msg-dot" r={6}>
                      <animateMotion dur="1.4s" fill="freeze" path={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} />
                    </circle>
                  ) : edge.count > 1 ? (
                    <text className="mc-edge-label" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle">
                      x{edge.count}
                    </text>
                  ) : null}
                  <title>{edge.tooltip}</title>
                </g>
              );
            })}
          </g>

          {/* Nodes (agents tween between hulls via a CSS transform transition). Revisions and decisions live outside the drawing. */}
          <g className="mc-nodes">
            {model.nodes
              .filter((n) => n.kind !== "item" && n.kind !== "rev" && n.kind !== "jev")
              .map((node) => {
                const p = points.get(node.id);
                if (!p) return null;
                if (node.detail.kind === "agent" && node.detail.hull !== undefined && collapsed.has(node.detail.hull)) {
                  return null;
                }
                const isSel = selected === node.id;
                return (
                  <g
                    key={node.id}
                    className={`mc-node kind-${node.kind} status-${node.status}${isSel ? " is-selected" : ""}${node.detail.kind === "agent" && node.detail.subLeadOf !== undefined && node.detail.hull !== undefined && node.detail.subLeadOf.includes(node.detail.hull) ? " is-sub-lead" : ""}`}
                    style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.kind} ${node.label} (${node.status})`}
                    onClick={() =>
                      choose(node.detail.kind === "agent" ? { kind: "agent", id: node.detail.agent } : { kind: "node", id: node.id })
                    }
                  >
                    <NodeShape node={node} />
                    <NodeLabel node={node} boost={boost} />
                    <title>{node.tooltip}</title>
                  </g>
                );
              })}
          </g>

          {/* The communication overlay: who addressed whom in the last few seqs (an annotation, not a graph edge). */}
          <g className="mc-talk" aria-label="Agent communication overlay">
            {arrows.map((arrow) => {
              const a = points.get(arrow.from);
              if (!a) return null;
              const b = arrow.to !== null ? points.get(arrow.to) : undefined;
              const opacity = commOpacity(arrow.age, COMM_WINDOW);
              const labelW = arrow.verb.length * 7.2 * boost + 12;
              const labelH = 17 * boost;
              if (!b || (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1)) {
                // No drawn target: a mark above the sender, stacked when it has several.
                const slot = markSlots.get(arrow.from) ?? 0;
                markSlots.set(arrow.from, slot + 1);
                const y = a.y - 30 - labelH - slot * (labelH + 3);
                return (
                  <g key={arrow.id} className="mc-talk-mark" style={{ opacity }} onClick={() => choose({ kind: "seq", seq: arrow.seq })}>
                    <rect x={a.x - labelW / 2} y={y} width={labelW} height={labelH} rx={labelH / 2} />
                    <text x={a.x} y={y + labelH * 0.72} textAnchor="middle">
                      {arrow.verb}
                    </text>
                    <title>{arrow.tooltip}</title>
                  </g>
                );
              }
              const curve = commCurve(a, b);
              return (
                <g key={arrow.id} className={`mc-talk-arrow${arrow.age === 0 ? " is-new" : ""}`} style={{ opacity }} onClick={() => choose({ kind: "seq", seq: arrow.seq })}>
                  <path d={curve.d} markerEnd="url(#mc-talk-head)" />
                  <rect x={curve.mid.x - labelW / 2} y={curve.mid.y - labelH / 2} width={labelW} height={labelH} rx={labelH / 2} />
                  <text x={curve.mid.x} y={curve.mid.y + labelH * 0.22} textAnchor="middle">
                    {arrow.verb}
                  </text>
                  <title>{arrow.tooltip}</title>
                </g>
              );
            })}
          </g>

          {/* Captions above the senders of newly landed messages (at most three, stacked clear of hull titles). */}
          <g className="mc-captions">
            {placedCaptions.map((c) => (
              <g key={c.seq} className="mc-caption" style={{ transform: `translate(${c.x}px, ${c.y}px)` }}>
                <rect x={-c.w / 2} y={0} width={c.w} height={c.h} rx={6} />
                <text textAnchor="middle" y={c.h * 0.7}>
                  {c.text}
                </text>
              </g>
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}

function NodeShape({ node }: { node: BoardGraphNode }) {
  switch (node.kind) {
    case "goal":
      return <polygon className="shape" points="0,-30 30,0 0,30 -30,0" />;
    case "lead":
      return <polygon className="shape" points={triangle(24)} />;
    case "rev":
      return <polygon className="shape" points={hexagon(24)} />;
    case "tool":
      return <rect className="shape" x={-17} y={-17} width={34} height={34} rx={4} />;
    case "jev":
      return <polygon className="shape" points={pentagon(12)} />;
    case "human":
      return <rect className="shape" x={-19} y={-19} width={38} height={38} rx={11} />;
    default:
      return <circle className="shape" r={17} />;
  }
}

function NodeLabel({ node, boost = 1 }: { node: BoardGraphNode; boost?: number }) {
  const d = node.detail;
  // Labels below a node move down as the text is boosted, so they never overlap it.
  const below = (r: number) => r + 15 * boost;
  if (d.kind === "rev") {
    return (
      <>
        <text className="mc-node-label is-center" textAnchor="middle" y={5}>
          {d.n}
        </text>
        <text className="mc-node-sub" textAnchor="start" x={32} y={5}>
          {d.verdictLabel}
          {d.progress
            ? d.progress.passed !== undefined
              ? ` ${d.progress.acceptance ? "acceptance " : ""}${d.progress.passed}/${d.progress.total}${d.progress.delta !== undefined ? ` (${d.progress.delta >= 0 ? "+" : ""}${d.progress.delta})` : ""}`
              : " acceptance did not run"
            : ""}
        </text>
      </>
    );
  }
  if (d.kind === "jev") {
    return (
      <text className="mc-node-chip advisory" textAnchor="start" x={20} y={4}>
        {d.juncture} (advisory)
      </text>
    );
  }
  if (d.kind === "tool") {
    return (
      <text className="mc-node-label" textAnchor="middle" y={below(17)}>
        {ellipsizeToWidth(d.capability, 180, 13 * boost)}
        {/* The use count on its own line, so neighbouring tools' labels never run together. */}
        {d.uses > 0 ? (
          <tspan className="mc-tool-uses" x={0} dy="1.2em">
            {` used x${d.uses}`}
          </tspan>
        ) : null}
      </text>
    );
  }
  if (d.kind === "goal") {
    return (
      <text className="mc-node-label" textAnchor="middle" y={below(30)}>
        {clip(d.objective, 44)}
      </text>
    );
  }
  if (d.kind === "human") {
    // Above the node: the goal's label runs along the top band below it.
    return (
      <text className="mc-node-label" textAnchor="middle" y={-(19 + 8)}>
        {d.pending.length > 0 ? `human: ${d.pending.length} waiting` : "human"}
      </text>
    );
  }
  return (
    <text className="mc-node-label" textAnchor="middle" y={node.kind === "lead" ? -(24 + 6) : below(17)}>
      {agentShortLabel(node.label)}
    </text>
  );
}

// ---------------------------------------------------------------------------
// Right pane: thread, node detail, tools
// ---------------------------------------------------------------------------

export type RightTab = "thread" | "node" | "tools" | "proof";

/**
 * The PROOF panel: what the board can prove about its final revision at seq K
 * (the full log at the live head), built from the log alone, so a recorded
 * run shows it the same way. Every line cites the board seq that backs it.
 */
export function ProofPanel({ bundle, onSelectSeq }: { bundle: ProofBundle; onSelectSeq: (seq: number) => void }) {
  const seq = (n: number | undefined) =>
    n === undefined ? null : (
      <button type="button" className="mc-seq-link" onClick={() => onSelectSeq(n)}>
        #{n}
      </button>
    );
  return (
    <div className="mc-proof" aria-label="Proof">
      <p className={`mc-proof-status is-${bundle.status}`}>
        {bundle.status === "proven" ? "PROVEN" : "NOT PROVEN"}
        {bundle.revision ? ` for revision ${bundle.revision.n} (${bundle.revision.commit.slice(0, 12)})` : ""} {seq(bundle.revision?.seq)}
      </p>
      {bundle.reasons.length > 0 ? (
        <ul className="mc-proof-reasons">
          {bundle.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <dl className="mc-proof-facts">
        <dt>gate</dt>
        <dd>
          {bundle.gate.command?.join(" ") ?? "no command recorded"}: {bundle.gate.verdict}
          {bundle.gate.gated ? "" : " (no gate ran)"}
        </dd>
        <dt>promoted</dt>
        <dd>
          {bundle.promotion ? (
            <>
              {bundle.promotion.branch} {bundle.promotion.commit.slice(0, 12)} from gated {bundle.promotion.gatedCommit.slice(0, 12)} (
              {bundle.promotion.matchesGated ? "the gated tree" : "NOT the gated tree"}) {seq(bundle.promotion.seq)}
            </>
          ) : (
            "not recorded"
          )}
        </dd>
        <dt>tests</dt>
        <dd>
          baseline {bundle.inventory.baseline?.count ?? "unknown"}; final{" "}
          {bundle.inventory.final
            ? `executed ${bundle.inventory.final.executed}${bundle.inventory.final.acceptance ? `, acceptance ${bundle.inventory.final.acceptance.passed}/${bundle.inventory.final.acceptance.total}` : ""}${bundle.inventory.final.developer ? `, developer ${bundle.inventory.final.developer.passed}/${bundle.inventory.final.developer.total}` : ""}`
            : "no count"}
        </dd>
        <dt>progress</dt>
        <dd>
          {bundle.progress.length > 0
            ? bundle.progress.map((p, i) => (
                <span key={p.seq}>
                  {i > 0 ? " -> " : ""}rev {p.n} {p.line} {seq(p.seq)}
                </span>
              ))
            : "none recorded"}
        </dd>
        {bundle.speculation ? (
          <>
            <dt>speculation</dt>
            <dd>
              round {bundle.speculation.round}:{" "}
              {bundle.speculation.candidates.map((c, i) => (
                <span key={c.seq}>
                  {i > 0 ? ", " : ""}C{c.index} {c.verdict} ({c.outcome}
                  {c.outcome === "landed" ? (bundle.speculation?.landed?.matchesRevision ? ", the gated commit" : ", NOT the gated commit") : ""}) {seq(c.seq)}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        <dt>merged</dt>
        <dd>
          {bundle.contributions.pushesMerged} push(es) from {bundle.contributions.agents.join(", ") || "nobody"};{" "}
          {bundle.contributions.items.filter((i) => i.status === "done").length} of {bundle.contributions.items.length} item(s) done
        </dd>
        <dt>contracts</dt>
        <dd>{bundle.contracts.length > 0 ? bundle.contracts.map((c) => `${c.contract} ${c.status}${c.decidedBy ? ` by ${c.decidedBy}` : ""}`).join("; ") : "none"}</dd>
        <dt>tools</dt>
        <dd>{bundle.tools.length > 0 ? bundle.tools.map((t) => `${t.capability} v${t.version} (${t.uses} use(s))`).join("; ") : "none"}</dd>
        <dt>decisions</dt>
        <dd>{bundle.decisions.length > 0 ? `${bundle.decisions.length} advisory (never part of the proof)` : "none"}</dd>
        <dt>human</dt>
        <dd>{bundle.human.length > 0 ? bundle.human.map((h) => `${h.ref}: ${h.decision}`).join("; ") : "none"}</dd>
        <dt>stalls</dt>
        <dd>
          {bundle.lapses.length} lapse(s), {bundle.replans.length} re-plan(s), {bundle.escalations.length} escalation(s), {bundle.clashes.length} clash prediction(s)
          {bundle.caps.length > 0 ? `, caps reached: ${bundle.caps.map((c) => c.kind).join(", ")}` : ""}
        </dd>
      </dl>
      {bundle.incompleteItems.length > 0 ? <p className="muted">not completed: {bundle.incompleteItems.join(", ")}</p> : null}
    </div>
  );
}

export function Thread({
  messages,
  title,
  selectedSeq,
  onSelectSeq,
  onSelectAgent,
}: {
  messages: readonly BoardMessage[];
  title: string;
  selectedSeq: number | null;
  onSelectSeq: (seq: number) => void;
  onSelectAgent: (agent: string) => void;
}) {
  return (
    <div className="mc-thread">
      <h3>
        {title} <span className="muted">({messages.length})</span>
      </h3>
      {messages.length === 0 ? <p className="muted">No messages yet.</p> : null}
      <ol className="mc-thread-list">
        {messages.map((m) => {
          const family = boardMessageFamily(m.type);
          return (
            <li key={m.seq} className={`mc-msg fam-${family}${selectedSeq === m.seq ? " is-selected" : ""}`}>
              <div className="mc-msg-head">
                <button type="button" className="mc-seq-link" onClick={() => onSelectSeq(m.seq)}>
                  seq {m.seq}
                </button>
                <button
                  type="button"
                  className={`mc-sender sender-${m.from === "engine" ? "engine" : m.from === "human" ? "human" : "agent"}`}
                  onClick={() => (m.from !== "engine" && m.from !== "human" ? onSelectAgent(m.from) : undefined)}
                >
                  {m.from}
                </button>
                <span className="mc-type" style={{ color: FAMILY_COLORS[family] }}>
                  {m.type}
                </span>
                {family === "decision" ? <span className="mc-chip-advisory">advisory</span> : null}
                {m.to && m.to.length > 0 ? <span className="muted">to {m.to.join(", ")}</span> : null}
                {m.inReplyTo !== undefined ? (
                  <button type="button" className="mc-seq-link" onClick={() => onSelectSeq(m.inReplyTo!)}>
                    re seq {m.inReplyTo}
                  </button>
                ) : null}
              </div>
              <div className="mc-msg-body">{payloadSummary(m)}</div>
              {m.rationale ? <q className="mc-rationale">{m.rationale}</q> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function BoardNodeDetail({ node, landed }: { node: BoardGraphNode; landed?: LandedPart | undefined }) {
  const d = node.detail;
  const row = (label: string, value: ReactNode) =>
    value === undefined || value === null || value === "" ? null : (
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    );
  const list = (values: readonly string[]) => (values.length === 0 ? "none" : values.join(", "));
  return (
    <div className="mc-detail">
      <h3>
        {node.label} <span className="muted">[{node.kind}]</span>
      </h3>
      <dl className="meta">
        {row("Status", node.status)}
        {row("Backed by", `seq ${node.seqs.join(", ")}`)}
        {d.kind === "goal" ? (
          <>
            {row("Protected (the contract)", list(d.protected))}
            {row("Baseline tests", d.testInventory ? `${d.testInventory.status}${d.testInventory.count !== undefined ? `, ${d.testInventory.count} test(s)` : ""}` : "not recorded")}
            {row("Contest turns", String(d.rules.maxContestTurns))}
          </>
        ) : null}
        {d.kind === "agent" ? (
          <>
            {row("Role", d.role ?? "worker")}
            {row("Holds", list(d.items))}
            {row("Rebase", d.rebasing ? `rebasing onto rev ${d.rebaseTo ?? "?"}` : d.rebaseTo !== undefined ? `last told rev ${d.rebaseTo}` : undefined)}
            {row("Left", d.left ? "yes" : undefined)}
          </>
        ) : null}
        {d.kind === "item" ? (
          <>
            {row("Objective", d.objective)}
            {row("Acceptance", list(d.acceptance))}
            {row("Scope hint", list(d.scopeHint))}
            {row("Owner", d.owner)}
            {row("Write intent", d.write.length > 0 ? d.write.join(", ") : undefined)}
            {row("Read intent", d.read.length > 0 ? d.read.join(", ") : undefined)}
            {row("Waiting claimant", d.claimant)}
            {row(
              "Done",
              d.completed !== undefined
                ? `completed at rev ${d.completed.n} (${d.completed.via})`
                : d.doneProposed
                  ? "proposed only: not done until a passing revision merges the owner's latest push"
                  : undefined,
            )}
            {row("Fix attempts", d.fixAttempts > 0 ? String(d.fixAttempts) : undefined)}
            {row("Last push", d.lastPush ? `${d.lastPush.commit.slice(0, 10)} by ${d.lastPush.agent}${d.lastPush.integratedIn !== undefined ? `, merged in rev ${d.lastPush.integratedIn}` : ", not yet merged by a passing revision"}` : undefined)}
          </>
        ) : null}
        {d.kind === "rev" ? (
          <>
            {row("Gate", d.verdictLabel)}
            {row("Commit", <code>{d.commit}</code>)}
            {row("Merged pushes", landed ? `${d.merged.length} (${landed.commits.length} already landed in rev ${landed.rev})` : String(d.merged.length))}
            {row(
              landed ? "Contributors to the failure" : "Contributors",
              list(landed ? d.contributors.filter((a) => !landed.agents.includes(a) || landed.failingAgents.includes(a)) : d.contributors),
            )}
            {landed ? row(`Landed in rev ${landed.rev}`, `${list(landed.items)}: passed in the round's landed candidate (seq ${landed.seq}, candidate.gated), not part of this failure`) : null}
            {row("Paths", list(d.paths))}
            {row("Dependency install", d.install)}
            {row("Implicated items", d.failing ? list(d.failing.items) : undefined)}
          </>
        ) : null}
        {d.kind === "tool" ? (
          <>
            {row("Kind", d.toolKind)}
            {row("Proposed by", d.proposedBy)}
            {row("Builder", d.builder ?? d.versions.at(-1)?.publishedBy)}
            {row("Inputs", d.inputs !== undefined ? (d.inputs.length > 0 ? list(d.inputs) : "the whole repository") : undefined)}
            {row("Published", d.published ? d.versions.map((v) => `v${v.version} by ${v.publishedBy} (used x${v.uses})`).join("; ") : "no: an unverified tool cannot be published")}
            {row("Usage", d.versions.at(-1)?.usage)}
            {row("Used by", d.users && d.users.length > 0 ? d.users.map((u) => `${u.agent} x${u.uses}`).join(", ") : undefined)}
            {row("Joins the gate", d.versions.some((v) => v.joinsGate === false) ? "no: a check tool does not join the gate in this slice" : undefined)}
          </>
        ) : null}
        {d.kind === "jev" ? (
          <>
            {row("Juncture", d.juncture)}
            {row("Answer", d.error !== undefined ? `call failed: ${d.error}` : (d.answer ?? "none"))}
            {row("Confidence", d.confidence !== undefined ? d.confidence.toFixed(2) : undefined)}
            {row("Used", d.accepted ? "confident (advisory)" : "not confident (advisory)")}
            {row("Outcome", d.resolved ? d.resolved.text : d.juncture === "attribution" ? "unresolved: no passing revision yet" : undefined)}
          </>
        ) : null}
        {d.kind === "human" ? row("Waiting", String(d.pending.length)) : null}
      </dl>
      {d.kind === "rev" && d.failing ? (
        <>
          <h4>Failing gate output</h4>
          <pre className="detail-pre">{d.failing.output}</pre>
        </>
      ) : null}
      {d.kind === "rev" && d.candidates && d.candidates.length > 0 ? (
        <>
          <h4>Speculative candidates</h4>
          <ol className="mc-candidates" aria-label="Speculative candidates">
            {d.candidates.map((c) => (
              <li key={c.seq} className={`mc-candidate is-${c.verdict}${c.rev === d.n ? " is-this" : ""}`} title={`seq ${c.seq}, candidate.gated`}>
                C{c.index} <code>{c.commit.slice(0, 10)}</code> {c.prefix}: {c.verdict.toUpperCase()}, {c.outcome}
                {c.rev !== undefined ? ` (rev ${c.rev})` : ""}
                {c.blamed !== undefined ? `; blamed ${c.blamed.join(", ")}` : ""}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {d.kind === "rev" && !d.gated ? (
        <p className="detail-warning">No gate ran on this revision: its pass checked nothing, so it is unverified.</p>
      ) : null}
      {d.kind === "tool" && d.gates && d.gates.length > 0 ? (
        <>
          <h4>Tool gate evidence</h4>
          {d.gates.map((g) => (
            <div key={g.seq}>
              <p className="muted">
                build {g.commit.slice(0, 10)}: {g.passed ? "passed" : "FAILED"} (seq {g.seq}, tool.gated)
              </p>
              <ul className="mc-tool-checks">
                {g.checks.map((c) => (
                  <li key={c.check} className={c.passed ? "is-pass" : "is-fail"}>
                    {c.check}: {c.passed ? "ok" : "FAIL"} - {c.detail}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : null}
      {d.kind === "jev" ? (
        <>
          <h4>Question</h4>
          <pre className="detail-pre">{d.question}</pre>
          <p className="muted advisory">
            Advisory only: a typed decision never changes arbitration, the gate verdict, or promotion.
            {d.resolved ? " The outcome says where the pick landed among items that changed before the next pass; it is not an accuracy measure." : ""}
          </p>
        </>
      ) : null}
      <p className="muted mc-backing">{node.tooltip}</p>
    </div>
  );
}

export function ToolsRegistry({ model }: { model: BoardGraphModel }) {
  const tools = model.nodes.filter((n) => n.kind === "tool");
  if (tools.length === 0) {
    return (
      <p className="muted mc-empty">
        No tools on the board yet. An agent proposes a tool, and it is published here only after it passes its own gate.
      </p>
    );
  }
  return (
    <table className="mc-tools">
      <thead>
        <tr>
          <th>Capability</th>
          <th>Version</th>
          <th>Kind</th>
          <th>Builder</th>
          <th>Tool gate</th>
          <th>Uses</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((node) => {
          const d = node.detail;
          if (d.kind !== "tool") {
            return null;
          }
          const latest = d.versions.at(-1);
          const gate = latest?.gateSeq !== undefined ? d.gates?.find((g) => g.seq === latest.gateSeq) : d.gates?.at(-1);
          return (
            <tr key={node.id} title={node.tooltip}>
              <td>
                <strong>{d.capability}</strong>
              </td>
              <td>{latest ? `v${latest.version}${latest.commit ? ` (${latest.commit.slice(0, 10)})` : ""}` : "unpublished"}</td>
              <td>{d.toolKind ?? "?"}</td>
              <td>{d.builder ?? latest?.publishedBy ?? d.proposedBy ?? "?"}</td>
              <td>
                {gate
                  ? `${gate.passed ? "passed" : "failed"}: ${gate.checks.map((c) => `${c.check} ${c.passed ? "ok" : "FAIL"}`).join(", ")} (seq ${gate.seq})`
                  : "not gated yet: an unverified tool cannot be published"}
              </td>
              <td>{d.users && d.users.length > 0 ? d.users.map((u) => `${u.agent} x${u.uses}`).join(", ") : "none"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export const REPLAY_SPEEDS = [1, 4, 16] as const;
/** Milliseconds per message at 1x. */
const REPLAY_BASE_MS = 600;

export function ReplayBar({
  log,
  k,
  live,
  playing,
  speed,
  recorded = false,
  onSeek,
  onLive,
  onPlay,
  onSpeed,
}: {
  log: readonly BoardMessage[];
  k: number;
  live: boolean;
  playing: boolean;
  speed: number;
  /** A recorded run: there is no live edge to follow, only the end of the log. */
  recorded?: boolean;
  onSeek: (k: number) => void;
  onLive: () => void;
  onPlay: () => void;
  onSpeed: (speed: number) => void;
}) {
  const lastSeq = log.length === 0 ? 0 : log[log.length - 1]!.seq;
  const jumps = useMemo(() => boardJumpTargets(log), [log]);
  const moments = useMemo(() => keyMoments(log), [log]);
  const ticks = useMemo(() => {
    const paths = new Map<BoardMessageFamily, string[]>();
    for (const m of log) {
      const f = boardMessageFamily(m.type);
      const list = paths.get(f) ?? [];
      list.push(`M${m.seq - 0.5} 0v10`);
      paths.set(f, list);
    }
    return [...paths.entries()];
  }, [log]);
  const next = (targets: readonly number[]) => targets.find((s) => s > k);
  const nextOf = (...kinds: MomentKind[]) => next(moments.filter((m) => kinds.includes(m.kind)).map((m) => m.seq));
  const nextContest = next(jumps.contests);
  const nextRev = next(jumps.revs);
  const nextClaim = nextOf("claim");
  const nextContract = nextOf("contract");
  const atMoment = moments.find((m) => m.seq === k);
  return (
    <div className="mc-replay" aria-label="Replay">
      <button type="button" className="mc-play" onClick={onPlay} disabled={lastSeq === 0}>
        {playing ? "Pause" : recorded && live ? "Play from start" : "Play"}
      </button>
      <span className="mc-speeds" role="group" aria-label="Replay speed">
        {REPLAY_SPEEDS.map((s) => (
          <button key={s} type="button" className={`mc-speed${speed === s ? " is-active" : ""}`} onClick={() => onSpeed(s)}>
            {s}x
          </button>
        ))}
      </span>
      <div className="mc-scrub">
        <svg className="mc-ticks" viewBox={`0 0 ${Math.max(1, lastSeq)} 10`} preserveAspectRatio="none" aria-hidden="true">
          {ticks.map(([family, d]) => (
            <path key={family} d={d.join("")} style={{ stroke: FAMILY_COLORS[family] }} strokeWidth={Math.max(0.4, lastSeq / 600)} />
          ))}
        </svg>
        <input
          type="range"
          min={0}
          max={lastSeq}
          value={k}
          aria-label="Replay seq"
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </div>
      <span className="mc-seq">
        seq {k}/{lastSeq}
      </span>
      <select
        className="mc-moments"
        aria-label="Jump to a key moment"
        value={atMoment ? String(atMoment.seq) : ""}
        onChange={(event) => {
          const seq = Number(event.target.value);
          if (Number.isFinite(seq) && seq > 0) onSeek(seq);
        }}
      >
        <option value="">jump to a key moment ({moments.length})</option>
        {MOMENT_GROUPS.map((group) => {
          const items = moments.filter((m) => m.kind === group.kind);
          return items.length === 0 ? null : (
            <optgroup key={group.kind} label={`${group.title} (${items.length})`}>
              {items.map((m) => (
                <option key={`${m.kind}-${m.seq}`} value={m.seq}>
                  seq {m.seq}: {m.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <span className="mc-next" role="group" aria-label="Jump to the next">
        <span className="muted">next</span>
        <button type="button" title="the next claim" disabled={nextClaim === undefined} onClick={() => nextClaim !== undefined && onSeek(nextClaim)}>
          claim
        </button>
        <button type="button" title="the next contract change" disabled={nextContract === undefined} onClick={() => nextContract !== undefined && onSeek(nextContract)}>
          contract
        </button>
        {nextContest !== undefined || !recorded ? (
          <button type="button" title="the next contest" disabled={nextContest === undefined} onClick={() => nextContest !== undefined && onSeek(nextContest)}>
            contest
          </button>
        ) : null}
        <button type="button" title="the next integrated revision" disabled={nextRev === undefined} onClick={() => nextRev !== undefined && onSeek(nextRev)}>
          rev
        </button>
      </span>
      {recorded ? (
        <button type="button" className="mc-end-pill" disabled={live} onClick={onLive}>
          end: final verdict
        </button>
      ) : (
        <button type="button" className={`mc-live-pill${live ? " is-live" : ""}`} onClick={onLive}>
          {live ? "LIVE" : "go live"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mission control
// ---------------------------------------------------------------------------

/** How long a landed message's edge stays visible (live mode) and its caption floats. */
const MESSAGE_FADE_MS = 4000;
const CAPTION_MS = 3000;
/** A big jump (a first load, a replay seek) animates only its latest messages. */
const MAX_ANIMATED = 12;

export interface MissionControlProps {
  readonly log: readonly BoardMessage[];
  readonly escalations: readonly BoardEscalationRecord[];
  readonly busy: boolean;
  readonly onResolve: (id: string, decision: string) => void | Promise<void>;
  /** Initial replay cursor (default: follow live). For tests and deep links. */
  readonly initialSeq?: number;
  readonly initialSelection?: BoardSelection | null;
  readonly initialTab?: RightTab;
  /**
   * A RECORDED run (the static replay page): nothing is live, no escalation can
   * be answered, and the end of the log is the end of the run.
   */
  readonly recorded?: boolean;
  /** Called with the replay cursor (null at the end of the log), e.g. to keep a shareable URL. */
  readonly onSeqChange?: (seq: number | null) => void;
}

export function MissionControl({
  log,
  escalations,
  busy,
  onResolve,
  initialSeq,
  initialSelection,
  initialTab,
  recorded = false,
  onSeqChange,
}: MissionControlProps) {
  const lastSeq = log.length === 0 ? 0 : log[log.length - 1]!.seq;
  const [cursor, setCursor] = useState<number | "live">(initialSeq ?? "live");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [messageMode, setMessageMode] = useState<MessageMode>("live");
  const [selection, setSelection] = useState<BoardSelection | null>(initialSelection ?? null);
  const [tab, setTab] = useState<RightTab>(initialTab ?? "thread");
  const [talk, setTalk] = useState(true);
  const [hoverRev, setHoverRev] = useState<number | null>(null);
  const live = cursor === "live" || cursor >= lastSeq;
  const k = cursor === "live" ? lastSeq : Math.min(cursor, lastSeq);
  useEffect(() => {
    onSeqChange?.(live ? null : k);
  }, [k, live, onSeqChange]);

  // Every projection of the log is guarded: a message the fold cannot read refuses the view at
  // that seq (with the replay controls kept), never a blank page.
  const layoutResult = useMemo(() => attempt(() => boardLayout(log)), [log]);
  const layout = layoutResult.value;
  // The proof of the final revision at K, from the log alone (works the same in replay).
  const proofResult = useMemo(() => attempt(() => buildProofBundle(boardPrefix(log, k))), [log, k]);
  const { model, error } = useMemo((): { model: BoardGraphModel | null; error: string | null } => {
    if (layoutResult.error !== null) return { model: null, error: layoutResult.error };
    const built = attempt(() => buildBoardGraph(log, k));
    return { model: built.value, error: built.error ?? proofResult.error };
  }, [log, k, layoutResult, proofResult]);

  // Arrival times of the seqs the cursor moved over (forward only), for the
  // transient message edges and the captions.
  const arrivals = useRef(new Map<number, number>());
  const previousK = useRef<number | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const prev = previousK.current;
    previousK.current = k;
    if (prev === null || k <= prev) {
      return;
    }
    const t = Date.now();
    for (let s = Math.max(prev + 1, k - MAX_ANIMATED + 1); s <= k; s += 1) {
      arrivals.current.set(s, t);
    }
    setNow(t);
  }, [k]);
  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      let anyRecent = false;
      for (const [seq, at] of arrivals.current) {
        if (t - at > MESSAGE_FADE_MS) arrivals.current.delete(seq);
        else anyRecent = true;
      }
      if (anyRecent || arrivals.current.size === 0) setNow(t);
    }, 500);
    return () => clearInterval(timer);
  }, []);
  const recentSeqs = useMemo(() => {
    const out = new Set<number>();
    for (const [seq, at] of arrivals.current) {
      if (now - at <= MESSAGE_FADE_MS && seq <= k) out.add(seq);
    }
    return out;
  }, [now, k]);
  const captions = useMemo(() => {
    if (!model) return [];
    let from = k;
    for (const [seq, at] of arrivals.current) {
      if (now - at <= CAPTION_MS && seq <= k) from = Math.min(from, seq - 1);
    }
    return boardCaptions(log, from, k, new Set(model.nodes.map((n) => n.id)), 3);
  }, [log, k, now, model]);

  // Replay playback.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setCursor((c) => {
        const at = c === "live" ? lastSeq : c;
        if (at >= lastSeq) {
          setPlaying(false);
          return "live";
        }
        return at + 1;
      });
    }, Math.max(20, REPLAY_BASE_MS / speed));
    return () => clearInterval(timer);
  }, [playing, speed, lastSeq]);

  const select = useCallback((next: BoardSelection) => {
    setSelection(next);
    setTab((t) => (t === "tools" ? "thread" : t));
  }, []);

  // The overlays at K: the talk arrows, the gate timeline, the progress chart, the advisory decisions.
  const arrows = useMemo(() => (talk ? (attempt(() => communicationArrows(log, k)).value ?? []) : []), [log, k, talk]);
  const chart = useMemo(() => attempt(() => progressChart(log, k)).value ?? { series: [] }, [log, k]);

  // The replay controls render even when the graph refuses to draw, so a bad seq never strands the viewer.
  const replayBar = (
    <ReplayBar
      log={log}
      k={k}
      live={live}
      playing={playing}
      speed={speed}
      recorded={recorded}
      onSeek={(seq) => {
        setPlaying(false);
        setCursor(seq >= lastSeq ? "live" : seq);
      }}
      onLive={() => {
        setPlaying(false);
        setCursor("live");
      }}
      onPlay={() => {
        if (!playing && live) {
          setCursor(0);
        }
        setPlaying((p) => !p);
      }}
      onSpeed={setSpeed}
    />
  );

  if (error || !model || !layout || !proofResult.value) {
    return (
      <section className={`mc is-guarded${recorded ? " is-recorded" : ""}`} aria-label="Mission control">
        <div className="mc-guard" role="alert" aria-label="Honesty guard">
          <p className="error">
            Refusing to render the board graph at seq {k}: {error}. The graph only draws elements backed by recorded board messages. Scrub to
            another seq with the replay controls.
          </p>
        </div>
        {replayBar}
      </section>
    );
  }

  const cards = escalationCards(model, escalations, live, recorded);
  const thread = selection ? boardThread(log, k, selection, model.state) : [...boardPrefix(log, k).slice(-40)].reverse();
  const threadTitle = !selection
    ? "Latest board messages (newest first)"
    : selection.kind === "seq"
      ? `Message seq ${selection.seq}`
      : selection.kind === "item"
        ? `Item ${selection.id}`
        : selection.kind === "agent"
          ? `Agent ${selection.id}`
          : `Node ${selection.id}`;
  const selectedId = selectedNodeId(selection, log);
  const selectedNode = selectedId ? model.nodes.find((n) => n.id === selectedId) : undefined;
  const selectedSeq = selection?.kind === "seq" ? selection.seq : null;
  const markers = gateTimeline(model, log);
  const selectedRev = selectedId?.startsWith("rev:") ? Number(selectedId.slice(4)) : null;
  const focusRev = hoverRev ?? selectedRev;
  const landed = selectedNode?.detail.kind === "rev" ? speculativeLanded(log, k, selectedNode.detail.n) : undefined;

  return (
    <section className={`mc${recorded ? " is-recorded" : ""}`} aria-label="Mission control">
      <Ticker ticker={model.ticker} live={live} k={k} lastSeq={lastSeq} recorded={recorded} />
      <GateStrip
        markers={markers}
        chart={chart}
        focus={focusRev}
        onHover={setHoverRev}
        onSelect={(n) => {
          select({ kind: "node", id: `rev:${n}` });
          setTab("node");
        }}
      />
      <BoardPane model={model} cards={cards} selection={selection} busy={busy} onSelect={select} onResolve={onResolve} log={log} />
      <div className="mc-graph" aria-label="Graph">
        <div className="mc-graph-controls">
          <strong>GRAPH</strong>
          <span className="muted">messages:</span>
          {(["live", "all", "off"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={messageMode === mode ? "is-active" : ""}
              onClick={() => setMessageMode(mode)}
              title={
                mode === "live"
                  ? "show each message as it lands (a dot travels sender to receiver, then fades)"
                  : mode === "all"
                    ? "show every message edge up to this point, aggregated"
                    : "hide message edges"
              }
            >
              {mode === "live" ? "as they land" : mode}
            </button>
          ))}
          <button
            type="button"
            className={`mc-talk-toggle${talk ? " is-active" : ""}`}
            aria-pressed={talk}
            onClick={() => setTalk((t) => !t)}
            title={`agent talk: who proposed to, asked, handed off to, or contested whom in the last ${COMM_WINDOW} seqs (an overlay from recorded messages, not graph edges)`}
          >
            talk {talk ? "on" : "off"}
          </button>
          {selection ? (
            <button type="button" className="secondary" onClick={() => setSelection(null)}>
              clear selection
            </button>
          ) : null}
        </div>
        <BoardGraphView
          model={model}
          layout={layout}
          selection={selection}
          log={log}
          messageMode={messageMode}
          recentSeqs={recentSeqs}
          captions={captions}
          onSelect={select}
          arrows={arrows}
          focusRev={focusRev}
        />
        <BoardLegend />
        <JevPanel
          rows={jevRows(model)}
          selected={selectedId}
          onSelect={(node) => {
            select({ kind: "node", id: node });
            setTab("node");
          }}
        />
      </div>
      <div className="mc-right" aria-label="Details">
        <div className="mc-tabs" role="tablist">
          {(["thread", "node", "tools", "proof"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "is-active" : ""} onClick={() => setTab(t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        {tab === "thread" ? (
          <Thread
            messages={thread}
            title={threadTitle}
            selectedSeq={selectedSeq}
            onSelectSeq={(seq) => select({ kind: "seq", seq })}
            onSelectAgent={(agent) => select({ kind: "agent", id: agent })}
          />
        ) : tab === "node" ? (
          selectedNode ? (
            <BoardNodeDetail node={selectedNode} landed={landed} />
          ) : (
            <p className="muted mc-empty">Select an item, agent, revision, tool, or decision.</p>
          )
        ) : tab === "proof" ? (
          <ProofPanel bundle={proofResult.value} onSelectSeq={(seq) => select({ kind: "seq", seq })} />
        ) : (
          <ToolsRegistry model={model} />
        )}
      </div>
      {replayBar}
    </section>
  );
}

/** Run a projection, catching what it throws (the message, for the honesty guard). */
function attempt<T>(fn: () => T): { readonly value: T | null; readonly error: string | null } {
  try {
    return { value: fn(), error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function boardPrefix(log: readonly BoardMessage[], k: number): readonly BoardMessage[] {
  return log.filter((m) => m.seq <= k);
}

function BoardLegend() {
  return (
    <ul className="legend mc-legend" aria-label="Board legend">
      <li><span className="line ln-dependency" /> dependency</li>
      <li><span className="line ln-trigger" /> trigger (fix asked, escalation)</li>
      <li><span className="line ln-tool" /> consumed tool</li>
      <li><span className="line ln-contest" /> contest (until resolved)</li>
      <li><span className="line ln-message" /> message</li>
      <li><span className="line ln-talk" /> agent talk (overlay from recorded messages, not a graph edge)</li>
      <li><span className="swatch-hex sw-neutral" aria-hidden="true" /> revision: on the gate timeline; hover one for its links</li>
    </ul>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  aggregateMessageEdges,
  boardCaptions,
  boardJumpTargets,
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
import { backedPreviews, previewTitle, type RevisionPreview } from "./previews.ts";
import { buildProofBundle, formatTestTeeth, type ProofBundle } from "@switchyard-change/orchestration/proof-bundle";

import {
  COMM_KINDS,
  COMM_WINDOW,
  commCurve,
  drawnLegend,
  escalationContext,
  fixAskState,
  revisionAnchor,
  type EscalationContext,
  placeLabel,
  talkLabelCandidates,
  type EdgeVariant,
  type LegendEntry,
  type LegendKey,
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
  type CommCurve,
  type GateMarker,
  type JevRow,
  type LandedPart,
  type SuiteSeries,
} from "./board-overlay";
import { IDENTITY_VIEW, shouldZoomOnWheel, zoomAt, type ViewTransform } from "./graph-interactions";
import {
  BENCH_CHIP_H,
  benchCounts,
  benchLine,
  COMPACT_DOT_R,
  COMPACT_DOT_Y,
  COMPACT_NESTED_DOT_Y,
  COMPACT_HULL_H,
  COMPACT_NESTED_H,
  COMPACT_MAX_AGENTS,
  compactCards,
  compactHullTitle,
  laneCaption,
  LANE_HEAD,
  onBenchChip,
  scaledBoardLayout,
  scaledNodePoint,
  shortList,
  subLeadTeams,
  type ScaledBoardLayout,
  type SubLeadTeam,
} from "./board-scale";
import { chapters as runChapters, formatDuration, narrateAt, narrateMessage, type Chapter, type Narration } from "./narration";
import { GRADE_INFO, gradeOf, type EvidenceGrade } from "./evidence";
import { keyMoments, MOMENT_GROUPS, type MomentKind } from "./replay-data";

/**
 * Mission control: the console view for a BOARD run (agents that form around
 * a goal). Everything on screen is a projection of the board log the console
 * holds: `buildBoardGraph(log, K)` for the graph, the board columns, the
 * ticker, and the threads, and `scaledBoardLayout(log)` (from the FULL log: the
 * orchestration `boardLayout` for a small board, lanes for a large one) for
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
  /** Why it was raised, from the recorded board messages (the agent's reason, the failing gate line, each side's words). */
  readonly context?: EscalationContext;
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
  /** The board log: when given, each card carries why it was raised (read up to the model's K). */
  log?: readonly BoardMessage[],
): EscalationCardData[] {
  const out: EscalationCardData[] = [];
  const why = (seq: number | undefined) => {
    const context = log && seq !== undefined ? escalationContext(log, model.k, seq) : undefined;
    return context ? { context } : {};
  };
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
        ...why(fromLog?.seq),
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
      ...why(e.seq),
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
      return message.payload.via === "tool"
        ? `${message.payload.item}: its tool was published (v${message.payload.version})`
        : message.payload.closedBy === "engine"
          ? `${message.payload.item} at rev ${message.payload.n}, closed by the engine (push #${message.payload.pushSeq} passed; the owner did not propose done)`
          : `${message.payload.item} at rev ${message.payload.n}`;
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
  teams = [],
}: {
  ticker: BoardTicker;
  live: boolean;
  k: number;
  lastSeq: number;
  recorded?: boolean;
  /** The sub-leads at K and their active agents (a compact breakdown beside the agent count). */
  teams?: readonly SubLeadTeam[];
}) {
  const rev = ticker.rev;
  const teamLabel = (t: SubLeadTeam) => `${t.items.map((i) => agentShortLabel(i, 14)).join("+")} ${t.active}`;
  const shownTeams = teams.slice(0, TICKER_MAX_TEAMS);
  const gateClass = !rev ? "" : !rev.gated ? "is-nogate" : rev.gate === "pass" ? "is-pass" : "is-fail";
  return (
    <div className="mc-ticker" aria-label="Ticker">
      {/* A recorded run shows its full goal in the run header above. */}
      {recorded ? null : <span className="mc-goal" title={ticker.goalSeq !== undefined ? `${ticker.goal ?? ""} (seq ${ticker.goalSeq}, goal.posted)` : undefined}>
        {ticker.goal ?? "no goal posted yet"}
      </span>}
      {recorded ? null : rev ? (
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
      <span className="mc-agents" title={`${ticker.agents.active} active of ${ticker.agents.joined} joined`}>
        {ticker.agents.active}/{ticker.agents.joined} agents
      </span>
      {teams.length > 0 ? (
        <span
          className="mc-teams"
          title={`active agents per sub-lead: ${teams.map((t) => `${t.agent} leads ${t.items.join(", ")} (${t.active} active)`).join("; ")}`}
        >
          sub-leads: {shownTeams.map(teamLabel).join(" · ")}
          {teams.length > shownTeams.length ? ` · +${teams.length - shownTeams.length}` : ""}
        </span>
      ) : null}
      <span className="mc-items" title="items on the board at this seq">
        {ticker.items.open} open, {ticker.items.claimed} claimed, {ticker.items.contested} contested, {ticker.items.done} done{ticker.items.proposed > 0 ? `, ${ticker.items.proposed} awaiting the lead` : ""}
      </span>
      <span className="mc-jev advisory">{ticker.jev.label}</span>
      {recorded ? null : !live ? (
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

/** The ticker names at most this many sub-leads, then a count. */
const TICKER_MAX_TEAMS = 4;

const GATE_WORD: Record<GateMarker["verdict"], string> = { pass: "PASS", fail: "FAIL", "no-gate": "NO GATE" };

/** A revision's gate marker: number, verdict, acceptance count. Hover or select it to draw its links. */
function GateMarkerButton({
  marker: m,
  focus,
  onHover,
  onSelect,
}: {
  marker: GateMarker;
  focus: number | null;
  onHover: (n: number | null) => void;
  onSelect: (n: number) => void;
}) {
  return (
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
      {m.count ? <span className={`mc-gate-count${m.acceptanceNotRun !== undefined ? " is-gap" : ""}`}>{m.count}</span> : null}
    </button>
  );
}

/**
 * A link to the app running one revision (a Worker version uploaded from that
 * revision's commit). Opens in a new tab; the gate verdict stays the verdict.
 */
export function PreviewLink({ preview, gate, compact = false }: { preview: RevisionPreview; gate: string; compact?: boolean }) {
  return (
    <a
      className={`mc-preview-link${compact ? " is-compact" : ""}`}
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      title={previewTitle(preview, gate)}
      aria-label={`open the app at revision ${preview.n} (${gate})`}
    >
      {compact ? "app \u2197" : `open the app at r${preview.n} \u2197`}
    </a>
  );
}

/**
 * The run's chapters (from the full log, so the strip holds still while
 * scrubbing), each ending at the gate marker of the revision that closed it.
 * A chapter's marker appears only once the cursor has reached that revision,
 * so the strip never tells the ending early. Clicking a chapter seeks to its
 * start; hovering or selecting a marker draws that revision's links.
 */
export function ChapterStrip({
  chapters: list,
  k,
  markers,
  focus,
  onHover,
  onSelect,
  onSeek,
  previews,
}: {
  chapters: readonly Chapter[];
  k: number;
  markers: readonly GateMarker[];
  focus: number | null;
  onHover: (n: number | null) => void;
  onSelect: (n: number) => void;
  onSeek: (seq: number) => void;
  /** Backed revision previews by revision number: each adds a link to the running app. */
  previews?: ReadonlyMap<number, RevisionPreview> | undefined;
}) {
  const byRev = new Map(markers.map((m) => [m.n, m]));
  return (
    <div className="mc-gate mc-chapters" aria-label="Gate timeline">
      <span className="mc-gate-title" title="The run in chapters; each revision ends at its gate, and the gate on the integrated tree decides">
        STORY
      </span>
      <ol className="mc-chapter-row">
        {list.map((c) => {
          const span = c.endSeq - c.startSeq + 1;
          const state = k > c.endSeq ? "is-past" : k >= c.startSeq ? "is-current" : "is-ahead";
          const fill = state === "is-past" ? 1 : state === "is-current" ? (k - c.startSeq + 1) / span : 0;
          const marker = c.rev ? byRev.get(c.rev.n) : undefined;
          return (
            <li key={c.startSeq} className={`mc-chapter kind-${c.kind} ${state}`} style={{ flexGrow: Math.max(1, Math.sqrt(span)) }}>
              <button
                type="button"
                className="mc-chapter-btn"
                aria-current={state === "is-current" ? "step" : undefined}
                title={`${c.title}${c.rev ? `, ending at revision ${c.rev.n}` : ""}: seq ${c.startSeq} to ${c.endSeq}${c.durationMs !== undefined ? `, ${formatDuration(c.durationMs)} of the live run` : ""}: jump to its start`}
                onClick={() => onSeek(c.startSeq)}
              >
                <span className="mc-chapter-title">{c.title}</span>
                <span className="mc-chapter-meta">
                  {span} msg{c.durationMs !== undefined ? ` · ${formatDuration(c.durationMs)}` : ""}
                </span>
                <span className="mc-chapter-fill" style={{ width: `${Math.round(fill * 100)}%` }} aria-hidden="true" />
              </button>
              {marker ? (
                <span className="mc-gate-stack">
                  <GateMarkerButton marker={marker} focus={focus} onHover={onHover} onSelect={onSelect} />
                  {previews?.get(marker.n) ? <PreviewLink preview={previews.get(marker.n)!} gate={GATE_WORD[marker.verdict]} compact /> : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {markers.length === 0 ? <span className="muted mc-gate-empty">no integrated revision yet</span> : null}
    </div>
  );
}

/** Message types that start a thread of their own: no earlier message causes them. */
const ORIGIN_TYPES = new Set<BoardMessage["type"]>(["goal.posted", "agent.joined", "agent.left", "item.proposed", "item.claimed", "help.requested", "contract.proposed", "token.refreshed"]);

/**
 * The narrator: one plain sentence for the message at K, with the earlier
 * messages the log links it to. Read from the recorded log only; a message
 * with no recorded cause says so instead of guessing one.
 */
export function Narrator({
  narration,
  onSelectSeq,
  preview,
}: {
  narration: Narration | null;
  onSelectSeq: (seq: number) => void;
  /** The backed preview of the revision this message integrated, if any. */
  preview?: { readonly preview: RevisionPreview; readonly gate: string } | undefined;
}) {
  if (!narration) {
    return (
      <p className="mc-narrator" role="status">
        <span className="muted">Nothing on the board yet.</span>
      </p>
    );
  }
  const shown = narration.causes.slice(0, 4);
  return (
    <p className="mc-narrator" role="status" aria-live="polite">
      <span className="mc-narr-dot" style={{ background: FAMILY_COLORS[boardMessageFamily(narration.type)] }} aria-hidden="true" />
      <span className="mc-narr-text">{narration.text}</span>
      {shown.length > 0 ? (
        <span className="mc-narr-why">
          after{" "}
          {shown.map((seq) => (
            <button key={seq} type="button" className="mc-seq-link" onClick={() => onSelectSeq(seq)} title="the earlier message the log links this one to">
              seq {seq}
            </button>
          ))}
          {narration.causes.length > shown.length ? ` +${narration.causes.length - shown.length}` : ""}
        </span>
      ) : !ORIGIN_TYPES.has(narration.type) ? (
        <span className="mc-narr-why muted">no recorded cause</span>
      ) : null}
      {preview ? <PreviewLink preview={preview.preview} gate={preview.gate} /> : null}
      <button type="button" className="mc-seq-link mc-narr-self" onClick={() => onSelectSeq(narration.seq)} title="open this message in the thread">
        {narration.type}
      </button>
    </p>
  );
}

const CHART_W = 260;
const CHART_H = 96;

/** What each suite is, in plain words (the Board pane's chart headings). */
export const SUITE_INFO: Readonly<Record<SuiteSeries["suite"], { readonly name: string; readonly explain: string }>> = {
  acceptance: { name: "Acceptance tests", explain: "the gate's own test suite; the run must pass all of them" },
  developer: { name: "Developer tests", explain: "the app's existing tests, which agents may only change with a human's approval" },
  tests: { name: "All tests", explain: "every test the gate ran" },
};

/** The headline of a suite at the cursor: `16 of 20 passing at revision 2`, or why the latest revision has no count. */
export function suiteHeadline(series: SuiteSeries): string {
  const last = series.points[series.points.length - 1];
  if (!last) return "no revision yet";
  if (last.passed === undefined) {
    const counted = [...series.points].reverse().find((p) => p.passed !== undefined);
    return `revision ${last.n}: ${last.gap ?? "no count recorded"}${counted ? `; last counted ${counted.passed} of ${counted.total} at revision ${counted.n}` : ""}`;
  }
  return `${last.passed} of ${last.total} passing at revision ${last.n}`;
}

/** Which points carry their count as text: all of them for a short run, else the first, the best, the last, and the focused one. */
export function labelledPoints(series: SuiteSeries, focus: number | null, max = 8): Set<number> {
  const pts = series.points;
  if (pts.length <= max) return new Set(pts.map((p) => p.n));
  const counted = pts.filter((p) => p.passed !== undefined);
  const best = counted.reduce<ChartPointLike | undefined>((b, p) => (!b || p.passed! > b.passed! ? p : b), undefined);
  return new Set([pts[0]!.n, pts[pts.length - 1]!.n, ...(best ? [best.n] : []), ...(focus !== null ? [focus] : [])]);
}

type ChartPointLike = SuiteSeries["points"][number];

/**
 * One suite: how many of its tests pass at each revision. The heading says
 * what the suite is and where it stands now; the chart is a step line through
 * the recorded counts with each revision labelled on the x axis (`r1`, `r2`,
 * ...) and its count over its point (`10/20`), the y axis from 0 to the most
 * tests recorded, a hollow gap marker where the suite did not run (never a
 * zero), the passing revision ringed, and speculative candidates as small
 * diamonds. Every mark cites its seq. The counts are advisory: only the gate
 * decides pass or fail.
 */
export function SuiteChart({ series, landed, focus = null }: { series: SuiteSeries; landed?: number | undefined; focus?: number | null }) {
  const pad = { l: 30, r: 18, t: 16, b: 18 };
  const n = series.points.length;
  const step = n > 1 ? (CHART_W - pad.l - pad.r) / (n - 1) : 0;
  const xOf = (i: number) => (n > 1 ? pad.l + i * step : (pad.l + CHART_W - pad.r) / 2);
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
  const info = SUITE_INFO[series.suite];
  const headline = suiteHeadline(series);
  const labelled = labelledPoints(series, focus);
  const xLabelEvery = Math.max(1, Math.ceil(n / 10));
  return (
    <figure className={`mc-chart suite-${series.suite}`} aria-label={`${series.suite} over revisions`}>
      <figcaption>
        <span className="mc-chart-name">{info.name}</span> <span className="mc-chart-explain">({info.explain})</span>
        <span className="mc-chart-headline">{headline}</span>
      </figcaption>
      <svg className="mc-chart-svg" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`${info.name}: how many pass at each revision: ${story}`}>
        <title>{`${info.name} passing at each revision: ${story}`}</title>
        <line className="mc-chart-total" x1={pad.l} x2={CHART_W - pad.r} y1={yOf(total)} y2={yOf(total)}>
          <title>{`all ${series.total} tests of the ${series.suite} suite (the most recorded)`}</title>
        </line>
        <line className="mc-chart-base" x1={pad.l} x2={CHART_W - pad.r} y1={yOf(0)} y2={yOf(0)} />
        {/* The y axis: 0 to the most tests recorded. */}
        <text className="mc-chart-axis" x={pad.l - 4} y={yOf(total) + 3} textAnchor="end">
          {series.total}
        </text>
        <text className="mc-chart-axis" x={pad.l - 4} y={yOf(0) + 3} textAnchor="end">
          0
        </text>
        {focus !== null && indexOf.has(focus) ? (
          <line className="mc-chart-focus" x1={xOf(indexOf.get(focus)!)} x2={xOf(indexOf.get(focus)!)} y1={pad.t - 4} y2={CHART_H - pad.b + 2} />
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
        {/* Per point: its count over it, its revision under the axis. */}
        {series.points.map((p, i) => (
          <g key={`l${p.seq}`} className="mc-chart-labels">
            {labelled.has(p.n) ? (
              <text
                className="mc-chart-count"
                x={xOf(i)}
                y={p.passed === undefined ? yOf(0) - 9 : yOf(p.passed) - 6}
                textAnchor={n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle"}
              >
                {p.passed === undefined ? "--" : `${p.passed}/${p.total}`}
              </text>
            ) : null}
            {i % xLabelEvery === 0 || i === n - 1 ? (
              <text className="mc-chart-axis" x={xOf(i)} y={CHART_H - 4} textAnchor="middle">
                r{p.n}
              </text>
            ) : null}
          </g>
        ))}
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
      {card.context ? <EscalationWhy context={card.context} onSelectSeq={onSelectSeq} showAdvice={card.recommendation === undefined} /> : null}
      {card.recommendation !== undefined ? (
        <p className="mc-recommendation">
          <span className="advisory">Jev recommends {card.recommendation}</span>{" "}
          <span className="mc-chip-advisory">{card.recorded ? "advisory: a human decides" : "advisory: you decide"}</span>
          {card.context?.kind === "contract" && card.context.advice ? (
            <>
              {" "}
              <SeqCite seq={card.context.advice.seq} type="decision.recorded" onSelectSeq={onSelectSeq} />
            </>
          ) : null}
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

/** A seq link inside an escalation card (opens the message in the thread). */
function SeqCite({ seq, type, onSelectSeq }: { seq: number; type: string; onSelectSeq?: ((seq: number) => void) | undefined }) {
  return (
    <button type="button" className="mc-seq-link" onClick={() => onSelectSeq?.(seq)} title="open this message in the thread">
      seq {seq}, {type}
    </button>
  );
}

/**
 * Why an escalation waits on a human, from recorded messages only: who asks
 * and for which item, in the agent's own words, the failing gate line that led
 * to it, what each answer does, and the advisory triage (never a verdict).
 */
export function EscalationWhy({
  context: c,
  onSelectSeq,
  showAdvice = true,
}: {
  context: EscalationContext;
  onSelectSeq?: ((seq: number) => void) | undefined;
  showAdvice?: boolean;
}) {
  if (c.kind === "contract") {
    return (
      <dl className="mc-escalation-why">
        <dt>Who asks</dt>
        <dd>
          <strong>{c.requester}</strong>, for item <strong>{c.item}</strong>: {c.change} <code>{c.target}</code>
          {c.proposalSeq !== undefined ? (
            <>
              {" "}
              <SeqCite seq={c.proposalSeq} type="contract.proposed" onSelectSeq={onSelectSeq} />
            </>
          ) : null}
        </dd>
        {c.description !== undefined || c.rationale !== undefined ? (
          <>
            <dt>Its reason</dt>
            <dd>
              {c.description !== undefined ? (
                <q className="mc-rationale" title={`${c.requester}'s own words: claimed, never counted`}>
                  {c.description}
                </q>
              ) : null}
              {c.rationale !== undefined && c.rationale !== c.description ? (
                <q className="mc-rationale" title={`${c.requester}'s own words: claimed, never counted`}>
                  {c.rationale}
                </q>
              ) : null}
            </dd>
          </>
        ) : null}
        {c.failure ? (
          <>
            <dt>The failure behind it</dt>
            <dd>
              <code className="mc-escalation-fail">{c.failure.text}</code> <SeqCite seq={c.failure.seq} type={c.failure.type} onSelectSeq={onSelectSeq} />
            </dd>
          </>
        ) : null}
        <dt>Accept</dt>
        <dd>{c.accepting}</dd>
        <dt>Reject</dt>
        <dd>{c.rejecting}</dd>
        {showAdvice && c.advice ? (
          <>
            <dt>Jev</dt>
            <dd className="advisory">
              recommends {c.advice.answer}
              {c.advice.confidence !== undefined ? ` (${c.advice.confidence.toFixed(2)}${c.advice.confident ? "" : ", not confident"})` : ""}{" "}
              <span className="mc-chip-advisory">advisory: the human decides here, and only the gate decides the run</span>{" "}
              <SeqCite seq={c.advice.seq} type="decision.recorded" onSelectSeq={onSelectSeq} />
            </dd>
          </>
        ) : null}
      </dl>
    );
  }
  return (
    <dl className="mc-escalation-why">
      <dt>Who</dt>
      <dd>
        <strong>{c.claimant}</strong> (for {c.item}) wants what <strong>{c.owner}</strong>
        {c.ownerItem !== undefined ? ` (for ${c.ownerItem})` : ""} holds
      </dd>
      <dt>Overlap</dt>
      <dd>
        <code>{c.overlap.join(", ")}</code>
      </dd>
      {c.reason !== undefined ? (
        <>
          <dt>Why a human</dt>
          <dd>{c.reason}</dd>
        </>
      ) : null}
      {c.sides.length > 0 ? (
        <>
          <dt>Each side</dt>
          <dd>
            <ul className="mc-escalation-sides">
              {c.sides.map((side) => (
                <li key={side.seq}>
                  <strong>{side.agent}</strong> <span className="muted">({side.role})</span>:{" "}
                  <q className="mc-rationale" title={`${side.agent}'s own words: claimed, never counted`}>
                    {side.words}
                  </q>{" "}
                  <SeqCite seq={side.seq} type={side.type} onSelectSeq={onSelectSeq} />
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      <dt>If {c.owner} keeps it</dt>
      <dd>{c.keepOwner}</dd>
      <dt>If {c.claimant} gets it</dt>
      <dd>{c.keepClaimant}</dd>
    </dl>
  );
}

function ItemCard({
  node,
  label,
  selected,
  onSelect,
  onSelectAgent,
  fixAsk,
}: {
  node: BoardGraphNode;
  label: string;
  selected: boolean;
  onSelect: () => void;
  onSelectAgent: (agent: string) => void;
  /** The item's fix request: the current failing state ("open") or history ("superseded"); none when answered. */
  fixAsk?: { readonly n: number; readonly state: "open" | "superseded" } | undefined;
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
        {fixAsk?.state === "open" ? (
          <span className="mc-tag is-fix" title="the latest revision failed and asked this item for a fix; it clears when the owner pushes">
            fix asked (rev {fixAsk.n})
          </span>
        ) : fixAsk?.state === "superseded" ? (
          <span className="mc-tag is-history" title="history: an earlier failing revision asked for a fix; a later revision was integrated and did not ask again">
            asked at rev {fixAsk.n}
          </span>
        ) : null}
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
  charts,
}: {
  model: BoardGraphModel;
  cards: readonly EscalationCardData[];
  selection: BoardSelection | null;
  busy: boolean;
  onSelect: (selection: BoardSelection) => void;
  onResolve: (id: string, decision: string) => void | Promise<void>;
  /** The board log: when given, seam and tool items read by their recorded origin. */
  log?: readonly BoardMessage[];
  /** The acceptance-over-revisions charts, shown above the columns. */
  charts?: ReactNode;
}) {
  const byItem = new Map(model.nodes.filter((n) => n.kind === "item").map((n) => [n.label, n]));
  const fixAsks = log ? fixAskState(model, log) : new Map<string, { n: number; state: "open" | "superseded" }>();
  // A large board's cards are compact (one line each; the objective shows on the selected card).
  const compactList = compactCards(byItem.size);
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
      {charts}
      {best !== undefined ? (
        <p className="muted mc-ratchet" title="the best-scoring failing revision before the first pass: what new pushes are stacked on; it never moves the head or promotes">
          {best}
        </p>
      ) : null}
      {columns.map(([title, ids]) => {
        // A column folds behind its heading (item names on one line) when it is
        // long and needs no one: the graph already draws every item. Contested
        // and proposed items always stay open, as does a selected item's column.
        const attention = title === "CONTESTED" || title === "PROPOSED";
        const holdsSelection = selection?.kind === "item" && ids.includes(selection.id);
        const folded = !attention && !holdsSelection && ids.length > COLUMN_OPEN_MAX;
        const heading = (
          <h3>
            {title} <span className="muted">{ids.length}</span>
          </h3>
        );
        return (
          <section key={title} className={`mc-column col-${title.toLowerCase()}${folded ? " is-folded" : ""}`}>
            {folded ? (
              <details>
                <summary>
                  {heading}
                  <span className="mc-column-names" title={ids.length > FOLDED_NAMES_MAX ? ids.map((id) => labels.get(id) ?? id).join(", ") : undefined}>
                    {shortList(ids.map((id) => labels.get(id) ?? id), ids.length > FOLDED_NAMES_MAX ? FOLDED_NAMES_SHORT : FOLDED_NAMES_MAX)}
                  </span>
                </summary>
                <ul className={`mc-cards${compactList ? " is-compact" : ""}`}>
                  {ids.map((id) => {
                    const node = byItem.get(id);
                    return node ? (
                      <ItemCard
                        key={id}
                        node={node}
                        label={labels.get(id) ?? id}
                        selected={false}
                        onSelect={() => onSelect({ kind: "item", id })}
                        onSelectAgent={(agent) => onSelect({ kind: "agent", id: agent })}
                        fixAsk={fixAsks.get(id)}
                      />
                    ) : null;
                  })}
                </ul>
              </details>
            ) : (
              <>
                {heading}
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
                <ul className={`mc-cards${compactList ? " is-compact" : ""}`}>
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
                        fixAsk={fixAsks.get(id)}
                      />
                    ) : null;
                  })}
                </ul>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** A Board column with more items than this folds behind its heading. */
const COLUMN_OPEN_MAX = 3;
/** A folded column names all its items up to this many; a longer one names the first FOLDED_NAMES_SHORT, then a count. */
const FOLDED_NAMES_MAX = 12;
const FOLDED_NAMES_SHORT = 6;

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

/**
 * Place at most three captions near their senders with the same collision
 * avoidance as the talk labels (placeLabel): each takes the first free spot
 * among a stack of spots above its sender, then above and to either side, then
 * below, clear of every hull title bar, every `occupied` box (node shapes and
 * labels, lane heads, the goal and lead labels, the bench chip, the revision
 * anchor and its line, ...), and the captions already placed, inside the
 * drawing. A caption with no free spot is dropped (the thread still has it).
 */
export function placeCaptions(
  captions: readonly { readonly seq: number; readonly node: string; readonly text: string }[],
  points: ReadonlyMap<string, BoardPoint>,
  layout: BoardLayout,
  scale = 1,
  occupied: readonly Box[] = [],
  bounds: Box = { x: 0, y: 0, w: layout.width, h: Number.POSITIVE_INFINITY },
): PlacedCaption[] {
  const taken: Box[] = [...[...layout.items.values()].map((r) => ({ x: r.x, y: r.y, w: r.w, h: HULL_TITLE_H })), ...occupied];
  const placed: PlacedCaption[] = [];
  const h = 22 * scale;
  for (const caption of captions.slice(0, 3)) {
    const p = points.get(caption.node);
    if (!p) continue;
    const text = clip(caption.text, 44);
    const w = Math.max(60, text.length * 7 * scale + 18);
    const x = Math.min(Math.max(p.x, bounds.x + w / 2 + 4), bounds.x + bounds.w - w / 2 - 4);
    const above = (i: number) => p.y - 26 * scale - h / 2 - i * (h + 4);
    const candidates = [
      ...[0, 1, 2, 3, 4, 5].map((i) => ({ x, y: above(i) })),
      ...[0, 1, 2].flatMap((i) => [-1, 1].map((side) => ({ x: p.x + side * (w / 2 + 24), y: above(i) }))),
      ...[0, 1, 2].map((i) => ({ x, y: p.y + 34 * scale + h / 2 + i * (h + 4) })),
    ];
    const box = placeLabel({ w, h }, candidates, taken, { bounds, gap: 3 });
    if (!box) continue;
    taken.push(box);
    placed.push({ seq: caption.seq, text, x: box.x + box.w / 2, y: box.y, w, h });
  }
  return placed;
}

export interface BoardGraphViewProps {
  readonly model: BoardGraphModel;
  /** The orchestration layout, or the console's scaled layout of a large board (lanes, compact hulls, bench chip). */
  readonly layout: BoardLayout | ScaledBoardLayout;
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
const REV_ANCHOR_Y = 150;
/** The line over the latest revision while its open fix requests are drawn (its red hexagon says it failed). */
const FIX_ASKED_LABEL = "FAIL: fix asked";
/** The line over a newly passing latest revision (shown a few seqs, fading). */
const PASSED_LABEL = "PASS";

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
export function BoardGraphView({ model, layout: given, selection, log, messageMode, recentSeqs, captions, onSelect, arrows = [], focusRev = null }: BoardGraphViewProps) {
  const layout: ScaledBoardLayout = "compact" in given ? given : { ...given, compact: false, lanes: [] };
  const compact = layout.compact;
  const selected = selectedNodeId(selection, log);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const baseExtent = drawingExtent(layout);
  // A scaled layout also holds its lanes and bench chip: the drawing spans its whole size.
  const extent = compact ? { width: Math.max(baseExtent.width, layout.width), height: Math.max(baseExtent.height, layout.height) } : baseExtent;
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

  // Collapse a hull past HULL_MAX_AGENTS (COMPACT_MAX_AGENTS on a large board) unless it is selected or contested.
  const maxAgents = compact ? COMPACT_MAX_AGENTS : HULL_MAX_AGENTS;
  const collapsed = new Set<string>();
  for (const node of model.nodes) {
    if (node.detail.kind === "item" && node.detail.agents.length > maxAgents && selected !== node.id && !node.detail.contested) {
      collapsed.add(node.detail.item);
    }
  }
  // A large board's free agents are one chip with counts, not a dot each.
  const bench = compact ? benchCounts(model) : { idle: [], left: [] };
  const benchSelected = compact && selection?.kind === "agent" && (bench.idle.includes(selection.id) || bench.left.includes(selection.id));
  // The chip grows with its line at the current text boost (it never cuts the counts).
  const benchW = layout.benchChip
    ? Math.max(layout.benchChip.w, Math.ceil(benchLine(bench.idle.length, bench.left.length).length * 13 * boost * CHAR_EM) + 36)
    : 0;
  // A large board's hull titles drop what their lane or parent hull already says.
  const laneOfItem = new Map<string, string>(layout.lanes.flatMap((lane) => lane.items.map((item): [string, string] => [item, lane.key])));
  const itemAgents = new Map<string, readonly string[]>();
  for (const node of model.nodes) if (node.detail.kind === "item") itemAgents.set(node.detail.item, node.detail.agents);
  // The revision drawn now (only while focused), at its anchor above the hulls.
  const focusNode = focusRev !== null ? model.nodes.find((n) => n.id === `rev:${focusRev}`) : undefined;
  // With no revision focused, the latest revision's open fix requests are drawn from it (each line backed by its fix.requested).
  const anchor = focusNode ? null : revisionAnchor(model, log);
  const fixAsked = anchor?.mode === "fix-asked" ? anchor : null;
  const shownRev = focusNode ?? anchor?.rev;
  const anchorLabel = anchor?.mode === "passed" ? PASSED_LABEL : FIX_ASKED_LABEL;
  const revAnchor = { x: extent.width - 34, y: REV_ANCHOR_Y };
  const points = new Map<string, BoardPoint>();
  for (const node of model.nodes) {
    if (node.kind === "rev") {
      if (node === shownRev) points.set(node.id, revAnchor);
      continue;
    }
    if (node.kind === "jev") continue;
    const p = compact ? scaledNodePoint(layout, node, model) : boardNodePoint(layout, node);
    if (!p) continue;
    if (node.detail.kind === "agent" && node.detail.hull !== undefined && collapsed.has(node.detail.hull)) {
      // A collapsed hull bundles its agents' edges at the hull center.
      const hull = layout.items.get(node.detail.hull)!;
      points.set(node.id, { x: hull.x + hull.w / 2, y: hull.y + hull.h / 2 });
    } else {
      points.set(node.id, p);
    }
  }
  // Only the latest failing revision's open requests read as "fix" on a hull (an older request is history).
  const fixAsks = fixAskState(model, log);
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
    // A large board draws a split item's children INSIDE its hull: the nesting is the link (split, merged), so the line is hidden.
    if (compact && e.from.startsWith("item:") && e.to.startsWith("item:")) {
      const [a, b] = [e.from.slice(5), e.to.slice(5)];
      if (layout.items.get(a)?.parent === b || layout.items.get(b)?.parent === a) return false;
    }
    const related = selected !== null && (e.from === selected || e.to === selected);
    if (e.from === "goal") return related;
    return true;
  });
  const revLinks = focusNode && focusNode.detail.kind === "rev" ? revisionLinks(model, focusNode.detail.n) : [];
  // The revision lines drawn now: the focused revision's links, else the latest revision's open fix requests.
  const shownRevLinks = focusNode ? revLinks : (fixAsked?.edges ?? []);
  const messages = (
    messageMode === "off"
      ? []
      : messageMode === "all"
        ? aggregateMessageEdges(model.edges)
        : model.edges.filter((e) => e.kind === "message" && recentSeqs.has(e.seqs[e.seqs.length - 1]!))
  ).filter((e) => !onRevOrJev(e.from) && !onRevOrJev(e.to));
  const selectEdge = (edge: BoardGraphEdge) => choose({ kind: "seq", seq: edge.seqs[edge.seqs.length - 1]! });
  const transformed = view.k !== 1 || view.tx !== 0 || view.ty !== 0;

  // The nodes drawn one by one (not in a collapsed hull, not on the bench chip), with a compact hull's short label.
  const drawnNodes = model.nodes
    .filter((n) => n.kind !== "item" && n.kind !== "rev" && n.kind !== "jev")
    .flatMap((node): DrawnNode[] => {
      const p = points.get(node.id);
      if (!p) return [];
      if (node.detail.kind === "agent" && node.detail.hull !== undefined && collapsed.has(node.detail.hull)) return [];
      // A large board's free agents are counted on the bench chip, not drawn one by one.
      if (onBenchChip(layout, node)) return [];
      const inHull = compact && node.detail.kind === "agent" && node.kind !== "lead" && node.detail.hull !== undefined ? layout.items.get(node.detail.hull) : undefined;
      // In a compact hull only the first dot (or the sub-lead) is labelled, to its right, cut to the hull.
      const hullAgents = inHull && node.detail.kind === "agent" ? itemAgents.get(node.detail.hull!) ?? [] : [];
      const compactLabel =
        inHull && node.detail.kind === "agent" && (hullAgents[0] === node.detail.agent || node.detail.subLeadOf?.includes(node.detail.hull!))
          ? ellipsizeToWidth(
              `${agentShortLabel(node.label)}${node.detail.subLeadOf?.includes(node.detail.hull!) ? " (sub-lead)" : hullAgents.length > 1 ? ` +${hullAgents.length - 1}` : ""}`,
              inHull.x + inHull.w - p.x - 14 - 60 - (hullAgents.length - 1) * 24,
              11 * boost,
            )
          : null;
      const compactX = COMPACT_DOT_R + 4 + (node.detail.kind === "agent" && !node.detail.subLeadOf?.includes(node.detail.hull!) ? (hullAgents.length - 1) * 24 : 0);
      return [{ node, p, inHull: inHull !== undefined, compactLabel, compactX }];
    });

  // Everything a talk label must not cover: node shapes and labels, hull and lane titles, hull text, edge tags, captions, the bench chip.
  const occupied: Box[] = drawnNodes.flatMap((d) => nodeBoxes(d, boost));
  for (const node of model.nodes) {
    if (node.detail.kind !== "item") continue;
    const rect = layout.items.get(node.detail.item);
    if (!rect) continue;
    occupied.push({ x: rect.x, y: rect.y, w: rect.w, h: HULL_TITLE_H });
    // The done check and the struggling mark at the bottom of the hull (as drawn below).
    const markBottom = compact ? rect.y + (rect.parent !== undefined ? COMPACT_NESTED_H : COMPACT_HULL_H) : rect.y + rect.h;
    if (node.detail.completed !== undefined || node.detail.doneProposed) occupied.push({ x: rect.x + rect.w - 33, y: markBottom - 33, w: 22, h: 22 });
    if (node.detail.struggling !== undefined) {
      const sx = compact ? rect.x + rect.w - 48 : rect.x + 18;
      occupied.push({ x: sx - 10, y: markBottom - 30, w: 20, h: 20 });
    }
    if (node.detail.volunteers !== undefined && node.detail.volunteers.length > 0) {
      occupied.push({ x: rect.x + (compact ? 12 : 34), y: rect.y + rect.h - (compact ? 6 : 15) - 11 * boost, w: Math.max(0, rect.w - (compact ? 70 : 74)), h: 14 * boost });
    }
    if (collapsed.has(node.detail.item)) {
      const w = `${node.detail.agents.length} agents`.length * 15 * boost * CHAR_EM;
      const cx = compact ? rect.x + 12 + w / 2 : rect.x + rect.w / 2;
      const by = compact ? rect.y + (rect.parent !== undefined ? COMPACT_NESTED_DOT_Y : COMPACT_DOT_Y) + 5 : rect.y + rect.h / 2 + 12;
      occupied.push(textBox(cx, by, w, 15 * boost));
    }
  }
  for (const lane of layout.lanes) {
    if (laneCaption(lane, model)) occupied.push({ x: lane.x, y: lane.y, w: lane.w, h: LANE_HEAD });
  }
  for (const edge of persistent) {
    const a = points.get(edge.from);
    const b = points.get(edge.to);
    if (!a || !b || !edge.label || (compact && edge.label === "merged")) continue;
    occupied.push(textBox((a.x + b.x) / 2, (a.y + b.y) / 2 - 4, edge.label.length * 11 * boost * CHAR_EM, 11 * boost));
  }
  if (messageMode === "all") {
    for (const edge of messages) {
      const a = points.get(edge.from);
      const b = points.get(edge.to);
      if (!a || !b || edge.count <= 1) continue;
      occupied.push(textBox((a.x + b.x) / 2, (a.y + b.y) / 2 - 4, `x${edge.count}`.length * 12 * boost * CHAR_EM, 12 * boost));
    }
  }
  if (shownRev && shownRev.detail.kind === "rev") {
    occupied.push({ x: revAnchor.x - 20, y: revAnchor.y - 20, w: 40, h: 40 });
    if (focusNode) {
      const w = shownRev.detail.verdictLabel.length * 13 * boost * CHAR_EM;
      occupied.push({ x: revAnchor.x - 26 - w, y: revAnchor.y - 20, w, h: 40 });
    } else {
      const w = anchorLabel.length * 13 * boost * CHAR_EM;
      occupied.push(textBox(revAnchor.x + 18 - w / 2, revAnchor.y - 26, w, 13 * boost));
    }
  }
  if (layout.benchChip && bench.idle.length + bench.left.length > 0) {
    occupied.push({ x: layout.benchChip.x, y: layout.benchChip.y, w: benchW, h: BENCH_CHIP_H });
  }
  // Captions first (the newest messages), clear of everything above; then the talk labels keep clear of the captions.
  const talkBounds = { x: -FIT_PAD, y: -FIT_PAD, w: vbW, h: vbH };
  const placedCaptions = placeCaptions(captions, points, { ...layout, width: extent.width }, boost, occupied, talkBounds);
  for (const c of placedCaptions) occupied.push({ x: c.x - c.w / 2, y: c.y, w: c.w, h: c.h });
  // Talk labels, newest arrow first: each takes the first free spot along its curve (or above its sender), else none.
  const talkDrawn = arrows.flatMap((arrow): TalkDrawn[] => {
    const a = points.get(arrow.from);
    if (!a) return [];
    const b = arrow.to !== null ? points.get(arrow.to) : undefined;
    const size = { w: arrow.verb.length * 7.2 * boost + 12, h: 17 * boost };
    const isMark = !b || (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1);
    const curve = isMark ? null : commCurve(a, b!);
    const candidates = curve
      ? talkLabelCandidates(curve, size.h)
      : [0, 1, 2, 3].map((slot) => ({ x: a.x, y: a.y - 30 - size.h / 2 - slot * (size.h + 3) })).concat(
          [-1, 1].map((side) => ({ x: a.x + side * (size.w / 2 + 24), y: a.y - 30 - size.h / 2 })),
        );
    const label = placeLabel(size, candidates, occupied, { bounds: talkBounds });
    if (label) occupied.push(label);
    return [{ arrow, from: a, curve, label }];
  });
  // The legend lists what is drawn now, from the same arrays the drawing renders.
  const itemOfLink = (e: BoardGraphEdge) => (e.from.startsWith("item:") ? e.from : e.to).slice("item:".length);
  const legend = drawnLegend(
    [
      ...persistent.filter((e) => points.has(e.from) && points.has(e.to)),
      ...(shownRev ? shownRevLinks.filter((e) => layout.items.has(itemOfLink(e))) : []),
      ...messages.filter((e) => points.has(e.from) && points.has(e.to)),
    ],
    talkDrawn.map((t) => t.arrow),
  );

  return (
    <>
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
            {/* One arrowhead per talk kind, so each head matches its arrow's colour. */}
            {COMM_KINDS.map((kind) => (
              <marker key={kind} id={`mc-talk-head-${kind}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className={`mc-talk-head talk-${kind}`} d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            ))}
            {/* And one start dot per kind at the sender, so the direction reads at both ends. */}
            {COMM_KINDS.map((kind) => (
              <marker key={`tail-${kind}`} id={`mc-talk-tail-${kind}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3" markerHeight="3">
                <circle className={`mc-talk-head talk-${kind}`} cx="5" cy="5" r="4" />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.k})`}>
            {/* Lanes (a large board): items grouped by sub-lead or domain; drawn only once one of their items exists at K. */}
            {layout.lanes.length > 0 ? (
              <g className="mc-lanes">
                {layout.lanes.map((lane) => {
                  const caption = laneCaption(lane, model);
                  if (!caption) return null;
                  const titleText = ellipsizeToWidth(caption.title, lane.w * 0.45, 13 * boost);
                  return (
                    <g key={lane.key} className="mc-lane">
                      <rect x={lane.x} y={lane.y} width={lane.w} height={lane.h} rx={12} />
                      <text className="mc-lane-title" x={lane.x + 10} y={lane.y + LANE_HEAD - 8}>
                        {titleText}
                      </text>
                      <text className="mc-lane-detail" x={lane.x + lane.w - 10} y={lane.y + LANE_HEAD - 8} textAnchor="end">
                        {ellipsizeToWidth(caption.detail, lane.w - 30 - titleText.length * 13 * boost * 0.62, 11 * boost)}
                      </text>
                      <title>{`${caption.title}: ${caption.detail}${caption.subLeads.length > 0 ? `, sub-lead ${caption.subLeads.join(", ")}` : ""} (${lane.items.length} top-level item(s))`}</title>
                    </g>
                  );
                })}
              </g>
            ) : null}
            {/* Item hulls. */}
            <g className={`mc-hulls${compact ? " is-compact" : ""}`}>
              {model.nodes
                .filter((n) => n.kind === "item")
                .map((node) => {
                  if (node.detail.kind !== "item") return null;
                  const d = node.detail;
                  const rect = layout.items.get(d.item);
                  if (!rect) return null;
                  const isSel = selected === node.id;
                  const statusText = `${node.status}${fixAsks.get(d.item)?.state === "open" ? ` / fix ${d.fixAttempts}` : ""}`;
                  const title = itemLabels.get(d.item) ?? d.item;
                  const header = hullHeader({ title: compact ? compactHullTitle(d.item, title, rect.parent ?? laneOfItem.get(d.item)) : title, status: statusText, width: rect.w, boost });
                  // The done check and the struggling mark sit at the bottom of the hull; a compact hull keeps them in its own band (above any nested child).
                  const markBottom = compact ? rect.y + (rect.parent !== undefined ? COMPACT_NESTED_H : COMPACT_HULL_H) : rect.y + rect.h;
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
                        <circle className="mc-check is-filled" cx={rect.x + rect.w - 22} cy={markBottom - 22} r={11} />
                      ) : d.doneProposed ? (
                        <circle className="mc-check is-hollow" cx={rect.x + rect.w - 22} cy={markBottom - 22} r={11} />
                      ) : null}
                      {d.completed !== undefined || d.doneProposed ? (
                        <text className="mc-check-mark" x={rect.x + rect.w - 22} y={markBottom - 17} textAnchor="middle">
                          {"✓"}
                        </text>
                      ) : null}
                      {d.struggling !== undefined ? (
                        // A compact hull's dot row runs along its left: the mark sits left of the done check instead.
                        <g className="mc-struggling">
                          <circle cx={compact ? rect.x + rect.w - 48 : rect.x + 18} cy={markBottom - 20} r={10} />
                          <text x={compact ? rect.x + rect.w - 48 : rect.x + 18} y={markBottom - 15} textAnchor="middle">
                            !
                          </text>
                          <title>{`struggling (${d.struggling.reason}, ${d.struggling.turnsSpent} turn(s)): idle agents may volunteer (seq ${d.struggling.seq}, item.struggling)`}</title>
                        </g>
                      ) : null}
                      {d.volunteers !== undefined && d.volunteers.length > 0 && !(compact && collapsed.has(d.item)) ? (
                        // One line inside the hull (a long list is cut), the full list in the title.
                        <g className="mc-volunteers-line">
                          <text className="mc-volunteers" x={compact ? rect.x + 12 : rect.x + 34} y={rect.y + rect.h - (compact ? 6 : 15)}>
                            {compact
                              ? ellipsizeToWidth(`${d.volunteers.length} offer${d.volunteers.length === 1 ? "" : "s"}`, rect.w - 70, 11 * boost)
                              : ellipsizeToWidth(d.volunteers.map((v) => `${v.agent}${v.answer ? ` (${v.answer})` : " offered"}`).join(", "), rect.w - 34 - 40, 11 * boost)}
                          </text>
                          <title>{`volunteers: ${d.volunteers.map((v) => `${v.agent}${v.answer ? ` (${v.answer})` : " offered"}`).join(", ")}`}</title>
                        </g>
                      ) : null}
                      {collapsed.has(d.item) ? (
                        <text
                          className="mc-hull-count"
                          x={compact ? rect.x + 12 : rect.x + rect.w / 2}
                          y={compact ? rect.y + (rect.parent !== undefined ? COMPACT_NESTED_DOT_Y : COMPACT_DOT_Y) + 5 : rect.y + rect.h / 2 + 12}
                          textAnchor={compact ? "start" : "middle"}
                        >
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
                    {/* A large board nests a split item's children inside it: the "merged" tag would only repeat that. */}
                    {edge.label && !(compact && edge.label === "merged") ? (
                      <text className="mc-edge-tag" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle">
                        {edge.label}
                      </text>
                    ) : null}
                    <title>{edge.tooltip}</title>
                  </g>
                );
              })}
            </g>

            {/* The focused revision's own edges (merged items, fix asked), else the latest revision's open fix requests, to the top of each hull. */}
            {shownRev && shownRev.detail.kind === "rev" ? (
              <g
                className={`mc-rev-focus status-${shownRev.status}${focusNode ? "" : anchor?.mode === "passed" ? " is-passed" : " is-fix-asked"}`}
                aria-label={focusNode ? `revision ${shownRev.detail.n} links` : anchor?.mode === "passed" ? `revision ${shownRev.detail.n} passed` : `revision ${shownRev.detail.n} open fix requests`}
                {...(anchor?.mode === "passed" ? { style: { opacity: anchor.opacity } } : {})}
              >
                {shownRevLinks.map((edge) => {
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
                <g className={`mc-node kind-rev status-${shownRev.status}`} style={{ transform: `translate(${revAnchor.x}px, ${revAnchor.y}px)` }} onClick={() => choose({ kind: "node", id: shownRev.id })}>
                  <polygon className="shape" points={hexagon(18)} />
                  <text className="mc-node-label is-center" textAnchor="middle" y={5}>
                    {shownRev.detail.n}
                  </text>
                  {/* Focused: the verdict to its left. Fix requests only: a short line above it, clear of the goal's label. */}
                  <text className="mc-node-sub" textAnchor="end" x={focusNode ? -26 : 18} y={focusNode ? 5 : -26}>
                    {focusNode ? shownRev.detail.verdictLabel : anchorLabel}
                  </text>
                  <title>{shownRev.tooltip}</title>
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
              {drawnNodes.map(({ node, p, inHull, compactLabel, compactX }) => {
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
                      {inHull ? (
                        <>
                          <circle className="shape" r={COMPACT_DOT_R} />
                          {compactLabel ? (
                            <text className="mc-node-label is-compact" textAnchor="start" x={compactX} y={4}>
                              {compactLabel}
                            </text>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <NodeShape node={node} />
                          <NodeLabel node={node} boost={boost} />
                        </>
                      )}
                      <title>{node.tooltip}</title>
                    </g>
                  );
                })}
              {layout.benchChip && bench.idle.length + bench.left.length > 0 ? (
                <g
                  className={`mc-bench-chip${benchSelected ? " is-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`bench: ${bench.idle.length} idle, ${bench.left.length} left`}
                  onClick={() => {
                    const first = bench.idle[0] ?? bench.left[0];
                    if (first !== undefined) choose({ kind: "agent", id: first });
                  }}
                >
                  <rect x={layout.benchChip.x} y={layout.benchChip.y} width={benchW} height={BENCH_CHIP_H} rx={BENCH_CHIP_H / 2} />
                  <text x={layout.benchChip.x + 16} y={layout.benchChip.y + BENCH_CHIP_H / 2 + 5}>
                    {ellipsizeToWidth(
                      benchLine(bench.idle.length, bench.left.length),
                      benchW - 32,
                      13 * boost,
                    )}
                  </text>
                  <title>{`Agents holding no item at seq ${model.k}. Idle: ${shortList(bench.idle, 12) || "none"}. Left the board: ${shortList(bench.left, 12) || "none"}.`}</title>
                </g>
              ) : null}
            </g>

            {/* The communication overlay: who addressed whom in the last few seqs (an annotation, not a graph edge). */}
            <g className="mc-talk" aria-label="Agent communication overlay">
              {talkDrawn.map(({ arrow, from, curve, label }) => {
                const opacity = commOpacity(arrow.age, COMM_WINDOW);
                // A label with no free spot is left off (the tooltip still carries the verb).
                const pill = label ? (
                  <>
                    <rect x={label.x} y={label.y} width={label.w} height={label.h} rx={label.h / 2} />
                    <text x={label.x + label.w / 2} y={label.y + label.h * 0.72} textAnchor="middle">
                      {arrow.verb}
                    </text>
                  </>
                ) : null;
                if (!curve) {
                  // No drawn target: a mark above the sender (a small dot when no label fits).
                  return (
                    <g key={arrow.id} className={`mc-talk-mark talk-${arrow.kind}`} style={{ opacity }} onClick={() => choose({ kind: "seq", seq: arrow.seq })}>
                      {pill ?? <circle cx={from.x} cy={from.y - 26} r={4 * boost} />}
                      <title>{arrow.tooltip}</title>
                    </g>
                  );
                }
                return (
                  <g key={arrow.id} className={`mc-talk-arrow talk-${arrow.kind}${arrow.age === 0 ? " is-new" : ""}`} style={{ opacity }} onClick={() => choose({ kind: "seq", seq: arrow.seq })}>
                    <path d={curve.d} markerStart={`url(#mc-talk-tail-${arrow.kind})`} markerEnd={`url(#mc-talk-head-${arrow.kind})`} />
                    {pill}
                    <title>{arrow.tooltip}</title>
                  </g>
                );
              })}
            </g>

            {/* Captions near the senders of newly landed messages (at most three, each on a free spot, else left off). */}
            <g className="mc-captions">
              {placedCaptions.map((c) => (
                <g key={c.seq} className="mc-caption">
                  <rect x={c.x - c.w / 2} y={c.y} width={c.w} height={c.h} rx={6} />
                  <text textAnchor="middle" x={c.x} y={c.y + c.h * 0.7}>
                    {c.text}
                  </text>
                </g>
              ))}
            </g>
          </g>
        </svg>
      </div>
      <BoardLegend present={legend.present} absent={legend.absent} />
    </>
  );
}

/** A node drawn one by one, where it sits, and (in a compact hull) its short label and that label's x offset. */
interface DrawnNode {
  readonly node: BoardGraphNode;
  readonly p: BoardPoint;
  readonly inHull: boolean;
  readonly compactLabel: string | null;
  readonly compactX: number;
}

/** One talk arrow (or mark) as drawn: its curve (null for a mark) and its placed label (null when no spot was free). */
interface TalkDrawn {
  readonly arrow: CommArrow;
  readonly from: BoardPoint;
  readonly curve: CommCurve | null;
  readonly label: Box | null;
}

/** The box of one line of text: centered on cx, with its baseline at by, at a font size of fontPx. */
function textBox(cx: number, by: number, w: number, fontPx: number): Box {
  return { x: cx - w / 2, y: by - fontPx * 0.85, w, h: fontPx * 1.1 };
}

/** The radius each node shape is drawn at (NodeShape). */
function shapeRadius(node: BoardGraphNode): number {
  switch (node.kind) {
    case "goal":
      return 30;
    case "lead":
      return 24;
    case "human":
      return 19;
    default:
      return 17;
  }
}

/**
 * The boxes a drawn node covers: its shape and its label text, mirroring
 * NodeShape, NodeLabel, and the compact-hull label, so a talk label can keep
 * clear of them.
 */
function nodeBoxes(d: DrawnNode, boost: number): Box[] {
  const { node, p } = d;
  if (d.inHull) {
    const boxes: Box[] = [{ x: p.x - COMPACT_DOT_R, y: p.y - COMPACT_DOT_R, w: 2 * COMPACT_DOT_R, h: 2 * COMPACT_DOT_R }];
    if (d.compactLabel) {
      const w = d.compactLabel.length * 11 * boost * CHAR_EM;
      boxes.push(textBox(p.x + d.compactX + w / 2, p.y + 4, w, 11 * boost));
    }
    return boxes;
  }
  const r = shapeRadius(node);
  const boxes: Box[] = [{ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }];
  const font = 13 * boost;
  const below = (rr: number) => p.y + rr + 15 * boost;
  const line = (text: string, by: number) => boxes.push(textBox(p.x, by, text.length * font * CHAR_EM, font));
  const det = node.detail;
  if (det.kind === "tool") {
    line(ellipsizeToWidth(det.capability, 180, font), below(17));
    if (det.uses > 0) line(` used x${det.uses}`, below(17) + font * 1.2);
  } else if (det.kind === "goal") {
    line(clip(det.objective, 44), below(30));
  } else if (det.kind === "human") {
    line(det.pending.length > 0 ? `human: ${det.pending.length} waiting` : "human", p.y - (19 + 8));
  } else if (det.kind !== "rev" && det.kind !== "jev") {
    line(agentShortLabel(node.label), node.kind === "lead" ? p.y - (24 + 6) : below(17));
  }
  return boxes;
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
      <p className="mc-grade-legend">
        {(Object.keys(GRADE_INFO) as EvidenceGrade[]).map((g) => (
          <span key={g}>
            <GradeBadge grade={g} /> {GRADE_INFO[g].meaning}
          </span>
        ))}
      </p>
      {bundle.reasons.length > 0 ? (
        <ul className="mc-proof-reasons">
          {bundle.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <dl className="mc-proof-facts">
        <dt>
          gate <GradeBadge grade="checked" />
        </dt>
        <dd>
          {bundle.gate.command?.join(" ") ?? "no command recorded"}: {bundle.gate.verdict}
          {bundle.gate.gated ? "" : " (no gate ran)"}
        </dd>
        <dt>
          promoted <GradeBadge grade="checked" />
        </dt>
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
        {bundle.revision?.applied ? (
          <>
            <dt>
          applied <GradeBadge grade="checked" />
        </dt>
            <dd>
              {bundle.revision.applied.map((u, i) => (
                <span key={u.agent}>
                  {i > 0 ? "; " : ""}
                  {u.agent}: {u.paths.join(", ") || "nothing"}
                  {u.yielded && u.yielded.length > 0 ? ` (yielded ${u.yielded.join(", ")})` : ""}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        <dt>
          tests <GradeBadge grade="advisory" />
        </dt>
        <dd>
          baseline {bundle.inventory.baseline?.count ?? "unknown"}; final{" "}
          {bundle.inventory.final
            ? `executed ${bundle.inventory.final.executed}${bundle.inventory.final.acceptance ? `, acceptance ${bundle.inventory.final.acceptance.passed}/${bundle.inventory.final.acceptance.total}` : ""}${bundle.inventory.final.developer ? `, developer ${bundle.inventory.final.developer.passed}/${bundle.inventory.final.developer.total}` : ""}`
            : "no count"}
        </dd>
        <dt>
          progress <GradeBadge grade="advisory" />
        </dt>
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
            <dt>
          speculation <GradeBadge grade="checked" />
        </dt>
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
        <dt>
          merged <GradeBadge grade="recorded" />
        </dt>
        <dd>
          {bundle.contributions.pushesMerged} push(es) from {bundle.contributions.agents.join(", ") || "nobody"};{" "}
          {bundle.contributions.items.filter((i) => i.status === "done").length} of {bundle.contributions.items.length} item(s) done
        </dd>
        <dt>
          contracts <GradeBadge grade="decided" />
        </dt>
        <dd>{bundle.contracts.length > 0 ? bundle.contracts.map((c) => `${c.contract} ${c.status}${c.decidedBy ? ` by ${c.decidedBy}` : ""}`).join("; ") : "none"}</dd>
        {bundle.teeth && bundle.teeth.length > 0 ? (
          <>
            <dt>
              test teeth <GradeBadge grade="advisory" />
            </dt>
            <dd>{bundle.teeth.map((t) => formatTestTeeth(t).replace(/^test teeth: /, "")).join("; ")}</dd>
          </>
        ) : null}
        <dt>
          tools <GradeBadge grade="checked" />
        </dt>
        <dd>{bundle.tools.length > 0 ? bundle.tools.map((t) => `${t.capability} v${t.version} (${t.uses} use(s))`).join("; ") : "none"}</dd>
        <dt>
          decisions <GradeBadge grade="advisory" />
        </dt>
        <dd>{bundle.decisions.length > 0 ? `${bundle.decisions.length} advisory (never part of the proof)` : "none"}</dd>
        <dt>
          human <GradeBadge grade="decided" />
        </dt>
        <dd>{bundle.human.length > 0 ? bundle.human.map((h) => `${h.ref}: ${h.decision}`).join("; ") : "none"}</dd>
        <dt>
          stalls <GradeBadge grade="recorded" />
        </dt>
        <dd>
          {bundle.lapses.length} lapse(s), {bundle.replans.length} re-plan(s), {bundle.escalations.length} escalation(s), {bundle.clashes.length} clash prediction(s)
          {bundle.caps.length > 0 ? `, caps reached: ${bundle.caps.map((c) => c.kind).join(", ")}` : ""}
        </dd>
      </dl>
      {bundle.incompleteItems.length > 0 ? <p className="muted">not completed: {bundle.incompleteItems.join(", ")}</p> : null}
    </div>
  );
}

/** A small evidence-grade badge: how much the statement beside it is worth. */
export function GradeBadge({ grade }: { grade: EvidenceGrade }) {
  return (
    <span className={`mc-grade grade-${grade}`} title={`${GRADE_INFO[grade].label}: ${GRADE_INFO[grade].meaning}`}>
      {GRADE_INFO[grade].label}
    </span>
  );
}

/** The fold group a routine message belongs to; consecutive runs of one group fold into a single row. */
function foldKey(m: BoardMessage): string | null {
  switch (m.type) {
    case "agent.left":
      return "left";
    case "agent.joined":
      return (m.payload as { role?: string }).role === "lead" ? null : "joined";
    case "item.claimed":
    case "claim.granted":
      return "claim";
    case "item.proposed":
      return "proposed";
    case "token.refreshed":
      return "token";
    default:
      return null;
  }
}

/** Fewer than this many routine messages in a row stay unfolded. */
const FOLD_MIN = 3;

export type ThreadEntry = { readonly kind: "one"; readonly message: BoardMessage } | { readonly kind: "fold"; readonly key: string; readonly messages: readonly BoardMessage[] };

/** The thread's rows: routine messages in a row (claims, joins, departures, proposals) fold into one. */
export function foldThread(messages: readonly BoardMessage[]): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  let i = 0;
  while (i < messages.length) {
    const key = foldKey(messages[i]!);
    let j = i + 1;
    if (key !== null) {
      while (j < messages.length && foldKey(messages[j]!) === key) j += 1;
    }
    if (key !== null && j - i >= FOLD_MIN) {
      out.push({ kind: "fold", key, messages: messages.slice(i, j) });
    } else {
      for (let x = i; x < j; x += 1) out.push({ kind: "one", message: messages[x]! });
    }
    i = j;
  }
  return out;
}

function names(list: readonly string[], max = 4): string {
  const unique = [...new Set(list)];
  return unique.length > max ? `${unique.slice(0, max).join(", ")} and ${unique.length - max} more` : unique.join(", ");
}

/** The one sentence a folded run of routine messages reads as. */
export function foldSummary(key: string, messages: readonly BoardMessage[]): string {
  const field = (m: BoardMessage, k: string) => String((m.payload as Record<string, unknown>)[k] ?? "");
  switch (key) {
    case "left":
      return `${messages.length} agents leave the board (${names(messages.map((m) => m.from))}).`;
    case "joined":
      return `${messages.length} agents join the board (${names(messages.map((m) => m.from))}).`;
    case "claim": {
      const grants = messages.filter((m) => m.type === "claim.granted");
      return grants.length > 0
        ? `${grants.length} claim${grants.length === 1 ? "" : "s"} granted: ${names(grants.map((m) => `${field(m, "item")} to ${field(m, "agent")}`), 3)}.`
        : `${messages.length} claim requests (${names(messages.map((m) => field(m, "item")))}).`;
    }
    case "proposed":
      return `${messages[0]!.from === "lead" ? "The lead" : names(messages.map((m) => m.from))} proposes ${messages.length} items: ${names(messages.map((m) => field(m, "item")), 6)}.`;
    case "token":
      return `${messages.length} tokens refreshed (never shown).`;
    default:
      return `${messages.length} messages.`;
  }
}

/** The order the thread lists its messages in. */
export type ThreadOrder = "newest" | "oldest";

export const THREAD_ORDER_KEY = "switchyard.thread.order";

/** The remembered thread order (newest first by default; storage may be blocked). */
export function readThreadOrder(storage: Pick<Storage, "getItem"> | undefined = threadStorage()): ThreadOrder {
  try {
    return storage?.getItem(THREAD_ORDER_KEY) === "oldest" ? "oldest" : "newest";
  } catch {
    return "newest";
  }
}

/** Remember the thread order (a blocked storage keeps it for this page only). */
export function storeThreadOrder(order: ThreadOrder, storage: Pick<Storage, "setItem"> | undefined = threadStorage()): void {
  try {
    storage?.setItem(THREAD_ORDER_KEY, order);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

function threadStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** One end of a message's direction: who, and the role chip it is drawn with. */
export interface Party {
  readonly id: string;
  readonly role: "agent" | "lead" | "engine" | "human" | "everyone";
}

/** A message's direction: its sender, its recipients, and whether the recipients were read from the board rather than addressed. */
export interface MessageDirection {
  readonly from: Party;
  readonly to: readonly Party[];
  /** True when the message named no recipient and the overlay's rule (from the board) names who it concerns. */
  readonly implied: boolean;
}

/**
 * Who sent a message and to whom, from recorded data only: the message's own
 * `to` when it names one; else, for a coordination message, who the talk
 * overlay's rule says it concerns (`implied`, from the board before it); else
 * everyone on the board (a board post is visible to all).
 */
export function messageDirection(m: BoardMessage, leads: ReadonlySet<string>, implied?: readonly string[]): MessageDirection {
  const party = (id: string): Party => ({
    id,
    role: id === "engine" ? "engine" : id === "human" ? "human" : leads.has(id) ? "lead" : "agent",
  });
  const from = party(m.from);
  if (m.to && m.to.length > 0) return { from, to: m.to.map(party), implied: false };
  if (implied && implied.length > 0) return { from, to: implied.map(party), implied: true };
  return { from, to: [{ id: "everyone", role: "everyone" }], implied: false };
}

/** The leads of a board log (agent.joined with the lead role). */
function boardLeads(log: readonly BoardMessage[] | undefined): Set<string> {
  const out = new Set<string>(["lead"]);
  for (const m of log ?? []) if (m.type === "agent.joined" && m.payload.role === "lead") out.add(m.from);
  return out;
}

/** Per seq, who a coordination message concerns, as the talk overlay reads it (participant ids). */
function impliedTargets(log: readonly BoardMessage[] | undefined): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!log || log.length === 0) return out;
  const last = log[log.length - 1]!.seq;
  for (const a of communicationArrows(log, last, { window: 0, max: Number.MAX_SAFE_INTEGER })) {
    if (a.to === null) continue;
    const id = a.to.replace(/^agent:/, "");
    out.set(a.seq, [...(out.get(a.seq) ?? []), id]);
  }
  return out;
}

function PartyChip({ party, onSelectAgent }: { party: Party; onSelectAgent: (agent: string) => void }) {
  const clickable = party.role === "agent" || party.role === "lead";
  return (
    <button
      type="button"
      className={`mc-party role-${party.role}`}
      disabled={!clickable}
      onClick={() => (clickable ? onSelectAgent(party.id) : undefined)}
      title={party.role === "everyone" ? "posted to the whole board, addressed to no one" : `${party.id} (${party.role})`}
    >
      {party.id}
    </button>
  );
}

/** Scroll to a message's card when it is in the list (and flash it); else select it. */
function jumpToMessage(seq: number, onSelectSeq: (seq: number) => void): void {
  const el = typeof document === "undefined" ? null : document.getElementById(`mc-msg-${seq}`);
  if (!el) {
    onSelectSeq(seq);
    return;
  }
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el.classList.remove("is-flash");
  // Restart the flash on a repeated click.
  void el.offsetWidth;
  el.classList.add("is-flash");
}

export function Thread({
  messages,
  title,
  selectedSeq,
  onSelectSeq,
  onSelectAgent,
  log,
  order,
  onOrder,
}: {
  /** The messages to list, oldest first when `order` is given (the thread then lists them in that order). */
  messages: readonly BoardMessage[];
  title: string;
  selectedSeq: number | null;
  onSelectSeq: (seq: number) => void;
  onSelectAgent: (agent: string) => void;
  /** The board log, for each row's plain sentence and its recorded causes. Without it, rows show the typed summary only. */
  log?: readonly BoardMessage[];
  /** Newest or oldest first; without it the messages are listed as given and no toggle is shown. */
  order?: ThreadOrder;
  onOrder?: (order: ThreadOrder) => void;
}) {
  const leads = useMemo(() => boardLeads(log), [log]);
  const implied = useMemo(() => impliedTargets(log), [log]);
  const bySeq = useMemo(() => new Map((log ?? messages).map((m) => [m.seq, m])), [log, messages]);
  const shown = order === undefined ? messages : [...messages].sort((a, b) => (order === "newest" ? b.seq - a.seq : a.seq - b.seq));
  const inList = new Set(shown.map((m) => m.seq));
  const row = (m: BoardMessage) => {
    const family = boardMessageFamily(m.type);
    const plain = log ? narrateMessage(m, log, payloadSummary).text : undefined;
    const grade = gradeOf(m);
    const dir = messageDirection(m, leads, implied.get(m.seq));
    const parent = m.inReplyTo !== undefined ? bySeq.get(m.inReplyTo) : undefined;
    return (
      <li
        key={m.seq}
        id={`mc-msg-${m.seq}`}
        className={`mc-msg fam-${family}${selectedSeq === m.seq ? " is-selected" : ""}${m.inReplyTo !== undefined ? " is-reply" : ""}`}
      >
        {m.inReplyTo !== undefined ? (
          <div className="mc-msg-reply">
            <span aria-hidden="true">{"↳"}</span> reply to{" "}
            <button
              type="button"
              className="mc-seq-link"
              onClick={() => jumpToMessage(m.inReplyTo!, onSelectSeq)}
              title={inList.has(m.inReplyTo) ? "jump to the message it answers (in this list)" : "open the message it answers"}
            >
              re seq {m.inReplyTo}
            </button>
            {parent ? (
              <span className="mc-msg-reply-what">
                {parent.from}&apos;s {parent.type}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="mc-msg-dir" aria-label={`from ${dir.from.id} to ${dir.to.map((p) => p.id).join(", ")}`}>
          <PartyChip party={dir.from} onSelectAgent={onSelectAgent} />
          <span className="mc-dir-arrow" aria-hidden="true">
            {"→"}
          </span>
          {dir.to.map((p) => (
            <PartyChip key={p.id} party={p} onSelectAgent={onSelectAgent} />
          ))}
          {dir.implied ? (
            <span className="mc-dir-note" title="the message named no recipient; this is who it concerns on the board (it was posted to everyone)">
              concerns
            </span>
          ) : null}
        </div>
        {plain !== undefined ? <div className="mc-msg-plain">{plain}</div> : null}
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
          {grade ? <GradeBadge grade={grade} /> : null}
        </div>
        <div className={`mc-msg-body${plain !== undefined ? " is-raw" : ""}`}>{payloadSummary(m)}</div>
        {m.rationale ? (
          <q className="mc-rationale" title={m.from === "engine" ? "the engine's note" : `${m.from}'s own words: claimed, never counted`}>
            {m.rationale}
          </q>
        ) : null}
      </li>
    );
  };
  return (
    <div className="mc-thread">
      <div className="mc-thread-head">
        <h3>
          {title} <span className="muted">({messages.length})</span>
        </h3>
        {order !== undefined && onOrder ? (
          <span className="mc-thread-order" role="group" aria-label="Thread order">
            {(["newest", "oldest"] as const).map((o) => (
              <button key={o} type="button" className={order === o ? "is-active" : ""} aria-pressed={order === o} onClick={() => onOrder(o)}>
                {o} first
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {messages.length === 0 ? <p className="muted">No messages yet.</p> : null}
      <ol className="mc-thread-list">
        {foldThread(shown).map((entry) =>
          entry.kind === "one" ? (
            row(entry.message)
          ) : (
            <li key={`fold-${entry.messages[0]!.seq}`} className="mc-fold">
              <details open={selectedSeq !== null && entry.messages.some((m) => m.seq === selectedSeq)}>
                <summary>
                  <span className="mc-fold-text">{foldSummary(entry.key, entry.messages)}</span>
                  <span className="mc-fold-range">
                    seq {Math.min(...entry.messages.map((m) => m.seq))} to {Math.max(...entry.messages.map((m) => m.seq))}, {entry.messages.length} messages
                  </span>
                </summary>
                <ol className="mc-thread-list">{entry.messages.map(row)}</ol>
              </details>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

export function BoardNodeDetail({ node, landed, preview }: { node: BoardGraphNode; landed?: LandedPart | undefined; preview?: RevisionPreview | undefined }) {
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
                ? d.completed.closedBy === "engine"
                  ? `completed at rev ${d.completed.n}: closed by the engine (its push #${d.completed.pushSeq ?? "?"} passed; the owner did not propose done)`
                  : `completed at rev ${d.completed.n} (${d.completed.via})`
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
            {row(
              "Running app",
              preview ? (
                <>
                  <PreviewLink preview={preview} gate={d.verdictLabel} />{" "}
                  <span className="muted">a Worker version built from this commit{preview.backfilled ? ", uploaded after the run" : ""}; the gate decides, the app is a look</span>
                </>
              ) : undefined,
            )}
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
const REPLAY_BASE_MS = 2000;

/**
 * The scrubber thumb's width in CSS px (styles.css sets it as `--mc-thumb` and
 * styles the thumb to exactly this width in every engine), so the tick row can
 * be inset by half a thumb on each side and line up with the thumb's centre.
 */
export const SCRUB_THUMB_PX = 14;

/**
 * Where the centre of a range input's thumb sits for `value`, in px from the
 * input's left edge: the thumb travels the track minus its own width, so its
 * centre runs from half a thumb at `min` to the width minus half a thumb at `max`.
 */
export function scrubThumbCenter(value: number, min: number, max: number, widthPx: number, thumbPx = SCRUB_THUMB_PX): number {
  const span = max - min;
  const frac = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0;
  return thumbPx / 2 + frac * Math.max(0, widthPx - thumbPx);
}

/**
 * Where the tick (pip) of message `seq` sits, in px from the scrubber's left
 * edge: the tick row is an SVG whose viewBox runs `min..max` with the tick
 * drawn AT x = seq, inset by half a thumb on each side (styles.css), so it
 * lands exactly under the thumb's centre at that seq.
 */
export function scrubTickX(seq: number, min: number, max: number, widthPx: number, thumbPx = SCRUB_THUMB_PX): number {
  const inner = Math.max(0, widthPx - thumbPx);
  const span = max - min;
  return thumbPx / 2 + (span > 0 ? ((seq - min) / span) * inner : 0);
}

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
      // AT the seq (never seq - 0.5): the range below puts its thumb's centre at value/max of the inset row.
      list.push(`M${m.seq} 0v10`);
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
      <div className="mc-scrub" style={{ ["--mc-thumb" as string]: `${SCRUB_THUMB_PX}px` }}>
        {/* viewBox 0..lastSeq matches the range's min..max; the row is inset half a thumb each side (styles.css). */}
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
  /** Revision previews from the snapshot; only those backed by the log's integrated.rev commit are shown. */
  readonly previews?: readonly RevisionPreview[];
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
  previews,
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
  const [threadOrder, setThreadOrder] = useState<ThreadOrder>(() => readThreadOrder());
  const live = cursor === "live" || cursor >= lastSeq;
  const k = cursor === "live" ? lastSeq : Math.min(cursor, lastSeq);
  // The seq a selection was made at: a selected revision draws its links only until the cursor moves on.
  const kRef = useRef(k);
  kRef.current = k;
  const [selectedAt, setSelectedAt] = useState<number | null>(initialSelection ? k : null);
  // A hovered gate marker can be re-rendered away under the pointer (no mouseleave): moving the cursor ends the hover.
  useEffect(() => {
    setHoverRev(null);
  }, [k]);
  useEffect(() => {
    onSeqChange?.(live ? null : k);
  }, [k, live, onSeqChange]);

  // Every projection of the log is guarded: a message the fold cannot read refuses the view at
  // that seq (with the replay controls kept), never a blank page.
  const layoutResult = useMemo(() => attempt(() => scaledBoardLayout(log)), [log]);
  // Previews whose commit matches the log's integrated.rev of the same number (no unbacked link).
  const backed = useMemo(() => backedPreviews(log, previews ?? []), [log, previews]);
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
    setSelectedAt(kRef.current);
    setTab((t) => (t === "tools" ? "thread" : t));
  }, []);

  // The overlays at K: the talk arrows, the gate timeline, the progress chart, the advisory decisions.
  const arrows = useMemo(() => (talk ? (attempt(() => communicationArrows(log, k)).value ?? []) : []), [log, k, talk]);
  const chart = useMemo(() => attempt(() => progressChart(log, k)).value ?? { series: [] }, [log, k]);

  const story = useMemo(() => runChapters(log), [log]);
  const seek = useCallback(
    (seq: number) => {
      setPlaying(false);
      setCursor(seq >= lastSeq ? "live" : seq);
    },
    [lastSeq],
  );

  // The replay controls render even when the graph refuses to draw, so a bad seq never strands the viewer.
  const replayBar = (
    <ReplayBar
      log={log}
      k={k}
      live={live}
      playing={playing}
      speed={speed}
      recorded={recorded}
      onSeek={seek}
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

  const cards = escalationCards(model, escalations, live, recorded, log);
  // Oldest first here; the thread lists them in the chosen order.
  const thread = selection ? boardThread(log, k, selection, model.state) : boardPrefix(log, k).slice(-40);
  const threadTitle = !selection
    ? `Latest board messages (${threadOrder} first)`
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
  // A selected revision is focused (its node and links drawn) only at the seq it was selected at:
  // once the cursor moves on, the anchor goes back to the latest revision's open fix requests.
  const focusRev = hoverRev ?? (selectedAt === k ? selectedRev : null);
  const landed = selectedNode?.detail.kind === "rev" ? speculativeLanded(log, k, selectedNode.detail.n) : undefined;

  const narration = narrateAt(log, k, payloadSummary);
  const narratedRev = narration?.type === "integrated.rev" ? log.find((m) => m.seq === narration.seq) : undefined;
  const narratedPreview = narratedRev?.type === "integrated.rev" ? backed.get(narratedRev.payload.n) : undefined;
  const narratedMarker = narratedPreview ? markers.find((m) => m.n === narratedPreview.n) : undefined;
  const selectSeqInThread = (seq: number) => {
    select({ kind: "seq", seq });
    setTab("thread");
  };

  return (
    <section className={`mc${recorded ? " is-recorded" : ""}`} aria-label="Mission control">
      <div className="mc-timeline" aria-label="Timeline">
        <div className="mc-timeline-head">
          <Narrator
            narration={narration}
            onSelectSeq={selectSeqInThread}
            preview={narratedPreview && narratedMarker ? { preview: narratedPreview, gate: GATE_WORD[narratedMarker.verdict] } : undefined}
          />
          <Ticker ticker={model.ticker} live={live} k={k} lastSeq={lastSeq} recorded={recorded} teams={subLeadTeams(model)} />
        </div>
        <div className="mc-timeline-story">
          <ChapterStrip
            chapters={story}
            k={k}
            markers={markers}
            focus={focusRev}
            onHover={setHoverRev}
            onSelect={(n) => {
              select({ kind: "node", id: `rev:${n}` });
              setTab("node");
            }}
            onSeek={seek}
            previews={backed}
          />
        </div>
        {replayBar}
      </div>
      <BoardPane
        model={model}
        cards={cards}
        selection={selection}
        busy={busy}
        onSelect={select}
        onResolve={onResolve}
        log={log}
        charts={
          chart.series.length > 0 ? (
            <div className="mc-charts">
              <p className="mc-charts-note">
                How many tests pass at each revision (r1, r2, ...). <span className="advisory">Advisory</span>: the counts are read from the gate&apos;s
                output; only the gate decides pass or fail.
              </p>
              {chart.series.map((series) => (
                <SuiteChart key={series.suite} series={series} landed={chart.landed} focus={focusRev} />
              ))}
            </div>
          ) : null
        }
      />
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
            log={log}
            order={threadOrder}
            onOrder={(next) => {
              storeThreadOrder(next);
              setThreadOrder(next);
            }}
          />
        ) : tab === "node" ? (
          selectedNode ? (
            <BoardNodeDetail node={selectedNode} landed={landed} preview={selectedNode.detail.kind === "rev" ? backed.get(selectedNode.detail.n) : undefined} />
          ) : (
            <p className="muted mc-empty">Select an item, agent, revision, tool, or decision.</p>
          )
        ) : tab === "proof" ? (
          <ProofPanel bundle={proofResult.value} onSelectSeq={(seq) => select({ kind: "seq", seq })} />
        ) : (
          <ToolsRegistry model={model} />
        )}
      </div>
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

/** The graph classes each edge variant is drawn with, so its legend swatch matches the drawing exactly. */
const EDGE_SWATCH_CLASS: Readonly<Record<EdgeVariant, string>> = {
  dependency: "mc-edge kind-dependency",
  fork: "mc-edge kind-dependency label-fork",
  merged: "mc-edge kind-dependency label-merged",
  trigger: "mc-edge kind-trigger",
  "consumed-tool": "mc-edge kind-consumed-tool",
  contest: "mc-edge kind-contest contest-open",
  "contest-escalated": "mc-edge kind-contest contest-escalated",
  message: "mc-edge kind-message",
};

/** A legend swatch: a short line (or talk curve) drawn with the real graph classes. */
function LegendSwatch({ entryKey }: { entryKey: LegendKey }) {
  return (
    <svg className="mc-legend-svg" width={26} height={12} viewBox="0 0 26 12" aria-hidden="true">
      {entryKey.startsWith("talk-") ? (
        <g className={`mc-talk-arrow ${entryKey}`}>
          <path d="M 2 10 Q 13 0 24 10" />
        </g>
      ) : (
        <g className={EDGE_SWATCH_CLASS[entryKey as EdgeVariant]}>
          <line x1={1} y1={6} x2={25} y2={6} />
        </g>
      )}
    </svg>
  );
}

/** A card-mark swatch (the hull's done check or struggling mark), drawn with the real hull classes. */
function MarkSwatch({ mark }: { mark: "done" | "proposed" | "struggling" }) {
  return (
    <svg className="mc-legend-svg" width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">
      {mark === "struggling" ? (
        <g className="mc-struggling">
          <circle cx={10} cy={10} r={8.5} />
          <text x={10} y={14.5} textAnchor="middle">
            !
          </text>
        </g>
      ) : (
        <>
          <circle className={`mc-check ${mark === "done" ? "is-filled" : "is-hollow"}`} cx={10} cy={10} r={8.5} />
          <text className="mc-check-mark" x={10} y={14.5} textAnchor="middle">
            {"✓"}
          </text>
        </>
      )}
    </svg>
  );
}

/**
 * The graph legend for what is drawn NOW: each edge variant and talk kind on
 * screen with its count, then one line naming those not on screen (hover one
 * for when it appears). The card marks and the revision note are always listed.
 */
export function BoardLegend({ present, absent }: { present: readonly LegendEntry[]; absent: readonly LegendEntry[] }) {
  const edges = present.filter((e) => !e.key.startsWith("talk-"));
  const talk = present.filter((e) => e.key.startsWith("talk-"));
  return (
    <ul className="legend mc-legend" aria-label="Board legend">
      {edges.map((e) => (
        <li key={e.key} data-legend={e.key}>
          <LegendSwatch entryKey={e.key} /> {e.label} <span className="mc-legend-count">x{e.count}</span>
        </li>
      ))}
      {talk.length > 0 ? (
        <li className="mc-legend-talk">
          agent talk (overlay from recorded messages, not a graph edge):
          {talk.map((e) => (
            <span key={e.key} data-legend={e.key}>
              <LegendSwatch entryKey={e.key} /> {e.label} <span className="mc-legend-count">x{e.count}</span>
            </span>
          ))}
        </li>
      ) : null}
      <li>
        <span className="swatch-hex sw-neutral" aria-hidden="true" /> revision: on the gate timeline; hover one for its links (the latest one's open fix requests are drawn from the top right)
      </li>
      <li>
        <svg className="mc-legend-svg" width={26} height={12} viewBox="0 0 26 12" aria-hidden="true">
          <g className="mc-rev-focus status-pass">
            <g className="mc-edge kind-dependency">
              <path d="M 1 3 L 25 3" />
            </g>
          </g>
          <g className="mc-rev-focus status-fail">
            <g className="mc-edge kind-dependency">
              <path d="M 1 9 L 25 9" />
            </g>
          </g>
        </svg>{" "}
        focused revision: its merged-item links turn green (pass) or red (fail)
      </li>
      <li data-legend="mark-done">
        <MarkSwatch mark="done" /> done: completed on a passing revision
      </li>
      <li data-legend="mark-proposed">
        <MarkSwatch mark="proposed" /> done proposed, not yet confirmed by a passing revision
      </li>
      <li data-legend="mark-struggling">
        <MarkSwatch mark="struggling" /> struggling: a failing revision blamed its push, repeated failed edits, or half its turns spent with no push; idle agents may volunteer (hover a card's mark for the reason)
      </li>
      {absent.length > 0 ? (
        <li className="mc-legend-absent">
          Not on screen now:{" "}
          {absent.map((e, i) => (
            <span key={e.key} data-legend-absent={e.key} title={e.hint}>
              {e.name}
              {i < absent.length - 1 ? ", " : ""}
            </span>
          ))}
        </li>
      ) : null}
    </ul>
  );
}

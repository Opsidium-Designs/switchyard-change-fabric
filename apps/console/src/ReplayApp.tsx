import { useCallback, useEffect, useMemo, useState } from "react";

import { MissionControl } from "./mission-control";
import { ThemeToggle } from "./theme";
import { readPreviews } from "./previews.ts";
import {
  finalVerdict,
  loadReplay,
  loadReplayIndex,
  parseReplayParams,
  replaySearch,
  type FinalVerdict,
  type ReplayIndexEntry,
  type ReplayRun,
} from "./replay-data";

/**
 * The static REPLAY page (a `--mode replay` build): recorded board runs played
 * back in the browser. It renders the same mission control as a live board run
 * (graph, board, threads, tools, progress, scrubber) over a recorded log, with
 * everything live removed: no launcher, no templates, no deploy, no polling,
 * and no escalation can be answered. The final verdict is shown exactly as the
 * run recorded it.
 *
 * Deep links: `?run=<id>` opens a run at its end, `?run=<id>&seq=<n>` at seq n.
 */

export const RECORDED_BANNER = "Recorded run, replayed in your browser. No agents are running.";

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

export function ReplayApp() {
  const initial = useMemo(() => parseReplayParams(currentSearch()), []);
  const [runs, setRuns] = useState<readonly ReplayIndexEntry[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(initial.run);
  const [startSeq, setStartSeq] = useState<number | null>(initial.seq);
  const [run, setRun] = useState<ReplayRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Where the replay cursor is: null at the end of the log (the final state).
  const [watching, setWatching] = useState<number | null>(initial.seq);

  useEffect(() => {
    let cancelled = false;
    loadReplayIndex(fetch)
      .then((list) => !cancelled && setRuns(list))
      .catch((err: unknown) => !cancelled && setIndexError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (runId === null) {
      setRun(null);
      setRunError(null);
      return;
    }
    let cancelled = false;
    setRun(null);
    setRunError(null);
    loadReplay(fetch, runId)
      .then((loaded) => !cancelled && setRun(loaded))
      .catch((err: unknown) => !cancelled && setRunError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Back/forward between the picker and a run.
  useEffect(() => {
    const onPop = () => {
      const params = parseReplayParams(window.location.search);
      setStartSeq(params.seq);
      setRunId(params.run);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const open = useCallback((id: string | null) => {
    window.history.pushState(null, "", `${window.location.pathname}${replaySearch(id, null)}`);
    setStartSeq(null);
    setRunId(id);
    window.scrollTo(0, 0);
  }, []);

  // Keep the URL on the moment being watched, so it can be shared.
  const onSeqChange = useCallback(
    (seq: number | null) => {
      setWatching(seq);
      if (runId === null) return;
      const next = `${window.location.pathname}${replaySearch(runId, seq)}`;
      if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(null, "", next);
    },
    [runId],
  );

  const entry = runs?.find((r) => r.id === runId) ?? null;

  return (
    <main className={`app-shell replay-shell${runId !== null ? " is-wide" : ""}`}>
      <header className="app-header replay-header">
        <div>
          <h1>
            <a href={`${typeof window === "undefined" ? "" : window.location.pathname}`} onClick={(e) => { e.preventDefault(); open(null); }}>
              Switchyard Change Fabric
            </a>
            <span className="replay-mark">replay</span>
          </h1>
          {runId === null ? (
            <p className="tagline">
              AI agents form around a goal on a shared board: they claim work, negotiate shared contracts, help each other, build
              tools, and only a revision that passes the app&apos;s own gate counts.
            </p>
          ) : null}
        </div>
        <ThemeToggle />
      </header>

      {runId === null ? (
        <p className="replay-banner" role="status">
          <strong>{RECORDED_BANNER}</strong> Every node and message below is a recorded board message from a real run; nothing is
          simulated or re-run.
        </p>
      ) : null}

      {runId === null ? (
        <RunPicker runs={runs} error={indexError} onOpen={open} />
      ) : (
        <>
          <section className="app-panel replay-run-head" aria-label="Recorded run">
            <div className="replay-run-title">
              <button type="button" className="secondary" onClick={() => open(null)}>
                All recorded runs
              </button>
              <h2>{entry?.title ?? runId}</h2>
              {entry ? <span className="replay-app">{entry.app}</span> : null}
              <span
                className="replay-recorded-chip"
                role="status"
                title="Every node and message below is a recorded board message from a real run; nothing is simulated or re-run."
              >
                {RECORDED_BANNER}
              </span>
              {run ? <ReadingGuide /> : null}
            </div>
            {run ? (
              <>
                <GoalLine goal={runGoal(run)} />
                {watching === null ? <VerdictPanel verdict={finalVerdict(run)} /> : <VerdictTeaser verdict={finalVerdict(run)} />}
              </>
            ) : null}
            {runError ? <p className="error">{runError}</p> : null}
            {!run && !runError ? <p className="muted">Loading the recorded board log...</p> : null}
          </section>
          {run ? (
            <MissionControl
              key={run.changeId}
              log={run.messages}
              escalations={[]}
              busy={false}
              onResolve={() => undefined}
              recorded
              previews={readPreviews(run.snapshot)}
              {...(startSeq !== null ? { initialSeq: startSeq } : {})}
              {...(initial.tab !== null && run.changeId === initial.run ? { initialTab: initial.tab } : {})}
              onSeqChange={onSeqChange}
            />
          ) : null}
        </>
      )}
    </main>
  );
}

/** The goal as the human posted it (the first board message), else the snapshot's objective. */
export function runGoal(run: ReplayRun): string {
  const first = run.messages[0];
  return first?.type === "goal.posted" ? first.payload.objective : (run.snapshot?.objective ?? "");
}

/** The final verdict, exactly as the run recorded it (never inferred from the replay position). */
export function VerdictPanel({ verdict }: { verdict: FinalVerdict }) {
  return (
    <div className={`replay-verdict is-${verdict.kind}`} role="note" aria-label="Final verdict">
      <span className="replay-verdict-word">{verdict.headline}</span>
      <span className="replay-verdict-detail">
        <strong>Final verdict, as recorded at the end of the run.</strong> {verdict.detail}
        {verdict.kind === "verified" || verdict.kind === "failed" ? " The gate on the integrated tree decides; the agents cannot mark their own work done." : ""}
      </span>
    </div>
  );
}

/** The goal on one line; click to read all of it. */
function GoalLine({ goal }: { goal: string }) {
  const [open, setOpen] = useState(false);
  return (
    <p className={`replay-goal${open ? " is-open" : ""}`}>
      <span className="replay-label">Goal</span>{" "}
      <button type="button" className="replay-goal-text" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? "show less" : "show the whole goal"}>
        {goal}
      </button>
    </p>
  );
}

/**
 * Before the end of the replay, the final verdict waits behind a click, so the
 * run is watched as it happened rather than read backwards from its ending.
 * It is the same recorded verdict, never a projection from the cursor.
 */
export function VerdictTeaser({ verdict }: { verdict: FinalVerdict }) {
  return (
    <details className={`replay-verdict-teaser is-${verdict.kind}`}>
      <summary>How this run ended (recorded verdict)</summary>
      <VerdictPanel verdict={verdict} />
    </details>
  );
}

/** A short legend of how to read mission control, for a first-time viewer. */
function ReadingGuide() {
  return (
    <details className="replay-guide">
      <summary>How to read this</summary>
      <ul>
        <li>
          <strong>Timeline</strong> (top): the first line says, in plain words, what the message at this point means, and which
          earlier messages led to it (click a seq to open it). Below it, the run in chapters: planning, building, one fix round per
          revision, then promotion. Each round ends at its revision&apos;s gate marker, green when the gate passed and red when it
          failed, with its acceptance count; a marker appears only once the replay reaches it. Play, scrub, or jump to a key moment
          underneath; the address bar keeps the exact moment as a link.
        </li>
        <li>
          <strong>Board</strong> (left): acceptance over revisions, then the work items the lead planned, by state. An agent
          <em> claims</em> an item before it edits; overlapping claims are <em>contested</em>.
        </li>
        <li>
          <strong>Graph</strong> (middle): each rounded box is an item with the agents working in it; orange squares are tools agents
          built for each other. Short curved teal arrows show who just proposed to, asked, handed off to, or contested whom; they
          fade over the next few messages. Advisory model decisions (Jev) are listed in their own panel under the graph.
        </li>
        <li>
          <strong>Thread</strong> (right): the raw board messages. Click any item, agent, or revision to filter to its messages.
        </li>
      </ul>
    </details>
  );
}

function RunPicker({
  runs,
  error,
  onOpen,
}: {
  runs: readonly ReplayIndexEntry[] | null;
  error: string | null;
  onOpen: (id: string) => void;
}) {
  if (error) {
    return (
      <section className="app-panel">
        <p className="error">{error}</p>
      </section>
    );
  }
  if (runs === null) {
    return (
      <section className="app-panel">
        <p className="muted">Loading the recorded runs...</p>
      </section>
    );
  }
  if (runs.length === 0) {
    return (
      <section className="app-panel">
        <p className="muted">No recorded runs are published here yet. Export one with make export-replay ID=&lt;changeId&gt;.</p>
      </section>
    );
  }
  return (
    <section className="app-panel replay-picker" aria-label="Recorded runs">
      <h2>Pick a recorded run</h2>
      <p className="muted">
        Real runs on live infrastructure, exported from the board log. Failures are kept on purpose: an honest failure is a result.
      </p>
      <ul className="replay-list">
        {runs.map((r) => (
          <li key={r.id} className={`replay-card is-${r.outcome}`}>
            <div className="replay-card-head">
              <span className={`replay-outcome is-${r.outcome}`}>{r.outcome}</span>
              <span className="replay-app">{r.app}</span>
            </div>
            <h3>{r.title}</h3>
            <p className="replay-card-desc">{r.description}</p>
            <div className="replay-card-foot">
              {r.messages !== undefined ? <span className="muted">{r.messages} board messages</span> : <span />}
              <a
                className="replay-open"
                href={replaySearch(r.id, null)}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(r.id);
                }}
              >
                Watch the replay
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

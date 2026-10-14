/**
 * The live console's home-page runs table and the run page's app panel.
 *
 * HOME lists the recorded replays (from public/replays/index.json, each with
 * an "Open replay" link to the separate replay page) and the runs this
 * console's launcher knows (launched here) plus the last run followed with
 * ?watch=; each live run opens its run page.
 *
 * The RUN page's app panel shows THIS run's app in two versions: the original
 * (the stable Worker's production deploy) and the version fixed by this run (a
 * preview version of the same Worker): a backed passing-revision preview from
 * a board run, or the promoted commit published after the run. Everything it
 * shows is backed by recorded state: the deployment marker, the Worker's
 * recorded previews (checked against the board's integrated.rev commits), the
 * Worker's integration verdict, and the launcher's record of the run's own
 * output. The gate stays the only verdict; a preview is a look.
 */

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { replayHref, runHref, type ActiveRun, type LaunchedRunSummary } from "./console-route";
import { latestPassingPreview, type RevisionPreview } from "./previews";
import type { ReplayIndexEntry } from "./replay-data";
import type { Template } from "./templates";

// ---------------------------------------------------------------------------
// The active run line
// ---------------------------------------------------------------------------

/** The tooltip on a CLI run treated as active: the launcher cannot see it. */
export const WATCH_ACTIVE_TITLE =
  "This run was started from the CLI and followed here with ?watch=. The launcher cannot know about CLI runs, so it would not refuse a launch; the console holds Launch back while the Worker reports this run unfinished.";

/** "A run is in progress: <id> (open it)", shown above the templates while one is. */
export function ActiveRunNotice({ active, onOpen }: { active: ActiveRun; onOpen?: (href: string) => void }) {
  return (
    <p className="notice active-run" role="status" title={active.source === "watch" ? WATCH_ACTIVE_TITLE : undefined}>
      A run is in progress: <code>{active.changeId}</code> (
      <a
        href={active.href}
        onClick={(event) => {
          if (onOpen) {
            event.preventDefault();
            onOpen(active.href);
          }
        }}
      >
        open it
      </a>
      ). One live run at a time: Launch is disabled until it finishes.
    </p>
  );
}

// ---------------------------------------------------------------------------
// The runs table
// ---------------------------------------------------------------------------

/** The followed CLI run, as the home page knows it. */
export interface WatchedRun {
  readonly changeId: string;
  /** Null until the Worker has answered. */
  readonly finished: boolean | null;
  readonly verdict?: string;
}

/** The distinct agents that joined a recorded board log (for the runs table). */
export function joinedAgents(messages: readonly { readonly type: string; readonly from: string }[]): number {
  return new Set(messages.filter((m) => m.type === "agent.joined").map((m) => m.from)).size;
}

/** A launched run's state line for the table. */
export function launchedRunState(run: LaunchedRunSummary): string {
  if (run.status === "running") return "running";
  return run.exitCode === 0 ? "exited (code 0)" : `exited (code ${run.exitCode ?? "?"})`;
}

export function RunsTable({
  replays,
  replayError = null,
  replayAgents = {},
  replayBase,
  launched,
  launcherReachable = true,
  watched = null,
  templates,
  onOpen,
}: {
  replays: readonly ReplayIndexEntry[];
  replayError?: string | null;
  /** Replay id -> agents that joined (loaded lazily from each recorded log). */
  replayAgents?: Readonly<Record<string, number>>;
  /** The replay page's base URL, or null when it is not configured. */
  replayBase: string | null;
  launched: readonly LaunchedRunSummary[];
  /** False when GET /api/runs could not be read (no launcher). */
  launcherReachable?: boolean;
  watched?: WatchedRun | null;
  templates: readonly Template[];
  onOpen?: (href: string) => void;
}) {
  const open = (href: string) => (event: { preventDefault(): void }) => {
    if (onOpen) {
      event.preventDefault();
      onOpen(href);
    }
  };
  const templateName = (id: string) => templates.find((t) => t.id === id)?.name ?? id;
  const watchedListed = watched !== null && !launched.some((r) => r.changeId === watched.changeId);
  return (
    <section className="app-panel runs-panel" aria-label="Runs">
      <h2>Runs</h2>
      <h3>Live runs</h3>
      {launched.length === 0 && !watchedListed ? (
        <p className="muted">
          {launcherReachable
            ? "No live run yet: launch one from a template above. A run started from the CLI opens with ?watch=<change id>."
            : "The launcher is not reachable, so its runs are not listed. Is `make dev-all` running?"}
        </p>
      ) : (
        <table className="runs-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Template</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {launched.map((run) => {
              const href = runHref(run.changeId, false);
              return (
                <tr key={run.changeId}>
                  <td>
                    <code>{run.changeId}</code>
                  </td>
                  <td>{templateName(run.templateId)}</td>
                  <td>{run.mode === "board" ? "board" : "run-live"}</td>
                  <td className={`run-state${run.status === "exited" && run.exitCode !== 0 ? " is-failed" : ""}`}>{launchedRunState(run)}</td>
                  <td className="muted">{run.startedAt.replace("T", " ").slice(0, 19)}</td>
                  <td>
                    <a href={href} onClick={open(href)}>
                      Open run
                    </a>
                  </td>
                </tr>
              );
            })}
            {watched !== null && watchedListed ? (
              <tr key={`watch-${watched.changeId}`}>
                <td>
                  <code>{watched.changeId}</code>
                </td>
                <td className="muted">started from the CLI</td>
                <td className="muted">watched (read-only)</td>
                <td>{watched.finished === null ? "checking..." : watched.finished ? `finished${watched.verdict ? ` (${watched.verdict})` : ""}` : "running"}</td>
                <td className="muted">-</td>
                <td>
                  <a href={runHref(watched.changeId, true)} onClick={open(runHref(watched.changeId, true))}>
                    Open run
                  </a>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
      <p className="muted runs-note">
        The Worker has no listing of changes, so only runs launched by this console (since its dev server started) and the
        last run followed with ?watch= appear here.
      </p>

      <h3>Recorded replays</h3>
      {replayError ? <p className="error">{replayError}</p> : null}
      {replays.length === 0 && !replayError ? <p className="muted">No recorded replay.</p> : null}
      {replays.length > 0 ? (
        <table className="runs-table">
          <thead>
            <tr>
              <th>Replay</th>
              <th>App</th>
              <th>Outcome</th>
              <th>Agents</th>
              <th>Messages</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {replays.map((r) => (
              <tr key={r.id}>
                <td>{r.title}</td>
                <td>
                  <code>{r.app}</code>
                </td>
                <td className={`run-outcome is-${r.outcome}`}>{r.simulated ? `${r.outcome} (simulated)` : r.outcome}</td>
                <td>{replayAgents[r.id] ?? "..."}</td>
                <td>{r.messages ?? "-"}</td>
                <td>
                  {replayBase !== null ? (
                    <a href={replayHref(replayBase, r.id)} target="_blank" rel="noreferrer">
                      Open replay
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {replayBase === null && replays.length > 0 ? (
        <p className="muted runs-note">
          The replay page is a separate build, so its links are hidden here. Serve it with{" "}
          <code>npm -w apps/console run dev:replay</code> and set <code>VITE_REPLAY_URL</code> to its address (for example
          http://localhost:5174/) to link each replay.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The app panel
// ---------------------------------------------------------------------------

/** The latest recorded promotion on a board log. */
export function boardPromotion(log: readonly BoardMessage[]): { readonly rev: number; readonly commit: string; readonly branch?: string } | undefined {
  let out: { rev: number; commit: string; branch?: string } | undefined;
  for (const m of log) {
    if (m.type !== "revision.promoted") continue;
    const p = m.payload as { rev?: unknown; commit?: unknown; branch?: unknown };
    if (typeof p.rev === "number" && typeof p.commit === "string") {
      out = { rev: p.rev, commit: p.commit, ...(typeof p.branch === "string" ? { branch: p.branch } : {}) };
    }
  }
  return out;
}

/** The recorded verdict of a snapshot: "verified", "ungated" (verified with no gate), "failed", or null (none yet). */
export function recordedVerdict(snapshot: unknown): string | null {
  const integration = (snapshot as { integration?: { verdict?: unknown; gated?: unknown } | null } | null)?.integration;
  if (integration === null || integration === undefined || typeof integration.verdict !== "string") return null;
  return integration.verdict === "verified" && integration.gated === false ? "ungated" : integration.verdict;
}

/** The exact command a human runs to publish the fixed version of a run the launcher cannot. */
export function publishFixedCommand(input: { readonly changeId: string; readonly app: string; readonly repoDir?: string; readonly commit?: string; readonly branch?: string }): string {
  return (
    `make publish-fixed CHANGE=${input.changeId} APP=${input.app} ` +
    `REPO=${input.repoDir ?? "<the repo: line of the run's output>"} ` +
    `COMMIT=${input.commit ?? "<the promoted commit>"} BRANCH=${input.branch ?? "<the promoted branch>"}`
  );
}

/** What the app panel shows (pure, so it is tested offline). */
export interface AppPanelState {
  readonly app: string;
  /** The production URL: the original, unless a verified run-live run redeployed the fix in place. */
  readonly original: { readonly url: string; readonly servesFix: boolean } | null;
  readonly fixed: { readonly url: string; readonly label: string; readonly title: string } | null;
  /** The "Publish the fixed version" button, or null when the fixed version is already shown from the passing preview. */
  readonly publish: {
    readonly enabled: boolean;
    readonly reason: string | null;
    /** The make command to run instead, for a run the launcher does not know. */
    readonly command: string | null;
    readonly publishing: boolean;
    readonly error: string | null;
  } | null;
}

export function appPanelState(input: {
  readonly app: string;
  readonly changeId: string;
  readonly watch: boolean;
  /** The app's production URL from the deployment marker (or this session's Deploy). */
  readonly deployedUrl?: string;
  /** A verified run-live run's in-place redeploy (snapshot.deployment.url). */
  readonly redeployedUrl?: string;
  /** The launcher's record of this run, or null when it does not know it. */
  readonly launched: Pick<LaunchedRunSummary, "status" | "repoDir" | "promoted" | "fixed" | "publish"> | null;
  readonly snapshot: unknown;
  readonly boardLog: readonly BoardMessage[];
  readonly previews: readonly RevisionPreview[];
  /** A publish this page is waiting on. */
  readonly publishing?: boolean;
}): AppPanelState {
  const { app, launched } = input;
  const original = input.deployedUrl
    ? { url: input.deployedUrl, servesFix: Boolean(input.redeployedUrl) }
    : input.redeployedUrl
      ? { url: input.redeployedUrl, servesFix: true }
      : null;
  const passing = latestPassingPreview(input.boardLog, input.previews);
  const promotion = boardPromotion(input.boardLog);
  let fixed: AppPanelState["fixed"] = null;
  if (launched?.fixed) {
    fixed = {
      url: launched.fixed.url,
      label: "Fixed by this run (the promoted commit)",
      title: `A preview version of the app's Worker uploaded from the run's promoted commit ${launched.fixed.commit.slice(0, 10)}, after the gate passed.`,
    };
  } else if (passing) {
    fixed = {
      url: passing.url,
      label: `Fixed by this run (revision ${passing.n})`,
      title: `A preview version of the app's Worker uploaded from revision ${passing.n} (commit ${passing.commit.slice(0, 10)}), the latest whose gate passed. The preview is only a look; the gate decides.`,
    };
  }
  // The passing preview of the promoted revision IS the fixed version: nothing to publish.
  const coveredByPreview = passing !== undefined && promotion !== undefined && passing.n === promotion.rev;
  if (launched?.fixed || coveredByPreview) {
    return { app, original, fixed, publish: null };
  }
  const verdict = recordedVerdict(input.snapshot);
  const command = publishFixedCommand({
    changeId: input.changeId,
    app,
    ...(launched?.repoDir ? { repoDir: launched.repoDir } : {}),
    ...((launched?.promoted?.commit ?? promotion?.commit) ? { commit: (launched?.promoted?.commit ?? promotion?.commit)! } : {}),
    ...((launched?.promoted?.branch ?? promotion?.branch) ? { branch: (launched?.promoted?.branch ?? promotion?.branch)! } : {}),
  });
  const publishing = input.publishing === true || launched?.publish?.kind === "publishing";
  const error = launched?.publish?.kind === "failed" ? launched.publish.error : null;
  const refuse = (reason: string, withCommand = false): AppPanelState => ({
    app,
    original,
    fixed,
    publish: { enabled: false, reason, command: withCommand ? command : null, publishing, error },
  });
  if (input.watch) {
    return refuse("This run was started from the CLI, so the console does not know its promoted repo. Publish it from a terminal instead:", true);
  }
  if (launched === null) {
    return refuse("The launcher does not know this run (its dev server restarted?), so it cannot read the run's promoted repo. Publish it from a terminal instead:", true);
  }
  if (launched.status === "running") {
    return refuse("Available once the run has promoted and exited.");
  }
  if (verdict !== "verified") {
    return refuse(
      `Only a run verified by a gate that ran has a fixed version to publish (recorded verdict: ${verdict === "ungated" ? "verified with no gate, which checked nothing" : (verdict ?? "none")}).`,
    );
  }
  if (!launched.promoted || !launched.repoDir) {
    return refuse("The run printed no promoted commit and repo, so there is nothing to publish.");
  }
  if (!original || original.servesFix) {
    return refuse(
      original?.servesFix
        ? "The production URL serves this run's fix (redeployed in place). Deploy the original again first, then publish the fix beside it."
        : "Deploy the original first: the fixed version is uploaded as a version of the same Worker.",
    );
  }
  if (publishing) {
    return { app, original, fixed, publish: { enabled: false, reason: "Publishing the fixed version...", command: null, publishing, error } };
  }
  return { app, original, fixed, publish: { enabled: true, reason: null, command: null, publishing, error } };
}

/**
 * The run page's APP panel: the original and the version fixed by this run,
 * side by side, plus Deploy the original and Publish the fixed version.
 */
export function AppPanel({
  state,
  deploying = false,
  deployError = null,
  onDeploy,
  onPublish,
}: {
  state: AppPanelState;
  deploying?: boolean;
  deployError?: string | null;
  onDeploy: () => void;
  onPublish: () => void;
}) {
  const { app, original, fixed, publish } = state;
  return (
    <section className="app-panel run-app-panel" aria-label={`App ${app}`}>
      <h2>
        App <code>{app}</code>
      </h2>
      <div className="app-versions">
        <div className="app-version is-original">
          <strong>Original</strong>
          {original ? (
            <p>
              <a href={original.url} target="_blank" rel="noreferrer">
                {original.url}
              </a>
              <br />
              <span className="muted">
                {original.servesFix
                  ? "The production URL now serves the fix: this run redeployed it in place."
                  : "The production deploy of the original code, before any fix."}
              </span>
            </p>
          ) : (
            <p className="muted">Not deployed.</p>
          )}
          <button
            type="button"
            className="secondary"
            onClick={onDeploy}
            disabled={deploying}
            title={`Deploy examples/apps/${app} as it is in the repo (the original, broken code) to the app's stable workers.dev URL`}
          >
            {deploying ? "Deploying..." : original ? "Deploy the original app again" : "Deploy the original app"}
          </button>
          {deployError ? (
            <pre className="detail-pre app-deploy-error" role="alert">
              {deployError}
            </pre>
          ) : null}
        </div>
        <div className="app-version is-fixed">
          <strong>Fixed by this run</strong>
          {fixed ? (
            <p>
              <a href={fixed.url} target="_blank" rel="noreferrer" title={fixed.title}>
                {fixed.url}
              </a>
              <br />
              <span className="muted">{fixed.label}</span>
            </p>
          ) : (
            <p className="muted">Not yet: a fixed version appears once a revision passes its gate (a board run with the app deployed), or when published from the promoted commit.</p>
          )}
          {publish ? (
            <>
              <button type="button" onClick={onPublish} disabled={!publish.enabled} title={publish.reason ?? "Upload the run's promoted commit as a version of the app's Worker, beside the original"}>
                {publish.publishing ? "Publishing..." : "Publish the fixed version"}
              </button>
              {publish.reason ? <p className="muted publish-reason">{publish.reason}</p> : null}
              {publish.command ? <pre className="detail-pre publish-command">{publish.command}</pre> : null}
              {publish.error ? (
                <p className="error" role="alert">
                  {publish.error}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

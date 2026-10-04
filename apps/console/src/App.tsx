import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildWorkGraphModel,
  type ChangeStateSnapshot,
  type EscalationSnapshot,
  type GraphNode,
  type WorkGraphModel,
} from "@switchyard-change/orchestration/graph-model";

import { GraphView } from "./graph-view";

/**
 * Console for the Switchyard Change Fabric.
 *
 * This is the primary deliverable: a real-state-backed morphing graph of a
 * living work graph. It polls a Change's live orchestration state from the
 * Worker control API, projects that snapshot into the typed node/edge graph with
 * the shared `buildWorkGraphModel` (the exact same projection the tests pin),
 * and renders it. The morphing a watcher sees (nodes appearing as units become
 * runnable and agents are recruited, greening as evidence lands, fading on
 * cleanup) is a projection of real state transitions between successive
 * snapshots, never a timed animation.
 *
 * Honesty: because the view is `buildWorkGraphModel(state)` and every node in
 * that model carries a backing that resolves against the state (the builder
 * routes every node through `assertBacked`), it is impossible to show a node
 * with no backing state. Clicking a node reveals its real backing: for an agent
 * node, its real Artifact repo identity and its real status/evidence; for a
 * plain work node, the real WorkUnit it stands for.
 *
 * The dial is a real control, not a cosmetic slider: it POSTs the min/max to the
 * Worker's `/dial` endpoint (the single lever M2 built), and the Recruit button
 * POSTs `/recruit`, so raising max and recruiting visibly widens how many agent
 * nodes become concurrently active, by the same engine mechanism.
 */

// The Worker control API runs separately under `wrangler dev`. Override with
// VITE_WORKER_URL when it is not on the default local port.
/**
 * The seeded demo Change spec. The console cannot read repository files, so the
 * "Start the demo Change" affordance embeds the same seeded audit-logging spec
 * that `examples/changes/audit-logging.change.yaml` holds (three units, one
 * dependency, and the deliberate `src/audit/events.ts` collision that drives the
 * lease and escalation beats). Starting a Change from the UI POSTs this spec to
 * the Worker, so a fresh clone shows a live graph without hand-POSTing YAML.
 * A goal-driven start remains the CLI/`make seed-change` path, since
 * decomposition is a Node-side step that does not run in the browser.
 */
const DEMO_CHANGE_SPEC = `id: change-audit-logging
objective: Add organization-level audit logging
baseline: HEAD
budget_usd: 5.00
assurance: standard

work:
  - id: model
    objective: Implement audit event persistence
    paths:
      - src/audit/**

  - id: api
    objective: Add API read endpoints
    depends_on:
      - model
    paths:
      - src/api/audit/**
      - src/audit/events.ts

  - id: tests
    objective: Add audit logging tests
    paths:
      - tests/audit/**
      - src/audit/events.ts
`;

const WORKER_BASE: string =
  (import.meta.env.VITE_WORKER_URL as string | undefined) ?? "http://127.0.0.1:8787";
const POLL_MS = 1200;

// The demo Change id. The watch-mode live run uses this STABLE id (not a
// per-run Date.now id), so the console can auto-load it with no hand-typing.
const DEFAULT_CHANGE_ID = "change-audit-logging";

/**
 * The Change id to load on first paint: a `?change=<id>` query param when
 * present (so a watch-mode run can hand the user a direct link), otherwise the
 * stable demo id. This is what lets the console auto-load the demo Change
 * instead of making the user hand-type it.
 */
function initialChangeId(): string {
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("change");
    if (fromQuery && fromQuery.trim() !== "") {
      return fromQuery.trim();
    }
  }
  return DEFAULT_CHANGE_ID;
}

export function App() {
  const [changeId, setChangeId] = useState(initialChangeId);
  const [snapshot, setSnapshot] = useState<ChangeStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [min, setMin] = useState(1);
  const [max, setMax] = useState(3);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${WORKER_BASE}/changes/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `request failed (${res.status})`);
        setSnapshot(null);
        return;
      }
      setSnapshot((await res.json()) as ChangeStateSnapshot);
      setError(null);
    } catch {
      setError(`cannot reach the Worker at ${WORKER_BASE}`);
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    if (!polling) {
      return;
    }
    void load(changeId);
    const timer = setInterval(() => void load(changeId), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, changeId, load]);

  // Build the graph model from the live snapshot. If the snapshot ever fails the
  // backing guard (an unbacked node), surface it loudly rather than drawing a
  // dishonest graph: the no-unbacked-node rule is enforced here too, at render.
  const { model, backingError } = useMemo((): {
    model: WorkGraphModel | null;
    backingError: string | null;
  } => {
    if (!snapshot) {
      return { model: null, backingError: null };
    }
    try {
      return { model: buildWorkGraphModel(snapshot), backingError: null };
    } catch (err) {
      return {
        model: null,
        backingError: err instanceof Error ? err.message : String(err),
      };
    }
  }, [snapshot]);

  // Keep the dial inputs in sync with the real dial the state reports, so the
  // control shows the config actually in force (not a local guess).
  const reportedDial = snapshot?.dial;
  const lastDialKey = useRef<string>("");
  useEffect(() => {
    if (!reportedDial) {
      return;
    }
    const key = `${reportedDial.minConcurrency}/${reportedDial.maxConcurrency}`;
    if (key !== lastDialKey.current) {
      lastDialKey.current = key;
      setMin(reportedDial.minConcurrency);
      setMax(reportedDial.maxConcurrency);
    }
  }, [reportedDial]);

  const selectedNode: GraphNode | null = useMemo(() => {
    if (!model || !selectedId) {
      return null;
    }
    return model.nodes.find((n) => n.id === selectedId) ?? null;
  }, [model, selectedId]);

  const post = useCallback(async (path: string, body?: unknown): Promise<boolean> => {
    try {
      const res = await fetch(`${WORKER_BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(parsed.error ?? `request failed (${res.status})`);
        return false;
      }
      return true;
    } catch {
      setNotice(`cannot reach the Worker at ${WORKER_BASE}`);
      return false;
    }
  }, []);

  // Push the dial to the real recruitment config (the M2 lever), then refresh.
  const applyDial = useCallback(async () => {
    setBusy(true);
    const ok = await post(`/changes/${encodeURIComponent(changeId)}/dial`, {
      minConcurrency: min,
      maxConcurrency: max,
    });
    if (ok) {
      setNotice(`dial set to min ${min}, max ${max}`);
      await load(changeId);
    }
    setBusy(false);
  }, [post, changeId, min, max, load]);

  // Kick off a recruitment wave under the current dial through the real engine.
  const recruit = useCallback(async () => {
    setBusy(true);
    const ok = await post(`/changes/${encodeURIComponent(changeId)}/recruit`);
    if (ok) {
      setNotice("recruitment wave kicked off");
      setPolling(true);
      await load(changeId);
    }
    setBusy(false);
  }, [post, changeId, load]);

  // Start the seeded demo Change: POST the embedded spec to the Worker (the same
  // spec examples/changes/audit-logging.change.yaml holds), then load it. This
  // is the create-a-Change affordance: a fresh clone shows a live graph without
  // hand-POSTing YAML. It is idempotent on the Worker side (re-creating an
  // existing Change id just returns its state), so pressing it twice is safe.
  const startDemoChange = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`${WORKER_BASE}/changes`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: DEMO_CHANGE_SPEC,
      });
      if (res.ok) {
        setChangeId(DEFAULT_CHANGE_ID);
        setNotice(`started Change ${DEFAULT_CHANGE_ID}; recruit a wave to populate it`);
        setPolling(true);
        await load(DEFAULT_CHANGE_ID);
      } else {
        const parsed = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(parsed.error ?? `could not start the Change (${res.status})`);
      }
    } catch {
      setNotice(`cannot reach the Worker at ${WORKER_BASE}`);
    }
    setBusy(false);
  }, [load]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Switchyard Change Fabric</h1>
        <p className="tagline">A living work graph, every node backed by real state</p>
      </header>

      <section className="app-panel" aria-label="Load a Change">
        <form
          className="load-row"
          onSubmit={(event) => {
            event.preventDefault();
            setPolling(true);
            void load(changeId);
          }}
        >
          <label htmlFor="change-id">Change id</label>
          <input
            id="change-id"
            value={changeId}
            onChange={(event) => setChangeId(event.target.value)}
            spellCheck={false}
          />
          <button type="submit">Load</button>
          <button
            type="button"
            className="secondary"
            onClick={() => setPolling((value) => !value)}
          >
            {polling ? "Pause polling" : "Resume polling"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void startDemoChange()}
            disabled={busy}
            title="POST the seeded audit-logging Change to the Worker and load it"
          >
            Start the demo Change
          </button>
        </form>
        <p className="muted">
          No Change yet? Press <strong>Start the demo Change</strong> to seed the
          example audit-logging Change into the Worker, then <strong>Recruit
          wave</strong> below to watch the graph populate. (A goal-driven start is
          the CLI / <code>make seed-change</code> path.)
        </p>
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="notice">{notice}</p> : null}
      </section>

      {snapshot ? (
        <section className="app-panel dial-panel" aria-label="Concurrency dial">
          <h2>Concurrency dial</h2>
          <p className="muted">
            The min/max dial is the real recruitment config. Raise max and recruit
            to widen how many agent nodes run at once, by the same engine mechanism.
          </p>
          <div className="dial-row">
            <label htmlFor="dial-min">min</label>
            <input
              id="dial-min"
              type="range"
              min={0}
              max={8}
              value={min}
              onChange={(event) => setMin(Number(event.target.value))}
            />
            <span className="dial-value">{min}</span>
            <label htmlFor="dial-max">max</label>
            <input
              id="dial-max"
              type="range"
              min={1}
              max={8}
              value={max}
              onChange={(event) => setMax(Number(event.target.value))}
            />
            <span className="dial-value">{max}</span>
            <button type="button" onClick={() => void applyDial()} disabled={busy}>
              Apply dial
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void recruit()}
              disabled={busy}
            >
              Recruit wave
            </button>
          </div>
          {reportedDial ? (
            <p className="muted">
              in force now: min {reportedDial.minConcurrency}, max{" "}
              {reportedDial.maxConcurrency}
            </p>
          ) : null}
        </section>
      ) : null}

      {backingError ? (
        <section className="app-panel" aria-label="Honesty guard">
          <p className="error">
            Refusing to render: a node had no backing state ({backingError}). The graph
            only draws nodes that map to real ChangeState.
          </p>
        </section>
      ) : null}

      {snapshot && (snapshot.escalations?.length ?? 0) > 0 ? (
        <EscalationPanel
          escalations={snapshot.escalations ?? []}
          busy={busy}
          onResolve={async (id, decision) => {
            setBusy(true);
            const ok = await post(
              `/changes/${encodeURIComponent(changeId)}/escalations/${encodeURIComponent(id)}/resolve`,
              { decision },
            );
            if (ok) {
              setNotice(`escalation ${id} resolved: ${decision}`);
              await load(changeId);
            }
            setBusy(false);
          }}
        />
      ) : null}

      {model ? (
        <section className="app-panel graph-panel" aria-label="Living work graph">
          <GraphView model={model} selectedId={selectedId} onSelect={setSelectedId} />
          <Legend />
        </section>
      ) : null}

      {selectedNode ? (
        <NodeDetail node={selectedNode} onClose={() => setSelectedId(null)} />
      ) : null}
    </main>
  );
}

/** The legend explaining node and edge kinds, including the reserved ones. */
function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
      <li><span className="swatch sw-goal" /> goal</li>
      <li><span className="swatch sw-work" /> work unit</li>
      <li><span className="swatch sw-agent" /> recruited agent (real repo)</li>
      <li><span className="swatch sw-verified" /> verified / integrated</li>
      <li><span className="swatch sw-tool" /> agent-built tool (real repo)</li>
      <li><span className="swatch sw-escalated" /> pending human escalation</li>
      <li><span className="line ln-dependency" /> dependency</li>
      <li><span className="line ln-dataflow" /> data flow</li>
      <li><span className="line ln-spawn" /> event-driven spawn</li>
      <li><span className="line ln-tool" /> consumed tool</li>
      <li><span className="line ln-lease" /> write-lease (waiter to owner)</li>
    </ul>
  );
}

/**
 * The escalation panel: the pending human decisions the engine is waiting on,
 * plus the resolved ones for context. A pending escalation is a durable wait in
 * ChangeState (the engine does not self-certify past it); resolving one here
 * POSTs the human decision to the Worker, which ends the wait and lets the
 * graph advance. Each pending escalation also lights its node red in the graph.
 */
function EscalationPanel({
  escalations,
  busy,
  onResolve,
}: {
  escalations: readonly EscalationSnapshot[];
  busy: boolean;
  onResolve: (id: string, decision: string) => void | Promise<void>;
}) {
  const pending = escalations.filter((e) => e.status === "pending");
  const resolved = escalations.filter((e) => e.status === "resolved");
  return (
    <section className="app-panel escalation-panel" aria-label="Human escalations">
      <h2>Human escalations</h2>
      <p className="muted">
        A fork mechanical evidence cannot settle. The engine recorded it and is
        waiting on a human decision; it does not self-certify past it.
      </p>
      {pending.length === 0 ? (
        <p className="muted">No pending escalation.</p>
      ) : (
        <ul className="escalation-list">
          {pending.map((escalation) => (
            <li key={escalation.id} className="escalation pending">
              <p className="escalation-question">{escalation.question}</p>
              <p className="muted">
                {escalation.kind}
                {escalation.unitId ? ` on ${escalation.unitId}` : ""}
                {escalation.path ? ` (${escalation.path})` : ""}
              </p>
              <div className="escalation-options">
                {(escalation.options ?? []).length > 0 ? (
                  (escalation.options ?? []).map((option) => (
                    <button
                      key={option}
                      type="button"
                      disabled={busy}
                      onClick={() => void onResolve(escalation.id, option)}
                    >
                      {option}
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onResolve(escalation.id, "proceed")}
                  >
                    Resolve
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {resolved.length > 0 ? (
        <details className="escalation-resolved">
          <summary>{resolved.length} resolved</summary>
          <ul>
            {resolved.map((escalation) => (
              <li key={escalation.id} className="muted">
                {escalation.question} -&gt; <strong>{escalation.decision}</strong>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * The node detail panel: the real backing of the clicked node. For an agent
 * node this is its real Artifact repo identity (name, clone URL, backend, and
 * whether it is the honest fallback) and its real status; for a work node it is
 * the real WorkUnit it stands for. Nothing here is synthesized: every field is
 * read straight from the node's backing, which was validated against the state.
 */
function NodeDetail({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  const backing = node.backing;
  return (
    <section className="app-panel detail-panel" aria-label="Node detail">
      <div className="detail-head">
        <h2>
          {node.label} <span className="muted">[{node.kind}]</span>
        </h2>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="meta">
        <div>
          <dt>Status</dt>
          <dd>{node.status}</dd>
        </div>
        <div>
          <dt>Verified</dt>
          <dd>{node.verified ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Backing kind</dt>
          <dd>{backing.kind}</dd>
        </div>
      </dl>

      {node.workspace ? (
        <>
          <h3>Real Artifact repo backing</h3>
          <dl className="meta">
            <div>
              <dt>Repo name</dt>
              <dd><code>{node.workspace.workspaceName}</code></dd>
            </div>
            <div>
              <dt>Clone URL</dt>
              <dd><code>{node.workspace.gitUrl}</code></dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd><code>{node.workspace.defaultBranch}</code></dd>
            </div>
            <div>
              <dt>Backend</dt>
              <dd>
                {node.workspace.backend}
                {node.workspace.fallback ? " (honest local/offline fallback)" : " (live)"}
              </dd>
            </div>
            {node.workspace.leasedAt ? (
              <div>
                <dt>Leased at</dt>
                <dd>{node.workspace.leasedAt}</dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : (
        <p className="muted">
          No agent has been recruited for this unit yet, so it has no Artifact repo.
          It becomes an agent node (with a real repo) once the engine recruits it.
        </p>
      )}

      <details className="raw-backing">
        <summary>Raw backing state</summary>
        <pre>{JSON.stringify(node.backing, null, 2)}</pre>
      </details>
    </section>
  );
}

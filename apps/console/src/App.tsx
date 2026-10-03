import { useCallback, useEffect, useState } from "react";

/**
 * Console for the Switchyard Change Fabric.
 *
 * It reads a Change's live orchestration state from the Worker control API and
 * renders the WorkUnit list with runnable/waiting/done status plus the
 * dependency edges between units. State is polled on an interval so transitions
 * (a dependent moving from waiting to runnable as its prerequisite completes)
 * appear without a reload.
 */

type WorkUnitStatus =
  | "waiting"
  | "runnable"
  | "running"
  | "verified"
  | "failed"
  | "integrated";

interface WorkUnitView {
  id: string;
  objective: string;
  dependsOn: string[];
  paths: string[];
  status: WorkUnitStatus;
}

interface Dependency {
  from: string;
  to: string;
}

interface PathCollision {
  path: string;
  unitIds: string[];
}

interface ChangeStateView {
  id: string;
  objective: string;
  baseline: string;
  budgetUsd: number;
  assurance: string;
  work: WorkUnitView[];
  edges: Dependency[];
  collisions: PathCollision[];
  completed: string[];
}

// The Worker control API runs separately under `wrangler dev`. Override the base
// URL with VITE_WORKER_URL when it is not on the default local port.
const WORKER_BASE: string =
  (import.meta.env.VITE_WORKER_URL as string | undefined) ?? "http://127.0.0.1:8787";
const POLL_MS = 1500;

const STATUS_LABEL: Record<WorkUnitStatus, string> = {
  waiting: "waiting",
  runnable: "runnable",
  running: "running",
  verified: "verified",
  failed: "failed",
  integrated: "done",
};

export function App() {
  const [changeId, setChangeId] = useState("change-audit-logging");
  const [state, setState] = useState<ChangeStateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const load = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${WORKER_BASE}/changes/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `request failed (${res.status})`);
        setState(null);
        return;
      }
      setState((await res.json()) as ChangeStateView);
      setError(null);
    } catch {
      setError(`cannot reach the Worker at ${WORKER_BASE}`);
      setState(null);
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

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Switchyard Change Fabric</h1>
        <p className="tagline">Agent-native change coordination on Cloudflare</p>
      </header>

      <section className="app-panel" aria-label="Load a Change">
        <h2>Change state</h2>
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
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>

      {state ? <ChangeView state={state} /> : null}
    </main>
  );
}

function ChangeView({ state }: { state: ChangeStateView }) {
  const done = state.work.filter((unit) => unit.status === "integrated").length;
  return (
    <>
      <section className="app-panel" aria-label="Change overview">
        <h2>{state.id}</h2>
        <p className="objective">{state.objective}</p>
        <dl className="meta">
          <div>
            <dt>Baseline</dt>
            <dd>{state.baseline}</dd>
          </div>
          <div>
            <dt>Assurance</dt>
            <dd>{state.assurance}</dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>${state.budgetUsd.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Progress</dt>
            <dd>
              {done}/{state.work.length} done
            </dd>
          </div>
        </dl>
      </section>

      <section className="app-panel" aria-label="Work units">
        <h2>Work units</h2>
        <ul className="work-list">
          {state.work.map((unit) => (
            <li key={unit.id} className="work-item">
              <div className="work-head">
                <span className="work-id">{unit.id}</span>
                <span className={`badge badge-${unit.status}`}>
                  {STATUS_LABEL[unit.status]}
                </span>
              </div>
              <p className="work-objective">{unit.objective}</p>
              {unit.dependsOn.length > 0 ? (
                <p className="work-deps">
                  depends on: {unit.dependsOn.join(", ")}
                </p>
              ) : (
                <p className="work-deps muted">no dependencies</p>
              )}
              <ul className="paths">
                {unit.paths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section className="app-panel" aria-label="Dependency edges">
        <h2>Dependencies</h2>
        {state.edges.length > 0 ? (
          <ul className="edge-list">
            {state.edges.map((edge) => (
              <li key={`${edge.from}->${edge.to}`}>
                <code>{edge.from}</code>
                <span className="arrow"> {"->"} </span>
                <code>{edge.to}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No dependency edges.</p>
        )}
      </section>

      {state.collisions.length > 0 ? (
        <section className="app-panel" aria-label="Path collisions">
          <h2>Declared path collisions</h2>
          <ul className="collision-list">
            {state.collisions.map((collision) => (
              <li key={collision.path}>
                <code>{collision.path}</code>
                <span className="muted"> claimed by {collision.unitIds.join(", ")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

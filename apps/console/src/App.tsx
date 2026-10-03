/**
 * Console shell for the Switchyard Change Fabric.
 *
 * M0 scope: a titled single-page shell only. Later milestones wire in live
 * Change/WorkUnit state (work graph, concurrent agents, workspaces, conflicts,
 * verification/evidence, cost, promotion) from the Worker control API.
 */
export function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Switchyard Change Fabric</h1>
        <p className="tagline">Agent-native change coordination on Cloudflare</p>
      </header>

      <section className="app-panel" aria-label="Change state">
        <h2>Change state</h2>
        <p className="placeholder">
          The console will show the active Change here: its work graph,
          concurrent WorkUnits, isolated workspaces, path conflicts,
          verification evidence, cost, and promotion.
        </p>
        <p className="placeholder muted">
          No Change is loaded yet. This is an M0 shell — orchestration arrives in
          later milestones.
        </p>
      </section>
    </main>
  );
}

# The replay page

A static, zero-cost public page that plays back REAL recorded board runs in the
browser. It is the console's mission control (graph, board, threads, tools tab,
progress, scrubber) built in a replay mode: the recorded board log is folded
with the same `buildBoardGraph(log, k)` the live console uses, so the view at
seq K is exactly what the board had recorded at K. Nothing runs: no Worker, no
launcher, no polling, no credentials, no model calls. Every node is backed by a
recorded message (the same `assertBoardBacked` guard), and the final verdict is
shown exactly as the run recorded it (the integration verdict in the snapshot),
never inferred from the replay position.

## Use it

```bash
make replay-build     # apps/console/dist-replay (relative asset paths: root or subpath)
make replay-preview   # build, then serve on http://127.0.0.1:4180 (REPLAY_PORT=...)
```

- `?run=<id>` opens a run at its end (the final state), `?run=<id>&seq=<n>` at
  seq n, `&tab=tools` (or `thread`, `node`, `proof`) opens a right pane tab. The address
  bar follows the scrubber, so a link opens the moment being watched.
- Play from the start, change speed (1x, 4x, 16x), scrub, or jump to a key
  moment: claims, contests, contract changes, help and handoffs, tool
  publications, gate passes and failures, promotions, completions, spent fix
  budgets, stalled seams, lapsed claims, re-plans, and caps. Every key moment
  is a recorded message.
- The PROOF tab shows what the run can prove about its final revision at the
  current seq (`buildProofBundle` over the log alone): proven only when the
  last revision passed a gate that ran and the recorded promotion's gated
  commit is that revision's commit; otherwise each reason. Item cards carry
  one line saying why a waiting item is not moving (derived from the board),
  and clash predictions are tagged on the cards.
- The GATE row (under the ticker) has one marker per integrated revision
  (number, PASS or FAIL, acceptance count; `--` where the acceptance suite did
  not run) beside a small chart per suite (acceptance, developer) of the
  recorded, advisory counts over revisions: a dashed line at the suite's total,
  the passing revision ringed, speculative candidates as small diamonds, and a
  hollow gap marker (never a zero) where a suite did not run. Revisions are not
  drawn in the graph: hovering or selecting a marker draws that revision with
  its links to the items it merged and asked to fix.
- Agent coordination is an overlay on the graph (toggle: `talk on/off`):
  short curved teal arrows labelled with a verb (proposes, accepts, asks help,
  volunteers, hands off, contests, clash, re-plans, ...) from the acting
  participant to the one it addressed or concerned, for the messages of the
  last 10 seqs, fading as they age. It is derived from the recorded messages at
  the current seq (`communicationArrows` in `apps/console/src/board-overlay.ts`),
  every arrow cites its seq, and it is not a graph edge: the edge kinds are
  unchanged.
- Advisory decisions (Jev) are listed in a collapsible panel under the graph:
  type, answer, confidence, and the mechanical outcome once resolved; grey,
  never styled like a verdict.
- A seam item reads `seam: <file>` (its contract's recorded target) and a tool
  item `tool: <capability>`; the full id stays in the tooltip and the detail.
- Theme: light and dark, following the system until chosen with the toggle in
  the header (remembered in localStorage); `&theme=light` or `&theme=dark`
  forces one for a link or a screenshot.
- Each recorded run is checked on load by the board's own reducer
  (`reduceBoard`): a file it refuses is not shown, with the reason. If the
  graph cannot be drawn at some seq, the view says so and keeps the replay
  controls, so the viewer can scrub away.
- Live-only controls are gone: no launcher, templates, deploy, or dial, and a
  pending escalation is shown read-only ("recorded run: decided during the live
  run, not here").

## Export a run

```bash
make export-replay ID=<changeId> [WORKER=http://127.0.0.1:8787] [TITLE="..."] [APP=storefront] [DESCRIPTION="..."]
```

It pages the full board log (`GET /changes/:id/board?after=`) and the snapshot
(`GET /changes/:id`) from a running Worker and writes
`apps/console/public/replays/<id>.json` plus its entry in `index.json`
(id, title, app, outcome, description). Before writing it:

- keeps only an allow-listed slice of the snapshot (objective, status, dial,
  integration verdict, planning failure, escalations, board counts): no
  deployment URLs or repo identities;
- scrubs local absolute paths: the repo root becomes repo-relative, a temp work
  directory (`/tmp/scf-board-XXXX/worktrees/...`) becomes `<work>`, and a home
  directory becomes `<home>`;
- REFUSES to write (exit 1, nothing written, the finding's location named but
  never its value) when anything token-like remains (a Bearer token, an
  `art_v*` Artifact token, a provider key, URL credentials, a private key, a
  long hex or base64 secret; 40-hex Git commit ids are allowed), or the value of
  any env var whose name contains TOKEN, SECRET, KEY, or ACCOUNT, from the
  process env and from the repo's `.env` (read into memory only).

The scrubber and the refusal are unit-tested offline
(`apps/console/tests/replay-export.test.ts`), and a test checks every published
replay folds with every node backed and holds no secret or local path
(`apps/console/tests/replay-data.test.tsx`).

## Deploy it

`apps/console/wrangler.replay.jsonc` serves `dist-replay/` as Workers static
assets: no Worker code, no bindings, no secrets.

```bash
make deploy-replay    # a REAL deploy on the account in .env: confirm before running
make delete-replay    # remove it again
```

## The recorded runs shipped here

| id | outcome | what happened |
| --- | --- | --- |
| `board-live-reg3` | verified | service-api: 6 resource items, a codemod built and published, acceptance 10/20, 16/20, then 20/20 on revision 3 |
| `board-live-sf7` | failed | storefront: contracts, help, handoffs, a scanner and a codemod; a shared Invoice change broke typecheck for revisions 2 to 9; best acceptance 40/129 |
| `board-live-sf8` | failed | storefront: 7 contract proposals, 4 escalated to a human; acceptance peaked at 35/129; two seam items stalled |

Runs recorded before promotions were written to the board (the three above)
carry no `revision.promoted`, so the page reports the recorded verdict, never
promotion, and their PROOF tab says not proven (no promotion recorded). A run
recorded since shows "VERIFIED AND PROMOTED" only from its recorded
`revision.promoted`.

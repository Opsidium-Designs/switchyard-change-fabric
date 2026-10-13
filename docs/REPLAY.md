# The replay page

A static, zero-cost public page that plays back REAL recorded board runs in the
browser (and one clearly labelled SIMULATED run at scale: see "The simulated
run at scale" below). It is the console's mission control (graph, board, threads, tools tab,
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
- Play from the start, change speed (1x is 2 s per message; 4x, 16x), scrub, or jump to a key
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
- A large board (more than 24 items or 16 workers; the board admits up to 100
  agents) is drawn at scale (`apps/console/src/board-scale.ts`): items are
  grouped into lanes (a sub-lead's split item with its children nested inside,
  else the items sharing a domain prefix such as `parking-`, else a scope
  directory), each lane captioned with its done count at the current seq;
  hulls are compact (titles drop what the lane or parent already says, at most
  4 agent dots, then a count); and free agents (idle or left) are one bench
  chip with counts, not a dot each. The drawing fits the pane by default.
  A folded Board column of more than 12 items names 6, then a count, and the
  cards are compact; the ticker stays one line, with active/total agents and, when there
  are sub-leads, the active agents under each. Positions still come from the
  full log, so nothing moves while scrubbing; a small board keeps the layout it
  always had. `apps/console/tests/fixtures/large-board.ts` builds synthetic
  30- and 100-agent board logs through the board API for the tests;
  `tests/fixtures/write-large-replay.ts <dir>` writes them as replay files into
  a built `dist-replay/replays` for local screenshots only (they are never
  added to `public/replays` or the index).
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

## Backfill revision previews

A run made with `--preview-revisions` records a preview (the running app at that
revision, a Worker version under a preview alias, never a production deploy;
see the board doc) for each integrated revision as it goes. For a run recorded
without them, the previews can be added afterwards from the run's integration
repo, if it is still on disk:

```bash
make preview-replay REPLAY=apps/console/public/replays/<id>.json \
  REPO=/tmp/scf-board-XXXX/integration-artifacts/<id>--integration.git APP=storefront DRY_RUN=1
```

It reads each `integrated.rev` (its `n` and `commit`) from the replay, checks
the commit is in the repo, finds the app in that commit's tree (the directory
whose `wrangler.jsonc` names the app's stable worker,
`switchyard-change-fabric-<app>`), and, without `DRY_RUN`, uploads it as a
version of that worker under the alias `<tag>-r<n>`. Each uploaded preview is
written into the replay's `snapshot.previews` with `backfilled: true` (the
snapshot is created if the replay had none; the file keeps the exporter's
compact JSON). `DRY_RUN=1` prints the plan and writes nothing.

- A revision whose commit is not in the repo is skipped and named. A run made
  WITHOUT previews kept only its passing revisions' commits, so for such a run
  only those can be backfilled; a run made with `--preview-revisions` keeps the
  failing ones too.
- The Worker must exist: if it does not, wrangler's error is shown, nothing is
  written for that revision, and the fix is a first deploy of the baseline
  (`make deploy-app APP=<app>`).
- Previews are advisory and visual: they change nothing about the recorded run.
  Their URLs are public `workers.dev` URLs and go away with the Worker
  (`make delete-app APP=<app>`, or `wrangler delete`).
- Re-exporting a run writes a fresh snapshot from the Worker. A live run's
  recorded previews are kept (only well-formed https `workers.dev` URLs; the
  production deployment record is still dropped), but backfilled ones exist
  only in the file: backfill again after a re-export.
- The console shows a preview link only when its commit is the commit the log
  recorded for that revision; anything else is ignored.

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
| `board-sim-100` | verified (SIMULATED) | NOT a live run: 100 scripted agents and a lead on a generated 100-module project; a seeded scanner and codemod, a scanner-found item split three ways under a sub-lead, the fixture gate failing revision 1 and passing revision 2, the gated tree promoted; 853 messages |

Runs recorded before promotions were written to the board (the three above)
carry no `revision.promoted`, so the page reports the recorded verdict, never
promotion, and their PROOF tab says not proven (no promotion recorded). A run
recorded since shows "VERIFIED AND PROMOTED" only from its recorded
`revision.promoted`.

## The simulated run at scale

`board-sim-100` is the one run on the page that is NOT a live run. It is
labelled SIMULATED everywhere a viewer meets it: `simulated: true` in the
replay file and its index entry, a title starting "SIMULATED:", a description
starting with what that means, a SIMULATED chip on its picker card and in the
run header (in place of the recorded-run chip), a one-line explanation under
the header, and a sentence in its verdict panel.

What is real: the board and its reducer (every message is one a board
accepted; the page checks it with `reduceBoard` like every other run), the
claims and their arbitration, the lead's seeded scanner and codemod (built,
gated on their own tests, published, and run), the continuous integrator and
its merges, the gate step on the exact integrated tree, the fix request and
the fix loop, item completion derived from a passing revision, and the
promotion of the gated tree to a local Git branch with its receipt. It runs
offline (`run-board --offline`) on the concurrent schedule a live run uses,
with about 100 agents under a dial of 100.

What is NOT real, and what a viewer must not read into it:

- No model took part. Every agent turn is the generic offline policy (the same
  goal-agnostic stand-in `make demo-board` uses), with free workers spread over
  the open items (`--spread-claims`: agent-k reads the open items from the
  k-th, so a wide pool does not all reach for the first one). Every edit is the
  deterministic noop executor writing a marker into its files: no validation
  was added to any module.
- The gate is the offline FIXTURE, not the project's tests (the generated
  project has none): it fails the first integrated revision, naming one file,
  and passes once that file is edited again. "Verified" and "PROVEN" on this
  run therefore mean the engine's mechanics held (the gate step ran on the
  promoted tree, the promoted commit is the gated one), not that the goal's
  code change was made.
- The planner is the heuristic decomposition (one item per module), not a
  planner model.
- Times are not real: the offline board stamps one second per message from a
  fixed start (2026-01-01), so the chapter durations count messages, and no
  model latency or cost is in them.

The project is generated at run time and never committed:
`examples/scale/make-scale-project.mjs <dir>` writes 10 domains x 10 route
modules (`src/<domain>/<module>.ts`) over three shared contract files, with
the last module of each domain importing the first (so the plan has a little
dependency order), no dependencies, and no gate script. Regenerate the replay
with:

```bash
make demo-board-scale   # SCALE_MAX=100 SCALE_INFLIGHT=16 SCALE_TURNS=8000 SCALE_ID=board-sim-100
```

It generates the project in a temp directory, runs
`run-board --offline --fixture-gate --concurrent --spread-claims --board-out <file>`
(the raw board log and Change snapshot, unscrubbed, kept in the temp
directory), then `export-replay --from-file <file> --simulated`, which scrubs
it and refuses anything token-like exactly as for a live export, and writes
`apps/console/public/replays/board-sim-100.json` and its index entry (the
description's counts are always read fresh from the new log). The concurrent
schedule interleaves differently each time, so a regenerated replay is a
different log, not a byte-identical one. No credentials and no network.

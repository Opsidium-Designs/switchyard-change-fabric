# The Change board

The board is the coordination substrate for agents that form around a goal: a
single ordered, durable log of typed messages per Change. A goal is posted,
agents join, claim items with a declared intent, contest overlapping claims,
split items, ask for help, propose contracts and tools, announce pushes, and
propose completion. The engine arbitrates mechanically; only the gate decides
what ships.

Status: the board model, its persistence in the Worker, and the offline parity
routes exist and are tested. Agents that form around a goal on the board run as
their own mode, `run-board` (see "Agents on the board" below); `run-live` does
not use the board. Two integrity rules from the board work apply to `run-live`
too, since it shares the integrator and the promote step: the gate's contract
(below) is restored from the baseline before the gate runs (in `run-live`,
which has no contract-change route, a unit's edit to it is restored and
recorded rather than failed: the gate runs on, and ships, the restored tree),
and promotion refuses unless the promoted tree is exactly the gated commit's
tree.

## Where it lives

- `packages/change-core/src/board.ts`: the pure model. Vocabulary and payload
  validation (`parseBoardDraft`), transition rules (`checkBoardTransition`),
  the reducer (`applyBoardMessage`, `foldBoard`, `reduceBoard`, `verifyBoard`),
  arbitration (`arbitrate`), the append entry points (`appendBoardMessage` for
  participants, `appendIntegratedRev` for integration results), the per-agent
  digest (`boardDigest`), and the escalation bridge. No clock, no I/O.
- `packages/change-core/src/path-overlap.ts`: exact glob overlap and
  containment for intents (same glob syntax as the verification path scope).
- `packages/change-core/src/board-script.ts`: a deterministic driver for scripted
  agents that joins and posts through the same routes a real client uses.
- `apps/worker/src/change-state.ts`: the ChangeState Durable Object stores one
  message per key, the reduced state, the agent token hashes, and the escalation
  records, all written in one storage transaction per append. The board resets
  whenever the Change is (re-)created.
- `packages/orchestration/src/local-control.ts`: the offline stand-in serves the
  same routes through the same model.

## Identity

Who sent a message is established by the route, never by the message body.

- **Agents** join through `POST /changes/:id/board/join` (under the shared
  bearer, when `SWITCHYARD_API_TOKEN` is set). The response carries a random
  per-agent board token, shown once; only its SHA-256 hash is stored. Every
  later agent post presents it in the `x-board-agent-token` header, and the
  sender is the agent the token identifies. A `from` in the body must match or
  the post is refused (`AUTH`). `agent.left` revokes the token. The agent post
  route needs only the agent token, not the shared bearer, so an agent process
  never holds a credential that could act as the human or the integrator.
- **The lead** is an agent like any other: it joins with role `lead` and gets a
  token. Only one active lead at a time. The lead (or the human) accepts or
  rejects contract proposals.
- **The human** posts through `POST /changes/:id/board/human` (bearer):
  `goal.posted`, `item.proposed`, `claim.resolved` (a decision),
  `contract.accepted`, `contract.rejected`. The existing escalation resolve route
  is the other human path.
- **The integrator** (the operator side, under the bearer) records revisions
  and reads agents' repos with short-lived read tokens the Worker issues it
  through `POST /changes/:id/board/read-token` and revokes each one as soon as
  the integration that used it is done; it never uses an agent's own write
  token.
- **The engine** never posts through a participant route. Its messages are
  derived by arbitration, or (for `integrated.rev`) produced from an integration
  result recorded through `POST /changes/:id/integration/revision` (bearer):
  `{commit, gate: "pass" | "fail", merged: [push commits], failing?: {output,
  items}}`. The board numbers the revision and derives its paths and
  contributors from the announced pushes it merged, so the board can only
  report what the integrator recorded. A failing revision may carry its bounded
  gate output and the items attribution implicated (each must be an item the
  revision merged).

## Routes

| Route | Auth | Effect |
|---|---|---|
| `POST /changes/:id/board/join` | bearer | `{agent, role?, rationale?, workspace?: {ttlSeconds}}` appends `agent.joined`; `201 {appended, token, workspace?}`. With `workspace`, the join is validated first (a join the board would refuse provisions nothing), then the agent's own repo (`<change>--board-<agent>`) and a repo-scoped write token with that explicit TTL (60 to 3600 s) are provisioned and returned once; a join refused or failing after that revokes the token AND archives the repo. |
| `POST /changes/:id/board/read-token` | bearer | `{agent, ttlSeconds?}` (default 600, 60 to 3600): a short-lived READ token for a joined agent's repo, for the integrator. `201 {workspaceName, tokenId, token, tokenExpiresAt}`. The lead and an agent that joined without a workspace have no repo (`400 NOT_ALLOWED`). |
| `POST /changes/:id/board/read-token/revoke` | bearer | `{agent, tokenId}`: revoke a read token the integrator is done with. |
| `POST /changes/:id/board` | agent token | `{type, payload, rationale?, inReplyTo?, to?}` appended as that agent; `201 {appended, escalations}`. |
| `POST /changes/:id/board/human` | bearer | A human message. |
| `POST /changes/:id/board/decision` | bearer | `{juncture, question, answer?, confidence?, accepted, error?, rev?, parsed?, contract?}`: the engine appends an ADVISORY `decision.recorded` (a typed decision and its outcome, or a failed call's reason). An attribution names the failing revision `rev` (it must be the latest, failing) and the items the string-parse attributed; a `contract-triage` names its protected `contract`. It changes only the decision counts, never arbitration or the verdict. |
| `POST /changes/:id/integration/revision` | bearer | An integration result `{commit, gate, merged, failing?}`; appends `integrated.rev` and what it triggers (completions and `rebase.needed` on a pass, `fix.requested` / `fix.exhausted` on a fail). |
| `POST /changes/:id/integration/cloud` | bearer | Configure integration on Cloudflare for the Change: `{integration: {workspaceName, gitUrl, defaultBranch}, gateCommand?, requireGate, protectedPaths, protectedJsonKeys, testInventory?, gateSupportFiles?, timeouts: {installMs, gateMs}, identity?, registryHost?, attribution?: "engine"|"driver"}`, validated with the job schema (tokenless `https` URLs only). It is part of the goal-time record: accepted ONCE and only BEFORE `goal.posted`; any later change (for example a gate command of `true`) is refused with `409`. From then on every `push.announced` starts or coalesces the integration Workflow. See "Integration on Cloudflare" below. |
| `POST /changes/:id/integration/cloud/attribution` | bearer | `{key, items}`: the run's ADVISORY attribution of a failing revision the Workflow holds (`attribution: "driver"`): items it merged only (`[]` = no confident choice). `409` for an unknown key or a second answer. |
| `GET /changes/:id/integration/cloud` | open | The configuration (the test inventory as count and format only, never its names), the active Workflow, and every revision attempt: recorded or not and why, the egress phases the job ran under, the install outcome, the evidence, and whether the integration branch was advanced. |
| `POST /changes/:id/integration/cloud/kick` | bearer | Start the integration Workflow now, or coalesce into the active one (an active instance that errored or was terminated is replaced). |
| `POST /changes/:id/integration/cloud/workspace` | bearer | `{ttlSeconds}`: provision the integration repo (`<change>--integration`) and a write token, returned once (the run seeds the baseline with it). Allowed before the Change exists. |
| `POST /changes/:id/integration/cloud/token` | bearer | `{scope: "read" or "write", ttlSeconds}`: a short-lived token for the integration repo (promotion reads with one). `.../token/revoke {tokenId}` revokes it. |
| `GET /changes/:id/board?after=<seq>&limit=<n>` | open | One page (default 500, at most 1000) of messages after `seq`, `hasMore`, and the reduced state. |
| `GET /changes/:id/board?for=<agent>&after=<seq>` | that agent's token | The agent's digest: its claims (with any unanswered fix request), pending claims, open contests it is in, open items, the latest passing revision, its rebase target, the latest failing revision's evidence when it asks this agent for a fix, the protected set, `pageEnd` (the last seq the page covered: page by it, since the messages are filtered), and the messages since `seq` addressed to it or touching its work. |
| `GET /changes/:id/board/verify` | open | Re-verifies that the stored log reduces to exactly the stored state (`409` if not). |
| `GET /changes/:id` | open | The snapshot carries only `board`, a count summary. |

Every append writes the messages, the board state and seq, the token map, and
the escalation records in one transaction: a rejected message, or a failed
write, leaves all of them untouched. Rejections carry a machine-readable code:
`{code, error}` with codes such as `BAD_PAYLOAD`, `AUTH`, `NOT_ALLOWED`,
`NO_GOAL`, `UNKNOWN_AGENT`, `UNKNOWN_REF`, `DUPLICATE`, `ITEM_NOT_OPEN`,
`NOT_OWNER`, `CONTEST_OPEN`, `CONTEST_CLOSED`, `INTENT_OVERLAP`,
`OUTSIDE_INTENT`, `OUTSIDE_SCOPE`, `PROTECTED`, `CONTRACT_REJECTED`, `NOT_WITHIN`, `INVALID_STATE`,
`LIMIT`. `AUTH` is 401,
`LIMIT` is 409 (413 for an oversized body), the rest are 400.

## Envelope

Every message is `{seq, at, from, type, payload, rationale?, inReplyTo?, to?}`.
`to` addresses other joined agents (questions, help, contract replies); the
digest surfaces addressed messages to their recipients. Free text belongs in
`rationale`; payload strings are ids, repo-relative paths or globs, or short
bounded fields that define an item.

## Vocabulary

`goal.posted {objective, rules, protected?, protectedKeys?, testInventory?}`, `item.proposed`, `item.claimed {item, intent:
{read, write}}`, `claim.granted`, `claim.contested`, `claim.ceded`,
`claim.kept`, `claim.narrowed {contest, write}`, `claim.resolved`,
`claim.escalated {..., reason: turns | idle}`, `item.split {item, children}`,
`item.discovered {..., scopeHint?}`, `help.requested`, `help.offered`,
`contract.proposed {contract, target, kind, item?}`, `contract.escalated {contract, item,
target, kind}` (engine: a protected contract waits for a human), `contract.accepted`,
`contract.rejected`, `push.announced
{item, commit, paths}`, `integrated.rev {n, commit, gate, merged, paths,
contributors, failing?: {output, items}, gated?: false}` (`gated: false`: no gate ran, so its pass checked nothing), `rebase.needed`, `review.requested`,
`review.result`, `handoff`, `done.proposed`, `item.completed`, `item.reopened {item, previousOwner, commit?, n}`
(engine: a spent fix budget reopens the item for another agent), `fix.requested
{item, n, attempt}` (engine, addressed to the item's owner), `fix.exhausted
{item, n, attempts}` (engine), `tool.proposed`, `tool.published`, `tool.used`, `decision.recorded {juncture:
plan-review | attribution | fix-confidence | contract-triage, question, answer?, confidence?, accepted, error?, rev?,
parsed?, contract?}` (engine, advisory), `decision.resolved {decisionSeq, rev, passed, answer, outcome:
in-fixed-set | not-in-fixed-set, fixed, parsed, parseOutcome: in-fixed-set | not-in-fixed-set | none}` (engine, derived, advisory),
`agent.joined`, `agent.left`.

Intent entries are repo-relative paths, globs (`**`, `*`, `?`), or
`path#symbol`. A trailing `/` names a directory (`src/` is `src/**`). A `**`
must fill a whole path segment: `src/**x` or `a**` is refused (`BAD_PAYLOAD`).
Symbol-level intent is accepted, but for overlap it is treated as its file, so
two symbols in one file contest.

## Arbitration rules

`goal.posted` records the rules the board runs under (`maxContestTurns`,
default 3; `contestIdleMessages`, default 25; `maxFixAttempts`, default 2) and
the CONTRACT (`protected`: the existing tests and gate configuration no agent
may change alone; `protectedKeys`: gate-defining keys inside editable files,
shown for visibility and restored by the integrator), so a log is
self-describing.

0. Scope and contract. A claim's write intent must lie within the item's
   `scopeHint` (`OUTSIDE_SCOPE`; an item with no scope hint cannot be claimed),
   and no write entry may overlap a protected path (`PROTECTED`, with a hint)
   unless an ACCEPTED `contract.proposed` for that item covers it. Changing an
   existing test or the gate's configuration is a contract change a HUMAN
   decides: such a contract must name its item and one concrete path that is
   itself in the contract (or a collapsed test directory entry of it), inside
   the item's scope hint; the engine escalates it (`contract.escalated` raises
   a pending `decision` escalation, answered in the console, through the
   escalation resolve route, or by the run's resolver hook), and the lead can
   never accept or reject it. Once accepted, exactly that path is writable for
   that item and the integrator applies that item's unit's version of it (and
   no other unit's) instead of restoring it; it reads the accepted set from
   board state, never from an agent. Once a human rejects a protected contract
   for an item, further protected contracts for that item are refused
   (`CONTRACT_REJECTED`, with the reason) until a failing revision implicating
   the item has been recorded since. Contracts on other paths stay the lead's
   to decide. A split child must stay within its parent's scope
   hint. New test files are never protected.
1. A claim whose write intent overlaps no other agent's live claim is granted.
   An agent's own claims never contest each other (it is one writer).
2. An overlapping write intent opens a contest naming the earliest-granted
   overlapping owner and the overlap. Read intents never block.
3. The owner may cede (its claim is released and the claimant is re-decided),
   keep, or narrow its write intent. The claimant may cede (withdraw), keep, or
   narrow. A narrowing must stay within the previous intent (checked exactly).
   One that removes the overlap resolves the contest and the claimant is
   re-decided against every live claim. An owner's narrowing re-checks every
   contest on its item.
4. Each keep, and each narrowing that still overlaps, is a turn. At the turn
   limit, or when no party has acted for the idle limit (counted in board
   messages, so it stays deterministic), the contest escalates: the engine
   appends `claim.escalated` and the Change records a pending `decision`
   escalation linked to the contest. The human answers through the escalation
   resolve route (the decision must name a party and is appended as a human
   `claim.resolved` in the same transaction) or by posting `claim.resolved`
   directly (which closes the escalation).
5. When an owner's claim is released (completion or split), contests waiting
   on it resolve and their claimants are re-decided.
6. A handoff is refused if the item's write intent would overlap a claim held
   by anyone other than the recipient, so two agents can never own overlapping
   writes.
7. Each pushed path is a concrete file (no wildcard, no symbol) that must lie
   WITHIN the owner's write intent (a symbol-scoped entry covers its file).
8. Completion is derived, never posted: an item completes when its owner has
   proposed done AND a passing integrated revision merged the owner's latest
   push (whichever happens second triggers it), citing that passing revision.
   Completing the last child of a split item completes the parent.
9. A passing `integrated.rev` sends `rebase.needed` to each active agent, other
   than the contributors, whose live read or write intent intersects the changed
   paths. A failing one completes nothing; for each item its evidence implicates
   whose owner is active, the engine appends `fix.requested` addressed (`to`) to
   that owner while the item's attempts are within `maxFixAttempts`, else
   `fix.exhausted`. The owner's next push answers the request.
10. Tools: `tool.published` requires the publisher's prior `tool.proposed` for
    that tool and capability, `verified: true` (the tool passed its own gate),
    and a new capability version. `tool.used` must name a published capability
    and version.

## Limits

Per board: 20000 messages, 1000 items, 100 agents, 200 published tool
versions, 512 protected paths (more existing tests than that are collapsed into
their dedicated test directories). Per message: 32 children per split, 64 entries
per intent (each at most 512 characters), 256 paths per push, 8192 characters
of failing output per failing revision, bounded objective, acceptance, and
rationale text, and a 64 KB request body. The state keeps counts and latest
values (push count, the latest push per item, uses per tool version); per-event
detail stays in the log.

## Replay

- `reduceBoard(log)` re-verifies a log: every participant message is re-checked
  as the route checks it, each integrated revision is re-derived from the pushes
  it names, arbitration is re-run under the recorded rules, and the engine
  messages that follow must be exactly the ones arbitration produces. Reducing
  the same log twice yields identical state, equal to the live state.
- `verifyBoard(log, state)` (and `GET /board/verify`) checks that a stored
  state equals the reduction of its stored log.
- `foldBoard(log, k)` applies messages up to seq `k` without checks, in linear
  time, for console replay at any point (engine messages are applied as they
  were recorded, so a `k` inside an engine batch shows the board partway
  through it).

## Agents on the board (`run-board`)

`run-board` is a run mode next to `run-live`. It reuses the same planner,
executor, verifier, integrator, gate, promotion, and redeploy; only the way work
is distributed changes: items are proposed and claimed, never assigned.

- `packages/model-adapters/src/agent-turn.ts`: one agent TURN is one strict
  json_schema call through the AI Gateway (the planner's path) returning exactly
  one typed action: `claim`, `propose_item`, `split`, `message` (help,
  question, reply, contract, review; `to` addresses agents), `contest_reply`
  (cede, keep, narrow), `edit`, `propose_done`, `propose_tool`,
  `decide_contract` (the lead only), or `wait`. The reply is validated strictly;
  an invalid reply or a failed call becomes a recorded `wait` with the reason.
- `packages/orchestration/src/board-agent.ts`: one runtime per agent in the
  driver process. A worker joins with its own repo. It reads its digest after
  the last seq it saw and takes a turn only when something relevant arrived (a
  message addressed to it or touching its items or contests, a `rebase.needed`,
  new open items while it is free) or its own previous action was accepted or
  refused (it keeps the initiative until it chooses to wait). It maps the action
  to a board post with its own token; a refusal's `{code, error}` goes into its
  next turn. `edit` resolves the claim's write intent to concrete files, runs the
  executor with those as the allowed paths (reading each file as the agent
  currently sees it: its own pushed version, else the shared baseline, which is
  the integrated revision after a rebase), checks the changed paths against the
  write intent with the verification path scope, commits, pushes to its own
  repo, and announces the push. A refused announcement rolls the repo back.
  Budgets: turns per item, and turns per run; a spent budget is recorded on the
  board (a handoff to another worker when the board accepts it, else a help
  request with need `turn-budget` or `run-budget`, or `agent.left` when the
  agent holds nothing) and stops the agent.
- The lead joins with role `lead`. Its first turn is the existing planner (the
  LLM planner live; a live run without one fails unless
  `--allow-heuristic-planner`, with the loud banner on a fallback); each planned
  unit becomes an `item.proposed` (objective, acceptance, the unit's paths as
  the scope hint). Later lead turns decide `contract.proposed` messages.
- `packages/orchestration/src/run-board.ts`: the driver. It creates the Change
  (planning-first), derives the protected set, posts `goal.posted` (with it) as
  the human, starts the lead, recruits workers under the min/max dial (another
  joins while open items outnumber the workers in flight, up to max), and
  integrates CONTINUOUSLY while the agents work (below). The agent phase ends
  when every item is completed, or every outstanding item's fix budget is spent
  (`fix-budget`), or the run budget, the round limit, quiescence, or the timeout
  ends it. The whole phase runs under try/finally: a throw (a refused join, an
  unreachable board) aborts every agent loop, marks the Change failed, and
  archives every repo the run created before the error propagates. The verdict
  is the LAST revision's gate; it is posted to `/integration` and must be
  recorded (a verdict the control plane refused stops the run before
  promotion); only that revision, when it passed, is promoted (and redeployed in
  place), and promotion refuses unless the promoted tree is exactly that
  revision's gated commit tree.
- Test inventory: at goal time the gate runs once on the baseline and the
  tests it executed are read from the runner's own output (node --test spec
  and TAP, go test -json and -v, pytest -v and its summary, vitest, jest; no
  flags are injected, the gate command is unchanged). It is posted with the
  goal (`testInventory`). Every revision's gate must execute at least those
  tests (by name where the runner prints names, never fewer by count), so code
  that exits early (`process.exit(0)`, `os._exit(0)`, a `TestMain` exiting 0)
  cannot green the gate with tests that never ran. When the output shape is not
  recognized the goal records `testInventory: {status: "unavailable"}` and
  revisions fall back to the exit code. Hardening: only the LAST summary line
  counts, a run must report in the baseline's format, a run naming no tests
  when the baseline named some falls short, and a file-level entry (node prints
  `✖ test/a.test.mjs` for a test file that failed to load) is not a test name:
  such a file only has to contribute tests. The board publishes the count and
  format only, and failure messages carry counts only (the names stay with the
  integrator). The report is read from the stream the runner writes it on
  (stdout first); when both streams carry a report and they disagree, the run
  has no trustworthy inventory and falls short. The gate command is never
  changed (no reporter flag is injected into an npm script), so a test that
  prints reporter-shaped lines on stdout (a fake `✔ name (1ms)`) remains a
  residual spoof risk, bounded by these rules but not eliminated; padding the
  count cannot make up for a missing baseline name, and new tests never raise
  or replace the baseline floor. When a human accepts a contract change to a protected path, the
  inventory drops that file's tests where the format names tests with their
  file (pytest); otherwise it is relaxed for later revisions, visibly
  (`test inventory: ...` on the revision), and they use the exit code.
- Every gate, test, lint, and typecheck command (and the baseline inventory
  run, and engine-built tools) runs with an ALLOWLISTED environment (PATH,
  HOME, USER, locale, CI, NODE_ENV, proxy and CA settings, package-manager
  cache and toolchain locations, a private temp dir made for that run): never a
  credential (API tokens, the gateway token, the account id, the Worker
  bearer). It runs in its own process group: at the timeout (default 10
  minutes, `--gate-timeout-ms`) or when its output overflows, the whole group
  is killed and the outcome says which; when the command exits normally,
  anything it left running in its group is killed too.
- Every git call the engine makes goes through one hardened runner
  (`packages/artifact-workspace/src/git-transport.ts`): no system or user
  config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`), a fresh
  private empty HOME, no prompts, no credential helper, hooks and fsmonitor
  off, `ext::` refused. A repo-scoped token never appears on git's command
  line, in a URL git could echo, or in a config file: it is sent as an
  `Authorization: Bearer` header scoped to that repo URL, supplied through the
  `GIT_CONFIG_COUNT` environment. A credentialed call in an existing repo is
  refused when that repo's own config carries a redirecting or
  program-running key (`url.*.insteadOf`, `pushInsteadOf`, `include`,
  `credential.*`, `http.*`, ...). So no checkout keeps a credential, and a
  `pushInsteadOf` planted in `~/.gitconfig` or a repo config cannot send the
  token elsewhere.
- After the gate has run agent code in a checkout, git never runs in that
  checkout again: the gated commit is captured and staged BEFORE the gate runs
  in a trusted bare repo under its own fresh private (0700) temp root outside
  the work root. After the gate, that repo is reset to known content (config
  rewritten, `hooks/`, `info/` and object alternates removed, the gated commit
  re-verified), then it verifies (with its own throwaway index, never the
  checkout's `.git`) that the tracked files are still exactly the gated
  commit's (otherwise the revision fails), and the push goes from it. So a
  hook, `core.hooksPath`, credential helper, or `insteadOf` the gate's code
  plants is never run, and a commit it makes is never pushed or recorded.
  Model calls never run repo code.
- Residual risk (same-user isolation is not complete): env filtering does not
  stop the command from READING files the OS user can read (HOME dotfiles, an
  absolute path such as a repo's `.env`), a gate child that leaves its process
  group with `setsid` survives the group kill, and a surviving same-user
  process can read a running git's environment (where the header is). The
  real fix is a sandbox (a separate user or container gate), out of scope for
  this spike.
- `packages/orchestration/src/protected-paths.ts`: the gate's CONTRACT,
  derived from the project, never named by the engine. The rule: the original
  code's existing tests are the contract, whatever the gate's shape (an npm
  script, vitest with no arguments, pytest, make test, cargo test). It is every
  EXISTING test-shaped file by the common ecosystems' conventions (`*.test.*`,
  `*.spec.*`, `test_*.py`, `*_test.py`, `*_test.go`, `*_spec.rb`, `*Test.java`,
  and files under `test`, `tests`, `__tests__`, `spec`, `specs` directories);
  test-runner and build configs that change what a test run does (vitest,
  vite, jest, mocha, playwright, cypress, karma, ava, babel, `conftest.py`,
  `pytest.ini`, `tox.ini`, `setup.cfg`, `noxfile.py`, `pyproject.toml` whole);
  the package-manager configs that change what `npm run` executes (`.npmrc`,
  `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.pnpmfile.cjs`, protected even
  when absent); `Makefile` or `justfile` when the gate invokes make or just;
  the files the gate command runs, and the in-repo harness they import,
  transitively (bounded depth): an imported file in the test tree (a directory
  holding a gate-named or test file, or below one; the repo root only for files
  directly in it) is harness, protected and followed; an imported file anywhere
  else is application code, the code under test, neither protected nor
  followed (a file it only syntax-checks, such as
  `node --check src/index.js`, is code under test and never protected, and a
  directory it names protects only the existing test files under it; a parent
  directory is never protected wholesale, and no app module is protected for
  being named like a helper); and in `package.json` only the KEYS that define
  the run (the scripts the gate invokes, transitively, each with its `pre` and
  `post` lifecycle scripts, and `type`, `packageManager`, `imports`, `exports`,
  and the jest, mocha, ava, babel, c8, nyc, vitest sections): dependencies and
  lockfiles stay editable. `tsconfig*.json` is protected when the gate runs the
  type checker. Root runner configs (`pytest.ini`, `tox.ini`, `setup.cfg`,
  `pyproject.toml`, `conftest.py`, `noxfile.py`) are protected even when
  absent, and such a config newly added anywhere is removed at gate time. A gate whose
  program is not a known test or build runner fails closed (the whole manifest,
  `Makefile`, and `justfile` are protected); so does an npm-script gate whose
  manifest cannot be read. NEW test files are never protected: agents may add
  them inside their scope. They are not part of the contract (a gate that globs
  test files runs them, so a failing new test fails the gate) until the check
  rule (a check counts only if it fails on the original code) admits them, a
  later slice. The contract is posted with the goal; the board refuses claims
  on it without an accepted contract; and the integrator restores it from the
  baseline before every gate run (an added config is removed) and fails a
  board revision that changed an unreleased contract path or key.
### Continuous integration and the fix loop

- `integrateBoardRevision` is a function of board state (the input synthesis,
  `planBoardIntegration` in change-core, is shared with the integration
  Workflow on Cloudflare, below): one unit per agent with
  pending pushes on items it still holds, PINNED to its latest pending announced
  commit (the clone checks out exactly that commit; every other merged commit of
  the agent must be in its history), diffed against the agent's last commit a
  passing revision already merged, scoped to the WRITE INTENTS of those items
  only (announced paths never widen it), with the files of items the agent
  handed off yielded (never applied from it, never failing it), and read with a
  fresh operator read token (revoked afterwards). The existing verifier and
  integrator compose the verified units onto the last RECORDED passing revision
  (the board's `integrated.commit`, never whatever the integration branch head
  is; only that revision's candidate ref is fetched), restore the contract from
  the baseline, and run the gate. The gated commit is left on a candidate ref;
  the integration branch advances to it only after the board recorded the
  revision, as a fast-forward (never forced), and the candidate refs are
  pruned, so a result that is discarded never moves the branch. A unit's
  symlinks, files inside dependency or tool trees (`node_modules`, `.git`,
  `.bin`, `vendor/bin`), reads whose directory resolves outside the unit's
  checkout, and writes that would resolve outside the integration checkout
  (checked before any directory is created) are never applied (the board refuses such pushes, and the agent
  runtime refuses them before pushing). The revision records the gated commit,
  the gate, the merged commits (exactly what was gated), and for a fail the
  bounded, credential-scrubbed output (first 8 KB) and the implicated items.
  When nothing the gate ran on can be recorded honestly (every push excluded,
  the integrator refused, or a merged push was superseded while the gate ran)
  NO revision is posted and the reason is recorded instead. Superseded runs are
  bounded: after 3 in a row the integrator holds the superseded agents back and
  integrates the rest WITHOUT their units (named in the revision; their newer
  pushes stay pending), so a recorded tree never contains content `merged`
  does not list. Transient failures (a read-token 5xx, an
  unreachable repo or board) are retried with backoff (3 times per push set);
  only a deterministic refusal marks a push set as attempted.
- `ContinuousBoardIntegrator` serializes revisions (one at a time) and coalesces
  pushes that land while one runs into the next; the same pending set is never
  gated twice. In `lockstep` it integrates between rounds; in `concurrent` the
  driver kicks it whenever it observes pending pushes.
- A failing revision's reason (`failure:`) and its evidence lead with the
  gate's own failing line (a `SyntaxError`, a failing test); an inventory
  shortfall is the stated cause only when the gate exited 0 (the early exit it
  protects against), and secondary otherwise.
- Attribution reuses run-live's: parse the failing output for the files and
  names it reports and map them to the items' write intents (command echoes
  such as npm's `> node --check a.js && ...` are ignored, and error locations
  `<path>:<line>`, which may be absolute paths in the gate's checkout, are
  preferred when present); then a CONFIDENT
  typed-decision choice when configured (advisory narrowing only); else every
  item the revision merged. The board then asks each implicated owner for a fix.
  A failure that names files of already COMPLETED items is a regression this
  revision's pushes caused (the tree passed before them): the evidence says
  which completed items regressed, and the fix is asked of the owners of the
  merged pushes (completed items are not reopened).
- A fix request is a turn: the owner refetches the latest passing revision,
  sees `claims[].fix` and `digest.failure` (the failing output, framed as
  untrusted data), edits with the failing output in the executor's objective on
  the next model of the escalation ladder per attempt
  (`AI_GATEWAY_ESCALATION_MODELS`), and pushes again, which triggers the next
  revision. Fix attempts per owner are bounded by `maxFixAttempts`
  (`--fix-attempts`, default 3). A spent budget is not a dead end: the engine
  records `fix.exhausted`, then `item.reopened` releases the item for another
  agent (fresh eyes), which starts from the previous owner's latest push; an
  agent that spent an item's budget cannot claim it again. The agent phase ends
  (`fix-budget`) when every outstanding item has been spent by every running
  agent, and the run budget bounds everything.
- No gate, no verification: when the project has no gate (and none is
  required), the integrator runs no final check. Such a revision is recorded
  `gate: pass` with `gated: false` and shown as "no gate: nothing checked"; the
  run's verdict is `unverified (no gate configured: nothing checked)`, never
  `verified`. The tree is still promoted, labeled "promoted unverified (no
  gate)" in the summary, and the control plane's integration record carries
  `gated: false`. The CLI exits non-zero unless the verdict is verified (a
  gate ran and passed) and every item completed (`boardRunExitCode`), so an
  unverified or partial result is never a success. `run`, `run-goal`, and
  `run-live` label a no-final-check verdict the same way (summary, CLI, the
  `integration-verdict` event, the control-plane record); their exit codes are
  unchanged.
- The verdict is the last revision's gate, but a passing last revision that
  left announced pushes ungated (excluded, refused, unreadable) is PARTIAL: the
  verdict is failed with that reason and nothing is promoted. A verified run
  with items not completed is reported as `verified (partial: N item(s) not
  completed: ...; the Change is not complete)` and the CLI exits non-zero. An
  owner whose push a passing revision merged is woken for a turn so it can
  propose done, and cued again at its next opportunities if it ignores the cue
  (up to 3 times; a turn it was taking anyway does not use one up). A failing
  revision's reason is shown as its first full line(s), at most 300 characters
  (`failure:` in the summary and the CLI), and the full bounded evidence stays
  on the board. The
  summary prints the promoted repo path and the baseline gate inventory.
- Human contract decisions: `--decide-contracts accept|reject` answers them
  non-interactively (the run-board counterpart of run-live's `--owner`; `make
  demo-board` rejects, so its tests item adds a NEW test file instead of
  rewriting the existing ones); without it each decision waits durably for the
  console or `POST /changes/:id/escalations/:id/resolve`.
- Typed decisions (advisory): the lead's plan review (from the planner pass),
  each failure attribution, and a fix-confidence check on the final passing
  revision are recorded on the board as `decision.recorded`, including any
  failed call with its reason (for example an API error message); none of them
  gates arbitration, promotion, or the deploy. The summary prints `jev: N
  call(s), M accepted, K error(s)`. The decision API's wire shapes: a choice
  question's criteria is a record option -> description, a score question's an
  array, a noul carries none. `make jev-smoke` (opt-in, live, never part of
  `make check`) asks one question of each type, plus the contract-triage
  question below, and prints PASS/FAIL.
- Decision outcomes (where attribution picks landed, advisory): an
  attribution decision is recorded AFTER its failing revision, linked to it
  (`rev`, and `parsed`: what the string-parse attributed on its own). The link
  is refused unless that revision is the latest, failing, and its merged pushes
  are on record (a board stored before outcomes existed records it unlinked).
  When the next PASSING revision is recorded, arbitration derives
  `decision.resolved` for every open attribution: `fixed` are the items whose
  merged push commit changed between the failing revision and the passing one
  (a newly merged item counts as changed); `outcome` says whether the pick is
  `in-fixed-set`, and `parseOutcome` the same for the parse (`none` when it
  attributed nothing). A decision with no passing revision after it stays open:
  unresolved. The outcome is derived from the log, so replay re-derives it and a
  forged one is rejected. The summary prints `jev attribution: N decision(s);
  pick among items changed before the next pass: C, not: M, unresolved: U (not
  a controlled accuracy measure: ...; parse among them: ...; pick differed from
  parse: D (pick only, parse only, both, neither), biased toward whichever was
  asked to fix)`. It is NOT an accuracy measure: attribution decides whose owner
  is asked for a fix (a confident pick together with the parse's items,
  otherwise the parse's items alone), and the asked items tend to be the ones
  that change. The one comparison with some signal is where the pick differed
  from the parse (the parse attributed items and the pick is not among them):
  which of the two landed in the fixed set. It is still biased toward
  whichever was asked. Recording a linked decision distinguishes a refusal from
  a transport error: a 4xx records it once unlinked; a 5xx or network error
  checks the board for the linked copy and retries (bounded), and never posts a
  second, unlinked copy. `run-live` places its ladder picks the same way in
  process (the units whose re-fan pushed an edit before the next passing
  round), emits `attribution-resolved` per decision, returns the tally as
  `result.attribution`, and prints the same line; it is not recorded on the
  Worker.
- Contract triage (advisory): before a protected contract's escalation is
  handed to the human (the resolver, `--decide-contracts`, or the console), a
  configured decision model is asked one choice question, accept or reject
  ("Is changing this existing test needed to achieve the goal (rather than
  weakening the check)?"), over the item's objective, the proposing agent's
  rationale, the target path, the latest failing output that implicated the
  item, and a bounded excerpt of the target file as it is in the baseline (a
  regular file inside the project only). The proposed change itself is not
  available yet: a protected path cannot be pushed before a human accepts it.
  Every free-text field is bounded, credential-scrubbed, and framed as
  delimited UNTRUSTED DATA. The result is recorded as `decision.recorded
  {juncture: contract-triage, contract}`; the escalation record then carries
  `recommendation` ("reject (confidence 0.86)", or "no recommendation (reason)"
  for an error or a confidence below the threshold) and the same line appended
  to its question. The resolver request carries it too, and the CLI prints it.
  The human still decides: the triage never resolves an escalation, and without
  a decision model nothing is asked.
- `rebase.needed` matters mid-run: an agent whose intents intersect a passing
  revision's changes refetches that revision before its next edit.
- Handoffs go only to agents still running, and the new owner's first edit of a
  handed-off item starts from the previous owner's latest pushed version of the
  item's files (read with an operator read token).
- Concurrent quiescence: when every agent is idle, nothing is integrating or
  pending, and no board message arrived for `--quiet-ms` (default 2 minutes),
  the agent phase ends as `quiescent` with that reason recorded.
- Tokens: agents push with their own short write tokens, which are not
  refreshed, so the run refuses an agent-phase timeout longer than their
  lifetime (`--token-ttl`); the integrator reads with fresh read tokens per
  revision. Every reason, error, and printed transcript is credential-scrubbed.
- Prompt framing: the turn prompt wraps other agents' rationales and messages,
  the board digest, and repo files as delimited UNTRUSTED DATA blocks; when the
  context is too long it drops whole low-priority entries (excerpts, then the
  file listing, then the oldest messages), never cutting JSON mid-structure.
- Schedules: `lockstep` steps the lead then each worker in a fixed order every
  round (offline demo and tests: byte-identical logs run to run, with a fixed
  board clock and fixed Git commit dates); `concurrent` runs each agent's own
  loop with idle backoff (live).
- `packages/orchestration/src/board-policy.ts`: the deterministic,
  goal-agnostic stand-in for the turn model used offline. It answers contests
  (a claimant narrows an overlapping glob to the concrete files nobody else
  holds, or cedes; an owner keeps once), replies to questions addressed to it,
  asks the other party after a narrowing, fixes an item a failing revision asked
  it to fix, edits held items, proposes them done, and claims the first open
  item while free; a claim refused as a contract change proposes the change
  for each protected path it needs (one concrete path each), waits for the
  human's decision, and claims once more; when a path stays protected it adds
  a NEW test file beside the existing ones instead. The lead never decides a
  protected contract; it accepts others unless the target is held by another
  agent (a live lead decides on the goal). No rule names a file, an app, or a goal.
- `FirstAttemptFailingGate` (`run-board-offline.ts`): the generic offline gate
  FIXTURE (`--offline --fixture-gate`, used by `make demo-board`). It fails the
  first integrated revision, naming the first file that revision changed, and
  passes once that file was edited again. Offline only, it REPLACES a
  project's declared gate (the noop executor can never satisfy a real gate),
  and the run says so in its header and summary: "offline fixture gate
  replaces the project's declared gate (npm run gate); this demo shows
  coordination, not a real fix". It installs no dependencies. A live run
  refuses `--fixture-gate` and always uses the project's declared gate. It is
  a labelled demo stand-in, never a project's gate.
- Dependency install before every gate run: every tree a gate runs on (the
  baseline inventory run, unit checkouts, each revision's integrated tree, and
  run-live's ladder previews and final gate) is a fresh clone with no
  installed dependencies, so the gate runner installs what the GATED TREE's
  lockfile declares first, in the gate's directory: `package-lock.json` ->
  `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline`;
  `pnpm-lock.yaml` / `yarn.lock` -> a frozen, script-free install when the
  tool is on PATH (else stated unsupported); a bun lockfile and python
  manifests are stated unsupported and not attempted; `go.mod` needs nothing
  (go fetches on test, over the network); a `package.json` without a lockfile
  is NOT installed (an unlocked install is not deterministic). Install
  scripts never run. The install runs with the gate's allowlisted environment
  (no credentials), its own process group, a timeout (default 5 minutes,
  `installTimeoutMs`), and a package cache shared under the run's work root;
  network is allowed for the install. A failed install fails that gate run
  with "dependency install failed: <reason>" as its first line, and the gate
  does not run. The outcome (installed, skipped, unsupported, or failed, with
  its duration) is recorded per revision (`BoardRevision.install`), on the
  baseline inventory line, and in run-live's `result.dependencyInstall`, and
  printed in the summaries. The installer is injectable (`dependencyInstaller`;
  `make check` uses fakes or lockfile-free fixtures, so it stays offline).

Usage:

```bash
make demo-board                     # offline: local control, generic policy, noop executor, fixture gate
switchyard-change run-board --offline [--fixture-gate] [--decide-contracts accept|reject] --goal-file <goal.txt> --project <dir> [--min N] [--max N]
switchyard-change run-board "<goal>" --project <dir> --worker <url> [--min N] [--max N] \
  [--id <changeId>] [--item-turns N] [--max-turns N] [--fix-attempts N] [--timeout-ms N] \
  [--quiet-ms N] [--token-ttl S] [--decide-contracts accept|reject] [--gate-timeout-ms N] [--integrator local|cloud] \
  [--lockstep] [--gate|--no-gate] [--watch] [--allow-heuristic-planner]
```

`--integrator local` (the default) integrates in the driver process;
`--integrator cloud` leaves integration to the Worker's integration Workflow,
with the gate in a Cloudflare Container (next section). `make run-board
INTEGRATOR=cloud` passes it through.

A live board run needs `EXECUTOR=ai-gateway` with the gateway URL and token
(the turn model is `AI_GATEWAY_AGENT_MODEL`, else `AI_GATEWAY_MODEL`); without a
live turn model it refuses rather than substituting the offline policy.

## Integration on Cloudflare (`--integrator cloud`)

With the cloud integrator the driver does not integrate. The Worker does, on
Cloudflare primitives, through the same board path and with the same
integrator code:

- **Trigger.** An agent's `push.announced` (the board's authoritative signal:
  the commit is pinned there) asks the ChangeState for integration. When no
  integration Workflow is active for the Change, one starts
  (`IntegrationWorkflow`); otherwise the active one is marked to look again
  before it finishes, so pushes that land while a revision runs are coalesced
  into the next. One revision at a time per Change. The Artifacts `repo.pushed`
  queue path is unchanged (it drives run-live's recruitment, not the board).
- **Plan.** A durable step plans the next revision's job from the board with
  `planBoardIntegration`, exactly as the local integrator does (pins, includes,
  diff bases, write-intent scope, yielded files, released contract paths, the
  last recorded passing revision as the base). The job's idempotency key is the
  Change, the base commit, and the pinned commits (`integrationJobKey`): every
  later step is named by it, and a Workflow retry never integrates anything
  else.
- **Run.** The run step mints short-lived Artifact tokens Worker-side (a READ
  token per agent repo, a WRITE token for the integration repo, TTL just over
  the job's deadline), runs the job in the GateRunner's container, and revokes
  the tokens in the same step. The step's timeout is the job's deadline
  (install + gate + 5 minutes) plus 2 minutes. A job that cannot run (the
  container, the tokens) is retried twice by the Workflow, then recorded as
  transient (not a verdict; the same pushes are tried again on the next push or
  kick).
- **Containment.** Every job runs in a FRESH container: the GateRunner
  destroys any running container, starts one from the image, and refuses to
  start the job unless it is clean (no sandbox-user process; nothing in the
  work root, the temp dirs, or the sandbox user's home); after the job,
  success or failure, the container is destroyed. Inside a job the install and
  the gate run as the sandbox user, capped at 512 processes (RLIMIT_NPROC), with
  a HOME and temp dir inside the job's own root; whatever that user owns
  outside the job root is removed before the job (and the job refuses to start
  if anything remains). After the install and after the gate, every sandbox
  process is killed with `kill(-1)` issued as the sandbox user (the kernel
  signals all of them in one pass, so a respawning child cannot outrun it), and
  the job THROWS if one survives: the result is refused and transient, no
  verdict, and the push phase is never entered. Before each credentialed
  phase (fetch, push) both the CLI and the GateRunner (from outside, as root)
  check that no sandbox process is alive. A PID namespace (`unshare --pid`)
  is not available in the container (not permitted), so the process cap, the
  kill, and the checks are what contain the sandbox. tini is PID 1 and reaps
  orphans.
- **Attribute.** A failing revision's implicated items come from the same
  parse as the local integrator (the failing output's files and names mapped to
  the merged items' write intents, `attributeFailure` in change-core); when
  nothing maps, every merged item. When the run has a decision model, the
  configuration says `attribution: "driver"`: the Workflow holds the failing
  revision (bounded, 3 minutes) and the run sends its advisory typed-decision
  choice (`POST .../integration/cloud/attribution`, items it merged only); a
  confident choice narrows exactly as it does locally, no answer or "no
  choice" leaves the parse. The run records the decision on the board linked
  to the revision.
- **Record.** The result is recorded through the SAME path as
  `POST /changes/:id/integration/revision` (`appendIntegratedRev` in the
  ChangeState), with the local integrator's rules: nothing is recorded when
  every pending push was excluded or the integrator refused, nor when a merged
  push was superseded while the gate ran (the next plan integrates the newer
  set); a failing revision carries its bounded, credential-scrubbed output.
  Recording is idempotent by the job key (a replayed step returns the stored
  record and never appends a second revision).
- **Advance.** After a recorded pass, a second, git-only job fast-forwards the
  integration branch to the gated commit and prunes the candidate refs
  (`advanceIntegrationBranch`), so promotion clones a branch whose head is the
  gated tree.
- **Promote (local).** The driver follows the attempts (`GET
  /changes/:id/integration/cloud`), turns recorded ones into its revisions
  (with their evidence), waits for the Workflow to settle at the end, and
  promotes as always: it reads the integration repo with a fresh short-lived
  token, pins the gated commit, and refuses unless the promoted tree is the
  gated tree.

The job (`packages/verification/src/integrate-job.ts`) is tokenless JSON: the
integration repo and every agent repo by URL only, the pinned commits, the
contract, the baseline inventory (names stay in the Worker; the open view
shows count and format only), the gate's shared support files, and the
timeouts. The container's CLI (`integrate-cli.ts`) runs it with the unchanged
`ChangeVerification` / `Integrator` / `LockfileDependencyInstaller` and prints
the result: the gated commit, the verdict, the failing line, the bounded
evidence, the install outcome, the executed-test count, and the phases.

Egress phases inside one job (the container starts with internet access off;
only intercepted hosts resolve, and the GateRunner's egress handler decides
each request; switching a phase re-registers the handler with the next
phase's policy):

| Phase | Reachable | What runs |
|---|---|---|
| `fetch` | the Artifacts host, only the job's repos, git smart HTTP; the handler adds that repo's token | clone the integration repo and every pinned unit commit, verify each unit, compose, restore the contract, commit |
| `deps` | the package registry (`registry.npmjs.org`), GET/HEAD only, no credential | `npm ci --ignore-scripts` (or pnpm/yarn from their lockfiles) as the unprivileged sandbox user |
| `gate` | nothing | the gate command, as the sandbox user |
| `push` | the Artifacts host again, as in `fetch` | every sandbox-user process is killed first; then the drift check and the trusted-repo push of the gated commit to its candidate ref |

The CLI asks for each phase on its own stdout and waits for the GateRunner's
acknowledgement on its stdin; the GateRunner moves the policy before it
acknowledges, and refuses a phase that moves backwards. The install and the
gate run as another user (`scfgate`, uid 64321, via `setpriv`), so they cannot
read the integrator's trusted repo, its memory, or its protocol streams, and
cannot forge a phase change. The phases each revision ran under are recorded
with the attempt.

Posture: the integration routes sit behind the same optional
`SWITCHYARD_API_TOKEN` bearer as every other mutating route. With the bearer
unset (local `wrangler dev` on localhost) anyone who can reach the Worker can
create a Change and configure its integration before its goal; set the token
before exposing the Worker on a LAN (`make dev-all-lan`) or deploying it.

Glob note: `**` matches whole path segments in both matchers (the path scope
and intent overlap): `src/**/x` matches `src/x`, `src/a/x`, and `src/a/b/x`,
never `srcx` or `src/ax`; a leading `**/x` matches `x` at any depth. An intent
entry whose `**` shares a segment with other characters is refused.

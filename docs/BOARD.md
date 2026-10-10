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
  rejects contract proposals, and accepts or rejects the items WORKERS propose
  (`item.accepted`, `item.rejected` with a rationale).
- **The human** posts through `POST /changes/:id/board/human` (bearer):
  `goal.posted`, `item.proposed`, `item.accepted`, `item.rejected`,
  `claim.resolved` (a decision), `contract.accepted`, `contract.rejected`. The existing escalation resolve route
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
| `POST /changes/:id/board/read-token` | bearer | `{agent, ttlSeconds?, help?}` (default 600, 60 to 3600): a short-lived READ token for a joined agent's repo, for the integrator. `201 {workspaceName, tokenId, token, tokenExpiresAt}`. The lead and an agent that joined without a workspace have no repo (`400 NOT_ALLOWED`). With `help` (a help request id) it reads that request's FORK instead, only when `agent` holds the request's grant (the requester's pull). |
| `POST /changes/:id/board/read-token/revoke` | bearer | `{agent, tokenId, help?}`: revoke a read token the integrator is done with. |
| `POST /changes/:id/board/help-fork` | bearer | `{request, agent, ttlSeconds?}` (default 900, 60 to 3600): fork the REQUESTER's repo for `agent`, the helper of a help request that grants a scope (`<change>--help-<request>`, the Artifacts repo fork; offline, the local backend copies the repo). The board checks first (`checkHelpFork`: the request grants a scope, is live and not yet granted, the agent is another joined non-lead agent, the requester has a repo), so a fork the board would refuse is never made. `201 {workspaceName, gitUrl, defaultBranch, backend, fallback, tokenId, token, tokenExpiresAt, forkOf}`: the fork's one-time creation token is revoked and only a short write token is returned, once. The helper then posts `help.offered {forkOf, forkCommit, fork}` itself. Forks are archived at cleanup with the agents' repos (`DELETE /workspaces/:name`, which the offline control serves too). |
| `POST /changes/:id/board` | agent token | `{type, payload, rationale?, inReplyTo?, to?}` appended as that agent; `201 {appended, escalations}`. |
| `POST /changes/:id/board/human` | bearer | A human message. |
| `POST /changes/:id/board/decision` | bearer | `{juncture, question, answer?, confidence?, accepted, error?, rev?, parsed?, contract?}`: the engine appends an ADVISORY `decision.recorded` (a typed decision and its outcome, or a failed call's reason). An attribution names the failing revision `rev` (it must be the latest, failing) and the items the string-parse attributed; a `contract-triage` names its protected or seam `contract` (kept on the contract as `triage` for whoever decides it). It changes only the decision counts and that advisory line, never arbitration or the verdict. |
| `POST /changes/:id/board/record` | bearer | `{type, payload}`: an engine fact only the operator side observes, validated against the board before it is appended (`appendEngineRecord`): `claim.lapsed {item}` (a leased claim recorded `stalled` on a quiet board), `clash.predicted`, `trunk.moved`, `token.refreshed`, `revision.promoted`, `run.capped`. See "Stalls, re-plans, clashes, proofs, and caps". |
| `POST /changes/:id/board/agent-token` | bearer | `{agent, ttlSeconds?, help?}` (60 to 3600): a REFRESHED, short-lived WRITE token for a joined agent's own repo (with `help`, the granted helper's fork), for runs longer than one token lifetime. `201 {workspaceName, tokenId, token, tokenExpiresAt}`, returned once; the old token is revoked through the read-token revoke route. Same checks as the read-token route. With `help`, a write token also requires the helper still joined (a read token does not). |
| `POST /changes/:id/board/seam-stalled` | bearer | `{item}`: the board went quiet while this seam item held dependents; the engine appends `seam.stalled {item, released}` (the hold ends; with no push of its owner's the item is released). Refused unless the item holds a dependent. |
| `POST /changes/:id/integration/revision` | bearer | An integration result `{commit, gate, merged, failing?}`; appends `integrated.rev` and what it triggers (completions and `rebase.needed` on a pass, `fix.requested` / `fix.exhausted` on a fail). |
| `POST /changes/:id/tools/gate` | bearer | A tool's own gate result on the latest build of its item, `{capability, commit, passed, checks: [{check, passed, detail}], repo, usage, output?}`; the engine appends `tool.gated` (addressed to the builder) and, on a pass, `tool.published` (the next version) and the tool item's `item.completed {via: tool}`. See "Agent-built tools". |
| `POST /changes/:id/tools/used` | bearer | A run of a pinned, published tool version the operator's runtime executed in a consumer's repo, `{capability, version, by, item?, commit?, changedFiles, findings?, exit?}`; the engine appends `tool.used` (addressed to the tool's builder). |
| `POST /changes/:id/tools/workspace` | bearer | `{ttlSeconds}`: provision the Change's tools repo (`<change>--tools`) once, with a write token returned once; a repeat returns the same repo with a fresh token. |
| `POST /changes/:id/tools/token` | bearer | `{scope: "read" or "write", ttlSeconds}`: a short-lived token for the tools repo; `.../token/revoke {tokenId}` revokes one. |
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
`LIMIT`, `NOT_SUPPORTED` (a split, or a goal with `speculate` above 1, under the cloud integrator), `CLAIM_CAP`, `SEAM_FIRST`,
`SEAM_OVERLAP` (a claim writing a shared seam another holder's scope covers),
`STALE_BASE` (a revision not built on the board's integrated head). `AUTH` is 401,
`LIMIT` is 409 (413 for an oversized body), the rest are 400.

## Envelope

Every message is `{seq, at, from, type, payload, rationale?, inReplyTo?, to?}`.
`to` addresses other joined agents (questions, help, contract replies); the
digest surfaces addressed messages to their recipients. Free text belongs in
`rationale`; payload strings are ids, repo-relative paths or globs, or short
bounded fields that define an item.

## Vocabulary

`goal.posted {objective, rules, protected?, protectedKeys?, testInventory?, integrator?: local | cloud}`, `item.proposed`, `item.accepted {item}`,
`item.rejected {item}` (the lead or a human; a rationale is required), `item.claimed {item, intent:
{read, write}}`, `claim.granted`, `claim.contested`, `claim.ceded`,
`claim.kept`, `claim.narrowed {contest, write}`, `claim.resolved`,
`claim.escalated {..., reason: turns | idle}`, `item.split {item, children}`,
`item.discovered {..., scopeHint?}`, `help.requested {request, item, need, scope?}`, `help.offered {request, forkOf?, forkCommit?, fork?}`,
`help.delivered {request, commit, paths}`, `help.closed {request, reason: declined | pull-failed, detail?}`,
`item.struggling {item, turnsSpent, failedEdits, reason: failed-edits | turn-budget | failing-revision, lastFailure?}`,
`help.volunteered {item}` (addressed to the owner), `help.declined {item, volunteer}`,
`contract.proposed {contract, target, kind, item?}`, `contract.escalated {contract, item,
target, kind}` (engine: a protected contract waits for a human), `contract.accepted`,
`contract.rejected`, `seam.stalled {item, released}` (engine, recorded by the operator: a seam item held dependents while the board went quiet), `push.announced
{item, commit, paths, merges?: [{item, commit}], pulled?: [request]}`, `integrated.rev {n, commit, gate, merged, paths,
contributors, failing?: {output, items}, gated?: false}` (`gated: false`: no gate ran, so its pass checked nothing; `unverified: [{item, reason}]`: merged children of a sub-lead push the integrator could not verify, not integrated by it), `rebase.needed`, `review.requested`,
`review.result`, `handoff`, `done.proposed`, `item.completed`, `item.reopened {item, previousOwner, commit?, n?}` (n absent for a tool item)
(engine: a spent fix budget reopens the item for another agent), `fix.requested
{item, n, attempt}` (engine, addressed to the item's owner), `fix.exhausted
{item, n, attempts}` (engine), `tool.proposed {tool, capability, kind, inputs, outputs}` (a rationale is required),
`tool.built {capability, commit, paths}` (the tool item's owner), `tool.gated {capability, commit, passed, checks, repo, usage,
output?}` (engine, recorded), `tool.published {tool, capability, version, repo, commit, verified: true, kind, usage,
joinsGate?: false}` (engine, derived), `tool.used {capability, version, by, item?, commit?, changedFiles, findings?, exit?}`
(engine, recorded), `claim.lapsed {item, agent, reason: no-progress | deadline | stalled, lastProgressSeq, deadlineSeq?, commit?}`
(engine: derived under the lease rules, or recorded `stalled` on a quiet board), `claim.extended {item, reason}` (the lead or a human),
`claim.overlap {item, agent, with, withAgent, files}` (engine, derived under the overlap rule, advisory),
`item.replanned {item, reason: fix-budget-exhausted | stalled | item-cap, action: split | rescope | merge, children, with?, rev?}` (the lead or a human),
`item.escalated {item, reason: replan-failed, replanOf}` (engine, derived), `clash.predicted {a, b, status: conflict | unknown | unavailable,
paths?, scope?, reason?}` (engine, recorded, advisory), `trunk.moved {rev, commit, expected?, actual?}` (engine, recorded),
`token.refreshed {agent, kind: repo-write | help-fork, request?}` (engine, recorded; never a token),
`revision.promoted {rev, gatedCommit, commit, branch}` (engine, recorded), `run.capped {kind: model-calls | spend | wall-clock |
item-calls, limit, used, item?}` (engine, recorded), `candidate.gated {round, index, of, prefix: [{agent, items, commit}], commit,
base?, verdict: pass | fail, outcome: landed | passed | blamed | retest, rev?, blamed?, progress?}` (engine, recorded: one
speculative candidate; see "Speculative batch gating"), `decision.recorded {juncture:
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
default 3; `contestIdleMessages`, default 25; `maxFixAttempts`, default 2;
the optional `maxActiveClaims`, `claimLeaseMessages`, `claimDeadlineMessages`,
`claimOverlap`, and `speculate` (speculative batch gating, 1 to 8; absent
means 1), each absent on a board posted before it, which then behaves as
before), the integration `baseline` commit and the `gateCommand`
(both optional), and
the CONTRACT (`protected`: the existing tests and gate configuration no agent
may change alone; `protectedKeys`: gate-defining keys inside editable files,
shown for visibility and restored by the integrator), so a log is
self-describing.

Proposals come first. An item the lead or a human proposes is `open` at once.
An item a WORKER proposes (`item.proposed` or `item.discovered`) is `proposed`:
not claimable (`ITEM_NOT_OPEN`), not offered in digests as open work, and not
counted toward the Change, until the lead (or a human) posts `item.accepted`
(it becomes `open`) or `item.rejected` (it becomes `rejected` for good). A
decision is made once (`INVALID_STATE` after). A run's completion and its
partial accounting count only accepted items: a rejected or undecided proposal
never makes a passing run partial, and the summary lists each one (with the
lead's rationale for a rejection). Split children stay open (they divide an
item the agent already holds, inside its scope and its write intent), so they
need no acceptance from the lead.

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
   hint (and within its owner's write intent). A protected contract may also
   name the protected path that the latest failing revision implicating the
   item names as its failing check (the CONTRACT CUE: a test that pins the
   behavior the goal changes); the owner's digest says so
   (`claims[].contractCue`, whose hint names the action to send: `message`
   kind `contract {target, change: modify, itemId}`), and once a human accepts it the released path is
   writable for that item even outside its scope (its pushes may carry it and
   its integration unit applies it). New test files are never protected.
   TWO CLASSES: the IMMUTABLE acceptance gate (`goal.posted.immutable`: the
   files the declared gate command runs or references by name, the test
   files and runner configs in those gate directories, the harness they
   import, the toolchain files the gate invokes, every config a gate step
   reads (a step that runs vitest, jest, mocha, ava, or playwright without an
   explicit config flag reads that runner's root config, so it is immutable;
   `tsconfig*.json` when a step runs tsc), and the package-manager and
   runner configs protected even when absent) is never changed by any agent:
   a contract on it is refused (`IMMUTABLE`) whatever a human would answer,
   the integrator always restores it, and the contract cue never points at
   it (its failures ARE the goal). The rest of the protected set, the
   project's pre-existing developer TEST FILES (and configs no gate step
   reads), stays contract-changeable with a human's approval. The run summary and the CLI
   print both classes.
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
   A split item completes when every child is done AND its sub-lead's push
   for it passed (rule 11), citing that push's revision.
9. A passing `integrated.rev` sends `rebase.needed` to each active agent, other
   than the contributors, whose live read or write intent intersects the changed
   paths. A failing one completes nothing; for each item its evidence implicates
   whose owner is active, the engine appends `fix.requested` addressed (`to`) to
   that owner while the item's attempts are within `maxFixAttempts`, else
   `fix.exhausted`. The owner's next push answers the request.
10. Tools (see "Agent-built tools"): a `tool.proposed` creates the tool item
    `tool-<capability>` (scope `tools/<capability>/**`), decided by the lead
    like any worker proposal. Only its owner posts `tool.built`, with paths
    inside its write intent. `tool.gated`, `tool.published`, and `tool.used`
    are the ENGINE's only: an agent can neither claim its tool passed nor fake
    a use. `tool.published` follows only a passing `tool.gated` for the latest
    build, as the capability's next version, and completes the tool item. A
    `tool.used` pins a published version, names a joined agent, and, when it
    changed files, names the item that agent holds and the push that carried
    them (inside that item's write intent). An `item.proposed` citing
    `fromTool` comes only from that tool's builder and still needs the lead.
11. Splits and sub-leads: only the owner splits an item (not a tool item, not
    in a contest, not while its own push on the item is unintegrated:
    `INVALID_STATE`), and every child's scope must lie within the item's scope
    hint and the owner's write intent (`OUTSIDE_INTENT`). The owner becomes the
    item's SUB-LEAD (`subLead`) and keeps its write intent, which stays a LIVE
    CLAIM of the sub-lead while it is on the board: a claim on its own
    children never contests it, but any other claim overlapping it contests
    the sub-lead (single writer: paths no child covers stay the sub-lead's and
    nobody ships them), and the sub-lead can neither cede nor narrow it, nor a
    human hand it to the claimant. A sub-lead's push carries only the write
    intents of the children it merges (`OUTSIDE_INTENT`), and its integration
    unit is scoped to exactly those, with the contract paths released for
    those children. Before a revision marks merged children integrated, the
    integrator verifies each one: the child's tree at its pushed commit,
    within its write intent, must equal the sub-lead commit's tree for those
    paths (content, deletions, released paths); a child that does not match is
    recorded in the revision's `unverified` with the reason and is not
    integrated (the sub-lead merges it again). The sub-lead mirrors each
    child's in-intent tree, deleting what the child deleted. The integration
    Workflow on Cloudflare does not read children's repos in this slice, so it
    records every merged child unverified (nothing is integrated on a
    sub-lead's word), so the goal records the integrator and the board refuses
    splits under the cloud integrator (`NOT_SUPPORTED`) until it can verify
    them. A child push a revision recorded unverified is never merged again at
    the same commit (the child pushes again first), one child push is merged at
    most 3 times (`LIMIT`), and an empty sub-lead push is refused. No push
    carries a symlink inside its write intent (the runtime refuses the commit
    before pushing, and a pull or merge that would bring one), so a
    sub-lead's mirror and the integrator's check agree. While the sub-lead
    is on the board, a child's push is NOT integrated directly (an integrated
    revision merging it is refused): the sub-lead merges children's pushes
    into its own repo and announces ONE `push.announced` for the split item
    with `merges` (each a child's latest, unintegrated push; a split item's
    push must carry merges, and only a split item's may). A passing revision
    that merges the sub-lead's push integrates those children's pushes too
    (they complete like any item once their owners proposed done, and their
    authors are the revision's contributors); a failing one may implicate
    those children, and the integrators narrow a failure of a split item to
    the merged children whose write intents the failing output names (all of
    them when it names none), so the fix goes to the child owners. When the
    sub-lead has left, its children integrate directly and the split item
    completes with them.
12. Help with a fork: `help.requested` with `scope` GRANTS a sub-scope of the
    requester's write intent on its item (`OUTSIDE_INTENT` otherwise; never
    overlapping another live grant). The first `help.offered` with `forkOf`
    (the requester; `forkCommit` its latest announced push, absent when it
    pushed nothing; `fork` the fork's repo) takes the grant; a second is
    `DUPLICATE`. A grant nobody has taken blocks nothing: the requester keeps
    working on the scope and may propose done. Once a helper TAKES it (its
    fork offer), single-writer holds inside the item while it is live: the
    requester's pushes may not touch the scope (`INTENT_OVERLAP`) unless they
    pull the delivered work, and it may not propose done (`INVALID_STATE`).
    Only the grantee posts `help.delivered` (its fork's commit, concrete paths
    inside the scope). The requester's `push.announced {pulled: [request]}`
    closes the grant. Never waiting forever: a grant nobody takes within
    `helpWaitMessages` (60) board messages of the request, or whose helper left
    or did not deliver within 60 of its offer, or whose delivered work the
    requester did not pull within 60 of the delivery, lapses (`helpGrantLive`,
    a pure function of the board). A delivery is refused once the grant
    lapsed or closed (a late one never revives it). The requester may close a
    grant without pulling (`help.closed`: `declined`, or `pull-failed` with the
    reason; the runtime posts the latter when a pull is refused for changing
    paths outside the grant or does not merge), and the scope is its own again.
    A grant may be addressed (`to`): only those agents may fork for it.
13. Formation cues (status, never a decision): an owner's runtime reports an
    item going badly with `item.struggling` (two failed or refused edits or
    tool runs, half its item turn budget spent with no push of its own yet, or
    a failing revision of ITS OWN push asking it for a fix; an inherited fix
    request on a handed-off item does not count until its own push fails), at
    most 3 times per item and owner, never twice the same, only by the current
    owner, with the last failure of that item's own edits. The report goes stale once its owner pushes again. The
    owner's digest then shows `struggling` and `idleAgents` (agents holding
    nothing); an agent that holds nothing while no item is open sees
    `busyOwners`. It may `help.volunteered` (addressed to the owner; one
    unanswered offer per agent and item, at most 2), and the owner answers with
    a grant addressed to it (`help.requested {scope}` with `to`, then the fork
    flow) or `help.declined`.

## Limits

Per board: 20000 messages, 1000 items, 100 agents, 200 published tool
versions (64 findings per use, 16 checks per tool gate), 512 protected paths (more existing tests than that are collapsed into
their dedicated test directories). Per message: 32 children per split (and 32 merges per sub-lead push), 64 entries
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
  (cede, keep, narrow), `edit`, `propose_done`, `propose_tool`, `build_tool`,
  `use_tool`, `pull` (a sub-lead merges its children's pushes, or a requester
  pulls a helper's delivered commit), `decide_contract`, `decide_item`,
  `extend_claim` (a claim near its deadline) and `replan_item` (an item not
  getting done: `plan` split, rescope, or merge with `withItemId`) (the lead
  only), or `wait`. A `message` of kind `help` may carry `scope` (the
  files it grants to a helper who forks its repo). A lead turn
  sees the pending proposals (`board.pendingItems`) and the accepted items
  (`board.items`) to compare them against; a new undecided proposal wakes it. The reply is validated strictly;
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
- Cues in the runtime: before a turn the runtime posts the owner's
  `item.struggling` report when a threshold is crossed (once per reason and
  revision); the turn input carries the digest's `struggling`, `idleAgents`,
  `busyOwners`, and `volunteers`, and `board.cues.splittable` for struggling
  items where a split is legal now (no unintegrated push of the owner's on
  the item, not the cloud integrator) whose write intent spans at least 3 files or whose objective names at
  least 2 sub-changes (`splitCue`: clauses split on `;`, `,`, `and`, `then`,
  of at least two words). The model decides: `offer_help {itemId, toAgent,
  why}`, `answer_volunteer {itemId, volunteer, accept, scope?}`, help with a
  scope, or a split. A new cue set wakes the agent once (a struggling report
  wakes agents only while they are free), so cues never storm.
- Formation in the runtime (see "Splits, sub-leads, and fork-based help"):
  a `split` posts `item.split` (children `<item>.<n>`); a `pull` on a split
  item the agent leads copies each child's latest pushed files (inside that
  child's write intent, read with an operator read token) into its own repo
  and announces one push with `merges`; a `reply` to a help request that
  grants a scope forks the requester's repo (the operator's help-fork route)
  and offers with its lineage; an `edit` on the requester's item by its
  grantee runs in the fork, only on the granted files, and posts
  `help.delivered`; a `pull` with `requestId` fetches the delivered commit
  from the fork, refuses it unless everything it changed since the fork
  point lies inside the grant, merges it into the requester's own repo (a
  fast-forward when nothing else moved), pushes, and announces with `pulled`.
  An owner's own edits never touch files it granted while the grant is live.
- Acceptance progress (advisory): each integrated revision records how many
  of the gate's checks passed, per suite (`integrated.rev.progress {passed,
  failed, total, suites?[{..., suite?}], acceptance?, acceptanceNotRun?}`).
  The gate check reads it from its FULL output (`CheckResult.progress`; the
  captured evidence is bounded and can cut a later suite's summary), split
  per runner summary with the test files each suite listed
  (`readTestProgress`). A suite whose files are in the immutable acceptance
  gate is labeled `acceptance`, one listing only other test files
  `developer` (`labelGateProgress`). When an earlier step stopped the gate
  (a typecheck error, a developer suite that failed first under `&&`, or a
  summary the capture lost), the revision says so instead of a number:
  `rev 9: acceptance suite did not run: typecheck failed (1 error)`. The
  summary prints `rev 7: acceptance 88/129 passing; developer 9/9 (+12)`
  (`describeProgress`), and the console shows it on revision nodes and the
  ticker. It never decides a verdict.
- A stronger executor for complex items: an item whose write intent covers
  at least 3 files, one with a contract proposed or accepted for it, a
  reopened item, or one whose first fix failed starts its app edits on the
  strongest configured model of the ladder; small items keep the base model.
  Every push records the model in its rationale, and the summary prints
  `edit models: ...`.
- Budgets scale with the plan (bounded; explicit flags win): the lead plans
  BEFORE the goal is posted, so the goal's fix budget is 3 + floor(items / 5)
  (at most 6), without an explicit `--max` the dial's max is min(items, 6)
  (at least the dial's min), without an explicit `--max-turns` the
  run-wide turn budget is min(800, max(200, 25 per planned item + 10 per file
  in the planned scopes)), and without an explicit `--claim-cap` the claim cap
  is 1 (2 when planned items are at least three times the dial's max). The
  effective values are printed (`budgets: ...`).
- No claim hoarding (`goal.posted.rules.maxActiveClaims`): an agent may hold
  at most that many UNFINISHED change items (its latest push has not passed
  an integrated revision); a further claim, or a handoff to an agent at its
  cap, is refused (`CLAIM_CAP`) and the digest says so (`claimCap`: finish
  one or hand it off). Seam items and tool items are exempt. A board posted
  without the rule keeps unlimited claims.
- Seam first: the goal records the shared seams of a modular project (the
  cohesion blueprint's frozen contracts) with their importers
  (`goal.posted.seams`). An item whose scope covers a seam is offered first
  (`seam` on open items; in lockstep its holder moves first), but only the
  seam item of an ACCEPTED SEAM CONTRACT (`fromContract`) HOLDS dependents: a
  claim on an item covering one of its importers is refused (`SEAM_FIRST`)
  until its push is GATED (merged into a revision, pass or fail: dependents
  merge with it from then on), while it makes progress (its grant or latest
  push within 60 board messages). A seam item never waits on another seam
  item. An OPEN seam item (nobody holds it) is listed in every worker's
  digest (`openSeams`, with `blocks`: the agent's items importing that seam)
  with a plain hint that it may claim it itself; a free agent, one whose
  items need it, or one with no change item in progress is woken once per
  open set, and before a quiet board could end the run the driver nudges the
  workers again (bounded, `MAX_OPEN_SEAM_CUES`). One predicate, `seamItemHolding`, decides
  this for the hold, the digest's `waitsFor`, `seamHolds`, and the stall check
  (`seamWaits`); a held dependent does
  not edit yet and then rebases onto the seam change (a passing revision that
  changes a seam sends `rebase.needed` to the holders of its importers). Each seam also records
  the names it exports (`symbols`).
- Seam contracts (decided by the LEAD): a seam no live item's scope covers is
  frozen. When a failing revision's type error (a tsc `path(line,col): error
  TS2339: ...` mismatch) is located in a frozen seam, or in a file of the
  implicated item that imports one (narrowed to the seam that exports the
  type the error names, such as `'Ctx'`), the owner's digest carries
  `claims[].seamCue {seams, errors, hint}`: send `message` kind `contract
  {target: the seam, change: modify, itemId, description: the exact change}`
  (the agent action that becomes `contract.proposed`) instead of using
  undeclared fields or casts. Only the owner of the implicated item
  proposes it, one pending per seam; a seam another item owns is refused
  (ask its owner). Bounded: one seam contract waiting per agent, three per
  Change, and one seam change per failing cause (a second one from the same
  agent for the same failing revision is refused while the first is
  unfinished). It is not escalated: the lead decides it. The lead's turn
  shows each with its exact id (`pendingContracts[].contract`; already
  decided ones in `decidedContracts`), the needed change (`description`),
  mechanical facts (`namedInFailure`: the failing output names the seam or a
  name it exports; `duplicateOf`: an earlier live seam change with the same
  description or the same NEW name), and, when a decision model is
  configured, an ADVISORY triage (`triage`, recorded as a `contract-triage`
  decision before the lead's turn; it never decides). The lead rejects
  duplicates, seams the error does not name, and new behavior; the offline
  policy does the same. `decide_contract` accepts the contract id or the
  seam item id derived from it, and refuses an already decided one locally.
  Accepted, the engine proposes the seam item `seam-<contract>`
  (`fromContract`, scoped to the seam) and GRANTS it to the proposer at once
  (it holds the context); it goes first like any seam item, and its
  importers wait for it and rebase onto it. The item that asked gets no
  release of the seam path: the seam item alone carries the change. The
  hold lasts only while the seam item makes progress (its grant or latest
  push within the seam-wait bound); when the board goes quiet while a seam
  item holds dependents, the driver records `seam.stalled` before quiescence
  could end the run (lockstep: an idle round; concurrent: half the
  quiescence window): the hold ends, and a seam item its owner pushed nothing
  for is released (open, `seam` first) for an idle agent. A rejected seam
  contract is cued again only after a newer failing revision implicates the
  item.
- Failures the plan missed become work: when a failing revision's evidence
  points at repo files that no item covers in any status, the lead proposes
  ONE item for them per revision (at most 4 per run), scoped to those files,
  with the revision's failing line in its rationale (`failingRepoFiles`,
  `uncoveredFailureFiles`). The evidence is read most telling first: failing
  test titles naming a module and error locations outside stack frames;
  only without those, stack frames, and of each stack only the outermost
  non-test repo frame (the caller): a file seen only as a deeper callee (a
  shared helper the failing code called) is never where a failure is. Shared
  seams are never proposed as uncovered work (they change only through a
  seam contract); when only seams are left, nothing is proposed and the lead
  records why (`SEAM_ONLY`). Struggling reports carry the gate's failing line
  (`gateFailureLine`), never a command echo.
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
  revision's gated commit tree. A worker's proposal awaiting the lead keeps the
  phase open (`all-items-done` waits for the lead's decision).
- Work roots: the CLI's offline commands (`run`, `run-goal`, `run-board
  --offline`) remove their whole scratch work root when they finish
  (`work root removed: <path>`); a live run (`run-live`, `run-board`) and
  `promote` keep only the promoted repo (the printed `repo:` path) and remove the
  rest. `--keep-work-root` keeps everything and prints the path. Only a run's
  own `scf-` scratch directory is ever removed. The tests run under one private
  temp root per `vitest` run (`tools/vitest-temp-root.ts` points TMPDIR at it
  and removes it at the end; `SCF_KEEP_TEST_TMP=1` keeps it).
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
- Credentials never travel through the CLI's process environment. A process's
  INITIAL environment is readable by any same-user process
  (`/proc/<pid>/environ`), so a gate or tool child could read its parent's. No
  Makefile target exports `.env` into the CLI any more: the live commands
  (`run-live`, `run-board` without `--offline`, `recruit-live`, `doctor`,
  `jev-smoke`, `tool-smoke`, `deploy-app`, `cleanup-live`, `env-check`) read `.env` (or
  `SCF_ENV_FILE`) themselves into memory, and the offline commands never read
  it (`packages/orchestration/src/credentials.ts`,
  a small parser, no dependency), and the code that needs a credential reads it
  from there (`runtimeEnv()`); wrangler, a trusted tool, gets exactly the
  Cloudflare credentials it needs passed to its own process. `make dev-all`
  gives `.env` to the Worker's subshell only, and the console launcher strips
  credentials from every run it spawns. `make cli ARGS=env-check` prints the
  credential NAMES in the CLI's environment (none expected) and the names it
  loaded from `.env`; the CLI warns when it finds a credential in its own
  environment. Residual risk: `.env` is still a file the same OS user can read
  by absolute path, and a process with ptrace rights over the CLI (Yama
  `ptrace_scope` 0) could read its memory; the cloud gate container (a separate
  user with no such file) avoids both for the app gate.
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
  transitively (bounded depth; a relative specifier resolves as Node and TS
  bundlers do: the exact file, a `.js`/`.jsx`/`.mjs`/`.cjs` specifier naming its
  `.ts`/`.tsx`/`.mts`/`.cts` source, the path plus each extension, then
  `<path>/index.<ext>`, so `import ... from "./harness"` protects
  `gate/harness.ts`): an imported file under a HARNESS ROOT is harness,
  protected and followed. A harness root is a dedicated test directory
  (`test`, `tests`, `__tests__`, `spec`, `specs` anywhere in its path), a
  directory the gate names, or the directory of a file the gate runs (a gate
  test, script, or runner config) unless that directory is colocated (it holds
  the module a gate test is named after, `a.ts` beside `a.test.ts`); the repo
  root counts only for files directly in it. A developer test outside a
  dedicated test directory is not a root, so what a colocated test imports is
  application code, the code under test, neither protected nor followed. A
  file the gate only syntax-checks (`node --check src/index.js`, or `node -c`;
  for any other program `-c` names a config) is code under test and never
  protected. The acceptance gate's directories (a dedicated test directory, or
  one named like the gate, holding a gate test or config, and any directory the
  gate names) are protected WHOLE: fixtures, expected outputs, and setup files
  in them are immutable too; another directory of a gate file protects only its
  test files and configs, and no app module is protected for being named like
  a helper. A runner config the gate reads (`--config f`, `-c f`,
  `--config=f`, or the root default) has every repo file it names by a string
  path (setupFiles, globalSetup, a reporter) protected as part of the gate. In
  `package.json` only the KEYS that define the run are protected (the scripts
  the gate invokes, transitively, each with its `pre` and `post` lifecycle
  scripts; `type`, `packageManager`, `imports`, `exports`, and the jest, mocha,
  ava, babel, c8, nyc, vitest sections), plus the gate's own toolchain: the
  RUNNER packages (every program the gate runs, however it is reached: an npm
  script, `npx`, `./node_modules/.bin/...`, a `node_modules/<pkg>` path, and
  `typescript` when it runs `tsc`) in `dependencies`, `devDependencies`,
  `optionalDependencies`, and `peerDependencies`, and the whole `overrides`,
  `resolutions`, and `pnpm` sections. In an npm lockfile the runner packages'
  entries and their transitive dependencies' entries (version, resolved,
  integrity, link) are protected key by key, and the integrator checks every
  gated tree against the baseline before the gate runs
  (`runnerResolutionViolations` in
  `packages/verification/src/runner-resolution.ts`, called from the
  integrator with the runner packages the protected manifest keys name: a
  changed or added closure entry, such as a nested copy that would shadow a
  runner dependency, a `file:`/link resolution, or a new package claiming a
  runner's bin is refused as a protected violation). Such a change cannot be
  restored key by key, so it fails the revision even where a protected change
  would otherwise only be restored; the same integrator gates every
  speculative candidate, so no candidate lands with a swapped runner either. A
  pnpm or yarn lockfile, or an npm lockfile whose runner closure is too large
  to list (over 400 entries), is protected whole. A dependency change that
  moves a runner dependency's lockfile entry (a re-hoist) is refused like any
  protected change. Other dependencies and lockfile entries stay editable.
  `tsconfig*.json` is
  protected when the gate runs the type checker (`tsc`, `npx tsc`,
  `./node_modules/.bin/tsc`). Root runner configs (`pytest.ini`, `tox.ini`, `setup.cfg`,
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
  revision, as a compare-and-swap fast-forward (see "Repos and promotion
  safety" below), and the candidate refs are pruned, so a result that is
  discarded never moves the branch. A unit's
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
  driver kicks it whenever it observes pending pushes. With speculation on (the
  `speculate` rule, K > 1) and a head that passed, a round gates prefix
  candidates of the pending pushes instead (next section).
- A failing revision's reason (`failure:`) and its evidence lead with the
  gate's own failing line (a `SyntaxError`, a failing test); an inventory
  shortfall is the stated cause only when the gate exited 0 (the early exit it
  protects against), and secondary otherwise.
- Attribution reuses run-live's: parse the failing output for the files and
  names it reports and map them to the items' write intents (command echoes
  such as npm's `> node --check a.js && ...` are ignored, and error locations
  `<path>:<line>` and the type checker's `<path>(<line>,<col>): error TS...`,
  which may be absolute paths in the gate's checkout, are preferred when
  present; a type error is also the revision's stated failing line); then a CONFIDENT
  typed-decision choice when configured (advisory narrowing only); else every
  item the revision merged. Parse and pick combine the same way locally and in
  the integration Workflow (`combineAttribution` in change-core): an
  unattributed parse ("all") with a confident pick implicates the pick ALONE
  (`jev`); an attributed parse that already names the pick stays `parse`; a pick
  outside an attributed parse is added to it (`jev`). The driver sends the
  Workflow only its pick, never its own combination, so the pick is never
  unioned with every item. The board then asks each implicated owner for a fix.
  A failure that names files of already COMPLETED items is a regression this
  revision's pushes caused (the tree passed before them): the evidence says
  which completed items regressed, and the fix is asked of the owners of the
  merged pushes (completed items are not reopened).
- A fix request is a turn: the owner refetches the latest passing revision,
  sees `claims[].fix` and `digest.failure` (the failing output, framed as
  untrusted data), edits with the failing output in the executor's objective on
  the next model of the escalation ladder per attempt
  (`AI_GATEWAY_ESCALATION_MODELS`), and pushes again, which triggers the next
  revision. `claims[].fix.instruction` states it plainly: the item FAILED, a
  done proposal does not complete it, and the owner is not waiting for
  integration. An owner that answers a fix request with a wait (or an invalid
  reply) is given another turn at once with a `FIX REQUIRED` cue, at most
  twice per item and failing revision (`MAX_FIX_CUES`). Fix attempts per owner are bounded by `maxFixAttempts`
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
  (up to 5 times, the last one stating plainly that the item cannot complete
  otherwise; a turn it was taking anyway does not use one up). The engine never
  proposes done on an owner's behalf: an item whose push passed but whose owner
  never proposed done stays incomplete, and the summary says exactly that
  (`not completed: item X: its push passed in rev N but its owner did not
  propose done`), with a reason line for every other incomplete item too. A failing
  revision's reason is shown as its first full line(s), at most 300 characters
  (`failure:` in the summary and the CLI), and the full bounded evidence stays
  on the board. The
  summary prints the promoted repo path and the baseline gate inventory.
- Human contract decisions: `--decide-contracts accept|reject` answers them
  non-interactively (the run-board counterpart of run-live's `--owner`; `make
  demo-board` rejects, so its tests item adds a NEW test file instead of
  rewriting the existing ones); without it each decision waits durably for the
  console or `POST /changes/:id/escalations/:id/resolve`.
- Typed decisions (advisory): the lead's plan review (from the planner pass;
  when a review is not accepted the planner re-plans once with the doubt as
  feedback, and every review is recorded, the plans not chosen first),
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
  is asked for a fix (a confident pick together with the parse's items, the
  pick alone when the parse attributed nothing, otherwise the parse's items
  alone), and the asked items tend to be the ones
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
- Concurrent quiescence: when no agent is taking a turn, nothing is integrating
  or pending, and no board message arrived for `--quiet-ms` (default 2
  minutes), the agent phase ends as `quiescent` with that reason recorded (in
  the result and the summary). An idle agent that is only polling its digest
  does not count as active: counting it kept a live board where every agent
  waited from ever looking quiet, since some agent was almost always mid-poll.
- Tokens: agents push with their own short write tokens, which the driver
  refreshes before they expire (see "Token refresh for runs over one token
  lifetime"), so `--timeout-ms` may exceed `--token-ttl`; `--no-token-refresh`
  restores the refusal of an agent-phase timeout longer than their lifetime.
  The cloud integration repo's token is NOT refreshed, so `--integrator cloud`
  refuses an agent phase longer than that token's lifetime. The integrator
  reads with fresh read tokens per revision. Every reason, error, and printed
  transcript is credential-scrubbed.
- Turn output that is almost right is repaired, not discarded: a `message`
  whose `payload.need` is free text (it must be a short id such as
  `auth-contract`) is normalized to a slug of at most 64 characters, and the
  original words are appended to the rationale; the schema and the prompt say
  so too.
- Prompt framing: the turn prompt wraps other agents' rationales and messages,
  the board digest, and repo files as delimited UNTRUSTED DATA blocks; when the
  context is too long it drops whole low-priority entries (excerpts, then the
  file listing, then the oldest messages), never cutting JSON mid-structure.
- Schedules: `lockstep` steps the lead then each worker in a fixed order every
  round (offline demo and tests: byte-identical logs run to run, with a fixed
  board clock and fixed Git commit dates), with the agents building a tool
  that is not published yet first in the round (`lockstepOrder`, schedule
  priority); `concurrent` runs each agent's own loop with idle backoff (live).
  Recruitment counts a help request that grants a scope nobody has taken yet
  as open work, so the dial can bring in a helper.
- `packages/orchestration/src/board-policy.ts`: the deterministic,
  goal-agnostic stand-in for the turn model used offline. As the lead it decides
  workers' proposed items (`decide_item`): it rejects one that duplicates an
  existing item (every scope entry overlaps that item's scope, or the objective
  is nearly the same words) or that declares no scope, and accepts the rest. It answers contests
  (a claimant narrows an overlapping glob to the concrete files nobody else
  holds, or cedes; an owner keeps once), replies to questions addressed to it,
  asks the other party after a narrowing, fixes an item a failing revision asked
  it to fix, edits held items, proposes them done, and claims the first open
  item while free; a claim refused as a contract change proposes the change
  for each protected path it needs (one concrete path each), waits for the
  human's decision, and claims once more; when a path stays protected it adds
  a NEW test file beside the existing ones instead. The lead never decides a
  protected contract; it accepts others unless the target is held by another
  agent (a live lead decides on the goal). Tools (see "Agent-built tools"): the lead
  seeds a scanner and a codemod when the planned items repeat one mechanical
  change (a free worker proposes them if the lead did not); workers claim
  seeded tool items first and the builder builds it; owners run a published scanner, then the codemod, before editing
  by hand; a scanner's builder turns findings no outstanding item covers into
  one proposal, and runs its scanner over the whole repository once right after publishing
  and again (bounded) after new passing code; the
  lead accepts tool proposals, and tool-found work unless an outstanding item
  already covers its files. Formation: an owner splits a held item the
  planner did not decompose (a worker's or a tool's proposal) that has no push
  yet and spans at least two files no codemod covers, one child per directory
  (else per file), then leaves the children to others (it takes one only
  after waiting twice) and pulls their pushes as sub-lead; an owner whose
  codemod pushed several files of an item grants the second half of the hand
  pass to a helper, does not propose done until it pulls the delivered work,
  and a free agent takes such a grant before claiming new work; while a
  codemod covering a held item is still being built, its owner first reads
  the item's files (a wait, at most two) before editing by hand. No rule
  names a file, an app, or a goal.
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
switchyard-change run-board --offline [--fixture-gate] [--decide-contracts accept|reject] --goal-file <goal.txt> --project <dir> [--min N] [--max N] [--keep-work-root]
switchyard-change run-board "<goal>" --project <dir> --worker <url> [--min N] [--max N] \
  [--id <changeId>] [--item-turns N] [--max-turns N] [--fix-attempts N] [--timeout-ms N] \
  [--quiet-ms N] [--token-ttl S] [--decide-contracts accept|reject] [--gate-timeout-ms N] [--integrator local|cloud] \
  [--speculate K] [--lockstep] [--gate|--no-gate] [--watch] [--keep-work-root] [--allow-heuristic-planner]
```

Flags are `--flag value` (two arguments): an inline `--flag=value` and a known
flag with no value are refused with a clear error. The dial is integers
`1 <= --min <= --max <= 16` (without `--max` the default 3 is raised to
`--min`); `--token-ttl` is an integer from 60 to 3600 seconds; every numeric
flag must be a plain decimal number (never coerced: `NaN`, `Infinity`, `1e3`,
and `0x10` are refused).

`--speculate K` (1 to 8; default 3 with the local integrator) sets speculative
batch gating (see "Speculative batch gating" below); `--speculate 1` integrates
every pending push as one revision, exactly as before. The offline run accepts
it too (`run-board --offline --speculate K`).

`--integrator local` (the default) integrates in the driver process;
`--integrator cloud` leaves integration to the Worker's integration Workflow,
with the gate in a Cloudflare Container (next section). `make run-board
INTEGRATOR=cloud` passes it through.

A live board run needs `EXECUTOR=ai-gateway` with the gateway URL and token
(the turn model is `AI_GATEWAY_AGENT_MODEL`, else `AI_GATEWAY_MODEL`); without a
live turn model it refuses rather than substituting the offline policy.

### Speculative batch gating (`speculate`, `candidate.gated`)

One revision of every pending push means one bad push sinks the good ones
merged with it, and attribution may send fix requests (and charge fix
budgets) to owners whose pushes were fine. With the goal rule `speculate` K
(`--speculate K`, 1 to `BOARD_LIMITS.maxSpeculate` = 8; default 3 with the
local integrator; absent on the goal means 1) the local integrator gates a
round of PREFIX CANDIDATES instead (`integrateSpeculativeRound`,
`packages/orchestration/src/speculative-integration.ts`):

- **When.** Only once the integrated head PASSED the gate (a recorded passing
  revision). A candidate's failure says something about the push it added only
  when what it was stacked on is known to pass; the goal's baseline may fail
  the gate (the gaps the goal is about), so until a revision passed, every
  pending push is integrated as one revision, exactly as with K = 1 (the
  demos' first, failing revision is unchanged).
- **The stack.** The units of `planBoardIntegration` (one per agent, pinned,
  scoped, as above), minus any agent whose pending item carries an unanswered
  fix request (a push a candidate already blamed waits for its owner's next
  push instead of sinking the pushes behind it again), ordered by each unit's
  earliest pending push seq, then agent id (`speculativeUnits`). At most K
  units are stacked; the rest wait for the next round.
- **Candidates.** C1 = head + p1, C2 = head + p1 + p2, ..., Ck. Each is built
  and gated exactly like a revision: the same verifier and integrator, the
  same immutable gate, contract restore, dependency install, test inventory,
  and process-group kill per command, each in its own disposable work
  directories, on the same recorded head, none moving the branch. They run with
  bounded concurrency (`candidateConcurrency`, default K; the offline run uses
  1, in order, so its log stays deterministic). A later candidate is not
  started once a shorter one is known to have failed, nor once a run cap is
  reached (`stopCandidates`: caps stop NEW candidates; C1 always runs).
- **Landing.** The LONGEST prefix C1..Ck that all passed lands as ONE passing
  revision whose recorded commit is exactly Ck's gated commit, built on the
  head (`STALE_BASE` applies: a head that moved while the candidates gated is
  a rebuild, never a wrong landing). Nothing lands when C1 fails.
- **Blame.** When C(k+1) FAILED right after the landed prefix (or C1 failed:
  head + p1 alone), its last push is the only difference from a tree known to
  pass, so the failure is attributed to that push: C(k+1) is recorded as a
  FAILING revision on the same head (its own gated commit, every push it
  contains in `merged`) whose implicated items are that push's items only,
  narrowed further by the existing parse of test titles and error locations
  (`failingRevisionEvidence`; never stack frames). It is recorded BEFORE the
  landed pass (a failing revision does not move the head), so both name the
  head they were built on and the pass stays the latest revision. The board's
  fix loop then asks, and charges the fix budget of, those items alone. With
  nothing landed the advisory typed decision may narrow among that push's
  items as for any failing revision; after a landed prefix it is not asked
  (the pass that follows would resolve its pick at once).
- **Re-tests.** Every candidate after the first non-pass is NOT blamed: its
  push stays pending and is stacked again next round on the new head (the
  blamed push is held, so it no longer sits ahead of it). Each round decides at
  least its first candidate's push (it lands or is blamed), so a re-tested push
  is decided within as many rounds as there are pushes ahead of it. The
  integrator starts the next round itself after a recorded round.
- **Records.** Every gated candidate is recorded after the revisions as
  `candidate.gated {round, index, of, prefix, commit, base, verdict, outcome,
  rev?, blamed?, progress?}` (engine, through the engine-record route):
  `landed` (rev: the passing revision; the board refuses one whose commit is
  not the latest passing revision's), `passed` (a longer prefix landed),
  `blamed` (rev: the failing revision; blamed items), `retest`. Only revisions
  are verdicts; candidates are records that back them, and the board refuses
  them unless the goal's `speculate` rule is above 1. A candidate that was not
  built, or not gated, is never recorded.
- **Console and proof.** A revision's detail lists the candidates of the round
  that recorded it (records, each with its seq: no new node or edge kind), the
  thread shows each `candidate.gated`, and the proof bundle lists the round
  that landed the final revision with its landed candidate, whose commit must
  be the revision's gated commit and the promoted one (`formatProofSummary`
  prints it on one line). Recorded replays without candidates fold unchanged.
- **K = 1** records exactly the board log of the integrator before this
  feature (a golden test pins the offline demo's log), and the goal posts no
  `speculate` rule.
- **Cloud.** The integration Workflow on Cloudflare gates one revision at a
  time: with `--integrator cloud` the default is 1, and `--speculate` above 1
  is refused at startup (the CLI and `runBoard`), as is a goal with
  `integrator: cloud` and `speculate` above 1 (`NOT_SUPPORTED`), like splits.

## Agent-built tools

Agents decide which tools to build, build them, and run them for each other;
the engine and the operator's runtime keep it honest. Nothing here is goal- or
app-specific.

- **The lead seeds tools.** When the lead seeds the planner's items and the
  structural rule fires (`detectBoardToolNeed`, the board form of
  `toolneed.ts`: two or more planned items making one change over at least
  three unprotected files, where "one change" is either a shared id prefix,
  or near-identical objectives over sibling files: after removing each item's
  own words (its scope's path tokens, its id's tokens, numbers), either the
  objectives' first sentences or clauses have token Jaccard of at least 0.7,
  or the full objectives an overlap coefficient (shared words over the
  smaller set) of at least 0.6, so an identical lead with item-specific
  detail after it still groups; and the scopes share a parent
  directory or a file name in sibling directories; so a planner that names
  items freely, such as `u1-auth-resource` ... `u6-users-resource`, still
  groups, while unrelated objectives in sibling files, or one objective spread
  over unrelated directories, do not), the lead itself posts a scanner and a codemod for it
  (`tool.proposed`, open at once like every lead item), and each item the
  codemod covers says in its objective: claim this item now; if the codemod
  is published run it with `use_tool` after the scanner, otherwise edit by
  hand; never wait for a tool. Tools are accelerators, never prerequisites:
  workers claim open items right away (the seeded tool items too), nobody
  waits for a tool while it is being built, and a free agent whose last turn
  was a wait while open items exist is told (at most 3 times per set of open
  items) to claim one. The turn prompt says the same.
  This is the trigger that makes tools happen on a live run without relying on
  the turn model to think of them.
- **Propose.** `propose_tool {capability, kind, why, inputs, outputs}` posts
  `tool.proposed` (kinds: `scanner` finds every place that needs a change,
  `codemod` applies one transform across many files, `check` fails while a
  violation remains, `harness`, `repro`, `index`). It becomes the board item
  `tool-<capability>`, scoped to `tools/<capability>/**`; a worker's proposal
  waits for the lead's `item.accepted` like any other. A codemod must declare
  its `inputs` (its intended scope); a scanner with no inputs looks at the
  whole repository. Tool items are internal: they never count toward (or
  against) the Change's completion; the summary reports them in a tools
  section.
- **Build.** Whoever claims the tool item builds it with `build_tool`. The
  Change's TOOLS repo (`<change>--tools`) is provisioned once, on the first
  build, through the existing provisioner (`POST /changes/:id/tools/workspace`);
  each tool lives in `tools/<capability>/` on its own branch
  (`tools/<capability>`), and the builder gets a short-lived, repo-scoped token
  for the build. One writer per tool path comes from the normal claim rules:
  the runtime refuses changed paths outside the claim's write intent, and the
  board refuses a `tool.built` whose paths are. Live, the agent's executor
  writes the tool (`executorToolAuthor`, told the contract below and, on a
  rebuild, the failing gate output); offline, a deterministic template author
  does (labelled in the run; the noop executor cannot write a tool). The live
  executor only makes anchored search/replace edits and cannot create a file,
  so on a tool's first build the RUNTIME writes a skeleton as the first commit
  of its branch (`toolSkeleton`: run.mjs and test.mjs with the CLI, the scope
  handling, the output format, and the test harness in place, and
  `// FILL-BEGIN <name>` / `// FILL-END <name>` regions whose unfilled code
  throws); the executor completes the regions with anchored edits and deletes
  the markers. The gate's `filled` check refuses any tool that still carries
  the `SWITCHYARD-TOOL-SKELETON` line or a FILL marker, so an unfilled or
  half-filled skeleton can never be published. On a live run the skeleton is
  filled region by region (`regionToolAuthor`): the runtime writes the
  skeleton afresh for every build, one schema-constrained call returns the
  code for each named region (the prompt lists every region with the exact
  function signature it must keep and a short example of a correct fill for
  that kind of tool), and the runtime splices each fill between its own
  markers, refusing an unknown region, a region filled twice, missing,
  duplicated, or out-of-order markers, or code that carries a marker. That
  call runs on the strongest configured model first (the last entry of
  `AI_GATEWAY_ESCALATION_MODELS`, down to `AI_GATEWAY_MODEL`), falling back
  down the ladder only on a transport error, never because the reply was
  wrong; a rebuild shows it its previous files and the failing checks. The
  executor-backed author (anchored search/replace against the skeleton) stays
  the fallback when no gateway is configured.
- **Codemods are decision logic on the runtime's edit helpers.** Model-written
  whole-file string surgery broke files (live runs: its own tests failing and
  `Expected '}', got '<eof>'` in the files it rewrote), so a codemod's
  skeleton ships `tools/<capability>/lib/edit.mjs` (the runtime's
  dependency-free helpers, `packages/verification/src/tool-lib/edit.mjs`) and
  its regions hold DECISIONS only: `plan(path, text, edit)` returns edits built
  with the helpers (`insertAtStart(target, statement)`, `wrapBody(target,
  before, after)`, `addImport({from, names, default?})`, `replaceOnce(find,
  replacement)`; `functions(text)` lists a file's functions, with their
  export, kind, and parameter names, for deciding; `relativeImport` gives a
  specifier), and the skeleton applies them with `applyEdits`, never the
  model's code. Every edit is re-parsed (Node's TypeScript-stripping parser,
  plus a token-aware bracket check) and skipped with a finding (on stderr)
  when its result would not parse; a file that does not parse is left alone;
  `replaceOnce` refuses a snippet that matches more than once; every primitive
  is idempotent. The second region, `expectChange(path, before, after)`,
  asserts what one changed file must contain; the skeleton's test runs the
  codemod on a COPY of the original code (the gate hands its tests a private
  copy in `SWITCHYARD_TOOL_BASELINE`) and asserts that it changes a file, that
  every changed file parses, and that a second run changes nothing. The
  fill prompt carries the helper API and a worked example (a guard call first
  in every exported handler, plus its import). The tool gate's checks are
  unchanged. `make tool-smoke` (opt-in, live, never in `make check`) builds
  the service-api codemod with the live filler and runs its own gate
  `ATTEMPTS` times (default 3; `ARGS="--rebuilds 1"` adds a rebuild with the
  failing evidence), printing PASS/FAIL per build and the pass rate, with no
  board, Worker, or Cloudflare resource. An `edit` on a tool item goes to
  the build flow, never to the agent's own repo, and `use_tool` or
  `propose_done` on a tool item is refused (`TOOL_ITEM`). App code edits keep
  the anchored search/replace path unchanged. The live author is also given
  the exact contract below, a WORKING skeleton of the same
  kind (the template's run.mjs and test.mjs) to adapt, the goal, up to three
  bounded project files the tool acts on (framed as untrusted data), and, on a
  rebuild, the failing checks of the previous build: a failed `tool.gated` is
  addressed to the builder and broadcast, its evidence is fed to the next
  `build_tool`, and agents waiting for that tool stop waiting and edit by hand.
  A builder whose builds fail the tool's own gate `maxFixAttempts` times loses
  the tool item: the engine reopens it (`item.reopened` without a revision
  number) for another agent, who builds from the tool's branch with the
  failing checks; the builder who spent it may not claim it again, and after
  two reopenings the item stays with its last builder.
- **Tool timing.** Tools are published early enough to be used: in lockstep
  the builders of unpublished tools take the first turns of each round; in the
  concurrent (live) schedule an owner whose only work is unpushed items a
  codemod still being built covers is held back (no turns; `toolHold`, a pure
  function of the board) for at most `toolHoldMs` (default 90 s), so the
  builder moves first; a failed tool gate is rebuilt at once by its builder
  with the failing checks and output, within the board's fix budget for the
  tool item, in any schedule; an
  owner holding an item a codemod being built covers reads its files first (at
  most two turns), and the runtime gives a worker that waits while holding
  such unpushed work another turn, at most twice (`MAX_HELD_WAIT_CUES`), so a
  tool that never arrives (or a build failure no board message reports) never
  stalls held work. The summary measures it from the log
  (`codemodTiming`): `tool timing: codemod X changed N item(s) before any hand
  edit of them (...); covered items edited by hand first: ...`.
- **Never wait forever for a tool.** Each claim in an agent's digest carries
  `toolUnavailable`: the scanners and codemods covering its write intent that
  it must not wait for, because the lead rejected them, a build failed its own
  gate, or they were not published within 60 board messages of their proposal
  (`toolUnavailableReason`, a pure function of the board). Agents never wait
  for a tool in any case; this flag tells a claim which tools not to count
  on, and a change in that set wakes the agent for a turn.
- **The tool contract.** Entry point `tools/<capability>/run.mjs` (a Node ES
  module), run as `node tools/<capability>/run.mjs [paths...]` with the target
  tree as its working directory (no paths: the whole tree); its own tests are
  `tools/<capability>/test*.mjs`, run with `node --test`. Scanners and checks
  print findings as JSON lines `{"path", "line"?, "message"}`.
- **The tool's own gate (before `tool.published`).** After `tool.built`, the
  operator's bench fetches exactly the built commit, removes `.git` before any
  tool code runs there, and checks, on a copy of the ORIGINAL code
  (`packages/verification/src/tool-gate.ts`):
  - every kind: only its own directory, an entry point, at least one test
    file, and its tests pass (they run with `SWITCHYARD_TOOL_BASELINE` naming
    a private copy of the original code, never the gate's baseline itself);
  - scanner: exit 0 with bounded output, every stdout line a well-formed
    finding naming an existing file, at least ONE finding (a scanner that
    finds nothing proves nothing), and no file changed;
  - codemod: exit 0, a non-empty change to at least one existing baseline file,
    every change inside its declared inputs, nothing deleted, and every changed
    JavaScript/TypeScript file still parses (Node's own TypeScript parser,
    which executes nothing; JSON with JSON.parse; other file types are reported
    as not checked); when the run declares the project's own check command
    (`toolSyntaxCommand`) it runs on the changed tree too;
  - check: it must FAIL on the original code with at least one finding (a
    crash names no violation and does not count), and change nothing; it is
    published with `joinsGate: false`: joining the Change's gate (the check
    rule: fails on the original code, then runs on every revision) is not
    implemented in this slice;
  - harness, repro, index: exit 0 without changing any existing baseline file.
  The result is recorded through `POST /changes/:id/tools/gate`
  (`tool.gated`, with each check and a bounded, credential-scrubbed failing
  output). A pass derives `tool.published` (the capability's next version, the
  commit, the repo, the usage, `verified: true`) and completes the tool item;
  a fail publishes nothing and is addressed to the builder, who may rebuild
  (bounded). Wall-clock times are never recorded, so offline logs repeat.
- **Use.** `use_tool {capability, version, args, itemId?}` pins a published
  version. A codemod run for an item gets only arguments inside that item's
  write intent (none left: the item's own files). The runtime (the operator side, like the integrator) checks the
  version is in the registry, fetches exactly its commit, and runs it over a
  COPY of the consumer's own view (the shared baseline or the revision it
  rebased onto, with its own pushed files on top). A codemod needs an item the
  consumer holds: its changes are kept only when every one lies inside that
  item's write intent (otherwise the whole run is discarded, refused as
  `OUTSIDE_INTENT`), it may not delete files, and the kept changes are
  committed in the consumer's own repo and announced as a normal push, so they
  flow through integration and the gate like any edit. Any other tool changes
  nothing (whatever it wrote in its copy is discarded). Only then does the
  engine record the use through `POST /changes/:id/tools/used`: `tool.used
  {capability, version, by, item?, commit?, changedFiles, findings?, exit?}`.
  Agents cannot post `tool.used`. Each use is drawn as a `consumed-tool` edge
  from the tool to the agent, backed by those `tool.used` seqs.
- **Tools generate work.** A `tool.used` with findings is addressed to the
  tool's builder. Findings in files no outstanding item covers (an open item's
  scope, a claimed item's write intent, an undecided proposal's scope) become
  an `item.proposed` from the builder citing `fromTool {capability, version}`
  (only the builder may cite it), drawn as a `trigger` edge from the tool to
  the item. It still needs the lead's acceptance, and completes like any item.
- **Where tools run.** The bench keeps everything it runs tools in (tool
  checkouts, the baseline copy, each run's scratch) in its own fresh private
  temp root (0700), outside the run's work root, never beside the agents'
  worktrees, and removes it at the end of the run. This raises the bar but is
  not a boundary (same user, same filesystem), so two more rules hold:
  every gate runs on a baseline COPY whose content manifest is checked first
  (a tool that wrote into it makes the next gate fail with `baseline-integrity`,
  never trusted), and an agent never pushes what it did not write: before each
  edit or tool use it resets and cleans anything uncommitted in its worktree
  (logged in its evidence: "discarded N uncommitted change(s) ... never
  pushed"), and it stages only the paths Git's status lists, all inside its
  write intent (never `git add -A`; anything outside refuses the whole edit).
- **Isolation.** Tool tests and runs get the gate's isolation: the allowlisted
  environment (never a credential), a private HOME and temp dir, a timeout
  (default 60 s per run, 120 s for its tests; `toolTimeoutMs`) and bounded
  output, after which the whole process group is killed, and a private scratch
  root (a write to `../x` lands there and is removed). The same-user residual
  risk applies: a tool can read files the OS user can read by absolute path,
  and a child that leaves its process group with `setsid` survives the kill.
  With `--integrator cloud`, tool gates and tool runs still run in the driver
  process in this slice (not in the gate container): the container job is the
  integration job only, and running tool jobs there needs a tool-job shape, its
  own Workflow step, and egress phases, a later slice.
- **The console.** The TOOLS tab lists the registry from the board: capability,
  version (and commit), kind, builder, the tool gate's evidence (each check,
  with its `tool.gated` seq), and who used it how often. A tool node is backed
  by its `tool.proposed`, `tool.gated`, and `tool.published` seqs; the tool
  item is an ordinary item hull backed by `tool.proposed`.
- **Offline demo.** `make demo-board` shows it twice: on the demo project, a
  scanner and a codemod are proposed, accepted, built, gated, published, and
  used by two agents each (the codemod on three items before any hand edit);
  on the multi-resource example app, the scanner also
  finds places the plan did not itemize (the shared modules) on its first sweep
  over the whole repository right after it is published, its builder
  proposes that work, the lead accepts it, and it completes.

## Splits, sub-leads, and fork-based help

Formation beyond claiming: an owner divides its work (a split, it becomes the
SUB-LEAD) or brings in a helper that starts from its in-progress repo (a fork).
Both stay on the board's single-writer rules (rules 11 and 12 above) and the
gate stays authoritative: nothing reaches the integrated tree except through
an announced push the integrator gates.

- **Split.** The owner posts `item.split`; children are open at once (inside
  its scope and write intent, so no lead decision). Other agents claim them.
  Children push to their own repos as usual, but the integrators do not merge
  those pushes (`pendingPushItems` routes them to the sub-lead;
  `awaitingSubLead` lists them). The sub-lead's `pull` is a mini-integration
  in its own repo: it copies each child's pushed files inside that child's
  write intent and announces ONE push for the split item (`merges`). No gate
  runs in the sub-lead's repo in this slice; the main integration gates the
  sub-lead's push on the integrated tree like any other (gate-equals-deploy is
  unchanged). The split item completes when its children are done and that
  push passed. A failure of the sub-lead's push is narrowed to the children
  (`narrowToSplitChildren`) so their owners are asked to fix; the sub-lead then
  merges their new pushes.
- **Fork-based help.** `help.requested {scope}` grants files of the requester's
  write intent. A helper (an idle agent, or one recruited because the grant
  counts as open work) asks the operator to fork the requester's repo
  (`POST /changes/:id/board/help-fork`; the Artifacts fork live, a copy of the
  local repo offline), so it starts from the requester's latest push, then
  offers with its lineage (`help.offered {forkOf, forkCommit, fork}`). It
  edits only the granted files in its fork, with the fork's short-lived write
  token, and posts `help.delivered {commit, paths}`. The requester pulls: the
  operator reads the fork with a short read token (revoked right after), the
  runtime checks the commit changes nothing outside the grant since the fork
  point, merges it into the requester's repo, and the requester announces the
  push with `pulled`, which closes the grant. Forks are archived at cleanup.
- **The console.** A split item's children are hulls nested inside its hull
  (the parent grows to hold them), with the sub-lead drawn on the parent
  hull's border. Fork lineage is a `dependency` edge from the requester to the
  helper labelled `fork`, backed by the `help.offered` seq; each child a
  sub-lead merged is a `dependency` edge from the child to the split item
  labelled `merged`, backed by the sub-lead's push. No new edge kind: the
  backing check verifies both labels against their messages.
- **Offline demo, cues.** On the demo project the owner of the tests item,
  after its claims were refused and a contract rejected, reports it
  struggling; both idle agents volunteer; it grants the new test file to the
  first (fresh eyes), which forks its repo, delivers, and is pulled, and it
  declines the second. The policy's deterministic versions of the cues: an
  idle agent volunteers once per item; an owner hands a volunteer the second
  half of several files (a struggling single file whole) or declines; a
  struggling owner with idle agents waits one turn for a volunteer.
- **Offline demo.** `make demo-board`: on the demo project the owner whose
  codemod pushed two files grants one to a helper, which forks its repo at
  that push, delivers, and the owner pulls it (a fast-forward) before
  proposing done; on the multi-resource app the item the scanner found (two
  shared modules) is split by its owner, two other agents claim the children,
  and the sub-lead merges their pushes. The summary prints each under
  `formation:` and the forks archived at cleanup. Both runs are
  deterministic.

## Integration on Cloudflare (`--integrator cloud`)

With the cloud integrator the driver does not integrate. The Worker does, on
Cloudflare primitives, through the same board path and with the same
integrator code. It gates one revision at a time: speculative batch gating is
a local-integrator feature, and a cloud run with `--speculate` above 1 is
refused at startup (see "Speculative batch gating"):

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
  Change, the base commit, the pinned commits, every gate-defining field (the
  integration repo and branch, the gate command, whether a gate is required,
  the protected paths and JSON keys, the baseline inventory, the accepted
  contracts, the gate support files, the timeouts, the identity), and the
  configuration's time as a run nonce (`integrationJobKey`): every later step
  is named by it, a Workflow retry never integrates anything else, and a
  re-created Change never replays a prior run's outcome (it also clears the
  GateRunner's bounded outcome cache).
- **Run.** The run step mints short-lived Artifact tokens Worker-side (a READ
  token per agent repo, a WRITE token for the integration repo, TTL just over
  the job's deadline; a configuration whose deadline would exceed the one-hour
  token lifetime minus a 2-minute margin is refused when posted), runs the job in the GateRunner's container, and revokes
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
- **Advance.** After a recorded GATED pass (never an ungated one), keyed by
  the integration repo, the base, the commit, and the revision
  (`advanceJobKey`), a second, git-only job fast-forwards the
  integration branch to the gated commit and prunes the candidate refs
  (`advanceIntegrationBranch`), so promotion clones a branch whose head is the
  gated tree. A branch another writer moved meanwhile is a named refusal in
  the job result (`refused: {reason: "trunk-moved", expected, actual}`), not a
  generic error, and nothing is pushed.
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

## Repos and promotion safety

- **Bounded repo names.** Every Artifact repo name (`<change>--<unit>`,
  `<change>--board-<agent>`, `<change>--help-<request>`, `<change>--tools`,
  `<change>--integration`) goes through `boundedRepoName`
  (`@switchyard-change/change-core/repo-name`): a name within the 63-character
  Artifacts limit is unchanged; a longer one keeps a readable prefix and ends
  with `-<8 hex>`, a hash of the full name, so two long names that share a
  prefix never collide. Deterministic, the same on every substrate.
- **Readiness.** The Artifacts provider returns a created, imported, or forked
  repo only once it is usable: it polls `get(name).info()` with a small
  backoff (30 s cap) while the binding reports `CREATE_IN_PROGRESS`,
  `IMPORT_IN_PROGRESS`, `FORK_IN_PROGRESS`, or a brief `NOT_FOUND`, so no
  token is issued for a repo an agent cannot clone yet. A timeout is a
  `RepoNotReadyError` naming the repo. A binding that never reports
  in-progress is not delayed.
- **Fork read-back.** A fork reports the head it really has
  (`realizedBase`, read from the fork's log), the head it was expected to
  start from (`expectedBase`: the caller's, or the source head read just
  before the fork), and `baseMismatch` when both are known and differ. Absent
  when the backend cannot say: never assumed equal to the source.
- **Compare-and-swap promotion.** The integrator records the integration
  branch value at clone time. The branch push checks locally that the gated
  commit descends from it (`merge-base --is-ancestor`), then pushes with an
  explicit lease on that value (`--force-with-lease=refs/heads/<b>:<sha>`), so
  the server rejects the push if the branch moved. A lost race throws
  `PromotionRefusedError` (`reason: "trunk-moved"`, with expected and actual;
  `"not-descendant"` for a sideways move), never retried; the pushed commit
  is always the gated one. `advanceIntegrationBranch` does the same, leasing
  the caller's `expectedBase` or the value it read.
- **Clash prediction** (`predictClashes`, verification): for each pair of
  agent heads over a base, clean (`disjoint` changed files, or a clean
  `git merge-tree --write-tree`), conflict (the paths; scoped `shared` when
  `isSharedPath` calls one shared, else `local`), or unknown (error, timeout,
  pair limit). Read-only on the repo (merged trees go to a scratch object
  store); `unavailable`, never clean, on a git older than 2.38. Advisory
  input only: the gate on the integrated tree stays authoritative.

Posture: the integration routes sit behind the same `SWITCHYARD_API_TOKEN`
bearer as every other mutating route. The Worker is fail-closed: with the
token unset, mutating routes are refused unless
`SWITCHYARD_ALLOW_UNAUTHENTICATED=1` opts in (the local dev targets pass it to
`wrangler dev`); with that opt-in on localhost anyone who can reach the Worker
can create a Change and configure its integration before its goal. Set the
token before exposing the Worker on a LAN (`make dev-all-lan`) or deploying
it.

Glob note: `**` matches whole path segments in both matchers (the path scope
and intent overlap): `src/**/x` matches `src/x`, `src/a/x`, and `src/a/b/x`,
never `srcx` or `src/ax`; a leading `**/x` matches `x` at any depth. An intent
entry whose `**` shares a segment with other characters is refused.

## Stalls, re-plans, clashes, proofs, and caps

Long runs on a large app (ten or more items, a hundred or more acceptance
tests) stall in recognizable ways: agents sit on claims, wait silently on each
other, spend fix budgets and stop, and the plan's split does not match where
the failures are. The board and the driver handle each one mechanically, from
recorded state only.

### Claim leases (`claimLeaseMessages`, `claimDeadlineMessages`)

- A claim on an item carries a LEASE, measured in board messages (so the same
  log always derives the same lapses). It is renewed ONLY by real progress on
  that item: a push announced for it, a message of its holder's that names it
  (`item.struggling`, `help.requested`, `help.closed`, `help.declined`, a
  contract proposed for it, `done.proposed`, `review.requested`, a contest
  turn on it, a handoff, which starts a fresh lease for the new holder), its
  push being GATED by an integrated revision, its tool build or tool gate, a
  decision on a contract for it, or a delivery by a granted helper. Messages
  about other items never renew it.
- With no progress for the lease, arbitration appends `claim.lapsed {reason:
  no-progress, lastProgressSeq, commit?}` addressed to the holder: the item is
  open again (`commit` is the holder's latest push, the next owner may start
  from it; the runtime seeds it on the first edit, as for a reopened item).
  The lapsed holder cannot claim it back for one lease period: another agent
  gets it first. A lapse counts as a stall release (`stallReleases`).
- A lease never lapses while it is SUSPENDED (`leaseSuspension`): the holder's
  push waits for the gate (a lapse would drop a push integration is about to
  gate), its tool build waits for its own gate, its push already passed (only
  the done proposal is left), a contract for the item waits for a decision, a
  helper holds a taken grant on it, or a contest on it is open (a contest
  settles its own way). A held item waiting on a seam change does not lapse
  for no progress either.
- The firm DEADLINE (`claimDeadlineMessages` from the grant) is not renewed by
  progress: the lead sees claims in their last quarter (`digest.deadlines`,
  with whether the holder is progressing) and extends one (`claim.extended`
  with a reason, at most twice, each a full period), or the claim lapses
  (`reason: deadline`). The offline lead extends a progressing claim and lets
  a stalled one lapse. Defaults keep normal work far from it.
- A QUIET board advances no message count, so the driver acts there: a leased,
  unsuspended claim with no stated wait reason whose holder sat the quiet
  period out is recorded stalled (the engine-record route, `claim.lapsed
  {reason: stalled}`), at most `stallReleasesBeforeReplan` (2) times per item.
- Seam items are leased like any item (an absent owner never blocks the
  seam's importers forever); tool items too (builds and tool gates renew them);
  a split item is not (its children are). Defaults (`scaledBudgets`): a lease
  of max(150, 40 per agent of the dial's max) board messages and a deadline of
  8 leases; `--lease-messages` and `--deadline-messages` override them.

### Every waiting item states why (`itemWaitReason`)

A pure function of the board names why an item is not moving:
`waiting-on-seam` (the seam item), `held-by-claim-cap` (every worker that may
take it is at its cap), `lease-lapsed` (whose claim, why), `waiting-for-human`
(a protected contract, or an escalated contest), `waiting-for-lead` (a seam
contract, or a worker's proposal), `blocked-by` (a contest's owner item, a
split's unfinished child, a sub-lead), `waiting-for-gate` (the pending push's
commit: the revision has no number yet, so none is invented),
`fix-budget-exhausted` (by whom), or `unclaimed`. A moving item has none.
Each agent's digest carries it on its claims and the open items (`wait`, with
one short line), and the console shows the line on every card. On a quiet
board the driver acts on the stated reason, one step per quiet period: a seam
hold that stopped moving is recorded stalled; an open seam item, or an
`unclaimed` or `lease-lapsed` item, is offered to the free workers (bounded);
a claim with no stated reason is recorded stalled (above). Waiting for a
human, the lead, the gate, or another item is left alone.

### Re-plan instead of giving up (`item.replanned`, `item.escalated`)

When an item spends its fix budget (it is reopened with `exhaustedBy`), is
released for not moving twice, or reaches its per-item model-call cap (a
recorded `run.capped {kind: item-calls, item}`; reason `item-cap`, open or
still held, since no agent can make another call on it), the lead gets one
bounded re-plan turn on it
(`digest.replan`, with the failing files and test lines of its latest failing
revision `rev`), once per situation (a new exhaustion or stall gives one more).
It may `split` it (two or more children), `rescope` it (one replacement with a
new objective or files, for example the files the failure names), or `merge`
it with an open neighbour `with` (one replacement covering both).
`item.replanned` makes the item (and a merged neighbour) a split item carried by
the replacement children (`replanOf`), which integrate directly and complete
it. An item is re-planned at most once, and a replacement never is: when a
replacement spends its budget or stalls twice, arbitration records
`item.escalated` and the Change raises a human escalation (it closes when the
item completes). The driver does not end the phase on spent fix budgets while
the lead has not had its re-plan turn. The offline lead re-scopes an item to
failing files no outstanding item covers, splits a multi-file item by its
failing file, and otherwise lets fresh eyes go first (merging a single-file
item with a neighbour in its directory, or re-scoping it to the failing tests,
once fresh eyes spent the budget too). An agent that lost an item (reopened,
lapsed, re-planned) keeps that work in its repo, so integration YIELDS the
files it pushed for it (never applied from its repo).

### Overlap check at claim time (`claimOverlap`)

A claim granted on an item whose planner-declared scope overlaps the scope of
an item another agent holds is recorded (`claim.overlap`, addressed to both,
advisory): both digests list it (`claims[].overlaps`, with a hint to
coordinate in a thread; the item claimed later rebases on the other's push),
open items say which held items they overlap (`overlapsClaimed`), and the
offline policy and the lead's prompt prefer items without any. A claim WRITING
a shared seam another holder's item scope covers is refused (`SEAM_OVERLAP`),
pointing at the question to that holder or the seam contract route.

### Clash alerts from real code (`clash.predicted`)

Before each revision, when two or more agents have pending pushes, the local
continuous integrator runs `predictClashes` (git merge-tree, read-only) over
the integration branch head (the current integrated commit, else the
baseline) on each pair of pinned heads, fetched with operator read tokens as
for integration, with the board's seams as the shared paths. A conflict is
recorded only on paths at least one side's integration unit applies and both
heads changed from the goal's baseline (by blob: a head that merely lacks what
another revision integrated is stale, not a clash, and a file an agent's repo
does not hold was never touched by it), scoped `shared` (a seam) or `local`; an
undecided pair is `unknown` and a prediction that could not run is
`unavailable`, both with the reason, never clean; a clean pair is not
recorded; one record per pair of commits. Digest cues: a shared conflict goes
through the seam contract; a local one is rebased by the item claimed later.
It never blocks or orders integration. The console tags the card and threads
the message. (The cloud integrator does not predict in this slice.)

### Trunk-moved and stale checks

- `goal.posted.baseline` records the integration branch's head before any
  revision, and each `integrated.rev` names the `base` it was built on. A
  revision whose base is not the board's integrated head (the latest passing
  revision's commit, else the baseline) is refused (`STALE_BASE`): a stale
  integration never becomes current; the integrator treats the refusal as
  stale and rebuilds. A revision without a base (a board before the field,
  or the cloud Workflow) is still recorded.
- After a recorded pass, the branch advance leases the value it reads (never
  the board's integrated commit, which the branch only reaches after it). A
  `PromotionRefusedError` with reason `trunk-moved` is a distinct outcome:
  `trunk.moved {rev, commit, expected, actual}` on the board and on the
  revision (`trunkMoved`); nothing was pushed.
- A help fork whose read-back head is not the head it was expected to start
  from (`baseMismatch` in the fork response) is recorded on `help.offered`
  (`baseMismatch {expected, realized}`), which then takes no grant
  (`forkMismatches` on the request, shown to the requester).

### Token refresh for runs over one token lifetime

Agents push with repo-scoped write tokens that expire. Before one expires
(expiry minus a margin, max(60 s, a fifth of the lifetime), on an injected
clock), the driver mints a fresh token for the same agent and repo (the
agent-token route; a helper's fork with `help`), swaps it into every later git
call, records `token.refreshed {agent, kind}` (never the token), and revokes
the old one only after a grace period (60 s by default) so a git call in
flight is not cut off; the margin is clamped to at most half the token
lifetime. So
`--timeout-ms` may exceed `--token-ttl`; `--no-token-refresh` restores the
refusal. Board agent tokens (`x-board-agent-token`) carry no expiry and are not
rotated. The cloud integration repo's token is not refreshed in this slice:
with `--integrator cloud` the phase may not outlast it.

### Proof bundle per verified revision (`buildProofBundle`)

A pure function of the board log builds the PROOF of the last revision (the
only one ever promoted): the gated commit and the promoted one (the run now
records `revision.promoted {rev, gatedCommit, commit, branch}` once it
committed; the board refuses a gated commit that is not the latest passing
revision's), the gate command and verdict, the test inventory (baseline
count, the final revision's acceptance and developer counts, executed at least
the baseline), per-suite progress across revisions, the items, agents, and
pushes merged, contracts and their decisions, tools, the typed (Jev)
decisions (advisory, with their outcomes, never part of the proof), human
decisions, and the lapses, re-plans, escalations, clash predictions, trunk
moves, token refreshes, and caps. It is PROVEN only when the last revision
passed a gate that ran and the recorded promotion's gated commit is that
revision's commit (and, when both are known, it executed at least the
baseline's tests); otherwise NOT-PROVEN with each reason. With speculative
batch gating it also lists the candidates of the round that landed the final
revision and the landed one (whose commit must be the revision's and the
promoted gated commit, else NOT-PROVEN). The CLI prints a
summary and writes the JSON to `--proof-out`, or `proof-bundle.json` in a kept
work root (a live run's, or `--keep-work-root`); the console's PROOF tab
renders it from the log alone, so a recorded run shows it too.

### Cost and time caps (demo safety)

The driver meters the model calls it routes through the meter: agent turns,
executor edits (every paid attempt: a transient retry counts, and an edit that
fails, for example on an unusable reply, counts the calls it made, at least
one), the planner, a separate tool author (`meteredToolAuthor`, the live
region-filling author; the default author goes through the metered executor),
and the run's typed decisions (`meteredJev`: attribution, speculative
candidates' included, contract triage, and the fix-confidence check; past a
run cap a decision call is refused and recorded as a decision error, the
mechanical result stands). The planner's own plan-review decision (asked
inside the seed, before the meter exists) is not metered. Spend is estimated as tokens times the configured price per model
(`--price <model>=<in>/<out>` USD per million tokens; `parsePrice` accepts
only finite, non-negative amounts and one price per model) when usage is
reported, else the executor's own estimate; a call with neither is counted
UNPRICED, never free, and non-finite usage or prices are never added. A spend
cap does not bound unpriced calls: under an active `--max-spend-usd` each
unpriced model is recorded as a meter warning and the summary says the cap
does not bound them. The CLI refuses `--max-spend-usd` unless every model the
run calls has a `--price` (`validateSpendCap` over the agent turn model, the
executor's base and escalation models, the planner's, the tool filler's, and
the decision model's). The planner call and the decision calls report no
token usage, so even priced they are counted unpriced and show as meter
warnings: the cap cannot bound them. Caps: `--max-calls` (default 10 per run turn), `--max-spend-usd`
(none unless set), `--max-wall-ms` (default twice the agent-phase timeout),
and `--max-item-calls` (default 8 per item turn, across agents). Reaching a
run cap records `run.capped {kind, limit, used}` once, stops new turns (the
metered transport answers `wait` without calling the model), ends the agent
phase as `capped`, lets the integrator finish what is in flight, and the
verdict stays the gate's; a reached cap also stops new speculative candidates
(each round then gates its first candidate only). An item at its cap gets no more model calls
(`ITEM_CAP`, recorded once per item): a worker whose held items are all at
their cap, with nothing else to act on, skips its turn without calling the
model, and the agent whose own call took an item to its cap releases it
through the item-budget path (a handoff to a running worker, else a help
request; the agent then stops, as for a spent per-item turn budget). Another
holder of a capped item only skips it. A capped item is eligible for the
lead's re-plan (reason `item-cap`, open or still held): its replacement
children are new items with their own call counts. A replacement that reaches
its own cap is not escalated to a human by that alone (escalation still
follows a spent fix budget or two stalls). The budgets line prints the caps;
the summary prints the usage and every meter warning.

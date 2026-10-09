# The Change board

The board is the coordination substrate for agents that form around a goal: a
single ordered, durable log of typed messages per Change. A goal is posted,
agents join, claim items with a declared intent, contest overlapping claims,
split items, ask for help, propose contracts and tools, announce pushes, and
propose completion. The engine arbitrates mechanically; only the gate decides
what ships.

Status: foundation only. The board model, its persistence in the Worker, and
the offline parity routes exist and are tested. `run-live` does not drive agents
through the board yet, so existing runs are unchanged.

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
- **The engine** never posts through a participant route. Its messages are
  derived by arbitration, or (for `integrated.rev`) produced from an integration
  result recorded through `POST /changes/:id/integration/revision` (bearer):
  `{commit, gate: "pass" | "fail", merged: [push commits]}`. The board numbers
  the revision and derives its paths and contributors from the announced pushes
  it merged, so the board can only report what the integrator recorded.

## Routes

| Route | Auth | Effect |
|---|---|---|
| `POST /changes/:id/board/join` | bearer | `{agent, role?, rationale?}` appends `agent.joined`; `201 {appended, token}`. |
| `POST /changes/:id/board` | agent token | `{type, payload, rationale?, inReplyTo?, to?}` appended as that agent; `201 {appended, escalations}`. |
| `POST /changes/:id/board/human` | bearer | A human message. |
| `POST /changes/:id/integration/revision` | bearer | An integration result; appends `integrated.rev`. |
| `GET /changes/:id/board?after=<seq>&limit=<n>` | open | One page (default 500, at most 1000) of messages after `seq`, `hasMore`, and the reduced state. |
| `GET /changes/:id/board?for=<agent>&after=<seq>` | that agent's token | The agent's digest: its claims, pending claims, open contests it is in, open items, the latest passing revision, its rebase target, and the messages since `seq` addressed to it or touching its work. |
| `GET /changes/:id/board/verify` | open | Re-verifies that the stored log reduces to exactly the stored state (`409` if not). |
| `GET /changes/:id` | open | The snapshot carries only `board`, a count summary. |

Every append writes the messages, the board state and seq, the token map, and
the escalation records in one transaction: a rejected message, or a failed
write, leaves all of them untouched. Rejections carry a machine-readable code:
`{code, error}` with codes such as `BAD_PAYLOAD`, `AUTH`, `NOT_ALLOWED`,
`NO_GOAL`, `UNKNOWN_AGENT`, `UNKNOWN_REF`, `DUPLICATE`, `ITEM_NOT_OPEN`,
`NOT_OWNER`, `CONTEST_OPEN`, `CONTEST_CLOSED`, `INTENT_OVERLAP`,
`OUTSIDE_INTENT`, `NOT_WITHIN`, `INVALID_STATE`, `LIMIT`. `AUTH` is 401,
`LIMIT` is 409 (413 for an oversized body), the rest are 400.

## Envelope

Every message is `{seq, at, from, type, payload, rationale?, inReplyTo?, to?}`.
`to` addresses other joined agents (questions, help, contract replies); the
digest surfaces addressed messages to their recipients. Free text belongs in
`rationale`; payload strings are ids, repo-relative paths or globs, or short
bounded fields that define an item.

## Vocabulary

`goal.posted {objective, rules}`, `item.proposed`, `item.claimed {item, intent:
{read, write}}`, `claim.granted`, `claim.contested`, `claim.ceded`,
`claim.kept`, `claim.narrowed {contest, write}`, `claim.resolved`,
`claim.escalated {..., reason: turns | idle}`, `item.split {item, children}`,
`item.discovered`, `help.requested`, `help.offered`, `contract.proposed`,
`contract.accepted`, `contract.rejected`, `push.announced {item, commit,
paths}`, `integrated.rev {n, commit, gate, merged, paths, contributors}`,
`rebase.needed`, `review.requested`, `review.result`, `handoff`,
`done.proposed`, `item.completed`, `tool.proposed`, `tool.published`,
`tool.used`, `agent.joined`, `agent.left`.

Intent entries are repo-relative paths, globs (`**`, `*`, `?`), or
`path#symbol`. A trailing `/` names a directory (`src/` is `src/**`). Symbol-level
intent is accepted, but for overlap it is treated as its file, so two symbols in
one file contest.

## Arbitration rules

`goal.posted` records the rules the board runs under (`maxContestTurns`,
default 3; `contestIdleMessages`, default 25), so a log is self-describing.

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
7. Pushes must stay inside the owner's write intent.
8. Completion is derived, never posted: an item completes when its owner has
   proposed done AND a passing integrated revision merged the owner's latest
   push (whichever happens second triggers it), citing that passing revision.
   Completing the last child of a split item completes the parent.
9. A passing `integrated.rev` sends `rebase.needed` to each active agent, other
   than the contributors, whose live read or write intent intersects the changed
   paths. A failing one advances nothing.
10. Tools: `tool.published` requires the publisher's prior `tool.proposed` for
    that tool and capability, `verified: true` (the tool passed its own gate),
    and a new capability version. `tool.used` must name a published capability
    and version.

## Limits

Per board: 20000 messages, 1000 items, 100 agents, 200 published tool
versions. Per message: 32 children per split, 64 entries per intent (each at
most 512 characters), 256 paths per push, bounded objective, acceptance, and
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

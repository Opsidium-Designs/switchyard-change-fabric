# Failure modes we hit, and what stops them now

The live storefront runs, and the service-api runs before them, failed in ways
a design review would not have predicted. This page lists each failure
we actually saw, what the engine does about it now, where that lives in the
code, and the offline test that shows it working. Every test named here runs
in `make check`.

Each entry is one of three kinds:

- **Prevented**: the failing state can no longer happen.
- **Refused**: the bad action is turned away before it costs a gate run, and
  the agent is told why.
- **Detected**: it can still happen, but it is recorded on the board and shown,
  never passed off as success.

Nothing on this page relies on a model judging correctly. The typed-decision
layer (Jev) stays advisory throughout; every defence below is mechanical.

## Trust in the result

### 1. A green check that did not cover what shipped (prevented)

**Seen:** early service-api runs verified a side overlay while the promoted
branch was built separately, so "verified" did not mean the shipped tree was
fixed.

**Now:** gate-equals-deploy. The integrator gates one exact tree, and promotion
writes that same tree (a compare-and-swap push of the gated commit); a staged
tree that differs from the gated one is refused.

- Code: `packages/git-promotion`, `packages/verification/src/integrator.ts`
- Tests: `gate-equals-promote: the gated tree is the promoted tree`
  (`packages/git-promotion/tests/gate-equals-promote.e2e.test.ts`); `refuses
  (and commits nothing) when the staged tree differs from the gated tree`
  (`gated-commit.test.ts`)

### 2. A gate that passes because the tests never ran (detected)

**Seen:** a broken import can make a test runner exit early, or exit 0 having
run nothing.

**Now:** before any work starts, the gate runs once on the baseline and its
test inventory is posted with the goal. A revision whose run skipped baseline
tests fails, whatever its exit code.

- Code: `recordBaselineInventory` in `packages/verification/src/integrator.ts`, called by `packages/orchestration/src/run-board.ts`
- Test: `records the baseline gate's test inventory with the goal, and fails a
  revision whose run skipped baseline tests` (`run-board.e2e.test.ts`)

### 3. An agent edits the tests to make them pass (prevented)

**Seen:** the cheapest "fix" for a failing assertion is to change the
assertion.

**Now:** two classes of protected files, derived from the gate command itself.
The acceptance gate, its harness, and the configs the gate run uses are
immutable. Developer tests change only through a contract that a human accepts
on the board.

- Code: `deriveProtectedPaths` in `packages/orchestration/src/protected-paths.ts`
- Tests: `two classes: the immutable acceptance gate and contract-changeable
  developer tests` (`protected-paths.test.ts`)

### 4. A promotion the board never recorded is claimed anyway (prevented)

**Seen in review:** a speculative round could land a passing candidate after
the board had already recorded a blamed failure for that round.

**Now:** promotion and redeploy follow only a revision the board recorded. An
unrecorded one is not redeployed, and its proof reads NOT PROVEN.

- Test: `a promotion the board refused to record is never redeployed
  (deploy-skipped) and is not proven` (`run-board.e2e.test.ts`)

## Agents working together

### 5. Two agents write the same file (prevented)

**Now:** an agent claims an item's write paths before editing. An overlapping
claim opens a contest that the two agents resolve (keep, cede, narrow), or that
goes to a human. Each agent pushes only to its own Artifacts repo.

- Test: `an overlapping write intent opens a contest naming the owner and the
  overlap` (`packages/change-core/tests/board.test.ts`)

### 6. An approved test change never reached the agent who needed it (prevented)

**Seen:** in storefront runs before sf21, a human accepted an agent's change to
a stale developer test (tax 72 to 73 cents, rounding to the nearest cent), but
the file stayed outside every agent's edit scope. The run plateaued with the
fix written and unpushable. This was the long-standing storefront blocker.

**Now:** an accepted developer-test contract releases that file to exactly one
item (arbitration revision 7). Its holder may write it alongside the code fix,
and any other agent's write to it is refused. sf21 passed with this fix.

- Code: `releasedTargets` in `packages/change-core/src/board.ts`;
  `releasedWrite` in `packages/orchestration/src/board-agent.ts`
- Tests: `is in the holder's edit scope: the executor may write it with the
  code fix, and one push carries both`; `released to ANOTHER item, it stays
  outside this agent's scope and a write to it is refused`
  (`board-agent.test.ts`)

### 7. Nobody acts, and the run waits forever (detected, then nudged)

**Seen:** a contract left undecided, or a holder waiting on a push that
another agent had to make, could leave the board quiet with work unfinished.

**Now:** a quiet board re-cues the lead about undecided contracts and nudges
holders who owe an action, naming the action (a regressed push, a fix
request). The nudges are bounded and never decide anything themselves.

- Tests: `a lead that always waits takes exactly 1 + MAX_CONTRACT_CUES turns on
  its own; the driver's nudges are bounded per contract set and never decide`
  (`board-agent.test.ts`); `a regressed holder that waits past its fix re-cues
  is nudged by the quiet-board driver with what its push made worse, then
  fixes it` (`run-board-ratchet.e2e.test.ts`)

## Wasted gate runs

### 8. An edit leaves a file unparsable (refused)

**Seen:** a search-and-replace edit that applied cleanly but dropped a closing
brace. The push cost a full integration and gate cycle, and a model misreading
the gate error could push the same thing again.

**Now:** the result of every edit is parsed (Node's own TypeScript parser, with
no type checking) before it is written. An edit that breaks a file that parsed
before is refused, and the parse error goes back to the agent. A file that was
already broken can still be edited toward fixed.

- Code: `packages/model-adapters/src/syntax-check.ts`
- Tests: `WorkersAiExecutor refuses an edit that leaves a file unparsable
  (offline)`; `still edits a file that was already unparsable, so a fix can
  append the missing brace` (`workers-ai.test.ts`)

### 9. An edit adds type errors that fail the whole gate (refused)

**Seen:** a one-line type error in one item's file failed the typecheck step
for every item in the revision.

**Now:** before pushing, `tsc` runs over the baseline plus the agent's changed
files, before and after the edit. Only new errors in the changed files refuse
the push; errors that already existed, and cross-module noise, do not.

- Code: `packages/verification/src/pre-push-typecheck.ts`
- Tests: `refuses an edit that adds an unused local to a changed file, naming
  the TS6133 line`; `does not report an error the changed file already had in
  the baseline (lines shifted)` (`pre-push-typecheck.test.ts`)

## Blame and fix budgets

### 10. A failure blamed on the wrong item (prevented)

**Seen:** a failing test in one module was blamed on whichever item happened to
be merged in the same revision, which then spent its fix budget on code that
was not broken.

**Now:** failures are matched to the items whose tests failed first. Failures
of items outside a revision blame no one. Before the first pass, a
leave-one-out round blames a push only when removing it makes the stack
better; coupled pushes that are only good together are not blamed.

- Code: `packages/orchestration/src/ratchet-integration.ts`,
  `packages/change-core/src/failure-attribution.ts`
- Tests: `p1 improves, p2 regresses, p3 improves: removing p2 alone makes the
  stack better, so p2 is push.regressed and left out`; `coupled seam + consumer
  (each alone would regress the best revision, together they improve it):
  neither is blamed` (`ratchet-integrator.test.ts`)

### 11. A fix budget drained before the owner could act (prevented)

**Seen:** re-gating the same unanswered push charged a fix attempt every
revision, so an item could exhaust its budget without its owner having pushed
anything.

**Now:** a fix is charged once per unanswered push (arbitration revision 7).

- Test: `re-gating the same unanswered push asks once (1 attempt, no
  exhaustion); revision 6 charged every revision`
  (`packages/change-core/tests/board.test.ts`)

## Running out, and stopping

### 12. Out of credits, the run waits out a rate-limit window (prevented)

**Seen:** on 2026-10-11 the OpenAI account behind the AI Gateway ran out of
credits. A 429 that means "no balance" was handled like a short rate limit, so
the run waited instead of ending.

**Now:** a 429 whose body reports an exhausted balance ends the run at once as
`quota-exhausted`, and cleanup still runs. An ordinary 429 pauses every agent
together. Runs can also use the operator's own Claude CLI instead of the
gateway (see `docs/LOCAL-CLI.md`); sf21 passed that way.

- Tests: `a turn refused for no credits ends the run at once quota-exhausted (no
  window wait); cleanup runs` (`run-board-rate-limit.e2e.test.ts`)

### 13. An interrupted run leaves a gate running (prevented)

**Now:** an interrupt aborts the in-flight gate. The abort kills its whole
process group (SIGTERM, then SIGKILL after a grace period), and its temporary
directories are removed before the run exits.

- Code: `packages/verification/src/command.ts`
- Tests: `kills a tree that ignores SIGTERM after the grace period`; `an
  already-aborted signal runs nothing and reports aborted`
  (`packages/verification/tests/command.test.ts`)

### 14. A fixed run ends partial because owners never proposed done (prevented)

**Seen:** in a live 30-agent run on 2026-10-13, revision 8 passed the full
gate (237/237) and was promoted, but the run ended `verified (partial: 6
item(s) not completed ...)` and the CLI exited 1. The pass landed about 80
seconds before the 30-minute agent-phase wall clock (`--timeout-ms`, not set,
so the default), and those 6 owners were still queued for one of the 8
in-flight model slots when the timeout ended the phase. Each item's push had
passed; only the done proposal was missing.

**Now:** when the phase would end (its timeout, quiescence, the round cap)
while owners whose latest push a passing revision merged have not proposed
done, those owners get one close-out cue and a bounded window (2 minutes by
default; every other worker is held back). After the last gated pass, any such
item still open is closed by the engine: a recorded `item.completed` with
`closedBy: engine` that cites the owner's `push.announced` seq. The board
refuses it unless that push was merged by a passing revision, the board's
latest revision passed, and nothing is outstanding on the item (a fix request,
a regression, an exclusion, a pending contract, a contest, a help grant). The
summary names each one (`closed by the engine (push passed in rev N, owner did
not propose done): ...`). An item with no such push stays not completed, and
the result stays partial.

- Code: `engineCloseRefusal` (`packages/change-core/src/board.ts`); the
  close-out window and the engine close (`packages/orchestration/src/run-board.ts`)
- Tests: `an owner that never proposes done gets a close-out cue; the engine
  then closes its item on its recorded push: verified, exit 0`; `an owner that
  answers the close-out cue proposes done itself: no engine close, every item
  done`; `an item no passing revision merged a push of stays not completed: the
  engine closes only the backed item, and the verdict stays partial (exit 1)`;
  `a timeout right after a pass cues the owner who has not proposed done, holds
  the others, and the owner closes its item` (`run-board-close-out.e2e.test.ts`);
  the `engine close` tests (`packages/change-core/tests/board.test.ts`)

### 15. A run ends "quiescent" while a human decision is pending (prevented)

**Seen:** in a live 30-agent run on 2026-10-13, the agent phase ended
`quiescent` ("every agent was idle, nothing was integrating or pending, and no
board message arrived for 120 s") while two protected contract changes
(`contract.escalated`, pending escalations on the Worker) were still
unanswered. The run failed only because the human had not clicked yet.

**Now:** a quiet board that waits on a person is not ended quiescent. While a
protected contract escalated to a human is undecided, or a contest is
escalated to a human, the run keeps waiting until those decisions are made or
the agent phase's time limit (`--timeout-ms`). While it waits it records
`run.waiting {contracts, contests, waitedMs?}` at most every 3 minutes
(`humanWaitRecordMs`; at most 40 per run), progress only: it changes no board
state and is never shown to agents. The console narrator reads "Waiting on
you: N decisions" and the CLI prints a line. Once decided, the normal
quiescence rules apply again. If nobody decides, the run ends at its time
limit and the reason names the pending decisions ("the run was waiting on N
human decision(s) nobody made (contract ...)").

- Code: `pendingHumanDecisions` (`packages/change-core/src/board.ts`); the
  quiet-board endings in `runBoard` (`packages/orchestration/src/run-board.ts`)
- Tests: `a human who decides after the old quiet window: the run waits for
  the decision instead of ending quiescent, then continues and completes`;
  `without a human resolver the contract waits durably, and the run reports
  the item as not completed` (`run-board-contracts.e2e.test.ts`); `a run
  waiting on a human is recorded by the engine and changes nothing else`
  (`packages/change-core/tests/board.test.ts`); `a run waiting on a person`
  (`apps/console/tests/integration-marker.test.tsx`)

## What is still open

- A changed developer test is approved by a human. When the final revision
  passes, each released test it changed is run alone on the baseline code and
  on the revision, and the proof bundle records whether it fails on the
  baseline ("teeth"). This is advisory and never changes a verdict. It lives on
  the proof bundle, not the board log, so the replay page does not show it yet,
  and it has only been exercised offline.
- A model can still write a weak test that passes for the wrong reason. The
  immutable acceptance gate is what protects the verdict; developer tests are
  the agents' own scaffolding.
- Live runs depend on the operator's model access (gateway credits or a CLI
  subscription). The engine ends honestly when that runs out, but cannot make
  it last longer.

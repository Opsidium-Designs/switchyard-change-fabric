/**
 * A deterministic board log for the mission-control graph tests and the
 * console's offline screenshots, built through the PURE board API (the same
 * append functions the Worker and the local control call), so every message
 * in it is one the board itself accepted: agents join and claim, a contest
 * escalates to a human, a protected contract waits for a human with an
 * advisory triage, a failing revision asks for a fix, an advisory attribution
 * is resolved by the next passing revision, rebases are targeted, a tool is
 * published and reused, and items complete.
 */
import {
  appendBoardMessage,
  appendDecisionRecorded,
  appendEngineRecord,
  appendIntegratedRev,
  appendToolGated,
  appendToolUsed,
  emptyBoard,
  type BoardAppendResult,
  type BoardMessage,
  type BoardState,
} from "@switchyard-change/change-core";

const AT = "2026-10-09T12:00:00.000Z";

/** A tiny in-memory board that throws on any refused post. */
export class FixtureBoard {
  state: BoardState = emptyBoard();
  readonly log: BoardMessage[] = [];

  private take(result: BoardAppendResult): readonly BoardMessage[] {
    this.state = result.state;
    this.log.push(...result.appended);
    return result.appended;
  }

  human(draft: Record<string, unknown>): readonly BoardMessage[] {
    return this.take(appendBoardMessage(this.state, { kind: "human" }, draft, AT));
  }

  join(agent: string, role?: string, rationale?: string): readonly BoardMessage[] {
    return this.take(
      appendBoardMessage(
        this.state,
        { kind: "join", agent },
        { type: "agent.joined", payload: role !== undefined ? { role } : {}, ...(rationale ? { rationale } : {}) },
        AT,
      ),
    );
  }

  agent(agent: string, draft: Record<string, unknown>): readonly BoardMessage[] {
    return this.take(appendBoardMessage(this.state, { kind: "agent", agent }, draft, AT));
  }

  rev(input: Record<string, unknown>): readonly BoardMessage[] {
    return this.take(appendIntegratedRev(this.state, input, AT));
  }

  decision(input: Record<string, unknown>): readonly BoardMessage[] {
    return this.take(appendDecisionRecorded(this.state, input, AT));
  }

  /** The operator records a tool's own gate result (the engine publishes a pass). */
  toolGate(input: Record<string, unknown>): readonly BoardMessage[] {
    return this.take(appendToolGated(this.state, input, AT));
  }

  /** The operator records a use the runtime ran (agents never post one). */
  toolUse(input: Record<string, unknown>): readonly BoardMessage[] {
    return this.take(appendToolUsed(this.state, input, AT));
  }

  /** The operator records an engine fact (candidate.gated, revision.promoted, ...). */
  record(type: string, payload: Record<string, unknown>): readonly BoardMessage[] {
    return this.take(appendEngineRecord(this.state, { type, payload }, AT));
  }

  lastSeqOf(type: string): number {
    const found = [...this.log].reverse().find((m) => m.type === type);
    if (!found) throw new Error(`no ${type} on the fixture board`);
    return found.seq;
  }
}

/** The mission-control fixture: a mid-run board with a pending contest escalation and a pending contract. */
export function missionControlLog(): BoardMessage[] {
  const b = new FixtureBoard();
  b.human({
    type: "goal.posted",
    payload: {
      objective: "Reject unauthenticated and invalid requests on every resource",
      rules: { maxContestTurns: 2, contestIdleMessages: 25, maxFixAttempts: 2 },
      protected: ["test/users.test.js"],
      testInventory: { status: "recorded", format: "node-test", count: 18 },
    },
  });
  b.join("lead", "lead", "reads the goal and the repo");
  b.decision({ juncture: "plan-review", question: "Does this plan cover the goal?", answer: "yes", confidence: 0.91, accepted: true });
  const items: [string, string, string[]][] = [
    ["users", "validate and guard /users", ["src/users.js"]],
    ["orders", "validate and guard /orders", ["src/orders.js"]],
    ["auth", "require auth on shared routes", ["src/auth.js", "src/shared/"]],
    ["products", "validate and guard /products", ["src/products.js"]],
    ["search", "guard /search", ["src/search.js", "src/shared/"]],
    ["tests", "cover the new checks", ["test/"]],
  ];
  for (const [item, objective, scopeHint] of items) {
    b.agent("lead", {
      type: "item.proposed",
      payload: { item, objective, acceptance: [`${item} rejects bad input with 400 and no auth with 401`], scopeHint },
      rationale: `one item per concern: ${item}`,
    });
  }
  for (const agent of ["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6"]) {
    b.join(agent, "worker");
  }
  b.agent("ag-1", { type: "item.claimed", payload: { item: "users", intent: { read: ["src/shared/**"], write: ["src/users.js"] } }, rationale: "users first" });
  b.agent("ag-2", { type: "item.claimed", payload: { item: "orders", intent: { read: [], write: ["src/orders.js"] } } });
  b.agent("ag-3", {
    type: "item.claimed",
    payload: { item: "auth", intent: { read: ["src/users.js"], write: ["src/auth.js", "src/shared/http.js"] } },
    rationale: "auth helpers live in shared/http",
  });
  b.agent("ag-4", { type: "item.claimed", payload: { item: "products", intent: { read: [], write: ["src/products.js"] } } });
  b.agent("ag-6", { type: "item.claimed", payload: { item: "tests", intent: { read: ["src/**"], write: ["test/validation.test.js"] } } });
  // A help request addressed to another agent, and its reply.
  const help = b.agent("ag-1", {
    type: "help.requested",
    payload: { request: "h1", item: "users", need: "auth-contract" },
    to: ["ag-3"],
    rationale: "need the auth contract before I guard users",
  });
  b.agent("ag-3", { type: "help.offered", payload: { request: "h1" }, to: ["ag-1"], inReplyTo: help[0]!.seq, rationale: "401 with a problem body" });
  // A contest on the shared helper: both keep, so it escalates to a human.
  b.agent("ag-5", {
    type: "item.claimed",
    payload: { item: "search", intent: { read: [], write: ["src/search.js", "src/shared/http.js"] } },
    rationale: "search needs the same helper",
  });
  const contest = String((b.state.items.search?.claimant?.contest) ?? "");
  b.agent("ag-3", { type: "claim.kept", payload: { contest }, rationale: "I am mid-edit on http.js" });
  b.agent("ag-5", { type: "claim.kept", payload: { contest }, rationale: "search cannot ship without it" });
  // Pushes, a failing revision, a fix request, and an advisory attribution.
  b.agent("ag-1", { type: "push.announced", payload: { item: "users", commit: "a1a1a1a", paths: ["src/users.js"] } });
  b.agent("ag-2", { type: "push.announced", payload: { item: "orders", commit: "b1b1b1b", paths: ["src/orders.js"] } });
  b.agent("ag-4", { type: "push.announced", payload: { item: "products", commit: "d1d1d1d", paths: ["src/products.js"] } });
  b.rev({
    commit: "rev1rev",
    gate: "fail",
    merged: ["a1a1a1a", "b1b1b1b", "d1d1d1d"],
    failing: { output: "not ok 7 - POST /orders without auth returns 401\n  expected 401, got 201", items: ["orders"] },
  });
  b.decision({
    juncture: "attribution",
    question: "Which item does this failure implicate?",
    answer: "orders",
    confidence: 0.82,
    accepted: true,
    rev: 1,
    parsed: ["orders"],
  });
  // Tools: a scanner is proposed, accepted, built, passes its own gate, and is reused.
  b.agent("ag-4", {
    type: "tool.proposed",
    payload: { tool: "route-scan", capability: "scan-unguarded-routes", kind: "scanner", inputs: ["src/**"], outputs: ["findings"] },
    rationale: "every resource repeats the same check",
  });
  b.agent("lead", { type: "item.accepted", payload: { item: "tool-scan-unguarded-routes" }, rationale: "a scanner beats hand checks" });
  b.agent("ag-4", { type: "item.claimed", payload: { item: "tool-scan-unguarded-routes", intent: { read: [], write: ["tools/scan-unguarded-routes/**"] } } });
  b.agent("ag-4", {
    type: "tool.built",
    payload: { capability: "scan-unguarded-routes", commit: "t00l001", paths: ["tools/scan-unguarded-routes/run.mjs", "tools/scan-unguarded-routes/test.mjs"] },
  });
  b.toolGate({
    capability: "scan-unguarded-routes",
    commit: "t00l001",
    passed: true,
    checks: [
      { check: "tests", passed: true, detail: "its own tests passed (2 test(s))" },
      { check: "finds", passed: true, detail: "found 4 place(s) in 4 file(s) on the baseline" },
    ],
    repo: "change--tools",
    usage: "node tools/scan-unguarded-routes/run.mjs [paths...]",
  });
  for (const user of ["ag-1", "ag-2", "ag-2"]) {
    b.toolUse({ capability: "scan-unguarded-routes", version: "1", by: user, findings: [{ path: "src/orders.js", line: 3, message: "route without auth" }] });
  }
  b.agent("ag-2", { type: "push.announced", payload: { item: "orders", commit: "b2b2b2b", paths: ["src/orders.js"] }, rationale: "requireAuth before the body check" });
  // auth pushes and proposes done, but the next revision does not merge it: a hollow check.
  b.agent("ag-3", { type: "push.announced", payload: { item: "auth", commit: "c1c1c1c", paths: ["src/auth.js"] } });
  b.agent("ag-3", { type: "done.proposed", payload: { item: "auth" }, rationale: "requireAuth is exported" });
  b.agent("ag-1", { type: "done.proposed", payload: { item: "users" } });
  b.agent("ag-4", { type: "done.proposed", payload: { item: "products" } });
  b.rev({ commit: "rev2rev", gate: "pass", merged: ["a1a1a1a", "b2b2b2b", "d1d1d1d"] });
  b.agent("ag-2", { type: "done.proposed", payload: { item: "orders" } });
  // A protected contract: escalated to a human, with an advisory triage.
  b.agent("ag-6", {
    type: "contract.proposed",
    payload: { contract: "k1", target: "test/users.test.js", kind: "modify", item: "tests" },
    rationale: "the old test expects 201 for an anonymous POST",
  });
  b.decision({
    juncture: "contract-triage",
    question: "Is changing this existing test needed to achieve the goal (rather than weakening the check)?",
    answer: "accept",
    confidence: 0.86,
    accepted: true,
    contract: "k1",
  });
  return b.log;
}

/** A tiny board whose only revision ran NO gate (gated: false). */
export function ungatedLog(): BoardMessage[] {
  const b = new FixtureBoard();
  b.human({ type: "goal.posted", payload: { objective: "add a footer", rules: { maxContestTurns: 3, contestIdleMessages: 25 } } });
  b.join("lead", "lead");
  b.agent("lead", { type: "item.proposed", payload: { item: "footer", objective: "add a footer", acceptance: [], scopeHint: ["src/"] } });
  b.join("ag-1");
  b.agent("ag-1", { type: "item.claimed", payload: { item: "footer", intent: { read: [], write: ["src/footer.js"] } } });
  b.agent("ag-1", { type: "push.announced", payload: { item: "footer", commit: "f00f00f", paths: ["src/footer.js"] } });
  b.agent("ag-1", { type: "done.proposed", payload: { item: "footer" } });
  b.rev({ commit: "rev1rev", gate: "pass", merged: ["f00f00f"], gated: false });
  return b.log;
}

/**
 * A formation log: ag-1 splits item `wide` (it becomes the sub-lead) and its
 * children are claimed by ag-2 and ag-3, who push; the sub-lead merges both
 * pushes into one push that passes. On item `pair`, ag-2 grants a file to a
 * helper: ag-3 forks ag-2's repo at its push, delivers, and ag-2 pulls.
 */
export function formationLog(): BoardMessage[] {
  const b = new FixtureBoard();
  b.human({ type: "goal.posted", payload: { objective: "change two areas" } });
  b.join("lead", "lead");
  for (const a of ["ag-1", "ag-2", "ag-3"]) {
    b.join(a);
  }
  b.agent("lead", { type: "item.proposed", payload: { item: "wide", objective: "change src/a", scopeHint: ["src/a/**"] } });
  b.agent("lead", { type: "item.proposed", payload: { item: "pair", objective: "change src/p", scopeHint: ["src/p/**"] } });
  b.agent("ag-1", { type: "item.claimed", payload: { item: "wide", intent: { read: [], write: ["src/a/**"] } } });
  b.agent("ag-1", {
    type: "item.split",
    payload: {
      item: "wide",
      children: [
        { item: "wide.1", objective: "x", scopeHint: ["src/a/x.ts"] },
        { item: "wide.2", objective: "y", scopeHint: ["src/a/y.ts"] },
      ],
    },
  });
  b.agent("ag-2", { type: "item.claimed", payload: { item: "wide.1", intent: { read: [], write: ["src/a/x.ts"] } } });
  b.agent("ag-3", { type: "item.claimed", payload: { item: "wide.2", intent: { read: [], write: ["src/a/y.ts"] } } });
  b.agent("ag-2", { type: "push.announced", payload: { item: "wide.1", commit: "c0000001", paths: ["src/a/x.ts"] } });
  b.agent("ag-3", { type: "push.announced", payload: { item: "wide.2", commit: "c0000002", paths: ["src/a/y.ts"] } });
  b.agent("ag-2", { type: "done.proposed", payload: { item: "wide.1" } });
  b.agent("ag-3", { type: "done.proposed", payload: { item: "wide.2" } });
  b.agent("ag-1", {
    type: "push.announced",
    payload: { item: "wide", commit: "c0000003", paths: ["src/a/x.ts", "src/a/y.ts"], merges: [{ item: "wide.1", commit: "c0000001" }, { item: "wide.2", commit: "c0000002" }] },
  });
  b.rev({ commit: "r0000001", gate: "pass", merged: ["c0000003"] });
  b.agent("ag-2", { type: "item.claimed", payload: { item: "pair", intent: { read: [], write: ["src/p/**"] } } });
  b.agent("ag-2", { type: "push.announced", payload: { item: "pair", commit: "c0000004", paths: ["src/p/a.ts", "src/p/b.ts"] } });
  b.agent("ag-2", { type: "help.requested", payload: { request: "h1", item: "pair", need: "parallel-edit", scope: ["src/p/b.ts"] } });
  b.agent("ag-3", { type: "help.offered", payload: { request: "h1", forkOf: "ag-2", forkCommit: "c0000004", fork: "chg--help-h1" }, to: ["ag-2"] });
  b.agent("ag-3", { type: "help.delivered", payload: { request: "h1", commit: "c0000005", paths: ["src/p/b.ts"] }, to: ["ag-2"] });
  b.agent("ag-2", { type: "push.announced", payload: { item: "pair", commit: "c0000005", paths: ["src/p/b.ts"], pulled: ["h1"] } });
  return b.log;
}

/**
 * A speculative-gating log (rules.speculate 2): after a first passing
 * revision, two pushes are stacked; C1 (one) passes and C2 (one then two)
 * fails, so C2 is recorded first as a failing revision implicating two only,
 * then C1 lands as the passing revision (its commit is C1's), both candidates
 * are recorded, and the landed revision is promoted.
 */
export function speculativeLog(): BoardMessage[] {
  const b = new FixtureBoard();
  b.human({ type: "goal.posted", payload: { objective: "add two reports", baseline: "base000", rules: { speculate: 2 }, gateCommand: ["npm", "run", "gate"] } });
  b.join("lead", "lead");
  for (const item of ["warm", "one", "two"]) {
    b.agent("lead", { type: "item.proposed", payload: { item, objective: `report ${item}`, scopeHint: [`src/${item}/**`] } });
  }
  for (const [agent, item] of [["ag-0", "warm"], ["ag-1", "one"], ["ag-2", "two"]] as const) {
    b.join(agent);
    b.agent(agent, { type: "item.claimed", payload: { item, intent: { read: [], write: [`src/${item}/**`] } } });
  }
  b.agent("ag-0", { type: "push.announced", payload: { item: "warm", commit: "aaa0000", paths: ["src/warm/w.js"] } });
  b.rev({ commit: "rev1000", gate: "pass", merged: ["aaa0000"], base: "base000" });
  b.agent("ag-1", { type: "push.announced", payload: { item: "one", commit: "bbb1111", paths: ["src/one/a.js"] } });
  b.agent("ag-2", { type: "push.announced", payload: { item: "two", commit: "ccc2222", paths: ["src/two/b.js"] } });
  b.rev({ commit: "cand222", gate: "fail", merged: ["bbb1111", "ccc2222"], base: "rev1000", failing: { output: "not ok 1 - src/two/b.js:3 total is wrong", items: ["two"] } });
  b.rev({ commit: "cand111", gate: "pass", merged: ["bbb1111"], base: "rev1000" });
  const one = { agent: "ag-1", items: ["one"], commit: "bbb1111" };
  const two = { agent: "ag-2", items: ["two"], commit: "ccc2222" };
  b.record("candidate.gated", { round: 1, index: 1, of: 2, prefix: [one], commit: "cand111", base: "rev1000", verdict: "pass", outcome: "landed", rev: 3 });
  b.record("candidate.gated", { round: 1, index: 2, of: 2, prefix: [one, two], commit: "cand222", base: "rev1000", verdict: "fail", outcome: "blamed", rev: 2, blamed: ["two"] });
  b.record("revision.promoted", { rev: 3, gatedCommit: "cand111", commit: "prom333", branch: "switchyard/change-1" });
  return b.log;
}

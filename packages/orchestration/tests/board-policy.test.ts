/**
 * The offline lead's triage of workers' proposed items: generic rules only
 * (scope overlap, near-identical objective, no scope), never a named file or app.
 */
import { describe, expect, it } from "vitest";

import type { BoardDigest, BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnInput } from "@switchyard-change/model-adapters";

import { coveredByOutstanding, createGenericBoardPolicy, duplicateOf } from "../src/board-policy.ts";

const existing = [
  { item: "u-users-validate-auth", objective: "Add input validation to the users resource handlers", scopeHint: ["src/users/**"] },
  { item: "u-notifications-validate", objective: "Add input validation to the notifications resource", scopeHint: ["src/notifications/**", "tests/notifications.test.ts"] },
];

describe("duplicateOf (the offline lead's proposal triage)", () => {
  it("a proposal whose scope lies inside an existing item's scope duplicates it", () => {
    expect(
      duplicateOf({ objective: "Add input validation and error responses for the notifications resource", scopeHint: ["src/notifications/handler.ts"] }, existing),
    ).toMatchObject({ item: "u-notifications-validate" });
  });

  it("a proposal that restates an existing objective duplicates it, whatever its scope", () => {
    expect(duplicateOf({ objective: "add input validation to the users resource handlers", scopeHint: ["lib/other.ts"] }, existing)).toMatchObject({
      item: "u-users-validate-auth",
    });
  });

  it("new work (a new scope, a different objective) is not a duplicate", () => {
    expect(duplicateOf({ objective: "Document the API error format", scopeHint: ["docs/errors.md"] }, existing)).toBeUndefined();
  });

  it("a proposal reaching beyond every existing scope is not a duplicate", () => {
    expect(duplicateOf({ objective: "Share one validator across resources", scopeHint: ["src/users/**", "src/shared/validate.ts"] }, existing)).toBeUndefined();
  });

  it("a proposal with no scope can never be claimed, so it is not taken", () => {
    expect(duplicateOf({ objective: "Something new", scopeHint: [] }, existing)).toEqual({ why: expect.stringMatching(/no scope/) });
  });
});

type Input = AgentTurnInput<BoardDigest, BoardMessage>;

/** A minimal turn input: an empty digest plus the given board facts. */
function input(agent: string, role: "lead" | "worker", board: Partial<Input["board"]>, extra: Partial<Input> = {}): Input {
  const digest = {
    agent,
    active: true,
    lastSeq: 1,
    after: 0,
    pageEnd: 1,
    claims: [],
    pending: [],
    contests: [],
    openItems: [],
    integrated: null,
    rebaseTo: null,
    failure: null,
    protected: [],
    protectedKeys: [],
    released: [],
    messages: [],
  } as unknown as BoardDigest;
  return {
    agent,
    role,
    goal: "g",
    digest,
    messages: [],
    capsule: { objective: "g", constraints: [], decisions: [], evidence: [] },
    board: { liveClaims: [], pendingContracts: [], ...board },
    repo: { files: [], excerpts: [] },
    allowed: [],
    ...extra,
  };
}

const policy = createGenericBoardPolicy();

describe("tools in the generic policy (goal-agnostic)", () => {
  const items = [
    { item: "fix-a", objective: "fix a", scopeHint: ["src/a.js"], status: "done" },
    { item: "fix-b", objective: "fix b", scopeHint: ["src/b/**"], status: "claimed", write: ["src/b/x.js"] },
    { item: "fix-c", objective: "fix c", scopeHint: ["src/c.js"], status: "open" },
  ];

  it("an outstanding item covers a file by its open scope or its claimed write intent; a done item covers nothing", () => {
    expect(coveredByOutstanding("src/c.js", items, [])).toBe(true);
    expect(coveredByOutstanding("src/b/x.js", items, [])).toBe(true);
    expect(coveredByOutstanding("src/b/y.js", items, [])).toBe(false); // narrowed away by its owner
    expect(coveredByOutstanding("src/a.js", items, [])).toBe(false); // done
    expect(coveredByOutstanding("src/d.js", items, [{ item: "p", objective: "o", scopeHint: ["src/d.js"], proposedBy: "x" }])).toBe(true);
  });

  it("the lead accepts a tool proposal, accepts tool-found work no outstanding item covers, and rejects tool-found work already covered", async () => {
    const tool = await policy(input("lead", "lead", { pendingItems: [{ item: "tool-scan", objective: "build", scopeHint: ["tools/scan/**"], proposedBy: "agent-1", tool: "scan" }], items }));
    expect(tool.action).toMatchObject({ type: "decide_item", itemId: "tool-scan", decision: "accept" });
    const fresh = await policy(
      input("lead", "lead", { pendingItems: [{ item: "agent-1-item-2", objective: "apply", scopeHint: ["src/a.js", "src/b/y.js"], proposedBy: "agent-1", fromTool: { capability: "scan", version: "1" } }], items }),
    );
    expect(fresh.action).toMatchObject({ type: "decide_item", decision: "accept" });
    const covered = await policy(
      input("lead", "lead", { pendingItems: [{ item: "agent-1-item-3", objective: "apply", scopeHint: ["src/c.js"], proposedBy: "agent-1", fromTool: { capability: "scan", version: "1" } }], items }),
    );
    expect(covered.action).toMatchObject({ type: "decide_item", decision: "reject" });
    expect(covered.action.type === "decide_item" && covered.action.rationale).toMatch(/src\/c\.js is already covered/);
  });

  it("a free worker proposes a scanner (whole repo) and, as another agent, a codemod (the group's scope) when planned items repeat one change over 3+ files", async () => {
    const planned = [
      { item: "guard-a", objective: "a", scopeHint: ["src/a.js"], status: "open", planned: true },
      { item: "guard-b", objective: "b", scopeHint: ["src/b.js"], status: "open", planned: true },
      { item: "guard-c", objective: "c", scopeHint: ["src/c.js"], status: "open", planned: true },
    ];
    const files = ["src/a.js", "src/b.js", "src/c.js", "README.md"];
    const first = await policy(input("agent-1", "worker", { items: planned, tools: [] }, { repo: { files, excerpts: [] } }));
    expect(first.action).toMatchObject({ type: "propose_tool", capability: "scan-guard", kind: "scanner", inputs: [] });
    const scanner = { capability: "scan-guard", kind: "scanner", item: "tool-scan-guard", status: "proposed", proposedBy: "agent-1", inputs: [], failedGates: 0, versions: [] };
    const second = await policy(input("agent-2", "worker", { items: planned, tools: [scanner] }, { repo: { files, excerpts: [] } }));
    expect(second.action).toMatchObject({ type: "propose_tool", capability: "codemod-guard", kind: "codemod", inputs: ["src/a.js", "src/b.js", "src/c.js"] });
    // Worker-proposed items (not planned) never trigger a tool.
    const unplanned = planned.map((i) => ({ ...i, planned: undefined }));
    expect((await policy(input("agent-1", "worker", { items: unplanned, tools: [] }, { repo: { files, excerpts: [] } }))).action.type).not.toBe("propose_tool");
  });
});

describe("formation in the generic policy (splits, fork-based help, tool timing)", () => {
  const claim = (item: string, write: string[], extra: Record<string, unknown> = {}) => ({ item, objective: `do ${item}`, intent: { read: [], write }, doneProposed: false, ...extra });
  const withDigest = (base: Input, digest: Record<string, unknown>, extra: Partial<Input> = {}): Input => ({
    ...base,
    digest: { ...(base.digest as unknown as Record<string, unknown>), ...digest } as unknown as BoardDigest,
    ...extra,
  });
  const files = { files: ["src/p/a.js", "src/p/b.js", "src/q/c.js"], excerpts: [] };

  it("splits a discovered (unplanned) multi-file item no codemod covers, one child per directory; never a planned item", async () => {
    const base = input("w1", "worker", { items: [{ item: "found", objective: "fix found", scopeHint: ["src/**"], status: "claimed" }] }, { repo: files });
    const turn = await policy(withDigest(base, { claims: [claim("found", ["src/**"])] }));
    expect(turn.action).toMatchObject({
      type: "split",
      itemId: "found",
      children: [
        { scopeHint: ["src/p/a.js", "src/p/b.js"] },
        { scopeHint: ["src/q/c.js"] },
      ],
    });
    const planned = input("w1", "worker", { items: [{ item: "found", objective: "fix found", scopeHint: ["src/**"], status: "claimed", planned: true }] }, { repo: files });
    expect((await policy(withDigest(planned, { claims: [claim("found", ["src/**"])] }))).action).toMatchObject({ type: "edit", itemId: "found" });
  });

  it("a sub-lead merges new child pushes, and leaves its open children to others", async () => {
    const base = input("w1", "worker", {}, { repo: files });
    const subLead = [{ item: "found", objective: "o", write: ["src/**"], children: [{ item: "found.1", status: "claimed", owner: "w2", lastPush: { commit: "c1", agent: "w2" }, merged: false }] }];
    expect((await policy(withDigest(base, { subLead }))).action).toMatchObject({ type: "pull", itemId: "found" });
    // A child push a revision recorded unverified is not merged again (no merge loop).
    const unverified = [{ ...subLead[0]!, children: [{ ...subLead[0]!.children[0]!, unverified: true }] }];
    expect((await policy(withDigest(base, { subLead: unverified }))).action.type).toBe("wait");
    const open = withDigest(base, {
      subLead: [{ item: "found", objective: "o", write: ["src/**"], children: [{ item: "found.2", status: "open", merged: false }] }],
      openItems: [{ item: "found.2", objective: "o", acceptance: [], scopeHint: ["src/q/c.js"], parent: "found" }],
    });
    expect((await policy(open)).action).toMatchObject({ type: "wait" });
  });

  it("asks for help on the hand pass after a codemod pushed several files, then pulls the delivered work before proposing done", async () => {
    const tools = [{ capability: "cm", kind: "codemod", item: "tool-cm", status: "done", proposedBy: "lead", inputs: ["src/p/**"], failedGates: 0, versions: [{ version: "1", commit: "t", usage: "u", publishedBy: "w9" }] }];
    const used = { turn: 1, action: { type: "use_tool" as const, capability: "cm", version: "1", args: [], itemId: "pair" }, outcome: "posted" as const, note: { changed: "2" } };
    const base = input("w1", "worker", { tools }, { repo: files, capsule: { objective: "g", constraints: [], decisions: [used], evidence: [] } });
    const pushed = claim("pair", ["src/p/**"], { lastPush: { commit: "c1abcdef00", agent: "w1" } });
    const ask = await policy(withDigest(base, { claims: [pushed] }));
    expect(ask.action).toMatchObject({ type: "message", kind: "help", payload: { itemId: "pair", need: "parallel-edit", scope: ["src/p/b.js"] } });
    // While the grant is live and undelivered: no propose_done.
    const waiting = withDigest(base, { claims: [pushed], help: { mine: [{ request: "h1", item: "pair", by: "w1", need: "n", scope: ["src/p/b.js"], live: true, pulled: false }], granted: [], wanted: [] } }, {
      capsule: { objective: "g", constraints: [], decisions: [used, { turn: 2, action: ask.action, outcome: "posted" }], evidence: [] },
    });
    expect((await policy(waiting)).action.type).toBe("wait");
    const delivered = withDigest(waiting, {
      help: { mine: [{ request: "h1", item: "pair", by: "w1", need: "n", scope: ["src/p/b.js"], live: true, grantee: "w2", delivered: { commit: "d1", paths: ["src/p/b.js"] }, pulled: false }], granted: [], wanted: [] },
    });
    expect((await policy(delivered)).action).toMatchObject({ type: "pull", itemId: "pair", requestId: "h1" });
    // A free agent takes a wanted grant (the runtime forks); a helper edits its grant.
    const free = withDigest(input("w2", "worker", {}), { help: { mine: [], granted: [], wanted: [{ request: "h1", item: "pair", by: "w1", need: "n", scope: ["src/p/b.js"], live: true, pulled: false }] } });
    expect((await policy(free)).action).toMatchObject({ type: "message", kind: "reply", payload: { requestId: "h1" } });
    const helper = withDigest(input("w2", "worker", {}), { help: { mine: [], granted: [{ request: "h1", item: "pair", by: "w1", need: "n", scope: ["src/p/b.js"], live: true, pulled: false }], wanted: [] } });
    expect((await policy(helper)).action).toMatchObject({ type: "edit", itemId: "pair" });
  });

  it("reads a held item's files (at most twice) while a codemod covering it is built, then edits by hand", async () => {
    const tools = [{ capability: "cm", kind: "codemod", item: "tool-cm", status: "claimed", proposedBy: "lead", inputs: ["src/p/**"], failedGates: 0, versions: [] }];
    const held = claim("pair", ["src/p/**"]);
    const explore = (n: number) => ({ turn: n, action: { type: "wait" as const, reason: `exploring pair: reading (${n})` }, outcome: "local" as const });
    const at = (decisions: Input["capsule"]["decisions"]) =>
      policy(withDigest(input("w1", "worker", { tools, items: [{ item: "pair", objective: "o", scopeHint: ["src/p/**"], status: "claimed", planned: true }] }, { repo: files, capsule: { objective: "g", constraints: [], decisions, evidence: [] } }), { claims: [held] }));
    expect((await at([])).action).toMatchObject({ type: "wait", reason: expect.stringMatching(/^exploring pair: .*codemod cm is built \(1 of 2/) });
    expect((await at([explore(1)])).action).toMatchObject({ type: "wait" });
    expect((await at([explore(1), explore(2)])).action).toMatchObject({ type: "edit", itemId: "pair" });
    // An unavailable codemod is never waited for.
    const unavailable = [{ ...tools[0]!, unavailable: "its own gate failed 1 time(s)" }];
    const direct = await policy(withDigest(input("w1", "worker", { tools: unavailable, items: [{ item: "pair", objective: "o", scopeHint: ["src/p/**"], status: "claimed", planned: true }] }, { repo: files }), { claims: [held] }));
    expect(direct.action).toMatchObject({ type: "edit", itemId: "pair" });
  });
});

describe("formation cues in the generic policy (volunteer, answer, wait once for a volunteer)", () => {
  const files = { files: ["src/p/a.js", "src/p/b.js"], excerpts: [] };
  const base = (agent: string, digest: Record<string, unknown>, decisions: Input["capsule"]["decisions"] = []): Input => {
    const items = [{ item: "pair", objective: "o", scopeHint: ["src/p/**"], status: "claimed", planned: true }];
    const i = input(agent, "worker", { items }, { repo: files, capsule: { objective: "g", constraints: [], decisions, evidence: [] } });
    return { ...i, digest: { ...(i.digest as unknown as Record<string, unknown>), ...digest } as unknown as BoardDigest };
  };
  const busy = [{ agent: "w1", item: "pair", turnsSpent: 4, failedEdits: 2, reason: "failed-edits", scope: ["src/p/**"] }];

  it("an idle agent with no open item volunteers once per item", async () => {
    expect((await policy(base("w2", { busyOwners: busy }))).action).toMatchObject({ type: "offer_help", itemId: "pair", toAgent: "w1" });
    const offered = { turn: 1, action: { type: "offer_help" as const, itemId: "pair", toAgent: "w1", why: "w" }, outcome: "posted" as const };
    expect((await policy(base("w2", { busyOwners: busy }, [offered]))).action.type).toBe("wait");
  });

  it("an owner hands a volunteer the second half of several files, a struggling single file whole, and declines otherwise", async () => {
    const claim = { item: "pair", objective: "o", intent: { read: [], write: ["src/p/**"] }, doneProposed: false, lastPush: { commit: "c", agent: "w1" } };
    expect((await policy(base("w1", { claims: [claim], volunteers: [{ agent: "w2", item: "pair", seq: 9 }] }))).action).toMatchObject({
      type: "answer_volunteer",
      accept: true,
      scope: ["src/p/b.js"],
    });
    const single = { ...claim, intent: { read: [], write: ["src/p/new.test.js"] } };
    expect((await policy(base("w1", { claims: [single], volunteers: [{ agent: "w2", item: "pair", seq: 9 }] }))).action).toMatchObject({ accept: false });
    const struggling = [{ item: "pair", turnsSpent: 4, failedEdits: 0, reason: "turn-budget" }];
    expect((await policy(base("w1", { claims: [single], struggling, volunteers: [{ agent: "w2", item: "pair", seq: 9 }] }))).action).toMatchObject({
      accept: true,
      scope: ["src/p/new.test.js"],
    });
  });

  it("a struggling owner with idle agents waits one turn for a volunteer before editing again", async () => {
    const claim = { item: "pair", objective: "o", intent: { read: [], write: ["src/p/**"] }, doneProposed: false };
    const cue = { claims: [claim], struggling: [{ item: "pair", turnsSpent: 4, failedEdits: 0, reason: "turn-budget" }], idleAgents: ["w2"] };
    const first = await policy(base("w1", cue));
    expect(first.action).toMatchObject({ type: "wait", reason: expect.stringMatching(/^struggling on pair: 1 idle agent/) });
    expect((await policy(base("w1", cue, [{ turn: 1, action: first.action, outcome: "local" }]))).action).toMatchObject({ type: "edit", itemId: "pair" });
  });
});

describe("the contract cue in the generic policy", () => {
  it("proposes a contract for the protected failing check once, then keeps fixing", async () => {
    const claim = { item: "tax", objective: "o", intent: { read: [], write: ["src/tax.ts"] }, doneProposed: true, fix: { n: 1, attempt: 1 }, contractCue: { paths: ["tests/tax.test.ts"], hint: "h" } };
    const base = input("w1", "worker", {});
    const at = (decisions: Input["capsule"]["decisions"]) =>
      policy({ ...base, capsule: { ...base.capsule, decisions }, digest: { ...(base.digest as unknown as Record<string, unknown>), claims: [claim] } as unknown as BoardDigest });
    const first = await at([]);
    expect(first.action).toMatchObject({ type: "message", kind: "contract", payload: { target: "tests/tax.test.ts", change: "modify", itemId: "tax" } });
    expect((await at([{ turn: 1, action: first.action, outcome: "posted" }])).action).toMatchObject({ type: "edit", itemId: "tax" });
  });
});

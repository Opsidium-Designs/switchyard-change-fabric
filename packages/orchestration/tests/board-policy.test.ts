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

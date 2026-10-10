/**
 * The board graph model (mission control): a pure function of the board log
 * at seq K. Offline, deterministic: the fixture log is built through the pure
 * board API.
 */
import { describe, expect, it } from "vitest";

import { foldBoard, type BoardMessage } from "@switchyard-change/change-core";

import {
  aggregateMessageEdges,
  assertBoardBacked,
  BOARD_GRAPH_EDGE_KINDS,
  boardCaptions,
  boardJumpTargets,
  boardLayout,
  boardNodePoint,
  boardPrefix,
  boardThread,
  buildBoardGraph,
  hullAgentPoint,
  type BoardGraphModel,
} from "../src/board-graph.ts";
import { formationLog, missionControlLog, ungatedLog } from "./board-graph-fixture.ts";

const log = missionControlLog();
const full = buildBoardGraph(log);
const seqOf = (type: string, pick: (m: BoardMessage) => boolean = () => true): number =>
  log.find((m) => m.type === type && pick(m))!.seq;

function withoutHead(model: BoardGraphModel): Omit<BoardGraphModel, "lastSeq"> {
  const { lastSeq: _lastSeq, ...rest } = model;
  return rest;
}

describe("the board graph at the live head", () => {
  it("draws the goal, the lead, agents, item hulls, the revision chain, tools, Jev, and the human", () => {
    const kinds = (kind: string) => full.nodes.filter((n) => n.kind === kind).map((n) => n.label);
    expect(kinds("goal")).toEqual(["Reject unauthenticated and invalid requests on every resource"]);
    expect(kinds("lead")).toEqual(["lead"]);
    expect(kinds("agent")).toEqual(["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6"]);
    expect(kinds("item")).toEqual(["users", "orders", "auth", "products", "search", "tests", "tool-scan-unguarded-routes"]);
    expect(kinds("rev")).toEqual(["rev 1", "rev 2"]);
    expect(kinds("tool")).toEqual(["scan-unguarded-routes"]);
    expect(kinds("jev")).toEqual(["plan-review", "attribution", "contract-triage"]);
    expect(kinds("human")).toEqual(["human"]);
  });

  it("uses only the allowed edge kinds and never a spawn (the board records no repo-pushed recruitment)", () => {
    for (const edge of full.edges) {
      expect(BOARD_GRAPH_EDGE_KINDS).toContain(edge.kind);
    }
    expect(full.edges.some((e) => e.kind === "spawn")).toBe(false);
  });

  it("ends every tooltip with its backing message", () => {
    for (const element of [...full.nodes, ...full.edges]) {
      expect(element.tooltip).toMatch(/\(seq \d+, [a-z.]+\)$/);
    }
  });

  it("puts agents in the hull of the item they hold, and free agents on the bench", () => {
    const agent = (id: string) => full.nodes.find((n) => n.id === `agent:${id}`)!.detail;
    expect(agent("ag-3")).toMatchObject({ hull: "auth", rebasing: true });
    expect(agent("ag-5")).toMatchObject({ hull: "search" }); // waiting on the contest
    expect(agent("ag-1")).not.toHaveProperty("hull"); // its item is done
    const auth = full.nodes.find((n) => n.id === "item:auth")!.detail;
    expect(auth).toMatchObject({ agents: ["ag-3"], contested: true });
  });

  it("keeps done.proposed hollow until a passing revision completes the item", () => {
    const auth = full.nodes.find((n) => n.id === "item:auth")!;
    expect(auth.detail).toMatchObject({ doneProposed: true });
    expect(auth.status).not.toBe("done");
    expect(auth.tooltip).toContain("done proposed (not yet on a passing revision)");
    const users = full.nodes.find((n) => n.id === "item:users")!;
    expect(users.status).toBe("done");
    expect(users.detail).toMatchObject({ completed: { n: 2, via: "integrated" } });
  });

  it("aggregates consumed-tool edges per user, backed by the engine's tool.used records", () => {
    const tool = full.edges.filter((e) => e.kind === "consumed-tool");
    expect(tool.map((e) => [e.to, e.count])).toEqual([
      ["agent:ag-1", 1],
      ["agent:ag-2", 2],
    ]);
    for (const edge of tool) {
      expect(edge.seqs.every((seq) => log.find((m) => m.seq === seq)?.type === "tool.used" && log.find((m) => m.seq === seq)?.from === "engine")).toBe(true);
    }
  });

  it("a tool node carries its registry entry: kind, builder, the gate evidence it passed, its versions and users", () => {
    const node = full.nodes.find((n) => n.id === "tool:scan-unguarded-routes")!;
    expect(node.status).toBe("published");
    expect(node.detail).toMatchObject({
      kind: "tool",
      toolKind: "scanner",
      proposedBy: "ag-4",
      item: "tool-scan-unguarded-routes",
      versions: [{ version: "1", publishedBy: "ag-4", commit: "t00l001", uses: 3 }],
      users: [
        { agent: "ag-1", uses: 1 },
        { agent: "ag-2", uses: 2 },
      ],
      published: true,
    });
    const gated = log.find((m) => m.type === "tool.gated")!;
    expect(node.seqs).toContain(gated.seq);
    expect(node.detail.kind === "tool" && node.detail.gates?.[0]).toMatchObject({ seq: gated.seq, passed: true });
    expect(node.detail.kind === "tool" && node.detail.versions[0]!.gateSeq).toBe(gated.seq);
    // The tool item's passing build published it: a trigger edge backed by tool.published.
    const published = full.edges.find((e) => e.id === "trigger:item:tool-scan-unguarded-routes->tool:scan-unguarded-routes")!;
    expect(published).toMatchObject({ kind: "trigger", type: "tool.published" });
  });

  it("refuses a consumed-tool edge backed by anything but a tool.used record", () => {
    const edge = full.edges.find((e) => e.kind === "consumed-tool")!;
    const pushed = log.find((m) => m.type === "push.announced")!;
    const forged = { ...full, edges: full.edges.map((e) => (e.id === edge.id ? { ...e, seqs: [pushed.seq] } : e)) };
    expect(() => assertBoardBacked(forged, log)).toThrow(/must be backed by tool.used/);
  });

  it("chains revisions and feeds each with the items whose pushes it merged", () => {
    expect(full.edges.find((e) => e.id === "dep:rev:1->rev:2")).toMatchObject({ kind: "dependency", seqs: [seqOf("integrated.rev", (m) => m.type === "integrated.rev" && m.payload.n === 2)] });
    expect(full.edges.filter((e) => e.to === "rev:1").map((e) => e.from)).toEqual(["item:users", "item:orders", "item:products"]);
    const fix = full.edges.find((e) => e.kind === "trigger" && e.type === "fix.requested")!;
    expect(fix).toMatchObject({ from: "rev:1", to: "item:orders" });
  });
});

describe("contest and message edges", () => {
  const contested = seqOf("claim.contested");
  const escalated = seqOf("claim.escalated");

  it("draws a contest edge from the claimant to the owner only while the contest is unresolved", () => {
    expect(buildBoardGraph(log, contested - 1).edges.some((e) => e.kind === "contest")).toBe(false);
    expect(buildBoardGraph(log, contested).edges.find((e) => e.kind === "contest")).toMatchObject({
      from: "agent:ag-5",
      to: "agent:ag-3",
      contest: "open",
      seqs: [contested],
    });
    expect(full.edges.find((e) => e.kind === "contest")).toMatchObject({ contest: "escalated", seqs: [contested, escalated] });
  });

  it("draws a message edge per addressed message or reply, backed by its seq", () => {
    const help = seqOf("help.requested");
    const offered = seqOf("help.offered");
    const messages = full.edges.filter((e) => e.kind === "message");
    expect(messages.map((e) => [e.from, e.to, e.seqs[0], e.type])).toEqual([
      ["agent:ag-1", "agent:ag-3", help, "help.requested"],
      ["agent:ag-3", "agent:ag-1", offered, "help.offered"],
    ]);
    expect(aggregateMessageEdges(messages).map((e) => e.count)).toEqual([1, 1]);
  });
});

describe("the backing check (no-unbacked-node)", () => {
  it("passes for every K", () => {
    for (let k = 0; k <= full.lastSeq; k += 1) {
      expect(() => buildBoardGraph(log, k)).not.toThrow();
    }
  });

  it("refuses a node whose seq is past K, or whose backing message cannot create it", () => {
    const early = buildBoardGraph(log, 20);
    const future = { ...early, nodes: [...early.nodes, { ...full.nodes.find((n) => n.id === "rev:2")! }] };
    expect(() => assertBoardBacked(future, log)).toThrow(/not a recorded board message at or before seq 20/);
    const wrongType = { ...full, nodes: full.nodes.map((n) => (n.id === "item:users" ? { ...n, seqs: [1] } : n)) };
    expect(() => assertBoardBacked(wrongType, log)).toThrow(/goal.posted, which cannot back a item node/);
    const unnamed = { ...full, nodes: full.nodes.map((n) => (n.id === "item:users" ? { ...n, seqs: [seqOf("item.proposed", (m) => m.type === "item.proposed" && m.payload.item === "orders")] } : n)) };
    expect(() => assertBoardBacked(unnamed, log)).toThrow(/does not name it/);
  });

  it("refuses a decorative edge: a message edge on the wrong seq, a spawn, a contest not opened by its seq", () => {
    const msg = full.edges.find((e) => e.kind === "message")!;
    const forged = { ...full, edges: [...full.edges, { ...msg, id: "forged", to: "agent:ag-6" }] };
    expect(() => assertBoardBacked(forged, log)).toThrow(/is not a message from agent:ag-1 to agent:ag-6/);
    const spawn = { ...full, edges: [...full.edges, { ...msg, id: "s", kind: "spawn" as const }] };
    expect(() => assertBoardBacked(spawn, log)).toThrow(/spawn edge needs a repo-pushed recruitment/);
    const contest = { ...full, edges: [...full.edges, { ...msg, id: "contest:x", kind: "contest" as const }] };
    expect(() => assertBoardBacked(contest, log)).toThrow(/not the claim.contested that opened it/);
    const empty = { ...full, edges: [{ ...msg, seqs: [] }] };
    expect(() => assertBoardBacked(empty, log)).toThrow(/no backing message/);
  });
});

describe("replay: the graph at K is the live fold at K", () => {
  it("equals the graph built from the log prefix, for every K", () => {
    for (let k = 0; k <= full.lastSeq; k += 1) {
      const replayed = buildBoardGraph(log, k);
      const live = buildBoardGraph(boardPrefix(log, k));
      expect(withoutHead(replayed)).toEqual(withoutHead(live));
      expect(replayed.state).toEqual(foldBoard(log, k));
    }
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildBoardGraph(missionControlLog(), 40))).toBe(JSON.stringify(buildBoardGraph(log, 40)));
  });
});

describe("stable layout", () => {
  const layout = boardLayout(log);

  it("gives items slots in order of first appearance", () => {
    expect([...layout.items.entries()].map(([id, r]) => [id, r.slot])).toEqual([
      ["users", 0],
      ["orders", 1],
      ["auth", 2],
      ["products", 3],
      ["search", 4],
      ["tests", 5],
    ]);
  });

  it("never moves a slot as the log grows (a prefix layout agrees on every slot it has)", () => {
    for (let k = 1; k <= full.lastSeq; k += 1) {
      const partial = boardLayout(boardPrefix(log, k));
      for (const [id, rect] of partial.items) {
        expect(layout.items.get(id)!.slot).toBe(rect.slot);
      }
      for (const [item, slots] of partial.agentSlots) {
        for (const [agent, slot] of slots) {
          expect(layout.agentSlots.get(item)!.get(agent)).toBe(slot);
        }
      }
    }
  });

  it("places an element at the same point at every K where its state is unchanged", () => {
    const point = (k: number, id: string) => {
      const model = buildBoardGraph(log, k);
      const node = model.nodes.find((n) => n.id === id);
      return node ? boardNodePoint(layout, node) : undefined;
    };
    expect(point(10, "item:users")).toEqual(point(full.lastSeq, "item:users"));
    expect(point(36, "rev:1")).toEqual(point(full.lastSeq, "rev:1"));
    // ag-3 sits in the auth hull from its grant to the end.
    expect(point(21, "agent:ag-3")).toEqual(point(full.lastSeq, "agent:ag-3"));
  });
});

describe("ticker and labels", () => {
  it("shows the latest revision's gate, rebasing agents, agent counts, and the advisory Jev summary", () => {
    expect(full.ticker).toMatchObject({
      goal: "Reject unauthenticated and invalid requests on every resource",
      rev: { n: 2, gate: "pass", gated: true, label: "GATE PASS" },
      rebasing: ["ag-3"],
      agents: { active: 7, joined: 7 },
      jev: { calls: 3, accepted: 3, errors: 0, label: "jev: 3 call(s), 3 accepted, 0 error(s) (advisory)" },
    });
    expect(buildBoardGraph(log, seqOf("integrated.rev")).ticker.rev).toMatchObject({ n: 1, label: "GATE FAIL" });
  });

  it('labels a revision that ran no gate "no gate: nothing checked", never a pass', () => {
    const model = buildBoardGraph(ungatedLog());
    expect(model.ticker.rev).toMatchObject({ gated: false, label: "no gate: nothing checked" });
    const rev = model.nodes.find((n) => n.kind === "rev")!;
    expect(rev.status).toBe("no-gate");
    expect(rev.tooltip).toContain("no gate: nothing checked");
    expect(rev.tooltip).not.toContain("GATE PASS");
  });

  it("describes a resolved attribution as where the pick landed, never as correct", () => {
    const attribution = full.nodes.find((n) => n.kind === "jev" && n.label === "attribution")!;
    expect(attribution.detail).toMatchObject({ resolved: { text: "Jev picked orders; orders changed before the next pass" } });
    for (const node of full.nodes.filter((n) => n.kind === "jev")) {
      expect(node.tooltip).not.toMatch(/correct/i);
      expect(node.tooltip).toContain("(advisory)");
    }
  });

  it("puts gate verdicts only on revision nodes", () => {
    for (const node of full.nodes.filter((n) => n.kind !== "rev")) {
      expect(node.tooltip).not.toMatch(/GATE (PASS|FAIL)/);
    }
  });

  it("sorts items into the board columns", () => {
    expect(full.columns).toEqual({
      proposed: [],
      open: [],
      claimed: ["tests"],
      contested: ["auth", "search"],
      done: ["users", "orders", "products", "tool-scan-unguarded-routes"],
    });
  });

  it("pins the escalations waiting on a human, with the contract's advisory triage", () => {
    expect(full.escalations.map((e) => [e.kind, e.ref, e.options, e.recommendation])).toEqual([
      ["contest", "contest-29", ["ag-3", "ag-5"], undefined],
      ["contract", "k1", ["accept", "reject"], "accept (confidence 0.86)"],
    ]);
  });
});

describe("threads, captions, and jump targets", () => {
  it("gathers an item's typed messages in seq order, including its contest", () => {
    const thread = boardThread(log, full.lastSeq, { kind: "item", id: "search" });
    expect(thread.map((m) => m.type)).toEqual(["item.proposed", "item.claimed", "claim.contested", "claim.kept", "claim.kept", "claim.escalated"]);
  });

  it("gathers an agent's sent and addressed messages", () => {
    const thread = boardThread(log, full.lastSeq, { kind: "agent", id: "ag-2" });
    expect(thread.map((m) => m.type)).toContain("fix.requested");
    expect(thread.every((m, i) => i === 0 || m.seq > thread[i - 1]!.seq)).toBe(true);
  });

  it("captions at most three newly landed messages over their senders", () => {
    const ids = new Set(full.nodes.map((n) => n.id));
    const captions = boardCaptions(log, 25, 31, ids);
    expect(captions.map((c) => [c.seq, c.node])).toEqual([
      [31, "agent:ag-5"],
      [30, "agent:ag-3"],
      [28, "agent:ag-5"],
    ]);
  });

  it("lists contest and revision seqs for the replay jumps", () => {
    const jumps = boardJumpTargets(log);
    expect(jumps.revs).toEqual([seqOf("integrated.rev"), seqOf("integrated.rev", (m) => m.type === "integrated.rev" && m.payload.n === 2)]);
    expect(jumps.contests).toEqual([seqOf("claim.contested"), seqOf("claim.escalated"), seqOf("contract.escalated")]);
  });
});

describe("formation: split hulls nested with the sub-lead on the border, and fork lineage", () => {
  const flog = formationLog();
  const graph = buildBoardGraph(flog);
  const layout = boardLayout(flog);
  const fseq = (type: string, pick: (m: BoardMessage) => boolean = () => true): number => flog.find((m) => m.type === type && pick(m))!.seq;

  it("nests a split item's children inside its hull, and the parent grows to hold them", () => {
    const parent = layout.items.get("wide")!;
    for (const id of ["wide.1", "wide.2"]) {
      const child = layout.items.get(id)!;
      expect(child).toMatchObject({ parent: "wide", depth: 1 });
      expect(child.x).toBeGreaterThanOrEqual(parent.x);
      expect(child.x + child.w).toBeLessThanOrEqual(parent.x + parent.w);
      expect(child.y).toBeGreaterThan(parent.y);
      expect(child.y + child.h).toBeLessThanOrEqual(parent.y + parent.h);
    }
    // Top-level items still take grid slots and never overlap the grown hull.
    const pair = layout.items.get("pair")!;
    expect(pair.parent).toBeUndefined();
    expect(pair.x >= parent.x + parent.w || pair.y >= parent.y + parent.h).toBe(true);
    // An agent in a narrow nested hull stays inside it.
    const child = layout.items.get("wide.1")!;
    const p = hullAgentPoint(child, 0, "ag-2");
    expect(p.x).toBeGreaterThan(child.x);
    expect(p.x).toBeLessThan(child.x + child.w);
  });

  it("draws the sub-lead on the border of the split item's hull", () => {
    // While the split item is in flight (before its sub-lead's push passed).
    const atMerge = buildBoardGraph(flog, fseq("push.announced", (m) => m.type === "push.announced" && m.payload.merges !== undefined));
    const subLead = atMerge.nodes.find((n) => n.id === "agent:ag-1")!;
    expect(subLead.detail).toMatchObject({ kind: "agent", hull: "wide", subLeadOf: ["wide"] });
    expect(atMerge.nodes.find((n) => n.id === "item:wide")!.detail).toMatchObject({ kind: "item", status: "split", subLead: "ag-1" });
    expect(graph.nodes.find((n) => n.id === "item:wide")!.detail).toMatchObject({ kind: "item", status: "done", subLead: "ag-1" });
    const hull = layout.items.get("wide")!;
    expect(boardNodePoint(layout, subLead)).toEqual({ x: hull.x, y: hull.y + 32 + 36 });
  });

  it("draws fork lineage as a dependency edge labelled fork, backed by the help.offered seq, and merges as labelled dependency edges", () => {
    const fork = graph.edges.find((e) => e.id === "fork:h1")!;
    expect(fork).toMatchObject({ kind: "dependency", label: "fork", from: "agent:ag-2", to: "agent:ag-3", seqs: [fseq("help.offered")] });
    expect(fork.tooltip).toContain("forked ag-2's repo at c0000004");
    const merged = graph.edges.filter((e) => e.label === "merged");
    expect(merged.map((e) => [e.from, e.to])).toEqual([
      ["item:wide.1", "item:wide"],
      ["item:wide.2", "item:wide"],
    ]);
    expect(graph.edges.every((e) => BOARD_GRAPH_EDGE_KINDS.includes(e.kind))).toBe(true);
    // The helper's delivery is an ordinary message edge (addressed to the requester).
    expect(graph.edges.some((e) => e.kind === "message" && e.type === "help.delivered" && e.to === "agent:ag-2")).toBe(true);
    // Threads: the help messages belong to the item they help on.
    expect(boardThread(flog, Number.POSITIVE_INFINITY, { kind: "item", id: "pair" }).map((m) => m.type)).toContain("help.delivered");
  });

  it("refuses a fork edge not backed by its help.offered, and a merged edge not backed by the sub-lead's push", () => {
    const fork = graph.edges.find((e) => e.id === "fork:h1")!;
    expect(() => assertBoardBacked({ ...graph, edges: [{ ...fork, seqs: [fseq("help.requested")] }] }, flog)).toThrow(/not the help.offered fork/);
    expect(() => assertBoardBacked({ ...graph, edges: [{ ...fork, from: "agent:ag-1" }] }, flog)).toThrow(/not the help.offered fork/);
    const merged = graph.edges.find((e) => e.label === "merged")!;
    expect(() => assertBoardBacked({ ...graph, edges: [{ ...merged, seqs: [fseq("help.offered")] }] }, flog)).toThrow(/not a sub-lead push/);
    for (let k = 0; k <= flog.at(-1)!.seq; k += 1) {
      expect(() => buildBoardGraph(flog, k)).not.toThrow();
    }
  });
});

describe("wait reasons on item cards (derived from the folded board)", () => {
  it("every non-moving item card states one short reason; a moving or finished one states none", () => {
    for (const node of full.nodes.filter((n) => n.kind === "item")) {
      if (node.detail.kind !== "item") continue;
      const d = node.detail;
      if (d.status === "done") {
        expect(d.wait).toBeUndefined();
      }
      if (d.status === "open") {
        expect(d.wait?.line).toMatch(/open|lapsed|cap|seam|fix budget/);
      }
      if (d.wait !== undefined) {
        expect(node.tooltip).toContain(`(${d.wait.line})`);
      }
    }
    // At the head of the fixture some item is waiting on something stated.
    expect(full.nodes.some((n) => n.detail.kind === "item" && n.detail.wait !== undefined)).toBe(true);
  });
});

/**
 * Offline tests for the mission-control view of a board run: the ticker, the
 * board columns, the pinned escalation card and its buttons (fetch faked), the
 * honesty labels, replay at K, the incremental board polling, and the
 * launcher's board launch arguments. Rendering uses react-dom/server (no
 * jsdom); the board log is built through the pure board API.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  boardLayout,
  boardNodePoint,
  boardPrefix,
  buildBoardGraph,
  HULL_TITLE_H,
  type BoardMessage,
  type BoardPoint,
} from "@switchyard-change/orchestration/board-graph";

import { FixtureBoard, missionControlLog, ungatedLog } from "../../../packages/orchestration/tests/board-graph-fixture.ts";
import { launchArgs, launchOptionsFromBody, runBoardArgs } from "../launcher";
import { isBoardRun } from "../src/App.tsx";
import { mergeBoardLog, pullBoard, resolveEscalation } from "../src/board-data.ts";
import {
  agentShortLabel,
  boardShortLabels,
  ellipsizeToWidth,
  hullHeader,
  HULL_STATUS_FONT,
  HULL_TITLE_FONT,
  placeCaptions,
  textBoost,
  BoardNodeDetail,
  BoardPane,
  EscalationCard,
  escalationCards,
  MissionControl,
  Thread,
  Ticker,
  ToolsRegistry,
  type BoardEscalationRecord,
} from "../src/mission-control.tsx";
import { templateById } from "../src/templates.ts";
import { WORKER_PROXY_MARKER } from "../src/worker-post.ts";

const log = missionControlLog();
const lastSeq = log[log.length - 1]!.seq;
const revOneSeq = log.find((m) => m.type === "integrated.rev")!.seq;

function render(props: Partial<Parameters<typeof MissionControl>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(MissionControl, { log, escalations: [], busy: false, onResolve: () => {}, ...props }),
  );
}

const records: BoardEscalationRecord[] = [
  {
    id: "esc-1",
    kind: "decision",
    question: "Board contest contest-29: ag-5 and ag-3 both need write access. Which agent keeps it?",
    options: ["ag-3", "ag-5"],
    status: "pending",
    raisedAt: "t",
    boardContest: "contest-29",
  },
  {
    id: "esc-2",
    kind: "decision",
    path: "test/users.test.js",
    question:
      "Board contract k1: an agent asks to modify test/users.test.js. Accept or reject?\nAdvisory triage (a typed decision; the human decides): accept (confidence 0.86)",
    options: ["accept", "reject"],
    status: "pending",
    raisedAt: "t",
    boardContract: "k1",
    recommendation: "accept (confidence 0.86)",
  },
];

describe("mission control at the live head", () => {
  const markup = render({ escalations: records });

  it("shows the ticker: goal, latest revision gate, rebasing agents, agent count, advisory Jev summary", () => {
    expect(markup).toContain("Reject unauthenticated and invalid requests on every resource");
    expect(markup).toContain("rev 2 [GATE PASS]");
    expect(markup).toContain("rebasing: ag-3");
    expect(markup).toContain("7/7 agents");
    expect(markup).toContain("jev: 3 call(s), 3 accepted, 0 error(s) (advisory)");
    expect(markup).toContain("LIVE");
  });

  it("lays out the four board columns and the full-width panes", () => {
    for (const title of ["CONTESTED", "OPEN", "CLAIMED", "DONE", "GRAPH", "THREAD", "NODE", "TOOLS"]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain('aria-label="Board graph"');
    expect(markup).toContain('aria-label="Replay"');
  });

  it("pins the escalations with the Jev recommendation as advisory, and the buttons enabled", () => {
    expect(markup).toContain("Awaiting you");
    expect(markup).toContain("Jev recommends accept (confidence 0.86)");
    expect(markup).toContain("advisory: you decide");
    // The triage line is not repeated inside the question.
    expect(markup).not.toContain("Advisory triage (a typed decision");
    expect(markup).toMatch(/<button type="button">ag-3<\/button>/);
    expect(markup).toMatch(/<button type="button">accept<\/button>/);
  });

  it("ends graph tooltips with their backing seq and type, and draws the hollow done check", () => {
    expect(markup).toMatch(/<title>item auth: [^<]*done proposed \(not yet on a passing revision\)[^<]*\(seq \d+, item\.proposed\)<\/title>/);
    expect(markup).toContain('class="mc-check is-hollow"');
    expect(markup).toContain('class="mc-check is-filled"');
    expect(markup).toContain(" used x3</tspan>");
  });

  it("shows gate verdicts only on revisions and the ticker, and Jev as grey advisory chips", () => {
    expect(markup).toContain("contract-triage (advisory)");
    // Outside the revision hexagons, the ticker, and the thread (where a row IS the integrated.rev message).
    const outsideRevs = markup
      .replace(/<g class="mc-node kind-rev[\s\S]*?<\/g>/g, "")
      .replace(/<div class="mc-ticker"[\s\S]*?<\/div>/, "")
      .replace(/<div class="mc-right"[\s\S]*?<div class="mc-replay"/, "");
    expect(outsideRevs).not.toMatch(/GATE (PASS|FAIL)/);
    expect(markup).not.toMatch(/correct/i);
  });
});

describe("escalation cards", () => {
  const model = buildBoardGraph(log);

  it("are answerable only when following live with a pending record", () => {
    const live = escalationCards(model, records, true);
    expect(live.map((c) => [c.id, c.kind, c.seq])).toEqual([
      ["esc-1", "contest", log.find((m) => m.type === "claim.escalated")!.seq],
      ["esc-2", "contract", log.find((m) => m.type === "contract.escalated")!.seq],
    ]);
    const replay = escalationCards(model, records, false);
    expect(replay.every((c) => c.id === undefined && c.note === "replaying: answer from the live view")).toBe(true);
    const noRecord = escalationCards(model, [], true);
    expect(noRecord.map((c) => c.note)).toEqual(["waiting for the escalation record", "waiting for the escalation record"]);
  });

  function buttons(node: ReactNode, out: ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>[] = []) {
    if (Array.isArray(node)) {
      node.forEach((child) => buttons(child, out));
    } else if (isValidElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>(node)) {
      if (node.type === "button") out.push(node);
      buttons(node.props.children, out);
    }
    return out;
  }

  it("calls onResolve with the escalation id and the chosen option", () => {
    const calls: [string, string][] = [];
    const card = escalationCards(model, records, true)[1]!;
    const tree = EscalationCard({ card, busy: false, onResolve: (id, decision) => void calls.push([id, decision]) });
    const options = buttons(tree).filter((b) => b.props.children === "accept" || b.props.children === "reject");
    expect(options.map((b) => b.props.disabled)).toEqual([false, false]);
    options[1]!.props.onClick!();
    expect(calls).toEqual([["esc-2", "reject"]]);
  });

  it("disables the buttons of a card that cannot be answered from here", () => {
    const calls: string[] = [];
    const card = escalationCards(model, [], false)[0]!;
    const tree = EscalationCard({ card, busy: false, onResolve: (id) => void calls.push(id) });
    const options = buttons(tree).filter((b) => b.props.children === "ag-3");
    expect(options[0]!.props.disabled).toBe(true);
    options[0]!.props.onClick!();
    expect(calls).toEqual([]);
  });

  it("posts the decision through the launcher proxy to the resolve route (fetch faked)", async () => {
    const seen: { url: string; body: string }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: String(init?.body ?? "") });
      return new Response("{}", { status: 200, headers: { [WORKER_PROXY_MARKER]: "1" } });
    };
    const res = await resolveEscalation(fetchFn, "http://w", "c 1", "esc-1", "ag-3");
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ url: "/api/worker/changes/c%201/escalations/esc-1/resolve", body: '{"decision":"ag-3"}' }]);
  });

  it("falls back to the Worker directly when there is no proxy", async () => {
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      return url.startsWith("/api/") ? new Response("", { status: 404 }) : new Response("{}", { status: 200 });
    };
    await resolveEscalation(fetchFn, "http://w", "c", "esc-2", "reject");
    expect(seen).toEqual(["/api/worker/changes/c/escalations/esc-2/resolve", "http://w/changes/c/escalations/esc-2/resolve"]);
  });
});

describe("replay", () => {
  it("renders the board at K as the live board was at K", () => {
    for (const k of [1, 20, revOneSeq, 40, lastSeq]) {
      const replayed = buildBoardGraph(log, k);
      const live = buildBoardGraph(boardPrefix(log, k));
      const pane = (model: typeof replayed) =>
        renderToStaticMarkup(
          createElement(BoardPane, { model, cards: [], selection: null, busy: false, onSelect: () => {}, onResolve: () => {} }),
        );
      expect(pane(replayed)).toBe(pane(live));
      const ticker = (model: typeof replayed) =>
        renderToStaticMarkup(createElement(Ticker, { ticker: model.ticker, live: true, k, lastSeq: k }));
      expect(ticker(replayed)).toBe(ticker(live));
    }
  });

  it("shows the replay cursor and the board as of that seq", () => {
    const markup = render({ initialSeq: revOneSeq, escalations: records });
    expect(markup).toContain(`replay: seq ${revOneSeq}/${lastSeq}`);
    expect(markup).toContain("rev 1 [GATE FAIL]");
    expect(markup).not.toContain("rev 2 [GATE PASS]");
    expect(markup).toContain("go live");
    // While replaying, the escalation card is read-only.
    expect(markup).toContain("replaying: answer from the live view");
  });
});

describe("honesty labels", () => {
  it('reads "no gate: nothing checked" for an ungated revision, never a pass', () => {
    const markup = render({ log: ungatedLog() });
    expect(markup).toContain("rev 1 [no gate: nothing checked]");
    expect(markup).not.toContain("GATE PASS");
  });

  it("lists the tool registry: capability, version, kind, builder, its own gate's evidence, and who used it", () => {
    const model = buildBoardGraph(log);
    const markup = renderToStaticMarkup(createElement(ToolsRegistry, { model }));
    expect(markup).toContain("<th>Capability</th>");
    expect(markup).toContain("<strong>scan-unguarded-routes</strong>");
    expect(markup).toContain("v1 (t00l001)");
    expect(markup).toContain("<td>scanner</td>");
    expect(markup).toContain("<td>ag-4</td>");
    expect(markup).toMatch(/passed: tests ok, finds ok \(seq \d+\)/);
    expect(markup).toContain("ag-1 x1, ag-2 x2");
    const tool = model.nodes.find((n) => n.kind === "tool")!;
    const detail = renderToStaticMarkup(createElement(BoardNodeDetail, { node: tool }));
    expect(detail).toContain("Tool gate evidence");
    expect(detail).toContain("finds: ok - found 4 place(s) in 4 file(s) on the baseline");
  });

  it("describes a resolved attribution as where the pick landed, advisory", () => {
    const model = buildBoardGraph(log);
    const jev = model.nodes.find((n) => n.kind === "jev" && n.label === "attribution")!;
    const markup = renderToStaticMarkup(createElement(BoardNodeDetail, { node: jev }));
    expect(markup).toContain("Jev picked orders; orders changed before the next pass");
    expect(markup).toContain("Advisory only");
    expect(markup).not.toMatch(/correct/i);
  });

  it("shows a thread as typed messages with sender chips, quoted rationale, and linked seqs", () => {
    const messages = log.filter((m) => m.type === "help.requested" || m.type === "help.offered");
    const markup = renderToStaticMarkup(
      createElement(Thread, { messages, title: "t", selectedSeq: null, onSelectSeq: () => {}, onSelectAgent: () => {} }),
    );
    expect(markup).toContain(`seq ${messages[0]!.seq}`);
    expect(markup).toContain(`re seq ${messages[0]!.seq}`);
    expect(markup).toContain("<q class=\"mc-rationale\">need the auth contract before I guard users</q>");
    expect(markup).toContain('class="mc-sender sender-agent"');
  });
});

describe("board polling", () => {
  function page(messages: readonly BoardMessage[], hasMore: boolean, last = lastSeq): Response {
    return new Response(JSON.stringify({ lastSeq: last, messages, hasMore }), { status: 200 });
  }

  it("pages through the backlog after the last seq and keeps the full log", async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(url);
      const after = Number(new URL(url).searchParams.get("after"));
      const rest = log.filter((m) => m.seq > after);
      return page(rest.slice(0, 25), rest.length > 25);
    };
    const first = await pullBoard(fetchFn, "http://w", "c", []);
    expect(first.status).toBe("ok");
    expect(first.log).toEqual(log);
    expect(urls).toEqual([
      "http://w/changes/c/board?after=0&limit=1000",
      "http://w/changes/c/board?after=25&limit=1000",
      "http://w/changes/c/board?after=50&limit=1000",
    ]);
    urls.length = 0;
    const again = await pullBoard(fetchFn, "http://w", "c", first.log);
    expect(again.log).toBe(first.log);
    expect(urls).toEqual([`http://w/changes/c/board?after=${lastSeq}&limit=1000`]);
  });

  it("reports a missing board quietly and restarts after a board reset", async () => {
    expect((await pullBoard(async () => new Response("{}", { status: 404 }), "http://w", "c", [])).status).toBe("missing");
    const fetchFn = async (url: string) => {
      const after = Number(new URL(url).searchParams.get("after"));
      return after > 0 ? page([], false, 3) : page(log.slice(0, 3), false, 3);
    };
    const reset = await pullBoard(fetchFn, "http://w", "c", log);
    expect(reset.log.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("merges only contiguous messages", () => {
    const head = log.slice(0, 5);
    expect(mergeBoardLog(head, [log[6]!])).toBe(head);
    expect(mergeBoardLog(head, [log[4]!, log[5]!, log[7]!]).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("launching a board run", () => {
  const serviceApi = templateById("service-api")!;
  const auditLogging = templateById("audit-logging")!;
  const dial = { min: 1, max: 3 };

  it("runs run-board with the same template's goal, project, and gate", () => {
    const args = runBoardArgs(serviceApi, "console-x", dial, "console");
    expect(args.slice(0, 6)).toEqual(["-w", "apps/cli", "run", "dev", "--", "run-board"]);
    expect(args.join(" ")).toContain("examples/goals/service-api-validation-auth.goal.txt");
    expect(args.join(" ")).toContain("--project");
    expect(args).toContain("--gate");
    expect(args).toContain("--watch");
    expect(args).not.toContain("--decide-contracts");
  });

  it("runs audit-logging on the board from its goal file and project, while run-live keeps its Change spec", () => {
    const board = runBoardArgs(auditLogging, "x", dial, "console").join(" ");
    expect(board).toContain("run-board");
    expect(board).toContain("examples/goals/audit-logging.goal.txt");
    expect(board).toContain("examples/demo-project");
    expect(board).toContain("--gate");
    expect(board).not.toContain("audit-logging.change.yaml");
    const live = launchArgs(auditLogging, "x", dial, { mode: "live", contractPolicy: "console" }).join(" ");
    expect(live).toContain("run-live");
    expect(live).toContain("examples/changes/audit-logging.change.yaml");
  });

  it("passes --decide-contracts only for an automatic policy", () => {
    expect(runBoardArgs(serviceApi, "x", dial, "accept").slice(-2)).toEqual(["--decide-contracts", "accept"]);
    expect(runBoardArgs(serviceApi, "x", dial, "reject").slice(-2)).toEqual(["--decide-contracts", "reject"]);
  });

  it("validates the launch body: a board launch needs a goal template; unknown values are refused", () => {
    expect(launchOptionsFromBody({}, serviceApi)).toEqual({ ok: true, options: { mode: "live", contractPolicy: "console" } });
    expect(launchOptionsFromBody({ mode: "board", decideContracts: "accept" }, serviceApi)).toEqual({
      ok: true,
      options: { mode: "board", contractPolicy: "accept" },
    });
    const specOnly = { ...auditLogging, boardGoalFile: undefined };
    expect(launchOptionsFromBody({ mode: "board" }, specOnly)).toMatchObject({ ok: false });
    expect(launchOptionsFromBody({ mode: "board" }, auditLogging)).toMatchObject({ ok: true });
    expect(launchOptionsFromBody({ mode: "rm -rf" }, serviceApi)).toMatchObject({ ok: false });
    expect(launchOptionsFromBody({ mode: "board", decideContracts: "maybe" }, serviceApi)).toMatchObject({ ok: false });
    expect(launchOptionsFromBody({ decideContracts: "accept" }, serviceApi)).toMatchObject({ ok: false });
  });

  it("keeps run-live launches unchanged", () => {
    const args = launchArgs(serviceApi, "x", dial, { mode: "live", contractPolicy: "console" });
    expect(args[5]).toBe("run-live");
  });

  it("detects a board run from the launch mode or a non-empty board summary", () => {
    expect(isBoardRun("board", null)).toBe(true);
    expect(isBoardRun("live", { board: { messages: 0 } })).toBe(false);
    expect(isBoardRun(null, { board: { messages: 4 } })).toBe(true);
    expect(isBoardRun(null, null)).toBe(false);
  });
});

describe("real-run naming (agent-N, lead, planner unit ids)", () => {
  function realShapedLog(): BoardMessage[] {
    const b = new FixtureBoard();
    b.human({ type: "goal.posted", payload: { objective: "guard every resource", rules: { maxContestTurns: 3, contestIdleMessages: 25 } } });
    b.join("lead", "lead");
    const units = ["unit-users-auth-validate", "unit-orders-auth-validate", "unit-search-auth-validate"];
    for (const [i, item] of units.entries()) {
      b.agent("lead", {
        type: "item.proposed",
        payload: { item, objective: `guard ${item}`, acceptance: [], scopeHint: [`src/r${i}.js`] },
      });
    }
    for (const [i, item] of units.entries()) {
      b.join(`agent-${i + 1}`);
      b.agent(`agent-${i + 1}`, { type: "item.claimed", payload: { item, intent: { read: [], write: [`src/r${i}.js`] } } });
    }
    return b.log;
  }

  it("shortens planner ids by dropping unit- and the tokens every id shares, keeping the full id in the tooltip", () => {
    expect([...boardShortLabels(["unit-users-auth-validate", "unit-orders-auth-validate", "unit-search-auth-validate"]).values()]).toEqual([
      "users",
      "orders",
      "search",
    ]);
    expect(boardShortLabels(["unit-users-auth-validate"]).get("unit-users-auth-validate")).toBe("users-auth-validate");
    expect(boardShortLabels(["users", "orders"]).get("orders")).toBe("orders");
    expect(boardShortLabels(["unit-a-very-long-planner-unit-identifier-x", "unit-b"]).get("unit-a-very-long-planner-unit-identifier-x")).toBe(
      "a-very-long-planner-u...",
    );
    expect(agentShortLabel("agent-12")).toBe("agent-12");
    expect(agentShortLabel("an-unusually-long-agent-id")).toBe("an-unusually-...");
  });

  it("shortens real live ids: u-/unit-/item- prefixes, commons over the SEED items only, agent-proposed ids left whole", () => {
    const seeds = ["u-users-validate-auth", "u-orders-validate-auth", "u-notifications-validate-auth"];
    const ids = [...seeds, "agent-2-item-1"];
    const labels = boardShortLabels(ids, { seeds });
    expect(ids.map((id) => labels.get(id))).toEqual(["users", "orders", "notifications", "agent-2-item-1"]);
    // Without the seed set, the agent-proposed id would block every common token.
    expect(boardShortLabels(ids).get("u-users-validate-auth")).toBe("users-validate-auth");
    // Mixed short prefixes still share their commons.
    const mixed = boardShortLabels(["unit-users-guard", "item-orders-guard", "u-search-guard"]);
    expect([...mixed.values()]).toEqual(["users", "orders", "search"]);
    // A single seed keeps its body; two ids never collapse to one label.
    expect(boardShortLabels(["u-users-validate-auth"]).get("u-users-validate-auth")).toBe("users-validate-auth");
    const clash = boardShortLabels(["unit-a-x", "item-a-x", "u-b-x"], { seeds: ["unit-a-x", "item-a-x", "u-b-x"] });
    expect(new Set(clash.values()).size).toBe(3);
  });

  it("the hull header ellipsizes the title to the width left of the status badge (no overlap at any status)", () => {
    for (const boost of [1, 1.6]) {
      for (const status of ["open", "contested / fix 2", "proposed"]) {
        for (const width of [180, 260, 420]) {
          const header = hullHeader({ title: "notifications-validate-auth-and-rate-limit", status, width, boost });
          const titleRight = 14 + header.title.length * HULL_TITLE_FONT * boost * 0.62;
          expect(titleRight).toBeLessThanOrEqual(header.badge.x);
          expect(header.badge.w).toBeGreaterThanOrEqual(header.status.length * HULL_STATUS_FONT * boost * 0.62);
          expect(header.badge.x + header.badge.w).toBeLessThanOrEqual(width);
          expect(header.title.length).toBeGreaterThan(0);
        }
      }
    }
    expect(hullHeader({ title: "users", status: "open", width: 400 }).title).toBe("users");
    expect(ellipsizeToWidth("abcdefghijklmnop", 10 * 15 * 0.62, 15)).toBe("abcdefg...");
  });

  it("renders the status as a badge, a long title ellipsized, and a worker's proposal in the PROPOSED column", () => {
    const b = new FixtureBoard();
    b.human({ type: "goal.posted", payload: { objective: "guard every resource", rules: { maxContestTurns: 3, contestIdleMessages: 25 } } });
    b.join("lead", "lead");
    const seeds = ["u-users-validate-auth", "u-notifications-validate-auth-and-rate-limiting-for-every-route"];
    for (const [i, item] of seeds.entries()) {
      b.agent("lead", { type: "item.proposed", payload: { item, objective: `guard ${item}`, acceptance: [], scopeHint: [`src/r${i}.js`] } });
    }
    b.join("agent-2");
    b.agent("agent-2", { type: "item.proposed", payload: { item: "agent-2-item-1", objective: "more", acceptance: [], scopeHint: ["src/x.js"] } });
    const markup = render({ log: b.log });
    expect(markup).toMatch(/<text class="mc-hull-title"[^>]*>users-validate[^<]*<\/text>/);
    expect(markup).toMatch(/<text class="mc-hull-title"[^>]*>agent-2-item-1<\/text>/);
    expect(markup).toMatch(/<rect class="mc-hull-badge"/);
    expect(markup).toMatch(/<text class="mc-hull-status"[^>]*text-anchor="middle"[^>]*>proposed<\/text>/);
    const long = /<text class="mc-hull-title"[^>]*>(notif[^<]*)<\/text>/.exec(markup)![1]!;
    expect(long.endsWith("...")).toBe(true);
    expect(markup).toContain("PROPOSED");
  });

  it("renders a real-shaped board with short hull titles, agent-N labels, and the lead", () => {
    const markup = render({ log: realShapedLog() });
    expect(markup).toMatch(/<text class="mc-hull-title"[^>]*>users<\/text>/);
    expect(markup).toMatch(/<text class="mc-hull-title"[^>]*>search<\/text>/);
    expect(markup).toContain(">agent-2</text>");
    expect(markup).toContain('aria-label="lead lead (free)"');
    expect(markup).toContain("item unit-orders-auth-validate: guard unit-orders-auth-validate");
    expect(markup).toContain('<span class="mc-card-title">orders</span>');
  });
});

describe("captions", () => {
  const model = buildBoardGraph(log, 31);
  const layout = boardLayout(log);
  const points = new Map<string, BoardPoint>();
  for (const node of model.nodes) {
    const p = boardNodePoint(layout, node);
    if (p) points.set(node.id, p);
  }
  const captions = [
    { seq: 31, node: "agent:ag-5", text: 'claim.kept: "search cannot ship without it"' },
    { seq: 30, node: "agent:ag-3", text: 'claim.kept: "I am mid-edit on http.js"' },
    { seq: 28, node: "agent:ag-5", text: "item.claimed" },
    { seq: 27, node: "agent:ag-3", text: "a fourth is never shown" },
  ];

  it("places at most three, above their senders, clear of hull title bars and of each other", () => {
    for (const scale of [1, 1.5]) {
      const placed = placeCaptions(captions, points, layout, scale);
      expect(placed.map((c) => c.seq)).toEqual([31, 30, 28]);
      const boxes = placed.map((c) => ({ x: c.x - c.w / 2, y: c.y, w: c.w, h: c.h }));
      const bars = [...layout.items.values()].map((r) => ({ x: r.x, y: r.y, w: r.w, h: HULL_TITLE_H }));
      const hit = (a: (typeof boxes)[0], b: (typeof boxes)[0]) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      for (const [i, box] of boxes.entries()) {
        expect(bars.some((bar) => hit(box, bar))).toBe(false);
        expect(boxes.some((other, j) => j !== i && hit(box, other))).toBe(false);
        expect(box.y + box.h).toBeLessThanOrEqual(points.get(captions[i]!.node)!.y);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
      }
    }
  });

  it("keeps labels at their minimum on-screen size when the drawing is scaled down, within a cap", () => {
    expect(textBoost(1)).toBe(1);
    expect(textBoost(2)).toBe(1);
    expect(textBoost(0.8)).toBeCloseTo(1.25);
    expect(textBoost(0.2)).toBe(1.8);
    expect(textBoost(Number.NaN)).toBe(1);
  });
});

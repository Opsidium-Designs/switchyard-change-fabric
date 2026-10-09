/**
 * Formation on the offline board, on exactly the inputs `make demo-board` runs
 * (the goal files and example projects, the generic policy, the offline
 * fixture gate, contract changes rejected):
 *   - fork-based help: an owner whose codemod pushed several files grants one
 *     of them to a helper; the helper's repo is a FORK of the requester's repo
 *     at its latest announced push, it delivers a commit there, and the
 *     requester pulls that commit (a fast-forward: it descends from the
 *     requester's own push) before announcing; the fork is archived at cleanup;
 *   - a split with a sub-lead: an owner splits a discovered item, other
 *     agents claim the children, their pushes integrate only through the
 *     sub-lead's merged push, and the parent completes when that push passes;
 *   - tool timing: the seeded codemod is used on at least two items before
 *     any hand edit of them.
 * No network, deterministic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { reduceBoard, type BoardMessage } from "@switchyard-change/change-core";

import { assertBoardBacked, buildBoardGraph } from "../src/board-graph.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { codemodTiming, formatBoardRunSummary, formatBoardTranscript } from "../src/run-board.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const reject = async () => "reject" as const;
const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

/** One `make demo-board` run, offline. */
function demo(goalFile: string, project: string) {
  return runBoardOffline({
    goal: readFileSync(join(ROOT, "examples", "goals", goalFile), "utf8"),
    projectDir: join(ROOT, ...project.split("/")),
    fixtureGate: true,
    replacesDeclaredGate: ["npm", "run", "gate"],
    resolveContract: reject,
  });
}

describe("formation on the demo-board inputs (offline, deterministic)", () => {
  it("fork-based help: the helper forks the requester's repo at its push, delivers, and the requester pulls before announcing", async () => {
    const result = await demo("audit-logging.goal.txt", "examples/demo-project");
    const log = result.log;
    const requested = of(log, "help.requested").find((m) => m.payload.scope !== undefined)!;
    expect(requested).toBeDefined();
    const requester = requested.from;
    // Granted inside the requester's write intent, after its codemod pushed the item.
    const codemodPush = of(log, "push.announced").filter((m) => m.from === requester && m.payload.item === requested.payload.item && m.seq < requested.seq).at(-1)!;
    expect(of(log, "tool.used").some((u) => u.payload.commit === codemodPush.payload.commit)).toBe(true);

    const offered = of(log, "help.offered").find((m) => m.payload.request === requested.payload.request && m.payload.forkOf !== undefined)!;
    const helper = offered.from;
    expect(helper).not.toBe(requester);
    // The fork starts from the requester's latest announced push (fork lineage on the board).
    const requesterHead = of(log, "push.announced").filter((m) => m.from === requester && m.seq < offered.seq).at(-1)!;
    expect(offered.payload).toMatchObject({ forkOf: requester, forkCommit: requesterHead.payload.commit, fork: `${result.changeId}--help-${requested.payload.request}` });
    expect(offered.to).toEqual([requester]);

    const delivered = of(log, "help.delivered").find((m) => m.payload.request === requested.payload.request)!;
    expect(delivered.from).toBe(helper);
    expect(delivered.payload.paths).toEqual(requested.payload.scope);
    const pulled = of(log, "push.announced").find((m) => (m.payload.pulled ?? []).includes(requested.payload.request))!;
    expect(pulled.from).toBe(requester);
    // A fast-forward: the helper's commit descends from the requester's push.
    expect(pulled.payload.commit).toBe(delivered.payload.commit);
    // Done is proposed only after the pull, and the pulled push is what passed.
    const done = of(log, "done.proposed").find((m) => m.payload.item === requested.payload.item)!;
    expect(done.seq).toBeGreaterThan(pulled.seq);
    expect(result.state.items[requested.payload.item]).toMatchObject({ status: "done", lastPush: { commit: pulled.payload.commit } });

    // The fork is archived at cleanup with the agents' repos.
    expect(result.cleanedUp).toContain(offered.payload.fork);
    // The codemod was used on at least two items before any hand edit of them.
    const timing = codemodTiming(log, result.state);
    expect(timing).toHaveLength(1);
    expect(timing[0]!.early.length).toBeGreaterThanOrEqual(2);
    expect(timing[0]!.handFirst).toEqual([]);

    const summary = formatBoardRunSummary(result);
    expect(summary).toMatch(new RegExp(`help ${requested.payload.request} on ${requested.payload.item} .*${helper} forked ${requester}'s repo at ${requesterHead.payload.commit.slice(0, 10)}.*${requester} pulled it`));
    expect(summary).toMatch(/tool timing: codemod \S+ changed [2-9] item\(s\) before any hand edit of them/);
    expect(formatBoardTranscript(log)).toMatch(/help\.offered\s+\S+: forked \S+'s repo at [0-9a-f]{10}/);
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(log)).toEqual(result.state);
    // The console graph draws the fork lineage, backed by the help.offered seq.
    const graph = buildBoardGraph(log);
    expect(graph.edges.find((e) => e.id === `fork:${requested.payload.request}`)).toMatchObject({ kind: "dependency", label: "fork", seqs: [offered.seq] });
    assertBoardBacked(graph, log);
  });

  it("a split with a sub-lead: children claimed by others integrate only through the sub-lead's one push; the parent completes after it passes", async () => {
    const result = await demo("service-api-validation-auth.goal.txt", "examples/apps/service-api");
    const log = result.log;
    const split = of(log, "item.split")[0]!;
    expect(split).toBeDefined();
    const subLead = split.from;
    const parent = split.payload.item;
    const children = split.payload.children.map((c) => c.item);
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(result.state.items[parent]).toMatchObject({ status: "done", subLead, completed: { via: "children" } });
    // Other agents claimed the children.
    const claimers = children.map((c) => of(log, "claim.granted").find((g) => g.payload.item === c)!.payload.agent);
    expect(claimers.every((a) => a !== subLead)).toBe(true);
    // The sub-lead merged them into its own pushes for the parent...
    const merges = of(log, "push.announced").filter((m) => m.payload.item === parent);
    expect(merges.every((m) => m.from === subLead && (m.payload.merges ?? []).length > 0)).toBe(true);
    expect(new Set(merges.flatMap((m) => m.payload.merges!.map((x) => x.item)))).toEqual(new Set(children));
    // ...and no revision ever merged a child's push directly.
    const childCommits = new Set(of(log, "push.announced").filter((m) => children.includes(m.payload.item)).map((m) => m.payload.commit));
    expect(of(log, "integrated.rev").flatMap((r) => r.payload.merged).some((c) => childCommits.has(c))).toBe(false);
    // The parent completes only once the last child does, citing the passing revision.
    const completions = of(log, "item.completed");
    const parentDone = completions.find((m) => m.payload.item === parent)!;
    expect(completions.filter((m) => children.includes(m.payload.item)).every((m) => m.seq < parentDone.seq)).toBe(true);
    expect(formatBoardRunSummary(result)).toMatch(new RegExp(`split ${parent.replace(/\./g, "\\.")} \\(seq ${split.seq}\\): ${subLead} is its sub-lead`));
    expect(codemodTiming(log, result.state)[0]!.early.length).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(log)).toEqual(result.state);
    const graph = buildBoardGraph(log);
    expect(graph.edges.filter((e) => e.label === "merged").map((e) => e.to)).toEqual(expect.arrayContaining([`item:${parent}`]));
  });

  it("a struggling owner's cue brings volunteers: one is granted a scope, forks, delivers, and is pulled; the other is declined; bounded", async () => {
    const result = await demo("audit-logging.goal.txt", "examples/demo-project");
    const log = result.log;
    const offers = of(log, "help.volunteered");
    expect(offers.length).toBeGreaterThan(0);
    const owner = offers[0]!.to![0]!;
    const item = offers[0]!.payload.item;
    const report = of(log, "item.struggling").find((m) => m.payload.item === item && m.from === owner && m.seq < offers[0]!.seq)!;
    expect(report).toBeDefined();
    // The grant answering a volunteer is addressed to it; it forks, delivers, the owner pulls.
    const grant = of(log, "help.requested").find((m) => m.payload.item === item && m.from === owner && m.payload.scope !== undefined && m.seq > report.seq)!;
    const volunteer = grant.to![0]!;
    expect(offers.map((o) => o.from)).toContain(volunteer);
    const fork = of(log, "help.offered").find((m) => m.payload.request === grant.payload.request && m.payload.forkOf === owner)!;
    expect(fork.from).toBe(volunteer);
    expect(of(log, "help.delivered").some((m) => m.payload.request === grant.payload.request && m.from === volunteer)).toBe(true);
    expect(of(log, "push.announced").some((m) => m.from === owner && (m.payload.pulled ?? []).includes(grant.payload.request))).toBe(true);
    // Every other volunteer on the item is declined; nothing storms.
    for (const other of offers.filter((o) => o.from !== volunteer && o.payload.item === item)) {
      expect(of(log, "help.declined").some((m) => m.payload.volunteer === other.from && m.payload.item === item)).toBe(true);
    }
    const perKey = new Map<string, number>();
    for (const o of offers) perKey.set(`${o.from}:${o.payload.item}`, (perKey.get(`${o.from}:${o.payload.item}`) ?? 0) + 1);
    expect(Math.max(...perKey.values())).toBeLessThanOrEqual(2);
    const reports = new Map<string, number>();
    for (const r of of(log, "item.struggling")) reports.set(`${r.from}:${r.payload.item}`, (reports.get(`${r.from}:${r.payload.item}`) ?? 0) + 1);
    expect(Math.max(...reports.values())).toBeLessThanOrEqual(3);
    expect(result.state.items[item]).toMatchObject({ status: "done" });
    expect(result.verdict).toBe("verified");
    const graph = buildBoardGraph(log, report.seq);
    expect(graph.nodes.find((n) => n.id === `item:${item}`)!.detail).toMatchObject({ kind: "item", struggling: { reason: report.payload.reason } });
  });

  it("is deterministic: the formation run repeats byte for byte", async () => {
    const first = await demo("audit-logging.goal.txt", "examples/demo-project");
    const second = await demo("audit-logging.goal.txt", "examples/demo-project");
    expect(formatBoardTranscript(second.log)).toBe(formatBoardTranscript(first.log));
    expect(second.log).toEqual(first.log);
  });
});

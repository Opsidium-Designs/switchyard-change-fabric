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

import { awaitingSubLead, reduceBoard, type BoardDigest, type BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport, ExecutorContext } from "@switchyard-change/model-adapters";

import { createGenericBoardPolicy } from "../src/board-policy.ts";

import { assertBoardBacked, buildBoardGraph } from "../src/board-graph.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { codemodTiming, formatBoardRunSummary, formatBoardTranscript } from "../src/run-board.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const reject = async () => "reject" as const;
const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T) =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);

/** One `make demo-board` run, offline (optionally with another turn transport). */
function demo(goalFile: string, project: string, transport?: AgentTurnTransport<BoardDigest, BoardMessage>) {
  return runBoardOffline({
    goal: readFileSync(join(ROOT, "examples", "goals", goalFile), "utf8"),
    projectDir: join(ROOT, ...project.split("/")),
    fixtureGate: true,
    replacesDeclaredGate: ["npm", "run", "gate"],
    resolveContract: reject,
    ...(transport ? { transport } : {}),
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

  it("a sub-lead that waits instead of merging its children's pushes is cued to pull: the merge lands and the run never ends with pushes awaiting it", async () => {
    // The generic policy, except every sub-lead answers its first merge with a wait.
    const policy = createGenericBoardPolicy();
    const waited = new Set<string>();
    const cued: string[] = [];
    const transport: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      if (input.capsule.evidence.some((e) => e.startsWith("SUB-LEAD MERGE DUE: pull {itemId: "))) {
        cued.push(input.agent);
      }
      const outcome = await policy(input);
      const action = outcome.action as { type: string; itemId?: string; requestId?: string };
      if (action.type === "pull" && action.requestId === undefined && !waited.has(input.agent)) {
        waited.add(input.agent);
        return { action: { type: "wait", reason: "the children may push again; merging later" } };
      }
      return outcome;
    };
    const result = await demo("service-api-validation-auth.goal.txt", "examples/apps/service-api", transport);
    const log = result.log;
    const split = of(log, "item.split")[0]!;
    expect(split).toBeDefined();
    expect(waited.has(split.from)).toBe(true);
    expect(cued).toContain(split.from);
    // The sub-lead's merge still landed, and the parent completed.
    expect(of(log, "push.announced").some((m) => m.from === split.from && m.payload.item === split.payload.item && (m.payload.merges ?? []).length > 0)).toBe(true);
    expect(result.state.items[split.payload.item]).toMatchObject({ status: "done" });
    expect(awaitingSubLead(result.state)).toEqual([]);
    expect(result.stopReason === "quiescent" && awaitingSubLead(result.state).length > 0).toBe(false);
    expect(result.verdict).toBe("verified");
    expect(result.incompleteItems).toEqual([]);
    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("a struggling owner's cue brings a volunteer: granted a scope, it forks, delivers, and is pulled; bounded", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { dirname } = await import("node:path");
    const { ScopedNoopExecutor } = await import("@switchyard-change/model-adapters");
    const dir = await mkdtemp(join(tmpdir(), "scf-volunteer-"));
    for (const [rel, body] of Object.entries({
      "package.json": '{"name":"p","type":"module","scripts":{}}\n',
      "src/api/handler.ts": "export const handler = 1;\n",
      "src/api/extra.ts": "export const extra = 1;\n",
      "src/core/a.ts": "export const a = 1;\n",
    })) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
    // The owner's first two edits of "api" fail (the executor returns no edit): it struggles.
    const inner = new ScopedNoopExecutor();
    let apiCalls = 0;
    const executor = {
      name: "flaky",
      async execute(context: ExecutorContext) {
        if (context.workUnitId === "api" && apiCalls++ < 2) {
          throw new Error("the model returned no usable edit");
        }
        return inner.execute(context);
      },
    };
    const result = await runBoardOffline({
      goal: "report status",
      projectDir: dir,
      resolveContract: reject,
      executor,
      seed: async () => ({
        source: "planner",
        model: "fake",
        items: [
          { item: "core", objective: "report status from core", acceptance: ["gate passes"], scopeHint: ["src/core/**"] },
          { item: "api", objective: "report status from the api", acceptance: ["gate passes"], scopeHint: ["src/api/**"] },
        ],
      }),
    });
    const log = result.log;
    const report = of(log, "item.struggling").find((m) => m.payload.item === "api" && m.payload.reason === "failed-edits")!;
    expect(report).toBeDefined();
    const offer = of(log, "help.volunteered").find((m) => m.payload.item === "api" && m.seq > report.seq)!;
    expect(offer.to).toEqual([report.from]);
    const grant = of(log, "help.requested").find((m) => m.payload.item === "api" && (m.to ?? []).includes(offer.from))!;
    expect(grant.payload.scope).toEqual(["src/api/handler.ts"]);
    const fork = of(log, "help.offered").find((m) => m.payload.request === grant.payload.request && m.payload.forkOf === report.from)!;
    expect(fork.from).toBe(offer.from);
    expect(of(log, "help.delivered").some((m) => m.payload.request === grant.payload.request)).toBe(true);
    expect(of(log, "push.announced").some((m) => (m.payload.pulled ?? []).includes(grant.payload.request))).toBe(true);
    // Bounded: at most 2 offers per agent and item, 3 reports per owner and item.
    const offers = new Map<string, number>();
    for (const o of of(log, "help.volunteered")) offers.set(`${o.from}:${o.payload.item}`, (offers.get(`${o.from}:${o.payload.item}`) ?? 0) + 1);
    expect(Math.max(...offers.values())).toBeLessThanOrEqual(2);
    expect(of(log, "item.struggling").filter((r) => r.payload.item === "api").length).toBeLessThanOrEqual(3);
    expect(result.state.items.api).toMatchObject({ status: "done" });
    expect(formatBoardRunSummary(result)).toMatch(/volunteer \S+ on api .*granted src\/api\/handler\.ts/);
    expect(reduceBoard(log)).toEqual(result.state);
  });

  it("is deterministic: the formation run repeats byte for byte", async () => {
    const first = await demo("audit-logging.goal.txt", "examples/demo-project");
    const second = await demo("audit-logging.goal.txt", "examples/demo-project");
    expect(formatBoardTranscript(second.log)).toBe(formatBoardTranscript(first.log));
    expect(second.log).toEqual(first.log);
  });
});

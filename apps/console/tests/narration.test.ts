/**
 * The story layer reads only the recorded log: every cause it cites is an
 * earlier recorded message the log links, chapters tile the log exactly, and a
 * revision's result is the one the revision recorded.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { foldSummary, foldThread, payloadSummary } from "../src/mission-control.tsx";
import { chapters, formatDuration, narrateAt, narrateMessage, revOutcome } from "../src/narration.ts";

const REPLAYS = new URL("../public/replays/", import.meta.url);

function recorded(id: string): BoardMessage[] {
  return (JSON.parse(readFileSync(new URL(`${id}.json`, REPLAYS), "utf8")) as { messages: BoardMessage[] }).messages;
}

const runs = readdirSync(REPLAYS)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => f.replace(/\.json$/, ""));

describe("narration", () => {
  it.each(runs)("%s: every message gets a sentence, and every cause is an earlier recorded message", (id) => {
    const log = recorded(id);
    const seqs = new Set(log.map((m) => m.seq));
    for (const m of log) {
      const n = narrateMessage(m, log, payloadSummary);
      expect(n.text.length).toBeGreaterThan(0);
      expect(n.seq).toBe(m.seq);
      for (const c of n.causes) {
        expect(c).toBeLessThan(m.seq);
        expect(seqs.has(c)).toBe(true);
      }
    }
  });

  it("links sf21's fix requests to the revision that failed, and a granted claim to its request", () => {
    const log = recorded("board-live-sf21");
    const fix = log.find((m) => m.type === "fix.requested")!;
    const n = narrateMessage(fix, log, payloadSummary);
    const rev = log.find((m) => m.seq === n.causes[0]);
    expect(rev?.type).toBe("integrated.rev");
    expect((rev!.payload as { n: number }).n).toBe((fix.payload as { n: number }).n);
    expect(n.text).toContain(`revision ${(fix.payload as { n: number }).n}`);

    const granted = log.find((m) => m.type === "claim.granted")!;
    const g = narrateMessage(granted, log, payloadSummary);
    expect(g.causes.map((s) => log.find((m) => m.seq === s)?.type)).toContain("item.claimed");
  });

  it("states a revision's recorded outcome and never says 'correct'", () => {
    const log = recorded("board-live-sf21");
    for (const m of log.filter((x) => x.type === "integrated.rev")) {
      const text = narrateMessage(m, log, payloadSummary).text;
      const outcome = revOutcome(m.payload as unknown as Record<string, unknown>);
      expect(text).toContain(outcome === "pass" ? "the gate passes" : outcome === "fail" ? "the gate fails" : "No gate ran");
      expect(text).not.toMatch(/correct/i);
    }
  });

  it("narrates the last message at or before K, and nothing before the first", () => {
    const log = recorded("board-live-sf21");
    expect(narrateAt(log, 0, payloadSummary)).toBeNull();
    expect(narrateAt(log, log[log.length - 1]!.seq + 50, payloadSummary)?.seq).toBe(log[log.length - 1]!.seq);
  });
});

describe("chapters", () => {
  it.each(runs)("%s: chapters tile the whole log in order, one per revision plus plan and wrap-up", (id) => {
    const log = recorded(id);
    const list = chapters(log);
    expect(list[0]!.startSeq).toBe(log[0]!.seq);
    expect(list[list.length - 1]!.endSeq).toBe(log[log.length - 1]!.seq);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i]!.startSeq).toBe(list[i - 1]!.endSeq + 1);
    }
    const revs = log.filter((m) => m.type === "integrated.rev");
    expect(list.filter((c) => c.rev !== undefined).length).toBe(revs.length);
    for (const c of list) {
      if (c.rev) {
        expect(c.endSeq).toBe(c.rev.seq);
        expect(log.find((m) => m.seq === c.rev!.seq)?.type).toBe("integrated.rev");
      }
    }
  });

  it("tells sf21 as plan, build, five fixes to rev 6, then promotion", () => {
    const list = chapters(recorded("board-live-sf21"));
    expect(list.map((c) => c.kind)).toEqual(["plan", "build", "fix", "fix", "fix", "fix", "fix", "promote"]);
    const last = list.filter((c) => c.rev).pop()!;
    expect(last.rev).toMatchObject({ n: 6, outcome: "pass", acceptance: "129/129" });
  });

  it("formats durations", () => {
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 05 min");
  });
});

describe("the folded thread", () => {
  it("folds sf21's seven departures into one row and keeps every message inside it", () => {
    const log = recorded("board-live-sf21");
    const newestFirst = [...log].reverse();
    const entries = foldThread(newestFirst);
    const kept = entries.flatMap((e) => (e.kind === "one" ? [e.message] : e.messages));
    expect(kept.map((m) => m.seq)).toEqual(newestFirst.map((m) => m.seq));
    const left = entries.find((e) => e.kind === "fold" && e.key === "left");
    expect(left?.kind === "fold" ? foldSummary(left.key, left.messages) : "").toMatch(/^7 agents leave the board/);
  });

  it("leaves short runs and non-routine messages unfolded", () => {
    const log = recorded("board-live-sf21");
    const revs = log.filter((m) => m.type === "integrated.rev");
    expect(foldThread(revs).every((e) => e.kind === "one")).toBe(true);
    const twoClaims = log.filter((m) => m.type === "claim.granted").slice(0, 2);
    expect(foldThread(twoClaims).every((e) => e.kind === "one")).toBe(true);
  });
});

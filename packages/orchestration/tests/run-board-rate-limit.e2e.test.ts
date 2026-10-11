/**
 * A board run under AI Gateway rate limits (HTTP 429): the provider's limit,
 * not agent behavior. A rate-limited turn spends no run or item turn budget,
 * is metered as a separate attempt, and pauses EVERY agent (one shared
 * backoff, no agent calls the gateway while it lasts); a run whose calls are
 * refused for the whole window ends with stop reason "rate-limited" and an
 * honest detail, cleans up, and its verdict is only what was gated; a burst
 * of 429s followed by success resumes and finishes like an unlimited run. A
 * 429 saying the provider account has no credits (insufficient_quota) ends the
 * run at once with stop reason "quota-exhausted", never waiting out the window.
 * Offline: the local control, the deterministic policy wrapped in a fake
 * rate-limiting transport, and the offline fixture gate.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { QuotaExhaustedError, type AgentTurnOutcome, type AgentTurnTransport, type ExecutorProvider } from "@switchyard-change/model-adapters";
import type { BoardDigest, BoardMessage } from "@switchyard-change/change-core";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, type BoardRunEvent } from "../src/run-board.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROJECT = join(REPO_ROOT, "examples/demo-project");
const GOAL = "Add audit logging to every module";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-rate-limit-"));
  made.push(dir);
  return dir;
}

type Transport = AgentTurnTransport<BoardDigest, BoardMessage>;

/** The rate-limited outcome the live gateway transport returns for a 429. */
function limitedOutcome(retryAfterMs?: number): AgentTurnOutcome {
  const reason = `turn call failed: AI Gateway agent turn call was rate limited for gpt-4o (HTTP 429, ${retryAfterMs === undefined ? "no retry-after" : `retry-after ${retryAfterMs} ms`})`;
  return { action: { type: "wait", reason }, invalid: reason, model: "gpt-4o", rateLimited: { status: 429, model: "gpt-4o", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } };
}

/** Wrap the deterministic policy: `limit(k)` says whether call k (from 0) is refused with a 429. */
function rateLimiting(limit: (k: number) => boolean): { transport: Transport; calls: { at: number; limited: boolean }[] } {
  const policy = createGenericBoardPolicy();
  const calls: { at: number; limited: boolean }[] = [];
  const transport: Transport = async (input) => {
    const k = calls.length;
    const limited = limit(k);
    calls.push({ at: Date.now(), limited });
    return limited ? limitedOutcome() : policy(input);
  };
  return { transport, calls };
}

/** Count the turns the policy actually took (the transport calls) in an unlimited run. */
function counting(): { transport: Transport; calls: () => number } {
  const policy = createGenericBoardPolicy();
  let n = 0;
  return {
    transport: async (input) => {
      n += 1;
      return policy(input);
    },
    calls: () => n,
  };
}

const base = { goal: GOAL, projectDir: PROJECT, fixtureGate: true, resolveContract: async () => "reject" as const };

describe("a board run under rate limits", () => {
  it("429s pause every agent (shared backoff) and spend no turn budget; a burst then success finishes like an unlimited run", async () => {
    // The unlimited run: how many turns the policy needs, and its outcome.
    const plain = counting();
    const baseline = await runBoardOffline({ ...base, transport: plain.transport, workRoot: await scratch() });
    expect(baseline.stopReason).toBe("all-items-done");
    const needed = plain.calls();

    // The same run with a run turn budget that fits only the turns the
    // policy needs (plus the lead's seed turn and a small slack: pausing
    // reorders the agents' turns), while far more calls are refused: a burst
    // of 4 at the start, then every third call. If a refused call spent a
    // turn, the budget would run out.
    const slack = 6;
    const backoffMs = 25;
    const limited = rateLimiting((k) => k < 4 || k % 3 === 0);
    const events: BoardRunEvent[] = [];
    const result = await runBoardOffline({
      ...base,
      transport: limited.transport,
      budgets: { maxRunTurns: needed + 1 + slack },
      rateLimit: { baseMs: backoffMs, maxMs: 4 * backoffMs, random: () => 0.5, windowMs: 60_000 },
      workRoot: await scratch(),
      onEvent: (e) => events.push(e),
    });
    const refused = limited.calls.filter((c) => c.limited).length;
    expect(refused).toBeGreaterThan(Math.max(needed / 3, 2 * slack));
    expect(result.stopReason).toBe("all-items-done");
    expect(result.verdict).toBe(baseline.verdict);
    expect(result.revisions.at(-1)?.gate).toBe("pass");
    expect(limited.calls.filter((c) => !c.limited).length).toBeLessThanOrEqual(needed + slack);

    // Every refused call is a local RATE_LIMITED wait (never a decision),
    // metered as a separate attempt, and announced as a shared backoff.
    const rateLimitedTurns = result.turns.filter((t) => t.code === "RATE_LIMITED");
    expect(rateLimitedTurns).toHaveLength(refused);
    expect(rateLimitedTurns.every((t) => t.outcome === "local" && t.action.type === "wait")).toBe(true);
    expect(result.usage?.rateLimitedCalls).toBe(refused);
    // The billed calls are the turns that got through, the planner's call,
    // and the edits' executor calls: never a refused one.
    const through = limited.calls.length - refused;
    const edits = result.turns.filter((t) => t.action.type === "edit" || t.action.type === "build_tool").length;
    expect(result.usage!.calls).toBeGreaterThanOrEqual(through + 1);
    expect(result.usage!.calls).toBeLessThanOrEqual(through + 1 + edits);
    const backoffs = events.flatMap((e) => (e.kind === "rate-limited" ? [e] : []));
    expect(backoffs).toHaveLength(refused);
    // The burst escalates (25, 50, 100 ms, capped at 100); a success resets it.
    expect(backoffs.slice(0, 4).map((e) => e.backoffMs)).toEqual([25, 50, 100, 100]);
    expect(backoffs.slice(0, 4).map((e) => e.consecutive)).toEqual([1, 2, 3, 4]);
    expect(backoffs[4]).toMatchObject({ backoffMs: 25, consecutive: 1 });

    // Global: after any refused call, NO agent calls the gateway until the
    // shared pause is over (a small allowance for timer granularity).
    for (let k = 0; k < limited.calls.length - 1; k += 1) {
      if (limited.calls[k]!.limited) {
        expect(limited.calls[k + 1]!.at - limited.calls[k]!.at).toBeGreaterThanOrEqual(backoffMs - 2);
      }
    }
    expect(formatBoardRunSummary(result)).toMatch(new RegExp(`${refused} rate-limited call attempt\\(s\\) \\(HTTP 429: not billed, no turn budget spent\\)`));
  }, 180_000);

  it("persistent 429s end the run rate-limited with an honest detail; cleanup runs and the verdict is only what was gated", async () => {
    const calls: number[] = [];
    const always: Transport = async () => {
      calls.push(Date.now());
      return limitedOutcome(40);
    };
    const events: BoardRunEvent[] = [];
    const result = await runBoardOffline({
      ...base,
      transport: always,
      rateLimit: { windowMs: 400, baseMs: 20, maxMs: 80, random: () => 0.5 },
      workRoot: await scratch(),
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("rate-limited");
    expect(result.stopDetail).toMatch(
      /^the AI Gateway returned HTTP 429 for every call for \d+ ms \(last: gpt-4o, retry-after 40 ms; \d+ rate-limited call\(s\)\): the provider's rate or quota limit; nothing was decided by a model in that window$/,
    );
    // Never quiescent, never a spent budget: nothing was integrated or verified.
    expect(result.revisions).toEqual([]);
    expect(result.verdict).toBe("failed");
    expect(result.turns.filter((t) => t.code !== undefined && t.code !== "RATE_LIMITED" && t.outcome !== "seeded")).toEqual([]);
    expect(result.usage?.rateLimitedCalls).toBe(calls.length);
    // Only the planner's call is counted as a model call.
    expect(result.usage?.calls).toBe(1);
    // Cleanup ran: every agent repo the run created was archived.
    const repos = result.agents.flatMap((a) => (a.workspace !== undefined ? [a.workspace] : []));
    expect(repos.length).toBeGreaterThan(0);
    for (const repo of repos) {
      expect(result.cleanedUp).toContain(repo);
    }
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("agents-done")).toBeLessThan(kinds.indexOf("cleaned-up"));
    expect(formatBoardRunSummary(result)).toMatch(/agent phase ended: rate-limited \(the AI Gateway returned HTTP 429 for every call/);
  }, 120_000);

  it("a turn refused for no credits ends the run at once quota-exhausted (no window wait); cleanup runs", async () => {
    const policy = createGenericBoardPolicy();
    let calls = 0;
    // The lead's turn gets through; the next call finds the balance spent, and every later one would too.
    const transport: Transport = async (input) => {
      calls += 1;
      if (calls === 1) {
        return policy(input);
      }
      const reason = "turn call failed: AI Gateway agent turn call was refused for gpt-4o (HTTP 429, credit_balance_exhausted): the provider account has no credits left; add credits and re-run";
      return { action: { type: "wait", reason }, invalid: reason, model: "gpt-4o", rateLimited: { status: 429, model: "gpt-4o", quotaExhausted: "credit_balance_exhausted" } };
    };
    const events: BoardRunEvent[] = [];
    const started = Date.now();
    const result = await runBoardOffline({
      ...base,
      transport,
      // The default 10 min window: the test would time out if it were waited out.
      rateLimit: { random: () => 0.5 },
      workRoot: await scratch(),
      onEvent: (e) => events.push(e),
    });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(result.stopReason).toBe("quota-exhausted");
    expect(result.stopDetail).toBe(
      "the provider account has no credits left (credit_balance_exhausted from gpt-4o): add credits and re-run; nothing was decided by a model after it",
    );
    // No pause was announced, and no agent kept calling after the refusal.
    expect(events.some((e) => e.kind === "rate-limited")).toBe(false);
    expect(result.usage?.rateLimitedCalls).toBe(calls - 1);
    expect(calls - 1).toBeLessThanOrEqual(result.agents.length);
    const repos = result.agents.flatMap((a) => (a.workspace !== undefined ? [a.workspace] : []));
    for (const repo of repos) {
      expect(result.cleanedUp).toContain(repo);
    }
    expect(formatBoardRunSummary(result)).toMatch(/agent phase ended: quota-exhausted \(the provider account has no credits left/);
  }, 120_000);

  it("an edit refused for no credits ends the run at once quota-exhausted", async () => {
    let edits = 0;
    const executor: ExecutorProvider = {
      name: "no-credits",
      execute: async (context) => {
        edits += 1;
        throw new QuotaExhaustedError("AI Gateway call was refused for gpt-4o (HTTP 429, insufficient_quota): the provider account has no credits left; add credits and re-run", {
          status: 429,
          model: context.model ?? "gpt-4o",
          providerType: "insufficient_quota",
        });
      },
    };
    const started = Date.now();
    const result = await runBoardOffline({
      ...base,
      transport: createGenericBoardPolicy(),
      executor,
      rateLimit: { random: () => 0.5 },
      workRoot: await scratch(),
    });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(edits).toBeGreaterThan(0);
    expect(result.stopReason).toBe("quota-exhausted");
    expect(result.stopDetail).toMatch(/^the provider account has no credits left \(insufficient_quota from .+\): add credits and re-run; nothing was decided by a model after it$/);
    expect(result.turns.some((t) => t.code === "RATE_LIMITED")).toBe(true);
    // The verdict is only what was gated: nothing the refused edits would have fixed passed.
    expect(result.revisions.every((r) => r.gate !== "pass")).toBe(true);
    expect(result.verdict).toBe("failed");
  }, 120_000);
});

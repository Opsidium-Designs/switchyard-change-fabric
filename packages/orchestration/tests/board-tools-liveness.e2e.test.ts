/**
 * Tools never stall a board run, end to end and offline: agents that wait on a
 * tool that never publishes end quiescent with a recorded reason, items are
 * completed by hand when no tool publishes, a tool that hangs is stopped at
 * the timeout, and on the concurrent (live) schedule a failed tool gate is
 * rebuilt at once and owners a codemod covers are held so its builder moves
 * first. No network, no model.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import type { BoardDigest, BoardMessage } from "@switchyard-change/change-core";
import type { AgentTurnTransport } from "@switchyard-change/model-adapters";

import { createGenericBoardPolicy } from "../src/board-policy.ts";
import { templateToolAuthor, type ToolAuthor } from "../src/board-tools.ts";
import { LocalChangeControl } from "../src/local-control.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { codemodTiming, formatBoardRunSummary, runBoard, type BoardRunEvent } from "../src/run-board.ts";
import { GOAL, of, project, reject, seed } from "./board-tools-fixtures.ts";

describe("agents build tools for each other (offline, deterministic)", () => {
  it("agents that only ever wait on a tool that never publishes do not deadlock: the phase ends as quiescent with a recorded reason, and the summary still lists the seeded tools", async () => {
    const projectDir = await project();
    const root = await mkdtemp(join(tmpdir(), "scf-tools-quiet-"));
    const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
    // An idle agent's digest read takes a while, as on a real Worker: an agent
    // that is only OBSERVING (polling while idle) must not keep the board from
    // ever looking quiet. (Counting it did: the live run never ended.)
    const slow = (async (input: string, init?: RequestInit) => {
      if (String(input).includes("?for=")) {
        await new Promise((r) => setTimeout(r, 400));
      }
      return control.fetch(input, init);
    }) as unknown as typeof fetch;
    // A tool author that cannot write anything (the build always fails), and
    // workers that, instead of editing, insist on waiting for the tool.
    const failing: ToolAuthor = async () => {
      throw new Error("edit targets a file that does not exist and cannot be anchored");
    };
    const policy = createGenericBoardPolicy();
    const waitsForTools: AgentTurnTransport<BoardDigest, BoardMessage> = async (input) => {
      const outcome = await policy(input);
      return outcome.action.type === "edit" || outcome.action.type === "use_tool"
        ? { action: { type: "wait", reason: "waiting for the tool; using it is required to proceed" } }
        : outcome;
    };
    const started = Date.now();
    const result = await runBoard({
      goal: GOAL,
      projectDir,
      changeId: "change-quiet-tools",
      workerUrl: "http://local-control",
      fetchFn: slow,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      transport: waitsForTools,
      seed,
      schedule: "concurrent",
      pollMs: 20,
      budgets: { quiescenceMs: 3000, timeoutMs: 100_000 },
      workRoot: join(root, "work"),
      toolAuthor: failing,
      resolveContract: reject,
    });
    expect(result.stopReason).toBe("quiescent");
    expect(Date.now() - started).toBeLessThan(90_000);
    // Claims nobody moved were recorded stalled on the quiet board: each item
    // at most stallReleasesBeforeReplan times, plus once more when the lead may
    // re-plan it (re-planning needs it open), and then the phase ended quiet.
    const stalled = result.log.filter((m) => m.type === "claim.lapsed");
    expect(stalled.length).toBeGreaterThan(0);
    for (const item of new Set(stalled.map((m) => (m.payload as { item: string }).item))) {
      const lapses = stalled.filter((m) => (m.payload as { item: string }).item === item);
      expect(lapses.length).toBeLessThanOrEqual(item.startsWith("tool-") || item.includes(".r") ? 2 : 3);
    }
    // The extra release made a re-plan possible, and the lead used it before the board went quiet.
    expect(result.log.some((m) => m.type === "item.replanned")).toBe(true);
    expect(result.turns.some((t) => t.code === "TOOL_BUILD_FAILED")).toBe(true);
    const summary = formatBoardRunSummary(result);
    expect(result.stopDetail).toMatch(/every agent was idle \(none taking a turn\).*no board message arrived for 3 s/);
    expect(summary).toContain("agent phase ended: quiescent (every agent was idle");
    expect(summary).toMatch(/tools: 2 proposed, 0 built, 0 gated \(0 passed, 0 failed\), 0 version\(s\) published, 0 use\(s\)/);
    expect(summary).toMatch(/scanner scan-guard: proposed by lead; /);
    expect(summary).toMatch(/codemod codemod-guard: proposed by lead; /);
  }, 150_000);

  it("tools are accelerators, never prerequisites: when no tool ever publishes, every item is still claimed and completed by hand", async () => {
    const projectDir = await project();
    const never: ToolAuthor = async () => {
      throw new Error("edit for WorkUnit targets a file that does not exist and cannot be anchored");
    };
    const result = await runBoardOffline({ goal: GOAL, projectDir, seed, fixtureGate: true, resolveContract: reject, toolAuthor: never });
    expect(of(result.log, "tool.published")).toEqual([]);
    for (const item of ["guard-a", "guard-b", "guard-c"]) {
      expect(of(result.log, "claim.granted").some((m) => m.payload.item === item)).toBe(true);
      expect(of(result.log, "item.completed").some((m) => m.payload.item === item)).toBe(true);
    }
    // Nobody waited for a tool.
    expect(result.turns.some((t) => t.action.type === "wait" && /waiting for the codemod/.test(t.action.reason))).toBe(false);
    expect(result.incompleteItems).toEqual([]);
    expect(result.verdict).toBe("verified");
    expect(formatBoardRunSummary(result)).toMatch(/codemod codemod-guard: proposed by lead; /);
  });

  it("a tool that hangs when used is stopped at the timeout; nothing is recorded and the item is edited by hand", async () => {
    const projectDir = await project();
    // Passes its gate (no paths: a well-behaved codemod over its inputs), hangs when given paths.
    const hanging: ToolAuthor = async (request) => {
      if (request.kind === "scanner") {
        return templateToolAuthor(request);
      }
      const dir = join(request.worktreeDir, "tools", request.capability);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "run.mjs"),
        [
          'import { readFileSync, writeFileSync } from "node:fs";',
          "if (process.argv.length > 2) { setInterval(() => {}, 1000); } else {",
          `  for (const f of ${JSON.stringify(request.inputs)}) writeFileSync(f, "// guarded\\n" + readFileSync(f, "utf8"));`,
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(join(dir, "test.mjs"), 'import test from "node:test";\ntest("ok", () => {});\n');
    };
    const result = await runBoardOffline({ goal: GOAL, projectDir, seed, fixtureGate: true, resolveContract: reject, toolAuthor: hanging, toolTimeoutMs: 1500 });
    const stopped = result.turns.filter((t) => t.action.type === "use_tool" && t.code === "TOOL_STOPPED");
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    expect(stopped[0]!.error).toMatch(/timed out/);
    expect(of(result.log, "tool.used").filter((m) => m.payload.capability === "codemod-guard")).toEqual([]);
    expect(result.incompleteItems).toEqual([]);
  });
});

describe("tool rebuilds and builder priority in the concurrent (live) schedule", () => {
  async function concurrentRun(id: string, toolAuthor: ToolAuthor, onEvent?: (event: BoardRunEvent) => void) {
    const projectDir = await project();
    const root = await mkdtemp(join(tmpdir(), `scf-${id}-`));
    const control = new LocalChangeControl(new LocalFilesystemWorkspaceProvider({ rootDir: join(root, "repos") }));
    return runBoard({
      goal: GOAL,
      projectDir,
      changeId: id,
      workerUrl: "http://local-control",
      fetchFn: control.fetch as unknown as typeof fetch,
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      transport: createGenericBoardPolicy(),
      seed,
      schedule: "concurrent",
      pollMs: 20,
      budgets: { quiescenceMs: 4000, timeoutMs: 80_000 },
      workRoot: join(root, "work"),
      toolAuthor,
      resolveContract: reject,
      ...(onEvent ? { onEvent } : {}),
    });
  }

  it("a failed tool gate is rebuilt at once by its builder with the failing checks, bounded, whatever the schedule", async () => {
    const failures: (string | undefined)[] = [];
    let codemodBuilds = 0;
    const flaky: ToolAuthor = async (request) => {
      if (request.kind !== "codemod") {
        return templateToolAuthor(request);
      }
      codemodBuilds += 1;
      failures.push(request.gateFailure);
      await templateToolAuthor(request);
      if (codemodBuilds === 1) {
        // The first build's own test fails: the tool's gate must fail it.
        await writeFile(join(request.worktreeDir, "tools", request.capability, "test.mjs"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("broken", () => assert.equal(1, 2));\n');
      }
    };
    const result = await concurrentRun("change-tool-rebuild", flaky);
    const built = of(result.log, "tool.built").filter((m) => m.payload.capability === "codemod-guard");
    const gated = of(result.log, "tool.gated").filter((m) => m.payload.capability === "codemod-guard");
    expect(gated.map((m) => m.payload.passed)).toEqual([false, true]);
    expect(built).toHaveLength(2);
    expect(new Set(built.map((m) => m.from)).size).toBe(1);
    expect(built[1]!.seq).toBeGreaterThan(gated[0]!.seq);
    // The rebuild was told what failed.
    expect(failures[0]).toBeUndefined();
    expect(failures[1]).toMatch(/tests/);
    expect(of(result.log, "tool.published").map((m) => m.payload.capability)).toContain("codemod-guard");
    expect(["guard-a", "guard-b", "guard-c"].every((i) => result.state.items[i]?.status === "done")).toBe(true);
  }, 120_000);

  it("concurrent: owners whose items a codemod being built covers are held so the builder moves first, and the codemod is used before hand edits", async () => {
    // A barrier, not a timer: the codemod's build finishes only once two
    // owners (not its builder) have claimed planned items it covers, so they
    // are held while it is built however slow the machine is. A generous
    // fallback keeps a regression from hanging the suite.
    const claimed = new Set<string>();
    let release: () => void = () => undefined;
    const ownersClaimed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onEvent = (event: BoardRunEvent) => {
      if (event.kind === "turn" && event.record.outcome === "posted" && event.record.action.type === "claim" && /^guard-/.test(event.record.action.itemId)) {
        claimed.add(event.record.agent);
        if (claimed.size >= 2) release();
      }
    };
    const slow: ToolAuthor = async (request) => {
      if (request.kind === "codemod") {
        await Promise.race([ownersClaimed, new Promise((resolve) => setTimeout(resolve, 30_000))]);
      }
      return templateToolAuthor(request);
    };
    const result = await concurrentRun("change-tool-hold", slow, onEvent);
    expect(claimed.size).toBeGreaterThanOrEqual(2);
    const timing = codemodTiming(result.log, result.state).find((t) => t.capability === "codemod-guard")!;
    expect(timing.early.length).toBeGreaterThanOrEqual(2);
    // The PLANNED items the codemod covers: none was edited by hand first.
    // (A scanner run on a not-yet-rebased tree may re-find a file another
    // item already fixed; such follow-up items depend on timing, so they are
    // not part of this ordering claim.)
    expect(timing.handFirst.filter((i) => /^guard-/.test(i))).toEqual([]);
    // The planned items all completed (later scanner-found work depends on timing).
    expect(["guard-a", "guard-b", "guard-c"].every((i) => result.state.items[i]?.status === "done")).toBe(true);
  }, 120_000);
});

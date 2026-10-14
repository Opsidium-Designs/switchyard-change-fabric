/**
 * The board run's gate, offline: a declared gate that is not wired cannot pass,
 * dependencies are installed in every gated tree before the gate (a failed
 * install fails the revision honestly), and acceptance progress per revision
 * and per suite is recorded as advisory and never decides the verdict. No
 * network: the generic policy takes every turn and deterministic executors edit.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { reduceBoard } from "@switchyard-change/change-core";
import type { CommandRunner, DependencyInstaller } from "@switchyard-change/verification";

import { runBoardOffline } from "../src/run-board-offline.ts";
import { boardRunExitCode, formatBoardRunSummary } from "../src/run-board.ts";
import { FixedGate, GOAL, of, offline, project, reject, seed } from "./run-board-fixtures.ts";

describe("runBoard (offline, lockstep, continuous integration)", () => {
  it("a declared gate that is not wired cannot pass", async () => {
    const projectDir = await project();
    // Every revision fails here, so one fix attempt per item is enough to show it (fixes are charged once per push).
    const result = await offline({ goal: GOAL, projectDir, seed, requireAppGate: true, budgets: { maxFixAttemptsPerItem: 1 } });
    expect(result.revisions.length).toBeGreaterThan(0);
    expect(result.revisions.every((r) => r.gate === "fail")).toBe(true);
    expect(result.verdict).toBe("failed");
    expect(result.promotion).toMatchObject({ committed: false });
  });
});

describe("dependency install before the gate (offline, fake installer)", () => {
  async function lockedProject(): Promise<string> {
    const dir = await project();
    await writeFile(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
    return dir;
  }

  it("installs in every gated tree (never the source project) before the gate, and reports it per revision and for the baseline", async () => {
    const projectDir = await lockedProject();
    const dirs: string[] = [];
    const dependencyInstaller: DependencyInstaller = {
      async install(dir) {
        dirs.push(dir);
        return { status: "installed", tool: "npm", detail: "npm ci --ignore-scripts", durationMs: 1200 };
      },
    };
    const gate = new FixedGate(0);
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate, dependencyInstaller });
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).not.toContain(projectDir);
    // Every gate run happened in a tree that was installed first.
    expect(gate.ran.every((cwd) => dirs.includes(cwd))).toBe(true);
    expect(result.revisions.every((r) => r.install?.status === "installed")).toBe(true);
    expect(result.testInventory).toContain("dependency install: installed (npm ci --ignore-scripts, 1.2 s)");
    expect(formatBoardRunSummary(result)).toMatch(/integrated revision 1: gate pass[^\n]*\n {4}dependency install: installed \(npm ci --ignore-scripts, 1\.2 s\)/);
    expect(result.verdict).toBe("verified");
  });

  it("a failed install fails the revision honestly: the gate never runs and the reason leads", async () => {
    const projectDir = await lockedProject();
    const dependencyInstaller: DependencyInstaller = {
      async install() {
        return { status: "failed", tool: "npm", detail: "npm ci: npm error code ERESOLVE", durationMs: 50 };
      },
    };
    const gate = new FixedGate(0);
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate, dependencyInstaller, budgets: { maxFixAttemptsPerItem: 1 } });
    expect(gate.ran).toEqual([]);
    expect(result.revisions.length).toBeGreaterThan(0);
    expect(result.revisions.every((r) => r.gate === "fail" && r.install?.status === "failed")).toBe(true);
    expect(result.revisions[0]!.failure).toMatch(/^dependency install failed: npm ci: npm error code ERESOLVE/);
    expect(of(result.log, "integrated.rev")[0]!.payload.failing!.output).toMatch(/^dependency install failed:/);
    expect(result.testInventory).toContain("dependency install: failed: npm ci: npm error code ERESOLVE");
    expect(result.verdict).toBe("failed");
    expect(boardRunExitCode(result)).toBe(1);
  });

  it("offline, the fixture gate may replace a declared gate: labeled, no install, and it shows coordination only", async () => {
    const projectDir = await lockedProject();
    let installs = 0;
    const result = await runBoardOffline({
      goal: GOAL,
      projectDir,
      seed,
      resolveContract: reject,
      fixtureGate: true,
      replacesDeclaredGate: ["npm", "run", "gate"],
      dependencyInstaller: {
        async install() {
          installs += 1;
          return { status: "installed", detail: "x", durationMs: 0 };
        },
      },
    });
    expect(installs).toBe(0); // the fixture installs nothing, whatever the caller passed
    expect(result.gateLabel).toBe("offline fixture gate replaces the project's declared gate (npm run gate); this demo shows coordination, not a real fix");
    expect(formatBoardRunSummary(result)).toContain(`  gate: ${result.gateLabel}`);
    expect(result.revisions.every((r) => r.install?.status === "skipped" && /disabled for this gate/.test(r.install.detail))).toBe(true);
    expect(result.verdict).toBe("verified");
  });
});

describe("acceptance progress per revision (advisory)", () => {
  it("records how many gate checks passed on each revision, shows the change, and never decides the verdict", async () => {
    const projectDir = await project();
    let runs = 0;
    // The baseline run, then a failing revision (2 of 3 passing), then a passing one.
    const gate: CommandRunner = {
      async run() {
        runs += 1;
        return runs <= 2
          ? { code: 1, stdout: "      Tests  1 failed | 2 passed (3)\n", stderr: "AssertionError: one check still fails\n" }
          : { code: 0, stdout: "      Tests  3 passed (3)\n", stderr: "" };
      },
    };
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["gate"], verifyCommandRunner: gate });
    const revs = of(result.log, "integrated.rev");
    expect(revs[0]!.payload.progress).toEqual({ passed: 2, failed: 1, total: 3 });
    expect(revs.at(-1)!.payload.progress).toEqual({ passed: 3, failed: 0, total: 3 });
    const summary = formatBoardRunSummary(result);
    // No suite named its files: the counts are not labeled as the acceptance suite's.
    expect(summary).toMatch(/rev 1: 2\/3 checks passing \(advisory; the gate decides\)/);
    expect(summary).toMatch(/rev 2: 3\/3 checks passing \(\+1\)/);
    const { buildBoardGraph } = await import("../src/board-graph.ts");
    const graph = buildBoardGraph(result.log);
    expect(graph.ticker.rev?.progress).toMatchObject({ passed: 3, total: 3 });
    expect(graph.nodes.find((n) => n.id === "rev:2")!.detail).toMatchObject({ progress: { passed: 3, total: 3, delta: 1 } });
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

describe("acceptance progress per suite (advisory)", () => {
  it("labels the acceptance suite from the immutable gate, never counts the developer suite as acceptance, and says when a typecheck stopped the gate first", async () => {
    const projectDir = await project();
    await mkdir(join(projectDir, "gate"), { recursive: true });
    await writeFile(join(projectDir, "gate/acceptance.test.ts"), "// the acceptance suite\n");
    const developer = " RUN  v2\n ✓ tests/core.test.ts (9 tests) 5ms\n Test Files  1 passed (1)\n      Tests  9 passed (9)\n";
    const acceptance = (passed: number, failed: number) =>
      ` RUN  v2\n ${failed > 0 ? "❯" : "✓"} gate/acceptance.test.ts (${passed + failed} tests${failed > 0 ? ` | ${failed} failed` : ""})\n Test Files  1 ${failed > 0 ? "failed" : "passed"} (1)\n      Tests  ${failed > 0 ? `${failed} failed | ` : ""}${passed} passed (${passed + failed})\n`;
    let runs = 0;
    // The baseline (developer 9/9, acceptance 1/4), a revision whose typecheck
    // fails (no suite runs), then a passing one.
    const gate: CommandRunner = {
      async run() {
        runs += 1;
        if (runs === 1) {
          return { code: 1, stdout: `> tsc --noEmit && vitest run && vitest run --config gate/vitest.config.ts\n${developer}${acceptance(1, 3)}`, stderr: "" };
        }
        if (runs === 2) {
          return { code: 2, stdout: "> tsc --noEmit\nsrc/core/a.ts(44,12): error TS2339: Property 'user' does not exist on type 'Ctx'.\n", stderr: "" };
        }
        return { code: 0, stdout: `${developer}${acceptance(4, 0)}`, stderr: "" };
      },
    };
    const result = await offline({ goal: GOAL, projectDir, seed, appGateCommand: ["vitest", "run", "gate"], verifyCommandRunner: gate });
    expect(result.state.immutable).toContain("gate/acceptance.test.ts");
    const revs = of(result.log, "integrated.rev");
    expect(revs[0]!.payload.progress).toEqual({ passed: 0, failed: 0, total: 0, acceptanceNotRun: "typecheck failed (1 error)" });
    expect(revs.at(-1)!.payload.progress).toEqual({
      passed: 13,
      failed: 0,
      total: 13,
      suites: [
        { passed: 9, failed: 0, total: 9, suite: "developer" },
        { passed: 4, failed: 0, total: 4, suite: "acceptance" },
      ],
      acceptance: { passed: 4, failed: 0, total: 4 },
    });
    const summary = formatBoardRunSummary(result);
    expect(summary).toMatch(/rev 1: acceptance suite did not run: typecheck failed \(1 error\) \(advisory; the gate decides\)/);
    expect(summary).toMatch(new RegExp(`rev ${revs.at(-1)!.payload.n}: acceptance 4/4 passing; developer 9/9`));
    expect(summary).not.toMatch(/9\/9 acceptance/);
    const { buildBoardGraph } = await import("../src/board-graph.ts");
    const graph = buildBoardGraph(result.log);
    expect(graph.ticker.rev?.progress).toMatchObject({ label: "acceptance 4/4 passing; developer 9/9", passed: 4, total: 4, acceptance: true });
    expect(graph.nodes.find((n) => n.id === "rev:1")!.detail).toMatchObject({ progress: { label: "acceptance suite did not run: typecheck failed (1 error)" } });
    expect(reduceBoard(result.log)).toEqual(result.state);
  });
});

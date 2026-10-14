/**
 * Agents build tools for each other on a board run, end to end and offline:
 * the generic policy sees a repeated mechanical change across the planned
 * items, proposes a scanner and a codemod, the lead accepts them, their
 * proposers claim and build them in the Change's tools repo, each passes its
 * OWN gate on the original code and is published by the engine, other agents
 * run the pinned versions in their own repos (the engine records every use),
 * a scanner's findings that no outstanding item covers become a proposal the
 * lead accepts, and that work completes through the normal gate. Live-shaped
 * plans seed the same tools, and two runs are identical. Tool authoring and
 * the tool gate live in board-tools-authoring.e2e.test.ts; liveness (a tool
 * that never publishes or hangs, and the concurrent schedule) in
 * board-tools-liveness.e2e.test.ts. No network, no model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { reduceBoard } from "@switchyard-change/change-core";

import { assertBoardBacked, buildBoardGraph } from "../src/board-graph.ts";
import { runBoardOffline } from "../src/run-board-offline.ts";
import { formatBoardRunSummary, formatBoardTranscript, type BoardSeed } from "../src/run-board.ts";
import { GOAL, git, of, project, reject, seed } from "./board-tools-fixtures.ts";

describe("agents build tools for each other (offline, deterministic)", () => {
  it("proposed -> accepted -> claimed -> built -> own gate passed -> published -> used by 2+ agents -> scanner work accepted -> completed", async () => {
    const projectDir = await project();
    const result = await runBoardOffline({ goal: GOAL, projectDir, seed, fixtureGate: true, resolveContract: reject });
    const log = result.log;

    // The lead seeds both tools with the plan (the structural rule fired), open at once; workers claim and build them.
    const proposed = of(log, "tool.proposed");
    expect(proposed.map((m) => [m.from, m.payload.kind, m.payload.capability])).toEqual([
      ["lead", "scanner", "scan-guard"],
      ["lead", "codemod", "codemod-guard"],
    ]);
    expect(proposed[0]!.payload.inputs).toEqual([]); // a scanner looks everywhere
    expect(proposed[1]!.payload.inputs).toEqual(["src/a.js", "src/b.js", "src/c.js"]); // a codemod's scope is declared
    // The items the codemod covers say to use it.
    expect(of(log, "item.proposed").filter((m) => m.from === "lead").every((m) => m.payload.objective.includes("use_tool"))).toBe(true);
    expect(of(log, "claim.granted").filter((x) => x.payload.item.startsWith("tool-")).map((x) => [x.payload.item, x.payload.agent])).toEqual([
      ["tool-scan-guard", "agent-1"],
      ["tool-codemod-guard", "agent-2"],
    ]);

    // Built, gated by the engine (never the agent), published only after a pass.
    for (const capability of ["scan-guard", "codemod-guard"]) {
      const built = of(log, "tool.built").find((m) => m.payload.capability === capability)!;
      const gated = of(log, "tool.gated").find((m) => m.payload.capability === capability)!;
      const published = of(log, "tool.published").find((m) => m.payload.capability === capability)!;
      expect(built.payload.paths.every((p) => p.startsWith(`tools/${capability}/`))).toBe(true);
      expect(gated).toMatchObject({ from: "engine", payload: { commit: built.payload.commit, passed: true } });
      expect(published).toMatchObject({ from: "engine", inReplyTo: gated.seq, payload: { version: "1", commit: built.payload.commit, verified: true } });
      expect(built.seq).toBeLessThan(gated.seq);
      expect(gated.seq).toBeLessThan(published.seq);
    }
    expect(of(log, "tool.gated").find((m) => m.payload.capability === "scan-guard")!.payload.checks.map((c) => c.check)).toEqual([
      "layout",
      "filled",
      "tests",
      "baseline-run",
      "output-format",
      "finds",
      "read-only",
    ]);

    // Every use is the engine's, pins version 1, and names who ran it; each tool is used by 2+ agents.
    const uses = of(log, "tool.used");
    expect(uses.every((m) => m.from === "engine" && m.payload.version === "1")).toBe(true);
    for (const capability of ["scan-guard", "codemod-guard"]) {
      expect(new Set(uses.filter((m) => m.payload.capability === capability).map((m) => m.payload.by)).size).toBeGreaterThanOrEqual(2);
    }
    // A codemod's change is the consumer's own push, inside its write intent.
    for (const use of uses.filter((m) => m.payload.changedFiles.length > 0)) {
      const pushed = of(log, "push.announced").find((p) => p.payload.commit === use.payload.commit)!;
      expect(pushed).toMatchObject({ from: use.payload.by, payload: { item: use.payload.item } });
      expect(pushed.payload.paths).toEqual(use.payload.changedFiles);
    }

    // The scanner's builder turned findings no item covered into work; the lead accepted it; it completed.
    const generated = of(log, "item.proposed").filter((m) => m.payload.fromTool !== undefined);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ from: "agent-1", payload: { scopeHint: ["src/shared/util.js"], fromTool: { capability: "scan-guard", version: "1" } } });
    const item = generated[0]!.payload.item;
    expect(log.find((m) => m.type === "item.accepted" && m.payload.item === item)?.from).toBe("lead");
    expect(of(log, "item.completed").some((m) => m.payload.item === item && m.payload.via === "integrated")).toBe(true);

    // The run completes every Change item, verified on the last revision; tool items are not counted.
    expect(result.stopReason).toBe("all-items-done");
    expect(result.incompleteItems).toEqual([]);
    expect(result.verdict).toBe("verified");
    const summary = formatBoardRunSummary(result);
    expect(summary).toContain("items completed: 4 of 4");
    expect(summary).toMatch(/tools: 2 proposed, 2 built, 2 gated \(2 passed, 0 failed\), 2 version\(s\) published, \d+ use\(s\)/);
    expect(summary).toMatch(/work from scan-guard@1 findings: agent-1-item-\d+ \[src\/shared\/util\.js\] \(completed\)/);
    expect(formatBoardTranscript(log)).toMatch(/tool\.gated\s+scan-guard commit \w+ tool gate PASSED/);

    // The codemod's change is in the promoted tree (the marker it inserts).
    const shipped = (await git("git", ["-C", result.sourceRepoDir!, "show", `${result.promotion!.commit}:src/b.js`])).stdout;
    expect(shipped).toMatch(/\/\/ switchyard:guard\nexport function b/);

    // The log replays to the same state, and the graph is fully backed (tool nodes, consumed-tool edges, trigger edges).
    expect(reduceBoard(log)).toEqual(result.state);
    const graph = buildBoardGraph(log);
    assertBoardBacked(graph, log);
    expect(graph.edges.filter((e) => e.kind === "consumed-tool").length).toBeGreaterThanOrEqual(4);
    expect(graph.edges.some((e) => e.kind === "trigger" && e.from === "tool:scan-guard" && e.to === `item:${item}`)).toBe(true);
  });

  it("the live planner's freely named items (u1-auth-resource ... u6-users-resource) still make the lead seed a scanner and a codemod", async () => {
    const names = ["auth", "notifications", "orders", "products", "search", "users"];
    const livePlan = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "fake-live-planner",
      items: names.map((name, i) => ({
        item: `u${i + 1}-${name}-resource`,
        objective: `Add input validation and require authentication in the ${name} resource handler so malformed or unauthenticated requests are rejected with 400 or 401`,
        acceptance: ["the gate passes"],
        scopeHint: [`src/resources/${name}.js`],
      })),
    });
    const projectDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "examples", "apps", "service-api");
    const result = await runBoardOffline({ goal: "Add input validation and require auth on every resource", projectDir, seed: livePlan, fixtureGate: true, resolveContract: reject });
    const proposed = of(result.log, "tool.proposed");
    expect(proposed.map((m) => [m.from, m.payload.kind, m.payload.capability])).toEqual([
      ["lead", "scanner", "scan-add-input"],
      ["lead", "codemod", "codemod-add-input"],
    ]);
    expect(proposed[1]!.payload.inputs).toEqual(names.map((n) => `src/resources/${n}.js`));
    expect(proposed[0]!.rationale).toMatch(/6 planned items \(u1-auth-resource, .*u6-users-resource\)/);
    const items = of(result.log, "item.proposed").filter((m) => m.from === "lead");
    expect(items.every((m) => m.payload.objective.includes("codemod-add-input"))).toBe(true);
    expect(of(result.log, "tool.published").map((m) => m.payload.capability).sort()).toEqual(["codemod-add-input", "scan-add-input"]);
    expect(result.incompleteItems).toEqual([]);
  });

  it("the recorded live plan (identical lead sentence, item-specific tails, ids U1-res-auth..U6-res-users) makes the lead seed a scanner and a codemod over the five sibling resources", async () => {
    const fixture = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "change-core", "tests", "fixtures", "live-plan-objectives.txt"), "utf8");
    const livePlan = async (): Promise<BoardSeed> => ({
      source: "planner",
      model: "recorded-live-planner",
      items: fixture
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const [item, objective, scope] = line.split(" | ");
          return { item: item!, objective: objective!.slice(0, 500), acceptance: ["the gate passes"], scopeHint: [...scope!.matchAll(/'([^']+)'/g)].map((m) => m[1]!) };
        }),
    });
    const projectDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "examples", "apps", "service-api");
    const result = await runBoardOffline({ goal: "Add input validation and require auth on every resource", projectDir, seed: livePlan, fixtureGate: true, resolveContract: reject });
    const proposed = of(result.log, "tool.proposed");
    expect(proposed.map((m) => [m.from, m.payload.kind])).toEqual([
      ["lead", "scanner"],
      ["lead", "codemod"],
    ]);
    expect(proposed[1]!.payload.inputs).toEqual(expect.arrayContaining(["src/resources/notifications.js", "src/resources/orders.js", "src/resources/products.js", "src/resources/search.js", "src/resources/users.js"]));
    expect(proposed[0]!.rationale).toMatch(/U2-res-notifications.*U6-res-users/);
    expect(result.incompleteItems).toEqual([]);
  });

  it("is deterministic: two runs produce identical board logs", async () => {
    const projectDir = await project();
    const first = await runBoardOffline({ goal: GOAL, projectDir, seed, fixtureGate: true, resolveContract: reject });
    const second = await runBoardOffline({ goal: GOAL, projectDir, seed, fixtureGate: true, resolveContract: reject });
    expect(second.log).toEqual(first.log);
  });
});

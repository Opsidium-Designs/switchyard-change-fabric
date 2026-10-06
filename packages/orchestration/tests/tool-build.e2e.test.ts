/**
 * M4: agent-for-agent tooling and write-lease coordination, proven offline and
 * deterministically against real state.
 *
 * These tests exercise the real tool-build driver and the real lease
 * coordination through the offline substrate (local-filesystem workspaces, the
 * honest fallback), so they run in `make check` with no Cloudflare account and
 * no inference. They assert:
 *
 *   (a) the tool node and consumed-tool edges derive from REAL state: a tool is
 *       built in its OWN workspace (a real bare git repo), and a downstream unit
 *       actually RUNS the published codemod (a genuine effect, recorded as a
 *       consumption);
 *   (b) the tool-build trigger is derived from the work, not a goal string: it
 *       fires for the universal fan-out goal and does NOT fire for the layered
 *       audit goal (cross-checked here end to end, not only at the unit level);
 *   (c) the write lease grants exactly one owner and records the other as a
 *       waiter on the seeded src/audit/events.ts collision, with no terminal
 *       merge;
 *   (d) the graph projection emits the tool node and consumed-tool edges backed
 *       by that real state, and the no-unbacked-node rule still holds for the
 *       new kinds.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "@switchyard-change/artifact-workspace/local";
import { decompose, parseChangeSpec, type RepoFile } from "@switchyard-change/change-core";

import { maybeBuildTool } from "../src/tool-build.ts";
import { runChange } from "../src/run-change.ts";
import {
  assertBacked,
  buildWorkGraphModel,
  toolNodeId,
  type ChangeStateSnapshot,
} from "../src/graph-model.ts";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CALC_PROJECT = join(REPO_ROOT, "examples", "calc-project");
const AUDIT_SPEC = join(REPO_ROOT, "examples", "changes", "audit-logging.change.yaml");
const AUDIT_PROJECT = join(REPO_ROOT, "examples", "demo-project");
const VALIDATION_GOAL = join(REPO_ROOT, "examples", "goals", "add-input-validation.goal.txt");

const FLAT_REPO: RepoFile[] = [
  { path: "src/statistics.ts", content: "export function mean(v: number[]): number { return 0; }\n" },
  { path: "src/geometry.ts", content: "export function area(w: number, h: number): number { return w * h; }\n" },
  { path: "src/finance.ts", content: "export function pct(a: number, p: number): number { return 0; }\n" },
  { path: "src/index.ts", content: "export { mean } from './statistics.js';\n" },
];

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scf-m4-"));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("M4: an agent builds a tool in its own repo and downstream units run it", () => {
  it("builds a real codemod in its own workspace and a downstream unit genuinely consumes it", async () => {
    const change = decompose({
      goal: "Add input validation to every exported function",
      repo: FLAT_REPO,
    }).change;

    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    const built = await maybeBuildTool({ change, workRoot, workspaces, enableToolBuild: true });

    expect(built).toBeDefined();
    const tool = built!;
    // The tool was published into its OWN real workspace (a local-fallback bare
    // git repo), distinct from any unit workspace.
    expect(tool.builderUnitId).toBe("tool-validate");
    expect(tool.capability).toBe("codemod:validate");
    expect(tool.workspace.backend).toBe("local-filesystem");
    expect(tool.workspace.fallback).toBe(true);
    expect(tool.toolPath).toBe("tools/validate-codemod.mjs");

    // The tool script is a REAL file in that real repo: clone it and read it.
    const check = await mkdtemp(join(workRoot, "verify-tool-"));
    await run("git", ["clone", tool.workspace.gitUrl, check]);
    const scriptStat = await stat(join(check, tool.toolPath));
    expect(scriptStat.isFile()).toBe(true);
    const scriptSrc = await readFile(join(check, tool.toolPath), "utf8");
    expect(scriptSrc).toContain("switchyard:validate-guard");

    // The tool is GENUINELY consumed: at least one downstream unit actually ran
    // the codemod (changed=true), not a decorative link.
    expect(tool.consumptions.length).toBeGreaterThanOrEqual(1);
    const changedConsumers = tool.consumptions.filter((c) => c.changed);
    expect(changedConsumers.length).toBeGreaterThanOrEqual(1);
    for (const consumption of changedConsumers) {
      expect(change.work.some((u) => u.id === consumption.consumerUnitId)).toBe(true);
      expect(consumption.capability).toBe("codemod:validate");
    }
  });

  it("builds NO tool for the layered audit Change (trigger is the work, not the goal)", async () => {
    const specYaml = await readFile(AUDIT_SPEC, "utf8");
    const change = parseChangeSpec(specYaml);
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    // Opt in: even with the tool path enabled, the layered Change's distinct
    // units do not repeat one transform over many files, so the structural
    // trigger still returns no tool.
    const built = await maybeBuildTool({ change, workRoot, workspaces, enableToolBuild: true });
    expect(built).toBeUndefined();
  });

  it("builds NO tool when the tool path is not opted in, even for a fan-out Change", async () => {
    // The default path is off: a Change whose work WOULD warrant a tool still
    // builds none unless the caller explicitly opts in, so an ordinary run emits
    // no tool node.
    const change = decompose({
      goal: "Add input validation to every exported function",
      repo: FLAT_REPO,
    }).change;
    const workspaces = new LocalFilesystemWorkspaceProvider({ rootDir: join(workRoot, "artifacts") });
    const built = await maybeBuildTool({ change, workRoot, workspaces });
    expect(built).toBeUndefined();
  });
});

describe("M4: runChange surfaces the tool and the write lease in the result", () => {
  it("the universal goal run builds a tool consumed by downstream units", async () => {
    const goal = (await readFile(VALIDATION_GOAL, "utf8")).trim();
    const change = decompose({ goal, repo: await import("../src/scan-repo.ts").then((m) => m.scanRepoFiles(CALC_PROJECT)) }).change;

    const result = await runChange({
      specYaml: await import("../src/decompose-goal.ts").then((m) => m.changeToSpecYaml(change)),
      projectDir: CALC_PROJECT,
      workRoot,
      enableToolBuild: true,
    });

    expect(result.tool).toBeDefined();
    expect(result.tool?.capability).toBe("codemod:validate");
    // Genuinely consumed by a downstream unit.
    const changed = result.tool?.consumptions.filter((c) => c.changed) ?? [];
    expect(changed.length).toBeGreaterThanOrEqual(1);
    // This flat goal has no path collisions, so the lease plan is empty.
    expect(result.leasePlan.needsAttention).toBe(false);
    expect(result.leasePlan.decisions).toEqual([]);
  });

  it("the audit run grants one lease owner + a waiter on src/audit/events.ts, no terminal merge, and builds no tool", async () => {
    const specYaml = await readFile(AUDIT_SPEC, "utf8");
    const result = await runChange({ specYaml, projectDir: AUDIT_PROJECT, workRoot });

    // The write lease: one owner (api, declared first), tests as waiter.
    expect(result.leasePlan.needsAttention).toBe(false);
    const decision = result.leasePlan.decisions.find((d) => d.path === "src/audit/events.ts");
    expect(decision?.resolution).toBe("serialized");
    expect(decision?.owner).toBe("api");
    expect(decision?.waiters).toEqual(["tests"]);
    // Exactly one owner, one writer: the ordering edge is waiter -> owner.
    expect(result.leasePlan.ordering).toEqual([{ waiter: "tests", owner: "api" }]);

    // The audit Change is layered, so no tool is built.
    expect(result.tool).toBeUndefined();

    // And the integration still landed the owner's content (no silent merge),
    // the same guarantee the demo e2e asserts.
    expect(result.evidence.integration.verdict).toBe("verified");
  });
});

describe("M4: the graph projects the tool node, consumed-tool edges, and lease edges from real state", () => {
  /** A snapshot shaped exactly as the live/offline state reports it. */
  function toolSnapshot(): ChangeStateSnapshot {
    const builderWorkspace = {
      workspaceId: "ws-tool",
      workspaceName: "change-x--tool-validate",
      gitUrl: "file:///tmp/artifacts/change-x--tool-validate",
      defaultBranch: "main",
      backend: "local-filesystem",
      fallback: true,
      tokenId: "tok-tool",
      tokenExpiresAt: "2026-10-04T12:00:00.000Z",
      leasedAt: "2026-10-04T10:00:00.000Z",
    };
    return {
      id: "change-x",
      objective: "fan out one transform over many files",
      completed: ["validate-a"],
      dial: { minConcurrency: 1, maxConcurrency: 3 },
      work: [
        { id: "tool-validate", objective: "build the codemod", dependsOn: [], paths: ["tools/validate-codemod.mjs"], status: "integrated", leased: false, workspace: builderWorkspace },
        { id: "validate-a", objective: "validate a", dependsOn: [], paths: ["src/a.ts"], status: "integrated", leased: false },
        { id: "validate-b", objective: "validate b", dependsOn: [], paths: ["src/b.ts"], status: "running", leased: true },
      ],
      edges: [],
      tool: {
        builderUnitId: "tool-validate",
        capability: "codemod:validate",
        toolPath: "tools/validate-codemod.mjs",
        workspace: builderWorkspace,
        label: "validate codemod",
      },
      toolConsumptions: [
        { capability: "codemod:validate", consumerUnitId: "validate-a", at: "2026-10-04T10:05:00.000Z" },
        { capability: "codemod:validate", consumerUnitId: "validate-b", at: "2026-10-04T10:06:00.000Z" },
      ],
    };
  }

  it("emits exactly one tool node, backed by the real tool-builder workspace", () => {
    const model = buildWorkGraphModel(toolSnapshot());
    const toolNodes = model.nodes.filter((n) => n.kind === "tool");
    expect(toolNodes).toHaveLength(1);
    const node = toolNodes[0];
    expect(node?.id).toBe(toolNodeId("codemod:validate"));
    expect(node?.backing.kind).toBe("tool");
    expect(node?.workspace?.workspaceName).toBe("change-x--tool-validate");
    expect(node?.verified).toBe(true);
  });

  it("emits a consumed-tool edge per real consumption, from the tool to the consumer", () => {
    const model = buildWorkGraphModel(toolSnapshot());
    const consumed = model.edges.filter((e) => e.kind === "consumed-tool");
    expect(consumed.map((e) => e.to).sort()).toEqual(["unit:validate-a", "unit:validate-b"]);
    for (const edge of consumed) {
      expect(edge.from).toBe(toolNodeId("codemod:validate"));
      expect(edge.backing.kind).toBe("tool-consumption");
    }
  });

  it("every emitted node still passes the backing guard (no unbacked node for the new kinds)", () => {
    const snapshot = toolSnapshot();
    const model = buildWorkGraphModel(snapshot);
    for (const node of model.nodes) {
      expect(() => assertBacked(node, snapshot)).not.toThrow();
    }
  });

  it("rejects a tool node when the state records no tool (the no-unbacked rule for tools)", () => {
    const snapshot: ChangeStateSnapshot = { ...toolSnapshot(), tool: undefined };
    const bogus = {
      id: toolNodeId("codemod:validate"),
      kind: "tool" as const,
      label: "validate codemod",
      status: "integrated" as const,
      verified: true,
      escalated: false,
      workspace: toolSnapshot().tool!.workspace,
      backing: {
        kind: "tool" as const,
        builderUnitId: "tool-validate",
        capability: "codemod:validate",
        workspace: toolSnapshot().tool!.workspace,
      },
    };
    expect(() => assertBacked(bogus, snapshot)).toThrow(/no agent-built tool/);
  });

  it("drops a consumed-tool edge for a consumer the state does not list", () => {
    const snapshot: ChangeStateSnapshot = {
      ...toolSnapshot(),
      toolConsumptions: [
        { capability: "codemod:validate", consumerUnitId: "validate-a", at: "2026-10-04T10:05:00.000Z" },
        { capability: "codemod:validate", consumerUnitId: "ghost", at: "2026-10-04T10:07:00.000Z" },
      ],
    };
    const model = buildWorkGraphModel(snapshot);
    const consumed = model.edges.filter((e) => e.kind === "consumed-tool");
    expect(consumed.map((e) => e.to)).toEqual(["unit:validate-a"]);
  });

  it("surfaces the write lease as an edge from each waiter to the owner", () => {
    const snapshot: ChangeStateSnapshot = {
      id: "change-audit-logging",
      objective: "Add organization-level audit logging",
      completed: [],
      work: [
        { id: "model", objective: "model", dependsOn: [], paths: ["src/audit/**"], status: "running", leased: true },
        { id: "api", objective: "api", dependsOn: ["model"], paths: ["src/api/audit/**", "src/audit/events.ts"], status: "running", leased: true },
        { id: "tests", objective: "tests", dependsOn: [], paths: ["tests/audit/**", "src/audit/events.ts"], status: "running", leased: true },
      ],
      edges: [{ from: "model", to: "api" }],
      leaseEdges: [{ path: "src/audit/events.ts", owner: "api", waiters: ["tests"] }],
    };
    const model = buildWorkGraphModel(snapshot);
    const lease = model.edges.filter((e) => e.kind === "lease");
    expect(lease).toHaveLength(1);
    expect(lease[0]?.from).toBe("unit:tests"); // waiter
    expect(lease[0]?.to).toBe("unit:api"); // owner
    expect(lease[0]?.backing).toEqual({
      kind: "lease",
      path: "src/audit/events.ts",
      owner: "api",
      waiter: "tests",
    });
  });
});

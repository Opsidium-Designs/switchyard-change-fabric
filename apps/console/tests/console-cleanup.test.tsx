/**
 * Offline tests for the console cleanup (no browser, no network):
 *   - agent labels are distinguishable (`unit-<resource>-resource-guards` no
 *     longer collapses to "guards" for every agent);
 *   - the "no Artifact repo yet" note shows only on an unrecruited unit node,
 *     never on goal / planner / verify / retry / jev nodes;
 *   - the verify-round text says the per-round gate is advisory and the final
 *     integration gate decides; the re-fan explainer names the LLM re-plan;
 *   - a zero/missing cost next to real tokens reads "not metered", not $0;
 *   - a non-zero run exit shows the reason from the run log;
 *   - the run panel shows the template once (no repeated what/solves copy);
 *   - template copy is accurate (no fresh end-of-run deploy claim);
 *   - the launcher restores deployed app URLs from .deployments markers.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildWorkGraphModel,
  type ChangeStateSnapshot,
  type GraphNode,
} from "@switchyard-change/orchestration/graph-model";

import { App, NodeDetail, RunStatus, formatCost, runFailureLines } from "../src/App.tsx";
import { GraphView, agentDisplayLabels } from "../src/graph-view.tsx";
import { TEMPLATES, templateById } from "../src/templates.ts";
import { readDeployedUrls } from "../launcher.ts";

const RESOURCES = ["auth", "notifications", "orders", "products", "search", "users"];

function serviceSnapshot(): ChangeStateSnapshot {
  return {
    id: "c",
    objective: "Add input validation and require auth on every resource",
    completed: RESOURCES.slice(1).map((r) => `unit-${r}-resource-guards`),
    work: RESOURCES.map((r, i) => ({
      id: `unit-${r}-resource-guards`,
      objective: `guard ${r}`,
      dependsOn: [],
      paths: [`src/resources/${r}.ts`],
      status: i === 0 ? "running" : "integrated",
      leased: false,
      // The first unit is runnable but has no workspace recorded yet.
      ...(i === 0
        ? {}
        : {
            workspace: {
              workspaceId: `ws-${r}`,
              workspaceName: `c--${r}`,
              gitUrl: `memory://c--${r}`,
              defaultBranch: "main",
              backend: "test",
              fallback: true,
            },
          }),
    })),
    edges: [],
  } as ChangeStateSnapshot;
}

const NO_REPO = "No agent recruited yet";

describe("agent labels are distinguishable", () => {
  it("strips the shared unit-/-resource-guards tokens so each agent shows its resource", () => {
    const model = buildWorkGraphModel(serviceSnapshot());
    const labels = agentDisplayLabels(model.nodes);
    expect([...labels.values()].sort()).toEqual([...RESOURCES].sort());
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model, selectedId: null, onSelect: () => {} }),
    );
    expect(markup).not.toContain(">guards<");
    for (const r of RESOURCES) {
      expect(markup).toContain(`>${r}<`);
      // The full unit id stays in the tooltip.
      expect(markup).toContain(`unit-${r}-resource-guards`);
    }
  });

  it("keeps a (retry N) suffix and falls back to the stripped id for a lone unit", () => {
    const node = (id: string, label: string) =>
      ({ id, kind: "agent", label, status: "running", verified: false, escalated: false }) as GraphNode;
    const two = agentDisplayLabels([
      node("a", "unit-auth-resource-guards"),
      node("b", "unit-auth-resource-guards (retry 2)"),
      node("c", "unit-users-resource-guards"),
    ]);
    expect(two.get("a")).toBe("auth");
    expect(two.get("b")).toBe("auth (retry 2)");
    expect(two.get("c")).toBe("users");
    const lone = agentDisplayLabels([node("a", "unit-auth-resource-guards")]);
    expect(lone.get("a")).toBe("auth-resource-guards");
  });

  it("shows a jev node's juncture as its label and its outcome in the caption", () => {
    const model = {
      changeId: "c",
      nodes: [
        { id: "goal:c", kind: "goal", label: "g", status: "integrated", verified: true, escalated: false, backing: { kind: "change", changeId: "c" } },
        { id: "jev:c#fix-confidence:0", kind: "jev", label: "jev: fix-confidence accepted", status: "integrated", verified: true, escalated: false, backing: { kind: "change", changeId: "c" } },
      ],
      edges: [],
    } as unknown as Parameters<typeof GraphView>[0]["model"];
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model, selectedId: null, onSelect: () => {} }),
    );
    expect(markup).toContain(">fix-confidence<");
    expect(markup).toContain(">jev accepted<");
  });
});

describe("node detail text", () => {
  const model = buildWorkGraphModel(serviceSnapshot());
  const render = (node: GraphNode) =>
    renderToStaticMarkup(createElement(NodeDetail, { node, onClose: () => {} }));

  it("shows the no-repo note only on an unrecruited unit node", () => {
    const unrecruited = model.nodes.find((n) => n.label === "unit-auth-resource-guards")!;
    expect(render(unrecruited)).toContain(NO_REPO);
    const recruited = model.nodes.find((n) => n.label === "unit-users-resource-guards")!;
    expect(render(recruited)).not.toContain(NO_REPO);
    const goal = model.nodes.find((n) => n.kind === "goal")!;
    expect(render(goal)).not.toContain(NO_REPO);
  });

  it("never shows the no-repo note on verify, retry, jev, or planner nodes", () => {
    const base = { status: "integrated", verified: true, escalated: false } as const;
    const nodes: GraphNode[] = [
      { ...base, id: "v", kind: "verify", label: "verify round 1 (app gate) pass", backing: { kind: "verify-attempt", changeId: "c", round: 1, outcome: "pass" } },
      { ...base, id: "r", kind: "retry", label: "retry round 2", backing: { kind: "retry-attempt", changeId: "c", round: 2, fromModel: "a", toModel: "b", implicatedUnits: [], reason: "" } },
      { ...base, id: "j", kind: "jev", label: "jev: plan-review accepted", backing: { kind: "change", changeId: "c" } },
      { ...base, id: "p", kind: "planner", label: "planner", backing: { kind: "change", changeId: "c" } },
    ] as unknown as GraphNode[];
    for (const node of nodes) {
      expect(render(node)).not.toContain(NO_REPO);
    }
  });

  it("says the verify round is advisory and the final integration gate decides", () => {
    const verify = {
      id: "v",
      kind: "verify",
      label: "verify round 1 (app gate) fail",
      status: "failed",
      verified: false,
      escalated: false,
      backing: {
        kind: "verify-attempt",
        changeId: "c",
        round: 1,
        outcome: "fail",
        failingOutput: "boom",
        implicatedUnits: ["unit-auth-resource-guards"],
        refanSource: "re-plan",
      },
    } as unknown as GraphNode;
    const markup = render(verify);
    expect(markup).not.toContain("ran ONCE against the whole integrated change");
    expect(markup).toContain("advisory");
    expect(markup).toContain("final integration");
    expect(markup).not.toContain("configured re-plan");
    expect(markup).toContain("LLM planner re-planning");
  });
});

describe("cost and run-exit display", () => {
  it("reads a zero or missing cost next to real tokens as not metered", () => {
    expect(formatCost({ usd: 0, inputTokens: 1200, outputTokens: 300 })).toBe("not metered");
    expect(formatCost({ inputTokens: 10 })).toBe("not metered");
    expect(formatCost({ usd: 0.0123, inputTokens: 10 })).toBe("$0.0123");
    expect(formatCost({ usd: 0, inputTokens: 0, outputTokens: 0 })).toBe("0");
    expect(formatCost({})).toBeNull();
  });

  it("renders not metered in the model transcript instead of 0", () => {
    const node = {
      id: "unit:x",
      kind: "agent",
      label: "x",
      status: "integrated",
      verified: true,
      escalated: false,
      backing: { kind: "change", changeId: "c" },
      detail: { model: "gpt-4o", inputTokens: 1500, outputTokens: 400, usd: 0 },
    } as unknown as GraphNode;
    const markup = renderToStaticMarkup(createElement(NodeDetail, { node, onClose: () => {} }));
    expect(markup).toContain("not metered");
    expect(markup).not.toContain("<dd>0</dd>");
  });

  it("shows the run's own Error: line on a non-zero exit, and the log tail when there is no summary line", () => {
    const log = ["Error: planner returned no plan", ...Array.from({ length: 10 }, (_, i) => `line ${i}`)];
    expect(runFailureLines(log, 4)).toEqual(["Error: planner returned no plan"]);
    expect(runFailureLines(["a", "b"])).toEqual(["a", "b"]);
    expect(runFailureLines(Array.from({ length: 10 }, (_, i) => `line ${i}`), 4)).toEqual(["line 6", "line 7", "line 8", "line 9"]);
  });

  it("shows the run's verdict and summary lines, never npm's error boilerplate", () => {
    const log = [
      "Board run for change-x",
      "  integrated revision 3: gate fail, commit abc, merged 2 push(es) (items a, b)",
      "    failure: not ok 4 - users: rejects a bad body",
      "  items completed: 4 of 6 (1 worker proposal(s) rejected: not counted)",
      "    proposal rejected: agent-2-item-1 by lead: agent-2-item-1 duplicates item u-notifications",
      "    not completed: item u-users: its push passed in rev 2 but its owner did not propose done (owner agent-1)",
      "  verdict: verified (partial: 2 item(s) not completed: u-users, u-orders; the Change is not complete) (the gate of the last revision, 3)",
      "    partial: the last revision passed, but 1 announced push(es) were never gated (items u-orders): a partial result is not verified",
      "  not promoted: nothing was integrated",
      "npm error Lifecycle script `dev` failed with error:",
      "npm error code 1",
      "npm error path /somewhere/apps/cli",
      "npm error workspace @switchyard-change/cli@0.0.0",
      "npm error command failed",
    ];
    const lines = runFailureLines(log);
    expect(lines).toEqual([
      "failure: not ok 4 - users: rejects a bad body",
      "items completed: 4 of 6 (1 worker proposal(s) rejected: not counted)",
      "proposal rejected: agent-2-item-1 by lead: agent-2-item-1 duplicates item u-notifications",
      "not completed: item u-users: its push passed in rev 2 but its owner did not propose done (owner agent-1)",
      "verdict: verified (partial: 2 item(s) not completed: u-users, u-orders; the Change is not complete) (the gate of the last revision, 3)",
      "partial: the last revision passed, but 1 announced push(es) were never gated (items u-orders): a partial result is not verified",
      "not promoted: nothing was integrated",
    ]);
    expect(lines.some((l) => l.startsWith("npm error"))).toBe(false);
    // Only npm boilerplate: nothing of it is shown as the reason.
    expect(runFailureLines(["npm error code 1", "npm error command failed"])).toEqual([]);
    const markup = renderToStaticMarkup(
      createElement(RunStatus, {
        changeId: "c",
        template: null,
        launchStatus: { status: "exited", exitCode: 1, log },
        redeployed: false,
        dial: { min: 1, max: 3 },
        busy: false,
        onTearDown: () => {},
      }),
    );
    const [summaryPart, rawPart] = markup.split("show raw log");
    expect(summaryPart).toContain("verdict: verified (partial");
    expect(summaryPart).not.toContain("npm error");
    // The raw log is one toggle away, untouched.
    expect(markup).toContain('<details class="run-raw-log"><summary>show raw log</summary>');
    expect(rawPart).toContain("npm error code 1");
  });

  it("shows the failure reason and only the template name in the run panel", () => {
    const template = templateById("service-api")!;
    const markup = renderToStaticMarkup(
      createElement(RunStatus, {
        changeId: "console-service-api-x",
        template,
        launchStatus: { status: "exited", exitCode: 1, log: ["starting", "Error: worker unreachable"] },
        redeployed: false,
        dial: { min: 1, max: 3 },
        busy: false,
        onTearDown: () => {},
      }),
    );
    expect(markup).toContain("Error: worker unreachable");
    expect(markup).toContain("exited (code 1)");
    expect(markup).toContain(template.name);
    expect(markup).not.toContain(template.whatItDoes);
    expect(markup).not.toContain("What this does");
    expect(markup).toContain("min 1 / max 3 (locked)");
  });
});

describe("template copy and initial layout", () => {
  it("no longer claims a fresh end-of-run deploy and keeps the before/after facts", () => {
    const api = templateById("service-api")!;
    const all = JSON.stringify(api);
    expect(all).not.toContain("end-of-run proof");
    expect(api.problemItSolves).toContain("201");
    expect(api.problemItSolves).toContain("401");
    expect(api.problemItSolves).toContain("400");
    expect(api.problemItSolves).toContain("Deployed the app first");
  });

  it("describes the audit contention as single-writer ownership plus an escalation", () => {
    const audit = templateById("audit-logging")!;
    expect(audit.problemItSolves).toContain("src/audit/events.ts");
    expect(audit.problemItSolves).toContain("single-writer");
    expect(audit.problemItSolves).toContain("escalates");
  });

  it("renders the gallery once with no standalone flow panel before a run", () => {
    const markup = renderToStaticMarkup(createElement(App));
    expect(markup).not.toContain('aria-label="How this works"');
    for (const t of TEMPLATES) {
      expect(markup.split(t.whatItDoes).length - 1).toBe(1);
    }
    expect(markup).toContain('aria-label="Concurrency dial"');
  });
});

describe("launcher deployed-URL restore", () => {
  it("reads only known apps' https URLs from .deployments markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "deployments-"));
    try {
      await mkdir(join(root, ".deployments"));
      await writeFile(
        join(root, ".deployments", "service-api.json"),
        JSON.stringify({ app: "service-api", url: "https://svc.example.workers.dev" }),
      );
      await writeFile(join(root, ".deployments", "bad.json"), JSON.stringify({ url: "javascript:alert(1)" }));
      await writeFile(join(root, ".deployments", "broken.json"), "{not json");
      const urls = await readDeployedUrls(root, ["service-api", "bad", "broken", "missing", "../x"]);
      expect(urls).toEqual({ "service-api": "https://svc.example.workers.dev" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Offline tests for three console honesty fixes:
 *   - a heuristic-fallback planner node (built by the real graph model) renders
 *     AMBER with a clear warning, never as the plain-success green;
 *   - "did the change pass?" follows the goal's authoritative integration
 *     verdict over a passing ladder round;
 *   - mutations go through the launcher's auth proxy when it exists (so no
 *     Worker secret lives in the bundle) and fall back to a direct Worker POST
 *     only when there is no proxy, never sending a mutation twice;
 *   - a node awaiting a human decision (a pending escalation) is YELLOW, never
 *     the failed red and never the heuristic-fallback warning amber.
 *
 * Rendering uses react-dom/server (no jsdom), and fetch is faked, so `make
 * check` stays offline and deterministic.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildWorkGraphModel,
  type ChangeStateSnapshot,
} from "@switchyard-change/orchestration/graph-model";

import { NodeDetail } from "../src/App.tsx";
import { AWAITING_FILL, GraphView, WARNING_FILL, changeHasPassed } from "../src/graph-view.tsx";
import { WORKER_PROXY_MARKER, WORKER_PROXY_PREFIX, postToWorker } from "../src/worker-post.ts";

function snapshot(overrides: Partial<ChangeStateSnapshot> = {}): ChangeStateSnapshot {
  return {
    id: "c",
    objective: "fix it",
    completed: ["fix"],
    work: [
      {
        id: "fix",
        objective: "fix the bug",
        dependsOn: [],
        paths: ["src/fix.js"],
        status: "integrated",
        leased: false,
        workspace: {
          workspaceId: "ws-fix",
          workspaceName: "c--fix",
          gitUrl: "memory://c--fix",
          defaultBranch: "main",
          backend: "test",
          fallback: true,
        },
      },
    ],
    edges: [],
    ...overrides,
  };
}

describe("a heuristic-fallback planner node renders as a warning, not success", () => {
  const fallback = buildWorkGraphModel(
    snapshot({ plan: { source: "heuristic-fallback", model: "", units: ["fix"], contracts: [] } }),
  );
  const planner = fallback.nodes.find((n) => n.kind === "planner")!;

  it("draws the planner amber with the warning in its tooltip", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: fallback, selectedId: null, onSelect: () => {} }),
    );
    expect(markup).toContain(`fill="${WARNING_FILL}"`);
    expect(markup).toContain("is-warning");
    expect(markup).toContain("WARNING: Heuristic fallback");
  });

  it("shows the warning text in the planner detail panel", () => {
    const markup = renderToStaticMarkup(createElement(NodeDetail, { node: planner, onClose: () => {} }));
    expect(markup).toContain("detail-warning");
    expect(markup).toContain("no planner model returned a usable plan");
  });

  it("keeps a real planner node free of the warning", () => {
    const model = buildWorkGraphModel(
      snapshot({ plan: { source: "planner", model: "gpt-x", units: ["fix"], contracts: [] } }),
    );
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model, selectedId: null, onSelect: () => {} }),
    );
    expect(markup).not.toContain(`fill="${WARNING_FILL}"`);
    expect(markup).not.toContain("is-warning");
  });
});

describe("changeHasPassed follows the authoritative integration verdict", () => {
  const ladderPass = {
    verifyAttempts: [{ round: 1, outcome: "pass" as const, model: "base", at: "t1" }],
  };

  it("is false when the ladder passed but integration failed", () => {
    const model = buildWorkGraphModel(
      snapshot({
        ...ladderPass,
        integration: { verdict: "failed", integratedUnits: [], excludedUnits: ["fix"] },
      }),
    );
    expect(changeHasPassed(model)).toBe(false);
    // And the goal diamond is not green.
    expect(model.nodes.find((n) => n.kind === "goal")?.verified).toBe(false);
  });

  it("is true when integration verified", () => {
    const model = buildWorkGraphModel(
      snapshot({
        ...ladderPass,
        integration: { verdict: "verified", integratedUnits: ["fix"], excludedUnits: [] },
      }),
    );
    expect(changeHasPassed(model)).toBe(true);
  });
});

describe("console mutations prefer the launcher auth proxy", () => {
  function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
    const calls: string[] = [];
    const fn = async (url: string, _init?: RequestInit) => {
      calls.push(url);
      return handler(url);
    };
    return { fn, calls };
  }

  it("uses the proxy and never posts the Worker directly when the proxy answers", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response("{}", { status: 404, headers: { [WORKER_PROXY_MARKER]: "1" } }),
    );
    const res = await postToWorker(fn, "http://worker:8787", "/changes/c/escalations/e/resolve", { decision: "ok" });
    // The Worker's own 404 relayed by the proxy is returned as is: no double post.
    expect(res.status).toBe(404);
    expect(calls).toEqual([`${WORKER_PROXY_PREFIX}/changes/c/escalations/e/resolve`]);
  });

  it("falls back to a direct Worker POST when there is no proxy (unmarked 404)", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.startsWith(WORKER_PROXY_PREFIX) ? new Response("", { status: 404 }) : new Response("{}", { status: 200 }),
    );
    const res = await postToWorker(fn, "http://worker:8787", "/changes/c/dial", { min: 1 });
    expect(res.status).toBe(200);
    expect(calls).toEqual([`${WORKER_PROXY_PREFIX}/changes/c/dial`, "http://worker:8787/changes/c/dial"]);
  });

  it("falls back when the launcher is unreachable", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.startsWith(WORKER_PROXY_PREFIX)) {
        throw new TypeError("network");
      }
      return new Response("{}", { status: 201 });
    });
    const res = await postToWorker(fn, "http://worker:8787", "/changes/c/dial");
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
  });
});

describe("a pending human escalation reads as awaiting you (yellow), not failed", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const FAILED_REDS = ["#f85149", "#da3633", "#8b2c22"];

  it("fills an escalated node with the awaiting yellow, distinct from failed and warning", () => {
    expect(AWAITING_FILL).not.toBe(WARNING_FILL);
    expect(FAILED_REDS).not.toContain(AWAITING_FILL);
    const model = {
      changeId: "c",
      nodes: [
        { id: "work:c#fix", kind: "work", label: "fix", status: "running", verified: false, escalated: true, backing: { kind: "change", changeId: "c" } },
      ],
      edges: [],
    } as unknown as Parameters<typeof GraphView>[0]["model"];
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model, selectedId: null, onSelect: () => {} }),
    );
    expect(markup).toContain(`fill="${AWAITING_FILL}"`);
    for (const red of FAILED_REDS) {
      expect(markup).not.toContain(`fill="${red}"`);
    }
  });

  it("keys the legend and the escalation panel to the same yellow, not red", async () => {
    const css = (await readFile(join(here, "..", "src", "styles.css"), "utf8")).replace(/\s+/g, " ");
    expect(css).toContain(`.sw-escalated { background: ${AWAITING_FILL}; }`);
    expect(css).toMatch(new RegExp(`\\.escalation-panel \\{[^}]*border-left: 3px solid ${AWAITING_FILL}`));
    expect(css).toMatch(new RegExp(`\\.escalation\\.pending \\{[^}]*border: 1px solid ${AWAITING_FILL}`));
  });
});

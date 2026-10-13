/**
 * Each template sets its own agent counts; the console has no dial (offline,
 * no browser, no network):
 *   - every template declares min/max agents for run-live and for the board;
 *   - the launcher passes exactly the template's counts as --min/--max and
 *     ignores any min/max a request body carries;
 *   - the gallery shows a read-only line per template and no dial inputs;
 *   - the run panel shows the run's actual agents, never a configured dial.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";
import type { WorkGraphModel } from "@switchyard-change/orchestration/graph-model";

import { launchArgs, launchRequestFromBody } from "../launcher";
import { App, RunStatus, boardAgentCount, liveAgentCount } from "../src/App.tsx";
import { agentCountLine, agentCountsOf, TEMPLATES, templateById, type LaunchMode } from "../src/templates.ts";

const MODES: readonly LaunchMode[] = ["live", "board"];

/** The value after a flag in a CLI arg list. */
function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

describe("each template's own agent counts", () => {
  it("are declared for both modes, coherent, and match the recorded runs", () => {
    for (const t of TEMPLATES) {
      for (const mode of MODES) {
        const { min, max } = agentCountsOf(t, mode);
        expect(Number.isInteger(min) && min >= 1, `${t.id} ${mode} min`).toBe(true);
        expect(Number.isInteger(max) && max >= min, `${t.id} ${mode} max`).toBe(true);
      }
    }
    expect(templateById("audit-logging")!.agents).toEqual({ live: { min: 1, max: 3 }, board: { min: 1, max: 3 } });
    expect(templateById("service-api")!.agents).toEqual({ live: { min: 1, max: 6 }, board: { min: 1, max: 3 } });
    expect(templateById("storefront")!.agents).toEqual({ live: { min: 1, max: 6 }, board: { min: 1, max: 6 } });
    expect(templateById("cityhall")!.agents).toEqual({ live: { min: 1, max: 8 }, board: { min: 8, max: 30 } });
  });

  it("read as one plain line per mode", () => {
    const cityhall = templateById("cityhall")!;
    expect(agentCountLine(cityhall, "board")).toBe("Runs with a lead and up to 30 agents (8 to start)");
    expect(agentCountLine(cityhall, "live")).toBe("Runs with up to 8 agents (1 to start)");
  });
});

describe("the launcher uses the template's counts", () => {
  it("passes exactly the template's --min/--max for each mode", () => {
    for (const t of TEMPLATES) {
      for (const mode of MODES) {
        const args = launchArgs(t, "x", { mode, contractPolicy: "console" });
        const { min, max } = agentCountsOf(t, mode);
        expect(flag(args, "--min"), `${t.id} ${mode}`).toBe(String(min));
        expect(flag(args, "--max"), `${t.id} ${mode}`).toBe(String(max));
        expect(args.filter((a) => a === "--min" || a === "--max")).toHaveLength(2);
      }
    }
  });

  it("ignores any min/max in the request body", () => {
    for (const body of [
      { templateId: "cityhall", mode: "board", min: 1, max: 99 },
      { templateId: "cityhall", mode: "board", min: "200", max: -4 },
      { templateId: "cityhall", mode: "board" },
    ]) {
      const resolved = launchRequestFromBody(body);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved).not.toHaveProperty("dial");
      const args = launchArgs(resolved.template, "x", resolved.options);
      expect(flag(args, "--min")).toBe("8");
      expect(flag(args, "--max")).toBe("30");
    }
    const live = launchRequestFromBody({ templateId: "service-api", min: 7, max: 8 });
    expect(live.ok).toBe(true);
    if (live.ok) {
      const args = launchArgs(live.template, "x", live.options);
      expect(flag(args, "--min")).toBe("1");
      expect(flag(args, "--max")).toBe("6");
    }
  });

  it("still refuses an unknown template or mode", () => {
    expect(launchRequestFromBody({ templateId: "../etc" })).toEqual({ ok: false, error: "unknown template: ../etc" });
    expect(launchRequestFromBody({ templateId: "cityhall", mode: "x" })).toMatchObject({ ok: false });
  });
});

describe("the console has no dial", () => {
  it("shows each template's read-only agent line and no dial inputs", () => {
    const markup = renderToStaticMarkup(createElement(App));
    expect(markup).not.toContain('type="range"');
    expect(markup).not.toContain("dial-min");
    expect(markup).not.toContain("dial-max");
    expect(markup).not.toContain("Use dial");
    expect(markup).not.toContain("Concurrency");
    expect(markup).not.toMatch(/locked/i);
    for (const t of TEMPLATES) {
      expect(markup).toContain(agentCountLine(t, "live"));
    }
  });
});

describe("the run panel's agent count", () => {
  const msg = (seq: number, type: string, from: string) =>
    ({ seq, type, from, payload: {} }) as unknown as BoardMessage;

  it("counts a board run's joined and still active agents from the log", () => {
    const log = [
      msg(1, "goal.posted", "human"),
      msg(2, "agent.joined", "lead"),
      msg(3, "agent.joined", "w1"),
      msg(4, "agent.joined", "w2"),
      msg(5, "agent.left", "w1"),
    ];
    expect(boardAgentCount(log)).toEqual({ joined: 3, active: 2 });
    expect(boardAgentCount([])).toEqual({ joined: 0, active: 0 });
  });

  it("counts a run-live run's recruited and running agents from the graph", () => {
    const model = {
      nodes: [
        { id: "a", kind: "agent", status: "running" },
        { id: "b", kind: "agent", status: "verified" },
        { id: "c", kind: "work", status: "waiting" },
      ],
      edges: [],
    } as unknown as WorkGraphModel;
    expect(liveAgentCount(model)).toEqual({ joined: 2, active: 1 });
  });

  it("shows the actual agents and never a dial", () => {
    const base = {
      changeId: "c",
      template: templateById("cityhall")!,
      launchStatus: { status: "running" as const, exitCode: null, log: [] },
      redeployed: false,
      busy: false,
      onTearDown: () => {},
    };
    const html = renderToStaticMarkup(createElement(RunStatus, { ...base, agents: { joined: 12, active: 9 } }));
    expect(html).toContain("12 agents joined, 9 active");
    expect(html).not.toMatch(/dial|locked/i);
    expect(renderToStaticMarkup(createElement(RunStatus, { ...base, agents: { joined: 0, active: 0 } }))).toContain("no agents yet");
    expect(renderToStaticMarkup(createElement(RunStatus, base))).not.toContain("agents joined");
  });
});

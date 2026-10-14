/**
 * The live console's home and run pages, offline (no browser, no network, no
 * wrangler: every spawned CLI is a fake child):
 *   - the routes (/ is home, ?run=<id> a launched run, ?watch=<id> a CLI run);
 *   - home renders the templates and the runs table, and no run; a run page
 *     renders only that run, with a Home link and no templates;
 *   - one live run at a time: Launch disabled on every card while a run is in
 *     progress (the launcher's, or a followed CLI run the Worker reports
 *     unfinished), and the launcher's 409 naming the active run;
 *   - the runs table (replays with an Open replay link when the replay page is
 *     configured, launched runs, the watched run);
 *   - the app panel's states (original and fixed side by side, Publish the
 *     fixed version enabled only for a verified, promoted, exited run with the
 *     original deployed; the exact make command for a CLI run);
 *   - the launcher's parsing of a run's `promoted:` / `repo:` lines, the
 *     pre-deploy of the original for a board app run, and publish-fixed.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import {
  activeRun,
  launchConflict,
  launchRequest,
  listRuns,
  parseRunOutputLine,
  publishFixedArgs,
  publishFixedRequest,
  pushLog,
  templatesWithGoalText,
  type LaunchedRun,
  type SpawnFn,
} from "../launcher";
import { App, TemplateGallery, templateForObjective } from "../src/App.tsx";
import {
  ActiveRunNotice,
  AppPanel,
  appPanelState,
  joinedAgents,
  publishFixedCommand,
  RunsTable,
} from "../src/console-pages.tsx";
import {
  activeRunFor,
  readLaunchedRuns,
  replayBaseUrl,
  replayHref,
  routeFromSearch,
  runHref,
  snapshotFinished,
  type LaunchedRunSummary,
} from "../src/console-route.ts";
import { TEMPLATES, templateById } from "../src/templates.ts";

/** Render with a given window.location.search (and no other browser API). */
function renderAt(search: string): string {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const previous = g.window;
  g.window = { location: { search, pathname: "/" } };
  try {
    return renderToStaticMarkup(createElement(App));
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

/** A fake `spawn`: records each call; each child prints its output and exits with its code. */
function fakeSpawn(results: { code: number | null; stdout?: string }[] | { code: number | null; stdout?: string }) {
  const queue = Array.isArray(results) ? [...results] : null;
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const children: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter })[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const result = queue ? (queue.shift() ?? { code: 0 }) : (results as { code: number | null; stdout?: string });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    // A launched run stays running (the test drives it); a short CLI exits at once.
    if (!args.includes("run-live") && !args.includes("run-board")) {
      setImmediate(() => {
        if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
        child.emit("exit", result.code);
      });
    }
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls, children };
}

function trackedRun(over: Partial<LaunchedRun> = {}): LaunchedRun {
  return {
    changeId: "console-storefront-abc",
    templateId: "storefront",
    status: "exited",
    exitCode: 0,
    mode: "board",
    startedAt: "2026-10-13T10:00:00.000Z",
    log: [],
    ...over,
  };
}

describe("routes", () => {
  it("/ is home, ?run= a launched run, ?watch= a CLI run (read-only)", () => {
    expect(routeFromSearch("")).toEqual({ kind: "home" });
    expect(routeFromSearch("?run=console-storefront-mg3x1abcde")).toEqual({ kind: "run", changeId: "console-storefront-mg3x1abcde", watch: false });
    expect(routeFromSearch("?watch=change-board-abc123")).toEqual({ kind: "run", changeId: "change-board-abc123", watch: true });
    expect(routeFromSearch("?run=../etc")).toEqual({ kind: "home" });
    expect(routeFromSearch("?watch=change-ABC")).toEqual({ kind: "home" });
    expect(runHref("console-x-1", false)).toBe("?run=console-x-1");
    expect(runHref("change-x", true)).toBe("?watch=change-x");
  });

  it("the replay link: VITE_REPLAY_URL as an http(s) URL or a same-origin path, else hidden", () => {
    expect(replayBaseUrl(undefined)).toBeNull();
    expect(replayBaseUrl("")).toBeNull();
    expect(replayBaseUrl("javascript:alert(1)")).toBeNull();
    expect(replayBaseUrl("//evil.example")).toBeNull();
    expect(replayBaseUrl("http://localhost:5180/")).toBe("http://localhost:5180/");
    expect(replayBaseUrl("/replay/")).toBe("/replay/");
    expect(replayHref("http://localhost:5180/", "board-live-sf21")).toBe("http://localhost:5180/?run=board-live-sf21");
    expect(replayHref("/replay/?theme=dark", "x")).toBe("/replay/?theme=dark&run=x");
  });

  it("the active run: the launcher's, else a followed CLI run the Worker reports unfinished", () => {
    expect(activeRunFor("console-a", null)).toEqual({ changeId: "console-a", href: "?run=console-a", source: "launcher" });
    expect(activeRunFor(null, { changeId: "change-b", finished: false })).toEqual({ changeId: "change-b", href: "?watch=change-b", source: "watch" });
    expect(activeRunFor(null, { changeId: "change-b", finished: true })).toBeNull();
    expect(snapshotFinished({ integration: null })).toBe(false);
    expect(snapshotFinished({ integration: { verdict: "failed" } })).toBe(true);
    expect(snapshotFinished({ status: "planning-failed" })).toBe(true);
  });
});

describe("home vs run page", () => {
  it("home renders the templates and the runs table, and no run", () => {
    const html = renderAt("");
    expect(html).toContain('aria-label="Template gallery"');
    expect(html).toContain('aria-label="Runs"');
    expect(html).toContain("Recorded replays");
    expect(html).toContain("Live runs");
    for (const t of TEMPLATES) expect(html).toContain(`Launch ${t.name}`);
    expect(html).not.toContain('aria-label="Run status"');
    expect(html).not.toContain("Tear down");
    expect(html).not.toContain("&lt;- Home");
  });

  it("a launched run's page shows only that run: Home link, status, no templates", () => {
    const html = renderAt("?run=console-storefront-mg3x1abcde");
    expect(html).toContain("&lt;- Home");
    expect(html).toContain('aria-label="Run status"');
    expect(html).toContain("console-storefront-mg3x1abcde");
    expect(html).toContain("Tear down (repos)");
    expect(html).not.toContain('aria-label="Template gallery"');
    expect(html).not.toContain("Show templates");
    expect(html).not.toContain('aria-label="Runs"');
  });

  it("a ?watch= run page is read-only: no Tear down, no templates", () => {
    const html = renderAt("?watch=change-board-abc123");
    expect(html).toContain("&lt;- Home");
    expect(html).toContain("change-board-abc123");
    expect(html).not.toContain("Tear down");
    expect(html).not.toContain('aria-label="Template gallery"');
  });
});

describe("one live run at a time", () => {
  const props = {
    templates: TEMPLATES,
    busy: false,
    deployedUrls: {},
    onLaunch: () => {},
    onDeploy: () => {},
    onRemove: () => {},
  };

  it("disables Launch on every template while a launched run is in progress, naming it", () => {
    const active = activeRunFor("console-cityhall-x", null)!;
    const html = renderToStaticMarkup(createElement(TemplateGallery, { ...props, activeRun: active }));
    const buttons = html.match(/<button[^>]*>Launch [^<]*<\/button>/g) ?? [];
    expect(buttons.length).toBe(TEMPLATES.length);
    for (const b of buttons) {
      expect(b).toContain('disabled=""');
      expect(b).toContain("A run is in progress: console-cityhall-x");
    }
    const notice = renderToStaticMarkup(createElement(ActiveRunNotice, { active }));
    expect(notice).toContain("A run is in progress: <code>console-cityhall-x</code>");
    expect(notice).toContain('href="?run=console-cityhall-x"');
    expect(notice).toContain("open it");
  });

  it("a followed CLI run explains in a tooltip that the launcher cannot know it", () => {
    const active = activeRunFor(null, { changeId: "change-board-q", finished: false })!;
    const html = renderToStaticMarkup(createElement(TemplateGallery, { ...props, activeRun: active }));
    expect(html).toContain("The launcher cannot know about CLI runs");
    expect(renderToStaticMarkup(createElement(ActiveRunNotice, { active }))).toContain('title="This run was started from the CLI');
  });

  it("enables Launch when no run is in progress", () => {
    const html = renderToStaticMarkup(createElement(TemplateGallery, { ...props, activeRun: null }));
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Launch /);
  });

  it("the launcher refuses a second launch with 409 naming the active run, and spawns nothing", async () => {
    const tracked = new Map<string, LaunchedRun>([["console-cityhall-x", trackedRun({ changeId: "console-cityhall-x", templateId: "cityhall", status: "running", exitCode: null })]]);
    const { spawnFn, calls } = fakeSpawn({ code: 0 });
    const result = await launchRequest({ templateId: "storefront" }, { spawnFn, tracked, appDeployed: async () => true, state: { launching: false } });
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("console-cityhall-x");
    expect(result.body.activeRun).toMatchObject({ changeId: "console-cityhall-x", templateId: "cityhall" });
    expect(calls).toEqual([]);
    // A launch already starting is refused too.
    expect(launchConflict([], true)?.status).toBe(409);
    expect(launchConflict([trackedRun()], false)).toBeUndefined();
  });

  it("a launch is tracked as running until its child exits; the listing names it active", async () => {
    const tracked = new Map<string, LaunchedRun>();
    const { spawnFn, calls, children } = fakeSpawn({ code: 0 });
    const result = await launchRequest({ templateId: "storefront" }, { spawnFn, tracked, appDeployed: async () => true, state: { launching: false } });
    expect(result.status).toBe(201);
    const id = String(result.body.changeId);
    expect(calls.at(-1)!.args).toContain("run-live");
    expect(activeRun(tracked.values())?.changeId).toBe(id);
    expect(listRuns(tracked)).toMatchObject({ active: id, runs: [{ changeId: id, templateId: "storefront", status: "running" }] });
    children.at(-1)!.emit("exit", 0);
    expect(listRuns(tracked)).toMatchObject({ active: null, runs: [{ status: "exited", exitCode: 0 }] });
  });

  it("a board app run deploys the original first when it is not deployed, then runs with the fixed preview", async () => {
    const tracked = new Map<string, LaunchedRun>();
    const { spawnFn, calls } = fakeSpawn([{ code: 0, stdout: "Deployed: https://switchyard-change-fabric-storefront.acct.workers.dev\n" }]);
    const result = await launchRequest({ templateId: "storefront", mode: "board" }, { spawnFn, tracked, appDeployed: async () => false, state: { launching: false } });
    expect(result.status).toBe(201);
    expect(calls[0]!.args).toContain("deploy-app");
    expect(calls[1]!.args).toContain("run-board");
    expect(calls[1]!.args).toContain("--preview-passing");
    expect(result.body.deployedOriginal).toBe("https://switchyard-change-fabric-storefront.acct.workers.dev");
  });

  it("a failed pre-deploy still launches, without the fixed preview, and says why", async () => {
    const tracked = new Map<string, LaunchedRun>();
    const { spawnFn, calls } = fakeSpawn([{ code: 1, stdout: "Deploy failed: not authenticated\n" }]);
    const result = await launchRequest({ templateId: "storefront", mode: "board" }, { spawnFn, tracked, appDeployed: async () => false, state: { launching: false } });
    expect(result.status).toBe(201);
    expect(calls[1]!.args).not.toContain("--preview-passing");
    expect(String(result.body.previewSkipped)).toContain("no fixed preview");
  });
});

describe("the runs table", () => {
  const replays = [
    { id: "board-live-sf21", title: "Storefront (passed)", app: "storefront", outcome: "verified" as const, description: "", messages: 137 },
    { id: "board-sim-100", title: "SIMULATED", app: "scale-project", outcome: "verified" as const, description: "", messages: 853, simulated: true },
  ];
  const launched: LaunchedRunSummary[] = [
    { changeId: "console-storefront-abc", templateId: "storefront", status: "exited", exitCode: 0, mode: "board", startedAt: "2026-10-13T10:00:00.000Z" },
  ];

  it("lists recorded replays (title, app, outcome, agents, messages) with an Open replay link when configured", () => {
    const html = renderToStaticMarkup(
      createElement(RunsTable, { replays, replayAgents: { "board-live-sf21": 7 }, replayBase: "http://localhost:5180/", launched: [], templates: TEMPLATES }),
    );
    expect(html).toContain("Storefront (passed)");
    expect(html).toContain("<td>7</td>");
    expect(html).toContain("<td>137</td>");
    expect(html).toContain("verified (simulated)");
    expect(html).toContain('href="http://localhost:5180/?run=board-live-sf21"');
    expect(html).not.toContain("VITE_REPLAY_URL");
  });

  it("hides Open replay with a hint when the replay page is not configured", () => {
    const html = renderToStaticMarkup(createElement(RunsTable, { replays, replayBase: null, launched: [], templates: TEMPLATES }));
    expect(html).not.toContain("Open replay");
    expect(html).toContain("VITE_REPLAY_URL");
    expect(html).toContain("dev:replay");
  });

  it("lists launched runs and the watched CLI run, each opening its run page", () => {
    const html = renderToStaticMarkup(
      createElement(RunsTable, { replays: [], replayBase: null, launched, watched: { changeId: "change-board-q", finished: false }, templates: TEMPLATES }),
    );
    expect(html).toContain('href="?run=console-storefront-abc"');
    expect(html).toContain(templateById("storefront")!.name);
    expect(html).toContain("exited (code 0)");
    expect(html).toContain('href="?watch=change-board-q"');
    expect(html).toContain("started from the CLI");
  });

  it("counts a replay's agents from its recorded joins, and reads the launcher listing defensively", () => {
    expect(joinedAgents([{ type: "agent.joined", from: "a" }, { type: "agent.joined", from: "a" }, { type: "agent.joined", from: "b" }, { type: "claim", from: "c" }])).toBe(2);
    expect(readLaunchedRuns({ runs: [launched[0], { changeId: 1 }], active: "console-storefront-abc" })).toEqual({ runs: [launched[0]], active: "console-storefront-abc" });
    expect(readLaunchedRuns(null)).toEqual({ runs: [], active: null });
  });
});

describe("the app panel", () => {
  const verified = { integration: { verdict: "verified", integratedUnits: [], excludedUnits: [] } };
  const deployedUrl = "https://switchyard-change-fabric-storefront.acct.workers.dev";
  const exited = { status: "exited" as const, repoDir: "/work/source", promoted: { branch: "switchyard/fix", commit: "15d7d40565" } };
  const base = { app: "storefront", changeId: "console-storefront-abc", watch: false, snapshot: verified, boardLog: [], previews: [] };
  const msg = (seq: number, type: string, payload: Record<string, unknown>) => ({ seq, type, from: "engine", payload }) as unknown as BoardMessage;

  it("enables Publish the fixed version only for a verified, promoted, exited run with the original deployed", () => {
    const ok = appPanelState({ ...base, deployedUrl, launched: exited });
    expect(ok.original).toEqual({ url: deployedUrl, servesFix: false });
    expect(ok.fixed).toBeNull();
    expect(ok.publish).toMatchObject({ enabled: true, reason: null });

    expect(appPanelState({ ...base, deployedUrl, launched: { ...exited, status: "running" } }).publish).toMatchObject({ enabled: false, reason: expect.stringContaining("exited") });
    expect(appPanelState({ ...base, deployedUrl, launched: exited, snapshot: { integration: null } }).publish?.reason).toContain("recorded verdict: none");
    expect(appPanelState({ ...base, deployedUrl, launched: exited, snapshot: { integration: { verdict: "verified", gated: false } } }).publish?.reason).toContain("no gate");
    expect(appPanelState({ ...base, launched: exited }).publish?.reason).toContain("Deploy the original first");
    expect(appPanelState({ ...base, deployedUrl, launched: { status: "exited" } }).publish?.reason).toContain("no promoted commit");
    expect(appPanelState({ ...base, deployedUrl, redeployedUrl: deployedUrl, launched: exited }).publish?.reason).toContain("redeployed in place");
  });

  it("a CLI run (?watch=) gets the button disabled with the exact make command (commit and branch from its board)", () => {
    const state = appPanelState({
      ...base,
      changeId: "change-board-q",
      watch: true,
      deployedUrl,
      launched: null,
      boardLog: [msg(1, "revision.promoted", { rev: 3, commit: "abcdef1234567", branch: "switchyard/change-board-q" })],
    });
    expect(state.publish?.enabled).toBe(false);
    expect(state.publish?.command).toBe(
      "make publish-fixed CHANGE=change-board-q APP=storefront REPO=<the repo: line of the run's output> COMMIT=abcdef1234567 BRANCH=switchyard/change-board-q",
    );
    expect(publishFixedCommand({ changeId: "c", app: "a", repoDir: "/r", commit: "1234567", branch: "b" })).toBe("make publish-fixed CHANGE=c APP=a REPO=/r COMMIT=1234567 BRANCH=b");
  });

  it("shows the passing-revision preview as the fixed version, and no Publish once it is the promoted revision", () => {
    const commit = "a".repeat(40);
    const preview = { n: 3, commit, url: "https://fixed-abc-switchyard-change-fabric-storefront.acct.workers.dev", alias: "fixed-abc", at: "" };
    const log = [msg(1, "integrated.rev", { n: 3, commit, gate: "pass" })];
    const during = appPanelState({ ...base, deployedUrl, launched: { status: "running" }, boardLog: log, previews: [preview] });
    expect(during.fixed).toMatchObject({ url: preview.url, label: "Fixed by this run (revision 3)" });
    const promoted = appPanelState({ ...base, deployedUrl, launched: exited, boardLog: [...log, msg(2, "revision.promoted", { rev: 3, commit: "b".repeat(40) })], previews: [preview] });
    expect(promoted.publish).toBeNull();
    // A preview whose commit is not the revision's is not shown.
    expect(appPanelState({ ...base, deployedUrl, launched: exited, boardLog: log, previews: [{ ...preview, commit: "c".repeat(40) }] }).fixed).toBeNull();
  });

  it("shows a published fixed version, and renders Original and Fixed by this run side by side", () => {
    const fixedUrl = "https://fixed-abc-switchyard-change-fabric-storefront.acct.workers.dev";
    const state = appPanelState({ ...base, deployedUrl, launched: { ...exited, fixed: { url: fixedUrl, commit: "15d7d40565" } } });
    expect(state.publish).toBeNull();
    const html = renderToStaticMarkup(createElement(AppPanel, { state, onDeploy: () => {}, onPublish: () => {} }));
    expect(html).toContain("Original");
    expect(html).toContain(`href="${deployedUrl}"`);
    expect(html).toContain("Fixed by this run");
    expect(html).toContain(`href="${fixedUrl}"`);
    expect(html).toContain("Deploy the original app again");
    expect(html).not.toContain("Publish the fixed version");
  });

  it("renders the publish button disabled with its reason", () => {
    const state = appPanelState({ ...base, launched: exited });
    const html = renderToStaticMarkup(createElement(AppPanel, { state, onDeploy: () => {}, onPublish: () => {} }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish the fixed version<\/button>/);
    expect(html).toContain("Not deployed.");
    expect(html).toContain(">Deploy the original app<");
  });

  it("finds a CLI run's template by its objective, only on an exact, unique goal match", () => {
    const withGoal = TEMPLATES.map((t) => (t.id === "storefront" ? { ...t, goalText: "Make the storefront\ncorrect." } : t));
    expect(templateForObjective("Make the storefront correct.", withGoal)?.id).toBe("storefront");
    expect(templateForObjective("Make the storefront correct", withGoal)).toBeNull();
    expect(templateForObjective(undefined, withGoal)).toBeNull();
  });

  it("the launcher serves each template's goal text from its goal file", async () => {
    const templates = await templatesWithGoalText();
    expect(templates.find((t) => t.id === "storefront")!.goalText).toMatch(/^Make the storefront correct and safe/);
    expect(templates.find((t) => t.id === "audit-logging")!.goalText).toBe("Add organization-level audit logging with a read API and tests");
  });
});

describe("the launcher reads a run's promotion from its output", () => {
  it("parses run-board's and run-live's promoted and repo lines, and ignores an unverified or refused one", () => {
    expect(parseRunOutputLine("  promoted: branch switchyard/board-x commit 15d7d40565c8")).toEqual({ promoted: { branch: "switchyard/board-x", commit: "15d7d40565c8" } });
    expect(parseRunOutputLine("  repo: /tmp/work/source")).toEqual({ repoDir: "/tmp/work/source" });
    expect(parseRunOutputLine("  promoted: switchyard/live-x (15d7d40565) in /tmp/w/source repo")).toEqual({
      promoted: { branch: "switchyard/live-x", commit: "15d7d40565" },
      repoDir: "/tmp/w/source repo",
    });
    expect(parseRunOutputLine("  promoted unverified (no gate): branch b commit 15d7d40565c8")).toBeUndefined();
    expect(parseRunOutputLine("  promoted: REFUSED (gate failed)")).toBeUndefined();
    expect(parseRunOutputLine("  repo: relative/path")).toBeUndefined();
  });

  it("keeps the promotion across chunks and after the rolling log scrolls", () => {
    const run = trackedRun({ status: "running", exitCode: null });
    pushLog(run, "verdict: verified\n  promoted: branch switchyard/b commit 15d7");
    pushLog(run, "d40565c8\n  repo: /tmp/w/src\n");
    for (let i = 0; i < 80; i += 1) pushLog(run, `line ${i}\n`);
    expect(run.promoted).toEqual({ branch: "switchyard/b", commit: "15d7d40565c8" });
    expect(run.repoDir).toBe("/tmp/w/src");
    expect(run.log.length).toBe(50);
  });
});

describe("publish-fixed from the console", () => {
  const promotedRun = () => trackedRun({ repoDir: "/tmp/w/src", promoted: { branch: "switchyard/b", commit: "15d7d40565c8" } });

  it("spawns publish-fixed with the run's own promoted repo, commit, and branch, and keeps the URL", async () => {
    const tracked = new Map([["console-storefront-abc", promotedRun()]]);
    const url = "https://fixed-abc-switchyard-change-fabric-storefront.acct.workers.dev";
    const { spawnFn, calls } = fakeSpawn({ code: 0, stdout: `  fixed: 15d7d40565c8 in /tmp/w/src (app at the tree root): x\n  fixed version: ${url}\n` });
    const result = await publishFixedRequest({ changeId: "console-storefront-abc" }, { spawnFn, tracked });
    expect(result.status).toBe(201);
    expect(result.body.fixed).toEqual({ url, commit: "15d7d40565c8" });
    expect(calls[0]!.command).toBe("npm");
    expect(calls[0]!.args).toEqual(publishFixedArgs("console-storefront-abc", "storefront", "/tmp/w/src", { branch: "switchyard/b", commit: "15d7d40565c8" }));
    expect(calls[0]!.args.slice(0, 6)).toEqual(["-w", "apps/cli", "run", "dev", "--", "publish-fixed"]);
    expect(calls[0]!.options.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(tracked.get("console-storefront-abc")!.fixed?.url).toBe(url);
    // A second call returns the kept version and spawns nothing.
    expect((await publishFixedRequest({ changeId: "console-storefront-abc" }, { spawnFn, tracked })).status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it("refuses an unknown run, a running run, a run with no promotion, and reports a CLI refusal", async () => {
    const { spawnFn, calls } = fakeSpawn({ code: 1, stdout: "Error: refusing: the run is not verified by a gate that ran\n" });
    expect((await publishFixedRequest({ changeId: "nope" }, { spawnFn, tracked: new Map() })).status).toBe(404);
    expect((await publishFixedRequest({ changeId: "console-storefront-abc" }, { spawnFn, tracked: new Map([["console-storefront-abc", trackedRun({ status: "running" })]]) })).status).toBe(409);
    expect((await publishFixedRequest({ changeId: "console-storefront-abc" }, { spawnFn, tracked: new Map([["console-storefront-abc", trackedRun()]]) })).status).toBe(409);
    expect(calls).toEqual([]);
    const tracked = new Map([["console-storefront-abc", promotedRun()]]);
    const refused = await publishFixedRequest({ changeId: "console-storefront-abc" }, { spawnFn, tracked });
    expect(refused.status).toBe(502);
    expect(refused.body.output).toContain("Error: refusing: the run is not verified by a gate that ran");
    expect(tracked.get("console-storefront-abc")!.publish).toMatchObject({ kind: "failed" });
  });
});

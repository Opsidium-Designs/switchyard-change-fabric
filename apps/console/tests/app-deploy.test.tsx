/**
 * Deploying and removing the example apps from the console, offline (no
 * browser, no network, no wrangler: every spawned CLI is a fake child):
 *   - the cityhall template and the run-board args it launches with (the
 *     Makefile's CH_* agent counts and budget flags, the fixed preview only when deployed);
 *   - the launcher's deploy-app / teardown-app endpoints: only template apps,
 *     the exact CLI commands, no credential in the spawned environment, and
 *     the CLI's own error on a failure;
 *   - the console: Deploy / Remove app states, the confirmations, the fixed
 *     app link from a backed passing preview, the Tear down refused while the
 *     run is running, and hidden for a run followed read-only with ?watch=.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import {
  deployAppArgs,
  deployAppRequest,
  knownAppFromBody,
  launchArgs,
  runBoardArgs,
  teardownAppArgs,
  teardownAppRequest,
  type SpawnFn,
} from "../launcher";
import {
  App,
  AppDeployControl,
  RunStatus,
  cliErrorLines,
  removeAppConfirmText,
  tearDownBlockedReason,
  tearDownConfirmText,
} from "../src/App.tsx";
import { latestPassingPreview, type RevisionPreview } from "../src/previews.ts";
import { boardCapable, TEMPLATES, templateApps, templateById } from "../src/templates.ts";

/** A fake `spawn`: records each call, then emits the given output and exit code. */
function fakeSpawn(result: { code: number | null; stdout?: string; stderr?: string; error?: string }) {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      if (result.error) {
        child.emit("error", new Error(result.error));
        return;
      }
      child.emit("exit", result.code);
    });
    return child as unknown as ChildProcess;
  };
  return { calls, spawnFn };
}

describe("the cityhall template", () => {
  const cityhall = templateById("cityhall")!;

  it("is a board-capable real-app template over the cityhall app and goal", () => {
    expect(cityhall.app).toBe("cityhall");
    expect(cityhall.projectDir).toBe("examples/apps/cityhall");
    expect(cityhall.source).toEqual({ kind: "goal", goalFile: "examples/goals/cityhall-services-correct.goal.txt" });
    expect(boardCapable(cityhall)).toBe(true);
    expect(cityhall.agents.board).toEqual({ min: 8, max: 30 });
    expect(cityhall.whatItDoes).toContain("32 modules across 8 city departments");
    for (const dept of ["utilities", "parking", "housing", "licensing", "parks", "records", "transit", "permits"]) {
      expect(cityhall.whatItDoes).toContain(dept);
    }
    expect(cityhall.problemItSolves).toContain("237-test acceptance suite");
    expect(cityhall.problemItSolves).toContain("Two existing developer tests");
    expect(templateApps()).toEqual(["service-api", "storefront", "cityhall"]);
  });

  it("launches run-board with the Makefile's CH_* budget flags and the app's stable worker", () => {
    const args = runBoardArgs(cityhall, "console-cityhall-x", "console");
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args.slice(0, 6)).toEqual(["-w", "apps/cli", "run", "dev", "--", "run-board"]);
    expect(flag("--goal-file")).toMatch(/examples\/goals\/cityhall-services-correct\.goal\.txt$/);
    expect(flag("--project")).toMatch(/examples\/apps\/cityhall$/);
    expect(flag("--min")).toBe("8");
    expect(flag("--max")).toBe("30");
    expect(flag("--max-inflight")).toBe("8");
    expect(flag("--max-turns")).toBe("1400");
    expect(flag("--timeout-ms")).toBe("4500000");
    expect(flag("--deploy-app")).toMatch(/examples\/apps\/cityhall$/);
    expect(flag("--deploy-app-name")).toBe("switchyard-change-fabric-cityhall");
    expect(args).toContain("--gate");
    expect(args).not.toContain("--preview-passing");
  });

  it("passes no budget flags for a template without board options", () => {
    const args = runBoardArgs(templateById("storefront")!, "x", "console");
    expect(args).not.toContain("--max-inflight");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--timeout-ms");
  });
});

describe("revision previews on a launch", () => {
  it("adds --preview-passing to a board run only when the app is deployed, keeping --decide-contracts last", () => {
    for (const t of TEMPLATES.filter((x) => x.app)) {
      const deployed = launchArgs(t, "x", { mode: "board", contractPolicy: "accept" }, true);
      expect(deployed, t.id).toContain("--preview-passing");
      expect(deployed.indexOf("--preview-passing")).toBeGreaterThan(deployed.indexOf("--deploy-app-name"));
      expect(deployed.slice(-2)).toEqual(["--decide-contracts", "accept"]);
      expect(launchArgs(t, "x", { mode: "board", contractPolicy: "console" }, false)).not.toContain("--preview-passing");
    }
  });

  it("never adds previews to a non-app template or to run-live (which keeps its redeploy in place)", () => {
    const audit = templateById("audit-logging")!;
    expect(launchArgs(audit, "x", { mode: "board", contractPolicy: "console" }, true)).not.toContain("--preview-passing");
    const live = launchArgs(templateById("service-api")!, "x", { mode: "live", contractPolicy: "console" }, true);
    expect(live[5]).toBe("run-live");
    expect(live).not.toContain("--preview-passing");
    expect(live[live.indexOf("--deploy-app-name") + 1]).toBe("switchyard-change-fabric-service-api");
  });
});

describe("the launcher's deploy-app and teardown-app endpoints", () => {
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = saved;
  });

  it("resolves only apps that belong to a template", () => {
    expect(knownAppFromBody({ app: "cityhall" })).toBe("cityhall");
    expect(knownAppFromBody({ templateId: "storefront" })).toBe("storefront");
    expect(knownAppFromBody({ templateId: "audit-logging" })).toBeUndefined();
    for (const bad of ["", "../service-api", "examples/apps/cityhall", "not-an-app", ".deployments"]) {
      expect(knownAppFromBody({ app: bad }), bad).toBeUndefined();
    }
    expect(knownAppFromBody({ app: 42 })).toBeUndefined();
    expect(knownAppFromBody({})).toBeUndefined();
  });

  it("builds the exact deploy-app and teardown-app CLI commands", () => {
    expect(deployAppArgs("cityhall")).toEqual([
      "-w", "apps/cli", "run", "dev", "--", "deploy-app", "--app", "cityhall", "--worker", expect.any(String),
    ]);
    expect(teardownAppArgs("cityhall")).toEqual(["-w", "apps/cli", "run", "dev", "--", "teardown-app", "--app", "cityhall"]);
  });

  it("refuses an unknown app without spawning anything", async () => {
    const fake = fakeSpawn({ code: 0 });
    const res = await teardownAppRequest({ app: "../../etc" }, fake.spawnFn);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("unknown app");
    const dep = await deployAppRequest({ app: "nope" }, fake.spawnFn);
    expect(dep.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("removes a known app through teardown-app, with no credential in the spawned environment", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "fake-token-value";
    const fake = fakeSpawn({ code: 0, stdout: "Removed cityhall: its stable worker switchyard-change-fabric-cityhall is deleted\n" });
    const res = await teardownAppRequest({ app: "cityhall" }, fake.spawnFn);
    expect(res).toMatchObject({ status: 200, body: { app: "cityhall", ok: true } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toBe("npm");
    expect(fake.calls[0]!.args).toEqual(teardownAppArgs("cityhall"));
    expect(fake.calls[0]!.options.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(fake.calls[0]!.options.env)).not.toContain("fake-token-value");
  });

  it("reports a failed removal with the CLI's own error", async () => {
    const fake = fakeSpawn({ code: 1, stderr: "Remove failed: Authentication error [code: 10000]\nnpm error code 1\n" });
    const res = await teardownAppRequest({ templateId: "storefront" }, fake.spawnFn);
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.output).toContain("Remove failed: Authentication error [code: 10000]");
    expect(cliErrorLines(res.body.output as string[])).toEqual(["Remove failed: Authentication error [code: 10000]"]);
  });

  it("deploys a known app and returns the workers.dev URL, or the CLI's error", async () => {
    const ok = fakeSpawn({ code: 0, stdout: "Deployed cityhall to its stable worker switchyard-change-fabric-cityhall\n  live URL: https://switchyard-change-fabric-cityhall.acct.workers.dev\n" });
    const res = await deployAppRequest({ templateId: "cityhall", app: "cityhall" }, ok.spawnFn);
    expect(res).toEqual({ status: 201, body: { app: "cityhall", url: "https://switchyard-change-fabric-cityhall.acct.workers.dev" } });
    expect(ok.calls[0]!.args).toEqual(deployAppArgs("cityhall"));
    const bad = fakeSpawn({ code: 1, stderr: "Deploy failed: wrangler deploy did not print a workers.dev URL\n" });
    const failed = await deployAppRequest({ app: "cityhall" }, bad.spawnFn);
    expect(failed.status).toBe(502);
    expect(failed.body.output).toEqual(["Deploy failed: wrangler deploy did not print a workers.dev URL"]);
  });

  it("answers a child that fails to start as a failure, never a hang", async () => {
    const fake = fakeSpawn({ code: null, error: "spawn npm ENOENT" });
    const res = await teardownAppRequest({ app: "service-api" }, fake.spawnFn);
    expect(res.status).toBe(502);
    expect(res.body.output).toContain("spawn npm ENOENT");
  });
});

describe("the console's app deployment control", () => {
  const render = (props: Partial<Parameters<typeof AppDeployControl>[0]>) =>
    renderToStaticMarkup(
      createElement(AppDeployControl, { app: "cityhall", url: undefined, op: undefined, onDeploy: () => {}, onRemove: () => {}, ...props }),
    );
  const url = "https://switchyard-change-fabric-cityhall.acct.workers.dev";

  it("offers Deploy when the app is not deployed", () => {
    const html = render({});
    expect(html).toContain("not deployed");
    expect(html).toContain("Deploy app (see it broken)");
    expect(html).not.toContain("Remove app");
  });

  it("shows the URL, says it is the original code, and offers Remove app once deployed", () => {
    const html = render({ url });
    expect(html).toContain(">deployed<");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("the ORIGINAL code, before any fix");
    expect(html).toContain("Remove app");
    expect(html).not.toContain("Deploy app (see it broken)");
    expect(render({ url, redeployed: true })).toContain("the fix, redeployed in place");
  });

  it("shows deploying and removing with the buttons disabled", () => {
    const deploying = render({ op: { kind: "deploying" } });
    expect(deploying).toContain("deploying...");
    expect(deploying).toMatch(/<button[^>]*disabled=""[^>]*>Deploy app/);
    const removing = render({ url, op: { kind: "removing" } });
    expect(removing).toContain("removing...");
    expect(removing).toMatch(/<button[^>]*disabled=""[^>]*>Remove app/);
  });

  it("shows a failure with the CLI's error", () => {
    const html = render({ url, op: { kind: "failed", action: "remove", error: "could not remove cityhall\nRemove failed: Authentication error" } });
    expect(html).toContain("remove failed");
    expect(html).toContain("Remove failed: Authentication error");
    expect(html).toContain('role="alert"');
  });

  it("refuses Remove app while a launched run of the app is still running", () => {
    const html = render({ url, inUse: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="A launched run of this app is still running[^"]*"[^>]*>Remove app/);
  });

  it("asks before removing, naming the app and its URL", () => {
    const text = removeAppConfirmText("cityhall", url);
    expect(text).toContain("cityhall");
    expect(text).toContain(url);
    expect(text).toContain("No run's repos are touched");
  });

  it("renders a Deploy control on every app template card", () => {
    const html = renderToStaticMarkup(createElement(App));
    for (const app of templateApps()) {
      expect(html).toContain(`aria-label="Deployment of ${app}"`);
    }
    expect(html).not.toContain('aria-label="Deployment of audit-logging"');
  });
});

describe("the run's Tear down (repos)", () => {
  const base = {
    changeId: "console-cityhall-x",
    template: templateById("cityhall")!,
    redeployed: false,
    busy: false,
    onTearDown: () => {},
  };
  const running = { status: "running" as const, exitCode: null, log: [] };
  const exited = { status: "exited" as const, exitCode: 0, log: [] };

  it("is refused while the launched run is running (or its status has not arrived), with the reason", () => {
    expect(tearDownBlockedReason(running, true)).toContain("still running");
    expect(tearDownBlockedReason(null, true)).toContain("Waiting");
    expect(tearDownBlockedReason(exited, true)).toBeNull();
    // A launcher that no longer knows the run (restarted): tearing down is the only way left.
    expect(tearDownBlockedReason(null, false)).toBeNull();
    const html = renderToStaticMarkup(
      createElement(RunStatus, { ...base, launchStatus: running, tearDownBlocked: tearDownBlockedReason(running, true) }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="The run is still running[^"]*"[^>]*>Tear down \(repos\)/);
  });

  it("is enabled once the run exits, and only names the repos", () => {
    const html = renderToStaticMarkup(createElement(RunStatus, { ...base, launchStatus: exited, tearDownBlocked: null }));
    expect(html).toContain("Tear down (repos)</button>");
    expect(html).not.toContain("deployed app)");
    expect(html).not.toMatch(/disabled=""[^>]*>Tear down/);
  });

  it("asks before deleting the run's real repos", () => {
    const text = tearDownConfirmText("console-cityhall-x");
    expect(text).toContain("console-cityhall-x");
    expect(text).toContain("Artifact repos");
  });

  it("is hidden for a run followed read-only", () => {
    const html = renderToStaticMarkup(createElement(RunStatus, { ...base, launchStatus: null, watchOnly: true }));
    expect(html).not.toContain("Tear down");
  });

  it("is hidden when the console opens with ?watch=<id>", () => {
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const previous = g.window;
    g.window = { location: { search: "?watch=change-board-abc123" } };
    try {
      const html = renderToStaticMarkup(createElement(App));
      expect(html).toContain("change-board-abc123");
      expect(html).not.toContain("Tear down");
    } finally {
      if (had) g.window = previous;
      else delete g.window;
    }
  });
});

describe("the fixed app link", () => {
  const rev = (seq: number, n: number, commit: string, gate: "pass" | "fail", extra: Record<string, unknown> = {}) =>
    ({
      seq,
      type: "integrated.rev",
      from: "integrator",
      payload: { n, commit, gate, merged: [], paths: [], contributors: [], ...extra },
    }) as unknown as BoardMessage;
  const preview = (n: number, commit: string): RevisionPreview => ({
    n,
    commit,
    url: `https://x-r${n}-switchyard-change-fabric-cityhall.acct.workers.dev`,
    alias: `x-r${n}`,
    at: "2026-10-13T12:00:00.000Z",
  });
  const c = (d: string) => d.repeat(40);

  it("is the latest gated passing revision whose preview matches the log's commit", () => {
    const log = [rev(1, 1, c("a"), "fail"), rev(2, 2, c("b"), "pass"), rev(3, 3, c("c"), "fail"), rev(4, 4, c("d"), "pass")];
    expect(latestPassingPreview(log, [preview(1, c("a")), preview(2, c("b")), preview(3, c("c"))])?.n).toBe(2);
    expect(latestPassingPreview(log, [preview(2, c("b")), preview(4, c("d"))])?.n).toBe(4);
    // A preview whose commit is not the gated one is never linked.
    expect(latestPassingPreview(log, [preview(4, c("e"))])).toBeUndefined();
    // An ungated "pass" checked nothing: it is not the fixed app.
    expect(latestPassingPreview([rev(1, 1, c("a"), "pass", { gated: false })], [preview(1, c("a"))])).toBeUndefined();
  });

  it("is shown prominently in the run panel", () => {
    const html = renderToStaticMarkup(
      createElement(RunStatus, {
        changeId: "console-cityhall-x",
        template: templateById("cityhall")!,
        launchStatus: { status: "exited", exitCode: 0, log: [] },
        redeployed: false,
        busy: false,
        onTearDown: () => {},
        fixedApp: preview(4, c("d")),
      }),
    );
    expect(html).toContain("Open the fixed app");
    expect(html).toContain('href="https://x-r4-switchyard-change-fabric-cityhall.acct.workers.dev"');
    expect(html).toContain("revision 4");
  });
});

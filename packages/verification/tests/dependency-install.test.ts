/** Dependency install before a gate: lockfile detection, the bounded install run, and the gate-runner decorator (offline, fake runners). */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatDependencyInstall,
  gateEnvironment,
  InstallingCommandRunner,
  LockfileDependencyInstaller,
  NO_DEPENDENCY_INSTALL,
  planDependencyInstall,
  type CommandOutcome,
  type CommandRunner,
  type CommandRunOptions,
} from "../src/index.ts";

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-install-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

/** A fake runner that records argv/cwd and answers with `outcome`. */
class Recording implements CommandRunner {
  readonly calls: { argv: readonly string[]; cwd: string }[] = [];
  constructor(private readonly outcome: (argv: readonly string[], cwd: string) => Promise<CommandOutcome> | CommandOutcome = () => ({ code: 0, stdout: "", stderr: "" })) {}
  async run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    this.calls.push({ argv, cwd });
    return this.outcome(argv, cwd);
  }
}

const none = async () => false;
const all = async () => true;

describe("planDependencyInstall", () => {
  it("installs only what a lockfile pins, with install scripts disabled", async () => {
    expect(await planDependencyInstall(await tree({ "package.json": "{}", "package-lock.json": "{}" }), none)).toEqual({
      kind: "run",
      tool: "npm",
      argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
    });
    expect(await planDependencyInstall(await tree({ "pnpm-lock.yaml": "" }), all)).toMatchObject({ kind: "run", argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] });
    expect(await planDependencyInstall(await tree({ "pnpm-lock.yaml": "" }), none)).toMatchObject({ kind: "unsupported", detail: expect.stringMatching(/pnpm is not on PATH/) });
    expect(await planDependencyInstall(await tree({ "yarn.lock": "" }), all)).toMatchObject({ kind: "run", argv: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"] });
    expect(await planDependencyInstall(await tree({ "yarn.lock": "" }), none)).toMatchObject({ kind: "unsupported" });
    expect(await planDependencyInstall(await tree({ "bun.lockb": "" }), all)).toMatchObject({ kind: "unsupported", detail: expect.stringMatching(/bun/) });
  });

  it("never installs an unlocked manifest, and states what it does not support", async () => {
    expect(await planDependencyInstall(await tree({ "package.json": "{}" }), all)).toEqual({
      kind: "skipped",
      detail: "no lockfile: dependencies not installed (an unlocked install is not deterministic)",
    });
    expect(await planDependencyInstall(await tree({ "requirements.txt": "x" }), all)).toEqual({
      kind: "unsupported",
      detail: "dependency install not supported for python yet: dependencies not installed",
    });
    expect(await planDependencyInstall(await tree({ "pyproject.toml": "x" }), all)).toMatchObject({ kind: "unsupported" });
    expect(await planDependencyInstall(await tree({ "go.mod": "module x" }), all)).toMatchObject({ kind: "skipped", detail: expect.stringMatching(/needs network/) });
    expect(await planDependencyInstall(await tree({}), all)).toEqual({ kind: "skipped", detail: "no dependency manifest" });
  });
});

describe("LockfileDependencyInstaller", () => {
  it("runs the install in the gated tree and reports its duration", async () => {
    const dir = await tree({ "package.json": "{}", "package-lock.json": "{}" });
    const runner = new Recording();
    let t = 1000;
    const outcome = await new LockfileDependencyInstaller({ runner, now: () => (t += 1500) }).install(dir);
    expect(runner.calls).toEqual([{ argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], cwd: dir }]);
    expect(outcome).toEqual({ status: "installed", tool: "npm", detail: "npm ci --ignore-scripts --no-audit --no-fund --prefer-offline", durationMs: 1500 });
    expect(formatDependencyInstall(outcome)).toBe("installed (npm ci --ignore-scripts --no-audit --no-fund --prefer-offline, 1.5 s)");
  });

  it("reports a failed install with a bounded, credential-free reason; runs nothing without a lockfile", async () => {
    const dir = await tree({ "package-lock.json": "{}" });
    const runner = new Recording(() => ({
      code: 1,
      stdout: "",
      stderr: "npm error code E404\nnpm error 404 Not Found - GET https://user:hunter2@registry.example/x - not found\nnpm error a complete log",
    }));
    const failed = await new LockfileDependencyInstaller({ runner }).install(dir);
    expect(failed.status).toBe("failed");
    expect(failed.detail).toMatch(/^npm ci: npm error code E404/);
    expect(failed.detail).not.toContain("hunter2");
    expect(failed.detail.length).toBeLessThanOrEqual(310);
    const quiet = new Recording();
    expect((await new LockfileDependencyInstaller({ runner: quiet }).install(await tree({ "package.json": "{}" }))).status).toBe("skipped");
    expect(quiet.calls).toEqual([]);
  });

  it("the install command sees the allowlisted environment with the shared cache, never a credential", () => {
    const env = gateEnvironment({ PATH: "/bin", npm_config_cache: "/work/npm-cache", CLOUDFLARE_API_TOKEN: "secret", NPM_TOKEN: "t" });
    expect(env).toMatchObject({ PATH: "/bin", npm_config_cache: "/work/npm-cache" });
    expect(env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(env).not.toHaveProperty("NPM_TOKEN");
  });
});

describe("InstallingCommandRunner", () => {
  it("installs once per tree before the first command, again when the lockfile changes, and fails the gate without running it when the install fails", async () => {
    const dir = await tree({ "package.json": "{}", "package-lock.json": "{\"v\":1}" });
    const installs: string[] = [];
    let fail = false;
    const installer = {
      async install(d: string) {
        installs.push(d);
        await mkdir(join(d, "node_modules"), { recursive: true });
        return fail
          ? { status: "failed" as const, tool: "npm", detail: "npm ci: npm error code ERESOLVE", durationMs: 5 }
          : { status: "installed" as const, tool: "npm", detail: "npm ci", durationMs: 5 };
      },
    };
    const gate = new Recording(() => ({ code: 0, stdout: "ok 1 - gate", stderr: "" }));
    const runner = new InstallingCommandRunner(gate, installer);
    await runner.run(["npm", "run", "gate"], dir);
    await runner.run(["npm", "run", "lint"], dir);
    expect(installs).toHaveLength(1);
    expect(gate.calls).toHaveLength(2);
    expect(runner.takeLastInstall()).toMatchObject({ status: "installed" });
    expect(runner.takeLastInstall()).toBeUndefined();

    // The tree's dependencies changed: install again; this time it fails.
    fail = true;
    await writeFile(join(dir, "package-lock.json"), "{\"v\":2}");
    const outcome = await runner.run(["npm", "run", "gate"], dir);
    expect(installs).toHaveLength(2);
    expect(outcome).toEqual({ code: 1, stdout: "", stderr: "dependency install failed: npm ci: npm error code ERESOLVE" });
    expect(gate.calls).toHaveLength(2); // the gate did not run
    expect(runner.takeLastInstall()).toMatchObject({ status: "failed" });

    // A recreated tree (node_modules gone) installs again.
    fail = false;
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
    await writeFile(join(dir, "package-lock.json"), "{\"v\":1}");
    await runner.run(["npm", "run", "gate"], dir);
    expect(installs).toHaveLength(3);
  });

  it("with installs disabled, the gate runs as is", async () => {
    const gate = new Recording();
    const runner = new InstallingCommandRunner(gate, NO_DEPENDENCY_INSTALL);
    await runner.run(["gate"], await tree({ "package-lock.json": "{}" }));
    expect(gate.calls).toHaveLength(1);
    expect(runner.takeLastInstall()).toMatchObject({ status: "skipped", detail: "dependency install disabled for this gate (it needs no dependencies)" });
  });

  it("passes the abort signal to the install and the gate; an install aborted mid-run neither runs the gate nor is remembered", async () => {
    const dir = await tree({ "package.json": "{}", "package-lock.json": "{\"v\":1}" });
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    let installs = 0;
    const installer = {
      async install(_d: string, options?: CommandRunOptions) {
        installs += 1;
        seen.push(options?.signal);
        if (installs === 1) {
          controller.abort(); // the run is interrupted while the install runs
          return { status: "failed" as const, tool: "npm", detail: "npm ci: aborted (the run was interrupted)", durationMs: 1 };
        }
        return { status: "installed" as const, tool: "npm", detail: "npm ci", durationMs: 1 };
      },
    };
    const gateSignals: (AbortSignal | undefined)[] = [];
    const gate: CommandRunner = {
      async run(_argv, _cwd, options) {
        gateSignals.push(options?.signal);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const runner = new InstallingCommandRunner(gate, installer);
    const aborted = await runner.run(["gate"], dir, { signal: controller.signal });
    expect(aborted).toMatchObject({ code: null, aborted: true });
    expect(aborted.stderr).toMatch(/dependency install failed: npm ci: aborted/);
    expect(seen).toEqual([controller.signal]);
    expect(gateSignals).toEqual([]);
    // A later run (another signal) installs again and the gate sees its signal.
    const next = new AbortController();
    expect(await runner.run(["gate"], dir, { signal: next.signal })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(installs).toBe(2);
    expect(gateSignals).toEqual([next.signal]);
  });
});

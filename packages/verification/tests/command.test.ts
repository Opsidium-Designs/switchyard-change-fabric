/**
 * Checked commands run code agents wrote: they see an allowlisted environment
 * (never a credential) and are stopped at a timeout with an honest reason.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChildProcessCommandRunner, gateEnvironment } from "../src/command.ts";

const SECRETS = {
  SWITCHYARD_API_TOKEN: "bearer-secret",
  CLOUDFLARE_API_TOKEN: "cf-secret",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "gw-secret",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.example",
  NODE_OPTIONS: "--require /tmp/evil.js",
};

describe("ChildProcessCommandRunner", () => {
  it("runs the command with an allowlisted environment: no credentials reach the child", async () => {
    const runner = new ChildProcessCommandRunner({ parentEnv: { ...process.env, ...SECRETS, LC_ALL: "C", CI: "1" } });
    const outcome = await runner.run([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], tmpdir());
    expect(outcome.code).toBe(0);
    const env = JSON.parse(outcome.stdout) as Record<string, string>;
    for (const key of Object.keys(SECRETS)) {
      expect(env[key], key).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toMatch(/secret/);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.LC_ALL).toBe("C");
    expect(env.CI).toBe("1");
    // A private temp dir made for this run (and removed afterwards).
    expect(env.TMPDIR).toMatch(/scf-cmd-/);
    expect(env.TMPDIR!.startsWith(tmpdir())).toBe(true);
  });

  it("gateEnvironment keeps only allowlisted names", () => {
    expect(gateEnvironment({ PATH: "/bin", HOME: "/h", ...SECRETS, LANG: "en", RANDOM_TOKEN: "x", HTTPS_PROXY: "http://p", USER: "u" })).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LANG: "en",
      HTTPS_PROXY: "http://p",
      USER: "u",
    });
  });

  it("stops a command at the timeout and says so", async () => {
    const runner = new ChildProcessCommandRunner({ timeoutMs: 300 });
    const outcome = await runner.run([process.execPath, "-e", "setTimeout(() => {}, 20000)"], tmpdir());
    expect(outcome.code).toBeNull();
    expect(outcome.stderr).toMatch(/timed out after 300 ms/);
  });

  it("kills the whole process tree at the timeout", async () => {
    const runner = new ChildProcessCommandRunner({ timeoutMs: 400 });
    const marker = join(tmpdir(), `scf-grandchild-${process.pid}-${Date.now()}`);
    // The command starts a grandchild that would write the marker after 1.5 s.
    const grandchild = join(tmpdir(), `scf-grandchild-${process.pid}-${Date.now()}.cjs`);
    writeFileSync(grandchild, `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500);\n`);
    const parent = `require("node:child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(() => {}, 20000);`;
    const outcome = await runner.run([process.execPath, "-e", parent], tmpdir());
    expect(outcome.stderr).toMatch(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it("reports an output overflow as an overflow, not a timeout", async () => {
    const runner = new ChildProcessCommandRunner({ maxBuffer: 1000 });
    const outcome = await runner.run([process.execPath, "-e", "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 5000)"], tmpdir());
    expect(outcome.code).toBeNull();
    expect(outcome.stderr).toMatch(/output exceeded 1000 bytes/);
    expect(outcome.stderr).not.toMatch(/timed out/);
  });
  it("kills a background child the command left running when it exits normally", async () => {
    // The command backgrounds a long sleep (detached from its stdio, still in
    // the command's process group) and exits 0 at once.
    const outcome = await new ChildProcessCommandRunner({ timeoutMs: 20_000 }).run(
      ["sh", "-c", "sleep 30 >/dev/null 2>&1 </dev/null & echo $!"],
      tmpdir(),
    );
    expect(outcome.code).toBe(0);
    const pid = Number(outcome.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A killed child may linger briefly as a zombie until it is reaped.
      try {
        return !/^\d+ \([^)]*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive()).toBe(false);
  });
});


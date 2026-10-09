/**
 * Credentials never travel through the CLI's process environment: the CLI
 * reads `.env` into memory, so code it runs (an app gate, an agent-built tool,
 * or their children) cannot read a credential from its parent's environment
 * (`/proc/<ppid>/environ`). Offline; real child processes; fake values only.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  credentialKeysIn,
  isCredentialKey,
  parseDotEnv,
  runtimeEnv,
  setRuntimeCredentials,
  withoutCredentials,
} from "../src/credentials.ts";

const run = promisify(execFile);
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const FAKE = { CLOUDFLARE_API_TOKEN: "fake-cf-token-7781", SWITCHYARD_API_TOKEN: "fake-bearer-3319", AI_GATEWAY_TOKEN: "fake-gw-5521" };
const linux = existsSync("/proc/self/environ");

async function envFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-env-"));
  const path = join(dir, ".env");
  await writeFile(path, Object.entries({ ...FAKE, EXECUTOR: "noop" }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return path;
}

/** The parent environment of a test child, with every real credential removed. */
const clean = () => withoutCredentials(process.env);

describe("credentials: parsed into memory, never into a process environment", () => {
  it("parses .env (export, quotes, comments) without expanding anything", () => {
    expect(parseDotEnv('# c\nexport A=1\nB="two words"\nC=\'$HOME\'\nD=x # note\nE="a\\nb"\nbad line\n')).toEqual({ A: "1", B: "two words", C: "$HOME", D: "x", E: "a\nb" });
  });

  it("names credentials by their names, including a gateway URL that carries the account id", () => {
    for (const k of ["CLOUDFLARE_API_TOKEN", "SWITCHYARD_API_TOKEN", "AI_GATEWAY_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_URL", "DB_PASSWORD", "MY_SECRET"]) {
      expect(isCredentialKey(k)).toBe(true);
    }
    for (const k of ["PATH", "HOME", "EXECUTOR", "GIT_AUTHOR_DATE", "AI_GATEWAY_MODEL", "AI_GATEWAY_MAX_TOKENS"]) {
      expect(isCredentialKey(k)).toBe(false);
    }
    expect(credentialKeysIn({ PATH: "/bin", CLOUDFLARE_API_TOKEN: "x", EMPTY_TOKEN: "" })).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });

  it("runtimeEnv() reads loaded values from memory, with the process environment taking precedence", () => {
    setRuntimeCredentials({ SCF_TEST_ONLY_VALUE: "from-dotenv" });
    expect(runtimeEnv().SCF_TEST_ONLY_VALUE).toBe("from-dotenv");
    expect(process.env.SCF_TEST_ONLY_VALUE).toBeUndefined();
    setRuntimeCredentials({});
  });

  it.skipIf(!linux)("a gate or tool child cannot read a credential from its parent's environ; an exported one it could", async () => {
    const script = join(await mkdtemp(join(tmpdir(), "scf-env-parent-")), "parent.ts");
    // The parent loads .env into memory (as the CLI does), then runs a child
    // the way gates and tools run: the allowlisted runner. The child dumps its
    // own environ and its PARENT's environ (what any same-user process sees).
    await writeFile(
      script,
      [
        `import { loadDotEnvFile, setRuntimeCredentials, runtimeEnv } from ${JSON.stringify(join(REPO, "packages/orchestration/src/credentials.ts"))};`,
        `import { ChildProcessCommandRunner } from ${JSON.stringify(join(REPO, "packages/verification/src/command.ts"))};`,
        "import { readFileSync } from 'node:fs';",
        "const loaded = process.env.SCF_ENV_FILE ? loadDotEnvFile(process.env.SCF_ENV_FILE) : undefined;",
        "if (loaded) setRuntimeCredentials(loaded);",
        "const child = await new ChildProcessCommandRunner().run([process.execPath, '-e', \"const fs=require('fs');process.stdout.write(fs.readFileSync('/proc/self/environ','utf8')+'\\\\n---\\\\n'+fs.readFileSync('/proc/'+process.ppid+'/environ','utf8'))\"], process.cwd());",
        "process.stdout.write(JSON.stringify({ inMemory: runtimeEnv().CLOUDFLARE_API_TOKEN ?? null, child: child.stdout, parentOwn: readFileSync('/proc/self/environ','utf8') }));",
      ].join("\n"),
    );
    const node = [process.execPath, "--disable-warning=ExperimentalWarning", "--experimental-transform-types"];
    const loadedInMemory = JSON.parse(
      (await run(node[0]!, [...node.slice(1), script], { env: { ...clean(), SCF_ENV_FILE: await envFile() }, cwd: REPO, maxBuffer: 1 << 22 })).stdout,
    ) as { inMemory: string | null; child: string; parentOwn: string };
    expect(loadedInMemory.inMemory).toBe(FAKE.CLOUDFLARE_API_TOKEN); // the parent has it, in memory
    for (const value of Object.values(FAKE)) {
      expect(loadedInMemory.child).not.toContain(value); // neither the child's environ nor its parent's
      expect(loadedInMemory.parentOwn).not.toContain(value);
    }
    // The control: a parent that EXPORTS the credential (the old Makefile) leaks it to the child.
    const exported = JSON.parse(
      (await run(node[0]!, [...node.slice(1), script], { env: { ...clean(), ...FAKE }, cwd: REPO, maxBuffer: 1 << 22 })).stdout,
    ) as { child: string };
    expect(exported.child.split("\n---\n")[0]).not.toContain(FAKE.CLOUDFLARE_API_TOKEN); // its own environ is allowlisted
    expect(exported.child.split("\n---\n")[1]).toContain(FAKE.CLOUDFLARE_API_TOKEN); // its parent's is not
  });

  it.skipIf(!linux)("the CLI run through the Makefile holds no credential in its environment; it loads .env into memory", async () => {
    const { stdout } = await run("make", ["-s", "cli", "ARGS=env-check"], {
      cwd: REPO,
      env: { ...clean(), SCF_ENV_FILE: await envFile() },
      maxBuffer: 1 << 22,
    });
    expect(stdout).toContain("credential names in this process's environment: none");
    expect(stdout).toMatch(/names loaded into memory from \.env \(values never shown\): .*CLOUDFLARE_API_TOKEN/);
    for (const value of Object.values(FAKE)) {
      expect(stdout).not.toContain(value);
    }
  });

  it("no Makefile recipe that runs the CLI exports .env into its environment", () => {
    const recipes = readFileSync(join(REPO, "Makefile"), "utf8").split(/\n(?=[A-Za-z][\w-]*:)/);
    const leaking = recipes.filter((r) => /apps\/cli|tools\/demo-live\.sh/.test(r) && /set -a;[^\n]*\.env[^\n]*set \+a; \\\n\s*(npm -w apps\/cli|bash tools\/demo-live)/.test(r));
    expect(leaking.map((r) => r.split(":")[0])).toEqual([]);
    // dev-all gives .env to the Worker's own subshell only.
    const devAll = recipes.find((r) => r.startsWith("dev-all:"))!;
    expect(devAll).toMatch(/\(set -a; \[ -f \.env \] && \. \.\/\.env; set \+a; npm -w apps\/worker run dev\)/);
    expect(devAll).not.toMatch(/^\tset -a/m);
  });
});

/**
 * The hardened git transport: a token never reaches git's command line, and
 * no configuration other code could plant (a user's ~/.gitconfig, a repo's own
 * config) can redirect a credentialed push. Local Git only (an https remote is
 * mapped to a local bare repo by a recording wrapper; no network).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit, splitCredential } from "../src/git-transport.ts";
import { installRecordingGit, type RecordingGit } from "./fake-git.ts";

const run = promisify(execFile);
const TOKEN = "S3CRET-artifact-token";
const REMOTE = "https://artifacts.example/team/repo.git";
const AUTHENTICATED = `https://token:${TOKEN}@artifacts.example/team/repo.git`;

let root: string;
let fake: RecordingGit;
let savedHome: string | undefined;
let real: string;
let evil: string;

async function refs(bare: string): Promise<string> {
  return (await run("git", ["-C", bare, "for-each-ref", "--format=%(refname) %(objectname)"])).stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scf-transport-"));
  real = join(root, "real.git");
  evil = join(root, "evil.git");
  await run("git", ["init", "-q", "--bare", real]);
  await run("git", ["init", "-q", "--bare", evil]);
  fake = await installRecordingGit(root, { "https://artifacts.example/team/": `${pathToFileURL(root).href}/` });
  // The "team/repo.git" remote maps to <root>/repo.git; make it the real repo.
  await run("git", ["clone", "-q", "--bare", real, join(root, "repo.git")]);
  real = join(root, "repo.git");
  savedHome = process.env.HOME;
});

afterEach(async () => {
  fake.restore();
  process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

async function workWithCommit(): Promise<{ dir: string; sha: string }> {
  const dir = join(root, "work");
  await mkdir(dir);
  await run("git", ["-C", dir, "init", "-q", "--initial-branch=main"]);
  await writeFile(join(dir, "a.txt"), "a\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "a"]);
  return { dir, sha: (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim() };
}

describe("hardened git transport", () => {
  it("splits a URL's credential from it", () => {
    expect(splitCredential(AUTHENTICATED)).toEqual({ url: REMOTE, token: TOKEN });
    expect(splitCredential("https://token:a%2Fb@h/x")).toEqual({ url: "https://h/x", token: "a/b" });
    expect(splitCredential("file:///tmp/x.git")).toEqual({ url: "file:///tmp/x.git" });
    expect(splitCredential("--quiet")).toEqual({ url: "--quiet" });
  });

  it("never puts the token on git's command line; it travels as a scoped Bearer header with no user config", async () => {
    const { dir, sha } = await workWithCommit();
    await runGit(["-C", dir, "push", "-q", AUTHENTICATED, "HEAD:refs/heads/main"]);
    expect(await refs(real)).toContain(sha);
    const calls = await fake.calls();
    const push = calls.find((c) => c.argv.includes(" push "));
    expect(push).toBeDefined();
    for (const call of calls) {
      expect(call.argv).not.toContain(TOKEN);
    }
    expect(push!.argv).toContain(REMOTE);
    expect(push!.env).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(push!.env).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(push!.env.find((l) => l.startsWith("HOME="))).not.toBe(`HOME=${savedHome}`);
    const header = push!.env.find((l) => l.endsWith(`=http.${REMOTE}.extraHeader`));
    const n = /^GIT_CONFIG_KEY_(\d+)=/.exec(header ?? "")?.[1];
    expect(n).toBeDefined();
    expect(push!.env).toContain(`GIT_CONFIG_VALUE_${n}=Authorization: Bearer ${TOKEN}`);
  });

  it("a pushInsteadOf planted in ~/.gitconfig cannot redirect a credentialed push", async () => {
    const home = join(root, "home");
    await mkdir(home);
    await writeFile(join(home, ".gitconfig"), `[url "${pathToFileURL(evil).href}"]\n\tpushInsteadOf = https://artifacts.example/\n`);
    process.env.HOME = home;
    const { dir, sha } = await workWithCommit();
    await runGit(["-C", dir, "push", "-q", AUTHENTICATED, "HEAD:refs/heads/main"]);
    expect(await refs(real)).toContain(sha);
    expect(await refs(evil)).toBe("");
  });

  it("refuses a credentialed operation in a repo whose own config could redirect it", async () => {
    const { dir } = await workWithCommit();
    await run("git", ["-C", dir, "config", `url.${pathToFileURL(evil).href}.pushInsteadOf`, "https://artifacts.example/"]);
    await expect(runGit(["-C", dir, "push", "-q", AUTHENTICATED, "HEAD:refs/heads/main"])).rejects.toThrow(
      /refusing a credentialed git operation .*url\..*\.pushinsteadof/,
    );
    expect(await refs(evil)).toBe("");
  });

  it("a clone keeps no token in the checkout's config, and an error never shows the token", async () => {
    const { dir } = await workWithCommit();
    await runGit(["-C", dir, "push", "-q", AUTHENTICATED, "HEAD:refs/heads/main"]);
    const target = join(root, "checkout");
    await runGit(["clone", "-q", AUTHENTICATED, target]);
    const config = await readFile(join(target, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).toContain(REMOTE);
    const failed = await runGit(["-C", target, "fetch", "-q", `https://token:${TOKEN}@artifacts.example/team/missing.git`]).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(failed).not.toBe("");
    expect(failed).not.toContain(TOKEN);
  });
});

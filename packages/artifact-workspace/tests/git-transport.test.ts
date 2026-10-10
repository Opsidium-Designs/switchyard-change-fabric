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

import { guardTransferArgs, runGit, splitCredential } from "../src/git-transport.ts";
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

  it("puts -- before a transfer's positional arguments, and it still clones, fetches, lists, and pushes", async () => {
    const { dir, sha } = await workWithCommit();
    await runGit(["-C", dir, "push", "-q", AUTHENTICATED, "HEAD:refs/heads/main"]);
    const push = (await fake.calls()).find((c) => c.argv.includes(" push "));
    expect(push!.argv).toContain(` push -q -- ${REMOTE} HEAD:refs/heads/main`);
    const target = join(root, "checkout");
    await runGit(["clone", "-q", AUTHENTICATED, target]);
    await runGit(["-C", target, "fetch", "-q", AUTHENTICATED, "+refs/heads/main:refs/remotes/x/main"]);
    expect((await runGit(["ls-remote", AUTHENTICATED, "refs/heads/main"])).stdout).toContain(sha);
    await runGit(["-C", dir, "push", "-q", `--force-with-lease=refs/heads/other:`, AUTHENTICATED, "HEAD:refs/heads/other"]);
    expect(await refs(real)).toContain("refs/heads/other");
  });

  it("refuses a remote or URL that starts with -, before git runs", async () => {
    const { dir } = await workWithCommit();
    const before = (await fake.calls()).length;
    for (const args of [
      ["-C", dir, "fetch", "--upload-pack=touch /tmp/pwned", "x"],
      ["-C", dir, "push", "-q", "-oProxyCommand=evil", "HEAD:refs/heads/main"],
      ["clone", "--config=core.sshCommand=evil", "x", join(root, "c2")],
      ["ls-remote", "--upload-pack=evil"],
    ]) {
      await expect(runGit(args)).rejects.toThrow(/starts with "-"/);
    }
    expect((await fake.calls()).length).toBe(before);
  });
});

describe("guardTransferArgs", () => {
  it("inserts -- before the first positional argument of a transfer, and leaves other commands alone", () => {
    expect(guardTransferArgs(["-C", "/d", "fetch", "-q", "origin", "main"])).toEqual(["-C", "/d", "fetch", "-q", "--", "origin", "main"]);
    expect(guardTransferArgs(["clone", "https://h/x.git", "/t"])).toEqual(["clone", "--", "https://h/x.git", "/t"]);
    expect(guardTransferArgs(["-C", "/d", "-c", "a.b=c", "push", "-q", "--force", "r", ":refs/heads/x"])).toEqual(["-C", "/d", "-c", "a.b=c", "push", "-q", "--force", "--", "r", ":refs/heads/x"]);
    expect(guardTransferArgs(["-C", "/d", "fetch", "--", "r", "x"])).toEqual(["-C", "/d", "fetch", "--", "r", "x"]);
    expect(guardTransferArgs(["-C", "/d", "rev-parse", "--verify", "HEAD"])).toEqual(["-C", "/d", "rev-parse", "--verify", "HEAD"]);
    // A refspec after the remote that starts with - is past the --: never an option.
    expect(guardTransferArgs(["-C", "/d", "fetch", "r", "-x"])).toEqual(["-C", "/d", "fetch", "--", "r", "-x"]);
  });

  it("refuses an unknown option in front of the positional arguments", () => {
    expect(() => guardTransferArgs(["-C", "/d", "fetch", "--upload-pack=x", "r"])).toThrow(/starts with "-"/);
    expect(() => guardTransferArgs(["push", "-"])).toThrow(/starts with "-"/);
  });
});

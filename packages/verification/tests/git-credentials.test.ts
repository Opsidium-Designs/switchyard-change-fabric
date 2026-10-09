/**
 * A checkout never keeps a credential: a token in the clone URL is sent as a
 * header for the transfer only, so code that later runs in the checkout (a
 * gate, a test) cannot read it from .git/config, and it is never on git's
 * command line. Local Git only (the https remote is mapped to a local repo by
 * a recording git wrapper; no network).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { clone, withoutCredentials } from "../src/git.ts";
import { installRecordingGit } from "./helpers.ts";

const run = promisify(execFile);

describe("credential-free checkouts", () => {
  it("strips userinfo from a URL", () => {
    expect(withoutCredentials("https://token:s3cr3t@artifacts.example/repo.git")).toBe("https://artifacts.example/repo.git");
    expect(withoutCredentials("file:///tmp/x.git")).toBe("file:///tmp/x.git");
  });

  it("a clone through an authenticated URL leaves no token in .git/config or on git's command line", async () => {
    const root = await mkdtemp(join(tmpdir(), "scf-cred-"));
    const source = join(root, "source");
    await mkdir(source);
    await run("git", ["-C", source, "init", "-q", "--initial-branch=main"]);
    await writeFile(join(source, "a.txt"), "a\n");
    await run("git", ["-C", source, "add", "-A"]);
    await run("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "a"]);
    const fake = await installRecordingGit(root, { "https://artifacts.example/repo.git": pathToFileURL(source).href });
    try {
      const target = join(root, "checkout");
      await clone("https://token:s3cr3t@artifacts.example/repo.git", target);
      const config = await readFile(join(target, ".git", "config"), "utf8");
      expect(config).not.toContain("s3cr3t");
      expect(config).toContain("https://artifacts.example/repo.git");
      const calls = await fake.calls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.argv).not.toContain("s3cr3t");
      }
    } finally {
      fake.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

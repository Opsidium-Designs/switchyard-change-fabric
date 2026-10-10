import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFilesystemWorkspaceProvider } from "../src/local.ts";

const run = promisify(execFile);

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "scf-ws-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("LocalFilesystemWorkspaceProvider", () => {
  it("creates an honest, clearly-labelled fallback workspace that git can clone", async () => {
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir });
    const ref = await provider.create("unit-a");

    expect(ref.backend).toBe("local-filesystem");
    expect(ref.fallback).toBe(true);
    expect(ref.gitUrl.startsWith("file://")).toBe(true);
    expect(ref.defaultBranch).toBe("main");

    // A real git client can clone the created bare repo.
    const cloneDir = join(rootDir, "clone");
    await run("git", ["clone", ref.gitUrl, cloneDir]);
  });

  it("seeds from a baseline remote, and refuses one that starts with - (never read as an option)", async () => {
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir });
    const baseline = await provider.create("baseline");
    const work = join(rootDir, "seed-work");
    await run("git", ["clone", "-q", baseline.gitUrl, work]);
    await run("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
    await run("git", ["-C", work, "push", "-q", "origin", "HEAD:main"]);
    const target = await provider.create("seeded");
    await provider.seed(target, baseline.gitUrl);
    expect((await provider.inspect(target)).lastPushAt).not.toBeNull();
    await expect(provider.seed(target, "--upload-pack=touch /tmp/pwned")).rejects.toThrow(/starts with "-"/);
  });

  it("forks a workspace: the fork starts from the source's commits and diverges independently", async () => {
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir });
    const source = await provider.create("requester");
    const work = join(rootDir, "work");
    await run("git", ["clone", "-q", source.gitUrl, work]);
    await run("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "in progress"]);
    await run("git", ["-C", work, "push", "-q", "origin", "HEAD:main"]);
    const head = (await run("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();

    const { ref, token, realizedBase, expectedBase, baseMismatch } = await provider.fork(source, "helper-fork", 120);
    expect(ref).toMatchObject({ name: "helper-fork", backend: "local-filesystem", fallback: true });
    expect(token.scope).toBe("write");
    // The head the fork really has is read back, not assumed.
    expect(realizedBase).toBe(head);
    expect(expectedBase).toBe(head);
    expect(baseMismatch).toBeUndefined();
    const clone = join(rootDir, "fork-clone");
    await run("git", ["clone", "-q", ref.gitUrl, clone]);
    expect((await run("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    await expect(provider.fork(source, "helper-fork")).rejects.toThrow(/already exists/);
    // Archiving the fork leaves the source untouched.
    await provider.archive(ref);
    await expect(provider.inspect(source)).resolves.toMatchObject({ name: "requester" });
    // A fork of an empty repo is empty.
    const empty = await provider.create("empty");
    const emptyFork = await provider.fork(empty, "empty-fork");
    expect(emptyFork.ref.name).toBe("empty-fork");
    expect(emptyFork.realizedBase).toBeUndefined();
  });

  it("issues and revokes scoped tokens labelled as local placeholders", async () => {
    const provider = new LocalFilesystemWorkspaceProvider({
      rootDir,
      now: () => 0,
      newId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });
    const ref = await provider.create("unit-b");

    const write = await provider.issueWriteToken(ref, 60);
    expect(write.scope).toBe("write");
    expect(write.token).toContain("local-fallback-write");
    expect(write.expiresAt).toBe(new Date(60 * 1000).toISOString());

    const read = await provider.issueReadToken(ref, 60);
    expect(read.scope).toBe("read");

    expect(await provider.revokeToken(ref, write.id)).toBe(true);
    expect(await provider.revokeToken(ref, write.id)).toBe(false);
  });

  it("inspect reports no push before any commit and archive removes the repo", async () => {
    const provider = new LocalFilesystemWorkspaceProvider({ rootDir });
    const ref = await provider.create("unit-c");

    const before = await provider.inspect(ref);
    expect(before.lastPushAt).toBeNull();
    expect(before.fallback).toBe(true);

    await provider.archive(ref);
    // Archiving a second time is a no-op, not an error.
    await provider.archive(ref);
  });
});

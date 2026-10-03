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

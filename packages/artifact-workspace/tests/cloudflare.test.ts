import { describe, expect, it } from "vitest";

import {
  BindingUnavailableError,
  CloudflareArtifactWorkspaceProvider,
  isBindingUnavailable,
  RepoNotReadyError,
  type ArtifactsBinding,
} from "../src/index.ts";

/** A small in-memory fake of the Artifacts binding, mirroring the real surface. */
function fakeBinding(): ArtifactsBinding & { revoked: string[] } {
  const tokens = new Map<string, { id: string; plaintext: string; scope: "read" | "write"; expiresAt: string }>();
  const revoked: string[] = [];
  let counter = 0;
  return {
    revoked,
    async create(name) {
      return {
        id: `repo-${name}`,
        name,
        defaultBranch: "main",
        remote: `https://artifacts.example/${name}.git`,
        token: `create-token-${name}`,
      };
    },
    async get(name) {
      return {
        async createToken(scope = "write", _ttl) {
          counter += 1;
          const token = {
            id: `tok-${counter}`,
            plaintext: `plain-${counter}`,
            scope: scope ?? "write",
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
          tokens.set(token.id, token);
          return token;
        },
        async revokeToken(tokenOrId: string) {
          revoked.push(tokenOrId);
          return tokens.delete(tokenOrId);
        },
        async info() {
          return { id: `repo-${name}`, name, defaultBranch: "main", lastPushAt: null };
        },
        async fork(target: string) {
          return {
            id: `repo-${target}`,
            name: target,
            defaultBranch: "main",
            remote: `https://artifacts.example/${target}.git`,
            token: `fork-token-${target}`,
          };
        },
      };
    },
    async import() {
      return {
        id: "imported",
        name: "imported",
        defaultBranch: "main",
        remote: "https://artifacts.example/imported.git",
        token: "import-token",
      };
    },
    async delete() {
      return true;
    },
  };
}

describe("CloudflareArtifactWorkspaceProvider", () => {
  it("maps the real binding result into a portable WorkspaceRef", async () => {
    const provider = new CloudflareArtifactWorkspaceProvider(fakeBinding());
    const ref = await provider.create("unit-x");
    expect(ref.gitUrl).toBe("https://artifacts.example/unit-x.git");
    expect(ref.backend).toBe("cloudflare-artifacts");
    expect(ref.fallback).toBe(false);
    expect(ref.defaultBranch).toBe("main");
  });

  it("issues write/read tokens and maps plaintext into the portable token", async () => {
    const provider = new CloudflareArtifactWorkspaceProvider(fakeBinding());
    const ref = await provider.create("unit-y");
    const token = await provider.issueWriteToken(ref, 120);
    expect(token.token).toMatch(/^plain-/);
    expect(token.scope).toBe("write");
    expect(token.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("revokes a token by id", async () => {
    const binding = fakeBinding();
    const provider = new CloudflareArtifactWorkspaceProvider(binding);
    const ref = await provider.create("unit-z");
    const token = await provider.issueWriteToken(ref);
    const ok = await provider.revokeToken(ref, token.id);
    expect(ok).toBe(true);
    expect(binding.revoked).toContain(token.id);
  });

  it("forks a workspace into a new ref with its one-time token", async () => {
    const provider = new CloudflareArtifactWorkspaceProvider(fakeBinding());
    const ref = await provider.create("unit-src");
    const forked = await provider.fork(ref, "unit-fork");
    expect(forked.ref.name).toBe("unit-fork");
    expect(forked.ref.gitUrl).toBe("https://artifacts.example/unit-fork.git");
    expect(forked.ref.backend).toBe("cloudflare-artifacts");
    expect(forked.token).toBe("fork-token-unit-fork");
  });

  it("translates an unauthenticated binding failure into BindingUnavailableError", async () => {
    const failing: ArtifactsBinding = {
      async create() {
        throw new Error("You must run remotely to use this binding");
      },
      async get() {
        throw new Error("unused");
      },
      async import() {
        throw new Error("unused");
      },
      async delete() {
        return false;
      },
    };
    const provider = new CloudflareArtifactWorkspaceProvider(failing);
    await expect(provider.create("nope")).rejects.toBeInstanceOf(BindingUnavailableError);
  });
});

describe("isBindingUnavailable", () => {
  it("recognizes the REMOTE_AUTH_REQUIRED code and remote-only messages", () => {
    expect(isBindingUnavailable({ code: "REMOTE_AUTH_REQUIRED" })).toBe(true);
    expect(isBindingUnavailable(new Error("this binding can only run remotely"))).toBe(true);
    expect(isBindingUnavailable(new Error("some other failure"))).toBe(false);
  });
});

/** An error shaped like the binding's ArtifactsError. */
function artifactsError(code: string): Error {
  return Object.assign(new Error(`artifacts: ${code}`), { name: "ArtifactsError", code });
}

/**
 * A fake whose `get(name)` throws an in-progress code for the first `pending`
 * probes of each repo, and whose repos report a head through `log` (`heads`).
 */
function slowBinding(pending: number, heads: Record<string, string> = {}): ArtifactsBinding & { gets: string[] } {
  const base = fakeBinding();
  const seen = new Map<string, number>();
  const gets: string[] = [];
  return {
    ...base,
    gets,
    async get(name) {
      gets.push(name);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n <= pending) {
        throw artifactsError(name.includes("fork") ? "FORK_IN_PROGRESS" : "CREATE_IN_PROGRESS");
      }
      const handle = await base.get(name);
      const head = heads[name];
      return head === undefined ? handle : { ...handle, async log() { return [{ hash: head }]; } };
    },
  };
}

/** A fake clock whose sleep advances it. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    async sleep(ms: number) {
      slept.push(ms);
      t += ms;
    },
  };
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("readiness wait after create/fork", () => {
  it("resolves on the first probe when the repo is ready (no sleep)", async () => {
    const clock = fakeClock();
    const binding = slowBinding(0);
    const provider = new CloudflareArtifactWorkspaceProvider(binding, { readiness: clock });
    await provider.create("ready-now");
    expect(binding.gets).toEqual(["ready-now"]);
    expect(clock.slept).toEqual([]);
  });

  it("polls with a growing backoff until the repo stops reporting in-progress", async () => {
    const clock = fakeClock();
    const binding = slowBinding(3);
    const provider = new CloudflareArtifactWorkspaceProvider(binding, { readiness: { ...clock, initialDelayMs: 100 } });
    const ref = await provider.create("slow-repo");
    expect(ref.name).toBe("slow-repo");
    expect(binding.gets).toEqual(["slow-repo", "slow-repo", "slow-repo", "slow-repo"]);
    expect(clock.slept).toEqual([100, 200, 400]);
    // A token is only issued after the wait (the repo is usable now).
    await expect(provider.issueWriteToken(ref)).resolves.toMatchObject({ scope: "write" });
  });

  it("fails with a typed error naming the repo once the total cap is spent", async () => {
    const clock = fakeClock();
    const provider = new CloudflareArtifactWorkspaceProvider(slowBinding(1_000), {
      readiness: { ...clock, timeoutMs: 1_000, initialDelayMs: 100, maxDelayMs: 400 },
    });
    const failure = await provider.create("never-ready").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RepoNotReadyError);
    const error = failure as RepoNotReadyError;
    expect(error.repo).toBe("never-ready");
    expect(error.lastCode).toBe("CREATE_IN_PROGRESS");
    expect(error.waitedMs).toBe(1_000);
    expect(error.message).toMatch(/never-ready was not ready/);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(1_000);
  });

  it("rethrows an error that is not a readiness signal instead of waiting", async () => {
    const clock = fakeClock();
    const base = fakeBinding();
    const binding: ArtifactsBinding = {
      ...base,
      async get() {
        throw artifactsError("INTERNAL_ERROR");
      },
    };
    const provider = new CloudflareArtifactWorkspaceProvider(binding, { readiness: clock });
    await expect(provider.create("broken")).rejects.toThrow(/INTERNAL_ERROR/);
    expect(clock.slept).toEqual([]);
  });

  it("waits for a fork to be ready before returning it", async () => {
    const clock = fakeClock();
    const binding = slowBinding(2);
    const provider = new CloudflareArtifactWorkspaceProvider(binding, { readiness: clock });
    const src = await provider.create("src");
    const forked = await provider.fork(src, "help-fork");
    expect(forked.ref.name).toBe("help-fork");
    expect(binding.gets.filter((n) => n === "help-fork").length).toBeGreaterThanOrEqual(3);
  });
});

describe("fork base read-back", () => {
  it("returns the head the fork really has, matching the source head", async () => {
    const provider = new CloudflareArtifactWorkspaceProvider(slowBinding(0, { src: SHA_A, "src-fork": SHA_A }));
    const forked = await provider.fork(await provider.create("src"), "src-fork");
    expect(forked.realizedBase).toBe(SHA_A);
    expect(forked.expectedBase).toBe(SHA_A);
    expect(forked.baseMismatch).toBeUndefined();
  });

  it("records a mismatch when the fork's head is not the expected source head", async () => {
    const provider = new CloudflareArtifactWorkspaceProvider(slowBinding(0, { src: SHA_A, "src-fork": SHA_B }));
    const forked = await provider.fork(await provider.create("src"), "src-fork");
    expect(forked.realizedBase).toBe(SHA_B);
    expect(forked.baseMismatch).toEqual({ expected: SHA_A, realized: SHA_B });
    // An explicit expected head from the caller takes precedence over the read one.
    const explicit = await provider.fork(await provider.create("src"), "src-fork", undefined, { expectedBase: SHA_B });
    expect(explicit.expectedBase).toBe(SHA_B);
    expect(explicit.baseMismatch).toBeUndefined();
  });

  it("leaves the realized base unknown when the binding cannot report it", async () => {
    const provider = new CloudflareArtifactWorkspaceProvider(fakeBinding());
    const forked = await provider.fork(await provider.create("src"), "src-fork", undefined, { expectedBase: SHA_A });
    expect(forked.realizedBase).toBeUndefined();
    expect(forked.expectedBase).toBe(SHA_A);
    expect(forked.baseMismatch).toBeUndefined();
  });
});

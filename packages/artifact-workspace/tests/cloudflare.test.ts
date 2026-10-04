import { describe, expect, it } from "vitest";

import {
  BindingUnavailableError,
  CloudflareArtifactWorkspaceProvider,
  isBindingUnavailable,
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

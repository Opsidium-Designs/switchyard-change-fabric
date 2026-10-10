/**
 * The Cloudflare provisioner over a fake Artifacts binding (no network):
 *   - a write token is issued only after the new repo stops reporting
 *     in-progress (the provider's readiness wait);
 *   - a fork reports the head it really has, and a differing expected head is
 *     recorded as a mismatch.
 */

import { describe, expect, it } from "vitest";

import type { ArtifactsBinding } from "@switchyard-change/artifact-workspace";

import type { EnvWithProvisioner } from "../src/workspace-provisioner.ts";
import { selectProvisioner } from "../src/workspace-provisioner.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** A fake binding: `get(name)` reports CREATE_IN_PROGRESS for the first `pending` probes of a repo. */
function fakeBinding(pending: number, heads: Record<string, string>, options: { readonly tokenFails?: boolean } = {}): ArtifactsBinding & { events: string[] } {
  const events: string[] = [];
  const probes = new Map<string, number>();
  const created = (name: string) => ({
    id: `repo-${name}`,
    name,
    defaultBranch: "main",
    remote: `https://artifacts.example/${name}.git`,
    token: `creation-${name}`,
  });
  return {
    events,
    async create(name) {
      events.push(`create ${name}`);
      return created(name);
    },
    async get(name) {
      const n = (probes.get(name) ?? 0) + 1;
      probes.set(name, n);
      if (n <= pending) {
        events.push(`not-ready ${name}`);
        throw Object.assign(new Error("CREATE_IN_PROGRESS"), { code: "CREATE_IN_PROGRESS" });
      }
      return {
        async createToken(scope = "write") {
          if (options.tokenFails) {
            events.push(`token-failed ${name}`);
            throw new Error("token service down");
          }
          events.push(`token ${name}`);
          return { id: `tok-${name}`, plaintext: `plain-${name}`, scope, expiresAt: "2099-01-01T00:00:00.000Z" };
        },
        async revokeToken(tokenOrId: string) {
          events.push(`revoke ${name} ${tokenOrId}`);
          return true;
        },
        async info() {
          return { id: `repo-${name}`, name, defaultBranch: "main", lastPushAt: null };
        },
        async fork(target: string) {
          events.push(`fork ${name} -> ${target}`);
          return created(target);
        },
        async log() {
          const head = heads[name];
          return head === undefined ? [] : [{ hash: head }];
        },
      };
    },
    async import() {
      throw new Error("unused");
    },
    async delete(name: string) {
      events.push(`delete ${name}`);
      return true;
    },
  };
}

function envWith(binding: ArtifactsBinding): EnvWithProvisioner {
  return { ARTIFACTS: binding } as unknown as EnvWithProvisioner;
}

describe("CloudflareProvisioner readiness and fork read-back", () => {
  it("issues the write token only after the new repo is ready", async () => {
    const binding = fakeBinding(1, {});
    const provisioned = await selectProvisioner(envWith(binding)).provision("chg--board-a", { ttlSeconds: 120 });
    expect(provisioned.token).toBe("plain-chg--board-a");
    expect(binding.events).toEqual(["create chg--board-a", "not-ready chg--board-a", "token chg--board-a", "revoke chg--board-a creation-chg--board-a"]);
  });

  it("revokes the repo's creation token once the scoped token is issued (only the scoped one is handed out)", async () => {
    const binding = fakeBinding(0, {});
    const provisioned = await selectProvisioner(envWith(binding)).provision("chg--u", { ttlSeconds: 120 });
    expect(provisioned.token).toBe("plain-chg--u");
    expect(provisioned.tokenId).toBe("tok-chg--u");
    expect(binding.events).toContain("revoke chg--u creation-chg--u");
    expect(binding.events.indexOf("token chg--u")).toBeLessThan(binding.events.indexOf("revoke chg--u creation-chg--u"));
  });

  it("deletes the new repo when the scoped token cannot be issued, and rethrows", async () => {
    const binding = fakeBinding(0, {}, { tokenFails: true });
    await expect(selectProvisioner(envWith(binding)).provision("chg--u", { ttlSeconds: 120 })).rejects.toThrow(/token service down/);
    expect(binding.events).toEqual(["create chg--u", "token-failed chg--u", "delete chg--u"]);
  });

  it("returns the fork's realized base, and records a mismatch against the expected head", async () => {
    const matching = await selectProvisioner(envWith(fakeBinding(0, { src: SHA_A, dst: SHA_A }))).fork!("src", "dst", { ttlSeconds: 120 });
    expect(matching.realizedBase).toBe(SHA_A);
    expect(matching.baseMismatch).toBeUndefined();

    const moved = await selectProvisioner(envWith(fakeBinding(0, { src: SHA_A, dst: SHA_B }))).fork!("src", "dst", {
      ttlSeconds: 120,
      expectedBase: SHA_A,
    });
    expect(moved.realizedBase).toBe(SHA_B);
    expect(moved.expectedBase).toBe(SHA_A);
    expect(moved.baseMismatch).toEqual({ expected: SHA_A, realized: SHA_B });
  });
});

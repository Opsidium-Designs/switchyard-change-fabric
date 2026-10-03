/**
 * Workspace provisioning for a lease.
 *
 * When a runner leases a runnable WorkUnit, the Worker provisions an isolated
 * workspace and a short-lived, repo-scoped write token, then hands the clone URL
 * and plaintext token to the runner exactly once. Only the token id is recorded
 * in the Durable Object (never the plaintext), so the token can be revoked on
 * completion.
 *
 * Real path: the Cloudflare Artifacts binding (`env.ARTIFACTS`). When it is
 * absent or unauthenticated, the provisioner uses an honest in-Worker memory
 * fallback that is clearly labelled (`backend: "worker-memory-fallback"`,
 * `fallback: true`) so a local run is never mistaken for the real service. The
 * on-disk local-filesystem fallback lives in artifact-workspace and is used by
 * Node callers (the runner and tests) through an injected provisioner.
 */

import {
  BindingUnavailableError,
  CloudflareArtifactWorkspaceProvider,
  DEFAULT_TOKEN_TTL_SECONDS,
} from "@switchyard-change/artifact-workspace";

import type { Env } from "./env.ts";

/** What a provisioner returns for a lease (plaintext token included once). */
export interface ProvisionedWorkspace {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId: string;
  readonly token: string;
  readonly tokenExpiresAt: string;
}

/** Injectable workspace provisioner, so Node callers can supply a real-git one. */
export interface WorkspaceProvisioner {
  provision(workspaceName: string): Promise<ProvisionedWorkspace>;
  revoke(workspaceName: string, tokenId: string): Promise<void>;
  archive(workspaceName: string): Promise<void>;
}

/**
 * Choose a provisioner. A test or Node host may attach one to `env` as
 * `WORKSPACE_PROVISIONER`; otherwise the Cloudflare Artifacts binding is used,
 * degrading to the honest in-Worker memory fallback when it is unavailable.
 */
export function selectProvisioner(env: EnvWithProvisioner): WorkspaceProvisioner {
  if (env.WORKSPACE_PROVISIONER) {
    return env.WORKSPACE_PROVISIONER;
  }
  if (env.ARTIFACTS) {
    return new CloudflareProvisioner(env.ARTIFACTS, new WorkerMemoryProvisioner());
  }
  return new WorkerMemoryProvisioner();
}

/** Env extended with an optional injected provisioner (set by Node hosts/tests). */
export interface EnvWithProvisioner extends Env {
  readonly WORKSPACE_PROVISIONER?: WorkspaceProvisioner;
}

/** Real provisioner over Cloudflare Artifacts, falling back when unavailable. */
class CloudflareProvisioner implements WorkspaceProvisioner {
  private readonly provider: CloudflareArtifactWorkspaceProvider;
  private readonly refs = new Map<string, { readonly name: string }>();

  constructor(
    binding: NonNullable<Env["ARTIFACTS"]>,
    private readonly fallback: WorkerMemoryProvisioner,
  ) {
    this.provider = new CloudflareArtifactWorkspaceProvider(binding);
  }

  async provision(workspaceName: string): Promise<ProvisionedWorkspace> {
    try {
      const ref = await this.provider.create(workspaceName);
      const token = await this.provider.issueWriteToken(ref, DEFAULT_TOKEN_TTL_SECONDS);
      this.refs.set(workspaceName, { name: ref.name });
      return {
        workspaceId: ref.id,
        workspaceName: ref.name,
        gitUrl: ref.gitUrl,
        defaultBranch: ref.defaultBranch,
        backend: ref.backend,
        fallback: ref.fallback,
        tokenId: token.id,
        token: token.token,
        tokenExpiresAt: token.expiresAt,
      };
    } catch (error) {
      if (error instanceof BindingUnavailableError) {
        return this.fallback.provision(workspaceName);
      }
      throw error;
    }
  }

  async revoke(workspaceName: string, tokenId: string): Promise<void> {
    if (!this.refs.has(workspaceName)) {
      return this.fallback.revoke(workspaceName, tokenId);
    }
    const ref = {
      id: "",
      name: workspaceName,
      gitUrl: "",
      defaultBranch: "main",
      backend: "cloudflare-artifacts" as const,
      fallback: false,
    };
    await this.provider.revokeToken(ref, tokenId);
  }

  async archive(workspaceName: string): Promise<void> {
    if (!this.refs.has(workspaceName)) {
      return this.fallback.archive(workspaceName);
    }
    const ref = {
      id: "",
      name: workspaceName,
      gitUrl: "",
      defaultBranch: "main",
      backend: "cloudflare-artifacts" as const,
      fallback: false,
    };
    await this.provider.archive(ref);
    this.refs.delete(workspaceName);
  }
}

/**
 * Honest in-Worker fallback. It does not provision real Git (a Worker cannot run
 * Git), so it hands back a clearly-labelled placeholder clone URL. It exists so
 * the control path (lease, cost, completion) is exercisable without credentials;
 * runners that need a real clone use the Node local-filesystem provisioner.
 */
class WorkerMemoryProvisioner implements WorkspaceProvisioner {
  private counter = 0;

  async provision(workspaceName: string): Promise<ProvisionedWorkspace> {
    this.counter += 1;
    const tokenId = `mem-${this.counter}`;
    return {
      workspaceId: `worker-memory-${workspaceName}`,
      workspaceName,
      gitUrl: `memory://worker-fallback/${workspaceName}`,
      defaultBranch: "main",
      backend: "worker-memory-fallback",
      fallback: true,
      tokenId,
      token: `worker-memory-fallback-token-${tokenId}`,
      tokenExpiresAt: new Date(Date.now() + DEFAULT_TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async revoke(_workspaceName: string, _tokenId: string): Promise<void> {
    // Nothing persisted to revoke in the memory fallback.
  }

  async archive(_workspaceName: string): Promise<void> {
    // Nothing persisted to archive in the memory fallback.
  }
}

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

/** Options for one provisioning. */
export interface ProvisionOptions {
  /**
   * The write token's lifetime in seconds. A caller that knows how long its
   * agent needs the token (the board join) passes an explicit short value;
   * omitted keeps the default lifetime the lease routes always used.
   */
  readonly ttlSeconds?: number;
}

/** A short-lived read token for an existing workspace (plaintext returned once). */
export interface IssuedReadToken {
  readonly tokenId: string;
  readonly token: string;
  readonly tokenExpiresAt: string;
}

/** Injectable workspace provisioner, so Node callers can supply a real-git one. */
export interface WorkspaceProvisioner {
  provision(workspaceName: string, options?: ProvisionOptions): Promise<ProvisionedWorkspace>;
  revoke(workspaceName: string, tokenId: string): Promise<void>;
  archive(workspaceName: string): Promise<void>;
  /**
   * Issue a short-lived, repo-scoped READ token for an existing workspace (the
   * integrator reads agents' repos with operator credentials at integration
   * time, never with an agent's write token). Optional: a provisioner without it
   * cannot serve the read-token route.
   */
  issueReadToken?(workspaceName: string, ttlSeconds: number): Promise<IssuedReadToken>;
  /**
   * Issue a short-lived, repo-scoped WRITE token for an existing workspace (the
   * integration Workflow pushes gated commits to the integration repo with one).
   * Optional, like issueReadToken.
   */
  issueWriteToken?(workspaceName: string, ttlSeconds: number): Promise<IssuedReadToken>;
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

  async provision(workspaceName: string, options: ProvisionOptions = {}): Promise<ProvisionedWorkspace> {
    try {
      const ref = await this.provider.create(workspaceName);
      const token = await this.provider.issueWriteToken(ref, options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS);
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
        return this.fallback.provision(workspaceName, options);
      }
      throw error;
    }
  }

  async issueReadToken(workspaceName: string, ttlSeconds: number): Promise<IssuedReadToken> {
    try {
      const token = await this.provider.issueReadToken(this.refByName(workspaceName), ttlSeconds);
      return { tokenId: token.id, token: token.token, tokenExpiresAt: token.expiresAt };
    } catch (error) {
      if (error instanceof BindingUnavailableError) {
        return this.fallback.issueReadToken(workspaceName, ttlSeconds);
      }
      throw error;
    }
  }

  async issueWriteToken(workspaceName: string, ttlSeconds: number): Promise<IssuedReadToken> {
    try {
      const token = await this.provider.issueWriteToken(this.refByName(workspaceName), ttlSeconds);
      return { tokenId: token.id, token: token.token, tokenExpiresAt: token.expiresAt };
    } catch (error) {
      if (error instanceof BindingUnavailableError) {
        return this.fallback.issueWriteToken(workspaceName, ttlSeconds);
      }
      throw error;
    }
  }

  async revoke(workspaceName: string, tokenId: string): Promise<void> {
    if (!this.refs.has(workspaceName)) {
      // The token was issued in a different request (a fresh provisioner), so the
      // in-memory ref is gone; address the repo by name directly to revoke.
      const ref = this.refByName(workspaceName);
      await this.provider.revokeToken(ref, tokenId);
      return;
    }
    const ref = this.refByName(workspaceName);
    await this.provider.revokeToken(ref, tokenId);
  }

  async archive(workspaceName: string): Promise<void> {
    // Delete the real Artifact repo by name. The binding's delete only needs the
    // repo name, so this works even when the repo was created in a different
    // request (a fresh provisioner with an empty in-memory ref map), which is
    // exactly the recruit-then-cleanup case. Gating on the in-memory map here
    // would silently skip the real delete and leak repos.
    const ref = this.refByName(workspaceName);
    await this.provider.archive(ref);
    this.refs.delete(workspaceName);
  }

  /** A minimal ref addressing a repo by name (all the provider needs by name). */
  private refByName(workspaceName: string) {
    return {
      id: "",
      name: workspaceName,
      gitUrl: "",
      defaultBranch: "main",
      backend: "cloudflare-artifacts" as const,
      fallback: false,
    };
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

  async provision(workspaceName: string, options: ProvisionOptions = {}): Promise<ProvisionedWorkspace> {
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
      tokenExpiresAt: new Date(Date.now() + (options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    };
  }

  async issueReadToken(_workspaceName: string, ttlSeconds: number): Promise<IssuedReadToken> {
    this.counter += 1;
    const tokenId = `mem-read-${this.counter}`;
    return {
      tokenId,
      token: `worker-memory-fallback-read-token-${tokenId}`,
      tokenExpiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async issueWriteToken(_workspaceName: string, ttlSeconds: number): Promise<IssuedReadToken> {
    this.counter += 1;
    const tokenId = `mem-write-${this.counter}`;
    return {
      tokenId,
      token: `worker-memory-fallback-write-token-${tokenId}`,
      tokenExpiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async revoke(_workspaceName: string, _tokenId: string): Promise<void> {
    // Nothing persisted to revoke in the memory fallback.
  }

  async archive(_workspaceName: string): Promise<void> {
    // Nothing persisted to archive in the memory fallback.
  }
}

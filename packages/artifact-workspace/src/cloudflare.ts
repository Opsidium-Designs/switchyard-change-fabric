/**
 * WorkspaceProvider backed by the real Cloudflare Artifacts binding.
 *
 * The binding is wired in the Worker (wrangler.jsonc, `remote = true`), so these
 * calls reach the live Artifacts service once a contributor has authenticated
 * (`wrangler login`). Each WorkUnit gets its own isolated Artifact repo, and the
 * provider issues short-lived, repo-scoped write/read tokens the local runner
 * uses to clone and push.
 *
 * When the binding is unavailable (no credentials, or Artifacts access is not
 * granted) the provider does not crash: it throws a typed
 * BindingUnavailableError that the caller can catch to fall back to the honest
 * local provider. This keeps the Worker bootable under `wrangler dev` without a
 * login, exactly as the create/delete path already behaved.
 */

import {
  DEFAULT_TOKEN_TTL_SECONDS,
  type CreateWorkspaceOptions,
  type ScopedToken,
  type TokenScope,
  type WorkspaceInspection,
  type WorkspaceProvider,
  type WorkspaceRef,
} from "./types.ts";

/**
 * Minimal structural view of the Cloudflare Artifacts binding this provider
 * depends on. The field and method names mirror the generated `wrangler types`
 * surface (ArtifactsCreateRepoResult, ArtifactsRepo, ArtifactsCreateTokenResult),
 * declared here so this package type-checks on its own without the Worker's
 * generated types. The real binding injected by the Worker runtime is structurally
 * compatible and can be passed directly.
 */
export interface ArtifactsBinding {
  create(name: string, opts?: ArtifactsCreateOptions): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepoHandle>;
  import(params: ArtifactsImportParams): Promise<ArtifactsCreateRepoResult>;
  delete(name: string): Promise<boolean>;
}

export interface ArtifactsCreateOptions {
  readonly readOnly?: boolean;
  readonly description?: string;
  readonly setDefaultBranch?: string;
}

export interface ArtifactsCreateRepoResult {
  readonly id: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly remote: string;
  /** Plaintext access token, only returned at creation time. */
  readonly token: string;
}

export interface ArtifactsCreateTokenResult {
  readonly id: string;
  readonly plaintext: string;
  readonly scope: TokenScope;
  readonly expiresAt: string;
}

export interface ArtifactsRepoInfo {
  readonly id: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly lastPushAt: string | null;
}

export interface ArtifactsImportParams {
  readonly source: { readonly url: string; readonly branch?: string; readonly depth?: number };
  readonly target: {
    readonly name: string;
    readonly opts?: { readonly description?: string; readonly readOnly?: boolean };
  };
}

/**
 * A repository handle (`env.ARTIFACTS.get(name)`). The real handle is an RPC stub
 * that is also disposable; this view keeps only the token lifecycle methods used
 * here. The real stub is released when the request ends, so this provider does
 * not dispose it explicitly.
 */
export interface ArtifactsRepoHandle {
  createToken(scope?: TokenScope, ttl?: number): Promise<ArtifactsCreateTokenResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  info(): Promise<ArtifactsRepoInfo>;
}

/** Thrown when the Artifacts binding is wired but cannot reach the service. */
export class BindingUnavailableError extends Error {
  readonly reason?: unknown;
  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = "BindingUnavailableError";
    this.reason = reason;
  }
}

/** WorkspaceProvider over the real Cloudflare Artifacts binding. */
export class CloudflareArtifactWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly binding: ArtifactsBinding) {}

  async create(name: string, opts?: CreateWorkspaceOptions): Promise<WorkspaceRef> {
    const result = await this.call(() =>
      this.binding.create(name, {
        description: opts?.description,
        readOnly: opts?.readOnly,
        setDefaultBranch: opts?.defaultBranch,
      }),
    );
    return this.toRef(result);
  }

  async seed(ref: WorkspaceRef, baselineRemote: string): Promise<void> {
    // Server-side import from a reachable HTTPS git remote. When the baseline is
    // not reachable by the service, callers rely on the runner's first push to
    // seed instead; this surfaces that case as a BindingUnavailableError.
    await this.call(() =>
      this.binding.import({
        source: { url: baselineRemote },
        target: { name: ref.name },
      }),
    );
  }

  async issueReadToken(ref: WorkspaceRef, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS): Promise<ScopedToken> {
    return this.issueToken(ref, "read", ttlSeconds);
  }

  async issueWriteToken(ref: WorkspaceRef, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS): Promise<ScopedToken> {
    return this.issueToken(ref, "write", ttlSeconds);
  }

  async revokeToken(ref: WorkspaceRef, tokenOrId: string): Promise<boolean> {
    return this.call(async () => {
      const repo = await this.binding.get(ref.name);
      return repo.revokeToken(tokenOrId);
    });
  }

  async inspect(ref: WorkspaceRef): Promise<WorkspaceInspection> {
    return this.call(async () => {
      const repo = await this.binding.get(ref.name);
      const info = await repo.info();
      return {
        id: info.id,
        name: info.name,
        defaultBranch: info.defaultBranch,
        lastPushAt: info.lastPushAt,
        backend: "cloudflare-artifacts" as const,
        fallback: false,
      };
    });
  }

  async archive(ref: WorkspaceRef): Promise<void> {
    await this.call(() => this.binding.delete(ref.name));
  }

  private async issueToken(
    ref: WorkspaceRef,
    scope: TokenScope,
    ttlSeconds: number,
  ): Promise<ScopedToken> {
    return this.call(async () => {
      const repo = await this.binding.get(ref.name);
      const token = await repo.createToken(scope, ttlSeconds);
      return {
        id: token.id,
        token: token.plaintext,
        scope: token.scope,
        expiresAt: token.expiresAt,
      };
    });
  }

  private toRef(result: ArtifactsCreateRepoResult): WorkspaceRef {
    return {
      id: result.id,
      name: result.name,
      gitUrl: result.remote,
      defaultBranch: result.defaultBranch,
      backend: "cloudflare-artifacts",
      fallback: false,
    };
  }

  /** Run a binding call, translating a binding-unavailable failure into a typed error. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isBindingUnavailable(error)) {
        throw new BindingUnavailableError(
          "Cloudflare Artifacts binding is unavailable (not authenticated or no access)",
          error,
        );
      }
      throw error;
    }
  }
}

/**
 * A remote binding call fails with a recognizable error when the contributor is
 * not authenticated to Cloudflare or lacks Artifacts (open beta) access. Treat
 * that as "fall back cleanly" rather than a hard failure.
 */
export function isBindingUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (code === "REMOTE_AUTH_REQUIRED") {
    return true;
  }
  return (
    /run remotely/i.test(message) ||
    /unauthenticated/i.test(message) ||
    /remote_auth_required/i.test(message) ||
    /not (?:authenticated|logged in)/i.test(message) ||
    /remote (?:binding|resource)/i.test(message)
  );
}

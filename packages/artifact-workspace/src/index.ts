/**
 * artifact-workspace — the WorkspaceProvider contract.
 *
 * A Workspace is an isolated, disposable per-WorkUnit Git workspace. The first
 * (and only, in this spike) implementation is Cloudflare Artifacts: one isolated
 * Artifact repo per WorkUnit with short-lived repo-scoped Git tokens.
 *
 * M0 scope: the contract plus a thin adapter over the Cloudflare Artifacts
 * binding, exposing just the M0 exit capability — create and delete an Artifact
 * repo. `seed`/`fork`/`issue_*_token`/`inspect` are declared on the interface but
 * land in M2. The adapter must *wire* the binding; when the binding is absent or
 * the environment is unauthenticated, calls are stubbed cleanly rather than
 * crashing, so the Worker boots under `wrangler dev` without credentials.
 */

/** A reference to a provisioned Artifact workspace. */
export interface WorkspaceRef {
  readonly id: string;
  /** Git HTTPS clone URL, when known. */
  readonly gitUrl?: string;
}

/** A short-lived, repo-scoped Git credential (never a broad SCM credential). */
export interface ScopedToken {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Portable workspace lifecycle contract. Any provider (Cloudflare Artifacts, a
 * local worktree, …) implements this so the fabric stays vendor-neutral.
 */
export interface WorkspaceProvider {
  create(name: string): Promise<WorkspaceRef>;
  delete(id: string): Promise<void>;
  // The remainder of the WorkspaceProvider contract lands in M2:
  // seed(ref, baseline), fork(ref), issueReadToken(ref), issueWriteToken(ref),
  // inspect(ref), archive(ref)
}

/**
 * The shape of the Cloudflare Artifacts binding we depend on. Artifacts is in
 * open beta and the exact binding surface is not yet stable, so we depend on a
 * deliberately minimal structural type here. The real binding is injected by the
 * Worker runtime (configured with `remote = true` in wrangler.jsonc). Replace
 * this with the official typing once Artifacts types are published.
 */
export interface ArtifactsBinding {
  createRepository(name: string): Promise<{ id: string; gitUrl?: string }>;
  deleteRepository(id: string): Promise<void>;
}

/**
 * WorkspaceProvider backed by the Cloudflare Artifacts binding.
 *
 * The binding is always wired (wrangler.jsonc, `remote = true`). When the
 * contributor has not authenticated (`wrangler login`) or the account lacks
 * Artifacts access, the remote binding call fails; rather than surfacing a 500
 * for the M0 control path, the provider degrades to a clearly-labelled stub
 * result (`stubbed: true`) so the create/delete path is always exercisable, and
 * performs a real Artifacts operation as soon as credentials are present.
 */
export class CloudflareArtifactWorkspaceProvider implements WorkspaceProvider {
  /** True once a call has degraded to stub mode (binding unavailable). */
  stubbed: boolean;

  constructor(private readonly binding?: ArtifactsBinding) {
    this.stubbed = binding === undefined;
  }

  async create(name: string): Promise<WorkspaceRef> {
    if (!this.binding) {
      this.stubbed = true;
      return { id: `stub-${name}-${Date.now()}` };
    }
    try {
      const repo = await this.binding.createRepository(name);
      return { id: repo.id, gitUrl: repo.gitUrl };
    } catch (error) {
      if (isBindingUnavailable(error)) {
        this.stubbed = true;
        return { id: `stub-${name}-${Date.now()}` };
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.binding) {
      this.stubbed = true;
      return;
    }
    try {
      await this.binding.deleteRepository(id);
    } catch (error) {
      if (isBindingUnavailable(error)) {
        this.stubbed = true;
        return;
      }
      throw error;
    }
  }
}

/**
 * A remote binding call fails with a recognizable error when the contributor is
 * not authenticated to Cloudflare / lacks Artifacts (open beta) access. Treat
 * that as "stub cleanly", not as a hard failure (the M0 exit requires real
 * credentials; booting and exercising the path must not).
 */
function isBindingUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /run remotely/i.test(message) ||
    /unauthenticated/i.test(message) ||
    /not (?:authenticated|logged in)/i.test(message) ||
    /remote (?:binding|resource)/i.test(message)
  );
}

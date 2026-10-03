/**
 * Portable workspace contracts for the Switchyard Change Fabric.
 *
 * A Workspace is an isolated, disposable per-WorkUnit Git workspace. Any backend
 * (Cloudflare Artifacts, a local bare repository, ...) implements the same
 * contract so the rest of the fabric stays vendor-neutral: it only ever sees a
 * clone URL plus a short-lived, repo-scoped Git credential.
 */

/** Which backend actually provisioned a workspace. */
export type WorkspaceBackend = "cloudflare-artifacts" | "local-filesystem";

/** A reference to a provisioned workspace (one isolated Git repo). */
export interface WorkspaceRef {
  /** Backend-assigned repository id. */
  readonly id: string;
  /** Stable repository name used to address the repo on its backend. */
  readonly name: string;
  /** Git HTTPS (or file://) clone URL. */
  readonly gitUrl: string;
  /** Default branch name of the provisioned repo. */
  readonly defaultBranch: string;
  /** Which backend provisioned this workspace. */
  readonly backend: WorkspaceBackend;
  /**
   * True when this is the honest local fallback, not real Cloudflare Artifacts.
   * Callers should surface this so a local demo is never mistaken for the real
   * service.
   */
  readonly fallback: boolean;
}

/** Token scope: read-only clone, or write (clone and push). */
export type TokenScope = "read" | "write";

/** A short-lived, repo-scoped Git credential (never a broad SCM credential). */
export interface ScopedToken {
  /** Backend-assigned token id, used to revoke the token later. */
  readonly id: string;
  /** The plaintext credential. Hand to a runner; never persist it. */
  readonly token: string;
  /** The granted scope. */
  readonly scope: TokenScope;
  /** ISO 8601 expiry timestamp. */
  readonly expiresAt: string;
}

/** A read-only snapshot of a workspace's current state. */
export interface WorkspaceInspection {
  readonly id: string;
  readonly name: string;
  readonly defaultBranch: string;
  /** ISO 8601 timestamp of the last push, or null if never pushed. */
  readonly lastPushAt: string | null;
  readonly backend: WorkspaceBackend;
  readonly fallback: boolean;
}

/**
 * Portable workspace lifecycle contract. The fabric creates a workspace per
 * runnable WorkUnit, seeds it from the Change baseline, issues a scoped token to
 * the runner, and archives (deletes) it once the work is integrated.
 */
export interface WorkspaceProvider {
  /** Create an isolated workspace (one Git repo) under the given name. */
  create(name: string, opts?: CreateWorkspaceOptions): Promise<WorkspaceRef>;
  /**
   * Seed a workspace from a baseline Git remote (an HTTPS URL the backend can
   * reach). Backends that cannot import server-side may make this a no-op and
   * rely on the runner's first push to seed the repo.
   */
  seed(ref: WorkspaceRef, baselineRemote: string): Promise<void>;
  /** Issue a short-lived read-only (clone) token. */
  issueReadToken(ref: WorkspaceRef, ttlSeconds?: number): Promise<ScopedToken>;
  /** Issue a short-lived write (clone and push) token. */
  issueWriteToken(ref: WorkspaceRef, ttlSeconds?: number): Promise<ScopedToken>;
  /** Revoke a previously issued token by its id or plaintext. */
  revokeToken(ref: WorkspaceRef, tokenOrId: string): Promise<boolean>;
  /** Read a workspace's current state without mutating it. */
  inspect(ref: WorkspaceRef): Promise<WorkspaceInspection>;
  /** Delete a workspace and all of its tokens. */
  archive(ref: WorkspaceRef): Promise<void>;
}

/** Options accepted when creating a workspace. */
export interface CreateWorkspaceOptions {
  readonly description?: string;
  readonly defaultBranch?: string;
  readonly readOnly?: boolean;
}

/** Default token lifetime (one hour) when a caller does not specify one. */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;

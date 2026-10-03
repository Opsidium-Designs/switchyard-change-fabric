/**
 * artifact-workspace: isolated, disposable per-WorkUnit Git workspaces.
 *
 * Two providers implement the same portable WorkspaceProvider contract:
 *   - CloudflareArtifactWorkspaceProvider: the real Cloudflare Artifacts binding
 *     (one isolated Artifact repo per WorkUnit, short-lived repo-scoped tokens).
 *   - LocalFilesystemWorkspaceProvider: an honest, clearly-labelled offline
 *     fallback backed by local bare Git repos, so the whole clone, execute, and
 *     push loop runs with zero Cloudflare setup.
 *
 * The Cloudflare provider throws BindingUnavailableError when it cannot reach
 * the service; callers catch that to pick the local fallback. The decision is
 * explicit and the resulting WorkspaceRef is always labelled with its backend
 * and a `fallback` flag so a local demo is never mistaken for the real service.
 *
 * The local fallback lives at the `./local` subpath (it uses the Node
 * filesystem and the Git CLI), so Worker-side code can import this root without
 * pulling in Node built-ins it never runs.
 */

export type {
  CreateWorkspaceOptions,
  ScopedToken,
  TokenScope,
  WorkspaceBackend,
  WorkspaceInspection,
  WorkspaceProvider,
  WorkspaceRef,
} from "./types.ts";
export { DEFAULT_TOKEN_TTL_SECONDS } from "./types.ts";

export type {
  ArtifactsBinding,
  ArtifactsCreateOptions,
  ArtifactsCreateRepoResult,
  ArtifactsCreateTokenResult,
  ArtifactsImportParams,
  ArtifactsRepoHandle,
  ArtifactsRepoInfo,
} from "./cloudflare.ts";
export {
  BindingUnavailableError,
  CloudflareArtifactWorkspaceProvider,
  isBindingUnavailable,
} from "./cloudflare.ts";

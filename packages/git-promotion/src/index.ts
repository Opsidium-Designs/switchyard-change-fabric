/**
 * git-promotion: promote a verified and integrated Change result into an
 * ordinary local Git repository, then expire the per-WorkUnit workspaces.
 *
 * The public surface:
 *   - types:          the DeliveryProvider contract and the promotion input,
 *                     target, and result schema
 *   - LocalGitDeliveryProvider: the guaranteed baseline delivery path, creating
 *                     a real branch and commit in a local source repository
 *   - cleanup:        the simple "expire the per-WorkUnit workspaces after
 *                     promotion" lifecycle policy, driven through the portable
 *                     WorkspaceProvider contract
 *
 * Everything runs over ordinary Git in Node (the local runner, the CLI, and
 * tests), not inside a Cloudflare Worker. Hosted forge delivery adapters are out
 * of scope here; local Git is the baseline that always works.
 */

export type { GitIdentity } from "./git.ts";
export { DEFAULT_IDENTITY } from "./git.ts";

export type {
  DeliveryProvider,
  PromotionInput,
  PromotionResult,
  PromotionTarget,
} from "./types.ts";

export type { LocalGitDeliveryOptions } from "./local-git.ts";
export { LocalGitDeliveryProvider, defaultBranch } from "./local-git.ts";

export type {
  ChangeWorkspaces,
  CleanupPolicy,
  CleanupResult,
  CleanupTrigger,
} from "./cleanup.ts";
export { DEFAULT_CLEANUP_POLICY, cleanupWorkspaces } from "./cleanup.ts";

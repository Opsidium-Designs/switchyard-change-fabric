/**
 * Workspace cleanup lifecycle: expire the per-WorkUnit workspaces once their
 * work has been delivered.
 *
 * Each WorkUnit runs in its own isolated, disposable workspace (a real
 * Cloudflare Artifact repo in production, or the honest local-filesystem
 * fallback offline). After the Change is verified, integrated, and promoted,
 * those workspaces have served their purpose and should not linger. This module
 * applies a simple, explicit policy: once a Change is promoted, archive (delete)
 * every workspace it created.
 *
 * Cleanup is driven through the same portable WorkspaceProvider contract the
 * rest of the fabric uses, so it archives real Artifact repos in production and
 * local bare repos offline. It is deliberately conservative: archiving an
 * already-gone workspace is a no-op, and a failure to archive one workspace does
 * not stop the others, so a partial failure never blocks delivery.
 */

import type { WorkspaceProvider, WorkspaceRef } from "@switchyard-change/artifact-workspace";

/** When to expire the per-WorkUnit workspaces. */
export type CleanupTrigger = "after-promotion";

/** A simple, explicit cleanup policy. */
export interface CleanupPolicy {
  /**
   * When to archive the per-WorkUnit workspaces. The baseline policy expires
   * them "after-promotion": once the Change has been promoted into local Git,
   * the per-WorkUnit workspaces are no longer needed.
   */
  readonly expireWorkspaces: CleanupTrigger;
  /**
   * Whether to also archive the integration workspace. Defaults to true so no
   * disposable workspace is left behind once the result is delivered.
   */
  readonly expireIntegration?: boolean;
}

/** The default cleanup policy: expire everything once promotion succeeds. */
export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
  expireWorkspaces: "after-promotion",
  expireIntegration: true,
};

/** The workspaces a Change created, to be expired after promotion. */
export interface ChangeWorkspaces {
  /** One workspace per WorkUnit that ran. */
  readonly unitWorkspaces: readonly WorkspaceRef[];
  /** The integration workspace, when one was created. */
  readonly integrationWorkspace?: WorkspaceRef;
}

/** The outcome of a cleanup pass. */
export interface CleanupResult {
  /** Workspace names that were archived in this pass. */
  readonly archived: readonly string[];
  /** Workspace names that could not be archived, with the error text. */
  readonly failed: readonly { readonly name: string; readonly error: string }[];
}

/**
 * Expire the per-WorkUnit (and optionally the integration) workspaces for a
 * promoted Change, per the given policy. Each archive is attempted
 * independently so one failure does not block the rest; the result lists what
 * was archived and what failed.
 */
export async function cleanupWorkspaces(
  workspaces: WorkspaceProvider,
  change: ChangeWorkspaces,
  policy: CleanupPolicy = DEFAULT_CLEANUP_POLICY,
): Promise<CleanupResult> {
  const targets: WorkspaceRef[] = [...change.unitWorkspaces];
  if ((policy.expireIntegration ?? true) && change.integrationWorkspace) {
    targets.push(change.integrationWorkspace);
  }

  const archived: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const ref of targets) {
    try {
      await workspaces.archive(ref);
      archived.push(ref.name);
    } catch (error) {
      failed.push({ name: ref.name, error: messageOf(error) });
    }
  }
  return { archived: archived.sort(), failed };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

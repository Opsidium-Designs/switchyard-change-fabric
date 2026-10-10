/**
 * The optional agent WORKSPACE a board join can provision.
 *
 * An agent that joins a board to do work needs its own repo to push to. The
 * join route can provision it in the same request: the caller asks for
 * `workspace: {ttlSeconds}` and the substrate (the Worker's provisioner, or the
 * offline local workspace backend) creates the agent's repo and a repo-scoped,
 * short-lived write token, returned once with the board token. These helpers
 * keep the request validation and the repo naming identical on both
 * substrates. Pure: no I/O, no clock. Every repo name is bounded to the
 * Artifacts name limit (see repo-name.ts): a name that fits is unchanged.
 */

import { boundedRepoName } from "./repo-name.ts";

/** The shortest and longest write-token lifetime a join may ask for, in seconds. */
export const BOARD_WORKSPACE_TTL_BOUNDS = { min: 60, max: 3600 } as const;

/** A validated workspace request from a join body. */
export interface BoardJoinWorkspaceRequest {
  readonly ttlSeconds: number;
}

/**
 * Validate the `workspace` field of a join body. Returns undefined when the
 * field is absent (a plain join), the request when it is valid, and an error
 * message otherwise. The TTL is required and must be explicit and short.
 */
export function parseBoardJoinWorkspace(
  raw: unknown,
): { readonly ok: true; readonly request?: BoardJoinWorkspaceRequest } | { readonly ok: false; readonly error: string } {
  if (raw === undefined) {
    return { ok: true };
  }
  const { min, max } = BOARD_WORKSPACE_TTL_BOUNDS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `workspace must be an object {ttlSeconds} (${min}..${max})` };
  }
  const ttl = (raw as Record<string, unknown>).ttlSeconds;
  for (const key of Object.keys(raw)) {
    if (key !== "ttlSeconds") {
      return { ok: false, error: `workspace has an unknown field ${JSON.stringify(key)}` };
    }
  }
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < min || ttl > max) {
    return { ok: false, error: `workspace.ttlSeconds must be an integer from ${min} to ${max}` };
  }
  return { ok: true, request: { ttlSeconds: ttl } };
}

/** The agent ids a join may provision a workspace for (the board's id syntax). */
export const BOARD_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The stable, filesystem-safe repo name of a board agent's workspace:
 * `<changeId>--board-<agent>`, so it never collides with a WorkUnit's
 * `<changeId>--<unitId>` repo for an ordinary unit id.
 */
export function boardAgentWorkspaceName(changeId: string, agent: string): string {
  return boundedRepoName(`${changeId}--board-${agent}`);
}

/**
 * The Change's TOOLS repo: one per Change (`<changeId>--tools`), provisioned
 * once, on the first tool build. Each tool lives in `tools/<capability>/` on
 * its own branch (`tools/<capability>`), so builders never race each other.
 */
export function toolsWorkspaceName(changeId: string): string {
  return boundedRepoName(`${changeId}--tools`);
}

/** The branch of the tools repo a tool is built on. */
export function toolBranch(capability: string): string {
  return `tools/${capability}`;
}

/**
 * The repo a helper gets for a help request that grants a sub-scope: a FORK of
 * the requester's repo (`<changeId>--help-<request>`), so the helper starts
 * from the requester's in-progress state. One fork per request (one grantee).
 */
export function boardHelpForkWorkspaceName(changeId: string, request: string): string {
  return boundedRepoName(`${changeId}--help-${request}`);
}

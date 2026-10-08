import type { ArtifactsBinding } from "@switchyard-change/artifact-workspace";

import type { ChangeState } from "./change-state.ts";

/**
 * Typed Worker bindings (wrangler.jsonc). In a configured build these can be
 * generated via `wrangler types`; this hand-written version keeps the Worker
 * type-checkable without a generated file in the repo.
 */
export interface Env {
  /** Durable Object namespace for live Change state, leases, and cost. */
  readonly CHANGE_STATE: DurableObjectNamespace<ChangeState>;
  /** Workflow binding for the durable Change work-graph lifecycle. */
  readonly CHANGE_WORKFLOW: Workflow;
  /**
   * Cloudflare Artifacts binding (open beta), configured `remote = true` in
   * local dev. Optional at the type level because it is unavailable until the
   * contributor authenticates with `wrangler login`; the provisioner degrades to
   * an honest, clearly-labelled fallback when it is absent.
   */
  readonly ARTIFACTS?: ArtifactsBinding;
  /**
   * Optional bearer token for the control plane (a Worker secret, never a
   * committed var). When set, every mutating route and every route that returns
   * a plaintext Artifact token requires `authorization: Bearer <token>`; the
   * read-only snapshot GETs stay open. When unset or blank, the Worker behaves
   * as an unauthenticated local-dev control plane. Set it with
   * `wrangler secret put SWITCHYARD_API_TOKEN` (deploy) or a gitignored
   * `apps/worker/.dev.vars` (wrangler dev). See src/auth.ts.
   */
  readonly SWITCHYARD_API_TOKEN?: string;
}

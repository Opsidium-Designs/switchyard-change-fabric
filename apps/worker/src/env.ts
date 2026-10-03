import type { ArtifactsBinding } from "@switchyard-change/artifact-workspace";

/**
 * Typed Worker bindings (wrangler.jsonc). In a configured build these can be
 * generated via `wrangler types`; this hand-written version keeps the Worker
 * type-checkable without a generated file in the repo.
 */
export interface Env {
  /** Durable Object namespace for live Change state + path leases. */
  readonly CHANGE_STATE: DurableObjectNamespace;
  /** Workflow binding for the durable Change work-graph lifecycle. */
  readonly CHANGE_WORKFLOW: Workflow;
  /**
   * Cloudflare Artifacts binding (open beta), configured `remote = true` in
   * local dev. Optional at the type level because it is unavailable until the
   * contributor authenticates with `wrangler login`; the Artifacts provider
   * stubs cleanly when it is absent.
   */
  readonly ARTIFACTS?: ArtifactsBinding;
}

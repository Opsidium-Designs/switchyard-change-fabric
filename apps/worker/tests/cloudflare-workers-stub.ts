/**
 * Offline stand-in for the `cloudflare:workers` module (aliased in
 * vitest.config.ts). It provides only the two base classes the entry module
 * extends: a DurableObject that stores the injected `ctx` (with its storage),
 * and `env`, and a WorkflowEntrypoint so the module that exports the Workflow
 * loads. No Cloudflare runtime behavior is emulated beyond that.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: { readonly storage: unknown };
  protected readonly env: Env;
  constructor(ctx: { readonly storage: unknown }, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The Workflow entrypoint base, so the entry module (which exports the Workflow) loads. */
export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The WorkerEntrypoint base, so the entry module (which exports the gate egress handler) loads. */
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  protected readonly ctx: { readonly props: Props };
  protected readonly env: Env;
  constructor(ctx: { readonly props: Props }, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

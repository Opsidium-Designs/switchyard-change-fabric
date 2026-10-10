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
 * depends on. The field and method names are reconciled against the real
 * generated `wrangler types` surface (the `Artifacts`, `ArtifactsRepo`,
 * `ArtifactsCreateRepoResult`, and `ArtifactsCreateTokenResult` shapes), so this
 * package type-checks on its own without the Worker's generated types. The real
 * binding injected by the Worker runtime is structurally compatible and can be
 * passed directly.
 *
 * Reconciliation notes (verified against a live account):
 *   - namespace methods are `create` / `get` / `import` / `delete` (plus `list`,
 *     unused here);
 *   - `create` returns `remote` (the HTTPS git URL) and a one-time `token`;
 *   - the repo handle (`get(name)`) exposes `createToken` (default scope
 *     "write"), `revokeToken`, `info`, and `fork`;
 *   - a scoped token authenticates ordinary Git over HTTPS as the password with
 *     any username (equivalently an `Authorization: Bearer <token>` header);
 *   - `info().lastPushAt` is eventually consistent and can read `null` for a
 *     short window right after a push, so it is not a reliable proof-of-push on
 *     its own.
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

/**
 * Repository metadata as returned by the real `ArtifactsRepo.info()`. This
 * provider reads only `id` / `name` / `defaultBranch` / `lastPushAt`; the other
 * fields are declared to match the real surface and may be read by callers.
 */
export interface ArtifactsRepoInfo {
  readonly id: string;
  readonly name: string;
  readonly defaultBranch: string;
  /** ISO 8601 timestamp of the last push, or null if never pushed (lags briefly). */
  readonly lastPushAt: string | null;
  readonly description?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Fork source, or null if this repo is not a fork. */
  readonly source?: string | null;
  readonly readOnly?: boolean;
  readonly remote?: string;
}

export interface ArtifactsImportParams {
  readonly source: { readonly url: string; readonly branch?: string; readonly depth?: number };
  readonly target: {
    readonly name: string;
    readonly opts?: { readonly description?: string; readonly readOnly?: boolean };
  };
}

/** Options for forking an existing repo to a new one (`ArtifactsRepo.fork`). */
export interface ArtifactsForkOptions {
  readonly description?: string;
  readonly readOnly?: boolean;
  readonly defaultBranchOnly?: boolean;
}

/**
 * A repository handle (`env.ARTIFACTS.get(name)`). The real handle is an RPC stub
 * that extends `Disposable`; this structural view keeps the methods this provider
 * uses. A real `Disposable` stub stays assignable to it. The real stub is also
 * released when the request ends, so disposal here is best-effort: the provider
 * calls `[Symbol.dispose]` when the runtime provides it (see `disposeHandle`).
 */
export interface ArtifactsRepoHandle {
  createToken(scope?: TokenScope, ttl?: number): Promise<ArtifactsCreateTokenResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  info(): Promise<ArtifactsRepoInfo>;
  /** Fork this repo to a new repo; returns the new repo with its one-time token. */
  fork?(name: string, opts?: ArtifactsForkOptions): Promise<ArtifactsCreateRepoResult>;
  /**
   * First-parent history, newest first (the real `ArtifactsRepo.log`). Optional
   * here: the fork read-back uses it when present to learn the head a fork
   * really has; a handle without it leaves the realized base unknown.
   */
  log?(opts?: { readonly ref?: string; readonly limit?: number; readonly offset?: number }): Promise<readonly ArtifactsCommitHead[]>;
}

/** The part of the real `ArtifactsCommitMetadata` the fork read-back reads. */
export interface ArtifactsCommitHead {
  readonly hash: string;
}

/**
 * How long, and how, the provider waits for a new repo to become usable after
 * create, import, or fork. The real binding has no readiness field on `info()`
 * or `list()`; a repo still being built makes `get(name)` throw with code
 * `CREATE_IN_PROGRESS` / `IMPORT_IN_PROGRESS` / `FORK_IN_PROGRESS`. The wait
 * polls `get(name).info()` with a small backoff until it answers. A binding
 * that never reports in-progress resolves on the first probe, so behavior with
 * such a binding is unchanged.
 */
export interface ReadinessOptions {
  /** Total time to wait before failing (default 30s). */
  readonly timeoutMs?: number;
  /** The first backoff delay (default 100ms); doubled each poll up to maxDelayMs. */
  readonly initialDelayMs?: number;
  /** The largest backoff delay (default 2s). */
  readonly maxDelayMs?: number;
  /** Injectable sleep (tests pass a fake). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in milliseconds (tests pass a fake). */
  readonly now?: () => number;
}

/** Options for constructing the Cloudflare provider. */
export interface CloudflareProviderOptions {
  readonly readiness?: ReadinessOptions;
}

/** Defaults for the readiness wait. */
export const READINESS_DEFAULTS = { timeoutMs: 30_000, initialDelayMs: 100, maxDelayMs: 2_000 } as const;

/** How long a readiness wait took. */
export interface ReadinessReport {
  readonly attempts: number;
  readonly waitedMs: number;
}

/**
 * Thrown when a new repo did not become usable within the readiness timeout.
 * Names the repo and the last not-ready code seen, so the failure is honest
 * rather than a token issued against a repo an agent cannot clone yet.
 */
export class RepoNotReadyError extends Error {
  readonly repo: string;
  readonly attempts: number;
  readonly waitedMs: number;
  readonly lastCode?: string;
  constructor(repo: string, attempts: number, waitedMs: number, lastCode?: string) {
    super(
      `Artifacts repo ${repo} was not ready after ${waitedMs}ms (${attempts} probe(s)` +
        `${lastCode ? `, last: ${lastCode}` : ""}); no token was issued for it`,
    );
    this.name = "RepoNotReadyError";
    this.repo = repo;
    this.attempts = attempts;
    this.waitedMs = waitedMs;
    if (lastCode !== undefined) {
      this.lastCode = lastCode;
    }
  }
}

/** Options for the fork read-back (not passed to the binding). */
export interface ForkReadBackOptions {
  /**
   * The source head the caller expects the fork to start from. When omitted,
   * the source's head read just before the fork (when the handle can report
   * it) is the expected value.
   */
  readonly expectedBase?: string;
}

/** What a fork produced, including the head the fork actually has. */
export interface ArtifactsForkResult {
  readonly ref: WorkspaceRef;
  /** The fork's one-time creation token. */
  readonly token: string;
  /**
   * The head commit the fork really has, read back from the fork after it
   * became ready. Absent when the binding cannot report it (unknown, never
   * assumed equal to the source).
   */
  readonly realizedBase?: string;
  /** The head the fork was expected to start from, when known. */
  readonly expectedBase?: string;
  /**
   * Set when both heads are known and differ (for example the source moved
   * between the read and the fork): recorded, never silently passed.
   */
  readonly baseMismatch?: { readonly expected: string; readonly realized: string };
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
  private readonly readiness: ReadinessOptions;

  constructor(
    private readonly binding: ArtifactsBinding,
    options: CloudflareProviderOptions = {},
  ) {
    this.readiness = options.readiness ?? {};
  }

  async create(name: string, opts?: CreateWorkspaceOptions): Promise<WorkspaceRef> {
    return (await this.createWithToken(name, opts)).ref;
  }

  /**
   * Create a repo and return it with its one-time CREATION token (plaintext),
   * so a caller that hands out a scoped token instead can revoke the creation
   * token (as the fork path does). Resolves once the repo is usable.
   */
  async createWithToken(name: string, opts?: CreateWorkspaceOptions): Promise<{ readonly ref: WorkspaceRef; readonly token: string }> {
    const result = await this.call(() =>
      this.binding.create(name, {
        description: opts?.description,
        readOnly: opts?.readOnly,
        setDefaultBranch: opts?.defaultBranch,
      }),
    );
    await this.waitUntilReady(result.name);
    return { ref: this.toRef(result), token: result.token };
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
    await this.waitUntilReady(ref.name);
  }

  /**
   * Fork an existing workspace into a new one, returning the new ref and its
   * one-time creation token. Fork lives on the repo handle in the real binding
   * (`get(name).fork(target)`); a fake without `fork` reports it as unsupported.
   * This is an additive capability over the portable WorkspaceProvider contract,
   * used by the live Artifacts path; non-forking backends simply do not expose it.
   *
   * The fork is returned only once it is usable (see waitUntilReady), and with
   * the head it REALLY has, read back from the fork, never assumed to equal
   * the source head. A known expected head that differs is recorded as
   * `baseMismatch`.
   */
  async fork(
    ref: WorkspaceRef,
    targetName: string,
    opts?: ArtifactsForkOptions,
    readBack: ForkReadBackOptions = {},
  ): Promise<ArtifactsForkResult> {
    const { result, sourceHead } = await this.withRepo(ref.name, async (repo) => {
      if (typeof repo.fork !== "function") {
        throw new Error("the Artifacts binding handle does not support fork");
      }
      const head = readBack.expectedBase === undefined ? await headOf(repo) : undefined;
      return { result: await repo.fork(targetName, opts), sourceHead: head };
    });
    await this.waitUntilReady(result.name);
    const realizedBase = await this.withRepo(result.name, (repo) => headOf(repo)).catch(() => undefined);
    const expectedBase = readBack.expectedBase ?? sourceHead;
    return {
      ref: this.toRef(result),
      token: result.token,
      ...(realizedBase !== undefined ? { realizedBase } : {}),
      ...(expectedBase !== undefined ? { expectedBase } : {}),
      ...(realizedBase !== undefined && expectedBase !== undefined && realizedBase !== expectedBase
        ? { baseMismatch: { expected: expectedBase, realized: realizedBase } }
        : {}),
    };
  }

  /**
   * Wait until a repo just created, imported, or forked is usable: poll
   * `get(name).info()` with a bounded backoff while the binding reports the
   * repo is still being built (an *_IN_PROGRESS code, or NOT_FOUND, which a
   * just-created repo can briefly return). Any other error is thrown as is
   * (binding-unavailable translated, as everywhere). Resolves on the first
   * answer, so a binding with no readiness signal is never delayed. Throws
   * RepoNotReadyError, naming the repo, once the total timeout is spent.
   */
  async waitUntilReady(name: string): Promise<ReadinessReport> {
    const timeoutMs = this.readiness.timeoutMs ?? READINESS_DEFAULTS.timeoutMs;
    const maxDelayMs = this.readiness.maxDelayMs ?? READINESS_DEFAULTS.maxDelayMs;
    const sleep = this.readiness.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const now = this.readiness.now ?? Date.now;
    const started = now();
    let delay = this.readiness.initialDelayMs ?? READINESS_DEFAULTS.initialDelayMs;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      let code: string;
      try {
        await this.withRepo(name, (repo) => repo.info());
        return { attempts, waitedMs: now() - started };
      } catch (error) {
        const pending = notReadyCode(error);
        if (pending === undefined) {
          throw error;
        }
        code = pending;
      }
      const waited = now() - started;
      if (waited >= timeoutMs) {
        throw new RepoNotReadyError(name, attempts, waited, code);
      }
      await sleep(Math.min(delay, timeoutMs - waited));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  async issueReadToken(ref: WorkspaceRef, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS): Promise<ScopedToken> {
    return this.issueToken(ref, "read", ttlSeconds);
  }

  async issueWriteToken(ref: WorkspaceRef, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS): Promise<ScopedToken> {
    return this.issueToken(ref, "write", ttlSeconds);
  }

  async revokeToken(ref: WorkspaceRef, tokenOrId: string): Promise<boolean> {
    return this.withRepo(ref.name, (repo) => repo.revokeToken(tokenOrId));
  }

  async inspect(ref: WorkspaceRef): Promise<WorkspaceInspection> {
    return this.withRepo(ref.name, async (repo) => {
      const info = await repo.info();
      // Note: info().lastPushAt is eventually consistent and can read null for a
      // short window right after a push, so callers must not treat a null here
      // as proof the repo was never pushed to.
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
    return this.withRepo(ref.name, async (repo) => {
      const token = await repo.createToken(scope, ttlSeconds);
      return {
        id: token.id,
        token: token.plaintext,
        scope: token.scope,
        expiresAt: token.expiresAt,
      };
    });
  }

  /**
   * Acquire a repo handle, run a function against it, and dispose it when the
   * runtime provides `[Symbol.dispose]` (the real RPC stub does). Binding-
   * unavailable failures are translated into BindingUnavailableError.
   */
  private async withRepo<T>(
    name: string,
    fn: (repo: ArtifactsRepoHandle) => Promise<T>,
  ): Promise<T> {
    return this.call(async () => {
      const repo = await this.binding.get(name);
      try {
        return await fn(repo);
      } finally {
        disposeHandle(repo);
      }
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

/** The codes the binding uses for a repo that exists but is not usable yet. */
const NOT_READY_CODES = new Set(["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS", "NOT_FOUND"]);

/**
 * The not-ready code of a binding error, or undefined when the error means
 * something else. The code is read from `.code`, falling back to the message
 * (an RPC hop can drop the property but keep the text).
 */
function notReadyCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && NOT_READY_CODES.has(code)) {
    return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(CREATE|IMPORT|FORK)_IN_PROGRESS\b/.exec(message)?.[0];
}

/** The head commit a repo handle reports, or undefined when it cannot say. */
async function headOf(repo: ArtifactsRepoHandle): Promise<string | undefined> {
  if (typeof repo.log !== "function") {
    return undefined;
  }
  try {
    const hash = (await repo.log({ limit: 1 }))[0]?.hash;
    return typeof hash === "string" && /^[0-9a-f]{40,64}$/.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Release an Artifacts repo handle when the runtime provides the well-known
 * disposer. The real binding handle is a disposable RPC stub; a plain fake is
 * not, so this is best-effort and never throws. Accessing the symbol via a
 * runtime lookup keeps this compatible without widening the TS lib target.
 */
function disposeHandle(repo: ArtifactsRepoHandle): void {
  const disposer = (Symbol as { dispose?: symbol }).dispose;
  if (!disposer) {
    return;
  }
  const fn = (repo as unknown as Record<symbol, unknown>)[disposer];
  if (typeof fn === "function") {
    try {
      (fn as () => void).call(repo);
    } catch {
      // Disposal is best-effort; the stub is also released at request end.
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

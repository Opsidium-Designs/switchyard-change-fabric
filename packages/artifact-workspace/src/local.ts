/**
 * LocalFilesystemWorkspaceProvider: the honest offline fallback.
 *
 * When no Cloudflare credentials or Artifacts binding are present, this provider
 * stands in for Cloudflare Artifacts so the whole clone, execute, and push loop
 * runs offline with zero Cloudflare setup. It is deliberately labelled as a
 * fallback (`backend: "local-filesystem"`, `fallback: true`) so a local demo is
 * never mistaken for the real service.
 *
 * Each workspace is a real bare Git repository under a root directory, reachable
 * at a `file://` URL that an ordinary Git client can clone from and push to.
 * Tokens are issued and tracked so revocation behaves, but they are local
 * placeholders (a `file://` remote needs no credential), which keeps the
 * contract identical while being honest about what they are.
 *
 * This provider uses Node's filesystem and the `git` CLI, so it runs in the
 * local runner, the CLI, and tests, not inside a Cloudflare Worker.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_TOKEN_TTL_SECONDS,
  type CreateWorkspaceOptions,
  type ScopedToken,
  type TokenScope,
  type WorkspaceInspection,
  type WorkspaceProvider,
  type WorkspaceRef,
} from "./types.ts";
import { runGit } from "./git-transport.ts";


interface LocalRepoRecord {
  readonly ref: WorkspaceRef;
  readonly repoDir: string;
  readonly tokens: Map<string, ScopedToken>;
}

/** Options for constructing the local provider. */
export interface LocalWorkspaceOptions {
  /** Root directory under which bare repos are created. Created if missing. */
  readonly rootDir: string;
  /**
   * Deterministic clock for token expiry, for tests. Defaults to Date.now.
   */
  readonly now?: () => number;
  /**
   * Deterministic id source, for tests. Defaults to crypto.randomUUID.
   */
  readonly newId?: () => string;
}

export class LocalFilesystemWorkspaceProvider implements WorkspaceProvider {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly repos = new Map<string, LocalRepoRecord>();

  constructor(opts: LocalWorkspaceOptions) {
    this.rootDir = resolve(opts.rootDir);
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
    mkdirSync(this.rootDir, { recursive: true });
  }

  async create(name: string, opts?: CreateWorkspaceOptions): Promise<WorkspaceRef> {
    const defaultBranch = opts?.defaultBranch ?? "main";
    const repoDir = join(this.rootDir, `${sanitize(name)}.git`);
    mkdirSync(repoDir, { recursive: true });
    await runGit(["init", "--bare", `--initial-branch=${defaultBranch}`, repoDir]);
    const ref: WorkspaceRef = {
      id: this.newId(),
      name,
      gitUrl: pathToFileURL(repoDir).href,
      defaultBranch,
      backend: "local-filesystem",
      fallback: true,
    };
    this.repos.set(name, { ref, repoDir, tokens: new Map() });
    return ref;
  }

  async seed(ref: WorkspaceRef, baselineRemote: string): Promise<void> {
    // Mirror the baseline into the bare repo so a clone starts from it. A
    // file:// or https baseline both work with the git CLI. If the baseline is
    // unreachable, the caller falls back to the runner's first push.
    const record = this.require(ref.name);
    await runGit(["-C", record.repoDir, "fetch", baselineRemote, "+refs/heads/*:refs/heads/*"]);
  }

  async issueReadToken(ref: WorkspaceRef, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS): Promise<ScopedToken> {
    return this.issueToken(ref, "read", ttlSeconds);
  }

  async issueWriteToken(ref: WorkspaceRef, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS): Promise<ScopedToken> {
    return this.issueToken(ref, "write", ttlSeconds);
  }

  async revokeToken(ref: WorkspaceRef, tokenOrId: string): Promise<boolean> {
    const record = this.require(ref.name);
    for (const [id, token] of record.tokens) {
      if (id === tokenOrId || token.token === tokenOrId) {
        record.tokens.delete(id);
        return true;
      }
    }
    return false;
  }

  async inspect(ref: WorkspaceRef): Promise<WorkspaceInspection> {
    const record = this.require(ref.name);
    let lastPushAt: string | null = null;
    try {
      const { stdout } = await runGit([
        "-C",
        record.repoDir,
        "log",
        "-1",
        "--format=%cI",
      ]);
      const trimmed = stdout.trim();
      lastPushAt = trimmed === "" ? null : trimmed;
    } catch {
      // No commits yet: never pushed.
      lastPushAt = null;
    }
    return {
      id: ref.id,
      name: ref.name,
      defaultBranch: ref.defaultBranch,
      lastPushAt,
      backend: "local-filesystem",
      fallback: true,
    };
  }

  async archive(ref: WorkspaceRef): Promise<void> {
    const record = this.repos.get(ref.name);
    if (!record) {
      return;
    }
    rmSync(record.repoDir, { recursive: true, force: true });
    this.repos.delete(ref.name);
  }

  private async issueToken(
    ref: WorkspaceRef,
    scope: TokenScope,
    ttlSeconds: number,
  ): Promise<ScopedToken> {
    const record = this.require(ref.name);
    const id = this.newId();
    const token: ScopedToken = {
      id,
      // Clearly-labelled local placeholder: a file:// remote needs no credential.
      token: `local-fallback-${scope}-${id}`,
      scope,
      expiresAt: new Date(this.now() + ttlSeconds * 1000).toISOString(),
    };
    record.tokens.set(id, token);
    return token;
  }

  private require(name: string): LocalRepoRecord {
    const record = this.repos.get(name);
    if (!record) {
      throw new Error(`unknown local workspace: ${name}`);
    }
    return record;
  }
}

/** Reduce a workspace name to a filesystem-safe directory segment. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}
